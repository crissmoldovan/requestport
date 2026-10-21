import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Pg from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  type DatabaseDriver,
  driverPoolOf,
  type Storage,
  selectDriver,
} from "./client.js";
import { readDatabaseUrl } from "./database-url.js";
import { MIGRATION_LOCK_KEY, migrate } from "./migrate.js";
import {
  createTestStorage,
  openSession,
  rawQuery,
  type TestSession,
} from "./testing.js";

/*
 * The programmatic migration entry point (track-e.md, contract §3.7).
 *
 * Every case that applies migrations does so to a database of its own,
 * created here beside this run's database and dropped afterwards, because a
 * migration run is only meaningful from empty. On PGlite that is a database
 * in memory, and only the PGlite lane runs those cases; the lane dials no
 * server, so it skips the pg ones. The private tree's hosted-driver.test.ts
 * holds the hosted driver's case, as it stood before J.2b.
 */

const pgliteLane = selectDriver(process.env) === "pglite";

const runUrl = pgliteLane ? "" : readDatabaseUrl(process.env);
const journal = JSON.parse(
  await readFile(
    new URL("../migrations/meta/_journal.json", import.meta.url),
    "utf8",
  ),
) as { entries: { tag: string; when: number }[] };
const everyTag = journal.entries.map((entry) => entry.tag);

const created: string[] = [];
const storages: Storage[] = [];

/*
 * The time budgets. Nothing this file proves is measured against a clock:
 * each is only how long a loaded machine is given before a case is abandoned.
 *
 * A connection may take a minute. The full gate of 2026-09-28, at a load
 * average of 19.9 at its start and 39.9 at its end, failed a first
 * connection at the 3 seconds this file used to allow ("Connection
 * terminated due to connection timeout", in `migrate()`'s `pool.connect()`).
 * Nothing is lost by waiting longer: the proof that `migrate()` never takes
 * a second connection no longer depends on a connection timing out (below).
 *
 * Each case on pg that creates a database is given 120 seconds (the figure
 * after its body), not the package's 30. Applying every migration is most of
 * it: measured on 2026-09-28 at a load average of 88–98, one run of
 * `migrate()` on an empty database took 7.3–26.6s, while connecting took
 * under half a second. In that gate the first case on pg timed out at 30s. The budget is above four times the slowest measured run,
 * and twice the connect timeout, so a case whose first connection cannot be
 * had fails with the connection's message rather than the case's.
 */
const CONNECT_TIMEOUT_MS = 60_000;

/**
 * An administrative connection to this run's own database, opened through the
 * pg path so it takes nothing from `PG*` (contract §3.4) — a bare `pg.Client`
 * would inherit `PGOPTIONS`, `PGAPPNAME` and the rest — and through
 * `createTestStorage`, so production or staging's own database is refused
 * before `create database` could run there.
 */
async function withAdmin<T>(work: (client: TestSession) => Promise<T>) {
  const storage = createTestStorage({
    driver: "pg",
    connectionString: runUrl,
    pool: {
      max: 1,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    },
  });

  try {
    const session = await openSession(storage);

    try {
      return await work(session);
    } finally {
      session.release();
    }
  } finally {
    await storage.close();
  }
}

async function freshDatabase(): Promise<string> {
  const base = new URL(runUrl).pathname.slice(1);
  const name = `${base}_mig_${randomBytes(4).toString("hex")}`;

  await withAdmin((client) => client.query(`create database "${name}"`));
  created.push(name);

  const url = new URL(runUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function storageFor(url: string, driver: DatabaseDriver = "pg", max = 1) {
  const pool = {
    max,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  };
  const storage = createTestStorage(
    driver === "pg"
      ? { driver, connectionString: url, pool }
      : { driver, connectionString: url },
  );

  storages.push(storage);
  return storage;
}

/**
 * The most clients a pg storage's pool had checked out at once while `work`
 * ran, counted from the pool's own `acquire` and `release` events. A count,
 * not a timing: how loaded the machine is changes how long `work` takes, not
 * how many connections it holds.
 */
async function mostCheckedOutDuring<T>(
  storage: Storage,
  work: () => Promise<T>,
) {
  const pool = driverPoolOf(storage) as Pg.Pool;
  let out = pool.totalCount - pool.idleCount;
  let most = out;
  const acquired = () => {
    out += 1;
    most = Math.max(most, out);
  };
  const released = () => {
    out -= 1;
  };

  pool.on("acquire", acquired);
  pool.on("release", released);
  try {
    const result = await work();

    return { result, most };
  } finally {
    pool.off("acquire", acquired);
    pool.off("release", released);
  }
}

async function advisoryLocksIn(database: string) {
  return withAdmin(async (client) => {
    const result = await client.query<{ n: number }>(
      `select count(*)::int as n
         from pg_locks l
         join pg_database d on d.oid = l.database
        where l.locktype = 'advisory' and d.datname = $1`,
      [database],
    );

    return result.rows[0]?.n;
  });
}

/*
 * Every database this file created is dropped over one administrative
 * session, and a drop that fails does not stop the ones after it; the names
 * left behind are reported rather than lost. A storage that fails to close
 * does not stop the drops either — `with (force)` ends its sessions.
 *
 * 120 seconds rather than the package's 30: this hook opens one connection
 * and drops up to five databases in series, and under R10's load a single
 * fresh connection has taken 66,619ms (track-t0.md). A review run at a load
 * average of 80 failed this file after every case had passed and left four
 * databases on the shared server; the hook timeout is the probable cause, not
 * a proved one, since that run's error was not captured.
 */
afterAll(async () => {
  await Promise.allSettled(storages.map((storage) => storage.close()));

  // Nothing to drop, and no reason to dial the server: the PGlite lane, or a
  // run whose cases were all skipped.
  if (created.length === 0) return;

  const leftBehind: string[] = [];

  await withAdmin(async (client) => {
    for (const name of created) {
      try {
        await client.query(`drop database if exists "${name}" with (force)`);
      } catch {
        leftBehind.push(name);
      }
    }
  });

  if (leftBehind.length > 0) {
    throw new Error(
      `migrate.test.ts could not drop ${leftBehind.join(", ")}; ` +
        "drop each with (force) on the local server.",
    );
  }
}, 120_000);

describe.skipIf(pgliteLane)("migrate(storage) on pg", () => {
  test("applies every migration to an empty database on one connection, never two at once", async () => {
    /*
     * Handed the pool instead of the client that holds the lock, Drizzle's
     * migrator would read the journal and open its transaction on a second
     * connection (contract §3.7). This pool has room for that second
     * connection, so a migrator that asked for one would be given it and
     * counted, not left waiting for a timeout to say so. One checked out at
     * a time is what a pool of `max: 1`, `drizzle-kit`'s own, can serve.
     */
    const url = await freshDatabase();
    const storage = storageFor(url, "pg", 2);

    const first = await mostCheckedOutDuring(storage, () => migrate(storage));

    expect(first.result.applied.map((entry) => entry.tag)).toEqual(everyTag);
    // Exactly one, not at most one: `migrate()`'s own checkout is counted,
    // so the count is watching this pool.
    expect(first.most).toBe(1);
    expect(await advisoryLocksIn(new URL(url).pathname.slice(1))).toBe(0);

    const again = await mostCheckedOutDuring(storage, () => migrate(storage));

    expect(again.result.applied).toEqual([]);
    expect(again.most).toBe(1);
  }, 120_000);

  test("writes the journal drizzle-kit writes, so the two can hand a database over", async () => {
    /*
     * This run's own database was migrated by `drizzle-kit migrate`
     * (scripts/create-track-worktree.mjs). migrate() finds nothing to do
     * there, and the rows it wrote on an empty database are the rows
     * drizzle-kit wrote: same hashes, same created_at.
     */
    const url = await freshDatabase();
    const fresh = storageFor(url);
    await migrate(fresh);

    const runStorage = storageFor(runUrl);
    const onRun = await migrate(runStorage);

    expect(onRun.applied).toEqual([]);

    const read = async (storage: Storage) =>
      (
        await rawQuery<{ hash: string; created_at: string }>(
          storage,
          "select hash, created_at::text from drizzle.__drizzle_migrations order by created_at",
        )
      ).rows;

    expect(await read(fresh)).toEqual(await read(runStorage));
  }, 120_000);

  test("two concurrent callers: one applies everything, the other nothing", async () => {
    const url = await freshDatabase();
    const [first, second] = await Promise.all([
      migrate(storageFor(url)),
      migrate(storageFor(url)),
    ]);
    const counts = [first.applied.length, second.applied.length].sort();

    expect(counts).toEqual([0, everyTag.length]);
    expect(await advisoryLocksIn(new URL(url).pathname.slice(1))).toBe(0);
  }, 120_000);

  test("a failing migration releases the lock and the connection", async () => {
    const folder = await mkdtemp(join(tmpdir(), "rp-e2-migrate-"));

    try {
      await mkdir(join(folder, "meta"));
      await writeFile(
        join(folder, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            {
              idx: 0,
              version: "7",
              when: 1,
              tag: "0000_fails",
              breakpoints: true,
            },
          ],
        }),
      );
      await writeFile(join(folder, "0000_fails.sql"), "select 1 / 0;");

      const url = await freshDatabase();
      const storage = storageFor(url);

      await expect(
        migrate(storage, { migrationsFolder: folder }),
      ).rejects.toThrow();
      expect(await advisoryLocksIn(new URL(url).pathname.slice(1))).toBe(0);

      // Nothing is left checked out of the pool of one, read from the pool
      // rather than waited for: a leaked client would fail this at once, not
      // after the connect timeout.
      const pool = driverPoolOf(storage) as Pg.Pool;

      expect(pool.totalCount - pool.idleCount).toBe(0);

      // The one pooled connection came back usable.
      await expect(storage.ready()).resolves.toBeUndefined();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 120_000);

  test("locks on a fixed key", () => {
    expect(MIGRATION_LOCK_KEY).toMatch(/^-?\d+$/u);
  });
});

describe.skipIf(!pgliteLane)("migrate(storage) on PGlite", () => {
  function pgliteStorage() {
    const storage = createTestStorage({ driver: "pglite" });

    storages.push(storage);
    return storage;
  }

  async function advisoryLocks(storage: Storage) {
    const result = await rawQuery<{ n: number }>(
      storage,
      "select count(*)::int as n from pg_locks where locktype = 'advisory'",
    );

    return result.rows[0]?.n;
  }

  test("applies every migration to an empty database, citext included", async () => {
    const storage = pgliteStorage();

    const report = await migrate(storage);

    expect(report.applied.map((entry) => entry.tag)).toEqual(everyTag);
    // 0002 creates the extension, which PGlite loads only when asked.
    const citext = await rawQuery<{ n: number }>(
      storage,
      "select count(*)::int as n from pg_extension where extname = 'citext'",
    );

    expect(citext.rows[0]?.n).toBe(1);
    expect(await advisoryLocks(storage)).toBe(0);

    const again = await migrate(storage);

    expect(again.applied).toEqual([]);
  });

  test("writes the journal drizzle-kit writes: one row per migration, at its own time", async () => {
    const storage = pgliteStorage();

    await migrate(storage);

    const rows = await rawQuery<{ created_at: string }>(
      storage,
      "select created_at::text from drizzle.__drizzle_migrations order by created_at",
    );

    expect(rows.rows.map((row) => Number(row.created_at))).toEqual(
      journal.entries.map((entry) => entry.when),
    );
  });

  test("a failing migration releases the lock and the one connection", async () => {
    const folder = await mkdtemp(join(tmpdir(), "rp-e2-migrate-"));

    try {
      await mkdir(join(folder, "meta"));
      await writeFile(
        join(folder, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            {
              idx: 0,
              version: "7",
              when: 1,
              tag: "0000_fails",
              breakpoints: true,
            },
          ],
        }),
      );
      await writeFile(join(folder, "0000_fails.sql"), "select 1 / 0;");

      const storage = pgliteStorage();

      await expect(
        migrate(storage, { migrationsFolder: folder }),
      ).rejects.toThrow();
      // The session came back: the storage's own handle is usable again.
      await expect(storage.ready()).resolves.toBeUndefined();
      expect(await advisoryLocks(storage)).toBe(0);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
