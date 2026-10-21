import { appendFileSync } from "node:fs";

import {
  declareDatabaseSurface,
  declaredDatabaseSurface,
} from "@requestport/db";

import { runOperatorStep } from "./operator-step.js";

/*
 * A test's operator child (manifest-h.md Done when 5): `entry.ts`'s step,
 * declared `operator` as that entry declares it, with one test-only
 * parameter: at each boundary this process records its own `process.argv`,
 * `process.env` and declared surface, as JSON lines appended to the file
 * `RP_H4_TEST_RECORD`
 * names, which reaches it in the environment its parent passes on. Only the
 * tests start this module, through `start.test-entry.ts`.
 */
declareDatabaseSurface("operator");

const recordFile = process.env.RP_H4_TEST_RECORD;
const [dataDirectory = ""] = process.argv.slice(2);

process.exitCode = await runOperatorStep({
  dataDirectory,
  env: process.env,
  output: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  afterBoundary: (boundary) => {
    if (recordFile !== undefined) {
      appendFileSync(
        recordFile,
        `${JSON.stringify({
          process: "operator",
          boundary,
          argv: process.argv,
          env: process.env,
          surface: declaredDatabaseSurface() ?? null,
        })}\n`,
      );
    }
  },
});
