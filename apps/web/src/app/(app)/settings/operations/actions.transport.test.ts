import {
  operationsCommandInputSchemas,
  operatorActor,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  agentContext,
  ids,
  restClient,
  signInAs,
} from "../../../../test/api-v1/agent-client.js";
import {
  apiV1,
  resetApiV1Fakes,
} from "../../../../test/api-v1/fake-database.js";

/*
  Plan 13, F.2.4's registry half: the operations forms and `/api/v1` reach
  the same handler. Both run here for real — the form's action, the REST
  route, the real `server-core-commands.ts` bus and
  `createCoreCommandRegistry()` — over B1's faked `@requestport/db`, so each
  ends at the same port method, which records what it was handed. The form
  arrives as the signed-in person; REST as an operator credential, whose
  issuing member the port is asked about, and whose own actor the write
  records.

  What the fake cannot show — the role rule, the attempt count and version
  checks, the credential's re-check against its row, the audit and event
  actors — is proven on PostgreSQL in
  `packages/db/src/repositories/operations-repository.integration.test.ts`,
  `retention-hold-repository.integration.test.ts` and
  `queries/administration/operations-reads.integration.test.ts`.

  Each read's one transaction is bound to the credential's organisation
  before its first statement (`withAdministrationReadTransaction`;
  manifest-i2.md §4 Owns, ruling 50). The fake records the organisation each
  was bound to, as `server-administration-reads.test.ts` reads it; that the
  helper binds, and what a binding admits, is held in `packages/db`
  (`tenant-context.test.ts`, `row-security.integration.test.ts`).
*/

vi.mock(
  "@requestport/db",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeDatabaseModule,
);
vi.mock(
  "@requestport/auth/server",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeAuthServerModule,
);
vi.mock(
  "@requestport/config/server",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeServerConfigModule,
);
vi.mock(
  "../../../../lib/observability.js",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeObservabilityModule,
);
/*
  The forms start their task after the commit; REST starts none (ruling 7:
  the scheduled repair runs claim the requeued row). B1's fake Trigger.dev
  module carries `dispatchCommittedEvents`, which the bus calls after a
  commit that appended events; the forms' five dispatchers, the outbox
  form's `dispatchCommittedOutbox` among them, are recorded here, so a case
  can show which path started a task.
*/
const dispatched = vi.hoisted(() => ({
  committedOutbox: vi.fn(async () => ({ accepted: false })),
  importTask: vi.fn(async () => ({ accepted: true })),
  notification: vi.fn(async () => undefined),
  slackConnectionTest: vi.fn(async () => undefined),
  slackMessageUpdate: vi.fn(async () => undefined),
}));
vi.mock("../../../../lib/trigger-client.js", async () => ({
  ...(await import("../../../../test/api-v1/fake-database.js"))
    .fakeTriggerClientModule,
  dispatchCommittedOutbox: dispatched.committedOutbox,
  dispatchImportTask: dispatched.importTask,
  triggerNotificationDelivery: dispatched.notification,
  triggerSlackConnectionTest: dispatched.slackConnectionTest,
  triggerSlackMessageUpdate: dispatched.slackMessageUpdate,
}));
// The web root runs, and the web's RequestPort is composed over the storage
// the wiring answers here (`server-web-request-port.ts`): the routes, the
// handlers and the rate limiter reach the faked package through it (Plan 13,
// G.3, G.6; ruling 140).
vi.mock(
  "@requestport/db/wiring",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js")).fakeWiringModule,
);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const session = vi.hoisted(() => ({
  user: { id: "user_f24_person" },
  session: { id: "session_f24" },
}));
vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: {
      id: "018f0000-0000-7000-8000-00000000b101",
      name: "B1",
      role: "owner",
      slug: "b1",
    },
    session,
  }),
}));

const route = await import("../../../api/v1/[[...path]]/route.js");
const actions = await import("./actions.js");
const { initialOperationsActionState } = await import("./action-state.js");
const api = restClient(route);

const rowId = "018f0000-0000-7000-8000-0000000f2411";
const eventId = "018f0000-0000-7000-8000-0000000f2412";
const projectId = "018f0000-0000-7000-8000-0000000f2413";
const lineageId = "018f0000-0000-7000-8000-0000000f2414";
const credentialId = "018f0000-0000-7000-8000-0000000f2415";
const memberUserId = "user_f24_operator_member";

type CommandName = keyof typeof operationsCommandInputSchemas;

/**
 * Each command, its form action, its port and method, one valid input, the
 * form's extra fields, and what the port answers.
 */
const cases: Array<{
  command: CommandName;
  action: keyof typeof actions;
  port: "operationsCommands" | "retentionHoldCommands";
  method: string;
  fields: Record<string, unknown>;
  form: Record<string, string>;
  answer: Record<string, unknown>;
}> = [
  {
    command: "requeue_outbox",
    action: "requeueOutboxAction",
    port: "operationsCommands",
    method: "requeueOutbox",
    fields: { outboxId: rowId },
    form: { outboxId: rowId },
    answer: { outboxId: rowId, eventId },
  },
  {
    command: "requeue_notification",
    action: "requeueNotificationAction",
    port: "operationsCommands",
    method: "requeueNotification",
    fields: { notificationIntentId: rowId },
    form: { notificationIntentId: rowId, channel: "email" },
    answer: { notificationIntentId: rowId },
  },
  {
    command: "requeue_slack_operation",
    action: "requeueSlackOperationAction",
    port: "operationsCommands",
    method: "requeueSlackOperation",
    fields: { operationId: rowId },
    form: { operationId: rowId, operationType: "message_update" },
    answer: { operationId: rowId, operationType: "message_update" },
  },
  {
    command: "requeue_import_dispatch",
    action: "requeueImportDispatchAction",
    port: "operationsCommands",
    method: "requeueImportDispatch",
    fields: { dispatchId: rowId },
    form: { dispatchId: rowId },
    answer: { dispatchId: rowId },
  },
  {
    command: "create_retention_hold",
    action: "createRetentionHoldAction",
    port: "retentionHoldCommands",
    method: "create",
    fields: { category: "all", reason: "Pending legal review" },
    form: { category: "all", reason: "Pending legal review" },
    answer: { id: rowId, version: 1 },
  },
  {
    command: "release_retention_hold",
    action: "releaseRetentionHoldAction",
    port: "retentionHoldCommands",
    method: "release",
    fields: { holdId: rowId },
    form: { holdId: rowId },
    answer: { id: rowId, version: 8 },
  },
];

function operatorContext(
  options: { projectId?: string | null; scopes?: readonly string[] } = {},
) {
  return {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator" as const,
    organizationId: ids.organization,
    projectId: options.projectId ?? null,
    laneIds: new Set<string>(),
    scopes: new Set(options.scopes ?? ["operations:manage"]),
    credentialId,
    credentialFingerprint: "f24-operator-fingerprint",
    correlationId: "018f0000-0000-7000-8000-0000000f2416",
    authorizationId: credentialId,
  };
}

function signInAsOperator(options?: Parameters<typeof operatorContext>[0]) {
  const context = operatorContext(options);
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

/** What the two operations ports were handed, per method. */
function recordPorts() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  for (const port of ["operationsCommands", "retentionHoldCommands"] as const) {
    const methods = [
      "authorize",
      ...cases
        .filter((entry) => entry.port === port)
        .map((entry) => entry.method),
    ];
    apiV1.ports[port] = Object.fromEntries(
      methods.map((method) => [
        method,
        async (...args: unknown[]) => {
          calls.push({ method: `${port}.${method}`, args });
          if (method === "authorize") return undefined;
          return cases.find(
            (entry) => entry.port === port && entry.method === method,
          )?.answer;
        },
      ]),
    ) as never;
  }
  return calls;
}

function formData(fields: Record<string, string>) {
  const data = new FormData();
  data.set("expectedVersion", "7");
  data.set("idempotencyKey", "f24-form-idempotency-0001");
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function nothingReached() {
  expect(
    apiV1.portCalls.filter(
      (call) =>
        call.startsWith("operationsCommands.") ||
        call.startsWith("retentionHoldCommands."),
    ),
  ).toEqual([]);
}

function tasksStarted() {
  return (
    apiV1.dispatchCommittedEvents.mock.calls.length +
    dispatched.committedOutbox.mock.calls.length +
    dispatched.importTask.mock.calls.length +
    dispatched.notification.mock.calls.length +
    dispatched.slackConnectionTest.mock.calls.length +
    dispatched.slackMessageUpdate.mock.calls.length
  );
}

beforeEach(() => {
  resetApiV1Fakes();
  for (const dispatcher of Object.values(dispatched)) dispatcher.mockClear();
});

describe("the form and REST reach the same handler", () => {
  test("the cases are the six commands, each once", () => {
    expect(cases.map((entry) => entry.command).sort()).toEqual(
      Object.keys(operationsCommandInputSchemas).sort(),
    );
  });

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s: the form and an operator's POST end at the same port method, each for its own member",
    async (_, entry) => {
      const calls = recordPorts();
      const action = actions[entry.action] as (
        state: unknown,
        data: FormData,
      ) => Promise<{ status: string }>;
      const state = await action(
        initialOperationsActionState,
        formData(entry.form),
      );
      expect(state.status).toBe("success");
      const fromForm = [...calls];
      calls.length = 0;
      const startedByForm = tasksStarted();

      const context = signInAsOperator();
      const response = await api.command(entry.command, {
        input: entry.fields,
        idempotencyKey: "f24-rest-idempotency-0001",
        expectedVersion: 7,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        result: entry.answer,
      });
      const fromRest = [...calls];

      // One authorisation, then the one write, by the same method on each
      // path.
      const methods = [
        `${entry.port}.authorize`,
        `${entry.port}.${entry.method}`,
      ];
      expect(fromForm.map((call) => call.method)).toEqual(methods);
      expect(fromRest.map((call) => call.method)).toEqual(methods);
      const operator = (userId: string) => ({
        userId,
        organizationId: ids.organization,
      });
      expect(fromForm[0]?.args).toEqual([operator(session.user.id)]);
      expect(fromRest[0]?.args).toEqual([operator(memberUserId)]);
      expect(fromForm[1]?.args[0]).toMatchObject({
        ...operator(session.user.id),
        actor: { type: "user", id: session.user.id },
        expectedVersion: 7,
      });
      expect(fromRest[1]?.args[0]).toEqual({
        ...operator(memberUserId),
        actor: context.actor,
        correlationId: context.correlationId,
        expectedVersion: 7,
      });
      // What the write is told to do, beyond who and where, is the same.
      expect(fromRest[1]?.args.slice(1)).toEqual(fromForm[1]?.args.slice(1));
      // A requeue form starts its task after the commit; REST starts none,
      // and leaves the requeued row to the scheduled repair (ruling 7).
      expect(tasksStarted()).toBe(startedByForm);
    },
  );
});

describe("REST refuses what the handler must never see", () => {
  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an agent credential 403 before anything runs, even holding operations:manage",
    async (_, entry) => {
      recordPorts();
      signInAs(agentContext({ scopes: ["operations:manage", "org:read"] }));
      const response = await api.command(entry.command, {
        input: entry.fields,
        expectedVersion: 7,
      });
      expect(response.status).toBe(403);
      expect(apiV1.transactionsRun).toBe(0);
      nothingReached();
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator bound to a project 403 before the port is asked",
    async (_, entry) => {
      recordPorts();
      signInAsOperator({ projectId });
      const response = await api.command(entry.command, {
        input: entry.fields,
        expectedVersion: 7,
      });
      expect(response.status).toBe(403);
      nothingReached();
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s writes the credential's organisation over the one the caller names",
    async (_, entry) => {
      const calls = recordPorts();
      signInAsOperator();
      const response = await api.command(entry.command, {
        input: { organizationId: ids.otherOrganization, ...entry.fields },
        expectedVersion: 7,
      });
      expect(response.status).toBe(200);
      expect(calls[0]?.args[0]).toEqual({
        userId: memberUserId,
        organizationId: ids.organization,
      });
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator without operations:manage 403, naming nothing it could reach",
    async (_, entry) => {
      recordPorts();
      signInAsOperator({ scopes: ["operator:revoke"] });
      const response = await api.command(entry.command, {
        input: entry.fields,
        expectedVersion: 7,
      });
      expect(response.status).toBe(403);
      nothingReached();
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator whose credential is no longer current 403, before the port is asked",
    async (_, entry) => {
      recordPorts();
      apiV1.ports.commandAuthorization = {
        assertCurrent: async () => {
          const { DomainError } = await import("@requestport/domain");
          throw new DomainError(
            "forbidden",
            "Current operator authorization is no longer active",
          );
        },
      };
      signInAsOperator();
      const response = await api.command(entry.command, {
        input: entry.fields,
        expectedVersion: 7,
      });
      expect(response.status).toBe(403);
      expect(apiV1.portCalls).toEqual(["commandAuthorization.assertCurrent"]);
    },
  );
});

describe.each([
  ["list_administration_operations", "operations", "operations"],
  ["list_administration_retention_holds", "retention-holds", "retentionHolds"],
] as const)("GET the %s read", (_, segment, fake) => {
  const path = ["administration", segment];
  const read = () => apiV1.administrationReads[fake];

  test("reads for an operator holding operations:manage, in one transaction bound to its organisation, with its context and the deployment's switch", async () => {
    const context = signInAsOperator();
    read().mockResolvedValue({ answered: segment });
    const response = await api.get(path);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ answered: segment });
    expect(read()).toHaveBeenCalledOnce();
    expect(read()).toHaveBeenCalledWith(
      { fake: "transaction" },
      { context, operatorCredentials: undefined },
    );
    expect(apiV1.transactionsRun).toBe(1);
    // The one transaction is bound to the credential's organisation.
    expect(apiV1.readTransactionOrganizations).toEqual([
      context.organizationId,
    ]);
  });

  test("binds the read's transaction to the credential's organisation, never one the request names", async () => {
    const context = signInAsOperator();
    read().mockResolvedValue({ answered: segment });
    const response = await api.get(
      path,
      `?organizationId=${ids.otherOrganization}`,
    );
    expect(response.status).toBe(200);
    expect(apiV1.readTransactionOrganizations).toEqual([
      context.organizationId,
    ]);
    expect(apiV1.readTransactionOrganizations).not.toContain(
      ids.otherOrganization,
    );
  });

  test("refuses an agent credential 403, even holding operations:manage, reading nothing", async () => {
    signInAs(agentContext({ scopes: ["operations:manage", "org:read"] }));
    const response = await api.get(path);
    expect(response.status).toBe(403);
    expect(read()).not.toHaveBeenCalled();
    expect(apiV1.transactionsRun).toBe(0);
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });

  test("refuses an operator without operations:manage 403, reading nothing", async () => {
    signInAsOperator({ scopes: ["operator:revoke"] });
    const response = await api.get(path);
    expect(response.status).toBe(403);
    expect(read()).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });

  test.each([
    ["forbidden", 403],
    ["not_found", 404],
  ] as const)("answers the read's %s as %i", async (code, status) => {
    signInAsOperator();
    const { DomainError } = await import("@requestport/domain");
    read().mockRejectedValue(new DomainError(code, "refused by the read"));
    const response = await api.get(path);
    expect(response.status).toBe(status);
  });

  test("a path beside the read's is refused 403, reading nothing", async () => {
    for (const parts of [
      [...path, "extra"],
      ["administration", `${segment}s`],
    ]) {
      signInAsOperator();
      const response = await api.get(parts);
      expect(response.status, parts.join("/")).toBe(403);
    }
    expect(read()).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });
});
