import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  AGENT_SCOPES,
  type AuthorizationServerMetadata,
  buildAuthorizationUrl,
  createPkce,
  createState,
  discover,
  exchangeCode,
  type FetchLike,
  OAuthError,
  REFRESH_SCOPE,
  readCallback,
  refresh,
  registerClient,
  TokenRequestError,
  WELL_KNOWN_PATH,
} from "./oauth.js";

const SERVER = "https://requestport.com";
const DISCOVERY = `${SERVER}/.well-known/oauth-authorization-server`;
const AUTHORIZE = `${SERVER}/api/auth/oauth2/authorize`;
const TOKEN = `${SERVER}/api/auth/oauth2/token`;
const REGISTER = `${SERVER}/api/auth/oauth2/register`;

/** A loopback listener, which is how a CLI receives the redirect. */
const REDIRECT = "http://127.0.0.1:41903/callback";

const SCOPES = ["work:claim", "request:read"];

/** Distinctive so a test can prove they appear in no error text. */
const CODE = "authcode-51f0-never-log-me";
const VERIFIER_SEED = "verifier-9c3a-never-log-me";
const ACCESS_TOKEN = "access-7b21-never-log-me";
const REFRESH_TOKEN = "refresh-3d84-never-log-me";

/** What requestport.com actually publishes at the well-known path. */
const published = {
  issuer: SERVER,
  authorization_endpoint: AUTHORIZE,
  token_endpoint: TOKEN,
  registration_endpoint: REGISTER,
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  response_types_supported: ["code"],
  scopes_supported: [...AGENT_SCOPES, REFRESH_SCOPE, "openid"],
};

type Call = { url: string; init: RequestInit | undefined };

/**
 * Every test drives a stub. Nothing here may reach requestport.com — a test
 * suite that talks to the real authorization server is a test suite that fails
 * on a plane and registers junk clients when it does not.
 */
function stub(handler: (url: string, init?: RequestInit) => Response): {
  calls: Call[];
  fetch: FetchLike;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ init, url });
      return Promise.resolve(handler(url, init));
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function only(calls: Call[]): Call {
  expect(calls).toHaveLength(1);
  return calls[0] as Call;
}

function form(call: Call): URLSearchParams {
  return new URLSearchParams(String(call.init?.body));
}

/** `undefined` in an override drops the key, because `JSON.stringify` does. */
function metadataStub(overrides: Record<string, unknown> = {}) {
  return stub(() => json({ ...published, ...overrides }));
}

function discovered(
  overrides: Record<string, unknown> = {},
): Promise<AuthorizationServerMetadata> {
  return discover(SERVER, metadataStub(overrides).fetch);
}

/** Message, stack and any field an author might add later. */
function everythingOn(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return JSON.stringify(error, Object.getOwnPropertyNames(error));
}

async function thrownBy(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, and it did not");
}

/**
 * Discovery decides where every later credential is sent.
 *
 * The document names the endpoints, so a document from the wrong place is not a
 * configuration mistake — it is a redirect of the token exchange to somebody
 * else's server. Everything here refuses rather than proceeds.
 */
describe("discovering the authorization server", () => {
  test("reads the well-known document from the server's own origin", async () => {
    const server = metadataStub();
    const metadata = await discover(SERVER, server.fetch);

    expect(only(server.calls).url).toBe(DISCOVERY);
    expect(WELL_KNOWN_PATH).toBe("/.well-known/oauth-authorization-server");
    expect(metadata.token_endpoint).toBe(TOKEN);
    expect(metadata.authorization_endpoint).toBe(AUTHORIZE);
    expect(metadata.registration_endpoint).toBe(REGISTER);
  });

  test("tolerates a server url written with a trailing slash", async () => {
    const server = metadataStub();
    await discover(`${SERVER}/`, server.fetch);

    expect(only(server.calls).url).toBe(DISCOVERY);
  });

  test("refuses metadata whose issuer is a different origin", async () => {
    const foreign = "https://requestport.com.evil.example";
    const server = metadataStub({
      authorization_endpoint: `${foreign}/api/auth/oauth2/authorize`,
      issuer: foreign,
      registration_endpoint: `${foreign}/api/auth/oauth2/register`,
      token_endpoint: `${foreign}/api/auth/oauth2/token`,
    });

    await expect(discover(SERVER, server.fetch)).rejects.toThrow(OAuthError);
    await expect(
      discover(SERVER, metadataStub({ issuer: foreign }).fetch),
    ).rejects.toThrow(/issuer/iu);
  });

  test("refuses an endpoint hosted somewhere other than the issuer", async () => {
    await expect(
      discovered({ token_endpoint: "https://evil.example/token" }),
    ).rejects.toThrow(/token_endpoint/u);

    await expect(
      discovered({ authorization_endpoint: "https://evil.example/authorize" }),
    ).rejects.toThrow(/authorization_endpoint/u);

    await expect(
      discovered({ registration_endpoint: "https://evil.example/register" }),
    ).rejects.toThrow(/registration_endpoint/u);
  });

  test("refuses a server that cannot do PKCE S256", async () => {
    await expect(
      discovered({ code_challenge_methods_supported: ["plain"] }),
    ).rejects.toThrow(/S256/u);

    await expect(
      discovered({ code_challenge_methods_supported: undefined }),
    ).rejects.toThrow(OAuthError);
  });

  test("refuses metadata with an endpoint missing", async () => {
    await expect(discovered({ token_endpoint: undefined })).rejects.toThrow(
      /token_endpoint/u,
    );
    await expect(
      discovered({ authorization_endpoint: undefined }),
    ).rejects.toThrow(/authorization_endpoint/u);
  });

  test("names the endpoint and status when discovery fails", async () => {
    const server = stub(() => json({ error: "nope" }, 503));

    await expect(discover(SERVER, server.fetch)).rejects.toThrow(/503/u);
    await expect(discover(SERVER, server.fetch)).rejects.toThrow(
      /oauth-authorization-server/u,
    );
  });

  /**
   * RFC 9207's flag is what tells the client every authorization response
   * will name its issuer, so it is read rather than dropped with the other
   * fields the schema does not know.
   */
  test("reads whether the server names its issuer in every authorization response", async () => {
    const advertised = await discovered({
      authorization_response_iss_parameter_supported: true,
    });
    const silent = await discovered();

    expect(advertised.authorization_response_iss_parameter_supported).toBe(
      true,
    );
    expect(silent.authorization_response_iss_parameter_supported).toBe(
      undefined,
    );
    await expect(
      discovered({ authorization_response_iss_parameter_supported: "yes" }),
    ).rejects.toThrow(/authorization_response_iss_parameter_supported/u);
  });

  test("refuses a discovery response that is not JSON", async () => {
    const server = stub(() => new Response("<html>login</html>"));

    await expect(discover(SERVER, server.fetch)).rejects.toThrow(OAuthError);
  });
});

/**
 * PKCE is the only thing standing between a stolen code and a token, because a
 * public client has no secret to fall back on.
 */
describe("PKCE", () => {
  test("derives the challenge from the verifier with S256", () => {
    const pkce = createPkce();

    expect(pkce.method).toBe("S256");
    expect(pkce.challenge).toBe(
      createHash("sha256").update(pkce.verifier).digest("base64url"),
    );
    expect(pkce.challenge).not.toBe(pkce.verifier);
  });

  test("produces a verifier of the length and alphabet RFC 7636 allows", () => {
    expect(createPkce().verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/u);
  });

  test("never repeats a verifier or a state", () => {
    const verifiers = new Set<string>();
    const states = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      verifiers.add(createPkce().verifier);
      states.add(createState());
    }

    expect(verifiers.size).toBe(200);
    expect(states.size).toBe(200);
    for (const state of states) expect(state.length).toBeGreaterThanOrEqual(22);
  });
});

/**
 * The agent registers itself, as a public client, every time it needs to.
 *
 * A public client is the honest description of something running on a
 * developer's laptop: there is nowhere to keep a secret that the developer
 * cannot read, so we ask for none and prove possession with PKCE instead.
 */
describe("registering the agent as a client", () => {
  test("posts public-client metadata to the registration endpoint", async () => {
    const server = stub(() => json({ client_id: "client-123" }));
    const metadata = await discovered();

    const client = await registerClient(
      {
        clientName: "requestport-agent",
        metadata,
        redirectUri: REDIRECT,
        scopes: SCOPES,
      },
      server.fetch,
    );

    const call = only(server.calls);
    expect(call.url).toBe(REGISTER);
    expect(call.init?.method).toBe("POST");
    expect(new Headers(call.init?.headers).get("content-type")).toBe(
      "application/json",
    );

    const body = JSON.parse(String(call.init?.body));
    expect(body).toMatchObject({
      client_name: "requestport-agent",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT],
      require_pkce: true,
      response_types: ["code"],
      scope: "work:claim request:read",
      token_endpoint_auth_method: "none",
    });
    expect(client.client_id).toBe("client-123");
  });

  test("refuses a registration that hands back a client secret", async () => {
    const server = stub(() =>
      json({ client_id: "client-123", client_secret: "shhh" }),
    );
    const metadata = await discovered();

    const error = await thrownBy(() =>
      registerClient(
        {
          clientName: "requestport-agent",
          metadata,
          redirectUri: REDIRECT,
          scopes: SCOPES,
        },
        server.fetch,
      ),
    );

    expect(error).toBeInstanceOf(OAuthError);
    expect(everythingOn(error)).not.toContain("shhh");
  });

  test("refuses a server that offers no registration endpoint", async () => {
    const metadata = await discovered({ registration_endpoint: undefined });
    const server = stub(() => json({ client_id: "client-123" }));

    await expect(
      registerClient(
        {
          clientName: "requestport-agent",
          metadata,
          redirectUri: REDIRECT,
          scopes: SCOPES,
        },
        server.fetch,
      ),
    ).rejects.toThrow(/registration/iu);
    expect(server.calls).toHaveLength(0);
  });

  test("names the endpoint and status when registration is refused", async () => {
    const server = stub(() => json({ error: "invalid_client_metadata" }, 400));
    const metadata = await discovered();

    await expect(
      registerClient(
        {
          clientName: "requestport-agent",
          metadata,
          redirectUri: REDIRECT,
          scopes: SCOPES,
        },
        server.fetch,
      ),
    ).rejects.toThrow(/400/u);
  });
});

/**
 * The URL the developer opens. It carries the challenge and never the verifier
 * — the verifier stays in this process, which is the whole of PKCE.
 */
describe("building the authorization url", () => {
  test("carries the challenge, the state and the scopes", async () => {
    const metadata = await discovered();
    const request = buildAuthorizationUrl({
      clientId: "client-123",
      metadata,
      redirectUri: REDIRECT,
      scopes: SCOPES,
    });
    const url = new URL(request.url);
    const query = url.searchParams;

    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE);
    expect(query.get("response_type")).toBe("code");
    expect(query.get("client_id")).toBe("client-123");
    expect(query.get("redirect_uri")).toBe(REDIRECT);
    expect(query.get("scope")).toBe("work:claim request:read");
    expect(query.get("state")).toBe(request.state);
    expect(query.get("code_challenge")).toBe(request.pkce.challenge);
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(request.url).not.toContain(request.pkce.verifier);
  });

  test("asks for S256 even when the server also offers plain", async () => {
    const metadata = await discovered({
      code_challenge_methods_supported: ["plain", "S256"],
    });
    const request = buildAuthorizationUrl({
      clientId: "client-123",
      metadata,
      redirectUri: REDIRECT,
      scopes: SCOPES,
    });

    expect(new URL(request.url).searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
  });

  test("passes the audience through when one is asked for", async () => {
    const metadata = await discovered();
    const request = buildAuthorizationUrl({
      clientId: "client-123",
      metadata,
      redirectUri: REDIRECT,
      resource: `${SERVER}/mcp`,
      scopes: SCOPES,
    });

    expect(new URL(request.url).searchParams.get("resource")).toBe(
      `${SERVER}/mcp`,
    );
  });

  test("generates a fresh state and verifier for every flow", async () => {
    const metadata = await discovered();
    const options = {
      clientId: "client-123",
      metadata,
      redirectUri: REDIRECT,
      scopes: SCOPES,
    };
    const first = buildAuthorizationUrl(options);
    const second = buildAuthorizationUrl(options);

    expect(first.state).not.toBe(second.state);
    expect(first.pkce.verifier).not.toBe(second.pkce.verifier);
  });

  test("refuses a scope set that is empty or carries a space", async () => {
    const metadata = await discovered();

    expect(() =>
      buildAuthorizationUrl({
        clientId: "client-123",
        metadata,
        redirectUri: REDIRECT,
        scopes: [],
      }),
    ).toThrow(OAuthError);

    expect(() =>
      buildAuthorizationUrl({
        clientId: "client-123",
        metadata,
        redirectUri: REDIRECT,
        scopes: ["work:claim request:triage"],
      }),
    ).toThrow(/scope/iu);
  });

  test("refuses a redirect that is neither https nor loopback", async () => {
    const metadata = await discovered();

    for (const redirectUri of [
      "http://example.com/callback",
      "http://127.0.0.1:41903/callback#fragment",
      "not a url",
    ]) {
      expect(() =>
        buildAuthorizationUrl({
          clientId: "client-123",
          metadata,
          redirectUri,
          scopes: SCOPES,
        }),
      ).toThrow(OAuthError);
    }
  });
});

/**
 * The callback is the one message in the flow that arrives from a browser, so
 * it is the one an attacker can try to write. The state is what says this
 * authorization is the one this process started.
 */
describe("reading the callback", () => {
  test("returns the code when the state matches", () => {
    const state = createState();
    const callback = `${REDIRECT}?code=${CODE}&state=${encodeURIComponent(state)}`;

    expect(readCallback(callback, { state }).code).toBe(CODE);
  });

  test("refuses a state that does not match, echoing neither it nor the code", () => {
    const callback = `${REDIRECT}?code=${CODE}&state=${createState()}`;
    const error = thrownSync(() =>
      readCallback(callback, { state: createState() }),
    );

    expect(error).toBeInstanceOf(OAuthError);
    expect(everythingOn(error)).not.toContain(CODE);
    expect(String(error)).toMatch(/state/iu);
  });

  test("refuses a callback with no state at all", () => {
    expect(() =>
      readCallback(`${REDIRECT}?code=${CODE}`, { state: createState() }),
    ).toThrow(OAuthError);
  });

  test("refuses a callback with no code", () => {
    const state = createState();

    expect(() =>
      readCallback(`${REDIRECT}?state=${encodeURIComponent(state)}`, { state }),
    ).toThrow(OAuthError);
  });

  test("reports the error the server sent instead of a code", () => {
    const state = createState();
    const callback = `${REDIRECT}?error=access_denied&state=${encodeURIComponent(state)}`;

    expect(() => readCallback(callback, { state })).toThrow(/access_denied/u);
  });
});

/**
 * RFC 9207: the response names the authorization server that sent it.
 *
 * A client that talks to more than one authorization server can be handed a
 * response from one while it believes it is finishing a flow with another —
 * the mix-up attack — and the code then goes to the wrong token endpoint. The
 * `iss` parameter is the server's own name for itself, compared exactly with
 * the issuer discovery established (§2.4).
 */
describe("reading the callback's issuer", () => {
  const FOREIGN = "https://requestport.com.evil.example";

  function landing(state: string, extra: Record<string, string>): string {
    const url = new URL(REDIRECT);
    url.searchParams.set("code", CODE);
    url.searchParams.set("state", state);
    for (const [name, value] of Object.entries(extra)) {
      url.searchParams.set(name, value);
    }
    return url.toString();
  }

  test("accepts a callback that names the expected issuer", () => {
    const state = createState();

    expect(
      readCallback(landing(state, { iss: SERVER }), {
        issuer: { identifier: SERVER, required: true },
        state,
      }).code,
    ).toBe(CODE);
  });

  test("refuses a callback with no issuer when the server promised one", () => {
    const state = createState();
    const error = thrownSync(() =>
      readCallback(landing(state, {}), {
        issuer: { identifier: SERVER, required: true },
        state,
      }),
    );

    expect(error).toBeInstanceOf(OAuthError);
    expect(String(error)).toMatch(/issuer/iu);
    expect(everythingOn(error)).not.toContain(CODE);
  });

  test("refuses a callback that names another issuer, without repeating its name", () => {
    const state = createState();
    const error = thrownSync(() =>
      readCallback(landing(state, { iss: FOREIGN }), {
        issuer: { identifier: SERVER, required: true },
        state,
      }),
    );

    expect(error).toBeInstanceOf(OAuthError);
    expect(String(error)).toContain(SERVER);
    expect(everythingOn(error)).not.toContain("evil.example");
    expect(everythingOn(error)).not.toContain(CODE);
  });

  /**
   * "For error responses, clients MUST NOT assume that the error originates
   * from the intended authorization server" (§2.4). So the issuer is judged
   * before the error is believed, and a foreign one is reported as foreign.
   */
  test("judges the issuer before it believes an error the callback carries", () => {
    const state = createState();
    const url = new URL(REDIRECT);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("state", state);
    url.searchParams.set("iss", FOREIGN);

    expect(() =>
      readCallback(url.toString(), {
        issuer: { identifier: SERVER, required: true },
        state,
      }),
    ).toThrow(/issuer/iu);
  });

  test("compares the issuer exactly, so a trailing slash is another issuer", () => {
    const state = createState();

    expect(() =>
      readCallback(landing(state, { iss: `${SERVER}/` }), {
        issuer: { identifier: SERVER, required: true },
        state,
      }),
    ).toThrow(OAuthError);
  });

  test("accepts a callback with no issuer from a server that never promised one", () => {
    const state = createState();

    expect(
      readCallback(landing(state, {}), {
        issuer: { identifier: SERVER, required: false },
        state,
      }).code,
    ).toBe(CODE);
  });

  /**
   * RFC 9207 leaves a server that sends `iss` without advertising it to local
   * policy. This one's: a name that is present is compared, advertised or
   * not, because a foreign issuer is foreign either way.
   */
  test("still refuses a foreign issuer from a server that never promised one", () => {
    const state = createState();

    expect(() =>
      readCallback(landing(state, { iss: FOREIGN }), {
        issuer: { identifier: SERVER, required: false },
        state,
      }),
    ).toThrow(/issuer/iu);
  });
});

/**
 * The exchange is where the secrets are. Nothing about it may reach a log, an
 * error message or a stack — a token in a traceback outlives the process it
 * came from.
 */
describe("exchanging the code for tokens", () => {
  const tokens = {
    access_token: ACCESS_TOKEN,
    expires_in: 900,
    refresh_token: REFRESH_TOKEN,
    scope: "work:claim request:read",
    token_type: "Bearer",
  };

  test("posts the code and the verifier to the token endpoint", async () => {
    const server = stub(() => json(tokens));
    const metadata = await discovered();

    const result = await exchangeCode(
      {
        clientId: "client-123",
        code: CODE,
        metadata,
        redirectUri: REDIRECT,
        verifier: VERIFIER_SEED,
      },
      server.fetch,
    );

    const call = only(server.calls);
    expect(call.url).toBe(TOKEN);
    expect(call.init?.method).toBe("POST");
    expect(new Headers(call.init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );

    const body = form(call);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe(CODE);
    expect(body.get("code_verifier")).toBe(VERIFIER_SEED);
    expect(body.get("client_id")).toBe("client-123");
    expect(body.get("redirect_uri")).toBe(REDIRECT);
    expect(result.access_token).toBe(ACCESS_TOKEN);
    expect(result.refresh_token).toBe(REFRESH_TOKEN);
    expect(result.expires_in).toBe(900);
  });

  test("refuses a token response that is not a Bearer token", async () => {
    const server = stub(() => json({ ...tokens, token_type: "mac" }));
    const metadata = await discovered();

    await expect(
      exchangeCode(
        {
          clientId: "client-123",
          code: CODE,
          metadata,
          redirectUri: REDIRECT,
          verifier: VERIFIER_SEED,
        },
        server.fetch,
      ),
    ).rejects.toThrow(OAuthError);
  });

  test("refuses a token response with no access token", async () => {
    const server = stub(() => json({ token_type: "Bearer" }));
    const metadata = await discovered();

    await expect(
      exchangeCode(
        {
          clientId: "client-123",
          code: CODE,
          metadata,
          redirectUri: REDIRECT,
          verifier: VERIFIER_SEED,
        },
        server.fetch,
      ),
    ).rejects.toThrow(OAuthError);
  });

  test("throws without the code, verifier or token when the exchange fails", async () => {
    const server = stub(() =>
      json(
        {
          error: "invalid_grant",
          error_description: `code ${CODE} is spent, token ${ACCESS_TOKEN}`,
        },
        400,
      ),
    );
    const metadata = await discovered();

    const error = await thrownBy(() =>
      exchangeCode(
        {
          clientId: "client-123",
          code: CODE,
          metadata,
          redirectUri: REDIRECT,
          verifier: VERIFIER_SEED,
        },
        server.fetch,
      ),
    );

    const text = everythingOn(error);
    expect(error).toBeInstanceOf(OAuthError);
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(VERIFIER_SEED);
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).toContain(TOKEN);
    expect(text).toContain("400");
  });
});

/**
 * Refreshing is the same exchange with a longer-lived secret, so it gets the
 * same silence on failure.
 */
describe("refreshing", () => {
  test("posts the refresh token and returns the new one", async () => {
    const server = stub(() =>
      json({
        access_token: "access-next",
        refresh_token: "refresh-next",
        token_type: "Bearer",
      }),
    );
    const metadata = await discovered();

    const result = await refresh(
      {
        clientId: "client-123",
        metadata,
        refreshToken: REFRESH_TOKEN,
      },
      server.fetch,
    );

    const body = form(only(server.calls));
    expect(only(server.calls).url).toBe(TOKEN);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(REFRESH_TOKEN);
    expect(body.get("client_id")).toBe("client-123");
    expect(result.access_token).toBe("access-next");
    expect(result.refresh_token).toBe("refresh-next");
  });

  test("narrows scope only when asked to", async () => {
    const server = stub(() =>
      json({ access_token: "access-next", token_type: "Bearer" }),
    );
    const metadata = await discovered();

    await refresh(
      {
        clientId: "client-123",
        metadata,
        refreshToken: REFRESH_TOKEN,
        scopes: ["request:read"],
      },
      server.fetch,
    );

    expect(form(only(server.calls)).get("scope")).toBe("request:read");
  });

  test("throws without the refresh token when the server refuses", async () => {
    const server = stub(() => json({ error: "invalid_grant" }, 401));
    const metadata = await discovered();

    const error = await thrownBy(() =>
      refresh(
        { clientId: "client-123", metadata, refreshToken: REFRESH_TOKEN },
        server.fetch,
      ),
    );

    const text = everythingOn(error);
    expect(error).toBeInstanceOf(OAuthError);
    expect(text).not.toContain(REFRESH_TOKEN);
    expect(text).toContain("401");
  });

  /**
   * The provider answers `400 invalid_grant` to every refresh token it will
   * not honour: unknown, issued to another client, expired, or already
   * rotated. A caller has to tell that apart from a server that is merely
   * failing, because only the first means "authorize again". The code is a
   * word from RFC 6749 §5.2's fixed set (with RFC 8707's `invalid_target`),
   * so it can be repeated; the description is free text, which a provider
   * may fill with the token it refused, so it never is.
   */
  test("names the refusal's error code, and nothing from its description", async () => {
    const server = stub(() =>
      json(
        {
          error: "invalid_grant",
          error_description: `the token ${REFRESH_TOKEN} was rotated`,
        },
        400,
      ),
    );
    const metadata = await discovered();

    const error = await thrownBy(() =>
      refresh(
        { clientId: "client-123", metadata, refreshToken: REFRESH_TOKEN },
        server.fetch,
      ),
    );

    expect(error).toBeInstanceOf(TokenRequestError);
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as TokenRequestError).error).toBe("invalid_grant");
    expect((error as TokenRequestError).status).toBe(400);
    const text = everythingOn(error);
    expect(text).toContain("invalid_grant");
    expect(text).not.toContain(REFRESH_TOKEN);
    expect(text).not.toContain("rotated");
  });

  test.each([
    [
      "an error that is not one of the fixed set",
      json({ error: `invalid_grant ${REFRESH_TOKEN}` }, 400),
    ],
    ["an error that is not a string", json({ error: 42 }, 400)],
    [
      "a body that is not JSON",
      new Response(`<p>${REFRESH_TOKEN}</p>`, { status: 503 }),
    ],
  ])("names no code for %s", async (_case, response) => {
    const server = stub(() => response);
    const metadata = await discovered();

    const error = await thrownBy(() =>
      refresh(
        { clientId: "client-123", metadata, refreshToken: REFRESH_TOKEN },
        server.fetch,
      ),
    );

    expect(error).toBeInstanceOf(TokenRequestError);
    expect((error as TokenRequestError).error).toBeUndefined();
    expect(everythingOn(error)).not.toContain(REFRESH_TOKEN);
  });
});

/**
 * A grant with no `offline_access` yields no refresh token, so the developer
 * re-consents at the first expiry. Naming the scope is what stops that being
 * discovered in production.
 */
describe("the scopes this client knows about", () => {
  test("lists the agent scopes without silently including offline access", () => {
    expect(AGENT_SCOPES).toContain("work:claim");
    expect(AGENT_SCOPES).toContain("request:triage");
    expect(AGENT_SCOPES).not.toContain(REFRESH_SCOPE);
    expect(AGENT_SCOPES).not.toContain("openid");
    expect(REFRESH_SCOPE).toBe("offline_access");
  });
});

function thrownSync(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, and it did not");
}
