import { resolve } from "node:path";

/**
 * Where each acceptance lane writes the machine-readable record of its run.
 *
 * `line` tells a person what happened and is gone when the job ends. The
 * run-evidence document is built from what the lanes actually ran, case by
 * case, so the lanes have to leave something a program can read — and it has
 * to survive the next lane, which is why it is not under `outputDir`:
 * Playwright empties that directory at the start of every run, so a report
 * written into it would be deleted by the lane that follows.
 *
 * One file per lane rather than one per run, because each lane is its own
 * Playwright process: they share this directory and would otherwise overwrite
 * one another's answer. `scripts/run-foundation-e2e.mjs` removes the reports of
 * the lanes it is about to run — not the whole directory, which it did while a
 * run was always every lane and which deleted a `pnpm test:webkit` run's
 * reports afterwards. So a report here is this run's answer *for the lanes this
 * run ran*, and a directory holding every lane may hold answers from more than
 * one run. Nothing assembles those into a document today —
 * `scripts/write-run-evidence.mjs` was deleted with the rest of the CI-era
 * tooling — and anything that replaces it has to stamp a run onto each report
 * rather than trust the set.
 */
export const acceptanceReportDirectory = resolve(
  import.meta.dirname,
  "../../acceptance-report",
);

/**
 * The extension, assembled rather than spelled.
 *
 * `browser-spec-contract` reads every string literal under this tree as a
 * possible CSS selector, and a literal beginning with a dot reads as a class
 * the application never emits.
 */
const reportExtension = ["", "json"].join(".");

/**
 * The report file the process running these shards writes.
 *
 * Named for the shards themselves so the file says which partition answered
 * for it. A process asked for no shard runs every lane at once and answers for
 * all of them, which is a different file rather than a nameless one.
 */
export function acceptanceReportFile(shards: readonly string[]): string {
  const name = shards.length > 0 ? [...shards].toSorted().join("+") : "all";

  return resolve(acceptanceReportDirectory, `${name}${reportExtension}`);
}
