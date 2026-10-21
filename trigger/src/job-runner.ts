import type { JobRunner } from "@requestport/jobs";
import { idempotencyKeys, tasks, wait } from "@trigger.dev/sdk";

import { dispatchCommittedOutbox } from "./outbox-dispatcher.js";

/**
 * The job-runner port, answered by Trigger.dev.
 *
 * Every call here is the one the task bodies made before they moved to
 * `@requestport/jobs`: `tasks.trigger(id, …)` is what `someTask.trigger(…)`
 * calls underneath (the SDK adds only `queue: params.queue?.name`, and no
 * task here names a queue); a keyed start is scoped globally and kept for 30
 * days; both pauses are Trigger.dev's checkpointed `wait.for`. The
 * `task-surface` test pins the resulting calls.
 */
export const triggerJobRunner: JobRunner = {
  kind: "trigger",

  async enqueue(name, payload, options) {
    const handle =
      options?.idempotencyKey === undefined
        ? await tasks.trigger(name, payload)
        : await tasks.trigger(name, payload, {
            idempotencyKey: await idempotencyKeys.create(
              options.idempotencyKey,
              { scope: "global" },
            ),
            idempotencyKeyTTL: "30d",
          });
    return { id: handle.id };
  },

  async sleep(seconds) {
    await wait.for({ seconds });
  },

  async waitBeforeRetry(seconds) {
    await wait.for({ seconds });
  },

  dispatchOutbox: (outboxId, organizationId) =>
    dispatchCommittedOutbox(outboxId, organizationId),
};
