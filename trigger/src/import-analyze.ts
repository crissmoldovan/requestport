import "./database-surface.js";

import { runImportAnalyze } from "@requestport/jobs";
import { task } from "@trigger.dev/sdk";

export const importAnalyze = task({
  id: "legacy-import-analyze",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
    randomize: true,
  },
  // Settles under this run's own id, which the dispatcher recorded at
  // acceptance (manifest-i2.md §5.1 "Settlement").
  run: (payload: unknown, { ctx }) =>
    runImportAnalyze(payload, { kind: "trigger_run", runId: ctx.run.id }),
});
