import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { authorizationResumeTarget } from "./authorization-resume.js";

/**
 * `exp` is seconds since the epoch, and the provider mints it minutes ahead of
 * the moment it signs. A fixture that hard-codes one stops standing for a live
 * authorization the day it passes, so every query here is dated from whatever
 * clock the test is running against.
 */
function epochSeconds(offset = 0) {
  return String(Math.floor(Date.now() / 1000) + offset);
}

/**
 * The signed query the provider sends to this page when an agent's
 * authorization arrives without a session. `sig` and `exp` are what make it
 * the provider's own; the rest is the request it is holding.
 */
function signedQuery(overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    client_id: "agent-client",
    redirect_uri: "http://127.0.0.1:41999/callback",
    response_type: "code",
    scope: "offline_access project:provision",
    state: "agent-state",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    exp: epochSeconds(600),
    ba_iat: String(Date.now()),
    sig: "a-signature",
    ...overrides,
  });
  for (const name of ["client_id", "redirect_uri", "scope", "state"]) {
    params.append("ba_param", name);
  }

  return params;
}

describe("where sign-in returns to", () => {
  test("resumes the authorization the provider was holding", () => {
    const target = authorizationResumeTarget(signedQuery());

    expect(target).toBeDefined();
    const url = new URL(target ?? "", "https://requestport.com");
    expect(url.pathname).toBe("/api/auth/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("agent-client");
    expect(url.searchParams.get("sig")).toBe("a-signature");
    expect(url.searchParams.getAll("ba_param")).toContain("redirect_uri");
  });

  test("returns nowhere in particular for an ordinary sign-in", () => {
    // A person who came here to sign in, not an agent's authorization. There
    // is nothing to resume, and inventing one would send them somewhere they
    // did not ask for.
    expect(authorizationResumeTarget(new URLSearchParams())).toBeUndefined();
  });

  test.each(["sig", "exp", "client_id"])(
    "refuses a query missing %s",
    (name) => {
      const params = signedQuery();
      params.delete(name);

      expect(authorizationResumeTarget(params)).toBeUndefined();
    },
  );

  test("never returns to an address the query asked for", () => {
    // The one thing this must not become. The destination is a constant of
    // this application; only the provider's own query travels. A caller that
    // names its own landing address is asking for an open redirect, and gets
    // the authorize endpoint instead.
    const hostileQueries: Record<string, string>[] = [
      { callbackURL: "https://evil.example/steal" },
      { callbackURL: "//evil.example" },
      { redirect_uri: "https://evil.example/callback" },
      { next: "https://evil.example" },
    ];
    for (const hostile of hostileQueries) {
      const target = authorizationResumeTarget(signedQuery(hostile));
      const url = new URL(target ?? "", "https://requestport.com");

      expect(url.origin).toBe("https://requestport.com");
      expect(url.pathname).toBe("/api/auth/oauth2/authorize");
    }
  });

  test("carries a repeated parameter as many times as it arrived", () => {
    // `ba_param` names every parameter the signature covers, once each. Losing
    // a repeat would change what the provider verifies and the request would
    // be refused as tampered with.
    const target = authorizationResumeTarget(signedQuery()) ?? "";
    const url = new URL(target, "https://requestport.com");

    expect(url.searchParams.getAll("ba_param")).toEqual([
      "client_id",
      "redirect_uri",
      "scope",
      "state",
    ]);
  });
});

/**
 * A prompt this page cannot satisfy.
 *
 * `prompt=login` and `prompt=create` ask authorization to re-authenticate, and
 * the provider honours that by bouncing to sign-in whether or not a session
 * exists — the check is ORed with the session, not gated on it. Carrying the
 * prompt back would therefore return the person to this page again, and again,
 * with no exit; stripping it is not available either, because `prompt` is
 * inside the signed parameter set and removing it invalidates the signature.
 *
 * `prompt=none` is here for a different reason: no genuine `prompt=none` flow
 * reaches sign-in, so one that turns up here was composed by hand. See the
 * declining test below, which also records what refusing it does not buy.
 *
 * So such an authorization is not resumed. That is the behaviour this page had
 * before it resumed anything — the request is dropped and the person lands on
 * the application — which is poor, and the alternatives are worse.
 */
describe("a prompt sign-in has just satisfied", () => {
  test.each(["login", "create"])(
    "strips prompt=%s and resumes the rest",
    (prompt) => {
      const target = authorizationResumeTarget(signedQuery({ prompt }));

      expect(target).toBeDefined();
      expect(
        new URL(target ?? "", "https://requestport.com").searchParams.has(
          "prompt",
        ),
      ).toBe(false);
    },
  );

  test("strips only the satisfied half of a compound prompt", () => {
    const target = authorizationResumeTarget(
      signedQuery({ prompt: "login consent" }),
    );

    expect(
      new URL(target ?? "", "https://requestport.com").searchParams.get(
        "prompt",
      ),
    ).toBe("consent");
  });

  test.each(["consent", "select_account"])(
    "leaves prompt=%s alone",
    (prompt) => {
      const target = authorizationResumeTarget(signedQuery({ prompt }));

      expect(
        new URL(target ?? "", "https://requestport.com").searchParams.get(
          "prompt",
        ),
      ).toBe(prompt);
    },
  );
});

describe("a prompt that reached this page by hand", () => {
  test.each(["none", "none consent", "select_account none"])(
    "declines to resume a query asking for prompt=%s",
    (prompt) => {
      expect(
        authorizationResumeTarget(signedQuery({ prompt })),
      ).toBeUndefined();
    },
  );

  test("declines rather than carrying a hand-composed prompt=none back", () => {
    // A genuine `prompt=none` flow never reaches sign-in: with no session the
    // provider answers the client with `login_required` rather than
    // redirecting here. So a `prompt=none` query on this page was composed by
    // hand — and resuming it after sign-in finds no stored consent, may not
    // ask for one, and sends the browser to the client's own `redirect_uri`
    // carrying `error=consent_required`. Client registration is
    // unauthenticated and takes any https address, so that `redirect_uri` is
    // whatever the composer registered.
    //
    // Stripping it is not the answer here, unlike `login` and `create`.
    // Sign-in satisfies those; nothing about signing in satisfies a request
    // to answer without asking, and removing it would turn a silent request
    // somebody composed into a consent screen drawn for their client.
    //
    // What this does not assert, because it is not true: that declining
    // closes the way from this origin to such a redirect. `GET
    // /oauth2/authorize` redirects to `query.redirect_uri` on error paths of
    // its own — an unpermitted scope, a `code_challenge` missing where PKCE
    // is required or using a method other than `S256` — before it looks for a
    // session and without reading any prompt.
    expect(
      authorizationResumeTarget(
        signedQuery({
          prompt: "none",
          redirect_uri: "https://evil.example/collect",
        }),
      ),
    ).toBeUndefined();
  });
});

/**
 * The expiry this page does not read.
 *
 * It is tempting to refuse a query whose `exp` has gone by, and this file did
 * for a while. It is wrong. `GET /oauth2/authorize` never looks at the `exp`
 * that arrives with it — the endpoint's query schema does not admit the field,
 * so zod drops it — and `signParams` then mints a fresh one, ten minutes out,
 * deletes the incoming `sig` and re-signs. The expiry the consent POST checks
 * is that new one, minted after the resume, never the one in the link.
 *
 * So refusing a lapsed `exp` here refuses a request the provider would have
 * carried through. Somebody who leaves the sign-in page open past ten minutes,
 * or signs in through a slow identity provider, has a working authorization;
 * reading the clock on this page is what would take it away from them.
 */
describe("an authorization whose stated moment has passed", () => {
  test.each([-1, -600, -86_400])(
    "resumes a query whose exp went by %s seconds ago",
    (offset) => {
      expect(
        authorizationResumeTarget(signedQuery({ exp: epochSeconds(offset) })),
      ).toBeDefined();
    },
  );

  test("still requires exp to be present, because its absence means this is no authorization", () => {
    const params = signedQuery();
    params.delete("exp");

    expect(authorizationResumeTarget(params)).toBeUndefined();
  });
});
