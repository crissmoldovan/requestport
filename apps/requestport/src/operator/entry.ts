import { declareDatabaseSurface } from "@requestport/db";

import { runOperatorStep } from "./operator-step.js";

/*
 * The operator step's process (`operator/command.ts`). It declares the
 * `operator` surface first, before anything can connect, as the private
 * CLI's entry does (manifest-h.md §2.4), and takes one argument, the data
 * directory.
 */
declareDatabaseSurface("operator");

const [dataDirectory, ...rest] = process.argv.slice(2);
if (dataDirectory === undefined || rest.length > 0) {
  process.stderr.write(
    "requestport start: the operator step takes one argument, the data directory.\n",
  );
  process.exitCode = 2;
} else {
  process.exitCode = await runOperatorStep({
    dataDirectory,
    env: process.env,
    output: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
  });
}
