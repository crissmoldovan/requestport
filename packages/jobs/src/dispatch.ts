import { randomUUID } from "node:crypto";

import type { ClaimedImportTaskDispatch, ClaimedOutbox } from "@requestport/db";

import type { JobName, JobPayloads } from "./port.js";
import type { JobRunnerKind } from "./selection.js";

/**
 * Starts a Trigger.dev task. The web application supplies it, because this
 * package does not depend on `@trigger.dev/sdk`; a keyed start must be scoped
 * globally and kept for 30 days, which is what the web application has always
 * asked for.
 */
export type StartTriggerTask = <N extends JobName>(
  taskId: N,
  payload: JobPayloads[N],
  options?: { idempotencyKey: string },
) => Promise<{ id: string }>;

type DispatchLogFields = {
  outboxId?: string;
  dispatchId?: string;
  runId?: string;
  status?: string;
  taskKind?: string;
  errorCode?: string;
};

export type JobDispatchDependencies = {
  /** Asked on every call, so the answer follows the environment. */
  kind: () => JobRunnerKind;
  startTriggerTask: StartTriggerTask;
  /**
   * `markAccepted` answers whether the acceptance held: it is refused once
   * the claim's lease has run out (manifest-i2.md §5.1, `markAccepted` by id).
   */
  outboxRepository: {
    claimOne(id: string, owner: string): Promise<ClaimedOutbox | null>;
    markAccepted(id: string, owner: string, runId: string): Promise<boolean>;
  };
  importTaskDispatchRepository: {
    claimOne(
      id: string,
      owner: string,
    ): Promise<ClaimedImportTaskDispatch | null>;
    markAccepted(id: string, owner: string, runId: string): Promise<boolean>;
  };
  logger: {
    info(event: string, fields: DispatchLogFields): void;
    warn(event: string, fields: DispatchLogFields): void;
  };
};

/**
 * What a caller receives when the Postgres worker is selected and it asked to
 * start a job directly. The row the job works from is already committed, and
 * the worker's repair schedule starts it when it is due.
 *
 * Every caller in `apps/web` (2026-09-27: the operations, webhook and Slack
 * actions, the Slack interactions route and the MCP route) already catches a
 * failed start and relies on that committed row, so a refusal takes the path
 * they were written for. The actions tell their user the row is durable and
 * will be retried; the two routes say nothing.
 */
export class JobDeferredToWorkerError extends Error {
  readonly code = "job_deferred_to_worker";

  constructor(readonly job: JobName) {
    super("job_deferred_to_worker");
    this.name = "JobDeferredToWorkerError";
  }
}

/**
 * The web application's side of background work: hand committed rows to
 * whichever runner `REQUESTPORT_JOB_RUNNER` selects.
 *
 * With Trigger.dev (the default, and production), every function does exactly
 * what `apps/web/src/lib/trigger-client.ts` did before it delegated here: the
 * same claims, owners, task ids, idempotency keys, run records and log lines,
 * with one addition since I.2b's b2: an acceptance the repository refuses,
 * because the claim's lease ran out, is logged as `*.acceptance_refused` and
 * answered as not accepted, where it used to be recorded regardless.
 *
 * With the Postgres worker, nothing here claims anything. A claim would lease
 * the row to a web request that is never going to deliver it and hide it from
 * the worker until the lease ran out. The rows are left as committed, and the
 * worker's pollers and repair schedules find them.
 */
export function createJobDispatch(deps: JobDispatchDependencies) {
  const { logger } = deps;

  function startDirectly<N extends JobName>(name: N, payload: JobPayloads[N]) {
    if (deps.kind() === "postgres") {
      return Promise.reject(new JobDeferredToWorkerError(name));
    }
    return deps.startTriggerTask(name, payload);
  }

  return {
    async dispatchCommittedOutbox(outboxId: string) {
      if (deps.kind() === "postgres") return { accepted: false as const };
      const owner = `web:${randomUUID()}`;
      const claimed = await deps.outboxRepository.claimOne(outboxId, owner);
      if (!claimed) return { accepted: false as const };
      try {
        const handle = await deps.startTriggerTask(
          "outbox-delivery",
          { outboxId },
          { idempotencyKey: `outbox:${outboxId}:${claimed.attemptCount}` },
        );
        const accepted = await deps.outboxRepository.markAccepted(
          outboxId,
          owner,
          handle.id,
        );
        if (!accepted) {
          // The lease ran out before the acceptance: the run cannot settle
          // this row, and the row is claimed again when due.
          logger.warn("outbox.acceptance_refused", {
            outboxId,
            runId: handle.id,
            status: "lease_expired",
          });
          return { accepted: false as const };
        }
        logger.info("outbox.accepted", {
          outboxId,
          runId: handle.id,
          status: "accepted",
        });
        return { accepted: true as const, runId: handle.id };
      } catch {
        logger.warn("outbox.dispatch_failed", {
          outboxId,
          status: "failed",
          errorCode: "trigger_dispatch_failed",
        });
        return { accepted: false as const };
      }
    },

    triggerWebhookDelivery(deliveryId: string) {
      return startDirectly("webhook-delivery", { deliveryId });
    },

    triggerSlackMessageUpdate(operationId: string) {
      return startDirectly("slack-message-update", { operationId });
    },

    triggerSlackConnectionTest(operationId: string) {
      return startDirectly("slack-connection-test", { operationId });
    },

    triggerNotificationDelivery(intentId: string, channel: "email" | "slack") {
      return channel === "email"
        ? startDirectly("email-delivery", { intentId })
        : startDirectly("slack-question-delivery", { intentId });
    },

    async dispatchImportTask(dispatchId: string) {
      if (deps.kind() === "postgres") return { accepted: false as const };
      const owner = `web-import:${randomUUID()}`;
      const claimed = await deps.importTaskDispatchRepository.claimOne(
        dispatchId,
        owner,
      );
      if (!claimed) return { accepted: false as const };
      try {
        const payload = {
          dispatchId: claimed.id,
          attemptCount: claimed.attemptCount,
        };
        const options = {
          idempotencyKey: `import-dispatch:${claimed.id}:${claimed.attemptCount}`,
        };
        const handle =
          claimed.taskKind === "analyze"
            ? await deps.startTriggerTask(
                "legacy-import-analyze",
                payload,
                options,
              )
            : await deps.startTriggerTask(
                "legacy-import-apply",
                payload,
                options,
              );
        const accepted = await deps.importTaskDispatchRepository.markAccepted(
          claimed.id,
          owner,
          handle.id,
        );
        if (!accepted) {
          // As the outbox's: the run cannot settle this dispatch, which is
          // claimed again when due.
          logger.warn("import.acceptance_refused", {
            dispatchId: claimed.id,
            runId: handle.id,
            status: "lease_expired",
            taskKind: claimed.taskKind,
          });
          return { accepted: false as const };
        }
        logger.info("import.dispatch_accepted", {
          dispatchId: claimed.id,
          runId: handle.id,
          status: "accepted",
          taskKind: claimed.taskKind,
        });
        return { accepted: true as const, runId: handle.id };
      } catch {
        logger.warn("import.dispatch_failed", {
          dispatchId: claimed.id,
          status: "failed",
          taskKind: claimed.taskKind,
          errorCode: "trigger_dispatch_failed",
        });
        return { accepted: false as const };
      }
    },
  };
}

export type JobDispatch = ReturnType<typeof createJobDispatch>;
