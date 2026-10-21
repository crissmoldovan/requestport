import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { describe, expect, test, vi } from "vitest";

import {
  askThroughRestarts,
  interruptingNavigation,
  isRestartTransportFailure,
  navigateThroughRestarts,
  restartTransportFailures,
  scenarioNavigationAttempts,
  scenarioNavigationAttemptTimeoutMs,
  scenarioNavigationBackoffMs,
  scenarioNavigationPageMethods,
  scenarioNavigationRecoveryMs,
  scenarioNavigationUnreachable,
  tolerateRestarts,
} from "../../tests/fixtures/scenario-navigation.js";

/**
 * Navigating a development server that restarts itself underneath the lane.
 *
 * The same mechanism `scenario-release.ts` was written against, met on the way
 * in rather than on the way out. `next dev` ends a request by comparing the
 * heap against its own ceiling and, when the used size crosses the share it
 * watches, calls `process.exit` so its supervisor can start a fresh child —
 * `getMemoryRestartStats` in `next/dist/server/lib/utils.js`, reached from the
 * `finally` of the request listener in `start-server.js`.
 *
 * The release path was taught to survive that. A `page.goto` racing the same
 * restart was not, and in CI run 33259821308 one appearance case retried into
 * exactly that race and reported `net::ERR_CONNECTION_RESET` against the
 * surface it was asked to drive. A navigation that never reached the server
 * did nothing, so asking again is safe; a navigation that failed for any other
 * reason is the page's own answer, and this loop has nothing to say about it.
 *
 * What a restart may not be allowed to become is the failure it became before:
 * the case's whole budget spent, reported as "the journey ran out of time",
 * naming no server and no restart. So the wait is bounded by the attempts this
 * module declares and ends in a named error.
 */

/** The tree whose fixtures open pages of their own. */
const fixtureRoot = resolve(import.meta.dirname, "../../tests");

/** Every place under one root that opens a page, and whether it is tolerated. */
function pagesOpenedIn(root: string): { at: string; tolerated: boolean }[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const next = join(root, entry.name);
    if (entry.isDirectory()) return pagesOpenedIn(next);
    if (!entry.name.endsWith(".ts")) return [];

    const source = readFileSync(next, "utf8");

    return [
      ...source.matchAll(/(\w+)?\s*\(?\s*await [\w.?]*newPage\(\)/gu),
    ].map((match) => ({
      at: `${entry.name}:${match[0]}`,
      tolerated: match[1] === "tolerateRestarts",
    }));
  });
}

/**
 * Every module that builds a `test` on Playwright's own, and how it hands the
 * page over.
 *
 * The scan above finds the pages a fixture *opens*, and every spec's page is
 * not one of them: it is handed over by the fixture that extends Playwright's
 * `test`, which is where dozens of navigations get the tolerance at once and
 * therefore where losing it costs the most. Removing it there left this suite
 * entirely green, so the shared handover is read here too.
 *
 * A module that builds on a `test` from this tree inherits whatever that one
 * installed and is not asked to reinstall it; only a module that starts from
 * the package's own `test` has to.
 */
function playwrightExtendersIn(
  root: string,
): { at: string; tolerated: boolean }[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const next = join(root, entry.name);
    if (entry.isDirectory()) return playwrightExtendersIn(next);
    if (!entry.name.endsWith(".ts")) return [];

    const source = readFileSync(next, "utf8");
    if (!/from\s*"@playwright\/test"/u.test(source)) return [];
    if (!/\.extend\s*[<(]/u.test(source)) return [];

    const fixture =
      /page:\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s*\},/u.exec(source);

    return [
      {
        at: entry.name,
        tolerated:
          fixture !== null && /tolerateRestarts\s*\(/u.test(fixture[1] ?? ""),
      },
    ];
  });
}

/** The page methods a browser automation library offers for navigating. */
const navigationMethods = ["goBack", "goForward", "goto", "reload"] as const;

/** Every navigation this tree asks a page for, by the method it asks with. */
function navigationsIn(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const next = join(root, entry.name);
    if (entry.isDirectory()) return navigationsIn(next);
    if (!entry.name.endsWith(".ts")) return [];

    return [
      ...scannable(readFileSync(next, "utf8")).matchAll(
        new RegExp(String.raw`\.(${navigationMethods.join("|")})\s*\(`, "gu"),
      ),
    ].map(([, method]) => `${entry.name}:${method}`);
  });
}

/**
 * One module's source with everything a scanner must not read blanked out.
 *
 * Comments and string bodies are replaced by spaces of their own length, so a
 * call named in prose is not a call, a bracket inside a string cannot unbalance
 * the depth count below, and every index still addresses the same character it
 * did before.
 */
function scannable(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gu,
    (found) => found.replace(/[^\n]/gu, " "),
  );
}

/** The loops a call in this tree may be made to survive a restart inside. */
const wireTolerances = ["askThroughRestarts", "releaseScenarioRun"];

/** Where each of those loops begins and ends in one module. */
function toleratedSpans(text: string): { end: number; start: number }[] {
  return wireTolerances.flatMap((name) =>
    [...text.matchAll(new RegExp(String.raw`\b${name}\s*\(`, "gu"))].map(
      (found) => {
        const start = found.index;
        let depth = 0;
        let index = start + found[0].length - 1;
        for (; index < text.length; index += 1) {
          if (text[index] === "(") depth += 1;
          else if (text[index] === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }

        return { end: index, start };
      },
    ),
  );
}

/**
 * Every wait this tree declares that it opts out of.
 *
 * `timeout: 0` is Playwright's way of saying "wait forever", and forever is
 * the one answer a suite driving a server that restarts itself may not accept:
 * the socket its supervisor holds keeps accepting while no child is serving,
 * so a request in flight is neither delivered nor refused. Read off the
 * blanked source, so an option named in prose is not an option.
 */
function unboundedWaitsIn(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const next = join(root, entry.name);
    if (entry.isDirectory()) return unboundedWaitsIn(next);
    if (!entry.name.endsWith(".ts")) return [];

    return [
      ...scannable(readFileSync(next, "utf8")).matchAll(
        /\btimeout\s*:\s*0\b/gu,
      ),
    ].map((found) => `${entry.name}:${found[0]}`);
  });
}

/** Every call this tree makes across the wire, and whether it is tolerated. */
function wireCallsIn(root: string): { at: string; tolerated: boolean }[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const next = join(root, entry.name);
    if (entry.isDirectory()) return wireCallsIn(next);
    if (!entry.name.endsWith(".ts")) return [];

    const text = scannable(readFileSync(next, "utf8"));
    const spans = toleratedSpans(text);

    return [
      ...text.matchAll(
        /\b\w*[Rr]equest\.(delete|fetch|get|head|patch|post|put)\s*\(/gu,
      ),
    ].map((found) => ({
      at: `${entry.name}:${found[1]}`,
      tolerated: spans.some(
        (span) => found.index > span.start && found.index < span.end,
      ),
    }));
  });
}

type Attempt = "arrive" | string;

function scriptedNavigation(attempts: readonly Attempt[]) {
  const asked: string[] = [];
  const slept: number[] = [];
  const arrival = { status: 200 };

  return {
    arrival,
    asked,
    slept,
    run: () =>
      navigateThroughRestarts(
        async () => {
          const next = attempts[asked.length];
          asked.push(next ?? "exhausted");
          if (next === undefined) throw new Error("no scripted attempt");
          if (next === "arrive") return arrival;

          throw new Error(next);
        },
        async (ms: number) => {
          slept.push(ms);
        },
      ),
  };
}

const reset = "page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:3100/";
const refused =
  "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3100/";

/**
 * What each engine says when a request never reaches the server.
 *
 * The tolerance below is a claim about transport failures, and a transport
 * failure has no canonical wording: each engine reports what the stack under it
 * said. The list this suite carried was written while only one engine had ever
 * run, so it was Chromium's vocabulary and nothing recorded that it was — and
 * the first WebKit lane to meet a memory restart was handed a sentence the
 * classifier had no entry for, on the navigation that signs a case in.
 *
 * So the vocabulary is argued from lines something really said. Every row
 * marked `seen` was recorded under Playwright in a Linux container, against a
 * server this probe refused, reset, closed, or killed while the request was in
 * flight — the same shapes `next dev` takes when it restarts itself — apart
 * from the sentence the WebKit lane itself reported, which is read off that
 * job log.
 * A row not marked `seen` is composed from the sentence its engine is known to
 * build, and is here so the reader can see which side of the line it falls on;
 * the test below requires each engine to argue both sides from something it
 * really said.
 *
 * Planted in both directions, because a classifier that answered `true` to
 * everything and one that answered `false` to everything would each satisfy
 * half of the tests around it — and the second is exactly what the WebKit lane
 * had.
 */
type TransportSource = keyof typeof restartTransportFailures;

type ObservedFailure = Readonly<{
  provoked: string;
  /** Whether this exact sentence was recorded, or composed from its shape. */
  seen: boolean;
  source: TransportSource;
  text: string;
  /** Whether the loop must read this as the server never having answered. */
  unanswered: boolean;
}>;

const observedTransportFailures: readonly ObservedFailure[] = [
  {
    provoked: "nothing was listening on the port",
    seen: true,
    source: "webkit",
    text: "page.goto: Could not connect to 127.0.0.1: Connection refused",
    unanswered: true,
  },
  {
    provoked: "the server was gone by the time the page reloaded",
    seen: true,
    source: "webkit",
    text: "page.reload: Could not connect to 127.0.0.1: Connection refused",
    unanswered: true,
  },
  {
    provoked: "the socket was reset before a reply began",
    seen: true,
    source: "webkit",
    text: "page.goto: Error receiving data: Connection reset by peer",
    unanswered: true,
  },
  {
    provoked: "a memory restart, as the WebKit lane reported it",
    seen: true,
    source: "webkit",
    text: "page.navigate: Error receiving data: Connection reset by peer",
    unanswered: true,
  },
  {
    provoked: "the serving child was killed while the request was in flight",
    seen: true,
    source: "webkit",
    text: "page.goto: Connection terminated unexpectedly",
    unanswered: true,
  },
  {
    provoked: "the socket failed while the request was still being written",
    seen: false,
    source: "webkit",
    text: "page.goto: Error sending data: Connection reset by peer",
    unanswered: true,
  },
  {
    provoked: "the server accepted the request and never answered",
    seen: true,
    source: "webkit",
    text: "page.goto: Timeout 3000ms exceeded.",
    unanswered: false,
  },
  {
    provoked: "the address named a host that does not resolve",
    seen: true,
    source: "webkit",
    text: "page.goto: Error resolving “requestport-no-such-host.invalid”: Name or service not known",
    unanswered: false,
  },
  {
    provoked: "the document the page showed took the navigation",
    seen: true,
    source: "webkit",
    text: 'page.goto: Navigation to "http://127.0.0.1:35759/there" is interrupted by another navigation to "http://127.0.0.1:35759/here"',
    unanswered: false,
  },
  {
    provoked: "a control the page never drew",
    seen: true,
    source: "webkit",
    text: "locator.click: Timeout 2000ms exceeded.",
    unanswered: false,
  },
  {
    provoked: "nothing was listening on the port",
    seen: true,
    source: "chromium",
    text: "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:43813/probe",
    unanswered: true,
  },
  {
    provoked: "the socket was reset before a reply began",
    seen: true,
    source: "chromium",
    text: "page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:33635/probe",
    unanswered: true,
  },
  {
    provoked: "the serving child was killed while the request was in flight",
    seen: true,
    source: "chromium",
    text: "page.goto: net::ERR_EMPTY_RESPONSE at http://127.0.0.1:38955/probe",
    unanswered: true,
  },
  {
    provoked: "the socket closed part-way through a reply",
    seen: false,
    source: "chromium",
    text: "page.goto: net::ERR_CONNECTION_CLOSED at http://127.0.0.1:3100/",
    unanswered: true,
  },
  {
    provoked: "the request was abandoned before it was answered",
    seen: false,
    source: "chromium",
    text: "page.goto: net::ERR_CONNECTION_ABORTED at http://127.0.0.1:3100/",
    unanswered: true,
  },
  {
    provoked: "the socket was gone before the request was written",
    seen: false,
    source: "chromium",
    text: "page.goto: net::ERR_SOCKET_NOT_CONNECTED at http://127.0.0.1:3100/",
    unanswered: true,
  },
  {
    provoked: "the address named a host that does not resolve",
    seen: true,
    source: "chromium",
    text: "page.goto: net::ERR_NAME_NOT_RESOLVED at http://requestport-no-such-host.invalid/probe",
    unanswered: false,
  },
  {
    provoked: "the server accepted the request and never answered",
    seen: true,
    source: "chromium",
    text: "page.goto: Timeout 3000ms exceeded.",
    unanswered: false,
  },
  {
    provoked: "a control the page never drew",
    seen: true,
    source: "chromium",
    text: "locator.click: Timeout 2000ms exceeded.",
    unanswered: false,
  },
  {
    provoked: "nothing was listening on the port",
    seen: true,
    source: "driver",
    text: "apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:36105",
    unanswered: true,
  },
  {
    provoked: "the socket was reset while the reply was being read",
    seen: false,
    source: "driver",
    text: "apiRequestContext.post: read ECONNRESET",
    unanswered: true,
  },
  {
    provoked: "the server closed the socket without replying",
    seen: false,
    source: "driver",
    text: "apiRequestContext.get: socket hang up",
    unanswered: true,
  },
  {
    provoked: "the server accepted the request and never answered",
    seen: true,
    source: "driver",
    text: "apiRequestContext.get: Timeout 3000ms exceeded.",
    unanswered: false,
  },
];

/**
 * A page that reports whatever its navigations are asked to report.
 *
 * The bound the tolerance installs is recorded rather than assumed, and the
 * scripted failure is written *with* that bound, so the tests below say "the
 * server did not answer inside the budget this module gave it" without naming
 * a figure of their own.
 */
function stubbedPage(
  answer: (bound: number, asked: number) => unknown,
  showing = "",
) {
  const asked: string[] = [];
  const installed: number[] = [];
  const opened = {
    ...Object.fromEntries(
      scenarioNavigationPageMethods.map((name) => [
        name,
        async (target?: string) => {
          asked.push(`${name}:${target ?? ""}`);
          const given = answer(installed.at(-1) ?? 0, asked.length);
          if (given instanceof Error) throw given;

          return given;
        },
      ]),
    ),
    setDefaultNavigationTimeout: (ms: number) => {
      installed.push(ms);
    },
    /**
     * The document this page is showing.
     *
     * A real page answers this differently before and after an interruption:
     * the document that took the navigation has committed by the time the
     * failure is read. The classifier is therefore only allowed to consult it
     * *before* an attempt, and a stub that answered the same thing at both
     * moments could not tell a rule that respects that from one that does not.
     * So this one changes, exactly as the browser's does.
     */
    url: () => showing,
  } as unknown as Page;

  return {
    arrive: (at: string) => {
      showing = at;
    },
    asked,
    installed,
    navigate: (method: string, target: string) =>
      (
        tolerateRestarts(opened) as unknown as Record<
          string,
          (to: string) => Promise<unknown>
        >
      )[method]?.(target),
  };
}

/** The timeout a page reports when a navigation outlived the budget it had. */
function navigationTimeout(bound: number): Error {
  return new Error(`page.goto: Timeout ${bound}ms exceeded.`);
}

describe("navigating across a development-server restart", () => {
  test("asks once when the server answers", async () => {
    const scripted = scriptedNavigation(["arrive"]);

    expect(await scripted.run()).toBe(scripted.arrival);
    expect({ asked: scripted.asked.length, slept: scripted.slept }).toEqual({
      asked: 1,
      slept: [],
    });
  });

  test("waits out a restart rather than failing the case that met it", async () => {
    const scripted = scriptedNavigation([reset, refused, "arrive"]);

    // A navigation the transport never delivered changed nothing, so the only
    // thing to do with it is ask again — and the answer the case goes on to
    // assert against is the one the server finally gave.
    expect(await scripted.run()).toBe(scripted.arrival);
    expect({ asked: scripted.asked.length, slept: scripted.slept }).toEqual({
      asked: 3,
      slept: [scenarioNavigationBackoffMs, scenarioNavigationBackoffMs],
    });
  });

  test("refuses a failure no restart explains, unretried", async () => {
    const scripted = scriptedNavigation([
      "page.goto: Timeout 30000ms exceeded.",
      "arrive",
    ]);

    // Retrying this would turn a defect in the page into a slower defect in
    // the page, and would hide the one attempt that reported it.
    await expect(scripted.run()).rejects.toThrow("Timeout 30000ms exceeded.");
    expect({ asked: scripted.asked.length, slept: scripted.slept }).toEqual({
      asked: 1,
      slept: [],
    });
  });

  test("gives up by name when the server never comes back", async () => {
    const scripted = scriptedNavigation(
      Array.from({ length: scenarioNavigationAttempts + 2 }, () => reset),
    );

    // A server that stays down is not a restart. Saying so is the whole point:
    // the failure this replaces was the case budget running out, which names
    // no server, no restart and no surface.
    await expect(scripted.run()).rejects.toThrow(scenarioNavigationUnreachable);
    expect(scripted.asked.length).toBe(scenarioNavigationAttempts);
  });

  test("reads a restart's transport failure as one, and nothing else as one", async () => {
    // Planted both ways, because a classifier that answered `true` to
    // everything and one that answered `false` to everything would each satisfy
    // half of the tests above.
    expect([reset, refused].map(isRestartTransportFailure)).toEqual([
      true,
      true,
    ]);
    expect(
      [
        "page.goto: Timeout 30000ms exceeded.",
        "expect(received).toEqual(expected)",
        "locator.click: Target closed",
      ].map(isRestartTransportFailure),
    ).toEqual([false, false, false]);
  });

  test("reads every engine's words for a server that never answered", () => {
    // The table beside this is the whole argument, and it is read in both
    // directions at once: a row the loop must wait out and a row it must hand
    // straight back are checked by the same expression, so a classifier that
    // answered one way to everything fails here rather than passing half of the
    // suite.
    expect(
      observedTransportFailures.map((failure) => ({
        provoked: failure.provoked,
        source: failure.source,
        unanswered: isRestartTransportFailure(failure.text),
      })),
    ).toEqual(
      observedTransportFailures.map((failure) => ({
        provoked: failure.provoked,
        source: failure.source,
        unanswered: failure.unanswered,
      })),
    );
  });

  test("argues each source's vocabulary from lines it really said", () => {
    // The guard on the table itself. Every row could be composed and the test
    // above would still agree with itself — a closed loop proving only that the
    // author is consistent with himself. So each source has to carry a recorded
    // line the loop waits out, and a recorded line it refuses.
    const argued = Object.keys(restartTransportFailures).map((source) => {
      const recorded = observedTransportFailures.filter(
        (failure) => failure.source === source && failure.seen,
      );

      return {
        refused: recorded.some((failure) => !failure.unanswered),
        source,
        waited: recorded.some((failure) => failure.unanswered),
      };
    });

    expect(argued).toEqual(
      argued.map(({ source }) => ({ refused: true, source, waited: true })),
    );
  });

  test("installs the loop on every navigation the page can make", async () => {
    // The page is tolerated in place and handed back, because a fixture that
    // opened it goes on using the object it opened. Driven on fake timers so
    // the backing off is proved rather than waited out.
    //
    // Every declared method is driven rather than the first one. The hole this
    // closes is exactly that distinction: the tolerance covered the navigation
    // that opens a surface and left the one that re-asks for it bare, and a
    // reload is the more exposed of the two because a case only reaches one
    // after it has already spent its setup.
    vi.useFakeTimers();
    try {
      for (const method of scenarioNavigationPageMethods) {
        const asked: string[] = [];
        const arrival = { status: 200 };
        const opened = {
          ...Object.fromEntries(
            scenarioNavigationPageMethods.map((name) => [
              name,
              async (target?: string) => {
                asked.push(`${name}:${target ?? ""}`);
                if (asked.length < 2) throw new Error(reset);

                return arrival;
              },
            ]),
          ),
          setDefaultNavigationTimeout: () => undefined,
          // The document a page is showing when an attempt begins. Every real
          // page answers this, and the loop reads it to tell an interruption
          // that reloaded the current document from one that went elsewhere.
          url: () => "http://127.0.0.1:3100/",
        } as unknown as Page;

        const page = tolerateRestarts(opened);
        expect(page).toBe(opened);

        const navigations = page as unknown as Record<
          string,
          (target?: string) => Promise<unknown>
        >;
        const navigation = navigations[method]("/settings/members");
        await vi.runAllTimersAsync();

        expect({ answer: await navigation, asked }).toEqual({
          answer: arrival,
          asked: [`${method}:/settings/members`, `${method}:/settings/members`],
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("navigates this tree by no method the tolerance leaves bare", () => {
    // The hole this closes. The tolerance patched the first navigation a case
    // makes and nothing else, so every reload across the fixtures and the
    // specs was left to fail its case on the same reset the loop absorbs for
    // the navigation that preceded it.
    const bare = navigationsIn(fixtureRoot).filter(
      (asked) =>
        !(scenarioNavigationPageMethods as readonly string[]).includes(
          asked.split(":")[1] ?? "",
        ),
    );

    expect([...new Set(bare)].sort()).toEqual([]);
  });

  test("crosses the wire nowhere in this tree without the tolerance", () => {
    // A navigation is not the only thing a case puts on the wire. Opening a
    // guarded scenario run and reading the magic-link outbox are requests to
    // the same development server, they meet the same restart, and a reset
    // there fails the case exactly as a reset on the way in did — including in
    // the `finally` of a case that had already passed.
    const bare = wireCallsIn(fixtureRoot).filter((call) => !call.tolerated);

    expect([...new Set(bare.map((call) => call.at))].sort()).toEqual([]);
  });

  test("leaves no page in this tree navigating without the tolerance", () => {
    // The tolerance is installed on the `page` a spec is handed, and a fixture
    // that opens a page of its own is handed nothing. Two did: the one the
    // tenant bootstrap drives — the longest sequence of first-request compiles
    // in a lane, and the one whose failure costs the whole lane — and the
    // second context a preference case reads its value back from.
    //
    // Naming them here would be the rule this module argues against. Every page
    // this tree opens is found instead, and each one has to be handed to the
    // tolerance on the spot.
    const untolerated = pagesOpenedIn(fixtureRoot).filter(
      (opened) => !opened.tolerated,
    );

    expect(untolerated).toEqual([]);
  });

  test("hands every spec a page the tolerance is already on", () => {
    // The hole this closes. Every spec in this tree takes its `page` from one
    // extended fixture, so that one handover covers every navigation a spec
    // makes — and taking the tolerance back out of it left this suite green
    // from end to end, including the scan below, which only ever looked at the
    // pages a fixture opens for itself.
    const extenders = playwrightExtendersIn(fixtureRoot);

    expect(extenders.length).toBeGreaterThan(0);
    expect(extenders.filter((one) => !one.tolerated)).toEqual([]);
  });

  test("asks again when a navigation outlives the bound this module installs", async () => {
    // The stall this closes. `next dev` exits when its heap crosses the share
    // it watches, and the socket its supervisor holds keeps accepting while no
    // child is serving — so the request in flight is neither answered nor
    // refused. Navigation carried no budget of its own, so the wait ended only
    // when the case did: CI run 33315836689 reported "Test timeout of 120000ms
    // exceeded" for the ordinary case that met the first restart, and the case
    // that met the second declares a budget of its own and sat inside it until
    // the lane gave up, naming nothing.
    //
    // A restart that answers nothing is the same restart as one that answers a
    // reset. The loop only ever saw the second, because nothing bounded the
    // first.
    vi.useFakeTimers();
    try {
      const arrival = { status: 200 };
      const stub = stubbedPage((bound, asked) =>
        asked < 2 ? navigationTimeout(bound) : arrival,
      );
      const navigation = stub.navigate("goto", "/settings/members");
      await vi.runAllTimersAsync();

      expect(await navigation).toBe(arrival);
      expect(stub.asked).toEqual([
        "goto:/settings/members",
        "goto:/settings/members",
      ]);
      expect(stub.installed.every((bound) => bound > 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("gives up by name when the bound it installs keeps elapsing", async () => {
    vi.useFakeTimers();
    try {
      const stub = stubbedPage((bound) => navigationTimeout(bound));
      const navigation = stub.navigate("goto", "/requests");
      const settled = expect(navigation).rejects.toThrow(
        scenarioNavigationUnreachable,
      );
      await vi.runAllTimersAsync();
      await settled;

      // A server that never comes back is not a restart, and saying so is the
      // whole point: what this replaces is the case budget running out, which
      // names no server, no restart and no surface.
      expect(stub.asked.length).toBe(scenarioNavigationAttempts);
    } finally {
      vi.useRealTimers();
    }
  });

  test("refuses a timeout that is not the bound it installed", async () => {
    vi.useFakeTimers();
    try {
      const stub = stubbedPage((bound) => navigationTimeout(bound + 1));
      const navigation = stub.navigate("goto", "/requests");
      const settled = expect(navigation).rejects.toThrow("exceeded");
      await vi.runAllTimersAsync();
      await settled;

      // A budget this module did not give is an answer from whatever did give
      // it, and asking again would turn one defect into a slower one.
      expect(stub.asked.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("asks again when the document the page shows takes the navigation", async () => {
    // The failure this closes, reproduced in WebKit 2336 under Playwright
    // 1.62.1 in a Linux container: a page that reloads itself while a `goto`
    // to another address is in flight ends that `goto` with `Navigation to
    // "…/b" is interrupted by another navigation to "…/a"`, where `/a` is the
    // document the page was already showing. Chromium absorbs the same race and
    // lands on `/b`.
    //
    // Under `next dev` the reload is not the application's: Fast Refresh
    // reloads the whole document when the client and the server disagree about
    // the build, which is exactly what a memory restart leaves them doing. CI
    // run 33355052056 logged six of those reloads and every one of the lane's
    // five interrupted navigations landed within seconds of one, each naming
    // the address the page was already on.
    //
    // A navigation that was taken away delivered no document, so asking again
    // is safe for the same reason asking again after a reset is.
    vi.useFakeTimers();
    try {
      const arrival = { status: 200 };
      const stub = stubbedPage(
        (_bound, asked) =>
          asked < 2
            ? new Error(
                'page.navigate: Navigation to "http://127.0.0.1:3100/settings/members" is interrupted by another navigation to "http://127.0.0.1:3100/settings/projects/new"',
              )
            : arrival,
        "http://127.0.0.1:3100/settings/projects/new",
      );
      const navigation = stub.navigate("goto", "/settings/members");
      await vi.runAllTimersAsync();

      expect(await navigation).toBe(arrival);
      expect(stub.asked).toEqual([
        "goto:/settings/members",
        "goto:/settings/members",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("refuses an interruption toward a document the page was not showing", async () => {
    // The other half, and the reason the rule reads the page *before* each
    // attempt rather than after the failure. A page that decides to go
    // somewhere — a client-side redirect, a switch that replaces the document —
    // interrupts a navigation in the same words, and that is the page's own
    // answer: re-asking would spend the loop's whole budget racing a decision
    // the application keeps making, then report the server as unreachable.
    //
    // Read after the failure the two are indistinguishable, because the
    // interrupting document has committed by then either way. So the stub
    // arrives somewhere else, exactly as a browser would.
    vi.useFakeTimers();
    try {
      let moved: { arrive: (at: string) => void } | null = null;
      const stub = stubbedPage(() => {
        // The interrupting document commits, exactly as a browser's would, so
        // the page now shows somewhere it was not showing when the attempt
        // began. A rule that consulted the page after the failure would find
        // the two equal here and ask again.
        moved?.arrive("http://127.0.0.1:3100/sign-in");

        return new Error(
          'page.navigate: Navigation to "http://127.0.0.1:3100/settings/members" is interrupted by another navigation to "http://127.0.0.1:3100/sign-in"',
        );
      }, "http://127.0.0.1:3100/settings/projects/new");
      moved = stub;
      const navigation = stub.navigate("goto", "/settings/members");
      const settled = expect(navigation).rejects.toThrow("is interrupted by");
      await vi.runAllTimersAsync();
      await settled;

      expect(stub.asked.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reads which document took a navigation, and reads nothing else as one", () => {
    // Planted both ways: a reader that answered with a URL for every failure
    // and one that answered `null` for every failure would each satisfy one of
    // the two tests above.
    expect(
      interruptingNavigation(
        'page.navigate: Navigation to "http://127.0.0.1:3100/settings/members" is interrupted by another navigation to "http://127.0.0.1:3100/"',
      ),
    ).toBe("http://127.0.0.1:3100/");
    expect(
      [
        reset,
        "page.goto: Timeout 30000ms exceeded.",
        "expect(received).toEqual(expected)",
        'Navigation to "http://127.0.0.1:3100/" is interrupted by another frame',
      ].map(interruptingNavigation),
    ).toEqual([null, null, null, null]);
  });

  test("declares the wait its own attempts can add", async () => {
    // What a restart costs this loop is no longer the backing off alone. An
    // attempt that is never answered spends the whole bound this module
    // installs, and the worst a restart can cost is every attempt spending it,
    // so the declared recovery is both terms — which is what
    // `playwright.config.ts` floors a shard's restart charge by.
    //
    // The bound is read off the page the tolerance was installed on rather
    // than named here, so the figure this arithmetic is done on is the figure
    // the navigations actually carry.
    vi.useFakeTimers();
    let bound = 0;
    try {
      const stub = stubbedPage(() => ({ status: 200 }));
      await stub.navigate("goto", "/");
      await vi.runAllTimersAsync();
      bound = stub.installed.at(-1) ?? 0;
    } finally {
      vi.useRealTimers();
    }

    expect(bound).toBeGreaterThan(0);
    expect(scenarioNavigationRecoveryMs).toBe(
      scenarioNavigationAttempts * bound +
        (scenarioNavigationAttempts - 1) * scenarioNavigationBackoffMs,
    );
    expect(scenarioNavigationAttempts).toBeGreaterThanOrEqual(2);

    // It has to end well inside the case budget the lane runs under, or a
    // server that never returns is reported as the case running out of time
    // all over again — which is the failure this whole module exists to
    // replace.
    expect(scenarioNavigationRecoveryMs).toBeLessThan(120_000);
  });

  test("waits nowhere in this tree for an answer that may never come", () => {
    // The hole this closes. The navigation path was bounded and the request
    // path was not: the anonymous-boundary probe opted out of the request
    // context's own budget, so the exact failure the bound exists to catch — a
    // request the restarting server accepts and never answers — could hang
    // that case until the lane's ceiling expired, naming neither.
    expect(unboundedWaitsIn(fixtureRoot)).toEqual([]);
  });

  test("asks a call across the wire again when the bound it carried elapsed", async () => {
    // A restart that answers nothing reaches a request the same way it reaches
    // a navigation, and it has to be read the same way: the bound elapsing
    // with nothing said *is* the server not answering. Reading it as an answer
    // fails the case at the restart the tolerance exists to absorb.
    vi.useFakeTimers();
    try {
      const arrival = { status: 307 };
      const asked: string[] = [];
      const settled = askThroughRestarts(async () => {
        asked.push("get");
        if (asked.length < 2) {
          throw new Error(
            `apiRequestContext.get: Timeout ${scenarioNavigationAttemptTimeoutMs}ms exceeded.`,
          );
        }

        return arrival;
      });
      await vi.runAllTimersAsync();

      expect(await settled).toBe(arrival);
      expect(asked.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("refuses a wire failure no restart explains, unretried", async () => {
    // Planted the other way too, because a tolerance that asked again for
    // everything would satisfy the case above and would turn a defect in a
    // route into a slower defect in that route.
    const asked: string[] = [];

    await expect(
      askThroughRestarts(async () => {
        asked.push("post");
        throw new Error("apiRequestContext.post: Timeout 1000ms exceeded.");
      }),
    ).rejects.toThrow("Timeout 1000ms exceeded.");
    expect(asked.length).toBe(1);
  });
});
