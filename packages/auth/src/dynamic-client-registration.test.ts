import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createAgentManagementRepository,
  createStorage,
  identitySchema,
  type Tx,
} from "@requestport/db";
import { queueQueriesOn, usePrivateJwksTable } from "@requestport/db/testing";
import { storageOptionsFromEnv } from "@requestport/db/wiring";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { serializeSignedCookie } from "better-call";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAuthRouteHandler } from "./auth-handler.js";
import { createAuthOptions } from "./server-options.js";

/**
 * Dynamic client registration through the route handler and Better Auth's own
 * endpoint, against the live adapter.
 *
 * Everything runs in one transaction, rolled back when the file ends, so the
 * clients, the person and the session it signs in with never outlive it. The
 * one exception is the provider's own `oauth_resource` rows, committed before
 * the transaction opens (`commitSeededResources`).
 *
 * The last block is the same route handler's other rewrite, the magic-link
 * signup denial, over stub handlers that touch no database.
 */

const baseUrl = "https://requestport.com";
const secret = "registration-integration-secret".padEnd(32, "!");

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage(storageOptionsFromEnv(process.env));

class TestRollback extends Error {}

let tx: Tx;
let finishTransaction: () => void;
let transactionEnded: Promise<void>;
let handle: (request: Request) => Promise<Response>;
let cookie = "";
const userId = `dcr_${randomUUID()}`;

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
      // Better Auth, composed over this transaction, issues some of its
      // queries at once, which all land on the transaction's one client:
      // queued, it is handed them in turn (queueQueriesOn; X25's remainder).
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
    sendMagicLink: async () => undefined,
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
  const auth = betterAuth(
    composeOver(
      drizzleAdapter(tx, {
        provider: "pg",
        schema: identitySchema,
        transaction: true,
      }),
    ),
  );
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
    values (${userId}, 'Registration', ${email}, now())
  `);
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId);
  cookie = (
    await serializeSignedCookie(
      "better-auth.session_token",
      session.token,
      secret,
    )
  ).split(";")[0] as string;
});

afterAll(async () => {
  try {
    finishTransaction?.();
    await transactionEnded;
  } finally {
    await suiteStorage.close();
  }
});

function registration(body: Record<string, unknown>) {
  return new Request(`${baseUrl}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function register(body: Record<string, unknown>) {
  const response = await handle(registration(body));
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function stored(clientId: string) {
  const result = await tx.execute(sql`
    select "require_pkce", "token_endpoint_auth_method", "application_type"
    from "oauth_client" where "client_id" = ${clientId}
  `);
  return result.rows[0];
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
 * Authorises the client for the signed-in person, consents, and redeems the
 * code — each through the endpoint production uses. Returns the token
 * endpoint's answer.
 */
async function consentAndRedeem(clientId: string, redirectUri: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "offline_access request:read",
    state: randomUUID(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${baseUrl}/mcp`,
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
  expect(callback.origin + callback.pathname).toBe(redirectUri);
  const code = callback.searchParams.get("code");
  if (!code) throw new Error(`Consent issued no code: ${callback}`);

  const response = await handle(
    new Request(`${baseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: `${baseUrl}/mcp`,
      }).toString(),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/**
 * The registration bodies RequestPort has on record, sent unedited. None names
 * an `application_type`; every one redirects to an `http` loopback address.
 */
const bodiesOnRecord = {
  // `packages/client/src/oauth.ts`, `registerClient`, as `authorize.ts` calls
  // it: its own name and a loopback receiver on an ephemeral port.
  "RequestPort's own client": {
    client_name: "requestport-agent",
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: ["http://127.0.0.1:53682/callback"],
    require_pkce: true,
    response_types: ["code"],
    scope: "offline_access request:read",
    token_endpoint_auth_method: "none",
  },
  // `apps/web/tests/fixtures/agent-consent.ts`, `registerClient`.
  "the browser fixture": {
    client_name: "Consent journey",
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: ["http://127.0.0.1:41999/callback"],
    require_pkce: true,
    response_types: ["code"],
    scope: "offline_access project:provision",
    token_endpoint_auth_method: "none",
  },
  // This file's own, as it stood before 1.7.
  "this file's": {
    client_name: "RequestPort agent client",
    redirect_uris: ["http://127.0.0.1:41234/callback"],
    token_endpoint_auth_method: "none",
    require_pkce: true,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  },
  // What an agent on the MCP SDK's v1 client sends: it never names an
  // `application_type`, and uses `localhost`.
  "an MCP v1 SDK client's": {
    client_name: "An MCP client",
    redirect_uris: ["http://localhost:8123/oauth/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    require_pkce: true,
  },
} as const;

describe.sequential("dynamic client registration under Better Auth 1.7.6", () => {
  test.each(Object.entries(bodiesOnRecord))(
    "registers %s body as a native public client that completes consent",
    async (_, body) => {
      const { response, body: answer } = await register(body);

      expect(answer).toMatchObject({ application_type: "native" });
      // Better Auth answers 200 where RFC 7591 asks for 201. Both our own
      // client and the MCP SDK branch on `response.ok`, so pinning the exact
      // number here would test their HTTP library, not this endpoint.
      expect(response.ok).toBe(true);
      const clientId = answer.client_id as string;
      // A public client must never be handed a secret to lose.
      expect(answer.client_secret).toBeUndefined();
      expect(answer.redirect_uris).toEqual(body.redirect_uris);

      // Pinned because everything downstream has to read it correctly: the
      // register endpoint strips `require_pkce` from the body, so the row it
      // writes says null, which Better Auth reads as "required". The consent
      // gates read the token endpoint method: 1.7.6 has no `public` or `type`
      // field, and 0022 (K.4) dropped both columns.
      await expect(stored(clientId)).resolves.toEqual({
        require_pkce: null,
        token_endpoint_auth_method: "none",
        application_type: "native",
      });

      // The consent screen's gate, then the flow behind it, end to end.
      await expect(
        createAgentManagementRepository(
          tx as unknown as Parameters<
            typeof createAgentManagementRepository
          >[0],
        ).getConsentOptions(userId, clientId),
      ).resolves.not.toBeNull();
      await expect(
        consentAndRedeem(clientId, body.redirect_uris[0]),
      ).resolves.toMatchObject({
        status: 200,
        body: { token_type: "Bearer" },
      });
    },
  );

  test("files an https redirect as web", async () => {
    const { response, body } = await register({
      ...bodiesOnRecord["this file's"],
      redirect_uris: ["https://agent.example/callback"],
    });

    expect(response.ok).toBe(true);
    expect(body).toMatchObject({ application_type: "web" });
  });

  test("keeps an application_type the request names", async () => {
    const { response, body } = await register({
      ...bodiesOnRecord["this file's"],
      application_type: "web",
    });

    // Kept as sent, so Better Auth judges the loopback redirect as a web
    // client's, and refuses it.
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_redirect_uri" });
  });

  test("leaves a mixed set of redirects to Better Auth, which refuses it", async () => {
    const { response, body } = await register({
      ...bodiesOnRecord["this file's"],
      redirect_uris: [
        "http://127.0.0.1:41234/callback",
        "https://agent.example/callback",
      ],
    });

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_redirect_uri" });
  });

  test("refuses a client that would not have to prove possession", async () => {
    const response = await handle(
      registration({ ...bodiesOnRecord["this file's"], require_pkce: false }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_client_metadata",
    });
  });
});

/**
 * The route handler's other rewrite: a magic-link verification the signup
 * policy refused goes to the one fixed page. `magic-link-handler.test.ts`
 * proves the real refusal end to end; these are the responses that must pass
 * through untouched, over stub handlers.
 */
describe("the route handler's magic-link denial rewrite", () => {
  const verify =
    "http://localhost:3000/api/auth/magic-link/verify?token=t&callbackURL=%2F";

  function redirect(location: string, cookie?: string) {
    const headers = new Headers({ location });
    if (cookie) headers.append("set-cookie", cookie);
    return new Response(null, { status: 302, headers });
  }

  function through(response: Response, url = verify) {
    return createAuthRouteHandler(async () => response)(new Request(url));
  }

  test("sends 1.7.6's denial redirect to the fixed page, wherever it pointed", async () => {
    const response = await through(
      redirect(
        "https://elsewhere.example/landing?error=signup_disabled&error_description=signup_disabled",
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/auth-error?error=signup_disabled",
    );
  });

  test("passes a redirect carrying another error through", async () => {
    const response = await through(
      redirect("http://localhost:3000/sign-in?error=INVALID_TOKEN"),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/sign-in?error=INVALID_TOKEN",
    );
  });

  test("passes a success redirect through with its session cookie, even when its callbackURL carries the code", async () => {
    const cookie = "better-auth.session_token=abc; Path=/; HttpOnly";
    const response = await through(
      redirect("http://localhost:3000/welcome?error=signup_disabled", cookie),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/welcome?error=signup_disabled",
    );
    expect(response.headers.get("set-cookie")).toBe(cookie);
  });

  test("passes a plain success redirect through", async () => {
    const cookie = "better-auth.session_token=abc; Path=/; HttpOnly";
    const response = await through(redirect("http://localhost:3000/", cookie));

    expect(response.headers.get("location")).toBe("http://localhost:3000/");
    expect(response.headers.get("set-cookie")).toBe(cookie);
  });

  test("leaves a denial redirect on a lookalike path alone", async () => {
    const location =
      "http://localhost:3000/auth-error?error=signup_disabled&error_description=signup_disabled";
    const response = await through(
      redirect(location),
      "http://localhost:3000/api/auth/lookalike/magic-link/verify?token=t",
    );

    expect(response.headers.get("location")).toBe(location);
  });
});
