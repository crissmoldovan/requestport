// The counters first, so that they are in place before anything below loads.
import { installWebUiCounters, webUiCounters } from "./web-ui-counters.js";

installWebUiCounters(process.env);

const { appendFileSync } = await import("node:fs");
const { serveFromDataDirectory } = await import("../serve/run.js");
const { runStart } = await import("../start/start.js");

/*
 * Done when 11's `requestport start` (manifest-h.md §2.7.1;
 * `web-ui.integration.test.ts`): `runStart` as the executable runs it, over
 * this process's arguments and environment, with `web-ui-counters.ts`
 * installed first and two records appended, as JSON lines, to the file
 * `RP_H5_RECORD` names:
 * - `serving`, once the worker is ready and the start has said it serves:
 *   the surface this process declared, whether the host's handoff is set,
 *   with its members, and which of the GitHub and Resend pairs' names its
 *   environment holds (the names, never a value);
 * - `closed`, once every storage has closed: the same, and every count.
 * Only the tests start this module.
 */
const recordFile = process.env.RP_H5_RECORD;
const record = (entry: Record<string, unknown>) => {
  if (recordFile !== undefined) {
    appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
  }
};
const HOST = Symbol.for("requestport.host");
const PROVIDER_VARIABLES = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
];
const handoffNow = () => {
  const handoff = (globalThis as Record<symbol, unknown>)[HOST];
  return handoff === undefined
    ? null
    : Object.keys(handoff as Record<string, unknown>).sort();
};

process.exitCode = await runStart(process.argv.slice(2), process.env, {
  serve: (context) =>
    serveFromDataDirectory({
      ...context,
      hooks: {
        afterServing: ({ surface }) => {
          record({
            event: "serving",
            surface: surface ?? null,
            handoff: handoffNow(),
            providerVariables: PROVIDER_VARIABLES.filter(
              (name) => process.env[name] !== undefined,
            ),
          });
        },
        afterClose: async () => {
          const { declaredDatabaseSurface } = await import("@requestport/db");
          record({
            event: "closed",
            surface: declaredDatabaseSurface() ?? null,
            handoff: handoffNow(),
            counters: webUiCounters(),
          });
        },
      },
    }),
});
