import { createHash, randomBytes } from "node:crypto";

import {
  createAgentAuthRepository,
  createStorage,
  identitySchema,
  type Tx,
} from "@requestport/db";
import {
  endTenantBinding,
  queueQueriesOn,
  usePrivateJwksTable,
} from "@requestport/db/testing";
import { storageOptionsFromEnv } from "@requestport/db/wiring";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { serializeSignedCookie } from "better-call";
import { sql } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAuthRouteHandler } from "../auth-handler.js";
import { createAuthOptions } from "../server-options.js";
import { createAuthenticateAgentBearer } from "./authenticate-bearer.js";
import { createAgentAccessTokenVerifier } from "./verify-access-token.js";

/**
 * GHSA-p2fr-6hmx-4528, end to end, through Better Auth's own endpoints.
 *
 * Before 1.7, the provider decided a token's audience from the `resource` of
 * the token request in front of it and never against what the client had
 * been authorised for, on the code grant and the refresh grant alike. The
 * running provider, `@better-auth/oauth-provider@1.7.6`, carries upstream's
 * fix: a token or refresh request may only narrow the resource authorised,
 * and anything wider is refused with `invalid_target`. The first two groups
 * of cases show that refusal from both directions and on both grants.
 *
 * A client that named no resource when it was authorised has nothing to
 * narrow, and the provider still mints a token for whichever resource its
 * code is redeemed for. RequestPort does not rely on the provider there: a
 * token is only as good as the grant it resolves to, and a grant is resolved
 * for one audience — a (person, client) pair holds at most one active grant,
 * and the grant family claim stamped into each token is computed for the
 * audience the token names. The last group mints that token for real and
 * shows it buys nothing at the other resource.
 *
 * Everything runs in one transaction, rolled back when the file ends: Better
 * Auth's adapter and the grant repository are both bound to it. Adding an
 * organization owner writes an append-only domain event, and binding a grant
 * writes an append-only audit record, so committed fixtures here could never
 * be removed. Rolled back, they never existed — including when the process
 * dies mid-run, because the server aborts the transaction. The one exception
 * is the provider's own `oauth_resource` rows, committed before the
 * transaction opens (`commitSeededResources`).
 */

const baseUrl = "https://requestport.com";
const secret = "cross-audience-integration-secret".padEnd(32, "!");
const audiences = {
  api: `${baseUrl}/api/v1`,
  mcp: `${baseUrl}/mcp`,
} as const;
const redirectUri = "http://127.0.0.1:41234/callback";

type Audience = keyof typeof audiences;
// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage(storageOptionsFromEnv(process.env));

class TestRollback extends Error {}

let tx: Tx;
let finishTransaction: () => void;
let transactionEnded: Promise<void>;
let handle: (request: Request) => Promise<Response>;
let presentAt: (endpoint: Audience, accessToken: string) => Promise<unknown>;
let repository: ReturnType<typeof createAgentAuthRepository>;

const person = {
  userId: `crossaud_${crypto.randomUUID()}`,
  organizationId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  agentPrincipalId: crypto.randomUUID(),
  cookie: "",
};

/**
 * Opens the transaction every case runs in, and keeps it open until
 * `finishTransaction` is called.
 */
async function openFileTransaction() {
  let ready: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    ready = resolve;
  });
  transactionEnded = suiteStorage.db
    .transaction(
      async (transaction) => {
        tx = transaction;
        // Better Auth signs with the newest `jwks` row (`getLatestKey`), and
        // decrypts its private key with the secret it is given. The track's
        // database is shared by every suite and by the browser lanes, which
        // leave rows encrypted under their own secrets, so this file found a
        // key it could not decrypt and every token request answered 500. This
        // transaction reads and writes an empty `jwks` of its own instead, so
        // the provider mints a key under this file's secret, a key another
        // suite commits mid-file never reaches it, and the shared table's rows
        // are never locked (`usePrivateJwksTable`).
        await usePrivateJwksTable(transaction);
        // Better Auth, composed over this transaction, issues some of its
        // queries at once, which all land on the transaction's one client:
        // queued, it is handed them in turn (queueQueriesOn; X25's
        // remainder).
        const restore = queueQueriesOn(transaction);
        try {
          await new Promise<void>((resolve) => {
            finishTransaction = resolve;
            ready();
          });
        } finally {
          restore();
        }
        throw new TestRollback();
      },
      { isolationLevel: "repeatable read" },
    )
    .catch((error: unknown) => {
      if (!(error instanceof TestRollback)) throw error;
    });
  await Promise.race([
    opened,
    transactionEnded.then(() => {
      throw new Error("The file transaction ended before it opened");
    }),
  ]);
}

function composeOver(
  database: Parameters<typeof createAuthOptions>[0]["database"],
) {
  return createAuthOptions({
    database,
    env: {
      // Not production: that would name the cookie `__Secure-…` and switch
      // on rate limits, neither of which this is about.
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: baseUrl,
    },
    assertSignupAllowed: async () => ({ allowed: true }),
    resolveAgentGrantBindingFingerprints: (input) =>
      repository.listOAuthGrantBindingFingerprints(input),
  });
}

/**
 * Commits the `oauth_resource` rows the composition seeds, before the file's
 * transaction takes its snapshot.
 *
 * Better Auth 1.7.6 starts initialising the moment `betterAuth()` is called,
 * and the OAuth provider's initialisation seeds its `resources`: it looks each
 * identifier up and inserts it when the lookup finds nothing
 * (`@better-auth/oauth-provider@1.7.6` `introspect-CbYi2MJT.mjs:805-870`).
 * Built over this file's transaction, that lookup reads the transaction's
 * snapshot. A row another suite committed after the snapshot began is
 * invisible to it, the insert then fails on `oauth_resource_identifier_unique`,
 * and Postgres aborts the transaction, so every later statement here answers
 * 25P02. Committed first, the rows are in the snapshot and the seed inserts
 * nothing. `on conflict do nothing` keeps this step safe against another suite
 * seeding at the same moment. Each row is the one the seed writes for a
 * resource given as a string: its identifier as its name, and every policy
 * column at its default. They are the rows every instance of this
 * composition writes, so leaving them committed changes nothing. A resource
 * given as an object carries its own policy, which this row would not match,
 * so one stops the file here rather than being mirrored wrongly.
 */
async function commitSeededResources() {
  const provider = composeOver(
    drizzleAdapter(suiteStorage.db, { provider: "pg", schema: identitySchema }),
  ).plugins.find((plugin) => plugin.id === "oauth-provider") as
    | { options?: { resources?: readonly unknown[] } }
    | undefined;
  const identifiers = (provider?.options?.resources ?? []).map((entry) => {
    if (typeof entry !== "string") {
      throw new Error("commitSeededResources only mirrors string resources");
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
}

/**
 * Builds the instance over the file's transaction and waits for its
 * initialisation, so a failure there is this file's own error rather than a
 * rejection nothing is listening to, and nothing else runs on the
 * transaction's connection while it initialises.
 */
async function wire() {
  repository = createAgentAuthRepository(tx);
  const auth = betterAuth(
    composeOver(
      drizzleAdapter(tx, {
        provider: "pg",
        schema: identitySchema,
        transaction: true,
      }),
    ),
  );
  await auth.$context;
  handle = createAuthRouteHandler(auth.handler);

  // The bearer path as `create-auth.ts` assembles it, with the same verifier and
  // the same grant lookup, reading the keys this provider signs with.
  const authenticateAgentBearer = createAuthenticateAgentBearer({
    audiences,
    userinfoAudience: `${baseUrl}/api/auth/oauth2/userinfo`,
    verifyApiKey: async () => ({ key: null, valid: false }),
    resolveApiKey: async () => null,
    verifyJwt: createAgentAccessTokenVerifier({
      audiences: Object.values(audiences),
      issuer: baseUrl,
      jwks: async () => await auth.api.getJwks(),
    }),
    resolveOAuth: (input) => repository.resolveOAuthGrant(input),
    // The stamp binds the grant's organisation (ruling 261). In production it
    // runs on the pool, so the binding ends with it; here every case shares
    // the file's one transaction, so the binding is ended after each stamp.
    touchOAuthGrant: async (grantId, organizationId) => {
      try {
        await repository.touchOAuthGrant(grantId, organizationId);
      } finally {
        await endTenantBinding(tx);
      }
    },
  });
  presentAt = (endpoint, accessToken) =>
    authenticateAgentBearer(
      new Request(audiences[endpoint], {
        headers: { authorization: `Bearer ${accessToken}` },
        method: "POST",
      }),
      endpoint,
    );

  return auth;
}

/** What the consent screen does once the person approves: bind the grant. */
async function bindGrant(clientId: string, audience: Audience) {
  await repository.bindOAuthConsent({
    organizationId: person.organizationId,
    agentPrincipalId: person.agentPrincipalId,
    userId: person.userId,
    clientId,
    audience,
    projectId: person.projectId,
    laneIds: [],
    scopes: ["request:read"],
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    correlationId: crypto.randomUUID(),
    expectedVersion: 0,
    idempotencyKey: crypto.randomUUID(),
    fingerprintSecret: "cross-audience-fingerprint-secret",
  });
}

/**
 * One bystander client per audience, each with a grant, so the family claim
 * the provider stamps into a token for either audience is never empty. An
 * empty claim would refuse the advisory's token on its own and hide whether
 * the per-audience grant lookup does anything.
 */
async function seedBystanders() {
  for (const audience of ["mcp", "api"] as const) {
    const clientId = `bystander_${crypto.randomUUID()}`;
    await tx.execute(sql`
      insert into "oauth_client"
        ("id", "client_id", "redirect_uris", "disabled",
         "token_endpoint_auth_method")
      values (${clientId}, ${clientId}, ${sql`array[${redirectUri}]`},
        false, 'none')
    `);
    await tx.execute(sql`
      insert into "oauth_consent" ("id", "client_id", "user_id", "scopes")
      values (${`consent_${crypto.randomUUID()}`}, ${clientId},
        ${person.userId}, ${sql`array['request:read']`})
    `);
    await bindGrant(clientId, audience);
  }
}

beforeAll(async () => {
  await commitSeededResources();
  await openFileTransaction();
  const auth = await wire();

  const email = `${person.userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${person.userId}, 'Cross audience', ${email}, now())
  `);
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${person.organizationId}, 'Cross audience tenant',
      ${`crossaud-${person.organizationId}`}, 'active')
  `);
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${person.organizationId}, ${person.userId}, 'owner', 'active')
  `);
  await tx.execute(sql`
    insert into "projects"
      ("id", "organization_id", "name", "slug", "key_prefix", "status")
    values (${person.projectId}, ${person.organizationId},
      'Cross audience project', ${`project-${person.projectId}`},
      ${`CA${person.projectId.slice(0, 6)}`}, 'active')
  `);
  await tx.execute(sql`
    insert into "agent_principals"
      ("id", "organization_id", "project_id", "display_name", "slug",
       "status", "created_by_user_id")
    values (${person.agentPrincipalId}, ${person.organizationId},
      ${person.projectId}, 'Cross audience agent',
      ${`agent-${person.agentPrincipalId}`}, 'active', ${person.userId})
  `);

  // A signed-in person, the way Better Auth reads one off a request.
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(person.userId);
  person.cookie = (
    await serializeSignedCookie(
      "better-auth.session_token",
      session.token,
      secret,
    )
  ).split(";")[0] as string;

  await seedBystanders();
});

afterAll(async () => {
  try {
    finishTransaction?.();
    await transactionEnded;
  } finally {
    await suiteStorage.close();
  }
});

/** Where a response sends its reader, whether as a redirect or as JSON. */
async function redirectTarget(response: Response) {
  const location = response.headers.get("location");
  if (location) return new URL(location, baseUrl);
  const body = (await response.json()) as { url?: unknown };
  if (typeof body.url !== "string") {
    throw new Error(
      `Expected a redirect, got ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return new URL(body.url, baseUrl);
}

async function register() {
  const response = await handle(
    new Request(`${baseUrl}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Cross audience agent",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        require_pkce: true,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  const body = (await response.json()) as { client_id?: unknown };
  if (!response.ok || typeof body.client_id !== "string") {
    throw new Error(`Registration failed: ${JSON.stringify(body)}`);
  }
  return body.client_id;
}

/**
 * Registers a client, has the person consent to it, binds the grant for
 * `audience`, and returns the authorization code the provider issued — each
 * step through the endpoint or repository production uses.
 */
async function connect(
  audience: Audience,
  { indicateResource = true }: { indicateResource?: boolean } = {},
) {
  const clientId = await register();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const authorize = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "offline_access request:read",
    state: crypto.randomUUID(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(indicateResource ? { resource: audiences[audience] } : {}),
  })) {
    authorize.searchParams.set(key, value);
  }
  const consentPage = await redirectTarget(
    await handle(
      new Request(authorize, {
        headers: { cookie: person.cookie },
        redirect: "manual",
      }),
    ),
  );
  expect(consentPage.pathname).toBe("/oauth/agent-consent");

  const consented = await handle(
    new Request(`${baseUrl}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: person.cookie,
        origin: baseUrl,
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: consentPage.search.slice(1),
      }),
    }),
  );
  const callback = await redirectTarget(consented);
  const code = callback.searchParams.get("code");
  if (!code) throw new Error(`Consent issued no code: ${callback}`);

  await bindGrant(clientId, audience);

  return { clientId, code, verifier };
}

async function tokenResponse(parameters: Record<string, string>) {
  const response = await handle(
    new Request(`${baseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters).toString(),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function token(parameters: Record<string, string>) {
  const { status, body } = await tokenResponse(parameters);
  if (status !== 200) {
    throw new Error(`Token request failed: ${JSON.stringify(body)}`);
  }
  return body as { access_token: string; refresh_token: string };
}

function codeParameters(
  connection: Awaited<ReturnType<typeof connect>>,
  resource: string,
) {
  return {
    grant_type: "authorization_code",
    client_id: connection.clientId,
    code: connection.code,
    code_verifier: connection.verifier,
    redirect_uri: redirectUri,
    resource,
  };
}

function refreshParameters(
  clientId: string,
  refreshToken: string,
  resource: string,
) {
  return {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    resource,
  };
}

function redeem(
  connection: Awaited<ReturnType<typeof connect>>,
  resource: string,
) {
  return token(codeParameters(connection, resource));
}

function refresh(clientId: string, refreshToken: string, resource: string) {
  return token(refreshParameters(clientId, refreshToken, resource));
}

/**
 * The provider did mint a token for `resource`, with an expiry. Asserted
 * before each refusal by the bearer path, so that refusal cannot be
 * explained by the provider having quietly declined.
 */
function expectMintedFor(accessToken: string, resource: string) {
  const claims = decodeJwt(accessToken);
  expect(claims.aud).toBe(resource);
  expect(typeof claims.exp).toBe("number");
}

const refusedByGrant = {
  code: "unauthenticated",
  message: "OAuth agent grant is unavailable",
};

describe.sequential("a client authorised for one resource asks for the other", () => {
  test.each([
    ["mcp", "api"],
    ["api", "mcp"],
  ] as const)(
    "consented for %s, its code redeemed for %s is invalid_target",
    async (consented, other) => {
      const connection = await connect(consented);

      const refused = await tokenResponse(
        codeParameters(connection, audiences[other]),
      );

      expect(refused).toMatchObject({
        status: 400,
        body: { error: "invalid_target" },
      });

      // The refusal spends the code: asked again, even for the resource it
      // was consented for, it is gone.
      await expect(
        tokenResponse(codeParameters(connection, audiences[consented])),
      ).resolves.toMatchObject({
        status: 400,
        body: { error: "invalid_grant" },
      });

      // The control: a second connection's code, redeemed for the resource it
      // was consented for, yields a token its own endpoint accepts. So the
      // chain can succeed, and what refused the request above was the
      // resource.
      const second = await connect(consented);
      const own = await redeem(second, audiences[consented]);
      await expect(
        presentAt(consented, own.access_token),
      ).resolves.toMatchObject({
        actor: { type: "agent", id: person.agentPrincipalId },
        audience: consented,
      });
      // The provider's own token, once it authenticates, stamps its grant's
      // last use (ruling 261).
      const stamped = await tx.execute<{ stamped: boolean }>(sql`
        select "last_used_at" is not null as "stamped"
        from "agent_oauth_grants"
        where "oauth_client_id" = ${second.clientId}
      `);
      expect(stamped.rows).toEqual([{ stamped: true }]);
    },
  );

  test.each([
    ["mcp", "api"],
    ["api", "mcp"],
  ] as const)(
    "consented for %s, a refresh for %s is invalid_target",
    async (consented, other) => {
      const connection = await connect(consented);
      const first = await redeem(connection, audiences[consented]);
      await expect(
        presentAt(consented, first.access_token),
      ).resolves.toMatchObject({ audience: consented });

      const refused = await tokenResponse(
        refreshParameters(
          connection.clientId,
          first.refresh_token,
          audiences[other],
        ),
      );

      expect(refused).toMatchObject({
        status: 400,
        body: { error: "invalid_target" },
      });

      // The control: the same refresh token, asked for the resource it was
      // consented for, still refreshes, and its own endpoint accepts the
      // token. What refused the request above was the resource.
      const own = await refresh(
        connection.clientId,
        first.refresh_token,
        audiences[consented],
      );
      await expect(
        presentAt(consented, own.access_token),
      ).resolves.toMatchObject({ audience: consented });
    },
  );
});

describe.sequential("a client that named no resource when it was authorised", () => {
  test.each([
    ["mcp", "api"],
    ["api", "mcp"],
  ] as const)(
    "granted %s, it is minted a token for %s that resource refuses",
    async (granted, other) => {
      const connection = await connect(granted, { indicateResource: false });

      const minted = await redeem(connection, audiences[other]);

      expectMintedFor(minted.access_token, audiences[other]);
      await expect(presentAt(other, minted.access_token)).rejects.toMatchObject(
        refusedByGrant,
      );
      // At the resource it was granted, the token is refused before any grant
      // is read: its audience is not that endpoint's.
      await expect(
        presentAt(granted, minted.access_token),
      ).rejects.toMatchObject({
        code: "unauthenticated",
        message: "OAuth access token is invalid",
      });
    },
  );
});
