import type { RequestPortBackground } from "@requestport/core";

/**
 * The exclusive runner the in-process worker is given on PGlite
 * (manifest-h.md §2.6 item 3; Done when 9).
 *
 * The worker runs each of its loops' and schedules' ticks only while its
 * runner holds the tick's key, and skips the tick when the runner answers
 * `{ acquired: false }`. Its default runner, `createAdvisoryExclusiveRunner`
 * (`@requestport/db`), holds a transaction open for the length of the tick to
 * keep a transaction-scoped advisory lock. PGlite has one connection, and
 * that transaction holds it, so a tick whose own queries go through the same
 * storage waits for a connection that its own runner holds: it never settles
 * (H.0's question 5 measured it; this module's test shows it again as its
 * control).
 *
 * A PGlite instance is one process (`requestport start` serves from it
 * alone, after its operator step has closed it), so a process-local lock is
 * the whole of the exclusion: a set of the keys whose ticks are running. A
 * tick whose key is held is skipped, never queued, as the advisory runner's
 * `pg_try_advisory_xact_lock` skips one, and the key is released when its
 * tick settles, whether it resolved or threw. The tick's queries run on the
 * storage as any other query does; the runner holds no connection.
 */
export type ExclusiveRunner = NonNullable<
  Extract<RequestPortBackground, { kind: "postgres" }>["runExclusive"]
>;

/** A process-local exclusive runner, for the worker on PGlite (above). */
export function createPgliteExclusiveRunner(): ExclusiveRunner {
  const held = new Set<string>();
  return async (key, run) => {
    if (held.has(key)) return { acquired: false };
    held.add(key);
    try {
      return { acquired: true, value: await run() };
    } finally {
      held.delete(key);
    }
  };
}
