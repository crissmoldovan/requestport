import { sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, test, vi } from "vitest";

import {
  createStorage,
  type Database,
  type DatabaseDriver,
  driverPoolOf,
  selectDriver,
} from "./client.js";
import { HOSTED_DRIVERS, LOCAL_PROXY_VARIABLE } from "./hosted-driver.js";
import {
  createTestStorage,
  openSession,
  rawQuery,
  testPool,
  testPoolOfHandle,
} from "./testing.js";

/*
 * The refusal of a shared database is proved here through
 * `createTestStorage`, for either driver, against a synthetic list: the
 * private `./shared-databases.js` is replaced by one naming the synthetic
 * hosts below by their digests (ruling 91, option (d)), so this file names no
 * shared database's host. The hosts lie under the
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

/*
 * The test accessors (track-e.md, contract §4.3): what the suites reach the
 * pool through instead of a handle's `$client`, which the public `Database`
 * type does not carry. This proves them, on the server drivers.
 */

/**
 * Whether this run names the hosted driver's local proxy, the only way that
 * driver reaches a plain PostgreSQL (`localProxyTarget` in `hosted-driver.ts`):
 * never, in a tree without a hosted driver.
 */
const hostedProxy =
  LOCAL_PROXY_VARIABLE === undefined
    ? undefined
    : process.env[LOCAL_PROXY_VARIABLE];
const hostedReachable =
  typeof hostedProxy === "string" && hostedProxy.trim() !== "";
// The PGlite lane dials no server: it runs the PGlite cases and skips these.
const pgliteLane = selectDriver(process.env) === "pglite";

describe("testPool, the accessor for $client", () => {
  test("has no default: called with no storage it is refused, and so is openSession", async () => {
    // Neither has a storage to fall back to, since G.5 retired the package's
    // default one: the caller names the storage whose pool it reaches.
    // @ts-expect-error testPool takes the storage whose pool it returns.
    expect(() => testPool()).toThrow("Not a storage created by createStorage.");
    await expect(
      // @ts-expect-error openSession takes the storage it checks a connection out of.
      openSession(),
    ).rejects.toThrow("Not a storage created by createStorage.");
  });

  test("is any storage's own pool when given one", () => {
    const storage = createStorage({
      driver: "pg",
      connectionString: "postgresql://u:p@db.invalid/test",
    });
    const other = createStorage({
      driver: "pg",
      connectionString: "postgresql://u:p@db.invalid/test",
    });

    expect(testPool(storage)).toBe(driverPoolOf(storage));
    expect(testPool(storage)).not.toBe(testPool(other));
  });
});

describe("testPoolOfHandle, the accessor for a handle's $client", () => {
  test("is the pool behind a storage's own handle", () => {
    const storage = createStorage({
      driver: "pg",
      connectionString: "postgresql://u:p@db.invalid/test",
    });

    expect(testPoolOfHandle(storage.db)).toBe(testPool(storage));
  });

  test("is the pool of the module graph the handle came from, which testPool does not see", async () => {
    // A suite that imports @requestport/db afresh can hold a storage that
    // graph's createStorage built, and only its handle. This module's testPool
    // knows only the storages this graph's createStorage built.
    vi.resetModules();
    const fresh = await import("./client.js");
    const storage = fresh.createStorage({
      driver: "pg",
      connectionString: "postgresql://u:p@db.invalid/test",
    });

    try {
      expect(testPoolOfHandle(storage.db)).toBe(fresh.storageClientOf(storage));
      expect(() => testPool(storage)).toThrow(
        "Not a storage created by createStorage.",
      );
    } finally {
      // Ending a pool that never connected opens no connection.
      await storage.close();
      vi.resetModules();
    }
  });

  test("refuses a handle that holds no client", () => {
    expect(() => testPoolOfHandle({} as unknown as Database)).toThrow(
      /holds no client/u,
    );
  });
});

describe("createTestStorage, the only way a suite here builds a storage of its own", () => {
  /*
   * createStorage never refuses an explicit connection string (contract §3.7
   * leaves that to the caller), and these suites are the caller. pg dials the
   * URL's host directly; so does the hosted driver without its local proxy.
   */
  const production =
    "postgres://u:p@db-production-pooler.region-1.example.test/appdb";
  const unrelated = "postgres://u:p@db.invalid:5432/rp_unrelated";

  test("refuses production on either driver, from DATABASE_URL or an explicit string", () => {
    for (const driver of ["pg", ...HOSTED_DRIVERS] as DatabaseDriver[]) {
      expect(() =>
        createTestStorage({ driver, env: { DATABASE_URL: production } }),
      ).toThrow(/production database/u);
      expect(() =>
        createTestStorage({
          driver,
          connectionString: production,
          env: { DATABASE_URL: unrelated },
        }),
      ).toThrow(/production database/u);
    }
  });

  test("refuses production wherever the driver reads its host from", () => {
    /*
     * Each server driver parses the string with pg-connection-string's rules:
     * a `host` in the query replaces the authority's (measured 2026-09-28 on
     * pg 8.23.0, and on the private tree's hosted driver at its package's
     * 1.1.0), and the authority's host is percent-decoded, where WHATWG URL
     * leaves a `postgres:` host encoded.
     */
    for (const url of [
      "postgres://u:p@127.0.0.1:55432/appdb?host=db-production-pooler.region-1.example.test",
      "postgres://u:p@127.0.0.1:55432/appdb?sslmode=disable&host=127.0.0.1&host=db-production.region-1.example.test",
      "postgres://u:p@db%2Dproduction%2Dpooler.region-1.example.test/appdb",
    ]) {
      for (const driver of ["pg", ...HOSTED_DRIVERS] as DatabaseDriver[]) {
        expect(
          () =>
            createTestStorage({
              driver,
              connectionString: url,
              env: { DATABASE_URL: unrelated },
            }),
          `${driver} ${url}`,
        ).toThrow(/production database/u);
      }
    }
  });

  test("builds a storage over this run's database, or the one it is given", async () => {
    const own = createTestStorage({
      driver: "pg",
      env: { DATABASE_URL: unrelated },
    });
    const approved = createTestStorage({
      driver: "pg",
      connectionString: production,
      env: {
        DATABASE_URL: unrelated,
        REQUESTPORT_PRODUCTION_DATABASE: "approved",
      },
    });

    try {
      expect(own.driver).toBe("pg");
      expect(approved.driver).toBe("pg");
    } finally {
      await Promise.all([own.close(), approved.close()]);
    }
  });
});

for (const [driver, skip] of [
  ["pg", pgliteLane],
  ...HOSTED_DRIVERS.map((hosted) => [hosted, !hostedReachable || pgliteLane]),
] as [DatabaseDriver, boolean][]) {
  describe.skipIf(skip)(`${driver}: sessions and raw queries`, () => {
    const storage = createTestStorage({ driver });

    afterAll(async () => {
      await storage.close();
    });

    test("rawQuery returns rows, with parameters", async () => {
      const result = await rawQuery<{ n: number }>(
        storage,
        "select $1::int + 1 as n",
        [41],
      );

      expect(result.rows).toEqual([{ n: 42 }]);
    });

    test("a session is one dedicated connection, and two sessions are two", async () => {
      const first = await openSession(storage);
      const second = await openSession(storage);

      try {
        const pid = async (session: typeof first) =>
          (
            await session.query<{ pid: number }>(
              "select pg_backend_pid() as pid",
            )
          ).rows[0]?.pid;

        const firstPid = await pid(first);

        expect(await pid(first)).toBe(firstPid);
        expect(await pid(second)).not.toBe(firstPid);

        // The session's Drizzle handle is bound to the same connection.
        const viaDrizzle = await first.db.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );

        expect(viaDrizzle.rows[0]?.pid).toBe(firstPid);
      } finally {
        first.release();
        second.release();
      }
    });

    test("a session holds an open transaction that another session cannot see", async () => {
      const first = await openSession(storage);
      const second = await openSession(storage);

      try {
        await first.query("begin");
        await first.query("create temporary table e2_session_probe (n int)");
        await first.db.execute(sql`insert into e2_session_probe values (1)`);

        const seen = await first.query<{ n: number }>(
          "select count(*)::int as n from e2_session_probe",
        );

        expect(seen.rows[0]?.n).toBe(1);

        // A temporary table belongs to the session that made it.
        await expect(
          second.query("select count(*) from e2_session_probe"),
        ).rejects.toThrow(/e2_session_probe/u);
      } finally {
        await first.query("rollback").catch(() => undefined);
        first.release();
        second.release();
      }
    });

    test("release returns the connection to the pool", async () => {
      const pool = driverPoolOf(storage);
      const session = await openSession(storage);
      const idleWhileHeld = pool.idleCount;

      session.release();
      expect(pool.idleCount).toBe(idleWhileHeld + 1);
    });
  });
}

describe.skipIf(!pgliteLane)(
  "pglite: one connection, so one session at a time",
  () => {
    /*
     * PGlite has one connection (track-e.md, contract §4.3). The lane's storage
     * says so by refusing, where a pool would have handed out a second
     * connection: a second session, and a query through the storage itself
     * while a session holds the connection, which would otherwise run inside
     * that session's transaction and change what a test proves.
     */
    const storage = createTestStorage({ driver: "pglite" });

    afterAll(async () => {
      await storage.close();
    });

    test("rawQuery returns rows, with parameters", async () => {
      const result = await rawQuery<{ n: number }>(
        storage,
        "select $1::int + 1 as n",
        [41],
      );

      expect(result.rows).toEqual([{ n: 42 }]);
      expect(result.rowCount).toBe(1);
    });

    test("reads int8 as a string, as the server drivers do", async () => {
      // pg-types, which both server drivers use, leaves int8 as text, since it
      // can exceed a double; PGlite's default parses it to a number (measured).
      // Code written against the server drivers — `count(...) over ()` in the
      // appearance migration suite, for one — reads the string.
      const result = await rawQuery<{ n: unknown; list: unknown }>(
        storage,
        "select count(*) over () as n, array[1, 9007199254740993]::int8[] as list",
      );

      expect(result.rows).toEqual([
        { n: "1", list: ["1", "9007199254740993"] },
      ]);
    });

    test("a second session is refused while one is checked out", async () => {
      const first = await openSession(storage);

      try {
        await expect(openSession(storage)).rejects.toThrow(/single-session/u);
      } finally {
        first.release();
      }
    });

    test("the storage's own handle is refused while a session holds the connection", async () => {
      const session = await openSession(storage);

      try {
        await expect(rawQuery(storage, "select 1")).rejects.toThrow(
          /session has it checked out/u,
        );
        const refused = await storage.db.execute(sql`select 1`).then(
          () => undefined,
          (error: unknown) => error as Error & { cause?: Error },
        );

        expect(refused?.cause?.message ?? refused?.message).toMatch(
          /session has it checked out/u,
        );
        // The session's own Drizzle handle is bound to the connection it holds.
        const viaSession = await session.db.execute<{ n: number }>(
          sql`select 2 as n`,
        );

        expect(viaSession.rows).toEqual([{ n: 2 }]);
      } finally {
        session.release();
      }

      await expect(storage.ready()).resolves.toBeUndefined();
    });

    test("a session's Drizzle handle selects rows by column, outside a transaction", async () => {
      // Drizzle's PGlite driver asks for array rows and its own parsers on a
      // select with fields, and maps columns by position; the session must
      // pass those options on, or every column reads as undefined.
      const probe = pgTable("e2_pglite_select_probe", {
        id: integer("id").notNull(),
        name: text("name").notNull(),
        at: timestamp("at", { withTimezone: true, mode: "string" }).notNull(),
      });
      const session = await openSession(storage);

      try {
        await session.query(
          "create temporary table e2_pglite_select_probe (id int not null, name text not null, at timestamptz not null)",
        );
        await session.query(
          "insert into e2_pglite_select_probe values (1, 'a', '2026-09-28T12:00:00Z')",
        );

        const rows = await session.db.select().from(probe);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(1);
        expect(rows[0]?.name).toBe("a");
        expect(new Date(`${rows[0]?.at ?? ""}`).toISOString()).toBe(
          "2026-09-28T12:00:00.000Z",
        );
      } finally {
        await session.query("drop table if exists e2_pglite_select_probe");
        session.release();
      }
    });

    test("a session holds its transaction until it ends it", async () => {
      const session = await openSession(storage);

      try {
        await session.query("begin");
        await session.query("create temporary table e2_pglite_probe (n int)");
        await session.db.execute(sql`insert into e2_pglite_probe values (1)`);

        const seen = await session.query<{ n: number }>(
          "select count(*)::int as n from e2_pglite_probe",
        );

        expect(seen.rows[0]?.n).toBe(1);
      } finally {
        await session.query("rollback");
        session.release();
      }

      // Rolled back with the transaction that created it.
      await expect(
        rawQuery(storage, "select count(*) from e2_pglite_probe"),
      ).rejects.toThrow(/e2_pglite_probe/u);
    });

    test("a session released with an error rolls back what it left open", async () => {
      // A pool destroys such a connection, which ends its transaction; the one
      // PGlite connection cannot be destroyed, so it is rolled back instead.
      const session = await openSession(storage);

      await session.query("begin");
      await session.query("create temporary table e2_pglite_abandoned (n int)");
      session.release(new Error("abandoned"));

      await expect(
        rawQuery(storage, "select count(*) from e2_pglite_abandoned"),
      ).rejects.toThrow(/e2_pglite_abandoned/u);
      const open = await rawQuery<{ n: number }>(
        storage,
        "select count(*)::int as n from pg_stat_activity where state like 'idle in transaction%'",
      );

      expect(open.rows[0]?.n ?? 0).toBe(0);
    });

    test("a released session cannot be used again", async () => {
      const session = await openSession(storage);

      session.release();
      await expect(session.query("select 1")).rejects.toThrow(/released/u);
    });

    test("testPool is PGlite's single-session stand-in, the same object db.$client is", () => {
      expect(testPool(storage)).toBe(testPoolOfHandle(storage.db));
    });
  },
);
