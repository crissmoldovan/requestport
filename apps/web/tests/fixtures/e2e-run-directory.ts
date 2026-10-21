import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");

/**
 * The variable every process of one acceptance run reads to find that run's
 * directory.
 *
 * A run is several processes — one Playwright per lane, each with its own
 * reporters — and a stamp minted per process would scatter one run across four
 * folders. `scripts/run-foundation-e2e.mjs` mints the directory once and names
 * it here, so every lane writes into the same place; a process started on its
 * own mints its own and is still a complete run.
 *
 * It lives beside the other acceptance fixtures rather than in `scripts/`
 * because both a `.ts` config and a `.mjs` script have to import it, and that
 * is the direction that already works here — `run-foundation-e2e.mjs` imports
 * `acceptance-report.ts` the same way.
 */
export const E2E_RUN_DIRECTORY_VARIABLE = "REQUESTPORT_E2E_RUN_DIRECTORY";

/** Where runs accumulate. Ignored by git: these hold screenshots and traces. */
export const e2eResultsRoot = resolve(repositoryRoot, "e2e-results");

/**
 * The folder name for a run, as date and time.
 *
 * ISO 8601 with the colons replaced, because a colon is not portable in a path
 * and is refused outright on Windows. Sub-second precision is dropped: two
 * runs cannot start in the same second on one machine, and the name is read by
 * people. Lexical order is chronological order, which is what makes a listing
 * of this directory useful without sorting it.
 */
export function e2eRunStamp(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/u, "Z")
    .replaceAll(":", "-");
}

/**
 * This run's directory: the one the environment names, or a new stamp.
 *
 * Reading the environment first is what joins the lanes of a single run
 * together. It is deliberately not created here — the Playwright config calls
 * this while merely being loaded, including by the config contract tests, and
 * loading a config should not leave a directory behind.
 */
export function e2eRunDirectory({
  env = process.env,
  now = () => new Date(),
}: {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
} = {}): string {
  const named = env[E2E_RUN_DIRECTORY_VARIABLE];

  if (typeof named === "string" && named.trim() !== "") return named.trim();

  return resolve(e2eResultsRoot, e2eRunStamp(now()));
}

/** The same directory, created, for the process that owns the run. */
export function createE2ERunDirectory(
  options: Parameters<typeof e2eRunDirectory>[0] = {},
): string {
  const directory = e2eRunDirectory(options);
  mkdirSync(directory, { recursive: true });

  return directory;
}
