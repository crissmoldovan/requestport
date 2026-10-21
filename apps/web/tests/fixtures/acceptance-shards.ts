import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { acceptanceSkipReason } from "../../src/test/acceptance-skip-rules.ts";
import {
  type AcceptanceCase,
  acceptanceCases,
  routeStateTag,
} from "./acceptance-matrix.ts";

/**
 * What each shard carries, derived from the tree Playwright loads.
 *
 * A Playwright project does not select from the acceptance table — it greps
 * titles — so a count read out of `acceptanceCases` is not the count the shard
 * runs. Both appearance shards also carry every untagged spec in the tree, and
 * charging them nothing is how a lane came to run more cases than the budget
 * derived from the table had paid for.
 *
 * This module therefore walks the same directory Playwright's `testDir` and
 * `testMatch` pair selects from and attributes every case in it to a lane by
 * the same tag the projects grep on. The attribution is static, so it is
 * checked rather than trusted: `scripts/playwright-config.test.mjs` asks
 * Playwright itself to list the tree and fails if these counts differ from the
 * selection it reports.
 *
 * What a shard selects is still not what it starts, and the difference is two
 * classes rather than one. The runner skips a case whose declared engine is
 * not the project's, and it skips a case the checked-in rules decline — both
 * from inside the case, once a browser context has been handed over. So the
 * second class is asked of the same function the runner asks, with the same
 * arguments, rather than restated here: a rule added to that list is charged
 * and skipped in one edit, and cannot come to mean one thing to the runner and
 * another to the budget.
 */

export type AcceptanceLane = AcceptanceCase["lane"];
export type AcceptanceEngine = AcceptanceCase["engine"];

/**
 * What one case is asked, to decide whether the runner will start it.
 *
 * The same question the runner asks, so the answer cannot differ. A case a
 * spec contributes outside the table is asked nothing: there is no surface and
 * no state for a rule to be about.
 */
export type AcceptanceSkipDecision = (
  surface: string,
  state: string,
  fixtureOwner?: string,
) => string | null;

/** One case, and the lane and engine that decide which shards carry it. */
export type AcceptanceShardCase = Readonly<{
  /** The engine the case declares, or `null` when every engine runs it. */
  engine: AcceptanceEngine | null;
  file: string;
  lane: AcceptanceLane;
  /** The surface and state a rule can decline, or `null` outside the table. */
  subject: Readonly<{
    fixtureOwner: string;
    state: string;
    surface: string;
  }> | null;
}>;

const specDirectory = resolve(import.meta.dirname, "../e2e");

/**
 * Every spec file under the acceptance tree, as Playwright matches them.
 *
 * The suffix is a pattern rather than a string because `browser-spec-contract`
 * reads every string literal under this tree as a possible CSS selector, and
 * `".spec.ts"` reads as a class the application never emits.
 */
const specSuffix = /\.spec\.ts$/u;

function specFiles(directory: string, prefix = ""): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? specFiles(join(directory, entry.name), `${prefix}${entry.name}/`)
      : specSuffix.test(entry.name)
        ? [`${prefix}${entry.name}`]
        : [],
  );
}

/**
 * The cases one spec file contributes.
 *
 * A spec that reads the acceptance table contributes that table: every row
 * becomes a case, on the lane and the engine the row declares. Every other
 * spec contributes one case per `test(` it declares, on the lane its tag
 * selects and on every engine, because nothing there is engine-specific.
 */
function casesIn(file: string): readonly AcceptanceShardCase[] {
  const source = readFileSync(join(specDirectory, file), "utf8");

  if (source.includes("acceptanceCases")) {
    return acceptanceCases.map((entry) => ({
      engine: entry.engine,
      file,
      lane: entry.lane,
      subject: {
        fixtureOwner: entry.fixtureOwner,
        state: entry.state,
        surface: entry.surface,
      },
    }));
  }

  const lane: AcceptanceLane = source.includes(routeStateTag)
    ? "route-state"
    : "appearance";

  return [...source.matchAll(/(?<![\w.$])test\s*\(/gu)].map(() => ({
    engine: null,
    file,
    lane,
    subject: null,
  }));
}

/**
 * Every case in the acceptance tree.
 *
 * A spec file that contributes nothing is refused here rather than silently
 * costing a shard nothing: it is either a file no shard claims, or a file this
 * derivation cannot read, and both are reasons to stop.
 */
export const acceptanceShardCases: readonly AcceptanceShardCase[] = specFiles(
  specDirectory,
)
  .toSorted()
  .flatMap((file) => {
    const cases = casesIn(file);
    if (cases.length === 0) {
      throw new Error(
        `No shard claims ${file}: it is under the acceptance test tree and declares no case.`,
      );
    }

    return cases;
  });

/** The name Playwright gives the shard that runs one lane on one engine. */
export function acceptanceShardName(
  lane: AcceptanceLane,
  engine: AcceptanceEngine,
): string {
  return `${lane}-${engine}`;
}

/**
 * How many cases each shard selects, how many of them it starts, and which
 * files those come from.
 *
 * `selected` is what the project's grep picks up. `runnable` is what is left
 * once the runner has skipped the cases the table declares on the other engine
 * *and* the cases the checked-in rules decline. Both are spent: a skip is
 * decided only after the case has been handed a browser context, so the
 * difference between the two counts costs the lane wall clock of its own.
 * `playwright.config.ts` charges each at what it measured, and
 * `scripts/playwright-config.test.mjs` holds the arithmetic and proves the
 * budget moves when a rule is added.
 *
 * `runnableFiles` is that same runnable set, tallied by the file each case
 * came from. A count alone says what a lane costs only while every case in it
 * costs the same, and the longest journeys in this tree cost several times what
 * the mean does — so the budget has to be able to ask which lanes actually run
 * them rather than charging every lane an average. Tallied rather than listed,
 * because a file contributes as many cases as it declares.
 *
 * The decision is a parameter only so that a test can plant a rule and watch
 * the budget fall. Its default is the function the runner itself calls, which
 * is what keeps the two from drifting.
 */
export function acceptanceShardCounts(
  engines: readonly AcceptanceEngine[],
  declined: AcceptanceSkipDecision = acceptanceSkipReason,
): {
  runnable: ReadonlyMap<string, number>;
  runnableFiles: ReadonlyMap<string, ReadonlyMap<string, number>>;
  selected: ReadonlyMap<string, number>;
} {
  const runnable = new Map<string, number>();
  const runnableFiles = new Map<string, ReadonlyMap<string, number>>();
  const selected = new Map<string, number>();

  for (const engine of engines) {
    for (const lane of ["appearance", "route-state"] as const) {
      const carried = acceptanceShardCases.filter(
        (entry) => entry.lane === lane,
      );
      const name = acceptanceShardName(lane, engine);
      const started = carried.filter(
        (entry) =>
          (entry.engine === null || entry.engine === engine) &&
          (entry.subject === null ||
            declined(
              entry.subject.surface,
              entry.subject.state,
              entry.subject.fixtureOwner,
            ) === null),
      );
      const tally = new Map<string, number>();
      for (const entry of started) {
        tally.set(entry.file, (tally.get(entry.file) ?? 0) + 1);
      }

      runnable.set(name, started.length);
      runnableFiles.set(name, tally);
      selected.set(name, carried.length);
    }
  }

  return { runnable, runnableFiles, selected };
}
