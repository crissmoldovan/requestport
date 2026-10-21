import { DomainError } from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Who is signed in, as a seam rather than a constant. The principal id is
// derived partly from the person, and a guarantee about two different people
// cannot be checked against a suite that only ever has one.
const signedInUserId = vi.hoisted(() => ({
  current: "00000000-0000-4000-8000-0000000000aa",
}));

// Whether the session resolves at all — the one seam that puts a refusal
// before authorization rather than after it.
const sessionFailure = vi.hoisted(() => ({
  current: null as Error | null,
}));

// Whether the person is still signed in by the time they submit. A consent
// screen is read slowly and a session can lapse underneath it, which is the
// one case where *where the gate sends the browser* is the subject.
const lapsedSession = vi.hoisted(() => ({ current: false }));

// The command secret, as a seam. The proposed principal id is keyed on it so
// that nobody holding the public link can compute it, and a claim about keying
// cannot be checked against a suite whose secret never moves.
const environment = vi.hoisted(() => ({
  BETTER_AUTH_SECRET: "fixture-value-not-a-real-credential",
  BETTER_AUTH_URL: "https://requestport.test",
}));

const consent = vi.hoisted(() => ({
  bindConsent: vi.fn(),
  invalidate: vi.fn(),
  oauth2Consent: vi.fn(),
}));

vi.mock("@requestport/auth/server", () => ({
  agentGrantService: { bindConsent: consent.bindConsent },
  auth: { api: { oauth2Consent: consent.oauth2Consent } },
}));

vi.mock("@requestport/config/server", () => ({ serverEnv: environment }));

vi.mock("@requestport/db", () => ({
  createAgentAuthRepository: () => ({
    invalidateUnboundOAuthProviderAuthorization: consent.invalidate,
  }),
}));

// The web root, whose storage the clean-up after a refused binding builds
// its repository over when it runs (Plan 13, G.3).
vi.mock("../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

const logged = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../../../lib/observability.js", () => ({ webLogger: logged }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

// How Next signals a navigation: a throw carrying a digest. The shape is
// shared with the gate stand-in below, because a suite that spelled it twice
// could assert a destination the action never actually navigated to.
const navigation = vi.hoisted(() => ({
  redirectError: (url: string) =>
    Object.assign(new Error("NEXT_REDIRECT"), { digest: `redirect:${url}` }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw navigation.redirectError(url);
  },
  unstable_rethrow: (error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      typeof (error as { digest?: unknown }).digest === "string" &&
      (error as { digest: string }).digest.startsWith("redirect:")
    ) {
      throw error;
    }
  },
}));

vi.mock("../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => {
    if (sessionFailure.current) throw sessionFailure.current;
    if (lapsedSession.current) return unauthenticatedGate();

    return { session: { user: { id: signedInUserId.current } } };
  },
}));

vi.mock("../../../lib/server-core-commands.js", () => ({
  humanCommandContext: () => ({ scopes: [] }),
}));

import { APIError } from "better-auth";
import { z } from "zod";

import { loadApplicationContext } from "../../../lib/application-context.js";
import {
  approveAgentConsentAction,
  denyAgentConsentAction,
} from "./actions.js";
import {
  consentFieldNames,
  initialConsentActionState,
} from "./consent-action-state.js";
import { uuidFromDigest } from "./uuid-from-digest.js";

/**
 * The gate, wired as the application wires it, for the one case about where it
 * sends the browser.
 *
 * `loadApplicationContext` is the only declaration in this application that
 * answers an unauthenticated request, so a stand-in that invented its own
 * destination would state nothing about where a lapsed consent lands. Only what
 * the application injects is replaced: the session read refuses, the redirect
 * throws the way Next's does, and the organization read below it is never
 * reached because the session fails first.
 */
async function unauthenticatedGate() {
  return loadApplicationContext({
    preferredOrganizationId: undefined,
    query: {
      findActiveOrganizationForUser: async () => null,
      listActiveOrganizationsForUser: async () => [],
      listOrganizationLanes: async () => [],
      listOrganizationMembers: async () => [],
      listOrganizationProjects: async () => [],
      listPendingInvitations: async () => [],
    },
    redirect: (path: string) => {
      throw navigation.redirectError(path);
    },
    requireSession: async () => {
      throw new APIError("UNAUTHORIZED", {
        code: "unauthorized",
        message: "unauthorized",
      });
    },
  });
}

/** The digest a navigation carries, or nothing when the throw was not one. */
function navigatedTo(thrown: unknown) {
  return (thrown as { digest?: unknown } | null)?.digest;
}

/**
 * Where a rejected consent submission is allowed to land.
 *
 * This form draws a field for the project binding, the principal, the display
 * name, the slug and the software name, so §7 puts a rejection about one of
 * them on that control's own error line. Everything else — a client whose
 * binding changed, a grant the server refused — stays the fixed banner. What
 * this must never do is throw a validator error out of the action: the reader
 * then gets the error boundary instead of the form they were filling in, and
 * the values they typed are gone.
 */

const organizationId = "00000000-0000-4000-8000-0000000000d1";
const projectId = "00000000-0000-4000-8000-0000000000c1";
/**
 * The shape Better Auth's consent redirect produces for an agent that named no
 * resource.
 *
 * Better Auth 1.6.29 signed a fixed parameter set onto that redirect and never
 * `resource`, so a consent that required one was refused for every agent.
 * 1.7.6 signs on each `resource` the agent sent; the cases that add one say so.
 */
const oauthQuery = "client_id=client-abcdef&scope=request%3Aread";
const mcpResource = "https://requestport.test/mcp";

function approvalForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("oauthQuery", oauthQuery);
  data.set("clientId", "client-abcdef");
  data.set("projectBinding", `${organizationId}:${projectId}`);
  data.set("agentPrincipalId", "new");
  data.set("displayName", "Fixture agent");
  data.set("slug", "fixture-agent");
  data.set("softwareName", "Fixture agent");
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);
  return data;
}

beforeEach(() => {
  // A mutable seam has to be put back, or a case that varies the person
  // silently hands that person to every case after it.
  signedInUserId.current = "00000000-0000-4000-8000-0000000000aa";
  sessionFailure.current = null;
  lapsedSession.current = false;
  environment.BETTER_AUTH_SECRET = "fixture-value-not-a-real-credential";
  logged.warn.mockReset();
  consent.bindConsent.mockReset();
  consent.bindConsent.mockResolvedValue(undefined);
  consent.invalidate.mockReset();
  consent.invalidate.mockResolvedValue(undefined);
  consent.oauth2Consent.mockReset();
  consent.oauth2Consent.mockResolvedValue({
    redirect: true,
    url: "http://127.0.0.1:41234/callback?code=abc123&state=xyz",
  });
});

describe("approving an agent connection", () => {
  test("names every field the form draws in one closed list", () => {
    expect(consentFieldNames).toEqual([
      "agentPrincipalId",
      "displayName",
      "projectBinding",
      "slug",
      "softwareName",
    ]);
    expect(initialConsentActionState).toEqual({ message: "", status: "idle" });
  });

  test.each([
    ["slug", { slug: "Not A Slug" }],
    ["displayName", { displayName: "" }],
    ["softwareName", { softwareName: "" }],
  ])("addresses a rejected %s to that control", async (field, overrides) => {
    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm(overrides),
    );

    expect(state).toMatchObject({ field, status: "error" });
    expect(consent.bindConsent).not.toHaveBeenCalled();
  });

  test("binds on a redirect that carries no resource", async () => {
    // An agent may name no resource. Under 1.6.29 none ever reached this page,
    // and requiring one refused every consent ever submitted — and told the
    // person to check values they had supplied correctly.
    await expect(
      approveAgentConsentAction(initialConsentActionState, approvalForm()),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(consent.bindConsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ audience: "mcp" }),
    );
  });

  test("still honours a resource it recognises", async () => {
    await expect(
      approveAgentConsentAction(
        initialConsentActionState,
        approvalForm({
          oauthQuery: `${oauthQuery}&resource=${encodeURIComponent(mcpResource)}`,
        }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(consent.bindConsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ audience: "mcp" }),
    );
  });

  test.each([
    ["missing oauth query", "oauth_invalid_request.missing_oauth_query"],
    ["redirect_uri mismatch", "oauth_invalid_request.redirect_uri_mismatch"],
    // Anything that is not plainly words is dropped rather than logged: a
    // description is the library's, but only the shape proves it.
    ["https://requestport.com/x?token=abc", "oauth_invalid_request"],
    ["someone@example.com", "oauth_invalid_request"],
    ["x".repeat(200), "oauth_invalid_request"],
  ])("names the refusal %j as %s", async (description, expected) => {
    consent.oauth2Consent.mockRejectedValue({
      body: { error: "invalid_request", error_description: description },
    });

    await approveAgentConsentAction(initialConsentActionState, approvalForm());

    // The whole field set, not a subset: a line that quietly gained a field
    // would be a line that quietly gained something to leak.
    expect(logged.warn).toHaveBeenCalledWith("oauth.agent_consent_refused", {
      actorId: "00000000-0000-4000-8000-0000000000aa",
      actorType: "user",
      credentialFingerprint: expect.any(String),
      errorCode: expected,
    });
  });

  test("asks for the plain answer rather than a Response", async () => {
    await expect(
      approveAgentConsentAction(initialConsentActionState, approvalForm()),
    ).rejects.toThrow("NEXT_REDIRECT");

    // Supplying `request` — which `ctx.request` requires — also flips Better
    // Auth into Response mode unless `asResponse` says otherwise. In that mode
    // the destination arrives as a json body, `.url` is "", and every refusal
    // is returned instead of thrown.
    expect(consent.oauth2Consent.mock.calls[0]?.[0]?.asResponse).toBe(false);
  });

  test("refuses a Response rather than redirecting to nowhere", async () => {
    consent.oauth2Consent.mockResolvedValue(
      new Response(JSON.stringify({ redirect: true, url: "/x?code=a" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    // The sentinel for the bug this file could not see: a Response's `.url` is
    // "", and `redirect("")` is a 500 raised after the grant is written.
    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm(),
    );

    expect(state).toMatchObject({ status: "error" });
  });

  test.each([
    ["a denial", "http://127.0.0.1:41234/callback?error=access_denied"],
    ["a refusal", "https://requestport.test/error?error=invalid_client"],
    ["a re-prompt", "/oauth/agent-consent?client_id=client-abcdef"],
  ])("binds nothing when the answer is %s", async (_kind, url) => {
    consent.oauth2Consent.mockResolvedValue({ redirect: true, url });

    // Each answers with a perfectly good destination and issued nothing.
    // Binding on a url alone provisions a grant for an authorization that never
    // happened — and revokes whatever the agent held before.
    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm(),
    );

    expect(state).toMatchObject({ status: "error" });
    expect(consent.bindConsent).not.toHaveBeenCalled();
  });

  test("hands the consent endpoint a request to find", async () => {
    await expect(
      approveAgentConsentAction(initialConsentActionState, approvalForm()),
    ).rejects.toThrow("NEXT_REDIRECT");

    // Better Auth's consent endpoint ends by running its authorization
    // handler, whose first act is `if (!ctx.request) throw`. Without one it
    // records the consent and then refuses — which is how every consent this
    // product ever took ended: Better Auth's half done, ours never reached.
    const request = consent.oauth2Consent.mock.calls[0]?.[0]?.request;
    expect(request).toBeInstanceOf(Request);
    expect(new URL(request.url).pathname).toBe("/api/auth/oauth2/consent");
  });

  test("accepts the signed request whole, naming no scope of its own", async () => {
    await expect(
      approveAgentConsentAction(initialConsentActionState, approvalForm()),
    ).rejects.toThrow("NEXT_REDIRECT");

    // Better Auth reads an absent scope as "all originally requested", which
    // is what this screen means. A scope rebuilt here could only ever agree
    // with the signed one or refuse the consent, and the refusal it produces
    // is indistinguishable from several unrelated ones.
    const [call] = consent.oauth2Consent.mock.calls;
    expect(call?.[0]?.body).toEqual({
      accept: true,
      oauth_query: expect.any(String),
    });
  });

  test("binds the api audience when the one resource named is the API", async () => {
    await expect(
      approveAgentConsentAction(
        initialConsentActionState,
        approvalForm({
          oauthQuery: `${oauthQuery}&resource=${encodeURIComponent("https://requestport.test/api/v1")}`,
        }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(consent.bindConsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ audience: "api" }),
    );
  });

  test.each([
    [
      "both resources",
      ["https://requestport.test/mcp", "https://requestport.test/api/v1"],
    ],
    ["the same resource twice", [mcpResource, mcpResource]],
  ])("refuses a request naming %s", async (_, named) => {
    // Better Auth 1.7.6 signs every `resource` the agent sent onto the consent
    // redirect. A grant binds one audience, so a request for two cannot be
    // consented as asked, and picking one would grant what nobody chose.
    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm({
        oauthQuery: `${oauthQuery}${named
          .map((value) => `&resource=${encodeURIComponent(value)}`)
          .join("")}`,
      }),
    );

    expect(state).toMatchObject({ status: "error" });
    expect(consent.bindConsent).not.toHaveBeenCalled();
  });

  test("still refuses a resource it does not serve", async () => {
    // Absence is an agent naming no resource. A value we do not recognise is
    // a request for something this server does not answer, and defaulting
    // that to `mcp` would hand out an audience nobody asked for.
    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm({
        oauthQuery: `${oauthQuery}&resource=${encodeURIComponent("https://elsewhere.invalid/mcp")}`,
      }),
    );

    expect(state).toMatchObject({ status: "error" });
    expect(consent.bindConsent).not.toHaveBeenCalled();
    // The browser gets fixed copy; the operator gets the name of the check.
    expect(logged.warn).toHaveBeenCalledWith(
      "oauth.agent_consent_refused",
      expect.objectContaining({ errorCode: expect.any(String) }),
    );
  });

  test("keeps a refused grant in the fixed banner", async () => {
    consent.bindConsent.mockRejectedValue(
      new DomainError("forbidden", "sentinel-must-never-reach-the-page"),
    );

    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm(),
    );

    expect(state.status).toBe("error");
    expect(state).not.toHaveProperty("field");
    expect(state.message).not.toContain("sentinel");
    expect(consent.invalidate).toHaveBeenCalledTimes(1);
  });

  test("keeps a changed client binding in the fixed banner", async () => {
    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm({ clientId: "client-somebody-else" }),
    );

    expect(state.status).toBe("error");
    expect(state).not.toHaveProperty("field");
    expect(consent.oauth2Consent).not.toHaveBeenCalled();
  });

  test("still redirects the browser when the grant is bound", async () => {
    await expect(
      approveAgentConsentAction(initialConsentActionState, approvalForm()),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(consent.bindConsent).toHaveBeenCalledTimes(1);
  });
});

function denialForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("oauthQuery", oauthQuery);
  data.set("clientId", "client-abcdef");
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);
  return data;
}

describe("denying an agent connection", () => {
  test("keeps a refusal in the fixed banner, addressed to no control", async () => {
    const data = new FormData();
    data.set("clientId", "client-abcdef");

    const state = await denyAgentConsentAction(initialConsentActionState, data);

    // No query at all: there is nothing to deny, and the page is reachable
    // unauthenticated, so the refusal says only the fixed sentence.
    expect(state.status).toBe("error");
    expect(state).not.toHaveProperty("field");
    expect(consent.oauth2Consent).not.toHaveBeenCalled();
  });

  test("still redirects the browser when the denial is recorded", async () => {
    await expect(
      denyAgentConsentAction(initialConsentActionState, denialForm()),
    ).rejects.toThrow("NEXT_REDIRECT");
  });

  test.each([
    ["names no agent scope", "client_id=client-abcdef"],
    [
      "names a resource this server does not answer",
      "client_id=client-abcdef&scope=request%3Aread&resource=https%3A%2F%2Felsewhere.invalid%2Fmcp",
    ],
  ])(
    "reaches the authorization server for a request that %s",
    async (_kind, query) => {
      // These are the requests the consent page draws a "this cannot be
      // approved" screen for. Denial is the only action left on them, and it
      // used to parse the signed request first — so it threw on exactly the
      // screens it existed to serve, and the person was handed a dead end with
      // no way out of it. The assertion is that the refusal now travels to the
      // authorization server rather than dying here; what that server makes of
      // the signature is its own business, and it verifies one either way.
      await expect(
        denyAgentConsentAction(
          initialConsentActionState,
          denialForm({ oauthQuery: query }),
        ),
      ).rejects.toThrow("NEXT_REDIRECT");

      expect(consent.oauth2Consent).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { accept: false, oauth_query: query },
        }),
      );
    },
  );
});

/**
 * A session that lapses between the screen being drawn and Allow being pressed.
 *
 * Every other dead end on this path was given words and a way out. This one
 * was silent: the gate redirected to a bare sign-in, sign-in had nothing to
 * resume, the person landed on the application with no mention of the agent,
 * and the agent waited out its loopback callback on a request nobody ever
 * answered. The signed query is on the submission, and
 * `sign-in/authorization-resume.ts` exists to pick exactly that up.
 */
describe("a session that lapses while the consent screen is open", () => {
  test("carries the authorization into sign-in rather than dropping it", async () => {
    lapsedSession.current = true;

    const thrown = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm(),
    ).catch((error: unknown) => error);

    expect(navigatedTo(thrown)).toBe(`redirect:/sign-in?${oauthQuery}`);
    // Nothing was authorized on the way past, and nothing may be: the whole
    // point of arriving here is that there is no longer anybody to ask.
    expect(consent.bindConsent).not.toHaveBeenCalled();
    expect(consent.oauth2Consent).not.toHaveBeenCalled();
  });

  test("carries it when the answer is a denial too", async () => {
    // Denial is the answer that ends the agent's wait, so losing the request
    // on the way to sign-in costs the same thing approving does.
    lapsedSession.current = true;

    const thrown = await denyAgentConsentAction(
      initialConsentActionState,
      denialForm(),
    ).catch((error: unknown) => error);

    expect(navigatedTo(thrown)).toBe(`redirect:/sign-in?${oauthQuery}`);
  });

  test("hands sign-in a query it assembled, not the characters submitted", async () => {
    // What is carried came in on a form that anyone can post, and it is about
    // to become a header. Rebuilt, a newline cannot end that header and a `#`
    // cannot reach past the path; echoed, both would travel as written.
    lapsedSession.current = true;

    const thrown = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm({ oauthQuery: "client_id=a b\nsig=x#/elsewhere" }),
    ).catch((error: unknown) => error);

    expect(navigatedTo(thrown)).toBe(
      "redirect:/sign-in?client_id=a+b%0Asig%3Dx%23%2Felsewhere",
    );
  });

  test("carries nothing at all when the query is implausibly long", async () => {
    // A `Location` competes with every other header for the response's budget,
    // and a signed authorization request is a few hundred characters. Dropping
    // one this size leaves exactly the bare sign-in this used to send.
    lapsedSession.current = true;

    const thrown = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm({ oauthQuery: `client_id=${"x".repeat(2_048)}` }),
    ).catch((error: unknown) => error);

    expect(navigatedTo(thrown)).toBe("redirect:/sign-in");
  });

  test("still resolves the session before it reads what was submitted", async () => {
    const form = approvalForm();
    const read: unknown[] = [];
    const entry = form.get.bind(form);
    form.get = (name: string) => {
      read.push(name);

      return entry(name);
    };

    await expect(
      approveAgentConsentAction(initialConsentActionState, form),
    ).rejects.toThrow("NEXT_REDIRECT");

    // The query reaches the gate as a thunk rather than as a value, and the
    // gate calls it only on the way out of a redirect it has already decided.
    // So a session that resolves leaves the submission untouched until the
    // schema reads it — the order this module holds every action to, and the
    // one an eager read would quietly give up.
    expect(read.filter((name) => name === "oauthQuery")).toHaveLength(1);
  });

  test("leaves every other unauthenticated request at a bare sign-in", async () => {
    // The gate is shared by every authenticated surface and only this path
    // hands it anything to carry. Written after the cases above on purpose: a
    // carry held anywhere but on the request that made it would still be here.
    const thrown = await unauthenticatedGate().catch((error: unknown) => error);

    expect(navigatedTo(thrown)).toBe("redirect:/sign-in");
  });
});

describe("the principal id a consent proposes", () => {
  test("keeps both nibbles the uuid format fixes", () => {
    // Proven on a digest chosen to break it, not on whatever a fixture's HMAC
    // happens to hold. An earlier attempt masked the version and left the
    // variant, and every test stayed green because those fixtures already had
    // a legal variant — ten of the sixteen values are not, so most real people
    // would have been handed an id `z.uuid()` refuses.
    const allF = uuidFromDigest("f".repeat(32));
    const allZero = uuidFromDigest("0".repeat(32));

    expect(allF).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(allZero).toBe("00000000-0000-4000-8000-000000000000");
    for (const shaped of [allF, allZero]) {
      expect(z.uuid().safeParse(shaped)).toMatchObject({ success: true });
    }
  });

  test("presents an identical binding on a retry", async () => {
    await expect(
      approveAgentConsentAction(initialConsentActionState, approvalForm()),
    ).rejects.toThrow("NEXT_REDIRECT");
    await expect(
      approveAgentConsentAction(initialConsentActionState, approvalForm()),
    ).rejects.toThrow("NEXT_REDIRECT");

    // The whole binding, not merely the id: the idempotency receipt
    // fingerprints all of it, so anything that moves between attempts makes a
    // retry conflict with the attempt before it. That conflict is permanent,
    // and retrying is the only thing a person can do.
    const [first] = consent.bindConsent.mock.calls[0] ?? [];
    const [, firstInput] = consent.bindConsent.mock.calls[0] ?? [];
    const [, secondInput] = consent.bindConsent.mock.calls[1] ?? [];
    expect(first).toBeDefined();
    expect(secondInput).toEqual(firstInput);
    expect(z.uuid().safeParse(firstInput?.newPrincipal?.id)).toMatchObject({
      success: true,
    });
  });

  test("hands two people different principals for one signed query", async () => {
    await expect(
      approveAgentConsentAction(initialConsentActionState, approvalForm()),
    ).rejects.toThrow("NEXT_REDIRECT");
    signedInUserId.current = "00000000-0000-4000-8000-0000000000bb";
    await expect(
      approveAgentConsentAction(initialConsentActionState, approvalForm()),
    ).rejects.toThrow("NEXT_REDIRECT");

    // The repository's fallback lookup matches a principal on organization and
    // id alone, so a shared id would bind the second person's grant silently to
    // the first person's principal. Nothing would report it.
    const [, mine] = consent.bindConsent.mock.calls[0] ?? [];
    const [, theirs] = consent.bindConsent.mock.calls[1] ?? [];
    expect(theirs?.newPrincipal?.id).not.toBe(mine?.newPrincipal?.id);
  });

  test("cannot be computed from the signed query alone", async () => {
    // Every public input held identical — the same link, the same person, the
    // same form — and only the command secret moved. This used to be asserted
    // of two constants handed to `uuidFromDigest`, which is pure string
    // slicing and holds no secret: the test named a security property and
    // exercised nothing that could have it, so rewriting the derivation as an
    // unkeyed digest of the oauth query — computable by anyone holding the
    // link, which is the very thing it forbids — left it green.
    await expect(
      approveAgentConsentAction(initialConsentActionState, approvalForm()),
    ).rejects.toThrow("NEXT_REDIRECT");
    environment.BETTER_AUTH_SECRET = "second-fixture-value-not-a-credential";
    await expect(
      approveAgentConsentAction(initialConsentActionState, approvalForm()),
    ).rejects.toThrow("NEXT_REDIRECT");

    const [, underOneSecret] = consent.bindConsent.mock.calls[0] ?? [];
    const [, underAnother] = consent.bindConsent.mock.calls[1] ?? [];
    expect(underOneSecret?.newPrincipal?.id).toEqual(expect.any(String));
    expect(underAnother?.newPrincipal?.id).not.toBe(
      underOneSecret?.newPrincipal?.id,
    );
  });
});

describe("being refused for trying too often", () => {
  test("says how long to wait, because that is the only actionable part", async () => {
    consent.bindConsent.mockRejectedValue(
      new DomainError("rate_limited", "Too many requests", {
        retryAfterSeconds: 42,
      }),
    );

    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm(),
    );

    // Without the number the person is told only that there were too many
    // attempts, which reads as an invitation to make another one now — and the
    // next attempt is refused for the same reason.
    expect(state).toMatchObject({
      status: "error",
      message:
        "Too many attempts. Wait a moment and try again in about 42 seconds.",
    });
  });

  test("still says something useful when the limiter names no wait", async () => {
    consent.bindConsent.mockRejectedValue(
      new DomainError("rate_limited", "Too many requests"),
    );

    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm(),
    );

    expect(state).toMatchObject({
      status: "error",
      message: "Too many attempts. Wait a moment and try again.",
    });
  });
});

describe("a refusal that names a field", () => {
  test("lands on the control rather than in the reload banner", async () => {
    // The binder names the control when it can. A slug already taken is
    // something a person fixes where they typed it; the banner for `conflict`
    // says to reload, which would fail again for the same reason.
    consent.bindConsent.mockRejectedValue(
      new DomainError("conflict", "That stable slug is already taken", {
        field: "slug",
      }),
    );

    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm(),
    );

    expect(state).toMatchObject({
      field: "slug",
      message: "That stable slug is already taken",
      status: "error",
    });
  });

  test("keeps a refusal naming no field in the banner", async () => {
    consent.bindConsent.mockRejectedValue(
      new DomainError("forbidden", "Agent principal is unavailable"),
    );

    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm(),
    );

    expect(state).toMatchObject({
      message: "You do not have permission to authorize this connection.",
      status: "error",
    });
    expect(state).not.toHaveProperty("field");
  });

  test("ignores a field the form does not have", async () => {
    consent.bindConsent.mockRejectedValue(
      new DomainError("conflict", "Something else", { field: "not-a-control" }),
    );

    const state = await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm(),
    );

    expect(state).not.toHaveProperty("field");
  });
});

describe("what a refused consent leaves behind", () => {
  test("names the client even when the query cannot be parsed", async () => {
    // The refusals that most needed naming are exactly the ones raised while
    // parsing the signed query, because that parse is what fails. The client
    // is nameable there because the identity is filled in from the submission
    // the moment the schema has read it — which is after the session and the
    // limiter, the order this application holds every action to, and before
    // anything that reads the signed query.
    await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm({ oauthQuery: "not-a-query" }),
    );

    const [, fields] = logged.warn.mock.calls[0] ?? [];
    expect(fields?.credentialFingerprint).toEqual(expect.any(String));
    expect(fields?.errorCode).toEqual(expect.any(String));
  });

  test("names the person once the session has resolved", async () => {
    consent.bindConsent.mockRejectedValue(new DomainError("forbidden", "no"));

    await approveAgentConsentAction(initialConsentActionState, approvalForm());

    const [, fields] = logged.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({
      actorId: "00000000-0000-4000-8000-0000000000aa",
      actorType: "user",
    });
  });

  test("never writes the client down, only a digest of it", async () => {
    await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm({ oauthQuery: "not-a-query" }),
    );

    // A client id is not a secret, but it is request-supplied, and the rule
    // here is that nothing a request carried appears verbatim. A digest joins
    // two lines together just as well.
    const [, fields] = logged.warn.mock.calls[0] ?? [];
    expect(JSON.stringify(fields)).not.toContain("client-abcdef");
  });

  test("names no client when the refusal predates authorization", async () => {
    // The order this application holds every action to: the session and the
    // limiter before the submission. Naming the client here would mean having
    // read the form before anyone had established the right to ask — so a
    // refusal raised this early names nobody, and that is the point.
    sessionFailure.current = new DomainError("unauthenticated", "no session");

    await approveAgentConsentAction(
      initialConsentActionState,
      approvalForm({ oauthQuery: "not-a-query" }),
    );

    const [, fields] = logged.warn.mock.calls[0] ?? [];
    expect(fields?.errorCode).toEqual(expect.any(String));
    expect(fields?.credentialFingerprint).toBeUndefined();
    expect(fields?.actorId).toBeUndefined();
  });
});
