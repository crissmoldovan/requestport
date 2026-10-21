import { JobDeferredToWorkerError } from "@requestport/jobs/dispatch";
import { beforeEach, describe, expect, test } from "vitest";

import { type CommittedRows, createBackgroundPort } from "./background.js";
import type { RequestPortBackground } from "./options.js";

/*
 * The background port (manifest-g.md §2.4). `trigger` is the dispatch the web
 * runs today against Trigger.dev, with the same claims, owners, task ids,
 * idempotency keys, acceptances and log lines, each committed row read and
 * claimed through repositories built for its organisation (D5). `none` is
 * the dispatch the web runs while the Postgres worker is selected: the rows
 * stay committed, nothing is claimed, and a direct start is refused.
 */

const recorded = {
  bound: [] as Array<[string, string]>,
  calls: [] as string[],
  started: [] as Array<[string, unknown, unknown]>,
  logged: [] as Array<[string, string, unknown]>,
};

const committedRows: CommittedRows = {
  outbox(organizationId) {
    recorded.bound.push(["outbox", organizationId]);
    return {
      idsForEvents: async (eventIds) => {
        recorded.calls.push(`outbox.idsForEvents ${eventIds.join(",")}`);
        return eventIds.map((id) => ({ id: `outbox-of-${id}` }));
      },
      idsForCorrelation: async (correlationId) => {
        recorded.calls.push(`outbox.idsForCorrelation ${correlationId}`);
        return [{ id: `outbox-of-${correlationId}` }];
      },
      claimOne: async (id, owner) => {
        recorded.calls.push(`outbox.claimOne ${id} ${owner}`);
        return { id, eventId: "event-1", attemptCount: 3 } as never;
      },
      markAccepted: async (id, _owner, runId) => {
        recorded.calls.push(`outbox.markAccepted ${id} ${runId}`);
        return true;
      },
    };
  },
  importTaskDispatches(organizationId) {
    recorded.bound.push(["import", organizationId]);
    return {
      claimOne: async (id, owner) => {
        recorded.calls.push(`import.claimOne ${id} ${owner}`);
        return {
          id,
          taskKind: id.includes("apply") ? "apply" : "analyze",
          taskPayload: {},
          attemptCount: 2,
        } as never;
      },
      markAccepted: async (id, _owner, runId) => {
        recorded.calls.push(`import.markAccepted ${id} ${runId}`);
        return true;
      },
    };
  },
};

const logger = {
  info: (event: string, fields: unknown) =>
    recorded.logged.push(["info", event, fields]),
  warn: (event: string, fields: unknown) =>
    recorded.logged.push(["warn", event, fields]),
};

const trigger: RequestPortBackground = {
  kind: "trigger",
  startTask: async (taskId, payload, options) => {
    recorded.started.push([taskId, payload, options]);
    return { id: `run_${recorded.started.length}` };
  },
};

beforeEach(() => {
  recorded.bound.length = 0;
  recorded.calls.length = 0;
  recorded.started.length = 0;
  recorded.logged.length = 0;
});

/** The owners a claim was made with, the random part replaced. */
const owners = () =>
  recorded.calls.map((call) =>
    call.replace(
      /(web(?:-import)?):[0-9a-f-]{36}$/u,
      (_match, prefix: string) => `${prefix}:<uuid>`,
    ),
  );

describe("the background port, on trigger", () => {
  const port = () =>
    createBackgroundPort({ background: trigger, committedRows, logger });

  test("claims a committed outbox row as web:<uuid>, starts outbox-delivery under its attempt's key, and accepts the run, bound to the organisation", async () => {
    await expect(
      port().dispatchCommittedOutbox("outbox-1", "org-a"),
    ).resolves.toEqual({ accepted: true, runId: "run_1" });

    expect(recorded.bound).toEqual([
      ["outbox", "org-a"],
      ["import", "org-a"],
    ]);
    expect(owners()).toEqual([
      "outbox.claimOne outbox-1 web:<uuid>",
      "outbox.markAccepted outbox-1 run_1",
    ]);
    expect(recorded.started).toEqual([
      [
        "outbox-delivery",
        { outboxId: "outbox-1" },
        { idempotencyKey: "outbox:outbox-1:3" },
      ],
    ]);
    expect(recorded.logged).toEqual([
      [
        "info",
        "outbox.accepted",
        { outboxId: "outbox-1", runId: "run_1", status: "accepted" },
      ],
    ]);
  });

  test.each([
    ["dispatch-analyze", "legacy-import-analyze", "analyze"],
    ["dispatch-apply", "legacy-import-apply", "apply"],
  ])(
    "claims an import dispatch, %s, as web-import:<uuid>, starts %s under its attempt's key, and accepts the run",
    async (dispatchId, task, taskKind) => {
      await expect(
        port().dispatchImportTask(dispatchId, "org-b"),
      ).resolves.toEqual({ accepted: true, runId: "run_1" });

      expect(recorded.bound).toEqual([
        ["outbox", "org-b"],
        ["import", "org-b"],
      ]);
      expect(owners()).toEqual([
        `import.claimOne ${dispatchId} web-import:<uuid>`,
        `import.markAccepted ${dispatchId} run_1`,
      ]);
      expect(recorded.started).toEqual([
        [
          task,
          { dispatchId, attemptCount: 2 },
          { idempotencyKey: `import-dispatch:${dispatchId}:2` },
        ],
      ]);
      expect(recorded.logged).toEqual([
        [
          "info",
          "import.dispatch_accepted",
          { dispatchId, runId: "run_1", status: "accepted", taskKind },
        ],
      ]);
    },
  );

  test("dispatches a command's events by organisation: each organisation's rows read and claimed bound to it", async () => {
    await port().dispatchCommittedEvents([
      { id: "event-a1", organizationId: "org-a" },
      { id: "event-b1", organizationId: "org-b" },
      { id: "event-a2", organizationId: "org-a" },
    ]);

    expect(recorded.bound).toEqual([
      ["outbox", "org-a"],
      ["outbox", "org-a"],
      ["import", "org-a"],
      ["outbox", "org-a"],
      ["import", "org-a"],
      ["outbox", "org-b"],
      ["outbox", "org-b"],
      ["import", "org-b"],
    ]);
    expect(owners().filter((call) => !call.includes("markAccepted"))).toEqual([
      "outbox.idsForEvents event-a1,event-a2",
      "outbox.claimOne outbox-of-event-a1 web:<uuid>",
      "outbox.claimOne outbox-of-event-a2 web:<uuid>",
      "outbox.idsForEvents event-b1",
      "outbox.claimOne outbox-of-event-b1 web:<uuid>",
    ]);
  });

  test("reads nothing for no events", async () => {
    await port().dispatchCommittedEvents([]);

    expect(recorded.bound).toEqual([]);
    expect(recorded.calls).toEqual([]);
  });

  test("swallows a failed start, logging it, because the row stays committed for the repair sweep", async () => {
    const failing = createBackgroundPort({
      background: {
        kind: "trigger",
        startTask: () => Promise.reject(new Error("Trigger.dev is down")),
      },
      committedRows,
      logger,
    });

    await expect(
      failing.dispatchCommittedEvents([
        { id: "event-1", organizationId: "org-a" },
      ]),
    ).resolves.toBeUndefined();
    expect(recorded.logged).toEqual([
      [
        "warn",
        "outbox.dispatch_failed",
        {
          outboxId: "outbox-of-event-1",
          status: "failed",
          errorCode: "trigger_dispatch_failed",
        },
      ],
    ]);
  });

  test("does not swallow a failed read", async () => {
    const unreadable = createBackgroundPort({
      background: trigger,
      committedRows: {
        ...committedRows,
        outbox: (organizationId) => ({
          ...committedRows.outbox(organizationId),
          idsForEvents: () => Promise.reject(new Error("read failed")),
        }),
      },
      logger,
    });

    await expect(
      unreadable.dispatchCommittedEvents([
        { id: "event-1", organizationId: "org-a" },
      ]),
    ).rejects.toThrow("read failed");
  });

  test("dispatches a correlation's rows bound to the organisation given", async () => {
    await port().dispatchCommittedCorrelation("correlation-1", "org-c");

    expect(
      recorded.bound.every(([, organization]) => organization === "org-c"),
    ).toBe(true);
    expect(owners()).toEqual([
      "outbox.idsForCorrelation correlation-1",
      "outbox.claimOne outbox-of-correlation-1 web:<uuid>",
      "outbox.markAccepted outbox-of-correlation-1 run_1",
    ]);
  });

  test.each([
    [
      "a webhook delivery",
      (background: ReturnType<typeof port>) =>
        background.triggerWebhookDelivery("delivery-1"),
      ["webhook-delivery", { deliveryId: "delivery-1" }],
    ],
    [
      "an email notification",
      (background: ReturnType<typeof port>) =>
        background.triggerNotificationDelivery("intent-1", "email"),
      ["email-delivery", { intentId: "intent-1" }],
    ],
    [
      "a Slack notification",
      (background: ReturnType<typeof port>) =>
        background.triggerNotificationDelivery("intent-2", "slack"),
      ["slack-question-delivery", { intentId: "intent-2" }],
    ],
    [
      "a Slack connection test",
      (background: ReturnType<typeof port>) =>
        background.triggerSlackConnectionTest("operation-1"),
      ["slack-connection-test", { operationId: "operation-1" }],
    ],
    [
      "a Slack message update",
      (background: ReturnType<typeof port>) =>
        background.triggerSlackMessageUpdate("operation-2"),
      ["slack-message-update", { operationId: "operation-2" }],
    ],
  ])(
    "starts %s directly, unkeyed, reading no committed row",
    async (_, start, [task, payload]) => {
      await expect(start(port())).resolves.toEqual({ id: "run_1" });

      expect(recorded.started).toEqual([[task, payload, undefined]]);
      expect(recorded.bound).toEqual([]);
      expect(recorded.calls).toEqual([]);
    },
  );
});

describe("the background port, on none", () => {
  const port = () =>
    createBackgroundPort({
      background: { kind: "none" },
      committedRows,
      logger,
    });

  test("claims no committed row: a command's rows are read and left committed", async () => {
    await port().dispatchCommittedEvents([
      { id: "event-1", organizationId: "org-a" },
    ]);

    expect(recorded.calls).toEqual(["outbox.idsForEvents event-1"]);
    expect(recorded.started).toEqual([]);
    expect(recorded.logged).toEqual([]);
  });

  test.each([
    [
      "an outbox row",
      (background: ReturnType<typeof port>) =>
        background.dispatchCommittedOutbox("outbox-1", "org-a"),
    ],
    [
      "an import dispatch",
      (background: ReturnType<typeof port>) =>
        background.dispatchImportTask("dispatch-1", "org-a"),
    ],
  ])("answers %s as not accepted, and claims nothing", async (_, dispatch) => {
    await expect(dispatch(port())).resolves.toEqual({ accepted: false });

    expect(recorded.calls).toEqual([]);
    expect(recorded.started).toEqual([]);
  });

  test.each([
    [
      "webhook-delivery",
      (background: ReturnType<typeof port>) =>
        background.triggerWebhookDelivery("delivery-1"),
    ],
    [
      "email-delivery",
      (background: ReturnType<typeof port>) =>
        background.triggerNotificationDelivery("intent-1", "email"),
    ],
    [
      "slack-question-delivery",
      (background: ReturnType<typeof port>) =>
        background.triggerNotificationDelivery("intent-1", "slack"),
    ],
    [
      "slack-connection-test",
      (background: ReturnType<typeof port>) =>
        background.triggerSlackConnectionTest("operation-1"),
    ],
    [
      "slack-message-update",
      (background: ReturnType<typeof port>) =>
        background.triggerSlackMessageUpdate("operation-1"),
    ],
  ])(
    "refuses a direct start of %s with JobDeferredToWorkerError",
    async (job, start) => {
      const refusal = await start(port()).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(JobDeferredToWorkerError);
      expect(refusal).toMatchObject({ code: "job_deferred_to_worker", job });
      expect(recorded.started).toEqual([]);
    },
  );
});

describe("the background port, chosen per dispatch", () => {
  test("asks the function once for each dispatch, and follows each answer", async () => {
    const answers: RequestPortBackground[] = [trigger, { kind: "none" }];
    let asked = 0;
    const port = createBackgroundPort({
      background: () => {
        const answer = answers[asked] ?? { kind: "none" };
        asked += 1;
        return answer;
      },
      committedRows,
      logger,
    });

    await expect(
      port.dispatchCommittedOutbox("outbox-1", "org-a"),
    ).resolves.toEqual({ accepted: true, runId: "run_1" });
    expect(asked).toBe(1);
    await expect(
      port.dispatchCommittedOutbox("outbox-2", "org-a"),
    ).resolves.toEqual({ accepted: false });
    expect(asked).toBe(2);
    expect(recorded.started).toHaveLength(1);
  });

  test("asks nothing when it is built", () => {
    let asked = 0;
    createBackgroundPort({
      background: () => {
        asked += 1;
        return trigger;
      },
      committedRows,
      logger,
    });

    expect(asked).toBe(0);
    expect(recorded.bound).toEqual([]);
  });
});
