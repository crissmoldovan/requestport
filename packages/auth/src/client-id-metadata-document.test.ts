import { createHash, randomBytes, randomUUID } from "node:crypto";
import dnsPromises from "node:dns/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { SignJWT } from "jose";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import { CIMD_ALLOWED_ORIGINS_VARIABLE } from "./cimd-origin-allowlist.js";
import { wrapCimdClientGuardAdapter } from "./restricted-adapter.js";
import { createAuthOptions } from "./server-options.js";

/*
  The real transport, `@better-auth/cimd/node`, does its one DNS lookup
  through `node:dns/promises` and its one request through `node:https`. It is
  loaded by Node rather than transformed by Vitest, so `vi.mock` cannot reach
  it; the built-ins are spied on their own module objects instead, and
  `syncBuiltinESMExports` carries the spies into the named exports the
  transport imports. Nothing else in this file touches either: the store is
  in memory.
*/
const network = {
  lookup: vi.spyOn(dnsPromises, "lookup").mockImplementation(async () => {
    throw new Error("no DNS in this test");
  }),
  request: vi.spyOn(https, "request").mockImplementation(() => {
    throw new Error("no HTTPS in this test");
  }),
};
syncBuiltinESMExports();

afterAll(() => {
  network.lookup.mockRestore();
  network.request.mockRestore();
  syncBuiltinESMExports();
});

afterEach(() => {
  vi.useRealTimers();
  network.lookup.mockClear();
  network.request.mockClear();
});

const baseUrl = "https://requestport.com";
const origin = "https://agents.example";
const clientIdUrl = `${origin}/client.json`;
const redirectUri = "http://127.0.0.1:43210/callback";

type Store = Record<string, Record<string, unknown>[]>;

function emptyStore(): Store {
  return {
    user: [],
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
}

type Transport = NonNullable<
  Parameters<typeof createAuthOptions>[0]["fetchClientMetadataResource"]
>;

/**
 * The composition under test. `cimd` and `allowedOrigins` default to on and
 * the one listed origin only when the key is absent: an explicit `undefined`
 * means unset.
 */
function options(
  input: {
    store?: Store;
    cimd?: string | undefined;
    allowedOrigins?: string | undefined;
    transport?: Transport;
    guarded?: boolean;
  } = {},
) {
  const database = memoryAdapter(input.store ?? emptyStore());
  return createAuthOptions({
    database:
      input.guarded === false ? database : wrapCimdClientGuardAdapter(database),
    env: {
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: "cimd-integration-secret".padEnd(32, "!"),
      BETTER_AUTH_URL: baseUrl,
      REQUESTPORT_OAUTH_CIMD: "cimd" in input ? input.cimd : "enabled",
      REQUESTPORT_OAUTH_CIMD_ALLOWED_ORIGINS:
        "allowedOrigins" in input ? input.allowedOrigins : origin,
    },
    assertSignupAllowed: async () => ({ allowed: true }),
    ...(input.transport
      ? { fetchClientMetadataResource: input.transport }
      : {}),
  });
}

function document(overrides: Record<string, unknown> = {}) {
  return {
    client_id: clientIdUrl,
    client_name: "A CIMD agent",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...overrides,
  };
}

/** A transport that serves one document per URL and records every call. */
function fakeTransport(documents: Record<string, unknown>) {
  const calls: { url: string; redirect: RequestRedirect | undefined }[] = [];
  const transport: Transport = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, redirect: init?.redirect });
    const body = documents[url];
    if (body instanceof Response) return body;
    if (body === undefined) return new Response(null, { status: 404 });
    return Response.json(body, {
      headers: { "cache-control": "max-age=60" },
    });
  };
  return { transport, calls };
}

function authorizeUrl(clientId = clientIdUrl, redirect = redirectUri) {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope: "offline_access request:read",
    state: randomUUID(),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  })) {
    url.searchParams.set(key, value);
  }
  return url;
}

/**
 * Where authorization sends a person with no session: to sign in, once the
 * client resolved; anywhere else means the client did not.
 */
async function authorize(
  auth: { handler: (request: Request) => Promise<Response> },
  clientId?: string,
  redirect?: string,
) {
  const response = await auth.handler(
    new Request(authorizeUrl(clientId, redirect), { redirect: "manual" }),
  );
  const location = response.headers.get("location");
  const body = location
    ? null
    : ((await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null);
  const target = location
    ? new URL(location, baseUrl)
    : typeof body?.url === "string"
      ? new URL(body.url, baseUrl)
      : null;
  return { status: response.status, target, body };
}

function resolved(outcome: Awaited<ReturnType<typeof authorize>>) {
  return outcome.target?.pathname === "/sign-in";
}

function storedClient(store: Store, clientId = clientIdUrl) {
  return store.oauthClient?.find((row) => row.clientId === clientId);
}

describe("composing CIMD", () => {
  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["only commas", ",,"],
    ["http", "http://agents.example"],
    ["userinfo", "https://user@agents.example"],
    ["a path", "https://agents.example/clients"],
    ["a query", "https://agents.example?x=1"],
    ["a fragment", "https://agents.example#x"],
    ["a wildcard", "https://*.agents.example"],
  ])(
    "throws, naming the list, when the switch is on and the list is %s",
    (_, list) => {
      expect(() => options({ allowedOrigins: list })).toThrow(
        CIMD_ALLOWED_ORIGINS_VARIABLE,
      );
    },
  );

  test.each([undefined, "", "https://*.agents.example"])(
    "ignores the list when the switch is off (%s)",
    (list) => {
      for (const cimd of [undefined, "", "disabled", "yes"]) {
        expect(() => options({ cimd, allowedOrigins: list })).not.toThrow();
        expect(
          options({ cimd, allowedOrigins: list }).plugins.map(
            (plugin) => plugin.id,
          ),
        ).not.toContain("cimd");
      }
    },
  );

  test("composes the plugin only when the switch is exactly enabled", () => {
    expect(options({}).plugins.map((plugin) => plugin.id)).toContain("cimd");
  });
});

describe("a URL client_id, over a fake transport", () => {
  test("registers from a document whose client_id matches, from a listed origin", async () => {
    const store = emptyStore();
    const { transport, calls } = fakeTransport({
      [clientIdUrl]: document(),
    });
    const auth = betterAuth(options({ store, transport }));

    expect(resolved(await authorize(auth))).toBe(true);
    expect(calls).toEqual([{ url: clientIdUrl, redirect: "error" }]);
    expect(storedClient(store)).toMatchObject({
      clientId: clientIdUrl,
      clientDiscoveryId: "cimd",
      tokenEndpointAuthMethod: "none",
    });
  });

  test("refuses a document whose client_id is not the URL it was fetched from", async () => {
    const store = emptyStore();
    const { transport } = fakeTransport({
      [clientIdUrl]: document({ client_id: `${origin}/other.json` }),
    });
    const auth = betterAuth(options({ store, transport }));

    expect(resolved(await authorize(auth))).toBe(false);
    expect(storedClient(store)).toBeUndefined();
  });

  test("refuses an authorisation to a redirect_uri the document does not list", async () => {
    const store = emptyStore();
    const { transport } = fakeTransport({ [clientIdUrl]: document() });
    const auth = betterAuth(options({ store, transport }));

    const outcome = await authorize(
      auth,
      clientIdUrl,
      "http://127.0.0.1:1/elsewhere",
    );

    expect(resolved(outcome)).toBe(false);
    // The client itself registers from its document, with the document's
    // redirects and no other.
    expect(storedClient(store)?.redirectUris).toEqual([redirectUri]);
  });

  test("is refused with the switch off, whatever the list holds", async () => {
    const store = emptyStore();
    const { transport, calls } = fakeTransport({
      [clientIdUrl]: document(),
    });
    const auth = betterAuth(
      options({ store, transport, cimd: undefined, allowedOrigins: origin }),
    );

    expect(resolved(await authorize(auth))).toBe(false);
    expect(calls).toEqual([]);
    expect(storedClient(store)).toBeUndefined();
  });
});

/*
  Ruling 38: after K.2, both consent gates admit only clients whose token
  endpoint method is `none`, so a CIMD client declaring anything else is
  refused where its row is written (`wrapCimdClientGuardAdapter`).
*/
describe("only public CIMD clients", () => {
  const jwksUri = `${origin}/jwks.json`;

  test.each([
    ["names none", document()],
    [
      "omits the method",
      (() => {
        const { token_endpoint_auth_method: _, ...body } = document();
        return body;
      })(),
    ],
  ])("a document that %s registers as none", async (_, body) => {
    const store = emptyStore();
    const { transport } = fakeTransport({ [clientIdUrl]: body });
    const auth = betterAuth(options({ store, transport }));

    expect(resolved(await authorize(auth))).toBe(true);
    expect(storedClient(store)?.tokenEndpointAuthMethod).toBe("none");
  });

  async function refusedPrivateKeyJwt(guarded: boolean) {
    const store = emptyStore();
    const { transport, calls } = fakeTransport({
      [clientIdUrl]: document({
        token_endpoint_auth_method: "private_key_jwt",
        jwks_uri: jwksUri,
      }),
    });
    const auth = betterAuth(options({ store, transport, guarded }));
    const outcome = await authorize(auth);
    return { auth, store, calls, outcome };
  }

  test("a private_key_jwt document is refused, writes nothing and never fetches its jwks_uri", async () => {
    const { auth, store, calls, outcome } = await refusedPrivateKeyJwt(true);

    expect(resolved(outcome)).toBe(false);
    expect(JSON.stringify(outcome)).toContain("invalid_client_metadata");
    expect(storedClient(store)).toBeUndefined();
    expect(calls).toEqual([{ url: clientIdUrl, redirect: "error" }]);

    // A token request authenticating as that client with an assertion is
    // refused too, and still never reaches the jwks_uri.
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(clientIdUrl)
      .setSubject(clientIdUrl)
      .setAudience(`${baseUrl}/api/auth/oauth2/token`)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(new TextEncoder().encode("a".repeat(32)));
    const token = await auth.handler(
      new Request(`${baseUrl}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "not-a-code",
          redirect_uri: redirectUri,
          code_verifier: "v".repeat(43),
          client_id: clientIdUrl,
          client_assertion_type:
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        }).toString(),
      }),
    );
    expect(token.ok).toBe(false);
    expect(calls.map((call) => call.url)).not.toContain(jwksUri);
  });

  test("with the guard removed from the composition, the same document registers", async () => {
    const { store, outcome } = await refusedPrivateKeyJwt(false);

    expect(resolved(outcome)).toBe(true);
    expect(storedClient(store)?.tokenEndpointAuthMethod).toBe(
      "private_key_jwt",
    );
  });

  test("a client whose document turns private_key_jwt is refused once the cache expires, and keeps none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = emptyStore();
    const documents: Record<string, unknown> = { [clientIdUrl]: document() };
    const { transport } = fakeTransport(documents);
    const auth = betterAuth(options({ store, transport }));
    expect(resolved(await authorize(auth))).toBe(true);

    documents[clientIdUrl] = document({
      token_endpoint_auth_method: "private_key_jwt",
      jwks_uri: jwksUri,
    });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1_000);

    expect(resolved(await authorize(auth))).toBe(false);
    expect(storedClient(store)?.tokenEndpointAuthMethod).toBe("none");
  });

  test("a none document naming a jwks_uri registers, and a client assertion never fetches it", async () => {
    const store = emptyStore();
    const { transport, calls } = fakeTransport({
      [clientIdUrl]: document({ jwks_uri: jwksUri }),
    });
    const auth = betterAuth(options({ store, transport }));
    expect(resolved(await authorize(auth))).toBe(true);

    const token = await auth.handler(
      new Request(`${baseUrl}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "not-a-code",
          redirect_uri: redirectUri,
          code_verifier: "v".repeat(43),
          client_id: clientIdUrl,
          client_assertion_type:
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: "a.b.c",
        }).toString(),
      }),
    );
    expect(token.ok).toBe(false);
    expect(calls.map((call) => call.url)).not.toContain(jwksUri);
  });
});

describe("the allowlist, at the network boundary", () => {
  test("a redirect to another origin is refused, after exactly one fetch that forbade redirects", async () => {
    const store = emptyStore();
    const { transport, calls } = fakeTransport({
      [clientIdUrl]: new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/client.json" },
      }),
    });
    const auth = betterAuth(options({ store, transport }));

    expect(resolved(await authorize(auth))).toBe(false);
    expect(calls).toEqual([{ url: clientIdUrl, redirect: "error" }]);
    expect(storedClient(store)).toBeUndefined();
  });

  test("a client from an origin taken off the list is refused at its next authorisation", async () => {
    const store = emptyStore();
    const { transport } = fakeTransport({ [clientIdUrl]: document() });
    expect(
      resolved(await authorize(betterAuth(options({ store, transport })))),
    ).toBe(true);

    const narrowed = betterAuth(
      options({ store, transport, allowedOrigins: "https://other.example" }),
    );

    expect(resolved(await authorize(narrowed))).toBe(false);
  });

  test("an unlisted client_id reaches neither DNS nor HTTPS through the real transport", async () => {
    const auth = betterAuth(options({}));

    const outcome = await authorize(auth, "https://unlisted.example/c.json");

    expect(resolved(outcome)).toBe(false);
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.request).not.toHaveBeenCalled();
  });

  test("without the predicate, the same client_id reaches DNS, so the case above can fail", async () => {
    const { cimd } = await import("@better-auth/cimd");
    const { fetchClientMetadataResource } = await import(
      "@better-auth/cimd/node"
    );
    const composed = options({ cimd: undefined });
    const auth = betterAuth({
      ...composed,
      plugins: [
        ...composed.plugins,
        cimd({
          fetchClientMetadataResource,
          metadataProfile: "mcp-2026-07-28",
        }),
      ],
    });

    await authorize(auth, "https://unlisted.example/c.json");

    expect(network.lookup).toHaveBeenCalledWith("unlisted.example", {
      all: true,
      verbatim: true,
    });
  });
});
