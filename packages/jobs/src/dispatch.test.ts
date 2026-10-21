import { beforeEach, describe, expect, test, vi } from "vitest";

import { createJobDispatch, JobDeferredToWorkerError } from "./dispatch.js";
import type { JobRunnerKind } from "./selection.js";

let kind: JobRunnerKind = "trigger";
let runs = 0;
const startTriggerTask = vi.fn(async () => {
  runs += 1;
  return { id: `run_${runs}` };
});
// An acceptance holds unless a case says otherwise: markAccepted by id
// answers whether it did (false once the claim's lease has run out).
const outboxRepository = {
  claimOne: vi.fn(),
  markAccepted: vi.fn(
    async (_id: string, _owner: string, _runId: string) => true,
  ),
};
const importTaskDispatchRepository = {
  claimOne: vi.fn(),
  markAccepted: vi.fn(
    async (_id: string, _owner: string, _runId: string) => true,
  ),
};
const logger = { info: vi.fn(), warn: vi.fn() };

const dispatch = createJobDispatch({
  kind: () => kind,
  startTriggerTask,
  outboxRepository,
  importTaskDispatchRepository,
  logger,
});

beforeEach(() => {
  vi.clearAllMocks();
  kind = "trigger";
  runs = 0;
  outboxRepository.markAccepted.mockResolvedValue(true);
  importTaskDispatchRepository.markAccepted.mockResolvedValue(true);
});

describe("dispatch from the web application, with Trigger.dev selected (production)", () => {
  test("claims a committed outbox row, starts outbox-delivery keyed by its attempt, and records the run", async () => {
    outboxRepository.claimOne.mockResolvedValue({
      id: "outbox-1",
      eventId: "event-1",
      attemptCount: 2,
    });

    await expect(dispatch.dispatchCommittedOutbox("outbox-1")).resolves.toEqual(
      { accepted: true, runId: "run_1" },
    );

    const [[outboxId, owner]] = outboxRepository.claimOne.mock.calls as [
      [string, string],
    ];
    expect(outboxId).toBe("outbox-1");
    expect(owner).toMatch(/^web:[0-9a-f-]{36}$/u);
    expect(startTriggerTask).toHaveBeenCalledWith(
      "outbox-delivery",
      { outboxId: "outbox-1" },
      { idempotencyKey: "outbox:outbox-1:2" },
    );
    expect(outboxRepository.markAccepted).toHaveBeenCalledWith(
      "outbox-1",
      owner,
      "run_1",
    );
    expect(logger.info).toHaveBeenCalledWith("outbox.accepted", {
      outboxId: "outbox-1",
      runId: "run_1",
      status: "accepted",
    });
  });

  test("answers not accepted when another dispatcher holds the row", async () => {
    outboxRepository.claimOne.mockResolvedValue(null);

    await expect(dispatch.dispatchCommittedOutbox("outbox-2")).resolves.toEqual(
      { accepted: false },
    );
    expect(startTriggerTask).not.toHaveBeenCalled();
  });

  test("answers not accepted, and leaves the lease to expire, when Trigger.dev refuses", async () => {
    outboxRepository.claimOne.mockResolvedValue({
      id: "outbox-3",
      eventId: "event-3",
      attemptCount: 1,
    });
    startTriggerTask.mockRejectedValueOnce(new Error("unauthorised"));

    await expect(dispatch.dispatchCommittedOutbox("outbox-3")).resolves.toEqual(
      { accepted: false },
    );
    expect(outboxRepository.markAccepted).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("outbox.dispatch_failed", {
      outboxId: "outbox-3",
      status: "failed",
      errorCode: "trigger_dispatch_failed",
    });
  });

  test.each([
    ["analyze", "legacy-import-analyze"],
    ["apply", "legacy-import-apply"],
  ] as const)(
    "claims an import dispatch and starts the %s task keyed by its attempt",
    async (taskKind, taskId) => {
      importTaskDispatchRepository.claimOne.mockResolvedValue({
        id: "dispatch-1",
        taskKind,
        taskPayload: {},
        attemptCount: 3,
      });

      await expect(dispatch.dispatchImportTask("dispatch-1")).resolves.toEqual({
        accepted: true,
        runId: "run_1",
      });

      const [[dispatchId, owner]] = importTaskDispatchRepository.claimOne.mock
        .calls as [[string, string]];
      expect(dispatchId).toBe("dispatch-1");
      expect(owner).toMatch(/^web-import:[0-9a-f-]{36}$/u);
      expect(startTriggerTask).toHaveBeenCalledWith(
        taskId,
        { dispatchId: "dispatch-1", attemptCount: 3 },
        { idempotencyKey: "import-dispatch:dispatch-1:3" },
      );
      expect(importTaskDispatchRepository.markAccepted).toHaveBeenCalledWith(
        "dispatch-1",
        owner,
        "run_1",
      );
      expect(logger.info).toHaveBeenCalledWith("import.dispatch_accepted", {
        dispatchId: "dispatch-1",
        runId: "run_1",
        status: "accepted",
        taskKind,
      });
    },
  );

  test("answers not accepted, and says so, when the outbox row's acceptance is refused", async () => {
    outboxRepository.claimOne.mockResolvedValue({
      id: "outbox-4",
      eventId: "event-4",
      attemptCount: 1,
    });
    // The claim's lease ran out before the acceptance (manifest-i2.md §5.1):
    // the run cannot settle the row, which is claimed again when due.
    outboxRepository.markAccepted.mockResolvedValue(false);

    await expect(dispatch.dispatchCommittedOutbox("outbox-4")).resolves.toEqual(
      { accepted: false },
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      "outbox.accepted",
      expect.anything(),
    );
    expect(logger.warn).toHaveBeenCalledWith("outbox.acceptance_refused", {
      outboxId: "outbox-4",
      runId: "run_1",
      status: "lease_expired",
    });
  });

  test("answers not accepted, and says so, when the import dispatch's acceptance is refused", async () => {
    importTaskDispatchRepository.claimOne.mockResolvedValue({
      id: "dispatch-3",
      taskKind: "analyze",
      taskPayload: {},
      attemptCount: 1,
    });
    importTaskDispatchRepository.markAccepted.mockResolvedValue(false);

    await expect(dispatch.dispatchImportTask("dispatch-3")).resolves.toEqual({
      accepted: false,
    });
    expect(logger.info).not.toHaveBeenCalledWith(
      "import.dispatch_accepted",
      expect.anything(),
    );
    expect(logger.warn).toHaveBeenCalledWith("import.acceptance_refused", {
      dispatchId: "dispatch-3",
      runId: "run_1",
      status: "lease_expired",
      taskKind: "analyze",
    });
  });

  test("logs a refused import dispatch and answers not accepted", async () => {
    importTaskDispatchRepository.claimOne.mockResolvedValue({
      id: "dispatch-2",
      taskKind: "apply",
      taskPayload: {},
      attemptCount: 1,
    });
    startTriggerTask.mockRejectedValueOnce(new Error("down"));

    await expect(dispatch.dispatchImportTask("dispatch-2")).resolves.toEqual({
      accepted: false,
    });
    expect(logger.warn).toHaveBeenCalledWith("import.dispatch_failed", {
      dispatchId: "dispatch-2",
      status: "failed",
      taskKind: "apply",
      errorCode: "trigger_dispatch_failed",
    });
  });

  test("starts webhook, Slack and notification runs unkeyed, and lets a refusal throw", async () => {
    await dispatch.triggerWebhookDelivery("delivery-1");
    await dispatch.triggerSlackMessageUpdate("operation-1");
    await dispatch.triggerSlackConnectionTest("operation-2");
    await dispatch.triggerNotificationDelivery("intent-1", "email");
    await dispatch.triggerNotificationDelivery("intent-2", "slack");

    expect(startTriggerTask.mock.calls).toEqual([
      ["webhook-delivery", { deliveryId: "delivery-1" }],
      ["slack-message-update", { operationId: "operation-1" }],
      ["slack-connection-test", { operationId: "operation-2" }],
      ["email-delivery", { intentId: "intent-1" }],
      ["slack-question-delivery", { intentId: "intent-2" }],
    ]);

    startTriggerTask.mockRejectedValueOnce(new Error("down"));
    await expect(
      dispatch.triggerWebhookDelivery("delivery-2"),
    ).rejects.toThrowError("down");
  });
});

describe("dispatch from the web application, with the Postgres worker selected", () => {
  beforeEach(() => {
    kind = "postgres";
  });

  test("leaves a committed outbox row pending for the worker's poller, without claiming it", async () => {
    await expect(dispatch.dispatchCommittedOutbox("outbox-9")).resolves.toEqual(
      { accepted: false },
    );
    // A claim here would lease the row to a web request that will never
    // deliver it, and hide it from the worker for the lease's minute.
    expect(outboxRepository.claimOne).not.toHaveBeenCalled();
    expect(startTriggerTask).not.toHaveBeenCalled();
  });

  test("leaves an import dispatch pending for the worker, without claiming it", async () => {
    await expect(dispatch.dispatchImportTask("dispatch-9")).resolves.toEqual({
      accepted: false,
    });
    expect(importTaskDispatchRepository.claimOne).not.toHaveBeenCalled();
  });

  test.each([
    ["triggerWebhookDelivery", () => dispatch.triggerWebhookDelivery("d")],
    [
      "triggerSlackMessageUpdate",
      () => dispatch.triggerSlackMessageUpdate("o"),
    ],
    [
      "triggerSlackConnectionTest",
      () => dispatch.triggerSlackConnectionTest("o"),
    ],
    [
      "triggerNotificationDelivery",
      () => dispatch.triggerNotificationDelivery("i", "email"),
    ],
  ])(
    "%s defers to the worker's repair schedule, the path every caller already takes when a start fails",
    async (_name, start) => {
      // Every caller catches a failed start and relies on the committed row,
      // which under the Postgres worker a repair schedule picks up.
      await expect(start()).rejects.toBeInstanceOf(JobDeferredToWorkerError);
      expect(startTriggerTask).not.toHaveBeenCalled();
    },
  );
});

describe("dispatch with a mistyped runner", () => {
  test("refuses before touching the outbox", async () => {
    const broken = createJobDispatch({
      kind: () => {
        throw new Error(
          'REQUESTPORT_JOB_RUNNER must be "trigger" or "postgres"',
        );
      },
      startTriggerTask,
      outboxRepository,
      importTaskDispatchRepository,
      logger,
    });

    await expect(
      broken.dispatchCommittedOutbox("outbox-1"),
    ).rejects.toThrowError(/REQUESTPORT_JOB_RUNNER/u);
    expect(outboxRepository.claimOne).not.toHaveBeenCalled();
  });
});
