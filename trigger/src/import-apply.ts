import "./database-surface.js";

import { runImportApply } from "@requestport/jobs";
import { task } from "@trigger.dev/sdk";

import { triggerJobRunner } from "./job-runner.js";

export const importApply = task({
  id: "legacy-import-apply",
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
    runImportApply(payload, triggerJobRunner, {
      kind: "trigger_run",
      runId: ctx.run.id,
    }),
});
