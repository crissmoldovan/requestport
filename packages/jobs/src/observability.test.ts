import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * The service names the job bodies' loggers and the metric sink carry
 * (`observability.ts`; ruling 145; ruling 158, item 9). The Trigger.dev
 * worker takes the worker root's settings, which name none, and its bodies
 * keep the names they have always logged under; settings that name the
 * self-host's, as core's `postgres` background and `requestport worker`
 * install them, give each its self-host name. Each case loads the modules
 * afresh, after the package's own module, which registers the worker root
 * the holder fills from, as each Trigger.dev task module loads it.
 */

/** Each body's name, as its module passes it to `workerLogger`, and its self-host name. */
const BODIES = {
  "trigger-import-analyze": "requestport-import-analyze",
  "trigger-import-apply": "requestport-import-apply",
  "trigger-outbox-delivery": "requestport-outbox-delivery",
  "trigger-retention": "requestport-retention",
  "trigger-webhook-delivery": "requestport-webhook-delivery",
} as const;

const load = async () => {
  await import("./index.js");
  return {
    ...(await import("./worker-root.js")),
    ...(await import("./worker-storages.js")),
    ...(await import("./observability.js")),
  };
};

/** The JSON lines `console.log` was given while `run` ran. */
const linesOf = (run: () => void) => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    run();
    return log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
  } finally {
    log.mockRestore();
  }
};

/** The services the five bodies' loggers and the metric sink write under, in that order. */
const servicesWritten = (
  modules: Awaited<ReturnType<typeof load>>,
): unknown[] =>
  linesOf(() => {
    for (const name of Object.keys(BODIES)) {
      modules.workerLogger(name).info("observability.case");
    }
    modules.triggerMetrics.count("task.result_total", 1, { taskId: "t" });
  }).map((line) => line.service);

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the job bodies' service names", () => {
  test("the Trigger.dev worker's: with the worker root's settings, which name none, each body and the metric sink write under the name it always has", async () => {
    const modules = await load();
    modules.useWorkerSettings(undefined);

    // The holder fills from the registered root on the first ask, as it
    // does in a Trigger.dev task.
    expect(modules.workerSettings().serviceNames).toBeUndefined();
    expect(modules.workerSettingsFromRoot().serviceNames).toBeUndefined();
    expect(servicesWritten(modules)).toEqual([
      ...Object.keys(BODIES),
      "requestport-trigger",
    ]);
    modules.useWorkerSettings(undefined);
  });

  test("the self-host's: with settings that name them, each body and the metric sink write under its self-host name, and under Trigger.dev's again once other settings are installed", async () => {
    const modules = await load();
    const root = modules.workerSettingsFromRoot();

    modules.useWorkerSettings(
      Object.assign(modules.workerSettingsFromRoot(), {
        serviceNames: "self-host" as const,
      }),
    );
    expect(servicesWritten(modules)).toEqual([
      ...Object.values(BODIES),
      "requestport-worker",
    ]);

    modules.useWorkerSettings(root);
    expect(servicesWritten(modules)).toEqual([
      ...Object.keys(BODIES),
      "requestport-trigger",
    ]);
    modules.useWorkerSettings(undefined);
  });
});
