import { randomUUID } from "node:crypto";

import { isSettledJobName, type JobHandlers } from "../catalogue.js";
import type {
  EnqueueOptions,
  JobName,
  JobPayloads,
  JobRunner,
} from "../port.js";

export type RunnerEvent =
  | { type: "job.failed"; job: JobName; id: string; errorMessage: string }
  | { type: "job.timed_out"; job: JobName; id: string; timeoutMs: number }
  | { type: "job.deferred"; job: JobName; reason: "draining" | "queue_full" }
  | { type: "job.duplicate"; job: JobName; id: string };

export type PostgresJobRunnerOptions = {
  /** How many jobs may run at once in this process. */
  concurrency: number;
  /**
   * How long the runner waits for one job before it stops counting it and
   * frees its slot. JavaScript cannot stop an async function, so a job that
   * outlives this keeps running; the timeout bounds what it can hold up, and
   * `timing.ts` keeps it shorter than every lease a job runs under.
   */
  jobTimeoutMs: number;
  /**
   * The most jobs that may wait for a slot. Past it a job is deferred to the
   * repair schedules, like one enqueued while draining.
   */
  maxQueued?: number;
  onEvent?: (event: RunnerEvent) => void;
};

type Queued = {
  id: string;
  name: JobName;
  payload: unknown;
  key: string | undefined;
};

/**
 * The job-runner port, answered in this process.
 *
 * There is no queue table: Track C adds no migration. What makes that safe is
 * that every job this runner starts already has durable state of its own — a
 * notification intent, a webhook delivery, a Slack operation, an import
 * dispatch — with a repair schedule that finds it again when it is due and
 * nobody holds it. So `enqueue` is a start-it-now, and anything this process
 * fails to finish, or never starts because it was stopping or full, is picked
 * up by those schedules rather than lost. Nothing is retried here; a failed
 * job has already recorded when it may be tried again.
 *
 * It refuses the three settled jobs — `outbox-delivery` and the two import
 * jobs (`settledJobNames`, manifest-i2.md §5.1): each settles under the
 * claim that started it, and a job started here would have none. Only the
 * pollers start them, each with its claim's lease. Nothing enqueued them
 * here before the refusal either.
 */
export function createPostgresJobRunner(options: PostgresJobRunnerOptions) {
  const maxQueued = options.maxQueued ?? 1_000;
  const emit = options.onEvent ?? (() => undefined);
  const queue: Queued[] = [];
  const keys = new Map<string, string>();
  const idle = new Set<() => void>();
  let handlers: JobHandlers | undefined;
  let running = 0;
  let accepting = true;

  function settleIfIdle() {
    if (running > 0 || queue.length > 0) return;
    for (const resolve of idle) resolve();
    idle.clear();
  }

  function start(job: Queued) {
    const handler = handlers?.[job.name] as
      | ((payload: unknown) => Promise<unknown>)
      | undefined;
    if (!handler) throw new Error(`No handler for job ${job.name}`);
    running += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      running -= 1;
      pump();
      settleIfIdle();
    };
    const timer = setTimeout(() => {
      emit({
        type: "job.timed_out",
        job: job.name,
        id: job.id,
        timeoutMs: options.jobTimeoutMs,
      });
      release();
    }, options.jobTimeoutMs);
    Promise.resolve()
      .then(() => handler(job.payload))
      .catch((error: unknown) => {
        emit({
          type: "job.failed",
          job: job.name,
          id: job.id,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        clearTimeout(timer);
        if (job.key !== undefined && keys.get(job.key) === job.id) {
          keys.delete(job.key);
        }
        release();
      });
  }

  function pump() {
    while (running < options.concurrency && queue.length > 0) {
      const next = queue.shift();
      if (next) start(next);
    }
  }

  const runner = {
    kind: "postgres" as const,

    /** Gives the runner the bodies it runs, which themselves need the runner. */
    bind(bound: JobHandlers) {
      handlers = bound;
    },

    async enqueue<N extends JobName>(
      name: N,
      payload: JobPayloads[N],
      enqueueOptions?: EnqueueOptions,
    ): Promise<{ id: string }> {
      if (!handlers) {
        throw new Error("The Postgres job runner has no handlers bound yet");
      }
      if (isSettledJobName(name)) {
        throw new Error(
          `The Postgres job runner does not start ${name}: it settles under the claim that starts it, and only a poller's claim does.`,
        );
      }
      if (!accepting || queue.length >= maxQueued) {
        emit({
          type: "job.deferred",
          job: name,
          reason: accepting ? "queue_full" : "draining",
        });
        return { id: `deferred:${randomUUID()}` };
      }
      const key = enqueueOptions?.idempotencyKey;
      const existing = key === undefined ? undefined : keys.get(key);
      if (existing !== undefined) {
        emit({ type: "job.duplicate", job: name, id: existing });
        return { id: existing };
      }
      const id = randomUUID();
      if (key !== undefined) keys.set(key, id);
      queue.push({ id, name, payload, key });
      pump();
      return { id };
    },

    sleep(seconds: number) {
      return new Promise<void>((resolve) => {
        setTimeout(resolve, seconds * 1_000);
      });
    },

    async waitBeforeRetry(_seconds: number) {},

    async dispatchOutbox(_outboxId: string, _organizationId: string) {
      return { accepted: false };
    },

    /** Start no more jobs; later enqueues are deferred to the repair schedules. */
    stopAccepting() {
      accepting = false;
      for (const dropped of queue.splice(0)) {
        emit({ type: "job.deferred", job: dropped.name, reason: "draining" });
      }
      keys.clear();
      settleIfIdle();
    },

    /**
     * Resolves `true` once nothing is running, or `false` if `deadlineMs`
     * passes first.
     */
    drain(deadlineMs: number): Promise<boolean> {
      if (running === 0 && queue.length === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          idle.delete(done);
          resolve(false);
        }, deadlineMs);
        idle.add(done);
      });
    },

    stats() {
      return { queued: queue.length, running };
    },
  } satisfies JobRunner & Record<string, unknown>;

  return runner;
}

export type PostgresJobRunner = ReturnType<typeof createPostgresJobRunner>;
