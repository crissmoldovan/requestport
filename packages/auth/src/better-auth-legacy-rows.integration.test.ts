import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SchemaMismatchError } from "@better-auth/core/db/internal";
import { createStorage, identitySchema, type Tx } from "@requestport/db";
import { usePrivateJwksTable } from "@requestport/db/testing";
import { storageOptionsFromEnv } from "@requestport/db/wiring";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { serializeSignedCookie } from "better-call";
import { getTableColumns, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAuthRouteHandler } from "./auth-handler.js";
import { createAuthOptions } from "./server-options.js";

/**
 * Rows Better Auth 1.6.29 wrote, read and used by 1.7.6 (plan 13, K.3 item 4).
 *
 * Production holds OAuth clients, refresh tokens and agent API keys that
 * 1.6.29 wrote before the upgrade, and migration 0017 gave them 1.7's columns
 * as NULL or their defaults. Each case here makes such a row — by SQL in
 * 1.6.29's shape, or by letting 1.7.6 write one and then putting every column
 * 0017 added back to what a 1.6.29 row holds — and then uses it through
 * 1.7.6's own endpoints. The last case is the other half of that boundary:
 * 1.7.6 handed a table without 0017's columns refuses to serve at all.
 *
 * Everything runs in one transaction, rolled back when the file ends, except
 * the provider's own `oauth_resource` rows, committed before the transaction
 * opens (`commitSeededResources`).
 */

const baseUrl = "https://requestport.com";
const secret = "legacy-rows-integration-secret".padEnd(32, "!");
const mcp = `${baseUrl}/mcp`;
const redirectUri = "http://127.0.0.1:41235/callback";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage(storageOptionsFromEnv(process.env));

class TestRollback extends Error {}

let tx: Tx;
let finishTransaction: () => void;
let transactionEnded: Promise<void>;
let auth: ReturnType<typeof betterAuth>;
let handle: (request: Request) => Promise<Response>;
const userId = `legacy_${randomUUID()}`;

async function openFileTransaction() {
  let ready: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    ready = resolve;
  });
  transactionEnded = suiteStorage.db
    .transaction(async (transaction) => {
      tx = transaction;
      // Better Auth signs with the newest `jwks` row and decrypts it with the
      // secret it is given; rows other suites leave behind are encrypted under
      // theirs. This transaction reads and writes an empty `jwks` of its own,
      // without locking the shared table's rows (`usePrivateJwksTable`).
      await usePrivateJwksTable(transaction);
      await new Promise<void>((resolve) => {
        finishTransaction = resolve;
        ready();
      });
      throw new TestRollback();
    })
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
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: baseUrl,
    },
    assertSignupAllowed: async () => ({ allowed: true }),
  });
}

/**
 * Commits the `oauth_resource` rows the composition seeds, before the file's
 * transaction opens.
 *
 * Better Auth 1.7.6 starts initialising the moment `betterAuth()` is called,
 * and the OAuth provider's initialisation seeds its `resources`: it looks each
 * identifier up and inserts it when the lookup finds nothing
 * (`@better-auth/oauth-provider@1.7.6` `introspect-CbYi2MJT.mjs:805-870`).
 * Built over this file's transaction, those are two statements in it. A row
 * another suite commits between them, or has inserted and not yet committed,
 * is not seen by the lookup; the insert then fails on
 * `oauth_resource_identifier_unique`, and Postgres aborts the transaction, so
 * every later statement here answers 25P02. Committed first, the rows are
 * there before the transaction's first statement and the seed inserts
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
      values (${randomUUID()}, ${identifier}, ${identifier}, now(), now())
      on conflict ("identifier") do nothing
    `);
  }
}

beforeAll(async () => {
  await commitSeededResources();
  await openFileTransaction();
  auth = betterAuth(
    composeOver(
      drizzleAdapter(tx, {
        provider: "pg",
        schema: identitySchema,
        transaction: true,
      }),
    ),
  ) as unknown as ReturnType<typeof betterAuth>;
  // Waited for here, before anything else uses the transaction, so a failure
  // while it initialises is this hook's error rather than an unhandled
  // rejection.
  await auth.$context;
  handle = createAuthRouteHandler(auth.handler);

  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Legacy rows', ${email}, now())
  `);
});

afterAll(async () => {
  try {
    finishTransaction?.();
    await transactionEnded;
  } finally {
    await suiteStorage.close();
  }
});

let lastSessionToken = "";

async function signIn() {
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId);
  lastSessionToken = session.token;
  return (
    await serializeSignedCookie(
      "better-auth.session_token",
      session.token,
      secret,
    )
  ).split(";")[0] as string;
}

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

/**
 * A public native client with a loopback redirect, inserted as Better Auth
 * 1.6.29's dynamic registration wrote one, with every column 0017 added at
 * its default — which is also what a client 1.6.29 registered between 0017's
 * apply and this upgrade holds. 1.6.29 also wrote `public` true and left
 * `type` NULL; 0022 (K.4) dropped both columns, so neither is written here.
 */
async function legacyClient() {
  const clientId = `legacy_client_${randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_client"
      ("id", "client_id", "name", "redirect_uris", "token_endpoint_auth_method",
       "grant_types", "response_types", "disabled", "scopes",
       "created_at", "updated_at")
    values (${clientId}, ${clientId}, 'Legacy agent',
      ${sql`array[${redirectUri}]`}, 'none',
      array['authorization_code', 'refresh_token'], array['code'],
      false, array['openid', 'offline_access', 'request:read'],
      now(), now())
  `);
  const [row] = (
    await tx.execute(sql`
      select "application_type", "client_discovery_id",
        "client_credentials_scopes"
      from "oauth_client" where "client_id" = ${clientId}
    `)
  ).rows;
  expect(row).toEqual({
    application_type: null,
    client_discovery_id: null,
    client_credentials_scopes: [],
  });
  return clientId;
}

/**
 * Authorises the client for a signed-in person, consents and redeems the code
 * for `resource` — each through the endpoint production uses.
 */
async function connect(clientId: string, cookie: string, resource = mcp) {
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "offline_access request:read",
    state: randomUUID(),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource,
  })) {
    authorize.searchParams.set(key, value);
  }
  const consentPage = await redirectTarget(
    await handle(
      new Request(authorize, { headers: { cookie }, redirect: "manual" }),
    ),
  );
  expect(consentPage.pathname).toBe("/oauth/agent-consent");
  const callback = await redirectTarget(
    await handle(
      new Request(`${baseUrl}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: baseUrl,
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: consentPage.search.slice(1),
        }),
      }),
    ),
  );
  const code = callback.searchParams.get("code");
  if (!code) throw new Error(`Consent issued no code: ${callback}`);
  return token({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource,
  });
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

/**
 * Puts a refresh token's row back into 1.6.29's shape: every column 0017
 * added is NULL, as it is on every refresh token production holds.
 */
async function asWrittenBy1629(clientId: string) {
  await tx.execute(sql`
    update "oauth_refresh_token" set
      "authorization_code_id" = null, "resources" = null,
      "requested_user_info_claims" = null, "rotated_at" = null,
      "rotation_replay_response" = null, "rotation_replay_expires_at" = null,
      "confirmation" = null
    where "client_id" = ${clientId}
  `);
  await tx.execute(sql`
    update "oauth_consent" set
      "resources" = null, "requested_user_info_claims" = null
    where "client_id" = ${clientId}
  `);
}

describe.sequential("OAuth rows 1.6.29 wrote, under 1.7.6", () => {
  test("a native loopback client 1.6.29 registered authorises, consents and redeems", async () => {
    const clientId = await legacyClient();

    const tokens = await connect(clientId, await signIn());

    expect(decodeJwt(tokens.access_token).aud).toBe(mcp);
    expect(tokens.refresh_token).toEqual(expect.any(String));
  });

  test("a refresh token 1.6.29 wrote refreshes for its own audience", async () => {
    const clientId = await legacyClient();
    const first = await connect(clientId, await signIn());
    await asWrittenBy1629(clientId);

    const refreshed = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: first.refresh_token,
      resource: mcp,
    });

    expect(decodeJwt(refreshed.access_token).aud).toBe(mcp);
  });

  test("a refresh token 1.6.29 wrote, refreshed with no resource, is issued an opaque token", async () => {
    // It stores no resource, so there is nothing to restore: the token has no
    // audience, and the provider issues an opaque one, which RequestPort's
    // bearer path cannot spend (`authenticate-bearer.ts` says why).
    const clientId = await legacyClient();
    const first = await connect(clientId, await signIn());
    await asWrittenBy1629(clientId);

    const refreshed = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: first.refresh_token,
    });

    expect(refreshed.access_token.split(".")).toHaveLength(1);
  });

  test("a person signing out leaves an agent's offline_access refresh token usable", async () => {
    const clientId = await legacyClient();
    const cookie = await signIn();
    const first = await connect(clientId, cookie);
    await asWrittenBy1629(clientId);

    const signedOut = await handle(
      new Request(`${baseUrl}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie, origin: baseUrl },
      }),
    );
    expect(signedOut.status).toBe(200);
    const session = await tx.execute(sql`
      select count(*)::int as "count" from "session"
      where "token" = ${lastSessionToken}
    `);
    expect(session.rows[0]).toEqual({ count: 0 });

    await expect(
      tokenResponse({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: first.refresh_token,
        resource: mcp,
      }),
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe.sequential("an agent API key 1.6.29 issued, under 1.7.6", () => {
  test("verifies, and its rate limit counts", async () => {
    // Inserted exactly as `@better-auth/api-key@1.6.29` stores a key: the
    // SHA-256 of the plain key, base64url without padding (its
    // `defaultKeyHasher`, unchanged in 1.7.6), under the agent configuration.
    const plain = `rp_${randomBytes(48).toString("base64url")}`;
    const hashed = createHash("sha256").update(plain).digest("base64url");
    const id = `legacy_key_${randomUUID()}`;
    await tx.execute(sql`
      insert into "apikey"
        ("id", "config_id", "name", "start", "reference_id", "prefix", "key",
         "enabled", "rate_limit_enabled", "rate_limit_time_window",
         "rate_limit_max", "request_count", "expires_at", "created_at",
         "updated_at")
      values (${id}, 'requestport-agent', 'Legacy key', ${plain.slice(0, 6)},
        ${userId}, 'rp_', ${hashed}, true, true, 60000, 600, 0,
        now() + interval '30 days', now(), now())
    `);

    const verified = await (
      auth.api as unknown as {
        verifyApiKey: (input: {
          body: { key: string; configId: string };
        }) => Promise<{ valid: boolean; key: { id: string } | null }>;
      }
    ).verifyApiKey({ body: { key: plain, configId: "requestport-agent" } });

    expect(verified).toMatchObject({ valid: true, key: { id } });
    const [row] = (
      await tx.execute(sql`
        select "request_count" from "apikey" where "id" = ${id}
      `)
    ).rows;
    expect(row).toEqual({ request_count: 1 });
  });
});

describe.sequential("an instance composed over the pre-expand oauth_client", () => {
  test("refuses its first request with Better Auth's schema mismatch", async () => {
    // Done when K.3 1, through a betterAuth() instance rather than the check
    // taken off the adapter (adapter-schema.test.ts). 1.7.6 registers
    // validateSchema's check when the instance initialises and awaits it in
    // the router's onRequest, before any endpoint runs. The table handed over
    // here is oauth_client without client_discovery_id, one of the columns
    // 0017 added; every other table is the full one.
    const oauthClient = pgTable(
      "oauth_client",
      Object.fromEntries(
        Object.entries(getTableColumns(identitySchema.oauthClient))
          .filter(([, column]) => column.name !== "client_discovery_id")
          .map(([key, column]) => [
            key,
            column.notNull ? text(column.name).notNull() : text(column.name),
          ]),
      ),
    );
    const projected = betterAuth(
      composeOver(
        drizzleAdapter(tx, {
          provider: "pg",
          schema: { ...identitySchema, oauthClient },
          transaction: true,
        }),
      ),
    ) as unknown as ReturnType<typeof betterAuth>;
    // Its initialisation, the resource seed included, runs on the file's
    // transaction; waited for before the control uses that transaction. The
    // schema is checked at initialisation only to be logged, so this
    // resolves, and the refusal comes from the request below.
    await projected.$context;

    // The control: the full tables, over the same transaction, answer.
    await expect(
      handle(new Request(`${baseUrl}/api/auth/ok`)),
    ).resolves.toMatchObject({ status: 200 });

    const failure = await projected
      .handler(new Request(`${baseUrl}/api/auth/ok`))
      .then(
        (response) => response,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SchemaMismatchError);
    expect(String((failure as Error).message)).toMatch(
      /client_discovery_id|clientDiscoveryId/u,
    );
  });
});
