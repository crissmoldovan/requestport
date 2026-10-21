import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { describe, expect, test, vi } from "vitest";
import { scenarioNavigationAttempts } from "../../tests/fixtures/scenario-navigation.js";
import { chooseOrganization } from "../../tests/fixtures/shell.js";
import {
  ORGANIZATION_SWITCH_UNAVAILABLE,
  postOrganizationSwitch,
} from "../lib/organization-switch.js";

/** What a stood-up locator answers about the thing it points at. */
type Found = Readonly<{
  attributes: Readonly<Record<string, string>>;
  text: string;
}> | null;

/** The part of a locator this fixture actually drives. */
type FakeLocator = {
  click: () => Promise<void>;
  filter: (options: { hasText?: string; visible?: boolean }) => FakeLocator;
  find: () => Found;
  first: () => FakeLocator;
  getByRole: (role: string, options?: { name?: string }) => FakeLocator;
  isVisible: () => Promise<boolean>;
  or: (other: FakeLocator) => FakeLocator;
};

/**
 * Playwright's assertions, answering out of the world below.
 *
 * The fixture's control flow is what is under guard here — which answers it
 * waits for, and what it does with each — and control flow is exactly what a
 * stand-in can settle. So these answer from the state of a switcher this file
 * drives rather than from a browser, and they answer *now*: a real
 * `toBeVisible` retries until its deadline, and a stand-in that did the same
 * would only turn a fixture waiting for the wrong thing into a slow test
 * instead of a failing one.
 */
vi.mock("@playwright/test", () => {
  const located = (subject: unknown) => subject as FakeLocator;

  return {
    expect: (subject: unknown) => ({
      toBeVisible: async () => {
        if (!(await located(subject).isVisible())) {
          throw new Error("expected something visible, and nothing was");
        }
      },
      toContainText: async (text: string) => {
        const found = located(subject).find();
        if (found === null || !found.text.includes(text)) {
          throw new Error(
            `expected the text ${text}, read ${found?.text ?? "nothing"}`,
          );
        }
      },
      toEqual: (expected: unknown) => {
        if (JSON.stringify(subject) !== JSON.stringify(expected)) {
          throw new Error("expected two values to be equal, and they were not");
        }
      },
      toHaveAttribute: async (name: string, value: string) => {
        const found = located(subject).find();
        if (found?.attributes[name] !== value) {
          throw new Error(`expected ${name} to read ${value}`);
        }
      },
      toPass: async (options: { intervals: readonly number[] }) => {
        const attempt = subject as () => Promise<void>;
        for (let left = options.intervals.length; ; left -= 1) {
          try {
            await attempt();

            return;
          } catch (failure) {
            if (left === 0) throw failure;
          }
        }
      },
    }),
  };
});

/**
 * The one call across this suite's wire that a *control* makes.
 *
 * `scenario-navigation.test.ts` requires every request this tree puts on the
 * wire to go through a loop that survives the development server restarting
 * itself, and it finds those requests by reading the fixtures. A tenant switch
 * is not there to be found: the fixture clicks an option and the *page* makes
 * the call, so the scan cannot see it and the tolerance cannot cover it.
 *
 * The restart does not care. In CI run 33355052056 the WebKit lane's
 * `projects.spec.ts` journey chose a tenant at 05:09, the server crossed its
 * memory ceiling at 05:10:40, and the assertion that follows the choice spent
 * its whole thirty seconds on a page header that was never going to change —
 * reporting the old organization's slug, naming no server and no restart. The
 * control had already said what happened, in the one fixed sentence a switch
 * that never reached the endpoint produces, and nothing was reading it.
 *
 * So the fixture reads it, and this is what keeps the two sides speaking the
 * same words: the sentence is the product's own export, and what the fixture
 * waits for is that export rather than a copy of it.
 */

const shellSource = readFileSync(
  resolve(import.meta.dirname, "../../tests/fixtures/shell.ts"),
  "utf8",
);

describe("a tenant switch that never reached the endpoint", () => {
  test("names it in the sentence the product actually emits", async () => {
    // Behavioural rather than a comparison of one constant with itself: the
    // exported sentence has to be what a switch whose request throws comes back
    // with, so a change to either side fails here rather than leaving a fixture
    // watching for words nothing says any more.
    const verdict = await postOrganizationSwitch(
      "00000000-0000-4000-8000-000000000001",
      () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3100");
      },
    );

    expect(verdict).toEqual({
      code: "unexpected_error",
      message: ORGANIZATION_SWITCH_UNAVAILABLE,
      status: "error",
    });
  });

  test("is what the shell fixture waits for beside the header", () => {
    // Both halves matter. Waiting on the header alone is the failure above;
    // waiting on a sentence spelled out here is the same failure one refactor
    // later. So the fixture imports the product's constant, and it waits for
    // one of the two answers a choice can produce rather than only for the one
    // it hopes for.
    expect(shellSource).toMatch(
      /import\s*\{[^}]*\bORGANIZATION_SWITCH_UNAVAILABLE\b[^}]*\}\s*from\s*"[^"]*organization-switch\.js"/u,
    );
    expect(shellSource).not.toContain("temporarily unavailable");
  });
});

/** What a tenant choice can be answered with, in the order it is answered. */
type SwitchAnswer = "arrives" | "unavailable";

/**
 * A switcher that answers a choice the way the product can answer one.
 *
 * A choice either lands — the server resolves the new organization and replaces
 * the document, so the header carries the new slug and `<html>` carries the new
 * theme — or it never reaches the endpoint, and the control says so in its own
 * fixed sentence while the document stays exactly where it was. An answer this
 * world is not given is the second kind, so a run of them needs no script.
 */
function switcherWorld(
  answers: readonly SwitchAnswer[],
  arrival: Readonly<{ slug: string; theme: string }>,
) {
  const chosen: string[] = [];
  const showing = {
    listOpen: false,
    reported: false,
    slug: "first",
    theme: "graphite",
  };

  const choose = (name: string) => {
    chosen.push(name);
    showing.listOpen = false;
    if (answers[chosen.length - 1] === "arrives") {
      showing.reported = false;
      showing.slug = arrival.slug;
      showing.theme = arrival.theme;

      return;
    }

    showing.reported = true;
  };

  const make = (
    find: () => Found,
    act?: () => void,
    roles?: (role: string, options?: { name?: string }) => FakeLocator,
  ): FakeLocator => {
    const self: FakeLocator = {
      click: async () => act?.(),
      // `visible` narrows nothing here: everything this world holds is on
      // screen, so the shell's `onScreen()` keeps what it is given.
      filter: ({ hasText }) =>
        make(
          () => {
            const found = find();
            if (found === null) return null;
            if (hasText !== undefined && !found.text.includes(hasText))
              return null;

            return found;
          },
          act,
          roles,
        ),
      find,
      first: () => self,
      getByRole: (role, options) => roles?.(role, options) ?? make(() => null),
      isVisible: async () => find() !== null,
      or: (other) => make(() => find() ?? other.find(), act, roles),
    };

    return self;
  };

  const seen = (text: string): Found => ({ attributes: {}, text });
  const list = make(
    () => (showing.listOpen ? seen("organizations") : null),
    undefined,
    (role, options) =>
      role === "option"
        ? make(
            () => (showing.listOpen ? seen(options?.name ?? "") : null),
            () => choose(options?.name ?? ""),
          )
        : make(() => null),
  );
  const switcher = make(
    () => seen("Current organization"),
    () => {
      showing.listOpen = true;
    },
  );
  const alert = make(() =>
    showing.reported ? seen(ORGANIZATION_SWITCH_UNAVAILABLE) : null,
  );

  return {
    chosen,
    page: {
      evaluate: async () => [],
      getByRole: (role: string) =>
        role === "listbox" ? list : role === "combobox" ? switcher : alert,
      locator: (selector: string) =>
        selector === "html"
          ? make(() => ({
              attributes: { "data-theme": showing.theme },
              text: "",
            }))
          : make(() => seen(showing.slug)),
    } as unknown as Page,
  };
}

const arrival = { slug: "second", theme: "sepia" } as const;

describe("what the shell waits for after a tenant is chosen", () => {
  test("asks once when the switch is answered", async () => {
    // Planted the other way first. A fixture that re-chose unconditionally
    // would satisfy both tests below and would double every switch in the
    // suite, so the loop has to end on the answer it was waiting for.
    const world = switcherWorld(["arrives"], arrival);
    await chooseOrganization(world.page, "Second", arrival.slug, arrival.theme);

    expect(world.chosen).toEqual(["Second"]);
  });

  test("chooses again when the control says the switch never landed", async () => {
    // The hole this closes. Narrowing the wait back to the page header alone
    // left this suite green from end to end: nothing drove a choice the server
    // never received, so nothing noticed that the fixture would spend its whole
    // assertion budget on a header already told that nothing happened.
    const world = switcherWorld(["unavailable", "arrives"], arrival);
    await chooseOrganization(world.page, "Second", arrival.slug, arrival.theme);

    expect(world.chosen).toEqual(["Second", "Second"]);
  });

  test("gives up by name after the attempts this tree declares", async () => {
    // The other half of the same hole. Taking the re-choose out left the suite
    // green too, and a re-choose with no bound is the failure this engagement
    // has refused everywhere else: a wait that ends only when the lane does.
    // The bound is the one this tree already declares for a call that met a
    // restart, so there is one policy rather than a second figure.
    const world = switcherWorld([], arrival);

    await expect(
      chooseOrganization(world.page, "Second", arrival.slug, arrival.theme),
    ).rejects.toThrow(ORGANIZATION_SWITCH_UNAVAILABLE);
    expect(world.chosen.length).toBe(scenarioNavigationAttempts);
  });
});
