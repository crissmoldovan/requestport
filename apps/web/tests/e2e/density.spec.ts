import {
  expect,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
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
  organizationSwitcher,
  pageEmptyStateTitle,
} from "../fixtures/shell.js";

const viewports = [1440, 1024, 768, 390] as const;
const longOrganizationName = "W".repeat(120);
const navigationHrefs = [
  "/",
  "/requests",
  "/requests?view=inbox",
  "/requests?view=my_work",
  "/questions",
  "/activity",
  "/settings/projects",
  "/settings/organization",
  "/settings/members",
  "/settings/routing",
  "/settings/operations",
  "/settings/operators",
  "/agents",
  "/webhooks",
  "/slack",
  "/imports",
] as const;

/**
 * The slots the migrated shell emits.
 *
 * The console is CUE++ `AppShell`, `AppBar` and `Sidebar` now, so its parts are
 * addressed by the `data-slot` attributes the package publishes and by the
 * roles they announce. The eleven recipe classes this suite used to measure —
 * `.top-bar`, `.desktop-rail`, `.mobile-navigation`, `.app-content` and the
 * rest — went with the stylesheet Task 11 replaced, and nothing had written
 * them onto an element for some time before that: every one of those locators
 * matched zero elements and auto-waited to the timeout, so the whole suite
 * reported "the page never loaded".
 */
const appBar = '[data-slot="app-bar"]';
const shellSidebar = '[data-slot="app-shell-sidebar"]';
const shellScroller = '[data-slot="app-shell-scroller"]';
const shellNavTrigger = '[data-slot="app-shell-nav-trigger"]';
const pageShell = '[data-slot="page-shell"]';
/**
 * A choice control inside the page, not the organization switcher in the app
 * bar: both are the same CUE++ `Select`, and only the page's own controls are
 * what an administration measurement is about.
 */
const pageSelectTrigger = 'main [data-slot="select-trigger"]';
const pageInput = 'main [data-slot="input"]';
const sidebarItem = '[data-slot="sidebar-item"]';

/**
 * `AppShell` is the one CUE++ component with a viewport rule: below `md` the
 * navigation column becomes a drawer and a trigger appears in the bar. Every
 * width-conditional assertion here is keyed on that one number rather than on a
 * second, local idea of where "mobile" starts.
 */
const navigationDrawerBelow = 768;

/**
 * The published width of a CUE++ `Sidebar`, which is the column's default and
 * not something this application chooses.
 */
const sidebarWidth = 224;

/**
 * The measure a `PageShell` of RequestPort's administration width caps at:
 * CUE++'s `wide`, 54rem. The two raw page widths the application used to own
 * are exactly what the reskin retired, so this reads the package's number.
 */
const administrationMeasure = 864;

/**
 * The label the appearance panel gives each density, and the value `<html>`
 * carries once it is applied.
 */
const densityOptions = {
  large: "Large",
  normal: "Normal",
  "ultra-compact": "Ultra compact",
} as const;

const inheritedDensityOption = "Organization default";

async function expectNoPageOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  const scroller = page.locator(shellScroller);
  if ((await scroller.count()) > 0) {
    expect(
      await scroller
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  }
}

/**
 * One computed length, from the first element a selector matches.
 *
 * The wait is explicit because `locator.evaluate` has no timeout of its own: a
 * selector matching nothing does not fail, it waits for the *test's* budget and
 * is then reported as "the journey ran out of time" — which is the same
 * illegible failure a retired recipe class produced, arriving from the other
 * direction. Ten seconds is far longer than any element here takes to render
 * and far shorter than the journey, so an absent element says so.
 */
async function computedPixels(
  page: Page,
  selector: string,
  property: "fontSize" | "height" | "width",
) {
  const element = page.locator(selector).first();
  await element.waitFor({ state: "attached", timeout: 10_000 });

  return element.evaluate(
    (node, cssProperty) =>
      Number.parseFloat(getComputedStyle(node)[cssProperty]),
    property,
  );
}

/**
 * A CUE++ length token, resolved to pixels by the document that owns it.
 *
 * The geometry the migrated chrome is held to belongs to the installed package
 * and moves with the density rung. Writing the pixels down here would pin one
 * rung rather than the contract, and would stand up a second, hand-maintained
 * copy of the token layer besides — the very thing §14.3 forbids in CSS.
 * Measuring an element styled with the token is the document's own answer to
 * "how tall is a small control here".
 */
async function cueLength(page: Page, token: string) {
  return page.evaluate((property) => {
    const probe = document.createElement("div");
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    probe.style.blockSize = `var(${property})`;
    document.body.append(probe);
    const measured = probe.getBoundingClientRect().height;
    probe.remove();
    return measured;
  }, token);
}

/**
 * The height CUE++ gives a control at one rung, measured through the utility a
 * control actually carries rather than through the token behind it.
 *
 * The two are not the same number. `h-control-md` resolves through the theme
 * layer, which applies its own pointer and density rules on the way, so a probe
 * of `var(--cue-control-md)` answers a question no control asks. Probing with
 * the class is the same question the chassis asks — and it stays right through
 * a token change, a density change, and a coarse-pointer viewport.
 */
async function cueControlHeight(page: Page, rung: "md" | "sm") {
  return page.evaluate((size) => {
    const probe = document.createElement("div");
    probe.className = `h-control-${size}`;
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    const measured = probe.getBoundingClientRect().height;
    probe.remove();
    return measured;
  }, rung);
}

/**
 * Hold an element inside the viewport, waiting for it to get there.
 *
 * The navigation drawer slides in and the account popover fades up, and
 * `boundingBox()` reads whichever frame it lands on — a drawer sampled two
 * frames into its transition is genuinely at `x: -197`, which says nothing
 * about where it comes to rest. Containment is therefore polled, and the bounds
 * are asserted again afterwards so a failure still names the numbers rather
 * than only reporting that a poll expired.
 */
async function expectLocatorWithinViewport(
  locator: Locator,
  width: number,
  height = 900,
) {
  const contains = (bounds: Awaited<ReturnType<Locator["boundingBox"]>>) =>
    bounds !== null &&
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= width &&
    bounds.y + bounds.height <= height;

  await expect
    .poll(async () => contains(await locator.first().boundingBox()), {
      timeout: 10_000,
    })
    .toBe(true);

  const bounds = await locator.first().boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;

  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
}

async function expectElementWithinViewport(
  page: Page,
  selector: string,
  width: number,
  height = 900,
) {
  await expectLocatorWithinViewport(page.locator(selector), width, height);
}

/**
 * The account menu is a CUE popover, so it has no `.user-control` markup and no
 * legacy touch rules left to measure. Its trigger and every control inside its
 * dialog resolve to the CUE small-control rung, which is one size at every
 * width rather than a widened mobile target. Task 12 owns the acceptance
 * judgement about control size across the migrated console; this suite only
 * holds the menu to the geometry the pinned library actually renders, and to
 * staying inside the viewport.
 */
function accountMenuTrigger(page: Page) {
  return page.getByRole("button", { name: /^Open user menu for/u });
}

async function openAccountMenu(page: Page) {
  await accountMenuTrigger(page).click();
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  return panel;
}

async function closeAccountMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function expectAccountMenuDensity(page: Page, width: number) {
  const controlHeight = await cueControlHeight(page, "sm");

  expect(
    await accountMenuTrigger(page).evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).height),
    ),
  ).toBe(controlHeight);

  const panel = await openAccountMenu(page);
  await expectLocatorWithinViewport(panel, width);
  // The panel's *box* proves almost nothing horizontally. `Popover.Popup`
  // carries `max-w-[calc(100vw-2rem)]` and Base UI keeps the positioner in
  // view, so content far wider than the viewport leaves the box pinned at the
  // cap while the document behind it grows to fit. Measured at 1440 under a
  // 400-character `white-space: pre` injection into the panel: the box sat at
  // x=24 w=1408 and every containment assertion still passed, while the panel's
  // own scrollWidth reached 4494 against a clientWidth of 1406 and the document
  // went to 4519. The overlay is therefore asked about its own layout overflow,
  // which is the one signal the cap cannot hide.
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);

  const controls = await panel
    .locator("button")
    .evaluateAll((elements) =>
      elements.map((element) =>
        Number.parseFloat(getComputedStyle(element).height),
      ),
    );
  expect(controls.length).toBeGreaterThan(0);
  for (const height of controls) expect(height).toBe(controlHeight);
  await expect(panel.getByRole("button", { name: "Sign out" })).toBeVisible();

  return panel;
}

async function signOutFromAccountMenu(page: Page) {
  await openAccountMenu(page);
  await page.getByRole("button", { name: "Sign out" }).click();
}

async function expectActionCode(page: Page, code: string) {
  await expect(page.locator(`[data-code="${code}"]`)).toBeVisible();
}

/**
 * Show the workspace map in whichever shape this width renders it, and hand
 * back the one navigation landmark that announces it.
 *
 * Both shapes are the same children: `AppShell.Sidebar` renders the column and
 * the drawer from one set, and only one of the two is ever in the accessibility
 * tree — the column is `display: none` below `md`, and the drawer is unmounted
 * above it. So the landmark resolves uniquely at every width, which is what
 * lets one set of assertions cover both.
 */
async function showNavigation(page: Page, width: number): Promise<Locator> {
  if (width < navigationDrawerBelow) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  }

  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation).toBeVisible();

  return navigation;
}

async function hideNavigation(page: Page, width: number) {
  if (width >= navigationDrawerBelow) return;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/**
 * The shell's own geometry: the bar, the navigation column or its drawer, and
 * every control the bar carries, all at the CUE++ rung the density resolves to.
 *
 * The current destination is checked here rather than through a second call,
 * because showing the navigation is the expensive half at a narrow viewport —
 * the drawer is a real overlay with a real transition — and there is nothing to
 * learn from opening it twice in a row.
 */
async function expectShellDensity(
  page: Page,
  width: number,
  expectedHref: string,
) {
  const controlHeight = await cueControlHeight(page, "sm");
  const iconSize = await cueLength(page, "--cue-icon-md");

  expect(await computedPixels(page, appBar, "height")).toBe(
    await cueLength(page, "--cue-chrome-toolbar"),
  );
  await expectElementWithinViewport(page, appBar, width);

  // Every control the bar carries stays inside the viewport, not merely inside
  // the bar's own box. The switcher renders an organization name, a name is
  // arbitrary text, and this journey deliberately uses a 120-character one: with
  // no measure on the control the trigger grew to fit it and pushed the search,
  // the new-request action and the account menu off a frame that clips rather
  // than scrolls — reachable by nothing, and visible as nothing until a click on
  // the account menu waited out the whole test budget. Containment is asserted
  // before anything is clicked, so a regression fails here, in ten seconds, with
  // the numbers in the message.
  for (const control of [
    organizationSwitcher(page),
    page.getByRole("link", { name: /^Search or run a command/u }),
    page.getByRole("link", { name: "New request" }),
    accountMenuTrigger(page),
  ]) {
    await expectLocatorWithinViewport(control, width);
    expect(
      await control.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).height),
      ),
    ).toBe(controlHeight);
  }

  if (width >= navigationDrawerBelow) {
    await expect(page.locator(shellSidebar)).toBeVisible();
    expect(await computedPixels(page, shellSidebar, "width")).toBe(
      sidebarWidth,
    );
    await expect(page.locator(shellNavTrigger)).toBeHidden();
  } else {
    await expect(page.locator(shellSidebar)).toBeHidden();
    await expect(page.locator(shellNavTrigger)).toBeVisible();
    // The trigger is the one bar control CUE++ renders at its medium rung:
    // `AppShell.NavTrigger` defaults to `size="md"`, and the shell hands it no
    // size of its own.
    expect(await computedPixels(page, shellNavTrigger, "height")).toBe(
      await cueControlHeight(page, "md"),
    );
  }

  const navigation = await showNavigation(page, width);
  const rows = navigation.locator(sidebarItem);
  await expect(rows).toHaveCount(navigationHrefs.length);
  expect(
    await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("href")),
    ),
  ).toEqual(navigationHrefs);
  await expect(navigation.locator('[aria-disabled="true"]')).toHaveCount(0);

  const current = navigation.locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("href", expectedHref);

  const icons = navigation.locator(`${sidebarItem} svg`);
  await expect(icons).toHaveCount(navigationHrefs.length);
  expect(
    await icons.first().evaluate((element) => {
      const style = getComputedStyle(element);
      return [Number.parseFloat(style.height), Number.parseFloat(style.width)];
    }),
  ).toEqual([iconSize, iconSize]);

  for (let index = 0; index < navigationHrefs.length; index += 1) {
    await expectLocatorWithinViewport(rows.nth(index), width);
  }
  await hideNavigation(page, width);

  await expectAccountMenuDensity(page, width);
  await closeAccountMenu(page);
}

/**
 * The project form, which the reskin already migrated.
 *
 * Its fields are CUE++ `Field` + `Input` and its submit is a CUE++ `Button`, so
 * the 32/24 touch pair this suite used to measure here belongs to markup the
 * page no longer renders, and there is no viewport rule left to check: the
 * migrated chassis gives one rung at every width.
 *
 * What is asserted is what this journey can justify. The form is bracketed
 * rather than pinned: no control smaller than the library's own small rung, and
 * none larger than the touch target the retired stylesheet used to impose. Task
 * 12 owns the acceptance judgement about the exact rung each migrated screen
 * lands on; pinning it from here would be this suite deciding that instead.
 *
 * The upper bound is inclusive, and 32px *is* the height the retired
 * sub-900px rule imposed — so a control still sitting at that height passes.
 * That is deliberate rather than an oversight: the bracket catches a control
 * that collapsed and one that grew past anything this console has ever
 * rendered, and it leaves the exact rung between the two to the acceptance pass
 * that owns the judgement.
 */
const legacyTouchTarget = 32;

async function expectProjectFormDensity(page: Page) {
  // The rung the migrated surface chose: every native form in this console is
  // built on `size="sm"`, so the floor is the small chassis rather than the
  // medium one the retired recipe happened to land on.
  const controlHeight = await cueControlHeight(page, "sm");

  for (const control of [
    onScreen(page.getByLabel("Project name")),
    onScreen(page.getByLabel("Request key prefix")),
    page.getByRole("button", { name: "Create project" }),
  ]) {
    const height = await control.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).height),
    );

    expect(height).toBeGreaterThanOrEqual(controlHeight);
    expect(height).toBeLessThanOrEqual(legacyTouchTarget);
  }

  // A real multi-line control rather than a taller input. The floor is three
  // small-chassis rungs — the claim the retired recipe's 64px min-height stood
  // for, in the units the installed package actually resolves.
  expect(
    await computedPixels(page, '[data-slot="textarea"]', "height"),
  ).toBeGreaterThanOrEqual(3 * controlHeight);
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  width: (typeof viewports)[number],
) {
  await page.setViewportSize({ height: 900, width });
  await expectNoPageOverflow(page);
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath(`${name}-${width}.png`),
  });
}

async function expectCurrentNavigation(
  page: Page,
  width: number,
  expectedHref: string,
) {
  const navigation = await showNavigation(page, width);
  const current = navigation.locator('[aria-current="page"]');

  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("href", expectedHref);
  await expect(navigation.locator('[aria-disabled="true"]')).toHaveCount(0);
  await expect(navigation.locator(`${sidebarItem} svg`)).toHaveCount(
    navigationHrefs.length,
  );
  await hideNavigation(page, width);
}

async function captureState(
  page: Page,
  testInfo: TestInfo,
  name: string,
  expectedHref: string,
) {
  for (const width of viewports) {
    await capture(page, testInfo, name, width);
    await expectCurrentNavigation(page, width, expectedHref);
    await expect(organizationSwitcher(page)).toBeVisible();
  }
}

async function holdNextPost(page: Page) {
  let releaseRequest: () => void = () => undefined;
  let markObserved: () => void = () => undefined;
  let markCompleted: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const observed = new Promise<void>((resolve) => {
    markObserved = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    markCompleted = resolve;
  });
  let awaitingPost = true;
  const handler = async (route: Route) => {
    if (awaitingPost && route.request().method() === "POST") {
      awaitingPost = false;
      markObserved();
      await released;
      await route.continue();
      markCompleted();
      return;
    }
    await route.continue();
  };
  await page.route("**/*", handler);

  return {
    observed,
    release: async () => {
      releaseRequest();
      await completed;
      await page.unroute("**/*", handler);
    },
  };
}

/**
 * The account menu at every width, and the page it opens over.
 *
 * The two claims are made in the two states each is a fact about. While the
 * menu is open, what matters is the *overlay*, and `expectAccountMenuDensity`
 * asks it two different questions. Its box has to stay inside the viewport —
 * and that alone is a weak claim horizontally, because `Popover.Popup` caps
 * itself at `calc(100vw-2rem)` and Base UI keeps the positioner in view, so a
 * panel whose content is twice the width of the screen still reports a box that
 * fits. The signal that survives the cap is the panel's own scroll overflow, so
 * that is what is asserted: an overlay wide enough to widen the page overflows
 * itself first, and says so whatever its box does.
 *
 * The document is judged with the menu closed, because an open modal takes the
 * measurement away. Base UI locks scrolling while the panel is open, and under
 * that lock `documentElement.scrollWidth` reports the union of content that is
 * normally clipped inside `overflow-x: auto` scrollers — on the members page at
 * 390 that is the full width of a table nobody can scroll the document to.
 * Asserting against that number would have this suite fail on a scroller's
 * contents while saying nothing about the overlay. So the page is measured in
 * the state a user actually scrolls it in, and the overlay is measured while it
 * is up.
 */
async function captureUserPopover(page: Page, testInfo: TestInfo) {
  for (const width of viewports) {
    await page.setViewportSize({ height: 900, width });
    await expectAccountMenuDensity(page, width);
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`user-popover-${width}.png`),
    });
    await closeAccountMenu(page);
    await expectNoPageOverflow(page);
  }
}

/**
 * One page, one padded measure column — and the rhythm it leaves behind.
 *
 * `PageShell` is the measure *and* the page gutter, so the number of shells a
 * page opens is the number of page gutters it draws. Composing a page out of
 * one shell per part — one for the heading, one for every section — closed the
 * header with `py-(--cue-space-7)` and opened the first section with the same,
 * so the distance from a page heading to its first panel was two full page
 * paddings on every migrated authenticated route.
 *
 * What is left is one shell, and the distance from the header to the first
 * panel is that shell's own `gap-(--cue-space-6)`. The number is read from the
 * document rather than written down here, so the claim holds at whichever
 * density is live rather than at one rung this file happened to pin.
 */
async function expectOnePageColumn(page: Page) {
  await expect(page.locator(pageShell)).toHaveCount(1);

  const gap = await page.evaluate(() => {
    const header = document.querySelector('[data-slot="page-shell-header"]');
    const panel = document.querySelector(
      '[data-slot="page-shell"] [data-slot="panel"]',
    );

    return header && panel
      ? panel.getBoundingClientRect().top -
          header.getBoundingClientRect().bottom
      : null;
  });
  const rhythm = await cueLength(page, "--cue-space-6");

  expect(gap).not.toBeNull();
  expect(Math.abs((gap ?? 0) - rhythm)).toBeLessThanOrEqual(1);

  return rhythm;
}

/**
 * Change this account's density from the account menu, and wait for the
 * document the write ends in.
 *
 * The panel lives in the shared layout, which is exactly what made its
 * render-context token age with the tab rather than with the page: minted once
 * in the layout body, it outlived its window during ordinary rail-link browsing
 * and the first Apply came back "this form is out of date". Applying here, deep
 * into a journey that has navigated many times, is the journey that catches it.
 */
async function setAccountDensity(
  page: Page,
  option: string,
  expected: string | null,
) {
  const panel = page.getByRole("dialog");
  // An accepted write lands a *new document*, and between the server's markup
  // arriving and React attaching to it the trigger is a button that swallows a
  // click and announces nothing about having done so. Nothing rendered on the
  // server can be waited on instead — hydration has no attribute — so the open
  // is retried, exactly as the tenant switcher's own fixture retries it.
  await expect(async () => {
    await accountMenuTrigger(page).click();
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass({ intervals: [250, 500, 1_000], timeout: 30_000 });

  await chooseOption(page, "Density", option);
  await panel.getByRole("button", { name: "Apply" }).click();

  // An accepted write ends in a full-document navigation, so the panel leaves
  // with the document rather than being dismissed.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Exact, because the page also draws an "Active members" section heading.
  await expect(
    page.getByRole("heading", { exact: true, name: "Members" }),
  ).toBeVisible();
  if (expected !== null) {
    await expect(page.locator("html")).toHaveAttribute(
      "data-density",
      expected,
    );
  }
}

async function captureFocusedTable(page: Page, testInfo: TestInfo) {
  for (const width of viewports) {
    await page.setViewportSize({ height: 900, width });
    const tableScroll = page
      .locator('[data-slot="table-scroll-region"]')
      .first();
    // `focus()` carries no timeout of its own, so the wait is what turns an
    // absent scroller into a failure rather than into a stalled journey.
    await expect(tableScroll).toBeVisible();
    await tableScroll.focus();
    await expect(tableScroll).toBeFocused();
    expect(
      await tableScroll.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).outlineWidth),
      ),
    ).toBeGreaterThanOrEqual(2);
    await expectNoPageOverflow(page);
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`focused-table-${width}.png`),
    });
  }
}

test("renders compact SupBuddy density across authenticated widths", async ({
  page,
  request,
}, testInfo) => {
  // One journey, thirteen application states, four viewports each, with a
  // full-page screenshot and a shell measurement at every one of them. The
  // budget is wall clock, not a limit on anything the assertions wait for:
  // every `expect` here carries its own, far smaller timeout, so a genuine
  // hang still fails as a hang rather than as this.
  //
  // It was set against a development server compiling routes on demand. The
  // lanes have driven a built server since `scripts/start-e2e-server.mjs`
  // replaced `next dev`, so that justification no longer describes what runs —
  // and this journey is the one case that has flaked intermittently since the
  // first run of the engagement, always in CI and never here. Three
  // consecutive local passes on 2026-09-03 did not reproduce it.
  //
  // Whoever picks that up should know two things before theorising. This
  // failure is reported at the declaration line, so it is the whole journey
  // timing out rather than an assertion failing — and the budget below is the
  // only thing that could produce that. Whether it is now too generous to catch
  // a real slowdown, or still too tight for a loaded runner, is exactly what
  // the flake has never been observed closely enough to say.
  test.setTimeout(900_000);
  const foundationScenario = createFoundationScenario("density");
  const scenario = {
    ...foundationScenario,
    uiOrganizationSlug: foundationScenario.uiOrganizationSlug.padEnd(63, "x"),
  };

  try {
    await clearMagicLinkOutbox(request);
    await bootstrapOwner(scenario);
    await signInWithMagicLink(page, request, scenario.ownerEmail);

    await captureState(page, testInfo, "setup", "/");

    await onScreen(page.getByLabel("Organization name")).fill(
      longOrganizationName,
    );
    await onScreen(page.getByLabel("Organization slug")).fill("settings");
    await page.getByRole("button", { name: "Create organization" }).click();
    await expectActionCode(page, "validation_failed");
    await captureState(page, testInfo, "setup-field-error", "/");

    await page.reload();

    await onScreen(page.getByLabel("Organization name")).fill(
      longOrganizationName,
    );
    await onScreen(page.getByLabel("Organization slug")).fill(
      scenario.uiOrganizationSlug,
    );
    const organizationGate = await holdNextPost(page);
    await page.getByRole("button", { name: "Create organization" }).click();
    await organizationGate.observed;
    await expect(
      page.getByRole("button", { name: "Creating…" }),
    ).toBeDisabled();
    await captureState(page, testInfo, "setup-pending", "/");
    await organizationGate.release();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await captureState(page, testInfo, "overview-empty", "/");

    await bootstrapOwner(scenario);
    // Stage two seeded the bootstrap tenant's appearance row and moved it off
    // the shared default. Everything below compares two triples, so the two
    // being different is asserted here rather than assumed by the comparisons.
    await expectDistinctTenantAppearance(scenario);
    await page.reload();
    await expectOrganizationChoices(page, 2);

    await page.goto("/settings/organization");
    await expect(
      page.locator('[data-slot="description-list-detail"]').first(),
    ).toHaveText(longOrganizationName);
    await captureState(
      page,
      testInfo,
      "organization-details",
      "/settings/organization",
    );

    await page.goto("/settings/projects");
    await captureState(
      page,
      testInfo,
      "projects-empty-owner",
      "/settings/projects",
    );
    await page.setViewportSize({ height: 900, width: 390 });
    // The migrated control wears `text-(length:--cue-text-ui)`, so the token
    // the document resolves is the number to hold it to.
    expect(
      await page
        .getByRole("link", { name: "Create project" })
        .first()
        .evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        ),
    ).toBe(await cueLength(page, "--cue-text-ui"));

    await page.goto("/settings/projects/new");
    for (const width of viewports) {
      await capture(page, testInfo, "project-form-owner", width);
      await expectShellDensity(page, width, "/settings/projects");
      await expectProjectFormDensity(page);
    }

    await onScreen(page.getByLabel("Project name")).fill(scenario.projectName);
    await onScreen(page.getByLabel("Request key prefix")).fill(
      scenario.projectKey,
    );
    await onScreen(page.getByLabel("Project slug")).fill(scenario.projectSlug);
    await onScreen(page.getByLabel("GitHub repository")).fill(
      `${scenario.repositoryUrl}?invalid=query`,
    );
    await page.getByRole("button", { name: "Create project" }).click();
    await expectActionCode(page, "validation_failed");
    await captureState(
      page,
      testInfo,
      "project-form-field-error",
      "/settings/projects",
    );

    await page.reload();
    await onScreen(page.getByLabel("Project name")).fill(scenario.projectName);
    await onScreen(page.getByLabel("Request key prefix")).fill(
      scenario.projectKey,
    );
    await onScreen(page.getByLabel("Project slug")).fill(scenario.projectSlug);
    await onScreen(page.getByLabel("GitHub repository")).fill(
      scenario.repositoryUrl,
    );
    const projectGate = await holdNextPost(page);
    await page.getByRole("button", { name: "Create project" }).click();
    await projectGate.observed;
    await expect(
      page.getByRole("button", { name: "Creating…" }),
    ).toBeDisabled();
    await captureState(
      page,
      testInfo,
      "project-form-pending",
      "/settings/projects",
    );
    await projectGate.release();
    // Exact: the page title and the section heading ("Registered projects")
    // are both headings now, and a substring match resolves to both.
    await expect(
      page.getByRole("heading", { exact: true, name: "Projects" }),
    ).toBeVisible();
    await captureState(
      page,
      testInfo,
      "projects-populated",
      "/settings/projects",
    );
    await captureFocusedTable(page, testInfo);

    await page.goto("/");
    await captureState(page, testInfo, "overview-populated", "/");

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
    await expectActionCode(page, "conflict");
    await captureState(
      page,
      testInfo,
      "project-form-action-error",
      "/settings/projects",
    );

    await page.goto("/settings/members");
    await captureState(
      page,
      testInfo,
      "members-no-pending",
      "/settings/members",
    );

    for (const width of [768, 390] as const) {
      await page.setViewportSize({ height: 900, width });
      // The choice controls ride the same recessed chassis as the inputs, so
      // the rung they hold is the package's own, not a pinned pixel count.
      expect(await computedPixels(page, pageSelectTrigger, "height")).toBe(
        await cueControlHeight(page, "sm"),
      );
      // "A select lines up with the Inputs beside it" is the package's own
      // contract for the control, and the input on this page is the only thing
      // that can answer whether it still holds at this width.
      expect(await computedPixels(page, pageSelectTrigger, "fontSize")).toBe(
        await computedPixels(page, pageInput, "fontSize"),
      );
      // Lining up with each other is not enough on its own: both readings come
      // from the same document at the same theme and density, so anything that
      // moves the pair together leaves them equal and the guard silent while
      // the console has visibly changed size. The number has to answer to a
      // token as well.
      //
      // The token is now the chassis rung it looks like. Until Task 11 it was
      // not: `globals.css` carried an unlayered `button, input, select,
      // textarea { font: inherit }`, which outranked every Tailwind utility
      // including the `text-(length:--cue-text-label)` the `sm` chassis puts on
      // this trigger, so both controls inherited `--cue-text-ui` from the
      // chrome around them instead. Retiring that stylesheet handed the rung
      // back to the package, and this assertion is what says so.
      expect(await computedPixels(page, pageSelectTrigger, "fontSize")).toBe(
        await cueLength(page, "--cue-text-label"),
      );
    }

    await onScreen(page.getByLabel("Email address")).fill("member@invalid");
    await chooseOption(page, "Role", "Member");
    await page.getByRole("button", { name: "Invite member" }).click();
    await expectActionCode(page, "validation_failed");
    await captureState(
      page,
      testInfo,
      "members-field-error",
      "/settings/members",
    );

    await page.reload();
    await onScreen(page.getByLabel("Email address")).fill(scenario.memberEmail);
    await chooseOption(page, "Role", "Member");
    const invitationGate = await holdNextPost(page);
    await page.getByRole("button", { name: "Invite member" }).click();
    await invitationGate.observed;
    await expect(
      page.getByRole("button", { name: "Inviting…" }),
    ).toBeDisabled();
    await captureState(
      page,
      testInfo,
      "members-invite-pending",
      "/settings/members",
    );
    await invitationGate.release();
    await expect(
      page.getByText("Invitation created and queued for email."),
    ).toBeVisible();
    await captureState(
      page,
      testInfo,
      "members-pending-present",
      "/settings/members",
    );

    for (const width of viewports) {
      await page.setViewportSize({ height: 900, width });
      expect(
        await computedPixels(page, pageShell, "width"),
      ).toBeLessThanOrEqual(administrationMeasure);
    }

    await onScreen(page.getByLabel("Email address")).fill(scenario.memberEmail);
    await chooseOption(page, "Role", "Admin");
    await page.getByRole("button", { name: "Invite member" }).click();
    await expectActionCode(page, "conflict");
    await captureState(
      page,
      testInfo,
      "members-action-error",
      "/settings/members",
    );

    await captureUserPopover(page, testInfo);

    // The end of the two-gutter defect, read in the browser at every width and
    // then at a second density — because the gutter and the rhythm are both
    // density tokens, and one rung proves nothing about the other.
    const rhythms: number[] = [];
    for (const width of viewports) {
      await page.setViewportSize({ height: 900, width });
      rhythms.push(await expectOnePageColumn(page));
    }

    await page.setViewportSize({ height: 900, width: 1440 });
    const inherited = await page.locator("html").getAttribute("data-density");
    const chosen = inherited === "ultra-compact" ? "large" : "ultra-compact";
    await setAccountDensity(page, densityOptions[chosen], chosen);
    rhythms.push(await expectOnePageColumn(page));

    await setAccountDensity(page, inheritedDensityOption, inherited);
    rhythms.push(await expectOnePageColumn(page));

    // Two rungs, not one measured twice.
    expect(new Set(rhythms).size).toBeGreaterThan(1);

    await chooseOrganization(
      page,
      scenario.bootstrapOrganizationName,
      scenario.bootstrapOrganizationSlug,
      await organizationTheme(scenario.bootstrapOrganizationSlug),
    );
    await page.goto("/settings/members");
    await onScreen(page.getByLabel("Email address")).fill(scenario.memberEmail);
    await chooseOption(page, "Role", "Member");
    await page.getByRole("button", { name: "Invite member" }).click();
    await expect(
      page.getByText("Invitation created and queued for email."),
    ).toBeVisible();

    await signOutFromAccountMenu(page);
    await expect(page).toHaveURL(/\/sign-in$/u);

    await clearMagicLinkOutbox(request);
    await signInWithMagicLink(page, request, scenario.memberEmail);
    await chooseOrganization(
      page,
      scenario.bootstrapOrganizationName,
      scenario.bootstrapOrganizationSlug,
      await organizationTheme(scenario.bootstrapOrganizationSlug),
    );

    await page.goto("/settings/projects");
    await expect(
      page.getByRole("link", { name: "Create project" }),
    ).toHaveCount(0);
    await captureState(
      page,
      testInfo,
      "projects-empty-member",
      "/settings/projects",
    );

    await page.goto("/settings/projects/new");
    // The denial is the panel's body, not a section of the document: the
    // native empty state carries its title in its own titled slot and the
    // section's `<h2>` above it is what names the region.
    await expect(pageEmptyStateTitle(page)).toHaveText(
      "Administration access required",
    );
    await captureState(
      page,
      testInfo,
      "project-form-member-denied",
      "/settings/projects",
    );

    await page.goto("/settings/members");
    await expect(
      page.getByRole("heading", { name: "Pending invitations" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Invite member" }),
    ).toHaveCount(0);
    await captureState(
      page,
      testInfo,
      "members-member-projection",
      "/settings/members",
    );

    // The narrow-viewport drawer is the only way to the workspace map at 390,
    // so the journey ends by walking through it rather than by navigating.
    await page.setViewportSize({ height: 900, width: 390 });
    const drawer = await showNavigation(page, 390);
    await drawer.getByRole("link", { name: "Overview" }).click();
    await expect(page).toHaveURL(/\/$/u);
    // The URL settles as soon as the router commits, while the document behind
    // it is still being rendered by a development server compiling on demand,
    // so this waits on the suite's server-answer budget like every other
    // cross-route wait in the journey.
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  } finally {
    try {
      await clearMagicLinkOutbox(request);
    } finally {
      await cleanupFoundationScenario(scenario);
    }
  }
});
