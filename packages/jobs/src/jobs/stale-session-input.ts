/**
 * The command input the work-session sweep hands the bus for one row.
 *
 * `mark_work_session_stale` has no reason, so its input has no `reason` key.
 * An `undefined` value would reach the bus's receipt hash
 * (`normalizedInputHash`), which refuses it as "Input must be JSON-safe", and
 * the sweep would throw on the first lease-expired live session it listed,
 * before it reached the grace sweep (Plan 13, X21; the same class as X18,
 * gotchas.md 2026-09-29).
 */
export type WorkSessionSweepCommand =
  | "mark_work_session_stale"
  | "abandon_work_session";

export function workSessionSweepInput(
  command: WorkSessionSweepCommand,
  row: { id: string; organizationId: string },
) {
  return {
    organizationId: row.organizationId,
    workSessionId: row.id,
    ...(command === "abandon_work_session"
      ? { reason: "Work-session grace period expired" }
      : {}),
  };
}
