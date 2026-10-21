import { DomainError } from "../shared/errors.js";
import type { WorkSessionState } from "./work-types.js";

const transitions: Record<WorkSessionState, ReadonlySet<WorkSessionState>> = {
  claimed: new Set(["active", "stale", "ended"]),
  active: new Set(["paused", "blocked", "stale", "ended"]),
  paused: new Set(["active", "blocked", "stale", "ended"]),
  blocked: new Set(["active", "paused", "stale", "ended"]),
  stale: new Set(["abandoned"]),
  abandoned: new Set(),
  ended: new Set(),
};

export function assertWorkTransition(
  from: WorkSessionState,
  to: WorkSessionState,
) {
  if (!transitions[from].has(to)) {
    throw new DomainError(
      "invalid_transition",
      `Work session cannot transition from ${from} to ${to}`,
    );
  }
}

export function boundedLeasePolicy(input?: {
  heartbeatIntervalSeconds?: number;
  leaseMultiplier?: number;
  graceSeconds?: number;
}) {
  const heartbeatIntervalSeconds = Math.min(
    300,
    Math.max(10, input?.heartbeatIntervalSeconds ?? 30),
  );
  const leaseMultiplier = Math.min(
    10,
    Math.max(2, input?.leaseMultiplier ?? 3),
  );
  const graceSeconds = Math.min(
    24 * 60 * 60,
    Math.max(60, input?.graceSeconds ?? 15 * 60),
  );
  return { heartbeatIntervalSeconds, leaseMultiplier, graceSeconds };
}

export function leaseTimes(
  now: Date,
  policy: ReturnType<typeof boundedLeasePolicy>,
) {
  const leaseExpiresAt = new Date(
    now.getTime() +
      policy.heartbeatIntervalSeconds * policy.leaseMultiplier * 1_000,
  );
  return {
    leaseExpiresAt,
    graceExpiresAt: new Date(
      leaseExpiresAt.getTime() + policy.graceSeconds * 1_000,
    ),
  };
}
