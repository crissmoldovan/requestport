/*
 * A database of their own for this package's integration suites, for one run.
 *
 * `outboxRepository.claimBatch` claims every eligible outbox row in the
 * database, not the suite's, so these suites refuse to start while any row is
 * claimable (docs/implementation/gotchas.md, "A test that claims outbox rows
 * claims everyone's"). The full gate runs every workspace's suites against
 * the track's one database at the same time, and the others leave claimable
 * rows behind, so on 2026-09-28 the refusal fired in the gate: "expected 9 to
 * be +0". No ordering fixes that; a database no other suite knows about does.
 *
 * Before the run: refuse anything but the local stack, drop what a killed run
 * left, then create `<local database>_jobs_<this pid>`, mark it and migrate
 * it, and, when the project's files include src/bin.integration.test.ts (the
 * integration project's do, the worker-role lane's do not), do the same for
 * `<local database>_jbin_<this pid>`. After: drop what it made. The suites
 * are pointed at the first by vitest.jobs-database-env.ts. The second is
 * src/bin.integration.test.ts's alone (X28, ruling 231; ruling 232 item 1):
 * the worker that file starts runs every schedule on its database when it
 * starts, so on the run's database it would work, and fail on, whatever due
 * rows the suites before it left there; that file points itself at the
 * second, which no other suite writes to.
 *
 * Creating and dropping go through `psql` inside the local database's
 * container, as scripts/create-track-worktree.mjs creates a track's database;
 * the migration is `pnpm --filter @requestport/db db:migrate`, as that script
 * and Plan 13's R1 migrate one. So this file imports no database driver, and
 * the tenant-scope sweep's boundary test, which reads it, has nothing to
 * report.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { TestProject } from "vitest/node";

import { localDatabaseTarget } from "../../scripts/clean-locally.mjs";
import {
  DROPPED_PREFIXES,
  LOCAL_DATABASE_CONTAINER,
  LOCAL_DATABASE_HOST,
  LOCAL_DATABASE_PORT,
  localStackRunning,
} from "../../scripts/create-track-worktree.mjs";
import { refuseUnapprovedProductionDatabase } from "../../scripts/production-database-guard.mjs";
import {
  jobsBinDatabaseName,
  jobsDatabaseMarker,
  jobsDatabaseName,
  processAlive,
  staleJobsDatabases,
  withDatabaseName,
} from "./src/test-support/jobs-database.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");

/**
 * The local database this run may create a sibling of, or a refusal.
 *
 * Every refusal comes before anything is created or dropped:
 * - `VERCEL_ENV` set: packages/db honours the local proxy only where it is
 *   not (`localProxyTarget`), and `readDatabaseUrl` would read the preview
 *   database under `preview`;
 * - `DATABASE_URL` naming production or staging without its opt-in
 *   (`refuseUnapprovedProductionDatabase`, the guard `with-root-env.mjs`
 *   applies). These suites would not use it, but a checkout configured that
 *   way is not one to run them in;
 * - `REQUESTPORT_LOCAL_DATABASE_URL` unset or not loopback
 *   (`localDatabaseTarget`, the guard `pnpm run clean --database` applies);
 * - that URL naming anything but the stack's own address, 127.0.0.1:55432,
 *   because the database is created in the stack's container and migrated
 *   through that address, and the two must be the same server;
 * - the stack's database container not running.
 */
function localTarget(env: NodeJS.ProcessEnv) {
  if (env.VERCEL_ENV !== undefined) {
    throw new Error(
      `VERCEL_ENV is set (${JSON.stringify(env.VERCEL_ENV)}), so this is not a local run; the jobs integration suites create a database only on the local stack.`,
    );
  }
  refuseUnapprovedProductionDatabase(env);
  const local = new URL(localDatabaseTarget(env));
  if (
    local.hostname !== LOCAL_DATABASE_HOST ||
    local.port !== LOCAL_DATABASE_PORT
  ) {
    throw new Error(
      `REQUESTPORT_LOCAL_DATABASE_URL must name the local stack at ${LOCAL_DATABASE_HOST}:${LOCAL_DATABASE_PORT}, where the jobs integration database is created and migrated.`,
    );
  }
  if (!localStackRunning()) {
    throw new Error(
      "The local database stack is not running (docker compose up -d), so the jobs integration suites have no database.",
    );
  }
  return {
    url: local.toString(),
    base: decodeURIComponent(local.pathname.slice(1)),
    user: decodeURIComponent(local.username),
  };
}

type Target = ReturnType<typeof localTarget>;

/** One statement through `psql` in the stack's container, connected to the local database. */
function psql(target: Target, statement: string): string {
  const result = spawnSync(
    "docker",
    [
      "exec",
      LOCAL_DATABASE_CONTAINER,
      "psql",
      "-X",
      "-At",
      "-U",
      target.user,
      "-d",
      target.base,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `psql on the local stack failed (exit ${result.status ?? result.signal}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * `<name>` is one of three: a name `setup` made with `jobsDatabaseName` or
 * `jobsBinDatabaseName`, each of which refuses a base not made of a-z, 0-9
 * and _ and a pid that is not a positive integer, dropped when the run ends
 * or a step fails; or one the stale sweep chose (`staleJobsDatabases`): a
 * database that carries `jobsDatabaseMarker`, which only this setup writes,
 * on a name it made with those two, and whose name `jobsDatabasePid` reads
 * back as either form for this run's base. So `<name>` needs no quoting
 * inside the double quotes, and the marker is a constant: both are safe to
 * place in the statement.
 */
function drop(target: Target, name: string) {
  psql(target, `drop database if exists "${name}" with (force)`);
}

/**
 * The environment the migration runs in: this one, less anything that could
 * name another database, with every URL `readDatabaseUrl` can select set to
 * the new one — the rule scripts/create-track-worktree.mjs `childEnvironment`
 * applies (its `DROPPED_PREFIXES`), whose own check admits only `rp_track_*`
 * names.
 */
function migrationEnvironment(env: NodeJS.ProcessEnv, url: string) {
  const kept = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !DROPPED_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
        key !== "REQUESTPORT_LOCAL_DATABASE_URL",
    ),
  );
  return {
    ...kept,
    DATABASE_URL: url,
    REQUESTPORT_LOCAL_DATABASE_URL: url,
    REQUESTPORT_PREVIEW_DATABASE_URL: url,
  };
}

/** src/bin.integration.test.ts, which alone uses the second database. */
const binSuite = resolve(import.meta.dirname, "src/bin.integration.test.ts");

export default async function setup(project: TestProject) {
  let target: Target;
  try {
    target = localTarget(process.env);
  } catch (error) {
    // The guards' own words, which were written for their own scripts, said
    // where they came from.
    throw new Error(
      `The jobs integration suites refused to create their database, and created nothing: ${(error as Error).message}`,
      { cause: error },
    );
  }

  const marked = psql(
    target,
    `select datname from pg_database where shobj_description(oid, 'pg_database') = '${jobsDatabaseMarker}' order by 1`,
  )
    .split("\n")
    .filter(Boolean);
  for (const stale of staleJobsDatabases(marked, target.base, processAlive)) {
    drop(target, stale);
  }

  // bin's database only for a project that runs bin's file: the
  // integration project, not the worker-role lane (ruling 232 item 1). Every
  // name before anything is created, so that one PostgreSQL would truncate
  // refuses the run with nothing made.
  const { testFiles } = await project.globTestFiles();
  const databases: (readonly [
    "jobsDatabaseUrl" | "jobsBinDatabaseUrl",
    string,
  ])[] = [["jobsDatabaseUrl", jobsDatabaseName(target.base, process.pid)]];
  if (testFiles.includes(binSuite)) {
    databases.push([
      "jobsBinDatabaseUrl",
      jobsBinDatabaseName(target.base, process.pid),
    ]);
  }
  const made: string[] = [];
  const dropMade = () => {
    for (const name of made.splice(0).reverse()) drop(target, name);
  };
  try {
    for (const [key, name] of databases) {
      const url = withDatabaseName(target.url, name);
      // `create database` cannot run in a transaction, so the marker follows
      // it as a second statement. A run killed between the two leaves a
      // database without the marker, which the sweep above never drops.
      psql(target, `create database "${name}"`);
      made.push(name);
      psql(target, `comment on database "${name}" is '${jobsDatabaseMarker}'`);
      const migrated = spawnSync(
        "pnpm",
        ["--filter", "@requestport/db", "db:migrate"],
        {
          cwd: repositoryRoot,
          env: migrationEnvironment(process.env, url),
          encoding: "utf8",
        },
      );
      if (migrated.status !== 0) {
        throw new Error(
          `Migrating ${name} failed (exit ${migrated.status ?? migrated.signal}):\n${migrated.stdout}${migrated.stderr}`,
        );
      }
      project.provide(key, url);
    }
  } catch (error) {
    dropMade();
    throw error;
  }

  return dropMade;
}
