import { describe, expect, test } from "vitest";

import {
  jobsBinDatabaseName,
  jobsDatabaseName,
  jobsDatabasePid,
  processAlive,
  staleJobsDatabases,
  withDatabaseName,
} from "./jobs-database.js";

describe("the jobs integration database's name", () => {
  test("is the local database's name, then _jobs_, then the process id", () => {
    expect(jobsDatabaseName("rp_track_c", 4321)).toBe("rp_track_c_jobs_4321");
    expect(jobsDatabaseName("requestport_local", 7)).toBe(
      "requestport_local_jobs_7",
    );
  });

  test("refuses a base that would need quoting, and a name PostgreSQL would truncate", () => {
    for (const base of ["", "Rp", "rp-track", 'rp"; drop', "rp track", "1rp"]) {
      expect(() => jobsDatabaseName(base, 1)).toThrowError(/not made of/u);
    }
    // 50 + "_jobs_" + 7 digits is 63; one more character is 64.
    expect(jobsDatabaseName("a".repeat(50), 1234567)).toHaveLength(63);
    expect(() => jobsDatabaseName("a".repeat(51), 1234567)).toThrowError(
      /longer than PostgreSQL's 63/u,
    );
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(() => jobsDatabaseName("rp_track_c", pid)).toThrowError(
        /Not a process id/u,
      );
    }
  });

  test("for bin.integration.test.ts's worker, is the local database's name, then _jbin_, then the process id (X28; ruling 232 item 1)", () => {
    expect(jobsBinDatabaseName("rp_track_c", 4321)).toBe(
      "rp_track_c_jbin_4321",
    );
    // With Linux's 7-digit ids a 50-character base gives 63 characters for
    // both names; one more character is 64 for both.
    const longest = "a".repeat(50);
    for (const pid of [1234567, 4194304]) {
      expect(jobsBinDatabaseName(longest, pid)).toHaveLength(63);
      expect(jobsDatabaseName(longest, pid)).toHaveLength(63);
    }
    expect(() => jobsBinDatabaseName("a".repeat(51), 1234567)).toThrowError(
      /longer than PostgreSQL's 63/u,
    );
    expect(() => jobsBinDatabaseName("rp-track", 1)).toThrowError(
      /not made of/u,
    );
    expect(() => jobsBinDatabaseName("rp_track_c", 0)).toThrowError(
      /Not a process id/u,
    );
  });

  test("for a 50-character base, the longest scripts/create-track-worktree.mjs accepts (rp_track_ and 41 more), and a 5-digit process id, as this host's are, bin's name is made and is no longer than the run's, so no base whose run's name fits is refused (ruling 232 item 1)", () => {
    const longest = `rp_track_${"a".repeat(41)}`;
    expect(longest).toHaveLength(50);
    const run = jobsDatabaseName(longest, 99999);
    expect(run).toHaveLength(61);
    expect(jobsBinDatabaseName(longest, 99999)).toBe(`${longest}_jbin_99999`);
    expect(jobsBinDatabaseName(longest, 99999)).toHaveLength(run.length);
  });

  test("reads back the process id only from a name it made for that base, the run's or bin's (X28; ruling 232 item 1)", () => {
    expect(jobsDatabasePid("rp_track_c_jobs_4321", "rp_track_c")).toBe(4321);
    expect(jobsDatabasePid("rp_track_c_jbin_4321", "rp_track_c")).toBe(4321);
    for (const name of [
      "rp_track_c",
      "rp_track_c_jobs_",
      "rp_track_c_jobs_0",
      "rp_track_c_jobs_12x",
      "rp_track_c_jobs_1_2",
      "rp_track_cx_jobs_12",
      "rp_track_d_jobs_12",
      "rp_track_c_jbin_",
      "rp_track_c_jbin_0",
      "rp_track_c_jbin_12x",
      "rp_track_c_jbin_1_2",
      "rp_track_cx_jbin_12",
      "rp_track_d_jbin_12",
      "rp_track_c_jobs_12_bin",
      "rp_track_c_jbin_jobs_12",
      "rp_track_c_jobs_jbin_12",
    ]) {
      expect(jobsDatabasePid(name, "rp_track_c"), name).toBeUndefined();
    }
  });
});

describe("the stale sweep", () => {
  test("chooses only this base's databases whose process has gone, bin.integration.test.ts's among them (X28; ruling 232 item 1)", () => {
    const alive = (pid: number) => pid === 200;
    expect(
      staleJobsDatabases(
        [
          "rp_track_c_jbin_100",
          "rp_track_c_jobs_100",
          "rp_track_c_jbin_200",
          "rp_track_c_jobs_200",
          "rp_track_d_jbin_100",
          "rp_track_d_jobs_100",
          "rp_track_c_jbin_x",
          "rp_track_c_jobs_x",
        ],
        "rp_track_c",
        alive,
      ),
    ).toEqual(["rp_track_c_jbin_100", "rp_track_c_jobs_100"]);
  });

  test("knows this process is alive and a spent id is not", () => {
    expect(processAlive(process.pid)).toBe(true);
    // Above the largest pid macOS (99998) or Linux (4194304) hands out.
    expect(processAlive(2 ** 30)).toBe(false);
  });
});

describe("the jobs integration database's URL", () => {
  test("is the local URL with only the database name replaced", () => {
    expect(
      withDatabaseName(
        "postgres://requestport:secret@127.0.0.1:55432/rp_track_c?sslmode=disable",
        "rp_track_c_jobs_4321",
      ),
    ).toBe(
      "postgres://requestport:secret@127.0.0.1:55432/rp_track_c_jobs_4321?sslmode=disable",
    );
    expect(() =>
      withDatabaseName("postgres://u@127.0.0.1:55432/x", "x/../y"),
    ).toThrowError(/Not a database name/u);
  });
});
