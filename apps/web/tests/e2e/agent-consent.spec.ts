import { expect } from "@playwright/test";
import { testPool } from "@requestport/db/testing";
import {
  authorizeUrl,
  CONSENT_ORIGIN,
  consentGateState,
  redeemAndUse,
  registerClient,
} from "../fixtures/agent-consent.js";
import {
  bootstrapOwner,
  cleanupFoundationScenario,
  clearMagicLinkOutbox,
  createFoundationScenario,
  fixtureStorage,
  signInWithMagicLink,
} from "../fixtures/auth.js";
import { test } from "../fixtures/engine.ts";
// `test` comes from the engine fixture, never from the package: the guard that
// skips an engine this host cannot drive lives on that extended `test`, and a
// spec importing around it turns an accounted-for limitation into a red run.
import { serverAnswerTimeoutMs } from "../fixtures/server-answer-budget.ts";
import { onScreen } from "../fixtures/shell.js";

/**
 * The journey nothing covered, and the reason five separate defects reached
 * production in one path.
 *
 * Every other test of agent consent mocks Better Auth, so each one asserted the
 * contract its author believed rather than the one the library keeps. This
 * drives the real endpoint in a real browser against a real database: register
 * a client the way an agent does, walk the authorization request, approve it,
 * and require that an authorization code comes back and a grant exists.
 *
 * The client registration, the authorization URL, the gate report and the
 * code redemption now live in `../fixtures/agent-consent.ts`, shared with the
 * cross-principal journey that continues past the credential this one stops at.
 */
const ORIGIN = CONSENT_ORIGIN;
const CLIENT_NAME = "Agent consent journey";

test.describe("agent consent", () => {
  /**
   * The ordinary first connection: nobody is signed in when the agent asks.
   *
   * The provider does not refuse an authorization that arrives without a
   * session — it redirects to sign-in carrying the whole signed request, to be
   * resumed once there is somebody to ask. Sign-in used to land every success
   * on `/`, which discarded the request at the moment it became answerable:
   * the person reached the overview with a session and no sign anything was
   * pending, this screen was never drawn, and the agent waited on its loopback
   * callback until it timed out.
   *
   * The journey below cannot see that, because it signs in before it asks. So
   * this one asks first, the way an agent does.
   */
  test("reaches consent when the authorization arrives before the session", async ({
    page,
    request,
  }) => {
    const scenario = createFoundationScenario("consent-signed-out");
    await clearMagicLinkOutbox(request);
    await bootstrapOwner(scenario);

    try {
      // An organization first, because a provisioning consent has nothing to
      // offer without a membership.
      await signInWithMagicLink(page, request, scenario.ownerEmail);
      await onScreen(page.getByLabel("Organization name")).fill(
        scenario.uiOrganizationName,
      );
      await onScreen(page.getByLabel("Organization slug")).fill(
        scenario.uiOrganizationSlug,
      );
      await page.getByRole("button", { name: "Create organization" }).click();
      await expect(
        page.getByRole("heading", { name: "Overview" }),
      ).toBeVisible();

      const clientId = await registerClient(ORIGIN, CLIENT_NAME);
      const authorize = authorizeUrl(ORIGIN, clientId);

      // Signed out, the way a person is when an agent first asks.
      await page.context().clearCookies();
      await clearMagicLinkOutbox(request);

      await page.goto(authorize);
      await expect(
        page,
        "an authorization without a session must reach sign-in, not an error",
      ).toHaveURL(/\/sign-in/u);

      // Sign in from where the provider put them, and the authorization has to
      // survive the round trip.
      await signInWithMagicLink(page, request, scenario.ownerEmail, {
        landsOn: /\/oauth\/agent-consent/u,
        startAt: authorize,
      });

      await expect(
        page.getByRole("button", { name: "Allow connection" }),
        `signing in discarded the authorization.\n` +
          `landed on: ${new URL(page.url()).pathname}\n` +
          `body: ${(await page.locator("body").innerText()).slice(0, 200)}`,
      ).toBeVisible();
    } finally {
      await cleanupFoundationScenario(scenario).catch(() => undefined);
    }
  });

  test("issues an authorization code and binds a provisioning grant", async ({
    page,
    request,
  }) => {
    const scenario = createFoundationScenario("consent");
    await clearMagicLinkOutbox(request);
    await bootstrapOwner(scenario);

    // Everything the server said, in order. When this journey fails, the
    // failure is a transcript rather than a guess.
    const exchanges: string[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin !== ORIGIN) return;
      if (url.pathname.startsWith("/_next/")) return;
      exchanges.push(
        `${response.status()} ${response.request().method()} ${url.pathname}`,
      );
    });

    // Stand in for the agent's loopback receiver. Without it the browser
    // reaches the callback and Chrome answers with its own connection-error
    // page, which replaces the address — the destination is the whole answer
    // here, so it has to survive arrival.
    await page.route("http://127.0.0.1:41999/**", async (route) => {
      await route.fulfill({
        body: "callback received",
        contentType: "text/plain",
        status: 200,
      });
    });

    try {
      await signInWithMagicLink(page, request, scenario.ownerEmail);

      // `bootstrap-owner` leaves no membership until its second stage, and a
      // provisioning consent has nothing to offer without one — the screen it
      // renders instead is `notFound()`, which reads as a mistyped address.
      // So the organization is made the way a person makes it.
      await expect(
        page.getByRole("heading", { name: "Create your first organization" }),
      ).toBeVisible();
      await onScreen(page.getByLabel("Organization name")).fill(
        scenario.uiOrganizationName,
      );
      await onScreen(page.getByLabel("Organization slug")).fill(
        scenario.uiOrganizationSlug,
      );
      await page.getByRole("button", { name: "Create organization" }).click();
      await expect(
        page.getByRole("heading", { name: "Overview" }),
      ).toBeVisible();

      const clientId = await registerClient(ORIGIN, CLIENT_NAME);
      await page.goto(authorizeUrl(ORIGIN, clientId));

      // The consent screen, not a sign-in bounce and not an error boundary.
      await expect(page).toHaveURL(/\/oauth\/agent-consent/u);
      const arrived = new URL(page.url());
      const allow = page.getByRole("button", { name: "Allow connection" });
      await expect(
        allow,
        `consent screen did not render.\n` +
          `landed on: ${arrived.pathname}\n` +
          `query keys: ${[...new Set([...arrived.searchParams.keys()])].join(", ") || "(none)"}\n` +
          `body: ${(await page.locator("body").innerText()).slice(0, 200)}\n` +
          `${await consentGateState(clientId, scenario.ownerEmail)}\n` +
          `transcript:\n${exchanges.slice(-14).join("\n")}`,
      ).toBeVisible();

      // Wait on the submission itself. Waiting on a url that already matches
      // resolves before the click has been answered, which is how the first
      // version of this journey reported the page it started on.
      const [submission] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/oauth/agent-consent",
          { timeout: serverAnswerTimeoutMs },
        ),
        allow.click(),
      ]);
      /*
        The suite's budget, not half of it.

        This waits on the same thing every other assertion here waits on — a
        server answer that round-trips to a remote database branch. A literal of
        its own said the wait was different when it is not, and it said so at
        half the budget, on lanes that run two and a half times slower than the
        one it was measured on. A redirect that arrived late would have read as
        a consent that issued no code.
      */
      await page
        .waitForURL(/127\.0\.0\.1:41999/u, { timeout: serverAnswerTimeoutMs })
        .catch(() => undefined);

      const banner = await page
        .getByRole("alert")
        .first()
        .innerText()
        .catch(() => "");
      const report =
        `consent POST answered ${submission.status()}\n` +
        `banner: ${banner.replaceAll("\n", " ").slice(0, 200) || "(none)"}\n` +
        `${await consentGateState(clientId, scenario.ownerEmail)}\n` +
        `transcript:\n${exchanges.slice(-10).join("\n")}`;

      const landed = new URL(page.url());
      expect(landed.host, report).toBe("127.0.0.1:41999");
      expect(
        landed.searchParams.get("code"),
        "an approved consent must issue an authorization code",
      ).toBeTruthy();
      expect(landed.searchParams.get("error")).toBeNull();

      // And the code is spent, because a code is not a credential.
      await redeemAndUse(
        ORIGIN,
        clientId,
        landed.searchParams.get("code") ?? "",
      );
    } finally {
      // Cleanup must never replace the verdict. This journey leaves rows the
      // shared teardown does not know about — a registered client, its consent,
      // the grant it binds — and a throw here would report the tidying instead
      // of the thing being tested.
      // The shared teardown predates agents and cannot delete a user who
      // created a principal. What this journey makes, this journey removes —
      // in reference order, and scoped to its own owner rather than the table.
      await testPool(fixtureStorage())
        .query(
          `DELETE FROM "agent_oauth_grants"
            WHERE "user_id" IN (SELECT "id" FROM "user" WHERE lower("email") = lower($1))`,
          [scenario.ownerEmail],
        )
        .catch(() => undefined);
      await testPool(fixtureStorage())
        .query(
          `DELETE FROM "agent_principals"
            WHERE "created_by_user_id" IN (SELECT "id" FROM "user" WHERE lower("email") = lower($1))`,
          [scenario.ownerEmail],
        )
        .catch(() => undefined);
      await testPool(fixtureStorage())
        .query('DELETE FROM "oauth_client" WHERE "name" = $1', [CLIENT_NAME])
        .catch(() => undefined);
      await cleanupFoundationScenario(scenario).catch((error: unknown) => {
        console.error(`cleanup did not complete: ${String(error)}`);
      });
    }
  });
});
