import { describe, expect, test } from "vitest";

import {
  defaultWorkerTiming,
  shortestChildLeaseMs,
  timingViolations,
  type WorkerTiming,
} from "./timing.js";

describe("the lease-versus-tick rule", () => {
  test("holds for the defaults", () => {
    expect(timingViolations(defaultWorkerTiming)).toEqual([]);
  });

  test("refuses an outbox routing that may outlive its lease plus a tick", () => {
    const timing: WorkerTiming = {
      ...defaultWorkerTiming,
      outboxLeaseMs: 60_000,
      outboxJobTimeoutMs: 56_000,
      tickMs: 5_000,
      drainMs: 60_000,
    };

    expect(timingViolations(timing)).toEqual([
      expect.stringMatching(
        /^outboxJobTimeoutMs \(56000\) \+ tickMs \(5000\) must be less than outboxLeaseMs \(60000\)/u,
      ),
    ]);
  });

  test("refuses an import job that may outlive its lease plus a tick", () => {
    expect(
      timingViolations({
        ...defaultWorkerTiming,
        importLeaseMs: 300_000,
        importJobTimeoutMs: 300_000,
      }),
    ).toEqual([expect.stringMatching(/^importJobTimeoutMs/u)]);
  });

  test("refuses a child job that may outlive the shortest lease a child runs under", () => {
    expect(shortestChildLeaseMs).toBe(10 * 60_000);
    expect(
      timingViolations({
        ...defaultWorkerTiming,
        childJobTimeoutMs: shortestChildLeaseMs,
      }),
    ).toEqual([expect.stringMatching(/^childJobTimeoutMs/u)]);
  });

  test("refuses a drain shorter than one outbox routing", () => {
    // A SIGTERM mid-routing would otherwise exit with the row still leased,
    // and nothing could deliver it until the lease ran out.
    expect(
      timingViolations({
        ...defaultWorkerTiming,
        drainMs: defaultWorkerTiming.outboxJobTimeoutMs - 1,
      }),
    ).toEqual([expect.stringMatching(/^drainMs/u)]);
  });

  test.each([
    // Function 1 clamps the outbox lease to 10-600 s, function 4 the import
    // lease to 60-1 800 s; the pollers ask in whole seconds, rounded up.
    ["outboxLeaseMs", 9_000, { outboxJobTimeoutMs: 1_000, tickMs: 1_000 }],
    [
      "outboxLeaseMs",
      600_001,
      { drainMs: 700_000, outboxJobTimeoutMs: 590_000 },
    ],
    [
      "outboxLeaseMs",
      900_000,
      { drainMs: 700_000, outboxJobTimeoutMs: 700_000 },
    ],
    ["importLeaseMs", 59_000, { importJobTimeoutMs: 50_000, tickMs: 1_000 }],
    ["importLeaseMs", 1_800_001, { importJobTimeoutMs: 1_700_000 }],
  ] as const)(
    "refuses a %s of %i, which the database's claim would clamp",
    (lease, value, rest) => {
      expect(
        timingViolations({ ...defaultWorkerTiming, ...rest, [lease]: value }),
      ).toEqual([
        expect.stringMatching(new RegExp(`^${lease} \\(${value}\\)`, "u")),
      ]);
    },
  );

  test("accepts the leases at the functions' bounds", () => {
    expect(
      timingViolations({
        ...defaultWorkerTiming,
        outboxLeaseMs: 600_000,
        importLeaseMs: 1_800_000,
      }),
    ).toEqual([]);
    expect(
      timingViolations({
        ...defaultWorkerTiming,
        tickMs: 1_000,
        outboxLeaseMs: 10_000,
        outboxJobTimeoutMs: 8_000,
        drainMs: 8_000,
        importLeaseMs: 60_000,
        importJobTimeoutMs: 58_000,
      }),
    ).toEqual([]);
  });

  test("refuses values that are not positive whole milliseconds", () => {
    expect(
      timingViolations({ ...defaultWorkerTiming, tickMs: 0 }),
    ).toContainEqual(expect.stringMatching(/^tickMs must be a positive/u));
    expect(
      timingViolations({ ...defaultWorkerTiming, drainMs: Number.NaN }),
    ).toContainEqual(expect.stringMatching(/^drainMs must be a positive/u));
  });
});
