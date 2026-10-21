import { describe, expect, test } from "vitest";

import { nextCronFire, parseCron } from "./cron.js";

const at = (iso: string) => new Date(iso);

describe("the next time a cron expression fires", () => {
  test.each([
    // Every expression the Trigger.dev schedules use today.
    ["*/2 * * * *", "2026-09-27T10:00:30Z", "2026-09-27T10:02:00.000Z"],
    ["*/2 * * * *", "2026-09-27T10:01:00Z", "2026-09-27T10:02:00.000Z"],
    ["*/5 * * * *", "2026-09-27T10:04:59Z", "2026-09-27T10:05:00.000Z"],
    ["*/10 * * * *", "2026-09-27T10:55:00Z", "2026-09-27T11:00:00.000Z"],
    ["*/15 * * * *", "2026-09-27T23:50:00Z", "2026-09-28T00:00:00.000Z"],
    ["17 3 * * *", "2026-09-27T03:16:59Z", "2026-09-27T03:17:00.000Z"],
    ["17 3 * * *", "2026-09-27T03:17:00Z", "2026-09-28T03:17:00.000Z"],
    ["17 3 * * *", "2026-12-31T04:00:00Z", "2027-01-01T03:17:00.000Z"],
  ])("%s after %s is %s", (expression, after, expected) => {
    expect(nextCronFire(expression, at(after)).toISOString()).toBe(expected);
  });

  test("is strictly after the instant it is given, even on a firing minute", () => {
    expect(
      nextCronFire("*/2 * * * *", at("2026-09-27T10:02:00Z")).toISOString(),
    ).toBe("2026-09-27T10:04:00.000Z");
  });

  test("reads ranges, lists and stepped ranges", () => {
    // 09:00 and 09:30 through 17:30, Monday to Friday. 2026-09-26 is a
    // Saturday, so the next firing is Monday morning.
    expect(
      nextCronFire(
        "0,30 9-17 * * 1-5",
        at("2026-09-26T12:00:00Z"),
      ).toISOString(),
    ).toBe("2026-09-28T09:00:00.000Z");
    expect(
      nextCronFire("0 8-20/6 * * *", at("2026-09-27T14:00:00Z")).toISOString(),
    ).toBe("2026-09-27T20:00:00.000Z");
  });

  test("fires on either the day of the month or the weekday when both are restricted", () => {
    // Standard cron: midnight on the 1st, and every Monday. 2026-09-27 is a
    // Sunday, so Monday the 28th comes before 1 October.
    expect(
      nextCronFire("0 0 1 * 1", at("2026-09-27T12:00:00Z")).toISOString(),
    ).toBe("2026-09-28T00:00:00.000Z");
    expect(
      nextCronFire("0 0 1 * 1", at("2026-09-28T12:00:00Z")).toISOString(),
    ).toBe("2026-10-01T00:00:00.000Z");
  });

  test("treats 7 as Sunday, like 0", () => {
    expect(
      nextCronFire("0 12 * * 7", at("2026-09-21T00:00:00Z")).toISOString(),
    ).toBe("2026-09-27T12:00:00.000Z");
  });

  test.each([
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "5-1 * * * *",
    "a * * * *",
    "",
  ])("refuses %j", (expression) => {
    expect(() => parseCron(expression)).toThrowError(/cron/u);
  });

  test("finds a date that exists only in leap years", () => {
    expect(
      nextCronFire("0 0 29 2 *", at("2026-03-01T00:00:00Z")).toISOString(),
    ).toBe("2028-02-29T00:00:00.000Z");
  });

  test("says so when an expression can never fire", () => {
    expect(() =>
      nextCronFire("0 0 30 2 *", at("2026-01-01T00:00:00Z")),
    ).toThrowError(/never fires/u);
  });
});
