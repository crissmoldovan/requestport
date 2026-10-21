import { readdirSync, readFileSync } from "node:fs";

import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * What production's Trigger.dev worker registers, and what it asks Trigger.dev
 * to run, pinned.
 *
 * Merging to `main` deploys this worker. Track C of Plan 13 moves the task
 * bodies behind a job-runner port so a Postgres worker can run them too, and
 * that move must leave Trigger — still the selected runner — doing exactly what
 * it did: the same task ids, the same retry policies, the same crons, and the
 * same child runs with the same idempotency options.
 *
 * The SDK is replaced by a recorder. `task(...).trigger(payload, options)` and
 * `tasks.trigger(id, payload, options)` both end in the SDK's
 * `trigger_internal` with the same task id, payload and options (the only
 * difference is `queue: params.queue?.name`, and no task here names a queue),
 * so both are recorded as one call shape: `[taskId, payload, options]`.
 */

type TriggerCall = [string, unknown, Record<string, unknown>];

const recorded = vi.hoisted(() => ({
  definitions: [] as Array<Record<string, unknown>>,
  triggers: [] as Array<[string, unknown, Record<string, unknown>]>,
  waits: [] as number[],
}));

vi.mock("@trigger.dev/sdk", () => {
  const record = (id: string, payload: unknown, options?: unknown) => {
    recorded.triggers.push([
      id,
      payload,
      (options ?? {}) as Record<string, unknown>,
    ]);
    return Promise.resolve({ id: `run_${recorded.triggers.length}` });
  };
  const define = (kind: "task" | "schedule") => (definition: object) => {
    recorded.definitions.push({ kind, ...definition });
    const id = (definition as { id: string }).id;
    return {
      ...definition,
      trigger: (payload: unknown, options?: unknown) =>
        record(id, payload, options),
    };
  };
  return {
    task: define("task"),
    schedules: { task: define("schedule") },
    tasks: { trigger: record },
    idempotencyKeys: {
      create: async (key: string, options: { scope: string }) =>
        `idempotency(${options.scope}):${key}`,
    },
    wait: {
      for: async ({ seconds }: { seconds: number }) => {
        recorded.waits.push(seconds);
      },
    },
  };
});

const outboxRepository = {
  acceptClaim: vi.fn(),
  claimBatch: vi.fn(),
  claimOne: vi.fn(),
  claimStanding: vi.fn(),
  deadLetter: vi.fn(),
  ensureWebhookDelivery: vi.fn(),
  loadEvent: vi.fn(),
  markAccepted: vi.fn(),
  markCompleted: vi.fn(),
  matchingWebhookSubscriptions: vi.fn(),
  pendingBacklog: vi.fn(),
  pendingWebhookDeliveries: vi.fn(),
};
const notificationRepository = {
  dueNotificationIntents: vi.fn(),
  dueQuestionReminders: vi.fn(),
  materializeQuestionReminder: vi.fn(),
  materializeInvitationIntents: vi.fn(),
  materializeQuestionIntents: vi.fn(),
  materializeRequestIntents: vi.fn(),
};
const slackRepository = { dueSlackDeliveryOperations: vi.fn() };
const importTaskDispatchRepository = {
  acceptClaim: vi.fn(),
  claimBatch: vi.fn(),
  claimStanding: vi.fn(),
  load: vi.fn(),
  markAccepted: vi.fn(),
};

/*
 * The worker's three storages, as production had them until the owner's
 * switch: unset. Each storage, and each processing unit, is the worker
 * root's storage's one handle, so the repository factories below hand back
 * the same recorders whichever handle they are given; what each call was
 * made on is recorded by `handles`.
 */
const handles = vi.hoisted(() => ({
  dispatcher: { handle: "dispatcher" },
  maintenance: { handle: "maintenance" },
  units: [] as string[],
}));
const storages = {
  bound: false,
  dispatcher: handles.dispatcher,
  maintenance: handles.maintenance,
  resolveJobOrganization: vi.fn(),
  withTenant: async (
    organizationId: string,
    work: (database: unknown) => unknown,
  ) => {
    handles.units.push(organizationId);
    return work({ handle: "unit" });
  },
  roleReports: async () => null,
  close: async () => undefined,
};
const factoryHandles: Array<[string, unknown]> = [];
const factory =
  <T>(name: string, repository: T) =>
  (database: unknown) => {
    factoryHandles.push([name, database]);
    return repository;
  };

vi.mock("@requestport/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createImportTaskDispatchRepository: factory(
    "imports",
    importTaskDispatchRepository,
  ),
  createNotificationRepository: factory(
    "notifications",
    notificationRepository,
  ),
  createOutboxRepository: factory("outbox", outboxRepository),
  createSlackRepository: factory("slack", slackRepository),
  createWorkerStorages: () => storages,
}));

/*
 * The worker root's own storage (`@requestport/db/wiring`), which the root
 * asks for before it builds the three: a stand-in, so that a body's first
 * `workerStorages()` builds no pool here. `createWorkerStorages` above
 * ignores it.
 */
vi.mock("@requestport/db/wiring", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rootStorageFromEnv: () => ({ db: { handle: "root" } }),
}));

const tasks = await import("./index.js");

type Runnable = { run: (payload?: unknown, context?: unknown) => unknown };
/** A run's context, as Trigger.dev hands it: this run's id is `run_self`. */
const run = (task: unknown, payload?: unknown) =>
  (task as Runnable).run(payload, { ctx: { run: { id: "run_self" } } });
const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";

beforeEach(() => {
  recorded.triggers.length = 0;
  recorded.waits.length = 0;
  handles.units.length = 0;
  factoryHandles.length = 0;
  storages.resolveJobOrganization.mockReset();
  storages.resolveJobOrganization.mockResolvedValue(organizationId);
  for (const repository of [
    outboxRepository,
    notificationRepository,
    slackRepository,
    importTaskDispatchRepository,
  ]) {
    for (const method of Object.values(repository)) method.mockReset();
  }
});

describe("the task definitions production's worker registers", () => {
  const retry = (
    maxAttempts: number,
    minTimeoutInMs: number,
    maxTimeoutInMs: number,
  ) => ({
    maxAttempts,
    minTimeoutInMs,
    maxTimeoutInMs,
    factor: 2,
    randomize: true,
  });

  test("keep every id, retry policy and cron", () => {
    const surface = recorded.definitions
      .map(({ kind, id, retry, cron }) => ({ kind, id, retry, cron }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));

    expect(surface).toEqual([
      {
        kind: "task",
        id: "deployment-preflight",
        retry: undefined,
        cron: undefined,
      },
      {
        kind: "task",
        id: "email-delivery",
        retry: retry(5, 30_000, 120_000),
        cron: undefined,
      },
      {
        kind: "task",
        id: "legacy-import-analyze",
        retry: retry(3, 2_000, 60_000),
        cron: undefined,
      },
      {
        kind: "task",
        id: "legacy-import-apply",
        retry: retry(3, 2_000, 60_000),
        cron: undefined,
      },
      {
        kind: "schedule",
        id: "legacy-import-dispatch-repair",
        retry: undefined,
        cron: "*/2 * * * *",
      },
      {
        kind: "schedule",
        id: "notification-delivery-repair",
        retry: undefined,
        cron: "*/2 * * * *",
      },
      {
        kind: "schedule",
        id: "operational-metrics",
        retry: undefined,
        cron: "*/2 * * * *",
      },
      {
        kind: "task",
        id: "outbox-delivery",
        retry: retry(5, 1_000, 60_000),
        cron: undefined,
      },
      {
        kind: "schedule",
        id: "outbox-repair",
        retry: undefined,
        cron: "*/2 * * * *",
      },
      {
        kind: "schedule",
        id: "question-reminders",
        retry: undefined,
        cron: "*/15 * * * *",
      },
      {
        kind: "schedule",
        id: "retention-cleanup",
        retry: undefined,
        cron: "17 3 * * *",
      },
      {
        kind: "task",
        id: "slack-connection-test",
        retry: retry(5, 30_000, 120_000),
        cron: undefined,
      },
      {
        kind: "schedule",
        id: "slack-connection-test-repair",
        retry: undefined,
        cron: "*/10 * * * *",
      },
      {
        kind: "task",
        id: "slack-message-update",
        retry: retry(5, 30_000, 120_000),
        cron: undefined,
      },
      {
        kind: "schedule",
        id: "slack-message-update-repair",
        retry: undefined,
        cron: "*/5 * * * *",
      },
      {
        kind: "task",
        id: "slack-question-delivery",
        retry: retry(5, 30_000, 120_000),
        cron: undefined,
      },
      {
        kind: "schedule",
        id: "stale-work-sessions",
        retry: undefined,
        cron: "*/2 * * * *",
      },
      {
        kind: "task",
        id: "webhook-delivery",
        retry: retry(6, 2_000, 120_000),
        cron: undefined,
      },
      {
        kind: "schedule",
        id: "webhook-delivery-repair",
        retry: undefined,
        cron: "*/2 * * * *",
      },
      {
        kind: "schedule",
        id: "webhook-secret-rotation",
        retry: undefined,
        cron: "*/5 * * * *",
      },
    ]);
  });
});

describe("the child runs production's worker asks Trigger.dev for", () => {
  test("outbox routing: a webhook run without options, and keyed notification runs", async () => {
    outboxRepository.claimStanding.mockResolvedValue("held");
    outboxRepository.markCompleted.mockResolvedValue(true);
    outboxRepository.loadEvent.mockResolvedValue({
      event: {
        id: "018f0000-0000-7000-8000-000000000001",
        organizationId,
        type: "retention.hold_changed.v1",
        data: { category: "all", status: "active" },
        projectId: null,
        requestId: null,
      },
    });
    outboxRepository.matchingWebhookSubscriptions.mockResolvedValue([
      { id: "subscription-1" },
    ]);
    outboxRepository.ensureWebhookDelivery.mockResolvedValue("delivery-1");
    notificationRepository.materializeRequestIntents.mockResolvedValue([
      { id: "intent-email", channel: "email" },
    ]);
    notificationRepository.materializeQuestionIntents.mockResolvedValue([
      { id: "intent-slack", channel: "slack" },
    ]);
    notificationRepository.materializeInvitationIntents.mockResolvedValue([]);

    await expect(
      run(tasks.outboxDelivery, { outboxId: "outbox-1" }),
    ).resolves.toMatchObject({ status: "routed" });

    expect(recorded.triggers).toEqual<TriggerCall[]>([
      ["webhook-delivery", { deliveryId: "delivery-1" }, {}],
      [
        "email-delivery",
        { intentId: "intent-email" },
        {
          idempotencyKey: "idempotency(global):email:intent-email",
          idempotencyKeyTTL: "30d",
        },
      ],
      [
        "slack-question-delivery",
        { intentId: "intent-slack" },
        {
          idempotencyKey: "idempotency(global):slack:intent-slack",
          idempotencyKeyTTL: "30d",
        },
      ],
    ]);
    // Settled under this run's own id (manifest-i2.md §5.1), read before
    // any effect, in units bound to the row's organisation.
    const settlement = { kind: "trigger_run", runId: "run_self" };
    expect(storages.resolveJobOrganization).toHaveBeenCalledWith(
      "outbox",
      "outbox-1",
    );
    expect(outboxRepository.claimStanding).toHaveBeenCalledWith(
      "outbox-1",
      settlement,
    );
    expect(outboxRepository.markCompleted).toHaveBeenCalledWith(
      "outbox-1",
      settlement,
    );
    expect(new Set(handles.units)).toEqual(new Set([organizationId]));
  });

  test("the three settling tasks settle under ctx.run.id, and a run started before its acceptance retries before any effect", async () => {
    const { SettlementPendingError } = await import("@requestport/jobs");
    const settlement = { kind: "trigger_run", runId: "run_self" };
    const dispatchId = "0b9e2c56-3f0e-4c38-9d55-6c1f3a1c9e11";
    outboxRepository.claimStanding.mockResolvedValue("pending_acceptance");
    importTaskDispatchRepository.claimStanding.mockResolvedValue(
      "pending_acceptance",
    );

    await expect(
      run(tasks.outboxDelivery, { outboxId: "outbox-2" }),
    ).rejects.toBeInstanceOf(SettlementPendingError);
    expect(outboxRepository.claimStanding).toHaveBeenCalledWith(
      "outbox-2",
      settlement,
    );
    for (const task of [tasks.importAnalyze, tasks.importApply]) {
      await expect(
        run(task, { dispatchId, attemptCount: 2 }),
      ).rejects.toBeInstanceOf(SettlementPendingError);
    }
    expect(importTaskDispatchRepository.claimStanding.mock.calls).toEqual([
      [dispatchId, 2, settlement],
      [dispatchId, 2, settlement],
    ]);
    expect(recorded.triggers).toEqual([]);
    expect(outboxRepository.loadEvent).not.toHaveBeenCalled();
    expect(importTaskDispatchRepository.load).not.toHaveBeenCalled();
  });

  test("question reminders: keyed per channel and intent", async () => {
    notificationRepository.dueQuestionReminders.mockResolvedValue([
      {
        questionId: "question-1",
        organizationId,
        asOf: new Date("2026-09-30T12:00:00Z"),
      },
    ]);
    notificationRepository.materializeQuestionReminder.mockResolvedValue([
      { id: "reminder-1", channel: "email" },
      { id: "reminder-2", channel: "slack" },
    ]);

    await expect(run(tasks.questionReminders)).resolves.toEqual({
      created: 2,
    });
    // Discovery on the dispatcher's storage; the materialisation in a unit
    // bound to the question's organisation.
    expect(notificationRepository.dueQuestionReminders).toHaveBeenCalledWith(
      200,
    );
    expect(factoryHandles).toContainEqual([
      "notifications",
      handles.dispatcher,
    ]);
    expect(handles.units).toEqual([organizationId]);
    expect(recorded.triggers).toEqual<TriggerCall[]>([
      [
        "email-delivery",
        { intentId: "reminder-1" },
        {
          idempotencyKey: "idempotency(global):reminder:email:reminder-1",
          idempotencyKeyTTL: "30d",
        },
      ],
      [
        "slack-question-delivery",
        { intentId: "reminder-2" },
        {
          idempotencyKey: "idempotency(global):reminder:slack:reminder-2",
          idempotencyKeyTTL: "30d",
        },
      ],
    ]);
  });

  test("notification repair: unkeyed runs per due intent", async () => {
    notificationRepository.dueNotificationIntents.mockResolvedValue([
      { id: "due-1", channel: "email" },
      { id: "due-2", channel: "slack" },
    ]);

    await expect(run(tasks.notificationDeliveryRepair)).resolves.toEqual({
      due: 2,
      accepted: 2,
    });
    expect(notificationRepository.dueNotificationIntents).toHaveBeenCalledWith(
      100,
    );
    expect(recorded.triggers).toEqual<TriggerCall[]>([
      ["email-delivery", { intentId: "due-1" }, {}],
      ["slack-question-delivery", { intentId: "due-2" }, {}],
    ]);
  });

  test("webhook and Slack repairs: unkeyed runs per pending row", async () => {
    outboxRepository.pendingWebhookDeliveries.mockResolvedValue([
      { id: "webhook-1" },
    ]);
    slackRepository.dueSlackDeliveryOperations.mockImplementation(
      async (type: string) => [{ id: `${type}-1` }],
    );

    await expect(run(tasks.webhookDeliveryRepair)).resolves.toEqual({
      scheduled: 1,
    });
    await expect(run(tasks.slackMessageUpdateRepair)).resolves.toEqual({
      scheduled: 1,
    });
    await expect(run(tasks.slackConnectionTestRepair)).resolves.toEqual({
      scheduled: 1,
    });

    expect(outboxRepository.pendingWebhookDeliveries).toHaveBeenCalledWith(100);
    expect(recorded.triggers).toEqual<TriggerCall[]>([
      ["webhook-delivery", { deliveryId: "webhook-1" }, {}],
      ["slack-message-update", { operationId: "message_update-1" }, {}],
      ["slack-connection-test", { operationId: "connection_test-1" }, {}],
    ]);
  });

  test("outbox repair: claims a batch, runs each keyed by attempt, records the run", async () => {
    outboxRepository.pendingBacklog.mockResolvedValue({
      count: 1,
      oldestAgeSeconds: 3,
    });
    outboxRepository.claimBatch.mockResolvedValue([
      {
        id: "outbox-9",
        eventId: "event-9",
        organizationId,
        attemptCount: 2,
        leaseId: "lease-9",
        leaseExpiresAt: new Date(),
      },
    ]);
    outboxRepository.acceptClaim.mockResolvedValue(true);

    await expect(run(tasks.outboxRepair)).resolves.toEqual({
      claimed: 1,
      accepted: 1,
    });
    // The backlog on the maintenance storage, the claim and the acceptance
    // on the dispatcher's (track-i2.md, "I.2b design" §3).
    expect(factoryHandles).toEqual([
      ["outbox", handles.maintenance],
      ["outbox", handles.dispatcher],
    ]);
    // A lease as long as the repair's own run may last (maxDuration 300 s,
    // trigger.config.ts), so every acceptance the run makes is inside it.
    expect(outboxRepository.claimBatch).toHaveBeenCalledWith(100, 300);
    expect(recorded.triggers).toEqual<TriggerCall[]>([
      [
        "outbox-delivery",
        { outboxId: "outbox-9" },
        {
          idempotencyKey: "idempotency(global):outbox:outbox-9:2",
          idempotencyKeyTTL: "30d",
        },
      ],
    ]);
    // Accepted under the claim's lease, with the id trigger() returned: the
    // run's ctx.run.id, which it settles under.
    expect(outboxRepository.acceptClaim).toHaveBeenCalledWith(
      "outbox-9",
      "lease-9",
      "run_1",
    );
    expect(outboxRepository.markAccepted).not.toHaveBeenCalled();
  });

  test("import dispatch repair: claims a batch, runs each keyed by attempt", async () => {
    importTaskDispatchRepository.claimBatch.mockResolvedValue([
      {
        id: "dispatch-a",
        organizationId,
        taskKind: "analyze",
        attemptCount: 1,
        leaseId: "lease-a",
        leaseExpiresAt: new Date(),
      },
      {
        id: "dispatch-b",
        organizationId,
        taskKind: "apply",
        attemptCount: 3,
        leaseId: "lease-b",
        leaseExpiresAt: new Date(),
      },
    ]);
    importTaskDispatchRepository.acceptClaim.mockResolvedValue(true);

    await expect(run(tasks.importDispatchRepair)).resolves.toEqual({
      claimed: 2,
      accepted: 2,
    });
    expect(factoryHandles).toEqual([["imports", handles.dispatcher]]);
    expect(importTaskDispatchRepository.claimBatch).toHaveBeenCalledWith(
      50,
      300,
    );
    expect(importTaskDispatchRepository.acceptClaim.mock.calls).toEqual([
      ["dispatch-a", "lease-a", "run_1"],
      ["dispatch-b", "lease-b", "run_2"],
    ]);
    expect(importTaskDispatchRepository.markAccepted).not.toHaveBeenCalled();
    expect(recorded.triggers).toEqual<TriggerCall[]>([
      [
        "legacy-import-analyze",
        { dispatchId: "dispatch-a", attemptCount: 1 },
        {
          idempotencyKey: "idempotency(global):import-dispatch:dispatch-a:1",
          idempotencyKeyTTL: "30d",
        },
      ],
      [
        "legacy-import-apply",
        { dispatchId: "dispatch-b", attemptCount: 3 },
        {
          idempotencyKey: "idempotency(global):import-dispatch:dispatch-b:3",
          idempotencyKeyTTL: "30d",
        },
      ],
    ]);
  });

  test("Slack rate limits wait through Trigger.dev's checkpointed wait", async () => {
    const limited = Object.assign(new Error("rate limited"), {
      code: "slack_webapi_rate_limited_error",
      retryAfter: 7,
    });
    const operation = vi
      .fn()
      .mockRejectedValueOnce(limited)
      .mockResolvedValueOnce("sent");

    await expect(tasks.withSlackRateLimit(operation)).resolves.toBe("sent");
    expect(recorded.waits).toEqual([7]);
  });

  test("the Trigger.dev runner's retry pause is the checkpointed wait", async () => {
    const { triggerJobRunner } = await import("./job-runner.js");

    await triggerJobRunner.waitBeforeRetry(12);

    expect(recorded.waits).toEqual([12]);
  });

  test("the Trigger.dev runner dispatches an outbox row the way the dispatcher always has", async () => {
    const { triggerJobRunner } = await import("./job-runner.js");
    outboxRepository.claimOne.mockResolvedValue({
      id: "outbox-7",
      eventId: "event-7",
      organizationId,
      attemptCount: 1,
    });
    outboxRepository.markAccepted.mockResolvedValue(true);

    await expect(
      triggerJobRunner.dispatchOutbox("outbox-7", organizationId),
    ).resolves.toEqual({
      accepted: true,
      runId: "run_1",
    });
    // The claim and the acceptance are each a unit bound to the row's
    // organisation, with the run started between them.
    expect(handles.units).toEqual([organizationId, organizationId]);
    expect(recorded.triggers).toEqual<TriggerCall[]>([
      [
        "outbox-delivery",
        { outboxId: "outbox-7" },
        {
          idempotencyKey: "idempotency(global):outbox:outbox-7:1",
          idempotencyKeyTTL: "30d",
        },
      ],
    ]);
    expect(outboxRepository.markAccepted).toHaveBeenCalledWith(
      "outbox-7",
      expect.stringMatching(/^web:/u),
      "run_1",
    );
  });
});

/*
 * The worker's database surface (manifest-i2.md §2.2, ruling 45). The worker
 * has no single entry file, so every module that defines a task imports
 * `./database-surface.js` before anything else, and loading any one of them
 * declares `worker`. This file's run has no `test` declaration of its own
 * (trigger/vitest.config.ts declares none), so what it reads is theirs.
 */
describe("the worker's database surface", () => {
  const taskModules = readdirSync(import.meta.dirname)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) =>
      /\b(?:task|schedules\.task)\(\{/u.test(
        readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
      ),
    )
    .sort();

  test("every task module imports the declaration before anything else", () => {
    expect(taskModules).toEqual([
      "deployment-preflight.ts",
      "email-delivery.ts",
      "import-analyze.ts",
      "import-apply.ts",
      "import-dispatch-repair.ts",
      "notification-repair.ts",
      "operational-metrics.ts",
      "outbox-delivery.ts",
      "outbox-repair.ts",
      "question-reminders.ts",
      "retention-cleanup.ts",
      "slack-connection-test.ts",
      "slack-message-update.ts",
      "slack-question-delivery.ts",
      "stale-sessions.ts",
      "webhook-delivery.ts",
      "webhook-secret-rotation.ts",
    ]);
    for (const file of taskModules) {
      const source = readFileSync(
        new URL(`./${file}`, import.meta.url),
        "utf8",
      );

      expect(source.match(/^import\b[^;]*;/mu)?.[0], file).toBe(
        'import "./database-surface.js";',
      );
    }
  });

  test("loading the task modules declared worker", async () => {
    const { declaredDatabaseSurface } = await import("@requestport/db");

    expect(declaredDatabaseSurface()).toBe("worker");
  });
});
