import {
  AtomicCommandBus,
  type AuthenticatedUserCommandContext,
  type AuthorizedCommandContext,
  appearanceOrganizationCommandName,
  appearanceOrganizationDefaultsUpdatedEvent,
  appearancePersonalCommandName,
  createAuthenticatedUserCommandRegistry,
  createCoreCommandRegistry,
  type TransactionManager,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import { domainEvents, outbox, securityAuditRecords } from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import {
  appearanceCutoverInstalled,
  createIsolatedAppearanceSchema,
  dropIsolatedAppearanceSchema,
  ensureAppearanceCutover,
} from "../test-support/appearance-cutover.js";
import { endingEachCommandBinding } from "../test-support/tenant-binding.js";
import { openSession, rawQuery, type TestSession } from "../testing.js";
import type { Tx } from "../transaction.js";
import { createAppearanceRepository } from "./appearance-repository.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";
import { createCommandTransactionManager } from "./command-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

const fingerprintSecret = "requestport-appearance-live-fingerprint-secret";
const lockChoreographyTimeoutMs = 30_000;

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
}

/**
 * The command transaction manager opens a transaction per command. Inside an
 * outer rollback transaction Drizzle turns that into a savepoint, which keeps
 * every live case isolated while still exercising the real lock order.
 */
function commandDatabase(tx: Tx) {
  return tx as unknown as Database;
}

function portFactory(name: string, database: Database | Tx) {
  if (name === "appearance") return createAppearanceRepository(database);
  if (name === "commandAuthorization") {
    return createCommandAuthorizationRepository(database);
  }
  return undefined;
}

/**
 * The command transaction manager over the case's transaction. The bus hands
 * each command's transaction its binding (manifest-i2.md §2.3 item 1), and
 * here that transaction is a savepoint: a transaction-local setting outlives
 * a released savepoint, so the next command, for another user or
 * organisation, would be refused a binding its own transaction would have
 * taken. In production the manager opens each command's transaction on the
 * pool, and the binding ends with it; this ends it after each command to
 * match (test-support/tenant-binding.ts).
 */
function commandTransactions(tx: Tx): TransactionManager {
  return endingEachCommandBinding(
    createCommandTransactionManager(commandDatabase(tx), portFactory),
    tx,
  );
}

function tenantBus(tx: Tx) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions: commandTransactions(tx),
    fingerprintSecret,
    authorizeContext: (context, uow) =>
      uow
        .port<ReturnType<typeof createCommandAuthorizationRepository>>(
          "commandAuthorization",
        )
        .assertCurrent(context),
  });
}

function personalBus(tx: Tx) {
  return new AtomicCommandBus<AuthenticatedUserCommandContext>({
    registry: createAuthenticatedUserCommandRegistry(),
    transactions: commandTransactions(tx),
    fingerprintSecret,
  });
}

async function seedUser(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Appearance user', ${email}, now())
  `);
  const sessionId = `session_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "session" ("id", "expires_at", "token", "updated_at", "user_id")
    values (${sessionId}, now() + interval '1 hour',
      ${`token_${crypto.randomUUID()}`}, now(), ${userId})
  `);
  return { userId, sessionId };
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Appearance tenant',
      ${`appearance-live-${organizationId}`}, 'active')
  `);
  return organizationId;
}

async function seedMembership(
  tx: Tx,
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "owner",
) {
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, 'active')
  `);
}

function textArray(values: readonly string[]) {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/**
 * Releases a committed choreography fixture. The tenant is archived rather
 * than deleted: after `0014` the seeded owner membership fires the
 * initialization trigger, `organizations` cascades into `domain_events`, and
 * that table is append-only — so `delete from "organizations"` raises 55000 on
 * every migrated database and strands the rows the teardown already touched.
 * `security_audit_records` refuses the same delete through its `no action`
 * tenant reference. What is left behind carries this run's own UUID slug, so
 * leftovers stay identifiable. Only the rows that own no append-only history
 * are removed outright.
 */
async function releaseChoreographyFixture(
  tx: Tx,
  fixture: {
    organizationId?: string;
    userIds: readonly string[];
    aggregateIds?: readonly string[];
  },
) {
  if (fixture.aggregateIds?.length) {
    // Receipts carry no tenant reference and no append-only guard, so the rows
    // a bus-level race commits are removed outright.
    await tx.execute(sql`
      delete from "command_receipts"
      where "aggregate_id" = any(array[${textArray(
        fixture.aggregateIds,
      )}]::uuid[])
    `);
  }
  if (fixture.organizationId) {
    await tx.execute(sql`
      update "organizations" set "status" = 'archived'
      where "id" = ${fixture.organizationId}
    `);
    await tx.execute(sql`
      delete from "organization_members"
      where "organization_id" = ${fixture.organizationId}
    `);
  }
  await tx.execute(sql`
    delete from "user"
    where "id" = any(array[${textArray(fixture.userIds)}]::text[])
  `);
  await tx.execute(sql`
    delete from "signup_allowlist"
    where "normalized_email" = any(array[${textArray(
      fixture.userIds.map((userId) => `${userId}@example.invalid`),
    )}]::citext[])
  `);
}

function tenantContext(input: {
  userId: string;
  sessionId: string;
  organizationId: string;
}): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: input.userId },
    organizationId: input.organizationId,
    scopes: new Set(["members:manage"]),
    credentialId: input.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

function userContext(input: {
  userId: string;
  sessionId: string;
}): AuthenticatedUserCommandContext {
  return {
    actor: { type: "user", id: input.userId },
    credentialId: input.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

async function appearanceEvents(tx: Tx, organizationId: string) {
  return (
    await tx
      .select({
        type: domainEvents.type,
        aggregateId: domainEvents.aggregateId,
        aggregateVersion: domainEvents.aggregateVersion,
        actor: domainEvents.actor,
        data: domainEvents.data,
      })
      .from(domainEvents)
      .where(eq(domainEvents.organizationId, organizationId))
      .orderBy(domainEvents.aggregateVersion)
  ).filter((event) => event.type.startsWith("appearance."));
}

/**
 * Only the update envelopes. A database that already carries `0014` also has
 * the membership trigger's version-1 initialization event for this tenant, and
 * the bus-level races count what the command itself wrote.
 */
async function appearanceUpdateEvents(tx: Tx, organizationId: string) {
  return (await appearanceEvents(tx, organizationId)).filter(
    (event) => event.type === appearanceOrganizationDefaultsUpdatedEvent,
  );
}

async function appearanceAudits(tx: Tx, organizationId: string) {
  return await tx
    .select({
      actorId: securityAuditRecords.actorId,
      targetType: securityAuditRecords.targetType,
      targetId: securityAuditRecords.targetId,
      fieldNames: securityAuditRecords.fieldNames,
    })
    .from(securityAuditRecords)
    .where(
      and(
        eq(securityAuditRecords.organizationId, organizationId),
        eq(
          securityAuditRecords.action,
          "appearance.organization_defaults_updated",
        ),
      ),
    );
}

async function commandReceiptCount(tx: Tx, aggregateId: string) {
  return (
    await tx.execute(sql`
      select count(*)::int as "receipts" from "command_receipts"
      where "aggregate_id" = ${aggregateId}::uuid
    `)
  ).rows[0] as { receipts: number };
}

async function outboxStates(tx: Tx, organizationId: string) {
  return await tx
    .select({ state: outbox.state })
    .from(outbox)
    .innerJoin(domainEvents, eq(domainEvents.id, outbox.eventId))
    .where(
      and(
        eq(domainEvents.organizationId, organizationId),
        sql`${domainEvents.type} like 'appearance.%'`,
      ),
    );
}

type AppearanceCommandResult = {
  aggregateId: string;
  version: number;
  theme: string | null;
  density: string | null;
  mode: string | null;
  changedFields: string[];
};

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("live appearance repository", () => {
  test("commits version two with a contiguous safe event and a value-free audit", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const { userId, sessionId } = await seedUser(tx);
      const organizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId, userId);

      const seeded =
        await createAppearanceRepository(tx).lockOrganizationDefaults(
          organizationId,
        );
      expect(seeded).toMatchObject({
        theme: "requestport",
        density: "ultra-compact",
        mode: "system",
        version: 1,
      });

      const context = tenantContext({ userId, sessionId, organizationId });
      const result = (await tenantBus(tx).execute({
        name: appearanceOrganizationCommandName,
        input: {
          organizationId,
          theme: "cue",
          density: "normal",
          mode: "dark",
        },
        context,
        meta: {
          idempotencyKey: `appearance-live-${crypto.randomUUID()}`,
          expectedVersion: 1,
        },
      })) as AppearanceCommandResult;

      expect(result).toMatchObject({
        version: 2,
        theme: "cue",
        changedFields: ["density", "mode", "theme"],
      });
      expect(result.aggregateId).toBe(seeded?.aggregateId);

      const events = await appearanceEvents(tx, organizationId);
      expect(events.map((event) => event.aggregateVersion)).toEqual([1, 2]);
      expect(events[0]).toMatchObject({
        type: "appearance.organization_defaults_initialized.v1",
        actor: {
          type: "service",
          id: "requestport-appearance-default-initializer",
        },
      });
      expect(events[1]).toMatchObject({
        type: appearanceOrganizationDefaultsUpdatedEvent,
        aggregateId: seeded?.aggregateId,
        actor: { type: "user", id: userId },
        data: {
          organizationId,
          changedFields: ["density", "mode", "theme"],
          before: {
            theme: "requestport",
            density: "ultra-compact",
            mode: "system",
          },
          after: { theme: "cue", density: "normal", mode: "dark" },
        },
      });
      expect(await outboxStates(tx, organizationId)).toEqual([
        { state: "pending" },
        { state: "pending" },
      ]);

      const audits = await tx
        .select()
        .from(securityAuditRecords)
        .where(eq(securityAuditRecords.organizationId, organizationId));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorType: "user",
        actorId: userId,
        action: "appearance.organization_defaults_updated",
        targetType: "organization_appearance",
        targetId: seeded?.aggregateId,
        reason: "Organization appearance defaults were updated",
        fieldNames: ["density", "mode", "theme"],
      });
      expect(JSON.stringify(audits[0])).not.toContain("cue");
    });
  });

  test("gives exactly one commit and one conflict to two owners at one version", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const first = await seedUser(tx);
      const second = await seedUser(tx);
      const organizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId, first.userId);
      await seedMembership(tx, organizationId, second.userId);
      const bus = tenantBus(tx);

      const committed = (await bus.execute({
        name: appearanceOrganizationCommandName,
        input: {
          organizationId,
          theme: "venu",
          density: "large",
          mode: "light",
        },
        context: tenantContext({ ...first, organizationId }),
        meta: {
          idempotencyKey: `appearance-race-a-${crypto.randomUUID()}`,
          expectedVersion: 1,
        },
      })) as AppearanceCommandResult;

      await expect(
        bus.execute({
          name: appearanceOrganizationCommandName,
          input: {
            organizationId,
            theme: "dusk",
            density: "normal",
            mode: "dark",
          },
          context: tenantContext({ ...second, organizationId }),
          meta: {
            idempotencyKey: `appearance-race-b-${crypto.randomUUID()}`,
            expectedVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ code: "version_conflict" });

      expect(committed.version).toBe(2);
      expect(
        (
          await createAppearanceRepository(tx).lockOrganizationDefaults(
            organizationId,
          )
        )?.version,
      ).toBe(2);
      const events = await appearanceEvents(tx, organizationId);
      expect(events.map((event) => event.aggregateVersion)).toEqual([1, 2]);
    });
  });

  test("replays one receipt and refuses to reuse the key in another tenant", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const { userId, sessionId } = await seedUser(tx);
      const organizationId = await seedOrganization(tx);
      const otherOrganizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId, userId);
      await seedMembership(tx, otherOrganizationId, userId);
      const bus = tenantBus(tx);
      const idempotencyKey = `appearance-receipt-${crypto.randomUUID()}`;
      const input = {
        organizationId,
        theme: "terminal",
        density: "normal",
        mode: "dark",
      };

      const first = await bus.execute({
        name: appearanceOrganizationCommandName,
        input,
        context: tenantContext({ userId, sessionId, organizationId }),
        meta: { idempotencyKey, expectedVersion: 1 },
      });
      const replay = await bus.execute({
        name: appearanceOrganizationCommandName,
        input,
        context: tenantContext({ userId, sessionId, organizationId }),
        meta: { idempotencyKey, expectedVersion: 1 },
      });

      expect(replay).toEqual(first);
      expect(await appearanceEvents(tx, organizationId)).toHaveLength(2);

      await expect(
        bus.execute({
          name: appearanceOrganizationCommandName,
          input: { ...input, organizationId: otherOrganizationId },
          context: tenantContext({
            userId,
            sessionId,
            organizationId: otherOrganizationId,
          }),
          meta: { idempotencyKey, expectedVersion: 1 },
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });

      expect(
        (
          await createAppearanceRepository(tx).lockOrganizationDefaults(
            otherOrganizationId,
          )
        )?.version,
      ).toBe(1);
      expect(await appearanceEvents(tx, otherOrganizationId)).toHaveLength(1);
    });
  });

  test("denies revoked membership, suspended tenant, and non-owner roles", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const owner = await seedUser(tx);
      const member = await seedUser(tx);
      const organizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId, owner.userId);
      await seedMembership(tx, organizationId, member.userId, "member");
      const bus = tenantBus(tx);
      const input = {
        organizationId,
        theme: "signal",
        density: "large",
        mode: "light",
      };

      await expect(
        bus.execute({
          name: appearanceOrganizationCommandName,
          input,
          context: tenantContext({ ...member, organizationId }),
          meta: {
            idempotencyKey: `appearance-role-${crypto.randomUUID()}`,
            expectedVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });

      await tx.execute(sql`
        update "organization_members" set "status" = 'revoked'
        where "organization_id" = ${organizationId}
          and "user_id" = ${owner.userId}
      `);
      await expect(
        bus.execute({
          name: appearanceOrganizationCommandName,
          input,
          context: tenantContext({ ...owner, organizationId }),
          meta: {
            idempotencyKey: `appearance-revoked-${crypto.randomUUID()}`,
            expectedVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });

      await tx.execute(sql`
        update "organization_members" set "status" = 'active'
        where "organization_id" = ${organizationId}
          and "user_id" = ${owner.userId}
      `);
      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${organizationId}
      `);
      await expect(
        bus.execute({
          name: appearanceOrganizationCommandName,
          input,
          context: tenantContext({ ...owner, organizationId }),
          meta: {
            idempotencyKey: `appearance-suspended-${crypto.randomUUID()}`,
            expectedVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });

      expect(await appearanceEvents(tx, organizationId)).toHaveLength(1);
    });
  });

  test("keeps personal writes global, tombstoned, and free of tenant events", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const { userId, sessionId } = await seedUser(tx);
      const organizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId, userId);
      const bus = personalBus(tx);
      const context = () => userContext({ userId, sessionId });

      const created = (await bus.execute({
        name: appearancePersonalCommandName,
        input: { theme: "hivehub", density: "large", mode: null },
        context: context(),
        meta: {
          idempotencyKey: `appearance-personal-a-${crypto.randomUUID()}`,
          expectedVersion: 0,
        },
      })) as AppearanceCommandResult;
      expect(created).toMatchObject({ version: 1, theme: "hivehub" });

      const reset = (await bus.execute({
        name: appearancePersonalCommandName,
        input: { theme: null, density: null, mode: null },
        context: context(),
        meta: {
          idempotencyKey: `appearance-personal-b-${crypto.randomUUID()}`,
          expectedVersion: 1,
        },
      })) as AppearanceCommandResult;

      expect(reset).toMatchObject({
        version: 2,
        theme: null,
        density: null,
        mode: null,
      });
      // Reset retains the row and its stable aggregate identity, so neither the
      // version nor the receipt identity can return to zero.
      expect(reset.aggregateId).toBe(created.aggregateId);
      await expect(
        bus.execute({
          name: appearancePersonalCommandName,
          input: { theme: "luma", density: null, mode: null },
          context: context(),
          meta: {
            idempotencyKey: `appearance-personal-c-${crypto.randomUUID()}`,
            expectedVersion: 0,
          },
        }),
      ).rejects.toMatchObject({ code: "version_conflict" });

      const stored = await tx.execute(sql`
        select "theme", "density", "mode", "version", "aggregate_id"
        from "user_appearance_preferences" where "user_id" = ${userId}
      `);
      expect(stored.rows[0]).toMatchObject({
        theme: null,
        density: null,
        mode: null,
        version: 2,
      });

      const audits = await tx
        .select()
        .from(securityAuditRecords)
        .where(eq(securityAuditRecords.actorId, userId));
      expect(audits).toHaveLength(2);
      for (const audit of audits) {
        expect(audit).toMatchObject({
          organizationId: null,
          action: "appearance.personal_preferences_updated",
          targetType: "user_appearance",
          targetId: created.aggregateId,
          reason: "Personal appearance preferences were updated",
        });
      }
      // Personal preferences are global, so they never enter the tenant stream.
      expect(await appearanceEvents(tx, organizationId)).toHaveLength(1);
    });
  });

  test("refuses a personal write on a revoked session and an expired one", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const { userId, sessionId } = await seedUser(tx);
      const other = await seedUser(tx);
      const bus = personalBus(tx);
      const idempotencyKey = `appearance-session-${crypto.randomUUID()}`;
      const input = { theme: "snuffle", density: null, mode: null };

      const committed = await bus.execute({
        name: appearancePersonalCommandName,
        input,
        context: userContext({ userId, sessionId }),
        meta: { idempotencyKey, expectedVersion: 0 },
      });
      expect(committed).toMatchObject({ version: 1 });

      // Another user's session may not replay this receipt or write this row.
      await expect(
        bus.execute({
          name: appearancePersonalCommandName,
          input,
          context: userContext({ userId, sessionId: other.sessionId }),
          meta: { idempotencyKey, expectedVersion: 0 },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });

      await tx.execute(sql`
        update "session" set "expires_at" = now() - interval '1 minute'
        where "id" = ${sessionId}
      `);
      await expect(
        bus.execute({
          name: appearancePersonalCommandName,
          input,
          context: userContext({ userId, sessionId }),
          meta: { idempotencyKey, expectedVersion: 0 },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  test("resolves an appearance snapshot with and without an organization", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const { userId } = await seedUser(tx);
      const organizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId, userId);
      const repository = createAppearanceRepository(tx);

      expect(await repository.readAppearanceSnapshot({ userId })).toMatchObject(
        {
          user: { theme: null, density: null, mode: null, version: 0 },
          organization: {
            theme: "requestport",
            density: "ultra-compact",
            mode: "system",
            version: 0,
          },
          effective: {
            theme: "requestport",
            source: {
              theme: "fallback",
              density: "fallback",
              mode: "fallback",
            },
          },
        },
      );

      await tx.execute(sql`
        update "organization_appearance_defaults"
        set "theme" = 'cue', "density" = 'normal', "mode" = 'dark'
        where "organization_id" = ${organizationId}
      `);
      await tx.execute(sql`
        insert into "user_appearance_preferences" ("user_id", "density")
        values (${userId}, 'large')
      `);

      expect(
        await repository.readAppearanceSnapshot({ userId, organizationId }),
      ).toMatchObject({
        user: { theme: null, density: "large", mode: null, version: 1 },
        organization: { theme: "cue", density: "normal", mode: "dark" },
        effective: {
          theme: "cue",
          density: "large",
          mode: "dark",
          source: {
            theme: "organization",
            density: "user",
            mode: "organization",
          },
        },
      });

      // A tenant the user does not belong to must never leak its default.
      const foreignId = await seedOrganization(tx);
      expect(
        await repository.readAppearanceSnapshot({
          userId,
          organizationId: foreignId,
        }),
      ).toMatchObject({
        organization: {
          theme: "requestport",
          density: "ultra-compact",
          mode: "system",
          version: 0,
        },
      });
    });
  });

  test("leaves the appearance event stream append-only", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const { userId, sessionId } = await seedUser(tx);
      const organizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId, userId);
      await tenantBus(tx).execute({
        name: appearanceOrganizationCommandName,
        input: {
          organizationId,
          theme: "luma",
          density: "normal",
          mode: "light",
        },
        context: tenantContext({ userId, sessionId, organizationId }),
        meta: {
          idempotencyKey: `appearance-append-${crypto.randomUUID()}`,
          expectedVersion: 1,
        },
      });
      const [event] = await appearanceEvents(tx, organizationId);
      expect(event).toBeDefined();

      for (const mutation of [
        sql`update "domain_events" set "aggregate_version" = 9
            where "organization_id" = ${organizationId}`,
        sql`delete from "domain_events" where "organization_id" = ${organizationId}`,
      ]) {
        let failure: unknown;
        try {
          await tx.transaction(async (nested) => {
            await nested.execute(mutation);
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
      }
    });
  });

  test("releases a committed choreography fixture after the 0014 cutover", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      // The choreography suite below commits its identity rows into `public`,
      // so its teardown has to survive the schema CI and staging actually run.
      // After 0014 the seeded owner membership fires the initialization
      // trigger, which writes an append-only `domain_events` row that cascades
      // from `organizations` — a teardown that deletes the tenant aborts with
      // 55000 and strands every row it already committed.
      await ensureAppearanceCutover(tx);
      const { userId } = await seedUser(tx);
      const organizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId, userId);
      expect(await appearanceEvents(tx, organizationId)).toHaveLength(1);
      // A bus-level race also commits a receipt, which carries no tenant
      // reference and so has to be removed by aggregate identity.
      const aggregateId = crypto.randomUUID();
      await tx.execute(sql`
        insert into "command_receipts" ("actor_fingerprint", "command_name",
          "idempotency_fingerprint", "normalized_input_hash", "aggregate_id",
          "result_json", "expires_at")
        values (${`fingerprint_${aggregateId}`},
          ${appearanceOrganizationCommandName}, ${`key_${aggregateId}`},
          ${`hash_${aggregateId}`}, ${aggregateId}::uuid, '{}'::jsonb,
          now() + interval '1 day')
      `);

      await releaseChoreographyFixture(tx, {
        organizationId,
        userIds: [userId],
        aggregateIds: [aggregateId],
      });

      const tenant = await tx.execute(sql`
        select "status" from "organizations" where "id" = ${organizationId}
      `);
      expect(tenant.rows).toEqual([{ status: "archived" }]);
      // The tenant's append-only history survives untouched, and every row the
      // fixture owns outright is gone.
      expect(await appearanceEvents(tx, organizationId)).toHaveLength(1);
      for (const remaining of [
        sql`select "user_id" from "organization_members"
            where "organization_id" = ${organizationId}`,
        sql`select "id" from "user" where "id" = ${userId}`,
        sql`select "normalized_email" from "signup_allowlist"
            where "normalized_email" = ${`${userId}@example.invalid`}::citext`,
        sql`select "id" from "command_receipts"
            where "aggregate_id" = ${aggregateId}::uuid`,
      ]) {
        expect((await tx.execute(remaining)).rows).toEqual([]);
      }
    });
  });
});

/**
 * Genuinely concurrent behaviour needs two committed connections looking at the
 * same tables, and a developer database has not necessarily applied `0014` yet.
 * These cases therefore replay the checked-in `0014` statements that build the
 * two appearance tables inside a private PostgreSQL schema and put it ahead of
 * `public` on each connection's `search_path`. Both tables are declared
 * unqualified, so every appearance row the fixture itself inserts, locks and
 * updates lands in that schema, and `afterAll` drops it.
 *
 * What is *not* isolated is `public`. The identity tables are shared and real,
 * so seeding commits allowlist entries, users, sessions, organizations and
 * memberships there; where `0014` is applied, seeding an owner membership also
 * fires its trigger, which seeds the real appearance row, its version-1 event
 * and an outbox row for a tenant that has none; and the two bus-level cases
 * commit the command's event, outbox, audit and receipt rows.
 * `releaseChoreographyFixture` archives the tenant and deletes the rows that
 * own no append-only history.
 *
 * Three cases do depend on `0014` being applied to `public`: the one that
 * asserts against the trigger-seeded row, and the two that dispatch the
 * command and must adopt that row's aggregate rather than mint a second one.
 * `beforeAll` records whether it is there with a read-only probe, and those
 * three skip when it is not. The remaining two run against either state.
 */
describe.sequential("live appearance lock choreography", () => {
  const isolatedSchema = `requestport_appearance_race_${crypto
    .randomUUID()
    .replaceAll("-", "")}`;

  /**
   * Whether `public` carries `0014`, read once in `beforeAll`.
   *
   * It is read here rather than per case because a case must decide whether to
   * run at all before it opens a transaction, and `ctx.skip` wants an answer
   * at that moment. `publicAggregateId` still probes for itself further down —
   * it runs inside a case's own transaction and asks a narrower question, what
   * aggregate `public` already holds, which this flag cannot answer.
   */
  let cutoverInstalled = false;

  /**
   * `SET search_path` has to be issued inside the transaction that uses it.
   * Outside one the serverless driver does not guarantee that the next
   * statement lands on the same session, and a stale path silently resolves
   * the appearance tables to `public` — which is exactly the state these cases
   * refuse to depend on.
   */
  async function beginIsolated(client: TestSession) {
    await client.query("BEGIN");
    await client.query(`set local search_path to "${isolatedSchema}", public`);
  }

  async function rollback(client: TestSession) {
    await client.query("ROLLBACK").catch(() => undefined);
  }

  async function inIsolatedTransaction<T>(run: (tx: Tx) => Promise<T>) {
    const client = await openSession(suiteStorage);
    try {
      await beginIsolated(client);
      const result = await run(client.db as unknown as Tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async function waitForBlocked(promise: Promise<unknown>) {
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    return settled;
  }

  /**
   * Opens one real transaction on a dedicated connection and hands back its
   * Drizzle handle plus the switch that ends it. This is what a bus-level race
   * needs: the command transaction manager nests a savepoint inside the handle,
   * so every lock a dispatch takes — the receipt `pg_advisory_xact_lock`
   * included, which is released only at the end of the top-level transaction —
   * is held until this outer transaction is told to commit.
   */
  async function beginHeldTransaction(client: TestSession) {
    const database = client.db;
    let decide!: (outcome: "commit" | "rollback") => void;
    const decided = new Promise<"commit" | "rollback">((resolve) => {
      decide = resolve;
    });
    let opened!: (tx: Tx) => void;
    let openFailed!: (error: unknown) => void;
    const ready = new Promise<Tx>((resolve, reject) => {
      opened = resolve;
      openFailed = reject;
    });
    let failure: unknown;
    const finished = database
      .transaction(async (inner) => {
        await inner.execute(
          sql.raw(`set local search_path to "${isolatedSchema}", public`),
        );
        opened(inner as unknown as Tx);
        if ((await decided) === "rollback") throw new TestRollback();
      })
      .catch((error: unknown) => {
        if (error instanceof TestRollback) return;
        failure = error;
        openFailed(error);
      });
    const tx = await ready;
    return {
      tx,
      /** Idempotent, so a failing case can end the handle again in `finally`. */
      async end(outcome: "commit" | "rollback") {
        decide(outcome);
        await finished;
        if (failure) throw failure;
      },
    };
  }

  /**
   * The aggregate `public` already holds for this organization, if it holds
   * one.
   *
   * 0014's trigger seeds the real row and its version-1 event the moment an
   * owner membership goes active, and the command under test writes its events
   * to `public.domain_events` whatever schema the row itself lives in. Adopting
   * that identity is what keeps the two halves of the stream contiguous; a
   * second id would strand the version-2 event on an aggregate this suite
   * drops on the way out, permanently, because the event store is append-only.
   *
   * Null on a database without 0014, where there is no trigger, no row, and no
   * version-1 event to be contiguous with.
   */
  async function publicAggregateId(tx: Tx, organizationId: string) {
    if (!(await appearanceCutoverInstalled(tx))) return null;
    const seeded = await tx.execute(sql`
      select "aggregate_id" from "public"."organization_appearance_defaults"
      where "organization_id" = ${organizationId}
    `);

    return (
      (seeded.rows[0] as { aggregate_id: string } | undefined)?.aggregate_id ??
      null
    );
  }

  async function seedOwnedTenant() {
    return await inIsolatedTransaction(async (tx) => {
      const owner = await seedUser(tx);
      const organizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId, owner.userId);
      // The trigger in `public` has already seeded the real row and its
      // version-1 event. This copy takes that identity rather than minting a
      // second one, so the command's version-2 event is contiguous with it.
      const adopted = await publicAggregateId(tx, organizationId);
      const seeded = await tx.execute(sql`
        insert into "organization_appearance_defaults"
          ("organization_id", "aggregate_id", "theme", "density", "mode",
            "last_updated_by_user_id")
        values (${organizationId}, coalesce(${adopted}::uuid, gen_random_uuid()),
          'requestport', 'ultra-compact', 'system', ${owner.userId})
        returning "aggregate_id"
      `);
      return {
        ...owner,
        organizationId,
        aggregateId: (seeded.rows[0] as { aggregate_id: string }).aggregate_id,
      };
    });
  }

  beforeAll(async () => {
    const client = await openSession(suiteStorage);
    try {
      // Read `public`'s migration state; do not change it. `to_regclass`
      // writes nothing, and the cases that need 0014 skip themselves below.
      // Replaying the migration on this connection would commit 0014's DDL
      // without the row drizzle-kit writes to its own migrations table, so the
      // next `db:migrate` would re-apply 0014, fail on the table that already
      // exists, and never reach the migrations after it.
      cutoverInstalled = await appearanceCutoverInstalled(
        client.db as unknown as Tx,
      );
      await createIsolatedAppearanceSchema(client, isolatedSchema);
    } finally {
      client.release();
    }
  }, lockChoreographyTimeoutMs);

  afterAll(async () => {
    const client = await openSession(suiteStorage);
    try {
      await dropIsolatedAppearanceSchema(client, isolatedSchema);
    } finally {
      client.release();
    }
  }, lockChoreographyTimeoutMs);

  /**
   * The isolated aggregate is the one `public` already has.
   *
   * These cases put a private copy of the appearance tables ahead of `public`
   * so the fixture owns its own rows — but the command writes its events to
   * `public.domain_events`, which is shared and append-only. Minting a second
   * aggregate id here commits a version-2 event, and its outbox row, for an
   * aggregate whose only row lives in a schema this suite drops on the way
   * out. `aggregate_version_sequence` counts every stream that does not begin
   * at version 1, so each one is a violation no teardown can remove; the
   * residue already attributed to this producer is recorded in
   * `docs/handoffs/2026-09-13-requestport-production-handoff.md`.
   *
   * `seedMembership` above has already fired 0014's trigger, which seeds the
   * real row in `public` and writes its version-1 event. Taking that identity
   * rather than minting another makes the command's version-2 event
   * contiguous with it, and leaves an aggregate whose row outlives this suite.
   * Without 0014 there is no trigger, no row and no version-1 event to be
   * contiguous with, so this case skips rather than assert against a table
   * `public` does not have.
   */
  test("seeds the aggregate public already knows, not a second one", {
    timeout: lockChoreographyTimeoutMs,
  }, async (ctx) => {
    ctx.skip(
      !cutoverInstalled,
      "0014 is not applied here, so `public` holds no row to adopt",
    );
    const seeded = await seedOwnedTenant();

    const [row] = (
      await rawQuery(
        suiteStorage,
        'select "aggregate_id" from "public"."organization_appearance_defaults" where "organization_id" = $1',
        [seeded.organizationId],
      )
    ).rows as { aggregate_id: string }[];

    expect(
      row?.aggregate_id,
      "0014's trigger seeds the row this fixture must adopt",
    ).toBeDefined();
    expect(seeded.aggregateId).toBe(row?.aggregate_id);
  });

  test("blocks a second owner until the first update commits", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    const seeded = await inIsolatedTransaction(async (tx) => {
      const first = await seedUser(tx);
      const second = await seedUser(tx);
      const organizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId, first.userId);
      await seedMembership(tx, organizationId, second.userId);
      // The identity `public` already holds, for the reason above.
      const adopted = await publicAggregateId(tx, organizationId);
      await tx.execute(sql`
        insert into "organization_appearance_defaults"
          ("organization_id", "aggregate_id", "theme", "density", "mode",
            "last_updated_by_user_id")
        values (${organizationId}, coalesce(${adopted}::uuid, gen_random_uuid()),
          'requestport', 'ultra-compact', 'system', ${first.userId})
      `);
      return { organizationId, first: first.userId, second: second.userId };
    });

    const firstClient = await openSession(suiteStorage);
    const secondClient = await openSession(suiteStorage);
    try {
      await beginIsolated(firstClient);
      await beginIsolated(secondClient);
      const firstRepository = createAppearanceRepository(
        firstClient.db as unknown as Tx,
      );
      const secondRepository = createAppearanceRepository(
        secondClient.db as unknown as Tx,
      );

      expect(
        await firstRepository.lockOrganizationDefaults(seeded.organizationId),
      ).toMatchObject({ version: 1 });
      const blocked = secondRepository.lockOrganizationDefaults(
        seeded.organizationId,
      );
      expect(await waitForBlocked(blocked)).toBe(false);

      expect(
        await firstRepository.updateOrganizationDefaults({
          organizationId: seeded.organizationId,
          expectedVersion: 1,
          theme: "cue",
          density: "normal",
          mode: "dark",
          lastUpdatedByUserId: seeded.first,
        }),
      ).toMatchObject({ version: 2 });
      await firstClient.query("COMMIT");

      // The waiting writer sees the committed version, so its own
      // expected-version check — not a lost update — decides the outcome.
      expect(await blocked).toMatchObject({ version: 2, theme: "cue" });
      expect(
        await secondRepository.updateOrganizationDefaults({
          organizationId: seeded.organizationId,
          expectedVersion: 1,
          theme: "dusk",
          density: "large",
          mode: "light",
          lastUpdatedByUserId: seeded.second,
        }),
      ).toBeNull();
      await secondClient.query("ROLLBACK");
    } finally {
      await rollback(firstClient);
      await rollback(secondClient);
      firstClient.release();
      secondClient.release();
      await inIsolatedTransaction((tx) =>
        releaseChoreographyFixture(tx, {
          organizationId: seeded.organizationId,
          userIds: [seeded.first, seeded.second],
        }),
      );
    }
  });

  test("serializes two first-time personal writers for the same user", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    const seeded = await inIsolatedTransaction((tx) => seedUser(tx));
    const firstClient = await openSession(suiteStorage);
    const secondClient = await openSession(suiteStorage);
    try {
      await beginIsolated(firstClient);
      await beginIsolated(secondClient);
      const firstRepository = createAppearanceRepository(
        firstClient.db as unknown as Tx,
      );
      const secondRepository = createAppearanceRepository(
        secondClient.db as unknown as Tx,
      );

      expect(
        await firstRepository.lockUserPreferences(seeded.userId),
      ).toBeNull();
      const blocked = secondRepository.lockUserPreferences(seeded.userId);
      // Without the identity lock both writers would read "absent" and race to
      // insert the same primary key.
      expect(await waitForBlocked(blocked)).toBe(false);

      expect(
        await firstRepository.createUserPreferences({
          userId: seeded.userId,
          theme: "cue",
          density: null,
          mode: null,
        }),
      ).toMatchObject({ version: 1, theme: "cue" });
      await firstClient.query("COMMIT");

      expect(await blocked).toMatchObject({ version: 1, theme: "cue" });
      expect(
        await secondRepository.createUserPreferences({
          userId: seeded.userId,
          theme: "venu",
          density: null,
          mode: null,
        }),
      ).toBeNull();
      await secondClient.query("ROLLBACK");
    } finally {
      await rollback(firstClient);
      await rollback(secondClient);
      firstClient.release();
      secondClient.release();
      await inIsolatedTransaction((tx) =>
        releaseChoreographyFixture(tx, { userIds: [seeded.userId] }),
      );
    }
  });

  test("holds a concurrent membership revoke until the command commits", {
    timeout: lockChoreographyTimeoutMs,
  }, async (ctx) => {
    // Dispatching the command commits a version-2 event to
    // `public.domain_events`. Without 0014 nothing has written a version-1
    // event for it to follow: `publicAggregateId` returns null, the fixture
    // mints an aggregate of its own, and the stream that event opens is
    // undeletable — so this case does not run rather than leave one behind.
    ctx.skip(
      !cutoverInstalled,
      "0014 is not applied here, so the command would strand a version-2 event",
    );
    const seeded = await seedOwnedTenant();
    const writerClient = await openSession(suiteStorage);
    const revokerClient = await openSession(suiteStorage);
    const writer = await beginHeldTransaction(writerClient);
    const revoker = await beginHeldTransaction(revokerClient);
    try {
      const committed = (await tenantBus(writer.tx).execute({
        name: appearanceOrganizationCommandName,
        input: {
          organizationId: seeded.organizationId,
          theme: "signal",
          density: "normal",
          mode: "dark",
        },
        context: tenantContext({ ...seeded }),
        meta: {
          idempotencyKey: `appearance-revoke-race-${crypto.randomUUID()}`,
          expectedVersion: 1,
        },
      })) as AppearanceCommandResult;
      expect(committed.version).toBe(2);

      // The dispatch reauthorized through session → organization → exact
      // membership, all `FOR SHARE`, and still holds them. A revoke arriving
      // from the other side has to wait rather than slip between the recheck
      // and the write. Resolved once, so that the wait below and the `await`
      // after the commit share one update: a Drizzle query runs again each
      // time it is awaited, and the second run overlapped the first on this
      // connection (X24).
      const revoke = Promise.resolve(
        revoker.tx.execute(sql`
          update "organization_members" set "status" = 'revoked'
          where "organization_id" = ${seeded.organizationId}
            and "user_id" = ${seeded.userId}
        `),
      );
      expect(await waitForBlocked(revoke)).toBe(false);

      await writer.end("commit");
      // Neither side deadlocks: the waiter proceeds on its own once the
      // command's transaction releases the membership.
      await revoke;
      await revoker.end("commit");

      // The revoked owner cannot dispatch again, so the receipt is not a
      // durable capability that outlives the membership.
      const denied = await beginHeldTransaction(writerClient);
      try {
        await expect(
          tenantBus(denied.tx).execute({
            name: appearanceOrganizationCommandName,
            input: {
              organizationId: seeded.organizationId,
              theme: "dusk",
              density: "large",
              mode: "light",
            },
            context: tenantContext({ ...seeded }),
            meta: {
              idempotencyKey: `appearance-revoked-retry-${crypto.randomUUID()}`,
              expectedVersion: 2,
            },
          }),
        ).rejects.toMatchObject({ code: "forbidden" });
      } finally {
        await denied.end("rollback");
      }

      await inIsolatedTransaction(async (tx) => {
        expect(
          await createAppearanceRepository(tx).lockOrganizationDefaults(
            seeded.organizationId,
          ),
        ).toMatchObject({ version: 2, theme: "signal" });
        expect(
          await appearanceUpdateEvents(tx, seeded.organizationId),
        ).toHaveLength(1);
        expect(await appearanceAudits(tx, seeded.organizationId)).toHaveLength(
          1,
        );
        expect(
          (
            await tx.execute(sql`
              select "status" from "organization_members"
              where "organization_id" = ${seeded.organizationId}
                and "user_id" = ${seeded.userId}
            `)
          ).rows,
        ).toEqual([{ status: "revoked" }]);
      });
    } finally {
      await writer.end("rollback").catch(() => undefined);
      await revoker.end("rollback").catch(() => undefined);
      writerClient.release();
      revokerClient.release();
      await inIsolatedTransaction((tx) =>
        releaseChoreographyFixture(tx, {
          organizationId: seeded.organizationId,
          userIds: [seeded.userId],
          aggregateIds: [seeded.aggregateId],
        }),
      );
    }
  });

  test("blocks a duplicate dispatch on the receipt lock and replays it", {
    timeout: lockChoreographyTimeoutMs,
  }, async (ctx) => {
    // Skipped without 0014 for the reason above: the dispatch would open an
    // undeletable event stream at version 2.
    ctx.skip(
      !cutoverInstalled,
      "0014 is not applied here, so the command would strand a version-2 event",
    );
    const seeded = await seedOwnedTenant();
    const firstClient = await openSession(suiteStorage);
    const secondClient = await openSession(suiteStorage);
    const first = await beginHeldTransaction(firstClient);
    const second = await beginHeldTransaction(secondClient);
    try {
      const idempotencyKey = `appearance-receipt-race-${crypto.randomUUID()}`;
      const input = {
        organizationId: seeded.organizationId,
        theme: "hivehub",
        density: "large",
        mode: "light",
      };
      const dispatch = (tx: Tx) =>
        tenantBus(tx).execute({
          name: appearanceOrganizationCommandName,
          input,
          // A distinct correlation id per dispatch: the receipt identity is the
          // actor, the command and the key, never the request envelope.
          context: tenantContext({ ...seeded }),
          meta: { idempotencyKey, expectedVersion: 1 },
        });

      const executed = (await dispatch(first.tx)) as AppearanceCommandResult;
      expect(executed).toMatchObject({ version: 2, theme: "hivehub" });

      // `pg_advisory_xact_lock` is the first thing the bus takes, before any
      // authorization read, and it is held to the end of the top-level
      // transaction — so the duplicate cannot execute a second write.
      const duplicate = dispatch(second.tx);
      expect(await waitForBlocked(duplicate)).toBe(false);

      await first.end("commit");
      expect(await duplicate).toEqual(executed);
      await second.end("commit");

      await inIsolatedTransaction(async (tx) => {
        expect(
          await createAppearanceRepository(tx).lockOrganizationDefaults(
            seeded.organizationId,
          ),
        ).toMatchObject({ version: 2, theme: "hivehub" });
        expect(
          await appearanceUpdateEvents(tx, seeded.organizationId),
        ).toHaveLength(1);
        expect(await appearanceAudits(tx, seeded.organizationId)).toHaveLength(
          1,
        );
        expect(await commandReceiptCount(tx, seeded.aggregateId)).toEqual({
          receipts: 1,
        });
      });
    } finally {
      await first.end("rollback").catch(() => undefined);
      await second.end("rollback").catch(() => undefined);
      firstClient.release();
      secondClient.release();
      await inIsolatedTransaction((tx) =>
        releaseChoreographyFixture(tx, {
          organizationId: seeded.organizationId,
          userIds: [seeded.userId],
          aggregateIds: [seeded.aggregateId],
        }),
      );
    }
  });
});
