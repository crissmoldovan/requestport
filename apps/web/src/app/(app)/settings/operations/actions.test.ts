import {
  type AuthorizedCommandContext,
  DomainError,
  operationsCommandInputSchemas,
  operationsScope,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const operations = vi.hoisted(() => ({
  execute: vi.fn(),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner" as string,
    slug: "example-org",
  },
  session: {
    user: { id: "00000000-0000-4000-8000-0000000000aa" },
    session: { id: "session-under-test" },
  },
  dispatchCommittedOutbox: vi.fn(),
  dispatchImportTask: vi.fn(),
  triggerNotificationDelivery: vi.fn(),
  triggerSlackConnectionTest: vi.fn(),
  triggerSlackMessageUpdate: vi.fn(),
}));

vi.mock("@requestport/config/server", () => ({
  serverEnv: {
    BETTER_AUTH_SECRET: "operations-actions-test-signing-material",
    REQUESTPORT_WORKSPACE_KEK_VERSION: "v1",
  },
}));

// The real package, with no database behind it: the bus below is replaced,
// so nothing here opens a transaction.
vi.mock("@requestport/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCommandTransactionManager: () => ({ run: vi.fn() }),
}));

vi.mock("../../../../lib/observability.js", () => ({
  webMetrics: { count: vi.fn(), gauge: vi.fn(), observe: vi.fn() },
}));

// The real `humanCommandContext` and `humanScopes`: what the forms hand the
// bus is the context a signed-in person really carries. Only the bus is
// replaced.
vi.mock("../../../../lib/server-core-commands.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreCommandBus: { execute: operations.execute },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("../../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: operations.organization,
    session: operations.session,
  }),
}));

vi.mock("../../../../lib/trigger-client.js", () => ({
  dispatchCommittedOutbox: operations.dispatchCommittedOutbox,
  dispatchImportTask: operations.dispatchImportTask,
  triggerNotificationDelivery: operations.triggerNotificationDelivery,
  triggerSlackConnectionTest: operations.triggerSlackConnectionTest,
  triggerSlackMessageUpdate: operations.triggerSlackMessageUpdate,
}));

import { initialOperationsActionState } from "./action-state.js";
import {
  createRetentionHoldAction,
  releaseRetentionHoldAction,
  requeueImportDispatchAction,
  requeueNotificationAction,
  requeueOutboxAction,
  requeueSlackOperationAction,
} from "./actions.js";

/** Every action the module exports, by name. */
const actions = {
  requeueOutboxAction,
  requeueNotificationAction,
  requeueSlackOperationAction,
  requeueImportDispatchAction,
  createRetentionHoldAction,
  releaseRetentionHoldAction,
};

/**
 * Where a rejected retention hold is allowed to land.
 *
 * The hold is the one operations form with visible fields of its own, so §7
 * puts a rejection about the reason on the reason control's error line. A
 * denial is about the operator rather than about any field, so it stays the
 * fixed banner.
 */

const key = "0123456789abcdef0123";
const outboxId = "00000000-0000-4000-8000-0000000000b1";
const eventId = "00000000-0000-4000-8000-0000000000b2";
const notificationIntentId = "00000000-0000-4000-8000-0000000000b3";
const operationId = "00000000-0000-4000-8000-0000000000b4";
const dispatchId = "00000000-0000-4000-8000-0000000000b5";
const holdId = "00000000-0000-4000-8000-0000000000b6";

function holdForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("category", "slack_oauth_state");
  data.set("reason", "Pending legal review");
  data.set("expectedVersion", "0");
  data.set("idempotencyKey", key);
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

beforeEach(() => {
  operations.organization.role = "owner";
  operations.execute.mockReset();
  operations.execute.mockResolvedValue({ id: holdId, version: 1 });
  operations.dispatchCommittedOutbox.mockReset();
  operations.dispatchCommittedOutbox.mockResolvedValue({ accepted: true });
  operations.dispatchImportTask.mockReset();
  operations.dispatchImportTask.mockResolvedValue({ accepted: true });
  operations.triggerNotificationDelivery.mockReset();
  operations.triggerNotificationDelivery.mockResolvedValue(undefined);
  operations.triggerSlackConnectionTest.mockReset();
  operations.triggerSlackConnectionTest.mockResolvedValue(undefined);
  operations.triggerSlackMessageUpdate.mockReset();
  operations.triggerSlackMessageUpdate.mockResolvedValue(undefined);
});

describe("creating a retention hold", () => {
  test("addresses a rejected reason to the reason control", async () => {
    const state = await createRetentionHoldAction(
      initialOperationsActionState,
      holdForm({ reason: "short" }),
    );

    expect(state).toMatchObject({ field: "reason", status: "error" });
    expect(state.message).not.toBe("");
    expect(operations.execute).not.toHaveBeenCalled();
  });

  test("addresses a rejected category to the category control", async () => {
    expect(
      await createRetentionHoldAction(
        initialOperationsActionState,
        holdForm({ category: "everything" }),
      ),
    ).toMatchObject({ field: "category", status: "error" });
    expect(operations.execute).not.toHaveBeenCalled();
  });

  test("keeps a denial in the fixed banner, addressed to no field", async () => {
    operations.organization.role = "member";

    expect(
      await createRetentionHoldAction(initialOperationsActionState, holdForm()),
    ).toEqual({
      message:
        "Only organization owners and admins can manage retention holds.",
      status: "error",
    });
    expect(operations.execute).not.toHaveBeenCalled();
  });

  test("keeps the command's own denial in the same banner", async () => {
    operations.execute.mockRejectedValue(
      new DomainError("forbidden", "Retention hold access is denied"),
    );

    expect(
      await createRetentionHoldAction(initialOperationsActionState, holdForm()),
    ).toEqual({
      message:
        "Only organization owners and admins can manage retention holds.",
      status: "error",
    });
  });

  /*
    The one answer this form gives that it did not before the bus: the bus
    refuses input its secret detector matches (`containsSecretJson`), before
    authorisation and before any write, as `validation_failed` naming no
    field. The form's schema has already passed by then, and the reason is
    the form's only free text, so the refusal is the reason's.
  */
  test("addresses the bus's secret-material refusal to the reason control", async () => {
    operations.execute.mockRejectedValue(
      new DomainError(
        "validation_failed",
        "Command input contains prohibited secret material",
      ),
    );

    expect(
      await createRetentionHoldAction(
        initialOperationsActionState,
        holdForm({ reason: "Keep for audit, password: hunter2hunter2" }),
      ),
    ).toEqual({
      field: "reason",
      message:
        "Remove passwords, tokens and other secrets from the reason, then try again.",
      status: "error",
    });
  });

  test("keeps a bus refusal that names a field it does not draw in the banner", async () => {
    operations.execute.mockRejectedValue(
      new DomainError("validation_failed", "Command input is invalid", {
        field: "organizationId",
      }),
    );

    expect(
      await createRetentionHoldAction(initialOperationsActionState, holdForm()),
    ).toEqual({
      message: "The retention hold could not be created.",
      status: "error",
    });
  });

  test("confirms an accepted hold without naming any field", async () => {
    expect(
      await createRetentionHoldAction(initialOperationsActionState, holdForm()),
    ).toEqual({ message: "Retention hold created.", status: "success" });
    expect(operations.execute).toHaveBeenCalledOnce();
  });
});

/*
  Plan 13, F.2.4: each operations form reaches the command the transport will
  reach — one command on the tenant bus per form, by name, with the signed-in
  person's command context, the organisation from the session, the row from
  the form, and the version and key as the bus's meta. A requeue then starts
  its task from what the command answered, after the command has committed.
*/
type ActionName = keyof typeof actions;

const cases: Array<{
  action: ActionName;
  command: keyof typeof operationsCommandInputSchemas;
  form: Record<string, string>;
  input: Record<string, unknown>;
  expectedVersion: number;
  answer: Record<string, unknown>;
  message: string;
  dispatched?: { spy: keyof typeof operations; with: unknown[] };
}> = [
  {
    action: "requeueOutboxAction",
    command: "requeue_outbox",
    form: { outboxId, expectedVersion: "5" },
    input: { outboxId },
    expectedVersion: 5,
    answer: { outboxId, eventId },
    message: "Outbox event requeued and accepted by the dispatcher.",
    // Dispatched bound to the organisation it was requeued in (D5).
    dispatched: {
      spy: "dispatchCommittedOutbox",
      with: [outboxId, operations.organization.id],
    },
  },
  {
    action: "requeueNotificationAction",
    command: "requeue_notification",
    form: { notificationIntentId, channel: "slack", expectedVersion: "3" },
    input: { notificationIntentId },
    expectedVersion: 3,
    answer: { notificationIntentId },
    message: "Notification requeued and accepted for delivery.",
    dispatched: {
      spy: "triggerNotificationDelivery",
      with: [notificationIntentId, "slack"],
    },
  },
  {
    action: "requeueSlackOperationAction",
    command: "requeue_slack_operation",
    form: {
      operationId,
      operationType: "message_update",
      expectedVersion: "4",
    },
    input: { operationId },
    expectedVersion: 4,
    answer: { operationId, operationType: "connection_test" },
    message: "Slack operation requeued and accepted for delivery.",
    // The row's own type, as the command answered it, not the form's.
    dispatched: { spy: "triggerSlackConnectionTest", with: [operationId] },
  },
  {
    action: "requeueImportDispatchAction",
    command: "requeue_import_dispatch",
    form: { dispatchId, expectedVersion: "6" },
    input: { dispatchId },
    expectedVersion: 6,
    answer: { dispatchId },
    message: "Import task requeued and accepted by the dispatcher.",
    // Dispatched bound to the organisation it was requeued in (D5).
    dispatched: {
      spy: "dispatchImportTask",
      with: [dispatchId, operations.organization.id],
    },
  },
  {
    action: "createRetentionHoldAction",
    command: "create_retention_hold",
    form: {
      category: "all",
      reason: "  Pending legal review ",
      expectedVersion: "0",
    },
    input: { category: "all", reason: "Pending legal review" },
    expectedVersion: 0,
    answer: { id: holdId, version: 1 },
    message: "Retention hold created.",
  },
  {
    action: "releaseRetentionHoldAction",
    command: "release_retention_hold",
    form: { holdId, expectedVersion: "1" },
    input: { holdId },
    expectedVersion: 1,
    answer: { id: holdId, version: 2 },
    message: "Retention hold released.",
  },
];

function form(fields: Record<string, string>) {
  const data = new FormData();
  data.set("idempotencyKey", ` ${key} `);
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe("each operations form reaches its operations command", () => {
  test("the six forms name the six commands, each once", () => {
    expect(cases.map((entry) => entry.command).sort()).toEqual(
      Object.keys(operationsCommandInputSchemas).sort(),
    );
    expect(new Set(cases.map((entry) => entry.action)).size).toBe(6);
    expect(Object.keys(actions).sort()).toEqual(
      cases.map((entry) => entry.action).sort(),
    );
  });

  test.each(cases.map((entry) => [entry.action, entry] as const))(
    "%s dispatches its command on the tenant bus, as the signed-in person",
    async (_, entry) => {
      operations.execute.mockResolvedValue(entry.answer);
      const state = await actions[entry.action](
        initialOperationsActionState,
        form(entry.form),
      );

      expect(state).toEqual({ status: "success", message: entry.message });
      expect(operations.execute).toHaveBeenCalledOnce();
      expect(operations.execute).toHaveBeenCalledWith({
        name: entry.command,
        context: expect.objectContaining({
          actor: { type: "user", id: operations.session.user.id },
          organizationId: operations.organization.id,
          credentialId: operations.session.session.id,
        }),
        input: { organizationId: operations.organization.id, ...entry.input },
        meta: { expectedVersion: entry.expectedVersion, idempotencyKey: key },
      });
      // The scope the command requires is one a signed-in person holds.
      const [{ context }] = operations.execute.mock.calls[0] as [
        { context: AuthorizedCommandContext },
      ];
      expect(context.scopes.has(operationsScope)).toBe(true);
      if (entry.dispatched) {
        const spy = operations[entry.dispatched.spy] as ReturnType<
          typeof vi.fn
        >;
        expect(spy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledWith(...entry.dispatched.with);
        expect(spy.mock.invocationCallOrder[0]).toBeGreaterThan(
          operations.execute.mock.invocationCallOrder[0] ?? Infinity,
        );
      }
    },
  );

  test.each(cases.map((entry) => [entry.action, entry] as const))(
    "%s refuses a session role below admin before it runs anything",
    async (_, entry) => {
      operations.organization.role = "member";
      const state = await actions[entry.action](
        initialOperationsActionState,
        form(entry.form),
      );

      expect(state.status).toBe("error");
      expect(operations.execute).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["requeueOutboxAction", "dispatchCommittedOutbox", { accepted: false }],
    ["requeueImportDispatchAction", "dispatchImportTask", { accepted: false }],
    ["requeueNotificationAction", "triggerNotificationDelivery", "throws"],
    ["requeueSlackOperationAction", "triggerSlackConnectionTest", "throws"],
  ] as const)(
    "%s leaves a task the dispatcher did not take to the repair sweep",
    async (action, spy, outcome) => {
      const entry = cases.find((candidate) => candidate.action === action);
      if (!entry) throw new Error(action);
      operations.execute.mockResolvedValue(entry.answer);
      const dispatch = operations[spy] as ReturnType<typeof vi.fn>;
      if (outcome === "throws")
        dispatch.mockRejectedValue(new Error("trigger unavailable"));
      else dispatch.mockResolvedValue(outcome);

      const state = await actions[action](
        initialOperationsActionState,
        form(entry.form),
      );
      expect(state.status).toBe("success");
      expect(state.message).toMatch(/the repair sweep will retry it\.$/u);
    },
  );

  test.each([
    [
      "requeueNotificationAction",
      "version_conflict",
      "That notification changed. Refresh and try again.",
    ],
    [
      "requeueSlackOperationAction",
      "invalid_state",
      "Only failed Slack operations can be requeued.",
    ],
    [
      "requeueImportDispatchAction",
      "not_found",
      "That import task is no longer available.",
    ],
    [
      "requeueOutboxAction",
      "forbidden",
      "Only organization owners and admins can operate delivery recovery.",
    ],
    [
      "releaseRetentionHoldAction",
      "version_conflict",
      "The retention hold could not be released.",
    ],
  ] as const)(
    "%s answers the command's %s as it always did",
    async (action, code, message) => {
      const entry = cases.find((candidate) => candidate.action === action);
      if (!entry) throw new Error(action);
      operations.execute.mockRejectedValue(new DomainError(code, "refused"));

      expect(
        await actions[action](initialOperationsActionState, form(entry.form)),
      ).toEqual({ status: "error", message });
      for (const spy of [
        operations.dispatchCommittedOutbox,
        operations.dispatchImportTask,
        operations.triggerNotificationDelivery,
        operations.triggerSlackConnectionTest,
        operations.triggerSlackMessageUpdate,
      ])
        expect(spy).not.toHaveBeenCalled();
    },
  );
});
