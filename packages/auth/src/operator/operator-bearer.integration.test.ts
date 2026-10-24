import {
  createAgentAuthRepository,
  createCommandAuthorizationRepository,
  createCommandTransactionManager,
  createFoundationRepository,
  createOperatorCredentialRepository,
  createStorage,
  identitySchema,
  type Tx,
} from "@requestport/db";
import { endTenantBinding, queueQueriesOn } from "@requestport/db/testing";
import { storageOptionsFromEnv } from "@requestport/db/wiring";
import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  BOOTSTRAP_OWNER_ACTOR,
  bootstrapOwner,
  createCoreCommandRegistry,
  hashLocalCredential,
  operatorActor,
  revokeOperatorCredentialCommandName,
} from "@requestport/domain";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createAuthenticateAgentBearer,
  createAuthenticateApiBearer,
} from "../agent/authenticate-bearer.js";
import {
  agentApiKeyConfiguration,
  createAuthOptions,
  operatorApiKeyConfiguration,
} from "../server-options.js";
import { createOperatorCredentialService } from "./operator-credential-service.js";
import { operatorCredentialSwitch } from "./operator-switch.js";

/*
  Plan 13, F.3: the operator bearer path against Better Auth's own endpoints,
  in process, on native PostgreSQL (R1). Better Auth is composed from the same
  `createAuthOptions` production uses, on a Drizzle adapter over a
  transaction that every case rolls back, so the keys, sessions and bindings
  it writes never outlive the case. The bearer is wired as `create-auth.ts`
  wires it. Every refusal is paired with the same key authenticating first.

  What this proves that the unit tests cannot: that the plugin, not the prefix,
  refuses a key of the other configuration; that a key deleted, re-enabled or
  given a longer or no expiry through Better Auth's own endpoints — which a
  signed-in member may call on their own key — never widens what the binding
  allows; and, for F3-14's guard, that the router really does answer 404 for
  `/change-password` when, and only when, the guard says it is closed.
*/

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage(storageOptionsFromEnv(process.env));

const baseURL = "http://localhost:3000";
const secret = "operator-bearer-integration-signing-0001";
const password = "operator-bearer-local-credential-0001";
const closed = ["/change-password"];
const mounted: string[] = [];

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  try {
    await suiteStorage.db.transaction(async (tx) => {
      // Better Auth, composed over this transaction, issues some of its
      // queries in the background (the OAuth provider's seeding of resources
      // as an instance starts, the API key plugin's sweep of expired keys),
      // which land on the transaction's one client beside the case's own:
      // queued, it is handed them in turn (queueQueriesOn; X25's remainder).
      const restore = queueQueriesOn(tx);
      try {
        await run(tx);
      } finally {
        restore();
      }
      throw new TestRollback();
    });
  } catch (error) {
    if (error instanceof TestRollback) return;
    throw error;
  }
  throw new Error("Expected the operator transaction to roll back");
}

afterAll(async () => {
  await suiteStorage.close();
});

/*
  Every case builds its instance over a transaction it rolls back, and Better
  Auth 1.7.6 seeds the OAuth provider's `resources` into `oauth_resource` as
  the instance initialises: a lookup, then an insert when it finds nothing
  (`@better-auth/oauth-provider@1.7.6` `introspect-CbYi2MJT.mjs:805-870`).
  Inside the case's transaction, a row another suite commits between the two
  fails the insert on `oauth_resource_identifier_unique` and aborts the
  transaction (seen on the first run after the rebase onto K.3). Committed
  here first, the rows are already there and the seed inserts nothing. They
  are the rows the seed itself writes for a resource given as a string — its
  identifier as its name, every policy column at its default — so leaving
  them committed changes nothing; `on conflict do nothing` keeps this safe
  against another suite seeding at the same moment. The same step as
  `better-auth-legacy-rows.integration.test.ts`'s.
*/
beforeAll(async () => {
  const options = createAuthOptions({
    database: {} as never,
    env: {
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: baseURL,
      REQUESTPORT_LOCAL_CREDENTIAL: "enabled",
      VERCEL_ENV: undefined,
    },
    assertSignupAllowed: async () => ({}),
  });
  const provider = options.plugins.find(
    (plugin) => plugin.id === "oauth-provider",
  ) as { options?: { resources?: readonly unknown[] } } | undefined;
  const identifiers = (provider?.options?.resources ?? []).map((entry) => {
    if (typeof entry !== "string") {
      throw new Error("Only a resource given as a string is mirrored here");
    }
    return entry;
  });
  if (identifiers.length === 0) {
    throw new Error("The composition seeds no OAuth resources");
  }
  for (const identifier of identifiers) {
    await suiteStorage.db.execute(sql`
      insert into "oauth_resource"
        ("id", "identifier", "name", "created_at", "updated_at")
      values (${crypto.randomUUID()}, ${identifier}, ${identifier}, now(), now())
      on conflict ("identifier") do nothing
    `);
  }
});

/**
 * The production composition, with the local credential on so a member can
 * sign in and call the api-key endpoints as themselves. Given `disabledPaths`,
 * they replace the composition's own — K.3's `["/change-password"]` (rulings
 * 31 and 48) — so a case can build the mounted composition production no
 * longer has; omitted, the composition's own list stands.
 */
function compose(tx: Tx, disabledPaths?: string[]) {
  const options = createAuthOptions({
    database: drizzleAdapter(tx as never, {
      provider: "pg",
      schema: identitySchema,
    }),
    env: {
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: baseURL,
      REQUESTPORT_LOCAL_CREDENTIAL: "enabled",
      VERCEL_ENV: undefined,
    },
    assertSignupAllowed: async () => ({}),
  });
  return betterAuth(
    disabledPaths === undefined ? options : { ...options, disabledPaths },
  );
}

type Auth = ReturnType<typeof compose>;

/**
 * `authenticateApiBearer`, wired as `create-auth.ts` wires it, on this transaction.
 * The switch defaults to `enabled`; pass `{}` for a deployment that leaves it
 * unset.
 */
function apiBearer(
  auth: Auth,
  tx: Tx,
  { variable }: { variable?: "enabled" | "disabled" } = { variable: "enabled" },
) {
  const operators = createOperatorCredentialRepository(tx);
  const agents = createAgentAuthRepository(tx);
  const authenticateAgentBearer = createAuthenticateAgentBearer({
    verifyApiKey: async (key) => {
      const result = await auth.api.verifyApiKey({
        body: { key, configId: "requestport-agent" },
      });
      return { valid: result.valid, key: result.key };
    },
    verifyJwt: async () => null,
    resolveApiKey: (input) => agents.resolveApiKeyCredential(input),
    resolveOAuth: async () => null,
  });
  return createAuthenticateApiBearer({
    authenticateAgentBearer,
    operatorCredentialsAvailable: async () =>
      (
        await operators.availability(
          operatorCredentialSwitch({
            variable,
            authContext: await auth.$context,
          }),
        )
      ).available,
    verifyOperatorKey: async (key) => {
      const result = await auth.api.verifyApiKey({
        body: { key, configId: "requestport-operator" },
      });
      return { valid: result.valid, key: result.key };
    },
    resolveOperatorKey: (input) => operators.resolveApiKeyCredential(input),
    // The touch binds the organisation the key resolved to (D15). In
    // production it runs on the pool, so the binding ends with it; here it
    // runs on the case's transaction, and one case authenticates keys of
    // several organisations, so the binding is ended after each.
    touchOperatorCredential: async (credentialId, organizationId) => {
      try {
        await operators.touchCredential(credentialId, organizationId);
      } finally {
        await endTenantBinding(tx);
      }
    },
  });
}

/**
 * The issuance service, wired as `create-auth.ts` wires it, on this transaction:
 * the same availability as the bearer, and keys created through this
 * instance's own `createApiKey`.
 */
function issuanceService(
  auth: Auth,
  tx: Tx,
  { variable }: { variable?: "enabled" | "disabled" } = { variable: "enabled" },
) {
  const operators = createOperatorCredentialRepository(tx);
  return createOperatorCredentialService({
    availability: async () =>
      operators.availability(
        operatorCredentialSwitch({
          variable,
          authContext: await auth.$context,
        }),
      ),
    createApiKey: async ({ name, userId, expiresIn }) =>
      (await auth.api.createApiKey({
        body: { configId: "requestport-operator", name, userId, expiresIn },
      })) as {
        id: string;
        key: string;
        prefix: string | null;
        start: string | null;
        expiresAt: Date | null;
      },
    repository: operators,
    fingerprintSecret: secret,
  });
}

/** A signed-in person's command context, on a live session row. */
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

/** What an issuance would have left behind: the member's keys and receipts. */
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

/**
 * The tenant bus, as the web's RequestPort composes it
 * (`createCoreCommandBus`, `@requestport/core`), with the switch on.
 */
function commandBus(tx: Tx) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions: createCommandTransactionManager(
      tx as never,
      (name, database) => {
        if (name === "commandAuthorization") {
          return createCommandAuthorizationRepository(database, {
            operatorCredentials: "enabled",
          });
        }
        if (name === "operatorCredentials") {
          return createOperatorCredentialRepository(database);
        }
        return undefined;
      },
    ),
    fingerprintSecret: secret,
    authorizeContext: (context, uow) =>
      uow
        .port<ReturnType<typeof createCommandAuthorizationRepository>>(
          "commandAuthorization",
        )
        .assertCurrent(context),
  });
}

/** A credential revoking itself through the real bus and `assertCurrent`. */
function revokeItself(
  tx: Tx,
  binding: {
    id: string;
    lineageId: string;
    organizationId: string;
    memberUserId: string;
  },
) {
  return commandBus(tx).execute({
    name: revokeOperatorCredentialCommandName,
    input: { organizationId: binding.organizationId, credentialId: binding.id },
    context: {
      actor: operatorActor({
        lineageId: binding.lineageId,
        memberUserId: binding.memberUserId,
      }),
      credentialKind: "operator",
      organizationId: binding.organizationId,
      projectId: null,
      laneIds: new Set(),
      scopes: new Set(["operator:revoke"]),
      credentialId: binding.id,
      correlationId: crypto.randomUUID(),
    },
    meta: {
      idempotencyKey: `idempotency-${crypto.randomUUID()}`,
      expectedVersion: 1,
    },
  });
}

/** Runs `run` and undoes whatever it wrote, keeping only its answer. */
async function probe<T>(tx: Tx, run: () => Promise<T>) {
  await tx.execute(sql`savepoint operator_bearer_probe`);
  try {
    return await run();
  } finally {
    await tx.execute(sql`rollback to savepoint operator_bearer_probe`);
  }
}

function bearer(key: string) {
  return new Request(`${baseURL}/api/v1/whoami`, {
    headers: { authorization: `Bearer ${key}` },
  });
}

async function seedMember(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "email_verified", "updated_at")
    values (${userId}, 'Operator member', ${email}, true, now())
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
    values (${organizationId}, 'Operator bearer tenant',
      ${`operator-bearer-${organizationId}`}, 'active')
  `);
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, 'owner', 'active')
  `);
  return { userId, email, organizationId };
}

/** Signs the member in over HTTP, and answers the session's cookie header. */
async function signIn(auth: Auth, email: string) {
  const response = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

/** A call to one of Better Auth's api-key endpoints, as the member. */
function asMember(auth: Auth, cookie: string, path: string, body: unknown) {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseURL,
        cookie,
      },
      body: JSON.stringify(body),
    }),
  );
}

/** A key minted server-side under `configId`, and bound as an operator's. */
async function issueBound(
  auth: Auth,
  tx: Tx,
  member: { userId: string; organizationId: string },
  options: { configId?: string; prefix?: string } = {},
) {
  const created = (await auth.api.createApiKey({
    body: {
      configId: options.configId ?? "requestport-operator",
      name: "CI deploy",
      userId: member.userId,
      expiresIn: 30 * 24 * 60 * 60,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    },
  })) as { id: string; key: string };
  const binding = await createOperatorCredentialRepository(tx).createCredential(
    {
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
    },
  );
  return { key: created.key, apiKeyId: created.id, binding };
}

async function expectAuthenticates(auth: Auth, tx: Tx, key: string) {
  await expect(apiBearer(auth, tx)(bearer(key))).resolves.toMatchObject({
    credentialKind: "operator",
  });
}

async function expectRefused(
  authenticate: (request: Request) => Promise<unknown>,
  key: string,
) {
  await expect(authenticate(bearer(key))).rejects.toMatchObject({
    code: "unauthenticated",
  });
}

describe.sequential("the operator bearer, through Better Auth's own endpoints", () => {
  test("a live, bound key authenticates as its operator, and the switch turns it off", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const { key, binding } = await issueBound(auth, tx, member);

      await expect(apiBearer(auth, tx)(bearer(key))).resolves.toMatchObject({
        actor: {
          type: "service",
          id: `operator:${binding.lineageId}`,
          originatingActor: { type: "user", id: member.userId },
        },
        credentialKind: "operator",
        organizationId: member.organizationId,
        projectId: null,
        credentialId: binding.id,
      });
      expect(key.startsWith("rpo_")).toBe(true);
      await expectRefused(apiBearer(auth, tx, {}), key);
      await expectRefused(apiBearer(auth, tx, { variable: "disabled" }), key);
    });
  });

  test("a key deleted through the delete endpoint, as the member, leaves its binding and authenticates nothing", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const { key, apiKeyId, binding } = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, key);
      await expect(
        probe(tx, () => revokeItself(tx, binding)),
      ).resolves.toMatchObject({ revoked: true });

      const cookie = await signIn(auth, member.email);
      const deleted = await asMember(auth, cookie, "/api-key/delete", {
        keyId: apiKeyId,
        configId: "requestport-operator",
      });
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      const row = await tx.execute(sql`
        select "better_auth_api_key_id" from "operator_credentials"
        where "id" = ${binding.id}
      `);
      expect(row.rows).toEqual([{ better_auth_api_key_id: null }]);
      await expectRefused(apiBearer(auth, tx), key);
      // At command time too: a context authenticated before the deletion.
      await expect(revokeItself(tx, binding)).rejects.toMatchObject({
        code: "forbidden",
      });
    });
  });

  // Three issuances and six endpoint calls: twice the budget of the others,
  // after one run timed out at 120s with the 1-minute load average near 50.
  test("the update endpoint cannot widen a binding: re-enabled, extended, or with no expiry", {
    timeout: 240_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const cookie = await signIn(auth, member.email);
      const update = (keyId: string, body: Record<string, unknown>) =>
        asMember(auth, cookie, "/api-key/update", {
          keyId,
          configId: "requestport-operator",
          ...body,
        });

      // A revoked binding whose plugin key is re-enabled and given a longer life.
      const revoked = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, revoked.key);
      await createOperatorCredentialRepository(tx).revokeCredential({
        organizationId: member.organizationId,
        credentialId: revoked.binding.id,
        expectedVersion: 1,
        actor: { actorType: "user", actorId: member.userId },
        reason: "Revoked for the test",
        correlationId: crypto.randomUUID(),
      });
      const reenabled = await update(revoked.apiKeyId, {
        enabled: true,
        expiresIn: 60 * 24 * 60 * 60,
      });
      expect(reenabled.status, await reenabled.clone().text()).toBe(200);
      await expectRefused(apiBearer(auth, tx), revoked.key);

      // An expired binding whose plugin key is extended.
      const expired = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, expired.key);
      await tx.execute(sql`
        update "operator_credentials"
        set "created_at" = now() - interval '2 days',
            "expires_at" = now() - interval '1 second'
        where "id" = ${expired.binding.id}
      `);
      const extended = await update(expired.apiKeyId, {
        expiresIn: 60 * 24 * 60 * 60,
      });
      expect(extended.status, await extended.clone().text()).toBe(200);
      await expectRefused(apiBearer(auth, tx), expired.key);

      // A live binding whose plugin expiry is cleared.
      const cleared = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, cleared.key);
      const noExpiry = await update(cleared.apiKeyId, { expiresIn: null });
      expect(noExpiry.status, await noExpiry.clone().text()).toBe(200);
      const plugin = await tx.execute(sql`
        select "expires_at" from "apikey" where "id" = ${cleared.apiKeyId}
      `);
      expect(plugin.rows).toEqual([{ expires_at: null }]);
      await expectRefused(apiBearer(auth, tx), cleared.key);
    });
  });

  test("a key a member creates at the create endpoint, with no binding, authenticates nothing", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const bound = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, bound.key);

      const cookie = await signIn(auth, member.email);
      const created = await asMember(auth, cookie, "/api-key/create", {
        configId: "requestport-operator",
        name: "Made by hand",
      });
      expect(created.status, await created.clone().text()).toBe(200);
      const { key } = (await created.json()) as { key: string };
      expect(key.startsWith("rpo_")).toBe(true);
      await expectRefused(apiBearer(auth, tx), key);
    });
  });

  test("the prefix is never trusted: keys of one configuration with the other's prefix are refused", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const genuine = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, genuine.key);

      // Operator configuration, agent prefix, bound as an operator's: it is
      // routed to the agent branch, whose configuration refuses it.
      const operatorAsAgent = await issueBound(auth, tx, member, {
        prefix: "rp_",
      });
      expect(operatorAsAgent.key.startsWith("rp_")).toBe(true);
      await expectRefused(apiBearer(auth, tx), operatorAsAgent.key);

      // Agent configuration, operator prefix, bound as an operator's: it is
      // routed to the operator branch, whose configuration refuses it.
      const agentAsOperator = await issueBound(auth, tx, member, {
        configId: "requestport-agent",
        prefix: "rpo_",
      });
      expect(agentAsOperator.key.startsWith("rpo_")).toBe(true);
      await expectRefused(apiBearer(auth, tx), agentAsOperator.key);
    });
  });

  test("an operator key in x-api-key is no session at an endpoint that needs one", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const { key } = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, key);

      // The positive control: the member's own session is accepted there.
      const cookie = await signIn(auth, member.email);
      const withSession = await asMember(auth, cookie, "/api-key/create", {
        configId: "requestport-operator",
        name: "With a session",
      });
      expect(withSession.status).toBe(200);

      const withKey = await auth.handler(
        new Request(`${baseURL}/api/auth/api-key/create`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: baseURL,
            "x-api-key": key,
          },
          body: JSON.stringify({
            configId: "requestport-operator",
            name: "With a key",
          }),
        }),
      );
      expect(withKey.status).toBe(401);
    });
  });

  test("the issuer's membership revoked, or the organisation suspended or archived, refuses the key", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      for (const change of ["membership", "suspended", "archived"] as const) {
        const member = await seedMember(tx);
        const { key } = await issueBound(auth, tx, member);
        await expectAuthenticates(auth, tx, key);
        await (change === "membership"
          ? tx.execute(sql`
              update "organization_members" set "status" = 'revoked'
              where "organization_id" = ${member.organizationId}
                and "user_id" = ${member.userId}
            `)
          : tx.execute(sql`
              update "organizations" set "status" = ${change}
              where "id" = ${member.organizationId}
            `));
        await expectRefused(apiBearer(auth, tx), key);
      }
    });
  });

  test("a credential revoked by revoke_operator_credential, through the real bus, authenticates nothing", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const { key, binding } = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, key);

      await expect(revokeItself(tx, binding)).resolves.toMatchObject({
        revoked: true,
      });
      await expectRefused(apiBearer(auth, tx), key);
    });
  });

  test("rotating the issuer's local credential through bootstrapOwner refuses the key (F3-13)", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const { key, binding } = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, key);

      await bootstrapOwner(
        createFoundationRepository(tx as never),
        { actor: BOOTSTRAP_OWNER_ACTOR, correlationId: crypto.randomUUID() },
        {
          email: member.email,
          organizationSlug: `operator-bearer-${member.organizationId}`,
          organizationName: "Operator bearer tenant",
          localCredential: "rotate",
        },
      );

      await expectRefused(apiBearer(auth, tx), key);
      await expect(revokeItself(tx, binding)).rejects.toMatchObject({
        code: "forbidden",
      });
    });
  });
});

/*
  Done when 4, the windows before the migration and before the switch: the
  issuance service refuses before it reserves a receipt or creates a plugin
  key, and an `rpo_` key gets 401, each paired with the same call succeeding
  once the switch is enabled and the table present.
*/
describe.sequential("issuance and use stay off until the table and the switch are there (F3-14)", () => {
  test("with the switch unset or disabled, the service writes nothing; enabled, it issues a key that authenticates", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const context = await personContext(tx, member);
      const request = {
        organizationId: member.organizationId,
        projectId: null,
        name: "CI deploy",
        scopes: ["operator:revoke"],
      };
      const before = await issuanceTrace(tx, member.userId);

      for (const variable of [undefined, "disabled"] as const) {
        await expect(
          issuanceService(auth, tx, { variable }).issue(context, request, {
            idempotencyKey: `operator-issue-${crypto.randomUUID()}`,
            expectedVersion: 0,
          }),
        ).rejects.toMatchObject({
          code: "configuration_error",
          details: { reason: "switched-off" },
        });
        await expect(issuanceTrace(tx, member.userId)).resolves.toEqual(before);
      }

      const issued = await issuanceService(auth, tx).issue(context, request, {
        idempotencyKey: `operator-issue-${crypto.randomUUID()}`,
        expectedVersion: 0,
      });
      expect(issued.plaintextKey.startsWith("rpo_")).toBe(true);
      await expectAuthenticates(auth, tx, issued.plaintextKey);

      // Rotation, by the issuer, through the same service: the replacement
      // authenticates as the same actor, and so does the old key, in its
      // overlap.
      const rotated = await issuanceService(auth, tx).rotate(context, {
        organizationId: member.organizationId,
        credentialId: issued.credential.id,
        overlapMinutes: 5,
        meta: {
          idempotencyKey: `operator-rotate-${crypto.randomUUID()}`,
          expectedVersion: 1,
        },
      });
      await expect(
        apiBearer(auth, tx)(bearer(rotated.plaintextKey)),
      ).resolves.toMatchObject({
        actor: { id: `operator:${issued.credential.lineageId}` },
        credentialId: rotated.credential.id,
      });
      await expectAuthenticates(auth, tx, issued.plaintextKey);
    });
  });

  /*
    The plugin reads `minExpiresIn` in days and refuses a key asked to live
    less than one, so a replacement handed the old credential's remaining
    lifetime in seconds failed whenever less than a day was left — which
    includes every credential in its rotation overlap. The binding's
    `expires_at` is the authority (the plugin's expiry only narrows), so the
    replacement is bound to the old expiry whatever the plugin is handed.
  */
  test("rotates a credential with an hour left, and one in its overlap, each replacement bound to the old expiry", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const context = await personContext(tx, member);
      const service = issuanceService(auth, tx);
      const issued = await service.issue(
        context,
        {
          organizationId: member.organizationId,
          projectId: null,
          name: "CI deploy",
          scopes: ["operator:revoke"],
        },
        {
          idempotencyKey: `operator-issue-${crypto.randomUUID()}`,
          expectedVersion: 0,
        },
      );
      await tx.execute(sql`
        update "operator_credentials"
        set "expires_at" =
          date_trunc('milliseconds', clock_timestamp() + interval '1 hour')
        where "id" = ${issued.credential.id}
      `);
      const expiresAtOf = async (id: string) => {
        const rows = await tx.execute<{ expires_at: string }>(sql`
          select "expires_at"::text as "expires_at"
          from "operator_credentials" where "id" = ${id}
        `);
        return rows.rows[0]?.expires_at;
      };
      const rotateOnce = (credentialId: string, expectedVersion: number) =>
        service.rotate(context, {
          organizationId: member.organizationId,
          credentialId,
          overlapMinutes: 5,
          meta: {
            idempotencyKey: `operator-rotate-${crypto.randomUUID()}`,
            expectedVersion,
          },
        });

      const hourLeft = await expiresAtOf(issued.credential.id);
      const first = await rotateOnce(issued.credential.id, 1);
      await expect(expiresAtOf(first.credential.id)).resolves.toBe(hourLeft);
      await expectAuthenticates(auth, tx, first.plaintextKey);

      // The old credential is now in its overlap: its expiry is the overlap's
      // end, minutes away, and it can still be rotated by its issuer.
      const inOverlap = await expiresAtOf(issued.credential.id);
      const second = await rotateOnce(issued.credential.id, 2);
      await expect(expiresAtOf(second.credential.id)).resolves.toBe(inOverlap);
      await expectAuthenticates(auth, tx, second.plaintextKey);
    });
  });

  test("with the table absent, whatever the switch says, the service refuses and a key gets 401", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const context = await personContext(tx, member);
      const { key } = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, key);

      // Renamed rather than dropped: a drop also takes ACCESS EXCLUSIVE on
      // apikey, organizations, projects and user, which deadlocked suites the
      // gate runs beside this one on the same database. `to_regclass` finds
      // no `operator_credentials` either way, and the rollback restores it.
      await tx.execute(
        sql`alter table "operator_credentials" rename to "operator_credentials_absent"`,
      );
      const before = await issuanceTrace(tx, member.userId);
      await expectRefused(apiBearer(auth, tx), key);
      await expect(
        issuanceService(auth, tx).issue(
          context,
          {
            organizationId: member.organizationId,
            projectId: null,
            name: "Before the migration",
            scopes: [],
          },
          {
            idempotencyKey: `operator-issue-${crypto.randomUUID()}`,
            expectedVersion: 0,
          },
        ),
      ).rejects.toMatchObject({
        code: "configuration_error",
        details: { reason: "not-migrated" },
      });
      await expect(issuanceTrace(tx, member.userId)).resolves.toEqual(before);
    });
  });
});

/*
  Done when 4 (ruling 53). Two instances from the same `createAuthOptions`
  result, one with `disabledPaths` emptied — the composition before K.3, which
  production no longer has — and one with `/change-password` in it; and a
  third, the composition exactly as `createAuthOptions` returns it since K.3.
  For each, the guard is read from that instance's own `$context`, and an
  unauthenticated POST to `/api/auth/change-password` goes through that
  instance's router.
*/
describe.sequential("activation has no effect while /change-password is mounted (F3-14)", () => {
  test("mounted: the router serves it, the answer is off, and a bound live key gets 401", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, mounted);
      const probe = await auth.handler(
        new Request(`${baseURL}/api/auth/change-password`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: baseURL },
          body: JSON.stringify({
            currentPassword: "x".repeat(12),
            newPassword: "y".repeat(12),
          }),
        }),
      );
      expect(probe.status).not.toBe(404);
      expect(
        operatorCredentialSwitch({
          variable: "enabled",
          authContext: await auth.$context,
        }),
      ).toEqual({ enabled: false, reason: "change-password-mounted" });

      const member = await seedMember(tx);
      const { key } = await issueBound(auth, tx, member);
      await expectRefused(apiBearer(auth, tx, { variable: "enabled" }), key);

      const context = await personContext(tx, member);
      const before = await issuanceTrace(tx, member.userId);
      await expect(
        issuanceService(auth, tx).issue(
          context,
          {
            organizationId: member.organizationId,
            projectId: null,
            name: "While mounted",
            scopes: [],
          },
          {
            idempotencyKey: `operator-issue-${crypto.randomUUID()}`,
            expectedVersion: 0,
          },
        ),
      ).rejects.toMatchObject({
        code: "configuration_error",
        details: { reason: "change-password-mounted" },
      });
      await expect(issuanceTrace(tx, member.userId)).resolves.toEqual(before);
    });
  });

  test("closed: the router answers 404, the answer is on, and the same key authenticates", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const probe = await auth.handler(
        new Request(`${baseURL}/api/auth/change-password`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: baseURL },
          body: JSON.stringify({
            currentPassword: "x".repeat(12),
            newPassword: "y".repeat(12),
          }),
        }),
      );
      expect(probe.status).toBe(404);
      expect(
        operatorCredentialSwitch({
          variable: "enabled",
          authContext: await auth.$context,
        }),
      ).toEqual({ enabled: true });

      const member = await seedMember(tx);
      const { key } = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, key);

      const issued = await issuanceService(auth, tx).issue(
        await personContext(tx, member),
        {
          organizationId: member.organizationId,
          projectId: null,
          name: "While closed",
          scopes: [],
        },
        {
          idempotencyKey: `operator-issue-${crypto.randomUUID()}`,
          expectedVersion: 0,
        },
      );
      await expectAuthenticates(auth, tx, issued.plaintextKey);
    });
  });

  test("the composition as createAuthOptions returns it is the closed case: 404, on, and a bound key authenticates", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx);
      const probe = await auth.handler(
        new Request(`${baseURL}/api/auth/change-password`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: baseURL },
          body: JSON.stringify({
            currentPassword: "x".repeat(12),
            newPassword: "y".repeat(12),
          }),
        }),
      );
      expect(probe.status).toBe(404);
      expect(
        operatorCredentialSwitch({
          variable: "enabled",
          authContext: await auth.$context,
        }),
      ).toEqual({ enabled: true });

      const member = await seedMember(tx);
      const { key } = await issueBound(auth, tx, member);
      await expectAuthenticates(auth, tx, key);
    });
  });

  test("the production composition closes /change-password, so enabled is on", () => {
    const options = createAuthOptions({
      database: {} as never,
      env: {
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: "https://requestport.com",
      },
      assertSignupAllowed: async () => ({}),
    });
    // K.3's line (rulings 31 and 48). Were it removed, the guard would answer
    // off with `change-password-mounted`, and this case would say so.
    expect(options.disabledPaths).toContain("/change-password");
    expect(
      operatorCredentialSwitch({
        variable: "enabled",
        authContext: { options },
      }),
    ).toEqual({ enabled: true });
  });
});

/*
  Done when 3: the composition golden records no plugin options, so it cannot
  see either configuration. These are asserted directly.
*/
describe("the two api-key configurations", () => {
  test("the agent configuration is exactly what K.3 left it", () => {
    // A literal copy of the agent `apiKey(...)` configuration on `main` at
    // 1bf1a68 (K.3, #122), which F.3 moved into `agentApiKeyConfiguration`
    // unchanged: `maxExpiresIn` is K.3's corrected bound, in days (ruling 12).
    expect(agentApiKeyConfiguration).toEqual({
      configId: "requestport-agent",
      defaultPrefix: "rp_",
      defaultKeyLength: 64,
      requireName: true,
      minimumNameLength: 1,
      maximumNameLength: 160,
      enableMetadata: false,
      enableSessionForAPIKeys: false,
      keyExpiration: {
        defaultExpiresIn: 90 * 24 * 60 * 60,
        disableCustomExpiresTime: false,
        minExpiresIn: 1,
        maxExpiresIn: 365,
      },
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
    });
  });

  test("the operator configuration never turns a key into a session, and bounds a key at 90 days", () => {
    expect(operatorApiKeyConfiguration).toMatchObject({
      configId: "requestport-operator",
      defaultPrefix: "rpo_",
      enableSessionForAPIKeys: false,
      keyExpiration: {
        defaultExpiresIn: 30 * 24 * 60 * 60,
        maxExpiresIn: 90,
      },
    });
  });

  test("agent keys created after F.3 carry the same rate-limit fields as before", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const auth = compose(tx, closed);
      const member = await seedMember(tx);
      const created = (await auth.api.createApiKey({
        body: {
          configId: "requestport-agent",
          name: "Agent after F.3",
          userId: member.userId,
          expiresIn: 90 * 24 * 60 * 60,
        },
      })) as { id: string };
      const row = await tx.execute(sql`
        select "rate_limit_max", "rate_limit_time_window", "config_id"
        from "apikey" where "id" = ${created.id}
      `);
      expect(row.rows).toEqual([
        {
          rate_limit_max: 600,
          rate_limit_time_window: 60_000,
          config_id: "requestport-agent",
        },
      ]);
    });
  });
});
