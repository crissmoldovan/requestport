/*
 * The worker-role lane's logins (Plan 13, Track I.2b; manifest-i2.md §5.3
 * Done when 12 and 14, ruling 35): a global setup that runs after
 * vitest.jobs-database.ts has created and migrated the run's database, and
 * makes one login in each worker group on that server —
 * `requestport_dispatcher`, `requestport_tenant_processor`,
 * `requestport_maintenance` — each `NOSUPERUSER NOBYPASSRLS`, a member of
 * its group and nothing else, owning nothing. The names are unique to the run
 * (the database's name, a random suffix and the group's letter), stored with
 * one SCRAM iteration, with passwords made here and never written down; the
 * three URLs name the run's database. The teardown drops the three.
 *
 * vitest.worker-role-env.ts hands the URLs to each suite as the three
 * variables the worker reads, so `workerStorages()` claims, processes and
 * maintains as these logins. `DATABASE_URL` still names the owner, which the
 * suites seed through.
 *
 * The roles are made and dropped through `psql` inside the local database's
 * container, as vitest.jobs-database.ts makes the run's database, so this
 * file imports no database driver and the tenant-scope sweep's boundary test
 * (packages/db, "finds no query outside packages/db") has nothing to report.
 * The statements go to `psql` on its standard input, so a password is never
 * a process argument.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TestProject } from "vitest/node";

import { LOCAL_DATABASE_CONTAINER } from "../../scripts/create-track-worktree.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    workerRoleUrls: {
      dispatcher: string;
      processor: string;
      maintenance: string;
    };
  }
}

const GROUPS = {
  dispatcher: ["requestport_dispatcher", "d"],
  processor: ["requestport_tenant_processor", "p"],
  maintenance: ["requestport_maintenance", "m"],
} as const;

/** Names this file places in statements: the run's database and its logins. */
const SAFE_NAME = /^[a-z0-9_]+$/u;

/**
 * `statements` through `psql` in the stack's container, as the owner of the
 * run's database, `database`, in one session. vitest.jobs-database.ts made
 * that database in the same container, so this is the same server.
 */
function asOwner(database: URL, statements: string) {
  const name = decodeURIComponent(database.pathname.slice(1));
  const user = decodeURIComponent(database.username);
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      LOCAL_DATABASE_CONTAINER,
      "psql",
      "-X",
      "-At",
      "-U",
      user,
      "-d",
      name,
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    { encoding: "utf8", input: statements },
  );
  if (result.status !== 0) {
    throw new Error(
      `psql on the local stack failed (exit ${result.status ?? result.signal}): ${result.stderr.trim()}`,
    );
  }
}

export default function setup(project: TestProject) {
  if (process.env.REQUESTPORT_DATABASE_DRIVER !== "pg") {
    throw new Error(
      "The worker-role lane runs on pg, against a real PostgreSQL: set REQUESTPORT_DATABASE_DRIVER=pg.",
    );
  }
  const jobsDatabaseUrl = project.getProvidedContext().jobsDatabaseUrl;
  if (typeof jobsDatabaseUrl !== "string" || jobsDatabaseUrl === "") {
    throw new Error(
      "The worker-role lane found no jobs database: vitest.jobs-database.ts must run first.",
    );
  }
  const database = new URL(jobsDatabaseUrl);
  const databaseName = decodeURIComponent(database.pathname.slice(1));
  if (!SAFE_NAME.test(databaseName)) {
    throw new Error(
      "The worker-role lane's database name is not one it made; it makes no logins for it.",
    );
  }

  const prefix = `${databaseName.slice(0, 32)}_wrl_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const logins = Object.entries(GROUPS).map(([role, [group, letter]]) => ({
    role: role as keyof typeof GROUPS,
    group,
    name: `${prefix}_${letter}`,
    password: randomUUID().replaceAll("-", ""),
  }));
  const names = logins.map((login) => login.name);

  try {
    asOwner(
      database,
      [
        "SET scram_iterations = 1;",
        ...logins.map(
          ({ name, password, group }) =>
            `create role "${name}" login password '${password}' ` +
            `nosuperuser nobypassrls nocreatedb nocreaterole noreplication in role ${group};`,
        ),
      ].join("\n"),
    );
  } catch (error) {
    drop(database, names);
    throw error;
  }

  const urls = {} as Record<keyof typeof GROUPS, string>;
  for (const { role, name, password } of logins) {
    const url = new URL(database);
    url.username = name;
    url.password = password;
    urls[role] = url.toString();
  }
  project.provide("workerRoleUrls", urls);
  return () => drop(database, names);
}

/** Drops the run's logins; `if exists`, so a partial setup drops what it made. */
function drop(database: URL, names: string[]) {
  asOwner(
    database,
    names.map((name) => `drop role if exists "${name}";`).join("\n"),
  );
}
