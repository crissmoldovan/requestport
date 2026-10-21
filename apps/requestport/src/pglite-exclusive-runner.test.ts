import {
  createAdvisoryExclusiveRunner,
  createOutboxRepository,
  createStorage,
} from "@requestport/db";
import { migrate } from "@requestport/db/migrate";
import { afterAll, describe, expect, test } from "vitest";

import { createPgliteExclusiveRunner } from "./pglite-exclusive-runner.js";

/*
 * The worker's exclusive runner on PGlite (manifest-h.md §2.6 item 3; Done
 * when 9). On one migrated PGlite storage, in memory: a scheduler tick around
 * `outboxRepository.claimBatch(10)`, the worker's outbox tick's own query,
 * through the shipped runner, settles within the bound, and so does a second
 * tick after it. The control, last, is the advisory runner over the same
 * storage: its transaction holds PGlite's one connection, the tick's query
 * waits for it, and the tick is still unsettled at the bound. That storage
 * is then discarded, never closed: its `end()` would queue behind the
 * transaction that will never commit.
 *
 * The bound's timer stays referenced. A tick that never settles holds no
 * I/O, and an unreferenced timer would leave nothing for the event loop to
 * wait on (H.0c's K2 control, run outside Vitest, exited 13 that way).
 */

/** Long enough for a tick on a loaded host; the control waits this long once. */
const BOUND_MS = 5_000;

type Outcome =
  | { settled: "resolved"; value: unknown; ms: number }
  | { settled: "rejected"; error: string; ms: number }
  | { settled: "unsettled"; ms: number };

async function within(work: Promise<unknown>): Promise<Outcome> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"unsettled">((resolve) => {
    timer = setTimeout(() => resolve("unsettled"), BOUND_MS);
  });
  try {
    const outcome = await Promise.race([
      work.then(
        (value) => ({ settled: "resolved" as const, value }),
        (error: unknown) => ({
          settled: "rejected" as const,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
      bound,
    ]);
    const ms = Math.round(performance.now() - started);
    return outcome === "unsettled"
      ? { settled: "unsettled", ms }
      : { ...outcome, ms };
  } finally {
    clearTimeout(timer);
  }
}

const storage = createStorage({ driver: "pglite", dataDir: "memory://" });
let wedged = false;

afterAll(async () => {
  // The control's storage is wedged by design, and discarded (above).
  if (!wedged) await storage.close();
});

describe("the in-process exclusive runner on PGlite (Done when 9; §2.6 item 3)", () => {
  test("a tick around claimBatch(10) through the shipped runner settles within the bound, and so does the tick after it; the advisory runner over the same storage, the control, does not", async () => {
    const report = await migrate(storage);
    expect(report.applied.length).toBeGreaterThan(0);
    const outbox = createOutboxRepository(storage.db);
    const runExclusive = createPgliteExclusiveRunner();

    const first = await within(
      runExclusive("outbox", () => outbox.claimBatch(10)),
    );
    expect(first).toMatchObject({
      settled: "resolved",
      value: { acquired: true, value: [] },
    });
    const second = await within(
      runExclusive("outbox", () => outbox.claimBatch(10)),
    );
    expect(second).toMatchObject({
      settled: "resolved",
      value: { acquired: true, value: [] },
    });
    // The storage still answers a query of its own after both ticks.
    expect((await within(storage.ready())).settled).toBe("resolved");

    // The control: the advisory runner, as the worker runs on a server.
    wedged = true;
    const advisory = createAdvisoryExclusiveRunner(storage.db);
    const control = await within(
      advisory("outbox", () => outbox.claimBatch(10)),
    );
    expect(control.settled).toBe("unsettled");
    expect(control.ms).toBeGreaterThanOrEqual(BOUND_MS - 50);
  });

  test("holds a key for the length of its tick: a tick under a held key is skipped, not queued; another key runs; the key is released when its tick resolves or throws", async () => {
    const runExclusive = createPgliteExclusiveRunner();
    let release: () => void = () => undefined;
    const held = runExclusive(
      "outbox",
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("first");
        }),
    );
    let ran = false;
    expect(
      await runExclusive("outbox", async () => {
        ran = true;
        return "second";
      }),
    ).toEqual({ acquired: false });
    expect(ran).toBe(false);
    expect(await runExclusive("imports", async () => "other key")).toEqual({
      acquired: true,
      value: "other key",
    });
    release();
    expect(await held).toEqual({ acquired: true, value: "first" });
    expect(await runExclusive("outbox", async () => "after")).toEqual({
      acquired: true,
      value: "after",
    });

    await expect(
      runExclusive("outbox", async () => {
        throw new Error("the tick failed");
      }),
    ).rejects.toThrow("the tick failed");
    expect(await runExclusive("outbox", async () => "released")).toEqual({
      acquired: true,
      value: "released",
    });
  });
});
