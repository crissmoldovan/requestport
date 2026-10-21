import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  applicationStorageOptionsFromEnv,
  createStorage,
  DATABASE_DRIVER_VARIABLE,
  driverPoolOf,
  HostHandoffRefusalError,
  loadPgliteDriver,
  PGLITE_ABSENT_MESSAGE,
  PGLITE_DATA_DIR_VARIABLE,
  pgliteLoadError,
  type Storage,
  selectDriver,
  storageOptionsFromEnv,
} from "./client.js";
import { UNOVERRIDABLE_PG_VARIABLES } from "./database-url.js";
import * as hostedDriver from "./hosted-driver.js";
import {
  DEFAULT_DRIVER,
  HOSTED_DRIVER_PACKAGES,
  HOSTED_DRIVERS,
  isHostedDriver,
} from "./hosted-driver.js";
import * as hostedDriverPublic from "./hosted-driver.public.js";
import * as hostedMigrator from "./hosted-migrator.js";
import * as hostedMigratorPublic from "./hosted-migrator.public.js";
import {
  createWorkerStorages,
  WORKER_DATABASE_URL_VARIABLES,
} from "./tenant-context.js";
import { openSession, testPoolOfHandle } from "./testing.js";
import { rootStorageFromEnv, withHostConstructionToken } from "./wiring.js";

/*
 * The refusal of a shared database is proved here through a storage built
 * from the environment, end to end, against a synthetic list: the private
 * `./shared-databases.js` is replaced by one naming the synthetic hosts below
 * by their digests (ruling 91, option (d)), so this file names no shared
 * database's host. The hosts lie under the
 * reserved `example.test`, a pooled first label ending `-pooler` beside the
 * same label without it.
 */
vi.mock("./shared-databases.js", async () => {
  const { createHash } = await import("node:crypto");
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");

  return {
    kind: "private",
    entries: [
      {
        name: "production",
        hostSha256: digest("db-production.region-1.example.test"),
        databaseNameSha256: null,
        optIn: "REQUESTPORT_PRODUCTION_DATABASE",
      },
      {
        name: "staging",
        hostSha256: digest("db-staging.region-1.example.test"),
        databaseNameSha256: digest("appdb"),
        optIn: "REQUESTPORT_STAGING_DATABASE",
      },
    ],
  };
});

const SENTINEL = "sentinel-value-that-must-not-leak";

/**
 * Set variables on the real `process.env` for one test, and put every one back.
 *
 * Both drivers read `PG*` from `process.env` itself, and a storage built from
 * the environment, as each composition root's is, reads its connection string
 * from it, so an injected env object cannot stand in for it here.
 */
const touched = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (!touched.has(key)) touched.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of touched) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  touched.clear();
});

/** Where `wiring.ts` keeps each root's storage: one per surface, on `globalThis`. */
const ROOT_STORAGES = Symbol.for("requestport.root-storages");

/**
 * Closes the storages the roots hold, and forgets them, so the next ask
 * builds afresh under the environment as it then is.
 */
async function releaseRootStorages() {
  const holder = globalThis as Record<
    symbol,
    Partial<Record<string, Storage>> | undefined
  >;
  const held = holder[ROOT_STORAGES];

  delete holder[ROOT_STORAGES];
  await Promise.all(
    Object.values(held ?? {}).map((storage) => storage?.close()),
  );
}

/**
 * The class a pool constructs its clients with: `pg-pool`'s `Client` field,
 * which `@types/pg` does not declare.
 */
function clientClassOf(pool: object) {
  return (pool as { Client: new (config?: unknown) => pg.Client }).Client;
}

/** A client built the way the pool builds one, without connecting it. */
function newClientOf(pool: { options: unknown }) {
  return new (clientClassOf(pool))(pool.options);
}

/** What a client will send, read without opening a connection. */
function parametersOf(client: unknown) {
  const parameters = (
    client as { connectionParameters: Record<string, unknown> }
  ).connectionParameters;

  return {
    user: parameters.user,
    password: parameters.password,
    host: parameters.host,
    port: parameters.port,
    database: parameters.database,
    ssl: parameters.ssl,
    connect_timeout: parameters.connect_timeout,
    options: parameters.options,
    application_name: parameters.application_name,
    replication: parameters.replication,
    binary: parameters.binary,
    client_encoding: parameters.client_encoding,
  };
}

describe("choosing the driver", () => {
  test("pglite selects single-session PGlite storage, and only where no Vercel runtime exists", () => {
    expect(selectDriver({ REQUESTPORT_DATABASE_DRIVER: "pglite" })).toBe(
      "pglite",
    );

    // Every deployed environment sets VERCEL_ENV, and a storage with one
    // connection is not something a deployment that serves many people
    // serves from, however the variable got there. The worker sets neither,
    // so it keeps its default driver.
    for (const vercelEnv of ["production", "preview", "development", ""]) {
      expect(
        () =>
          selectDriver({
            REQUESTPORT_DATABASE_DRIVER: "pglite",
            VERCEL_ENV: vercelEnv,
          }),
        `VERCEL_ENV=${JSON.stringify(vercelEnv)}`,
      ).toThrow(/pglite/u);
    }
  });

  test("PGlite is configured by its own variable, and reads no connection string", () => {
    expect(PGLITE_DATA_DIR_VARIABLE).toBe("REQUESTPORT_PGLITE_DATA_DIR");

    for (const unset of [undefined, "", "  "]) {
      expect(
        () =>
          storageOptionsFromEnv({
            REQUESTPORT_DATABASE_DRIVER: "pglite",
            REQUESTPORT_PGLITE_DATA_DIR: unset,
          }),
        JSON.stringify(unset),
      ).toThrow("REQUESTPORT_PGLITE_DATA_DIR");
    }

    expect(
      storageOptionsFromEnv({
        REQUESTPORT_DATABASE_DRIVER: "pglite",
        REQUESTPORT_PGLITE_DATA_DIR: "/tmp/requestport-pglite-lane",
        DATABASE_URL: "postgresql://u:p@db.invalid/unused",
      }),
    ).toEqual({ driver: "pglite", dataDir: "/tmp/requestport-pglite-lane" });
  });

  test("the PGlite variable on its own changes nothing", () => {
    const env = { REQUESTPORT_PGLITE_DATA_DIR: "/tmp/requestport-pglite-lane" };

    expect(selectDriver(env)).toBe(DEFAULT_DRIVER);
    expect(storageOptionsFromEnv(env).driver).toBe(DEFAULT_DRIVER);
  });

  test("any other value is refused, naming the variable and not echoing the value", () => {
    for (const value of [
      "postgres",
      "PG",
      " pg",
      "pg ",
      "node-postgres",
      SENTINEL,
    ]) {
      const env = { REQUESTPORT_DATABASE_DRIVER: value };

      expect(() => selectDriver(env), value).toThrow(
        "REQUESTPORT_DATABASE_DRIVER",
      );
      try {
        selectDriver(env);
      } catch (error) {
        expect((error as Error).message).not.toContain(SENTINEL);
      }
    }
  });

  test("a refused value stops nothing when the module loads: it is refused where a storage is built from the environment", async () => {
    // Importing builds no storage (Plan 13, G.5), so nothing reads the
    // variable then. Each composition root reads it when it first builds its
    // storage (`wiring.ts`), and that first ask is where it is refused.
    setEnv({ REQUESTPORT_DATABASE_DRIVER: "mysql" });
    vi.resetModules();

    try {
      const fresh = await import("./client.js");

      expect(() => fresh.storageOptionsFromEnv(process.env)).toThrow(
        "REQUESTPORT_DATABASE_DRIVER",
      );
    } finally {
      vi.resetModules();
    }
  });
});

/*
 * The pool-error listener on pg, the driver both trees have. The private
 * tree's hosted-driver.test.ts holds the case of this name as it was before
 * J.2b, the hosted driver's pool beside pg's.
 */
test("handles pool errors with a fixed secret-safe message", () => {
  const sentinelCredential =
    "postgresql://sentinel-user:sentinel-password@db.invalid/test";
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);

  try {
    const pool = driverPoolOf(
      createStorage({
        driver: "pg",
        connectionString: "postgresql://u:p@db.invalid/test",
      }),
    );

    expect(pool.listenerCount("error")).toBe(1);
    pool.emit("error", new Error(sentinelCredential));

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "Unexpected database pool error.",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      sentinelCredential,
    );
  } finally {
    consoleError.mockRestore();
  }
});

/**
 * The mechanism, pinned.
 *
 * `pool.Client` is how `pg-pool` constructs every client, and it is the hook
 * that moved the connection-string read out of module scope. It is also
 * undocumented. If a dependency bump ever stops honouring it, the pool falls
 * back to its own options — which no longer carry a connection string, because
 * the pool is now constructed with none — and `pg` resolves that to `localhost`
 * as the operating-system user. That is a silently different database, not an
 * error, so nothing downstream would notice.
 *
 * These assertions are the difference between that being caught by a test and
 * being caught in an environment.
 */
describe("each root's storage's deferred read", () => {
  /**
   * A root's storage, built afresh by this ask under the run's environment:
   * the operator's, which reads DATABASE_URL whatever the application
   * variable names, so these cases hold where a track's `.env.local` names
   * its application login. The application root's reader is pinned below.
   */
  async function freshRootStorage() {
    await releaseRootStorages();
    return rootStorageFromEnv("operator");
  }

  afterEach(releaseRootStorages);

  /*
   * A root on pg here. Where this run's environment selects the hosted
   * driver, the private tree's hosted-driver.test.ts judges the root's pool
   * in the case of this name, as it stood before J.2b.
   */
  test.skipIf(isHostedDriver(selectDriver(process.env)))(
    "constructs every client through the deferred reader",
    async () => {
      const storage = await freshRootStorage();
      const pool = driverPoolOf(storage);

      expect(storage.driver).toBe("pg");
      expect(pool).toBeInstanceOf(pg.Pool);
      expect(clientClassOf(pool)).not.toBe(pg.Client);
      expect(clientClassOf(pool).prototype).toBeInstanceOf(pg.Client);
      expect(testPoolOfHandle(storage.db)).toBe(pool);
    },
  );

  test("reads the connection string when it connects, not when it is built", async () => {
    // Building the root's storage ran no read: the pool holds no connection
    // string and the process is still here to assert it.
    const pool = driverPoolOf(await freshRootStorage());

    expect(pool.options.connectionString).toBeUndefined();

    setEnv({ DATABASE_URL: "" });
    expect(() => newClientOf(pool)).toThrow(
      "RequestPort database configuration is invalid.",
    );
  });

  test("hands the client the database the environment names", async () => {
    const pool = driverPoolOf(await freshRootStorage());

    setEnv({
      DATABASE_URL: "postgresql://someone:pw@pinned.example/pinned-db",
    });
    const client = newClientOf(pool);

    expect(client.host).toBe("pinned.example");
    expect(client.database).toBe("pinned-db");
  });
});

/*
 * Which URL each storage built from the environment dials (manifest-i2.md
 * §2.8 item 2; I.2 step 5, slice 1). Only the application root reads the
 * application variable. The operator's and the worker's roots, and every
 * storage a suite or a fixture builds with `storageOptionsFromEnv`, read the
 * owner's URL, so an application login in a track's `.env.local` reaches the
 * application alone.
 */
describe("a storage built from the environment, and the application variable (manifest-i2.md §2.8 item 2)", () => {
  const OWNER = "postgresql://owner:pw@owner.example/owner-db";
  const APPLICATION = "postgresql://app:pw@app.example/app-db";

  afterEach(releaseRootStorages);

  test("the application root dials the application variable, and the operator's and the worker's roots dial DATABASE_URL whatever it names", async () => {
    await releaseRootStorages();
    setEnv({
      REQUESTPORT_DATABASE_DRIVER: "pg",
      DATABASE_URL: OWNER,
      REQUESTPORT_APPLICATION_DATABASE_URL: APPLICATION,
      VERCEL_ENV: undefined,
    });
    const dialled = (surface: "application" | "operator" | "worker") => {
      const client = newClientOf(driverPoolOf(rootStorageFromEnv(surface)));

      return `${client.host}/${client.database}`;
    };

    expect(dialled("application")).toBe("app.example/app-db");
    expect(dialled("operator")).toBe("owner.example/owner-db");
    expect(dialled("worker")).toBe("owner.example/owner-db");
  });

  test("the application root, with only DATABASE_URL set, refuses when its pool constructs a client, naming the application variable, and dials nothing (I.2 step 5)", async () => {
    for (const application of [undefined, "", "   "]) {
      await releaseRootStorages();
      setEnv({
        REQUESTPORT_DATABASE_DRIVER: "pg",
        DATABASE_URL: OWNER,
        REQUESTPORT_APPLICATION_DATABASE_URL: application,
        VERCEL_ENV: undefined,
      });
      const pool = driverPoolOf(rootStorageFromEnv("application"));
      let refusal = "";

      try {
        newClientOf(pool);
      } catch (error) {
        refusal = String(error);
      }

      expect(refusal, JSON.stringify(application)).toContain(
        "REQUESTPORT_APPLICATION_DATABASE_URL is not set",
      );
      expect(refusal, JSON.stringify(application)).not.toContain(
        "owner.example",
      );
      expect(pool.totalCount, JSON.stringify(application)).toBe(0);
    }
  });

  test("storageOptionsFromEnv, which a suite's or a fixture's storage is built from, dials DATABASE_URL on every driver whatever the application variable names", () => {
    for (const driver of [undefined, "pg"]) {
      for (const application of [APPLICATION, undefined]) {
        const options = storageOptionsFromEnv({
          [DATABASE_DRIVER_VARIABLE]: driver,
          DATABASE_URL: OWNER,
          REQUESTPORT_APPLICATION_DATABASE_URL: application,
        });
        const read = options.connectionString as () => string;

        expect(read(), `${driver} ${application}`).toBe(OWNER);
      }
    }
  });

  test("applicationStorageOptionsFromEnv, which the application root is built from, dials the application variable on every driver, and with it unset or blank refuses, naming it, and never dials DATABASE_URL (I.2 step 5)", () => {
    for (const driver of [undefined, "pg"]) {
      for (const application of [APPLICATION, undefined, "  "]) {
        const options = applicationStorageOptionsFromEnv({
          [DATABASE_DRIVER_VARIABLE]: driver,
          DATABASE_URL: OWNER,
          REQUESTPORT_APPLICATION_DATABASE_URL: application,
        });
        const read = options.connectionString as () => string;

        expect(options.driver).toBe(
          storageOptionsFromEnv({ [DATABASE_DRIVER_VARIABLE]: driver }).driver,
        );
        if (application === APPLICATION) {
          expect(read(), `${driver} ${application}`).toBe(APPLICATION);
        } else {
          expect(read, `${driver} ${application}`).toThrow(
            "REQUESTPORT_APPLICATION_DATABASE_URL is not set",
          );
        }
      }
    }
  });
});

describe("the pg driver", () => {
  const URL_FULL = "postgresql://url-user:url-pw@url.example:55432/url-db";

  const hostile = {
    PGUSER: "env-user",
    PGPASSWORD: SENTINEL,
    PGHOST: "env.example",
    PGPORT: "9999",
    PGDATABASE: "env-db",
    PGSSLMODE: "require",
    PGCONNECT_TIMEOUT: "99",
  };

  function pgPool(options: Partial<Parameters<typeof createStorage>[0]> = {}) {
    const storage = createStorage({
      driver: "pg",
      connectionString: URL_FULL,
      ...options,
    });

    return { storage, pool: driverPoolOf(storage) as pg.Pool };
  }

  test("is pg's own Pool, with explicit limits and timeouts", () => {
    const { storage, pool } = pgPool();

    expect(storage.driver).toBe("pg");
    expect(pool).toBeInstanceOf(pg.Pool);
    expect(pool.options.max).toBe(10);
    expect(pool.options.idleTimeoutMillis).toBe(10_000);
    expect(pool.options.connectionTimeoutMillis).toBe(15_000);
    expect(
      (storage.db as unknown as { session: object }).session.constructor.name,
    ).toBe("NodePgSession");
  });

  test("takes the limits it is given", () => {
    const { pool } = pgPool({
      pool: { max: 1, idleTimeoutMillis: 500, connectionTimeoutMillis: 2_000 },
    });

    expect(pool.options.max).toBe(1);
    expect(pool.options.idleTimeoutMillis).toBe(500);
    expect(pool.options.connectionTimeoutMillis).toBe(2_000);
  });

  test("takes every connection field from the URL, never from PG*", () => {
    setEnv(hostile);

    for (const [url, expected] of [
      [URL_FULL, { host: "url.example", port: 55432, ssl: false }],
      // No port, no sslmode: the two fields pg would otherwise fill from
      // PGPORT and PGSSLMODE.
      [
        "postgresql://url-user:url-pw@url.example/url-db",
        { host: "url.example", port: 5432, ssl: false },
      ],
      [
        "postgresql://url-user:url-pw@url.example/url-db?sslmode=disable",
        { host: "url.example", port: 5432, ssl: false },
      ],
    ] as const) {
      const { pool } = pgPool({ connectionString: url });
      const client = newClientOf(pool);
      const parameters = parametersOf(client);

      expect(parameters.user, url).toBe("url-user");
      expect(parameters.password, url).toBe("url-pw");
      expect(parameters.database, url).toBe("url-db");
      expect(parameters.host, url).toBe(expected.host);
      expect(parameters.port, url).toBe(expected.port);
      expect(parameters.ssl, url).toBe(expected.ssl);
      // From the pool's connectionTimeoutMillis, not PGCONNECT_TIMEOUT.
      expect(parameters.connect_timeout, url).toBe(15);
      expect(JSON.stringify(parameters), url).not.toContain(SENTINEL);
    }
  });

  test("keeps TLS when the URL asks for it", () => {
    setEnv(hostile);

    const { pool } = pgPool({
      connectionString:
        "postgresql://url-user:url-pw@url.example/url-db?sslmode=require",
    });
    const client = newClientOf(pool);

    expect(parametersOf(client).ssl).toBeTruthy();
  });

  test("uses a password function when the URL carries no password", () => {
    setEnv(hostile);

    const password = () => "from-a-function";
    const { pool } = pgPool({
      connectionString: "postgresql://url-user@url.example/url-db",
      password,
    });
    const client = newClientOf(pool);

    expect(client.password).toBe(password);
    expect(parametersOf(client).password).toBe(password);
  });

  test("refuses a URL that would leave a credential to the environment", () => {
    for (const url of [
      "postgresql://url.example/url-db",
      "postgresql://url-user@url.example/url-db",
      "postgresql://url-user:@url.example/url-db",
    ]) {
      expect(() => pgPool({ connectionString: url }), url).toThrow(
        /user|password/u,
      );
    }
  });

  test("refuses to construct a client while a variable it cannot override is set", () => {
    const { pool } = pgPool();

    for (const name of UNOVERRIDABLE_PG_VARIABLES) {
      setEnv({ [name]: SENTINEL });
      try {
        expect(() => newClientOf(pool), name).toThrow(name);
        expect(() => newClientOf(pool), name).not.toThrow(SENTINEL);
      } finally {
        setEnv({ [name]: undefined });
      }
    }

    // And once they are gone, it constructs.
    expect(() => newClientOf(pool)).not.toThrow();
  });

  test("reads a deferred connection string when it constructs a client", () => {
    let current = "postgresql://first:pw@first.example/first-db";
    const { pool } = pgPool({ connectionString: () => current });

    expect(newClientOf(pool).host).toBe("first.example");
    current = "postgresql://second:pw@second.example/second-db";
    expect(newClientOf(pool).host).toBe("second.example");
  });

  test("never asks a read again, because it cannot yet tell pg's errors apart", () => {
    /*
     * read-retry.ts classifies by the hosted driver's server-error class
     * (`isHostedServerError`); pg's comes from pg-protocol, so a pg server
     * error whose text names a socket would be re-sent and a real 08006 would
     * not (contract §2.5). Off until that is
     * fixed, and a request to turn it on is refused rather than ignored.
     */
    const { pool } = pgPool();

    expect(Object.hasOwn(pool, "query")).toBe(false);
    expect(() => pgPool({ readRetry: true })).toThrow(/read retry/iu);
  });
});

/**
 * The synthetic shared databases `./shared-databases.js` is replaced with at
 * the top of this file, spelled as a driver would be handed them.
 */
const PRODUCTION_URLS = [
  "postgres://u:p@db-production-pooler.region-1.example.test/appdb",
  // The direct endpoint, which migrations reach for.
  "postgres://u:p@db-production.region-1.example.test/appdb",
  // The same host as a fully qualified name.
  "postgres://u:p@db-production-pooler.region-1.example.test./appdb",
];
const STAGING_URL =
  "postgres://u:p@db-staging-pooler.region-1.example.test/appdb";
const STAGING_ENDPOINT_PER_RUN_URL =
  "postgres://u:p@db-staging-pooler.region-1.example.test/requestport_ci_1234_1_normal";

describe("a storage built from the environment on pg refuses a shared database it was not approved for", () => {
  /*
   * Contract §3.4, last paragraph. Only the pg path: the hosted driver's local
   * WebSocket proxy pins every connection of that driver to the local
   * database whatever host the URL names, but pg dials the URL's host
   * directly, so a checkout whose .env.local names production would put the
   * integration suites on it.
   */
  function pgClientFor(env: NodeJS.ProcessEnv) {
    const storage = createStorage(
      storageOptionsFromEnv({ [DATABASE_DRIVER_VARIABLE]: "pg", ...env }),
    );

    return () => newClientOf(driverPoolOf(storage));
  }

  test("refuses production, pooled, direct or fully qualified, naming the opt-in and not the host", () => {
    for (const url of PRODUCTION_URLS) {
      const construct = pgClientFor({ DATABASE_URL: url });

      expect(construct, url).toThrow(/production database/u);
      expect(construct, url).toThrow(
        /REQUESTPORT_PRODUCTION_DATABASE=approved/u,
      );
      expect(construct, url).not.toThrow(/db-production/u);
    }
  });

  test("refuses production spelled in any case, since DNS ignores case", () => {
    // WHATWG URL lowercases the host only for special schemes; `postgres:` is
    // not one, so the spelling reaches the comparison as typed.
    for (const url of [
      "postgres://u:p@DB-PRODUCTION-POOLER.REGION-1.EXAMPLE.TEST/appdb",
      "postgres://u:p@DB-Production.region-1.example.test/appdb",
    ]) {
      expect(pgClientFor({ DATABASE_URL: url }), url).toThrow(
        /production database/u,
      );
    }
    expect(
      pgClientFor({
        DATABASE_URL:
          "postgres://u:p@DB-STAGING-POOLER.region-1.example.test/appdb",
      }),
    ).toThrow(/staging database/u);
  });

  test("refuses production named in the query or percent-encoded, where pg reads its host", () => {
    // pg takes a query `host` over the authority's, and percent-decodes the
    // authority's host, which WHATWG URL leaves encoded for `postgres:`.
    for (const url of [
      "postgres://u:p@127.0.0.1:55432/appdb?host=db-production-pooler.region-1.example.test",
      "postgres://u:p@db%2Dproduction%2Dpooler.region-1.example.test/appdb",
    ]) {
      expect(pgClientFor({ DATABASE_URL: url }), url).toThrow(
        /production database/u,
      );
    }
  });

  test("refuses any other host in the query, before a client exists", () => {
    expect(
      pgClientFor({
        DATABASE_URL:
          "postgres://u:p@127.0.0.1:55432/appdb?host=elsewhere.example.invalid",
      }),
    ).toThrow(/query parameter "host"/u);
  });

  test("refuses production named by the preview variable too", () => {
    const construct = pgClientFor({
      VERCEL_ENV: "preview",
      DATABASE_URL: "postgresql://u:p@elsewhere.example/db",
      REQUESTPORT_PREVIEW_DATABASE_URL: PRODUCTION_URLS[0],
    });

    expect(construct).toThrow(/production database/u);
  });

  test("allows production only when the opt-in reads exactly approved", () => {
    for (const value of ["true", "1", "yes", "Approved", ""]) {
      const construct = pgClientFor({
        DATABASE_URL: PRODUCTION_URLS[0],
        REQUESTPORT_PRODUCTION_DATABASE: value,
      });

      expect(construct, value).toThrow(/production database/u);
    }

    const construct = pgClientFor({
      DATABASE_URL: PRODUCTION_URLS[0],
      REQUESTPORT_PRODUCTION_DATABASE: "approved",
    });

    expect(construct().host).toBe("db-production-pooler.region-1.example.test");
  });

  test("refuses staging's own database, and lets a per-run one on its endpoint through", () => {
    expect(pgClientFor({ DATABASE_URL: STAGING_URL })).toThrow(
      /staging database.*REQUESTPORT_STAGING_DATABASE=approved/su,
    );
    expect(
      pgClientFor({
        DATABASE_URL: STAGING_URL,
        REQUESTPORT_STAGING_DATABASE: "approved",
      })().database,
    ).toBe("appdb");
    expect(
      pgClientFor({ DATABASE_URL: STAGING_ENDPOINT_PER_RUN_URL })().database,
    ).toBe("requestport_ci_1234_1_normal");
  });

  test("says nothing about any other database", () => {
    expect(
      pgClientFor({
        DATABASE_URL:
          "postgres://u:p@db-unrelated-pooler.region-1.example.test/appdb",
      })().database,
    ).toBe("appdb");
  });
});

describe("the PGlite driver, before it is started", () => {
  /*
   * Nothing here starts PGlite. This package's suites run on it in their own
   * lane (`pnpm --filter @requestport/db test:pglite`), where
   * testing.test.ts, transaction.test.ts and migrate.test.ts exercise it.
   */
  test("opens nothing until the first query", async () => {
    const dataDir = join(tmpdir(), `rp-e2-pglite-${randomUUID()}`);
    const storage = createStorage({ driver: "pglite", dataDir });

    expect(storage.driver).toBe("pglite");
    // PGlite creates its directory when it starts; it has not started.
    expect(existsSync(dataDir)).toBe(false);
    await storage.close();
    expect(existsSync(dataDir)).toBe(false);
  });

  test("takes a data directory, and refuses what only a server takes", () => {
    expect(() => createStorage({ driver: "pglite" })).toThrow(/dataDir/u);
    expect(() => createStorage({ driver: "pglite", dataDir: "" })).toThrow(
      /dataDir/u,
    );
    expect(() =>
      createStorage({
        driver: "pglite",
        dataDir: "memory://",
        connectionString: "postgresql://u:p@h.example/d",
      }),
    ).toThrow(/connection string/u);
    expect(() =>
      createStorage({
        driver: "pglite",
        dataDir: "memory://",
        password: () => "x",
      }),
    ).toThrow(/password/u);
    expect(() =>
      createStorage({
        driver: "pglite",
        dataDir: "memory://",
        pool: { max: 1, idleTimeoutMillis: 1, connectionTimeoutMillis: 1 },
      }),
    ).toThrow(/pool/u);
    expect(() =>
      createStorage({
        driver: "pglite",
        dataDir: "memory://",
        readRetry: true,
      }),
    ).toThrow(/read retry/iu);
  });

  test("without @electric-sql/pglite installed, a PGlite storage refuses in its own words, keeping Node's code, require stack and error as its cause (rulings 138, 151)", () => {
    const notFound = (specifier: string, code = "MODULE_NOT_FOUND") =>
      Object.assign(
        new Error(
          `Cannot find module '${specifier}'\nRequire stack:\n- /planted/core/dist/chunk.js`,
        ),
        { code, requireStack: ["/planted/core/dist/chunk.js"] },
      );

    // What `loadPgliteDriver` throws when its require of the package fails
    // that way: the package is installed here, so the error is planted.
    const absent = notFound("@electric-sql/pglite");
    const refusal = pgliteLoadError(absent);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toBe(PGLITE_ABSENT_MESSAGE);
    expect(PGLITE_ABSENT_MESSAGE).toMatch(
      /^A PGlite storage needs @electric-sql\/pglite, and it is not installed/u,
    );
    // Under S8 db's packed manifest declares PGlite as an optional peer, and
    // core's declares no peer (ruling 189); the message ships in db's tarball.
    expect(PGLITE_ABSENT_MESSAGE).toContain(
      "(@requestport/db declares it as an optional peer dependency)",
    );
    expect(refusal).toMatchObject({
      code: "MODULE_NOT_FOUND",
      requireStack: ["/planted/core/dist/chunk.js"],
    });
    expect((refusal as Error).cause).toBe(absent);

    // Anything else is Node's error, as Node raised it: a module under the
    // package or beside it, a code other than CommonJS's, and not an Error.
    for (const error of [
      notFound("@electric-sql/pglite/contrib/citext"),
      notFound("drizzle-orm/pglite"),
      notFound("@electric-sql/pglite", "ERR_MODULE_NOT_FOUND"),
      notFound("@electric-sql/pglite-tools"),
      "Cannot find module '@electric-sql/pglite'",
    ]) {
      expect(pgliteLoadError(error)).toBe(error);
    }
    // With the package installed, the driver loads.
    expect(typeof loadPgliteDriver().PGlite).toBe("function");
  });

  test("loadPgliteDriver throws that refusal when its own require cannot find @electric-sql/pglite, and Node's error when it cannot find a module under it", () => {
    const realPglite = loadPgliteDriver();
    const notFound = (specifier: string) =>
      Object.assign(
        new Error(
          `Cannot find module '${specifier}'\nRequire stack:\n- /planted/db/dist/client.js`,
        ),
        {
          code: "MODULE_NOT_FOUND",
          requireStack: ["/planted/db/dist/client.js"],
        },
      );
    // The loader's `require` is the one `process.getBuiltinModule` hands it,
    // so each case replaces that lookup with one whose `require` finds only
    // what `present` names.
    const withRequire = (present: readonly string[]) =>
      vi.spyOn(process, "getBuiltinModule").mockImplementation(
        () =>
          ({
            createRequire: () => (specifier: string) => {
              if (!present.includes(specifier)) throw notFound(specifier);
              return realPglite;
            },
          }) as never,
      );
    const thrown = (load: () => unknown) => {
      try {
        load();
      } catch (error) {
        return error as Error & { code?: unknown; requireStack?: unknown };
      }
      throw new Error("loadPgliteDriver did not throw");
    };

    const absent = withRequire([]);
    try {
      const refusal = thrown(loadPgliteDriver);
      expect(refusal.message).toBe(PGLITE_ABSENT_MESSAGE);
      expect(refusal.code).toBe("MODULE_NOT_FOUND");
      expect(refusal.requireStack).toEqual(["/planted/db/dist/client.js"]);
      expect((refusal.cause as Error).message).toMatch(
        /^Cannot find module '@electric-sql\/pglite'\n/u,
      );
    } finally {
      absent.mockRestore();
    }

    const citextMissing = withRequire(["@electric-sql/pglite"]);
    try {
      const error = thrown(loadPgliteDriver);
      expect(error.message).toMatch(
        /^Cannot find module '@electric-sql\/pglite\/contrib\/citext'\n/u,
      );
      expect(error.cause).toBeUndefined();
    } finally {
      citextMissing.mockRestore();
    }
  });

  test("the server drivers refuse a data directory, and need a connection string", () => {
    expect(() =>
      createStorage({
        driver: "pg",
        connectionString: "postgresql://u:p@h.example/d",
        dataDir: "memory://",
      }),
    ).toThrow(/dataDir/u);
    for (const driver of [...HOSTED_DRIVERS, "pg"] as const) {
      expect(() => createStorage({ driver }), driver).toThrow(
        /connection string/u,
      );
    }
  });
});

/*
 * PGlite's refusals in its own words (Plan 13, H.4): storage for one user in
 * one process, which `requestport start` serves from, and no longer "the
 * lane" (ruling 138, for client.ts's three; ruling 158, item 8, for
 * tenant-context.ts's). The last case starts PGlite, in memory, to hold its
 * one session.
 */
describe("PGlite's refusals, in its own words", () => {
  test("selectDriver on Vercel, a missing data directory, and the worker's logins on PGlite name what PGlite is, not the test lane", () => {
    expect(() =>
      selectDriver({
        REQUESTPORT_DATABASE_DRIVER: "pglite",
        VERCEL_ENV: "production",
      }),
    ).toThrow(
      "REQUESTPORT_DATABASE_DRIVER=pglite selects PGlite, single-session storage for one user in one process, which no Vercel deployment serves from. Unset it.",
    );
    expect(() =>
      storageOptionsFromEnv({ REQUESTPORT_DATABASE_DRIVER: "pglite" }),
    ).toThrow(
      "REQUESTPORT_DATABASE_DRIVER=pglite needs REQUESTPORT_PGLITE_DATA_DIR, the directory its database is in (or memory://). `requestport start` sets both for an instance on PGlite, and `pnpm --filter @requestport/db test:pglite` for its test lane.",
    );

    // Nothing is opened: the refusal comes before any storage is built.
    const env: NodeJS.ProcessEnv = {
      REQUESTPORT_DATABASE_DRIVER: "pglite",
      REQUESTPORT_PGLITE_DATA_DIR: "memory://",
    };
    for (const variable of Object.values(WORKER_DATABASE_URL_VARIABLES)) {
      env[variable] = "postgresql://worker:unused@127.0.0.1:1/unused";
    }
    expect(() => createWorkerStorages(env)).toThrow(
      "The worker's three roles log in to a PostgreSQL server, and a PGlite database has no logins: a worker on PGlite runs only inside requestport start, which asks for the embedded exception. Run this worker on PostgreSQL, with its three logins.",
    );
  });

  test("a second session on one PGlite storage is refused as work that needs a PostgreSQL server", async () => {
    const storage = createStorage({ driver: "pglite", dataDir: "memory://" });
    try {
      const first = await openSession(storage);
      try {
        await expect(openSession(storage)).rejects.toThrow(
          "PGlite has one connection, so a PGlite storage is single-session: a second session cannot be opened while one is checked out. Work that holds two sessions at once needs a PostgreSQL server, not PGlite.",
        );
      } finally {
        first.release();
      }
    } finally {
      await storage.close();
    }
  });
});

describe("closing", () => {
  for (const driver of [...HOSTED_DRIVERS, "pg", "pglite"] as const) {
    test(`${driver}: close() is idempotent and every later query rejects`, async () => {
      // PGlite is never started here: a storage that is closed before its
      // first query has nothing to shut down.
      const storage = createStorage(
        driver === "pglite"
          ? { driver, dataDir: "memory://" }
          : { driver, connectionString: "postgresql://u:p@db.invalid/test" },
      );

      const first = storage.close();
      const second = storage.close();

      expect(second).toBe(first);
      await first;
      // Drizzle wraps the driver's refusal in its own "Failed query" error.
      const refused = await storage.db.execute(sql`select 1`).then(
        () => undefined,
        (error: unknown) => error as Error & { cause?: Error },
      );

      expect(refused?.cause?.message).toMatch(/after calling end/u);
    });
  }
});

/*
 * The host's handoff (Plan 13, H.5; manifest-h.md §2.7.1; rulings 145 and
 * 160): while `globalThis[Symbol.for("requestport.host")]` is set,
 * `createStorage` builds only for a caller whose options carry a
 * construction token the handoff's `admitsConstruction` admits, and refuses
 * any other with a named error and one console line. Unset, as on Vercel and
 * in the Trigger.dev worker, which never set it, it builds as it always has.
 */
describe("createStorage and the host's handoff", () => {
  const HOST = Symbol.for("requestport.host");
  const holder = globalThis as Record<symbol, unknown>;
  const pgOptions = {
    driver: "pg" as const,
    connectionString: `postgres://requestport:${SENTINEL}@127.0.0.1:1/requestport`,
  };
  const built: Storage[] = [];
  const refusalLine =
    "HostHandoffRefusalError: RequestPort's createStorage refused: the " +
    "host's handoff is present, and the caller passed no construction " +
    "token it admits. While it is present, the web answers the storage, " +
    "Better Auth and RequestPort it carries and builds none of its own " +
    "(manifest-h.md §2.7.1).";

  afterEach(async () => {
    delete holder[HOST];
    vi.restoreAllMocks();
    await Promise.all(built.splice(0).map((storage) => storage.close()));
  });

  /** Captures console.error's lines, and prints none. */
  function consoleErrors() {
    return vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  /** What createStorage threw, or undefined when it built. */
  function refusalOf(build: () => Storage): unknown {
    try {
      built.push(build());
    } catch (error) {
      return error;
    }
    return undefined;
  }

  test("absent, it builds as it always has, and writes nothing to the console", () => {
    const logged = consoleErrors();

    expect(HOST in holder).toBe(false);
    expect(refusalOf(() => createStorage(pgOptions))).toBeUndefined();
    expect(built.map((storage) => storage.driver)).toEqual(["pg"]);
    expect(logged).not.toHaveBeenCalled();
  });

  test("present, it refuses a caller that passes no token before it reads any other option, with HostHandoffRefusalError and one console line naming createStorage", () => {
    const logged = consoleErrors();
    holder[HOST] = { admitsConstruction: () => true };

    // An unknown driver is refused as a driver when it is read; here the
    // construction is refused first.
    const refusal = refusalOf(() =>
      createStorage({ driver: "unknown" as never }),
    );

    expect(refusal).toBeInstanceOf(HostHandoffRefusalError);
    expect((refusal as Error).name).toBe("HostHandoffRefusalError");
    expect(`${(refusal as Error).name}: ${(refusal as Error).message}`).toBe(
      refusalLine,
    );
    expect(logged.mock.calls).toEqual([[refusalLine]]);
    expect(built).toEqual([]);
  });

  test("present, it refuses a token the handoff does not admit, and names no value", () => {
    const logged = consoleErrors();
    const token = Object.freeze({});
    holder[HOST] = {
      admitsConstruction: (candidate: unknown) => candidate === token,
    };

    const refusal = refusalOf(() =>
      createStorage(withHostConstructionToken(pgOptions, Object.freeze({}))),
    );

    expect(refusal).toBeInstanceOf(HostHandoffRefusalError);
    expect(logged.mock.calls).toEqual([[refusalLine]]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SENTINEL);
    expect(built).toEqual([]);
  });

  test("present without admitsConstruction, it refuses every token", () => {
    const logged = consoleErrors();
    holder[HOST] = { storage: {} };

    const refusal = refusalOf(() =>
      createStorage(withHostConstructionToken(pgOptions, Object.freeze({}))),
    );

    expect(refusal).toBeInstanceOf(HostHandoffRefusalError);
    expect(logged.mock.calls).toEqual([[refusalLine]]);
  });

  test("present, it builds for the token the handoff admits, handed through withHostConstructionToken, and writes nothing to the console", () => {
    const logged = consoleErrors();
    const token = Object.freeze({});
    const asked: unknown[] = [];
    holder[HOST] = {
      admitsConstruction: (candidate: unknown) => {
        asked.push(candidate);
        return candidate === token;
      },
    };

    const refusal = refusalOf(() =>
      createStorage(withHostConstructionToken(pgOptions, token)),
    );

    expect(refusal).toBeUndefined();
    expect(built.map((storage) => storage.driver)).toEqual(["pg"]);
    expect(asked).toEqual([token]);
    expect(logged).not.toHaveBeenCalled();
  });
});

/*
 * The public tree's driver modules (Plan 13, J.2b; ruling 175, owner question
 * 3). The seed carries `hosted-driver.public.ts` and
 * `hosted-migrator.public.ts` at the private modules' paths
 * (`release/public-tree.json`, `substitute`), so each must export what the
 * private one does, and `client.ts` must select, refuse and build over the
 * public variant as the public tree will. Here the public variants are
 * imported beside the modules this tree resolves, and the selection cases
 * load a fresh `client.ts` whose `./hosted-driver.js` is the public variant.
 * In the seed both are the public variant, and every case holds the same.
 */
describe("the public tree's driver modules (hosted-driver.public.ts, hosted-migrator.public.ts)", () => {
  afterEach(() => {
    vi.doUnmock("./hosted-driver.js");
    vi.resetModules();
  });

  /** `./client.js` from a fresh module graph over the public variant. */
  async function publicClient() {
    vi.doMock("./hosted-driver.js", () => import("./hosted-driver.public.js"));
    vi.resetModules();
    return import("./client.js");
  }

  test("each public variant exports exactly its private module's names", () => {
    expect(Object.keys(hostedDriverPublic).sort()).toEqual(
      Object.keys(hostedDriver).sort(),
    );
    expect(Object.keys(hostedMigratorPublic).sort()).toEqual(
      Object.keys(hostedMigrator).sort(),
    );
  });

  test("the public variant has no hosted driver: no name, no package, no proxy, no storage and no migrator", async () => {
    expect(hostedDriverPublic.kind).toBe("public");
    expect(hostedMigratorPublic.kind).toBe("public");
    expect(hostedDriverPublic.HOSTED_DRIVERS).toEqual([]);
    expect(hostedDriverPublic.DEFAULT_DRIVER).toBe("pg");
    expect(hostedDriverPublic.HOSTED_DRIVER_PACKAGES).toEqual([]);
    expect(hostedDriverPublic.HOSTED_DRIVER_MODULES).toEqual([]);
    expect(hostedDriverPublic.LOCAL_PROXY_VARIABLE).toBeUndefined();
    for (const value of ["pg", "pglite", "", "hosted", undefined]) {
      expect(hostedDriverPublic.isHostedDriver(value), String(value)).toBe(
        false,
      );
    }
    for (const env of [{}, { VERCEL_ENV: "preview" }]) {
      expect(hostedDriverPublic.localProxyTarget(env)).toBeUndefined();
      expect(hostedDriverPublic.applyLocalProxy(env)).toBe(false);
    }
    expect(hostedDriverPublic.isHostedServerError(new Error("x"))).toBe(false);
    expect(hostedDriverPublic.isHostedSession({})).toBe(false);
    expect(() =>
      hostedDriverPublic.createHostedStorage(
        { driver: "pg", connectionString: "postgresql://u:p@db.invalid/d" },
        {} as never,
      ),
    ).toThrow(
      "This build has no hosted driver: its drivers are pg and PGlite.",
    );
    expect(() => hostedDriverPublic.drizzleOverHosted({})).toThrow(
      "This build has no hosted driver",
    );
    await expect(
      hostedMigratorPublic.migrateHosted({}, { migrationsFolder: "." }),
    ).rejects.toThrow("This build has no hosted driver");
  });

  test("selects pg when REQUESTPORT_DATABASE_DRIVER is unset or empty, whatever else the environment says, and pg or PGlite when it names them", async () => {
    const { selectDriver: select, storageOptionsFromEnv: optionsFrom } =
      await publicClient();

    for (const env of [
      {},
      { REQUESTPORT_DATABASE_DRIVER: "" },
      { VERCEL_ENV: "production" },
      { VERCEL_ENV: "preview" },
      { VERCEL_ENV: "" },
      { TRIGGER_DEPLOYMENT_ID: "deployment_x" },
      { REQUESTPORT_PGLITE_DATA_DIR: "/tmp/requestport-pglite-lane" },
    ]) {
      expect(select(env), JSON.stringify(env)).toBe("pg");
      expect(optionsFrom(env).driver, JSON.stringify(env)).toBe("pg");
    }
    expect(select({ REQUESTPORT_DATABASE_DRIVER: "pg" })).toBe("pg");
    expect(select({ REQUESTPORT_DATABASE_DRIVER: "pglite" })).toBe("pglite");
    expect(() =>
      select({ REQUESTPORT_DATABASE_DRIVER: "pglite", VERCEL_ENV: "" }),
    ).toThrow(/pglite/u);
  });

  test("refuses any other value without echoing it, naming pg and PGlite, and builds a storage on no other driver", async () => {
    const { selectDriver: select, createStorage: build } = await publicClient();

    for (const value of ["postgres", "PG", " pg", "hosted", SENTINEL]) {
      expect(
        () => select({ REQUESTPORT_DATABASE_DRIVER: value }),
        value,
      ).toThrow(
        'REQUESTPORT_DATABASE_DRIVER is set to a value this build does not recognise. Unset it for pg, or set it to "pg" or "pglite".',
      );
    }
    expect(() =>
      build({
        driver: "hosted" as never,
        connectionString: "postgresql://u:p@db.invalid/d",
      }),
    ).toThrow("Unknown database driver.");

    const storage = build({
      driver: "pg",
      connectionString: "postgresql://u:p@db.invalid/d",
    });
    try {
      expect(storage.driver).toBe("pg");
    } finally {
      await storage.close();
    }
  });
});

describe("the package barrel", () => {
  test("hands out createStorage, and not a default storage, its handle, its readiness probe or its shutdown hook, nor the pool, the pg loader, the wiring or the test helpers", async () => {
    /*
     * createStorage is public since G.1 (manifest-g.md §2.2, Done when 12):
     * E's contract names it as public surface. tenant-scope-sweep.test.ts
     * pins client.ts's barrel exports, and its model counts createStorage
     * as the one name that yields a handle. storageOptionsFromEnv and its
     * application twin are repository-internal wiring (track-e.md, the
     * storage contract), so they are on ./wiring, the roots' subpath, and
     * not here. G.5 retired the
     * process's default storage and what hung on it: its handle `db`, the
     * readiness probe `checkDatabaseReadiness` and Track C's shutdown hook
     * `closeDatabase`. A caller builds its own storage, and asks that
     * storage's `ready()` and `close()`.
     */
    const publicApi = await import("./index.js");
    const keys = Object.keys(publicApi);

    expect(keys).toContain("createStorage");
    for (const internal of [
      "checkDatabaseReadiness",
      "closeDatabase",
      "db",
      "defaultStorage",
      "driverPoolOf",
      "loadPgDriver",
      "loadPgliteDriver",
      "migrate",
      "openSession",
      "rawQuery",
      "storageOptionsFromEnv",
      "applicationStorageOptionsFromEnv",
      "testPool",
    ]) {
      expect(keys, internal).not.toContain(internal);
    }
  });
});

/*
 * What importing the package does (Plan 13, G.5): nothing a process can see.
 * No storage is built, so no tenant binding is recorded (`createStorage`
 * installs that record on `globalThis` with its first call), no variable is
 * read, and the hosted driver's settings are left as they were: its local
 * proxy is applied where a storage on it is built, by a composition root
 * (`wiring.ts`), `createTestStorage` (`testing.ts`) or the E2E owner storage.
 * The half a Vitest process can hold reads that driver's settings, so it is
 * the private tree's hosted-driver.test.ts's, as it stood before J.2b. The
 * other half, Done when 1's, is the case below: a process started with an
 * empty environment.
 */
describe("importing the package", () => {
  /*
   * Done when 1, packages/db's part (manifest-g.md §7): imported with an
   * empty environment, as `env -i` starts a process, the package constructs
   * nothing and opens no connection, and its own code reads no variable and
   * installs no global. Of its dependencies, the hosted driver's package,
   * where the tree has one, reads two variables, and zod installs two globals
   * (below).
   * The child imports each subpath `package.json` exports, by the package's
   * own name, with `process.env` replaced by a proxy that records every read
   * and the frame that made it. Node strips the sources' types
   * (`--experimental-transform-types`), and a resolve hook maps their `.js`
   * specifiers to the `.ts` files: the one thing a TypeScript loader would add
   * here, and packages/db depends on none.
   *
   * What it asserts:
   * - the child's environment is empty, but for the one variable macOS adds
   *   (below);
   * - no module of this repository's, packages/db's or a workspace package's
   *   it imports, reads a variable: by name, by `in`, by its descriptor, or
   *   the list of names;
   * - no symbol joins `globalThis`, so no storage was built (`createStorage`
   *   installs the tenant-binding record with its first call) and no root
   *   holds one;
   * - no resource is left active: no socket, no timer, no lookup;
   * - what the dependencies do as they load, pinned so that a change is read:
   *   the hosted driver's package (`HOSTED_DRIVER_PACKAGES`; none in the
   *   public tree) reads `USER` and `NODE_PG_FORCE_NATIVE`, for the pg
   *   defaults it bundles, and zod 4 installs `__zod_globalConfig` and
   *   `__zod_globalRegistry`. Done when 1's words allow neither. Whether
   *   this case meets it with them pinned is the driver's ruling, not made at
   *   this commit (track-g.md, "G.5, after the independent review").
   *
   * A read made by Node's own code, its loader's or its source-map cache's,
   * is Node's, even where a module's call led to it. A pool constructed
   * without `createStorage`, reading nothing, would not show here; Done when
   * 2's pin (index.test.ts) refuses a driver's class constructed as a module
   * loads.
   */
  test("in a process started with an empty environment, as env -i starts one, importing each subpath reads no variable in this repository's code, installs no global of its own and opens nothing (Done when 1)", {
    timeout: 120_000,
  }, () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { name: string; exports: Record<string, string> };
    const subpaths = Object.keys(manifest.exports).map((subpath) =>
      subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
    );
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--no-warnings",
        "--input-type=module",
        "--eval",
        importProbe(subpaths),
      ],
      { cwd: packageRoot, env: {}, encoding: "utf8", timeout: 100_000 },
    );

    expect({ status: child.status, stderr: child.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    const report = JSON.parse(child.stdout) as {
      environment: string[];
      reads: Array<{ variable: string; reader: string; importing: string }>;
      globals: string[];
      symbols: string[];
      resources: string[];
    };
    const repositoryReads: string[] = [];
    const dependencyReads = new Set<string>();
    const unattributed: string[] = [];
    for (const { variable, reader, importing } of report.reads) {
      const location = reader
        .replace(/^at (?:.*? \()?/u, "")
        .replace(/\)$/u, "");
      if (location.startsWith("node:")) continue;
      // An ".mjs" frame names a file URL; one Node stripped the types of
      // names its path.
      const file = location.replace(/:\d+:\d+$/u, "");
      const path = file.startsWith("file:")
        ? fileURLToPath(file)
        : file.startsWith("/")
          ? file
          : undefined;
      const line = location.match(/:(\d+):\d+$/u)?.[1];
      if (path === undefined) {
        unattributed.push(`${reader} reads ${variable}`);
      } else if (path.includes("/node_modules/")) {
        const [scope, name] = (path.split("/node_modules/").at(-1) ?? "").split(
          "/",
        );
        dependencyReads.add(
          `${scope?.startsWith("@") ? `${scope}/${name}` : scope} reads ${variable}`,
        );
      } else {
        repositoryReads.push(
          `${relative(repositoryRoot, path)}:${line} reads ${variable}, importing ${importing}`,
        );
      }
    }

    expect(subpaths).toEqual([
      "@requestport/db",
      "@requestport/db/e2e",
      "@requestport/db/migrate",
      "@requestport/db/testing",
      "@requestport/db/wiring",
    ]);
    expect({
      // macOS's CoreFoundation gives a process that starts without it
      // `__CF_USER_TEXT_ENCODING`; `env -i node` holds it too. Nothing else
      // is there.
      environment: report.environment.filter(
        (name) => name !== "__CF_USER_TEXT_ENCODING",
      ),
      repositoryReads,
      dependencyReads: [...dependencyReads].sort(),
      unattributed,
      globals: [...report.globals].sort(),
      symbols: report.symbols,
      resources: report.resources,
    }).toEqual({
      environment: [],
      repositoryReads: [],
      dependencyReads: HOSTED_DRIVER_PACKAGES.flatMap((name) => [
        `${name} reads NODE_PG_FORCE_NATIVE`,
        `${name} reads USER`,
      ]),
      unattributed: [],
      globals: ["__zod_globalConfig", "__zod_globalRegistry"],
      symbols: [],
      resources: [],
    });
  });
});

/**
 * The program Done when 1's child runs (above): it imports each of
 * `subpaths` with `process.env` replaced by a proxy that records each read
 * with the first frame below the program's own, and writes one line of JSON:
 * the environment's names when it started, the reads, and the globals, the
 * symbols and the active resources the imports added.
 */
function importProbe(subpaths: readonly string[]): string {
  return [
    'import { registerHooks } from "node:module";',
    "registerHooks({",
    "  resolve(specifier, context, nextResolve) {",
    "    try {",
    "      return nextResolve(specifier, context);",
    "    } catch (error) {",
    '      if (error?.code === "ERR_MODULE_NOT_FOUND" && /^\\.\\.?\\//u.test(specifier) && specifier.endsWith(".js")) {',
    '        return nextResolve(specifier.slice(0, -3) + ".ts", context);',
    "      }",
    "      throw error;",
    "    }",
    "  },",
    "});",
    "const environment = Object.keys(process.env);",
    "void process.stdout;",
    "void process.stderr;",
    "const names = new Set(Object.getOwnPropertyNames(globalThis));",
    "const symbols = new Set(Object.getOwnPropertySymbols(globalThis));",
    "const before = process.getActiveResourcesInfo();",
    "const reads = [];",
    "let importing;",
    "const record = (variable) => {",
    '  const frames = new Error().stack.split("\\n").slice(1);',
    '  const reader = frames.find((frame) => !frame.includes("[eval"));',
    '  reads.push({ variable, reader: reader === undefined ? "" : reader.trim(), importing });',
    "};",
    "const original = process.env;",
    "process.env = new Proxy(original, {",
    '  get(target, key, receiver) { if (typeof key === "string") record(key); return Reflect.get(target, key, receiver); },',
    '  has(target, key) { if (typeof key === "string") record(key); return Reflect.has(target, key); },',
    '  ownKeys(target) { record("(its names)"); return Reflect.ownKeys(target); },',
    '  getOwnPropertyDescriptor(target, key) { if (typeof key === "string") record(key); return Reflect.getOwnPropertyDescriptor(target, key); },',
    "});",
    `for (const subpath of ${JSON.stringify(subpaths)}) {`,
    "  importing = subpath;",
    "  await import(subpath);",
    "}",
    "process.env = original;",
    "const resources = process.getActiveResourcesInfo();",
    "for (const resource of before) {",
    "  const at = resources.indexOf(resource);",
    "  if (at !== -1) resources.splice(at, 1);",
    "}",
    "process.stdout.write(JSON.stringify({",
    "  environment,",
    "  reads,",
    "  globals: Object.getOwnPropertyNames(globalThis).filter((name) => !names.has(name)),",
    "  symbols: Object.getOwnPropertySymbols(globalThis).filter((symbol) => !symbols.has(symbol)).map(String),",
    "  resources,",
    "}));",
  ].join("\n");
}
