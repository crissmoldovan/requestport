import { expect, type Locator, type Page } from "@playwright/test";

import { ORGANIZATION_SWITCH_UNAVAILABLE } from "../../src/lib/organization-switch.js";
import { scenarioNavigationAttempts } from "./scenario-navigation.js";

/**
 * The authenticated shell's contracts, in one place.
 *
 * The organization switcher is a CUE++ `Select`: a labelled `combobox` button
 * that opens a portalled `listbox`, not a native `<select>` with `<option>`
 * descendants. A spec that reaches for the native-select API, or counts
 * `option` elements inside the trigger, matches nothing and auto-waits to the
 * timeout — which reads as "the organization list never loaded". Keeping the
 * recipe here means the next change to the control fails one fixture rather
 * than every journey that switches tenants.
 */
const switcherLabel = "Current organization";

export function organizationSwitcher(page: Page): Locator {
  return page.getByRole("combobox", { name: switcherLabel });
}

/**
 * Pick one row out of any CUE++ `Select`'s portalled listbox, by its label.
 *
 * The migrated choice controls share the switcher's shape: a labelled
 * `combobox` button opening a `listbox`. The native-select API has nothing to
 * act on there — it fails with "element is not a <select>" at best and
 * auto-waits to the timeout at worst. Driving the role contract keeps every
 * journey independent of the element the package builds the control from.
 *
 * `within` narrows which control is meant. A label is unique on most surfaces
 * and the page is the right scope there, but the appearance settings page
 * draws its own "Density" control and the organization default's beside it, so
 * the account panel's is the third and a page-scoped choice matches all three
 * and acts on none. The listbox stays page-scoped whatever the trigger's
 * scope: it is portalled to the document, not rendered inside the panel.
 */
export async function chooseOption(
  page: Page,
  control: string,
  option: string,
  within?: Locator,
) {
  await (within ?? page)
    .getByRole("combobox", { exact: true, name: control })
    .click();
  await page
    .getByRole("listbox")
    .getByRole("option", { exact: true, name: option })
    .click();
}

/**
 * The copies of an element a person can see, out of every copy the document holds.
 *
 * A page under `(app)/loading.tsx`, `(auth)/loading.tsx` or `oauth/loading.tsx`
 * whose content arrives after the shell is streamed: React writes it into a
 * `<div hidden id="S:0">` at the end of `<body>` and queues the reveal that
 * moves it into place — to the next frame
 * for the document's first reveal, otherwise to 300 ms after the previous one,
 * or to the 2.3 s mark when that falls between 2 and 2.3 s (the React 19.3
 * canary Next ships). cue-ui#232: `@cueplusplus/ui`'s `ThemeProvider` changes
 * its context in the commit that hydrates the shell for a reader on `system`
 * who prefers light — Playwright's default — and React then renders any
 * boundary whose reveal is still queued on the client, leaving the server's
 * copy hidden in `<body>` until the reveal runs. In that window every locator
 * that does not skip hidden elements — CSS, `getByText`, `getByLabel`,
 * `getByPlaceholder`, `getByTestId`, `getByTitle`, `getByAltText` — resolves
 * to both copies, and a strict action or assertion on it throws at once.
 * `getByRole` skips hidden elements and needs no wrapping.
 *
 * Filtering to visible elements keeps strict mode for two copies a person can
 * see, and a missing or wrong element still fails. The double render itself is
 * pinned by `src/app/streamed-page-hydration.dom.test.tsx`, not by this suite.
 * Measured on `route-state-0168` (2026-09-29): see `docs/implementation/gotchas.md`.
 */
export function onScreen(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

/** The page-header kicker, which carries the current organization's slug. */
export function pageEyebrow(page: Page): Locator {
  return onScreen(
    page.locator('[data-slot="page-shell-header"] [data-slot="eyebrow"]'),
  );
}

/**
 * The title of an empty state in the page's own content.
 *
 * Scoped to `<main>` as well as to visible elements, so an empty state in the
 * shell or in an overlay is not mistaken for the page's. Being scoped, it does
 * not see a second visible copy outside `<main>`; a case that must refuse one
 * counts `onScreen` over the whole document as well.
 */
export function pageEmptyStateTitle(page: Page): Locator {
  return onScreen(
    page.getByRole("main").locator('[data-slot="empty-state-title"]'),
  );
}

/**
 * Where the outgoing document records any appearance stamp it was made to
 * change. `sessionStorage` survives the navigation the switch performs, so the
 * new document can be asked what the one it replaced did in its final moments.
 */
const outgoingStampKey = "requestport.e2e.outgoing-appearance";

/**
 * Watch `<html>` for any appearance stamp written *in this document*.
 *
 * A tenant switch must be resolved by the server on a new document. If it were
 * dispatched as a Server Action instead, the cookie write alone would make the
 * router refetch and commit the new tenant's tree here, the provider's layout
 * effect would restamp `<html>`, and the new theme would paint in the document
 * that is about to be discarded.
 *
 * Each record is written down as it arrives, from the record's own payload. The
 * earlier shape compared `record.oldValue` against the attribute read back at
 * callback time, and that comparison could not fail: a callback is delivered
 * after a microtask, so a stamp written and reverted inside one task — exactly
 * what a provider remount does — reads back identical to its old value and was
 * recorded as nothing at all. A restamp of the same triple is recorded here
 * too, deliberately: once a switch is under way the provider has no business
 * touching these attributes at all, and "it only wrote what was already there"
 * is a claim about intent rather than about what happened.
 *
 * Which makes *when* the watch starts part of the contract. Hydration stamps
 * the triple once, from the provider's mount effect, over the values the
 * pre-paint script already wrote — a legitimate, idempotent write that belongs
 * to the document's arrival rather than to the switch. So the watch is armed
 * only after the switcher has proved itself interactive, and what it observes
 * is exactly the window between choosing a tenant and the document being
 * replaced.
 */
async function watchOutgoingAppearance(page: Page) {
  await page.evaluate((key) => {
    sessionStorage.removeItem(key);
    new MutationObserver((records) => {
      const seen = JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[];
      for (const record of records) {
        seen.push(
          `${record.attributeName ?? ""}:${String(record.oldValue ?? "")}`,
        );
      }
      sessionStorage.setItem(key, JSON.stringify(seen));
    }).observe(document.documentElement, {
      attributeFilter: ["data-theme", "data-density", "data-mode", "style"],
      attributeOldValue: true,
    });
  }, outgoingStampKey);
}

async function expectNoOutgoingAppearanceChange(page: Page) {
  const recorded = await page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return raw === null ? [] : (JSON.parse(raw) as string[]);
  }, outgoingStampKey);

  expect(recorded).toEqual([]);
}

/**
 * Open the tenant list, waiting for the control to be able to open it.
 *
 * The switcher is a client component, and a committed switch lands a *new
 * document*: between the server's markup arriving and React attaching to it,
 * the trigger is a button that swallows a click and announces nothing about
 * having done so. Nothing rendered on the server can be waited on instead —
 * hydration has no attribute — so the open is retried, and the retry is the
 * wait. Without it the journey's second switch races the document it was just
 * handed and reports "the organization list never loaded".
 */
async function openOrganizationList(page: Page): Promise<Locator> {
  const list = page.getByRole("listbox");

  await expect(async () => {
    await organizationSwitcher(page).click();
    await expect(list).toBeVisible({ timeout: 2_000 });
  }).toPass({ intervals: [250, 500, 1_000], timeout: 30_000 });

  return list;
}

/** How many organizations this account may switch between. */
/** The entry that opens creation; it is not an organization and never counts. */
const createOrganizationLabel = "Create organization…";

/**
 * How many organizations this account can switch to.
 *
 * The list holds one entry that is not an organization — creation — so counting
 * every option counts a door as a room. Excluding it keeps each call site
 * saying what it means, and the entry is asserted present in the same breath,
 * because a list that lost it would otherwise pass this quietly.
 */
export async function expectOrganizationChoices(page: Page, expected: number) {
  const list = await openOrganizationList(page);

  await expect(
    list.getByRole("option", { name: createOrganizationLabel }),
  ).toHaveCount(1);
  await expect(list.getByRole("option")).toHaveCount(expected + 1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/**
 * Switch tenants and wait for the document the switch replaces this one with.
 *
 * Three things are checked, and they are the same claim from three sides. The
 * slug in the page header is the proof that the *server* resolved the new
 * organization, so waiting on it is waiting on the new document. The theme on
 * `<html>` is the proof that the appearance the server resolved is the one that
 * painted — and the two tenants are seeded with different themes precisely so
 * that this can be wrong. The outgoing record is the proof that the change
 * happened here and not in the document that was replaced.
 */
export async function chooseOrganization(
  page: Page,
  name: string,
  expectedSlug: string,
  expectedTheme: string,
) {
  // A choice has two possible answers and only one used to be waited for.
  //
  // The switch is a single call across the wire, made by the control rather
  // than by this fixture, and `next dev` restarts itself under this lane when
  // its heap crosses the share it watches. A switch that met one never reaches
  // the endpoint: nothing is written, the document is never replaced, and the
  // control says so in the one fixed sentence a transport failure produces.
  // Waiting only on the page header then spends the whole assertion budget on a
  // header that has already been told nothing happened — which is how CI run
  // 33355052056 reported this journey, naming neither the server nor the
  // restart.
  //
  // So both answers are waited for. The sentence is the product's own export,
  // not a copy, and a request that was never delivered may be made again for
  // exactly the reason every other call across this wire may be: it did
  // nothing. The attempts are the ones this tree already declares for a call
  // that met a restart, so there is one policy rather than a second figure.
  const reported = page
    .getByRole("alert")
    .filter({ hasText: ORGANIZATION_SWITCH_UNAVAILABLE });
  const arrived = pageEyebrow(page).filter({ hasText: expectedSlug });

  for (let attempt = 1; ; attempt += 1) {
    // Opening the list is what proves the control has hydrated, so arming the
    // watch afterwards keeps the document's own arrival out of the record.
    const list = await openOrganizationList(page);
    await watchOutgoingAppearance(page);

    await list.getByRole("option", { exact: true, name }).click();
    await expect(arrived.or(reported).first()).toBeVisible();
    if (!(await reported.isVisible())) break;

    if (attempt >= scenarioNavigationAttempts) {
      throw new Error(
        `Organization switch never reached the server: ${ORGANIZATION_SWITCH_UNAVAILABLE}`,
      );
    }
  }

  await expect(pageEyebrow(page)).toContainText(expectedSlug);
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    expectedTheme,
  );
  await expectNoOutgoingAppearanceChange(page);
}
