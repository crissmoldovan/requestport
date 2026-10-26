import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  actorFingerprint,
  createCoreCommandRegistry,
  DomainError,
  type DomainEvent,
  type JsonObject,
  keyedFingerprint,
  normalizedInputHash,
  operatorActor,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  commandReceipts,
  domainEvents,
  invitations,
  notificationIntents,
  organizationMembers,
  outbox,
  securityAuditRecords,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import {
  endingEachCommandBinding,
  endingEachMethodBinding,
} from "../test-support/tenant-binding.js";
import type { Tx } from "../transaction.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";
import { createCommandTransactionManager } from "./command-repository.js";
import { createFoundationRepository } from "./foundation-repository.js";
import { createNotificationRepository } from "./notification-repository.js";
import { createOperatorCredentialRepository } from "./operator-credential-repository.js";
import { createOrganizationManagementRepository } from "./organization-management-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  The first real-database suite for the organisation management repository
  (Plan 13, F.2.7; `manifest-f2.md` §2.7), and for inviting on the foundation
  repository's invitation methods. Every write goes through the command bus the
  members page's forms use and REST will use, with the real unit of work, the
  real `organizationManagement` and `foundation` ports and the real
  `assertCurrent`, so what is proved here is the handler both reach.

  Each case runs inside a transaction that is rolled back at the end, and
  reports its own failure rather than the rollback's. The bus opens its own
  transaction per command, which Drizzle turns into a savepoint inside the
  outer one.
*/

const busSecret = "organization-management-live-bus-secret-0000000";
const formSecret = "organization-management-live-form-secret-000000";

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  let failure: unknown;
  await expect(
    suiteStorage.transaction(async (tx) => {
      try {
        await run(tx);
      } catch (error) {
        failure = error;
      }
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
  if (failure !== undefined) throw failure;
}

/**
 * The ports the bus opens. Operator credentials are switched on here, as a
 * deployment with `REQUESTPORT_OPERATOR_CREDENTIALS=enabled` has them (the
 * switch changes nothing for a person); with it off `assertCurrent` refuses
 * every operator before these commands run (F.3's own suite holds that).
 */
function portFactory(name: string, database: Database | Tx) {
  if (name === "organizationManagement")
    return createOrganizationManagementRepository(database);
  if (name === "foundation") return createFoundationRepository(database);
  if (name === "commandAuthorization")
    return createCommandAuthorizationRepository(database, {
      operatorCredentials: "enabled",
    });
  return undefined;
}

/**
 * The bus as the web builds it. `withAssertCurrent: false` leaves the
 * credential re-check out, so a case can show that a command refuses a
 * machine actor itself, whatever the bus in front of it does.
 */
function bus(
  tx: Tx,
  options: {
    withAssertCurrent?: boolean;
    committed?: DomainEvent[];
  } = {},
) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    // A case runs commands for several people or organisations on one
    // transaction; each command's binding ends with it, as its own
    // transaction ends it in production (test-support/tenant-binding.ts).
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(tx as unknown as Database, portFactory),
      tx,
    ),
    fingerprintSecret: busSecret,
    afterCommit: async (events) => {
      options.committed?.push(...events);
    },
    ...(options.withAssertCurrent === false
      ? {}
      : {
          authorizeContext: (context: AuthorizedCommandContext, uow) =>
            uow
              .port<ReturnType<typeof createCommandAuthorizationRepository>>(
                "commandAuthorization",
              )
              .assertCurrent(context),
        }),
  });
}

type Person = { userId: string; sessionId: string };

async function seedPerson(tx: Tx): Promise<Person> {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Organization management user', ${email}, now())
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
    values (${organizationId}, 'Organization management tenant',
      ${`organization-management-live-${organizationId}`}, 'active')
  `);
  return organizationId;
}

type Role = "owner" | "admin" | "member";

async function seedMembership(
  tx: Tx,
  organizationId: string,
  userId: string,
  role: Role,
  status: "active" | "revoked" = "active",
) {
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, ${status})
  `);
}

async function seedMember(
  tx: Tx,
  organizationId: string,
  role: Role,
  status: "active" | "revoked" = "active",
) {
  const person = await seedPerson(tx);
  await seedMembership(tx, organizationId, person.userId, role, status);
  return person;
}

/** An organisation with an owner, an admin and two members. */
async function seedTenant(tx: Tx) {
  const organizationId = await seedOrganization(tx);
  return {
    organizationId,
    owner: await seedMember(tx, organizationId, "owner"),
    admin: await seedMember(tx, organizationId, "admin"),
    member: await seedMember(tx, organizationId, "member"),
    target: await seedMember(tx, organizationId, "member"),
  };
}

type Tenant = Awaited<ReturnType<typeof seedTenant>>;

async function seedInvitation(
  tx: Tx,
  organizationId: string,
  createdBy: string,
  role: Role,
  state: "pending" | "revoked" | "accepted" = "pending",
) {
  const [row] = await tx
    .insert(invitations)
    .values({
      organizationId,
      normalizedEmail: `invited-${crypto.randomUUID()}@example.invalid`,
      role,
      tokenHash: `test-token-hash-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdByUserId: createdBy,
      ...(state === "revoked" ? { revokedAt: new Date() } : {}),
      ...(state === "accepted" ? { acceptedAt: new Date() } : {}),
    })
    .returning({ id: invitations.id });
  if (!row) throw new Error("no invitation");
  return row.id;
}

function humanContext(
  person: Person,
  organizationId: string,
  scopes: readonly string[] = ["members:manage"],
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: person.userId },
    organizationId,
    scopes: new Set(scopes),
    credentialId: person.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

function key() {
  return `organization-management-live-${crypto.randomUUID()}`;
}

async function run(
  tx: Tx,
  input: {
    name: string;
    context: AuthorizedCommandContext;
    fields: Record<string, unknown>;
    expectedVersion?: number;
    idempotencyKey?: string;
    committed?: DomainEvent[];
    withAssertCurrent?: boolean;
  },
) {
  return bus(tx, {
    committed: input.committed,
    withAssertCurrent: input.withAssertCurrent,
  }).execute<unknown, JsonObject>({
    name: input.name,
    context: input.context,
    input: { organizationId: input.context.organizationId, ...input.fields },
    meta: {
      idempotencyKey: input.idempotencyKey ?? key(),
      expectedVersion: input.expectedVersion ?? 1,
    },
  });
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the command was not refused");
}

async function membership(tx: Tx, organizationId: string, userId: string) {
  const [row] = await tx
    .select({
      id: organizationMembers.id,
      role: organizationMembers.role,
      status: organizationMembers.status,
      version: organizationMembers.version,
    })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    );
  if (!row) throw new Error("no membership");
  return row;
}

async function invitation(tx: Tx, invitationId: string) {
  const [row] = await tx
    .select({
      version: invitations.version,
      revokedAt: invitations.revokedAt,
      role: invitations.role,
      normalizedEmail: invitations.normalizedEmail,
    })
    .from(invitations)
    .where(eq(invitations.id, invitationId));
  if (!row) throw new Error("no invitation");
  return row;
}

async function invitationsFor(tx: Tx, organizationId: string) {
  return tx
    .select({
      id: invitations.id,
      role: invitations.role,
      normalizedEmail: invitations.normalizedEmail,
      createdByUserId: invitations.createdByUserId,
    })
    .from(invitations)
    .where(eq(invitations.organizationId, organizationId));
}

async function auditRows(tx: Tx, organizationId: string) {
  return tx
    .select({
      actorType: securityAuditRecords.actorType,
      actorId: securityAuditRecords.actorId,
      action: securityAuditRecords.action,
      targetId: securityAuditRecords.targetId,
    })
    .from(securityAuditRecords)
    .where(
      and(
        eq(securityAuditRecords.organizationId, organizationId),
        sql`${securityAuditRecords.action} like 'organization.%'`,
      ),
    );
}

async function organizationEvents(tx: Tx, organizationId: string) {
  return tx
    .select({
      id: domainEvents.id,
      type: domainEvents.type,
      aggregateId: domainEvents.aggregateId,
      aggregateVersion: domainEvents.aggregateVersion,
      actor: domainEvents.actor,
      data: domainEvents.data,
      outboxState: outbox.state,
    })
    .from(domainEvents)
    .leftJoin(outbox, eq(outbox.eventId, domainEvents.id))
    .where(
      and(
        eq(domainEvents.organizationId, organizationId),
        sql`${domainEvents.type} like 'organization.%'`,
      ),
    );
}

/** Every receipt the case's transaction wrote, under any name and actor. */
async function receiptsWrittenHere(tx: Tx) {
  return tx
    .select({
      actorFingerprint: commandReceipts.actorFingerprint,
      commandName: commandReceipts.commandName,
      idempotencyFingerprint: commandReceipts.idempotencyFingerprint,
      result: commandReceipts.resultJson,
    })
    .from(commandReceipts)
    .where(sql`${commandReceipts.createdAt} = now()`);
}

async function endSession(tx: Tx, person: Person) {
  await tx.execute(sql`
    update "session" set "expires_at" = now() - interval '1 minute'
    where "id" = ${person.sessionId}
  `);
}

async function setOrganizationStatus(
  tx: Tx,
  organizationId: string,
  status: "active" | "suspended",
) {
  await tx.execute(sql`
    update "organizations" set "status" = ${status}
    where "id" = ${organizationId}
  `);
}

async function setRole(
  tx: Tx,
  organizationId: string,
  userId: string,
  role: Role,
) {
  await tx
    .update(organizationMembers)
    .set({ role })
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    );
}

afterAll(async () => {
  await suiteStorage.close();
});

/* ------------------------------------------------------------------------ */

const setMember = "set_organization_member";

function change(
  tenant: Tenant,
  overrides: Partial<{ userId: string; role: Role; status: string }> = {},
) {
  return {
    userId: tenant.target.userId,
    role: "admin" as Role,
    status: "active",
    ...overrides,
  };
}

describe("set_organization_member, on the real database", () => {
  test.each(["owner", "admin"] as const)(
    "an %s changes a member's role: version 2, one user audit row, one event with its outbox row",
    async (actorRole) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const actor = tenant[actorRole];
        const context = humanContext(actor, tenant.organizationId);
        const result = await run(tx, {
          name: setMember,
          context,
          fields: change(tenant),
        });
        const row = await membership(
          tx,
          tenant.organizationId,
          tenant.target.userId,
        );

        expect(row).toMatchObject({
          role: "admin",
          status: "active",
          version: 2,
        });
        expect(result).toEqual({
          id: row.id,
          role: "admin",
          status: "active",
          version: 2,
        });
        expect(await auditRows(tx, tenant.organizationId)).toEqual([
          {
            actorType: "user",
            actorId: actor.userId,
            action: "organization.member_changed",
            targetId: row.id,
          },
        ]);
        const events = await organizationEvents(tx, tenant.organizationId);
        expect(events).toEqual([
          expect.objectContaining({
            type: "organization.member_changed.v1",
            aggregateId: row.id,
            aggregateVersion: 2,
            actor: { type: "user", id: actor.userId },
            data: { membershipId: row.id, role: "admin", status: "active" },
            outboxState: "pending",
          }),
        ]);
      });
    },
  );

  test("an owner revokes a member's access, and promotes a member to owner", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const context = () => humanContext(tenant.owner, tenant.organizationId);
      await run(tx, {
        name: setMember,
        context: context(),
        fields: change(tenant, { role: "member", status: "revoked" }),
      });
      await run(tx, {
        name: setMember,
        context: context(),
        fields: change(tenant, { userId: tenant.member.userId, role: "owner" }),
      });

      expect(
        await membership(tx, tenant.organizationId, tenant.target.userId),
      ).toMatchObject({ role: "member", status: "revoked", version: 2 });
      expect(
        await membership(tx, tenant.organizationId, tenant.member.userId),
      ).toMatchObject({ role: "owner", status: "active", version: 2 });
    });
  });

  test.each([
    ["an active member", "member", "active"],
    ["a revoked owner", "owner", "revoked"],
    ["a revoked admin", "admin", "revoked"],
  ] as const)(
    "%s is refused, and nothing is written, audited or receipted",
    async (_label, role, status) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const actor = await seedMember(tx, tenant.organizationId, role, status);
        const error = await refusal(
          run(tx, {
            name: setMember,
            context: humanContext(actor, tenant.organizationId),
            fields: change(tenant),
          }),
        );

        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({ code: "forbidden" });
        expect(
          await membership(tx, tenant.organizationId, tenant.target.userId),
        ).toMatchObject({ role: "member", version: 1 });
        expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
        expect(await receiptsWrittenHere(tx)).toEqual([]);
      });
    },
  );

  test.each([
    [
      "an owner's role",
      (tenant: Tenant) => ({
        userId: tenant.owner.userId,
        role: "admin" as Role,
      }),
    ],
    ["a promotion to owner", (_tenant: Tenant) => ({ role: "owner" as Role })],
  ])(
    "an admin is refused %s: only an owner manages owners",
    async (_label, overrides) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const error = await refusal(
          run(tx, {
            name: setMember,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: change(tenant, overrides(tenant)),
          }),
        );

        expect(error).toMatchObject({
          code: "forbidden",
          message: "Only an owner may manage owners",
        });
        expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
        expect(await receiptsWrittenHere(tx)).toEqual([]);
      });
    },
  );

  test("nobody revokes their own access", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      await seedMember(tx, tenant.organizationId, "owner");
      const error = await refusal(
        run(tx, {
          name: setMember,
          context: humanContext(tenant.owner, tenant.organizationId),
          fields: change(tenant, {
            userId: tenant.owner.userId,
            role: "owner",
            status: "revoked",
          }),
        }),
      );

      expect(error).toMatchObject({
        code: "forbidden",
        message: "Use another owner to revoke your organization access",
      });
      expect(
        await membership(tx, tenant.organizationId, tenant.owner.userId),
      ).toMatchObject({ status: "active", version: 1 });
    });
  });

  test("the last active owner cannot be demoted; with a second owner, one owner may demote the other", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const error = await refusal(
        run(tx, {
          name: setMember,
          context: humanContext(tenant.owner, tenant.organizationId),
          fields: change(tenant, {
            userId: tenant.owner.userId,
            role: "admin",
          }),
        }),
      );
      expect(error).toMatchObject({
        code: "conflict",
        message: "The organization must retain an active owner",
      });
      expect(
        await membership(tx, tenant.organizationId, tenant.owner.userId),
      ).toMatchObject({ role: "owner", version: 1 });

      const second = await seedMember(tx, tenant.organizationId, "owner");
      await run(tx, {
        name: setMember,
        context: humanContext(second, tenant.organizationId),
        fields: change(tenant, { userId: tenant.owner.userId, role: "admin" }),
      });
      expect(
        await membership(tx, tenant.organizationId, tenant.owner.userId),
      ).toMatchObject({ role: "admin", version: 2 });
    });
  });

  test("a suspended organisation and an ended session are refused by the re-check", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      await endSession(tx, tenant.owner);
      expect(
        await refusal(
          run(tx, {
            name: setMember,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: change(tenant),
          }),
        ),
      ).toMatchObject({ code: "forbidden" });

      await setOrganizationStatus(tx, tenant.organizationId, "suspended");
      expect(
        await refusal(
          run(tx, {
            name: setMember,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: change(tenant),
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
      expect(
        await membership(tx, tenant.organizationId, tenant.target.userId),
      ).toMatchObject({ role: "member", version: 1 });
      expect(await receiptsWrittenHere(tx)).toEqual([]);
    });
  });

  test("another organisation's member is not found, for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const away = await seedTenant(tx);
      await seedMembership(tx, away.organizationId, home.owner.userId, "owner");
      const error = await refusal(
        run(tx, {
          name: setMember,
          context: humanContext(home.owner, home.organizationId),
          fields: change(away),
        }),
      );

      expect(error).toMatchObject({
        code: "not_found",
        message: "Organization member was not found",
      });
      expect(
        await membership(tx, away.organizationId, away.target.userId),
      ).toMatchObject({ role: "member", version: 1 });
      expect(await auditRows(tx, away.organizationId)).toEqual([]);
    });
  });

  test("a stale version answers version_conflict and writes nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const error = await refusal(
        run(tx, {
          name: setMember,
          context: humanContext(tenant.owner, tenant.organizationId),
          fields: change(tenant),
          expectedVersion: 2,
        }),
      );

      expect(error).toMatchObject({ code: "version_conflict" });
      expect(
        await membership(tx, tenant.organizationId, tenant.target.userId),
      ).toMatchObject({ role: "member", version: 1 });
      expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
    });
  });

  test("the role and status it already has write nothing, and answer the row as it is", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const result = await run(tx, {
        name: setMember,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: change(tenant, { role: "member" }),
      });

      expect(result).toMatchObject({ role: "member", version: 1 });
      expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
      expect(await organizationEvents(tx, tenant.organizationId)).toEqual([]);
    });
  });

  test("a replay answers the first result with one audit row and one event; other input under the key is idempotency_conflict", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const first = await run(tx, {
        name: setMember,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: change(tenant),
        idempotencyKey,
      });
      const replay = await run(tx, {
        name: setMember,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: change(tenant),
        idempotencyKey,
      });

      expect(replay).toEqual(first);
      expect(await auditRows(tx, tenant.organizationId)).toHaveLength(1);
      expect(await organizationEvents(tx, tenant.organizationId)).toHaveLength(
        1,
      );
      expect(
        await refusal(
          run(tx, {
            name: setMember,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: change(tenant, { role: "member" }),
            idempotencyKey,
          }),
        ),
      ).toMatchObject({ code: "idempotency_conflict" });
    });
  });

  test("a replay after the person is demoted to member is refused, not answered", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      await run(tx, {
        name: setMember,
        context: humanContext(tenant.admin, tenant.organizationId),
        fields: change(tenant),
        idempotencyKey,
      });
      await setRole(tx, tenant.organizationId, tenant.admin.userId, "member");

      expect(
        await refusal(
          run(tx, {
            name: setMember,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: change(tenant),
            idempotencyKey,
          }),
        ),
      ).toMatchObject({
        code: "forbidden",
        message: "Organization administration is required",
      });
    });
  });

  test("a replay of an owner change after the person is demoted from owner to admin is refused, not answered", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const second = await seedMember(tx, tenant.organizationId, "owner");
      const idempotencyKey = key();
      const fields = change(tenant, { role: "owner" });
      await run(tx, {
        name: setMember,
        context: humanContext(second, tenant.organizationId),
        fields,
        idempotencyKey,
      });
      await setRole(tx, tenant.organizationId, second.userId, "admin");

      expect(
        await refusal(
          run(tx, {
            name: setMember,
            context: humanContext(second, tenant.organizationId),
            fields,
            idempotencyKey,
          }),
        ),
      ).toMatchObject({
        code: "forbidden",
        message: "Only an owner may manage owners",
      });
    });
  });

  test("an unknown member is not found", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      expect(
        await refusal(
          run(tx, {
            name: setMember,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: change(tenant, { userId: `user_${crypto.randomUUID()}` }),
          }),
        ),
      ).toMatchObject({ code: "not_found" });
    });
  });

  test("leaves exactly one receipt, the bus's, holding its result, across every name and actor", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const result = await run(tx, {
        name: setMember,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: change(tenant),
        idempotencyKey,
      });

      expect(await receiptsWrittenHere(tx)).toEqual([
        {
          actorFingerprint: actorFingerprint({
            type: "user",
            id: tenant.owner.userId,
          }),
          commandName: setMember,
          idempotencyFingerprint: keyedFingerprint(busSecret, idempotencyKey),
          result,
        },
      ]);
    });
  });

  test("a form retried across the deploy with the same key misses the old receipt and meets the version check", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const fields = change(tenant);
      // The first submission, before the deploy: the repository wrote the
      // change and its own receipt, keyed with the form's secret.
      await run(tx, {
        name: setMember,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields,
      });
      await tx.insert(commandReceipts).values({
        actorFingerprint: actorFingerprint({
          type: "user",
          id: tenant.owner.userId,
        }),
        commandName: setMember,
        idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
        normalizedInputHash: normalizedInputHash({
          userId: fields.userId,
          role: fields.role,
          status: fields.status,
        }),
        resultJson: { role: "admin" },
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      expect(
        await refusal(
          run(tx, {
            name: setMember,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields,
            idempotencyKey,
          }),
        ),
      ).toMatchObject({ code: "version_conflict" });
      expect(
        await membership(tx, tenant.organizationId, tenant.target.userId),
      ).toMatchObject({ version: 2 });
    });
  });
});

/* ------------------------------------------------------------------------ */

const revoke = "revoke_organization_invitation";

describe("revoke_organization_invitation, on the real database", () => {
  test.each(["owner", "admin"] as const)(
    "an %s revokes a member invitation: version 2, one user audit row, one event with its outbox row",
    async (actorRole) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const actor = tenant[actorRole];
        const invitationId = await seedInvitation(
          tx,
          tenant.organizationId,
          tenant.owner.userId,
          "member",
        );
        const result = await run(tx, {
          name: revoke,
          context: humanContext(actor, tenant.organizationId),
          fields: { invitationId },
        });

        expect(result).toEqual({ id: invitationId, version: 2 });
        expect(await invitation(tx, invitationId)).toMatchObject({
          version: 2,
          revokedAt: expect.any(Date),
        });
        expect(await auditRows(tx, tenant.organizationId)).toEqual([
          {
            actorType: "user",
            actorId: actor.userId,
            action: "organization.invitation_revoked",
            targetId: invitationId,
          },
        ]);
        expect(await organizationEvents(tx, tenant.organizationId)).toEqual([
          expect.objectContaining({
            type: "organization.invitation_revoked.v1",
            aggregateId: invitationId,
            aggregateVersion: 2,
            actor: { type: "user", id: actor.userId },
            data: { invitationId },
            outboxState: "pending",
          }),
        ]);
      });
    },
  );

  test("an owner invitation is revoked by an owner, and refused to an admin", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const invitationId = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "owner",
      );
      expect(
        await refusal(
          run(tx, {
            name: revoke,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: { invitationId },
          }),
        ),
      ).toMatchObject({
        code: "forbidden",
        message: "Only an owner may revoke an owner invitation",
      });
      expect(await invitation(tx, invitationId)).toMatchObject({
        version: 1,
        revokedAt: null,
      });
      expect(await receiptsWrittenHere(tx)).toEqual([]);

      await run(tx, {
        name: revoke,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: { invitationId },
      });
      expect(await invitation(tx, invitationId)).toMatchObject({ version: 2 });
    });
  });

  test.each([
    ["an active member", "member", "active"],
    ["a revoked owner", "owner", "revoked"],
    ["a revoked admin", "admin", "revoked"],
  ] as const)(
    "%s is refused, and nothing is written, audited or receipted",
    async (_label, role, status) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const actor = await seedMember(tx, tenant.organizationId, role, status);
        const invitationId = await seedInvitation(
          tx,
          tenant.organizationId,
          tenant.owner.userId,
          "member",
        );
        expect(
          await refusal(
            run(tx, {
              name: revoke,
              context: humanContext(actor, tenant.organizationId),
              fields: { invitationId },
            }),
          ),
        ).toMatchObject({ code: "forbidden" });
        expect(await invitation(tx, invitationId)).toMatchObject({
          version: 1,
          revokedAt: null,
        });
        expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
        expect(await receiptsWrittenHere(tx)).toEqual([]);
      });
    },
  );

  test("a suspended organisation and an ended session are refused by the re-check", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const invitationId = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      await endSession(tx, tenant.owner);
      expect(
        await refusal(
          run(tx, {
            name: revoke,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: { invitationId },
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
      await setOrganizationStatus(tx, tenant.organizationId, "suspended");
      expect(
        await refusal(
          run(tx, {
            name: revoke,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: { invitationId },
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
      expect(await invitation(tx, invitationId)).toMatchObject({ version: 1 });
    });
  });

  test("another organisation's invitation is not found, for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const away = await seedTenant(tx);
      await seedMembership(tx, away.organizationId, home.owner.userId, "owner");
      const invitationId = await seedInvitation(
        tx,
        away.organizationId,
        away.owner.userId,
        "member",
      );
      expect(
        await refusal(
          run(tx, {
            name: revoke,
            context: humanContext(home.owner, home.organizationId),
            fields: { invitationId },
          }),
        ),
      ).toMatchObject({
        code: "not_found",
        message: "Invitation was not found",
      });
      expect(await invitation(tx, invitationId)).toMatchObject({
        version: 1,
        revokedAt: null,
      });
    });
  });

  test("a stale version is version_conflict; an invitation no longer pending is invalid_transition", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const pending = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      expect(
        await refusal(
          run(tx, {
            name: revoke,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: { invitationId: pending },
            expectedVersion: 2,
          }),
        ),
      ).toMatchObject({ code: "version_conflict" });

      for (const state of ["revoked", "accepted"] as const) {
        const done = await seedInvitation(
          tx,
          tenant.organizationId,
          tenant.owner.userId,
          "member",
          state,
        );
        expect(
          await refusal(
            run(tx, {
              name: revoke,
              context: humanContext(tenant.owner, tenant.organizationId),
              fields: { invitationId: done },
            }),
          ),
        ).toMatchObject({ code: "invalid_transition" });
      }
      expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
    });
  });

  test("a replay answers the first result; other input under the key is idempotency_conflict; after demotion it is refused", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const invitationId = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      const other = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      const idempotencyKey = key();
      const first = await run(tx, {
        name: revoke,
        context: humanContext(tenant.admin, tenant.organizationId),
        fields: { invitationId },
        idempotencyKey,
      });
      expect(
        await run(tx, {
          name: revoke,
          context: humanContext(tenant.admin, tenant.organizationId),
          fields: { invitationId },
          idempotencyKey,
        }),
      ).toEqual(first);
      expect(await auditRows(tx, tenant.organizationId)).toHaveLength(1);
      expect(await organizationEvents(tx, tenant.organizationId)).toHaveLength(
        1,
      );
      expect(
        await refusal(
          run(tx, {
            name: revoke,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: { invitationId: other },
            idempotencyKey,
          }),
        ),
      ).toMatchObject({ code: "idempotency_conflict" });

      await setRole(tx, tenant.organizationId, tenant.admin.userId, "member");
      expect(
        await refusal(
          run(tx, {
            name: revoke,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: { invitationId },
            idempotencyKey,
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
    });
  });

  test("leaves exactly one receipt, the bus's; a pre-deploy receipt under the form's secret is missed, and the retry meets the version check", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const invitationId = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      const idempotencyKey = key();
      const result = await run(tx, {
        name: revoke,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: { invitationId },
        idempotencyKey,
      });
      const owner = actorFingerprint({ type: "user", id: tenant.owner.userId });
      expect(await receiptsWrittenHere(tx)).toEqual([
        {
          actorFingerprint: owner,
          commandName: revoke,
          idempotencyFingerprint: keyedFingerprint(busSecret, idempotencyKey),
          result,
        },
      ]);

      const retried = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      const retryKey = key();
      await run(tx, {
        name: revoke,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: { invitationId: retried },
      });
      await tx.insert(commandReceipts).values({
        actorFingerprint: owner,
        commandName: revoke,
        idempotencyFingerprint: keyedFingerprint(formSecret, retryKey),
        normalizedInputHash: normalizedInputHash({ invitationId: retried }),
        resultJson: { id: retried, version: 2 },
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      expect(
        await refusal(
          run(tx, {
            name: revoke,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: { invitationId: retried },
            idempotencyKey: retryKey,
          }),
        ),
      ).toMatchObject({ code: "version_conflict" });
    });
  });
});

/* ------------------------------------------------------------------------ */

const invite = "invite_organization_member";

function invitationFields(overrides: Record<string, unknown> = {}) {
  return {
    email: `Invited-${crypto.randomUUID()}@Example.invalid`,
    role: "member",
    ...overrides,
  };
}

describe("invite_organization_member, on the real database", () => {
  test.each([
    ["owner", "owner"],
    ["owner", "admin"],
    ["admin", "admin"],
    ["admin", "member"],
  ] as const)(
    "an %s invites %s: one invitation, one user audit row, one event the bus dispatches after commit",
    async (actorRole, role) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const actor = tenant[actorRole];
        const committed: DomainEvent[] = [];
        const fields = invitationFields({ role });
        const result = await run(tx, {
          name: invite,
          context: humanContext(actor, tenant.organizationId),
          fields,
          expectedVersion: 0,
          committed,
        });
        const [row] = await invitationsFor(tx, tenant.organizationId);

        expect(row).toEqual({
          id: expect.any(String),
          role,
          normalizedEmail: String(fields.email).toLowerCase(),
          createdByUserId: actor.userId,
        });
        expect(result).toEqual({
          id: row?.id,
          role,
          expiresAt: expect.any(String),
          created: true,
        });
        expect(JSON.stringify(result)).not.toContain("example.invalid");
        expect(await auditRows(tx, tenant.organizationId)).toEqual([
          {
            actorType: "user",
            actorId: actor.userId,
            action: "organization.invitation_created",
            targetId: row?.id,
          },
        ]);
        const events = await organizationEvents(tx, tenant.organizationId);
        expect(events).toEqual([
          expect.objectContaining({
            type: "organization.invitation_created.v1",
            aggregateId: row?.id,
            aggregateVersion: 1,
            actor: { type: "user", id: actor.userId },
            data: {
              invitationId: row?.id,
              role,
              expiresAt: result.expiresAt,
            },
            outboxState: "pending",
          }),
        ]);
        expect(committed.map((event) => event.id)).toEqual([events[0]?.id]);
      });
    },
  );

  test.each([
    ["an admin inviting an owner", "admin", "active", "owner"],
    ["an active member", "member", "active", "member"],
    ["a revoked owner", "owner", "revoked", "member"],
  ] as const)(
    "%s is refused, and nothing is written, audited or receipted",
    async (_label, role, status, invitedRole) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const actor = await seedMember(tx, tenant.organizationId, role, status);
        expect(
          await refusal(
            run(tx, {
              name: invite,
              context: humanContext(actor, tenant.organizationId),
              fields: invitationFields({ role: invitedRole }),
              expectedVersion: 0,
            }),
          ),
        ).toMatchObject({ code: "forbidden" });
        expect(await invitationsFor(tx, tenant.organizationId)).toEqual([]);
        expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
        expect(await receiptsWrittenHere(tx)).toEqual([]);
      });
    },
  );

  test("a suspended organisation and an ended session are refused by the re-check", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      await endSession(tx, tenant.owner);
      expect(
        await refusal(
          run(tx, {
            name: invite,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: invitationFields(),
            expectedVersion: 0,
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
      await setOrganizationStatus(tx, tenant.organizationId, "suspended");
      expect(
        await refusal(
          run(tx, {
            name: invite,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: invitationFields(),
            expectedVersion: 0,
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
      expect(await invitationsFor(tx, tenant.organizationId)).toEqual([]);
    });
  });

  test("an active invitation to the same address and role answers created false; another role is a conflict on email, already_invited", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const fields = invitationFields();
      const committed: DomainEvent[] = [];
      const first = await run(tx, {
        name: invite,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields,
        expectedVersion: 0,
      });
      const again = await run(tx, {
        name: invite,
        context: humanContext(tenant.admin, tenant.organizationId),
        fields: { ...fields, email: ` ${String(fields.email).toUpperCase()} ` },
        expectedVersion: 0,
        committed,
      });

      expect(again).toEqual({ ...first, created: false });
      expect(committed).toEqual([]);
      expect(await invitationsFor(tx, tenant.organizationId)).toHaveLength(1);
      expect(await auditRows(tx, tenant.organizationId)).toHaveLength(1);
      expect(
        await refusal(
          run(tx, {
            name: invite,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: { ...fields, role: "admin" },
            expectedVersion: 0,
          }),
        ),
      ).toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "already_invited" },
      });
    });
  });

  // Until X15 this case pinned main's answer: a revoked address could never be
  // invited again. X15 renews the address's one row instead; its own suite,
  // foundation-repository.invitation-renewal.integration.test.ts, holds the
  // rest of the command's renewal and refusal cases.
  test("an address whose invitation was revoked is invited again by renewing its one row, evented at the new version", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const fields = invitationFields();
      const first = await run(tx, {
        name: invite,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields,
        expectedVersion: 0,
      });
      await run(tx, {
        name: revoke,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: { invitationId: first.id },
      });

      const committed: DomainEvent[] = [];
      const again = await run(tx, {
        name: invite,
        context: humanContext(tenant.admin, tenant.organizationId),
        fields,
        expectedVersion: 0,
        committed,
      });

      expect(again).toEqual({
        id: first.id,
        role: first.role,
        expiresAt: expect.any(String),
        created: true,
      });
      expect(await invitationsFor(tx, tenant.organizationId)).toHaveLength(1);
      expect(await invitation(tx, String(first.id))).toMatchObject({
        version: 3,
        revokedAt: null,
      });
      // Sorted: the rows of one transaction share their time, and the table
      // has no other order.
      expect(
        (await auditRows(tx, tenant.organizationId))
          .map((row) => row.action)
          .sort(),
      ).toEqual([
        "organization.invitation_created",
        "organization.invitation_renewed",
        "organization.invitation_revoked",
      ]);
      const renewal = (
        await organizationEvents(tx, tenant.organizationId)
      ).find((event) => event.aggregateVersion === 3);
      expect(renewal).toMatchObject({
        type: "organization.invitation_created.v1",
        aggregateId: first.id,
        actor: { type: "user", id: tenant.admin.userId },
        data: {
          invitationId: first.id,
          role: first.role,
          expiresAt: again.expiresAt,
          renewedFrom: "revoked",
        },
        outboxState: "pending",
      });
      expect(committed.map((event) => event.id)).toEqual([renewal?.id]);
    });
  });

  test("a replay answers the first result with one invitation and one event; other input under the key is idempotency_conflict; after demotion it is refused", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const fields = invitationFields();
      const committed: DomainEvent[] = [];
      const first = await run(tx, {
        name: invite,
        context: humanContext(tenant.admin, tenant.organizationId),
        fields,
        expectedVersion: 0,
        idempotencyKey,
      });
      expect(
        await run(tx, {
          name: invite,
          context: humanContext(tenant.admin, tenant.organizationId),
          fields,
          expectedVersion: 0,
          idempotencyKey,
          committed,
        }),
      ).toEqual(first);
      expect(committed).toEqual([]);
      expect(await invitationsFor(tx, tenant.organizationId)).toHaveLength(1);
      expect(await organizationEvents(tx, tenant.organizationId)).toHaveLength(
        1,
      );
      expect(
        await refusal(
          run(tx, {
            name: invite,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: invitationFields(),
            expectedVersion: 0,
            idempotencyKey,
          }),
        ),
      ).toMatchObject({ code: "idempotency_conflict" });

      await setRole(tx, tenant.organizationId, tenant.admin.userId, "member");
      expect(
        await refusal(
          run(tx, {
            name: invite,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields,
            expectedVersion: 0,
            idempotencyKey,
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
    });
  });

  test("a new invitation at any version but 0 is version_conflict, and writes nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      expect(
        await refusal(
          run(tx, {
            name: invite,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: invitationFields(),
            expectedVersion: 1,
          }),
        ),
      ).toMatchObject({ code: "version_conflict" });
      expect(await invitationsFor(tx, tenant.organizationId)).toEqual([]);
    });
  });

  test("leaves exactly one receipt, the bus's, with no address in it", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const result = await run(tx, {
        name: invite,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: invitationFields(),
        expectedVersion: 0,
        idempotencyKey,
      });

      const receipts = await receiptsWrittenHere(tx);
      expect(receipts).toEqual([
        {
          actorFingerprint: actorFingerprint({
            type: "user",
            id: tenant.owner.userId,
          }),
          commandName: invite,
          idempotencyFingerprint: keyedFingerprint(busSecret, idempotencyKey),
          result,
        },
      ]);
      expect(JSON.stringify(receipts)).not.toContain("example.invalid");
    });
  });
});

/* ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ */

const resend = "resend_organization_invitation";
const emailBaseUrl = "https://requestport.invalid";
const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

/** The invitation row as a resend changes it, its token hash included. */
async function issuedInvitation(tx: Tx, invitationId: string) {
  const [row] = await tx
    .select({
      version: invitations.version,
      role: invitations.role,
      tokenHash: invitations.tokenHash,
      createdAt: invitations.createdAt,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
      createdByUserId: invitations.createdByUserId,
    })
    .from(invitations)
    .where(eq(invitations.id, invitationId));
  if (!row) throw new Error("no invitation");
  return row;
}

describe("resend_organization_invitation, on the real database", () => {
  test.each(["owner", "admin"] as const)(
    "an %s resends a pending member invitation: a new token, the lifetime a new invitation gets, version 2, one user audit row, and the invitation's own event at the new version, dispatched after commit",
    async (actorRole) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const actor = tenant[actorRole];
        const invitationId = await seedInvitation(
          tx,
          tenant.organizationId,
          tenant.owner.userId,
          "member",
        );
        const before = await issuedInvitation(tx, invitationId);
        const committed: DomainEvent[] = [];
        const result = await run(tx, {
          name: resend,
          context: humanContext(actor, tenant.organizationId),
          fields: { invitationId },
          committed,
        });
        const after = await issuedInvitation(tx, invitationId);

        expect(result).toEqual({
          id: invitationId,
          role: "member",
          expiresAt: after.expiresAt.toISOString(),
          version: 2,
        });
        expect(after).toMatchObject({
          version: 2,
          role: "member",
          acceptedAt: null,
          revokedAt: null,
          createdByUserId: tenant.owner.userId,
        });
        // A new token: the stored hash is replaced by a fresh SHA-256, and no
        // row holds the old one, so nothing can still be matched against it.
        expect(after.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(after.tokenHash).not.toBe(before.tokenHash);
        expect(
          await tx
            .select({ id: invitations.id })
            .from(invitations)
            .where(eq(invitations.tokenHash, before.tokenHash)),
        ).toEqual([]);
        // Issued now, for the lifetime a new invitation gets.
        expect(after.createdAt.getTime()).toBeGreaterThan(
          before.createdAt.getTime(),
        );
        expect(after.expiresAt.getTime() - after.createdAt.getTime()).toBe(
          invitationLifetimeMs,
        );
        expect(await auditRows(tx, tenant.organizationId)).toEqual([
          {
            actorType: "user",
            actorId: actor.userId,
            action: "organization.invitation_resent",
            targetId: invitationId,
          },
        ]);
        const events = await organizationEvents(tx, tenant.organizationId);
        expect(events).toEqual([
          expect.objectContaining({
            type: "organization.invitation_created.v1",
            aggregateId: invitationId,
            aggregateVersion: 2,
            actor: { type: "user", id: actor.userId },
            data: { invitationId, role: "member", expiresAt: result.expiresAt },
            outboxState: "pending",
          }),
        ]);
        expect(committed.map((event) => event.id)).toEqual([events[0]?.id]);
        // No token, old or new, in what the command answers or records.
        const recorded = JSON.stringify([
          result,
          events,
          await receiptsWrittenHere(tx),
        ]);
        expect(recorded).not.toContain(after.tokenHash);
        expect(recorded).not.toContain(before.tokenHash);
      });
    },
  );

  test("sends the email a new invitation sends, from the same event, and suppresses the one its earlier issue still had scheduled", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const notifications = createNotificationRepository(tx);
      const created: DomainEvent[] = [];
      const invited = await run(tx, {
        name: invite,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: invitationFields({ role: "admin" }),
        expectedVersion: 0,
        committed: created,
      });
      const invitationId = String(invited.id);
      const [creation] = created;
      if (!creation) throw new Error("no creation event");
      // The worker routes the creation's event: one email, scheduled.
      expect(
        await notifications.materializeInvitationIntents(
          creation.id,
          emailBaseUrl,
        ),
      ).toHaveLength(1);

      const resent: DomainEvent[] = [];
      const answer = await run(tx, {
        name: resend,
        context: humanContext(tenant.admin, tenant.organizationId),
        fields: { invitationId },
        committed: resent,
      });
      const [reissue] = resent;
      if (!reissue) throw new Error("no resend event");
      expect(reissue).toMatchObject({
        type: creation.type,
        aggregateType: creation.aggregateType,
        aggregateId: invitationId,
        aggregateVersion: 2,
      });
      expect(
        await notifications.materializeInvitationIntents(
          reissue.id,
          emailBaseUrl,
        ),
      ).toHaveLength(1);

      const intents = await tx
        .select()
        .from(notificationIntents)
        .where(eq(notificationIntents.invitationId, invitationId));
      const original = intents.find((intent) => intent.eventId === creation.id);
      const again = intents.find((intent) => intent.eventId === reissue.id);
      if (!original || !again) throw new Error("missing an intent");
      // The same email to the same address, carrying the new expiry.
      expect(again).toMatchObject({
        status: "pending",
        channel: original.channel,
        template: "organization_invitation_v1",
        recipientRef: original.recipientRef,
      });
      expect(again.template).toBe(original.template);
      expect(again.viewModel).toEqual({
        ...original.viewModel,
        expiresAt: answer.expiresAt,
      });
      // The earlier issue's scheduled email does not go out beside it.
      expect(original).toMatchObject({
        status: "suppressed",
        nextAttemptAt: null,
      });
    });
  });

  test("an earlier issue's event that reaches the worker after a resend sends nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const notifications = createNotificationRepository(tx);
      const created: DomainEvent[] = [];
      const invited = await run(tx, {
        name: invite,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: invitationFields({ role: "admin" }),
        expectedVersion: 0,
        committed: created,
      });
      const invitationId = String(invited.id);
      const [creation] = created;
      if (!creation) throw new Error("no creation event");

      // A backlog: the resend lands before the worker has routed the
      // creation's event, so no email intent exists yet to suppress.
      const resent: DomainEvent[] = [];
      await run(tx, {
        name: resend,
        context: humanContext(tenant.admin, tenant.organizationId),
        fields: { invitationId },
        committed: resent,
      });
      const [reissue] = resent;
      if (!reissue) throw new Error("no resend event");

      expect(
        await notifications.materializeInvitationIntents(
          reissue.id,
          emailBaseUrl,
        ),
      ).toHaveLength(1);
      // The creation's event, routed late, schedules nothing.
      expect(
        await notifications.materializeInvitationIntents(
          creation.id,
          emailBaseUrl,
        ),
      ).toEqual([]);
      const intents = await tx
        .select()
        .from(notificationIntents)
        .where(eq(notificationIntents.invitationId, invitationId));
      expect(intents.map((intent) => intent.eventId)).toEqual([reissue.id]);
    });
  });

  test("an owner invitation is resent by an owner, and refused to an admin", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const invitationId = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "owner",
      );
      const before = await issuedInvitation(tx, invitationId);
      expect(
        await refusal(
          run(tx, {
            name: resend,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: { invitationId },
          }),
        ),
      ).toMatchObject({
        code: "forbidden",
        message: "Only an owner may resend an owner invitation",
      });
      expect(await issuedInvitation(tx, invitationId)).toEqual(before);
      expect(await receiptsWrittenHere(tx)).toEqual([]);

      await run(tx, {
        name: resend,
        context: humanContext(tenant.owner, tenant.organizationId),
        fields: { invitationId },
      });
      expect(await issuedInvitation(tx, invitationId)).toMatchObject({
        version: 2,
      });
    });
  });

  test.each([
    ["an active member", "member", "active"],
    ["a revoked owner", "owner", "revoked"],
    ["a revoked admin", "admin", "revoked"],
  ] as const)(
    "%s is refused, and nothing is written, audited, evented or receipted",
    async (_label, role, status) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const actor = await seedMember(tx, tenant.organizationId, role, status);
        const invitationId = await seedInvitation(
          tx,
          tenant.organizationId,
          tenant.owner.userId,
          "member",
        );
        const before = await issuedInvitation(tx, invitationId);
        expect(
          await refusal(
            run(tx, {
              name: resend,
              context: humanContext(actor, tenant.organizationId),
              fields: { invitationId },
            }),
          ),
        ).toMatchObject({ code: "forbidden" });
        expect(await issuedInvitation(tx, invitationId)).toEqual(before);
        expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
        expect(await organizationEvents(tx, tenant.organizationId)).toEqual([]);
        expect(await receiptsWrittenHere(tx)).toEqual([]);
      });
    },
  );

  test("a suspended organisation and an ended session are refused by the re-check", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const invitationId = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      await endSession(tx, tenant.owner);
      expect(
        await refusal(
          run(tx, {
            name: resend,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: { invitationId },
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
      await setOrganizationStatus(tx, tenant.organizationId, "suspended");
      expect(
        await refusal(
          run(tx, {
            name: resend,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: { invitationId },
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
      expect(await issuedInvitation(tx, invitationId)).toMatchObject({
        version: 1,
      });
    });
  });

  test("another organisation's invitation is not found, for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const away = await seedTenant(tx);
      await seedMembership(tx, away.organizationId, home.owner.userId, "owner");
      const invitationId = await seedInvitation(
        tx,
        away.organizationId,
        away.owner.userId,
        "member",
      );
      expect(
        await refusal(
          run(tx, {
            name: resend,
            context: humanContext(home.owner, home.organizationId),
            fields: { invitationId },
          }),
        ),
      ).toMatchObject({
        code: "not_found",
        message: "Invitation was not found",
      });
      expect(await issuedInvitation(tx, invitationId)).toMatchObject({
        version: 1,
      });
    });
  });

  test("a stale version is version_conflict; a revoked, accepted or expired invitation is invalid_transition", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const pending = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      expect(
        await refusal(
          run(tx, {
            name: resend,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: { invitationId: pending },
            expectedVersion: 2,
          }),
        ),
      ).toMatchObject({ code: "version_conflict" });

      const expired = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      await tx
        .update(invitations)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(invitations.id, expired));
      const revoked = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
        "revoked",
      );
      const accepted = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
        "accepted",
      );
      for (const invitationId of [revoked, accepted, expired]) {
        expect(
          await refusal(
            run(tx, {
              name: resend,
              context: humanContext(tenant.owner, tenant.organizationId),
              fields: { invitationId },
            }),
          ),
        ).toMatchObject({
          code: "invalid_transition",
          message: "Only a pending invitation may be resent",
        });
      }
      expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
      expect(await organizationEvents(tx, tenant.organizationId)).toEqual([]);
    });
  });

  test("a replay answers the first result with one new token and one event; other input under the key is idempotency_conflict; after demotion it is refused", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const invitationId = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      const other = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      const idempotencyKey = key();
      const committed: DomainEvent[] = [];
      const first = await run(tx, {
        name: resend,
        context: humanContext(tenant.admin, tenant.organizationId),
        fields: { invitationId },
        idempotencyKey,
        committed,
      });
      const issued = await issuedInvitation(tx, invitationId);
      expect(
        await run(tx, {
          name: resend,
          context: humanContext(tenant.admin, tenant.organizationId),
          fields: { invitationId },
          idempotencyKey,
          committed,
        }),
      ).toEqual(first);
      // A double press sends one email: the replay issues no second token
      // and records no second event.
      expect(await issuedInvitation(tx, invitationId)).toEqual(issued);
      expect(await auditRows(tx, tenant.organizationId)).toHaveLength(1);
      expect(await organizationEvents(tx, tenant.organizationId)).toHaveLength(
        1,
      );
      expect(committed).toHaveLength(1);
      expect(
        await refusal(
          run(tx, {
            name: resend,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: { invitationId: other },
            idempotencyKey,
          }),
        ),
      ).toMatchObject({ code: "idempotency_conflict" });

      await setRole(tx, tenant.organizationId, tenant.admin.userId, "member");
      expect(
        await refusal(
          run(tx, {
            name: resend,
            context: humanContext(tenant.admin, tenant.organizationId),
            fields: { invitationId },
            idempotencyKey,
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
    });
  });

  test("an owner's operator resends with its member's authority, recorded as the service it is", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner.userId,
      });
      const context = operatorContext(credential);
      const invitationId = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.admin.userId,
        "owner",
      );
      const committed: DomainEvent[] = [];
      expect(
        await run(tx, {
          name: resend,
          context,
          fields: { invitationId },
          committed,
        }),
      ).toMatchObject({ id: invitationId, role: "owner", version: 2 });

      const actor = { type: "service", id: `operator:${credential.lineageId}` };
      expect(await auditRows(tx, tenant.organizationId)).toEqual([
        {
          actorType: actor.type,
          actorId: actor.id,
          action: "organization.invitation_resent",
          targetId: invitationId,
        },
      ]);
      expect(committed.map((event) => event.actor)).toEqual([context.actor]);
      // The invitation keeps the person who issued it as its creator.
      expect(await issuedInvitation(tx, invitationId)).toMatchObject({
        createdByUserId: tenant.admin.userId,
      });
    });
  });
});

describe("every organisation administration command", () => {
  async function fields(tx: Tx, tenant: Tenant, name: string) {
    if (name === invite) return invitationFields();
    if (name === revoke || name === resend)
      return {
        invitationId: await seedInvitation(
          tx,
          tenant.organizationId,
          tenant.owner.userId,
          "member",
        ),
      };
    return change(tenant);
  }

  test.each([invite, setMember, revoke, resend])(
    "%s: without members:manage the refusal names the scope; another organisation in the input is refused",
    async (name) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const other = await seedOrganization(tx);
        expect(
          await refusal(
            run(tx, {
              name,
              context: humanContext(tenant.owner, tenant.organizationId, [
                "org:read",
              ]),
              fields: await fields(tx, tenant, name),
              expectedVersion: name === invite ? 0 : 1,
            }),
          ),
        ).toMatchObject({
          code: "forbidden",
          details: { scope: "members:manage" },
        });
        expect(
          await refusal(
            run(tx, {
              name,
              context: humanContext(tenant.owner, tenant.organizationId),
              fields: {
                ...(await fields(tx, tenant, name)),
                organizationId: other,
              },
              expectedVersion: name === invite ? 0 : 1,
            }),
          ),
        ).toMatchObject({
          code: "forbidden",
          message: "Organization access is denied",
        });
        expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
        expect(await receiptsWrittenHere(tx)).toEqual([]);
      });
    },
  );

  test.each([invite, setMember, revoke, resend])(
    "%s: an agent and a service actor holding members:manage are refused by the command itself",
    async (name) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        for (const actor of [
          { type: "agent" as const, id: crypto.randomUUID() },
          {
            type: "service" as const,
            id: `operator:${crypto.randomUUID()}`,
            originatingActor: {
              type: "user" as const,
              id: tenant.owner.userId,
            },
          },
        ]) {
          expect(
            await refusal(
              run(tx, {
                name,
                context: {
                  ...humanContext(tenant.owner, tenant.organizationId),
                  actor,
                },
                fields: await fields(tx, tenant, name),
                expectedVersion: name === invite ? 0 : 1,
                withAssertCurrent: false,
              }),
            ),
          ).toMatchObject({
            code: "forbidden",
            message:
              "Organization administration requires a person or an operator credential",
          });
        }
        expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
        expect(await receiptsWrittenHere(tx)).toEqual([]);
      });
    },
  );
});

/* ------------------------------------------------------------------------ */

/**
 * A live operator credential holding `members:manage`, as F.3 issues one,
 * and the context `/api/v1` builds for it.
 */
async function issueOperator(
  tx: Tx,
  input: { organizationId: string; userId: string; projectId?: string | null },
) {
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "config_id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, 'requestport-operator', ${input.userId},
      ${`secret_${crypto.randomUUID()}`}, true, now() + interval '30 days',
      now(), now())
  `);
  // Issuance binds the credential's organisation; ended with the call, as
  // the issuing service's own transaction ends it.
  const credential = await endingEachMethodBinding(
    createOperatorCredentialRepository(tx),
    tx,
  ).createCredential({
    organizationId: input.organizationId,
    memberUserId: input.userId,
    projectId: input.projectId ?? null,
    betterAuthApiKeyId: apiKeyId,
    name: "Members administrator",
    prefix: "rpo_f27",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["members:manage"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
  return { ...credential, apiKeyId };
}

function operatorContext(
  credential: Awaited<ReturnType<typeof issueOperator>>,
): AuthorizedCommandContext {
  return {
    actor: operatorActor({
      lineageId: credential.lineageId,
      memberUserId: credential.memberUserId,
    }),
    credentialKind: "operator",
    organizationId: credential.organizationId,
    projectId: credential.projectId,
    laneIds: new Set(),
    scopes: new Set(credential.scopes),
    credentialId: credential.id,
    correlationId: crypto.randomUUID(),
  };
}

async function seedProject(tx: Tx, organizationId: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [row] = await tx
    .execute<{ id: string }>(sql`
    insert into "projects"
      ("organization_id", "name", "slug", "key_prefix", "status")
    values (${organizationId}, ${`Bound ${suffix}`}, ${`bound-${suffix}`},
      ${`M${suffix.toUpperCase()}`}, 'active')
    returning "id"
  `)
    .then((result) => result.rows);
  if (!row) throw new Error("no project");
  return row.id;
}

describe("an operator credential", () => {
  test("an owner's operator runs all three with its member's authority, recorded as the service it is", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner.userId,
      });
      const context = operatorContext(credential);
      const committed: DomainEvent[] = [];

      expect(
        await run(tx, {
          name: setMember,
          context,
          fields: change(tenant, { role: "owner" }),
        }),
      ).toMatchObject({ role: "owner", status: "active", version: 2 });
      const invitationId = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "owner",
      );
      expect(
        await run(tx, { name: revoke, context, fields: { invitationId } }),
      ).toEqual({ id: invitationId, version: 2 });
      const invited = await run(tx, {
        name: invite,
        context,
        fields: invitationFields({ role: "owner" }),
        expectedVersion: 0,
        committed,
      });
      expect(invited).toMatchObject({ role: "owner", created: true });

      const actor = { type: "service", id: `operator:${credential.lineageId}` };
      const audits = await auditRows(tx, tenant.organizationId);
      expect(audits.map((row) => row.action).sort()).toEqual([
        "organization.invitation_created",
        "organization.invitation_revoked",
        "organization.member_changed",
      ]);
      for (const row of audits)
        expect(row).toMatchObject({ actorType: actor.type, actorId: actor.id });
      // The member is recorded nowhere as the actor: the credential row names
      // them.
      expect(JSON.stringify(audits)).not.toContain(tenant.owner.userId);
      const events = await organizationEvents(tx, tenant.organizationId);
      expect(events.map((event) => event.type).sort()).toEqual([
        "organization.invitation_created.v1",
        "organization.invitation_revoked.v1",
        "organization.member_changed.v1",
      ]);
      for (const event of events)
        expect(event.actor, event.type).toEqual(context.actor);
      expect(committed.map((event) => event.actor)).toEqual([context.actor]);
      // The invitation's creator is the member whose authority it was made
      // under: the column references a person.
      const created = (await invitationsFor(tx, tenant.organizationId)).find(
        (row) => row.id === (invited as { id: string }).id,
      );
      expect(created?.createdByUserId).toBe(tenant.owner.userId);
    });
  });

  // The registry halves' stack: X15's renewal (on `main`) and this group's
  // actor meet in `createOrganizationInvitation`. An operator that invites an
  // address whose invitation it revoked renews the one row, and the renewal's
  // audit row and event record it as the service it is, as the creation's
  // did; the renewed row names the member as its creator.
  test("an owner's operator renews a revoked invitation, recorded as the service it is on every row", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner.userId,
      });
      const context = operatorContext(credential);
      const fields = invitationFields();
      const first = await run(tx, {
        name: invite,
        context,
        fields,
        expectedVersion: 0,
      });
      await run(tx, {
        name: revoke,
        context,
        fields: { invitationId: first.id },
      });

      const committed: DomainEvent[] = [];
      const again = await run(tx, {
        name: invite,
        context,
        fields: { ...fields, role: "admin" },
        expectedVersion: 0,
        committed,
      });

      expect(again).toMatchObject({
        id: first.id,
        role: "admin",
        created: true,
      });
      expect(await invitation(tx, String(first.id))).toMatchObject({
        version: 3,
        revokedAt: null,
        role: "admin",
      });
      const rows = await invitationsFor(tx, tenant.organizationId);
      expect(rows.map((row) => [row.id, row.createdByUserId])).toEqual([
        [first.id, tenant.owner.userId],
      ]);
      const actor = { type: "service", id: `operator:${credential.lineageId}` };
      const audits = await auditRows(tx, tenant.organizationId);
      expect(audits.map((row) => row.action).sort()).toEqual([
        "organization.invitation_created",
        "organization.invitation_renewed",
        "organization.invitation_revoked",
      ]);
      for (const row of audits)
        expect(row, row.action).toMatchObject({
          actorType: actor.type,
          actorId: actor.id,
        });
      const renewal = (
        await organizationEvents(tx, tenant.organizationId)
      ).find((event) => event.aggregateVersion === 3);
      expect(renewal).toMatchObject({
        type: "organization.invitation_created.v1",
        aggregateId: first.id,
        actor: context.actor,
        data: { renewedFrom: "revoked", role: "admin" },
      });
      expect(committed.map((event) => event.id)).toEqual([renewal?.id]);
    });
  });

  test("an admin's operator follows its member's role: it manages members and is refused owners", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const context = operatorContext(
        await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.admin.userId,
        }),
      );
      expect(
        await run(tx, { name: setMember, context, fields: change(tenant) }),
      ).toMatchObject({ role: "admin", version: 2 });
      const ownerInvitation = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "owner",
      );
      for (const [name, fields, expectedVersion] of [
        [setMember, change(tenant, { userId: tenant.owner.userId }), 1],
        [
          setMember,
          change(tenant, { userId: tenant.member.userId, role: "owner" }),
          1,
        ],
        [revoke, { invitationId: ownerInvitation }, 1],
        [resend, { invitationId: ownerInvitation }, 1],
        [invite, invitationFields({ role: "owner" }), 0],
      ] as const)
        expect(
          await refusal(
            run(tx, { name, context, fields: { ...fields }, expectedVersion }),
          ),
          name,
        ).toMatchObject({ code: "forbidden" });
      expect(
        (await auditRows(tx, tenant.organizationId)).map((row) => row.action),
      ).toEqual(["organization.member_changed"]);
    });
  });

  test("an operator's member cannot revoke their own access through it", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      await seedMember(tx, tenant.organizationId, "owner");
      const context = operatorContext(
        await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.owner.userId,
        }),
      );
      expect(
        await refusal(
          run(tx, {
            name: setMember,
            context,
            fields: change(tenant, {
              userId: tenant.owner.userId,
              role: "owner",
              status: "revoked",
            }),
          }),
        ),
      ).toMatchObject({
        code: "forbidden",
        message: "Use another owner to revoke your organization access",
      });
    });
  });

  test("its receipt is its own, never its member's", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner.userId,
      });
      const idempotencyKey = key();
      const first = await run(tx, {
        name: setMember,
        context: operatorContext(credential),
        fields: change(tenant),
        idempotencyKey,
      });
      // The member's own retry with the operator's key is not answered from
      // the operator's receipt: it runs, and meets the version check.
      expect(
        await refusal(
          run(tx, {
            name: setMember,
            context: humanContext(tenant.owner, tenant.organizationId),
            fields: change(tenant),
            idempotencyKey,
          }),
        ),
      ).toMatchObject({ code: "version_conflict" });
      // The operator's replay is answered from its receipt.
      expect(
        await run(tx, {
          name: setMember,
          context: operatorContext(credential),
          fields: change(tenant),
          idempotencyKey,
        }),
      ).toEqual(first);
      expect(
        (await receiptsWrittenHere(tx)).map((row) => row.actorFingerprint),
      ).toEqual([actorFingerprint(operatorContext(credential).actor)]);
    });
  });

  test("an operator bound to a project is refused all three, writing and receipting nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const projectId = await seedProject(tx, tenant.organizationId);
      const context = operatorContext(
        await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.owner.userId,
          projectId,
        }),
      );
      expect(context.projectId).toBe(projectId);
      const invitationId = await seedInvitation(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
        "member",
      );
      for (const [name, fields, expectedVersion] of [
        [setMember, change(tenant), 1],
        [revoke, { invitationId }, 1],
        [invite, invitationFields(), 0],
      ] as const)
        expect(
          await refusal(
            run(tx, { name, context, fields: { ...fields }, expectedVersion }),
          ),
          name,
        ).toMatchObject({
          code: "forbidden",
          message:
            "Organization administration requires a credential bound to no project",
        });
      expect(await auditRows(tx, tenant.organizationId)).toEqual([]);
      expect(await receiptsWrittenHere(tx)).toEqual([]);
      expect(
        await membership(tx, tenant.organizationId, tenant.target.userId),
      ).toMatchObject({ role: "member", version: 1 });
    });
  });

  test("an operator issued for one organisation reaches nothing of another, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const away = await seedTenant(tx);
      await seedMembership(tx, away.organizationId, home.owner.userId, "owner");
      const context = operatorContext(
        await issueOperator(tx, {
          organizationId: home.organizationId,
          userId: home.owner.userId,
        }),
      );
      const awayInvitation = await seedInvitation(
        tx,
        away.organizationId,
        away.owner.userId,
        "member",
      );
      // Another organisation's member and invitation, named in its own
      // organisation's input, are not found.
      expect(
        await refusal(
          run(tx, {
            name: setMember,
            context,
            fields: change(away),
          }),
        ),
      ).toMatchObject({ code: "not_found" });
      expect(
        await refusal(
          run(tx, {
            name: revoke,
            context,
            fields: { invitationId: awayInvitation },
          }),
        ),
      ).toMatchObject({ code: "not_found" });
      // Naming the other organisation is refused outright; the route
      // overwrites that field with the credential's anyway.
      for (const [name, fields, expectedVersion] of [
        [setMember, change(away), 1],
        [revoke, { invitationId: awayInvitation }, 1],
        [invite, invitationFields(), 0],
      ] as const)
        expect(
          await refusal(
            run(tx, {
              name,
              context,
              fields: { ...fields, organizationId: away.organizationId },
              expectedVersion,
            }),
          ),
          name,
        ).toMatchObject({ code: "forbidden" });
      expect(await auditRows(tx, away.organizationId)).toEqual([]);
      expect(
        await membership(tx, away.organizationId, away.target.userId),
      ).toMatchObject({ role: "member", version: 1 });
      expect((await invitation(tx, awayInvitation)).revokedAt).toBeNull();
    });
  });

  const changes: Array<
    [
      string,
      (
        tx: Tx,
        at: {
          organizationId: string;
          userId: string;
          credentialId: string;
          apiKeyId: string;
        },
      ) => Promise<void>,
    ]
  > = [
    [
      "the credential is revoked",
      async (tx, { credentialId }) => {
        await tx.execute(sql`
          update "operator_credentials" set "revoked_at" = now()
          where "id" = ${credentialId}
        `);
      },
    ],
    [
      "the credential has expired",
      async (tx, { credentialId }) => {
        await tx.execute(sql`
          update "operator_credentials"
          set "created_at" = now() - interval '2 days',
              "expires_at" = now() - interval '1 second'
          where "id" = ${credentialId}
        `);
      },
    ],
    [
      "its key has expired",
      async (tx, { apiKeyId }) => {
        await tx.execute(sql`
          update "apikey" set "expires_at" = now() - interval '1 second'
          where "id" = ${apiKeyId}
        `);
      },
    ],
    [
      "its member is demoted below the rule",
      async (tx, { organizationId, userId }) => {
        await setRole(tx, organizationId, userId, "member");
      },
    ],
    [
      "its member's membership is revoked",
      async (tx, { organizationId, userId }) => {
        await tx.execute(sql`
          update "organization_members" set "status" = 'revoked'
          where "organization_id" = ${organizationId}
            and "user_id" = ${userId}
        `);
      },
    ],
    [
      "the organisation is suspended",
      async (tx, { organizationId }) => {
        await setOrganizationStatus(tx, organizationId, "suspended");
      },
    ],
  ];
  test.each(changes)(
    "is refused once %s, having succeeded before, and writes nothing",
    async (_, alter) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        // A second owner, so the member can be demoted or revoked.
        await seedMember(tx, tenant.organizationId, "owner");
        const credential = await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.owner.userId,
        });
        await run(tx, {
          name: setMember,
          context: operatorContext(credential),
          fields: change(tenant),
        });
        await alter(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.owner.userId,
          credentialId: credential.id,
          apiKeyId: credential.apiKeyId,
        });
        const invitationId = await seedInvitation(
          tx,
          tenant.organizationId,
          tenant.admin.userId,
          "member",
        );
        for (const [name, fields, expectedVersion] of [
          [setMember, change(tenant, { role: "member" }), 2],
          [revoke, { invitationId }, 1],
          [invite, invitationFields(), 0],
        ] as const) {
          const error = await refusal(
            run(tx, {
              name,
              context: operatorContext(credential),
              fields: { ...fields },
              expectedVersion,
            }),
          );
          expect(error, name).toBeInstanceOf(DomainError);
          expect((error as DomainError).code, name).toBe("forbidden");
        }
        expect(
          (await auditRows(tx, tenant.organizationId)).map((row) => row.action),
        ).toEqual(["organization.member_changed"]);
      });
    },
  );

  test("the human path still records the person as user", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const context = humanContext(tenant.owner, tenant.organizationId);
      await run(tx, { name: setMember, context, fields: change(tenant) });
      await run(tx, {
        name: invite,
        context,
        fields: invitationFields(),
        expectedVersion: 0,
      });
      const audits = await auditRows(tx, tenant.organizationId);
      expect(audits).toHaveLength(2);
      for (const row of audits)
        expect(row).toMatchObject({
          actorType: "user",
          actorId: tenant.owner.userId,
        });
      for (const event of await organizationEvents(tx, tenant.organizationId))
        expect(event.actor).toEqual({
          type: "user",
          id: tenant.owner.userId,
        });
    });
  });
});
