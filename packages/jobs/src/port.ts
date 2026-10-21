import type { JobRunnerKind } from "./selection.js";

/**
 * Every job one job may ask a runner to start, and the payload each takes.
 *
 * The names are Trigger.dev's task ids, unchanged, so the Trigger adapter
 * passes them straight through and a run in Trigger.dev's dashboard still
 * names the task it always did.
 */
export type JobPayloads = {
  "outbox-delivery": { outboxId: string };
  "webhook-delivery": { deliveryId: string };
  "email-delivery": { intentId: string };
  "slack-question-delivery": { intentId: string };
  "slack-message-update": { operationId: string };
  "slack-connection-test": { operationId: string };
  "legacy-import-analyze": { dispatchId: string; attemptCount: number };
  "legacy-import-apply": { dispatchId: string; attemptCount: number };
};

export type JobName = keyof JobPayloads;

export const jobNames = [
  "outbox-delivery",
  "webhook-delivery",
  "email-delivery",
  "slack-question-delivery",
  "slack-message-update",
  "slack-connection-test",
  "legacy-import-analyze",
  "legacy-import-apply",
] as const satisfies readonly JobName[];

export type EnqueueOptions = {
  /**
   * Starts the job at most once for this key. Trigger.dev scopes the key
   * globally and keeps it for 30 days, which is what every keyed call made
   * before this port existed. The Postgres runner holds it only while a job
   * with that key is queued or running in this process; after that, the
   * claim each job takes in its own table is what prevents a repeat.
   */
  idempotencyKey?: string;
};

/**
 * What a job body may ask of whatever is running it.
 *
 * The bodies in this package call nothing from `@trigger.dev/sdk`; each
 * capability they used from it is a method here, and each runner answers it
 * in its own way.
 */
export interface JobRunner {
  readonly kind: JobRunnerKind;

  /**
   * Start another job. Resolves once the runner has accepted it, not when
   * it finishes, and says how the runner will know it again.
   */
  enqueue<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    options?: EnqueueOptions,
  ): Promise<{ id: string }>;

  /**
   * A pause the job needs before it can continue, such as a provider's
   * `Retry-After`. It must actually elapse: Trigger.dev checkpoints the run
   * and resumes it; the Postgres runner waits in the process.
   */
  sleep(seconds: number): Promise<void>;

  /**
   * The pause before a job that is about to throw a retryable failure. Under
   * Trigger.dev the run waits and then its retry policy takes over. The
   * Postgres runner does not retry in-process — the job's own table records
   * when it may be tried again and a repair schedule picks it up — so this
   * resolves at once there.
   */
  waitBeforeRetry(seconds: number): Promise<void>;

  /**
   * Hand a committed outbox row of `organizationId` to whatever delivers it.
   * Trigger.dev claims the row, in a processing unit bound to that
   * organisation, and starts `outbox-delivery`; the Postgres runner leaves
   * it pending for its outbox poller, which claims it on its next tick.
   */
  dispatchOutbox(
    outboxId: string,
    organizationId: string,
  ): Promise<{ accepted: boolean }>;
}
