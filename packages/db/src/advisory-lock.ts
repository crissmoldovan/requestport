import { sql } from "drizzle-orm";

import type { Database } from "./client.js";

/*
 * The per-tick lock of the Postgres job worker in packages/jobs.
 *
 * It lives here, not beside the worker, because it runs a query: the
 * tenant-scope sweep (tenant-scope-sweep.test.ts) reads every query in this
 * package, and its boundary test fails any file outside it that imports a
 * database driver or hands the `db` handle to something the package did not
 * export. Moved from packages/jobs/src/advisory-lock.ts on 2026-09-28, with the
 * namespace, the key function and the behaviour unchanged.
 */

/**
 * The first half of every advisory lock the worker takes: "RPJB" as a
 * 32-bit integer. PostgreSQL's two-key advisory locks live in their own space
 * per first key, so this keeps the worker's locks clear of any other
 * application sharing the database that uses single-key locks, or a
 * different first key.
 */
export const advisoryLockNamespace = 0x52504a42;

/**
 * A stable signed 32-bit key for a lock name (FNV-1a over its UTF-8 bytes).
 *
 * Computed here rather than with PostgreSQL's `hashtext`, which is an
 * internal function whose output is not a documented contract.
 */
export function advisoryLockKey(name: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(name)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * Runs `run` only while holding the key's lock, and says whether it did. The
 * shape of packages/jobs' `ExclusiveRunner`, which this package cannot import
 * (packages/jobs depends on it), so the worker's scheduler accepts it as is.
 */
export type AdvisoryExclusiveRunner = <T>(
  key: string,
  run: () => Promise<T>,
) => Promise<{ acquired: true; value: T } | { acquired: false }>;

/**
 * Runs a tick only while holding `pg_try_advisory_xact_lock` for its key.
 *
 * The lock is taken in a transaction opened for the purpose and held until
 * the tick returns or throws, when the transaction ends and PostgreSQL
 * releases it — including when this process dies, because the session goes
 * with it. `try` means a worker that finds the key held skips the tick
 * instead of queueing behind it; the holder is already doing that work.
 *
 * The tick's own queries do not run in this transaction. They use the
 * repositories' own connections, so the transaction holds one pooled
 * connection idle for the length of the tick and nothing else: nothing the
 * tick writes is rolled back if it throws.
 */
export function createAdvisoryExclusiveRunner(
  database: Database,
): AdvisoryExclusiveRunner {
  return (key, run) =>
    database.transaction(async (tx) => {
      const result = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${advisoryLockNamespace}::integer, ${advisoryLockKey(key)}::integer) as locked`,
      );
      if (result.rows[0]?.locked !== true) return { acquired: false as const };
      return { acquired: true as const, value: await run() };
    });
}
