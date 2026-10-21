import "./database-surface.js";

import { createImportTaskDispatchRepository } from "@requestport/db";
import { workerStorages } from "@requestport/jobs";
import { idempotencyKeys, schedules } from "@trigger.dev/sdk";

import { importAnalyze } from "./import-analyze.js";
import { importApply } from "./import-apply.js";
import { observeTaskResult, triggerMetrics } from "./observability.js";
import { REPAIR_LEASE_SECONDS } from "./repair-lease.js";

/**
 * Hands every claimable import dispatch to its task (track-i2.md, "I.2b
 * design" §3): a batch claimed through function 4 on the dispatcher's
 * storage, each under a lease id the database generates and for
 * `REPAIR_LEASE_SECONDS`; per dispatch, the
 * run started, then accepted through function 5 under the claim's lease with
 * the id `trigger()` returned, which is the run's `ctx.run.id` and what it
 * settles under.
 */
export const importDispatchRepair = schedules.task({
  id: "legacy-import-dispatch-repair",
  cron: "*/2 * * * *",
  run: async () =>
    observeTaskResult("legacy-import-dispatch-repair", async () => {
      const dispatcher = createImportTaskDispatchRepository(
        workerStorages().dispatcher,
      );
      const claimed = await dispatcher.claimBatch(50, REPAIR_LEASE_SECONDS);
      let accepted = 0;
      for (const dispatch of claimed) {
        try {
          const idempotencyKey = await idempotencyKeys.create(
            `import-dispatch:${dispatch.id}:${dispatch.attemptCount}`,
            { scope: "global" },
          );
          const handle =
            dispatch.taskKind === "analyze"
              ? await importAnalyze.trigger(
                  {
                    dispatchId: dispatch.id,
                    attemptCount: dispatch.attemptCount,
                  },
                  { idempotencyKey, idempotencyKeyTTL: "30d" },
                )
              : await importApply.trigger(
                  {
                    dispatchId: dispatch.id,
                    attemptCount: dispatch.attemptCount,
                  },
                  { idempotencyKey, idempotencyKeyTTL: "30d" },
                );
          if (
            await dispatcher.acceptClaim(
              dispatch.id,
              dispatch.leaseId,
              handle.id,
            )
          ) {
            accepted += 1;
          }
        } catch {
          // Trigger acceptance is unknown. The lease remains authoritative until
          // it expires, after which this repair schedule may claim it again.
        }
      }
      triggerMetrics.gauge("import.dispatch_repair_claimed", claimed.length, {
        status: "claimed",
        taskId: "legacy-import-dispatch-repair",
      });
      return { claimed: claimed.length, accepted };
    }),
});
