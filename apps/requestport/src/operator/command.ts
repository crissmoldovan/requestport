import type { ChildProcess, SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

import { moduleLayout } from "../layout.js";

/**
 * The operator step's process (manifest-h.md §2.4): `requestport start`
 * runs it as a child, so that the owner's credentials are in no environment
 * and no memory of the process that goes on to serve. Its arguments are
 * the operator entry and the data directory, and nothing else: the child
 * reads the owner URL from the data directory's `owner.json` itself.
 */

/**
 * The operator child's entry, and the arguments that load it, for this
 * module at `moduleUrl` (`../layout.ts`):
 *
 * - in the repository, `./entry.ts`, TypeScript, which tsx loads:
 *   `--import` preloads `bin/tsx-loader.mjs`, which registers tsx's loader,
 *   as `bin/requestport.mjs` does for `cli.ts`. This module names that file
 *   and not tsx, so that nothing the tarball bundles names tsx;
 * - packed, `./operator.js`, the operator entry esbuild writes into `dist/`
 *   beside this module's chunk (`apps/requestport/bundle.mjs`), with no
 *   loader: the tarball carries no tsx.
 */
function operatorChild(moduleUrl: string): {
  entry: string;
  loader: string[];
} {
  if (moduleLayout(moduleUrl) === "packed") {
    return {
      entry: fileURLToPath(new URL("./operator.js", moduleUrl)),
      loader: [],
    };
  }
  return {
    entry: fileURLToPath(new URL("./entry.ts", moduleUrl)),
    loader: ["--import", new URL("../../bin/tsx-loader.mjs", moduleUrl).href],
  };
}

/** The operator step's entry, as this module runs: `./entry.ts` in the repository, `dist/operator.js` packed. */
export const OPERATOR_ENTRY = operatorChild(import.meta.url).entry;

export interface OperatorCommand {
  command: string;
  args: string[];
}

/**
 * `node [--import <bin/tsx-loader.mjs>] <entry> <data directory>`: the
 * loader in the repository only (`operatorChild`). `entry` is another module
 * only in tests, which start a test entry around the same step, and
 * `moduleUrl` another URL only in tests, which ask for the packed form.
 */
export function operatorChildCommand(
  dataDirectory: string,
  entry?: string,
  moduleUrl: string = import.meta.url,
): OperatorCommand {
  const child = operatorChild(moduleUrl);
  return {
    command: process.execPath,
    args: [...child.loader, entry ?? child.entry, dataDirectory],
  };
}

/** How the child is started: `node:child_process`'s `spawn`, or a test's recording wrapper. */
export type SpawnOperator = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface OperatorExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Waits for the child to exit, and answers how. */
export function operatorExit(child: ChildProcess): Promise<OperatorExit> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
