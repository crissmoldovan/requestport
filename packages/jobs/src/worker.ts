import {
  type createImportTaskDispatchRepository,
  WORKER_POOL_SIZES,
} from "@requestport/db";

import type { JobHandlers, ScheduleDefinition } from "./catalogue.js";
import type { JobRunner } from "./port.js";
import { createImportDispatchPoller } from "./postgres/import-dispatch-poller.js";
import {
  createOutboxPoller,
  type OutboxPollerRepository,
} from "./postgres/outbox-poller.js";
import { createPostgresJobRunner } from "./postgres/runner.js";
import { createScheduler, type ExclusiveRunner } from "./scheduler.js";
import {
  defaultWorkerTiming,
  timingViolations,
  type WorkerTiming,
} from "./timing.js";

/**
 * This worker's pools, with the three worker variables set (track-i2.md,
 * "I.2b design" §5): its three loops each hold an advisory transaction on
 * the dispatcher's pool for a whole tick, and one more connection serves the
 * claims and discoveries inside them; the processor's and maintenance's are
 * the Trigger.dev figures. Unset, there is one pool, the default one.
 */
export const POSTGRES_WORKER_POOL_SIZES = Object.freeze({
  ...WORKER_POOL_SIZES,
  dispatcher: 4,
});

type LogFields = {
  taskId?: string;
  status?: string;
  errorCode?: string;
  count?: number;
  durationMs?: number;
  outboxId?: string;
  dispatchId?: string;
};

export type WorkerLogger = {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

/**
 * Everything the worker talks to, so a test can stand in for any of it. The
 * two repositories claim, and the exclusive runner locks, on the dispatcher's
 * storage (`cli.ts`); the bodies reach the processor's through
 * `worker-storages.ts`. Each claim's lease id is the database's
 * (manifest-i2.md §5.1), so the worker names no owner.
 */
export type JobWorkerDependencies = {
  outboxRepository: OutboxPollerRepository;
  importTaskDispatchRepository: Pick<
    ReturnType<typeof createImportTaskDispatchRepository>,
    "claimBatch"
  >;
  createHandlers: (runner: JobRunner) => JobHandlers;
  schedules: readonly ScheduleDefinition[];
  runExclusive: ExclusiveRunner;
  logger: WorkerLogger;
};

export type JobWorkerOptions = {
  timing?: WorkerTiming;
  /** Email, Slack and webhook jobs running at once. */
  concurrency?: number;
  /** Outbox rows claimed, and routed at once, per tick. */
  outboxBatchSize?: number;
  /** Import dispatches claimed, and run at once, per tick. */
  importBatchSize?: number;
  /** How often the schedules are checked; they fire on whole minutes. */
  scheduleTickMs?: number;
  clock?: () => Date;
};

/**
 * A code for the log that cannot carry an error's text: the message of a
 * database or provider error may hold a connection string or an address.
 */
function errorCode(error: string, fallback: string) {
  return /^[a-z][a-z0-9_]{0,79}$/u.test(error) ? error : fallback;
}

/**
 * The Postgres job worker: three loops and an in-process runner.
 *
 * - **outbox** drains the outbox, routing every claimed row at once.
 * - **imports** runs queued import analyses and applications. It is its own
 *   loop so that an application, which may take minutes, never holds up
 *   delivery.
 * - **schedules** runs the shared catalogue: run-on-start, coalescing.
 *
 * Each outbox and import tick, and each schedule run, holds its own
 * `pg_try_advisory_xact_lock` for its length, so several workers can run
 * against one database and take turns rather than collide. That costs one
 * idle pooled connection per loop while its tick runs. With the defaults
 * below, at most three locks, three routings, one import and two children
 * are in flight at once. With the three worker variables set, the locks and
 * claims are on the dispatcher's pool (four connections) and the bodies on
 * the processor's (ten; track-i2.md, "I.2b design" §5); unset, all of it
 * shares the one default pool of ten, as before. A query that finds its
 * pool full waits for a connection rather than failing.
 *
 * Ready means the first outbox tick has reached the database. A tick that
 * fails is logged and tried again after `tickMs`; the process does not exit
 * for it, so a database that comes up after the worker is simply waited for.
 */
export function startJobWorker(
  deps: JobWorkerDependencies,
  options: JobWorkerOptions = {},
) {
  const timing = options.timing ?? defaultWorkerTiming;
  const violations = timingViolations(timing);
  if (violations.length > 0) {
    throw new Error(
      `The job worker's timing is unsafe:\n- ${violations.join("\n- ")}`,
    );
  }

  const { logger } = deps;
  const runner = createPostgresJobRunner({
    concurrency: options.concurrency ?? 2,
    jobTimeoutMs: timing.childJobTimeoutMs,
    onEvent: (event) => {
      if (event.type === "job.failed") {
        logger.warn("job.failed", {
          taskId: event.job,
          errorCode: errorCode(event.errorMessage, "job_failed"),
        });
      } else if (event.type === "job.timed_out") {
        logger.warn("job.timed_out", {
          taskId: event.job,
          durationMs: event.timeoutMs,
        });
      } else if (event.type === "job.deferred") {
        logger.info("job.deferred", {
          taskId: event.job,
          status: event.reason,
        });
      }
    },
  });
  const handlers = deps.createHandlers(runner);
  runner.bind(handlers);

  const outboxPoller = createOutboxPoller({
    repository: deps.outboxRepository,
    deliver: (outboxId, settlement) =>
      handlers["outbox-delivery"]({ outboxId }, settlement),
    batchSize: options.outboxBatchSize ?? 3,
    leaseMs: timing.outboxLeaseMs,
    jobTimeoutMs: timing.outboxJobTimeoutMs,
    onEvent: (event) => {
      if (event.type === "outbox.routing_timed_out") {
        logger.warn("outbox.routing_timed_out", {
          outboxId: event.outboxId,
          durationMs: event.timeoutMs,
        });
      } else if (event.type === "outbox.attempts_exhausted") {
        logger.warn("outbox.dead_letter", {
          outboxId: event.outboxId,
          count: event.attempt,
          status: "dead_letter",
        });
      } else if (event.type === "outbox.release_refused") {
        logger.warn("outbox.release_refused", {
          outboxId: event.outboxId,
          count: event.attempt,
          status: "lease_expired",
        });
      } else {
        logger.info("outbox.retry_scheduled", {
          outboxId: event.outboxId,
          count: event.attempt,
          durationMs: event.delayMs,
        });
      }
    },
  });
  const importPoller = createImportDispatchPoller({
    repository: deps.importTaskDispatchRepository,
    handlers,
    batchSize: options.importBatchSize ?? 1,
    leaseMs: timing.importLeaseMs,
    jobTimeoutMs: timing.importJobTimeoutMs,
    onEvent: (event) => {
      logger.warn(event.type, {
        dispatchId: event.dispatchId,
        errorCode:
          event.type === "import.dispatch_failed"
            ? errorCode(event.errorMessage, "import_failed")
            : "import_timed_out",
      });
    },
  });
  const scheduler = createScheduler({
    schedules: deps.schedules.map((definition) => ({
      id: definition.id,
      cron: definition.cron,
      run: () => definition.run(runner),
    })),
    clock: options.clock ?? (() => new Date()),
    runExclusive: deps.runExclusive,
  });

  let stopping = false;
  const sleepers = new Set<() => void>();
  function pause(ms: number) {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });
  }

  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  async function loop(
    name: string,
    intervalMs: number,
    tick: () => Promise<void>,
  ) {
    while (!stopping) {
      try {
        await tick();
      } catch {
        logger.warn("worker.tick_failed", {
          taskId: name,
          errorCode: "tick_failed",
        });
      }
      if (stopping) break;
      await pause(intervalMs);
    }
  }

  const loops = [
    loop("outbox", timing.tickMs, async () => {
      const result = await deps.runExclusive("outbox", () =>
        outboxPoller.drainOnce(),
      );
      markReady();
      if (result.acquired && result.value.claimed > 0) {
        logger.info("outbox.drained", {
          count: result.value.claimed,
          status: "drained",
        });
      }
    }),
    loop("imports", timing.tickMs, async () => {
      await deps.runExclusive("imports", () => importPoller.drainOnce());
    }),
    loop("schedules", options.scheduleTickMs ?? 15_000, async () => {
      for (const outcome of await scheduler.tick()) {
        if (outcome.outcome === "failed") {
          logger.warn("schedule.failed", {
            taskId: outcome.id,
            errorCode: "schedule_failed",
          });
        }
      }
    }),
  ];

  void ready.then(() => {
    logger.info("worker.ready", { status: "ready" });
  });

  return {
    ready,

    /**
     * Stop claiming, stop starting children, and wait up to `drainMs` for
     * what is already running. Resolves `drained: false` if the deadline
     * passed first; the leases on anything still held then expire on their
     * own and another worker, or this one restarted, picks the rows up.
     */
    async stop(): Promise<{ drained: boolean }> {
      stopping = true;
      for (const wake of [...sleepers]) wake();
      runner.stopAccepting();
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        Promise.all(loops).then(() =>
          runner.drain(Math.max(0, timing.drainMs - (Date.now() - started))),
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timing.drainMs);
        }),
      ]);
      clearTimeout(timer);
      logger.info("worker.stopped", {
        status: drained ? "drained" : "drain_timed_out",
        durationMs: Date.now() - started,
      });
      return { drained };
    },
  };
}

export type JobWorker = ReturnType<typeof startJobWorker>;
