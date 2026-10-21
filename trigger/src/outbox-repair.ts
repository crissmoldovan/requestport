import "./database-surface.js";

import { createOutboxRepository } from "@requestport/db";
import { workerStorages } from "@requestport/jobs";
import { idempotencyKeys, schedules } from "@trigger.dev/sdk";
import { observeTaskResult, triggerMetrics } from "./observability.js";
import { outboxDelivery } from "./outbox-delivery.js";
import { REPAIR_LEASE_SECONDS } from "./repair-lease.js";

/**
 * Hands every claimable outbox row to `outbox-delivery` (track-i2.md, "I.2b
 * design" §3): the backlog from function 16 on the maintenance storage; a
 * batch claimed through function 1 on the dispatcher's, each row under a
 * lease id the database generates and for `REPAIR_LEASE_SECONDS`; per row, the run started, then accepted
 * through function 2 under the claim's lease with the id `trigger()`
 * returned, which is the run's `ctx.run.id` and what it settles under.
 */
export const outboxRepair = schedules.task({
  id: "outbox-repair",
  cron: "*/2 * * * *",
  run: async () =>
    observeTaskResult("outbox-repair", async () => {
      const storages = workerStorages();
      const backlog = await createOutboxRepository(
        storages.maintenance,
      ).pendingBacklog();
      triggerMetrics.gauge("outbox.pending_total", backlog.count, {
        status: "eligible",
        taskId: "outbox-repair",
      });
      triggerMetrics.gauge(
        "outbox.oldest_age_seconds",
        backlog.oldestAgeSeconds,
        {
          status: "eligible",
          taskId: "outbox-repair",
        },
      );
      const dispatcher = createOutboxRepository(storages.dispatcher);
      const claimed = await dispatcher.claimBatch(100, REPAIR_LEASE_SECONDS);
      let accepted = 0;
      for (const row of claimed) {
        try {
          const handle = await outboxDelivery.trigger(
            { outboxId: row.id },
            {
              idempotencyKey: await idempotencyKeys.create(
                `outbox:${row.id}:${row.attemptCount}`,
                { scope: "global" },
              ),
              idempotencyKeyTTL: "30d",
            },
          );
          if (await dispatcher.acceptClaim(row.id, row.leaseId, handle.id)) {
            accepted += 1;
          }
        } catch {
          // The lease remains until expiry because Trigger acceptance is unknown.
        }
      }
      return { claimed: claimed.length, accepted };
    }),
});
