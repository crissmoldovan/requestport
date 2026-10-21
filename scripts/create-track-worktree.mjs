#!/usr/bin/env node
/**
 * One isolated track: a git worktree on its own branch, its own database on
 * the local PostgreSQL, migrated, and a generated `.env.local` that holds no
 * live credential.
 *
 *   node scripts/create-track-worktree.mjs <name> [--base <ref>]
 *
 * Why a database per track rather than a shared one: the gate seeds and
 * deletes, so two tracks running it against one database would be testing each
 * other's rows.
 * Why not PGlite: it has one connection, and the lock-choreography suites hold
 * two or three sessions open at once. Every track's URL names the same server,
 * `127.0.0.1:55432` (`assertLocalDatabaseUrl` refuses any other), with the same
 * user and password, so the database *name* is the only part that differs —
 * which is why a name per track is enough to separate them.
 *
 * Why the environment is generated and never copied: the main checkout's
 * `.env.local` names the production database. This script reads no
 * `.env.local`, and writes only the new worktree's, only when none is there.
 *
 * The migration it runs goes through `with-root-env.mjs` inside the new
 * worktree, which fills *unset* variables from that worktree's own file — the
 * one written here, or one already there and kept, which this script has not
 * read. `readDatabaseUrl` takes `REQUESTPORT_PREVIEW_DATABASE_URL` when
 * `VERCEL_ENV` is `preview` and `DATABASE_URL` otherwise, and a kept file can
 * set `VERCEL_ENV`. So `childEnvironment` sets *both* URLs to the track
 * database: the file cannot fill either, and whichever one is read names the
 * track. A kept file still decides what every later command in that worktree
 * uses, so keeping one is announced rather than passed over.
 *
 * Why the application gets a login of its own (Plan 13, I.2 step 5; ruling
 * 221 item 2): `pnpm dev`'s application connects as production's does, as a
 * login in `requestport_application` that owns nothing and cannot bypass
 * row-level security, which the file names in
 * `REQUESTPORT_APPLICATION_DATABASE_URL`. Only the application root reads
 * that variable; the migration, the operator CLI and the storages the suites
 * build with `packages/db`'s `storageOptionsFromEnv` read `DATABASE_URL`, the
 * owner. The group comes from the migration (`0019`), so
 * the login is made after it, with the password this script generated for
 * the file it wrote. A kept file gets no login: its contents are unknown here.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { providerVariablePrefixes } from "./hosted-deployment.mjs";

export const TRACK_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/u;
export const DEFAULT_BASE = "origin/main";

/** The local stack, as `compose.yaml` declares it. */
export const LOCAL_DATABASE_CONTAINER = "requestport-local-db";
export const LOCAL_DATABASE_HOST = "127.0.0.1";
export const LOCAL_DATABASE_PORT = "55432";
const LOCAL_DATABASE_USER = "requestport";
// Not a secret: it authenticates a throwaway database bound to loopback, and
// `compose.yaml` writes it in full for the same reason.
const LOCAL_DATABASE_PASSWORD = "requestport_local";
const MAINTENANCE_DATABASE = "requestport_local";
/** The group the application's login joins, which migration `0019` creates. */
export const APPLICATION_GROUP = "requestport_application";
const TRACK_DATABASE_NAME = /^rp_track_[a-z0-9_]{1,41}$/u;
/** What `generateApplicationPassword` makes, and all a login statement takes. */
const APPLICATION_PASSWORD = /^[0-9a-f]{32,128}$/u;

export const USAGE =
  "Usage: node scripts/create-track-worktree.mjs <name> [--base <ref>]\n" +
  "  <name> is 1-41 characters of a-z, 0-9 and '-', starting with a letter or digit.";

export const STACK_NOT_RUNNING = [
  "The local database stack is not running, so there is nowhere to put this track's database.",
  "",
  "Start it:   docker compose up -d",
  "",
  "Nothing was created.",
].join("\n");

/**
 * Every key the generated `.env.local` holds, and nothing else.
 *
 * The placeholders make the application's eager configuration parse, and are
 * written so that nobody could mistake them for a real client, key or sender.
 *
 * `REQUESTPORT_DATABASE_DRIVER` is here for runs outside the gate: the gate
 * sets `pg` itself, but a targeted `pnpm --filter … test` in the track (the
 * vitest configs of packages/db, packages/auth and packages/jobs fill unset
 * variables from this file) or `pnpm dev` (through `with-root-env.mjs`) reads
 * it only from here. Unset, packages/db selects its default driver
 * (`DEFAULT_DRIVER` in packages/db/src/hosted-driver.ts), which in the private
 * tree is the hosted driver, and that cannot reach a plain PostgreSQL without
 * the WebSocket proxy the local stack stopped running on 2026-09-28; with it,
 * those runs use pg, as the gate does.
 *
 * `REQUESTPORT_APPLICATION_DATABASE_URL` names the track's application login
 * (`applicationLoginUrl`), which only the application root reads.
 */
export const TRACK_ENV_KEYS = [
  "NODE_ENV",
  "LOG_LEVEL",
  "NEXT_PUBLIC_APP_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "DATABASE_URL",
  "REQUESTPORT_LOCAL_DATABASE_URL",
  "REQUESTPORT_APPLICATION_DATABASE_URL",
  "REQUESTPORT_DATABASE_DRIVER",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
];

export class Refusal extends Error {}

/** `<name> [--base <ref>]`, or a refusal that says what was wrong. */
export function parseArguments(argv) {
  let name;
  let base = DEFAULT_BASE;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--base") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-") || value.trim() === "") {
        throw new Refusal(`--base needs a ref.\n${USAGE}`);
      }
      base = value;
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new Refusal(`Unknown option ${argument}.\n${USAGE}`);
    } else if (name === undefined) {
      name = argument;
    } else {
      throw new Refusal(`One track name, not two.\n${USAGE}`);
    }
  }

  if (name === undefined) throw new Refusal(USAGE);

  return { name: validateTrackName(name), base };
}

export function validateTrackName(name) {
  if (typeof name !== "string" || !TRACK_NAME.test(name)) {
    throw new Refusal(`Not a track name: ${JSON.stringify(name)}.\n${USAGE}`);
  }

  return name;
}

/** Everything derived from the name, so it is decided in one place. */
export function trackLayout(repositoryRoot, name) {
  validateTrackName(name);
  const database = `rp_track_${name.replaceAll("-", "_")}`;

  return {
    name,
    worktree: join(repositoryRoot, ".worktrees", `track-${name}`),
    branch: `track/${name}`,
    database,
    databaseUrl: `postgres://${LOCAL_DATABASE_USER}:${LOCAL_DATABASE_PASSWORD}@${LOCAL_DATABASE_HOST}:${LOCAL_DATABASE_PORT}/${database}`,
  };
}

/**
 * Refuse any database that is not the local server.
 *
 * Parsed, not matched: `127.0.0.1.evil.example:55432` contains the right
 * characters in the right order and is somebody else's machine. The host is
 * the literal loopback address the stack binds, and the port is the one it
 * publishes — a different port on loopback is a different server, possibly a
 * tunnel to one that is not local at all.
 */
export function assertLocalDatabaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Refusal("Refusing a database URL that does not parse.");
  }

  const local =
    (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") &&
    parsed.hostname === LOCAL_DATABASE_HOST &&
    parsed.port === LOCAL_DATABASE_PORT &&
    /^\/rp_track_[a-z0-9_]{1,41}$/u.test(parsed.pathname);

  if (!local) {
    throw new Refusal(
      `Refusing a database that is not a track database on the local server (${LOCAL_DATABASE_HOST}:${LOCAL_DATABASE_PORT}).`,
    );
  }

  return url;
}

/**
 * The track's application login: the database's name and `_dev_app`, at
 * most 58 characters, inside PostgreSQL's 63. Each track's database name is
 * its own, so no other track's login can be the same, and no other login
 * this repository makes on the local server ends in `_dev_app` (searched
 * at I.2 step 5's review): the acceptance server's (`start-e2e-server.mjs`)
 * and the application-role lane's (`vitest.application-role.config.ts`) are
 * the first 40 characters of a database's name followed by `_e2e_app` and
 * `_app_lane`; the core tarball smoke's is `rp_g8_smoke_<hex>_app`; and
 * the suites' roles carry their run's name and suffixes of their own. With
 * `_app`, track `foo-e2e`'s login was track `foo`'s acceptance login.
 */
export function applicationLoginName(database) {
  if (typeof database !== "string" || !TRACK_DATABASE_NAME.test(database)) {
    throw new Refusal(`Refusing an unexpected database name: ${database}`);
  }

  return `${database}_dev_app`;
}

/** A password for the application login: 48 hex characters. */
export function generateApplicationPassword(bytes = randomBytes) {
  return bytes(24).toString("hex");
}

function assertApplicationPassword(password) {
  if (typeof password !== "string" || !APPLICATION_PASSWORD.test(password)) {
    throw new Refusal(
      "The application login's password must be 32 to 128 lower-case hex characters.",
    );
  }

  return password;
}

/**
 * The track database's URL as the application login: its user and password
 * in place of the owner's, and nothing else changed, so it passes
 * `assertLocalDatabaseUrl` as the owner's does.
 */
export function applicationLoginUrl(databaseUrl, password) {
  assertLocalDatabaseUrl(databaseUrl);
  assertApplicationPassword(password);
  const url = new URL(databaseUrl);

  url.username = applicationLoginName(url.pathname.slice(1));
  url.password = password;

  return assertLocalDatabaseUrl(url.toString());
}

/** The generated `.env.local`, as text. */
export function renderTrackEnv({
  name,
  databaseUrl,
  secret,
  applicationPassword,
}) {
  assertLocalDatabaseUrl(databaseUrl);
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Refusal("BETTER_AUTH_SECRET must be at least 32 characters.");
  }
  const applicationDatabaseUrl = applicationLoginUrl(
    databaseUrl,
    applicationPassword,
  );

  const values = {
    NODE_ENV: "development",
    LOG_LEVEL: "info",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: secret,
    DATABASE_URL: databaseUrl,
    REQUESTPORT_LOCAL_DATABASE_URL: databaseUrl,
    REQUESTPORT_APPLICATION_DATABASE_URL: applicationDatabaseUrl,
    REQUESTPORT_DATABASE_DRIVER: "pg",
    GITHUB_CLIENT_ID: "track-local-not-a-real-client",
    GITHUB_CLIENT_SECRET: "track-local-not-a-real-secret",
    RESEND_API_KEY: "re_track_local_not_a_real_key",
    RESEND_FROM_EMAIL: "track-local@example.invalid",
  };

  return [
    `# Track ${name} — generated by scripts/create-track-worktree.mjs. Local-only; nothing here is live.`,
    ...TRACK_ENV_KEYS.map((key) => `${key}=${values[key]}`),
    "",
  ].join("\n");
}

export function generateSecret(bytes = randomBytes) {
  return bytes(32).toString("base64url");
}

/**
 * Write the file only if there is none. `wx` makes that one step rather than a
 * check followed by a write, so nothing can appear between them and be
 * overwritten. The mode is set again afterwards because `mode` on create is
 * filtered through the umask.
 */
export function writeTrackEnv(
  path,
  contents,
  fs = { writeFileSync, chmodSync },
) {
  try {
    fs.writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error && error.code === "EEXIST") return "kept";
    throw error;
  }
  fs.chmodSync(path, 0o600);

  return "written";
}

/**
 * The prefixes of every variable `childEnvironment` drops: the ones below, and
 * the database service's (`providerVariablePrefixes`). `packages/jobs`'
 * database setup (`vitest.jobs-database.ts`) drops the same.
 */
export const DROPPED_PREFIXES = Object.freeze([
  "PG",
  "POSTGRES_",
  ...providerVariablePrefixes,
  "VERCEL_",
  "DATABASE_",
  "REQUESTPORT_PREVIEW_",
]);

/**
 * The environment a child of this script runs in: the caller's, minus
 * anything that could name a database or a deployment, plus the track's own.
 *
 * `pg` and `psql` fill a missing connection parameter from `PG*`, and a shell
 * that once pulled Vercel variables may still hold `POSTGRES_*`, `DATABASE_*`,
 * `VERCEL_*` or `REQUESTPORT_PREVIEW_*` values that point somewhere real, or
 * the database service's own (`providerVariablePrefixes` in
 * `hosted-deployment.mjs`; none in the public tree).
 *
 * Every URL `readDatabaseUrl` can select is then *set*, not merely removed:
 * `with-root-env.mjs` fills only unset variables from the worktree's
 * `.env.local`, so a removed one could come back from that file. With
 * `DATABASE_URL` and `REQUESTPORT_PREVIEW_DATABASE_URL` both naming the track
 * database, the `VERCEL_ENV` the file may supply changes which is read and not
 * what it says.
 */
export function childEnvironment(env, databaseUrl) {
  assertLocalDatabaseUrl(databaseUrl);
  const kept = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !DROPPED_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
        key !== "REQUESTPORT_LOCAL_DATABASE_URL",
    ),
  );

  return {
    ...kept,
    DATABASE_URL: databaseUrl,
    REQUESTPORT_LOCAL_DATABASE_URL: databaseUrl,
    REQUESTPORT_PREVIEW_DATABASE_URL: databaseUrl,
  };
}

/** What a kept `.env.local` means, said where nobody can miss it. */
export function keptEnvWarning(path, database) {
  return [
    `WARNING: ${path} was already there, and was kept without being read.`,
    "",
    "This script did not write it and cannot say which database it names. The",
    `migration above was pinned to ${database} regardless, but verify-locally.mjs`,
    "and every other command run in this worktree will use whatever that file",
    "says. Check it, or move it aside and run this again to get a generated one.",
    "",
    "For the same reason no application login was made: pnpm dev's application",
    "connects through REQUESTPORT_APPLICATION_DATABASE_URL, which only a file",
    "written here names. Moving the file aside and running this again makes both.",
  ].join("\n");
}

/**
 * An existing path is used only if it is this repository's worktree on the
 * track's branch; anything else there is somebody else's, and nothing is
 * written into it.
 */
export function assertTrackWorktree(root, layout, spawn = spawnSync) {
  const ask = (args) =>
    spawn("git", ["-C", layout.worktree, "rev-parse", ...args], {
      encoding: "utf8",
    });
  const common = ask(["--path-format=absolute", "--git-common-dir"]);
  const head = ask(["--abbrev-ref", "HEAD"]);
  const ours =
    common.status === 0 &&
    (common.stdout ?? "").trim() === join(root, ".git") &&
    head.status === 0 &&
    (head.stdout ?? "").trim() === layout.branch;

  if (!ours) {
    throw new Refusal(
      `${layout.worktree} exists but is not this repository's worktree on ${layout.branch}. Nothing was changed there.`,
    );
  }
}

/** The stack's one container, the local database, running. */
export function localStackRunning(spawn = spawnSync) {
  const probe = spawn(
    "docker",
    ["inspect", "--format", "{{.State.Running}}", LOCAL_DATABASE_CONTAINER],
    { encoding: "utf8" },
  );

  if (probe.status !== 0) return false;
  const states = (probe.stdout ?? "").trim().split(/\s+/u);

  return states.length === 1 && states[0] === "true";
}

function psql(spawn, statement) {
  return spawn(
    "docker",
    [
      "exec",
      LOCAL_DATABASE_CONTAINER,
      "psql",
      "-X",
      "-At",
      "-U",
      LOCAL_DATABASE_USER,
      "-d",
      MAINTENANCE_DATABASE,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ],
    { encoding: "utf8" },
  );
}

/**
 * Create the track's database unless it exists. The name has already passed
 * `TRACK_NAME` and `assertLocalDatabaseUrl`, so it is `[a-z0-9_]` only and is
 * safe to place in the statement.
 */
export function ensureDatabase(database, spawn = spawnSync) {
  if (!/^rp_track_[a-z0-9_]{1,41}$/u.test(database)) {
    throw new Refusal(`Refusing an unexpected database name: ${database}`);
  }

  const found = psql(
    spawn,
    `select 1 from pg_database where datname = '${database}'`,
  );
  if (found.status !== 0) {
    throw new Refusal(`Could not ask the local server about ${database}.`);
  }
  if ((found.stdout ?? "").trim() === "1") return "exists";

  const created = psql(spawn, `create database "${database}"`);
  if (created.status !== 0) {
    throw new Refusal(`Could not create ${database}.`);
  }

  return "created";
}

/**
 * Make the track's application login, replacing one an earlier run left: a
 * login with the password given and nothing else (no superuser, `BYPASSRLS`,
 * `CREATEDB`, `CREATEROLE` or replication), a member of
 * `requestport_application` alone, stored with one SCRAM iteration, as the
 * application-role lane and the acceptance server make theirs. One
 * transaction, through the stack's own `psql`, with the statement on standard
 * input so that the password is on no command line. The name is one only
 * this script makes (`applicationLoginName`), and this script grants the
 * login nothing beyond its membership, so dropping one an earlier run made
 * meets no dependency; a role of that name made by hand would be dropped
 * too. The name and the password have passed their patterns, so both are
 * safe in the statement. A failure names the login, never the password.
 */
export function ensureApplicationLogin(database, password, spawn = spawnSync) {
  const login = applicationLoginName(database);
  assertApplicationPassword(password);
  const statement = [
    "SET scram_iterations = 1;",
    `DROP ROLE IF EXISTS "${login}";`,
    `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' ` +
      "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION " +
      `IN ROLE ${APPLICATION_GROUP};`,
    "",
  ].join("\n");
  const made = spawn(
    "docker",
    [
      "exec",
      "-i",
      LOCAL_DATABASE_CONTAINER,
      "psql",
      "-X",
      "-At",
      "-U",
      LOCAL_DATABASE_USER,
      "-d",
      MAINTENANCE_DATABASE,
      "-v",
      "ON_ERROR_STOP=1",
      "-1",
      "-f",
      "-",
    ],
    { encoding: "utf8", input: statement },
  );

  if (made.status !== 0) {
    throw new Refusal(
      `Could not make the application login ${login} (exit ${made.status ?? "signal"}).`,
    );
  }

  return login;
}

/** The main checkout's root, found from wherever this script is run. */
export function mainRepositoryRoot(scriptRoot, spawn = spawnSync) {
  const common = spawn(
    "git",
    [
      "-C",
      scriptRoot,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    { encoding: "utf8" },
  );
  const directory = (common.stdout ?? "").trim();
  if (common.status !== 0 || directory === "") {
    throw new Refusal("Not inside a git checkout.");
  }

  return dirname(directory);
}

function run(spawn, command, args, options, what) {
  const outcome = spawn(command, args, { stdio: "inherit", ...options });
  if (outcome.status !== 0) {
    throw new Refusal(`${what} failed (exit ${outcome.status ?? "signal"}).`);
  }
}

/**
 * The whole sequence. Every refusal happens before anything is created: the
 * name, the database URL, the stack and an existing worktree path are checked
 * first.
 */
export function createTrackWorktree({
  argv,
  scriptRoot,
  env = process.env,
  spawn = spawnSync,
  exists = existsSync,
  fs = { writeFileSync, chmodSync },
  secret = generateSecret,
  applicationPassword = generateApplicationPassword,
  log = console.log,
  warn = console.error,
}) {
  const { name, base } = parseArguments(argv);
  const root = mainRepositoryRoot(scriptRoot, spawn);
  const layout = trackLayout(root, name);
  assertLocalDatabaseUrl(layout.databaseUrl);

  if (!localStackRunning(spawn)) throw new Refusal(STACK_NOT_RUNNING);
  const reuse = exists(layout.worktree);
  if (reuse) assertTrackWorktree(root, layout, spawn);

  run(
    spawn,
    "git",
    ["-C", root, "fetch", "origin", "--quiet"],
    {},
    "git fetch",
  );

  let worktree = "exists";
  if (!reuse) {
    run(
      spawn,
      "git",
      [
        "-C",
        root,
        "worktree",
        "add",
        layout.worktree,
        "-b",
        layout.branch,
        base,
      ],
      {},
      "git worktree add",
    );
    worktree = "created";
  }

  const database = ensureDatabase(layout.database, spawn);

  const password = applicationPassword();
  const envFile = writeTrackEnv(
    join(layout.worktree, ".env.local"),
    renderTrackEnv({
      name,
      databaseUrl: layout.databaseUrl,
      secret: secret(),
      applicationPassword: password,
    }),
    fs,
  );

  const childEnv = childEnvironment(env, layout.databaseUrl);
  run(
    spawn,
    "pnpm",
    ["install", "--frozen-lockfile"],
    { cwd: layout.worktree, env: childEnv },
    "pnpm install",
  );
  run(
    spawn,
    "pnpm",
    ["--filter", "@requestport/db", "db:migrate"],
    { cwd: layout.worktree, env: childEnv },
    "migration",
  );

  // Only for a file written here, which holds this password; a kept file's
  // login, if it names one, is left exactly as it is.
  const applicationLogin =
    envFile === "written"
      ? ensureApplicationLogin(layout.database, password, spawn)
      : undefined;

  const summary = {
    ...layout,
    base,
    worktreeState: worktree,
    databaseState: database,
    envFile,
    applicationLogin,
  };
  log(
    `track=${name} worktree=${layout.worktree} (${worktree}) branch=${layout.branch} base=${base} database=${layout.database} (${database}) .env.local=${envFile} application-login=${applicationLogin ?? "none"}`,
  );
  if (envFile === "kept") {
    warn(keptEnvWarning(join(layout.worktree, ".env.local"), layout.database));
  }

  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    createTrackWorktree({
      argv: process.argv.slice(2),
      scriptRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
