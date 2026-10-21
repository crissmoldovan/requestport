import {
  operatorActor,
  slackAdministrationCommandInputSchemas,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  agentContext,
  ids,
  restClient,
  signInAs,
} from "../../../test/api-v1/agent-client.js";
import { apiV1, resetApiV1Fakes } from "../../../test/api-v1/fake-database.js";

/*
  Plan 13, F.2.5's registry half: the Slack forms and `/api/v1` reach the same
  handler. Both run here for real — the form's action, the REST route, the
  real `server-core-commands.ts` bus and `createCoreCommandRegistry()` — over
  B1's faked `@requestport/db`, so each ends at the same Slack administration
  port method, which records what it was handed. The form arrives as the
  signed-in person; REST as an operator credential, whose issuing member the
  port is asked about, and whose own actor the write records.

  The connection test stays off the bus: its form and its registry entry
  `send_slack_connection_test` both reach its handler (`@requestport/core`'s,
  which the form reaches through `lib/server-slack-actions.ts`), which queues
  through the Slack repository, a fake port here, on its own transaction. The
  handler runs end to end on PostgreSQL, through this route, in
  `actions.connection-test.database.test.ts`.

  What the fake cannot show — the role rule, the version check, the
  credential's re-check against its row — is proven on PostgreSQL in
  `packages/db/src/repositories/slack-repository.integration.test.ts` and
  `queries/administration/slack-reads.integration.test.ts`.

  The read's one transaction is bound to the credential's organisation
  before its first statement (`withAdministrationReadTransaction`;
  manifest-i2.md §4 Owns, ruling 50). The fake records the organisation it
  was bound to, as `server-administration-reads.test.ts` reads it; that the
  helper binds, and what a binding admits, is held in `packages/db`
  (`tenant-context.test.ts`, `row-security.integration.test.ts`).
*/

vi.mock(
  "@requestport/db",
  async () =>
    (await import("../../../test/api-v1/fake-database.js")).fakeDatabaseModule,
);
vi.mock(
  "@requestport/auth/server",
  async () =>
    (await import("../../../test/api-v1/fake-database.js"))
      .fakeAuthServerModule,
);
vi.mock(
  "@requestport/config/server",
  async () =>
    (await import("../../../test/api-v1/fake-database.js"))
      .fakeServerConfigModule,
);
vi.mock(
  "../../../lib/observability.js",
  async () =>
    (await import("../../../test/api-v1/fake-database.js"))
      .fakeObservabilityModule,
);
vi.mock(
  "../../../lib/trigger-client.js",
  async () =>
    (await import("../../../test/api-v1/fake-database.js"))
      .fakeTriggerClientModule,
);
// The web root runs, and the web's RequestPort is composed over the storage
// the wiring answers here (`server-web-request-port.ts`): the routes, the
// handlers and the rate limiter reach the faked package through it (Plan 13,
// G.3, G.6; ruling 140).
vi.mock(
  "@requestport/db/wiring",
  async () =>
    (await import("../../../test/api-v1/fake-database.js")).fakeWiringModule,
);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const session = vi.hoisted(() => ({
  user: { id: "user_f25_person" },
  session: { id: "session_f25" },
}));
vi.mock("../../../lib/server-application-context.js", () => ({
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

const route = await import("../../api/v1/[[...path]]/route.js");
const actions = await import("./actions.js");
const { initialSlackActionState } = await import("./slack-action-state.js");
const api = restClient(route);

const installationId = "018f0000-0000-7000-8000-0000000f2511";
const projectId = "018f0000-0000-7000-8000-0000000f2512";
const lineageId = "018f0000-0000-7000-8000-0000000f2513";
const credentialId = "018f0000-0000-7000-8000-0000000f2514";
const memberUserId = "user_f25_operator_member";

type CommandName = keyof typeof slackAdministrationCommandInputSchemas;

/**
 * Each command, its form action, its port method, one valid input as REST
 * sends it, and the same as the form sends it.
 */
const cases: Array<{
  command: CommandName;
  action: keyof typeof actions;
  method: string;
  fields: Record<string, unknown>;
  form: Record<string, string>;
  /** What the form's hidden version field says, and REST's `expectedVersion`. */
  expectedVersion: number;
}> = [
  {
    command: "set_slack_user_mapping",
    action: "mapSlackUserAction",
    method: "upsertMapping",
    fields: {
      installationId,
      userId: "user_f25_target",
      slackUserId: "U0TARGET1",
    },
    form: {
      installationId,
      userId: "user_f25_target",
      slackUserId: "U0TARGET1",
    },
    expectedVersion: 0,
  },
  {
    command: "set_slack_route",
    action: "setSlackRouteAction",
    method: "setRoute",
    fields: {
      projectId,
      mode: "channel",
      channelId: "C0ROUTE01",
      fallback: "none",
    },
    form: {
      projectId,
      mode: "channel",
      channelId: "C0ROUTE01",
      fallback: "none",
    },
    expectedVersion: 3,
  },
  {
    command: "set_slack_installation_status",
    action: "setSlackInstallationStatusAction",
    method: "setInstallationStatus",
    fields: { installationId, status: "disabled" },
    form: { installationId, status: "disabled" },
    expectedVersion: 4,
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
    scopes: new Set(options.scopes ?? ["slack:manage"]),
    credentialId,
    credentialFingerprint: "f25-operator-fingerprint",
    correlationId: "018f0000-0000-7000-8000-0000000f2515",
    authorizationId: credentialId,
  };
}

function signInAsOperator(options?: Parameters<typeof operatorContext>[0]) {
  const context = operatorContext(options);
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

/** What the Slack administration port was handed, per method. */
function recordPort() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const methods = ["authorize", ...cases.map((entry) => entry.method)];
  apiV1.ports.slackAdministrationCommands = Object.fromEntries(
    methods.map((method) => [
      method,
      async (...args: unknown[]) => {
        calls.push({ method, args });
        if (method === "authorize") return undefined;
        return { id: installationId, version: 9, status: "disabled" };
      },
    ]),
  ) as never;
  return calls;
}

function formData(fields: Record<string, string>, expectedVersion: number) {
  const data = new FormData();
  data.set("expectedVersion", String(expectedVersion));
  data.set("idempotencyKey", "f25-form-idempotency-0001");
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function nothingReached() {
  expect(
    apiV1.portCalls.filter((call) =>
      call.startsWith("slackAdministrationCommands."),
    ),
  ).toEqual([]);
}

beforeEach(() => {
  resetApiV1Fakes();
  vi.restoreAllMocks();
});

describe("the form and REST reach the same handler", () => {
  test("the cases are the three commands, each once", () => {
    expect(cases.map((entry) => entry.command).sort()).toEqual(
      Object.keys(slackAdministrationCommandInputSchemas).sort(),
    );
  });

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s: the form and an operator's POST end at the same port method, each for its own member",
    async (_, entry) => {
      const calls = recordPort();
      const action = actions[entry.action] as (
        state: unknown,
        data: FormData,
      ) => Promise<{ status: string }>;
      const state = await action(
        initialSlackActionState,
        formData(entry.form, entry.expectedVersion),
      );
      expect(state.status).toBe("success");
      const fromForm = [...calls];
      calls.length = 0;

      const context = signInAsOperator();
      const response = await api.command(entry.command, {
        input: entry.fields,
        idempotencyKey: "f25-rest-idempotency-0001",
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(200);
      const fromRest = [...calls];
      const { result } = (await response.json()) as {
        result: Record<string, unknown>;
      };
      expect(result).toMatchObject({ id: installationId, version: 9 });

      // One authorisation, then the one write, by the same method on each
      // path.
      expect(fromForm.map((call) => call.method)).toEqual([
        "authorize",
        entry.method,
      ]);
      expect(fromRest.map((call) => call.method)).toEqual(
        fromForm.map((call) => call.method),
      );
      const target = (actorUserId: string) => ({
        actorUserId,
        organizationId: ids.organization,
      });
      expect(fromForm[0]?.args).toEqual([target(session.user.id)]);
      expect(fromRest[0]?.args).toEqual([target(memberUserId)]);
      expect(fromForm[1]?.args[0]).toMatchObject({
        ...target(session.user.id),
        actor: { type: "user", id: session.user.id },
        expectedVersion: entry.expectedVersion,
      });
      expect(fromRest[1]?.args[0]).toMatchObject({
        ...target(memberUserId),
        actor: context.actor,
        correlationId: context.correlationId,
        expectedVersion: entry.expectedVersion,
      });
      // What the write is told to do, beyond who and where, is the same.
      expect(fromRest[1]?.args.slice(1)).toEqual(fromForm[1]?.args.slice(1));
    },
  );
});

describe("REST refuses what the handler must never see", () => {
  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an agent credential 403 before anything runs, even holding slack:manage",
    async (_, entry) => {
      recordPort();
      signInAs(agentContext({ scopes: ["slack:manage", "org:read"] }));
      const response = await api.command(entry.command, {
        input: entry.fields,
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(403);
      expect(apiV1.transactionsRun).toBe(0);
      nothingReached();
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator bound to a project 403 before the port is asked",
    async (_, entry) => {
      recordPort();
      signInAsOperator({ projectId });
      const response = await api.command(entry.command, {
        input: entry.fields,
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(403);
      nothingReached();
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s writes the credential's organisation over the one the caller names",
    async (_, entry) => {
      const calls = recordPort();
      signInAsOperator();
      const response = await api.command(entry.command, {
        input: { ...entry.fields, organizationId: ids.otherOrganization },
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(200);
      expect(calls[0]?.args[0]).toMatchObject({
        organizationId: ids.organization,
      });
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator without slack:manage 403, naming nothing it could reach",
    async (_, entry) => {
      recordPort();
      signInAsOperator({ scopes: ["operator:revoke"] });
      const response = await api.command(entry.command, {
        input: entry.fields,
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(403);
      nothingReached();
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator whose credential is no longer current 403, before the port is asked",
    async (_, entry) => {
      recordPort();
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
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(403);
      expect(apiV1.portCalls).toEqual(["commandAuthorization.assertCurrent"]);
    },
  );
});

describe("the connection test: the form and REST reach the same handler", () => {
  const operationId = "018f0000-0000-7000-8000-0000000f2516";
  const fields = { installationId, channelId: "C0TESTING" };

  /** What the Slack repository's queueConnectionTest was handed. */
  function recordQueue() {
    const queued: Array<Record<string, unknown>> = [];
    apiV1.ports.slack = {
      queueConnectionTest: async (input: Record<string, unknown>) => {
        queued.push(input);
        return {
          id: operationId,
          installationId,
          operationPayload: { channelId: fields.channelId },
        };
      },
    };
    return queued;
  }

  test("the form and an operator's POST queue through the same repository method, each for its own member and actor", async () => {
    const queued = recordQueue();
    const data = new FormData();
    data.set("installationId", installationId);
    data.set("channelId", fields.channelId);
    data.set("idempotencyKey", "f25-form-idempotency-0001");
    const state = await actions.sendSlackConnectionTestAction(
      initialSlackActionState,
      data,
    );
    expect(state.status).toBe("success");

    const context = signInAsOperator();
    const response = await api.command("send_slack_connection_test", {
      input: fields,
      idempotencyKey: "f25-rest-idempotency-0001",
      expectedVersion: 0,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: { operationId, dispatched: true },
    });

    const [fromForm, fromRest] = queued;
    expect(queued).toHaveLength(2);
    expect(fromForm).toMatchObject({
      organizationId: ids.organization,
      userId: session.user.id,
      actor: { type: "user", id: session.user.id },
      idempotencyKey: "f25-form-idempotency-0001",
    });
    expect(fromRest).toMatchObject({
      organizationId: ids.organization,
      userId: memberUserId,
      actor: context.actor,
      correlationId: context.correlationId,
      idempotencyKey: "f25-rest-idempotency-0001",
    });
    // What the queue is told to do, beyond who, when and under which key, is
    // the same.
    const what = (input: Record<string, unknown> | undefined) => {
      const {
        userId: _userId,
        actor: _actor,
        correlationId: _correlationId,
        idempotencyKey: _idempotencyKey,
        ...rest
      } = input ?? {};
      return rest;
    };
    expect(what(fromRest)).toEqual(what(fromForm));
    // Each re-checked its credential first, and started the task after.
    expect(
      apiV1.portCalls.filter((call) => !call.startsWith("slackAdministration")),
    ).toEqual([
      "commandAuthorization.assertCurrent",
      "slack.queueConnectionTest",
      "commandAuthorization.assertCurrent",
      "slack.queueConnectionTest",
    ]);
    expect(apiV1.triggerSlackConnectionTest.mock.calls).toEqual([
      [operationId],
      [operationId],
    ]);
  });

  test("an agent credential is refused 403 before anything runs, even holding slack:manage", async () => {
    recordQueue();
    signInAs(agentContext({ scopes: ["slack:manage", "org:read"] }));
    const response = await api.command("send_slack_connection_test", {
      input: fields,
      expectedVersion: 0,
    });
    expect(response.status).toBe(403);
    expect(apiV1.transactionsRun).toBe(0);
    expect(apiV1.portCalls).toEqual([]);
  });

  test("an agent credential is refused by the route's own admission, before the body is read", async () => {
    // The route checks the entry's credentialKinds before it reads the body
    // (route.ts, "Checked before the body is read"), so a malformed body
    // still answers 403 here. Were agents admitted, the route would read the
    // body first and answer 400; the handler's own memberAuthority refusal
    // alone could not tell the two apart.
    recordQueue();
    signInAs(agentContext({ scopes: ["slack:manage", "org:read"] }));
    const response = await api.postRaw(
      ["commands", "send_slack_connection_test"],
      { body: "{ not json", headers: { "content-type": "application/json" } },
    );
    expect(response.status).toBe(403);
    expect(apiV1.transactionsRun).toBe(0);
    expect(apiV1.portCalls).toEqual([]);
  });

  test("an operator bound to a project is refused 403 before any transaction opens", async () => {
    recordQueue();
    signInAsOperator({ projectId });
    const response = await api.command("send_slack_connection_test", {
      input: fields,
      expectedVersion: 0,
    });
    expect(response.status).toBe(403);
    expect(apiV1.transactionsRun).toBe(0);
    expect(apiV1.portCalls).toEqual([]);
  });

  test("an operator without slack:manage is refused 403 before any transaction opens", async () => {
    recordQueue();
    signInAsOperator({ scopes: ["operator:revoke"] });
    const response = await api.command("send_slack_connection_test", {
      input: fields,
      expectedVersion: 0,
    });
    expect(response.status).toBe(403);
    expect(apiV1.transactionsRun).toBe(0);
  });

  test("the credential's organisation is written over the one the caller names", async () => {
    const queued = recordQueue();
    signInAsOperator();
    const response = await api.command("send_slack_connection_test", {
      input: { ...fields, organizationId: ids.otherOrganization },
      expectedVersion: 0,
    });
    expect(response.status).toBe(200);
    expect(queued[0]).toMatchObject({ organizationId: ids.organization });
  });

  test("an operator whose credential is no longer current is refused 403, and nothing is queued or started", async () => {
    recordQueue();
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
    const response = await api.command("send_slack_connection_test", {
      input: fields,
      expectedVersion: 0,
    });
    expect(response.status).toBe(403);
    expect(apiV1.portCalls).toEqual(["commandAuthorization.assertCurrent"]);
    expect(apiV1.triggerSlackConnectionTest).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/administration/slack", () => {
  const path = ["administration", "slack"];

  test("reads for an operator holding slack:manage, in one transaction bound to its organisation, with its context", async () => {
    const context = signInAsOperator();
    apiV1.administrationReads.slackConfiguration.mockResolvedValue({
      installations: [],
      mappings: [],
      routes: [],
    });
    const response = await api.get(path);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      installations: [],
      mappings: [],
      routes: [],
    });
    expect(apiV1.administrationReads.slackConfiguration).toHaveBeenCalledOnce();
    expect(apiV1.administrationReads.slackConfiguration).toHaveBeenCalledWith(
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
    apiV1.administrationReads.slackConfiguration.mockResolvedValue({
      installations: [],
      mappings: [],
      routes: [],
    });
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

  test("refuses an agent credential 403, even holding slack:manage, reading nothing", async () => {
    signInAs(agentContext({ scopes: ["slack:manage", "org:read"] }));
    const response = await api.get(path);
    expect(response.status).toBe(403);
    expect(apiV1.administrationReads.slackConfiguration).not.toHaveBeenCalled();
    expect(apiV1.transactionsRun).toBe(0);
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });

  test("refuses an operator without slack:manage 403, reading nothing", async () => {
    signInAsOperator({ scopes: ["operator:revoke"] });
    const response = await api.get(path);
    expect(response.status).toBe(403);
    expect(apiV1.administrationReads.slackConfiguration).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });

  test.each([
    ["forbidden", 403],
    ["not_found", 404],
  ] as const)("answers the read's %s as %i", async (code, status) => {
    signInAsOperator({ projectId });
    const { DomainError } = await import("@requestport/domain");
    apiV1.administrationReads.slackConfiguration.mockRejectedValue(
      new DomainError(code, "refused by the read"),
    );
    const response = await api.get(path);
    expect(response.status).toBe(status);
  });

  test("a path beside the read's is refused 403, reading nothing", async () => {
    for (const parts of [
      ["administration", "slack", "routes"],
      ["administration", "slack", installationId],
    ]) {
      signInAsOperator();
      const response = await api.get(parts);
      expect(response.status, parts.join("/")).toBe(403);
    }
    expect(apiV1.administrationReads.slackConfiguration).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });
});
