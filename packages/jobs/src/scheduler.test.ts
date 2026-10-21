import { describe, expect, test, vi } from "vitest";

import {
  createScheduler,
  type ExclusiveRunner,
  type ScheduledJob,
} from "./scheduler.js";

function fakeClock(iso: string) {
  let now = new Date(iso).getTime();
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
    set: (next: string) => {
      now = new Date(next).getTime();
    },
  };
}

const minutes = (count: number) => count * 60_000;
const hours = (count: number) => count * 60 * 60_000;

/** Every key is free: this process always gets the lock. */
const alwaysAcquired: ExclusiveRunner = async (_key, run) => ({
  acquired: true,
  value: await run(),
});

function catalogue() {
  const runs: string[] = [];
  const job = (id: string, cron: string): ScheduledJob => ({
    id,
    cron,
    run: async () => {
      runs.push(id);
    },
  });
  return {
    runs,
    schedules: [
      job("retention-cleanup", "17 3 * * *"),
      job("question-reminders", "*/15 * * * *"),
      job("outbox-metrics", "*/2 * * * *"),
    ],
  };
}

describe("the Postgres worker's schedules", () => {
  test("run once each when the worker starts, whatever the time", async () => {
    const clock = fakeClock("2026-09-27T10:01:00Z");
    const { runs, schedules } = catalogue();
    const scheduler = createScheduler({
      schedules,
      clock: clock.now,
      runExclusive: alwaysAcquired,
    });

    await scheduler.tick();

    // Retention's daily slot is 03:17 and this is 10:01. A host that is
    // only up during the day would otherwise never run it.
    expect(runs).toEqual([
      "retention-cleanup",
      "question-reminders",
      "outbox-metrics",
    ]);

    await scheduler.tick();
    expect(runs).toHaveLength(3);
  });

  test("then fire on their cron slots", async () => {
    const clock = fakeClock("2026-09-27T10:01:00Z");
    const { runs, schedules } = catalogue();
    const scheduler = createScheduler({
      schedules,
      clock: clock.now,
      runExclusive: alwaysAcquired,
    });
    await scheduler.tick();
    runs.length = 0;

    clock.set("2026-09-27T10:02:00Z");
    await scheduler.tick();
    expect(runs).toEqual(["outbox-metrics"]);

    clock.set("2026-09-27T10:15:00Z");
    await scheduler.tick();
    expect(runs).toEqual([
      "outbox-metrics",
      "question-reminders",
      "outbox-metrics",
    ]);
    expect(scheduler.nextDueAt("retention-cleanup")?.toISOString()).toBe(
      "2026-09-28T03:17:00.000Z",
    );
  });

  test("after a host sleeps through many slots, run each once, not once per missed slot", async () => {
    const clock = fakeClock("2026-09-27T01:00:00Z");
    const { runs, schedules } = catalogue();
    const scheduler = createScheduler({
      schedules,
      clock: clock.now,
      runExclusive: alwaysAcquired,
    });
    await scheduler.tick();
    runs.length = 0;

    // A laptop lid closed at 01:00 and opened at 06:00: retention's 03:17
    // slot, twenty reminder slots and 150 metric slots went by.
    clock.advance(hours(5));
    await scheduler.tick();

    expect(runs.sort()).toEqual([
      "outbox-metrics",
      "question-reminders",
      "retention-cleanup",
    ]);

    // And the next slots are counted from waking, not from the missed ones.
    runs.length = 0;
    clock.advance(1_000);
    await scheduler.tick();
    expect(runs).toEqual([]);
    expect(scheduler.nextDueAt("question-reminders")?.toISOString()).toBe(
      "2026-09-27T06:15:00.000Z",
    );
  });

  test("skip a slot another worker holds, without running it and without retrying it", async () => {
    const clock = fakeClock("2026-09-27T10:01:00Z");
    const { runs, schedules } = catalogue();
    const heldElsewhere: ExclusiveRunner = async () => ({ acquired: false });
    const scheduler = createScheduler({
      schedules,
      clock: clock.now,
      runExclusive: heldElsewhere,
    });

    const outcomes = await scheduler.tick();

    expect(runs).toEqual([]);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
      "held_elsewhere",
      "held_elsewhere",
      "held_elsewhere",
    ]);
    expect(scheduler.nextDueAt("outbox-metrics")?.toISOString()).toBe(
      "2026-09-27T10:02:00.000Z",
    );
  });

  test("lock each schedule under its own key", async () => {
    const clock = fakeClock("2026-09-27T10:01:00Z");
    const { schedules } = catalogue();
    const keys: string[] = [];
    const scheduler = createScheduler({
      schedules,
      clock: clock.now,
      runExclusive: async (key, run) => {
        keys.push(key);
        return { acquired: true, value: await run() };
      },
    });

    await scheduler.tick();

    expect(keys).toEqual([
      "schedule:retention-cleanup",
      "schedule:question-reminders",
      "schedule:outbox-metrics",
    ]);
  });

  test("retry a failed run sooner than its next slot, then fall back to the slot", async () => {
    const clock = fakeClock("2026-09-27T03:17:00Z");
    const run = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const scheduler = createScheduler({
      schedules: [{ id: "retention-cleanup", cron: "17 3 * * *", run }],
      clock: clock.now,
      runExclusive: alwaysAcquired,
      retryDelaysMs: [minutes(1), minutes(5)],
    });

    const [first] = await scheduler.tick();
    expect(first).toMatchObject({ outcome: "failed" });
    expect(scheduler.nextDueAt("retention-cleanup")?.toISOString()).toBe(
      "2026-09-27T03:18:00.000Z",
    );

    clock.set("2026-09-27T03:18:00Z");
    await scheduler.tick();
    expect(scheduler.nextDueAt("retention-cleanup")?.toISOString()).toBe(
      "2026-09-27T03:23:00.000Z",
    );

    clock.set("2026-09-27T03:23:00Z");
    await scheduler.tick();
    expect(scheduler.nextDueAt("retention-cleanup")?.toISOString()).toBe(
      "2026-09-28T03:17:00.000Z",
    );
    expect(run).toHaveBeenCalledTimes(3);

    // A success resets the retry budget for the next failure.
    run.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("again"));
    clock.set("2026-09-28T03:17:00Z");
    await scheduler.tick();
    clock.set("2026-09-29T03:17:00Z");
    await scheduler.tick();
    expect(scheduler.nextDueAt("retention-cleanup")?.toISOString()).toBe(
      "2026-09-29T03:18:00.000Z",
    );
  });

  test("never retry later than the next slot would have run it anyway", async () => {
    const clock = fakeClock("2026-09-27T10:01:30Z");
    const scheduler = createScheduler({
      schedules: [
        {
          id: "outbox-metrics",
          cron: "*/2 * * * *",
          run: async () => {
            throw new Error("down");
          },
        },
      ],
      clock: clock.now,
      runExclusive: alwaysAcquired,
      retryDelaysMs: [minutes(5)],
    });

    await scheduler.tick();

    expect(scheduler.nextDueAt("outbox-metrics")?.toISOString()).toBe(
      "2026-09-27T10:02:00.000Z",
    );
  });

  test("count the next slot from when a slow run finished", async () => {
    const clock = fakeClock("2026-09-27T10:01:59Z");
    const scheduler = createScheduler({
      schedules: [
        {
          id: "outbox-metrics",
          cron: "*/2 * * * *",
          run: async () => {
            clock.advance(minutes(3));
          },
        },
      ],
      clock: clock.now,
      runExclusive: alwaysAcquired,
    });

    await scheduler.tick();

    // Started before 10:02 and finished at 10:04:59. The 10:02 and 10:04
    // slots were covered by the run itself.
    expect(scheduler.nextDueAt("outbox-metrics")?.toISOString()).toBe(
      "2026-09-27T10:06:00.000Z",
    );
  });

  test("do not start a tick while the previous one is still running", async () => {
    const clock = fakeClock("2026-09-27T10:01:00Z");
    let release: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const scheduler = createScheduler({
      schedules: [{ id: "slow", cron: "* * * * *", run }],
      clock: clock.now,
      runExclusive: alwaysAcquired,
    });

    const first = scheduler.tick();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await expect(scheduler.tick()).resolves.toEqual([]);
    release();
    await first;
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("refuse a catalogue with a duplicate id or an invalid cron", () => {
    const run = async () => undefined;
    expect(() =>
      createScheduler({
        schedules: [
          { id: "a", cron: "* * * * *", run },
          { id: "a", cron: "*/2 * * * *", run },
        ],
        clock: () => new Date(),
        runExclusive: alwaysAcquired,
      }),
    ).toThrowError(/duplicate schedule id "a"/u);
    expect(() =>
      createScheduler({
        schedules: [{ id: "b", cron: "every minute", run }],
        clock: () => new Date(),
        runExclusive: alwaysAcquired,
      }),
    ).toThrowError(/cron/u);
  });
});
