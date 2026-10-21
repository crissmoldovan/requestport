import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  type Database,
  type DatabaseDriver,
  driverPoolOf,
  loadPgDriver,
  loadPgliteDriver,
  type Storage,
  selectDriver,
  storageClientOf,
} from "./client.js";
import {
  drizzleOverHosted,
  HOSTED_DRIVERS,
  isHostedDriver,
  LOCAL_PROXY_VARIABLE,
} from "./hosted-driver.js";
import * as schema from "./schema/index.js";
import { takeConcurrentQueries } from "./test-support/one-query-at-a-time.js";
import { createTestStorage } from "./testing.js";
import type { Tx } from "./transaction.js";

/*
 * The transaction contract, proved per driver (track-e.md, contract §3.5).
 *
 * A transaction gets a session of its own only because Drizzle's session
 * decides the handle it holds is a pool — the hosted driver's by `instanceof
 * Pool`, pg's by that or a constructor name containing "Pool" — and checks a
 * connection out. The private tree's `hosted-driver.ts` records, beside the
 * hosted driver's pool, what a wrapper did to that: five transaction tests
 * rolled back against the pool instead of one session.
 * A comment cannot catch the next wrapper; these can, because they test the
 * behaviour rather than the `instanceof`.
 *
 * The hosted driver's cases, where the tree has that driver, need its local
 * WebSocket proxy, the only way that driver reaches a plain PostgreSQL;
 * without it they are skipped, by name. The PGlite cases run only in the
 * PGlite lane, which dials no server and so skips the others.
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
const pgliteLane = selectDriver(process.env) === "pglite";

const drivers: { driver: DatabaseDriver; skip: boolean }[] = [
  { driver: "pg", skip: pgliteLane },
  ...HOSTED_DRIVERS.map((driver) => ({
    driver,
    skip: !hostedReachable || pgliteLane,
  })),
];

async function backendPid(handle: Database | Tx): Promise<number> {
  const result = await handle.execute<{ pid: number }>(
    sql`select pg_backend_pid() as pid`,
  );

  return Number(result.rows[0]?.pid);
}

/** Two statements at once, then one more, all on the handle given. */
async function pidsOf(handle: Database | Tx) {
  const [first, second] = await Promise.all([
    backendPid(handle),
    backendPid(handle),
  ]);

  return [first, second, await backendPid(handle)];
}

/*
 * `pidsOf`'s two statements at once on one transaction are what these cases
 * are about, so on pg the one-query-at-a-time guard
 * (`test-support/one-query-at-a-time.ts`, X24) records the second, and the
 * case takes that record rather than failing on it. The guard watches only
 * pg's client, so on the hosted driver it records nothing.
 */
function expectTwoAtOnce(driver: DatabaseDriver) {
  expect(takeConcurrentQueries().map(({ issued }) => issued)).toEqual(
    driver === "pg" ? ["select pg_backend_pid() as pid"] : [],
  );
}

class Rollback extends Error {}

for (const { driver, skip } of drivers) {
  describe.skipIf(skip)(`${driver}: a transaction is one session`, () => {
    const table = `e2_tx_conformance_${randomUUID().replaceAll("-", "")}`;
    let storage: Storage;

    const count = async (id: string, handle: Database | Tx = storage.db) => {
      const result = await handle.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table)} where id = ${id}`,
      );

      return Number(result.rows[0]?.n);
    };

    const insert = (handle: Database | Tx, id: string) =>
      handle.execute(
        sql`insert into ${sql.identifier(table)} (id) values (${id})`,
      );

    beforeAll(async () => {
      storage = createTestStorage({ driver });
      await storage.db.execute(
        sql`create table ${sql.identifier(table)} (id text primary key)`,
      );
    });

    afterAll(async () => {
      await storage.db.execute(
        sql`drop table if exists ${sql.identifier(table)}`,
      );
      await storage.close();
    });

    test("every statement inside reports the same backend", async () => {
      const pids = await storage.transaction((tx) => pidsOf(tx));

      expect(new Set(pids).size).toBe(1);
      expectTwoAtOnce(driver);
    });

    test("a throw rolls back everything written inside", async () => {
      const id = randomUUID();

      await expect(
        storage.transaction(async (tx) => {
          await insert(tx, id);
          expect(await count(id, tx)).toBe(1);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);

      expect(await count(id)).toBe(0);
    });

    test("a row written inside is invisible to another session until commit", async () => {
      const id = randomUUID();

      await storage.transaction(async (tx) => {
        await insert(tx, id);
        // storage.db takes another connection from the pool: the
        // transaction is holding its own.
        expect(await count(id)).toBe(0);
        expect(await count(id, tx)).toBe(1);
      });

      expect(await count(id)).toBe(1);
    });

    test("a nested transaction is a savepoint", async () => {
      const outer = randomUUID();
      const inner = randomUUID();

      await storage.transaction(async (tx) => {
        await insert(tx, outer);
        await expect(
          tx.transaction(async (nested) => {
            await insert(nested, inner);
            throw new Rollback();
          }),
        ).rejects.toBeInstanceOf(Rollback);
      });

      expect(await count(outer)).toBe(1);
      expect(await count(inner)).toBe(0);
    });

    test("the default transaction entry point is the storage's own", async () => {
      // Storage.transaction delegates to its Drizzle handle; this pins that it
      // is the same session behaviour, not a second path.
      const pids = await storage.db.transaction((tx) => pidsOf(tx));

      expect(new Set(pids).size).toBe(1);
      expectTwoAtOnce(driver);
    });

    test("control: over a stand-in for the pool, the same check fails", async () => {
      /*
       * The detector firing once on the thing it exists to catch. Drizzle is
       * handed a plain object that forwards to the real pool — what a wrapper
       * amounts to — so it no longer recognises a pool, runs the transaction
       * on the pool itself, and two concurrent statements land on two
       * connections.
       */
      // A storage of its own: the stand-in leaves a connection idle inside
      // the BEGIN it sent, and closing the pool is what rolls that back.
      const controlStorage = createTestStorage({ driver });
      const pool = driverPoolOf(controlStorage);
      const standIn = {
        query: (...args: unknown[]) =>
          (pool.query as (...a: unknown[]) => unknown)(...args),
        connect: () => pool.connect(),
      };
      const unwrapped = isHostedDriver(driver)
        ? drizzleOverHosted(standIn, schema)
        : loadPgDriver().drizzle({
            client: standIn as unknown as pg.Pool,
            schema,
          });

      try {
        const [first, second] = await (
          unwrapped as unknown as Database
        ).transaction(async (tx) =>
          Promise.all([backendPid(tx), backendPid(tx)]),
        );

        expect(first).not.toBe(second);
      } finally {
        await controlStorage.close();
      }
    });
  });
}

/*
 * PGlite has one connection, so "one session" is not in question there; what
 * a transaction must still be is exclusive and atomic. Drizzle's PGlite
 * session always runs a transaction through PGlite's own `transaction()`,
 * which holds the connection until it ends: work from outside waits for it,
 * rather than seeing it or joining it. The control hands Drizzle a stand-in
 * whose `transaction` skips that, and the rollback check fires.
 */
describe.skipIf(!pgliteLane)(
  "pglite: a transaction is exclusive and atomic",
  () => {
    const table = `e2_tx_conformance_${randomUUID().replaceAll("-", "")}`;
    let storage: Storage;

    const count = async (id: string, handle: Database | Tx = storage.db) => {
      const result = await handle.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table)} where id = ${id}`,
      );

      return Number(result.rows[0]?.n);
    };

    const insert = (handle: Database | Tx, id: string) =>
      handle.execute(
        sql`insert into ${sql.identifier(table)} (id) values (${id})`,
      );

    beforeAll(async () => {
      storage = createTestStorage({ driver: "pglite" });
      await storage.db.execute(
        sql`create table ${sql.identifier(table)} (id text primary key)`,
      );
    });

    afterAll(async () => {
      await storage.close();
    });

    test("every statement inside reports the same backend", async () => {
      const pids = await storage.transaction((tx) => pidsOf(tx));

      expect(new Set(pids).size).toBe(1);
    });

    test("a throw rolls back everything written inside", async () => {
      const id = randomUUID();

      await expect(
        storage.transaction(async (tx) => {
          await insert(tx, id);
          expect(await count(id, tx)).toBe(1);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);

      expect(await count(id)).toBe(0);
    });

    test("work from outside waits for the transaction, and sees only what it committed", async () => {
      const id = randomUUID();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let inserted!: () => void;
      const written = new Promise<void>((resolve) => {
        inserted = resolve;
      });

      const transaction = storage.transaction(async (tx) => {
        await insert(tx, id);
        inserted();
        await held;
      });

      await written;
      let outsideSettled = false;
      const outside = count(id).then((n) => {
        outsideSettled = true;
        return n;
      });

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(outsideSettled).toBe(false);

      release();
      await transaction;
      expect(await outside).toBe(1);
    });

    test("a nested transaction is a savepoint", async () => {
      const outer = randomUUID();
      const inner = randomUUID();

      await storage.transaction(async (tx) => {
        await insert(tx, outer);
        await expect(
          tx.transaction(async (nested) => {
            await insert(nested, inner);
            throw new Rollback();
          }),
        ).rejects.toBeInstanceOf(Rollback);
      });

      expect(await count(outer)).toBe(1);
      expect(await count(inner)).toBe(0);
    });

    test("the default transaction entry point is the storage's own", async () => {
      const id = randomUUID();

      await expect(
        storage.db.transaction(async (tx) => {
          await insert(tx, id);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);

      expect(await count(id)).toBe(0);
    });

    test("control: over a stand-in that skips PGlite's transaction, the same check fails", async () => {
      // What a wrapper amounts to here: Drizzle calls `transaction`, and the
      // stand-in runs the work on the connection with no BEGIN around it.
      const client = storageClientOf(storage) as unknown as {
        query: (...args: unknown[]) => Promise<unknown>;
      };
      const standIn = {
        query: (...args: unknown[]) => client.query(...args),
        transaction: (work: (tx: unknown) => Promise<unknown>) =>
          work({ query: (...args: unknown[]) => client.query(...args) }),
      };
      const unwrapped = loadPgliteDriver().drizzle({
        client: standIn as never,
        schema,
      }) as unknown as Database;
      const id = randomUUID();

      await expect(
        unwrapped.transaction(async (tx) => {
          await insert(tx, id);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);

      expect(await count(id)).toBe(1);
    });
  },
);
