import { operatorActor, routingCommandInputSchemas } from "@requestport/domain";
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
  Plan 13, F.2.1's registry half: the routing rule forms and `/api/v1` reach
  the same handler. Both run here for real — the form's action, the REST
  route, the real `server-core-commands.ts` bus and
  `createCoreCommandRegistry()` — over B1's faked `@requestport/db`, so each
  ends at the same routing port methods, which record what they were handed.
  The form arrives as the signed-in person; REST as an operator credential,
  whose issuing member the port is asked about, and whose own actor the rule
  records as its author.

  The routing rules read and route evaluation are dispatched here, and their
  compositions answered by fakes; what the fakes cannot show — the role
  rule, the version check, the credential's re-check against its row, and
  the evaluation itself — is proven on PostgreSQL in
  `packages/db/src/repositories/routing-repository.integration.test.ts` and
  `queries/administration/routing-reads.integration.test.ts`.

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
vi.mock(
  "../../../../lib/trigger-client.js",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeTriggerClientModule,
);
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
  user: { id: "user_f21_person" },
  session: { id: "session_f21" },
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
const api = restClient(route);

const targetProjectId = "018f0000-0000-7000-8000-0000000f2111";
const otherProjectId = "018f0000-0000-7000-8000-0000000f2112";
const ruleId = "018f0000-0000-7000-8000-0000000f2113";
const lineageId = "018f0000-0000-7000-8000-0000000f2115";
const credentialId = "018f0000-0000-7000-8000-0000000f2116";
const memberUserId = "user_f21_operator_member";

type CommandName = keyof typeof routingCommandInputSchemas;

const rule = {
  targetProjectId,
  sourceKind: "human_direct",
  decision: "deny",
  requestTypes: [],
  laneIds: [],
  priorities: [],
  humanRoles: [],
  agentPrincipalIds: [],
};

/** Each command, its form action, its port write, and one valid input. */
const cases: Array<{
  command: CommandName;
  action:
    | "createRoutingRuleAction"
    | "updateRoutingRuleAction"
    | "disableRoutingRuleAction";
  method: "createRule" | "updateRule" | "disableRule";
  expectedVersion: number;
  input: Record<string, unknown>;
  form: Record<string, string>;
}> = [
  {
    command: "create_routing_rule",
    action: "createRoutingRuleAction",
    method: "createRule",
    expectedVersion: 0,
    input: { ...rule, enabled: true },
    form: { sourceProjectId: "", targetProjectId, decision: "deny" },
  },
  {
    command: "update_routing_rule",
    action: "updateRoutingRuleAction",
    method: "updateRule",
    expectedVersion: 7,
    input: { ...rule, ruleId, enabled: true },
    form: {
      ruleId,
      expectedVersion: "7",
      sourceProjectId: "",
      targetProjectId,
      decision: "deny",
    },
  },
  {
    command: "disable_routing_rule",
    action: "disableRoutingRuleAction",
    method: "disableRule",
    expectedVersion: 7,
    input: { ruleId },
    form: { ruleId, expectedVersion: "7" },
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
    scopes: new Set(options.scopes ?? ["routing:manage", "request:create"]),
    credentialId,
    credentialFingerprint: "f21-operator-fingerprint",
    correlationId: "018f0000-0000-7000-8000-0000000f2117",
    authorizationId: credentialId,
  };
}

function signInAsOperator(options?: Parameters<typeof operatorContext>[0]) {
  const context = operatorContext(options);
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

/** What the routing port was handed, per method. */
function recordPort() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const stored = {
    id: ruleId,
    organizationId: ids.organization,
    ...rule,
    specificity: 1_000,
    enabled: true,
    version: 8,
  };
  apiV1.ports.routing = {
    canManage: async (...args: unknown[]) => {
      calls.push({ method: "canManage", args });
      return true;
    },
    createRule: async (...args: unknown[]) => {
      calls.push({ method: "createRule", args });
      return { ...stored, version: 1 };
    },
    updateRule: async (...args: unknown[]) => {
      calls.push({ method: "updateRule", args });
      return stored;
    },
    disableRule: async (...args: unknown[]) => {
      calls.push({ method: "disableRule", args });
      return { ...stored, enabled: false };
    },
  } as never;
  return calls;
}

function formData(fields: Record<string, string>) {
  const data = new FormData();
  data.set("idempotencyKey", "f21-form-idempotency-0001");
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function nothingReached() {
  expect(apiV1.portCalls.filter((call) => call.startsWith("routing."))).toEqual(
    [],
  );
}

beforeEach(() => {
  resetApiV1Fakes();
  vi.restoreAllMocks();
});

describe("the rule forms and REST reach the same handler", () => {
  test("the cases are the three rule commands, each once", () => {
    expect(cases.map((entry) => entry.command).sort()).toEqual(
      Object.keys(routingCommandInputSchemas).sort(),
    );
  });

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s: the form and an operator's POST end at the same port methods, each for its own member",
    async (_, entry) => {
      const calls = recordPort();
      const action = actions[entry.action];
      const state = await action({ status: "idle" }, formData(entry.form));
      expect(state).toMatchObject({ status: "success" });
      const fromForm = [...calls];
      calls.length = 0;

      const context = signInAsOperator();
      const response = await api.command(entry.command, {
        input: entry.input,
        idempotencyKey: "f21-rest-idempotency-0001",
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(200);
      const fromRest = [...calls];

      // One authorisation, then the one write, by the same method on each
      // path.
      expect(fromForm.map((call) => call.method)).toEqual([
        "canManage",
        entry.method,
      ]);
      expect(fromRest.map((call) => call.method)).toEqual(
        fromForm.map((call) => call.method),
      );
      expect(fromForm[0]?.args).toEqual([
        ids.organization,
        { type: "user", id: session.user.id },
      ]);
      expect(fromRest[0]?.args).toEqual([
        ids.organization,
        { type: "user", id: memberUserId },
      ]);
      if (entry.method === "createRule") {
        // What the rule records as its author is who acted; everything else
        // the write is told is the same.
        const { createdBy: formAuthor, ...formRule } = (fromForm[1]?.args[0] ??
          {}) as Record<string, unknown>;
        const { createdBy: restAuthor, ...restRule } = (fromRest[1]?.args[0] ??
          {}) as Record<string, unknown>;
        expect(formAuthor).toBe(`user:${session.user.id}`);
        expect(restAuthor).toBe(`service:operator:${lineageId}`);
        expect(restRule).toEqual(formRule);
      } else {
        expect(fromRest[1]?.args).toEqual(fromForm[1]?.args);
      }
      // The event records the operator as the service it is, with its
      // member as origin.
      expect(apiV1.appendedEvents.at(-1)?.actor).toEqual(context.actor);
    },
  );
});

describe("REST refuses what the handler must never see", () => {
  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an agent credential 403 before anything runs, even holding routing:manage",
    async (_, entry) => {
      recordPort();
      signInAs(agentContext({ scopes: ["routing:manage", "request:create"] }));
      const response = await api.command(entry.command, {
        input: entry.input,
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
      signInAsOperator({ projectId: otherProjectId });
      const response = await api.command(entry.command, {
        input: entry.input,
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
        input: { ...entry.input, organizationId: ids.otherOrganization },
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(200);
      expect(calls[0]?.args[0]).toBe(ids.organization);
    },
  );

  test.each(cases.map((entry) => [entry.command, entry] as const))(
    "%s refuses an operator without routing:manage 403, before the port is asked",
    async (_, entry) => {
      recordPort();
      signInAsOperator({ scopes: ["request:create"] });
      const response = await api.command(entry.command, {
        input: entry.input,
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
        input: entry.input,
        expectedVersion: entry.expectedVersion,
      });
      expect(response.status).toBe(403);
      expect(apiV1.portCalls).toEqual(["commandAuthorization.assertCurrent"]);
    },
  );
});

describe("GET /api/v1/administration/routing-rules", () => {
  const path = ["administration", "routing-rules"];

  test("reads for an operator holding routing:manage, in one transaction bound to its organisation, with its context", async () => {
    const context = signInAsOperator();
    apiV1.administrationReads.routingRules.mockResolvedValue([
      { id: ruleId, version: 3 },
    ]);
    const response = await api.get(path);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { id: ruleId, version: 3 },
    ]);
    expect(apiV1.administrationReads.routingRules).toHaveBeenCalledOnce();
    expect(apiV1.administrationReads.routingRules).toHaveBeenCalledWith(
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
    apiV1.administrationReads.routingRules.mockResolvedValue([]);
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

  test("refuses an agent credential 403, even holding routing:manage, reading nothing", async () => {
    signInAs(agentContext({ scopes: ["routing:manage", "request:create"] }));
    const response = await api.get(path);
    expect(response.status).toBe(403);
    expect(apiV1.administrationReads.routingRules).not.toHaveBeenCalled();
    expect(apiV1.transactionsRun).toBe(0);
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });

  test("refuses an operator without routing:manage 403, reading nothing", async () => {
    signInAsOperator({ scopes: ["request:create"] });
    const response = await api.get(path);
    expect(response.status).toBe(403);
    expect(apiV1.administrationReads.routingRules).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });

  test("answers the read's forbidden as 403", async () => {
    signInAsOperator({ projectId: targetProjectId });
    const { DomainError } = await import("@requestport/domain");
    apiV1.administrationReads.routingRules.mockRejectedValue(
      new DomainError(
        "forbidden",
        "Routing rules are read with a credential bound to no project",
      ),
    );
    const response = await api.get(path);
    expect(response.status).toBe(403);
  });
});

describe("GET /api/v1/administration/route-evaluations/{test,preview}", () => {
  const purposes = [
    ["test", "routing:manage"],
    ["preview", "request:create"],
  ] as const;
  const query = `?targetProjectId=${targetProjectId}&requestType=bug&priority=normal`;

  test.each(purposes)(
    "%s evaluates for an operator holding its scope, in one transaction, with its context, its purpose and the query",
    async (purpose, scope) => {
      const context = signInAsOperator({ scopes: [scope] });
      const decision = {
        allowed: false,
        reason: "matched_deny",
        matchedRuleId: ruleId,
        policyVersion: 3,
        evaluatedConstraints: [],
      };
      apiV1.administrationReads.routeEvaluation.mockResolvedValue(decision);
      const response = await api.get(
        ["administration", "route-evaluations", purpose],
        query,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(decision);
      expect(apiV1.administrationReads.routeEvaluation).toHaveBeenCalledOnce();
      const [transaction, input] =
        apiV1.administrationReads.routeEvaluation.mock.calls[0] ?? [];
      expect(transaction).toEqual({ fake: "transaction" });
      expect(input).toMatchObject({
        context,
        purpose,
        operatorCredentials: undefined,
      });
      expect(Object.fromEntries(input.searchParams)).toEqual({
        targetProjectId,
        requestType: "bug",
        priority: "normal",
      });
      expect(apiV1.transactionsRun).toBe(1);
      // The one transaction is bound to the credential's organisation.
      expect(apiV1.readTransactionOrganizations).toEqual([
        context.organizationId,
      ]);
    },
  );

  test.each(purposes)(
    "%s binds the evaluation's transaction to the credential's organisation, never one the query names",
    async (purpose, scope) => {
      const context = signInAsOperator({ scopes: [scope] });
      apiV1.administrationReads.routeEvaluation.mockResolvedValue({
        allowed: true,
      });
      const response = await api.get(
        ["administration", "route-evaluations", purpose],
        `${query}&organizationId=${ids.otherOrganization}`,
      );
      expect(response.status).toBe(200);
      expect(apiV1.readTransactionOrganizations).toEqual([
        context.organizationId,
      ]);
      expect(apiV1.readTransactionOrganizations).not.toContain(
        ids.otherOrganization,
      );
    },
  );

  test.each(purposes)(
    "%s refuses an agent credential 403, even holding its scope, evaluating nothing",
    async (purpose, scope) => {
      signInAs(agentContext({ scopes: [scope, "routing:manage"] }));
      const response = await api.get(
        ["administration", "route-evaluations", purpose],
        query,
      );
      expect(response.status).toBe(403);
      expect(apiV1.administrationReads.routeEvaluation).not.toHaveBeenCalled();
      expect(apiV1.transactionsRun).toBe(0);
      expect(apiV1.readTransactionOrganizations).toEqual([]);
    },
  );

  test("each purpose refuses an operator holding only the other's scope 403, evaluating nothing", async () => {
    for (const [purpose, scope] of [
      ["test", "request:create"],
      ["preview", "routing:manage"],
    ] as const) {
      signInAsOperator({ scopes: [scope] });
      const response = await api.get(
        ["administration", "route-evaluations", purpose],
        query,
      );
      expect(response.status, purpose).toBe(403);
    }
    expect(apiV1.administrationReads.routeEvaluation).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });

  test("answers the evaluation's refusal as 403, and its invalid input as 422", async () => {
    const { DomainError } = await import("@requestport/domain");
    const { ZodError } = await import("zod");
    for (const [thrown, status] of [
      [new DomainError("forbidden", "Operator project access is denied"), 403],
      [new ZodError([]), 422],
    ] as const) {
      signInAsOperator();
      apiV1.administrationReads.routeEvaluation.mockRejectedValueOnce(thrown);
      const response = await api.get(
        ["administration", "route-evaluations", "test"],
        query,
      );
      expect(response.status).toBe(status);
    }
  });

  test("a path beside the evaluations' is refused 403, evaluating nothing", async () => {
    for (const parts of [
      ["administration", "route-evaluations"],
      ["administration", "route-evaluations", "other"],
      ["administration", "route-evaluations", "test", "extra"],
      ["administration", "routing-rules", ruleId],
    ]) {
      signInAsOperator();
      const response = await api.get(parts, query);
      expect(response.status, parts.join("/")).toBe(403);
    }
    expect(apiV1.administrationReads.routeEvaluation).not.toHaveBeenCalled();
    expect(apiV1.administrationReads.routingRules).not.toHaveBeenCalled();
    expect(apiV1.readTransactionOrganizations).toEqual([]);
  });
});
