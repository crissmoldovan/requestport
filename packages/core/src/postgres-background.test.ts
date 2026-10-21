import { createHmac, randomBytes } from "node:crypto";

import type { Storage, WorkerStorages } from "@requestport/db";
import { DomainError } from "@requestport/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RequestPortOptions } from "./options.js";

/*
 * A `postgres` background (manifest-g.md §2.4): C's Postgres job worker,
 * run in process over the three worker storages the caller built, started
 * when the first capability composes RequestPort and stopped by close(); and
 * the job bodies it runs reading RequestPort's options in place of the
 * environment (§2.3; ruling 65's hand-over of the bodies), through the worker
 * settings `@requestport/jobs` keeps beside its storages.
 *
 * The worker itself is a recorder here (`startJobWorker`), so that no loop
 * runs; the bodies are the real ones, run directly, over stand-in
 * repositories, with the settings core installed.
 */

const mocks = vi.hoisted(() => {
  const record =
    <T>(name: string, value: T, into: Array<[string, unknown]>) =>
    (database: unknown) => {
      into.push([name, database]);
      return value;
    };
  const built: Array<[string, unknown]> = [];
  return {
    record,
    built,
    workers: [] as Array<{
      deps: Record<string, unknown>;
      stop: () => Promise<{ drained: boolean }>;
      stops: number;
    }>,
    failStart: false,
    /** What a started worker's `ready` waits for; settled unless a case holds it. */
    readyGate: Promise.resolve() as Promise<void>,
    installedStorages: [] as unknown[],
    installedSettings: [] as unknown[],
    workerStoragesBuilt: 0,
    resend: [] as Array<{ apiKey: string; from: string }>,
    busSecrets: [] as string[],
    outbox: {
      claimStanding: async () => "held",
      loadEvent: async () => ({
        event: {
          id: "018f0000-0000-7000-8000-000000000001",
          organizationId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1",
          type: "appearance.organization_defaults_initialized.v1",
          data: {
            organizationId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1",
            theme: "cue",
            density: "normal",
            mode: "dark",
          },
          projectId: null,
          requestId: null,
        },
      }),
      matchingWebhookSubscriptions: async () => [],
      markCompleted: async () => true,
      deadLetter: async () => true,
    },
    importDispatches: { claimBatch: async () => [] },
    exclusive: async () => ({ acquired: false }),
    notifications: {
      materialized: [] as unknown[][],
      claimNotificationIntent: async () => ({ attemptCount: 1 }),
      loadPendingIntent: async () => ({
        id: "intent-1",
        organizationId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1",
        recipientRef: "person@example.invalid",
        viewModel: {},
      }),
      ensureEmailDelivery: async () => ({ id: "delivery-1" }),
      completeEmailDelivery: async () => true,
      failEmailDelivery: async () => undefined,
      failed: [] as unknown[],
      failNotificationIntent: async (input: unknown) => {
        mocks.notifications.failed.push(input);
      },
      suppressPendingIntent: async () => undefined,
      dueQuestionReminders: async () => [
        { organizationId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1" },
      ],
    } as Record<string, unknown> & {
      materialized: unknown[][];
      failed: unknown[];
    },
    sweep: {
      listLeaseExpired: async () => [
        {
          id: "0b3f6b5e-1c1d-4e5f-8a9b-0c1d2e3f4a5b",
          organizationId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1",
          version: 3,
        },
      ],
      listGraceExpired: async () => [],
    },
    retention: { cleanup: async () => ({ deleted: 0 }) },
  };
});

for (const name of [
  "materializeRequestIntents",
  "materializeQuestionIntents",
  "materializeInvitationIntents",
  "materializeQuestionReminder",
]) {
  mocks.notifications[name] = async (...args: unknown[]) => {
    mocks.notifications.materialized.push([name, ...args]);
    return [];
  };
}

vi.mock("@requestport/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@requestport/db")>();
  const { DomainError } = await import("@requestport/domain");
  return {
    ...original,
    createOutboxRepository: mocks.record("outbox", mocks.outbox, mocks.built),
    createImportTaskDispatchRepository: mocks.record(
      "import dispatches",
      mocks.importDispatches,
      mocks.built,
    ),
    createAdvisoryExclusiveRunner: mocks.record(
      "exclusive",
      mocks.exclusive,
      mocks.built,
    ),
    createNotificationRepository: mocks.record(
      "notifications",
      mocks.notifications,
      mocks.built,
    ),
    createWorkSweepRepository: mocks.record(
      "work sweep",
      mocks.sweep,
      mocks.built,
    ),
    createRetentionRepository: mocks.record(
      "retention",
      mocks.retention,
      mocks.built,
    ),
    // The sweep's commands find nothing to change, which it counts as
    // nothing changed.
    createCommandTransactionManager: () => ({
      run: () => Promise.reject(new DomainError("not_found", "no session")),
    }),
    createWorkerStorages: () => {
      mocks.workerStoragesBuilt += 1;
      throw new Error("core never builds the worker storages");
    },
  };
});
vi.mock("@requestport/domain", async (importOriginal) => {
  const original = await importOriginal<typeof import("@requestport/domain")>();
  class RecordingBus extends original.AtomicCommandBus {
    constructor(
      options: ConstructorParameters<typeof original.AtomicCommandBus>[0],
    ) {
      mocks.busSecrets.push(options.fingerprintSecret);
      super(options);
    }
  }
  return { ...original, AtomicCommandBus: RecordingBus };
});
vi.mock("@requestport/jobs/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@requestport/jobs/worker")>()),
  startJobWorker: (deps: Record<string, unknown>) => {
    if (mocks.failStart) throw new Error("the worker's timing is unsafe");
    const worker = {
      deps,
      stops: 0,
      stop: async () => {
        worker.stops += 1;
        return { drained: true };
      },
    };
    mocks.workers.push(worker);
    return { ready: mocks.readyGate, stop: worker.stop };
  },
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
// By path: core does not depend on @requestport/notifications, so its name
// does not resolve from here; the e-mail body imports this module.
vi.mock("../../notifications/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createResendNotificationAdapter: (options: {
    apiKey: string;
    from: string;
  }) => {
    mocks.resend.push(options);
    return { send: async () => ({ providerMessageId: "message-1" }) };
  },
}));

const { createRequestPort, requestPortComposition } = await import(
  "./request-port.js"
);
const { postgresWorkerSettings } = await import("./background.js");
const jobs = await import("@requestport/jobs");
const { workerSettings, workSweepFingerprintSecret } = await import(
  "@requestport/jobs/worker-storages"
);

const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";
const ring = () => ({
  current: { version: "v2", key: randomBytes(32).toString("base64") },
  previous: { version: "v1", key: randomBytes(32).toString("base64") },
});

/** The caller's three worker storages, unset-shaped, recording what touches them. */
function callerWorkerStorages() {
  const closed: string[] = [];
  const storages = {
    bound: false,
    dispatcher: { name: "dispatcher" },
    maintenance: { name: "maintenance" },
    resolveJobOrganization: async () => organizationId,
    withTenant: async (
      organization: string,
      work: (database: unknown) => unknown,
    ) => work({ name: `unit ${organization}` }),
    roleReports: async () => null,
    close: async () => {
      closed.push("worker storages");
    },
  };
  return { storages: storages as unknown as WorkerStorages, closed };
}

function postgresOptions(overrides: Partial<RequestPortOptions> = {}) {
  const worker = callerWorkerStorages();
  const closed: string[] = [];
  const storage = {
    db: { name: "storage" },
    close: async () => {
      closed.push("storage");
    },
  } as unknown as Storage;
  const lines: unknown[][] = [];
  const logger = {
    debug: (...line: unknown[]) => lines.push(["debug", ...line]),
    info: (...line: unknown[]) => lines.push(["info", ...line]),
    warn: (...line: unknown[]) => lines.push(["warn", ...line]),
    error: (...line: unknown[]) => lines.push(["error", ...line]),
  };
  const workspaceKeys = ring();
  const options: RequestPortOptions = {
    storage,
    secrets: {
      commandFingerprintKey: "core-authentication-secret-of-forty-chars",
      operatorCredentials: "disabled",
      workspaceKeys,
      webhookKeys: { ...ring(), signingKey: "read-by-nothing" },
      slackStateSecret: "core-slack-state-secret",
      email: { apiKey: "core-resend-key", from: "core@example.invalid" },
    },
    background: { kind: "postgres", workerStorages: worker.storages },
    publicUrl: "https://core.example",
    environment: "core-environment",
    logger,
    ...overrides,
  };
  return { options, worker, closed, logger, lines };
}

const ports: Array<ReturnType<typeof createRequestPort>> = [];
function port(options: RequestPortOptions) {
  const created = createRequestPort(options);
  ports.push(created);
  return created;
}

/** The JSON lines `console.log` was given while `run` ran. */
async function linesOf(run: () => Promise<unknown>) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await run();
    return log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
  } finally {
    log.mockRestore();
  }
}

beforeEach(() => {
  mocks.built.length = 0;
  mocks.workers.length = 0;
  mocks.installedStorages.length = 0;
  mocks.installedSettings.length = 0;
  mocks.workerStoragesBuilt = 0;
  mocks.failStart = false;
  mocks.readyGate = Promise.resolve();
  mocks.resend.length = 0;
  mocks.notifications.materialized.length = 0;
  mocks.notifications.failed.length = 0;
});
afterEach(async () => {
  for (const created of ports.splice(0)) await created.close();
});

describe("a postgres background", () => {
  test("createRequestPort starts no worker, installs nothing and builds no worker storage", () => {
    port(postgresOptions().options);

    expect(mocks.workers).toEqual([]);
    expect(mocks.installedStorages).toEqual([]);
    expect(mocks.installedSettings).toEqual([]);
    expect(mocks.workerStoragesBuilt).toBe(0);
  });

  test("the first capability starts C's worker once, over the caller's storages, as requestport-jobs starts it", async () => {
    const { options, worker, logger } = postgresOptions();
    const requestPort = port(options);

    requestPortComposition(requestPort);
    await requestPortComposition(requestPort).worker?.ready;

    expect(mocks.workers).toHaveLength(1);
    const { deps } = mocks.workers[0] ?? { deps: {} };
    // Its claims and its schedules' locks on the dispatcher's storage, every
    // job's body and every schedule from the shared catalogue, and the
    // caller's logger for its own lines.
    expect(mocks.built).toEqual([
      ["outbox", worker.storages.dispatcher],
      ["import dispatches", worker.storages.dispatcher],
      ["exclusive", worker.storages.dispatcher],
    ]);
    expect(deps).toEqual({
      outboxRepository: mocks.outbox,
      importTaskDispatchRepository: mocks.importDispatches,
      runExclusive: mocks.exclusive,
      createHandlers: jobs.createJobHandlers,
      schedules: jobs.scheduleDefinitions,
      logger,
    });
    // The bodies reach the caller's storages, and read the options.
    expect(mocks.installedStorages).toEqual([worker.storages]);
    expect(mocks.installedSettings).toEqual([
      await postgresWorkerSettings(options),
    ]);
    expect(mocks.workerStoragesBuilt).toBe(0);
  });

  test("close() stops the worker it started, waits for it, and forgets the storages and settings, closing no storage", async () => {
    const { options, worker, closed } = postgresOptions();
    const requestPort = port(options);
    await requestPortComposition(requestPort).worker?.ready;

    await requestPort.close();
    await requestPort.close();

    expect(mocks.workers.map(({ stops }) => stops)).toEqual([1]);
    expect(mocks.installedStorages).toEqual([worker.storages, undefined]);
    expect(mocks.installedSettings).toEqual([
      await postgresWorkerSettings(options),
      undefined,
    ]);
    expect(worker.closed).toEqual([]);
    expect(closed).toEqual([]);
  });

  test("close() before any capability stops nothing, because nothing started", async () => {
    const requestPort = port(postgresOptions().options);

    await requestPort.close();

    expect(mocks.workers).toEqual([]);
    expect(mocks.installedStorages).toEqual([]);
  });

  test("an exclusive runner given with the background holds the worker's ticks in place of the advisory one, which is not built (ruling 141)", async () => {
    const { options, worker } = postgresOptions();
    const runExclusive = async () => ({ acquired: false as const });
    const requestPort = port({
      ...options,
      background: {
        kind: "postgres",
        workerStorages: worker.storages,
        runExclusive,
      },
    });

    await requestPortComposition(requestPort).worker?.ready;

    expect(mocks.workers).toHaveLength(1);
    expect(mocks.workers[0]?.deps.runExclusive).toBe(runExclusive);
    expect(mocks.built).toEqual([
      ["outbox", worker.storages.dispatcher],
      ["import dispatches", worker.storages.dispatcher],
    ]);
  });

  test("start() starts the worker at once, resolves once it is ready, and asked again starts no second one (ruling 158, item 5)", async () => {
    const { options, worker } = postgresOptions();
    let markReady: () => void = () => undefined;
    mocks.readyGate = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const requestPort = port(options);
    let settled = false;

    const started = requestPort.start().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(mocks.workers).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    markReady();
    await started;

    expect(settled).toBe(true);
    expect(mocks.installedStorages).toEqual([worker.storages]);
    await requestPort.start();
    requestPortComposition(requestPort);
    expect(mocks.workers).toHaveLength(1);
  });

  test("start() rejects when the worker cannot start", async () => {
    mocks.failStart = true;
    const requestPort = port(postgresOptions().options);

    await expect(requestPort.start()).rejects.toThrow(
      "the worker's timing is unsafe",
    );
    expect(mocks.workers).toEqual([]);
  });

  test("a worker that cannot start is told to the logger, rejects ready, forgets what was installed, and leaves the process free for another", async () => {
    mocks.failStart = true;
    const { options, worker, lines } = postgresOptions();
    const requestPort = port(options);

    const { worker: background } = requestPortComposition(requestPort);
    await expect(background?.ready).rejects.toThrow(
      "the worker's timing is unsafe",
    );
    await expect(requestPort.close()).resolves.toBeUndefined();
    await expect(background?.stop()).resolves.toEqual({ drained: true });

    expect(lines).toEqual([
      ["error", "worker.start_failed", { errorCode: "worker_start_failed" }],
    ]);
    expect(mocks.installedStorages).toEqual([worker.storages, undefined]);
    expect(mocks.installedSettings).toEqual([
      await postgresWorkerSettings(options),
      undefined,
    ]);
    mocks.failStart = false;
    await requestPortComposition(port(postgresOptions().options)).worker?.ready;
    expect(mocks.workers).toHaveLength(1);
  });

  test("a second refuses to start while one runs in the process, and starts once that one stops", async () => {
    const first = port(postgresOptions().options);
    const second = port(postgresOptions().options);
    await requestPortComposition(first).worker?.ready;

    expect(() => requestPortComposition(second)).toThrow(DomainError);
    expect(() => requestPortComposition(second)).toThrow(
      /already runs in this process/u,
    );
    expect(mocks.workers).toHaveLength(1);

    await first.close();
    await requestPortComposition(second).worker?.ready;
    expect(mocks.workers).toHaveLength(2);
  });

  test("the settings the bodies read are the options: the label, defaulting to unknown, the links' origin, the webhook endpoint policy, production exactly under the label production, private and loopback receivers exactly when privateWebhookReceivers is true, the sweep key derived as the Trigger.dev worker derives it, the rings, the Slack secret and Resend's pair; and the self-host's service names", async () => {
    const { options } = postgresOptions();

    expect(await postgresWorkerSettings(options)).toEqual({
      environment: "core-environment",
      serviceNames: "self-host",
      publicUrl: "https://core.example",
      productionWebhookEndpoints: false,
      privateWebhookReceivers: false,
      secrets: {
        workSweepFingerprintSecret: createHmac(
          "sha256",
          options.secrets.commandFingerprintKey,
        )
          .update("requestport-work-sweep-v1")
          .digest("hex"),
        workspaceKeys: options.secrets.workspaceKeys,
        slackStateSecret: "core-slack-state-secret",
        webhookKeys: options.secrets.webhookKeys,
        email: { apiKey: "core-resend-key", from: "core@example.invalid" },
      },
    });
    expect(
      (await postgresWorkerSettings({ ...options, environment: undefined }))
        .environment,
    ).toBe("unknown");
    expect(
      (await postgresWorkerSettings({ ...options, environment: "production" }))
        .productionWebhookEndpoints,
    ).toBe(true);
    expect(
      (await postgresWorkerSettings({ ...options, environment: undefined }))
        .productionWebhookEndpoints,
    ).toBe(false);
    for (const [privateWebhookReceivers, admitted] of [
      [true, true],
      [false, false],
      [undefined, false],
    ] as const) {
      expect(
        (
          await postgresWorkerSettings({
            ...options,
            environment: "production",
            privateWebhookReceivers,
          })
        ).privateWebhookReceivers,
      ).toBe(admitted);
    }
  });
});

describe("the job bodies, under a postgres background", () => {
  /**
   * Composes a RequestPort over `options`, and waits for its background,
   * which installs its settings before the worker starts.
   */
  const started = async (options: RequestPortOptions) => {
    await requestPortComposition(port(options)).worker?.ready;
    return workerSettings();
  };
  const runner = {
    kind: "postgres" as const,
    enqueue: async () => ({ id: "job-1" }),
    sleep: async () => undefined,
    waitBeforeRetry: async () => undefined,
    dispatchOutbox: async () => ({ accepted: false }),
  };
  const schedule = (id: string) => {
    const definition = jobs.scheduleDefinitions.find(
      (candidate) => candidate.id === id,
    );
    if (!definition) throw new Error(`no schedule ${id}`);
    return definition;
  };

  test("e-mail delivery sends with the options' Resend pair, and fails as provider_unavailable without it", async () => {
    await started(postgresOptions().options);

    await jobs.runEmailDelivery({ intentId: "intent-1" });
    expect(mocks.resend).toEqual([
      { apiKey: "core-resend-key", from: "core@example.invalid" },
    ]);
    await ports.splice(0)[0]?.close();

    const { options } = postgresOptions();
    await started({
      ...options,
      secrets: { ...options.secrets, email: undefined },
    });
    await expect(
      jobs.runEmailDelivery({ intentId: "intent-1" }),
    ).rejects.toThrow("provider_unavailable");
    expect(mocks.resend).toHaveLength(1);
    expect(mocks.notifications.failed).toMatchObject([
      { intentId: "intent-1", errorCode: "provider_unavailable" },
    ]);
  });

  test("outbox routing and question reminders write their links against the options' publicUrl", async () => {
    await started(postgresOptions().options);

    await jobs.deliverOutboxEvent("outbox-1", runner, {
      kind: "lease",
      leaseId: "lease-1",
    });
    await schedule("question-reminders").run(runner);

    expect(
      mocks.notifications.materialized.map(([name, first]) => [name, first]),
    ).toEqual([
      ["materializeRequestIntents", "018f0000-0000-7000-8000-000000000001"],
      ["materializeQuestionIntents", "018f0000-0000-7000-8000-000000000001"],
      ["materializeInvitationIntents", "018f0000-0000-7000-8000-000000000001"],
      ["materializeQuestionReminder", "https://core.example"],
    ]);
    expect(
      mocks.notifications.materialized
        .slice(0, 3)
        .map(([, , publicUrl]) => publicUrl),
    ).toEqual([
      "https://core.example",
      "https://core.example",
      "https://core.example",
    ]);
  });

  test("the stale-session sweep's bus fingerprints with the key derived from the options' commandFingerprintKey", async () => {
    const { options } = postgresOptions();
    await started(options);
    const before = mocks.busSecrets.length;

    await schedule("stale-work-sessions").run(runner);

    const expected = workSweepFingerprintSecret(
      options.secrets.commandFingerprintKey,
    );
    expect(mocks.busSecrets.slice(before)).toEqual([expected]);
    expect(expected).toBe(
      createHmac("sha256", options.secrets.commandFingerprintKey)
        .update("requestport-work-sweep-v1")
        .digest("hex"),
    );
  });

  test("a body's log lines and the job metrics carry the options' environment, as the Trigger.dev worker's carry its label, under the self-host's service names, not the Trigger.dev worker's (ruling 158, item 9)", async () => {
    await started(postgresOptions().options);

    const lines = await linesOf(() =>
      schedule("retention-cleanup").run(runner),
    );

    expect(lines).toContainEqual(
      expect.objectContaining({
        event: "retention.category_completed",
        service: "requestport-retention",
        environment: "core-environment",
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: "metric.recorded",
        service: "requestport-worker",
        environment: "core-environment",
        metricName: "task.result_total",
      }),
    );
    expect(
      lines
        .map((line) => line.service)
        .filter((service) =>
          /^(?:trigger-|requestport-trigger$)/u.test(String(service)),
        ),
    ).toEqual([]);
  });
});
