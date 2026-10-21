import { describe, expect, test, vi } from "vitest";

import { agentScopes } from "../agents/agent-types.js";
import {
  coreCommandInputSchemas,
  createCoreEventSchemaRegistry,
} from "../core/core-commands.js";
import { EventFactory } from "../events/event-factory.js";
import { operatorActor, operatorScopes } from "../operators/operator-types.js";
import type {
  ActorRef,
  AuthorizedCommandContext,
} from "../shared/authorization.js";
import { DomainError } from "../shared/errors.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";
import {
  administrationBasePath,
  capabilityRegistry,
  findMcpToolTransport,
  findQueryCapability,
  findRestCommandTransport,
  restApiBasePath,
  restQueryTransports,
} from "../transport-metadata.js";
import {
  createRoutingCommandDefinitions,
  routingCommandInputSchemas,
} from "./routing-commands.js";
import {
  evaluateRouteForMember,
  type RouteEvaluationSources,
} from "./routing-service.js";
import type { RoutingRule } from "./routing-types.js";

/*
  The routing rule commands' authorisation and the one route-evaluation entry
  (Plan 13, F.2.1), against fakes. What a real database answers is
  `packages/db/src/repositories/routing-repository.integration.test.ts`'s.
*/

const organizationId = "8f6b0f2a-0000-4000-8000-000000000010";
const otherOrganizationId = "8f6b0f2a-0000-4000-8000-000000000011";
const sourceProjectId = "8f6b0f2a-0000-4000-8000-000000000020";
const targetProjectId = "8f6b0f2a-0000-4000-8000-000000000021";
const laneId = "8f6b0f2a-0000-4000-8000-000000000030";
const agentPrincipalId = "8f6b0f2a-0000-4000-8000-000000000040";
const ruleId = "8f6b0f2a-0000-4000-8000-000000000050";
const userId = "user_01JQ0000000000000000000021";

function context(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set(["routing:manage", "request:create"]),
    credentialId: "session_1",
    correlationId: "8f6b0f2a-0000-4000-8000-0000000000cc",
    ...overrides,
  };
}

const machineActors: Array<[string, ActorRef]> = [
  ["an agent", { type: "agent", id: agentPrincipalId }],
  [
    "a service actor",
    {
      type: "service",
      id: "operator:probe",
      originatingActor: { type: "user", id: userId },
    },
  ],
];

function rule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: ruleId,
    organizationId,
    sourceKind: "human_direct",
    targetProjectId,
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

describe("the routing rule commands", () => {
  function definitions() {
    return createRoutingCommandDefinitions({
      events: new EventFactory(createCoreEventSchemaRegistry()),
    });
  }

  function unitOfWork(canManage: (id: string, actor: ActorRef) => boolean) {
    const port = {
      canManage: vi.fn(async (id, actor) => canManage(id, actor)),
    };
    const uow = {
      port: (name: string) => {
        if (name !== "routing") throw new Error(`unexpected port ${name}`);
        return port;
      },
    } as unknown as UnitOfWork;
    return { uow, port };
  }

  const inputs: Record<string, Record<string, unknown>> = {
    create_routing_rule: {
      organizationId,
      sourceKind: "human_direct",
      targetProjectId,
      decision: "deny",
    },
    update_routing_rule: {
      organizationId,
      ruleId,
      sourceKind: "human_direct",
      targetProjectId,
      decision: "deny",
    },
    disable_routing_rule: { organizationId, ruleId },
  };

  /*
    Against the real event registry, which is the only arrangement in which a
    payload can fail its own schema (as `request-events.test.ts` does for the
    request events). `routing_rule.changed.v1` names the rule `ruleId`; the
    command's answer to its caller names it `id`.
  */
  test("each rule command's event passes its own schema, naming the rule ruleId", async () => {
    const stored = rule({ version: 2 });
    const port = {
      createRule: vi.fn(async () => ({ ...stored, version: 1 })),
      updateRule: vi.fn(async () => stored),
      disableRule: vi.fn(async () => ({ ...stored, enabled: false })),
    };
    const uow = { port: () => port } as unknown as UnitOfWork;
    const changes: Record<string, [string, number, boolean]> = {
      create_routing_rule: ["created", 1, true],
      update_routing_rule: ["updated", 2, true],
      disable_routing_rule: ["disabled", 2, false],
    };
    for (const definition of definitions()) {
      const input = definition.parse(inputs[definition.name]);
      const executed = await definition.execute(uow, context(), input, {
        idempotencyKey: "routing-events-0000000000",
        expectedVersion: definition.name === "create_routing_rule" ? 0 : 1,
      });
      const [changeType, version, enabled] = changes[definition.name] ?? [];
      expect(executed.result, definition.name).toMatchObject({
        id: ruleId,
        version,
      });
      expect(
        executed.events.map((event) => event.data),
        definition.name,
      ).toEqual([
        {
          changeType,
          ruleId,
          version,
          decision: "deny",
          sourceKind: "human_direct",
          sourceProjectId: null,
          targetProjectId,
          enabled,
        },
      ]);
    }
  });

  test.each(machineActors)(
    "%s holding routing:manage is refused before the routing port is asked",
    async (_, actor) => {
      for (const definition of definitions()) {
        const { uow, port } = unitOfWork(() => true);
        const input = definition.parse(inputs[definition.name]);
        const error = await definition
          .authorize(context({ actor }), input, uow)
          .then(
            () => undefined,
            (caught: unknown) => caught,
          );
        expect(error, definition.name).toBeInstanceOf(DomainError);
        expect((error as DomainError).code, definition.name).toBe("forbidden");
        expect((error as DomainError).message, definition.name).toBe(
          "Routing requires a person or an operator credential",
        );
        expect(port.canManage, definition.name).not.toHaveBeenCalled();
      }
    },
  );

  test("a person's authority is asked of the port as that person", async () => {
    for (const definition of definitions()) {
      const { uow, port } = unitOfWork(() => true);
      const input = definition.parse(inputs[definition.name]);
      await definition.authorize(context(), input, uow);
      expect(port.canManage, definition.name).toHaveBeenCalledWith(
        organizationId,
        { type: "user", id: userId },
      );
    }
  });

  test("a person the port does not admit is refused", async () => {
    for (const definition of definitions()) {
      const { uow } = unitOfWork(() => false);
      const input = definition.parse(inputs[definition.name]);
      await expect(
        definition.authorize(context(), input, uow),
        definition.name,
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "Organization routing authority is required",
      });
    }
  });

  test("without routing:manage, or for another organisation, nothing is asked", async () => {
    for (const definition of definitions()) {
      const { uow, port } = unitOfWork(() => true);
      const input = definition.parse(inputs[definition.name]);
      await expect(
        definition.authorize(
          context({ scopes: new Set(["request:create"]) }),
          input,
          uow,
        ),
      ).rejects.toMatchObject({ details: { scope: "routing:manage" } });
      await expect(
        definition.authorize(
          context({ organizationId: otherOrganizationId }),
          input,
          uow,
        ),
      ).rejects.toMatchObject({ message: "Organization access is denied" });
      expect(port.canManage, definition.name).not.toHaveBeenCalled();
    }
  });
});

describe("the route evaluation entry, shared by the tester and the preview", () => {
  function sources(
    options: {
      role?: "owner" | "admin" | "member" | null;
      rules?: RoutingRule[] | null;
      projects?: Array<{ id: string; status: string; canRepresent: boolean }>;
    } = {},
  ) {
    const role = options.role === undefined ? "member" : options.role;
    const fakes = {
      findActiveOrganizationForUser: vi.fn(async () =>
        role === null
          ? null
          : { id: organizationId, name: "Tenant", slug: "tenant", role },
      ),
      listOrganizationProjects: vi.fn(async () =>
        (options.projects ?? []).map((project) => ({
          name: "Project",
          slug: "project",
          keyPrefix: "PRJ",
          defaultRepository: null,
          ...project,
        })),
      ),
      listRulesForMember: vi.fn(async () =>
        options.rules === undefined ? [] : options.rules,
      ),
    };
    const wired = {
      rules: { listRulesForMember: fakes.listRulesForMember },
      members: {
        findActiveOrganizationForUser: fakes.findActiveOrganizationForUser,
        listOrganizationProjects: fakes.listOrganizationProjects,
      },
    } as unknown as RouteEvaluationSources;
    return { fakes, wired };
  }

  const target = {
    organizationId,
    targetProjectId,
    requestType: "feature",
    priority: "normal",
  } as const;

  test("evaluates for the member, with the role the organisation records and the context's scopes", async () => {
    const { fakes, wired } = sources({
      role: "admin",
      rules: [rule({ humanRoles: ["admin"], specificity: 1_099 })],
    });
    const decision = await evaluateRouteForMember(wired, context(), {
      ...target,
      purpose: "test",
    });
    expect(decision).toEqual({
      allowed: false,
      reason: "matched_deny",
      matchedRuleId: ruleId,
      policyVersion: 3,
      evaluatedConstraints: ["human_role"],
    });
    expect(fakes.findActiveOrganizationForUser).toHaveBeenCalledWith(
      userId,
      organizationId,
    );
    expect(fakes.listRulesForMember).toHaveBeenCalledWith(
      userId,
      organizationId,
    );

    const other = sources({
      role: "member",
      rules: [rule({ humanRoles: ["admin"], specificity: 1_099 })],
    });
    expect(
      await evaluateRouteForMember(other.wired, context(), {
        ...target,
        purpose: "preview",
      }),
    ).toMatchObject({ allowed: true, reason: "default_same_org" });
  });

  test("human-direct needs request:create among the context's scopes", async () => {
    const { wired } = sources();
    expect(
      await evaluateRouteForMember(
        wired,
        context({ scopes: new Set(["routing:manage"]) }),
        { ...target, purpose: "test" },
      ),
    ).toMatchObject({ allowed: false, reason: "no_matching_permission" });
  });

  test("the tester may name an agent principal and a lane, and is not asked to represent the source", async () => {
    const { fakes, wired } = sources({
      rules: [
        rule({
          sourceKind: "project",
          sourceProjectId,
          decision: "allow",
          agentPrincipalIds: [agentPrincipalId],
          laneIds: [laneId],
          specificity: 3_297,
        }),
      ],
    });
    const decision = await evaluateRouteForMember(wired, context(), {
      ...target,
      purpose: "test",
      sourceProjectId,
      laneId,
      agentPrincipalId,
    });
    expect(decision).toMatchObject({
      allowed: true,
      reason: "matched_allow",
      matchedRuleId: ruleId,
    });
    expect(fakes.listOrganizationProjects).not.toHaveBeenCalled();
  });

  test("the preview answers a source project the member cannot represent as today, reading no rule", async () => {
    for (const projects of [
      [],
      [{ id: sourceProjectId, status: "active", canRepresent: false }],
      [{ id: sourceProjectId, status: "archived", canRepresent: true }],
    ]) {
      const { fakes, wired } = sources({ projects });
      expect(
        await evaluateRouteForMember(wired, context(), {
          ...target,
          purpose: "preview",
          sourceProjectId,
        }),
      ).toEqual({
        allowed: false,
        reason: "no_matching_permission",
        policyVersion: 0,
        evaluatedConstraints: ["source_project"],
      });
      expect(fakes.listRulesForMember).not.toHaveBeenCalled();
    }
  });

  test("the preview evaluates a source project the member can represent", async () => {
    const { fakes, wired } = sources({
      projects: [{ id: sourceProjectId, status: "active", canRepresent: true }],
      rules: [
        rule({
          sourceKind: "project",
          sourceProjectId,
          specificity: 1_099,
        }),
      ],
    });
    expect(
      await evaluateRouteForMember(wired, context(), {
        ...target,
        purpose: "preview",
        sourceProjectId,
      }),
    ).toMatchObject({ allowed: false, reason: "matched_deny" });
    expect(fakes.listOrganizationProjects).toHaveBeenCalledWith(
      userId,
      organizationId,
    );
  });

  test("the preview names no agent principal and no lane", async () => {
    const { wired } = sources();
    for (const extra of [{ agentPrincipalId }, { laneId }]) {
      await expect(
        evaluateRouteForMember(wired, context(), {
          ...target,
          purpose: "preview",
          ...extra,
        }),
      ).rejects.toMatchObject({ name: "ZodError" });
    }
  });

  test("a member not active in an active organisation is refused", async () => {
    for (const options of [{ role: null }, { rules: null }] as const) {
      const { wired } = sources(options);
      await expect(
        evaluateRouteForMember(wired, context(), {
          ...target,
          purpose: "preview",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  test("each purpose checks its scope: routing:manage to test, request:create to preview", async () => {
    const { fakes, wired } = sources();
    await expect(
      evaluateRouteForMember(
        wired,
        context({ scopes: new Set(["request:create"]) }),
        { ...target, purpose: "test" },
      ),
    ).rejects.toMatchObject({ details: { scope: "routing:manage" } });
    await expect(
      evaluateRouteForMember(
        wired,
        context({ scopes: new Set(["routing:manage"]) }),
        { ...target, purpose: "preview" },
      ),
    ).rejects.toMatchObject({ details: { scope: "request:create" } });
    expect(fakes.findActiveOrganizationForUser).not.toHaveBeenCalled();
  });

  test.each(machineActors)(
    "%s is refused before anything is read",
    async (_, actor) => {
      const { fakes, wired } = sources();
      await expect(
        evaluateRouteForMember(wired, context({ actor }), {
          ...target,
          purpose: "test",
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "Routing requires a person or an operator credential",
      });
      expect(fakes.findActiveOrganizationForUser).not.toHaveBeenCalled();
      expect(fakes.listRulesForMember).not.toHaveBeenCalled();
    },
  );

  test("another organisation than the context's is refused before anything is read", async () => {
    const { fakes, wired } = sources();
    await expect(
      evaluateRouteForMember(wired, context(), {
        ...target,
        organizationId: otherOrganizationId,
        purpose: "test",
      }),
    ).rejects.toMatchObject({ message: "Organization access is denied" });
    expect(fakes.findActiveOrganizationForUser).not.toHaveBeenCalled();
  });
});

/*
  Plan 13, F.2.1's registry half: an operator credential reaches the three
  rule commands and both purposes of the evaluation entry over REST. Each
  takes the member from `memberAuthority` — the operator's issuing member,
  never `operator:<lineage>` — and refuses an operator bound to a project,
  because a routing rule and a route's evaluation are the organisation's.
*/
describe("an operator credential", () => {
  const lineageId = "8f6b0f2a-0000-4000-8000-0000000000f1";
  const memberUserId = "user_01JQ00000000000000000000F2";

  function operatorContext(
    overrides: Partial<AuthorizedCommandContext> = {},
  ): AuthorizedCommandContext {
    return context({
      actor: operatorActor({ lineageId, memberUserId }),
      credentialKind: "operator",
      projectId: null,
      credentialId: "8f6b0f2a-0000-4000-8000-0000000000f3",
      ...overrides,
    });
  }

  function definitions() {
    return createRoutingCommandDefinitions({
      events: new EventFactory(createCoreEventSchemaRegistry()),
    });
  }

  const inputs: Record<string, Record<string, unknown>> = {
    create_routing_rule: {
      organizationId,
      sourceKind: "human_direct",
      targetProjectId,
      decision: "deny",
    },
    update_routing_rule: {
      organizationId,
      ruleId,
      sourceKind: "human_direct",
      targetProjectId,
      decision: "deny",
    },
    disable_routing_rule: { organizationId, ruleId },
  };

  function routingPort(admit = true) {
    const stored = rule({ version: 2 });
    const port = {
      canManage: vi.fn(async () => admit),
      createRule: vi.fn(async () => ({ ...stored, version: 1 })),
      updateRule: vi.fn(async () => stored),
      disableRule: vi.fn(async () => ({ ...stored, enabled: false })),
    };
    const uow = { port: () => port } as unknown as UnitOfWork;
    return { uow, port };
  }

  test("each rule command asks the port about the operator's member, never its own actor", async () => {
    for (const definition of definitions()) {
      const { uow, port } = routingPort();
      const input = definition.parse(inputs[definition.name]);
      await definition.authorize(operatorContext(), input, uow);
      expect(port.canManage, definition.name).toHaveBeenCalledWith(
        organizationId,
        { type: "user", id: memberUserId },
      );
    }
  });

  test("an operator whose member the port does not admit is refused", async () => {
    for (const definition of definitions()) {
      const { uow } = routingPort(false);
      const input = definition.parse(inputs[definition.name]);
      await expect(
        definition.authorize(operatorContext(), input, uow),
        definition.name,
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "Organization routing authority is required",
      });
    }
  });

  test("an operator bound to a project is refused every rule command before the port is asked", async () => {
    for (const definition of definitions()) {
      const { uow, port } = routingPort();
      const input = definition.parse(inputs[definition.name]);
      await expect(
        definition.authorize(
          operatorContext({ projectId: targetProjectId }),
          input,
          uow,
        ),
        definition.name,
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "Operator project access is denied",
      });
      expect(port.canManage, definition.name).not.toHaveBeenCalled();
    }
  });

  test("an operator without routing:manage is refused naming the scope", async () => {
    for (const definition of definitions()) {
      const { uow, port } = routingPort();
      const input = definition.parse(inputs[definition.name]);
      await expect(
        definition.authorize(
          operatorContext({ scopes: new Set(["request:create"]) }),
          input,
          uow,
        ),
        definition.name,
      ).rejects.toMatchObject({ details: { scope: "routing:manage" } });
      expect(port.canManage, definition.name).not.toHaveBeenCalled();
    }
  });

  test("a context claiming the operator kind without its shape is refused", async () => {
    for (const actor of [
      { type: "user", id: memberUserId },
      { type: "service", id: "operator:" },
    ] as const) {
      for (const definition of definitions()) {
        const { uow, port } = routingPort();
        const input = definition.parse(inputs[definition.name]);
        await expect(
          definition.authorize(
            context({ actor, credentialKind: "operator" }),
            input,
            uow,
          ),
          definition.name,
        ).rejects.toMatchObject({ code: "forbidden" });
        expect(port.canManage, definition.name).not.toHaveBeenCalled();
      }
    }
  });

  test("a rule an operator creates records the operator as its author, and a person's the person", async () => {
    for (const [who, actingContext, author] of [
      ["an operator", operatorContext(), `service:operator:${lineageId}`],
      ["a person", context(), `user:${userId}`],
    ] as const) {
      const { uow, port } = routingPort();
      const [create] = definitions();
      if (!create) throw new Error("no create_routing_rule");
      await create.execute(
        uow,
        actingContext,
        create.parse(inputs.create_routing_rule),
        { idempotencyKey: "routing-author-000000000", expectedVersion: 0 },
      );
      expect(port.createRule, who).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: author }),
      );
    }
  });

  describe("the evaluation entry", () => {
    function sources(role: "owner" | "admin" | "member" = "member") {
      const fakes = {
        findActiveOrganizationForUser: vi.fn(async () => ({
          id: organizationId,
          name: "Tenant",
          slug: "tenant",
          role,
        })),
        listOrganizationProjects: vi.fn(async () => [
          {
            id: sourceProjectId,
            status: "active",
            canRepresent: true,
            name: "Project",
            slug: "project",
            keyPrefix: "PRJ",
            defaultRepository: null,
          },
        ]),
        listRulesForMember: vi.fn(async () => [
          rule({ humanRoles: ["admin"], specificity: 1_099 }),
        ]),
      };
      const wired = {
        rules: { listRulesForMember: fakes.listRulesForMember },
        members: {
          findActiveOrganizationForUser: fakes.findActiveOrganizationForUser,
          listOrganizationProjects: fakes.listOrganizationProjects,
        },
      } as unknown as RouteEvaluationSources;
      return { fakes, wired };
    }

    const route = {
      organizationId,
      targetProjectId,
      requestType: "feature",
      priority: "normal",
    } as const;

    test.each(["test", "preview"] as const)(
      "%s evaluates for the operator's member, with the role the organisation records",
      async (purpose) => {
        const { fakes, wired } = sources("admin");
        expect(
          await evaluateRouteForMember(wired, operatorContext(), {
            ...route,
            purpose,
            sourceProjectId,
          }),
        ).toMatchObject({ allowed: true, reason: "default_same_org" });
        expect(
          await evaluateRouteForMember(wired, operatorContext(), {
            ...route,
            purpose,
          }),
        ).toMatchObject({
          allowed: false,
          reason: "matched_deny",
          matchedRuleId: ruleId,
        });
        for (const read of [
          fakes.findActiveOrganizationForUser,
          fakes.listRulesForMember,
        ]) {
          for (const call of read.mock.calls)
            expect(call).toEqual([memberUserId, organizationId]);
        }
        if (purpose === "preview")
          expect(fakes.listOrganizationProjects).toHaveBeenCalledWith(
            memberUserId,
            organizationId,
          );
      },
    );

    test("the principal carries the operator's scopes: without request:create a person-direct test answers no_matching_permission", async () => {
      const { wired } = sources("admin");
      expect(
        await evaluateRouteForMember(
          wired,
          operatorContext({ scopes: new Set(["routing:manage"]) }),
          { ...route, purpose: "test" },
        ),
      ).toMatchObject({
        allowed: false,
        reason: "no_matching_permission",
        evaluatedConstraints: ["human_direct", "request:create"],
      });
    });

    test.each(["test", "preview"] as const)(
      "%s refuses an operator bound to a project before anything is read",
      async (purpose) => {
        const { fakes, wired } = sources();
        await expect(
          evaluateRouteForMember(
            wired,
            operatorContext({ projectId: targetProjectId }),
            { ...route, purpose },
          ),
        ).rejects.toMatchObject({
          code: "forbidden",
          message: "Operator project access is denied",
        });
        expect(fakes.findActiveOrganizationForUser).not.toHaveBeenCalled();
        expect(fakes.listRulesForMember).not.toHaveBeenCalled();
      },
    );
  });
});

/*
  The registry entries (Plan 13, F.2.1's registry half, as its log's "After
  F.3" list sets them): each rule command is a REST command an operator alone
  reaches, with no MCP tool (ruling 2), bound to the credential's
  organisation by the route and checking `routing:manage`, which an operator
  may carry and no agent grant can. The rules read and the two purposes of
  route evaluation are REST only, under the administration prefix, operator
  only, and bound to the organisation.
*/
describe("the registry entries", () => {
  const ruleCommands = [
    "create_routing_rule",
    "update_routing_rule",
    "disable_routing_rule",
  ] as const;

  test.each(ruleCommands)(
    "%s is a REST command an operator alone reaches, with no MCP tool",
    (name) => {
      const transport = findRestCommandTransport(name);
      expect(transport).toEqual({
        name,
        method: "POST",
        path: `${restApiBasePath}/commands/${name}`,
        dispatch: { to: "command-bus", commandName: name },
        inputSchema: coreCommandInputSchemas[name],
        injectedFields: [
          { field: "organizationId", from: "credential.organizationId" },
        ],
        scope: { kind: "fixed", scope: "routing:manage", checkedBy: "command" },
        routeRequiresProject: false,
        rateLimitClass: "mutation",
        mcpTool: null,
        credentialKinds: ["operator"],
      });
      expect(transport?.inputSchema).toBe(routingCommandInputSchemas[name]);
      expect(findMcpToolTransport(name)).toBeUndefined();
    },
  );

  const reads = [
    [
      "list_administration_routing_rules",
      "/routing-rules",
      "routing:manage",
      [],
    ],
    [
      "test_administration_route",
      "/route-evaluations/test",
      "routing:manage",
      [
        "sourceProjectId",
        "targetProjectId",
        "requestType",
        "priority",
        "laneId",
        "agentPrincipalId",
      ],
    ],
    [
      "preview_administration_route",
      "/route-evaluations/preview",
      "request:create",
      ["sourceProjectId", "targetProjectId", "requestType", "priority"],
    ],
  ] as const;

  test.each(reads)(
    "%s is REST only, under the administration prefix, for an organisation-wide operator",
    (name, path, scope, parameters) => {
      const entry = findQueryCapability(name);
      expect(entry).toMatchObject({
        kind: "query",
        name,
        dispatch: { to: "administration-read", method: name },
        binding: "organization",
        scope,
        rest: {
          method: "GET",
          path: `${administrationBasePath}${path}`,
          pathParameters: [],
          routeRequiresProject: false,
          rateLimitClass: "token",
        },
        mcpTool: null,
        credentialKinds: ["operator"],
      });
      expect(
        entry?.rest.queryParameters.map((parameter) => parameter.name),
      ).toEqual(parameters);
      for (const parameter of entry?.rest.queryParameters ?? [])
        expect(parameter.repeated, parameter.name).toBe(false);
      expect(
        restQueryTransports.filter((transport) => transport.name === name),
      ).toHaveLength(1);
      expect(findMcpToolTransport(name)).toBeUndefined();
      expect(operatorScopes).toContain(scope);
    },
  );

  test("the evaluation parameters describe the values the entry accepts", () => {
    const parameters = Object.fromEntries(
      (
        findQueryCapability("test_administration_route")?.rest
          .queryParameters ?? []
      ).map((parameter) => [parameter.name, parameter.valueSchema]),
    );
    for (const name of [
      "sourceProjectId",
      "targetProjectId",
      "laneId",
      "agentPrincipalId",
    ]) {
      expect(parameters[name]?.safeParse(targetProjectId).success, name).toBe(
        true,
      );
      expect(parameters[name]?.safeParse("not-a-uuid").success, name).toBe(
        false,
      );
    }
    expect(parameters.requestType?.safeParse("feature").success).toBe(true);
    expect(parameters.requestType?.safeParse("chore-ish").success).toBe(false);
    expect(parameters.priority?.safeParse("normal").success).toBe(true);
    expect(parameters.priority?.safeParse("whenever").success).toBe(false);
  });

  test("routing:manage is a scope an operator may carry and no agent grant can; request:create an operator may carry too", () => {
    expect(operatorScopes).toContain("routing:manage");
    expect(agentScopes as readonly string[]).not.toContain("routing:manage");
    // Agents hold request:create; an operator carrying it reaches only the
    // entries that name `"operator"`, of which the preview is the one that
    // checks it.
    expect(operatorScopes).toContain("request:create");
  });

  test("the entries come after every earlier entry, commands then reads, in declaration order", () => {
    const at = (name: string) =>
      capabilityRegistry.findIndex((entry) => entry.name === name);
    const positions = [...ruleCommands, ...reads.map(([name]) => name)].map(at);
    expect(
      positions.every(
        (position) => position > at("get_administration_project_settings"),
      ),
    ).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
