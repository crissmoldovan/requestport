import { declareDatabaseSurface } from "@requestport/db";

import { runOperatorStep } from "../operator/operator-step.js";
import { crashAtBoundary } from "./crash-at-boundary.js";

/*
 * A test's operator child that crashes (manifest-h.md §2.3.1's proof, Done
 * when 6a): `operator/entry.ts`'s step, declared `operator` as that entry
 * declares it, with one test-only parameter, an `afterBoundary` that kills
 * this process at the boundary among B5 to B11 that `RP_H4_TEST_CRASH_AT`
 * names (`crash-at-boundary.ts`). B5 and B8 are inside their transactions,
 * before `COMMIT`. Only `crashing-start.test-entry.ts` starts this module.
 */
declareDatabaseSurface("operator");

const [dataDirectory = ""] = process.argv.slice(2);

process.exitCode = await runOperatorStep({
  dataDirectory,
  env: process.env,
  output: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  afterBoundary: crashAtBoundary,
});
