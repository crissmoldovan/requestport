/*
 * What the three settling bodies — outbox-delivery, legacy-import-analyze and
 * legacy-import-apply — do with their standing (Plan 13, Track I.2b, step b2;
 * manifest-i2.md §5.1 "Settlement"; ruling 59).
 *
 * Each reads `claimStanding` before any effect. `held` proceeds.
 * `pending_acceptance` — a Trigger.dev run that started before its
 * dispatcher recorded its run id — throws `SettlementPendingError`, which
 * Trigger.dev's retry policy answers by running the same run again, with the
 * same `ctx.run.id`. `superseded` returns `{ status: "superseded" }` and does
 * nothing. A settlement refused after the effects is logged as
 * `<kind>.settlement_refused` and also returns `superseded`, without
 * throwing: the effects happened, so a retry would only repeat them, and the
 * claim that now holds the row settles it.
 */

/** The retryable refusal: the run's acceptance is not recorded yet. */
export class SettlementPendingError extends Error {
  readonly code = "settlement_pending_acceptance";

  constructor() {
    super("settlement_pending_acceptance");
    this.name = "SettlementPendingError";
  }
}

/** The answer of a body that did nothing, or whose settlement was refused. */
export const superseded = () => ({ status: "superseded" as const });
