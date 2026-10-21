import type { Storage, Tx } from "@requestport/db";
import {
  type AuthorizedCommandContext,
  actorFingerprint,
  type DomainError,
  keyedFingerprint,
  operatorActor,
} from "@requestport/domain";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  agentContext,
  restClient,
  signInAs,
} from "../../../test/api-v1/agent-client.js";
import { apiV1, resetApiV1Fakes } from "../../../test/api-v1/fake-database.js";

/*
  The Slack connection test end to end on PostgreSQL (Plan 13, F.2.5's
  connection test follow-up): the real `/api/v1` route, its registry entry
  `send_slack_connection_test`, the real handler (`@requestport/core`'s, which
  `lib/server-slack-actions.ts` hands the form), the real `assertCurrent` and
  the real repository, against this run's database. The form calls the same
  handler, as the signed-in person; the cases below that run the handler
  directly are the form's path (`slack/actions.test.ts` holds that the form
  hands it the person's context).

  What is not real, and why:

  - `authenticateApiBearer` answers the context the case signs in as, built
    from a credential the case issued through F.3's repository, as
    `authenticateApiBearer` builds it for that credential. The key's own
    authentication is F.3's, and tested there.
  - The rate limiter lets every call through: its window is written on its
    own connection, outside the case's transaction, and would outlive it.
  - `triggerSlackConnectionTest` records the operation it is handed: no task
    starts.
  - `serverEnv` holds a fixed secret and the operator switch, which a case
    can turn off.
  - The handler's transaction is opened inside the case's own, which is
    rolled back at the end, as `packages/db`'s suites run the bus inside
    theirs: the web root's `transaction` becomes a savepoint of it. Each ends
    the tenant binding `assertCurrent` leaves, as the handler's own top-level
    transaction ends it in production (`test-support/tenant-binding.ts`).
    Every statement still runs on PostgreSQL, through a storage of this
    suite's own.
*/

const live = vi.hoisted(() => ({
  storage: undefined as Storage | undefined,
  tx: null as unknown,
  triggered: [] as string[],
  triggerFails: false,
  serverEnv: {
    BETTER_AUTH_SECRET: "f25c-connection-test-form-secret-000000000",
    REQUESTPORT_OPERATOR_CREDENTIALS: "enabled" as string | undefined,
  },
}));

/*
 * The handler opens its transaction on the web root's storage, and the
 * command bus's transaction manager holds that storage's handle (Plan 13,
 * G.2), both through the web's RequestPort since G.6, which
 * `server-web-request-port.ts` composes over the storage the wiring answers
 * the root (ruling 140). The wiring here builds this suite's storage when it
 * is first imported, from this process's environment, as each test lane sets
 * it, and keeps it in `live.storage`. It answers the root a storage whose
 * handle is that storage's, with its `transaction` made a savepoint of the
 * case's, so each handler transaction is still a savepoint of the case's.
 */
vi.mock("@requestport/db/wiring", async (importOriginal) => {
  const wiring =
    await importOriginal<typeof import("@requestport/db/wiring")>();
  const { createStorage } = await import("@requestport/db");
  const { endTenantBinding } = await import("@requestport/db/testing");
  const storage = createStorage(wiring.storageOptionsFromEnv(process.env));
  live.storage = storage;
  const db = new Proxy(storage.db, {
    get(target, property, receiver) {
      if (property !== "transaction")
        return Reflect.get(target, property, receiver);
      return async <T>(work: (tx: Tx) => Promise<T>) => {
        const outer = live.tx as Tx | null;
        if (!outer) throw new Error("No case transaction is open");
        try {
          return await outer.transaction(work);
        } finally {
          await endTenantBinding(outer);
        }
      };
    },
  });
  return {
    ...wiring,
    applicationStorageFromEnv: () => ({ db, transaction: db.transaction }),
  };
});
vi.mock(
  "@requestport/auth/server",
  async () =>
    (await import("../../../test/api-v1/fake-database.js"))
      .fakeAuthServerModule,
);
vi.mock("@requestport/config/server", () => ({ serverEnv: live.serverEnv }));
vi.mock(
  "../../../lib/observability.js",
  async () =>
    (await import("../../../test/api-v1/fake-database.js"))
      .fakeObservabilityModule,
);
vi.mock("../../../lib/trigger-client.js", () => ({
  dispatchCommittedEvents: async () => undefined,
  triggerSlackConnectionTest: async (operationId: string) => {
    if (live.triggerFails) throw new Error("Trigger.dev is unreachable");
    live.triggered.push(operationId);
  },
}));
vi.mock("../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => undefined,
  rateLimitFingerprint: () => "f25c-rate-limit",
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const database = await import("@requestport/db");
const route = await import("../../api/v1/[[...path]]/route.js");
const { queueSlackConnectionTest } = await import(
  "../../../lib/server-slack-actions.js"
);
const api = restClient(route);

/** This suite's storage, which the wiring's mock above built. */
function suiteStorage(): Storage {
  if (!live.storage) throw new Error("The wiring has not been imported");
  return live.storage;
}

class TestRollback extends Error {}

/** Runs a case in one transaction, rolled back at its end. */
async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage().transaction(async (tx) => {
      live.tx = tx;
      try {
        await run(tx);
      } finally {
        live.tx = null;
      }
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
}

/** A SQL string literal. Every value quoted here is one this suite made. */
function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function rows<T>(tx: Tx, query: string) {
  const result = (await tx.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

async function seedUser(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  const sessionId = `session_${crypto.randomUUID()}`;
  await tx.execute(`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${literal(email)}, 'active')
  `);
  await tx.execute(`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${literal(userId)}, 'Slack user', ${literal(email)}, now())
  `);
  await tx.execute(`
    insert into "session" ("id", "expires_at", "token", "updated_at", "user_id")
    values (${literal(sessionId)}, now() + interval '1 hour',
      ${literal(`token_${crypto.randomUUID()}`)}, now(), ${literal(userId)})
  `);
  return { userId, sessionId };
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${literal(organizationId)}, 'Slack tenant',
      ${literal(`slack-test-${organizationId}`)}, 'active')
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
  await tx.execute(`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${literal(organizationId)}, ${literal(userId)}, ${literal(role)},
      ${literal(status)})
  `);
}

async function seedProject(tx: Tx, organizationId: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [project] = await rows<{ id: string }>(
    tx,
    `
    insert into "projects"
      ("organization_id", "name", "slug", "key_prefix", "status")
    values (${literal(organizationId)}, ${literal(`Slack ${suffix}`)},
      ${literal(`slack-${suffix}`)},
      ${literal(`K${suffix.slice(0, 4).toUpperCase()}`)}, 'active')
    returning "id"
  `,
  );
  if (!project) throw new Error("no project");
  return project.id;
}

/** An active installation, installed by a member of the organisation. */
async function seedInstallation(tx: Tx, organizationId: string) {
  const installer = await seedUser(tx);
  await seedMembership(tx, organizationId, installer.userId, "member");
  const [installation] = await rows<{ id: string }>(
    tx,
    `
    insert into "slack_installations"
      ("organization_id", "workspace_id", "workspace_name",
       "bot_token_ciphertext", "bot_user_id", "installed_by_user_id")
    values (${literal(organizationId)},
      ${literal(`T${crypto.randomUUID().slice(0, 8).toUpperCase()}`)},
      'Slack test workspace', '{"sealed":"not-a-real-token"}'::jsonb,
      'U0BOTUSER', ${literal(installer.userId)})
    returning "id"
  `,
  );
  if (!installation) throw new Error("no installation");
  return installation.id;
}

/** An owner of a new organisation, with an active installation there. */
async function seedOwnedInstallation(tx: Tx) {
  const organizationId = await seedOrganization(tx);
  const owner = await seedUser(tx);
  await seedMembership(tx, organizationId, owner.userId, "owner");
  const installationId = await seedInstallation(tx, organizationId);
  return { organizationId, owner, installationId };
}

/**
 * An operator credential for `userId` in `organizationId`, holding
 * `slack:manage`, as F.3's repository issues one, with the Better Auth key
 * row it is bound to.
 */
async function issueOperator(
  tx: Tx,
  input: { organizationId: string; userId: string; projectId?: string | null },
) {
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(`
    insert into "apikey"
      ("id", "config_id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${literal(apiKeyId)}, 'requestport-operator',
      ${literal(input.userId)}, ${literal(`secret_${crypto.randomUUID()}`)},
      true, now() + interval '30 days', now(), now())
  `);
  const { endingEachMethodBinding } = await import("@requestport/db/testing");
  return endingEachMethodBinding(
    database.createOperatorCredentialRepository(tx),
    tx,
  ).createCredential({
    organizationId: input.organizationId,
    memberUserId: input.userId,
    projectId: input.projectId ?? null,
    betterAuthApiKeyId: apiKeyId,
    name: "Slack operator",
    prefix: "rpo_f25c",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["slack:manage"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
}

type Credential = Awaited<ReturnType<typeof issueOperator>>;

/** Signs every following call in as the operator, as the route authenticates it. */
function signInAsOperator(credential: Credential) {
  const context = {
    actor: operatorActor({
      lineageId: credential.lineageId,
      memberUserId: credential.memberUserId,
    }),
    credentialKind: "operator" as const,
    organizationId: credential.organizationId,
    projectId: credential.projectId,
    laneIds: new Set<string>(),
    scopes: new Set(credential.scopes),
    credentialId: credential.id,
    credentialFingerprint: credential.fingerprint,
    correlationId: crypto.randomUUID(),
    authorizationId: credential.id,
  };
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

/** The context the form hands the handler for a signed-in person. */
function personContext(input: {
  userId: string;
  sessionId: string;
  organizationId: string;
}): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: input.userId },
    organizationId: input.organizationId,
    scopes: new Set(["slack:manage"]),
    credentialId: input.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

function key() {
  return `slack-test-${crypto.randomUUID()}`;
}

function post(input: Record<string, unknown>, idempotencyKey = key()) {
  return api.command("send_slack_connection_test", {
    input: { channelId: "C0TESTING", ...input },
    idempotencyKey,
    expectedVersion: 0,
  });
}

/** The handler, as the form calls it. */
function queue(
  context: AuthorizedCommandContext,
  input: {
    installationId: string;
    channelId?: string;
    idempotencyKey?: string;
    expectedVersion?: number;
  },
) {
  return queueSlackConnectionTest(
    context,
    {
      organizationId: context.organizationId,
      installationId: input.installationId,
      channelId: input.channelId ?? "C0TESTING",
    },
    {
      idempotencyKey: input.idempotencyKey ?? key(),
      expectedVersion: input.expectedVersion ?? 0,
    },
  );
}

async function operations(tx: Tx, installationId: string) {
  return rows<{
    id: string;
    operation_key: string;
    operation_type: string;
    status: string;
  }>(
    tx,
    `
    select "id", "operation_key", "operation_type", "status"
    from "slack_delivery_operations"
    where "installation_id" = ${literal(installationId)}
    order by "created_at", "id"
  `,
  );
}

async function auditRows(tx: Tx, organizationId: string) {
  return rows<{ actor_type: string; actor_id: string; action: string }>(
    tx,
    `
    select "actor_type", "actor_id", "action"
    from "security_audit_records"
    where "organization_id" = ${literal(organizationId)}
      and "action" like 'slack.%'
  `,
  );
}

async function receiptCount(tx: Tx, userId: string) {
  const [row] = await rows<{ count: string | number }>(
    tx,
    `
    select count(*) as "count" from "command_receipts"
    where "actor_fingerprint" = ${literal(
      actorFingerprint({ type: "user", id: userId }),
    )}
  `,
  );
  return Number(row?.count);
}

function operationKey(
  actor: Parameters<typeof actorFingerprint>[0],
  idempotencyKey: string,
) {
  return `connection-test:${keyedFingerprint(
    live.serverEnv.BETTER_AUTH_SECRET,
    `${actorFingerprint(actor)}:${idempotencyKey}`,
  )}`;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the connection test was not refused");
}

beforeEach(() => {
  resetApiV1Fakes();
  live.triggered = [];
  live.triggerFails = false;
  live.serverEnv.REQUESTPORT_OPERATOR_CREDENTIALS = "enabled";
});

afterAll(async () => {
  await suiteStorage().close();
});

describe("POST /api/v1/commands/send_slack_connection_test, on PostgreSQL", () => {
  test("an organisation-wide operator queues one pending operation, recorded as the operator it is, and starts it", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, owner, installationId } =
        await seedOwnedInstallation(tx);
      const credential = await issueOperator(tx, {
        organizationId,
        userId: owner.userId,
      });
      const context = signInAsOperator(credential);
      const idempotencyKey = key();

      const response = await post({ installationId }, idempotencyKey);

      expect(response.status).toBe(200);
      const { result } = (await response.json()) as {
        result: { operationId: string; dispatched: boolean };
      };
      expect(result).toEqual({
        operationId: expect.any(String),
        dispatched: true,
      });
      expect(await operations(tx, installationId)).toEqual([
        {
          id: result.operationId,
          operation_key: operationKey(context.actor, idempotencyKey),
          operation_type: "connection_test",
          status: "pending",
        },
      ]);
      expect(await auditRows(tx, organizationId)).toEqual([
        {
          actor_type: "service",
          actor_id: `operator:${credential.lineageId}`,
          action: "slack.connection_test_queued",
        },
      ]);
      expect(live.triggered).toEqual([result.operationId]);
    });
  });

  test("its replay answers the same operation, and its member's retry under the same key is an operation of its own", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, owner, installationId } =
        await seedOwnedInstallation(tx);
      signInAsOperator(
        await issueOperator(tx, { organizationId, userId: owner.userId }),
      );
      const idempotencyKey = key();
      const first = (await (
        await post({ installationId }, idempotencyKey)
      ).json()) as { result: { operationId: string } };
      const again = (await (
        await post({ installationId }, idempotencyKey)
      ).json()) as { result: { operationId: string } };
      expect(again.result.operationId).toBe(first.result.operationId);

      const member = await queue(personContext({ ...owner, organizationId }), {
        installationId,
        idempotencyKey,
      });

      expect(member.operationId).not.toBe(first.result.operationId);
      expect(
        (await operations(tx, installationId)).map((row) => row.id).sort(),
      ).toEqual([first.result.operationId, member.operationId].sort());
      expect(
        (await auditRows(tx, organizationId)).map((row) => row.actor_type),
      ).toEqual(["service", "user"]);
    });
  });

  test("an agent credential is refused 403 before anything runs, even holding slack:manage", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, installationId } =
        await seedOwnedInstallation(tx);
      signInAs(
        agentContext({
          organizationId,
          projectId: null,
          scopes: ["slack:manage", "org:read"],
        }),
      );

      const response = await post({ installationId });

      expect(response.status).toBe(403);
      expect(await operations(tx, installationId)).toEqual([]);
      expect(await auditRows(tx, organizationId)).toEqual([]);
      expect(live.triggered).toEqual([]);
    });
  });

  test("an operator bound to a project, even an owner's, is refused 403 and queues nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, owner, installationId } =
        await seedOwnedInstallation(tx);
      const projectId = await seedProject(tx, organizationId);
      signInAsOperator(
        await issueOperator(tx, {
          organizationId,
          userId: owner.userId,
          projectId,
        }),
      );

      const response = await post({ installationId });

      expect(response.status).toBe(403);
      expect(await operations(tx, installationId)).toEqual([]);
      expect(await auditRows(tx, organizationId)).toEqual([]);
      expect(live.triggered).toEqual([]);
    });
  });

  test("an operator reaches no other organisation's installation, even one its member owns, having queued in its own", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedOwnedInstallation(tx);
      const other = await seedOrganization(tx);
      await seedMembership(tx, other, home.owner.userId, "owner");
      const foreign = await seedInstallation(tx, other);
      signInAsOperator(
        await issueOperator(tx, {
          organizationId: home.organizationId,
          userId: home.owner.userId,
        }),
      );
      expect((await post({ installationId: home.installationId })).status).toBe(
        200,
      );

      // Named by its installation alone, and with its organisation too: the
      // route writes the credential's organisation over the one named.
      for (const input of [
        { installationId: foreign },
        { installationId: foreign, organizationId: other },
      ]) {
        const response = await post(input);
        expect(response.status).toBe(404);
      }

      expect(await operations(tx, foreign)).toEqual([]);
      expect(await auditRows(tx, other)).toEqual([]);
      expect(await operations(tx, home.installationId)).toHaveLength(1);
    });
  });

  test("another organisation's operator is refused this organisation's installation, having queued in its own", async () => {
    await inRollbackTransaction(async (tx) => {
      const target = await seedOwnedInstallation(tx);
      const stranger = await seedOwnedInstallation(tx);
      signInAsOperator(
        await issueOperator(tx, {
          organizationId: stranger.organizationId,
          userId: stranger.owner.userId,
        }),
      );
      expect(
        (await post({ installationId: stranger.installationId })).status,
      ).toBe(200);

      const response = await post({
        installationId: target.installationId,
        organizationId: target.organizationId,
      });

      expect(response.status).toBe(404);
      expect(await operations(tx, target.installationId)).toEqual([]);
      expect(await auditRows(tx, target.organizationId)).toEqual([]);
      expect(await auditRows(tx, stranger.organizationId)).toHaveLength(1);
    });
  });

  test("the credential is re-checked in the handler's transaction: revoked, it is refused 403 having queued before", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, owner, installationId } =
        await seedOwnedInstallation(tx);
      const credential = await issueOperator(tx, {
        organizationId,
        userId: owner.userId,
      });
      signInAsOperator(credential);
      expect((await post({ installationId })).status).toBe(200);
      await tx.execute(`
        update "operator_credentials" set "revoked_at" = now()
        where "id" = ${literal(credential.id)}
      `);

      const response = await post({ installationId });

      expect(response.status).toBe(403);
      expect(await operations(tx, installationId)).toHaveLength(1);
      expect(live.triggered).toHaveLength(1);
    });
  });

  test("with the deployment's operator switch off, the handler's re-check refuses the operator 403", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, owner, installationId } =
        await seedOwnedInstallation(tx);
      signInAsOperator(
        await issueOperator(tx, { organizationId, userId: owner.userId }),
      );
      live.serverEnv.REQUESTPORT_OPERATOR_CREDENTIALS = undefined;

      const response = await post({ installationId });

      expect(response.status).toBe(403);
      expect(await operations(tx, installationId)).toEqual([]);
    });
  });
});

/*
  The form's path: the handler as the form calls it, for a signed-in person.
  These held the repository's rules through a copy of the handler's
  composition in `packages/db` until the connection test had its REST entry;
  they now run the handler itself.
*/
describe("the connection test's handler for a person, on PostgreSQL", () => {
  test.each([
    ["an organisation owner", "owner"],
    ["an organisation admin", "admin"],
  ] as const)(
    "%s queues one pending operation, audited as the user, and starts it",
    async (_, role) => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const person = await seedUser(tx);
        await seedMembership(tx, organizationId, person.userId, role);
        const installationId = await seedInstallation(tx, organizationId);

        const queued = await queue(
          personContext({ ...person, organizationId }),
          {
            installationId,
          },
        );

        expect(queued).toEqual({
          operationId: expect.any(String),
          dispatched: true,
        });
        expect(await operations(tx, installationId)).toEqual([
          {
            id: queued.operationId,
            operation_key: expect.stringMatching(/^connection-test:/u),
            operation_type: "connection_test",
            status: "pending",
          },
        ]);
        expect(await auditRows(tx, organizationId)).toEqual([
          {
            actor_type: "user",
            actor_id: person.userId,
            action: "slack.connection_test_queued",
          },
        ]);
        // Its idempotency is the operation's key; it leaves no receipt.
        expect(await receiptCount(tx, person.userId)).toBe(0);
        expect(live.triggered).toEqual([queued.operationId]);
      });
    },
  );

  test("a failed start leaves the operation pending and answers it undispatched", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, owner, installationId } =
        await seedOwnedInstallation(tx);
      live.triggerFails = true;

      const queued = await queue(personContext({ ...owner, organizationId }), {
        installationId,
      });

      expect(queued.dispatched).toBe(false);
      expect(await operations(tx, installationId)).toMatchObject([
        { id: queued.operationId, status: "pending" },
      ]);
    });
  });

  test("a member, a maintainer, a revoked owner, an ended session and a suspended organisation queue nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const installationId = await seedInstallation(tx, organizationId);
      const member = await seedUser(tx);
      await seedMembership(tx, organizationId, member.userId, "member");
      const maintainer = await seedUser(tx);
      await seedMembership(tx, organizationId, maintainer.userId, "member");
      const projectId = await seedProject(tx, organizationId);
      await tx.execute(`
        insert into "project_members"
          ("organization_id", "project_id", "user_id", "role", "status")
        values (${literal(organizationId)}, ${literal(projectId)},
          ${literal(maintainer.userId)}, 'maintainer', 'active')
      `);
      const revoked = await seedUser(tx);
      await seedMembership(
        tx,
        organizationId,
        revoked.userId,
        "owner",
        "revoked",
      );
      const ended = await seedUser(tx);
      await seedMembership(tx, organizationId, ended.userId, "owner");
      await tx.execute(`
        update "session" set "expires_at" = now() - interval '1 minute'
        where "id" = ${literal(ended.sessionId)}
      `);
      for (const person of [member, maintainer, revoked, ended]) {
        const error = await refusal(
          queue(personContext({ ...person, organizationId }), {
            installationId,
          }),
        );
        expect((error as DomainError).code).toBe("forbidden");
      }
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      await tx.execute(`
        update "organizations" set "status" = 'suspended'
        where "id" = ${literal(organizationId)}
      `);
      const suspended = await refusal(
        queue(personContext({ ...owner, organizationId }), { installationId }),
      );
      expect((suspended as DomainError).code).toBe("forbidden");
      expect(await operations(tx, installationId)).toEqual([]);
      expect(await auditRows(tx, organizationId)).toEqual([]);
      expect(live.triggered).toEqual([]);
    });
  });

  test("another organisation's installation, and a disabled one, are not found", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedOrganization(tx);
      const other = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, home, owner.userId, "owner");
      await seedMembership(tx, other, owner.userId, "owner");
      const foreign = await seedInstallation(tx, other);
      const own = await seedInstallation(tx, home);
      await tx.execute(`
        update "slack_installations" set "status" = 'disabled'
        where "id" = ${literal(own)}
      `);
      const context = personContext({ ...owner, organizationId: home });
      for (const installationId of [foreign, own]) {
        const error = await refusal(queue(context, { installationId }));
        expect((error as DomainError).code).toBe("not_found");
        expect(await operations(tx, installationId)).toEqual([]);
      }
    });
  });

  test("a replay finds the same operation; other input under the key, or a version other than zero, is refused", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, owner, installationId } =
        await seedOwnedInstallation(tx);
      const context = personContext({ ...owner, organizationId });
      const idempotencyKey = key();
      const first = await queue(context, { installationId, idempotencyKey });
      const again = await queue(
        { ...context, correlationId: crypto.randomUUID() },
        { installationId, idempotencyKey },
      );
      expect(again.operationId).toBe(first.operationId);
      const conflicting = await refusal(
        queue(context, {
          installationId,
          channelId: "C0ELSEWHR",
          idempotencyKey,
        }),
      );
      expect((conflicting as DomainError).code).toBe("idempotency_conflict");
      const versioned = await refusal(
        queue(context, { installationId, expectedVersion: 1 }),
      );
      expect((versioned as DomainError).code).toBe("version_conflict");
      expect(await operations(tx, installationId)).toHaveLength(1);
      expect(await auditRows(tx, organizationId)).toHaveLength(1);
    });
  });

  test("a replay by a member who has since lost the role is refused, not answered", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const admin = await seedUser(tx);
      await seedMembership(tx, organizationId, admin.userId, "admin");
      const installationId = await seedInstallation(tx, organizationId);
      const context = personContext({ ...admin, organizationId });
      const idempotencyKey = key();
      await queue(context, { installationId, idempotencyKey });
      await tx.execute(`
        update "organization_members" set "role" = 'member'
        where "organization_id" = ${literal(organizationId)}
          and "user_id" = ${literal(admin.userId)}
      `);
      const error = await refusal(
        queue(context, { installationId, idempotencyKey }),
      );
      expect((error as DomainError).code).toBe("forbidden");
    });
  });

  test("the operation is keyed as the form keyed it, so a retry across the deploy finds it", async () => {
    await inRollbackTransaction(async (tx) => {
      const { organizationId, owner, installationId } =
        await seedOwnedInstallation(tx);
      const idempotencyKey = key();
      const queued = await queue(personContext({ ...owner, organizationId }), {
        installationId,
        idempotencyKey,
      });
      expect(await operations(tx, installationId)).toMatchObject([
        {
          id: queued.operationId,
          operation_key: operationKey(
            { type: "user", id: owner.userId },
            idempotencyKey,
          ),
        },
      ]);
    });
  });
});
