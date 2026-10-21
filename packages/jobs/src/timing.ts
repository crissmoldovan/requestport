/**
 * The Postgres worker's clocks, and the rule that keeps them honest.
 *
 * A claimed row is leased: until the lease runs out, no other claim can take
 * it. The worker waits a bounded time for the work it claimed (JavaScript
 * cannot stop an async function, so a job that overruns keeps running; the
 * worker only stops waiting for it). The rule is that **the lease outlives the
 * wait by at least one tick**: when a tick gives up on a slow job and ends, the
 * row is still leased to it, and the next tick — this worker's or any other's,
 * since ticks take the same advisory lock in turn — cannot claim it again
 * while it may still be running. A job that overruns by more than that margin
 * can be claimed and run a second time; every body here is written to survive
 * that (claims re-check state, deliveries are keyed), which is the backstop,
 * not the plan.
 */
export type WorkerTiming = {
  /** The pause between one delivery tick ending and the next starting. */
  tickMs: number;
  /** The lease on each claimed outbox row. */
  outboxLeaseMs: number;
  /** How long a tick waits for one outbox routing. */
  outboxJobTimeoutMs: number;
  /** The lease on each claimed import dispatch. */
  importLeaseMs: number;
  /** How long a tick waits for one import analysis or application. */
  importJobTimeoutMs: number;
  /** How long the in-process runner waits for an email, Slack or webhook job. */
  childJobTimeoutMs: number;
  /**
   * How long the worker waits, after SIGTERM, for the work it holds. Whatever
   * runs the worker must allow more than this between SIGTERM and SIGKILL:
   * Docker's default is 10 seconds and Kubernetes' 30.
   */
  drainMs: number;
};

/**
 * The shortest lease a child job runs under: Slack delivery operations are
 * leased for 10 minutes (`claimSlackDeliveryOperation`), and a webhook
 * attempt left `delivering` for 10 minutes is sent again by the repair
 * (`pendingWebhookDeliveries`). Notification intents are leased for 20.
 */
export const shortestChildLeaseMs = 10 * 60_000;

export const defaultWorkerTiming: WorkerTiming = {
  tickMs: 5_000,
  // `claimBatch`'s own default lease.
  outboxLeaseMs: 60_000,
  outboxJobTimeoutMs: 20_000,
  importLeaseMs: 10 * 60_000,
  // Trigger.dev gives each run up to 300 seconds (`maxDuration` in
  // trigger.config.ts); an import application is the longest job there is.
  importJobTimeoutMs: 5 * 60_000,
  childJobTimeoutMs: 5 * 60_000,
  drainMs: 25_000,
};

export function timingViolations(timing: WorkerTiming): string[] {
  const violations: string[] = [];

  for (const [name, value] of Object.entries(timing)) {
    if (!Number.isInteger(value) || value <= 0) {
      violations.push(
        `${name} must be a positive whole number of milliseconds`,
      );
    }
  }
  if (violations.length > 0) return violations;

  const outlives = (timeout: keyof WorkerTiming, lease: keyof WorkerTiming) => {
    if (timing[timeout] + timing.tickMs < timing[lease]) return;
    violations.push(
      `${timeout} (${timing[timeout]}) + tickMs (${timing.tickMs}) must be less than ${lease} (${timing[lease]}), or a row may be claimed again while its first claim is still working on it`,
    );
  };
  outlives("outboxJobTimeoutMs", "outboxLeaseMs");
  outlives("importJobTimeoutMs", "importLeaseMs");

  // The pollers ask the database for their lease in whole seconds, rounded
  // up, and functions 1 and 4 clamp it (manifest-i2.md §5.1). A lease outside
  // those bounds would be granted as the bound, not as configured, and the
  // rule above would be checked against a lease the rows never get.
  const clamped = (
    lease: keyof WorkerTiming,
    minSeconds: number,
    maxSeconds: number,
    fn: string,
  ) => {
    const seconds = Math.ceil(timing[lease] / 1_000);
    if (seconds >= minSeconds && seconds <= maxSeconds) return;
    violations.push(
      `${lease} (${timing[lease]}) must be ${minSeconds * 1_000}-${maxSeconds * 1_000} ms, the lease ${fn} grants; outside it the database clamps the lease`,
    );
  };
  clamped("outboxLeaseMs", 10, 600, "claim_outbox_batch (function 1)");
  clamped(
    "importLeaseMs",
    60,
    1_800,
    "claim_import_dispatch_batch (function 4)",
  );

  if (timing.childJobTimeoutMs >= shortestChildLeaseMs) {
    violations.push(
      `childJobTimeoutMs (${timing.childJobTimeoutMs}) must be less than ${shortestChildLeaseMs}, the shortest lease a child job runs under`,
    );
  }
  if (timing.drainMs < timing.outboxJobTimeoutMs) {
    violations.push(
      `drainMs (${timing.drainMs}) must be at least outboxJobTimeoutMs (${timing.outboxJobTimeoutMs}), so a SIGTERM does not abandon a routing it could have finished`,
    );
  }

  return violations;
}
