import { afterEach, describe, expect, test, vi } from "vitest";

import { register } from "./instrumentation";

/*
 * The database surface `register` declares, recorded rather than applied:
 * this lane's own setup has declared `test` in the real module, and a second,
 * different declaration there would be refused (D21).
 */
const declared = vi.hoisted(() => [] as string[]);
/** What `declaredDatabaseSurface` answers: what this process declared before `register` ran. */
const before = vi.hoisted(() => ({ surface: undefined as string | undefined }));

vi.mock("@requestport/db", () => ({
  declareDatabaseSurface: (surface: string) => {
    declared.push(surface);
  },
  declaredDatabaseSurface: () => before.surface,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  declared.length = 0;
  before.surface = undefined;
});

describe("the web server's boot", () => {
  test("accepts an unset REQUESTPORT_JOB_RUNNER in production: Trigger.dev", async () => {
    vi.stubEnv("REQUESTPORT_JOB_RUNNER", undefined);
    vi.stubEnv("VERCEL_ENV", "production");

    await expect(register()).resolves.toBeUndefined();
  });

  test("accepts postgres where no Vercel runtime exists", async () => {
    vi.stubEnv("REQUESTPORT_JOB_RUNNER", "postgres");
    vi.stubEnv("VERCEL_ENV", undefined);

    await expect(register()).resolves.toBeUndefined();
  });

  test("refuses postgres on Vercel, where no worker drains the outbox", async () => {
    vi.stubEnv("REQUESTPORT_JOB_RUNNER", "postgres");
    vi.stubEnv("VERCEL_ENV", "production");

    await expect(register()).rejects.toThrowError(
      /REQUESTPORT_JOB_RUNNER=postgres is refused wherever VERCEL_ENV is set/u,
    );
  });

  test("refuses a value that is neither runner, naming the variable", async () => {
    vi.stubEnv("REQUESTPORT_JOB_RUNNER", "garbage");
    vi.stubEnv("VERCEL_ENV", undefined);

    await expect(register()).rejects.toThrowError(
      /^REQUESTPORT_JOB_RUNNER must be "trigger" or "postgres"/u,
    );
  });

  test("declares the application database surface first, before anything can query (manifest-i2.md §2.2)", async () => {
    vi.stubEnv("REQUESTPORT_JOB_RUNNER", undefined);
    vi.stubEnv("VERCEL_ENV", "production");

    await register();
    expect(declared).toEqual(["application"]);

    // Declared even when the runner check then refuses the boot: it comes
    // first.
    declared.length = 0;
    vi.stubEnv("REQUESTPORT_JOB_RUNNER", "garbage");
    await expect(register()).rejects.toThrowError(/REQUESTPORT_JOB_RUNNER/u);
    expect(declared).toEqual(["application"]);
  });

  test("in a process requestport start declared embedded (PGlite, with Next served beside its host), it declares nothing over it", async () => {
    vi.stubEnv("REQUESTPORT_JOB_RUNNER", "postgres");
    vi.stubEnv("VERCEL_ENV", undefined);
    before.surface = "embedded";

    await expect(register()).resolves.toBeUndefined();
    expect(declared).toEqual([]);
  });

  test("in a process requestport start declared application (pg), it declares application, as it always has", async () => {
    vi.stubEnv("REQUESTPORT_JOB_RUNNER", "postgres");
    vi.stubEnv("VERCEL_ENV", undefined);
    before.surface = "application";

    await register();
    expect(declared).toEqual(["application"]);
  });
});
