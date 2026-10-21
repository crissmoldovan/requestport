import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type * as NodePgMigrator from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as PgliteMigrator from "drizzle-orm/pglite/migrator";
import type * as Pg from "pg";

import {
  driverPoolOf,
  drizzleOverPgliteSession,
  loadPgDriver,
  type RowsResultHKT,
  SingleSessionPglite,
  type Storage,
  storageClientOf,
  type TestSessionClient,
} from "./client.js";
import { drizzleOverHosted, isHostedDriver } from "./hosted-driver.js";
import { migrateHosted } from "./hosted-migrator.js";

/*
 * `@requestport/db/migrate` — the programmatic migration entry point
 * (track-e.md, contract §3.7). A subpath export, not in the barrel: nothing
 * that serves requests needs it in its module graph. `drizzle-kit migrate`
 * (`pnpm db:migrate`) is unchanged and remains what every launcher runs.
 */

/**
 * The session-level advisory lock every `migrate()` takes before it reads the
 * journal: the bytes of "RPMIGRAT" as a bigint. It excludes other `migrate()`
 * callers only — `drizzle-kit migrate` takes no lock, so a drizzle-kit run
 * at the same moment is not excluded.
 */
export const MIGRATION_LOCK_KEY = "5931325686371467604";

export interface MigrateOptions {
  /** Defaults to this package's own `migrations/`, found from this file. */
  migrationsFolder?: string;
}

export interface AppliedMigration {
  tag: string;
  hash: string;
  /** The journal's `created_at`: the migration's `when`, in milliseconds. */
  createdAt: number;
}

export interface MigrationReport {
  /** What this call applied, in order. Empty when there was nothing to do. */
  applied: AppliedMigration[];
}

const requireFromHere = createRequire(import.meta.url);

function defaultMigrationsFolder() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
}

type JournalRow = {
  hash: string;
  created_at: string;
};

/** A Drizzle handle bound to the one connection a migration run holds. */
type Bound = PgDatabase<RowsResultHKT>;

/**
 * The journal `drizzle-kit migrate` and Drizzle's migrator both write:
 * `drizzle.__drizzle_migrations`, their shared default. Absent on a database
 * nothing has migrated yet.
 */
async function readJournal(bound: Bound): Promise<JournalRow[]> {
  const present = await bound.execute<{ present: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
  );

  if (!present.rows[0]?.present) return [];

  const rows = await bound.execute<JournalRow>(
    sql`select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at, id`,
  );

  return rows.rows;
}

async function tagsByCreatedAt(folder: string) {
  const journal = JSON.parse(
    await readFile(join(folder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string; when: number }[] };

  return new Map(journal.entries.map((entry) => [entry.when, entry.tag]));
}

/**
 * PGlite's migrator, loaded the way `client.ts` loads PGlite itself: through
 * a `require` no bundler follows, so this subpath does not pull PGlite into a
 * build that imports it for pg or the hosted driver.
 */
function loadPgliteMigrator() {
  return (
    process.getBuiltinModule("node:module").createRequire(import.meta.url)(
      "drizzle-orm/pglite/migrator",
    ) as typeof PgliteMigrator
  ).migrate;
}

/**
 * Apply every pending migration to the storage's database.
 *
 * One connection does all of it: `migrate()` checks a client out, takes the
 * advisory lock on it, binds a Drizzle handle to that client — not to the
 * pool — and runs Drizzle's migrator through it. Drizzle's migrator reads the
 * journal and then opens a transaction; on a pool that transaction would
 * check out a second connection, which a one-connection pool can never give
 * while the lock holds the first. Bound to one client, it runs where the lock
 * is. The lock is released and the client returned in `finally`; if the
 * unlock fails the client is destroyed instead, so no pooled connection
 * carries a stale lock. On PGlite the client is its one connection, checked
 * out as a session; the lock is taken all the same, so the journal read, the
 * migrator and the unlock run exactly as they do on a server.
 *
 * Reads no environment variable. Refusing a production database is the
 * caller's job.
 */
export async function migrate(
  storage: Storage,
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const migrationsFolder =
    options.migrationsFolder ?? defaultMigrationsFolder();
  const storageClient = storageClientOf(storage);
  const pgliteClient =
    storageClient instanceof SingleSessionPglite
      ? await storageClient.connect()
      : undefined;
  const pool = pgliteClient === undefined ? driverPoolOf(storage) : undefined;
  const hostedClient = isHostedDriver(storage.driver)
    ? await (pool as unknown as { connect(): Promise<object> }).connect()
    : undefined;
  const pgClient =
    storage.driver === "pg" ? await (pool as Pg.Pool).connect() : undefined;
  const client = (hostedClient ??
    pgClient ??
    pgliteClient) as unknown as TestSessionClient;
  const hostedBound = hostedClient && drizzleOverHosted(hostedClient);
  const pgBound = pgClient && loadPgDriver().drizzle({ client: pgClient });
  const pgliteBound = pgliteClient && drizzleOverPgliteSession(pgliteClient);
  const bound = (hostedBound ?? pgBound ?? pgliteBound) as Bound;

  try {
    await bound.execute(
      sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`,
    );
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }

  let unlockFailure: Error | undefined;

  try {
    const before = await readJournal(bound);

    if (hostedBound !== undefined) {
      await migrateHosted(hostedBound, { migrationsFolder });
    } else if (pgBound !== undefined) {
      const { migrate: migratePg } = requireFromHere(
        "drizzle-orm/node-postgres/migrator",
      ) as typeof NodePgMigrator;

      await migratePg(pgBound, { migrationsFolder });
    } else if (pgliteBound !== undefined) {
      await loadPgliteMigrator()(
        pgliteBound as unknown as Parameters<
          ReturnType<typeof loadPgliteMigrator>
        >[0],
        { migrationsFolder },
      );
    }

    const after = await readJournal(bound);
    const seen = new Set(before.map((row) => `${row.hash}:${row.created_at}`));
    const tags = await tagsByCreatedAt(migrationsFolder);

    return {
      applied: after
        .filter((row) => !seen.has(`${row.hash}:${row.created_at}`))
        .map((row) => ({
          tag: tags.get(Number(row.created_at)) ?? "",
          hash: row.hash,
          createdAt: Number(row.created_at),
        })),
    };
  } finally {
    await bound
      .execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`)
      .catch((error: unknown) => {
        unlockFailure =
          error instanceof Error
            ? error
            : new Error("The migration lock could not be released.");
      });
    client.release(unlockFailure);
  }
}
