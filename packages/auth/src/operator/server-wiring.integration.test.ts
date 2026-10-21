import type { Storage, Tx } from "@requestport/db";
import type { AuthorizedCommandContext } from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

/*
  Plan 13, F.3 (F3-14; Done when 1 and 4): the operator wiring as `server.ts`
  deploys it, not a copy of it. Every other test of the switch builds its own
  bearer and service (`operator-bearer.integration.test.ts` says "wired as
  `server.ts` wires it"), and the web tests mock `@requestport/auth/server`, so
  without this file the deployed switch could be removed and every suite would
  stay green.

  Two things are replaced, and nothing else:

  - `@requestport/config/server`'s `REQUESTPORT_OPERATOR_CREDENTIALS`, which
    each case sets before it imports `../server.js` afresh. `server.ts` reads
    the switch once per process, so each value needs its own module graph.
  - the database handle, by one that forwards every call to the case's
    transaction while one is open, and to the real pool otherwise: as the
    `db` of the application storage `server.ts` hands Better Auth
    (`applicationStorageFromEnv`, from `@requestport/db/wiring`;
    manifest-g.md §2.12). The cases build their operator repository over the
    same handle. So the key, the binding, the session and the tenant the
    cases write are rolled back, and what `server.ts` builds over that
    storage — its Better Auth composition, its repositories — reads them.

  The composition is the one `server.ts` builds from this process's
  environment. Since K.3 (#122) it lists `/change-password` in
  `disabledPaths` (rulings 31 and 48), so `enabled` is the positive case: the
  switch and the availability answer on, a bound key authenticates through
  `server.ts`'s own bearer, and the issuance service mints a key that does
  too. The mounted composition, which production no longer has, is
  `operator-bearer.integration.test.ts`'s.
*/

/*
 * The rows here are seeded through the application root's storage, in the
 * case's transaction, and the application role may not write them (it holds
 * no INSERT on `signup_allowlist`), so in this file the application
 * root dials DATABASE_URL: the application variable is set to it before
 * anything is imported, whatever the run's environment names (a track's
 * `.env.local` names its application login; Plan 13, I.2 step 5, slice 1).
 */
vi.hoisted(() => {
  if (typeof process.env.DATABASE_URL === "string") {
    process.env.REQUESTPORT_APPLICATION_DATABASE_URL = process.env.DATABASE_URL;
  }
});

type Variable = "enabled" | "disabled" | undefined;

const state = vi.hoisted(() => ({
  variable: undefined as "enabled" | "disabled" | undefined,
  tx: undefined as object | undefined,
  storages: [] as Storage[],
}));

vi.mock("@requestport/config/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@requestport/config/server")>();
  return {
    ...actual,
    serverEnv: {
      ...actual.serverEnv,
      get REQUESTPORT_OPERATOR_CREDENTIALS() {
        return state.variable;
      },
    },
  };
});

vi.mock("@requestport/db/wiring", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@requestport/db/wiring")>();
  const storage = actual.applicationStorageFromEnv();
  state.storages.push(storage);
  const db = new Proxy(storage.db, {
    get(target, property) {
      const handle = (state.tx ?? target) as object;
      const value = Reflect.get(handle, property);
      return typeof value === "function" ? value.bind(handle) : value;
    },
  });
  return {
    ...actual,
    applicationStorageFromEnv: () => ({ ...storage, db }),
  };
});

const password = "operator-server-wiring-local-0001";

class TestRollback extends Error {}

/**
 * The real handle of the application storage of the module graph
 * `../server.js` was last imported with: since G.5 the process's one, which
 * the wiring builds on the first ask and returns to every module graph after
 * (`@requestport/db/wiring`), so each case's graph reads the same storage.
 */
function realDatabase() {
  const storage = state.storages.at(-1);
  if (!storage) throw new Error("@requestport/db/wiring has not been imported");
  return storage.db;
}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  try {
    await realDatabase().transaction(async (tx) => {
      state.tx = tx;
      try {
        await run(tx);
      } finally {
        state.tx = undefined;
      }
      throw new TestRollback();
    });
  } catch (error) {
    if (error instanceof TestRollback) return;
    throw error;
  }
  throw new Error("Expected the wiring transaction to roll back");
}

/**
 * `../server.js`, imported afresh with the switch set to `variable`, with
 * that module graph's `@requestport/db`, and the handle its application
 * storage answers.
 */
async function importServer(variable: Variable) {
  state.variable = variable;
  vi.resetModules();
  const server = await import("../server.js");
  const db = await import("@requestport/db");
  const { applicationStorageFromEnv } = await import("@requestport/db/wiring");
  return { server, db, database: applicationStorageFromEnv().db };
}

afterAll(async () => {
  for (const storage of new Set(state.storages)) await storage.close();
});

beforeEach(() => {
  state.tx = undefined;
});

async function seedMember(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  const { hashLocalCredential } = await import("@requestport/domain");
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "email_verified", "updated_at")
    values (${userId}, 'Operator wiring member', ${email}, true, now())
  `);
  await tx.execute(sql`
    insert into "account"
      ("id", "account_id", "provider_id", "user_id", "password", "updated_at")
    values (${`account_${crypto.randomUUID()}`}, ${userId}, 'credential',
      ${userId}, ${await hashLocalCredential(password)}, now())
  `);
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Operator wiring tenant',
      ${`operator-wiring-${organizationId}`}, 'active')
  `);
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, 'owner', 'active')
  `);
  return { userId, organizationId };
}

/** A signed-in person's context, on a live session row. */
async function personContext(
  tx: Tx,
  member: { userId: string; organizationId: string },
): Promise<AuthorizedCommandContext> {
  const sessionId = `session_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "session" ("id", "token", "user_id", "expires_at", "updated_at")
    values (${sessionId}, ${`token_${crypto.randomUUID()}`}, ${member.userId},
      now() + interval '1 hour', now())
  `);
  return {
    actor: { type: "user", id: member.userId },
    organizationId: member.organizationId,
    scopes: new Set(["operator:manage"]),
    credentialId: sessionId,
    correlationId: crypto.randomUUID(),
  };
}

/** The member's plugin keys and command receipts: what an issuance leaves. */
async function issuanceTrace(tx: Tx, userId: string) {
  const rows = await tx.execute<{ keys: number; receipts: number }>(sql`
    select
      (select count(*)::int from "apikey" where "reference_id" = ${userId})
        as "keys",
      (select count(*)::int from "command_receipts"
        where "actor_fingerprint" = ${`user:${userId}`}) as "receipts"
  `);
  return rows.rows[0];
}

function bearer(key: string) {
  return new Request("http://localhost:3000/api/v1/whoami", {
    headers: { authorization: `Bearer ${key}` },
  });
}

/**
 * The expectations every value of the switch shares while `server.ts` answers
 * off: the switch and the availability give `reason`; a live `rpo_` key,
 * bound in the table, is refused by `server.ts`'s own bearer, although the
 * same key, verified by `server.ts`'s own Better Auth and resolved through its
 * own binding, authenticates once availability is forced on; and the issuance
 * service refuses before it reserves or mints anything.
 */
async function expectOff(
  { server, db, database }: Awaited<ReturnType<typeof importServer>>,
  reason: string,
) {
  await expect(server.operatorCredentialsSwitch()).resolves.toEqual({
    enabled: false,
    reason,
  });
  await expect(server.operatorCredentialAvailability()).resolves.toEqual({
    available: false,
    reason,
  });

  await inRollbackTransaction(async (tx) => {
    const member = await seedMember(tx);
    const created = (await server.auth.api.createApiKey({
      body: {
        configId: "requestport-operator",
        name: "CI deploy",
        userId: member.userId,
        expiresIn: 30 * 24 * 60 * 60,
      },
    })) as { id: string; key: string };
    expect(created.key.startsWith("rpo_")).toBe(true);
    const operators = db.createOperatorCredentialRepository(database);
    await operators.createCredential({
      organizationId: member.organizationId,
      memberUserId: member.userId,
      projectId: null,
      betterAuthApiKeyId: created.id,
      name: "CI deploy",
      prefix: created.key.slice(0, 8),
      fingerprint: `fingerprint_${crypto.randomUUID()}`,
      scopes: ["operator:revoke"],
      expiresInDays: 30,
      correlationId: crypto.randomUUID(),
    });

    // The control: the key is live and bound in this deployment. Only the
    // availability answer differs from `server.ts`'s bearer.
    const { createAuthenticateApiBearer } = await import(
      "../agent/authenticate-bearer.js"
    );
    const forcedOn = createAuthenticateApiBearer({
      authenticateAgentBearer: server.authenticateAgentBearer,
      operatorCredentialsAvailable: async () => true,
      verifyOperatorKey: async (key) => {
        const result = await server.auth.api.verifyApiKey({
          body: { key, configId: "requestport-operator" },
        });
        return { valid: result.valid, key: result.key };
      },
      resolveOperatorKey: (input) => operators.resolveApiKeyCredential(input),
    });
    await expect(forcedOn(bearer(created.key))).resolves.toMatchObject({
      credentialKind: "operator",
      actor: {
        type: "service",
        originatingActor: { type: "user", id: member.userId },
      },
    });

    await expect(
      server.authenticateApiBearer(bearer(created.key)),
    ).rejects.toMatchObject({ code: "unauthenticated" });

    const context = await personContext(tx, member);
    const before = await issuanceTrace(tx, member.userId);
    await expect(
      server.operatorCredentialService.issue(
        context,
        {
          organizationId: member.organizationId,
          projectId: null,
          name: "Second key",
          scopes: ["operator:revoke"],
        },
        {
          idempotencyKey: `operator-issue-${crypto.randomUUID()}`,
          expectedVersion: 0,
        },
      ),
    ).rejects.toMatchObject({
      code: "configuration_error",
      details: { reason },
    });
    await expect(issuanceTrace(tx, member.userId)).resolves.toEqual(before);
  });
}

/**
 * What `server.ts` does once its answer is on: the switch and the
 * availability say so; `/change-password` answers 404 through `server.ts`'s
 * own router; a live `rpo_` key bound in the table authenticates through
 * `server.ts`'s own bearer, and a key no binding holds does not; and the
 * issuance service mints a key that authenticates the same way.
 */
async function expectOn({
  server,
  db,
  database,
}: Awaited<ReturnType<typeof importServer>>) {
  await expect(server.operatorCredentialsSwitch()).resolves.toEqual({
    enabled: true,
  });
  await expect(server.operatorCredentialAvailability()).resolves.toEqual({
    available: true,
  });

  await inRollbackTransaction(async (tx) => {
    const probe = await server.auth.handler(
      new Request("http://localhost:3000/api/auth/change-password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          currentPassword: "x".repeat(12),
          newPassword: "y".repeat(12),
        }),
      }),
    );
    expect(probe.status).toBe(404);

    const member = await seedMember(tx);
    const unbound = (await server.auth.api.createApiKey({
      body: {
        configId: "requestport-operator",
        name: "No binding",
        userId: member.userId,
        expiresIn: 30 * 24 * 60 * 60,
      },
    })) as { id: string; key: string };
    // The control: on, a live plugin key still needs its binding.
    await expect(
      server.authenticateApiBearer(bearer(unbound.key)),
    ).rejects.toMatchObject({ code: "unauthenticated" });

    const created = (await server.auth.api.createApiKey({
      body: {
        configId: "requestport-operator",
        name: "CI deploy",
        userId: member.userId,
        expiresIn: 30 * 24 * 60 * 60,
      },
    })) as { id: string; key: string };
    const operators = db.createOperatorCredentialRepository(database);
    await operators.createCredential({
      organizationId: member.organizationId,
      memberUserId: member.userId,
      projectId: null,
      betterAuthApiKeyId: created.id,
      name: "CI deploy",
      prefix: created.key.slice(0, 8),
      fingerprint: `fingerprint_${crypto.randomUUID()}`,
      scopes: ["operator:revoke"],
      expiresInDays: 30,
      correlationId: crypto.randomUUID(),
    });
    await expect(
      server.authenticateApiBearer(bearer(created.key)),
    ).resolves.toMatchObject({
      credentialKind: "operator",
      organizationId: member.organizationId,
      actor: {
        type: "service",
        originatingActor: { type: "user", id: member.userId },
      },
    });

    const issued = await server.operatorCredentialService.issue(
      await personContext(tx, member),
      {
        organizationId: member.organizationId,
        projectId: null,
        name: "Second key",
        scopes: ["operator:revoke"],
      },
      {
        idempotencyKey: `operator-issue-${crypto.randomUUID()}`,
        expectedVersion: 0,
      },
    );
    await expect(
      server.authenticateApiBearer(bearer(issued.plaintextKey)),
    ).resolves.toMatchObject({
      credentialKind: "operator",
      organizationId: member.organizationId,
    });
  });
}

describe.sequential("server.ts's operator wiring answers off unless F3-14 is on", () => {
  test("REQUESTPORT_OPERATOR_CREDENTIALS unset: switched off", {
    timeout: 120_000,
  }, async () => {
    await expectOff(await importServer(undefined), "switched-off");
  });

  test("REQUESTPORT_OPERATOR_CREDENTIALS=disabled: switched off", {
    timeout: 120_000,
  }, async () => {
    await expectOff(await importServer("disabled"), "switched-off");
  });

  test("REQUESTPORT_OPERATOR_CREDENTIALS=enabled, with /change-password closed since K.3: on", {
    timeout: 120_000,
  }, async () => {
    const imported = await importServer("enabled");
    // The precondition this case rests on, read from the composition the
    // router serves: K.3's line closes the endpoint.
    const context = await imported.server.auth.$context;
    expect(context.options.disabledPaths ?? []).toContain("/change-password");
    await expectOn(imported);
  });
});
