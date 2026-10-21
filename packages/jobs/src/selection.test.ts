import { describe, expect, test } from "vitest";

import { jobRunnerVariable, resolveJobRunnerKind } from "./selection.js";

describe("which job runner a process uses", () => {
  test("is Trigger.dev when nothing is configured, which is production today", () => {
    expect(resolveJobRunnerKind({})).toBe("trigger");
    expect(resolveJobRunnerKind({ [jobRunnerVariable]: undefined })).toBe(
      "trigger",
    );
    // `REQUESTPORT_JOB_RUNNER=` in an env file reads as an empty string; that
    // is the absence of a choice, not a third runner.
    expect(resolveJobRunnerKind({ [jobRunnerVariable]: "" })).toBe("trigger");
  });

  test.each(["trigger", "postgres"] as const)("honours %s", (kind) => {
    expect(resolveJobRunnerKind({ [jobRunnerVariable]: kind })).toBe(kind);
  });

  test.each(["Postgres", " postgres", "pg", "trigger.dev", "none"])(
    "refuses %j rather than falling back to Trigger.dev",
    (value) => {
      // A typo that silently selected Trigger.dev would leave a self-hosted
      // install with no worker draining its outbox, and nothing would say so.
      expect(() =>
        resolveJobRunnerKind({ [jobRunnerVariable]: value }),
      ).toThrowError(/REQUESTPORT_JOB_RUNNER must be "trigger" or "postgres"/u);
    },
  );

  test.each(["garbage", "Postgres", "pg"])(
    "refuses %j with a message naming the variable",
    (value) => {
      expect(() =>
        resolveJobRunnerKind({ [jobRunnerVariable]: value }),
      ).toThrowError(new RegExp(`^${jobRunnerVariable} `, "u"));
    },
  );

  describe("on Vercel, where VERCEL_ENV is set", () => {
    test.each(["production", "preview", "development"])(
      "refuses postgres under VERCEL_ENV=%s: no worker there drains the outbox",
      (vercelEnv) => {
        expect(() =>
          resolveJobRunnerKind({
            [jobRunnerVariable]: "postgres",
            VERCEL_ENV: vercelEnv,
          }),
        ).toThrowError(
          /REQUESTPORT_JOB_RUNNER=postgres is refused wherever VERCEL_ENV is set/u,
        );
      },
    );

    test("counts an empty VERCEL_ENV as set, as packages/db does", () => {
      expect(() =>
        resolveJobRunnerKind({
          [jobRunnerVariable]: "postgres",
          VERCEL_ENV: "",
        }),
      ).toThrowError(/VERCEL_ENV/u);
    });

    test.each([undefined, "", "trigger"])(
      "still selects Trigger.dev for %j, as production does today",
      (value) => {
        expect(
          resolveJobRunnerKind({
            [jobRunnerVariable]: value,
            VERCEL_ENV: "production",
          }),
        ).toBe("trigger");
      },
    );

    test("selects postgres when VERCEL_ENV is absent", () => {
      expect(resolveJobRunnerKind({ [jobRunnerVariable]: "postgres" })).toBe(
        "postgres",
      );
    });
  });

  test("names the variable it reads", () => {
    expect(jobRunnerVariable).toBe("REQUESTPORT_JOB_RUNNER");
  });
});
