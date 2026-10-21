import type { Storage, WorkerStorages } from "@requestport/db";
import { DomainError } from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { RequestPortOptions } from "./options.js";

/*
 * A `postgres` background whose stop passes its drain deadline (manifest-g.md
 * §2.4). C's worker answers `{ drained: false }` when its `drainMs` passes
 * with work still running (`packages/jobs/src/worker.ts`, `stop`); that work
 * keeps running, and each body it runs reads `workerStorages()` and
 * `workerSettings()` as it goes. So the background keeps what it installed
 * until the worker has drained: forgetting it would leave those bodies a
 * refusal, or, in a process that has loaded `@requestport/jobs` itself, the
 * worker root's, built from the host's environment (§2.1 rule 2).
 *
 * In a file of its own: such a background never forgets what it installed,
 * so this module's copy of core refuses any background after it, which every
 * case in `postgres-background.test.ts` starts.
 *
 * The worker is a recorder here (`startJobWorker`), and the catalogue a stand-in,
 * so that no loop runs and no body loads.
 */

const mocks = vi.hoisted(() => ({
  drained: true,
  stops: 0,
  installedStorages: [] as unknown[],
  installedSettings: [] as unknown[],
}));

vi.mock("@requestport/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@requestport/db")>()),
  createOutboxRepository: () => ({}),
  createImportTaskDispatchRepository: () => ({}),
  createAdvisoryExclusiveRunner: () => async () => ({ acquired: false }),
  createWorkerStorages: () => {
    throw new Error("core never builds the worker storages");
  },
}));
vi.mock("@requestport/jobs/worker", () => ({
  startJobWorker: () => ({
    ready: Promise.resolve(),
    stop: async () => {
      mocks.stops += 1;
      return { drained: mocks.drained };
    },
  }),
}));
vi.mock("@requestport/jobs/catalogue", () => ({
  createJobHandlers: () => ({}),
  scheduleDefinitions: [],
}));
vi.mock("@requestport/jobs/worker-storages", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@requestport/jobs/worker-storages")>();
  return {
    ...original,
    useWorkerStorages: (storages: WorkerStorages | undefined) => {
      mocks.installedStorages.push(storages);
      original.useWorkerStorages(storages);
    },
    useWorkerSettings: (
      settings: Parameters<typeof original.useWorkerSettings>[0],
    ) => {
      mocks.installedSettings.push(settings);
      original.useWorkerSettings(settings);
    },
  };
});

const { createRequestPort, requestPortComposition } = await import(
  "./request-port.js"
);
const { postgresWorkerSettings } = await import("./background.js");
const { workerSettings, workerStorages } = await import(
  "@requestport/jobs/worker-storages"
);

function postgresOptions(): RequestPortOptions {
  const storages = {
    bound: false,
    dispatcher: { name: "dispatcher" },
    maintenance: { name: "maintenance" },
  } as unknown as WorkerStorages;
  return {
    storage: { db: { name: "storage" } } as unknown as Storage,
    secrets: {
      commandFingerprintKey: "core-authentication-secret-of-forty-chars",
      operatorCredentials: "disabled",
    },
    background: { kind: "postgres", workerStorages: storages },
    publicUrl: "https://core.example",
    environment: "core-environment",
  };
}

beforeEach(() => {
  mocks.drained = true;
  mocks.stops = 0;
  mocks.installedStorages.length = 0;
  mocks.installedSettings.length = 0;
});

describe("a postgres background whose stop passes its drain deadline", () => {
  test("answers drained: false, keeps the worker storages and settings installed for the work still running, and keeps refusing another background in the process", async () => {
    mocks.drained = false;
    const options = postgresOptions();
    const requestPort = createRequestPort(options);
    const background = requestPortComposition(requestPort).worker;
    await background?.ready;
    const settings = await postgresWorkerSettings(options);
    const storages =
      options.background?.kind === "postgres"
        ? options.background.workerStorages
        : undefined;

    await expect(background?.stop()).resolves.toEqual({ drained: false });
    await requestPort.close();

    // Installed once, and never forgotten.
    expect(mocks.installedStorages).toEqual([storages]);
    expect(mocks.installedSettings).toEqual([settings]);
    // A body still running reads the caller's storages and the options, not
    // the worker root's.
    expect(workerStorages()).toBe(storages);
    expect(workerSettings()).toEqual(settings);
    // Stopped once: close() answers the same stop.
    expect(mocks.stops).toBe(1);
    const another = createRequestPort(postgresOptions());
    expect(() => requestPortComposition(another)).toThrow(DomainError);
    expect(() => requestPortComposition(another)).toThrow(
      /already runs in this process/u,
    );
  });
});
