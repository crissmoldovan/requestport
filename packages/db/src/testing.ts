import type * as Pg from "pg";

import {
  createStorage,
  type Database,
  type DatabaseDriver,
  type DatabaseWithTestPool,
  driverPoolOf,
  drizzleOverPgliteSession,
  loadPgDriver,
  type PoolLimits,
  SingleSessionPglite,
  type Storage,
  shareTenantBinding,
  storageClientOf,
  type TenantBinding,
  type TestPool,
  type TestQueryResult,
  type TestSessionClient,
} from "./client.js";
import {
  readDatabaseUrl,
  refuseUnapprovedSharedPgDatabase,
} from "./database-url.js";
import {
  applyLocalProxy,
  drizzleOverHosted,
  isHostedDriver,
} from "./hosted-driver.js";
import * as schema from "./schema/index.js";

/*
 * `@requestport/db/testing` — for tests only (track-e.md, contract §1 and
 * §4.3). It is not exported from the package barrel, so nothing in a
 * production module graph imports it by accident.
 *
 * Tests reach the pool through these instead of a handle's `$client`. E.2
 * provided `testPool`, `rawQuery` and `openSession`, and moved its own three
 * lock-choreography suites onto them. G.4 added `testPoolOfHandle`, and moved
 * every other use outside client.ts and this file onto it and `testPool`;
 * Done when 2's pin keeps it so (`index.test.ts`). G.5 took `$client` off the
 * package's public surface: `db`, the one export typed with it, is gone, and
 * `Database` never carried it. `testPoolOfHandle` reads it through a cast.
 */

/**
 * The hosted driver's npm packages (`hosted-driver.ts`; none in the public
 * tree), for the suites outside this package that pin what core's bundle
 * leaves external and what its dependencies read as they load (core's
 * `bundle.test.ts` and `import.test.ts`): they reach this package through its
 * subpaths, not its modules' paths.
 */
export { HOSTED_DRIVER_PACKAGES } from "./hosted-driver.js";
export { usePrivateJwksTable } from "./test-support/private-jwks-table.js";
export {
  endingEachCommandBinding,
  endingEachMethodBinding,
  endTenantBinding,
} from "./test-support/tenant-binding.js";
export type { TestPool, TestQueryResult, TestSessionClient };

/**
 * The accessor for `$client`: the storage's pool, typed to the part every
 * driver shares — for PGlite, its single-session stand-in. There is no
 * default: the caller names the storage (Plan 13, G.5).
 */
export function testPool(storage: Storage): TestPool {
  return storageClientOf(storage) as TestPool;
}

/**
 * The accessor for a handle's `$client`, for a suite that holds a storage's
 * own handle (`storage.db`) and not the storage: one built by a module graph
 * the suite imported afresh, say, whose storages this module's `testPool`
 * does not know. For a storage's handle it is what `testPool(storage)` is.
 * Refused for a handle that holds no client.
 */
export function testPoolOfHandle(database: Database): TestPool {
  const client = (database as Partial<DatabaseWithTestPool>).$client;

  if (client === undefined) {
    throw new Error(
      "This handle holds no client: testPoolOfHandle takes a storage's own " +
        "handle, storage.db.",
    );
  }
  return client;
}

export interface TestStorageOptions {
  driver: DatabaseDriver;
  /**
   * pg and the hosted driver: defaults to this run's database,
   * `readDatabaseUrl(env)`. PGlite takes none.
   */
  connectionString?: string;
  /** PGlite only: defaults to `memory://`, a database of its own. */
  dataDir?: string;
  /** pg only, as in `createStorage`. */
  pool?: PoolLimits;
  /** As in `createStorage`, whose default, `"wrapped"`, an absent one takes. */
  tenantBinding?: TenantBinding;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * A storage a suite opens for itself, over this run's database unless it names
 * another, refused first when that database is production or staging's own
 * and `env` does not carry its opt-in (contract §3.4, last paragraph).
 *
 * `createStorage` never refuses an explicit connection string — §3.7 leaves
 * that to the caller — so a suite that called it directly would dial whatever
 * `.env.local` named. The refusal applies to each server driver here: pg
 * dials the URL's host directly, and so does the hosted driver when no local
 * proxy is named (`localProxyTarget` in `hosted-driver.ts`). It runs before
 * the storage exists, so nothing is dialled.
 *
 * A PGlite storage names no host, so there is nothing to refuse: it is a
 * database in this process, in memory unless `dataDir` names a directory.
 *
 * Before it builds a storage on the hosted driver it points the driver at the
 * local proxy `env` names (`applyLocalProxy`), as a composition root does:
 * importing the package applies nothing (Plan 13, G.5), and the hosted
 * driver's cases of this package's suites reach a plain PostgreSQL only
 * through that proxy.
 */
export function createTestStorage(options: TestStorageOptions): Storage {
  const tenantBinding =
    options.tenantBinding === undefined
      ? {}
      : { tenantBinding: options.tenantBinding };

  if (options.driver === "pglite") {
    return createStorage({
      driver: "pglite",
      dataDir: options.dataDir ?? "memory://",
      ...(options.pool ? { pool: options.pool } : {}),
      ...tenantBinding,
    });
  }

  const env = options.env ?? process.env;
  const connectionString = options.connectionString ?? readDatabaseUrl(env);

  refuseUnapprovedSharedPgDatabase(connectionString, env);
  if (isHostedDriver(options.driver)) applyLocalProxy(env);

  // `pool` is passed through as given, so the hosted driver's path refuses it
  // as `createStorage` always does rather than dropping it.
  return createStorage({
    driver: options.driver,
    connectionString,
    ...(options.pool ? { pool: options.pool } : {}),
    ...tenantBinding,
  });
}

/** One query on the pool, outside any session the test holds. */
export function rawQuery<
  // biome-ignore lint/suspicious/noExplicitAny: mirrors both drivers' own default row type
  Row extends Record<string, any> = any,
>(
  storage: Storage,
  text: string,
  values?: unknown[],
): Promise<TestQueryResult<Row>> {
  return testPool(storage).query<Row>(text, values);
}

/**
 * A dedicated connection: statements on it run in order on one backend, so a
 * test can hold a transaction or a lock open while another session acts.
 */
export interface TestSession {
  /** A Drizzle handle bound to this connection, not to the pool. */
  readonly db: Database;
  query: TestSessionClient["query"];
  /** Returns the connection to the pool; pass an error to destroy it. */
  release(error?: Error | boolean): void;
}

/**
 * Check one connection out of the storage's pool and bind a Drizzle handle
 * to it with the storage's own driver. On PGlite that is its one connection:
 * a second session while this one is out is refused (`SingleSessionPglite`).
 * The handle carries the storage's `tenantBinding` (`shareTenantBinding`),
 * so `withTenant` wraps a read on it exactly when it would wrap one on the
 * storage's `db`.
 */
export async function openSession(storage: Storage): Promise<TestSession> {
  const storageClient = storageClientOf(storage);

  if (storageClient instanceof SingleSessionPglite) {
    const session = await storageClient.connect();

    return sessionOver(
      storage,
      session,
      drizzleOverPgliteSession(session, schema),
    );
  }

  const pool = driverPoolOf(storage);

  if (isHostedDriver(storage.driver)) {
    const client = await (
      pool as unknown as { connect(): Promise<TestSessionClient> }
    ).connect();
    const database: Database = drizzleOverHosted(client, schema);

    return sessionOver(storage, client, database);
  }

  const client = await (pool as Pg.Pool).connect();
  const database: Database = loadPgDriver().drizzle({ client, schema });

  return sessionOver(storage, client as unknown as TestSessionClient, database);
}

function sessionOver(
  storage: Storage,
  client: TestSessionClient,
  database: Database,
): TestSession {
  shareTenantBinding(storage, database);
  return {
    db: database,
    query: (text, values) => client.query(text, values),
    release: (error) => client.release(error),
  };
}
