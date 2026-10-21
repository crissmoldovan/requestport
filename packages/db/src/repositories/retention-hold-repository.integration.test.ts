import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  actorFingerprint,
  createCoreCommandRegistry,
  DomainError,
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
  outbox,
  retentionHolds,
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
import { createOperatorCredentialRepository } from "./operator-credential-repository.js";
import { createRetentionHoldCommandRepository } from "./retention-hold-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  The first real-database suite for the retention hold repository (Plan 13,
  F.2.4; `manifest-f2.md` §2.7). Creating and releasing a hold go through the
  command bus the settings forms and, after F.3, REST share, with the real
  unit of work, the real `retentionHoldCommands` port and the real
  `assertCurrent`.

  Each case runs inside a transaction that is rolled back at the end. The bus
  opens its own transaction per command, which Drizzle turns into a savepoint
  inside the outer one.
*/

const busSecret = "retention-hold-live-bus-fingerprint-secret-00000";
const formSecret = "retention-hold-live-form-fingerprint-secret-0000";

class TestRollback extends Error {}

/**
 * Runs `run` in a transaction that is always rolled back. A failure inside it
 * is rethrown after the rollback, as itself, so its own message and diff are
 * what the run reports.
 */
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
 * deployment with `REQUESTPORT_OPERATOR_CREDENTIALS=enabled` has them (Plan
 * 13, F.2.4's registry half); with the switch off `assertCurrent` refuses
 * every operator before these commands run (F.3's own suite holds that). A
 * person's re-check does not read the switch.
 */
function portFactory(name: string, database: Database | Tx) {
  if (name === "retentionHoldCommands")
    return createRetentionHoldCommandRepository(database as Database);
  if (name === "commandAuthorization")
    return createCommandAuthorizationRepository(database, {
      operatorCredentials: "enabled",
    });
  return undefined;
}

function bus(tx: Tx, options: { assertCurrent?: boolean } = {}) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    // A case runs commands for an operator and its member, or several
    // actors, on one transaction; each command's binding ends with it, as
    // its own transaction ends it in production
    // (test-support/tenant-binding.ts).
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(tx as unknown as Database, portFactory),
      tx,
    ),
    fingerprintSecret: busSecret,
    authorizeContext:
      options.assertCurrent === false
        ? undefined
        : (context, uow) =>
            uow
              .port<ReturnType<typeof createCommandAuthorizationRepository>>(
                "commandAuthorization",
              )
              .assertCurrent(context),
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
    values (${userId}, 'Retention user', ${email}, now())
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
    values (${organizationId}, 'Retention tenant',
      ${`retention-live-${organizationId}`}, 'active')
  `);
  return organizationId;
}

async function seedMembership(
  tx: Tx,
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member",
  status: "active" | "revoked" = "active",
) {
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, ${status})
  `);
}

/** An active hold on `category`, at version 1, created by `userId`. */
async function seedHold(
  tx: Tx,
  organizationId: string,
  userId: string,
  category: "all" | "slack_oauth_state" | "slack_action_token" = "all",
) {
  const [hold] = await tx
    .insert(retentionHolds)
    .values({
      organizationId,
      category,
      reason: "Seeded for the suite",
      createdByUserId: userId,
    })
    .returning({ id: retentionHolds.id });
  if (!hold) throw new Error("no hold");
  return hold.id;
}

function humanContext(input: {
  userId: string;
  sessionId: string;
  organizationId: string;
  scopes?: readonly string[];
}): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: input.userId },
    organizationId: input.organizationId,
    scopes: new Set(input.scopes ?? ["operations:manage"]),
    credentialId: input.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

/**
 * Issues an operator credential for `userId` in `organizationId`, holding
 * `operations:manage`, as F.3's repository writes one, with the Better Auth
 * key row it is bound to.
 */
async function issueOperator(
  tx: Tx,
  input: {
    organizationId: string;
    userId: string;
    projectId?: string | null;
  },
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
    name: "Retention hold operator",
    prefix: "rpo_f24",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["operations:manage"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
  return { ...credential, apiKeyId };
}

/** The context `authenticateApiBearer` builds for an operator credential. */
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

function key() {
  return `retention-live-${crypto.randomUUID()}`;
}

async function run(
  tx: Tx,
  input: {
    name: "create_retention_hold" | "release_retention_hold";
    context: AuthorizedCommandContext;
    fields: Record<string, unknown>;
    expectedVersion: number;
    idempotencyKey?: string;
    organizationId?: string;
  },
) {
  return bus(tx).execute<unknown, JsonObject>({
    name: input.name,
    context: input.context,
    input: {
      organizationId: input.organizationId ?? input.context.organizationId,
      ...input.fields,
    },
    meta: {
      idempotencyKey: input.idempotencyKey ?? key(),
      expectedVersion: input.expectedVersion,
    },
  });
}

const creating = {
  name: "create_retention_hold" as const,
  fields: { category: "slack_oauth_state", reason: "Pending legal review" },
  expectedVersion: 0,
};

function releasing(holdId: string) {
  return {
    name: "release_retention_hold" as const,
    fields: { holdId },
    expectedVersion: 1,
  };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the command was not refused");
}

async function holds(tx: Tx, organizationId: string) {
  return tx
    .select({
      id: retentionHolds.id,
      category: retentionHolds.category,
      status: retentionHolds.status,
      version: retentionHolds.version,
    })
    .from(retentionHolds)
    .where(eq(retentionHolds.organizationId, organizationId));
}

async function auditRows(tx: Tx, organizationId: string) {
  return tx
    .select({
      actorType: securityAuditRecords.actorType,
      actorId: securityAuditRecords.actorId,
      action: securityAuditRecords.action,
    })
    .from(securityAuditRecords)
    .where(eq(securityAuditRecords.organizationId, organizationId));
}

/** Every receipt the actor holds, under any command name. */
async function receiptsOf(tx: Tx, userId: string) {
  return tx
    .select({
      commandName: commandReceipts.commandName,
      idempotencyFingerprint: commandReceipts.idempotencyFingerprint,
      resultJson: commandReceipts.resultJson,
    })
    .from(commandReceipts)
    .where(
      eq(
        commandReceipts.actorFingerprint,
        actorFingerprint({ type: "user", id: userId }),
      ),
    );
}

/**
 * Every receipt this case's transaction has written, under any actor and any
 * command name. A receipt row takes `created_at` from `now()`, which is the
 * outer transaction's start time in every savepoint inside it; another
 * suite's committed row carries its own transaction's time.
 */
async function receiptsWrittenHere(tx: Tx) {
  return tx
    .select({
      actorFingerprint: commandReceipts.actorFingerprint,
      commandName: commandReceipts.commandName,
    })
    .from(commandReceipts)
    .where(sql`${commandReceipts.createdAt} = now()`);
}

async function tenant(
  tx: Tx,
  role: "owner" | "admin" | "member" = "owner",
  status: "active" | "revoked" = "active",
) {
  const organizationId = await seedOrganization(tx);
  const actor = await seedUser(tx);
  await seedMembership(tx, organizationId, actor.userId, role, status);
  return {
    organizationId,
    actor,
    context: humanContext({ ...actor, organizationId }),
  };
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("retention holds through the command bus", () => {
  describe("the role matrix", () => {
    test.each([
      ["an organisation owner", "owner"],
      ["an organisation admin", "admin"],
    ] as const)("%s may create and release a hold", async (_, role) => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, context } = await tenant(tx, role);
        const created = await run(tx, { ...creating, context });
        expect(created).toEqual({ id: expect.any(String), version: 1 });
        const released = await run(tx, {
          ...releasing(String(created.id)),
          context,
        });
        expect(released).toEqual({ id: created.id, version: 2 });
        expect(await holds(tx, organizationId)).toEqual([
          {
            id: created.id,
            category: "slack_oauth_state",
            status: "released",
            version: 2,
          },
        ]);
      });
    });

    test.each([
      ["an organisation member", "member", "active"],
      ["a revoked owner", "owner", "revoked"],
    ] as const)(
      "%s is refused both, and nothing is written",
      async (_, role, status) => {
        await inRollbackTransaction(async (tx) => {
          const { organizationId, context, actor } = await tenant(
            tx,
            role,
            status,
          );
          const holdId = await seedHold(tx, organizationId, actor.userId);
          for (const command of [creating, releasing(holdId)]) {
            const error = await refusal(run(tx, { ...command, context }));
            expect(error, command.name).toBeInstanceOf(DomainError);
            expect((error as DomainError).code, command.name).toBe("forbidden");
          }
          expect(await holds(tx, organizationId)).toEqual([
            { id: holdId, category: "all", status: "active", version: 1 },
          ]);
          expect(await auditRows(tx, organizationId)).toEqual([]);
          expect(await receiptsOf(tx, actor.userId)).toEqual([]);
        });
      },
    );

    test("a suspended organisation, and an ended session, are refused both", async () => {
      await inRollbackTransaction(async (tx) => {
        const suspended = await tenant(tx);
        const suspendedHold = await seedHold(
          tx,
          suspended.organizationId,
          suspended.actor.userId,
        );
        await tx.execute(sql`
          update "organizations" set "status" = 'suspended'
          where "id" = ${suspended.organizationId}
        `);
        const ended = await tenant(tx);
        const endedHold = await seedHold(
          tx,
          ended.organizationId,
          ended.actor.userId,
        );
        await tx.execute(sql`
          update "session" set "expires_at" = now() - interval '1 minute'
          where "id" = ${ended.actor.sessionId}
        `);
        for (const [who, holdId] of [
          [suspended, suspendedHold],
          [ended, endedHold],
        ] as const) {
          for (const command of [creating, releasing(holdId)]) {
            const error = await refusal(
              run(tx, { ...command, context: who.context }),
            );
            expect((error as DomainError).code, command.name).toBe("forbidden");
          }
          expect(await holds(tx, who.organizationId)).toEqual([
            { id: holdId, category: "all", status: "active", version: 1 },
          ]);
        }
      });
    });

    test("another organisation's hold is not found, even for an owner of both", async () => {
      await inRollbackTransaction(async (tx) => {
        const home = await tenant(tx);
        const other = await seedOrganization(tx);
        await seedMembership(tx, other, home.actor.userId, "owner");
        const foreign = await seedHold(tx, other, home.actor.userId);
        const error = await refusal(
          run(tx, { ...releasing(foreign), context: home.context }),
        );
        expect((error as DomainError).code).toBe("not_found");
        // Not the bus's own not_found for a command it does not hold.
        expect((error as DomainError).message).toBe(
          "Retention hold was not found",
        );
        expect(await holds(tx, other)).toEqual([
          { id: foreign, category: "all", status: "active", version: 1 },
        ]);
        expect(await auditRows(tx, other)).toEqual([]);
      });
    });
  });

  describe("what the command checks before the repository runs", () => {
    test("a context without operations:manage is refused naming that scope", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, actor } = await tenant(tx);
        const holdId = await seedHold(tx, organizationId, actor.userId);
        const context = humanContext({
          ...actor,
          organizationId,
          scopes: ["org:read", "project:manage"],
        });
        for (const command of [creating, releasing(holdId)]) {
          const error = await refusal(run(tx, { ...command, context }));
          expect((error as DomainError).details, command.name).toEqual({
            scope: "operations:manage",
          });
        }
        expect(await holds(tx, organizationId)).toHaveLength(1);
      });
    });

    test("an input naming another organisation than the context's is refused", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, actor, context } = await tenant(tx);
        const holdId = await seedHold(tx, organizationId, actor.userId);
        for (const command of [creating, releasing(holdId)]) {
          const error = await refusal(
            run(tx, {
              ...command,
              context,
              organizationId: crypto.randomUUID(),
            }),
          );
          expect((error as DomainError).code, command.name).toBe("forbidden");
        }
        expect(await holds(tx, organizationId)).toHaveLength(1);
      });
    });

    test.each([
      ["an agent", { type: "agent", id: crypto.randomUUID() }],
      [
        "a service actor",
        {
          type: "service",
          id: "operator:probe",
          originatingActor: { type: "user", id: "someone" },
        },
      ],
    ] as const)(
      "%s holding operations:manage is refused before any repository runs",
      async (_, actor) => {
        await inRollbackTransaction(async (tx) => {
          const owner = await tenant(tx);
          const holdId = await seedHold(
            tx,
            owner.organizationId,
            owner.actor.userId,
          );
          // The bus's own `assertCurrent` is left out here, as in the
          // operations suite: it would refuse both contexts on its own, which
          // would hide whether the command refuses them itself.
          for (const command of [creating, releasing(holdId)]) {
            const error = await refusal(
              bus(tx, { assertCurrent: false }).execute({
                name: command.name,
                context: {
                  actor,
                  organizationId: owner.organizationId,
                  scopes: new Set(["operations:manage"]),
                  credentialId: "not-a-person",
                  correlationId: crypto.randomUUID(),
                },
                input: {
                  organizationId: owner.organizationId,
                  ...command.fields,
                },
                meta: {
                  idempotencyKey: key(),
                  expectedVersion: command.expectedVersion,
                },
              }),
            );
            expect((error as DomainError).code, command.name).toBe("forbidden");
            expect((error as DomainError).message, command.name).toBe(
              "Operations require a person or an operator credential",
            );
          }
          expect(await holds(tx, owner.organizationId)).toHaveLength(1);
        });
      },
    );

    test.each([
      ["a reason under eight characters", { reason: "short" }, "reason"],
      ["a category outside the three", { category: "everything" }, "category"],
    ])(
      "%s is refused as invalid input, naming the field",
      async (_, fields, field) => {
        await inRollbackTransaction(async (tx) => {
          const { organizationId, context } = await tenant(tx);
          const error = await refusal(
            run(tx, {
              ...creating,
              fields: { ...creating.fields, ...fields },
              context,
            }),
          );
          expect((error as DomainError).code).toBe("validation_failed");
          expect((error as DomainError).details).toEqual({ field });
          expect(await holds(tx, organizationId)).toEqual([]);
        });
      },
    );

    /*
      New with the bus (R6): the repository and form on `main` checked only a
      reason's length. The bus refuses input its secret detector matches
      before it authorises or writes anything, naming no field; the hold form
      addresses that refusal to its reason control.
    */
    test.each([
      "Keep for audit, password: hunter2hunter2",
      "Keep for audit, Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    ])(
      "a reason the bus's secret detector matches is refused, writing nothing: %s",
      async (reason) => {
        await inRollbackTransaction(async (tx) => {
          const { organizationId, context } = await tenant(tx);
          const error = await refusal(
            run(tx, {
              ...creating,
              fields: { ...creating.fields, reason },
              context,
            }),
          );
          expect((error as DomainError).code).toBe("validation_failed");
          expect((error as DomainError).message).toBe(
            "Command input contains prohibited secret material",
          );
          expect((error as DomainError).details).toEqual({});
          expect(await holds(tx, organizationId)).toEqual([]);
          expect(await auditRows(tx, organizationId)).toEqual([]);
          expect(await receiptsWrittenHere(tx)).toEqual([]);
        });
      },
    );
  });

  describe("versions, replays and conflicts", () => {
    test("a new hold at any version but zero answers version_conflict", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, context } = await tenant(tx);
        const error = await refusal(
          run(tx, { ...creating, expectedVersion: 1, context }),
        );
        expect((error as DomainError).code).toBe("version_conflict");
        expect(await holds(tx, organizationId)).toEqual([]);
      });
    });

    test("a second active hold on one category answers version_conflict", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, actor, context } = await tenant(tx);
        await seedHold(tx, organizationId, actor.userId, "slack_oauth_state");
        const error = await refusal(run(tx, { ...creating, context }));
        expect((error as DomainError).code).toBe("version_conflict");
        expect(await holds(tx, organizationId)).toHaveLength(1);
      });
    });

    test("releasing at a stale version, or a hold already released, answers version_conflict", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, actor, context } = await tenant(tx);
        const holdId = await seedHold(tx, organizationId, actor.userId);
        const stale = await refusal(
          run(tx, { ...releasing(holdId), expectedVersion: 2, context }),
        );
        expect((stale as DomainError).code).toBe("version_conflict");
        await run(tx, { ...releasing(holdId), context });
        const again = await refusal(
          run(tx, { ...releasing(holdId), expectedVersion: 2, context }),
        );
        expect((again as DomainError).code).toBe("version_conflict");
        expect(await holds(tx, organizationId)).toEqual([
          { id: holdId, category: "all", status: "released", version: 2 },
        ]);
      });
    });

    test("a replay with the same key and input answers the first result, writing nothing more", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, context } = await tenant(tx);
        const createKey = key();
        const created = await run(tx, {
          ...creating,
          context,
          idempotencyKey: createKey,
        });
        expect(
          await run(tx, {
            ...creating,
            context: { ...context, correlationId: crypto.randomUUID() },
            idempotencyKey: createKey,
          }),
        ).toEqual(created);
        const releaseKey = key();
        const released = await run(tx, {
          ...releasing(String(created.id)),
          context,
          idempotencyKey: releaseKey,
        });
        expect(
          await run(tx, {
            ...releasing(String(created.id)),
            context,
            idempotencyKey: releaseKey,
          }),
        ).toEqual(released);
        expect(await holds(tx, organizationId)).toHaveLength(1);
        expect(await auditRows(tx, organizationId)).toHaveLength(2);
      });
    });

    test("a key reused with different input answers idempotency_conflict", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, context } = await tenant(tx);
        const idempotencyKey = key();
        await run(tx, { ...creating, context, idempotencyKey });
        const error = await refusal(
          run(tx, {
            ...creating,
            fields: { ...creating.fields, reason: "Another legal review" },
            context,
            idempotencyKey,
          }),
        );
        expect((error as DomainError).code).toBe("idempotency_conflict");
        expect(await holds(tx, organizationId)).toHaveLength(1);
      });
    });

    test("a replay by a member who has since lost the role is refused, not answered", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, actor, context } = await tenant(tx, "admin");
        const idempotencyKey = key();
        await run(tx, { ...creating, context, idempotencyKey });
        await tx.execute(sql`
          update "organization_members" set "role" = 'member'
          where "organization_id" = ${organizationId}
            and "user_id" = ${actor.userId}
        `);
        const error = await refusal(
          run(tx, { ...creating, context, idempotencyKey }),
        );
        expect((error as DomainError).code).toBe("forbidden");
      });
    });
  });

  describe("records", () => {
    test("the human path audits and publishes as the user, as before", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, actor, context } = await tenant(tx);
        const created = await run(tx, { ...creating, context });
        await run(tx, { ...releasing(String(created.id)), context });
        expect(await auditRows(tx, organizationId)).toEqual(
          expect.arrayContaining([
            {
              actorType: "user",
              actorId: actor.userId,
              action: "retention.hold_created",
            },
            {
              actorType: "user",
              actorId: actor.userId,
              action: "retention.hold_released",
            },
          ]),
        );
        const events = await tx
          .select({
            id: domainEvents.id,
            actor: domainEvents.actor,
            version: domainEvents.aggregateVersion,
            data: domainEvents.data,
          })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.aggregateId, String(created.id)),
              eq(domainEvents.type, "retention.hold_changed.v1"),
            ),
          );
        expect(
          events
            .map(({ actor: eventActor, version, data }) => ({
              actor: eventActor,
              version,
              data,
            }))
            .sort((a, b) => a.version - b.version),
        ).toEqual([
          {
            actor: { type: "user", id: actor.userId },
            version: 1,
            data: { category: "slack_oauth_state", status: "active" },
          },
          {
            actor: { type: "user", id: actor.userId },
            version: 2,
            data: { category: "slack_oauth_state", status: "released" },
          },
        ]);
        for (const event of events)
          expect(
            await tx
              .select({ state: outbox.state })
              .from(outbox)
              .where(eq(outbox.eventId, event.id)),
          ).toEqual([{ state: "pending" }]);
        const [row] = await tx
          .select({
            reason: retentionHolds.reason,
            createdBy: retentionHolds.createdByUserId,
            releasedBy: retentionHolds.releasedByUserId,
          })
          .from(retentionHolds)
          .where(eq(retentionHolds.id, String(created.id)));
        expect(row).toEqual({
          reason: "Pending legal review",
          createdBy: actor.userId,
          releasedBy: actor.userId,
        });
      });
    });
  });

  /*
    The receipt decision (`manifest-f2.md` §2.4, F.2.4): each hold write's one
    receipt is the bus's. The repository keeps none of its own.
  */
  describe("receipts", () => {
    test("each write leaves exactly one receipt, the bus's, and no other under any name", async () => {
      await inRollbackTransaction(async (tx) => {
        const { actor, context } = await tenant(tx);
        const createKey = key();
        const created = await run(tx, {
          ...creating,
          context,
          idempotencyKey: createKey,
        });
        const releaseKey = key();
        const released = await run(tx, {
          ...releasing(String(created.id)),
          context,
          idempotencyKey: releaseKey,
        });
        const byName = (
          a: { commandName: string },
          b: { commandName: string },
        ) => a.commandName.localeCompare(b.commandName);
        expect((await receiptsOf(tx, actor.userId)).sort(byName)).toEqual([
          {
            commandName: "create_retention_hold",
            idempotencyFingerprint: keyedFingerprint(busSecret, createKey),
            resultJson: created,
          },
          {
            commandName: "release_retention_hold",
            idempotencyFingerprint: keyedFingerprint(busSecret, releaseKey),
            resultJson: released,
          },
        ]);
        // And none under any other actor: two commands, two receipts.
        expect((await receiptsWrittenHere(tx)).sort(byName)).toEqual([
          {
            actorFingerprint: actorFingerprint({
              type: "user",
              id: actor.userId,
            }),
            commandName: "create_retention_hold",
          },
          {
            actorFingerprint: actorFingerprint({
              type: "user",
              id: actor.userId,
            }),
            commandName: "release_retention_hold",
          },
        ]);
      });
    });

    test("a receipt the repository stored before the port does not answer the bus: the retry meets the active hold", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, actor, context } = await tenant(tx);
        const idempotencyKey = key();
        // What the form's first submission left before the deploy: the hold,
        // and the repository's own receipt, keyed with the form's secret
        // under the same command name.
        const holdId = await seedHold(
          tx,
          organizationId,
          actor.userId,
          "slack_oauth_state",
        );
        await tx.insert(commandReceipts).values({
          actorFingerprint: actorFingerprint({
            type: "user",
            id: actor.userId,
          }),
          commandName: "create_retention_hold",
          idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
          normalizedInputHash: normalizedInputHash(creating.fields),
          resultJson: { id: holdId, version: 1 },
          expiresAt: new Date(Date.now() + 60_000),
        });
        const error = await refusal(
          run(tx, { ...creating, context, idempotencyKey }),
        );
        expect((error as DomainError).code).toBe("version_conflict");
        expect(await holds(tx, organizationId)).toEqual([
          {
            id: holdId,
            category: "slack_oauth_state",
            status: "active",
            version: 1,
          },
        ]);
      });
    });
  });

  /*
    Plan 13, F.2.4's registry half: an operator credential creates and
    releases holds with its issuing member's authority, through the same bus,
    port and `assertCurrent` a person's form does, with operator credentials
    switched on. Each refusal below is shown able to pass first: the same
    credential succeeds before the change that makes it fail.
  */
  describe("an operator credential", () => {
    async function holdEvents(tx: Tx, holdId: string) {
      return (
        await tx
          .select({
            actor: domainEvents.actor,
            version: domainEvents.aggregateVersion,
          })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.aggregateId, holdId),
              eq(domainEvents.type, "retention.hold_changed.v1"),
            ),
          )
      ).sort((a, b) => a.version - b.version);
    }

    test.each([
      ["an owner's", "owner"],
      ["an admin's", "admin"],
    ] as const)(
      "%s organisation-wide operator creates and releases a hold, recorded as the service it is, with its member as creator and releaser",
      async (_, role) => {
        await inRollbackTransaction(async (tx) => {
          const { organizationId, actor } = await tenant(tx, role);
          const credential = await issueOperator(tx, {
            organizationId,
            userId: actor.userId,
          });
          const context = operatorContext(credential);
          const created = await run(tx, { ...creating, context });
          expect(created).toMatchObject({ version: 1 });
          const released = await run(tx, {
            ...releasing(String(created.id)),
            context,
          });
          expect(released).toEqual({ id: created.id, version: 2 });
          const audits = (await auditRows(tx, organizationId)).filter(
            (row) => row.action !== "operator.credential_issued",
          );
          expect(audits).toEqual(
            expect.arrayContaining([
              {
                actorType: "service",
                actorId: `operator:${credential.lineageId}`,
                action: "retention.hold_created",
              },
              {
                actorType: "service",
                actorId: `operator:${credential.lineageId}`,
                action: "retention.hold_released",
              },
            ]),
          );
          expect(audits).toHaveLength(2);
          // Each event carries the operator's actor, its member as origin, as
          // every other event does (F3-2).
          expect(await holdEvents(tx, String(created.id))).toEqual([
            { actor: context.actor, version: 1 },
            { actor: context.actor, version: 2 },
          ]);
          const [row] = await tx
            .select({
              createdBy: retentionHolds.createdByUserId,
              releasedBy: retentionHolds.releasedByUserId,
            })
            .from(retentionHolds)
            .where(eq(retentionHolds.id, String(created.id)));
          expect(row).toEqual({
            createdBy: actor.userId,
            releasedBy: actor.userId,
          });
        });
      },
    );

    test("its receipt is its own, never its member's", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, actor, context: member } = await tenant(tx);
        const credential = await issueOperator(tx, {
          organizationId,
          userId: actor.userId,
        });
        const context = operatorContext(credential);
        const idempotencyKey = key();
        const first = await run(tx, {
          ...creating,
          context,
          idempotencyKey,
        });
        // The member's own retry with the operator's key is not answered from
        // the operator's receipt: it runs, and meets the active hold.
        const retry = await refusal(
          run(tx, { ...creating, context: member, idempotencyKey }),
        );
        expect((retry as DomainError).code).toBe("version_conflict");
        expect(
          await run(tx, {
            ...creating,
            context: operatorContext(credential),
            idempotencyKey,
          }),
        ).toEqual(first);
        expect(await holds(tx, organizationId)).toHaveLength(1);
        expect(await receiptsWrittenHere(tx)).toEqual([
          {
            actorFingerprint: actorFingerprint(context.actor),
            commandName: "create_retention_hold",
          },
        ]);
        expect(await receiptsOf(tx, actor.userId)).toEqual([]);
      });
    });

    test("an operator bound to a project is refused both, and nothing is written", async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, actor } = await tenant(tx);
        const holdId = await seedHold(tx, organizationId, actor.userId);
        const suffix = crypto.randomUUID().slice(0, 8);
        const [project] = await tx
          .execute<{ id: string }>(sql`
            insert into "projects" ("organization_id", "name", "slug",
              "key_prefix", "status")
            values (${organizationId}, ${`Bound ${suffix}`},
              ${`bound-${suffix}`}, ${`B${suffix.slice(0, 4).toUpperCase()}`},
              'active')
            returning "id"
          `)
          .then((result) => result.rows);
        const credential = await issueOperator(tx, {
          organizationId,
          userId: actor.userId,
          projectId: project?.id ?? null,
        });
        for (const command of [
          { ...creating, fields: { ...creating.fields, category: "all" } },
          releasing(holdId),
        ]) {
          const error = await refusal(
            run(tx, { ...command, context: operatorContext(credential) }),
          );
          expect((error as DomainError).code, command.name).toBe("forbidden");
          expect((error as DomainError).message, command.name).toBe(
            "Operations require a credential bound to no project",
          );
        }
        expect(await holds(tx, organizationId)).toEqual([
          { id: holdId, category: "all", status: "active", version: 1 },
        ]);
        expect(
          (await auditRows(tx, organizationId)).map((row) => row.action),
        ).toEqual(["operator.credential_issued"]);
        expect(await receiptsWrittenHere(tx)).toEqual([]);
      });
    });

    test("an operator issued for one organisation finds no hold of another, though its member owns both", async () => {
      await inRollbackTransaction(async (tx) => {
        const home = await tenant(tx);
        const other = await seedOrganization(tx);
        await seedMembership(tx, other, home.actor.userId, "owner");
        const foreign = await seedHold(tx, other, home.actor.userId);
        const credential = await issueOperator(tx, {
          organizationId: home.organizationId,
          userId: home.actor.userId,
        });
        const error = await refusal(
          run(tx, {
            ...releasing(foreign),
            context: operatorContext(credential),
          }),
        );
        expect((error as DomainError).code).toBe("not_found");
        expect((error as DomainError).message).toBe(
          "Retention hold was not found",
        );
        // Naming the other organisation in the input is refused outright, for
        // both; the route overwrites that field with the credential's anyway.
        for (const command of [creating, releasing(foreign)]) {
          const named = await refusal(
            run(tx, {
              ...command,
              context: operatorContext(credential),
              organizationId: other,
            }),
          );
          expect((named as DomainError).code, command.name).toBe("forbidden");
        }
        expect(await holds(tx, other)).toEqual([
          { id: foreign, category: "all", status: "active", version: 1 },
        ]);
        expect(await holds(tx, home.organizationId)).toEqual([]);
        expect(await auditRows(tx, other)).toEqual([]);
      });
    });

    const changes: Array<
      [
        string,
        (
          tx: Tx,
          ids: {
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
          await tx.execute(sql`
            update "organization_members" set "role" = 'member'
            where "organization_id" = ${organizationId}
              and "user_id" = ${userId}
          `);
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
          await tx.execute(sql`
            update "organizations" set "status" = 'suspended'
            where "id" = ${organizationId}
          `);
        },
      ],
    ];
    test.each(changes)(
      "is refused once %s, having succeeded before, and writes nothing",
      async (_, change) => {
        await inRollbackTransaction(async (tx) => {
          const { organizationId, actor } = await tenant(tx);
          const credential = await issueOperator(tx, {
            organizationId,
            userId: actor.userId,
          });
          const created = await run(tx, {
            ...creating,
            context: operatorContext(credential),
          });
          await change(tx, {
            organizationId,
            userId: actor.userId,
            credentialId: credential.id,
            apiKeyId: credential.apiKeyId,
          });
          for (const command of [
            { ...creating, fields: { ...creating.fields, category: "all" } },
            releasing(String(created.id)),
          ]) {
            const error = await refusal(
              run(tx, { ...command, context: operatorContext(credential) }),
            );
            expect(error, command.name).toBeInstanceOf(DomainError);
            expect((error as DomainError).code, command.name).toBe("forbidden");
          }
          expect(await holds(tx, organizationId)).toEqual([
            {
              id: created.id,
              category: "slack_oauth_state",
              status: "active",
              version: 1,
            },
          ]);
          expect(
            (await auditRows(tx, organizationId))
              .map((row) => row.action)
              .filter((action) => action !== "operator.credential_issued"),
          ).toEqual(["retention.hold_created"]);
        });
      },
    );
  });
});
