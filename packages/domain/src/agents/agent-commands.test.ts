import { describe, expect, test } from "vitest";

import { createCoreCommandRegistry } from "../core/core-commands.js";
import {
  agentRevokeScope,
  operatorActor,
  operatorExcludedScopes,
  operatorOnlyScopes,
  operatorScopes,
} from "../operators/operator-types.js";
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
} from "../transport-metadata.js";
import {
  agentAdministrationInputSchemas,
  agentCommandInputSchemas,
} from "./agent-commands.js";
import { agentScopes } from "./agent-types.js";

/*
  Plan 13, F.2.2's registry half: `set_agent_principal_status` takes the
  acting member from `memberAuthority(context)` (F3-2), so an operator
  credential acts with its issuing member's authority and a person with their
  own. An operator is held to `agent:revoke` (a person to `agent:manage`), may
  only suspend (ruling 3), and when bound to a project may act only on a
  principal of that project. The port is asked `canManage` about the member,
  as a person, and the write is handed the context's actor, which the
  repository records. Run against a fake port, so what is proved is what the
  command hands the repository and when it refuses before reaching it.
*/

const organizationId = "018f0000-0000-7000-8000-0000000f2201";
const projectId = "018f0000-0000-7000-8000-0000000f2202";
const otherProjectId = "018f0000-0000-7000-8000-0000000f2203";
const agentPrincipalId = "018f0000-0000-7000-8000-0000000f2204";
const lineageId = "018f0000-0000-7000-8000-0000000f2205";
const memberUserId = "user_f22_member";
const personUserId = "user_f22_person";

function operatorContext(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator",
    organizationId,
    projectId: null,
    laneIds: new Set(),
    scopes: new Set([agentRevokeScope]),
    credentialId: "018f0000-0000-7000-8000-0000000f2206",
    correlationId: "f22-correlation",
    ...overrides,
  };
}

function personContext(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: personUserId },
    organizationId,
    scopes: new Set(["agent:manage"]),
    credentialId: "session_f22",
    correlationId: "f22-correlation",
    ...overrides,
  };
}

type CanManageInput = {
  organizationId: string;
  projectId: string | null;
  actor: ActorRef;
};

/** An `agents` port that records what it was asked, and answers yes. */
function recordingUnitOfWork(principalProjectId: string | null = projectId) {
  const calls: string[] = [];
  const asked: CanManageInput[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const principal = {
    id: agentPrincipalId,
    organizationId,
    projectId: principalProjectId,
    displayName: "Deploy bot",
    slug: "deploy-bot",
    softwareName: null,
    status: "active" as const,
    version: 1,
    createdByUserId: memberUserId,
    createdAt: new Date("2026-09-29T00:00:00.000Z"),
    updatedAt: new Date("2026-09-29T00:00:00.000Z"),
  };
  const port = {
    async findPrincipal() {
      calls.push("findPrincipal");
      return principal;
    },
    async canManage(input: CanManageInput) {
      calls.push("canManage");
      asked.push(input);
      return true;
    },
    async setPrincipalStatus(input: Record<string, unknown>) {
      calls.push("setPrincipalStatus");
      writes.push(input);
      return {
        principal: {
          ...principal,
          status: input.status as "suspended",
          version: 2,
        },
        previousStatus: "active" as const,
      };
    },
  };
  const uow = { port: <T>() => port as T } as unknown as UnitOfWork;
  return { uow, calls, asked, writes };
}

async function run(
  context: AuthorizedCommandContext,
  options: {
    status?: "active" | "suspended" | "revoked";
    principalProjectId?: string | null;
  } = {},
) {
  const definition = createCoreCommandRegistry().resolve(
    "set_agent_principal_status",
  );
  if (!definition) throw new Error("No set_agent_principal_status");
  const parsed = definition.parse({
    organizationId,
    agentPrincipalId,
    status: options.status ?? "suspended",
    reason: "Suspended while its key is rotated",
  });
  const recorded = recordingUnitOfWork(
    options.principalProjectId === undefined
      ? projectId
      : options.principalProjectId,
  );
  try {
    await definition.authorize(context, parsed, recorded.uow);
    const outcome = await definition.execute(recorded.uow, context, parsed, {
      idempotencyKey: "f22-idempotency-key-0001",
      expectedVersion: 1,
    });
    return { ...recorded, outcome, error: null };
  } catch (error) {
    return { ...recorded, outcome: null, error };
  }
}

function refusal(error: unknown) {
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe("set_agent_principal_status acts for memberAuthority(context)", () => {
  test("an organisation-wide operator suspends, asking about its member as a person and recording its own actor", async () => {
    const context = operatorContext();
    const result = await run(context);
    expect(result.error).toBeNull();
    expect(result.calls).toEqual([
      "findPrincipal",
      "canManage",
      "setPrincipalStatus",
    ]);
    expect(result.asked).toEqual([
      {
        organizationId,
        projectId,
        actor: { type: "user", id: memberUserId },
      },
    ]);
    expect(result.writes[0]).toMatchObject({
      organizationId,
      agentPrincipalId,
      status: "suspended",
      expectedVersion: 1,
      actor: context.actor,
      correlationId: context.correlationId,
    });
    expect(result.outcome?.events[0]?.actor).toEqual(context.actor);
  });

  test("a person suspends as themselves, as before", async () => {
    const context = personContext();
    const result = await run(context);
    expect(result.error).toBeNull();
    expect(result.asked[0]?.actor).toEqual({ type: "user", id: personUserId });
    expect(result.writes[0]).toMatchObject({
      actor: { type: "user", id: personUserId },
    });
  });

  test.each(["active", "revoked"] as const)(
    "an operator may not set %s, and the port is never asked",
    async (status) => {
      const result = await run(operatorContext(), { status });
      const error = refusal(result.error);
      expect(error.code).toBe("forbidden");
      expect(error.message).toBe(
        "An operator credential may only suspend an agent",
      );
      expect(result.calls).toEqual([]);
    },
  );

  test.each(["active", "revoked"] as const)(
    "a person may still set %s",
    async (status) => {
      const result = await run(personContext(), { status });
      expect(result.error).toBeNull();
      expect(result.writes[0]).toMatchObject({ status });
    },
  );

  test("an operator without agent:revoke is refused naming it, even holding agent:manage", async () => {
    for (const scopes of [[], ["agent:manage"], ["project:manage"]]) {
      const result = await run(operatorContext({ scopes: new Set(scopes) }));
      const error = refusal(result.error);
      expect(error.code, scopes.join()).toBe("forbidden");
      expect(error.details, scopes.join()).toEqual({ scope: agentRevokeScope });
      expect(result.calls, scopes.join()).toEqual([]);
    }
  });

  test("a person without agent:manage is refused naming it, even holding agent:revoke", async () => {
    const result = await run(
      personContext({ scopes: new Set([agentRevokeScope]) }),
    );
    const error = refusal(result.error);
    expect(error.details).toEqual({ scope: "agent:manage" });
    expect(result.calls).toEqual([]);
  });

  test("an operator bound to the principal's project acts on it", async () => {
    const result = await run(operatorContext({ projectId }));
    expect(result.error).toBeNull();
    expect(result.writes).toHaveLength(1);
  });

  test.each([
    ["another project's principal", otherProjectId],
    ["an organisation-wide principal", null],
  ] as const)(
    "an operator bound to a project is refused %s before canManage is asked",
    async (_, principalProjectId) => {
      const result = await run(operatorContext({ projectId }), {
        principalProjectId,
      });
      const error = refusal(result.error);
      expect(error.code).toBe("forbidden");
      expect(error.message).toBe("Operator project access is denied");
      expect(result.calls).toEqual(["findPrincipal"]);
    },
  );

  test.each([
    [
      "an agent",
      {
        actor: { type: "agent", id: agentPrincipalId },
        scopes: new Set(["agent:manage", agentRevokeScope]),
      },
    ],
    [
      "the worker's own service actor",
      {
        actor: { type: "service", id: "trigger-worker" },
        scopes: new Set(["agent:manage", agentRevokeScope]),
      },
    ],
    [
      "an operator-shaped service actor whose context does not say operator",
      {
        actor: operatorActor({ lineageId, memberUserId }),
        credentialKind: undefined,
        scopes: new Set(["agent:manage", agentRevokeScope]),
      },
    ],
  ] as const)(
    "%s is refused before the port is asked",
    async (_, overrides) => {
      const result = await run(
        operatorContext(overrides as Partial<AuthorizedCommandContext>),
      );
      const error = refusal(result.error);
      expect(error.code).toBe("forbidden");
      expect(error.message).toBe(
        "Agent administration requires a person or an operator credential",
      );
      expect(result.calls).toEqual([]);
    },
  );
});

describe("the registry entries", () => {
  test("set_agent_principal_status is a REST command for an operator holding agent:revoke, and no MCP tool", () => {
    expect(findRestCommandTransport("set_agent_principal_status")).toEqual({
      name: "set_agent_principal_status",
      method: "POST",
      path: `${restApiBasePath}/commands/set_agent_principal_status`,
      dispatch: {
        to: "command-bus",
        commandName: "set_agent_principal_status",
      },
      inputSchema: agentCommandInputSchemas.set_agent_principal_status,
      injectedFields: [
        { field: "organizationId", from: "credential.organizationId" },
      ],
      scope: { kind: "fixed", scope: agentRevokeScope, checkedBy: "command" },
      routeRequiresProject: false,
      rateLimitClass: "mutation",
      mcpTool: null,
      credentialKinds: ["operator"],
    });
    expect(findMcpToolTransport("set_agent_principal_status")).toBeUndefined();
  });

  test.each(
    Object.keys(agentAdministrationInputSchemas) as Array<
      keyof typeof agentAdministrationInputSchemas
    >,
  )(
    "%s is a REST command off the bus, run by the agent administration handler, for an operator holding agent:revoke",
    (name) => {
      expect(findRestCommandTransport(name)).toEqual({
        name,
        method: "POST",
        path: `${restApiBasePath}/commands/${name}`,
        dispatch: { to: "agent-administration", handler: name },
        inputSchema: agentAdministrationInputSchemas[name],
        injectedFields: [
          { field: "organizationId", from: "credential.organizationId" },
        ],
        scope: {
          kind: "fixed",
          scope: agentRevokeScope,
          checkedBy: "agent-auth-service",
        },
        routeRequiresProject: false,
        rateLimitClass: "mutation",
        mcpTool: null,
        credentialKinds: ["operator"],
      });
      expect(findMcpToolTransport(name)).toBeUndefined();
    },
  );

  test("the two revocations' schemas are the ones their forms were parsed with", () => {
    expect(Object.keys(agentAdministrationInputSchemas)).toEqual([
      "revoke_agent_credential",
      "revoke_agent_oauth_grant",
    ]);
    const credential = {
      organizationId,
      agentPrincipalId,
      credentialId: lineageId,
    };
    expect(
      agentAdministrationInputSchemas.revoke_agent_credential.parse(credential),
    ).toEqual(credential);
    const grant = {
      organizationId,
      agentPrincipalId,
      grantId: lineageId,
      reason: "  The laptop holding it was lost  ",
    };
    expect(
      agentAdministrationInputSchemas.revoke_agent_oauth_grant.parse(grant),
    ).toEqual({ ...grant, reason: "The laptop holding it was lost" });
    expect(
      agentAdministrationInputSchemas.revoke_agent_oauth_grant.safeParse({
        ...grant,
        reason: "short",
      }).success,
    ).toBe(false);
  });

  test.each([
    ["list_administration_agent_principals", "/agent-principals", []],
    [
      "get_administration_agent_principal",
      "/agent-principals/{agentPrincipalId}",
      ["agentPrincipalId"],
    ],
  ] as const)(
    "%s is REST only, under the administration prefix, for an operator holding agent:revoke",
    (name, path, pathParameters) => {
      expect(findQueryCapability(name)).toEqual({
        kind: "query",
        name,
        dispatch: { to: "administration-read", method: name },
        binding: "organization-or-project",
        scope: agentRevokeScope,
        rest: {
          method: "GET",
          path: `${administrationBasePath}${path}`,
          pathParameters,
          queryParameters: [],
          routeRequiresProject: false,
          rateLimitClass: "token",
        },
        mcpTool: null,
        credentialKinds: ["operator"],
      });
      expect(findMcpToolTransport(name)).toBeUndefined();
    },
  );

  test("agent:revoke is a scope only an operator carries: no agent grant, never excluded", () => {
    expect(operatorScopes).toContain(agentRevokeScope);
    expect(operatorOnlyScopes).toContain(agentRevokeScope);
    expect(agentScopes as readonly string[]).not.toContain(agentRevokeScope);
    expect(operatorExcludedScopes as readonly string[]).not.toContain(
      agentRevokeScope,
    );
    // `agent:manage` itself stays excluded: it also creates and mints.
    expect(operatorScopes).not.toContain("agent:manage");
    expect(operatorExcludedScopes as readonly string[]).toContain(
      "agent:manage",
    );
  });

  test("the entries follow F.2.3's, the three commands and then the two reads", () => {
    const at = (name: string) =>
      capabilityRegistry.findIndex((entry) => entry.name === name);
    const positions = [
      "set_agent_principal_status",
      "revoke_agent_credential",
      "revoke_agent_oauth_grant",
      "list_administration_agent_principals",
      "get_administration_agent_principal",
    ].map(at);
    expect(positions[0]).toBeGreaterThan(
      at("get_administration_project_settings"),
    );
    expect(positions).toEqual(
      positions.map((_, index) => (positions[0] ?? 0) + index),
    );
  });
});
