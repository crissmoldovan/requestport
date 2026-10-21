import "./database-surface.js";

import { deliverOutboxEvent as routeOutboxEvent } from "@requestport/jobs";
import { task } from "@trigger.dev/sdk";

import { triggerJobRunner } from "./job-runner.js";

/**
 * The routing body the `outbox-delivery` task runs, bound to Trigger.dev and
 * settling under `runId`, the executing run's own id, which its dispatcher
 * recorded at acceptance (manifest-i2.md §5.1 "Settlement").
 */
export const deliverOutboxEvent = (outboxId: string, runId: string) =>
  routeOutboxEvent(outboxId, triggerJobRunner, { kind: "trigger_run", runId });

export const outboxDelivery = task({
  id: "outbox-delivery",
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
    randomize: true,
  },
  run: ({ outboxId }: { outboxId: string }, { ctx }) =>
    deliverOutboxEvent(outboxId, ctx.run.id),
});
