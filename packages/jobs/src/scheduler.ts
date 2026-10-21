import { nextCronFire, type ParsedCron, parseCron } from "./cron.js";

/**
 * One recurring job: an id, the cron it follows, and what it does.
 *
 * The same catalogue drives Trigger.dev's `schedules.task` definitions and the
 * Postgres worker, so the ids and crons cannot drift apart between runners.
 */
export type ScheduledJob = {
  id: string;
  cron: string;
  run: () => Promise<unknown>;
};

/**
 * Runs `run` only if this process holds the lock named by `key`, and says
 * whether it did. The Postgres worker's implementation is a
 * `pg_try_advisory_xact_lock` held for the length of the run, so two workers
 * never run the same schedule at once; neither waits for the other.
 */
export type ExclusiveRunner = <T>(
  key: string,
  run: () => Promise<T>,
) => Promise<{ acquired: true; value: T } | { acquired: false }>;

export type ScheduleOutcome = {
  id: string;
  outcome: "ran" | "failed" | "held_elsewhere";
  nextDueAt: Date;
  error?: unknown;
};

export type SchedulerOptions = {
  schedules: readonly ScheduledJob[];
  clock: () => Date;
  runExclusive: ExclusiveRunner;
  /**
   * How long to wait before retrying a failed run, one entry per retry. A
   * retry is never scheduled later than the schedule's next slot, which
   * would run it anyway; once the entries are used up the schedule waits for
   * that slot. Trigger.dev retries a failed scheduled run too (the project
   * default is four attempts), so a failure here is not simply dropped.
   */
  retryDelaysMs?: readonly number[];
};

type State = {
  job: ScheduledJob;
  cron: ParsedCron;
  nextDueAt: Date;
  failures: number;
};

/**
 * When each schedule next runs, and running the ones that are due.
 *
 * Three rules, each a decision about a host that is not always awake:
 *
 * - **Run on start.** Every schedule is due the moment the worker starts. A
 *   daily schedule whose slot falls while the host is off would otherwise
 *   never run on a machine that is off every night; retention is the one that
 *   matters.
 * - **Coalesce what was missed.** A due schedule runs once, however many slots
 *   went by, and its next slot is counted from when that run finished. A host
 *   waking from five hours' sleep sends one round of reminders, not twenty.
 * - **Idempotent bodies, not exactly-once runs.** Nothing here records that a
 *   slot ran — there is no table for it, by design (Track C adds no
 *   migration). Two workers starting a minute apart both run every schedule
 *   on start. What stops them running one *at the same time* is the exclusive
 *   runner; what makes the second run harmless is that every body in the
 *   catalogue is safe to repeat (deletes of what has expired, claims under a
 *   lease, idempotency keys, stage-keyed reminders).
 */
export function createScheduler(options: SchedulerOptions) {
  const retryDelaysMs = options.retryDelaysMs ?? [60_000, 5 * 60_000];
  const startedAt = options.clock();
  const states = new Map<string, State>();

  for (const job of options.schedules) {
    if (states.has(job.id)) {
      throw new Error(`duplicate schedule id ${JSON.stringify(job.id)}`);
    }
    states.set(job.id, {
      job,
      cron: parseCron(job.cron),
      nextDueAt: startedAt,
      failures: 0,
    });
  }

  let ticking = false;

  async function runOne(state: State): Promise<ScheduleOutcome> {
    const { job } = state;
    try {
      const result = await options.runExclusive(`schedule:${job.id}`, job.run);
      const finishedAt = options.clock();
      state.nextDueAt = nextCronFire(state.cron, finishedAt);
      state.failures = 0;
      return {
        id: job.id,
        outcome: result.acquired ? "ran" : "held_elsewhere",
        nextDueAt: state.nextDueAt,
      };
    } catch (error) {
      const failedAt = options.clock();
      const nextSlot = nextCronFire(state.cron, failedAt);
      const delay = retryDelaysMs[state.failures];
      state.failures += 1;
      if (delay === undefined) {
        state.failures = 0;
        state.nextDueAt = nextSlot;
      } else {
        const retryAt = new Date(failedAt.getTime() + delay);
        state.nextDueAt = retryAt < nextSlot ? retryAt : nextSlot;
      }
      return {
        id: job.id,
        outcome: "failed",
        nextDueAt: state.nextDueAt,
        error,
      };
    }
  }

  return {
    /**
     * Run every due schedule, one after another, and report each. A tick
     * asked for while the previous one is still running returns nothing: the
     * running tick will reach anything that falls due meanwhile.
     */
    async tick(): Promise<ScheduleOutcome[]> {
      if (ticking) return [];
      ticking = true;
      try {
        const outcomes: ScheduleOutcome[] = [];
        for (const state of states.values()) {
          if (options.clock() < state.nextDueAt) continue;
          outcomes.push(await runOne(state));
        }
        return outcomes;
      } finally {
        ticking = false;
      }
    },

    nextDueAt(id: string): Date | undefined {
      return states.get(id)?.nextDueAt;
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
