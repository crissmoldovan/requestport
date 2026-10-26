import type { BrowserContext } from "@playwright/test";
import { expect, type Locator, type Page } from "@playwright/test";

import {
  type AcceptanceSurfaceEntry,
  boundarySentence,
} from "../../src/test/acceptance-surfaces.js";
import { answerChoice } from "./acceptance-choice.js";
import type { AcceptanceCase } from "./acceptance-matrix.js";
import {
  type AcceptanceRecords,
  type AcceptanceTenant,
  type AppearanceTriple,
  type ConsoleLog,
  clearCookieValue,
  controlNames,
  expectLandmark,
  openAccountMenu,
  organizationCookieName,
  type ScenarioRun,
  scenarioCookieName,
  seededRow,
  setCookieValue,
} from "./acceptance-run.js";
import { holdNextWrite } from "./held-write.js";
import { onScreen, pageEmptyStateTitle } from "./shell.js";

/**
 * One driver per catalogued scenario: what it takes to put a surface into the
 * state its case declares, and what the application must then be emitting.
 *
 * Keying on the case's own `fixtureOwner` rather than on a hand-written mapping
 * is what keeps the runner derived from the table. `seeded-project-data` is the
 * one owner that reaches several states, so it — and only it — dispatches on
 * the case's state.
 */

export type DriveInput = Readonly<{
  baseURL: string;
  consoleLog: ConsoleLog;
  context: BrowserContext;
  entry: AcceptanceSurfaceEntry;
  page: Page;
  /** Replace the session every later case reuses, after a deliberate sign-out. */
  replaceSessionCookies: (
    cookies: Awaited<ReturnType<BrowserContext["cookies"]>>,
  ) => void;
  release: () => Promise<void>;
  run: ScenarioRun;
  seeded: AcceptanceRecords;
  /**
   * The assertions every case makes, whatever state it is in: the triple the
   * server resolved, the colour the document painted, the absence of a flash,
   * and a page that does not scroll sideways.
   *
   * A driver calls it once, at the moment its surface has settled, and the
   * runner fails a driver that never called it — an unasserted case is
   * indistinguishable from a passing one, and this suite has shipped that shape
   * before.
   */
  settle: (
    options?: Readonly<{ appearance?: "case" | "fallback" }>,
  ) => Promise<void>;
  tenant: AcceptanceTenant;
  testCase: AcceptanceCase;
  triple: AppearanceTriple;
  url: string;
}>;

export type Driver = (input: DriveInput) => Promise<void>;

/** The sentence the surface's own segment prints for one boundary. */
function boundaryLine(
  entry: AcceptanceSurfaceEntry,
  kind: "error" | "global-error" | "loading" | "not-found",
): string {
  return boundarySentence(entry.segment, kind);
}

async function expectBoundary(
  page: Page,
  entry: AcceptanceSurfaceEntry,
  kind: "error" | "global-error" | "loading" | "not-found",
): Promise<void> {
  await expect(
    onScreen(page.getByText(boundaryLine(entry, kind), { exact: true })),
  ).toBeVisible();
  // The settings boundaries exist so that a failing or missing settings page
  // keeps the section navigation (ruling 260): they sit below
  // settings/layout.tsx. The sentence alone would also pass a boundary drawn
  // above the layout, so the navigation is asserted beside it. Loading is left
  // out: it is still (app)'s boundary, which renders above the layout.
  if (entry.segment === "app-settings" && kind !== "loading") {
    await expect(
      onScreen(page.getByRole("navigation", { name: "Settings" })),
    ).toBeVisible();
  }
}

async function landAndAssert(input: DriveInput): Promise<void> {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();
}

/* ------------------------------------------------------------------ *
 * Submitting a form without knowing which form it is.
 * ------------------------------------------------------------------ */

/**
 * The values a generic filler may put in a control, in the order it tries them.
 *
 * A control is filled and then *asked whether it is valid*: the browser's own
 * answer decides, so a `pattern`, a length bound, or an input type is satisfied
 * rather than guessed at. A control that accepts none of these fails loudly,
 * which is the only honest outcome — a driver that silently skipped a required
 * field would submit a form the browser then refuses, and the case would time
 * out waiting for a request that never left.
 */
const genericValues = [
  "e2eacceptance",
  "e2e-acceptance",
  "E2EACC",
  "E2E acceptance value",
  "0123456789",
];

/**
 * Whether the browser's own constraints are satisfied.
 *
 * `checkValidity()` is not the right question: a `Field` sets a *custom*
 * validity of its own while it revalidates, so a control holding a perfectly
 * acceptable value reports itself invalid for a moment and a filler that
 * believed it would run out of candidates for a value nothing was wrong with.
 * The native flags are the ones that decide whether a submission will leave the
 * page at all, so those are the ones read.
 */
async function satisfiesNativeConstraints(control: Locator): Promise<boolean> {
  return control.evaluate((element) => {
    if (
      !(element instanceof HTMLInputElement) &&
      !(element instanceof HTMLTextAreaElement)
    ) {
      return true;
    }
    const state = element.validity;

    return !(
      state.badInput ||
      state.patternMismatch ||
      state.rangeOverflow ||
      state.rangeUnderflow ||
      state.stepMismatch ||
      state.tooLong ||
      state.tooShort ||
      state.typeMismatch ||
      state.valueMissing
    );
  });
}

async function fillControl(control: Locator): Promise<void> {
  const type = await control.evaluate((element) =>
    element instanceof HTMLInputElement ? element.type : "textarea",
  );
  const ordered =
    type === "email"
      ? ["acceptance@example.invalid"]
      : type === "url"
        ? ["https://github.com/example-org/e2e-acceptance"]
        : type === "number"
          ? ["1", "10"]
          : type === "date" || type === "datetime-local"
            ? ["2026-01-01"]
            : genericValues;

  for (const value of ordered) {
    await control.fill(value);
    if (await satisfiesNativeConstraints(control)) return;
  }

  throw new Error(
    `Acceptance form control accepted no generic value: ${
      (await control.getAttribute("name")) ?? "unnamed"
    }`,
  );
}

/**
 * Every overlay a choice may have left open, closed before anything is clicked.
 *
 * `answerChoice` already dismisses a choice it could not answer, and asks the
 * listbox whether it closed. A multi-select answers that question with the
 * wrong element: the listbox goes, and the popup that carried it stays, holding
 * `data-open` and `role="presentation"` over the work area. It is not a control
 * and nothing looks for it, so the form beneath it simply stopped taking
 * clicks — `route-state-0157` spent its whole click budget on a submit that was
 * visible, enabled and stable, with the trace naming the popup's own subtree as
 * what intercepted the pointer.
 *
 * Bounded, and silent about what it finds: an overlay still open after this is
 * left for whatever the case does next to fail on, because a driver that threw
 * here would report the overlay rather than the surface.
 */
async function dismissOpenOverlays(page: Page): Promise<void> {
  // Never the dialog a form was opened in (`formOpener`): it is the form's
  // own container, and pressing Escape at it would close the form the case is
  // about to submit.
  const open = page.locator(
    "[data-slot$='-popup'][data-open]:not([data-slot='dialog-popup'])",
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await open.count()) === 0) return;
    // Twice, and the second time addressed to the document. An overlay opened
    // by a control that has since been re-rendered has nothing focused inside
    // it, and a keypress sent to the page reaches whatever holds focus rather
    // than the overlay.
    await page.keyboard.press("Escape");
    if ((await open.count()) > 0) {
      await page
        .locator("body")
        .press("Escape")
        .catch(() => undefined);
    }
    await expect(open)
      .toHaveCount(0, { timeout: 2_000 })
      .catch(() => undefined);
  }
}

/**
 * Where a surface's forms are: the work area, or the dialog its opener opens.
 *
 * A settings page opens a form that used to sit under its list in a dialog
 * from the page's or the panel's action (ruling 259). The dialog is portalled
 * out of `<main>` and only exists once it is open, so for a surface that names
 * its opener the button is pressed first and the dialog is where the form is
 * looked for.
 *
 * The dialog is the one the opener names in `aria-controls`, which Base UI's
 * `Dialog.Trigger` sets while its dialog is open, not the first `dialog` on
 * the page: a settings page's confirmation toast is a Base UI `Toast.Root`,
 * whose role is `dialog` too, and it stays up for five seconds after a write.
 */
async function formScope(page: Page, opener?: string): Promise<Locator> {
  if (opener === undefined) return page.locator("main");

  // Pressed until the dialog is open. Between the server's markup arriving and
  // React attaching to it the trigger is a button that swallows a click, and
  // nothing rendered on the server says when hydration has finished, so the
  // press is retried, as the account menu's own fixture retries its trigger.
  // Only a trigger that is not already expanded is pressed: the dialog is not
  // modal, so its trigger stays pressable, and a second press closes it.
  const trigger = page
    .locator("main")
    .getByRole("button", { exact: true, name: opener });
  const controlled = async () => {
    const controls = await trigger.getAttribute("aria-controls", {
      timeout: 2_000,
    });
    expect(controls, `${opener} names the dialog it opened`).toBeTruthy();
    return page.locator(`[id="${controls}"]`);
  };
  await expect(async () => {
    if ((await trigger.getAttribute("aria-expanded")) !== "true") {
      await trigger.click();
    }
    await expect(await controlled()).toBeVisible({ timeout: 2_000 });
  }).toPass({ intervals: [250, 500, 1_000], timeout: 30_000 });

  return controlled();
}

/**
 * Fill and return the primary form of the surface, or `null` when it has none.
 *
 * "Primary" is the first form in the work area that carries a submit control —
 * which is the same one a person would reach first, and the only definition a
 * driver that must work on every catalogued surface can hold. A case whose
 * surface draws several passes the accessible name of the one it means, and
 * then only that form is filled and returned. A surface whose form opens in a
 * dialog names the button that opens it (`formOpener`), and the form is looked
 * for in that dialog instead.
 */
async function prepareSubmission(
  page: Page,
  submitName?: string,
  opener?: string,
): Promise<Locator | null> {
  const forms = (await formScope(page, opener)).locator("form");
  const count = await forms.count();

  for (let index = 0; index < count; index += 1) {
    const form = forms.nth(index);
    // "The first form carrying a visible submit" is the right definition for a
    // surface that draws one. A surface that draws several needs the case to
    // name the control it is about — otherwise the driver submits whichever
    // form happens to come first in the document, which on the members surface
    // is a role change to the tenant's own owner.
    const submit =
      submitName === undefined
        ? form.locator("button[type='submit']").first()
        : form.getByRole("button", { exact: true, name: submitName }).first();
    if ((await submit.count()) === 0 || !(await submit.isVisible())) continue;

    // Choices first, then text.
    //
    // A choice on these surfaces is not inert: the request form asks the server
    // whether the route it now describes is allowed, and the answer re-renders
    // the form around whatever has been typed into it. Answering the choices
    // before typing keeps a re-render from landing between the two.
    const choices = form.locator("[data-slot='select-trigger']");
    const chosen = await choices.count();
    for (let index = 0; index < chosen; index += 1) {
      const trigger = choices.nth(index);
      if (!(await trigger.isVisible())) continue;
      if (await trigger.isDisabled()) continue;
      const popup = page.getByRole("listbox");
      const options = popup.getByRole("option");
      await answerChoice({
        choose: async () => {
          await options.first().click();
        },
        closed: async () => {
          await expect(popup).toHaveCount(0);
        },
        dismiss: async () => {
          await page.keyboard.press("Escape");
        },
        listed: async () => await options.count(),
        open: async () => {
          await trigger.click();
        },
        settled: async () => {
          await expect(popup).toHaveCount(1);
        },
      });
    }

    // Nothing is clicked while an overlay a choice opened is still over the
    // work area.
    await dismissOpenOverlays(page);

    // Twice, if the first pass leaves the form refusing to submit. Choosing a
    // project asks the server whether the route is allowed and the answer
    // re-renders the form, so a value typed into a control the re-render
    // replaced is a value the form no longer holds — and a submission that the
    // browser then refuses never leaves the page for the case to observe.
    const controls = form.locator(
      "input:not([type='hidden']):not([type='checkbox']):not([type='radio']), textarea",
    );
    for (let pass = 0; pass < 2; pass += 1) {
      const fields = await controls.count();
      for (let field = 0; field < fields; field += 1) {
        const control = controls.nth(field);
        if (!(await control.isVisible())) continue;
        if (await control.isDisabled()) continue;
        await fillControl(control);
      }
      const ready = await form.evaluate((element) =>
        element instanceof HTMLFormElement ? element.checkValidity() : true,
      );
      if (ready) break;
    }

    return submit;
  }

  return null;
}

/**
 * The accessible name of every control the work area, or a dialog opened from
 * it, currently refuses. The dialog counts because a form opened in one draws
 * its pending state there (`formOpener`).
 */
async function disabledControls(page: Page): Promise<string[]> {
  const names = await page
    .locator(
      "main button, main input, main [data-slot='select-trigger'], [role='dialog'] button, [role='dialog'] input, [role='dialog'] [data-slot='select-trigger']",
    )
    .evaluateAll((elements) =>
      elements
        .filter(
          (element) =>
            (element as HTMLButtonElement).disabled === true ||
            element.getAttribute("aria-disabled") === "true",
        )
        .map((element) =>
          (element.getAttribute("aria-label") ?? element.textContent ?? "")
            .replace(/\s+/gu, " ")
            .trim(),
        ),
    );

  return names.sort();
}

/* ------------------------------------------------------------------ *
 * The drivers.
 * ------------------------------------------------------------------ */

/**
 * How long a held boundary must survive to be a hold rather than a flicker.
 *
 * Every surface streams its segment's loading fallback for a moment, so an
 * assertion that only waited for it to appear would pass whether the hold
 * worked or not — with the register neutered, exactly that case still passed.
 * A page that is not being held resolves in far less than this; a page that is
 * stays until the case releases it.
 */
const heldBoundaryMs = 1_500;

/**
 * What the page held when a boundary assertion gave way.
 *
 * Every read is optional and every failure is swallowed: this runs only on a
 * path that has already failed, and the one thing it must never do is throw a
 * second error over the first.
 */
async function describeScreen(page: Page): Promise<string> {
  const read = async (label: string, value: () => Promise<unknown>) => {
    try {
      return `${label}: ${String(await value())}`;
    } catch (error) {
      return `${label}: unreadable (${(error as Error).message.slice(0, 80)})`;
    }
  };

  return (
    await Promise.all([
      read("url", async () => page.url()),
      read("title", async () => page.title()),
      read("outer loading boundary visible", async () =>
        page
          .getByText(boundarySentence("app", "loading"), { exact: true })
          .isVisible(),
      ),
      read("work area", async () =>
        JSON.stringify(
          (await page.getByRole("main").innerText()).slice(0, 400),
        ),
      ),
    ])
  ).join("\n");
}

const loadingBoundary: Driver = async (input) => {
  const fallback = input.page.getByText(boundaryLine(input.entry, "loading"), {
    exact: true,
  });

  // A segment below the shell is reached the way a person reaches it. On a
  // fresh document the whole tree streams from the root and the outermost
  // fallback is what paints, so a case watching for a nested one waits on a
  // sentence that is in the document and hidden. Navigating from inside the
  // application leaves the shared layout rendered and fetches only the segment
  // below it, which is the segment whose boundary the case is about.
  if (input.entry.clientRouteLabel !== undefined) {
    await clearCookieValue(input.context, scenarioCookieName);
    await input.page.goto(new URL("/", input.baseURL).toString());
    await setCookieValue(
      input.context,
      scenarioCookieName,
      input.run.namespace,
      input.baseURL,
    );

    // Opened and clicked until the segment is actually entered. A click on this
    // link is answered but does not always navigate: the trace of a failed
    // attempt carries prefetches for every address in the primary navigation
    // and no request at all for this one, so nothing was ever asked for and the
    // case waited out its budget on a page that had not moved. Retrying the
    // pair is the wait — the hold keeps the fallback on screen once it is
    // reached, so an attempt that did navigate ends the loop.
    const label = input.entry.clientRouteLabel;

    try {
      await expect(async () => {
        if (!(await fallback.isVisible().catch(() => false))) {
          const menu = await openAccountMenu(input.page);
          await menu.getByRole("link", { exact: true, name: label }).click();
        }
        await expect(fallback).toBeVisible({ timeout: 5_000 });
      }).toPass({ intervals: [500, 1_000, 2_000], timeout: 30_000 });
    } catch (error) {
      /*
        Say what was on the screen instead.

        This case is declared on WebKit alone, so the only place it runs is a
        CI lane. When it failed there it reported that a sentence was missing
        and nothing else: not the address the browser had reached, not whether
        another boundary had painted, not what the work area held. A trace
        answers none of those either — its snapshots are diffs, and the missing
        sentence never appears in one.

        Gathered inside its own guard, and appended rather than substituted: a
        diagnostic that can throw is a diagnostic that replaces the verdict it
        was added to explain.
      */
      // Read out first: the class scanner reads selectors from template
      // literals, and an interpolated `input.page` is a `.page` class to it.
      const screen = await describeScreen(input.page);

      throw new Error(`${(error as Error).message}\n${screen}`);
    }
    await input.page.waitForTimeout(heldBoundaryMs);
    await expect(fallback).toBeVisible();

    await input.release();
    await expect(fallback).toHaveCount(0);
    await input.settle();

    return;
  }

  // `commit` rather than `load`: the document is deliberately still streaming —
  // the shell has arrived and the work area is the segment's loading fallback,
  // which is the whole state under test. Waiting for `load` here would wait for
  // the very hold this case exists to observe.
  const navigation = input.page.goto(input.url, { waitUntil: "commit" });

  await expect(fallback).toBeVisible();
  await input.page.waitForTimeout(heldBoundaryMs);
  await expect(fallback).toBeVisible();

  await input.release();
  await navigation;
  // The hold ended with the release, so the fallback is gone rather than merely
  // having been there.
  await expect(fallback).toHaveCount(0);
  await input.settle();
};

const routeErrorBoundary: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectBoundary(input.page, input.entry, "error");
  await input.settle();
};

const notFoundBoundary: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectBoundary(input.page, input.entry, "not-found");
  await input.settle();
};

const globalErrorBoundary: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectBoundary(input.page, input.entry, "global-error");
  // `global-error` replaces the root layout, so it resolves nothing and paints
  // the fixed fallback triple. Asserting that is what tells a rendered global
  // boundary apart from a page that merely printed the same sentence.
  await input.settle({ appearance: "fallback" });
};

/**
 * The controls an entry's `ownerOnlyControlOpener` reveals, read from the
 * dialog it opens; none when the entry names no opener or the reading does
 * not offer it. The dialog is a portal outside `<main>`, which is why
 * `controlNames` cannot see it, and it is closed again before returning so
 * the reading that follows starts from the page as it was.
 */
async function namesBehindOpener(
  page: Page,
  entry: { ownerOnlyControlOpener?: string },
): Promise<string[]> {
  const opener = entry.ownerOnlyControlOpener;
  if (opener === undefined) return [];
  const control = page
    .locator("main")
    .getByRole("button", { exact: true, name: opener });
  if ((await control.count()) === 0) return [];
  const dialog = page.getByRole("dialog");
  // The press is retried, and the retry is the wait: between the server's
  // markup and hydration the trigger swallows a click without saying so.
  await expect(async () => {
    await control.click();
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ intervals: [250, 500, 1_000], timeout: 30_000 });
  const names = await dialog
    .locator("a, button")
    .evaluateAll((elements) =>
      elements.map((element) =>
        (element.getAttribute("aria-label") ?? element.textContent ?? "")
          .replace(/\s+/gu, " ")
          .trim(),
      ),
    );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  return [...new Set(names.filter((name) => name !== ""))].sort();
}

/**
 * A reduced role removes affordances and adds none.
 *
 * The claim is made against the same surface rendered for the same account
 * moments earlier, so it needs no per-surface knowledge of which control an
 * administrator gets: whatever the owner could reach, the member reaches a
 * strict subset of. A fault that did nothing would produce two identical sets
 * and fail here, which is exactly the point.
 */
const memberDenied: Driver = async (input) => {
  await clearCookieValue(input.context, scenarioCookieName);
  await input.page.goto(input.url);
  // Both readings wait for the surface to have rendered before counting what
  // it offers. `controlNames` asks the document once and does not wait, so
  // against a server quick enough to answer `goto` before the streamed content
  // arrives it reads an empty `main` — and two empty readings compare equal,
  // which fails this driver for the one reason it is not allowed to mean:
  // that the fault did nothing. The development server was slow enough to hide
  // that; `route-state-0156` failed on the built one the first time the lanes
  // ran against it, with `{"member": [], "owner": []}`.
  await expectLandmark(input.page, input.entry, input.seeded);
  const asOwner = await controlNames(input.page);
  const ownerBehindOpener = await namesBehindOpener(input.page, input.entry);
  const notice = input.entry.ownerOnlyNotice;
  const ownerSawNotice =
    notice === undefined
      ? false
      : await onScreen(input.page.getByText(notice, { exact: true }))
          .isVisible()
          .catch(() => false);

  await setCookieValue(
    input.context,
    scenarioCookieName,
    input.run.namespace,
    input.baseURL,
  );
  await input.page.goto(input.url);

  // A reduced role is refused in one of two ways, and both are denials: the
  // surface answers not-found outright — which is what an administration-only
  // page does rather than describe itself to someone who may not see it — or it
  // renders with fewer affordances. The second is checked against the same
  // surface rendered for the same account moments earlier, so it needs no
  // per-surface knowledge of which control an administrator gets: whatever the
  // owner could reach, the member reaches a strict subset of. A fault that did
  // nothing produces two identical sets and fails here, which is the point.
  const deniedOutright = await onScreen(
    input.page.getByText(boundaryLine(input.entry, "not-found"), {
      exact: true,
    }),
  )
    .isVisible()
    .catch(() => false);

  if (!deniedOutright) {
    // The same wait, for the same reason and one more: a member reading taken
    // early is empty, an empty member set is a strict subset of the owner's,
    // and the driver would report a denial it never observed.
    await expectLandmark(input.page, input.entry, input.seeded);

    // A third denial shape, for a surface that keeps the controls and replaces
    // the owner-only form with a statement. Both sides are asserted together so
    // a surface that always shows the sentence, or never does, fails here — the
    // claim is the difference between the two readings, not the presence of a
    // sentence in one of them.
    if (notice !== undefined) {
      const memberSawNotice = await onScreen(
        input.page.getByText(notice, { exact: true }),
      )
        .isVisible()
        .catch(() => false);

      expect({ member: memberSawNotice, owner: ownerSawNotice }).toEqual({
        member: true,
        owner: false,
      });
      await input.settle();

      return;
    }

    const asMember = await controlNames(input.page);
    const memberBehindOpener = await namesBehindOpener(input.page, input.entry);
    const ownerOnly = input.entry.ownerOnlyControl;

    // A fourth shape, for a surface that offers both roles the same controls
    // and a narrower set of choices inside one of them. Asserted from both
    // sides for the same reason the sentence is: offered to both, or to
    // neither, fails here.
    if (ownerOnly !== undefined) {
      expect({
        member: [...asMember, ...memberBehindOpener].includes(ownerOnly),
        owner: [...asOwner, ...ownerBehindOpener].includes(ownerOnly),
      }).toEqual({ member: false, owner: true });
      await input.settle();

      return;
    }

    expect({ member: asMember, owner: asOwner }).not.toEqual({
      member: asOwner,
      owner: asOwner,
    });
    expect(asOwner).toEqual(expect.arrayContaining(asMember));
  }
  await input.settle();
};

/**
 * The provider is unavailable *because the run said so*.
 *
 * The surface prints one sentence for two different reasons — a provider the
 * run made unreachable, and a provider nobody configured — so a case that only
 * waited for the sentence was satisfied by the five absent Slack settings,
 * which is every local and CI run, and passed with the injection removed. The
 * acceptance server is configured for exactly this reason, and the claim is a
 * difference rather than a sentence: outside the run the surface offers the
 * connection it would offer a real operator; inside it, it refuses and the
 * offer is gone.
 *
 * The refusal is looked for three ways, on purpose. Its presence is asserted
 * on the copy a person sees in the page's content: a streamed page can hold a
 * second, hidden copy outside `<main>` until React's queued reveal removes it,
 * which failed `route-state-0168` in strict mode (cue-ui#232's shape; see
 * `onScreen`). That it is shown once is asserted on the whole document's
 * visible copies, so a second copy a person can see — in `<main>` or outside
 * it — still fails. Its absence is asserted on the whole document, hidden
 * copies included, because a refusal the server rendered anywhere is a
 * refusal outside the run.
 */
const providerUnavailable: Driver = async (input) => {
  const refusalText = "Slack configuration required";
  const refusal = pageEmptyStateTitle(input.page).filter({
    hasText: refusalText,
  });
  const anyRefusal = input.page.locator('[data-slot="empty-state-title"]', {
    hasText: refusalText,
  });
  const connect = input.page.getByRole("link", { name: "Connect workspace" });

  await clearCookieValue(input.context, scenarioCookieName);
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await expect(connect).toBeVisible();
  await expect(anyRefusal).toHaveCount(0);

  await setCookieValue(
    input.context,
    scenarioCookieName,
    input.run.namespace,
    input.baseURL,
  );
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await expect(refusal).toBeVisible();
  await expect(onScreen(anyRefusal)).toHaveCount(1);
  await expect(connect).toHaveCount(0);
  await input.settle();
};

const conflictingWrite: Driver = async (input) => {
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);

  const submit = await prepareSubmission(
    input.page,
    input.entry.conflictSubmit,
    input.entry.formOpener,
  );
  expect(submit).not.toBeNull();
  await dismissOpenOverlays(input.page);
  await submit?.click();

  // The sentence, not merely an alert. Every migrated form draws a failure as
  // an `alert` with a tone chip, and a rejected submission draws one too — so a
  // case that waited for any alert would pass on a value the schema refused,
  // which is a different state the table covers elsewhere. Each surface's
  // `conflict` arm has a fixed sentence of its own, and that is what a
  // conflicting write has to print.
  const message = input.entry.conflictMessage;
  // Thrown rather than defaulted. `hasText: ""` matches every alert on the
  // page, so a surface that named no sentence would be asserted against "some
  // alert appeared" — the exact shape this suite keeps having to remove.
  if (message === undefined) {
    throw new Error("Acceptance conflict case names no sentence");
  }
  await expect(
    input.page.getByRole("alert").filter({ hasText: message }),
  ).toBeVisible();
  await input.settle();
};

/**
 * A seeded tenant with nothing in it.
 *
 * The browser is moved into the organization the run created, which is the
 * only way an empty state is the *true* state of a surface rather than a
 * coincidence of ordering.
 */
const seededOwnerIdentity: Driver = async (input) => {
  const organizationId = seededRow(input.run, "organizations");
  expect(organizationId).not.toBeNull();
  await setCookieValue(
    input.context,
    organizationCookieName,
    organizationId ?? "",
    input.baseURL,
  );

  // A surface that answers a question is opened with one. `emptyQuery` is the
  // surface's own statement of what brings it to an empty state; a surface that
  // is empty as soon as it is opened declares none and is opened bare.
  const emptyQuery =
    input.testCase.state === "empty" ? input.entry.emptyQuery : undefined;

  // Concatenated rather than interpolated: `browser-spec-contract.test.ts`
  // reads the literals in this tree looking for classes the application no
  // longer emits, and a property access inside a template literal reads to that
  // scan as a class selector.
  await input.page.goto(
    emptyQuery === undefined ? input.url : input.url + "?" + emptyQuery,
  );
  await expectLandmark(input.page, input.entry, input.seeded);
  if (input.testCase.state === "empty") {
    await expect(pageEmptyStateTitle(input.page).first()).toBeVisible();
  }
  await input.settle();
};

const seededProjectData: Driver = async (input) => {
  if (input.testCase.state === "pending") {
    await input.page.goto(input.url);
    await expectLandmark(input.page, input.entry, input.seeded);

    const submit = await prepareSubmission(
      input.page,
      undefined,
      input.entry.formOpener,
    );
    expect(submit).not.toBeNull();
    const before = await disabledControls(input.page);
    // Held, and then aborted rather than let through: a write that reached the
    // application here would race the scenario's release, and one that won
    // appended an event the release can never delete (`held-write.ts`).
    const write = await holdNextWrite(input.page);
    try {
      // Again here, and not only inside `prepareSubmission`: the controls are
      // filled after that call and a form that re-renders around them can
      // leave an overlay open between the two. `route-state-0157` was still
      // losing its click to one after the first dismissal was added, with the
      // trace naming the same popup.
      await dismissOpenOverlays(input.page);
      await submit?.click();
      const held = await write.observed;

      // Every migrated form names its own pending state and disables the
      // control that started it. Some surfaces rename theirs ("Creating…",
      // "Sending…") and some only disable it, so the claim is the one both
      // make: the set of disabled controls grew, and grew only.
      await expect
        .poll(async () => (await disabledControls(input.page)).length, {
          timeout: 15_000,
        })
        .toBeGreaterThan(before.length);
      const during = await disabledControls(input.page);
      expect(during).toEqual(expect.arrayContaining(before));

      // The universal claims are made on the pending document, because that is
      // the state this case declares. The write is still held here; once it
      // is aborted the page is answering a failure, which is another state.
      await input.settle();

      // And the write never left the browser. Asked of the request itself, so
      // a hold that quietly let it through fails here rather than at release.
      await write.abandon();
      await expect
        .poll(() => held.request().failure()?.errorText ?? null)
        .not.toBeNull();
      // Nor did any other: a write made while the first was held went on to
      // the application, and would race the release the same way.
      expect(write.writesLetThrough()).toBe(0);
    } finally {
      await write.abandon();
    }

    return;
  }

  await landAndAssert(input);
};

/**
 * The ledger removed exactly what it recorded, in an order the schema accepts.
 *
 * Asked of the database rather than of the answer: a hook that recorded a row
 * it never wrote, or deleted a parent before its child, answers the same JSON.
 */
const scenarioCleanup: Driver = async (input) => {
  const { countScenarioRows } = await import("./acceptance-rows.js");

  expect(input.run.rows.length).toBeGreaterThan(0);
  expect(await countScenarioRows(input.run.rows)).toEqual(
    input.run.rows.map((row) => ({ found: 1, table: row.table })),
  );

  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();

  await input.release();
  expect(await countScenarioRows(input.run.rows)).toEqual(
    input.run.rows.map((row) => ({ found: 0, table: row.table })),
  );
};

/**
 * The cookie is inert; the register is what means anything.
 *
 * Three renders of the same surface: one carrying a namespace nothing ever
 * opened, one carrying this run's namespace — whose case declares no fault, so
 * it must also change nothing — and one carrying a namespace that has been
 * released. All three have to be the surface itself.
 */
const faultInjectionScope: Driver = async (input) => {
  const invented = "11111111-2222-4333-8444-555555555555";

  for (const value of [invented, input.run.namespace]) {
    await setCookieValue(
      input.context,
      scenarioCookieName,
      value,
      input.baseURL,
    );
    await input.page.goto(input.url);
    await expectLandmark(input.page, input.entry, input.seeded);
  }

  await input.release();
  await input.page.goto(input.url);
  await expectLandmark(input.page, input.entry, input.seeded);
  await input.settle();
};

export const acceptanceDrivers: Readonly<Record<string, Driver>> = {
  "conflicting-write": conflictingWrite,
  "fault-injection-scope": faultInjectionScope,
  "global-error-boundary": globalErrorBoundary,
  "loading-boundary": loadingBoundary,
  "member-denied": memberDenied,
  "not-found-boundary": notFoundBoundary,
  "provider-unavailable": providerUnavailable,
  "route-error-boundary": routeErrorBoundary,
  "scenario-cleanup": scenarioCleanup,
  "seeded-owner-identity": seededOwnerIdentity,
  "seeded-project-data": seededProjectData,
};
