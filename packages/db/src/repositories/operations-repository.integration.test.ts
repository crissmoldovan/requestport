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
  importTaskDispatches,
  notificationIntents,
  outbox,
  securityAuditRecords,
  slackDeliveryOperations,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import {
  endingEachCommandBinding,
  endingEachMethodBinding,
} from "../test-support/tenant-binding.js";
import type { Tx } from "../transaction.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";
import { createCommandTransactionManager } from "./command-repository.js";
import { createOperationsCommandRepository } from "./operations-repository.js";
import { createOperatorCredentialRepository } from "./operator-credential-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  The first real-database suite for the operations repository (Plan 13,
  F.2.4; `manifest-f2.md` §2.7). Every requeue goes through the command bus
  the settings forms and, after F.3, REST share, with the real unit of work,
  the real `operationsCommands` port and the real `assertCurrent`, so what is
  proved here is the handler both reach.

  Each case runs inside a transaction that is rolled back at the end. The bus
  opens its own transaction per command, which Drizzle turns into a savepoint
  inside the outer one.
*/

const busSecret = "operations-live-bus-fingerprint-secret-000000000";
const formSecret = "operations-live-form-fingerprint-secret-00000000";

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
  if (name === "operationsCommands")
    return createOperationsCommandRepository(database as Database);
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
    values (${userId}, 'Operations user', ${email}, now())
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
    values (${organizationId}, 'Operations tenant',
      ${`operations-live-${organizationId}`}, 'active')
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

async function firstId(tx: Tx, query: ReturnType<typeof sql>): Promise<string> {
  const result = await tx.execute<{ id: string }>(query);
  const id = result.rows[0]?.id;
  if (!id) throw new Error("seed returned no id");
  return id;
}

/**
 * One row of each kind the four requeues act on, in `organizationId`, each in
 * the state its requeue accepts: a dead-lettered outbox row after 5 attempts,
 * a failed notification intent after 3, a failed Slack connection test after
 * 4, and a dead-lettered import analysis dispatch after 6.
 */
async function seedRows(tx: Tx, organizationId: string, installedBy: string) {
  const eventId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "domain_events" ("id", "organization_id", "aggregate_type",
      "aggregate_id", "aggregate_version", "type", "schema_version", "actor",
      "correlation_id", "causation_id", "data")
    values (${eventId}, ${organizationId}, 'operations_probe',
      ${crypto.randomUUID()}, 1, 'operations.probe.v1', 1,
      '{"type":"system","id":"operations-live"}'::jsonb, 'operations-live',
      'operations-live', '{}'::jsonb)
  `);
  const outboxId = await firstId(
    tx,
    sql`
      insert into "outbox" ("event_id", "state", "attempt_count")
      values (${eventId}, 'dead_letter', 5)
      returning "id"
    `,
  );
  const notificationIntentId = await firstId(
    tx,
    sql`
      insert into "notification_intents" ("organization_id", "channel",
        "recipient_ref", "template", "dedupe_key", "view_model", "status",
        "attempt_count", "last_error_code")
      values (${organizationId}, 'email', 'operations@example.invalid',
        'operations_probe', ${crypto.randomUUID()}, '{}'::jsonb, 'failed', 3,
        'provider_rejected')
      returning "id"
    `,
  );
  const installationId = await firstId(
    tx,
    sql`
      insert into "slack_installations" ("organization_id", "workspace_id",
        "workspace_name", "bot_token_ciphertext", "bot_user_id",
        "installed_by_user_id")
      values (${organizationId}, ${`T${crypto.randomUUID().slice(0, 8)}`},
        'Operations workspace', '{}'::jsonb, 'U0PERATIONS', ${installedBy})
      returning "id"
    `,
  );
  const slackOperationId = await firstId(
    tx,
    sql`
      insert into "slack_delivery_operations" ("installation_id",
        "operation_key", "operation_type", "status", "attempt_count",
        "last_error_code")
      values (${installationId}, ${crypto.randomUUID()}, 'connection_test',
        'failed', 4, 'slack_unavailable')
      returning "id"
    `,
  );
  const suffix = crypto.randomUUID().slice(0, 8);
  const projectId = await firstId(
    tx,
    sql`
      insert into "projects" ("organization_id", "name", "slug", "key_prefix",
        "status")
      values (${organizationId}, ${`Operations ${suffix}`},
        ${`operations-${suffix}`}, ${`O${suffix.slice(0, 4).toUpperCase()}`},
        'active')
      returning "id"
    `,
  );
  const importSourceId = await firstId(
    tx,
    sql`
      insert into "import_sources" ("organization_id", "project_id",
        "created_by")
      values (${organizationId}, ${projectId}, ${installedBy})
      returning "id"
    `,
  );
  const snapshotId = await firstId(
    tx,
    sql`
      insert into "source_snapshots" ("organization_id", "import_source_id",
        "manifest_sha256")
      values (${organizationId}, ${importSourceId}, ${"a".repeat(64)})
      returning "id"
    `,
  );
  const importRunId = await firstId(
    tx,
    sql`
      insert into "import_runs" ("organization_id", "import_source_id",
        "source_snapshot_id", "requested_by_type", "requested_by_id",
        "parser_version")
      values (${organizationId}, ${importSourceId}, ${snapshotId}, 'user',
        ${installedBy}, 'operations-live')
      returning "id"
    `,
  );
  const importDispatchId = await firstId(
    tx,
    sql`
      insert into "import_task_dispatches" ("organization_id",
        "import_run_id", "task_kind", "task_payload", "state",
        "attempt_count", "last_error_code")
      values (${organizationId}, ${importRunId}, 'analyze', '{}'::jsonb,
        'dead_letter', 6, 'trigger_unavailable')
      returning "id"
    `,
  );
  return {
    eventId,
    outboxId,
    notificationIntentId,
    slackOperationId,
    importDispatchId,
  };
}

type Seeded = Awaited<ReturnType<typeof seedRows>>;

/**
 * Each requeue: its input against the rows `seedRows` made, the attempt count
 * it expects there, what it answers, and the row's state as the requeue
 * checks it and leaves it.
 */
const requeues: Record<
  string,
  {
    input: (seeded: Seeded) => Record<string, unknown>;
    expectedVersion: number;
    result: (seeded: Seeded) => JsonObject;
    state: (tx: Tx, seeded: Seeded) => Promise<unknown>;
    before: unknown;
    after: unknown;
    audit: string;
  }
> = {
  requeue_outbox: {
    input: (seeded) => ({ outboxId: seeded.outboxId }),
    expectedVersion: 5,
    result: (seeded) => ({
      outboxId: seeded.outboxId,
      eventId: seeded.eventId,
    }),
    state: async (tx, seeded) =>
      (
        await tx
          .select({ state: outbox.state, attemptCount: outbox.attemptCount })
          .from(outbox)
          .where(eq(outbox.id, seeded.outboxId))
      )[0],
    before: { state: "dead_letter", attemptCount: 5 },
    after: { state: "pending", attemptCount: 5 },
    audit: "outbox.requeued",
  },
  requeue_notification: {
    input: (seeded) => ({
      notificationIntentId: seeded.notificationIntentId,
    }),
    expectedVersion: 3,
    result: (seeded) => ({
      notificationIntentId: seeded.notificationIntentId,
    }),
    state: async (tx, seeded) =>
      (
        await tx
          .select({
            state: notificationIntents.status,
            attemptCount: notificationIntents.attemptCount,
          })
          .from(notificationIntents)
          .where(eq(notificationIntents.id, seeded.notificationIntentId))
      )[0],
    before: { state: "failed", attemptCount: 3 },
    after: { state: "pending", attemptCount: 0 },
    audit: "notification.requeued",
  },
  requeue_slack_operation: {
    input: (seeded) => ({ operationId: seeded.slackOperationId }),
    expectedVersion: 4,
    result: (seeded) => ({
      operationId: seeded.slackOperationId,
      operationType: "connection_test",
    }),
    state: async (tx, seeded) =>
      (
        await tx
          .select({
            state: slackDeliveryOperations.status,
            attemptCount: slackDeliveryOperations.attemptCount,
          })
          .from(slackDeliveryOperations)
          .where(eq(slackDeliveryOperations.id, seeded.slackOperationId))
      )[0],
    before: { state: "failed", attemptCount: 4 },
    after: { state: "pending", attemptCount: 0 },
    audit: "slack.operation_requeued",
  },
  requeue_import_dispatch: {
    input: (seeded) => ({ dispatchId: seeded.importDispatchId }),
    expectedVersion: 6,
    result: (seeded) => ({ dispatchId: seeded.importDispatchId }),
    state: async (tx, seeded) =>
      (
        await tx
          .select({
            state: importTaskDispatches.state,
            attemptCount: importTaskDispatches.attemptCount,
          })
          .from(importTaskDispatches)
          .where(eq(importTaskDispatches.id, seeded.importDispatchId))
      )[0],
    before: { state: "dead_letter", attemptCount: 6 },
    after: { state: "pending", attemptCount: 0 },
    audit: "import.dispatch_requeued",
  },
};
const requeueNames = Object.keys(requeues);

function requeue(name: string) {
  const entry = requeues[name];
  if (!entry) throw new Error(`no requeue ${name}`);
  return entry;
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
    scopes?: string[];
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
    name: "Operations operator",
    prefix: "rpo_f24",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: input.scopes ?? ["operations:manage"],
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

/** A project in `organizationId`, for a credential to be bound to. */
async function seedProject(tx: Tx, organizationId: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  return firstId(
    tx,
    sql`
      insert into "projects" ("organization_id", "name", "slug", "key_prefix",
        "status")
      values (${organizationId}, ${`Bound ${suffix}`}, ${`bound-${suffix}`},
        ${`B${suffix.slice(0, 4).toUpperCase()}`}, 'active')
      returning "id"
    `,
  );
}

function key() {
  return `operations-live-${crypto.randomUUID()}`;
}

async function run(
  tx: Tx,
  input: {
    name: string;
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

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the command was not refused");
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

/** An owner, admin or member of a fresh organisation, with rows to requeue. */
async function tenant(
  tx: Tx,
  role: "owner" | "admin" | "member" = "owner",
  status: "active" | "revoked" = "active",
) {
  const organizationId = await seedOrganization(tx);
  const actor = await seedUser(tx);
  await seedMembership(tx, organizationId, actor.userId, role, status);
  const seeded = await seedRows(tx, organizationId, actor.userId);
  return {
    organizationId,
    actor,
    seeded,
    context: humanContext({ ...actor, organizationId }),
  };
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("operations requeues through the command bus", () => {
  describe("the role matrix, for each of the four requeues", () => {
    test.each([
      ["an organisation owner", "owner"],
      ["an organisation admin", "admin"],
    ] as const)("%s may run every requeue", async (_, role) => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, context, organizationId, actor } = await tenant(
          tx,
          role,
        );
        for (const name of requeueNames) {
          const entry = requeue(name);
          const result = await run(tx, {
            name,
            context,
            fields: entry.input(seeded),
            expectedVersion: entry.expectedVersion,
          });
          expect(result, name).toEqual(entry.result(seeded));
          expect(await entry.state(tx, seeded), name).toEqual(entry.after);
        }
        expect(
          (await auditRows(tx, organizationId)).map((row) => row.action).sort(),
        ).toEqual(requeueNames.map((name) => requeue(name).audit).sort());
        for (const row of await auditRows(tx, organizationId))
          expect(row).toMatchObject({
            actorType: "user",
            actorId: actor.userId,
          });
      });
    });

    test.each([
      ["an organisation member", "member", "active"],
      ["a revoked owner", "owner", "revoked"],
    ] as const)(
      "%s is refused every requeue, and nothing is written",
      async (_, role, status) => {
        await inRollbackTransaction(async (tx) => {
          const { seeded, context, organizationId, actor } = await tenant(
            tx,
            role,
            status,
          );
          for (const name of requeueNames) {
            const entry = requeue(name);
            const error = await refusal(
              run(tx, {
                name,
                context,
                fields: entry.input(seeded),
                expectedVersion: entry.expectedVersion,
              }),
            );
            expect(error, name).toBeInstanceOf(DomainError);
            expect((error as DomainError).code, name).toBe("forbidden");
            expect(await entry.state(tx, seeded), name).toEqual(entry.before);
          }
          expect(await auditRows(tx, organizationId)).toEqual([]);
          expect(await receiptsOf(tx, actor.userId)).toEqual([]);
        });
      },
    );

    test("a suspended organisation is refused every requeue", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, context, organizationId } = await tenant(tx);
        await tx.execute(sql`
          update "organizations" set "status" = 'suspended'
          where "id" = ${organizationId}
        `);
        for (const name of requeueNames) {
          const entry = requeue(name);
          const error = await refusal(
            run(tx, {
              name,
              context,
              fields: entry.input(seeded),
              expectedVersion: entry.expectedVersion,
            }),
          );
          expect((error as DomainError).code, name).toBe("forbidden");
          expect(await entry.state(tx, seeded), name).toEqual(entry.before);
        }
      });
    });

    test("an ended session is refused by the bus's re-check", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, context, actor } = await tenant(tx);
        await tx.execute(sql`
          update "session" set "expires_at" = now() - interval '1 minute'
          where "id" = ${actor.sessionId}
        `);
        for (const name of requeueNames) {
          const entry = requeue(name);
          const error = await refusal(
            run(tx, {
              name,
              context,
              fields: entry.input(seeded),
              expectedVersion: entry.expectedVersion,
            }),
          );
          expect((error as DomainError).code, name).toBe("forbidden");
          expect(await entry.state(tx, seeded), name).toEqual(entry.before);
        }
      });
    });

    test("another organisation's rows are not found, even for an owner of both", async () => {
      await inRollbackTransaction(async (tx) => {
        const home = await tenant(tx);
        const other = await seedOrganization(tx);
        await seedMembership(tx, other, home.actor.userId, "owner");
        const foreign = await seedRows(tx, other, home.actor.userId);
        const messages: Record<string, string> = {
          requeue_outbox: "Outbox record was not found",
          requeue_notification: "Notification intent was not found",
          requeue_slack_operation: "Slack operation was not found",
          requeue_import_dispatch: "Import dispatch was not found",
        };
        for (const name of requeueNames) {
          const entry = requeue(name);
          const error = await refusal(
            run(tx, {
              name,
              context: home.context,
              fields: entry.input(foreign),
              expectedVersion: entry.expectedVersion,
            }),
          );
          expect((error as DomainError).code, name).toBe("not_found");
          // Not the bus's own not_found for a command it does not hold.
          expect((error as DomainError).message, name).toBe(messages[name]);
          expect(await entry.state(tx, foreign), name).toEqual(entry.before);
        }
        expect(await auditRows(tx, other)).toEqual([]);
      });
    });
  });

  describe("what the command checks before the repository runs", () => {
    test("a context without operations:manage is refused naming that scope", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, organizationId, actor } = await tenant(tx);
        for (const name of requeueNames) {
          const entry = requeue(name);
          const error = await refusal(
            run(tx, {
              name,
              context: humanContext({
                ...actor,
                organizationId,
                scopes: ["org:read", "project:manage", "routing:manage"],
              }),
              fields: entry.input(seeded),
              expectedVersion: entry.expectedVersion,
            }),
          );
          expect(error, name).toBeInstanceOf(DomainError);
          expect((error as DomainError).details, name).toEqual({
            scope: "operations:manage",
          });
          expect(await entry.state(tx, seeded), name).toEqual(entry.before);
        }
      });
    });

    test("an input naming another organisation than the context's is refused", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, context } = await tenant(tx);
        for (const name of requeueNames) {
          const entry = requeue(name);
          const error = await refusal(
            run(tx, {
              name,
              context,
              organizationId: crypto.randomUUID(),
              fields: entry.input(seeded),
              expectedVersion: entry.expectedVersion,
            }),
          );
          expect((error as DomainError).code, name).toBe("forbidden");
          expect(await entry.state(tx, seeded), name).toEqual(entry.before);
        }
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
          const { seeded, organizationId } = await tenant(tx);
          // The bus's own `assertCurrent` is left out here. It would refuse
          // both contexts on its own — the agent for carrying no project, the
          // `operator:` service actor because its context does not say
          // `credentialKind: "operator"`, so it is no well-formed operator —
          // which would hide whether the command refuses them itself.
          for (const name of requeueNames) {
            const entry = requeue(name);
            const error = await refusal(
              bus(tx, { assertCurrent: false }).execute({
                name,
                context: {
                  actor,
                  organizationId,
                  scopes: new Set(["operations:manage"]),
                  credentialId: "not-a-person",
                  correlationId: crypto.randomUUID(),
                },
                input: { organizationId, ...entry.input(seeded) },
                meta: {
                  idempotencyKey: key(),
                  expectedVersion: entry.expectedVersion,
                },
              }),
            );
            expect(error, name).toBeInstanceOf(DomainError);
            expect((error as DomainError).code, name).toBe("forbidden");
            expect((error as DomainError).message, name).toBe(
              "Operations require a person or an operator credential",
            );
            expect(await entry.state(tx, seeded), name).toEqual(entry.before);
          }
        });
      },
    );

    test("an id that is not a UUID is refused as invalid input, naming the field", async () => {
      await inRollbackTransaction(async (tx) => {
        const { context } = await tenant(tx);
        const fields: Record<string, string> = {
          requeue_outbox: "outboxId",
          requeue_notification: "notificationIntentId",
          requeue_slack_operation: "operationId",
          requeue_import_dispatch: "dispatchId",
        };
        for (const name of requeueNames) {
          const field = fields[name] ?? "";
          const error = await refusal(
            run(tx, {
              name,
              context,
              fields: { [field]: "operator:lineage" },
              expectedVersion: 0,
            }),
          );
          expect((error as DomainError).code, name).toBe("validation_failed");
          expect((error as DomainError).details, name).toEqual({ field });
        }
      });
    });
  });

  describe("versions, states, replays and conflicts", () => {
    test("a stale attempt count answers version_conflict and writes nothing", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, context, organizationId, actor } = await tenant(tx);
        for (const name of requeueNames) {
          const entry = requeue(name);
          const error = await refusal(
            run(tx, {
              name,
              context,
              fields: entry.input(seeded),
              expectedVersion: entry.expectedVersion + 1,
            }),
          );
          expect((error as DomainError).code, name).toBe("version_conflict");
          expect(await entry.state(tx, seeded), name).toEqual(entry.before);
        }
        expect(await auditRows(tx, organizationId)).toEqual([]);
        expect(await receiptsOf(tx, actor.userId)).toEqual([]);
      });
    });

    test("a row that is not failed or dead-lettered answers invalid_state, as today", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, context } = await tenant(tx);
        await tx
          .update(outbox)
          .set({ state: "completed" })
          .where(eq(outbox.id, seeded.outboxId));
        await tx
          .update(notificationIntents)
          .set({ status: "pending" })
          .where(eq(notificationIntents.id, seeded.notificationIntentId));
        await tx
          .update(slackDeliveryOperations)
          .set({ status: "retry" })
          .where(eq(slackDeliveryOperations.id, seeded.slackOperationId));
        await tx
          .update(importTaskDispatches)
          .set({ state: "pending" })
          .where(eq(importTaskDispatches.id, seeded.importDispatchId));
        for (const name of requeueNames) {
          const entry = requeue(name);
          const error = await refusal(
            run(tx, {
              name,
              context,
              fields: entry.input(seeded),
              expectedVersion: entry.expectedVersion,
            }),
          );
          expect((error as DomainError).code, name).toBe("invalid_state");
        }
      });
    });

    test("a replay with the same key and input answers the first result, writing nothing more", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, context, organizationId } = await tenant(tx);
        for (const name of requeueNames) {
          const entry = requeue(name);
          const idempotencyKey = key();
          const first = await run(tx, {
            name,
            context,
            fields: entry.input(seeded),
            expectedVersion: entry.expectedVersion,
            idempotencyKey,
          });
          const again = await run(tx, {
            name,
            context: { ...context, correlationId: crypto.randomUUID() },
            fields: entry.input(seeded),
            expectedVersion: entry.expectedVersion,
            idempotencyKey,
          });
          expect(again, name).toEqual(first);
          expect(await entry.state(tx, seeded), name).toEqual(entry.after);
        }
        expect(await auditRows(tx, organizationId)).toHaveLength(
          requeueNames.length,
        );
      });
    });

    test("a key reused with different input answers idempotency_conflict", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, context, organizationId, actor } = await tenant(tx);
        const other = await seedRows(tx, organizationId, actor.userId);
        for (const name of requeueNames) {
          const entry = requeue(name);
          const idempotencyKey = key();
          await run(tx, {
            name,
            context,
            fields: entry.input(seeded),
            expectedVersion: entry.expectedVersion,
            idempotencyKey,
          });
          const error = await refusal(
            run(tx, {
              name,
              context,
              fields: entry.input(other),
              expectedVersion: entry.expectedVersion,
              idempotencyKey,
            }),
          );
          expect((error as DomainError).code, name).toBe(
            "idempotency_conflict",
          );
          expect(await entry.state(tx, other), name).toEqual(entry.before);
        }
      });
    });

    test("a replay by a member who has since lost the role is refused, not answered", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, context, organizationId, actor } = await tenant(
          tx,
          "admin",
        );
        const keys = new Map<string, string>();
        for (const name of requeueNames) {
          const entry = requeue(name);
          const idempotencyKey = key();
          keys.set(name, idempotencyKey);
          await run(tx, {
            name,
            context,
            fields: entry.input(seeded),
            expectedVersion: entry.expectedVersion,
            idempotencyKey,
          });
        }
        await tx.execute(sql`
          update "organization_members" set "role" = 'member'
          where "organization_id" = ${organizationId}
            and "user_id" = ${actor.userId}
        `);
        for (const name of requeueNames) {
          const entry = requeue(name);
          const error = await refusal(
            run(tx, {
              name,
              context,
              fields: entry.input(seeded),
              expectedVersion: entry.expectedVersion,
              idempotencyKey: keys.get(name),
            }),
          );
          expect((error as DomainError).code, name).toBe("forbidden");
        }
      });
    });
  });

  /*
    The receipt decision (`manifest-f2.md` §2.4, F.2.4): a requeue's one
    receipt is the bus's. The repository keeps none of its own, so no secret
    is wired into it at all, and the bus's is never handed to it.
  */
  describe("receipts", () => {
    test("each requeue leaves exactly one receipt, the bus's, and no other under any name", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, context, actor } = await tenant(tx);
        const expected: Array<Record<string, unknown>> = [];
        for (const name of requeueNames) {
          const entry = requeue(name);
          const idempotencyKey = key();
          const result = await run(tx, {
            name,
            context,
            fields: entry.input(seeded),
            expectedVersion: entry.expectedVersion,
            idempotencyKey,
          });
          expected.push({
            commandName: name,
            idempotencyFingerprint: keyedFingerprint(busSecret, idempotencyKey),
            resultJson: result,
          });
        }
        const byName = (
          a: { commandName: string },
          b: { commandName: string },
        ) => a.commandName.localeCompare(b.commandName);
        expect((await receiptsOf(tx, actor.userId)).sort(byName)).toEqual(
          (expected as Array<{ commandName: string }>).sort(byName),
        );
        // And none under any other actor: four commands, four receipts.
        expect((await receiptsWrittenHere(tx)).sort(byName)).toEqual(
          [...requeueNames].sort().map((commandName) => ({
            actorFingerprint: actorFingerprint({
              type: "user",
              id: actor.userId,
            }),
            commandName,
          })),
        );
      });
    });

    test("a receipt the repository stored before the port does not answer the bus: the retry meets the row's state", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, context, organizationId, actor } = await tenant(tx);
        const idempotencyKey = key();
        // What the form's first submission left before the deploy: the
        // requeued row, its audit row, and the repository's own receipt,
        // keyed with the form's secret under the same command name.
        await tx
          .update(notificationIntents)
          .set({ status: "pending", attemptCount: 0 })
          .where(eq(notificationIntents.id, seeded.notificationIntentId));
        await tx.insert(commandReceipts).values({
          actorFingerprint: actorFingerprint({
            type: "user",
            id: actor.userId,
          }),
          commandName: "requeue_notification",
          idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
          normalizedInputHash: normalizedInputHash({
            notificationIntentId: seeded.notificationIntentId,
          }),
          resultJson: { notificationIntentId: seeded.notificationIntentId },
          expiresAt: new Date(Date.now() + 60_000),
        });

        const error = await refusal(
          run(tx, {
            name: "requeue_notification",
            context,
            fields: { notificationIntentId: seeded.notificationIntentId },
            expectedVersion: 3,
            idempotencyKey,
          }),
        );
        expect((error as DomainError).code).toBe("version_conflict");
        expect(await requeue("requeue_notification").state(tx, seeded)).toEqual(
          { state: "pending", attemptCount: 0 },
        );
        expect(
          await tx
            .select({ id: securityAuditRecords.id })
            .from(securityAuditRecords)
            .where(
              and(
                eq(securityAuditRecords.organizationId, organizationId),
                eq(securityAuditRecords.action, "notification.requeued"),
              ),
            ),
        ).toEqual([]);
      });
    });
  });

  /*
    Plan 13, F.2.4's registry half: an operator credential runs the four
    requeues with its issuing member's authority, through the same bus, port
    and `assertCurrent` a person's form does, with operator credentials
    switched on. Each refusal below is shown able to pass first: the same
    credential succeeds before the change that makes it fail.
  */
  describe("an operator credential", () => {
    test.each([
      ["an owner's", "owner"],
      ["an admin's", "admin"],
    ] as const)(
      "%s organisation-wide operator runs every requeue, recorded as the service it is",
      async (_, role) => {
        await inRollbackTransaction(async (tx) => {
          const { seeded, organizationId, actor } = await tenant(tx, role);
          const credential = await issueOperator(tx, {
            organizationId,
            userId: actor.userId,
          });
          const context = operatorContext(credential);
          for (const name of requeueNames) {
            const entry = requeue(name);
            const result = await run(tx, {
              name,
              context,
              fields: entry.input(seeded),
              expectedVersion: entry.expectedVersion,
            });
            expect(result, name).toEqual(entry.result(seeded));
            expect(await entry.state(tx, seeded), name).toEqual(entry.after);
          }
          const audits = await auditRows(tx, organizationId);
          // The credential's own issuance row, then one per requeue.
          const requeued = audits.filter(
            (row) => row.action !== "operator.credential_issued",
          );
          expect(requeued.map((row) => row.action).sort()).toEqual(
            requeueNames.map((name) => requeue(name).audit).sort(),
          );
          for (const row of requeued)
            expect(row).toMatchObject({
              actorType: "service",
              actorId: `operator:${credential.lineageId}`,
            });
          // The member is recorded as the actor of nothing it did not do
          // itself: only the issuance, which the member performed.
          expect(
            audits
              .filter((row) => row.actorId === actor.userId)
              .map((row) => row.action),
          ).toEqual(["operator.credential_issued"]);
        });
      },
    );

    test("its receipt is its own, never its member's", async () => {
      await inRollbackTransaction(async (tx) => {
        const {
          seeded,
          organizationId,
          actor,
          context: member,
        } = await tenant(tx);
        const credential = await issueOperator(tx, {
          organizationId,
          userId: actor.userId,
        });
        const context = operatorContext(credential);
        const idempotencyKey = key();
        const fields = { notificationIntentId: seeded.notificationIntentId };
        const first = await run(tx, {
          name: "requeue_notification",
          context,
          fields,
          expectedVersion: 3,
          idempotencyKey,
        });
        // The member's own retry with the operator's key is not answered from
        // the operator's receipt: it runs, and meets the attempt count the
        // operator's requeue reset.
        const retry = await refusal(
          run(tx, {
            name: "requeue_notification",
            context: member,
            fields,
            expectedVersion: 3,
            idempotencyKey,
          }),
        );
        expect((retry as DomainError).code).toBe("version_conflict");
        // The operator's replay is answered from its receipt.
        expect(
          await run(tx, {
            name: "requeue_notification",
            context: operatorContext(credential),
            fields,
            expectedVersion: 3,
            idempotencyKey,
          }),
        ).toEqual(first);
        expect(await receiptsWrittenHere(tx)).toEqual([
          {
            actorFingerprint: actorFingerprint(context.actor),
            commandName: "requeue_notification",
          },
        ]);
        expect(await receiptsOf(tx, actor.userId)).toEqual([]);
      });
    });

    test("an operator bound to a project is refused every requeue, and nothing is written", async () => {
      await inRollbackTransaction(async (tx) => {
        const { seeded, organizationId, actor } = await tenant(tx);
        const projectId = await seedProject(tx, organizationId);
        const credential = await issueOperator(tx, {
          organizationId,
          userId: actor.userId,
          projectId,
        });
        for (const name of requeueNames) {
          const entry = requeue(name);
          const error = await refusal(
            run(tx, {
              name,
              context: operatorContext(credential),
              fields: entry.input(seeded),
              expectedVersion: entry.expectedVersion,
            }),
          );
          expect(error, name).toBeInstanceOf(DomainError);
          expect((error as DomainError).code, name).toBe("forbidden");
          expect((error as DomainError).message, name).toBe(
            "Operations require a credential bound to no project",
          );
          expect(await entry.state(tx, seeded), name).toEqual(entry.before);
        }
        expect(
          (await auditRows(tx, organizationId)).map((row) => row.action),
        ).toEqual(["operator.credential_issued"]);
        expect(await receiptsWrittenHere(tx)).toEqual([]);
      });
    });

    test("an operator issued for one organisation finds no row of another, though its member owns both", async () => {
      await inRollbackTransaction(async (tx) => {
        const home = await tenant(tx);
        const other = await seedOrganization(tx);
        await seedMembership(tx, other, home.actor.userId, "owner");
        const foreign = await seedRows(tx, other, home.actor.userId);
        const credential = await issueOperator(tx, {
          organizationId: home.organizationId,
          userId: home.actor.userId,
        });
        const messages: Record<string, string> = {
          requeue_outbox: "Outbox record was not found",
          requeue_notification: "Notification intent was not found",
          requeue_slack_operation: "Slack operation was not found",
          requeue_import_dispatch: "Import dispatch was not found",
        };
        for (const name of requeueNames) {
          const entry = requeue(name);
          const error = await refusal(
            run(tx, {
              name,
              context: operatorContext(credential),
              fields: entry.input(foreign),
              expectedVersion: entry.expectedVersion,
            }),
          );
          expect((error as DomainError).code, name).toBe("not_found");
          expect((error as DomainError).message, name).toBe(messages[name]);
          expect(await entry.state(tx, foreign), name).toEqual(entry.before);
          // Naming the other organisation in the input is refused outright;
          // the route overwrites that field with the credential's anyway.
          const named = await refusal(
            run(tx, {
              name,
              context: operatorContext(credential),
              organizationId: other,
              fields: entry.input(foreign),
              expectedVersion: entry.expectedVersion,
            }),
          );
          expect((named as DomainError).code, name).toBe("forbidden");
          expect(await entry.state(tx, foreign), name).toEqual(entry.before);
        }
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
          const { seeded, organizationId, actor } = await tenant(tx);
          const credential = await issueOperator(tx, {
            organizationId,
            userId: actor.userId,
          });
          await run(tx, {
            name: "requeue_outbox",
            context: operatorContext(credential),
            fields: requeue("requeue_outbox").input(seeded),
            expectedVersion: 5,
          });
          await change(tx, {
            organizationId,
            userId: actor.userId,
            credentialId: credential.id,
            apiKeyId: credential.apiKeyId,
          });
          for (const name of requeueNames.filter(
            (name) => name !== "requeue_outbox",
          )) {
            const entry = requeue(name);
            const error = await refusal(
              run(tx, {
                name,
                context: operatorContext(credential),
                fields: entry.input(seeded),
                expectedVersion: entry.expectedVersion,
              }),
            );
            expect(error, name).toBeInstanceOf(DomainError);
            expect((error as DomainError).code, name).toBe("forbidden");
            expect(await entry.state(tx, seeded), name).toEqual(entry.before);
          }
          expect(
            (await auditRows(tx, organizationId))
              .map((row) => row.action)
              .filter((action) => action !== "operator.credential_issued"),
          ).toEqual(["outbox.requeued"]);
        });
      },
    );
  });
});
