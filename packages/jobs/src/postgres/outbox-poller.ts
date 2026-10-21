import type {
  ClaimedOutbox,
  ClaimLease,
  createOutboxRepository,
} from "@requestport/db";

import { timedOut, within } from "./within.js";

/**
 * The claim and the release, on the dispatcher's storage (manifest-i2.md
 * §5.1; track-i2.md, "I.2b design" §3): functions 1 and 3.
 */
export type OutboxPollerRepository = Pick<
  ReturnType<typeof createOutboxRepository>,
  "claimBatch" | "releaseClaim"
>;

export type OutboxPollerEvent =
  | {
      type: "outbox.retry_scheduled";
      outboxId: string;
      attempt: number;
      delayMs: number;
    }
  | { type: "outbox.attempts_exhausted"; outboxId: string; attempt: number }
  | { type: "outbox.routing_timed_out"; outboxId: string; timeoutMs: number }
  | { type: "outbox.release_refused"; outboxId: string; attempt: number };

/** The settlement a poller hands the body it starts: its claim's lease. */
export type LeaseSettlement = { kind: "lease"; leaseId: string };

export type OutboxPollerOptions = {
  repository: OutboxPollerRepository;
  /**
   * Routes one claimed row, completing or dead-lettering it itself under
   * `settlement`, the lease this poller's claim returned.
   */
  deliver: (outboxId: string, settlement: LeaseSettlement) => Promise<unknown>;
  batchSize: number;
  /** The lease each claim asks for; function 1 clamps it to 10-600 s. */
  leaseMs: number;
  jobTimeoutMs: number;
  /** The attempt that is dead-lettered when it fails. */
  maxAttempts?: number;
  onEvent?: (event: OutboxPollerEvent) => void;
};

export type OutboxDrainReport = {
  claimed: number;
  routed: number;
  retried: number;
  deadLettered: number;
  timedOut: number;
  /** Releases refused because the lease had run out: the row is claimed again when due. */
  releaseRefused: number;
};

/**
 * The outbox-delivery task's Trigger.dev retry policy, as a delay before the
 * given attempt's retry: a second, doubling, at most a minute. Trigger.dev
 * also randomised it; one worker draining one table has no herd to spread.
 */
export function outboxRetryDelayMs(attempt: number) {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Drains the outbox without Trigger.dev: claims through function 1, which
 * leases each row under a lease id the database generates, and releases a
 * failed row through function 3, under that lease.
 *
 * One drain claims up to `batchSize` rows under `leaseMs` and routes them all
 * at once, so every row starts inside its lease. Routing settles the row
 * itself, under the claim's lease. When it throws, the row goes back with the
 * outbox-delivery task's backoff, or to the dead letter on its fifth attempt,
 * the task's `maxAttempts` — each only while the lease still holds; after it
 * has run out, the release changes nothing and the row is claimed again when
 * due. When routing overruns `jobTimeoutMs` the row is left alone: its lease
 * still holds (the timing rule makes sure of that), and a body that outlives
 * the lease cannot settle the row, which another claim may hold by then
 * (manifest-i2.md §5.1 "Settlement").
 */
export function createOutboxPoller(options: OutboxPollerOptions) {
  const maxAttempts = options.maxAttempts ?? 5;
  const emit = options.onEvent ?? (() => undefined);
  const leaseSeconds = Math.ceil(options.leaseMs / 1_000);

  async function settle(
    row: ClaimedOutbox & ClaimLease,
    report: OutboxDrainReport,
  ) {
    try {
      const outcome = await within(
        options.deliver(row.id, { kind: "lease", leaseId: row.leaseId }),
        options.jobTimeoutMs,
      );
      if (outcome === timedOut) {
        report.timedOut += 1;
        emit({
          type: "outbox.routing_timed_out",
          outboxId: row.id,
          timeoutMs: options.jobTimeoutMs,
        });
        return;
      }
      report.routed += 1;
    } catch {
      const exhausted = row.attemptCount >= maxAttempts;
      const delayMs = outboxRetryDelayMs(row.attemptCount);
      const released = await options.repository.releaseClaim(
        row.id,
        row.leaseId,
        exhausted,
        delayMs,
      );
      if (!released) {
        report.releaseRefused += 1;
        emit({
          type: "outbox.release_refused",
          outboxId: row.id,
          attempt: row.attemptCount,
        });
        return;
      }
      if (exhausted) {
        report.deadLettered += 1;
        emit({
          type: "outbox.attempts_exhausted",
          outboxId: row.id,
          attempt: row.attemptCount,
        });
        return;
      }
      report.retried += 1;
      emit({
        type: "outbox.retry_scheduled",
        outboxId: row.id,
        attempt: row.attemptCount,
        delayMs,
      });
    }
  }

  return {
    async drainOnce(): Promise<OutboxDrainReport> {
      const claimed = await options.repository.claimBatch(
        options.batchSize,
        leaseSeconds,
      );
      const report: OutboxDrainReport = {
        claimed: claimed.length,
        routed: 0,
        retried: 0,
        deadLettered: 0,
        timedOut: 0,
        releaseRefused: 0,
      };
      await Promise.all(claimed.map((row) => settle(row, report)));
      return report;
    },
  };
}
