import { createLogger } from "@requestport/config";
import {
  createBackgroundPort,
  type RequestPortBackground,
} from "@requestport/core";
import {
  boundImportTaskDispatchRepository,
  boundOutboxRepository,
} from "@requestport/db";
import type { StartTriggerTask } from "@requestport/jobs/dispatch";
import { resolveJobRunnerKind } from "@requestport/jobs/selection";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { webStorage } from "./server-request-port.js";

const logger = createLogger({
  service: "web-trigger-client",
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
});

/**
 * Starts a Trigger.dev task the way this file always has: a keyed start is
 * scoped globally and its key kept for 30 days.
 */
const startTriggerTask: StartTriggerTask = async (taskId, payload, options) => {
  const handle =
    options === undefined
      ? await tasks.trigger(taskId, payload)
      : await tasks.trigger(taskId, payload, {
          idempotencyKey: await idempotencyKeys.create(options.idempotencyKey, {
            scope: "global",
          }),
          idempotencyKeyTTL: "30d",
        });
  return { id: handle.id };
};

/**
 * Background work from the web application goes to the runner
 * `REQUESTPORT_JOB_RUNNER` selects, read on every call: Trigger.dev when it is
 * unset, as in production; the `requestport-jobs` worker when it is
 * `postgres`, to which core's background of kind `none` defers. A value this
 * process cannot honour — neither runner, or `postgres` wherever `VERCEL_ENV`
 * is set — is refused at boot by `src/instrumentation.ts`, so it does not
 * reach a dispatch.
 */
function webBackground(): RequestPortBackground {
  return resolveJobRunnerKind(process.env) === "postgres"
    ? { kind: "none" }
    : { kind: "trigger", startTask: startTriggerTask };
}

/**
 * Core's background port (Plan 13, G.6; `@requestport/core`), which runs
 * `createJobDispatch` (`packages/jobs/src/dispatch.ts`, where what each
 * function does under each runner is stated and tested). It is built as this
 * module loads and asks for nothing then: each committed row's repositories
 * are built over the web root's storage when a dispatch runs (Plan 13, G.3),
 * bound to the row's organisation (manifest-i2.md §2.4; track-i2.md D5), and
 * a direct start reads no row. It is the process's one background port:
 * `server-web-request-port.ts` hands the web's RequestPort these functions as
 * its background port (`backgroundPort`), so the bus core composes, and the
 * capabilities it runs, dispatch through them too (ruling 137).
 */
const background = createBackgroundPort({
  background: webBackground,
  committedRows: {
    outbox(organizationId) {
      const storage = webStorage();
      return boundOutboxRepository(organizationId, storage.db);
    },
    importTaskDispatches(organizationId) {
      const storage = webStorage();
      return boundImportTaskDispatchRepository(organizationId, storage.db);
    },
  },
  logger,
});

export function triggerNotificationDelivery(
  intentId: string,
  channel: "email" | "slack",
) {
  return background.triggerNotificationDelivery(intentId, channel);
}

export function triggerSlackConnectionTest(operationId: string) {
  return background.triggerSlackConnectionTest(operationId);
}

export function triggerSlackMessageUpdate(operationId: string) {
  return background.triggerSlackMessageUpdate(operationId);
}

export function triggerWebhookDelivery(deliveryId: string) {
  return background.triggerWebhookDelivery(deliveryId);
}

/** Hands a committed outbox row of `organizationId` to the selected runner. */
export function dispatchCommittedOutbox(
  outboxId: string,
  organizationId: string,
) {
  return background.dispatchCommittedOutbox(outboxId, organizationId);
}

/** Hands a committed import dispatch of `organizationId` to the selected runner. */
export function dispatchImportTask(dispatchId: string, organizationId: string) {
  return background.dispatchImportTask(dispatchId, organizationId);
}

/**
 * Dispatches the outbox rows a command's events committed. Each
 * organisation's events are read, and their rows dispatched, bound to that
 * organisation (D5). D5 says one command's events share one organisation;
 * this does not rely on it. No events: nothing is read. A failed dispatch is
 * swallowed — the rows are committed, and the repair sweep is the durable
 * fallback — but a failed read is not.
 */
export function dispatchCommittedEvents(
  events: readonly { id: string; organizationId: string }[],
) {
  return background.dispatchCommittedEvents(events);
}

/**
 * Dispatches the outbox rows committed under `correlationId`, read and
 * dispatched bound to `organizationId`, the organisation the command
 * committed in (D5). Failed dispatches are swallowed, as above.
 */
export function dispatchCommittedCorrelation(
  correlationId: string,
  organizationId: string,
) {
  return background.dispatchCommittedCorrelation(correlationId, organizationId);
}
