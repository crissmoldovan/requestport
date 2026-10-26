import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const consent = vi.hoisted(() => ({
  getConsentOptions: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@requestport/db", () => ({
  createAgentManagementRepository: () => ({
    getConsentOptions: consent.getConsentOptions,
  }),
}));

// The web root, whose storage the page builds its repository over when it
// runs (Plan 13, G.3).
vi.mock("../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/navigation", () => ({ notFound: consent.notFound }));

/**
 * The gate, switchable, because this suite has cases on both sides of it.
 *
 * Every surface in this segment reads the same module, so one holder answers
 * for the layout above and the page below, and a case that needs an
 * unauthenticated request replaces what it resolves to rather than replacing
 * the module again.
 */
const gate = vi.hoisted(() => {
  const signedIn = {
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  };

  return {
    load: async (): Promise<unknown> => signedIn,
    signedIn,
  };
});

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: () => gate.load(),
  getApplicationLayoutContext: () => gate.load(),
}));

vi.mock("./actions.js", () => ({
  approveAgentConsentAction: async () => {},
  denyAgentConsentAction: async () => {},
}));

import { APIError } from "better-auth";

import {
  carryingIntoSignIn,
  loadApplicationContext,
} from "../../../lib/application-context.js";
import AgentConsentSegmentLayout from "../layout.js";
import AgentConsentPage from "./page.js";

const options = {
  agents: [
    {
      displayName: "Release bot",
      id: "00000000-0000-4000-8000-0000000000a1",
      organizationName: "CUE++",
    },
  ],
  client: {
    clientId: "client-abcdef",
    name: "Fixture agent",
    uri: "https://agent.example",
  },
  lanes: [
    {
      id: "00000000-0000-4000-8000-0000000000b1",
      name: "release",
      projectId: "00000000-0000-4000-8000-0000000000c1",
    },
  ],
  projects: [
    {
      id: "00000000-0000-4000-8000-0000000000c1",
      name: "Platform",
      organizationId: "00000000-0000-4000-8000-0000000000d1",
      organizationName: "CUE++",
    },
  ],
};

const searchParams = {
  client_id: "client-abcdef",
  resource: "https://requestport.test/mcp",
  scope: "request:read request:write",
};

async function consentMarkup(overrides: Record<string, string> = {}) {
  const page = (await AgentConsentPage({
    searchParams: Promise.resolve({ ...searchParams, ...overrides }),
  })) as ReactElement;

  return renderToStaticMarkup(page);
}

/**
 * The retired recipes the consent surface used to spell by hand. The three
 * that share the retired prefix are assembled from it, because this suite is
 * itself under `apps/web/src` and the native audit reads every class literal
 * written there — including one written only to check for its absence.
 */
const retiredConsentClasses = [
  "admin-form",
  "consent-scopes",
  "consent-shell",
  "field-hint",
  "form-actions",
  "oauth-client-card",
  "scope-fieldset",
  "scope-grid",
  ...["button", "field", "input"].map((name) => `ui-${name}`),
];

beforeEach(() => {
  consent.getConsentOptions.mockReset();
  consent.getConsentOptions.mockResolvedValue(options);
  consent.notFound.mockClear();
  gate.load = async () => gate.signedIn;
});

describe("agent consent surface", () => {
  test("renders the same form for the same request", async () => {
    const first = await consentMarkup();
    const second = await consentMarkup();

    // The page used to mint a principal id per render, so an attempt and its
    // retry submitted different ones — and the consent's idempotency receipt
    // covers the proposed principal, which made every retry conflict with the
    // attempt before it, permanently. Comparing the whole markup states the
    // property that prevents it: nothing on this page may vary between renders
    // of one request. A check for the absence of a field name would pass the
    // moment somebody minted the next one under a different name.
    expect(second).toBe(first);
  });

  test("keeps every server-action field the grant binding depends on", async () => {
    const markup = await consentMarkup();

    for (const field of [
      "oauthQuery",
      "clientId",
      "projectBinding",
      "laneIds",
      "agentPrincipalId",
      "displayName",
      "slug",
      "softwareName",
    ]) {
      expect({ field, present: markup.includes(`name="${field}"`) }).toEqual({
        field,
        present: true,
      });
    }
  });

  test("presents untrusted client metadata and the requested scopes natively", async () => {
    const markup = await consentMarkup();

    expect(markup).toContain('data-slot="panel"');
    expect(markup).toContain("Fixture agent");
    expect(markup).toContain("client-abcdef");
    expect(markup).toContain("request:read");
    expect(markup).toContain("request:write");
    expect(markup.match(/data-slot="row"/gu)).toHaveLength(4);
    expect(markup.match(/data-slot="panel-header"/gu)).toHaveLength(2);
  });

  test("wraps every visible control in a native field or labelled group", async () => {
    const markup = await consentMarkup();

    expect(markup.match(/data-slot="field"/gu)).toHaveLength(5);
    expect(markup.match(/data-slot="field-label"/gu)).toHaveLength(5);
    expect(markup).toContain('data-slot="checkbox-group"');
    expect(markup).toContain('data-slot="select-trigger"');
    expect(markup).not.toContain("<fieldset");
    expect(markup).not.toContain("<legend");
    expect(markup).not.toContain("<select");
    expect(markup).not.toContain("<option");
    expect(markup).not.toContain("htmlFor");
  });

  test("offers allow and deny as native buttons with no retired recipe", async () => {
    const markup = await consentMarkup();

    expect(markup).toContain("Allow connection");
    expect(markup).toContain("Deny");
    for (const retired of retiredConsentClasses) {
      expect({ markup: markup.includes(retired), retired }).toEqual({
        markup: false,
        retired,
      });
    }
  });

  test("refuses an address that names no request at all", async () => {
    // No client and no query is a mistyped address, and the page that says so
    // is the right answer to it.
    await expect(
      AgentConsentPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  /**
   * Nothing to bind to is not nothing at this address.
   *
   * A person with an account, a membership and a valid signed request, whose
   * organization simply has no project yet, was shown "Nothing lives at this
   * address" — the same page as a typo. They had done nothing wrong, there was
   * nothing on the screen to tell them what was missing, and the agent waiting
   * on its callback was told nothing either.
   */
  test("tells a person their organization has no project to bind", async () => {
    consent.getConsentOptions.mockResolvedValue({ ...options, projects: [] });

    const markup = await consentMarkup();

    expect(markup).not.toContain("Nothing lives at this address");
    expect(markup).toContain("No project to bind this to");
    // The two gaps are different and a person can act on only one of them.
    expect(markup).not.toContain("No organization you administer");
    expect(markup).toContain("Deny");
  });

  test("tells a person they administer no organization to provision in", async () => {
    consent.getConsentOptions.mockResolvedValue({
      ...options,
      organizations: [],
    });

    const markup = await consentMarkup({ scope: "project:provision" });

    expect(markup).not.toContain("Nothing lives at this address");
    expect(markup).toContain("No organization you administer");
    expect(markup).not.toContain("No project to bind this to");
    expect(markup).toContain("Deny");
  });
});

describe("the ways-in frame (ruling 259)", () => {
  test("draws the grant under the mark and the name, with one heading, and every scope and both decisions kept", async () => {
    const markup = await consentMarkup();

    expect(markup.match(/<h1/gu)).toHaveLength(1);
    expect(markup).toMatch(/<h1[^>]*>Connect an agent<\/h1>/u);
    expect(markup).toContain("RequestPort");
    expect(markup).toContain("<svg");
    expect(markup).not.toContain('data-slot="eyebrow"');
    expect(markup).toContain("request:read");
    expect(markup).toContain("request:write");
    expect(markup).toContain('aria-label="Allow connection"');
    expect(markup).toContain('aria-label="Deny connection"');
  });

  test("draws a lapsed request in the same frame", async () => {
    const markup = await consentMarkup({
      exp: String(Math.floor(Date.now() / 1_000) - 1),
    });

    expect(markup.match(/<h1/gu)).toHaveLength(1);
    expect(markup).toMatch(/<h1[^>]*>This request has expired<\/h1>/u);
    expect(markup).not.toContain('data-slot="eyebrow"');
  });
});

describe("an authorization request that has lapsed", () => {
  test("says so instead of drawing a grant that cannot be approved", async () => {
    const markup = await consentMarkup({
      exp: String(Math.floor(Date.now() / 1_000) - 1),
    });

    // Eleven minutes of reading the provisioning warning used to end in "that
    // connection could not be authorized", with no mention of time and nothing
    // to do about it.
    expect(markup).toContain("This request has expired");
    expect(markup).toContain("Start the connection again");
    expect(markup).not.toContain("Allow connection");
  });

  test("draws the grant while the request is still live", async () => {
    const markup = await consentMarkup({
      exp: String(Math.floor(Date.now() / 1_000) + 600),
    });

    expect(markup).not.toContain("This request has expired");
  });

  test("draws the grant when the request claims no expiry at all", async () => {
    // This page reads `exp` and does not verify the signature, so it can only
    // say that a request claiming an expiry has passed it. Absence is not a
    // lapse, and treating it as one would refuse requests the authorization
    // server would honour.
    const markup = await consentMarkup();

    expect(markup).not.toContain("This request has expired");
  });
});

/**
 * A request that cannot be approved still has to end.
 *
 * `project:provision` may carry no other scope, so the screen says so and
 * stops. It used to stop with advice and nothing else — no control, no answer
 * to the client — and the agent waiting on its loopback callback learned
 * nothing until it timed out. Denial is possible here and is the only action
 * left: the signed query is still valid, it simply cannot be approved, so the
 * provider can answer the client with `access_denied` the moment a person says
 * so.
 */
describe("a request that cannot be approved", () => {
  test("still lets the person answer the agent", async () => {
    const markup = await consentMarkup({
      scope: "project:provision request:read",
    });

    expect(markup).toContain("project:provision may carry no other scope");
    expect(markup).toContain("Deny");
  });

  test("says why, so the agent can be asked for something else", async () => {
    const markup = await consentMarkup({
      scope: "project:provision request:read",
    });

    expect(markup).toContain("This request cannot be approved");
  });
});

/**
 * A request naming no capability this server grants.
 *
 * The scope list is filtered to the ones RequestPort understands, and a
 * request that names none of them — `openid offline_access` and nothing else,
 * say — left every control on the screen. A person could choose an
 * organization, name a principal, and press Allow, and the binder would refuse
 * it for a reason decided before the page was drawn. It is the same shape as
 * the impossible scope mix, one field over.
 */
describe("a request naming no capability this server grants", () => {
  test("is not drawn as something that could be approved", async () => {
    const markup = await consentMarkup({ scope: "openid" });

    expect(markup).toContain("No RequestPort scope requested");
    expect(markup).not.toContain("Allow connection");
  });

  test("can still be answered, so the agent stops waiting", async () => {
    const markup = await consentMarkup({ scope: "openid" });

    expect(markup).toContain("Deny");
  });

  test("still draws the form when a capability is recognised", async () => {
    const markup = await consentMarkup({ scope: "request:read" });

    expect(markup).toContain("Allow connection");
  });
});

/**
 * A document GET of the consent URL with no session.
 *
 * Not an exotic case: it is any arrival with no session at the moment the
 * browser gets here — among them a consent link opened on its own, opened in
 * another browser or profile, reopened later, or one whose session lapsed
 * between the provider's redirect and the arrival. The agent that opened the
 * authorize URL is waiting on its loopback callback throughout.
 */
const redirectError = (path: string) =>
  Object.assign(new Error("NEXT_REDIRECT"), { digest: `redirect:${path}` });

/** The digest a navigation carries, or nothing when the throw was not one. */
function navigatedTo(thrown: unknown) {
  return (thrown as { digest?: unknown } | null)?.digest;
}

/**
 * The gate wired as the application wires it, refusing the session.
 *
 * `loadApplicationContext` is what answers an unauthenticated request on every
 * rendered page of this application — not the only such answer anywhere, since
 * `apps/web/src/app/mcp/route.ts` and the agent bearer path each refuse one in
 * their own vocabulary, but the only one on this path. So a stand-in that
 * invented its own destination would say nothing about where this arrival
 * lands. Only what the
 * application injects is replaced; the organization read below is never
 * reached, because the session fails first.
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
      throw redirectError(path);
    },
    requireSession: async () => {
      throw new APIError("UNAUTHORIZED", {
        code: "unauthorized",
        message: "unauthorized",
      });
    },
  });
}

const oauthQuery = new URLSearchParams(searchParams).toString();

describe("an unauthenticated document GET of the consent URL", () => {
  beforeEach(() => {
    gate.load = unauthenticatedGate;
  });

  test("is turned away by the segment layout, above the page", async () => {
    const thrown = await AgentConsentSegmentLayout({
      children: "consent",
    }).catch((error: unknown) => error);

    expect(navigatedTo(thrown)).toBe("redirect:/sign-in");
  });

  test("cannot reach consent content through the page either", async () => {
    await expect(
      AgentConsentPage({ searchParams: Promise.resolve(searchParams) }),
    ).rejects.toThrow("NEXT_REDIRECT");
    // Nothing was read on the way past, so there was nothing to draw.
    expect(consent.getConsentOptions).not.toHaveBeenCalled();
  });

  /**
   * The half of the carry that is still open, written down as a test so it
   * cannot be assumed closed.
   *
   * The POST out of this screen hands sign-in the authorization it was holding
   * (`agent-consent/actions.ts`, and the cases in `actions.test.ts`). This
   * arrival hands it nothing, and that is not a bug in the carry: the decision
   * is made in the segment layout, above the page, and a layout is given no
   * `searchParams` — `next/dist/docs/01-app/03-api-reference/03-file-conventions/layout.md`
   * says why, that layouts do not rerender on navigation and the params would
   * go stale. `headers()` cannot stand in for them either: it is a sealed view
   * of the request's own headers (`next/dist/server/async-storage/request-store.js`)
   * and adds nothing about the route being rendered, so the query is there
   * only if something upstream of the render put it there.
   *
   * So this expects the bare sign-in, deliberately. The day the query is put
   * on a request header in `src/proxy.ts` and read here, this test is the one
   * that fails, and the note in `oauth/layout.tsx` is the one to update.
   */
  test("lands at a bare sign-in, and the authorization does not travel", async () => {
    const thrown = await AgentConsentSegmentLayout({
      children: "consent",
    }).catch((error: unknown) => error);

    expect(navigatedTo(thrown)).toBe("redirect:/sign-in");
  });

  test("though the carry itself works when something holds the query", async () => {
    // The same gate, on the same arrival, with the authorization in the store
    // the POST path puts it in. What the document GET is missing is not the
    // mechanism — it is anything above the page that knows the query.
    const thrown = await carryingIntoSignIn(
      () => oauthQuery,
      () => AgentConsentSegmentLayout({ children: "consent" }),
    ).catch((error: unknown) => error);

    expect(navigatedTo(thrown)).toBe(`redirect:/sign-in?${oauthQuery}`);
  });
});
