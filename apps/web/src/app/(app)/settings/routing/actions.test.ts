import {
  createCoreCommandRegistry,
  DomainError,
  normalizedInputHash,
  routingCommandInputSchemas,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const routing = vi.hoisted(() => ({
  execute: vi.fn(),
  humanCommandContext: vi.fn(
    (
      session: { user: { id: string }; session: { id: string } },
      organizationId: string,
    ) => ({
      actor: { type: "user", id: session.user.id },
      organizationId,
      scopes: new Set(["routing:manage", "request:create"]),
      credentialId: session.session.id,
      correlationId: "00000000-0000-4000-8000-0000000000cc",
    }),
  ),
  session: {
    user: { id: "00000000-0000-4000-8000-0000000000aa" },
    session: { id: "session-routing-suite" },
  },
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  },
}));

/**
 * The database the route evaluation helper opens, faked at the package
 * boundary so the helper and the domain's evaluation entry run for real.
 * Each factory records the transaction it was built on.
 */
const database = vi.hoisted(() => {
  const tx = { name: "the evaluation's transaction" };
  return {
    tx,
    builtOn: [] as unknown[],
    assertCurrent: vi.fn(),
    findActiveOrganizationForUser: vi.fn(),
    listOrganizationProjects: vi.fn(),
    listRulesForMember: vi.fn(),
    withTransaction: vi.fn(async (run: (tx: unknown) => unknown) => run(tx)),
  };
});

vi.mock("@requestport/db", () => ({
  createCommandAuthorizationRepository: (tx: unknown) => {
    database.builtOn.push(tx);
    return { assertCurrent: database.assertCurrent };
  },
  createFoundationQueryRepository: (tx: unknown) => {
    database.builtOn.push(tx);
    return {
      findActiveOrganizationForUser: database.findActiveOrganizationForUser,
      listOrganizationProjects: database.listOrganizationProjects,
    };
  },
  createRoutingRepository: (tx: unknown) => {
    database.builtOn.push(tx);
    return { listRulesForMember: database.listRulesForMember };
  },
}));
/*
 * The helper opens its transaction on the web root's storage (Plan 13, G.2).
 * So the root hands back the fake above, `database.withTransaction`, as that
 * storage's `transaction`, and the cases count it as they always did.
 */
vi.mock("../../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ transaction: database.withTransaction }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("../../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: routing.organization,
    session: routing.session,
  }),
}));

vi.mock("../../../../lib/server-core-commands.js", () => ({
  coreCommandBus: { execute: routing.execute },
  humanCommandContext: routing.humanCommandContext,
}));

import {
  createRoutingRuleAction,
  disableRoutingRuleAction,
  testRoutingRuleAction,
  updateRoutingRuleAction,
} from "./actions.js";
import { initialRoutingActionState } from "./routing-action-state.js";

/**
 * Where a rejected routing submission is allowed to land.
 *
 * The rule forms draw a field for each end of the route and for the decision,
 * so §7 puts a rejection about one of them on that control's own error line.
 * The disable control and the tester draw no field a message could land on —
 * one carries hidden metadata, the other an `aria-label`led toolbar — so their
 * rejections stay the fixed banner they have always been.
 */

const target = "00000000-0000-4000-8000-0000000000c2";
const key = "0123456789abcdef0123";

function ruleForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("sourceProjectId", "");
  data.set("targetProjectId", target);
  data.set("decision", "allow");
  data.set("idempotencyKey", key);
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

beforeEach(() => {
  routing.execute.mockReset();
  routing.execute.mockResolvedValue(undefined);
  routing.humanCommandContext.mockClear();
  database.builtOn.length = 0;
  for (const spy of [
    database.assertCurrent,
    database.findActiveOrganizationForUser,
    database.listOrganizationProjects,
    database.listRulesForMember,
  ])
    spy.mockReset();
  database.withTransaction.mockClear();
  database.assertCurrent.mockResolvedValue(undefined);
  database.findActiveOrganizationForUser.mockResolvedValue({
    ...routing.organization,
  });
  database.listOrganizationProjects.mockResolvedValue([]);
  database.listRulesForMember.mockResolvedValue([]);
});

describe("a rejected rule submission", () => {
  test("names the control a schema rejection belongs to", async () => {
    const data = ruleForm();
    data.delete("targetProjectId");

    expect(
      await createRoutingRuleAction(initialRoutingActionState, data),
    ).toMatchObject({ field: "targetProjectId", status: "error" });
  });

  test("names the control a decision rejection belongs to", async () => {
    expect(
      await createRoutingRuleAction(
        initialRoutingActionState,
        ruleForm({ decision: "maybe" }),
      ),
    ).toMatchObject({ field: "decision", status: "error" });
  });

  test("carries the field a domain rejection already names", async () => {
    routing.execute.mockRejectedValue(
      new DomainError("conflict", "narrower rule denies this route", {
        field: "targetProjectId",
      }),
    );

    expect(
      await createRoutingRuleAction(initialRoutingActionState, ruleForm()),
    ).toEqual({
      field: "targetProjectId",
      message: "That rule conflicts with existing policy.",
      status: "error",
    });
  });

  test("names no field when the rejection is about the route as a whole", async () => {
    routing.execute.mockRejectedValue(
      new DomainError("version_conflict", "stale"),
    );

    expect(
      await createRoutingRuleAction(initialRoutingActionState, ruleForm()),
    ).toEqual({
      message: "The rule changed. Refresh and try again.",
      status: "error",
    });
  });
});

describe("a rejected submission with no field to land on", () => {
  test("keeps the fixed message for the hidden-metadata disable control", async () => {
    expect(
      await disableRoutingRuleAction(initialRoutingActionState, new FormData()),
    ).toEqual({ message: "Routing rule input is invalid.", status: "error" });
  });

  test("keeps the fixed message for the tester's labelled toolbar", async () => {
    expect(
      await testRoutingRuleAction(initialRoutingActionState, new FormData()),
    ).toEqual({ message: "Choose a complete route to test.", status: "error" });
  });
});

/**
 * The tester reaches the one route evaluation entry the request form's preview
 * also reaches (Plan 13, F.2.1), through `server-routing-actions.ts`: the
 * credential re-checked first, then the entry, all on one transaction.
 */
describe("testing a route", () => {
  const source = "00000000-0000-4000-8000-0000000000c1";
  const lane = "00000000-0000-4000-8000-0000000000e1";
  const agent = "00000000-0000-4000-8000-0000000000f1";
  const ruleId = "00000000-0000-4000-8000-0000000000b1";

  function testForm(overrides: Record<string, string> = {}) {
    const data = new FormData();
    data.set("sourceProjectId", "");
    data.set("targetProjectId", target);
    data.set("requestType", "feature");
    data.set("priority", "normal");
    data.set("laneId", "");
    data.set("agentPrincipalId", "");
    for (const [name, value] of Object.entries(overrides))
      data.set(name, value);
    return data;
  }

  function rule(overrides: Record<string, unknown> = {}) {
    return {
      id: ruleId,
      organizationId: routing.organization.id,
      sourceKind: "human_direct",
      targetProjectId: target,
      decision: "deny",
      requestTypes: [],
      laneIds: [],
      priorities: [],
      humanRoles: [],
      agentPrincipalIds: [],
      specificity: 1_000,
      enabled: true,
      version: 3,
      ...overrides,
    };
  }

  test("re-checks the credential, then evaluates a named agent and lane, on one transaction", async () => {
    database.listRulesForMember.mockResolvedValue([
      rule({
        sourceKind: "project",
        sourceProjectId: source,
        decision: "allow",
        laneIds: [lane],
        agentPrincipalIds: [agent],
        specificity: 3_297,
      }),
    ]);

    expect(
      await testRoutingRuleAction(
        initialRoutingActionState,
        testForm({
          sourceProjectId: source,
          laneId: lane,
          agentPrincipalId: agent,
        }),
      ),
    ).toEqual({
      status: "decision",
      allowed: true,
      message: "Allowed: matched allow · policy v3",
    });
    expect(database.withTransaction).toHaveBeenCalledTimes(1);
    expect(database.builtOn).toEqual([database.tx, database.tx, database.tx]);
    expect(database.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: "user", id: "00000000-0000-4000-8000-0000000000aa" },
        organizationId: routing.organization.id,
        credentialId: "session-routing-suite",
      }),
    );
    expect(database.assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      database.findActiveOrganizationForUser.mock.invocationCallOrder[0] ?? 0,
    );
    // The tester is not asked whether the member may represent the source.
    expect(database.listOrganizationProjects).not.toHaveBeenCalled();
  });

  test("evaluates the member, with the role the organisation records, when no agent is named", async () => {
    database.findActiveOrganizationForUser.mockResolvedValue({
      ...routing.organization,
      role: "member",
    });
    database.listRulesForMember.mockResolvedValue([
      rule({ humanRoles: ["member"], specificity: 1_099 }),
    ]);

    expect(
      await testRoutingRuleAction(initialRoutingActionState, testForm()),
    ).toEqual({
      status: "decision",
      allowed: false,
      message: "Denied: matched deny · policy v3",
    });
    expect(database.listRulesForMember).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-0000000000aa",
      routing.organization.id,
    );
  });

  test("answers a refused credential as the tester answers a refusal", async () => {
    database.assertCurrent.mockRejectedValue(
      new DomainError(
        "forbidden",
        "Current human authorization is no longer active",
      ),
    );

    expect(
      await testRoutingRuleAction(initialRoutingActionState, testForm()),
    ).toEqual({
      status: "error",
      message: "Only organization owners and admins can manage routing.",
    });
    expect(database.listRulesForMember).not.toHaveBeenCalled();
  });
});

/*
  Plan 13, F.2.1: each rule form reaches the command the transport will reach —
  one command on the tenant bus per form, by name, with the signed-in person's
  command context, the organisation from the session, the rule's fields from
  the form, and the version and key as the bus's meta.
*/
describe("each rule form reaches its routing command", () => {
  const source = "00000000-0000-4000-8000-0000000000c1";
  const lane = "00000000-0000-4000-8000-0000000000e1";
  const agent = "00000000-0000-4000-8000-0000000000f1";
  const ruleId = "00000000-0000-4000-8000-0000000000b1";

  const fields = {
    sourceProjectId: source,
    targetProjectId: target,
    decision: "deny",
    requestTypes: ["bug", "feature"],
    priorities: ["urgent"],
    humanRoles: [] as string[],
    laneIds: [lane],
    agentPrincipalIds: [agent],
  };
  const ruleInput = {
    organizationId: routing.organization.id,
    sourceKind: "project",
    sourceProjectId: source,
    targetProjectId: target,
    decision: "deny",
    requestTypes: ["bug", "feature"],
    laneIds: [lane],
    priorities: ["urgent"],
    humanRoles: [],
    agentPrincipalIds: [agent],
    enabled: true,
  };

  const cases: Array<{
    action: typeof createRoutingRuleAction;
    command: keyof typeof routingCommandInputSchemas;
    form: Record<string, string | string[]>;
    input: Record<string, unknown>;
    meta: { expectedVersion: number; idempotencyKey: string };
    message: string;
  }> = [
    {
      action: createRoutingRuleAction,
      command: "create_routing_rule",
      // A create form carries no version; the bus is told the rule is new.
      form: { ...fields, expectedVersion: "9" },
      input: ruleInput,
      meta: { expectedVersion: 0, idempotencyKey: key },
      message: "Routing rule created.",
    },
    {
      action: updateRoutingRuleAction,
      command: "update_routing_rule",
      form: { ...fields, ruleId, expectedVersion: "4" },
      input: { ...ruleInput, ruleId },
      meta: { expectedVersion: 4, idempotencyKey: key },
      message: "Routing rule updated.",
    },
    {
      action: disableRoutingRuleAction,
      command: "disable_routing_rule",
      form: { ...fields, ruleId, expectedVersion: "4" },
      input: { organizationId: routing.organization.id, ruleId },
      meta: { expectedVersion: 4, idempotencyKey: key },
      message: "Routing rule disabled.",
    },
  ];

  function form(values: Record<string, string | string[]>) {
    const data = new FormData();
    data.set("idempotencyKey", key);
    for (const [name, value] of Object.entries(values))
      for (const one of Array.isArray(value) ? value : [value])
        data.append(name, one);
    return data;
  }

  test("the three forms name the three rule commands, each once", () => {
    expect(cases.map((entry) => entry.command).sort()).toEqual(
      Object.keys(routingCommandInputSchemas).sort(),
    );
    expect(new Set(cases.map((entry) => entry.action)).size).toBe(3);
  });

  test.each(cases.map((entry) => [entry.action.name, entry] as const))(
    "%s dispatches its command on the tenant bus, as the signed-in person",
    async (_, entry) => {
      const state = await entry.action(
        initialRoutingActionState,
        form(entry.form),
      );

      expect(state).toEqual({ status: "success", message: entry.message });
      expect(routing.humanCommandContext).toHaveBeenCalledOnce();
      expect(routing.humanCommandContext).toHaveBeenCalledWith(
        routing.session,
        routing.organization.id,
      );
      expect(routing.execute).toHaveBeenCalledOnce();
      const sent = routing.execute.mock.calls[0]?.[0];
      expect(sent).toStrictEqual({
        name: entry.command,
        context: routing.humanCommandContext.mock.results[0]?.value,
        meta: entry.meta,
        input: entry.input,
      });
      // The command the form names is one the bus holds, and it accepts what
      // the form sends.
      const definition = createCoreCommandRegistry().resolve(entry.command);
      expect(definition).toBeDefined();
      expect(() => definition?.parse(sent.input)).not.toThrow();
      // And the bus can take its receipt's hash of what the definition
      // parsed, which is its next step.
      expect(() =>
        normalizedInputHash(definition?.parse(sent.input)),
      ).not.toThrow();
    },
  );

  test("a create with no source sends a direct request's rule for the roles it names", async () => {
    expect(
      await createRoutingRuleAction(
        initialRoutingActionState,
        form({
          ...fields,
          sourceProjectId: "",
          humanRoles: ["member", "admin"],
          agentPrincipalIds: [],
        }),
      ),
    ).toEqual({ status: "success", message: "Routing rule created." });
    const sent = routing.execute.mock.calls[0]?.[0];
    const { sourceProjectId: _source, ...direct } = ruleInput;
    expect(sent.input).toStrictEqual({
      ...direct,
      sourceKind: "human_direct",
      humanRoles: ["member", "admin"],
      agentPrincipalIds: [],
    });
    expect(() =>
      createCoreCommandRegistry()
        .resolve("create_routing_rule")
        ?.parse(sent.input),
    ).not.toThrow();
  });

  /*
    A rule with no source names no source project: the key is absent, not
    `undefined`. The bus hashes the parsed input for its receipt
    (`normalizedInputHash`), which refuses `undefined` as not JSON-safe, and
    the schema keeps a key it was given as `undefined`. Sent with the key,
    every create or update of a person-direct rule from the settings form was
    answered "Check the rule values and try again." without reaching the
    repository.
  */
  test.each([
    ["createRoutingRuleAction", createRoutingRuleAction, {}],
    [
      "updateRoutingRuleAction",
      updateRoutingRuleAction,
      { ruleId, expectedVersion: "4" },
    ],
  ] as const)(
    "%s sends a person-direct rule the bus can hash",
    async (_, action, extra) => {
      expect(
        await action(
          initialRoutingActionState,
          form({
            ...fields,
            ...extra,
            sourceProjectId: "",
            agentPrincipalIds: [],
          }),
        ),
      ).toMatchObject({ status: "success" });
      const sent = routing.execute.mock.calls[0]?.[0];
      const parsed = createCoreCommandRegistry()
        .resolve(sent.name)
        ?.parse(sent.input);
      expect(() => normalizedInputHash(parsed)).not.toThrow();
      expect(Object.hasOwn(sent.input, "sourceProjectId")).toBe(false);
    },
  );

  test.each(cases.map((entry) => [entry.action.name, entry] as const))(
    "%s refuses a malformed submission without reaching the bus",
    async (_, entry) => {
      const data = form(entry.form);
      data.set("idempotencyKey", "short");
      const state = await entry.action(initialRoutingActionState, data);

      expect(state).toMatchObject({ status: "error" });
      expect(routing.execute).not.toHaveBeenCalled();
    },
  );
});
