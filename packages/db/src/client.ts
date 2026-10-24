import { createRequire } from "node:module";
import type * as PgliteModule from "@electric-sql/pglite";
import type * as PgliteCitextModule from "@electric-sql/pglite/contrib/citext";
import { sql } from "drizzle-orm";
import type * as NodePgDriver from "drizzle-orm/node-postgres";
import type {
  PgDatabase,
  PgQueryResultHKT,
  PgTransactionConfig,
} from "drizzle-orm/pg-core";
import type * as PgliteDriver from "drizzle-orm/pglite";
import type * as Pg from "pg";

import {
  isolatedPgConnectionString,
  readApplicationDatabaseUrl,
  readDatabaseUrl,
  refuseUnapprovedSharedPgDatabase,
  refuseUnoverridablePgVariables,
} from "./database-url.js";
import {
  createHostedStorage,
  DEFAULT_DRIVER,
  type HostedDriver,
  type HostedPool,
  isHostedDriver,
  UNRECOGNISED_DRIVER_ADVICE,
} from "./hosted-driver.js";
import { readRetryFor, withReadRetry } from "./read-retry.js";
import {
  type DatabaseRoleGuard,
  DatabaseRoleGuardError,
  DatabaseSurfaceError,
} from "./role-guard.js";
import * as schema from "./schema/index.js";
import type { Tx } from "./transaction.js";

/*
 * The driver seam (Plan 13, Track E.2; the contract is
 * docs/implementation/plans/2026-09-27-13/track-e.md, "The storage contract").
 *
 * Up to three drivers, one surface. The hosted driver is `hosted-driver.ts`'s.
 * Where that module is the private one, the hosted driver is the default,
 * built exactly as it was before this seam existed, so no process already in
 * production changes driver, and `pg` is used only when
 * REQUESTPORT_DATABASE_DRIVER=pg says so; where it is the public tree's
 * variant there is no hosted driver, and pg is the default (J.2b; ruling
 * 175). PGlite is used only when REQUESTPORT_DATABASE_DRIVER=pglite says so,
 * with its database named in REQUESTPORT_PGLITE_DATA_DIR. PGlite is a
 * supported storage for one user in one process
 * (docs/specs/2026-09-27-requestport-open-core-distribution.md §1;
 * manifest-h.md §2.6), and this package's `test:pglite` lane runs its suites
 * on it. It has one connection, so a PGlite storage is single-session.
 */

export const DATABASE_DRIVER_VARIABLE = "REQUESTPORT_DATABASE_DRIVER";

/** PGlite's own variable: the directory its database is in, or `memory://`. */
export const PGLITE_DATA_DIR_VARIABLE = "REQUESTPORT_PGLITE_DATA_DIR";

export type DatabaseDriver = HostedDriver | "pg" | "pglite";

/**
 * Which driver this process uses.
 *
 * Unset or empty selects `hosted-driver.ts`'s `DEFAULT_DRIVER`, whatever else
 * the environment says: the Trigger.dev worker does not run on Vercel and
 * nothing sets `VERCEL_ENV` for it, so a rule keyed on `VERCEL_ENV` would have
 * moved it (contract §2.3; the ruling is in wave1-integration.md). The hosted
 * driver's own name, where the tree has one, selects that driver. `pg`
 * selects pg, and no other value does.
 * `pglite` selects PGlite, single-session storage for one user in one
 * process, and is refused wherever `VERCEL_ENV` is set, empty included:
 * every Vercel deployment sets it, and a deployment that serves many people
 * is not one to serve from a single connection. Any other value is refused
 * rather than ignored, and the message does not echo the value.
 */
export function selectDriver(env: NodeJS.ProcessEnv): DatabaseDriver {
  const value = env[DATABASE_DRIVER_VARIABLE];

  if (value === undefined || value === "") return DEFAULT_DRIVER;
  if (isHostedDriver(value)) return value;
  if (value === "pg") return "pg";
  if (value === "pglite") {
    if (env.VERCEL_ENV !== undefined) {
      throw new Error(
        `${DATABASE_DRIVER_VARIABLE}=pglite selects PGlite, single-session ` +
          "storage for one user in one process, which no Vercel deployment " +
          "serves from. Unset it.",
      );
    }
    return "pglite";
  }

  throw new Error(
    `${DATABASE_DRIVER_VARIABLE} is set to a value this build does not ` +
      `recognise. ${UNRECOGNISED_DRIVER_ADVICE}`,
  );
}

/** The result shape every driver shares: rows, and nothing else. */
export interface RowsResult<Row> {
  rows: Row[];
}

export interface RowsResultHKT extends PgQueryResultHKT {
  type: RowsResult<
    this["row"] extends Record<string, unknown>
      ? this["row"]
      : Record<string, unknown>
  >;
}

export type Schema = typeof schema;

/**
 * A database handle that names no driver (contract §3.1).
 *
 * Only `rows` is read from a result anywhere in this package, and every
 * driver's result carries it; `rowCount`, `fields` and the rest are what
 * differ, so they are not part of this type.
 */
export type Database = PgDatabase<RowsResultHKT, Schema>;

/**
 * The part of a pool the test suites reach through `testing.ts`'s accessors
 * (contract §4.3), which both pool drivers' pools satisfy, and PGlite's
 * single-session stand-in below.
 */
export interface TestQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface TestSessionClient {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the drivers' own default row type
  query<Row extends Record<string, any> = any>(
    text: string,
    values?: unknown[],
  ): Promise<TestQueryResult<Row>>;
  release(error?: Error | boolean): void;
}

export interface TestPool {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the drivers' own default row type
  query<Row extends Record<string, any> = any>(
    text: string,
    values?: unknown[],
  ): Promise<TestQueryResult<Row>>;
  connect(): Promise<TestSessionClient>;
  end(): Promise<void>;
}

/**
 * A handle as Drizzle builds it, with the pool it holds as `$client`. Only
 * this module's builders and `testing.ts`'s accessor use it: the package's
 * public surface hands out `Database`, which carries no `$client`, since G.5
 * retired `db`, the one export typed with it (Plan 13).
 */
export type DatabaseWithTestPool = Database & { $client: TestPool };

export interface PoolLimits {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

/**
 * Whether a pool read through the storage runs in a transaction bound to its
 * organisation (manifest-g.md §2.2; `withTenant` in `tenant-context.ts`):
 * `"wrapped"`, which a role under row security needs, or `"off"`, which runs
 * it on the pool in no transaction.
 */
export type TenantBinding = "wrapped" | "off";

export interface StorageOptions {
  driver: DatabaseDriver;
  /**
   * pg and the hosted driver: the database, required. A function is called
   * each time the pool constructs a client, which is how a storage built from
   * the environment (`storageOptionsFromEnv`,
   * `applicationStorageOptionsFromEnv`) reads its URL when it connects rather
   * than when it is built.
   */
  connectionString?: string | (() => string);
  /** pglite only, required: a directory, or `memory://`. */
  dataDir?: string;
  /** pg only: replaces the URL's password (contract §3.4 layer 2). */
  password?: () => string | Promise<string>;
  /**
   * pg only: defaults to `PG_POOL_LIMITS`. The hosted driver's pool keeps its
   * own (`hosted-driver.ts`).
   */
  pool?: PoolLimits;
  /**
   * Ask a dropped read once more. The hosted driver: on by default. pg,
   * pglite: refused.
   */
  readRetry?: boolean;
  /**
   * The role guard (`role-guard.ts`), which outside tests each composition
   * root's storage (`wiring.ts`) and each of the worker's bound storages
   * (`createWorkerStorages`) are given. Its declaration and environment
   * checks run each time a connection string is read — for PGlite, first
   * inside its lazy constructor — and its role check once, before the
   * storage's first use runs (`installRoleCheck`).
   */
  guard?: DatabaseRoleGuard;
  /**
   * Recorded against the storage's `db`, which `withTenant` and the
   * appearance read consult whenever they are handed it as a pool
   * (`tenantBindingFor`). Absent, `"wrapped"` is recorded (manifest-g.md
   * §2.2, ruling 118): a caller who says nothing gets bound reads, the only
   * mode in which a role under row security reads a tenant's rows. Each
   * composition root derives its own from this process's environment when it
   * builds (`wiring.ts`).
   */
  tenantBinding?: TenantBinding;
}

export interface Storage {
  readonly driver: DatabaseDriver;
  readonly db: Database;
  transaction<T>(
    work: (tx: Tx) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T>;
  /** `select 1`, the readiness probe. */
  ready(): Promise<void>;
  /** Ends the pool, or closes PGlite. Idempotent: every call returns the same promise. */
  close(): Promise<void>;
}

/**
 * The pg pool's limits when none are given.
 *
 * `max` and `idleTimeoutMillis` are `pg-pool`'s own defaults, which the hosted
 * driver's pool, where the tree has one, also runs with, so choosing a driver
 * does not change how many connections a process opens or how long an idle
 * one lives. The connect
 * timeout is the one real choice: `pg-pool` waits for a connection forever
 * by default, and 15 seconds is below this package's 30-second test budget,
 * so a connection that cannot be had fails with its own message instead of a
 * test timeout.
 */
export const PG_POOL_LIMITS: Readonly<PoolLimits> = Object.freeze({
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
});

type DriverPool = HostedPool | Pg.Pool;

/** What Drizzle holds for a storage: the driver's pool, or PGlite's stand-in. */
export type StorageClient = DriverPool | SingleSessionPglite;

const clients = new WeakMap<Storage, StorageClient>();

/**
 * What Drizzle holds behind a storage — the object its handle keeps as
 * `$client`, which the public `Database` type does not show. For
 * `testing.ts`, `migrate.ts` and this package's own tests; not exported from
 * the package barrel.
 */
export function storageClientOf(storage: Storage): StorageClient {
  const client = clients.get(storage);

  if (client === undefined) {
    throw new Error("Not a storage created by createStorage.");
  }
  return client;
}

/**
 * The driver's own pool behind a pg storage, or one on the hosted driver. A
 * PGlite storage has none, and is refused.
 */
export function driverPoolOf(storage: Storage): DriverPool {
  const client = storageClientOf(storage);

  if (client instanceof SingleSessionPglite) {
    throw new Error("A PGlite storage has no pool: it has one connection.");
  }
  return client;
}

function reportPoolError() {
  console.error("Unexpected database pool error.");
}

function readerOf(connectionString: StorageOptions["connectionString"]) {
  if (connectionString === undefined) {
    throw new Error(
      "The server drivers need a connection string; only PGlite takes a " +
        "dataDir instead.",
    );
  }
  return typeof connectionString === "function"
    ? connectionString
    : () => connectionString;
}

/**
 * The connection-string read, with the guard's declaration and environment
 * checks in front of it when the storage has a guard: nothing is read, and
 * so nothing dialled, before they have run.
 */
function guardedReaderOf(options: StorageOptions) {
  const read = readerOf(options.connectionString);
  const guard = options.guard;

  if (guard === undefined) return read;
  return () => {
    guard.beforeConnect();
    return read();
  };
}

function refuseDataDir(driver: DatabaseDriver, options: StorageOptions) {
  if (options.dataDir !== undefined) {
    throw new Error(
      `A dataDir is only taken by the PGlite driver; the ${driver} driver ` +
        "takes a connection string.",
    );
  }
}

/*
 * pg is loaded only when a storage asks for it: loading this module evaluates
 * neither `pg` nor Drizzle's pg driver (a probe loading `client.ts` with the
 * variable unset counts none of their modules). That is a claim about
 * evaluation, not about the build. Webpack parses `createRequire` for node
 * targets, so `next build --webpack` still puts both modules in the web
 * server's bundle graph, evaluated lazily, with `pg` external; the Trigger
 * worker's esbuild bundle has not been inspected. Neither build is proved
 * here — the `--e2e` build and the Vercel preview check are.
 */
const requireFromHere = createRequire(import.meta.url);

export function loadPgDriver() {
  return {
    pg: requireFromHere("pg") as typeof Pg,
    drizzle: (
      requireFromHere("drizzle-orm/node-postgres") as typeof NodePgDriver
    ).drizzle,
  };
}

/*
 * The role check, run once per storage before its first use (manifest-i2.md
 * §2.2). Every way Drizzle, the readiness probe, `testing.ts` and
 * `migrate()` reach a connection goes through the client's `query`,
 * `connect` or — PGlite's — `transaction`, so each is patched on the
 * instance to wait for the check first. Patched, not wrapped: Drizzle asks
 * `client instanceof Pool`, as `withReadRetry` says.
 *
 * The check itself runs through the unpatched `query`. A pool's callback
 * forms are left untouched: pg's own `query` checks a client out through
 * `connect(callback)`, so gating that form too would gate each query twice,
 * and the check's own query would wait for itself. Nothing here calls
 * `query` with a callback.
 *
 * A check that refused stays refused: every later use rejects with the same
 * error. A check that could not run — the connection failed — throws the
 * connection's error, which is not a refusal, so `checked` is cleared and
 * the next use asks again. A cold start that cannot reach the database still
 * has its role judged once it can.
 */
function installRoleCheck(
  client: StorageClient,
  guard: DatabaseRoleGuard,
  driver: DatabaseDriver,
) {
  const target = client as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const query = (target.query as (text: string) => Promise<unknown>).bind(
    client,
  );
  let checked: Promise<void> | undefined;

  const ready = () => {
    try {
      refuseEmbeddedSurface(driver, guard);
    } catch (error) {
      return Promise.reject(error);
    }
    checked ??= guard
      .checkRole(
        (text) => query(text) as Promise<{ rows: Record<string, unknown>[] }>,
      )
      .then(
        () => undefined,
        (error: unknown) => {
          if (!(error instanceof DatabaseRoleGuardError)) checked = undefined;
          throw error;
        },
      );
    return checked;
  };

  for (const [name, callbackForm] of [
    ["query", true],
    ["connect", true],
    ["transaction", false],
  ] as const) {
    const original = target[name];

    if (typeof original !== "function") continue;

    const bound = original.bind(client);

    Object.defineProperty(client, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        if (callbackForm && typeof args.at(-1) === "function") {
          return bound(...args);
        }
        return ready().then(() => bound(...args));
      },
    });
  }
}

/**
 * `embedded` is PGlite's surface, and the role check judges nothing under it,
 * because PGlite has no roles (`role-guard.ts`; ruling 73). A guarded storage
 * on any other driver refuses it whatever the guard's modes: as it is built,
 * and again before its first use, since a process may declare after it
 * builds. So a server's role never escapes the role check by a declaration.
 */
function refuseEmbeddedSurface(
  driver: DatabaseDriver,
  guard: DatabaseRoleGuard,
): void {
  if (driver === "pglite" || guard.report().surface !== "embedded") return;
  throw new DatabaseSurfaceError(
    "RequestPort database surface `embedded` is taken only by a PGlite " +
      `storage, and this one is on the ${driver} driver. A process that ` +
      "connects to a PostgreSQL server declares application, worker or " +
      "operator.",
  );
}

function finish(
  driver: DatabaseDriver,
  pool: StorageClient,
  db: DatabaseWithTestPool,
  guard?: DatabaseRoleGuard,
): Storage {
  let closing: Promise<void> | undefined;

  if (guard !== undefined) {
    refuseEmbeddedSurface(driver, guard);
    installRoleCheck(pool, guard, driver);
  }

  const storage: Storage = {
    driver,
    db,
    transaction: (work, config) => db.transaction(work, config),
    ready: async () => {
      await db.execute(sql`select 1 as ready`);
    },
    close: () => {
      closing ??= pool.end();
      return closing;
    },
  };

  clients.set(storage, pool);
  return storage;
}

/**
 * What `createStorage` hands the hosted driver's storage factory
 * (`createHostedStorage` in `hosted-driver.ts`): the parts of building a
 * storage that are this module's, so that the factory need not import this
 * module, which imports it.
 */
export interface HostedStorageSeam {
  refuseDataDir(driver: DatabaseDriver, options: StorageOptions): void;
  guardedReaderOf(options: StorageOptions): () => string;
  readRetryFor(driver: DatabaseDriver, requested: boolean | undefined): boolean;
  withReadRetry<P extends { query: (...args: never[]) => unknown }>(pool: P): P;
  reportPoolError(): void;
  finish(
    driver: DatabaseDriver,
    pool: StorageClient,
    db: Database,
    guard?: DatabaseRoleGuard,
  ): Storage;
}

const hostedStorageSeam: HostedStorageSeam = {
  refuseDataDir,
  guardedReaderOf,
  readRetryFor,
  withReadRetry,
  reportPoolError,
  // Every driver's Drizzle handle holds its pool as `$client`.
  finish: (driver, pool, db, guard) =>
    finish(driver, pool, db as DatabaseWithTestPool, guard),
};

/**
 * The pg path, with nothing left for `PG*` to fill (contract §3.4).
 *
 * The client class this pool constructs every connection through:
 *
 * 1. refuses while a variable no configuration can override is set, on every
 *    construction;
 * 2. reads the connection string then, like the hosted driver's path, and
 *    passes it with user, password and port written into it
 *    (`isolatedPgConnectionString`);
 * 3. sets `ssl: false` beside it, which `pg` keeps unless the URL's own
 *    `sslmode` or `ssl` says otherwise — without it `pg` reads `PGSSLMODE`;
 * 4. receives the pool's `connectionTimeoutMillis`, which stops `pg` reading
 *    `PGCONNECT_TIMEOUT`;
 * 5. when given a password function, installs it after construction, because
 *    the parsed string would otherwise override it with `""`.
 *
 * Its name must not contain "Pool": Drizzle's pg session treats a client
 * whose constructor name does as a pool and checks a connection out of it.
 */
function createPgStorage(options: StorageOptions): Storage {
  refuseDataDir("pg", options);
  // Always false for pg: a request for `true` is refused inside (§3.8).
  readRetryFor("pg", options.readRetry);

  const read = guardedReaderOf(options);
  const { pg, drizzle } = loadPgDriver();
  const password = options.password;
  const limits = options.pool ?? PG_POOL_LIMITS;

  if (typeof options.connectionString === "string") {
    // Refuse a bad string now rather than on the first query.
    isolatedPgConnectionString(options.connectionString, { password });
  }

  class IsolatedPgClient extends pg.Client {
    constructor(config?: Pg.ClientConfig) {
      refuseUnoverridablePgVariables(process.env);

      super({
        ...(config ?? {}),
        connectionString: isolatedPgConnectionString(read(), { password }),
        ssl: false,
      });

      if (password !== undefined) {
        // pg calls a function password at authentication; @types/pg types
        // the field as a string only.
        const self = this as unknown as {
          password: unknown;
          connectionParameters: { password: unknown };
        };

        self.password = password;
        self.connectionParameters.password = password;
      }
    }
  }

  const pool = new pg.Pool({
    max: limits.max,
    idleTimeoutMillis: limits.idleTimeoutMillis,
    connectionTimeoutMillis: limits.connectionTimeoutMillis,
    Client: IsolatedPgClient,
  });

  pool.on("error", reportPoolError);

  const db: DatabaseWithTestPool = drizzle({ client: pool, schema });

  return finish("pg", pool, db, options.guard);
}

/** The package a PGlite storage loads, at run time (`loadPgliteDriver`). */
export const PGLITE_PACKAGE = "@electric-sql/pglite";

/**
 * What a PGlite storage throws when `PGLITE_PACKAGE` is not installed where
 * Node's lookup from this module can find it (Plan 13, H.4; rulings 138 and
 * 151). The error keeps Node's `code`, `MODULE_NOT_FOUND`, and its
 * `requireStack`, which names the module the lookup started from, and holds
 * Node's own error as its `cause`.
 */
export const PGLITE_ABSENT_MESSAGE =
  `A PGlite storage needs ${PGLITE_PACKAGE}, and it is not installed: ` +
  "Node found no such package from the module that loads it, which the " +
  `error's requireStack names. Install ${PGLITE_PACKAGE} where that module ` +
  "can find it (@requestport/db declares it as an optional peer " +
  "dependency), or use a PostgreSQL server through the pg driver.";

/**
 * Whether `error` is Node's refusal to find `PGLITE_PACKAGE` itself: its
 * code is `MODULE_NOT_FOUND` and its first line names that package and
 * nothing under it. A module PGlite needs that is missing, or a subpath of
 * it, is another error, and is left as Node raised it.
 */
function isPgliteAbsent(error: unknown): error is Error & {
  code: string;
  requireStack?: unknown;
} {
  if (!(error instanceof Error)) return false;
  return (
    (error as { code?: unknown }).code === "MODULE_NOT_FOUND" &&
    error.message.split("\n", 1)[0] === `Cannot find module '${PGLITE_PACKAGE}'`
  );
}

/**
 * What `loadPgliteDriver` throws for an error from its `require` of
 * `PGLITE_PACKAGE`: for Node's refusal to find that package itself, the
 * refusal in `PGLITE_ABSENT_MESSAGE`'s words, keeping Node's `code` and
 * `requireStack` and holding Node's error as its `cause`; for anything else,
 * the error as Node raised it.
 */
export function pgliteLoadError(error: unknown): unknown {
  if (!isPgliteAbsent(error)) return error;
  return Object.assign(new Error(PGLITE_ABSENT_MESSAGE, { cause: error }), {
    code: error.code,
    requireStack: error.requireStack,
  });
}

/*
 * PGlite is a 25 MB development dependency of this package, which its test
 * lane uses, and a dependency of the `requestport` program, whose
 * `requestport start` serves from it; `@requestport/db`'s packed manifest
 * declares it as an optional peer (`ROWS.db.optionalPeers` in
 * `scripts/pack-packages.mjs`).
 * So it is loaded through a `require` obtained at run time
 * from `process.getBuiltinModule`, not through an import or `createRequire`,
 * which a bundler can resolve. Measured (track-e.md, E.2 step 3): esbuild,
 * which builds the Trigger worker, leaves `@electric-sql/pglite`,
 * `drizzle-orm/pglite` and `pg` all out of a bundle of this package, and a
 * standalone webpack 5 build of the same call left PGlite out. What
 * `next build` and its file tracing include was not built here; the `--e2e`
 * build and the Vercel preview check are the evidence for the web server.
 *
 * When `@electric-sql/pglite` itself is not installed, it throws
 * `PGLITE_ABSENT_MESSAGE`'s refusal in place of Node's generic error
 * (`pgliteLoadError`, above). Each specifier is a string literal, so
 * `scripts/pack-packages.mjs`'s source scan reads every one of them.
 */
export function loadPgliteDriver() {
  const requireAtRuntime = process
    .getBuiltinModule("node:module")
    .createRequire(import.meta.url);
  let pglite: typeof PgliteModule;
  try {
    pglite = requireAtRuntime("@electric-sql/pglite") as typeof PgliteModule;
  } catch (error) {
    throw pgliteLoadError(error);
  }

  return {
    PGlite: pglite.PGlite,
    types: pglite.types,
    citext: (
      requireAtRuntime(
        "@electric-sql/pglite/contrib/citext",
      ) as typeof PgliteCitextModule
    ).citext,
    drizzle: (requireAtRuntime("drizzle-orm/pglite") as typeof PgliteDriver)
      .drizzle,
  };
}

type PgliteInstance = InstanceType<typeof PgliteModule.PGlite>;
type PgliteQuery = PgliteInstance["query"];
type PgliteTransaction = PgliteInstance["transaction"];

/** What a checked-out PGlite session offers: a pool session, plus the transaction Drizzle's PGlite session calls. */
export interface PgliteSessionClient extends TestSessionClient {
  transaction: PgliteTransaction;
}

const PGLITE_CLOSED = "Cannot use a PGlite storage after calling end on it.";
/** `_int8`, which PGlite's `types` does not name. */
const INT8_ARRAY_OID = 1016;
const PGLITE_SECOND_SESSION =
  "PGlite has one connection, so a PGlite storage is single-session: a " +
  "second session cannot be opened while one is checked out. Work that " +
  "holds two sessions at once needs a PostgreSQL server, not PGlite.";
const PGLITE_SESSION_HELD =
  "PGlite has one connection, and a session has it checked out: a query " +
  "through the storage itself would run inside that session, so it is " +
  "refused until the session is released.";

/**
 * The PGlite storage's stand-in for a pool, which Drizzle holds as its
 * client and the test suites reach through `testing.ts`'s `testPool`.
 *
 * - PGlite starts on the first query, not when the storage is built.
 * - `connect()` checks out the one connection: a second `connect()` while it
 *   is out is refused, and so is a query through the storage itself, which
 *   would otherwise run inside the session's transaction. A pool would have
 *   given each a connection of its own; PGlite cannot, and a refusal says so
 *   where a silent shared session would change what a test proves.
 * - `transaction()` is PGlite's own, which holds the connection exclusively:
 *   work from outside waits until it ends, rather than seeing it.
 * - `end()` closes PGlite. Every later query rejects with one message.
 */
export class SingleSessionPglite {
  readonly #start: () => PgliteInstance;
  #instance: Promise<PgliteInstance> | undefined;
  #ended: Promise<void> | undefined;
  #session: object | undefined;

  constructor(start: () => PgliteInstance) {
    this.#start = start;
  }

  #open(): Promise<PgliteInstance> {
    if (this.#ended !== undefined) {
      return Promise.reject(new Error(PGLITE_CLOSED));
    }
    this.#instance ??= (async () => {
      const instance = this.#start();

      await instance.waitReady;
      return instance;
    })();
    return this.#instance;
  }

  #refuseWhileSessionHeld() {
    if (this.#session !== undefined) throw new Error(PGLITE_SESSION_HELD);
  }

  query: PgliteQuery = async (text, params, options) => {
    this.#refuseWhileSessionHeld();
    return (await this.#open()).query(text, params, options);
  };

  transaction: PgliteTransaction = async (work) => {
    this.#refuseWhileSessionHeld();
    return (await this.#open()).transaction(work);
  };

  async connect(): Promise<PgliteSessionClient> {
    if (this.#session !== undefined) throw new Error(PGLITE_SECOND_SESSION);

    const token = {};

    this.#session = token;

    let instance: PgliteInstance;

    try {
      instance = await this.#open();
    } catch (error) {
      this.#session = undefined;
      throw error;
    }

    let released = false;
    const held = () =>
      released
        ? Promise.reject(new Error("This PGlite session was released."))
        : Promise.resolve(instance);

    return {
      // All three arguments: Drizzle's PGlite driver passes `{ rowMode:
      // "array", parsers }` as the third on every select with fields, and
      // maps its columns by position.
      query: (async (
        text: string,
        params?: unknown[],
        options?: Parameters<PgliteQuery>[2],
      ) =>
        (await held()).query(
          text,
          params,
          options,
        )) as PgliteSessionClient["query"],
      transaction: (async (work) =>
        (await held()).transaction(work)) as PgliteTransaction,
      release: (error) => {
        if (released) return;
        released = true;
        if (error) {
          // A pool destroys a connection released with an error, which ends
          // any transaction it held. The one PGlite connection cannot be
          // destroyed, so what the session left open is rolled back instead;
          // later queries queue behind it.
          void instance.query("rollback").catch(() => undefined);
        }
        if (this.#session === token) this.#session = undefined;
      },
    };
  }

  end(): Promise<void> {
    this.#ended ??= (async () => {
      // A start that failed — the role guard refused it before PGlite was
      // constructed — opened nothing, so there is nothing to close.
      const instance = await this.#instance?.catch(() => undefined);

      if (instance !== undefined) await instance.close();
    })();
    return this.#ended;
  }
}

/**
 * A Drizzle handle bound to a checked-out PGlite session, as `openSession`
 * and `migrate()` bind one to a pool's client. Drizzle's PGlite session calls
 * only `query` and `transaction`, which the session forwards — `query` with
 * its text, parameters and options — to the one connection it holds.
 */
export function drizzleOverPgliteSession<
  TSchema extends Record<string, unknown>,
>(
  session: PgliteSessionClient,
  schemaOf?: TSchema,
): PgDatabase<RowsResultHKT, TSchema> {
  const client = session as unknown as PgliteInstance;

  return loadPgliteDriver().drizzle(
    schemaOf === undefined ? { client } : { client, schema: schemaOf },
  ) as unknown as PgDatabase<RowsResultHKT, TSchema>;
}

/**
 * The PGlite path: one in-process database, single-session.
 *
 * `citext` is loaded because migration 0002 creates that extension; PGlite
 * ships it but does not load it unless asked. Nothing is started here: the
 * first query starts PGlite, which then creates `dataDir` if it is a
 * directory that does not exist yet.
 *
 * int8 and int8[] are left as text, as pg-types — which pg uses, and the
 * hosted driver where there is one — leaves them, because an int8 can exceed
 * a double. PGlite's own parser
 * returns a number, or a bigint past 2^53 (measured, track-e.md), so a row a
 * test or a repository reads would otherwise differ by driver. Drizzle's own
 * column mapping accepts either.
 */
function createPgliteStorage(options: StorageOptions): Storage {
  if (options.connectionString !== undefined) {
    throw new Error(
      "A connection string is only taken by the server drivers; PGlite " +
        "takes a dataDir.",
    );
  }
  if (options.password !== undefined) {
    throw new Error("A password function is only honoured by the pg driver.");
  }
  if (options.pool !== undefined) {
    throw new Error(
      "Pool limits are only taken by the pg driver; PGlite has one " +
        "connection and no pool.",
    );
  }
  readRetryFor("pglite", options.readRetry);

  const dataDir = options.dataDir;

  if (dataDir === undefined || dataDir.trim() === "") {
    throw new Error(
      "A PGlite storage needs a dataDir: a directory, or memory://.",
    );
  }

  const { PGlite, citext, drizzle, types } = loadPgliteDriver();
  const asText = (value: string) => value;
  const guard = options.guard;
  const client = new SingleSessionPglite(() => {
    // D9: the connection-string read's counterpart, before PGlite starts.
    guard?.beforeConnect();
    return new PGlite(dataDir, {
      extensions: { citext },
      parsers: {
        [types.INT8]: asText,
        [INT8_ARRAY_OID]: (value: string) =>
          types.arrayParser(value, asText, INT8_ARRAY_OID),
      },
    });
  });
  const db = drizzle({
    client: client as unknown as PgliteInstance,
    schema,
  }) as unknown as DatabaseWithTestPool;

  return finish("pglite", client, db, options.guard);
}

/*
 * The record of each handle's `tenantBinding` lives on `globalThis`, under a
 * registered symbol, as the roots' storages do (`wiring.ts`), and for their
 * reason: a bundler can give one process two copies of this module, and a
 * root's storage, which every copy shares, is built by whichever copy asks
 * first. A record only that copy could read would leave the others reading
 * no binding, and so `"wrapped"`, for a storage built `"off"`. The record is
 * a `WeakMap` keyed by the handle, installed by the first `createStorage`
 * call, never as this module loads: loading it builds no storage.
 */
const TENANT_BINDINGS = Symbol.for("requestport.tenant-bindings");

type TenantBindingHolder = {
  [TENANT_BINDINGS]?: WeakMap<object, TenantBinding>;
};

function recordTenantBinding(handle: object, binding: TenantBinding): void {
  const holder = globalThis as TenantBindingHolder;

  holder[TENANT_BINDINGS] ??= new WeakMap();
  holder[TENANT_BINDINGS].set(handle, binding);
}

/**
 * The `tenantBinding` recorded against this handle, by any copy of this
 * module: the one the storage whose `db` it is was built with (`"wrapped"`
 * when it was given none), or, for a handle over one of a storage's own
 * connections, that storage's (`shareTenantBinding`). Undefined for any other
 * handle. For `tenant-context.ts`; not exported from the package barrel.
 */
export function recordedTenantBinding(
  database: object,
): TenantBinding | undefined {
  return (globalThis as TenantBindingHolder)[TENANT_BINDINGS]?.get(database);
}

/**
 * Records against `handle`, a Drizzle handle over one of `storage`'s own
 * connections, the binding `storage`'s `db` carries, so that `withTenant`
 * treats the one as it treats the other. For `testing.ts`'s `openSession`;
 * not exported from the package barrel.
 */
export function shareTenantBinding(storage: Storage, handle: object): void {
  const binding = recordedTenantBinding(storage.db);

  if (binding !== undefined) recordTenantBinding(handle, binding);
}

/*
 * The host's handoff (Plan 13, H.5; manifest-h.md §2.7.1; rulings 141, 145
 * and 160). A host that serves Next's request handler in its own process
 * sets `globalThis[Symbol.for("requestport.host")]` to the storage, Better
 * Auth and RequestPort it built, with `admitsConstruction`, which is to
 * admit only a token the host's own closure holds. Next's build carries
 * copies of this package of its own, so the code that builds a storage is in
 * that process more than once. While the handoff is set, `createStorage` and
 * `createWorkerStorages` build only for a caller whose options carry a token
 * it admits (`refuseUnlessHostAdmits`), and the application root answers the
 * storage it carries (`wiring.ts`). Where nothing sets it — on Vercel, in the
 * Trigger.dev worker and in `requestport-jobs` — no factory here changes what
 * it does. It is read when a factory runs, never as this module loads.
 */
const HOST_HANDOFF = Symbol.for("requestport.host");

/**
 * The key under which a caller hands a factory its construction token, in
 * the options object it passes (`withHostConstructionToken`). A symbol, so
 * that no option type `@requestport/core` publishes names it (ruling 160,
 * item 1).
 */
const HOST_CONSTRUCTION_TOKEN = Symbol.for(
  "requestport.host-construction-token",
);

/** What the host's handoff carries. Any member may be missing. */
export interface HostHandoff {
  readonly requestPort?: unknown;
  readonly auth?: unknown;
  readonly storage?: Storage;
  readonly admitsConstruction?: (token: unknown) => boolean;
}

/**
 * The host's handoff, or undefined where none is set. A value that is not an
 * object is a handoff that carries no member, so every reader refuses it.
 */
export function hostHandoff(): HostHandoff | undefined {
  const value: unknown = (globalThis as Record<symbol, unknown>)[HOST_HANDOFF];

  if (value === undefined) return undefined;
  return typeof value === "object" && value !== null
    ? (value as HostHandoff)
    : {};
}

/**
 * A refusal while the host's handoff is set, naming where it was raised and
 * what was missing. Its message carries no value: no token, no URL.
 */
export class HostHandoffRefusalError extends Error {
  constructor(site: string, missing: string) {
    super(
      `RequestPort's ${site} refused: the host's handoff is present, and ` +
        `${missing}. While it is present, the web answers the storage, ` +
        "Better Auth and RequestPort it carries and builds none of its own " +
        "(manifest-h.md §2.7.1).",
    );
    this.name = "HostHandoffRefusalError";
  }
}

/**
 * A refusal, with its one console line written here, where it is raised
 * (ruling 145), for the caller to throw.
 */
export function hostHandoffRefusal(
  site: string,
  missing: string,
): HostHandoffRefusalError {
  const refusal = new HostHandoffRefusalError(site, missing);

  console.error(`${refusal.name}: ${refusal.message}`);
  return refusal;
}

/** The construction token `options` carries, or undefined. */
export function hostConstructionTokenOf(options: object): unknown {
  return (options as Record<symbol, unknown>)[HOST_CONSTRUCTION_TOKEN];
}

/**
 * A copy of `options` that carries `token` as its construction token, or
 * `options` itself when `token` is undefined. Nothing else is changed.
 */
export function withHostConstructionToken<Options extends object>(
  options: Options,
  token: unknown,
): Options {
  return token === undefined
    ? options
    : { ...options, [HOST_CONSTRUCTION_TOKEN]: token };
}

/**
 * Throws, after its console line, while the host's handoff is set, unless
 * `options` carries a construction token and the handoff's
 * `admitsConstruction` admits it: options without a token are refused
 * without asking, and a handoff without `admitsConstruction` admits none.
 * Returns, and reads nothing more, where no handoff is set. `factory` names
 * the caller.
 */
export function refuseUnlessHostAdmits(factory: string, options: object): void {
  const handoff = hostHandoff();

  if (handoff === undefined) return;
  const token = hostConstructionTokenOf(options);

  if (
    token !== undefined &&
    typeof handoff.admitsConstruction === "function" &&
    handoff.admitsConstruction(token) === true
  ) {
    return;
  }
  throw hostHandoffRefusal(
    factory,
    "the caller passed no construction token it admits",
  );
}

/**
 * A storage: one pool (or PGlite's one connection), one Drizzle handle over
 * it, and its lifecycle. Constructing one opens no connection; the first
 * query does. Its handle carries the `tenantBinding` it is given, and
 * `"wrapped"` when it is given none. While the host's handoff is set, it
 * builds only for a caller whose options carry a construction token the
 * handoff admits, and refuses any other before it reads any other option
 * (above).
 */
export function createStorage(options: StorageOptions): Storage {
  refuseUnlessHostAdmits("createStorage", options);
  const tenantBinding = options.tenantBinding;

  if (
    tenantBinding !== undefined &&
    tenantBinding !== "wrapped" &&
    tenantBinding !== "off"
  ) {
    throw new Error('A storage\'s tenantBinding is "wrapped" or "off".');
  }

  let storage: Storage;

  if (isHostedDriver(options.driver)) {
    storage = createHostedStorage(options, hostedStorageSeam);
  } else {
    switch (options.driver) {
      case "pg":
        storage = createPgStorage(options);
        break;
      case "pglite":
        storage = createPgliteStorage(options);
        break;
      default:
        throw new Error("Unknown database driver.");
    }
  }

  recordTenantBinding(storage.db, tenantBinding ?? "wrapped");
  return storage;
}

/**
 * The options of a storage built from this process's environment over the
 * owner's connection string: the driver `selectDriver` names, and the URL
 * `readDatabaseUrl` reads from `env` each time a client is constructed —
 * `DATABASE_URL`, or a preview's own variable — whatever the application
 * variable says (manifest-i2.md §2.8 item 2; I.2 step 5, slice 1). Every
 * composition root but the application's builds from it (`wiring.ts`), and
 * so does each suite's or fixture's storage built with it, so an application
 * login in a track's `.env.local` reaches none of them. The application root
 * builds from `applicationStorageOptionsFromEnv`.
 *
 * On the pg path that read also refuses production, or staging's own
 * database, unless `env` carries its opt-in (contract §3.4, last paragraph;
 * `refuseUnapprovedSharedPgDatabase` says why pg and not the hosted driver).
 * The refusal comes before the client exists, so nothing is dialled. The
 * hosted driver's read is the one it always had.
 *
 * On the PGlite path there is no connection string:
 * REQUESTPORT_PGLITE_DATA_DIR names the database, and is required. Every
 * PGlite storage built from the environment takes this path, the
 * `test:pglite` lane's included, and `@requestport/config` asks such a
 * process for no `DATABASE_URL` (Plan 13, H.3).
 */
export function storageOptionsFromEnv(env: NodeJS.ProcessEnv): StorageOptions {
  return storageOptionsReading(env, readDatabaseUrl);
}

/**
 * The options of the application root's storage (`wiring.ts`): as
 * `storageOptionsFromEnv`'s on every driver, with the URL
 * `readApplicationDatabaseUrl` reads instead — the application variable, or
 * under `VERCEL_ENV=preview` the preview's own, and never `DATABASE_URL`
 * (manifest-i2.md §3 step 5). With that variable unset or blank the read
 * refuses, naming it, before any client exists, so nothing is dialled.
 */
export function applicationStorageOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): StorageOptions {
  return storageOptionsReading(env, readApplicationDatabaseUrl);
}

function storageOptionsReading(
  env: NodeJS.ProcessEnv,
  readUrl: (env: NodeJS.ProcessEnv) => string,
): StorageOptions {
  const driver = selectDriver(env);

  if (isHostedDriver(driver)) {
    return { driver, connectionString: () => readUrl(env) };
  }

  if (driver === "pglite") {
    const dataDir = env[PGLITE_DATA_DIR_VARIABLE];

    if (dataDir === undefined || dataDir.trim() === "") {
      throw new Error(
        `${DATABASE_DRIVER_VARIABLE}=pglite needs ${PGLITE_DATA_DIR_VARIABLE}, ` +
          "the directory its database is in (or memory://). " +
          "`requestport start` sets both for an instance on PGlite, and " +
          "`pnpm --filter @requestport/db test:pglite` for its test lane.",
      );
    }
    return { driver, dataDir };
  }

  return {
    driver,
    connectionString: () => {
      const connectionString = readUrl(env);

      refuseUnapprovedSharedPgDatabase(connectionString, env);
      return connectionString;
    },
  };
}
