import { expect, type Page } from "@playwright/test";
import { collectConsole } from "../fixtures/acceptance-run.js";
import {
  bootstrapOwner,
  cleanupFoundationScenario,
  clearMagicLinkOutbox,
  createFoundationScenario,
  expectDistinctTenantAppearance,
  organizationTheme,
  signInWithMagicLink,
} from "../fixtures/auth.js";
import { test } from "../fixtures/engine.ts";
import {
  chooseOption,
  chooseOrganization,
  expectOrganizationChoices,
  onScreen,
} from "../fixtures/shell.js";

/**
 * The account menu is a CUE popover: a labelled trigger button opening a dialog,
 * rather than the retired `<details class="user-control"><summary>` markup. The
 * journey drives its accessible contract so it does not depend on either shape.
 */
async function signOutFromAccountMenu(page: Page) {
  await page.getByRole("button", { name: /^Open user menu for/u }).click();
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Sign out" }).click();
}

test("completes owner setup, project administration, invitation, and member access", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  // A hydration complaint here has been fixed for the second time as something
  // else. React recovers from one by re-rendering the subtree on the client
  // while the server's markup is still in the document, so the page ends up
  // with two of a control — and the journey fails several steps later on a
  // selector that matched twice, naming a label rather than the cause. Run
  // 33674350371 lost this test to exactly that: two `Email address` inputs,
  // one carrying a server-generated identifier and one a client-generated one.
  //
  // The appearance drivers already refuse a hydration complaint. This journey
  // collected nothing, which is why the same fault reads as a flake here and as
  // a failure there.
  const consoleLog = collectConsole(page);
  const scenario = createFoundationScenario("foundation");

  try {
    await clearMagicLinkOutbox(request);
    await bootstrapOwner(scenario);
    await signInWithMagicLink(page, request, scenario.ownerEmail);

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
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

    await bootstrapOwner(scenario);
    // Stage two seeded the bootstrap tenant's appearance row and moved it off
    // the shared default. Everything below compares two triples, so the two
    // being different is asserted here rather than assumed by the comparisons.
    await expectDistinctTenantAppearance(scenario);
    await page.reload();
    await expectOrganizationChoices(page, 2);
    await chooseOrganization(
      page,
      scenario.bootstrapOrganizationName,
      scenario.bootstrapOrganizationSlug,
      await organizationTheme(scenario.bootstrapOrganizationSlug),
    );
    await chooseOrganization(
      page,
      scenario.uiOrganizationName,
      scenario.uiOrganizationSlug,
      await organizationTheme(scenario.uiOrganizationSlug),
    );

    await page.goto("/settings/projects/new");
    await onScreen(page.getByLabel("Project name")).fill(scenario.projectName);
    await onScreen(page.getByLabel("Request key prefix")).fill(
      scenario.projectKey,
    );
    await onScreen(page.getByLabel("Project slug")).fill(scenario.projectSlug);
    await onScreen(page.getByLabel("GitHub repository")).fill(
      scenario.repositoryUrl,
    );
    await page.getByRole("button", { name: "Create project" }).click();
    // Exact: the page title and the section heading ("Registered projects")
    // are both headings now, and a substring match resolves to both.
    await expect(
      page.getByRole("heading", { exact: true, name: "Projects" }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: scenario.projectName }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: scenario.repositorySlug }),
    ).toBeVisible();

    await page.goto("/settings/projects/new");
    await onScreen(page.getByLabel("Project name")).fill(
      `${scenario.projectName} duplicate`,
    );
    await onScreen(page.getByLabel("Request key prefix")).fill(
      scenario.projectKey,
    );
    await onScreen(page.getByLabel("Project slug")).fill(
      `${scenario.projectSlug}-duplicate`,
    );
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator('[data-code="conflict"]')).toHaveText(
      "That canonical value is already in use.",
    );

    await page.goto("/settings/projects/new");
    await onScreen(page.getByLabel("Project name")).fill(
      `${scenario.projectName} invalid repository`,
    );
    await onScreen(page.getByLabel("Request key prefix")).fill(
      scenario.invalidProjectKey,
    );
    await onScreen(page.getByLabel("Project slug")).fill(
      `${scenario.projectSlug}-invalid`,
    );
    await onScreen(page.getByLabel("GitHub repository")).fill(
      `${scenario.repositoryUrl}?unexpected=query`,
    );
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator('[data-code="validation_failed"]')).toHaveText(
      "Check the highlighted field and try again.",
    );

    await page.goto("/settings/members");
    await onScreen(page.getByLabel("Email address")).fill(scenario.memberEmail);
    await chooseOption(page, "Role", "Member");
    await page.getByRole("button", { name: "Invite member" }).click();
    await expect(
      page.getByText("Invitation created and queued for email."),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: scenario.memberEmail }),
    ).toBeVisible();

    expect(consoleLog.hydration).toEqual([]);

    await signOutFromAccountMenu(page);
    await expect(page).toHaveURL(/\/sign-in$/u);

    await clearMagicLinkOutbox(request);
    await signInWithMagicLink(page, request, scenario.memberEmail);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expectOrganizationChoices(page, 1);
    await page.goto("/settings/members");
    await expect(
      page.getByRole("heading", { name: "Members", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Invite member" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Pending invitations" }),
    ).toHaveCount(0);

    await signOutFromAccountMenu(page);
    await expect(page).toHaveURL(/\/sign-in$/u);
    await page.goto("/settings/projects");
    await expect(page).toHaveURL(/\/sign-in$/u);
  } finally {
    try {
      await clearMagicLinkOutbox(request);
    } finally {
      await cleanupFoundationScenario(scenario);
    }
  }
});
