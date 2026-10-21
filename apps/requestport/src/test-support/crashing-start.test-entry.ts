import { fileURLToPath } from "node:url";

import { runStart } from "../start/start.js";
import { crashAtBoundary } from "./crash-at-boundary.js";

/*
 * A test's `requestport start` that crashes (manifest-h.md §2.3.1's proof,
 * Done when 6a): `runStart` as the executable runs it, over this process's
 * arguments and environment, with two test-only parameters. Its
 * `afterBoundary` kills this process at the boundary among B1 to B4 that
 * `RP_H4_TEST_CRASH_AT` names (`crash-at-boundary.ts`), and its operator
 * child is `crashing-operator.test-entry.ts`, which kills itself at the one
 * among B5 to B11. With no boundary named, or one it never crosses, it is a
 * start like the shipped one. Only the tests start this module.
 */
process.exitCode = await runStart(process.argv.slice(2), process.env, {
  operatorEntry: fileURLToPath(
    new URL("./crashing-operator.test-entry.ts", import.meta.url),
  ),
  afterBoundary: crashAtBoundary,
});
