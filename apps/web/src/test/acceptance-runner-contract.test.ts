import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  acceptancePointers,
  pointerForWidth,
} from "../../tests/fixtures/acceptance-pointer.js";
import {
  isHydrationMismatch,
  refuseErrorBoundary,
  refuseTenantNotFound,
} from "../../tests/fixtures/acceptance-run.js";
import { appearanceStorageKey } from "../lib/appearance-script.js";
import {
  type AcceptanceBoundaryKind,
  acceptanceBoundaryText,
  acceptancePathTokens,
  acceptanceSegments,
  acceptanceSkipReason,
  acceptanceSkipRules,
  acceptanceSurface,
  acceptanceSurfaces,
  boundarySentence,
  inventorySurfaceIds,
} from "./acceptance-surfaces.js";
import { e2eScenarioIds } from "./e2e-scenarios.js";
import { routeStateInventory, routeStates } from "./route-state-inventory.js";

/**
 * The runner is derived from the case table, and the derivation is checked
 * here.
 *
 * The browser suite cannot report this itself: a case it never ran and a case
 * it ran and passed both leave no line in a green report. So the shape is
 * pinned in the node lane, where it fails in a second — every inventory surface
 * has an address, every catalogued scenario has a driver, the spec enumerates
 * no case of its own, the two lanes still partition, and every case is either
 * driven or skipped by a rule that says why.
 */

const webRoot = resolve(import.meta.dirname, "..", "..");
const repositoryRoot = resolve(webRoot, "..", "..");

type MatrixCase = {
  density: string;
  engine: string;
  fixtureOwner: string;
  id: string;
  lane: string;
  pointer: string;
  state: string;
  surface: string;
  viewport: { height: number; width: number };
};

const matrix = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "docs/implementation/acceptance/requestport-cue-reskin-matrix.json",
    ),
    "utf8",
  ),
) as {
  cases: MatrixCase[];
  viewports: { height: number; width: number }[];
};

function read(file: string) {
  return readFileSync(resolve(webRoot, file), "utf8");
}

/**
 * The file each segment's boundary of each kind is actually written in.
 *
 * Named here rather than derived, because the point of the check below is to
 * compare the table against the components: a mapping the table produced would
 * agree with the table by construction. Every segment shares one global
 * boundary; the settings segment writes no loading file and inherits the
 * authenticated segment's; and the appearance route writes no not-found file
 * and inherits the settings segment's (ruling 260). So those entries
 * deliberately name a file another segment also names.
 */
const boundaryFiles: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  app: {
    error: "src/app/(app)/error.tsx",
    "global-error": "src/app/global-error.tsx",
    loading: "src/app/(app)/loading.tsx",
    "not-found": "src/app/(app)/not-found.tsx",
  },
  "app-appearance": {
    error: "src/app/(app)/settings/appearance/error.tsx",
    "global-error": "src/app/global-error.tsx",
    loading: "src/app/(app)/settings/appearance/loading.tsx",
    "not-found": "src/app/(app)/settings/not-found.tsx",
  },
  "app-settings": {
    error: "src/app/(app)/settings/error.tsx",
    "global-error": "src/app/global-error.tsx",
    loading: "src/app/(app)/loading.tsx",
    "not-found": "src/app/(app)/settings/not-found.tsx",
  },
  auth: {
    error: "src/app/(auth)/error.tsx",
    "global-error": "src/app/global-error.tsx",
    loading: "src/app/(auth)/loading.tsx",
    "not-found": "src/app/(auth)/not-found.tsx",
  },
  // The root fallbacks, one of which is not written at the root: a loading
  // boundary there would be a Suspense boundary above every authenticated
  // segment, so it lives in the consent segment, below that segment's own
  // authentication decision.
  root: {
    error: "src/app/error.tsx",
    "global-error": "src/app/global-error.tsx",
    loading: "src/app/oauth/loading.tsx",
    "not-found": "src/app/not-found.tsx",
  },
};

/** Every component module the application's surfaces render. */
function componentSources(): string {
  const directory = resolve(webRoot, "src/components");

  return readdirSync(directory)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => readFileSync(resolve(directory, name), "utf8"))
    .join("\n");
}

/** Every page component under the application router. */
function pageSources(): { file: string; source: string }[] {
  const found: { file: string; source: string }[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        walk(next, `${prefix}/${entry.name}`);
        continue;
      }
      if (entry.name !== "page.tsx") continue;
      found.push({
        file: `${prefix}/${entry.name}`,
        source: readFileSync(next, "utf8"),
      });
    }
  };
  walk(resolve(webRoot, "src/app"), "src/app");

  return found;
}

const specSource = read("tests/e2e/acceptance-matrix.spec.ts");
const runSource = read("tests/fixtures/acceptance-run.ts");
const driverSources = [
  read("tests/fixtures/acceptance-drivers.ts"),
  read("tests/fixtures/acceptance-appearance-drivers.ts"),
].join("\n");

/**
 * The split this pass claims.
 *
 * Pinned rather than derived so that turning a skip into a driver, or losing a
 * driver to a skip, is a deliberate edit with a number attached. The counts are
 * over the whole table; each case runs on exactly one engine, so the executed
 * figure is what CI runs across both shards.
 */
const declaredExecution = { executed: 252, skipped: 48, total: 300 };

function applicationModule(candidate: string): string | undefined {
  return [
    candidate,
    candidate.replace(/\.js$/u, ".ts"),
    candidate.replace(/\.js$/u, ".tsx"),
  ].find((file) => existsSync(file) && statSync(file).isFile());
}

/**
 * A surface's own source: its page module, and the modules that page mounts.
 *
 * One level, deliberately. Following the whole import graph is what made this
 * check say nothing: the request list's module imports the request *forms*
 * module, which is full of controls a submission disables — and the list draws
 * none of them. A module that is merely reachable is not a control the surface
 * shows, so the closure stops where the page's own composition does.
 */
function surfaceSource(source: string): string {
  const page = applicationModule(resolve(webRoot, "src/app", source));
  if (!page) return "";
  const text = readFileSync(page, "utf8");
  const mounted = [...text.matchAll(/from "(\.[^"]*)"/gu)]
    .map(([, specifier]) =>
      applicationModule(resolve(dirname(page), specifier)),
    )
    .filter((file): file is string => file !== undefined);

  return [text, ...mounted.map((file) => readFileSync(file, "utf8"))].join(
    "\n",
  );
}

/**
 * The flags a module holds for its own submission being in flight.
 *
 * Derived from the module, because this is the whole difference between two
 * states the inventory keeps apart. `pending` is the control a form refuses
 * while the submission it started is running; `disabled` is a control the
 * surface refuses because of what it renders. Both are written `disabled={…}`,
 * so a pattern that reads the attribute alone cannot tell them apart — which is
 * why the guard written to catch a surface declaring an unreachable `disabled`
 * did not catch the next one: the operations surface's every refusal is its own
 * in-flight flag, and it satisfied the attribute pattern exactly.
 */
function inFlightFlags(source: string): Set<string> {
  const flags = new Set<string>();
  for (const [, binding] of source.matchAll(
    /const\s*\[([^\]]*)\]\s*=\s*useActionState\b/gu,
  )) {
    const name = binding.split(",")[2]?.trim();
    if (name) flags.add(name);
  }
  for (const [, name] of source.matchAll(
    /const\s*\[\s*(\w+)\s*,\s*\w+\s*\]\s*=\s*useState(?:<boolean>)?\(\s*false\s*\)/gu,
  )) {
    flags.add(name);
  }
  for (const [, name] of source.matchAll(
    /const\s*\[\s*(\w+)\s*,\s*\w+\s*\]\s*=\s*useTransition\(\)/gu,
  )) {
    flags.add(name);
  }

  return flags;
}

/**
 * A control this surface refuses for a reason it renders.
 *
 * A bare identifier is never evidence: `disabled={pending}` is the surface's
 * `pending` affordance and `disabled={disabled}` is a prop passed through from
 * whatever mounts it, and neither is a refusal this surface decides. What
 * counts is an expression naming something outside the module's own in-flight
 * flags — a routing preview that denied, a list with nothing in it, a role.
 */
function drawsRefusedControl(source: string): boolean {
  const flags = inFlightFlags(source);

  return [
    ...source.matchAll(/(?:^|[^\w-])(?:aria-)?disabled=\{([^{}]*)\}/gu),
  ].some(([, expression]) => {
    const body = expression.trim();
    if (/^[A-Za-z_$][\w$]*$/u.test(body)) return false;

    return [
      ...body.replace(/"[^"]*"|'[^']*'/gu, " ").matchAll(/[A-Za-z_$][\w$]*/gu),
    ].some(([name]) => !flags.has(name));
  });
}

/**
 * What a surface's own composition must show before it may declare a state.
 *
 * Derived rather than argued. The previous guard trusted one rule's prose about
 * one state on one surface; a rule can say a surface refuses a control while a
 * delivery attempt is in flight, and the surface can draw no such refusal at
 * all. Every state whose affordance is visible in a page's own composition gets
 * an entry here, and every row of the inventory declaring one of them is
 * checked — wherever the declaration appears, not where somebody remembered to
 * look.
 */
const stateAffordance: Readonly<Record<string, (source: string) => boolean>> = {
  disabled: drawsRefusedControl,
};

/**
 * How many cases the run actually executes for each state.
 *
 * Pinned per state rather than only in total, because a total hides the shape:
 * a state every one of whose cases is declined contributes nothing and looks
 * exactly like a state that runs, and the fixture-owner guards below cannot see
 * it — they ask who drives a case, never whether anybody drives this state at
 * all.
 */
const declaredStateExecution: Readonly<Record<string, number>> = {
  conflict: 5,
  default: 142,
  destructive: 0,
  disabled: 0,
  empty: 13,
  error: 36,
  loading: 18,
  member_denied: 7,
  not_found: 14,
  pending: 10,
  provider_unavailable: 2,
  success: 5,
};

/**
 * The states the table carries but never runs, and the surfaces still
 * declaring them.
 *
 * Written out rather than counted, so a surface joining or leaving the
 * unexecuted set is an edit somebody made on purpose. Every one of these is
 * declined by a checked-in rule below; what this pins is that the set has not
 * grown quietly, and that no surface sits here whose state the run could in
 * fact reach.
 */
const unexecutedStates: Readonly<Record<string, readonly string[]>> = {
  destructive: [
    "route:/agents/[agentId]",
    "route:/oauth/agent-consent",
    "route:/requests/[requestId]",
    "route:/settings/members",
    "route:/settings/projects/[projectId]",
    "route:/webhooks/[subscriptionId]",
  ],
  disabled: ["route:/requests/new"],
};

describe("the acceptance runner", () => {
  test("addresses every inventory surface, and no other", () => {
    expect(acceptanceSurfaces.map((entry) => entry.id).sort()).toEqual([
      ...inventorySurfaceIds,
    ]);
    expect(new Set(acceptanceSurfaces.map((entry) => entry.id)).size).toBe(
      acceptanceSurfaces.length,
    );
  });

  test("gives every surface a real address and a declared segment", () => {
    for (const entry of acceptanceSurfaces) {
      const tokens = [...entry.path.matchAll(/:[a-z]+/gu)].map(
        (match) => match[0],
      );

      expect({
        id: entry.id,
        path: entry.path.startsWith("/"),
        segment: acceptanceSegments.includes(entry.segment),
        tokens: tokens.filter(
          (token) =>
            !(acceptancePathTokens as readonly string[]).includes(token),
        ),
      }).toEqual({ id: entry.id, path: true, segment: true, tokens: [] });
    }
  });

  test("makes every boundary row print its own segment's sentence", () => {
    const boundaries = acceptanceSurfaces.filter(
      (entry) => entry.boundary !== undefined,
    );

    // The framework boundaries of the inventory, no more and no fewer.
    expect(boundaries.length).toBe(
      inventorySurfaceIds.filter((id) => id.startsWith("boundary:")).length,
    );
    for (const entry of boundaries) {
      const kind = entry.boundary;
      if (kind === undefined) continue;

      expect({ id: entry.id, landmark: entry.landmark }).toEqual({
        id: entry.id,
        landmark: {
          kind: "text",
          text: acceptanceBoundaryText[entry.segment][kind],
        },
      });
    }
  });

  test("waits for a sentence its own boundary component really prints", () => {
    // The table is only evidence while every line in it is a line the named
    // boundary emits. One entry named the /auth-error page's own PageShell
    // title instead, so the assertion was satisfied by the page whether the
    // boundary rendered or not — and on the engine where the boundary does
    // render it could not be satisfied at all.
    const absent: string[] = [];

    for (const segment of acceptanceSegments) {
      for (const kind of Object.keys(acceptanceBoundaryText[segment])) {
        const text =
          acceptanceBoundaryText[segment][kind as AcceptanceBoundaryKind];
        const file = boundaryFiles[segment]?.[kind] ?? "";
        if (text === undefined || !read(file).includes(text)) {
          absent.push(`${segment}/${kind}`);
        }
      }
    }

    expect(absent.sort()).toEqual([]);
  });

  test("waits for a sentence no page of its own draws", () => {
    // A boundary is what a segment shows *instead of* the page, so a sentence
    // the page also prints makes the assertion pass on the page the boundary
    // was supposed to replace. Every boundary here is driven at a real address,
    // and three of those addresses have a page.
    const shared: string[] = [];

    for (const { file, source } of pageSources()) {
      for (const segment of acceptanceSegments) {
        for (const kind of Object.keys(acceptanceBoundaryText[segment])) {
          const text =
            acceptanceBoundaryText[segment][kind as AcceptanceBoundaryKind];
          if (text !== undefined && source.includes(text)) {
            shared.push(`${segment}/${kind}: ${file}`);
          }
        }
      }
    }

    expect([...new Set(shared)].sort()).toEqual([]);
  });

  test("keeps each boundary's sentence unique to the one file that prints it", () => {
    // A boundary assertion is only evidence while the sentence it waits for is
    // printed by exactly one boundary file; two files sharing a line would let
    // a case pass on the wrong one. A segment that writes no file of a kind
    // inherits its parent's, and with it the parent's line, so the sentence
    // and the file must name each other exactly: one line per file, one file
    // per line. This replaced a comparison that left the inherited lines out
    // by hand (ruling 260).
    const linesOfFile = new Map<string, Set<string>>();
    const filesOfLine = new Map<string, Set<string>>();
    for (const segment of acceptanceSegments) {
      for (const [kind, text] of Object.entries(
        acceptanceBoundaryText[segment],
      )) {
        const file = boundaryFiles[segment]?.[kind];
        if (text === undefined || file === undefined) continue;
        linesOfFile.set(file, (linesOfFile.get(file) ?? new Set()).add(text));
        filesOfLine.set(text, (filesOfLine.get(text) ?? new Set()).add(file));
      }
    }

    expect(
      [
        ...[...linesOfFile]
          .filter(([, lines]) => lines.size !== 1)
          .map(([file]) => `file ${file}`),
        ...[...filesOfLine]
          .filter(([, files]) => files.size !== 1)
          .map(([line]) => `line ${line}`),
      ].sort(),
    ).toEqual([]);
  });

  test("gives the settings pages a segment of their own, whose boundaries draw inside the settings layout (ruling 260)", () => {
    const settings = acceptanceSurfaces.filter((entry) =>
      entry.id.startsWith("route:/settings/"),
    );

    expect(settings.map((entry) => [entry.id, entry.segment])).toEqual(
      settings.map((entry) => [
        entry.id,
        entry.id === "route:/settings/appearance"
          ? "app-appearance"
          : "app-settings",
      ]),
    );
    // Driven at a settings page, so the boundary that answers the fault is
    // the settings segment's and not the authenticated segment's.
    expect(
      acceptanceSurfaces
        .filter((entry) => entry.id.endsWith(":(app)/settings"))
        .map(({ boundary, id, path, segment }) => ({
          boundary,
          id,
          path,
          segment,
        })),
    ).toEqual([
      {
        boundary: "error",
        id: "boundary:error:(app)/settings",
        path: "/settings/organization",
        segment: "app-settings",
      },
      {
        boundary: "not-found",
        id: "boundary:not-found:(app)/settings",
        path: "/settings/organization",
        segment: "app-settings",
      },
    ]);
    // A member denied routing or operations is answered not-found, now by the
    // settings segment's boundary, which is the line that denial waits for.
    expect(boundarySentence("app-settings", "not-found")).not.toBe(
      boundarySentence("app", "not-found"),
    );
    expect(boundarySentence("app-settings", "error")).not.toBe(
      boundarySentence("app", "error"),
    );
  });

  test("gives every catalogued scenario a driver of its own", () => {
    const undriven = e2eScenarioIds.filter(
      (id) => !driverSources.includes(`"${id}":`),
    );

    expect(undriven).toEqual([]);
  });

  test("names the surfaces every decline covers", () => {
    // A rule stated by state alone declines that state on *every* surface,
    // including surfaces it was never written about — which is how the
    // persistence aspect lost all three of its cases while every guard here
    // stayed green. A decline has to name what it declines.
    const unscoped = acceptanceSkipRules
      .filter((rule) => rule.surfaces.length === 0)
      .map((rule) => rule.reason.slice(0, 40));
    const addressable = new Set(acceptanceSurfaces.map((entry) => entry.id));
    const unknown = acceptanceSkipRules
      .flatMap((rule) => rule.surfaces)
      .filter((surface) => !addressable.has(surface));

    expect({ unknown: [...new Set(unknown)].sort(), unscoped }).toEqual({
      unknown: [],
      unscoped: [],
    });
  });

  test("leaves every catalogued aspect an executed case of its own", () => {
    // A driver the rules decline every case of is a driver nothing runs, and
    // the source-grep above cannot tell that apart from a driver that runs on
    // every case. This is the guard that binds the catalogue to what executes.
    const unexecuted = e2eScenarioIds.filter(
      (id) =>
        !matrix.cases.some(
          (entry) =>
            entry.fixtureOwner === id &&
            acceptanceSkipReason(entry.surface, entry.state, id) === null,
        ),
    );

    expect([...unexecuted].sort()).toEqual([]);
  });

  test("leaves every catalogued aspect a case the developer host will drive", () => {
    // WebKit is host-dependent: the pin-derived guard skips every WebKit case
    // on the declared developer platform, so an aspect whose only executed case
    // is a WebKit one contributes nothing to the run the team actually makes
    // and first fails in CI — or never fails at all, when the assertion is
    // satisfiable for the wrong reason. Chromium is the engine no host skips,
    // so that is the engine every aspect has to reach.
    const undriven = e2eScenarioIds.filter(
      (id) =>
        !matrix.cases.some(
          (entry) =>
            entry.fixtureOwner === id &&
            entry.engine === "chromium" &&
            acceptanceSkipReason(entry.surface, entry.state, id) === null,
        ),
    );

    expect([...undriven].sort()).toEqual([]);
  });

  test("enumerates no case of its own", () => {
    // The spec reads the table. A case identifier written into the spec is the
    // beginning of a second, drifting copy of the matrix.
    const spelled = matrix.cases
      .map((entry) => entry.id)
      .filter((id) => specSource.includes(id));

    expect(spelled).toEqual([]);
    expect(specSource).toContain("acceptanceCases");
    expect(specSource).toContain("acceptanceSkipReason");
  });

  test("skips for the two reasons the shard budget is charged for", () => {
    // `acceptance-shards.ts` derives what a lane will start by subtracting
    // exactly these two classes from what its project selects, and it asks the
    // second of them of this very function. A third `skip` in the runner would
    // be a class the budget knows nothing about, and the lane would again be
    // charged for cases it never begins — which is the defect that arrangement
    // exists to close, found twice before by a lane expiring rather than by a
    // test.
    const skips = specSource
      .split("\n")
      .filter((line) => line.includes("test.skip("));

    expect(skips.length).toBe(2);
    expect(specSource).toContain("browserName !== testCase.engine");
    expect(specSource).toContain("declined !== null");
  });

  test("tags exactly the route/state lane, so the two shards partition", () => {
    // `playwright.config.ts` greps one tag and grep-inverts the same one, so a
    // tag on both lanes runs half the table twice and a tag on neither drops
    // half of it.
    const tagged = specSource
      .split("\n")
      .filter((line) => line.includes("routeStateTag"));

    expect(tagged.length).toBeGreaterThan(0);
    // The tag is appended for one lane and for no other. Spelled as two
    // fragments because this file is itself scanned for template placeholders.
    expect(specSource).toContain('lane === "route-state" ? ');
    expect(
      specSource.split("\n").filter((line) => line.includes("routeStateTag"))
        .length,
    ).toBe(2);
  });

  /**
   * A state a surface cannot enter is not coverage; it is a row that can never
   * fail. `route:/requests` declared `disabled` while nothing in the list it
   * renders can be refused; `route:/settings/operations` declared it while its
   * every refusal is the flag its own submission sets, which is the `pending`
   * state it already declares beside it. Both declines argued the same
   * in-flight delivery attempt, and no surface here draws one.
   */
  test("declares only the states its own composition can draw", () => {
    const unreachable = routeStateInventory.flatMap((entry) =>
      entry.states
        .filter((state) => {
          const draws = stateAffordance[state];

          return draws !== undefined && !draws(surfaceSource(entry.source));
        })
        .map((state) => `${entry.id}: ${state}`),
    );

    expect(unreachable.sort()).toEqual([]);

    // And every affordance this derives has to reach the inventory, or a rule
    // nothing matches would pass by describing a state no surface declares.
    expect(
      Object.keys(stateAffordance)
        .filter(
          (state) =>
            !routeStateInventory.some((entry) =>
              (entry.states as readonly string[]).includes(state),
            ),
        )
        .sort(),
    ).toEqual([]);
  });

  test("executes what it claims for each state, and names the states it runs none of", () => {
    const executed: Record<string, number> = Object.fromEntries(
      routeStates.map((state) => [state, 0]),
    );
    for (const entry of matrix.cases) {
      if (
        acceptanceSkipReason(entry.surface, entry.state, entry.fixtureOwner) ===
        null
      ) {
        executed[entry.state] = (executed[entry.state] ?? 0) + 1;
      }
    }

    expect(executed).toEqual(declaredStateExecution);
    expect(
      Object.values(declaredStateExecution).reduce((sum, n) => sum + n, 0),
    ).toBe(declaredExecution.executed);

    // The states nothing runs, with the surfaces that still declare them.
    const silent = Object.fromEntries(
      routeStates
        .filter((state) => declaredStateExecution[state] === 0)
        .map((state) => [
          state,
          routeStateInventory
            .filter((entry) => entry.states.includes(state))
            .map((entry) => entry.id)
            .sort(),
        ]),
    );

    expect(silent).toEqual(unexecutedStates);

    // And every one of those rows is declined by a rule that says why, rather
    // than left to be dropped by a runner nobody asked.
    for (const entry of matrix.cases) {
      if (!(entry.state in silent)) continue;
      expect({
        declined:
          acceptanceSkipReason(
            entry.surface,
            entry.state,
            entry.fixtureOwner,
          ) !== null,
        id: entry.id,
      }).toEqual({ declined: true, id: entry.id });
    }
  });

  /**
   * The width composition actually fails at, and the surfaces measured there.
   *
   * `surface` is not one of the pairwise factors and nothing else bound a
   * surface to a width, so a surface could be catalogued only at desktop sizes
   * and the cross-product would still be complete. `expectNoDocumentOverflow`
   * runs on every executed case and on no other, which means such a surface was
   * never measured narrow at all while the runbook presented this table as the
   * mobile verification the specification asks for.
   *
   * The width is read from the table's own declared viewports rather than
   * written here, so the narrowest size this suite runs is whichever size the
   * table declares.
   */
  test("measures every surface at the narrowest viewport the table declares", () => {
    const narrowest = Math.min(
      ...matrix.viewports.map((viewport) => viewport.width),
    );
    const measured = new Set(
      matrix.cases
        .filter(
          (entry) =>
            entry.viewport.width === narrowest &&
            acceptanceSkipReason(
              entry.surface,
              entry.state,
              entry.fixtureOwner,
            ) === null,
        )
        .map((entry) => entry.surface),
    );

    expect(
      [...new Set(matrix.cases.map((entry) => entry.surface))]
        .filter((surface) => !measured.has(surface))
        .sort(),
    ).toEqual([]);
  });

  /**
   * The pointer each case is driven with, and the accommodation it renders.
   *
   * A window narrowed to a phone's width still reports a mouse. Nothing under
   * this application set `hasTouch`, `isMobile` or a device descriptor, and the
   * table had no axis on which a case could ask for one — so every case the
   * runbook presents as mobile verification ran as a narrow desktop window, and
   * the one accommodation the installed token layer publishes for mobile went
   * unrendered by every case in the table.
   *
   * Three claims: the table declares a pointer and declares the coarse one
   * exactly where section 13 says mobile; the runner hands that declaration to
   * the context it opens; and the accommodation the token layer guards behind
   * the coarse query is rendered by an executed case.
   */
  test("declares a coarse pointer at exactly the widths section 13 calls mobile", () => {
    const wrong = matrix.cases
      .filter(
        (entry) => entry.pointer !== pointerForWidth(entry.viewport.width),
      )
      .map((entry) => `${entry.id}: ${entry.viewport.width}px ${entry.pointer}`)
      .sort();

    expect(wrong).toEqual([]);
    // Both pointers are actually run: a table that declared one of them
    // everywhere would satisfy the agreement above and cover nothing.
    expect(
      [...new Set(matrix.cases.map((entry) => entry.pointer))].sort(),
    ).toEqual([...acceptancePointers].sort());
  });

  test("hands each case's declared pointer to the context it opens", () => {
    // A declared axis the runner never reads is a column in a table, not a
    // property of a run.
    expect(specSource).toContain("acceptanceHasTouch");
    expect(specSource).toContain("hasTouch: acceptanceHasTouch(");
    expect(specSource).toContain("testCase.pointer");
    expect(
      specSource.split("\n").filter((line) => line.includes("hasTouch")).length,
    ).toBe(1);
  });

  test("renders the token layer's only coarse-pointer accommodation", () => {
    // Read out of the installed package rather than named here, so the density
    // this guards is whichever density the package guards.
    const stylesheet = readFileSync(
      resolve(webRoot, "node_modules/@cueplusplus/tokens/dist/axes.css"),
      "utf8",
    );
    // Since `@cueplusplus/tokens` 0.17.0 the rule's selector list opens with
    // the line that reaches an island still following the root's density
    // (`:where(:root[data-density="…"]) [data-cue-follows~="density"]`), so
    // the density is the one its plain `[data-density="…"]` selector names.
    const selectors =
      /@media \(pointer: coarse\) \{([^{}]*)\{/u.exec(stylesheet)?.[1] ?? "";
    const branch = selectors
      .split(",")
      .map((selector) => /^\s*\[data-density="([a-z-]+)"\]\s*$/u.exec(selector))
      .find((match) => match !== null);

    expect(branch?.[1]).toBeDefined();
    const accommodated = branch?.[1];
    expect(
      matrix.cases.some(
        (entry) =>
          entry.density === accommodated &&
          entry.pointer === "coarse" &&
          acceptanceSkipReason(
            entry.surface,
            entry.state,
            entry.fixtureOwner,
          ) === null,
      ),
    ).toBe(true);
  });

  test("skips only what a checked-in rule declines, and declines nothing else", () => {
    const skipped = matrix.cases.filter(
      (entry) =>
        acceptanceSkipReason(entry.surface, entry.state, entry.fixtureOwner) !==
        null,
    );

    expect({
      executed: matrix.cases.length - skipped.length,
      skipped: skipped.length,
      total: matrix.cases.length,
    }).toEqual(declaredExecution);

    // A rule that matches nothing is a reason that has outlived its cause.
    for (const rule of acceptanceSkipRules) {
      const matched = matrix.cases.filter((entry) => {
        if (!rule.states.includes(entry.state)) return false;
        if (!rule.surfaces.includes(entry.surface)) return false;

        return rule.owners ? rule.owners.includes(entry.fixtureOwner) : true;
      });

      expect({
        matched: matched.length > 0,
        states: [...rule.states],
      }).toEqual({ matched: true, states: [...rule.states] });
      expect(rule.reason.length).toBeGreaterThan(60);
    }
  });

  test("leaves every executed case a fixture owner the runner can drive", () => {
    const undriven = matrix.cases
      .filter(
        (entry) =>
          acceptanceSkipReason(
            entry.surface,
            entry.state,
            entry.fixtureOwner,
          ) === null,
      )
      .filter((entry) => !driverSources.includes(`"${entry.fixtureOwner}":`))
      .map((entry) => `${entry.id}: ${entry.fixtureOwner}`);

    expect([...new Set(undriven)].sort()).toEqual([]);
  });

  test("gives every conflicting write the sentence its surface prints", () => {
    // A conflict assertion is only evidence while it names the sentence the
    // surface's own `conflict` arm draws; without one the case passes on any
    // rejected submission, and with the fault register neutered it did.
    const missing = matrix.cases
      .filter((entry) => entry.state === "conflict")
      .filter(
        (entry) =>
          acceptanceSkipReason(
            entry.surface,
            entry.state,
            entry.fixtureOwner,
          ) === null,
      )
      .filter(
        (entry) =>
          acceptanceSurface(entry.surface).conflictMessage === undefined,
      )
      .map((entry) => entry.surface);

    expect([...new Set(missing)].sort()).toEqual([]);
  });

  test("names a submit control the application really draws", () => {
    // A case that names its form names it by the label a person reads, so the
    // label has to be one the application prints. "Save role" and "Invite
    // member" sit on the same surface, and the difference between them is
    // whether the case demotes the tenant's own owner on its way past.
    const drawn = componentSources();
    const absent = acceptanceSurfaces
      .filter((entry) => entry.conflictSubmit !== undefined)
      .filter((entry) => !drawn.includes(`"${entry.conflictSubmit}"`))
      .map((entry) => `${entry.id}: ${entry.conflictSubmit}`);

    // And a named control that no executed case reaches is a name kept past
    // its reason, exactly like a skip rule that matches nothing.
    const unused = acceptanceSurfaces
      .filter((entry) => entry.conflictSubmit !== undefined)
      .filter(
        (entry) =>
          !matrix.cases.some(
            (testCase) =>
              testCase.surface === entry.id &&
              testCase.state === "conflict" &&
              acceptanceSkipReason(
                testCase.surface,
                testCase.state,
                testCase.fixtureOwner,
              ) === null,
          ),
      )
      .map((entry) => entry.id);

    expect({ absent, unused }).toEqual({ absent: [], unused: [] });
  });

  test("names a form opener the application really draws, on a surface a form case drives, and hands it to the chooser", () => {
    // A settings page opens a form that used to sit under its list in a
    // dialog (ruling 259), so the pending and conflicting-write drivers press
    // the opener first. Its label has to be one the application prints, and a
    // case has to reach it, or it is a name kept past its reason.
    const drawn = componentSources();
    const openers = acceptanceSurfaces.filter(
      (entry) => entry.formOpener !== undefined,
    );
    const absent = openers
      .filter((entry) => !drawn.includes(`"${entry.formOpener}"`))
      .map((entry) => `${entry.id}: ${entry.formOpener}`);
    const unused = openers
      .filter(
        (entry) =>
          !matrix.cases.some(
            (testCase) =>
              testCase.surface === entry.id &&
              (testCase.state === "pending" || testCase.state === "conflict") &&
              acceptanceSkipReason(
                testCase.surface,
                testCase.state,
                testCase.fixtureOwner,
              ) === null,
          ),
      )
      .map((entry) => entry.id);
    // Both form drivers pass it on: the conflicting write and the held one.
    const drivers = read("tests/fixtures/acceptance-drivers.ts");

    expect({
      absent,
      handed: drivers.match(/input\.entry\.formOpener/gu)?.length ?? 0,
      unused,
    }).toEqual({ absent: [], handed: 2, unused: [] });
    expect(openers.map((entry) => entry.id).sort()).toEqual([
      "route:/settings/members",
      "route:/settings/operations",
    ]);
  });

  test("spells the appearance key the document really writes", () => {
    // The browser fixtures cannot import the appearance module: it reaches
    // `@cueplusplus/ui/system`, whose published entry point is TypeScript, and
    // Playwright's loader refuses a `.ts` file under `node_modules`. So the key
    // is spelled in the fixture and pinned here, in the lane that can import
    // the module that emits it — a driver writing a key nothing reads back is
    // exactly the shape this round is removing.
    expect(read("tests/fixtures/acceptance-run.ts")).toContain(
      `export const appearanceStorageKey = ${JSON.stringify(
        appearanceStorageKey,
      )};`,
    );
  });

  test("grants the mount stamp to the one boundary that owns its document", () => {
    // `global-error` is the only boundary that replaces the root layout, so it
    // is the only case whose document can arrive carrying no triple at all.
    // The allowance is keyed to the fixed fallback and granted in one place; a
    // second grant would be a second case allowed to change its appearance
    // after the document arrived, which is the claim every case makes.
    expect(
      specSource.split("\n").filter((line) => line.includes("stampedOnMount"))
        .length,
    ).toBe(1);
    expect(specSource).toContain("stampedOnMount: appearanceFallback");
  });

  test("requires each case to assert the universal claims exactly once", () => {
    // The `settle` count is what stops a driver from reporting a pass it never
    // checked; the assertion on it lives in the spec, so its absence is a
    // change to this file as well.
    expect(specSource).toContain("settled: 1");
    expect(specSource).toContain("expectNoAppearanceFlash");
    expect(specSource).toContain("expectPaintedScheme");
    expect(specSource).toContain("expectNoDocumentOverflow");
  });
});

describe("a hydration complaint is the cause, not a flake", () => {
  test("every matrix case refuses one, whatever its driver asserts", () => {
    /*
     * The defect this closes. React recovers from a hydration mismatch by
     * re-rendering the subtree on the client while the server's markup is still
     * in the document, so the page ends up holding two of a control — and the
     * case fails later on a selector that matched twice, naming a label rather
     * than the cause. `projects.spec.ts` records that happening twice, fixed
     * twice as something else.
     *
     * The appearance drivers already refuse a complaint. The matrix collected
     * the console and no route/state driver ever read it, so the same fault
     * read as a mystery duplicate here and as a named failure there. It is
     * refused for every case, in the spec, because a driver that has to
     * remember is a driver that will not.
     */
    expect(specSource).toContain("consoleLog.hydration");
    /*
     * Raised even when the driver threw. A mismatch makes the driver itself
     * fail on a selector that matched twice, so a check placed after the driver
     * call never runs for the case it was written to explain — it can only
     * convert passing cases into failures.
     */
    expect(specSource).toMatch(
      /catch \(error\)[\s\S]*?reportHydration\(\)[\s\S]*?throw error/u,
    );
  });
});

describe("a page that hit its error boundary says so", () => {
  /** The little of a Page this refusal touches. */
  const pageShowing = (texts: readonly string[]) =>
    ({
      getByText: (text: string) => ({
        count: async () => (texts.includes(text) ? 1 : 0),
      }),
    }) as unknown as Parameters<typeof refuseErrorBoundary>[0];

  const surface = (
    id: string,
    segment: "app" | "app-appearance" | "app-settings" | "auth" | "root",
    landmark: { kind: "heading"; text: string },
    boundary?: "error",
  ) =>
    ({
      ...(boundary === undefined ? {} : { boundary }),
      id,
      landmark,
      path: "/",
      segment,
    }) as unknown as Parameters<typeof refuseErrorBoundary>[1];

  test("refuses when an ordinary surface rendered the boundary", async () => {
    /*
     * The defect this closes. A surface whose render throws does not fail where
     * the mistake is: it renders the error boundary perfectly well, the
     * landmark never appears, and the case spends its whole expectation budget
     * before reporting a heading that did not become visible — naming the
     * surface rather than the reason. Observed on a request surface, whose page
     * had rendered "Something went wrong" because a query failed with a
     * WebSocket error from the driver's connection to the local proxy.
     */
    await expect(
      refuseErrorBoundary(
        pageShowing([boundarySentence("app", "error")]),
        surface("route:/requests/[requestId]", "app", {
          kind: "heading",
          text: "Overview",
        }),
      ),
    ).rejects.toThrow(/rendered its error boundary/u);
  });

  test("refuses on every segment's own sentence, because boundaries nest", async () => {
    // Looking only for the app segment's sentence left every appearance,
    // settings, auth and root surface uncovered: one of those throwing renders
    // *its* sentence and the app's never appears.
    for (const segment of [
      "app-appearance",
      "app-settings",
      "auth",
      "root",
    ] as const) {
      await expect(
        refuseErrorBoundary(
          pageShowing([boundarySentence(segment, "error")]),
          surface(`route:${segment}`, segment, {
            kind: "heading",
            text: "Overview",
          }),
        ),
      ).rejects.toThrow(/rendered its error boundary/u);
    }
  });

  test("says nothing when the surface rendered its own content", async () => {
    await expect(
      refuseErrorBoundary(
        pageShowing(["Overview"]),
        surface("route:/", "app", { kind: "heading", text: "Overview" }),
      ),
    ).resolves.toBeUndefined();
  });

  test("exempts a case that drives a boundary on purpose", async () => {
    // Exempting on the landmark's *text* instead exempted every surface that
    // uses a boundary sentence as its landmark — dozens of ordinary route
    // cases whose landmark is the not-found sentence — so the refusal was
    // silent for exactly the cases it exists to catch. The surface being a
    // boundary case is the thing that makes it deliberate.
    await expect(
      refuseErrorBoundary(
        pageShowing([boundarySentence("app", "error")]),
        surface(
          "boundary:error:(app)",
          "app",
          { kind: "heading", text: "Something went wrong" },
          "error",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  test("is called by the landmark expectation, not merely defined", () => {
    // Behaviour above, call site here: deleting the call passed every test
    // when this file only matched strings.
    expect(runSource).toMatch(
      /export async function expectLandmark[\s\S]*?await refuseErrorBoundary\(/u,
    );
  });
});

describe("a page that answered the tenant's not-found says so (ruling 260)", () => {
  /** The little of a Page this refusal touches. */
  const pageShowing = (texts: readonly string[]) =>
    ({
      getByText: (text: string) => ({
        count: async () => (texts.includes(text) ? 1 : 0),
      }),
      getByRole: () => ({ textContent: async () => "Acceptance tenant" }),
      context: () => ({ cookies: async () => [] }),
    }) as unknown as Parameters<typeof refuseTenantNotFound>[0];

  test("refuses a settings page that drew the settings segment's not-found line", async () => {
    // A settings page's not-found renders the settings boundary's own line,
    // so a detector that looked only for the authenticated segment's would
    // let a settings case wait out its whole timeout instead.
    await expect(
      refuseTenantNotFound(
        pageShowing([boundarySentence("app-settings", "not-found")]),
        { kind: "heading", text: "Members" },
      ),
    ).rejects.toThrow(/tenant not-found page/u);
    await expect(
      refuseTenantNotFound(
        pageShowing([boundarySentence("app", "not-found")]),
        { kind: "heading", text: "Overview" },
      ),
    ).rejects.toThrow(/tenant not-found page/u);
  });

  test("exempts a case whose landmark is that line, and a page that drew its own content", async () => {
    await expect(
      refuseTenantNotFound(
        pageShowing([boundarySentence("app-settings", "not-found")]),
        { kind: "text", text: boundarySentence("app-settings", "not-found") },
      ),
    ).resolves.toBeUndefined();
    await expect(
      refuseTenantNotFound(pageShowing(["Members"]), {
        kind: "heading",
        text: "Members",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("a hydration mismatch is visible in the build the lanes run", () => {
  test("classifies what a production build emits, not only development prose", () => {
    // The lanes build and serve with `next start`, so a mismatch arrives
    // minified. The prose-only classifier could not fire at all — it read as
    // coverage while seeing nothing.
    expect(
      isHydrationMismatch(
        "Minified React error #418; visit https://react.dev/errors/418",
      ),
    ).toBe(true);
    expect(
      isHydrationMismatch(
        "Minified React error #425; visit https://react.dev/errors/425",
      ),
    ).toBe(true);
  });

  test("ignores the codes React emits when it recovers from a thrown render", () => {
    // 419, 422 and 423 say React recovered from an error *during* hydration,
    // which the matrix's own `error` and `loading` cases produce on purpose.
    // Collecting them would fail the cases that work.
    for (const code of [419, 422, 423]) {
      expect(
        isHydrationMismatch(
          `Minified React error #${code}; visit https://react.dev/errors/${code}`,
        ),
      ).toBe(false);
    }
  });

  test("still sees the development wording", () => {
    expect(
      isHydrationMismatch("Hydration failed because the server rendered HTML"),
    ).toBe(true);
  });
});
