import { createHash, randomBytes, randomUUID } from "node:crypto";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { serializeSignedCookie } from "better-call";
import { describe, expect, test } from "vitest";

import { createAuthRouteHandler } from "./auth-handler.js";
import { createAuthOptions } from "./server-options.js";

/**
 * What the authorisation server advertises, and RFC 9207's `iss` on the
 * authorisation response, compared with the discovery document's `issuer` —
 * the same comparison D makes for a token's `iss`.
 */

const baseUrl = "https://requestport.com";
const secret = "metadata-integration-secret".padEnd(32, "!");
const redirectUri = "http://127.0.0.1:43211/callback";

function compose(cimd?: string) {
  const store: Record<string, Record<string, unknown>[]> = {
    user: [
      {
        id: "user_metadata",
        name: "Metadata",
        email: "metadata@example.invalid",
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    apikey: [],
    oauthClient: [],
    oauthRefreshToken: [],
    oauthAccessToken: [],
    oauthConsent: [],
    oauthResource: [],
    oauthClientResource: [],
    oauthClientAssertion: [],
  };
  const auth = betterAuth(
    createAuthOptions({
      database: memoryAdapter(store),
      env: {
        NODE_ENV: "test",
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: baseUrl,
        REQUESTPORT_OAUTH_CIMD: cimd,
        REQUESTPORT_OAUTH_CIMD_ALLOWED_ORIGINS: "https://agents.example",
      },
      assertSignupAllowed: async () => ({ allowed: true }),
      fetchClientMetadataResource: async () => {
        throw new Error("no metadata document is fetched here");
      },
    }),
  );
  return { auth, handle: createAuthRouteHandler(auth.handler) };
}

async function discovery(auth: ReturnType<typeof compose>["auth"]) {
  const response = await oauthProviderAuthServerMetadata(auth)(
    new Request(`${baseUrl}/.well-known/oauth-authorization-server`),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("the authorisation server metadata", () => {
  test("carries the issuer, RFC 9207 support and the registration endpoint", async () => {
    const metadata = await discovery(compose().auth);

    expect(metadata).toMatchObject({
      issuer: baseUrl,
      authorization_response_iss_parameter_supported: true,
      registration_endpoint: `${baseUrl}/api/auth/oauth2/register`,
    });
  });

  test("advertises Client ID Metadata Documents only with the switch on", async () => {
    expect(await discovery(compose().auth)).not.toHaveProperty(
      "client_id_metadata_document_supported",
    );
    expect(await discovery(compose("enabled").auth)).toMatchObject({
      client_id_metadata_document_supported: true,
    });
  });
});

describe("the authorisation response's iss", () => {
  async function registeredClient(handle: (r: Request) => Promise<Response>) {
    const response = await handle(
      new Request(`${baseUrl}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Metadata agent",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          require_pkce: true,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      }),
    );
    const body = (await response.json()) as { client_id?: string };
    if (!body.client_id) throw new Error(JSON.stringify(body));
    return body.client_id;
  }

  async function signedIn(auth: ReturnType<typeof compose>["auth"]) {
    const context = await auth.$context;
    const session =
      await context.internalAdapter.createSession("user_metadata");
    return (
      await serializeSignedCookie(
        "better-auth.session_token",
        session.token,
        secret,
      )
    ).split(";")[0] as string;
  }

  function authorizeRequest(
    clientId: string,
    cookie: string,
    scope: string,
    state: string,
  ) {
    const url = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: createHash("sha256")
        .update(randomBytes(32).toString("base64url"))
        .digest("base64url"),
      code_challenge_method: "S256",
      resource: `${baseUrl}/mcp`,
    })) {
      url.searchParams.set(key, value);
    }
    return new Request(url, { headers: { cookie }, redirect: "manual" });
  }

  async function target(response: Response) {
    const location =
      response.headers.get("location") ??
      ((await response.json()) as { url?: string }).url;
    if (!location) throw new Error(`no redirect: ${response.status}`);
    return new URL(location, baseUrl);
  }

  test("on a success redirect, equals the discovery issuer", async () => {
    const { auth, handle } = compose();
    const { issuer } = await discovery(auth);
    const clientId = await registeredClient(handle);
    const cookie = await signedIn(auth);
    const state = randomUUID();

    const consentPage = await target(
      await handle(
        authorizeRequest(
          clientId,
          cookie,
          "offline_access request:read",
          state,
        ),
      ),
    );
    expect(consentPage.pathname).toBe("/oauth/agent-consent");
    // 1.7.6 signs `resource` onto the consent redirect, where 1.6.29 dropped
    // it; the consent action reads it there.
    expect(consentPage.searchParams.getAll("resource")).toEqual([
      `${baseUrl}/mcp`,
    ]);
    const callback = await target(
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
    expect(callback.searchParams.get("code")).toBeTruthy();
    expect(callback.searchParams.get("state")).toBe(state);
    expect(callback.searchParams.get("iss")).toBe(issuer);
  });

  test("on an error redirect, which reaches the client with its state, equals the discovery issuer", async () => {
    const { auth, handle } = compose();
    const { issuer } = await discovery(auth);
    const clientId = await registeredClient(handle);
    const cookie = await signedIn(auth);
    const state = randomUUID();

    const callback = await target(
      await handle(
        authorizeRequest(clientId, cookie, "not-a-scope-anyone-offers", state),
      ),
    );

    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("error")).toBe("invalid_scope");
    expect(callback.searchParams.get("state")).toBe(state);
    expect(callback.searchParams.get("iss")).toBe(issuer);
  });
});
