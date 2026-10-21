import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  createCoreCommandRegistry,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../../client.js";
import { createStorage, storageOptionsFromEnv } from "../../client.js";
import { createCommandTransactionManager } from "../../repositories/command-repository.js";
import { createOperationsCommandRepository } from "../../repositories/operations-repository.js";
import { createOperatorCredentialRepository } from "../../repositories/operator-credential-repository.js";
import { createRetentionHoldCommandRepository } from "../../repositories/retention-hold-repository.js";
import { tenantWrappingEnabled } from "../../tenant-context.js";
import { endingEachMethodBinding } from "../../test-support/tenant-binding.js";
import type { Tx } from "../../transaction.js";
import {
  listAdministrationOperations,
  listAdministrationRetentionHolds,
  readOperationsForOperator,
  readRetentionHoldsForOperator,
} from "./operations-reads.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  `list_administration_operations` and `list_administration_retention_holds`
  (Plan 13, F.2.4; `manifest-f2.md` §4.1), at the repository: what they
  return, and whom they refuse. `/api/v1` reaches them for an operator
  credential only: each has a registry entry naming `credentialKinds:
  ["operator"]`, and its dispatch line
  (`packages/core/src/administration-reads.ts`) runs
  `readOperationsForOperator` or `readRetentionHoldsForOperator` in one
  transaction. Those first run the bus's own `assertCurrent` on the context,
  then hand the read the member F.3's `memberAuthority` names and the
  credential's organisation and project; their cases are the last block
  here.

  Every case runs in a transaction that is rolled back at the end.
*/

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

async function seedUser(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Operations reader', ${email}, now())
  `);
  return { userId, email };
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Operations read tenant',
      ${`operations-read-${organizationId}`}, 'active')
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
 * One row of each kind in `organizationId`, each in the state its requeue
 * accepts, and one active hold on `holdCategory` with a reason.
 */
async function seedRows(
  tx: Tx,
  organizationId: string,
  userId: string,
  holdCategory: "all" | "slack_oauth_state" | "slack_action_token" = "all",
) {
  const eventId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "domain_events" ("id", "organization_id", "aggregate_type",
      "aggregate_id", "aggregate_version", "type", "schema_version", "actor",
      "correlation_id", "causation_id", "data")
    values (${eventId}, ${organizationId}, 'operations_probe',
      ${crypto.randomUUID()}, 1, 'operations.probe.v1', 1,
      '{"type":"system","id":"operations-read"}'::jsonb, 'operations-read',
      'operations-read', '{}'::jsonb)
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
      values (${organizationId}, 'slack', 'reader@example.invalid',
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
        'Operations read workspace', '{}'::jsonb, 'U0PERATIONS', ${userId})
      returning "id"
    `,
  );
  const slackOperationId = await firstId(
    tx,
    sql`
      insert into "slack_delivery_operations" ("installation_id",
        "operation_key", "operation_type", "status", "attempt_count",
        "last_error_code")
      values (${installationId}, ${crypto.randomUUID()}, 'message_update',
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
        ${`operations-read-${suffix}`}, ${`R${suffix.slice(0, 4).toUpperCase()}`},
        'active')
      returning "id"
    `,
  );
  const importSourceId = await firstId(
    tx,
    sql`
      insert into "import_sources" ("organization_id", "project_id",
        "created_by")
      values (${organizationId}, ${projectId}, ${userId})
      returning "id"
    `,
  );
  const snapshotId = await firstId(
    tx,
    sql`
      insert into "source_snapshots" ("organization_id", "import_source_id",
        "manifest_sha256")
      values (${organizationId}, ${importSourceId}, ${"b".repeat(64)})
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
        ${userId}, 'operations-read')
      returning "id"
    `,
  );
  const importDispatchId = await firstId(
    tx,
    sql`
      insert into "import_task_dispatches" ("organization_id",
        "import_run_id", "task_kind", "task_payload", "state",
        "attempt_count", "last_error_code")
      values (${organizationId}, ${importRunId}, 'apply', '{}'::jsonb,
        'dead_letter', 6, 'trigger_unavailable')
      returning "id"
    `,
  );
  const holdId = await firstId(
    tx,
    sql`
      insert into "retention_holds" ("organization_id", "category", "reason",
        "created_by_user_id")
      values (${organizationId}, ${holdCategory}, 'A reason nobody reads here',
        ${userId})
      returning "id"
    `,
  );
  return {
    outboxId,
    notificationIntentId,
    slackOperationId,
    importDispatchId,
    holdId,
  };
}

async function tenant(
  tx: Tx,
  role: "owner" | "admin" | "member" = "owner",
  status: "active" | "revoked" = "active",
) {
  const organizationId = await seedOrganization(tx);
  const member = await seedUser(tx);
  await seedMembership(tx, organizationId, member.userId, role, status);
  const seeded = await seedRows(tx, organizationId, member.userId);
  return {
    organizationId,
    member,
    seeded,
    input: {
      memberUserId: member.userId,
      organizationId,
      credentialProjectId: null,
    },
  };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the read was not refused");
}

const reads = [
  ["list_administration_operations", listAdministrationOperations],
  ["list_administration_retention_holds", listAdministrationRetentionHolds],
] as const;

/** Every id anywhere in an answer. */
function ids(answer: unknown): string[] {
  return JSON.stringify(answer).match(/[0-9a-f-]{36}/gu) ?? [];
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("list_administration_operations", () => {
  test("answers an owner with exactly the ids, states and attempt counts, and nothing else", async () => {
    await inRollbackTransaction(async (tx) => {
      const { seeded, input, member } = await tenant(tx);
      const answer = await listAdministrationOperations(tx, input);

      // Creating an organisation seeds its appearance defaults, with their
      // event and a pending outbox row (migration 0014), so the outbox list
      // holds that row as well as the seeded one.
      const { outbox: outboxRows, ...others } = answer;
      expect(outboxRows).toContainEqual({
        id: seeded.outboxId,
        state: "dead_letter",
        attemptCount: 5,
      });
      for (const row of outboxRows)
        expect(Object.keys(row).sort()).toEqual([
          "attemptCount",
          "id",
          "state",
        ]);
      expect(others).toEqual({
        notificationIntents: [
          {
            id: seeded.notificationIntentId,
            channel: "slack",
            status: "failed",
            attemptCount: 3,
          },
        ],
        slackOperations: [
          {
            id: seeded.slackOperationId,
            operationType: "message_update",
            status: "failed",
            attemptCount: 4,
          },
        ],
        importDispatches: [
          {
            id: seeded.importDispatchId,
            state: "dead_letter",
            attemptCount: 6,
          },
        ],
      });
      const text = JSON.stringify(answer);
      for (const absent of [
        member.email,
        "reader@example.invalid",
        "provider_rejected",
        "slack_unavailable",
        "trigger_unavailable",
        "operations.probe.v1",
      ])
        expect(text).not.toContain(absent);
    });
  });

  test("answers an admin, and lists newest first, 200 rows at most per list", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, seeded, input } = await tenant(tx, "admin");
      await tx.execute(sql`
        insert into "notification_intents" ("organization_id", "channel",
          "recipient_ref", "template", "dedupe_key", "view_model", "status",
          "created_at")
        select ${organizationId}, 'email', 'bulk@example.invalid', 'bulk',
          gen_random_uuid()::text, '{}'::jsonb, 'pending',
          now() + make_interval(secs => n)
        from generate_series(1, 200) as n
      `);
      const answer = await listAdministrationOperations(tx, input);
      expect(answer.notificationIntents).toHaveLength(200);
      expect(answer.notificationIntents.map((row) => row.id)).not.toContain(
        seeded.notificationIntentId,
      );
      expect(answer.outbox).toHaveLength(1);
    });
  });
});

describe.sequential("list_administration_retention_holds", () => {
  test("answers an owner with exactly the ids, categories, states and versions, and nothing else", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, seeded, input, member } = await tenant(tx);
      await tx.execute(sql`
        update "retention_holds"
        set "status" = 'released', "version" = 2, "released_at" = now(),
          "released_by_user_id" = ${member.userId}
        where "id" = ${seeded.holdId}
      `);
      const later = await firstId(
        tx,
        sql`
          insert into "retention_holds" ("organization_id", "category",
            "reason", "created_by_user_id", "created_at")
          values (${organizationId}, 'slack_action_token',
            'Another reason nobody reads', ${member.userId},
            now() + interval '1 minute')
          returning "id"
        `,
      );
      const answer = await listAdministrationRetentionHolds(tx, input);

      expect(answer).toEqual([
        {
          id: later,
          category: "slack_action_token",
          status: "active",
          version: 1,
        },
        { id: seeded.holdId, category: "all", status: "released", version: 2 },
      ]);
      expect(JSON.stringify(answer)).not.toContain("reason nobody reads");
    });
  });
});

describe.sequential("both operations reads", () => {
  test.each(reads)("%s answers an admin", async (_, read) => {
    await inRollbackTransaction(async (tx) => {
      const { input } = await tenant(tx, "admin");
      await expect(read(tx, input)).resolves.toBeDefined();
    });
  });

  test.each(reads)(
    "%s refuses a member below admin, a revoked owner, and anyone in a suspended organisation",
    async (_, read) => {
      await inRollbackTransaction(async (tx) => {
        const member = await tenant(tx, "member");
        const revoked = await tenant(tx, "owner", "revoked");
        const suspended = await tenant(tx);
        await tx.execute(sql`
          update "organizations" set "status" = 'suspended'
          where "id" = ${suspended.organizationId}
        `);
        for (const who of [member, revoked, suspended]) {
          const error = await refusal(read(tx, who.input));
          expect(error).toBeInstanceOf(DomainError);
          expect((error as DomainError).code).toBe("forbidden");
        }
      });
    },
  );

  test.each(reads)(
    "%s never reads another organisation's rows, for an owner of both",
    async (_, read) => {
      await inRollbackTransaction(async (tx) => {
        const home = await tenant(tx);
        const other = await seedOrganization(tx);
        await seedMembership(tx, other, home.member.userId, "owner");
        const foreign = await seedRows(tx, other, home.member.userId);
        const answer = await read(tx, home.input);
        const seen = ids(answer);
        for (const id of Object.values(foreign)) expect(seen).not.toContain(id);
        expect(seen.length).toBeGreaterThan(0);
      });
    },
  );

  test.each(reads)(
    "%s refuses a credential bound to a project, before any query",
    async (_, read) => {
      await inRollbackTransaction(async (tx) => {
        const { input } = await tenant(tx);
        // An organisation id that is not a UUID would raise from PostgreSQL
        // if any query ran; the refusal comes first.
        const error = await refusal(
          read(tx, {
            ...input,
            organizationId: "not-a-uuid",
            credentialProjectId: crypto.randomUUID(),
          }),
        );
        expect((error as DomainError).code).toBe("forbidden");
        await expect(tx.execute(sql`select 1`)).resolves.toBeDefined();
      });
    },
  );

  test.each(reads)(
    "%s answers a member id that is an operator's as forbidden, never raised from the database",
    async (_, read) => {
      await inRollbackTransaction(async (tx) => {
        const { input } = await tenant(tx);
        const error = await refusal(
          read(tx, { ...input, memberUserId: "operator:lineage" }),
        );
        expect((error as DomainError).code).toBe("forbidden");
        await expect(tx.execute(sql`select 1`)).resolves.toBeDefined();
      });
    },
  );
});

/*
  What the reads are for: each id and version a write takes. An attempt count
  read here is accepted by its requeue as `expectedVersion`, and a hold's
  version by its release; one more than either answers `version_conflict`.
*/
describe.sequential("the reads serve the writes", () => {
  function bus(tx: Tx) {
    return new AtomicCommandBus({
      registry: createCoreCommandRegistry(),
      transactions: createCommandTransactionManager(
        tx as unknown as Database,
        (name, database) =>
          name === "operationsCommands"
            ? createOperationsCommandRepository(database as Database)
            : name === "retentionHoldCommands"
              ? createRetentionHoldCommandRepository(database as Database)
              : undefined,
      ),
      fingerprintSecret: "operations-read-bus-fingerprint-secret-000000000",
    });
  }

  function context(
    organizationId: string,
    userId: string,
  ): AuthorizedCommandContext {
    return {
      actor: { type: "user", id: userId },
      organizationId,
      scopes: new Set(["operations:manage"]),
      credentialId: "operations-read",
      correlationId: crypto.randomUUID(),
    };
  }

  test("each attempt count and version read is the one its write accepts, and one more is a version conflict", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, member, input, seeded } = await tenant(tx);
      const operations = await listAdministrationOperations(tx, input);
      const [hold] = await listAdministrationRetentionHolds(tx, input);
      const outboxRow = operations.outbox.find(
        (row) => row.id === seeded.outboxId,
      );
      const [intent] = operations.notificationIntents;
      const [slack] = operations.slackOperations;
      const [importRow] = operations.importDispatches;
      if (!outboxRow || !intent || !slack || !importRow || !hold)
        throw new Error("a list was empty");
      const writes = [
        ["requeue_outbox", { outboxId: outboxRow.id }, outboxRow.attemptCount],
        [
          "requeue_notification",
          { notificationIntentId: intent.id },
          intent.attemptCount,
        ],
        [
          "requeue_slack_operation",
          { operationId: slack.id },
          slack.attemptCount,
        ],
        [
          "requeue_import_dispatch",
          { dispatchId: importRow.id },
          importRow.attemptCount,
        ],
        ["release_retention_hold", { holdId: hold.id }, hold.version],
      ] as const;
      for (const [name, fields, version] of writes) {
        const stale = await refusal(
          bus(tx).execute({
            name,
            context: context(organizationId, member.userId),
            input: { organizationId, ...fields },
            meta: {
              idempotencyKey: `operations-read-${crypto.randomUUID()}`,
              expectedVersion: version + 1,
            },
          }),
        );
        expect((stale as DomainError).code, name).toBe("version_conflict");
        await expect(
          bus(tx).execute({
            name,
            context: context(organizationId, member.userId),
            input: { organizationId, ...fields },
            meta: {
              idempotencyKey: `operations-read-${crypto.randomUUID()}`,
              expectedVersion: version,
            },
          }),
          name,
        ).resolves.toBeDefined();
      }
    });
  });
});

/*
  Plan 13, F.2.4's registry half: the two reads as `/api/v1` dispatches them
  for an operator credential (core's `administration-reads.ts`), each in the
  caller's one transaction: the bus's own `assertCurrent` on the context,
  under the deployment's switch, then the read for the member
  `memberAuthority` names. Each refusal below is shown able to pass first:
  the same credential is answered before the change that makes it fail.
*/

/**
 * Issues an operator credential for `userId` in `organizationId`, holding
 * `operations:manage`, as F.3's repository writes one, with the Better Auth
 * key row it is bound to, and the context `authenticateApiBearer` builds for
 * it.
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
    name: "Operations reader",
    prefix: "rpo_f24",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["operations:manage"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
  const context: AuthorizedCommandContext = {
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
  return { credential, context, apiKeyId };
}

type Changed = {
  organizationId: string;
  userId: string;
  credentialId: string;
  apiKeyId: string;
};

/**
 * Each read as REST dispatches it, beside the repository read it answers
 * with. `operatorCredentials` is the deployment's switch, `enabled` unless
 * the case says otherwise.
 */
const operatorReads = [
  [
    "list_administration_operations",
    readOperationsForOperator,
    listAdministrationOperations,
  ],
  [
    "list_administration_retention_holds",
    readRetentionHoldsForOperator,
    listAdministrationRetentionHolds,
  ],
] as const;

describe.sequential("both operations reads, as REST dispatches them for an operator", () => {
  test.each(operatorReads)(
    "%s answers an owner's operator with the projection its member would get",
    async (_, asOperator, read) => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, member, input } = await tenant(tx);
        const { context } = await issueOperator(tx, {
          organizationId,
          userId: member.userId,
        });
        expect(
          await asOperator(tx, { context, operatorCredentials: "enabled" }),
        ).toEqual(await read(tx, input));
      });
    },
  );

  const changes: Array<[string, (tx: Tx, at: Changed) => Promise<void>]> = [
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
  test.each(
    operatorReads.flatMap(([name, asOperator]) =>
      changes.map(
        ([change, apply]) => [name, change, asOperator, apply] as const,
      ),
    ),
  )(
    "%s refuses once %s, having answered before",
    async (_, __, asOperator, change) => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, member } = await tenant(tx);
        const { credential, context, apiKeyId } = await issueOperator(tx, {
          organizationId,
          userId: member.userId,
        });
        await expect(
          asOperator(tx, { context, operatorCredentials: "enabled" }),
        ).resolves.toBeDefined();
        await change(tx, {
          organizationId,
          userId: member.userId,
          credentialId: credential.id,
          apiKeyId,
        });
        const error = await refusal(
          asOperator(tx, { context, operatorCredentials: "enabled" }),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("forbidden");
      });
    },
  );

  test.each(operatorReads)(
    "%s refuses every operator while operator credentials are switched off",
    async (_, asOperator) => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, member } = await tenant(tx);
        const { context } = await issueOperator(tx, {
          organizationId,
          userId: member.userId,
        });
        await expect(
          asOperator(tx, { context, operatorCredentials: "enabled" }),
        ).resolves.toBeDefined();
        for (const setting of ["disabled", undefined] as const) {
          const error = await refusal(
            asOperator(tx, { context, operatorCredentials: setting }),
          );
          expect((error as DomainError).code, String(setting)).toBe(
            "forbidden",
          );
        }
      });
    },
  );

  test.each(operatorReads)(
    "%s never answers an operator issued for one organisation with another's rows, though its member owns both",
    async (_, asOperator) => {
      await inRollbackTransaction(async (tx) => {
        const home = await tenant(tx);
        const other = await seedOrganization(tx);
        await seedMembership(tx, other, home.member.userId, "owner");
        const foreign = await seedRows(tx, other, home.member.userId);
        const { context } = await issueOperator(tx, {
          organizationId: home.organizationId,
          userId: home.member.userId,
        });
        const seen = ids(
          await asOperator(tx, { context, operatorCredentials: "enabled" }),
        );
        for (const id of Object.values(foreign)) expect(seen).not.toContain(id);
        expect(seen.length).toBeGreaterThan(0);
      });
    },
  );

  test.each(operatorReads)(
    "%s refuses an operator bound to a project, though its credential is current",
    async (_, asOperator) => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, member } = await tenant(tx);
        const suffix = crypto.randomUUID().slice(0, 8);
        const projectId = await firstId(
          tx,
          sql`
            insert into "projects" ("organization_id", "name", "slug",
              "key_prefix", "status")
            values (${organizationId}, ${`Bound ${suffix}`},
              ${`bound-${suffix}`}, ${`B${suffix.slice(0, 4).toUpperCase()}`},
              'active')
            returning "id"
          `,
        );
        const { context } = await issueOperator(tx, {
          organizationId,
          userId: member.userId,
          projectId,
        });
        const error = await refusal(
          asOperator(tx, { context, operatorCredentials: "enabled" }),
        );
        expect((error as DomainError).code).toBe("forbidden");
        expect((error as DomainError).message).toBe(
          "Operations reads require an organisation-wide credential",
        );
      });
    },
  );

  test.each(operatorReads)(
    "%s refuses a context that is not an operator's before anything is read",
    async (_, asOperator) => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, member } = await tenant(tx);
        const { context } = await issueOperator(tx, {
          organizationId,
          userId: member.userId,
        });
        for (const stranger of [
          { ...context, credentialKind: undefined },
          { ...context, actor: { type: "user" as const, id: member.userId } },
          {
            ...context,
            actor: { type: "agent" as const, id: crypto.randomUUID() },
            credentialKind: undefined,
          },
        ]) {
          const error = await refusal(
            asOperator(tx, {
              context: stranger,
              operatorCredentials: "enabled",
            }),
          );
          expect(error).toBeInstanceOf(DomainError);
          expect((error as DomainError).code).toBe("forbidden");
          expect((error as DomainError).message).toBe(
            "This read admits an operator credential only",
          );
        }
      });
    },
  );
});
