import { expect } from "@playwright/test";
import {
  cleanupDeniedIdentity,
  clearMagicLinkOutbox,
  createFoundationScenario,
  expectNoIdentity,
  findMagicLink,
  submitMagicLinkRequest,
} from "../fixtures/auth.js";
import { test } from "../fixtures/engine.ts";

test.describe
  .serial("restricted authentication", () => {
    test.beforeEach(async ({ request }) => {
      await clearMagicLinkOutbox(request);
    });

    test.afterEach(async ({ request }) => {
      await clearMagicLinkOutbox(request);
    });

    test("redirects protected access and offers both approved sign-in methods", async ({
      page,
    }) => {
      await page.goto("/");

      await expect(page).toHaveURL(/\/sign-in$/u);
      await expect(
        page.getByRole("button", { name: "Continue with GitHub" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Email me a sign-in link" }),
      ).toBeVisible();
    });

    test("keeps unknown-email initiation neutral without creating a test email", async ({
      page,
      request,
    }) => {
      const scenario = createFoundationScenario("denied");

      try {
        await submitMagicLinkRequest(page, scenario.ownerEmail);

        await expect(page.getByRole("status")).toHaveText(
          "If that address can sign in, a link is on its way.",
        );
        await expect(
          findMagicLink(request, scenario.ownerEmail),
        ).resolves.toBeNull();
        await expectNoIdentity(scenario.ownerEmail);
      } finally {
        await cleanupDeniedIdentity(scenario.ownerEmail);
      }
    });
  });
