import {
  createStorage,
  selectDriver,
  storageClientOf,
  type TestQueryResult,
} from "./client.js";
import {
  refuseUnapprovedSharedPgDatabase,
  validDatabaseUrl,
} from "./database-url.js";
import { applyLocalProxy, isHostedDriver } from "./hosted-driver.js";

/*
 * The owner storage the E2E scenario hook seeds through (Plan 13, Track I.2,
 * D20 option (a); manifest-i2.md §2.9, "The browser lane, before step 5").
 *
 * The acceptance server connects as a local application-role login, so its
 * web root's storage is under row security, and a scenario that seeds rows
 * across organisations cannot seed through it. This is a second storage,
 * over the owner's URL, for that hook alone. It is built with no role guard,
 * so no guard watches it.
 *
 * It reads that URL from `REQUESTPORT_E2E_OWNER_DATABASE_URL`, and from no
 * other variable (Plan 13, I.2 step 7; ruling 224 item 3). Since step 7 the
 * acceptance server is handed no owner-capable name (`DATABASE_URL`, any
 * `DATABASE_URL_*`, `PG*` or `POSTGRES_*`), whose presence would have its web
 * root's storage refused at its first use; so the owner's URL reaches this
 * storage under a name of its own, which only the starters of an E2E server
 * set, for the server they start: `scripts/start-e2e-server.mjs` (the
 * acceptance server) and the scenario hook's live proof in apps/web
 * (`route.test.ts`, `pnpm dev:e2e`). The environment check reads names only,
 * and this name is not one it refuses: the check is the second line, and the
 * role check, which refuses the web root's storage an owner's login, is the
 * authority (manifest-i2.md §2.2).
 *
 * It is refused, before anything is dialled:
 *
 * - wherever `VERCEL_ENV` is set, empty included: every Vercel deployment sets
 *   it, so no deployed environment builds it;
 * - unless `NODE_ENV` is `development` or `test`: a production runtime never
 *   builds it, on Vercel or off it;
 * - unless `REQUESTPORT_E2E_MODE` is `1`. The web application's own E2E check
 *   (`isE2EEmailMode`, which also demands the token) runs before this is
 *   called; this is the part of it this package can read without depending
 *   on `@requestport/auth`;
 * - on the PGlite driver, whose one connection cannot be shared with a
 *   second storage;
 * - when `REQUESTPORT_E2E_OWNER_DATABASE_URL` is unset or blank;
 * - when the owner's URL names production or staging's own database without
 *   its opt-in (`refuseUnapprovedSharedPgDatabase`), as the pg path of
 *   `storageOptionsFromEnv` and `applicationStorageOptionsFromEnv`, one of
 *   which each root's storage takes on pg, and `createTestStorage` refuse it.
 *
 * Before it builds a storage on the hosted driver it points that driver at the
 * local proxy `env` names (`applyLocalProxy` in `hosted-driver.ts`, which
 * changes nothing wherever `VERCEL_ENV` is set), as a composition root and
 * `createTestStorage` do: importing the package applies none (Plan 13, G.5).
 */

export const E2E_OWNER_STORAGE_REFUSED_ON_VERCEL =
  "The E2E owner storage is never built on Vercel: VERCEL_ENV is set.";

export const E2E_OWNER_STORAGE_REFUSED_OUTSIDE_E2E =
  "The E2E owner storage is built only in E2E mode: NODE_ENV development or " +
  "test, and REQUESTPORT_E2E_MODE=1.";

/** The variable this storage reads the owner's URL from, and the only one. */
export const E2E_OWNER_DATABASE_URL_VARIABLE =
  "REQUESTPORT_E2E_OWNER_DATABASE_URL";

export const E2E_OWNER_STORAGE_URL_UNSET =
  "The E2E owner storage needs REQUESTPORT_E2E_OWNER_DATABASE_URL: the " +
  "owner's URL, under a name of its own that the role guard's environment " +
  "check does not refuse, which scripts/start-e2e-server.mjs sets for the " +
  "acceptance server it starts.";

export const E2E_OWNER_STORAGE_REFUSED_ON_PGLITE =
  "The E2E owner storage needs a server: PGlite has one connection, which " +
  "cannot be shared with a second storage.";

/** What the scenario hook needs of the owner: parameterised statements, and a way to end the pool. */
export interface E2EOwnerStorage {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<TestQueryResult<Row>>;
  close(): Promise<void>;
}

/**
 * Build the owner storage, or throw one of the refusals above. Building opens
 * no connection; the first `query` does.
 */
export function createE2EOwnerStorage(env: NodeJS.ProcessEnv): E2EOwnerStorage {
  if (env.VERCEL_ENV !== undefined) {
    throw new Error(E2E_OWNER_STORAGE_REFUSED_ON_VERCEL);
  }
  if (
    (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") ||
    env.REQUESTPORT_E2E_MODE !== "1"
  ) {
    throw new Error(E2E_OWNER_STORAGE_REFUSED_OUTSIDE_E2E);
  }

  const driver = selectDriver(env);

  if (driver === "pglite") throw new Error(E2E_OWNER_STORAGE_REFUSED_ON_PGLITE);

  const ownerUrl = env[E2E_OWNER_DATABASE_URL_VARIABLE];

  if (typeof ownerUrl !== "string" || ownerUrl.trim() === "") {
    throw new Error(E2E_OWNER_STORAGE_URL_UNSET);
  }

  const connectionString = validDatabaseUrl(ownerUrl);

  refuseUnapprovedSharedPgDatabase(connectionString, env);
  if (isHostedDriver(driver)) applyLocalProxy(env);

  const storage = createStorage({ driver, connectionString });
  const client = storageClientOf(storage) as unknown as {
    query<Row>(text: string, values: unknown[]): Promise<TestQueryResult<Row>>;
  };

  return {
    query: (text, values) => client.query(text, [...values]),
    close: () => storage.close(),
  };
}
