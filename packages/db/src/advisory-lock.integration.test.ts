import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  advisoryLockKey,
  advisoryLockNamespace,
  createAdvisoryExclusiveRunner,
} from "./advisory-lock.js";
import { createStorage, storageOptionsFromEnv } from "./client.js";
import { tenantWrappingEnabled } from "./tenant-context.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

afterAll(async () => {
  await suiteStorage.close();
});

function barrier() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function advisoryLocksHeld(key: string) {
  const result = await suiteStorage.db.execute<{ held: number }>(sql`
    select count(*)::integer as held
    from pg_locks
    where locktype = 'advisory'
      and classid = ${advisoryLockNamespace}::oid
      and objid = (${advisoryLockKey(key)}::bigint & 4294967295)::oid
      and granted
  `);
  return Number(result.rows[0]?.held ?? 0);
}

describe("the Postgres worker's per-tick advisory lock", () => {
  const runExclusive = createAdvisoryExclusiveRunner(suiteStorage.db);
  const key = `test:${crypto.randomUUID()}`;

  // Each case below holds up to three connections at once. Opening one is
  // the slow part on a loaded host (three fresh ones measured 20s at a load
  // average near 100, and 0.5s once pooled), and it is not what these cases
  // are about, so the pool is filled first, inside the default hook budget.
  beforeAll(async () => {
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        suiteStorage.db.transaction((tx) => tx.execute(sql`select 1`)),
      ),
    );
  });

  test("admits one holder of a key; a second, on another connection, is turned away without waiting", async () => {
    const inside = barrier();
    const leave = barrier();
    const first = runExclusive(key, async () => {
      inside.open();
      await leave.opened;
      return "first";
    });
    await inside.opened;

    // A real PostgreSQL advisory lock, visible to the server, not an
    // in-process flag.
    expect(await advisoryLocksHeld(key)).toBe(1);

    const started = Date.now();
    await expect(runExclusive(key, async () => "second")).resolves.toEqual({
      acquired: false,
    });
    // `pg_try_advisory_xact_lock` answers at once; a blocking lock would
    // still be waiting for `leave`.
    expect(Date.now() - started).toBeLessThan(15_000);

    leave.open();
    await expect(first).resolves.toEqual({ acquired: true, value: "first" });

    // Released with the transaction.
    expect(await advisoryLocksHeld(key)).toBe(0);
    await expect(runExclusive(key, async () => "third")).resolves.toEqual({
      acquired: true,
      value: "third",
    });
  });

  test("does not make different keys wait for each other", async () => {
    const inside = barrier();
    const leave = barrier();
    const other = `${key}:other`;
    const first = runExclusive(key, async () => {
      inside.open();
      await leave.opened;
    });
    await inside.opened;

    await expect(runExclusive(other, async () => "other")).resolves.toEqual({
      acquired: true,
      value: "other",
    });

    leave.open();
    await first;
  });

  test("releases the lock when the run throws, and rethrows", async () => {
    await expect(
      runExclusive(key, async () => {
        throw new Error("tick failed");
      }),
    ).rejects.toThrowError("tick failed");

    expect(await advisoryLocksHeld(key)).toBe(0);
    await expect(runExclusive(key, async () => "after")).resolves.toEqual({
      acquired: true,
      value: "after",
    });
  });
});

describe("advisory lock keys", () => {
  test("are stable 32-bit integers, so every worker computes the same one", () => {
    expect(advisoryLockKey("schedule:retention-cleanup")).toBe(
      advisoryLockKey("schedule:retention-cleanup"),
    );
    expect(advisoryLockKey("a")).not.toBe(advisoryLockKey("b"));
    for (const value of [
      "",
      "a",
      "schedule:retention-cleanup",
      "ü".repeat(99),
    ]) {
      const hashed = advisoryLockKey(value);
      expect(Number.isInteger(hashed)).toBe(true);
      expect(hashed).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(hashed).toBeLessThan(2 ** 31);
    }
  });
});
