import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  AGENT_CLIENT_NAME,
  type Authorization,
  AuthorizationError,
  type AuthorizeDependencies,
  authorize,
  type CallbackReceiver,
} from "./authorize.js";
import {
  type Audience,
  type CredentialStore,
  CredentialStoreError,
  createFileStore,
  createKeychainStore,
  type StoredCredential,
} from "./credentials.js";
import { type FetchLike, OAuthError, REFRESH_SCOPE } from "./oauth.js";
import { fakeKeychain } from "./test-support/fake-keychain.js";

const SERVER = "https://requestport.com";
const DISCOVERY = `${SERVER}/.well-known/oauth-authorization-server`;
const AUTHORIZE = `${SERVER}/api/auth/oauth2/authorize`;
const REGISTER = `${SERVER}/api/auth/oauth2/register`;
const TOKEN = `${SERVER}/api/auth/oauth2/token`;

/** Whatever port the receiver bound. Nothing in the flow may guess one. */
const REDIRECT = "http://127.0.0.1:41903/callback";

const PROJECT_ID = "3f7c1c1e-0b6a-4a0e-9a41-2f1d5c8e7b90";
const CLIENT_ID = "client-123";
const SCOPES = ["work:claim", "request:read"];
const OBTAINED = "2026-01-02T03:04:05.000Z";

/**
 * The three secrets that pass through this flow, spelled without a word of
 * English.
 *
 * The leak assertions slide a six-character window across each of them, so a
 * token written `refresh-…` would match any message that merely says the word
 * and the check would pass for the wrong reason.
 */
const CODE = "Kc9-vT2xQ7-mB4nZ8-pL6";
const REFRESH_TOKEN = "Rx5-hJ3wD9-tG7kV1-sN2";
const ACCESS_TOKEN = "Av8-yU4bE6-qM0jX5-cW3";

/**
 * The two ways a foreign error's `code` property carries something that is not
 * a symbol anyone could look up: a real errno with a value tacked on, and a run
 * of capitals that is nothing but the value. Both fabricated, like every other
 * secret in this file. The first is deliberately short enough to be a plausible
 * code, so that only the shape of the guard can reject it.
 */
const SMUGGLED_AFTER_ERRNO = "EADDRINUSE 8HQ2VN";
const SMUGGLED = "GHP7X4QK2M9WZ0RTVB6NLJ8DCFYS3A1E";

/**
 * Six characters of a secret is six an attacker no longer has to guess, so the
 * check is for any recognisable run of one rather than for the whole string.
 * `credentials.test.ts` uses the same width for the same reason.
 */
const RECOGNISABLE = 6;

/** What requestport.com publishes at the well-known path. */
const published = {
  authorization_endpoint: AUTHORIZE,
  authorization_response_iss_parameter_supported: true,
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  issuer: SERVER,
  registration_endpoint: REGISTER,
  response_types_supported: ["code"],
  scopes_supported: [...SCOPES, REFRESH_SCOPE],
  token_endpoint: TOKEN,
};

const tokens = {
  access_token: ACCESS_TOKEN,
  expires_in: 900,
  refresh_token: REFRESH_TOKEN,
  token_type: "Bearer",
};

type Call = { init: RequestInit | undefined; url: string };
type Write = {
  audience: Audience;
  credential: StoredCredential;
  projectId: string;
  server: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/**
 * The callback arrives while `authorize` is already awaiting it, so the test
 * has to be able to answer after the flow has started.
 */
function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    reject = fail;
    resolve = settle;
  });

  return { promise, reject, resolve };
}

/**
 * Where the browser lands: the flow's own redirect, plus a code, a state and
 * the issuer's name, as requestport.com sends them (RFC 9207). `null` for the
 * issuer leaves the parameter out.
 */
function landingFor(
  authorizationUrl: string,
  state?: string,
  issuer: string | null = SERVER,
): string {
  const query = new URL(authorizationUrl).searchParams;
  const landing = new URL(String(query.get("redirect_uri")));
  landing.searchParams.set("code", CODE);
  landing.searchParams.set("state", state ?? String(query.get("state")));
  if (issuer !== null) landing.searchParams.set("iss", issuer);

  return landing.toString();
}

type FlowOptions = {
  readonly arrivalFails?: unknown;
  /** `mcp` unless given; `"absent"` leaves the option out altogether. */
  readonly audience?: Audience | "absent";
  /**
   * What the receiver does to a callback nobody is waiting for yet, which is
   * what this package's own listener does: closing it rejects the pending read.
   */
  readonly arrivalFailsOnClose?: unknown;
  readonly browser?: (url: string) => void | Promise<void>;
  readonly clientName?: string;
  readonly closeFails?: unknown;
  /** A close that fails asynchronously — the other half of `void | Promise`. */
  readonly closeRejects?: unknown;
  readonly landing?: (url: string) => string;
  /** Fields laid over what requestport.com publishes; `undefined` drops one. */
  readonly metadata?: Record<string, unknown>;
  readonly receiverFails?: unknown;
  readonly redirectUri?: string;
  readonly registration?: () => Response;
  readonly scopes?: readonly string[];
  /** A real store in place of the recording one. */
  readonly store?: CredentialStore;
  readonly token?: () => Response;
  readonly writeFails?: unknown;
};

/**
 * The whole flow, with a stub in every place a real one would touch the world.
 *
 * No socket is bound, no browser is opened and nothing is sent to
 * requestport.com — a suite that did any of those would fail on a plane, and
 * would register junk clients against the real server when it did not.
 */
function flow(options: FlowOptions = {}) {
  const calls: Call[] = [];
  const events: string[] = [];
  const opened: string[] = [];
  const urls: string[] = [];
  const writes: Write[] = [];
  const arrival = deferred<string>();
  let closes = 0;
  let clockReads = 0;
  let starts = 0;

  const fetch: FetchLike = (url, init) => {
    calls.push({ init, url });
    if (url === DISCOVERY) {
      events.push("discover");
      return Promise.resolve(json({ ...published, ...options.metadata }));
    }
    if (url === REGISTER) {
      events.push("register");
      const answer =
        options.registration ?? (() => json({ client_id: CLIENT_ID }));
      return Promise.resolve(answer());
    }
    if (url === TOKEN) {
      events.push("exchange");
      const answer = options.token ?? (() => json(tokens));
      return Promise.resolve(answer());
    }

    throw new Error(`the flow reached ${url}, which no test stubbed`);
  };

  const receiver: CallbackReceiver = {
    callback: arrival.promise,
    close() {
      closes += 1;
      events.push("close");
      if (options.arrivalFailsOnClose !== undefined) {
        arrival.reject(options.arrivalFailsOnClose);
      }
      if (options.closeRejects !== undefined) {
        return Promise.reject(options.closeRejects);
      }
      if (options.closeFails !== undefined) throw options.closeFails;
    },
    redirectUri: options.redirectUri ?? REDIRECT,
  };

  const store: CredentialStore = {
    clear() {
      throw new Error("authorizing must not clear a credential");
    },
    hasLegacyRecord() {
      // Naming an earlier client's record is `requestport login`'s, before it
      // calls this; the write below is what removes one.
      throw new Error("authorizing must not look for an earlier record");
    },
    read() {
      // Whether a credential is needed at all is `resolve.ts`'s question, and
      // it is asked before anything reaches this module. A read from here would
      // mean that decision is made twice, in two places, from two rules.
      throw new Error("authorizing must not read a credential");
    },
    write(server, projectId, audience, credential) {
      events.push("write");
      writes.push({ audience, credential, projectId, server });
      if (options.writeFails !== undefined) throw options.writeFails;
    },
  };

  const deps: AuthorizeDependencies = {
    fetch,
    // Known, so that a leak of either is detectable on EVERY path — including
    // the ones that fail before the authorization url exists, where recovering
    // the verifier from the published `code_challenge` is impossible and the
    // assertion used to check nothing at all.
    pkce: () => ({
      challenge: createHash("sha256")
        .update(KNOWN_VERIFIER)
        .digest("base64url"),
      method: "S256",
      verifier: KNOWN_VERIFIER,
    }),
    state: () => KNOWN_STATE,
    now: () => {
      clockReads += 1;
      return OBTAINED;
    },
    onAuthorizationUrl: (url) => {
      events.push("url");
      urls.push(url);
      if (options.arrivalFails !== undefined) {
        arrival.reject(options.arrivalFails);
        return;
      }
      arrival.resolve((options.landing ?? landingFor)(url));
    },
    openBrowser:
      options.browser ??
      ((url) => {
        events.push("browser");
        opened.push(url);
      }),
    startCallbackReceiver: () => {
      starts += 1;
      events.push("receiver");
      if (options.receiverFails !== undefined) throw options.receiverFails;
      return receiver;
    },
  };

  return {
    calls,
    closes: () => closes,
    clockReads: () => clockReads,
    events,
    opened,
    run: (
      overrides: Partial<AuthorizeDependencies> = {},
    ): Promise<Authorization> =>
      authorize({
        ...(options.audience === "absent"
          ? {}
          : { audience: options.audience ?? "mcp" }),
        clientName: options.clientName,
        deps: { ...deps, ...overrides },
        projectId: PROJECT_ID,
        scopes: options.scopes ?? SCOPES,
        server: SERVER,
        store: options.store ?? store,
      } as Parameters<typeof authorize>[0]),
    starts: () => starts,
    urls,
    writes,
  };
}

type Flow = ReturnType<typeof flow>;

function registrationBody(run: Flow): Record<string, unknown> {
  return JSON.parse(
    String(run.calls.find((call) => call.url === REGISTER)?.init?.body),
  );
}

function exchangeBody(run: Flow): URLSearchParams {
  return new URLSearchParams(
    String(run.calls.find((call) => call.url === TOKEN)?.init?.body),
  );
}

function authorizationQuery(run: Flow): URLSearchParams {
  return new URL(String(run.urls[0])).searchParams;
}

/**
 * Everything this flow held that must not outlive it, by name.
 *
 * The state is generated inside the module, so it is read back out of what it
 * published rather than fixed here — a leak test that only knows the constants
 * would miss the values the module made itself. The verifier is the one secret
 * that cannot be listed this way before the exchange has happened, and
 * `verifierIn` below is how it is caught instead.
 */
function secretsOf(run: Flow): string[] {
  const secrets = [ACCESS_TOKEN, CODE, REFRESH_TOKEN];

  if (run.urls.length > 0) {
    const query = authorizationQuery(run);
    for (const name of ["code_challenge", "state"]) {
      const value = query.get(name);
      if (value !== null) secrets.push(value);
    }
  }

  const verifier = exchangeBody(run).get("code_verifier");
  if (verifier !== null) secrets.push(verifier);

  return secrets;
}

/** 32 bytes of base64url: what `createPkce` makes, and RFC 7636's minimum. */
const VERIFIER_LENGTH = 43;

/**
 * The flow's two secrets, fixed for the test so a leak is recognisable anywhere.
 *
 * Deliberately shaped like the real values and deliberately unmistakable in a
 * failure message, so an assertion that fires names something a reader can find.
 */
const KNOWN_VERIFIER = "verifier-must-not-leak-0123456789abcdefghij";
const KNOWN_STATE = "state-must-not-leak-0123456789";

/**
 * The verifier this flow made, if the text is holding it — found by proof.
 *
 * Every other secret can be listed: two are constants, and the state and the
 * challenge are read back out of the published url. The verifier appears in
 * nothing the flow publishes — the url carries only its sha256 — so until the
 * token request exists there is no copy of it to compare against, and a message
 * quoting it sails past a check that can only look for values it already holds.
 * That is not hypothetical: the callback-failure message was made to carry the
 * live verifier and the whole suite stayed green.
 *
 * So every base64url window of the right width is hashed and compared with the
 * published challenge, which is what the server does with the real one. A match
 * is proof rather than a resemblance, so this cannot fire on an innocent
 * message.
 */
function verifierIn(text: string, run: Flow): string | undefined {
  // The known verifier is checked first and unconditionally. Hashing candidates
  // against the published `code_challenge` only works once the authorization
  // url exists, so on every path that fails earlier this function used to
  // return `undefined` and the assertion behind it checked nothing — proved by
  // an audit that leaked a live verifier into an early error with the suite
  // green. The direct search has no such precondition.
  for (const form of [KNOWN_VERIFIER, KNOWN_STATE]) {
    for (let at = 0; at + 8 <= form.length; at += 1) {
      if (text.includes(form.slice(at, at + 8))) return form;
    }
  }

  if (run.urls.length === 0) return undefined;
  const challenge = authorizationQuery(run).get("code_challenge");
  if (challenge === null) return undefined;

  const words = new RegExp(`[A-Za-z0-9_-]{${VERIFIER_LENGTH},}`, "gu");

  for (const word of text.match(words) ?? []) {
    for (let at = 0; at + VERIFIER_LENGTH <= word.length; at += 1) {
      const candidate = word.slice(at, at + VERIFIER_LENGTH);
      if (
        createHash("sha256").update(candidate).digest("base64url") === challenge
      ) {
        return candidate;
      }
    }
  }

  return undefined;
}

/**
 * What a person would actually see, which includes the cause chain: Node prints
 * causes, so an error that merely carries the failure it wrapped discloses
 * exactly as much as one that quotes it.
 */
function exposureOf(error: unknown): string {
  const chain: string[] = [];
  let current: unknown = error;

  for (let depth = 0; current !== undefined && depth < 5; depth += 1) {
    chain.push(
      current instanceof Error
        ? JSON.stringify(current, Object.getOwnPropertyNames(current))
        : String(current),
    );
    current = current instanceof Error ? current.cause : undefined;
  }

  return chain.join(" ");
}

/**
 * Takes the flow rather than a list of secrets, so that no failure path can be
 * checked against a shorter list than the one it was actually holding.
 */
function expectNoTraceOf(error: unknown, run: Flow): void {
  const text = exposureOf(error);

  for (const secret of secretsOf(run)) {
    for (let at = 0; at + RECOGNISABLE <= secret.length; at += 1) {
      expect(text).not.toContain(secret.slice(at, at + RECOGNISABLE));
    }
  }

  expect(verifierIn(text, run)).toBeUndefined();
}

/**
 * Whatever rejected with nobody listening while `work` ran.
 *
 * An abandoned promise is not a tidiness problem here. Node answers one by
 * printing the reason in full and, with no handler installed, killing the
 * process — so a promise this flow walks away from is a path by which a
 * dependency's raw message reaches a terminal, replacing the redacted error the
 * caller was about to report. Nothing but the event itself observes that.
 */
async function looseRejectionsDuring(
  work: () => Promise<unknown>,
): Promise<unknown[]> {
  const loose: unknown[] = [];
  const watch = (reason: unknown) => {
    loose.push(reason);
  };

  process.on("unhandledRejection", watch);
  try {
    await work().then(
      () => {},
      () => {},
    );
    // Node forms the opinion once the microtask queue has drained, so let the
    // loop turn twice before asking for it.
    await new Promise((settle) => setImmediate(settle));
    await new Promise((settle) => setImmediate(settle));
  } finally {
    process.off("unhandledRejection", watch);
  }

  return loose;
}

async function thrownBy(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }

  throw new Error("the call was expected to throw, and did not");
}

/**
 * The order of these steps is the correctness problem this module owns.
 *
 * Each primitive in `oauth.ts` is careful about one thing; none of them knows
 * that the listener must exist before the client is registered, or that the
 * state made before the url is the one the callback is checked against.
 */
describe("authorizing a project", () => {
  test("carries the flow from discovery through to a stored credential", async () => {
    const run = flow();
    const result = await run.run();

    expect(run.events).toEqual([
      "discover",
      "receiver",
      "register",
      "url",
      "browser",
      "exchange",
      "write",
      "close",
    ]);
    expect(run.writes).toEqual([
      {
        audience: "mcp",
        credential: {
          audience: "mcp",
          clientId: CLIENT_ID,
          obtained: OBTAINED,
          refreshToken: REFRESH_TOKEN,
          resource: `${SERVER}/mcp`,
          version: 2,
        },
        projectId: PROJECT_ID,
        server: SERVER,
      },
    ]);
    expect(result).toEqual({ obtained: OBTAINED });
  });

  test("exchanges the callback's code with the verifier behind the challenge it published", async () => {
    const run = flow();
    await run.run();

    const query = authorizationQuery(run);
    const body = exchangeBody(run);
    const verifier = String(body.get("code_verifier"));

    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe(CODE);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      query.get("code_challenge"),
    );
    expect(String(run.urls[0])).not.toContain(verifier);
  });

  test("uses the redirect uri the receiver reports, everywhere it is named", async () => {
    const redirectUri = "http://127.0.0.1:52111/oauth/callback";
    const run = flow({ redirectUri });
    await run.run();

    expect(run.starts()).toBe(1);
    expect(run.events.indexOf("receiver")).toBeLessThan(
      run.events.indexOf("register"),
    );
    expect(registrationBody(run).redirect_uris).toEqual([redirectUri]);
    expect(authorizationQuery(run).get("redirect_uri")).toBe(redirectUri);
    expect(exchangeBody(run).get("redirect_uri")).toBe(redirectUri);
  });

  test("asks for offline access, because a credential it cannot renew is one it will not store", async () => {
    const run = flow({ scopes: ["work:claim"] });
    await run.run();

    expect(registrationBody(run).scope).toBe(`work:claim ${REFRESH_SCOPE}`);
    expect(authorizationQuery(run).get("scope")).toBe(
      `work:claim ${REFRESH_SCOPE}`,
    );
  });

  test("asks for offline access exactly once when the caller already listed it", async () => {
    const run = flow({ scopes: ["work:claim", REFRESH_SCOPE, "request:read"] });
    await run.run();

    expect(authorizationQuery(run).get("scope")).toBe(
      `work:claim ${REFRESH_SCOPE} request:read`,
    );
  });

  test("registers under the agent's name, or the caller's when it gives one", async () => {
    const standard = flow();
    await standard.run();
    const named = flow({ clientName: "requestport-cli" });
    await named.run();

    expect(AGENT_CLIENT_NAME).toBe("requestport-agent");
    expect(registrationBody(standard).client_name).toBe(AGENT_CLIENT_NAME);
    expect(registrationBody(named).client_name).toBe("requestport-cli");
  });

  /**
   * The resource is the server's origin plus the audience's path, never a
   * caller's text. A consent with no resource is consented as MCP, so the
   * HTTP client could not get an `api` grant without naming its resource;
   * and a refresh without one mints a token no endpoint accepts
   * (manifest-h.md §2.8.2).
   */
  test.each([
    ["mcp", `${SERVER}/mcp`],
    ["api", `${SERVER}/api/v1`],
  ] as const)(
    "names the %s audience's resource in both halves of the flow, and stores it",
    async (audience, resource) => {
      const run = flow({ audience });
      await run.run();

      expect(authorizationQuery(run).get("resource")).toBe(resource);
      expect(exchangeBody(run).get("resource")).toBe(resource);
      expect(run.writes[0]?.audience).toBe(audience);
      expect(run.writes[0]?.credential).toMatchObject({ audience, resource });
    },
  );

  /**
   * A refresh token is bound to the client it was issued to: the provider
   * answers `invalid_grant` to a refresh naming any other. So the client id
   * the registration returned is the one thing a refresh cannot do without,
   * and it is stored with the token.
   */
  test("stores the client id the registration returned, beside the refresh token", async () => {
    const run = flow({
      registration: () => json({ client_id: "client-from-registration-9" }),
    });
    await run.run();

    expect(exchangeBody(run).get("client_id")).toBe(
      "client-from-registration-9",
    );
    expect(run.writes[0]?.credential).toMatchObject({
      clientId: "client-from-registration-9",
      refreshToken: REFRESH_TOKEN,
      version: 2,
    });
  });

  test("refuses to start without an audience, before anything is fetched or bound", async () => {
    const run = flow({ audience: "absent" });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(String(error)).toMatch(/audience/u);
    expect(run.calls).toEqual([]);
    expect(run.starts()).toBe(0);
    expect(run.writes).toEqual([]);
  });

  test("refuses an audience that is neither mcp nor api", async () => {
    const run = flow({ audience: "web" as Audience });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(run.calls).toEqual([]);
    expect(run.starts()).toBe(0);
  });

  test("reads the clock once, so the stored and the reported timestamp cannot differ", async () => {
    const run = flow();
    const result = await run.run();

    expect(run.clockReads()).toBe(1);
    expect(result.obtained).toBe(run.writes[0]?.credential.obtained);
  });
});

const homes: string[] = [];

afterEach(() => {
  while (homes.length > 0) {
    rmSync(homes.pop() as string, { force: true, recursive: true });
  }
});

/**
 * manifest-h.md Done when 12b, against both stores: what `authorize` writes
 * is a record each store accepts and gives back whole, so a token source can
 * refresh it with the registration's client id and the audience's resource;
 * and without an audience it refuses to start, and neither store holds
 * anything after.
 */
describe.each([
  [
    "file",
    () => {
      const home = mkdtempSync(join(tmpdir(), "requestport-authorize-"));
      homes.push(home);
      return createFileStore({ home });
    },
  ],
  ["keychain", () => createKeychainStore({ run: fakeKeychain().run })],
])("authorizing into the %s store", (_label, make) => {
  test.each(["mcp", "api"] as const)(
    "stores a version 2 %s record holding the registration's client id and the audience's resource",
    async (audience) => {
      const store = make();
      const run = flow({
        audience,
        registration: () => json({ client_id: "client-from-registration-9" }),
        store,
      });

      await run.run();

      expect(store.read(SERVER, PROJECT_ID, audience)).toEqual({
        audience,
        clientId: "client-from-registration-9",
        obtained: OBTAINED,
        refreshToken: REFRESH_TOKEN,
        resource: audience === "mcp" ? `${SERVER}/mcp` : `${SERVER}/api/v1`,
        version: 2,
      });
    },
  );

  test.each([
    ["without an audience", "absent"],
    ["with an audience that is neither mcp nor api", "web"],
  ] as const)(
    "refuses to start %s, before anything is fetched or bound, and stores nothing",
    async (_case, audience) => {
      const store = make();
      const run = flow({ audience: audience as Audience | "absent", store });

      const error = await thrownBy(() => run.run());

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(run.calls).toEqual([]);
      expect(run.starts()).toBe(0);
      for (const each of ["mcp", "api"] as const) {
        expect(store.read(SERVER, PROJECT_ID, each)).toBeUndefined();
      }
    },
  );
});

/**
 * A machine with no browser is a normal machine — a container, a build agent,
 * an ssh session — and the flow has to finish on one. The url is what a person
 * needs, so it is handed over whether or not anything can open it.
 */
describe("when there is no browser to open", () => {
  test("hands the url to the caller before it reaches for a browser", async () => {
    const run = flow();
    await run.run();

    expect(run.urls).toHaveLength(1);
    expect(run.opened).toEqual(run.urls);
    expect(run.events.indexOf("url")).toBeLessThan(
      run.events.indexOf("browser"),
    );
  });

  test("finishes even though opening the browser threw", async () => {
    const run = flow({
      browser: (url) => {
        throw new Error(`xdg-open: no display for ${url}`);
      },
    });

    await expect(run.run()).resolves.toEqual({ obtained: OBTAINED });
    expect(run.urls).toHaveLength(1);
    expect(run.writes).toHaveLength(1);
  });

  test("finishes when the opener rejects rather than throws", async () => {
    const run = flow({
      browser: () => Promise.reject(new Error("no display")),
    });

    await expect(run.run()).resolves.toEqual({ obtained: OBTAINED });
  });

  test("finishes when no opener was injected at all", async () => {
    const run = flow();

    await expect(run.run({ openBrowser: undefined })).resolves.toEqual({
      obtained: OBTAINED,
    });
    expect(run.events).not.toContain("browser");
  });
});

/** Every refusal below is a case where continuing would be quietly worse. */
describe("refusing", () => {
  test("refuses a token response with no refresh token, and stores nothing", async () => {
    const run = flow({
      token: () =>
        json({
          access_token: ACCESS_TOKEN,
          expires_in: 900,
          token_type: "Bearer",
        }),
    });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(String(error)).toMatch(/refresh/iu);
    expect(run.writes).toEqual([]);
    expect(run.closes()).toBe(1);
    expectNoTraceOf(error, run);
  });

  test("refuses a callback whose state is not this flow's", async () => {
    const run = flow({
      landing: (url) => landingFor(url, "someone-elses-state"),
    });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(OAuthError);
    expect(String(error)).toMatch(/state/iu);
    expect(run.writes).toEqual([]);
    expectNoTraceOf(error, run);
  });

  test("opens no listener for a server it cannot discover", async () => {
    const run = flow();

    const error = await thrownBy(() =>
      run.run({ fetch: () => Promise.resolve(json({ error: "nope" }, 503)) }),
    );

    expect(error).toBeInstanceOf(OAuthError);
    expect(run.starts()).toBe(0);
    expect(run.closes()).toBe(0);
  });

  test("leaves an empty scope set empty, so oauth.ts still refuses it", async () => {
    const run = flow({ scopes: [] });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(OAuthError);
    expect(String(error)).toMatch(/scope/iu);
    expect(run.writes).toEqual([]);
  });
});

/**
 * RFC 9207, through the flow (ruling 20): requestport.com advertises
 * `authorization_response_iss_parameter_supported`, so every callback must
 * name the issuer discovery found, and a callback that does not is refused
 * before its code is exchanged.
 */
describe("naming the issuer", () => {
  test("refuses a callback with no issuer from a server that promised one, and stores nothing", async () => {
    const run = flow({ landing: (url) => landingFor(url, undefined, null) });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(OAuthError);
    expect(String(error)).toMatch(/issuer/iu);
    expect(run.events).not.toContain("exchange");
    expect(run.writes).toEqual([]);
    expect(run.closes()).toBe(1);
    expectNoTraceOf(error, run);
  });

  test("refuses a callback that names another issuer, and stores nothing", async () => {
    const run = flow({
      landing: (url) =>
        landingFor(url, undefined, "https://requestport.com.evil.example"),
    });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(OAuthError);
    expect(String(error)).toMatch(/issuer/iu);
    expect(run.events).not.toContain("exchange");
    expect(run.writes).toEqual([]);
    expectNoTraceOf(error, run);
  });

  test("accepts a callback that names the discovered issuer", async () => {
    const run = flow();

    await expect(run.run()).resolves.toEqual({ obtained: OBTAINED });
    expect(run.events).toContain("exchange");
  });

  test("accepts a callback with no issuer from a server that never advertised one", async () => {
    const run = flow({
      landing: (url) => landingFor(url, undefined, null),
      metadata: { authorization_response_iss_parameter_supported: undefined },
    });

    await expect(run.run()).resolves.toEqual({ obtained: OBTAINED });
  });

  test("refuses a foreign issuer even from a server that never advertised one", async () => {
    const run = flow({
      landing: (url) =>
        landingFor(url, undefined, "https://requestport.com.evil.example"),
      metadata: { authorization_response_iss_parameter_supported: undefined },
    });

    await expect(run.run()).rejects.toThrow(/issuer/iu);
    expect(run.writes).toEqual([]);
  });
});

/**
 * A listener left bound outlives the failure that stranded it: the port stays
 * taken, the next attempt binds a different one, and the process does not exit.
 */
describe("closing the receiver", () => {
  const failures: Array<[string, () => Flow]> = [
    [
      "registration is refused",
      () =>
        flow({
          registration: () => json({ error: "invalid_client_metadata" }, 400),
        }),
    ],
    [
      "the exchange is refused",
      () => flow({ token: () => json({ error: "invalid_grant" }, 400) }),
    ],
    [
      "the callback never arrives",
      () => flow({ arrivalFails: new Error("the receiver gave up waiting") }),
    ],
    [
      "the callback carries another flow's state",
      () => flow({ landing: (url) => landingFor(url, "someone-elses-state") }),
    ],
    [
      "the response carries no refresh token",
      () =>
        flow({
          token: () =>
            json({ access_token: ACCESS_TOKEN, token_type: "Bearer" }),
        }),
    ],
    [
      "the store will not write",
      () =>
        flow({ writeFails: new CredentialStoreError("the file is not JSON.") }),
    ],
    ["no scope was asked for", () => flow({ scopes: [] })],
    [
      "the caller cannot be handed the url",
      () =>
        flow({
          landing: () => {
            throw new Error("nowhere to print it");
          },
        }),
    ],
  ];

  test.each(failures)("closes the receiver when %s", async (_name, make) => {
    const run = make();

    await thrownBy(() => run.run());

    expect(run.closes()).toBe(1);
  });

  test("closes the receiver on the way out of a flow that worked", async () => {
    const run = flow();
    await run.run();

    expect(run.closes()).toBe(1);
    expect(run.events.at(-1)).toBe("close");
  });

  test("does not let a failing close replace the failure that caused it", async () => {
    const run = flow({
      closeFails: new Error("the socket was already gone"),
      token: () => json({ error: "invalid_grant" }, 400),
    });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(OAuthError);
    expect(String(error)).toMatch(/400/u);
  });

  test("does not let a failing close turn a finished authorization into an error", async () => {
    const run = flow({ closeFails: new Error("the socket was already gone") });

    await expect(run.run()).resolves.toEqual({ obtained: OBTAINED });
  });
});

/**
 * The rule the whole package is written to: an error outlives the request it
 * came from, and the values in this flow are still valid when it lands in a log,
 * a CI transcript or an issue tracker.
 */
describe("keeping secrets out of failures", () => {
  test("says the endpoint, the status and the error code when the exchange is refused, and nothing from the description", async () => {
    const run = flow({
      token: () =>
        json(
          {
            error: "invalid_grant",
            error_description: `code ${CODE} is spent, token ${ACCESS_TOKEN}`,
          },
          400,
        ),
    });

    const error = await thrownBy(() => run.run());

    expect(String(error)).toContain(TOKEN);
    expect(String(error)).toContain("400");
    expect(String(error)).toContain("invalid_grant");
    expectNoTraceOf(error, run);
  });

  test("replaces a dependency's error rather than wrapping it", async () => {
    const run = flow({
      arrivalFails: new Error(`could not read ${CODE}`, {
        cause: new Error(`while holding ${REFRESH_TOKEN}`),
      }),
    });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(AuthorizationError);
    expect((error as Error).cause).toBeUndefined();
    expectNoTraceOf(error, run);
  });

  test("replaces a store's error unless the store is one of this package's", async () => {
    const foreign = flow({
      writeFails: new Error(`refusing to write ${REFRESH_TOKEN}`),
    });
    const ours = flow({
      writeFails: new CredentialStoreError(
        "credentials.json is not valid JSON. Refusing to read or replace it.",
      ),
    });

    const foreignError = await thrownBy(() => foreign.run());
    const ourError = await thrownBy(() => ours.run());

    expect(foreignError).toBeInstanceOf(AuthorizationError);
    expectNoTraceOf(foreignError, foreign);
    expect(ourError).toBeInstanceOf(CredentialStoreError);
    expect(String(ourError)).toContain("credentials.json");
  });

  test("reports a receiver that will not start by its errno and not its message", async () => {
    const refused = Object.assign(
      new Error(`listen EADDRINUSE ${REDIRECT} while holding ${CODE}`),
      { code: "EADDRINUSE" },
    );
    const run = flow({ receiverFails: refused });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(String(error)).toContain("EADDRINUSE");
    expect(String(error)).not.toContain("listen EADDRINUSE");
    expect(run.closes()).toBe(0);
    expectNoTraceOf(error, run);
  });

  test("repeats nothing from an error whose code is not an errno symbol", async () => {
    const run = flow({
      receiverFails: Object.assign(new Error("nope"), {
        code: `not an errno ${REFRESH_TOKEN}`,
      }),
    });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(AuthorizationError);
    expectNoTraceOf(error, run);
  });

  /**
   * The test above rejects its code on the first character, so the rest of the
   * guard — the part that stops a code from carrying anything after the symbol
   * — was never asked a question. A code that opens like a real errno and then
   * keeps going is the shape that gets through a first-character check.
   */
  test("quotes nothing from a code that only starts like an errno symbol", async () => {
    const run = flow({
      receiverFails: Object.assign(new Error("nope"), {
        code: SMUGGLED_AFTER_ERRNO,
      }),
    });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(String(error)).not.toContain(SMUGGLED_AFTER_ERRNO);
    expect(String(error)).not.toContain("EADDRINUSE");
    expect(String(error)).not.toContain("8HQ2VN");
    expectNoTraceOf(error, run);
  });

  /**
   * An alphabet alone admits any run of capitals, and a long one is not a word
   * that came from a fixed set — it is an opaque value wearing the right
   * characters. The message is worth one word less; it is not worth a token.
   */
  test("quotes nothing from a code too long to be an errno symbol", async () => {
    const run = flow({
      receiverFails: Object.assign(new Error("nope"), { code: SMUGGLED }),
    });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(String(error)).not.toContain(SMUGGLED);
    expectNoTraceOf(error, run);
  });

  /**
   * The url is handed over inside the same wrapper as everything else, and for
   * the same reason: a caller's own failure — a closed stream, a broken pipe —
   * arrives here holding the one string that carries the state and the
   * challenge, and the tidy-looking `await deps.onAuthorizationUrl(...)` would
   * let it out with its message and its cause chain intact.
   */
  test("replaces the caller's failure when the url cannot be handed over", async () => {
    const run = flow({
      landing: () => {
        throw new Error(`nowhere to print ${CODE}`, {
          cause: new Error(`while holding ${REFRESH_TOKEN}`),
        });
      },
    });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(String(error)).toMatch(/handed to the caller/u);
    expect((error as Error).cause).toBeUndefined();
    expect(exposureOf(error)).not.toContain(String(run.urls[0]));
    expectNoTraceOf(error, run);
  });

  /**
   * The other half of that rule: this package's own error types say only what
   * they are allowed to say, and their own suites hold them to it, so replacing
   * one would cost a developer the endpoint and the status and buy nothing.
   * Identity is asserted rather than the type, because a replacement is an
   * `AuthorizationError` too.
   */
  test("passes this package's own errors through whichever dependency raised one", async () => {
    const refusal = new OAuthError(`${SERVER} answered 503 at registration.`);
    const complaint = new AuthorizationError("the store gave up mid-write.");
    const refused = flow({ receiverFails: refusal });
    const gaveUp = flow({ writeFails: complaint });

    await expect(refused.run()).rejects.toBe(refusal);
    await expect(gaveUp.run()).rejects.toBe(complaint);
  });

  /**
   * The verifier check above is worth exactly what its detector is worth, and
   * the detector proves a value rather than recognising one — so it is pinned
   * here against a verifier from a flow that finished. A detector that quietly
   * stopped seeing anything would take every leak assertion in this file with
   * it and leave them all green.
   */
  test("can prove a verifier inside a message, which is how one is caught", async () => {
    const run = flow();
    await run.run();
    const verifier = String(exchangeBody(run).get("code_verifier"));

    expect(verifierIn(`never arrived ${verifier}`, run)).toBe(verifier);
    expect(verifierIn("never arrived", run)).toBeUndefined();
  });
});

/**
 * Findings from the adversarial review of 2026-09-06, pinned so they cannot
 * return.
 */
describe("what a badly behaved dependency cannot do", () => {
  /**
   * A browser opener is a convenience, and awaiting one that never settles
   * wedged the whole flow — with the loopback listener still holding its port —
   * which is worse than no browser at all. A headless machine and a hung
   * launcher must degrade the same way: the caller already has the url, so the
   * person pastes it themselves.
   */
  test("a browser opener that never settles does not wedge the flow", async () => {
    let entered = false;
    const run = flow({
      browser: () => {
        entered = true;
        return new Promise<void>(() => {});
      },
    });

    await expect(run.run()).resolves.toBeDefined();
    expect(entered).toBe(true);
  });

  /** What this package's own listener rejects a pending read with. */
  const closing = new Error(
    `the listener was reading GET /callback?code=${CODE} when it was closed`,
  );

  /**
   * Every failure between the receiver starting and the callback being awaited
   * leaves that promise pending, and the `finally` then closes a receiver
   * which — like this package's own — rejects whatever it was still waiting on.
   * With no handler attached that is an unhandled rejection, and Node answers
   * one by printing the reason: the listener quoting the request it was mid-read
   * on, which is the callback carrying the authorization code. The process then
   * dies with that in the transcript, in place of the redacted error the caller
   * was about to report.
   */
  const abandoned: Array<[string, () => Flow]> = [
    [
      "registration is refused",
      () =>
        flow({
          arrivalFailsOnClose: closing,
          registration: () => json({ error: "invalid_client_metadata" }, 400),
        }),
    ],
    [
      "the url cannot be handed to the caller",
      () =>
        flow({
          arrivalFailsOnClose: closing,
          landing: () => {
            throw new Error("nowhere to print it");
          },
        }),
    ],
    [
      "the redirect uri is refused",
      () =>
        flow({
          arrivalFailsOnClose: closing,
          redirectUri: "https://attacker.example/callback",
        }),
    ],
  ];

  test.each(abandoned)(
    "hands the callback a handler at birth, so nothing is abandoned when %s",
    async (_name, make) => {
      const run = make();
      let error: unknown;

      const loose = await looseRejectionsDuring(async () => {
        error = await thrownBy(() => run.run());
      });

      expect(error).toBeDefined();
      expect(loose).toEqual([]);
      expect(run.closes()).toBe(1);
    },
  );

  /**
   * `close()` is declared `void | Promise<void>`, so a receiver that answers
   * with a promise is answering within its contract. Not waiting for that
   * promise puts an unhandled rejection on the tidy-up path of a flow that
   * otherwise worked, which is the one path where nothing is left to catch it.
   */
  test("waits for a close that fails asynchronously rather than orphaning it", async () => {
    const run = flow({
      closeRejects: new Error("the socket was already gone"),
    });
    let result: unknown;

    const loose = await looseRejectionsDuring(async () => {
      result = await run.run();
    });

    expect(result).toEqual({ obtained: OBTAINED });
    expect(loose).toEqual([]);
  });

  /**
   * The receiver reports the redirect uri and the rest of the flow takes it on
   * trust: it is registered with the server, it is what the browser is sent to,
   * and it is where the authorization code lands. `oauth.ts` allows https on any
   * host, which is right for a redirect uri in general and wrong for this one —
   * a receiver reporting a public host would send the browser, and the code with
   * it, off this machine, with every layer below agreeing it was well formed.
   */
  test("refuses a receiver whose redirect uri is not on this machine", async () => {
    const run = flow({ redirectUri: "https://attacker.example/callback" });

    const error = await thrownBy(() => run.run());

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(run.events).toEqual(["discover", "receiver", "close"]);
    expect(run.urls).toEqual([]);
    expect(run.writes).toEqual([]);
    expect(run.closes()).toBe(1);
  });

  test("takes a loopback redirect uri however the receiver spells it", async () => {
    const ipv6 = flow({ redirectUri: "http://[::1]:41903/callback" });
    const named = flow({ redirectUri: "http://localhost:41903/callback" });

    await expect(ipv6.run()).resolves.toEqual({ obtained: OBTAINED });
    await expect(named.run()).resolves.toEqual({ obtained: OBTAINED });
  });
});
