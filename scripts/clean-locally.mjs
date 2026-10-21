#!/usr/bin/env node
/**
 * Put the machine back the way a verification run found it.
 *
 * Written on 2026-09-17. Until then nothing in this repository removed
 * anything: no workspace defined a `clean` script and no dependency could have
 * run one. A full `--e2e` pass leaves 1.2 GB in `apps/web/.next`, a coverage
 * directory in eight workspaces, Playwright's traces and screenshots, and a
 * database carrying every tenant every lane invented — and the next run
 * inherits all of it.
 *
 * The three jobs are deliberately separate, because they cost different things
 * to be wrong about. Removing build output costs a rebuild. Resetting the
 * database costs whatever was in it. Stopping the stack costs nothing but
 * surprises somebody whose dev server is using it. So artefacts are the
 * default, and the other two are asked for.
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCAL_DATABASE_CONTAINER,
  LOCAL_DATABASE_PORT,
} from "./create-track-worktree.mjs";
import { loadRootEnv } from "./with-root-env.mjs";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * What a run leaves behind, relative to the repository root.
 *
 * Every entry here is ignored by git — the list is what a run *creates*, not
 * what a checkout contains, and anything tracked has no business in it.
 */
/**
 * Written by every acceptance run, and carried out of the container by `pnpm
 * test:webkit`. Removed by `pnpm clean`, which a person runs deliberately, and
 * **not** by the gate's own sweep after a passing lane run — that sweep would
 * delete a WebKit run's reports on the next `verify-locally --e2e`, which is
 * the deletion `run-webkit-lanes.mjs` exists to stop.
 */
export const REPORT_PATH = "apps/web/acceptance-report";

/** What the gate may sweep after a passing lane run. */
export const ARTEFACT_PATHS = [
  "apps/web/.next",
  // The self-host build's own distDir (Plan 13, H.5; manifest-h.md §2.7.1).
  "apps/web/.next-self-host",
  "apps/web/test-results",
  "apps/web/playwright-report",
  "apps/web/blob-report",
  "apps/web/coverage",
  "apps/cli/coverage",
  "packages/auth/coverage",
  "packages/client/coverage",
  "packages/client/dist",
  "packages/config/coverage",
  "packages/db/coverage",
  "packages/domain/coverage",
  "packages/theme/coverage",
  "packages/importer/coverage",
  "packages/mcp/coverage",
  "packages/notifications/coverage",
  "packages/trigger/coverage",
  "packages/webhooks/coverage",
  "spikes/evaluator/coverage",
];

/** What `pnpm clean` removes: the sweepable artefacts, and the reports. */
export const CLEAN_PATHS = [...ARTEFACT_PATHS, REPORT_PATH];

/**
 * The reset, as one statement, because it has to be all of it or none.
 *
 * `drizzle` is dropped as well as `public`, and that is the whole point.
 * Drizzle keeps its journal in its own schema, so dropping `public` alone
 * leaves a journal still claiming all seventeen migrations are applied: the
 * migrate that follows reports success, applies nothing, and every suite
 * afterwards fails on `relation "organizations" does not exist`. That is not a
 * hypothetical — it cost a full run on the day this was written.
 *
 * `requestport_private` goes too (Plan 13, Track I.2, D4). Migration 0019
 * creates it and puts its definer functions there, owned by
 * `requestport_definer`; it is the only schema a migration creates (`public`
 * is recreated here, and `drizzle` is the migrator's own), so a reset that
 * left it would leave functions of an older migration behind, for the next
 * migrate to replace or not. Everything
 * else 0019 makes in a database — policies, table grants, the trigger
 * functions in `public`, the grants on `public` itself — goes with `public`.
 *
 * Roles are not dropped. `requestport_application` and `requestport_definer`
 * are cluster-wide: every database on the shared server (one per track) has
 * functions owned by the definer and grants to both, so `DROP ROLE` would be
 * refused while any of them holds one, and would break them if it were not.
 * 0019 re-checks and reuses roles it finds, so a reset needs them gone no more
 * than it needs the server gone. The per-run logins (the application-role
 * lane's `…_app_lane`, the acceptance server's `…_e2e_app`) are dropped by the
 * runs that create them.
 */
export const RESET_STATEMENT =
  "drop schema if exists drizzle cascade; drop schema if exists requestport_private cascade; drop schema if exists public cascade; create schema public;";

export const DATABASE_NOT_LOCAL =
  "Refusing to reset a database that is not on this machine. " +
  "REQUESTPORT_LOCAL_DATABASE_URL must name a loopback host — this drops two schemas, " +
  "and nothing downstream of here asks again who it is talking to.";

export const DATABASE_UNNAMED =
  "REQUESTPORT_LOCAL_DATABASE_URL is not set, so there is no local database to reset. " +
  "Nothing was removed.";

/**
 * The query parameters a local connection string may carry: neither can move
 * the connection to another host, port, user or password.
 */
export const LOCAL_DATABASE_QUERY_PARAMETERS = Object.freeze([
  "sslmode",
  "application_name",
]);

export const DATABASE_QUERY_NOT_ALLOWED =
  "Refusing a local database string with a query parameter other than " +
  `${LOCAL_DATABASE_QUERY_PARAMETERS.join(" or ")}. pg takes host, port, ` +
  "user and password from the query over the ones before it, so a loopback " +
  "host there says nothing about where pg connects. Nothing was changed.";

export const DATABASE_NOT_IN_THE_STACK =
  "Refusing to change a database outside the local stack. This works " +
  "through the requestport-local-db container, which compose.yaml " +
  "publishes on 127.0.0.1:55432, and REQUESTPORT_LOCAL_DATABASE_URL names " +
  "another port: another server, whose database of that name the container " +
  "cannot reach. Nothing was changed.";

export const DATABASE_NOT_NAMED =
  "REQUESTPORT_LOCAL_DATABASE_URL names no database, and this will not " +
  "guess one: every track worktree has its own. Nothing was changed.";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The one database this script may touch.
 *
 * It reads `REQUESTPORT_LOCAL_DATABASE_URL` and never `DATABASE_URL`, which is
 * the variable a checkout pulled from Vercel fills with staging. The host must
 * be loopback, parsed rather than matched: `127.0.0.1.evil.example` contains
 * the right characters in the right order and is somebody else's machine.
 *
 * The query may hold only `LOCAL_DATABASE_QUERY_PARAMETERS`. The gate and the
 * WebKit runner hand this string to pg, whose parser (pg-connection-string)
 * copies every query parameter into the connection config, where `host`,
 * `port`, `user` and `password` replace the ones in the authority. A loopback
 * authority followed by `?host=elsewhere` connects to elsewhere. This is an
 * allowlist, not a list of the keys pg is known to read today.
 */
export function localDatabaseTarget(env) {
  const url = env.REQUESTPORT_LOCAL_DATABASE_URL;

  if (typeof url !== "string" || url.trim() === "") {
    throw new Error(DATABASE_UNNAMED);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(DATABASE_NOT_LOCAL);
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(DATABASE_NOT_LOCAL);
  }

  for (const name of parsed.searchParams.keys()) {
    if (!LOCAL_DATABASE_QUERY_PARAMETERS.includes(name)) {
      throw new Error(DATABASE_QUERY_NOT_ALLOWED);
    }
  }

  return url;
}

/**
 * The name of the database a local URL names, in the stack's own server.
 *
 * Everything here that changes a database does it with `docker exec` into the
 * stack's container, which reaches the server in that container and whichever
 * of its databases `-d` names. So the name comes from the URL, as pg reads it
 * (the path, through `decodeURI`), and is never a constant: every track worktree
 * has its own database (`create-track-worktree.mjs` names it), and until Plan
 * 13's X20 the reset below named `requestport_local` whatever the URL said.
 *
 * The URL must be on the port `compose.yaml` publishes the container on. Any
 * other port is another server, and the database of the same name in the
 * container is not the one the URL names. It must name a database, too:
 * without one, the server picks the database named after the user, and a
 * reset should not land wherever a default points.
 */
export function stackDatabaseName(databaseUrl) {
  const parsed = new URL(databaseUrl);

  if ((parsed.port || "5432") !== LOCAL_DATABASE_PORT) {
    throw new Error(DATABASE_NOT_IN_THE_STACK);
  }

  const name = decodeURI(parsed.pathname.replace(/^\//u, ""));
  if (name === "") throw new Error(DATABASE_NOT_NAMED);

  return name;
}

/** `psql` in the stack's container, as its superuser, against one database. */
export function stackPsqlArguments(databaseName, statement) {
  return [
    "exec",
    LOCAL_DATABASE_CONTAINER,
    "psql",
    "-U",
    "requestport",
    "-d",
    databaseName,
    "-q",
    "-c",
    statement,
  ];
}

/**
 * The artefacts that are actually there, as absolute paths.
 *
 * `paths` is the caller's choice and the distinction matters: the gate sweeps
 * `ARTEFACT_PATHS` after a passing lane run, and `pnpm clean` removes
 * `CLEAN_PATHS`, which also holds the acceptance reports. Sweeping those from
 * the gate would delete a WebKit run's evidence on the next
 * `verify-locally --e2e` — a run that produced none of it.
 */
export function artefactPlan(root, exists = existsSync, paths = CLEAN_PATHS) {
  return paths
    .map((path) => resolve(root, path))
    .filter((path) => exists(path));
}

export function removeArtefacts(paths, remove = rmSync) {
  for (const path of paths) {
    remove(path, { force: true, recursive: true });
  }

  return paths.length;
}

/**
 * What this invocation was asked to do.
 *
 * The database target is resolved here rather than at the moment of the drop,
 * so a run that would refuse refuses before it has removed anything.
 */
export function planClean(argv = [], env = {}) {
  const database = argv.includes("--database") || argv.includes("--all");
  const stack = argv.includes("--stack") || argv.includes("--all");
  const databaseUrl = database ? localDatabaseTarget(env) : undefined;

  return {
    artefacts: true,
    database,
    stack,
    databaseUrl,
    databaseName: database ? stackDatabaseName(databaseUrl) : undefined,
  };
}

/** A stale server on the acceptance port fails the next run, not this one. */
export function stopStaleE2EServer(spawn = spawnSync) {
  const holders = spawn("sh", ["-c", "lsof -ti tcp:3100 || true"], {
    encoding: "utf8",
  });
  const pids = (holders.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/u.test(line));

  for (const pid of pids) {
    spawn("kill", ["-9", pid], { encoding: "utf8" });
  }

  return pids.length;
}

/**
 * Drop and re-migrate the one database the plan names.
 *
 * The drop and the migrate reach the same database: the drop by the name
 * `planClean` read from the URL, in the stack's container, and the migrate by
 * the URL itself.
 */
export function resetDatabase(plan, spawn = spawnSync) {
  const psql = spawn(
    "docker",
    stackPsqlArguments(plan.databaseName, RESET_STATEMENT),
    { encoding: "utf8" },
  );

  if (psql.status !== 0) return false;

  const migrate = spawn("pnpm", ["--filter", "@requestport/db", "db:migrate"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: plan.databaseUrl },
    stdio: "inherit",
  });

  return migrate.status === 0;
}

/**
 * How `--stack` puts the local stack away: `docker compose down`, run in the
 * repository root, where `compose.yaml` declares the stack (ruling 175, owner
 * question 2d), with that file and the project it names given on the command
 * line. `docker compose` would otherwise take its project from an exported
 * COMPOSE_PROJECT_NAME and its file from an exported COMPOSE_FILE, and take
 * down whatever stack those name; `stopStack` also passes it no `COMPOSE_`
 * variable at all.
 *
 * Never with `--volumes`. The database lives on the stack's named volume, and
 * `down` without that flag removes the container and its network and keeps
 * the volume, so the next `docker compose up -d` finds every worktree's
 * database where it was.
 */
export const STACK_DOWN = Object.freeze({
  command: "docker",
  args: Object.freeze([
    "compose",
    "--project-name",
    "requestport-local",
    "--file",
    "compose.yaml",
    "down",
  ]),
  cwd: repositoryRoot,
});

/**
 * Run `STACK_DOWN` with `env` less every `COMPOSE_` variable; true only when
 * it exited 0.
 */
export function stopStack(spawn = spawnSync, env = process.env) {
  const down = spawn(STACK_DOWN.command, [...STACK_DOWN.args], {
    cwd: STACK_DOWN.cwd,
    encoding: "utf8",
    env: Object.fromEntries(
      Object.entries(env).filter(([name]) => !name.startsWith("COMPOSE_")),
    ),
  });

  return down.status === 0;
}

export function invokedDirectly(argv1, moduleUrl) {
  return typeof argv1 === "string" && argv1 === fileURLToPath(moduleUrl);
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  const argv = process.argv.slice(2);
  const env = loadRootEnv();

  let plan;
  try {
    plan = planClean(argv, env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const stopped = stopStaleE2EServer();
  if (stopped > 0) {
    console.log(`Stopped ${stopped} stale acceptance server(s) on port 3100.`);
  }

  const paths = artefactPlan(repositoryRoot);
  removeArtefacts(paths);
  console.log(`Removed ${paths.length} build and coverage artefact(s).`);

  if (plan.database) {
    console.log("Resetting the local database and re-applying migrations…");
    if (!resetDatabase(plan)) {
      console.error(
        "The database reset failed. The stack may not be running: docker compose up -d",
      );
      process.exit(1);
    }
    console.log("Local database reset and migrated from empty.");
  }

  if (plan.stack) {
    console.log(
      stopStack()
        ? "Local stack stopped. The named volume, and the data in it, survive."
        : "Could not stop the local stack; leaving it as it is.",
    );
  }
}
