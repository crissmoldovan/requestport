import { createHash } from "node:crypto";

import * as sharedDatabases from "./shared-databases.js";

const INVALID_DATABASE_CONFIGURATION =
  "RequestPort database configuration is invalid.";

/**
 * The scheme, host and database-name rules every connection string here must
 * meet. Throws the one fixed message, which never echoes the string.
 */
function parseDatabaseUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(INVALID_DATABASE_CONFIGURATION);
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      !url.hostname ||
      !url.pathname.startsWith("/") ||
      url.pathname.length === 1
    ) {
      throw new Error(INVALID_DATABASE_CONFIGURATION);
    }
    return url;
  } catch {
    throw new Error(INVALID_DATABASE_CONFIGURATION);
  }
}

/**
 * `value`, held to the rules every connection string here meets (the scheme,
 * a host and a database name), or the one fixed message, which never echoes
 * it. For a URL read from a variable of its own, such as the worker's three
 * (`tenant-context.ts`).
 */
export function validDatabaseUrl(value: unknown): string {
  parseDatabaseUrl(value);
  return value as string;
}

/**
 * The owner's connection string: `DATABASE_URL`, or a preview's own variable.
 *
 * Migrations (`drizzle.config.ts`) and the test helpers read this one, and
 * must keep reading it: only the owner can run DDL (manifest-i2.md §2.6). So
 * does every storage built with `storageOptionsFromEnv` (`client.ts`): every
 * composition root's but the application's, and each suite's and fixture's
 * built with it (I.2 step 5, slice 1).
 */
export function readDatabaseUrl(env: NodeJS.ProcessEnv) {
  const value =
    env.VERCEL_ENV === "preview"
      ? env.REQUESTPORT_PREVIEW_DATABASE_URL
      : env.DATABASE_URL;

  parseDatabaseUrl(value);

  return value as string;
}

/**
 * The application's own connection string (Plan 13, Track I.2;
 * manifest-i2.md §1): a role that owns nothing and cannot bypass row-level
 * security. It was set in Vercel Production at the switch (§3 step 3,
 * 2026-10-15). Only the application root reads it
 * (`applicationStorageOptionsFromEnv` in `client.ts`, through
 * `readApplicationDatabaseUrl`), and outside a preview it is the only URL
 * that root reads (§3 step 5).
 */
export const APPLICATION_DATABASE_URL_VARIABLE =
  "REQUESTPORT_APPLICATION_DATABASE_URL";

/** A preview's own connection string, which it reads in place of every other. */
const PREVIEW_DATABASE_URL_VARIABLE = "REQUESTPORT_PREVIEW_DATABASE_URL";

/**
 * Whether the application variable is in use: it is set to something other
 * than blanks, and this is not a preview. A preview reads its own variable
 * and nothing else, so it can never pick up a production application URL
 * (§2.8 item 2). Outside a preview the application root can connect only
 * when this holds: `readApplicationDatabaseUrl` refuses otherwise (§3 step
 * 5).
 *
 * This is also the switch that turns on the wrapping of pool reads in bound
 * transactions (ruling 17, open question 8; `tenantWrappingEnabled` in
 * `tenant-context.ts`), for every composition root but the application's,
 * which is wrapped whatever it answers (`wiring.ts`).
 */
export function applicationDatabaseUrlSelected(env: NodeJS.ProcessEnv) {
  if (env.VERCEL_ENV === "preview") return false;

  const value = env[APPLICATION_DATABASE_URL_VARIABLE];

  return typeof value === "string" && value.trim() !== "";
}

/**
 * The connection string the application root's storage dials
 * (`applicationStorageOptionsFromEnv` in `client.ts`): the application
 * variable, or under `VERCEL_ENV=preview` the preview's own variable, and
 * nothing else. Since §3 step 5 it never reads `DATABASE_URL`, the owner's:
 * with its variable unset, blank or malformed it refuses, naming the
 * variable and never a value. No other storage reads it.
 */
export function readApplicationDatabaseUrl(env: NodeJS.ProcessEnv) {
  return readNamedDatabaseUrl(
    env,
    env.VERCEL_ENV === "preview"
      ? PREVIEW_DATABASE_URL_VARIABLE
      : APPLICATION_DATABASE_URL_VARIABLE,
  );
}

/**
 * The connection string the variable `name` holds, held to the rules every
 * connection string here meets. Unset or blank, or malformed, it refuses
 * with the fixed message and the variable's name, never its value.
 */
function readNamedDatabaseUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${INVALID_DATABASE_CONFIGURATION} ${name} is not set: the ` +
        "application's storage connects only through it, never through " +
        "DATABASE_URL.",
    );
  }

  try {
    parseDatabaseUrl(value);
  } catch {
    throw new Error(
      `${INVALID_DATABASE_CONFIGURATION} ${name} is not a postgres URL ` +
        "naming a host and a database.",
    );
  }

  return value;
}

/**
 * The `PG*` variables no client configuration can neutralise
 * (track-e.md, contract §2.2 and §3.4 layer 3).
 *
 * `pg` and the hosted driver fill a field from `PG<FIELD>` whenever the config
 * leaves it falsy. `PGOPTIONS` (which can set `search_path` or `role`),
 * `PGREPLICATION` and `PGBINARY` have no value that means "off";
 * `PGAPPNAME` and `PGCLIENT_ENCODING` could be overridden only by sending a
 * value of our own; and `PGSSLNEGOTIATION=direct` makes `pg` throw whenever
 * TLS is off. So while any of them is set the pg path refuses to connect.
 */
export const UNOVERRIDABLE_PG_VARIABLES = [
  "PGOPTIONS",
  "PGAPPNAME",
  "PGREPLICATION",
  "PGBINARY",
  "PGCLIENT_ENCODING",
  "PGSSLNEGOTIATION",
] as const;

/**
 * Refuse while a variable from `UNOVERRIDABLE_PG_VARIABLES` is set and
 * non-empty. The message names the variable and never its value.
 *
 * The pg path calls this on every client construction, because the driver
 * reads these on every construction (`pg-pool` builds a new client from the
 * same options each time the pool grows), so a variable set after the pool
 * was created is caught too.
 */
export function refuseUnoverridablePgVariables(env: NodeJS.ProcessEnv): void {
  for (const name of UNOVERRIDABLE_PG_VARIABLES) {
    const value = env[name];

    if (typeof value === "string" && value !== "") {
      throw new Error(
        `RequestPort refuses to open a pg connection while ${name} is set: ` +
          "pg would apply it and no connection setting can override it. " +
          `Unset ${name} for this process.`,
      );
    }
  }
}

/**
 * The query parameters pg would take in place of the host, port, user or
 * password the authority names. pg-connection-string copies every query
 * parameter into the config and lets these win, so
 * `postgresql://u:p@127.0.0.1/app?host=elsewhere` dials elsewhere while every
 * check that reads the URL's host sees loopback. `hostaddr` is libpq's; pg
 * does not read it today, and it is refused all the same.
 */
export const PG_TARGET_QUERY_PARAMETERS = [
  "host",
  "hostaddr",
  "port",
  "user",
  "password",
] as const;

export interface IsolatedPgConnectionOptions {
  /** Replaces the URL's password; the only way to connect with an empty one. */
  password?: () => string | Promise<string>;
}

/**
 * The connection string the pg path hands its driver, with nothing left for
 * `PG*` to fill (contract §3.4 layers 1 and 2).
 *
 * `pg` parses the string and lets the result override every field it was
 * also given, and the parser writes `""` for a missing user, password or
 * port — which `pg` then treats as absent and takes from `PGUSER`,
 * `PGPASSWORD` or `PGPORT`. So the string itself has to carry them:
 *
 * - no user, or no password (or an empty one) without a `password`
 *   function, is refused, naming what is missing and never the string;
 * - a query parameter from `PG_TARGET_QUERY_PARAMETERS` is refused, naming
 *   the parameter and never its value, so the authority is the only place the
 *   string says where it connects and as whom;
 * - a missing port is written out as 5432, PostgreSQL's own default.
 *
 * `ssl` and the connect timeout are not in the string; the pg client sets
 * them explicitly beside it (see `client.ts`).
 */
export function isolatedPgConnectionString(
  value: string,
  options: IsolatedPgConnectionOptions = {},
): string {
  const url = parseDatabaseUrl(value);

  if (!url.username) {
    throw new Error(
      "RequestPort's pg connection string names no user; refusing to let " +
        "PGUSER supply one. Put the user in the connection string.",
    );
  }

  if (!url.password && options.password === undefined) {
    throw new Error(
      "RequestPort's pg connection string has no password or an empty one; " +
        "refusing to let PGPASSWORD or a password file supply one. Put the " +
        "password in the connection string, or pass a password function.",
    );
  }

  for (const name of PG_TARGET_QUERY_PARAMETERS) {
    if (url.searchParams.has(name)) {
      throw new Error(
        `RequestPort's pg connection string carries the query parameter "${name}", ` +
          "which pg would use in place of the one before the query. " +
          "Put the host, port, user and password before the `?`, and nowhere else.",
      );
    }
  }

  if (!url.port) url.port = "5432";

  return url.toString();
}

/*
 * The shared databases the pg path refuses without an opt-in (contract §3.4,
 * last paragraph) are `./shared-databases.ts`'s entries, imported statically
 * at the top of this file (ruling 91, option (d)). That module is private: the
 * public seed carries `shared-databases.public.ts` at its path, which names
 * none. It holds the entries of `scripts/hosted-deployment.mjs`, the list the
 * entry-point guard reads, because a published package cannot import a script
 * from this repository; `scripts/workspace-contract.test.mjs` fails if the two
 * differ, `kind` included. The digests, the normalisation and the exact
 * `approved` opt-in are the guard's (`scripts/production-database-guard.mjs`),
 * and its comments and the private module's give the reasons for each.
 */
const SHARED_DATABASE_APPROVAL = "approved";
const SHARED_DATABASE_KEYS = [
  "databaseNameSha256",
  "hostSha256",
  "name",
  "optIn",
].join();
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const SHARED_DATABASE_NAME = /^[a-z][a-z0-9-]*$/u;
const SHARED_DATABASE_OPT_IN = /^REQUESTPORT_[A-Z0-9_]+_DATABASE$/u;

/** What the refusal throws when the list itself is wrong. It quotes nothing from the list. */
export const SHARED_DATABASE_LIST_MALFORMED =
  "RequestPort refuses this connection: the shared-database list is malformed (packages/db/src/shared-databases.ts), so every connection the refusal judges is refused until it is fixed.";

/** A list the refusal compares against: `./shared-databases.ts`'s exports, or a test's. */
export interface SharedDatabaseList {
  readonly kind: unknown;
  readonly entries: unknown;
}

/** One shared database, as a well-formed list names it. */
export interface SharedDatabaseEntry {
  readonly name: string;
  readonly hostSha256: string;
  readonly databaseNameSha256: string | null;
  readonly optIn: string;
}

/**
 * The entries `list` names, once checked; by default `./shared-databases.ts`'s.
 *
 * Well formed, as the guard's `sharedDatabasesOf` has it: `kind` exactly
 * `"private"` with at least one entry, or exactly `"public"` with none; every
 * entry an object with exactly `name`, `hostSha256`, `databaseNameSha256` and
 * `optIn`, where `name` is a lower-case word used once, `hostSha256` is 64
 * lower-case hex characters, `databaseNameSha256` is `null` or 64 lower-case
 * hex characters, and `optIn` is a variable named `REQUESTPORT_<…>_DATABASE`.
 * Anything else throws `SHARED_DATABASE_LIST_MALFORMED`.
 */
export function sharedDatabasesOf(
  list: SharedDatabaseList = sharedDatabases,
): readonly SharedDatabaseEntry[] {
  const malformed = () => new Error(SHARED_DATABASE_LIST_MALFORMED);
  if (list === null || typeof list !== "object") throw malformed();
  const { kind, entries } = list;
  if (!Array.isArray(entries)) throw malformed();
  const shapeFits =
    (kind === "private" && entries.length > 0) ||
    (kind === "public" && entries.length === 0);
  if (!shapeFits) throw malformed();
  const names = new Set<string>();
  for (const entry of entries as unknown[]) {
    if (entry === null || typeof entry !== "object") throw malformed();
    const fields = entry as Record<string, unknown>;
    if (Object.keys(fields).sort().join() !== SHARED_DATABASE_KEYS) {
      throw malformed();
    }
    const { name, hostSha256, databaseNameSha256, optIn } = fields;
    if (
      typeof name !== "string" ||
      !SHARED_DATABASE_NAME.test(name) ||
      names.has(name)
    ) {
      throw malformed();
    }
    names.add(name);
    if (typeof hostSha256 !== "string" || !HEX_DIGEST.test(hostSha256)) {
      throw malformed();
    }
    if (
      databaseNameSha256 !== null &&
      (typeof databaseNameSha256 !== "string" ||
        !HEX_DIGEST.test(databaseNameSha256))
    ) {
      throw malformed();
    }
    if (typeof optIn !== "string" || !SHARED_DATABASE_OPT_IN.test(optIn)) {
      throw malformed();
    }
  }
  return entries as readonly SharedDatabaseEntry[];
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * A host as the drivers read it. pg-connection-string percent-decodes the
 * authority's host, and WHATWG URL leaves a `postgres:` host encoded, so
 * without this a host with each `-` written `%2D` would reach the comparison
 * as typed and the driver decoded.
 * A sequence that does not decode is left as it is. A query `host` arrives
 * here already decoded once by `searchParams`; decoding it again can only
 * widen what is refused, since no real host name contains `%`.
 */
function percentDecoded(hostname: string): string {
  try {
    return decodeURIComponent(hostname);
  } catch {
    return hostname;
  }
}

/**
 * The host a hosted database settles to: a trailing dot and the first label's
 * `-pooler` suffix removed, as `normalizeDatabaseHostname` in the script does,
 * and percent-decoded and lowercased, which the script does not do. WHATWG URL lowercases a host
 * only for special schemes and `postgres:` is not one, while DNS ignores case,
 * so without it `EP-…` would reach production unrefused.
 */
function normalizedHostname(hostname: string): string {
  const [first = "", ...rest] = percentDecoded(hostname)
    .toLowerCase()
    .replace(/\.$/u, "")
    .split(".");
  return [first.replace(/-pooler$/u, ""), ...rest].join(".");
}

/**
 * Refuse a connection to a shared database `list` names, unless `env` carries
 * that database's opt-in set to exactly `approved`. By default the list is
 * `./shared-databases.ts`'s: production, and staging's own database, in the
 * private tree; none in the public seed. A test hands in its own. The list is
 * checked first, on every call and before any early return
 * (`sharedDatabasesOf`), so a malformed one refuses every call.
 *
 * Its callers: the pg path of a storage built from the environment, on every
 * client construction (`storageOptionsFromEnv` and
 * `applicationStorageOptionsFromEnv` in `client.ts`, one of which each
 * composition root's storage takes); the worker's bound storages, on pg
 * (`createWorkerStorages`); the storage `./e2e` builds in E2E mode
 * (`e2e-owner-storage.ts`); `createTestStorage`
 * in `testing.ts`, for either driver, before a suite's own storage exists;
 * `openOperatorSession`, on every owner connection; and, by default,
 * `requestport`'s operator step and `owner rotate-credential` (H.4).
 *
 * A storage built from the environment calls it on pg only, and that is the
 * point of it. On the hosted driver that storage is production's own on
 * Vercel (each root's), so it must not refuse there. Locally, with the
 * driver's proxy variable set, the hosted driver is handed a proxy address
 * that names no host (`hosted-driver.ts`), and the proxy, started with
 * `APPEND_PORT=db:5432`, connects to the local database whatever host the URL
 * names. pg dials the URL's host directly, so a checkout whose `.env.local`
 * names production would otherwise put every integration suite run under
 * `REQUESTPORT_DATABASE_DRIVER=pg` on it.
 *
 * It judges the URL the process is about to use, which under
 * `VERCEL_ENV=preview` is the preview variable, not `DATABASE_URL`, and every
 * host that URL names as the drivers read it: the authority's, percent-decoded,
 * and each `host` in the query, which pg and the hosted driver both take in
 * the authority's place (measured 2026-09-28 on pg 8.23.0 and on the hosted
 * driver's 1.1.0). A string
 * this cannot parse is left to the driver's own checks (on pg,
 * `isolatedPgConnectionString`, which refuses it).
 * The message names the database and the opt-in, never the host or the URL.
 */
export function refuseUnapprovedSharedPgDatabase(
  connectionString: string,
  env: NodeJS.ProcessEnv,
  list: SharedDatabaseList = sharedDatabases,
): void {
  const shared = sharedDatabasesOf(list);
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return;
  }

  // Every host the string names: the authority's, and each `host` in the
  // query, which both drivers read in its place (the last one wins there).
  const hostDigests = [
    url.hostname,
    ...url.searchParams.getAll("host").filter((host) => host !== ""),
  ].map((host) => sha256Hex(normalizedHostname(host)));
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    databaseName = "";
  }
  const nameDigest = sha256Hex(databaseName);

  for (const database of shared) {
    if (!hostDigests.includes(database.hostSha256)) continue;
    if (
      database.databaseNameSha256 !== null &&
      nameDigest !== database.databaseNameSha256
    ) {
      continue;
    }
    if (env[database.optIn] === SHARED_DATABASE_APPROVAL) return;

    throw new Error(
      `RequestPort would connect to the ${database.name} database. ` +
        `Set ${database.optIn}=${SHARED_DATABASE_APPROVAL} to do that ` +
        "deliberately, or point the connection string somewhere else.",
    );
  }
}
