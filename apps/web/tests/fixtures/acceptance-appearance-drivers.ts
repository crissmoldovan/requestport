import { expect, type Page } from "@playwright/test";
import type { DriveInput, Driver } from "./acceptance-drivers.js";
import {
  appearanceStorageKey,
  clearCookieValue,
  clearUserAppearance,
  controlNames,
  developmentFastRefreshFailure,
  developmentStyleRefusal,
  enginePrefetchRefusal,
  expectAppearance,
  expectLandmark,
  expectNoDocumentOverflow,
  openAccountMenu,
  organizationCookieName,
  readEmittedAppearance,
  readOrganizationAppearance,
  readPrepaintAppearance,
  readStoredAppearance,
  scenarioCookieName,
  setCookieValue,
  writeOrganizationAppearance,
  writeUserAppearance,
} from "./acceptance-run.js";
import {
  clearMagicLinkOutbox,
  findMagicLink,
  signInWithMagicLink,
  submitMagicLinkRequest,
} from "./auth.js";
import { developmentOverlaySelectors } from "./development-overlay.js";
import {
  type FocusIndicatorSample,
  focusIndicatorFailures,
  focusTokenNames,
  unresolvedFocusToken,
} from "./focus-indicator.js";
import { attachLaneDiagnostics } from "./lane-diagnostics.js";
import { tolerateRestarts } from "./scenario-navigation.js";
import { chooseOption, pageEyebrow } from "./shell.js";

/**
 * The appearance and interaction lane's drivers, one per catalogued aspect.
 *
 * Each is a claim about what the *document* does, not about what the fixture
 * asked for: the triple resolved before first paint, the colour the page
 * painted, the control the browser focused, the value the server still returns
 * after a reload in a second context. A driver that compared a value it had
 * just supplied against itself would pass on a server that resolved nothing.
 */

async function closeAccountMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/* ------------------------------------------------------------------ *
 * No flash, inheritance, persistence.
 * ------------------------------------------------------------------ */

const noFlashPrepaint: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  // The document arrived already wearing the triple. This is the half a later
  // reading cannot make: an attribute written during hydration would be absent
  // here and correct afterwards, and the two are indistinguishable at `load`.
  expect(await readPrepaintAppearance(input.page)).toEqual(input.triple);

  // What a malformed record does to the next document.
  //
  // Not "the pre-paint ignores it": the emitted pre-paint body contains no
  // storage read at all, so an assertion that re-checked the stamp after
  // writing rubbish was an assertion about a value the application never
  // consults — true for every input, including a broken one. That property is
  // real and is pinned where it can fail, at the source, by
  // `appearance-script.test.ts`. The half a browser can fail is the other one:
  // the record is a *mirror* the head rewrites from the server triple, so a
  // malformed record is repaired by the next document rather than read by it.
  // Remove the mirror script and the rubbish below survives the reload.
  await input.page.evaluate((key) => {
    localStorage.setItem(key, "{not json");
  }, appearanceStorageKey);
  await input.page.reload();
  expect({
    prepaint: await readPrepaintAppearance(input.page),
    stored: await readStoredAppearance(input.page),
  }).toEqual({ prepaint: input.triple, stored: input.triple });
  await expectAppearance(input.page, input.triple);
};

/**
 * Per-axis inheritance: user override, then organization default, then the
 * fixed fallback — held across a real reload and a real tenant switch.
 */
const organizationInheritance: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  const organization = {
    density: "large",
    mode: "light",
    theme: "terminal",
  } as const;
  const tenantDefault = await readOrganizationAppearance(
    input.tenant.organizationId,
  );

  try {
    await writeOrganizationAppearance(
      input.tenant.organizationId,
      organization,
    );

    // Every axis inherited: the organization's default is what the document
    // wears, through a full reload rather than a client transition.
    await clearUserAppearance(input.tenant.userId);
    await input.page.reload();
    await expectAppearance(input.page, organization);
    expect(await readPrepaintAppearance(input.page)).toEqual(organization);

    // One axis overridden, two still inherited — the axes are independent, so
    // an implementation that resolved the triple as a unit fails here.
    await writeUserAppearance(input.tenant.userId, {
      density: null,
      mode: null,
      theme: "signal",
    });
    await input.page.reload();
    await expectAppearance(input.page, {
      density: organization.density,
      mode: organization.mode,
      theme: "signal",
    });

    // A second tenant with a default of its own. The overridden axis follows
    // the account across the switch; the inherited two follow the tenant.
    const bootstrapSlug = input.tenant.scenario.bootstrapOrganizationSlug;
    const bootstrap = await readOrganizationAppearance(
      input.tenant.bootstrapOrganizationId,
    );
    expect(bootstrap).not.toEqual(organization);
    await setCookieValue(
      input.context,
      organizationCookieName,
      input.tenant.bootstrapOrganizationId,
      input.baseURL,
    );
    await input.page.goto(input.url);
    await expectAppearance(input.page, {
      density: bootstrap.density,
      mode: bootstrap.mode,
      theme: "signal",
    });
    expect(bootstrapSlug.length).toBeGreaterThan(0);
  } finally {
    await setCookieValue(
      input.context,
      organizationCookieName,
      input.tenant.organizationId,
      input.baseURL,
    );
    await writeOrganizationAppearance(
      input.tenant.organizationId,
      tenantDefault,
    );
    await writeUserAppearance(input.tenant.userId, input.triple);
  }
};

/**
 * A preference written through the product's own control survives a reload and
 * a second browser context, because the server is what holds it.
 */
const preferencePersistence: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  const chosen =
    input.triple.density === "ultra-compact" ? "large" : "ultra-compact";
  const label = chosen === "large" ? "Large" : "Ultra compact";
  const panel = await openAccountMenu(input.page);
  // The panel's control, not the page's. This surface draws a "Density" of its
  // own and the organization default's beside it, so a page-scoped choice
  // matches three controls and acts on none of them.
  await chooseOption(input.page, "Density", label, panel);
  await panel.getByRole("button", { name: "Apply" }).click();

  // An accepted write ends in a full-document navigation, so the panel leaves
  // with the document rather than being dismissed.
  await expect(input.page.getByRole("dialog")).toHaveCount(0);
  await expect(input.page.locator("html")).toHaveAttribute(
    "data-density",
    chosen,
  );

  await input.page.reload();
  expect((await readEmittedAppearance(input.page)).density).toBe(chosen);

  // A second context shares nothing but the session cookie, so a value that
  // lived in this browser rather than in the database disappears here.
  const second = await input.context.browser()?.newContext();
  expect(second).toBeDefined();
  if (second) {
    // Closed whatever the reading says. A failed assertion here used to leave
    // the context open, and an open context holds a browser process for the
    // rest of the lane.
    try {
      await second.addCookies(input.tenant.cookies);
      const page = tolerateRestarts(await second.newPage());
      // Watched for the same reason the tenant's page is: a page a fixture
      // opens is not the page the spec fixture hands over, and an unwatched one
      // fails saying nothing.
      attachLaneDiagnostics(page);
      await page.goto(new URL(input.url, input.baseURL).toString());
      expect((await readEmittedAppearance(page)).density).toBe(chosen);
    } finally {
      await second.close();
    }
  }

  await writeUserAppearance(input.tenant.userId, input.triple);
};

/* ------------------------------------------------------------------ *
 * Session.
 * ------------------------------------------------------------------ */

const accountSwitchAndSignOut: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  // The organization the header names is the server's answer, so waiting on it
  // is waiting on the new document rather than on a client transition.
  const eyebrow = pageEyebrow(input.page);
  await setCookieValue(
    input.context,
    organizationCookieName,
    input.tenant.bootstrapOrganizationId,
    input.baseURL,
  );
  await input.page.goto(input.url);
  await expect(eyebrow).toContainText(
    input.tenant.scenario.bootstrapOrganizationSlug,
  );

  await setCookieValue(
    input.context,
    organizationCookieName,
    input.tenant.organizationId,
    input.baseURL,
  );
  await input.page.goto(input.url);
  await expect(eyebrow).toContainText(input.tenant.organizationSlug);

  await openAccountMenu(input.page);
  await input.page.getByRole("button", { name: "Sign out" }).click();
  await expect(input.page).toHaveURL(/\/sign-in$/u);

  // A signed-out session is gone server-side, so the shared cookies are dead
  // and the next case would land on sign-in. The identity is re-established
  // through the same magic link the tenant was created with, and the tenant's
  // cookies are replaced with the new session's.
  await clearMagicLinkOutbox(input.context.request);
  await signInWithMagicLink(
    input.page,
    input.context.request,
    input.tenant.scenario.ownerEmail,
  );
  input.replaceSessionCookies(await input.context.cookies());
};

/* ------------------------------------------------------------------ *
 * Hygiene.
 * ------------------------------------------------------------------ */

const consoleHygiene: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  // Not only the arrival: the console is judged after the page has been used,
  // because a hydration complaint and a client-side failure both arrive after
  // the document is already `load`ed.
  await openAccountMenu(input.page);
  await closeAccountMenu(input.page);
  await input.page.goto(new URL("/requests", input.baseURL).toString());
  await expect(
    input.page.getByRole("heading", { exact: true, name: "Requests" }),
  ).toBeVisible();

  // The development server's Fast Refresh transport is not the application.
  // It polls the build over a resource no production build serves, and a memory
  // restart leaves it asking a fresh server for a build that is gone — so the
  // poll fails, in the console, about `next dev`. Everything else the page
  // wrote still fails the case, including a failure naming any other resource.
  expect({
    errors: input.consoleLog.errors.filter(
      (line) =>
        !developmentFastRefreshFailure(line) && !enginePrefetchRefusal(line),
    ),
    hydration: input.consoleLog.hydration,
  }).toEqual({ errors: [], hydration: [] });
  // Exactly one inline style is tolerated, named by the hash of its content,
  // and nothing else is. The collector puts *every* Content Security Policy
  // refusal in one bucket precisely so this line has something it can fail on:
  // a refusal naming another directive, another hash, or `style-src-elem` in
  // any other words survives the filter below and fails the case.
  expect(
    input.consoleLog.csp.filter((line) => !developmentStyleRefusal(line)),
  ).toEqual([]);
};

const hydrationAgreement: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  // React attached: a control that only exists once the client has taken over
  // answers a click. Without this the "no hydration complaint" claim is also
  // satisfied by a page that never hydrated at all.
  const panel = await openAccountMenu(input.page);
  await expect(panel.getByRole("button", { name: "Sign out" })).toBeVisible();
  await closeAccountMenu(input.page);

  expect(input.consoleLog.hydration).toEqual([]);
  // The stamp survived hydration unchanged, which is the other half of the
  // agreement: the server's triple and the client's first render are the same.
  await expectAppearance(input.page, input.triple);
};

/* ------------------------------------------------------------------ *
 * Interaction.
 * ------------------------------------------------------------------ */

const keyboardFocus: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  const reached: FocusIndicatorSample[] = [];
  for (let step = 0; step < 8; step += 1) {
    await input.page.keyboard.press("Tab");
    const sample = await input.page.evaluate(
      ([tokenNames, unresolved, overlays]: [
        readonly string[],
        string,
        readonly string[],
      ]) => {
        const active = document.activeElement;
        if (!active || active === document.body) return null;
        // `next dev` mounts its devtools as focusable elements in every
        // document it serves. They are the development server's own chrome, not
        // controls this application renders, and holding them to the focus
        // contract would be holding the tool to the product's rules. The
        // selectors come from the one module that names them, so the overflow
        // assertion and this driver cannot come to disagree about what the
        // tool's chrome is.
        if (overlays.some((selector) => active.closest(selector) !== null)) {
          return null;
        }
        const style = getComputedStyle(active);

        // The theme's own focus colours, resolved where the focused control
        // sits rather than at the document root, so a nested theme or density
        // island is judged against its own values. A probe is the only way to
        // read them in the same notation `getComputedStyle` reports a colour.
        const probe = document.createElement("span");
        probe.style.display = "none";
        (active.parentElement ?? document.body).append(probe);
        const tokenColors = tokenNames.map((name) => {
          probe.style.color = `var(${name}, ${unresolved})`;
          return getComputedStyle(probe).color;
        });
        probe.remove();

        return {
          boxShadow: style.boxShadow,
          outlineColor: style.outlineColor,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          tag: active.tagName.toLowerCase(),
          tokenColors,
        };
      },
      [
        [...focusTokenNames],
        unresolvedFocusToken,
        [...developmentOverlaySelectors],
      ] as [readonly string[], string, readonly string[]],
    );
    if (sample) reached.push(sample);
  }

  // Something took focus, and every focused thing drew its ring from the
  // CUE++ focus token. Shape alone is not the contract: the browser's own
  // default ring is correctly shaped, and `§13` forbids it.
  expect(reached.length).toBeGreaterThan(0);
  expect(focusIndicatorFailures(reached)).toEqual([]);
};

const overlaySurfaces: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  await expect(input.page.getByRole("dialog")).toHaveCount(0);
  const panel = await openAccountMenu(input.page);

  // An overlay inherits the invoking theme and density: it is portalled out of
  // the page, so the only thing that can carry them is an ancestor the provider
  // stamped.
  expect(
    await panel.evaluate((element) => {
      const owner = element.closest("[data-theme]") ?? document.documentElement;

      return {
        density: owner.getAttribute("data-density"),
        theme: owner.getAttribute("data-theme"),
      };
    }),
  ).toEqual({ density: input.triple.density, theme: input.triple.theme });

  // The overlay holds itself inside its own box rather than widening the page.
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await closeAccountMenu(input.page);
  await expectNoDocumentOverflow(input.page);
};

const dataTables: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  const region = input.page
    .locator('[data-slot="table-scroll-region"]')
    .first();
  await expect(region).toBeVisible();
  // A named, keyboard-focusable scroll region: `§13`'s rule for a table that
  // overflows, and the reason the document itself never has to.
  expect(
    await region.evaluate((element) => ({
      label: element.getAttribute("aria-label") ?? "",
      tabIndex: element.tabIndex,
    })),
  ).toEqual({ label: expect.stringMatching(/\S/u), tabIndex: 0 });

  await region.focus();
  await expect(region).toBeFocused();
  await expectNoDocumentOverflow(input.page);
};

const horizontalOverflow: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  // The document never scrolls sideways; where content is wider than the
  // measure, it is a scroll region that scrolls, not the page.
  await expectNoDocumentOverflow(input.page);
  const regions = input.page.locator('[data-slot="table-scroll-region"]');
  const count = await regions.count();
  for (let index = 0; index < count; index += 1) {
    expect(
      await regions.nth(index).evaluate((element) => ({
        contained: element.getBoundingClientRect().right <= innerWidth + 1,
        scrollable: getComputedStyle(element).overflowX,
      })),
    ).toEqual({ contained: true, scrollable: "auto" });
  }
};

const longValues: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  // The tenant carries an unbroken name far wider than the column that quotes
  // it, and a slug at the longest a DNS label may be, on purpose — so this asks
  // a page that is genuinely quoting a long value what it did with it. `§13`'s
  // rule is that such a value wraps *or scrolls* within its
  // region without creating document overflow — truncation is a legitimate
  // answer and clipping the viewport is not — so what is asserted is
  // containment, on every element that quotes it.
  const quoted = input.page.getByText(
    input.tenant.scenario.uiOrganizationName,
    {
      exact: false,
    },
  );
  const quotations = await quoted.count();
  expect(quotations).toBeGreaterThan(0);
  for (let index = 0; index < quotations; index += 1) {
    expect(
      await quoted.nth(index).evaluate((element) => {
        const box = element.getBoundingClientRect();

        return { left: box.left >= -1, right: box.right <= innerWidth + 1 };
      }),
    ).toEqual({ left: true, right: true });
  }
  await expectNoDocumentOverflow(input.page);
};

/** The roles a visible form control announces itself as. */
const namedControlRoles =
  /^\s*-\s+(checkbox|combobox|listbox|radio|searchbox|slider|spinbutton|textbox)\b(.*)$/u;

const formFields: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  // `§7`: every visible single control has a label of its own. Read from the
  // accessibility tree the browser computed rather than from an attribute this
  // suite guesses at — a native `<label>`, an `aria-label`, and a Base UI
  // `aria-labelledby` are three different wirings of one contract, and the
  // computed name is the only place all three agree.
  const nameless = (await input.page.locator("main").ariaSnapshot())
    .split("\n")
    .map((line) => namedControlRoles.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter((match) => !(match[2] ?? "").trimStart().startsWith('"'))
    .map((match) => match[0].trim());

  expect(nameless).toEqual([]);
  expect((await controlNames(input.page)).length).toBeGreaterThan(0);
};

/* ------------------------------------------------------------------ *
 * Redaction.
 * ------------------------------------------------------------------ */

/**
 * Credential material reaches no artifact this run produces.
 *
 * The credential is real: a magic link the application itself minted for a real
 * allowlisted address, which would sign this account in. The assertions never
 * print it — each is a boolean about whether it was found — because a failure
 * message is itself an artifact.
 */
const sentinelRedaction: Driver = async (input) => {
  await clearMagicLinkOutbox(input.context.request);
  await submitMagicLinkRequest(input.page, input.tenant.scenario.ownerEmail);

  const link = await findMagicLink(
    input.context.request,
    input.tenant.scenario.ownerEmail,
  );
  expect(link).not.toBeNull();
  const token = new URL(link ?? "", input.baseURL).searchParams.get("token");
  expect(typeof token).toBe("string");
  expect((token ?? "").length).toBeGreaterThan(16);

  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  const secret = token ?? "";
  const exposure = await input.page.evaluate((value) => {
    const readStore = (store: Storage) => {
      let joined = "";
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index) ?? "";
        joined += `${key}=${store.getItem(key) ?? ""};`;
      }

      return joined;
    };

    return {
      cookies: document.cookie.includes(value),
      local: readStore(localStorage).includes(value),
      markup: document.documentElement.outerHTML.includes(value),
      session: readStore(sessionStorage).includes(value),
      text: (document.body.innerText ?? "").includes(value),
    };
  }, secret);

  expect(exposure).toEqual({
    cookies: false,
    local: false,
    markup: false,
    session: false,
    text: false,
  });
  expect(
    [...input.consoleLog.errors, ...input.consoleLog.hydration].some((line) =>
      line.includes(secret),
    ),
  ).toBe(false);

  // Nor does a fixed-failure sentinel from the harness reach the page.
  expect(
    await input.page.evaluate(() =>
      /Foundation E2E|E2E scenario/u.test(document.documentElement.outerHTML),
    ),
  ).toBe(false);
  await clearMagicLinkOutbox(input.context.request);
  await clearCookieValue(input.context, scenarioCookieName);
};

export const acceptanceAppearanceDrivers: Readonly<Record<string, Driver>> = {
  "account-switch-and-sign-out": accountSwitchAndSignOut,
  "console-hygiene": consoleHygiene,
  "data-tables": dataTables,
  "form-fields": formFields,
  "horizontal-overflow": horizontalOverflow,
  "hydration-agreement": hydrationAgreement,
  "keyboard-focus": keyboardFocus,
  "long-values": longValues,
  "no-flash-prepaint": noFlashPrepaint,
  "organization-inheritance": organizationInheritance,
  "overlay-surfaces": overlaySurfaces,
  "preference-persistence": preferencePersistence,
  "sentinel-redaction": sentinelRedaction,
};

export type { DriveInput };
