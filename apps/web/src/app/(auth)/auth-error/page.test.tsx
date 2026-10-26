/**
 * The auth error page, in the frame the ways in share (ruling 259): the mark
 * and the name, its one heading, and a card that says what happened and leads
 * back to sign-in. Only the two fixed messages are ever drawn; the provider's
 * own reason never reaches the page.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

// A guarded local run uses this to reach the segment's boundaries; there is no
// run here.
vi.mock("../../../lib/server-scenario-boundary.js", () => ({
  applyE2EScenarioBoundary: async () => undefined,
}));

import AuthErrorPage from "./page.js";

async function markup(error?: string | string[]) {
  return renderToStaticMarkup(
    (await AuthErrorPage({
      searchParams: Promise.resolve(error === undefined ? {} : { error }),
    })) as ReactElement,
  );
}

describe("the auth error page", () => {
  test("draws one heading under the mark and the name, and a card leading back to sign-in", async () => {
    const html = await markup();

    expect(html.match(/<h1/gu)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Sign-in unavailable<\/h1>/u);
    expect(html).toContain("RequestPort");
    expect(html).toContain("<svg");
    expect(html).toContain('data-slot="card"');
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain("Return to sign in");
    expect(html).not.toContain('data-slot="eyebrow"');
  });

  test("says only one of its two fixed messages, whatever the provider sent", async () => {
    expect(await markup("signup_disabled")).toContain(
      "This RequestPort is invite-only",
    );
    const other = await markup("<script>provider detail</script>");
    expect(other).toContain("We couldn’t sign you in. Please try again.");
    expect(other).not.toContain("provider detail");
  });
});
