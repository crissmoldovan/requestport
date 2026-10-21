/**
 * What the sign-in page hands its form, rather than what the form draws.
 *
 * A client component's props never reach static markup, so a test that greps
 * rendered HTML for the resumed address passes whether or not the page
 * resolved one. This reads the prop, which is where the decision is.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const handed = vi.hoisted(() => ({
  resumeTo: undefined as string | undefined,
}));

vi.mock("./sign-in-form.js", () => ({
  AUTH_SUCCESS_PATH: "/",
  SignInForm: (props: { resumeTo?: string }) => {
    handed.resumeTo = props.resumeTo;
    return null;
  },
}));

import SignInPage from "./page.js";

async function render(
  searchParams?: Record<string, string | string[] | undefined>,
) {
  handed.resumeTo = undefined;
  renderToStaticMarkup(
    (await SignInPage(
      searchParams ? { searchParams: Promise.resolve(searchParams) } : {},
    )) as ReactElement,
  );

  return handed.resumeTo;
}

/**
 * `exp` is seconds since the epoch, and the provider mints it minutes ahead of
 * the moment it signs. Written as a literal it would stand for a live
 * authorization only until that second arrived and for a lapsed one ever
 * after, so it is dated from the clock the test is running against.
 */
function epochSeconds(offset: number) {
  return String(Math.floor(Date.now() / 1000) + offset);
}

function agentAuthorization(
  overrides: Record<string, string | string[]> = {},
): Record<string, string | string[]> {
  return {
    ba_param: ["client_id", "redirect_uri"],
    client_id: "agent-client",
    exp: epochSeconds(600),
    redirect_uri: "http://127.0.0.1:41999/callback",
    response_type: "code",
    scope: "offline_access project:provision",
    sig: "a-signature",
    state: "agent-state",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "test");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "test");
});

describe("an authorization waiting on sign-in", () => {
  test("is handed back to the provider once there is somebody to ask", async () => {
    const resumeTo = await render(agentAuthorization());

    expect(resumeTo).toBeDefined();
    const url = new URL(resumeTo ?? "", "https://requestport.com");
    expect(url.pathname).toBe("/api/auth/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("agent-client");
    expect(url.searchParams.get("sig")).toBe("a-signature");
    expect(url.searchParams.getAll("ba_param")).toEqual([
      "client_id",
      "redirect_uri",
    ]);
  });

  test("is absent for a person who simply came here to sign in", async () => {
    expect(await render()).toBeUndefined();
    expect(await render({})).toBeUndefined();
  });

  test("is absent when the query carries no signature to verify", async () => {
    const { sig: _sig, ...unsigned } = agentAuthorization();

    expect(await render(unsigned)).toBeUndefined();
  });

  test.each([1, 600])(
    "still resumes %i seconds after the query's own exp went by",
    async (secondsAgo) => {
      // Asserted from the page as well as from the helper, because the
      // tempting reading of a lapsed `exp` is that the request is dead, and it
      // is not. `GET /oauth2/authorize` does not admit `exp` into its query
      // schema, so the one in this link is dropped unread; `signParams` then
      // mints a fresh expiry ten minutes out and re-signs. Somebody who leaves
      // this page open past the ten minutes, or signs in through a slow
      // identity provider, still has an authorization the provider will carry
      // — and refusing it here is the only thing that would take it from them.
      expect(
        await render(agentAuthorization({ exp: epochSeconds(-secondsAgo) })),
      ).toBeDefined();
    },
  );
});
