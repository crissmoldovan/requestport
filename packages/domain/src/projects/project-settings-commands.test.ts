import { describe, expect, test } from "vitest";

import { agentScopes } from "../agents/agent-types.js";
import {
  coreCommandInputSchemas,
  createCoreCommandRegistry,
} from "../core/core-commands.js";
import { operatorActor, operatorScopes } from "../operators/operator-types.js";
import type { AuthorizedCommandContext } from "../shared/authorization.js";
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
  type ProjectSettingsMutation,
  type ProjectSettingsTarget,
  projectSettingsCommandInputSchemas,
} from "./project-settings-commands.js";

/*
  Plan 13, F.2.3's registry half: the eleven project settings commands take
  the acting member from `memberAuthority(context)` (F3-2), so an operator
  credential acts with its issuing member's authority and a person with their
  own, and nothing else is admitted. A project-bound operator is held to its
  project. The mutation the port receives carries the context's actor, which
  the repository records (`auditActor` for the audit row, the actor itself on
  the event). Run against a fake port, so what is proved is what the command
  hands the repository and when it refuses before reaching it.
*/

const organizationId = "018f0000-0000-7000-8000-0000000f2301";
const projectId = "018f0000-0000-7000-8000-0000000f2302";
const otherProjectId = "018f0000-0000-7000-8000-0000000f2303";
const repositoryId = "018f0000-0000-7000-8000-0000000f2304";
const laneId = "018f0000-0000-7000-8000-0000000f2305";
const lineageId = "018f0000-0000-7000-8000-0000000f2306";
const memberUserId = "user_f23_member";

const fields: Record<
  keyof typeof projectSettingsCommandInputSchemas,
  Record<string, unknown>
> = {
  add_project_alias: { alias: "legacy" },
  add_project_repository: {
    repositoryUrl: "https://github.com/example-org/requestport",
  },
  set_default_project_repository: { repositoryId },
  set_project_repository_status: { repositoryId, status: "archived" },
  add_project_lane: { name: "Hotfix", slug: "hotfix" },
  set_default_project_lane: { laneId },
  set_project_lane_status: { laneId, status: "archived" },
  set_project_member: {
    userId: "user_f23_target",
    role: "viewer",
    status: "active",
  },
  set_project_work_policy: {
    heartbeatIntervalSeconds: 60,
    leaseMultiplier: 3,
    graceSeconds: 600,
    requiredWorkspaceFields: [],
  },
  update_project_metadata: { name: "Renamed", description: "" },
  set_project_status: { status: "archived" },
};
const names = Object.keys(fields) as Array<keyof typeof fields>;

function operatorContext(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator",
    organizationId,
    projectId: null,
    laneIds: new Set(),
    scopes: new Set(["project:manage"]),
    credentialId: "018f0000-0000-7000-8000-0000000f2307",
    correlationId: "f23-correlation",
    ...overrides,
  };
}

/** A port that records what it was asked, and answers every write. */
function recordingUnitOfWork() {
  const authorized: ProjectSettingsTarget[] = [];
  const mutations: ProjectSettingsMutation[] = [];
  const port = new Proxy(
    {},
    {
      get(_, property) {
        if (property === "then") return undefined;
        if (property === "authorize")
          return async (target: ProjectSettingsTarget) => {
            authorized.push(target);
          };
        return async (mutation: ProjectSettingsMutation) => {
          mutations.push(mutation);
          return { projectId: mutation.projectId, version: 2 };
        };
      },
    },
  );
  const uow = {
    port: <T>() => port as T,
  } as unknown as UnitOfWork;
  return { uow, authorized, mutations };
}

async function runCommand(
  name: keyof typeof fields,
  context: AuthorizedCommandContext,
  input: Record<string, unknown> = {},
) {
  const definition = createCoreCommandRegistry().resolve(name);
  if (!definition) throw new Error(`No command ${name}`);
  const parsed = definition.parse({
    organizationId,
    projectId,
    ...fields[name],
    ...input,
  });
  const recorded = recordingUnitOfWork();
  try {
    await definition.authorize(context, parsed, recorded.uow);
    await definition.execute(recorded.uow, context, parsed, {
      idempotencyKey: "f23-idempotency-key-0001",
      expectedVersion: 1,
    });
    return { ...recorded, error: null };
  } catch (error) {
    return { ...recorded, error };
  }
}

describe("the acting member is memberAuthority(context)", () => {
  test.each(names)(
    "%s asks the port about an operator's issuing member, and hands it the operator's actor",
    async (name) => {
      const context = operatorContext();
      const { authorized, mutations, error } = await runCommand(name, context);
      expect(error).toBeNull();
      const target = { userId: memberUserId, organizationId, projectId };
      expect(authorized).toEqual([target]);
      expect(mutations).toHaveLength(1);
      expect(mutations[0]).toMatchObject({
        ...target,
        actor: context.actor,
        correlationId: context.correlationId,
        expectedVersion: 1,
      });
    },
  );

  test.each(names)(
    "%s still acts for a signed-in person as that person",
    async (name) => {
      const actor = { type: "user", id: "user_f23_person" } as const;
      const { authorized, mutations, error } = await runCommand(name, {
        actor,
        organizationId,
        scopes: new Set(["project:manage"]),
        credentialId: "session",
        correlationId: "f23-person",
      });
      expect(error).toBeNull();
      expect(authorized).toEqual([
        { userId: actor.id, organizationId, projectId },
      ]);
      expect(mutations[0]).toMatchObject({ userId: actor.id, actor });
    },
  );

  test.each(names)(
    "%s lets an operator bound to the project act on it",
    async (name) => {
      const { authorized, error } = await runCommand(
        name,
        operatorContext({ projectId }),
      );
      expect(error).toBeNull();
      expect(authorized).toHaveLength(1);
    },
  );

  test.each(names)(
    "%s refuses an operator bound to another project before the port is asked",
    async (name) => {
      const { authorized, mutations, error } = await runCommand(
        name,
        operatorContext({ projectId: otherProjectId }),
      );
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("forbidden");
      expect(authorized).toEqual([]);
      expect(mutations).toEqual([]);
    },
  );

  const refused: Array<[string, AuthorizedCommandContext]> = [
    [
      "an agent",
      {
        actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000f2308" },
        organizationId,
        projectId,
        scopes: new Set(["project:manage"]),
        credentialId: "agent-credential",
        correlationId: "f23-agent",
      },
    ],
    [
      "the worker's own service actor",
      {
        actor: { type: "service", id: "trigger:work-session-sweep" },
        organizationId,
        scopes: new Set(["project:manage"]),
        credentialId: "worker",
        correlationId: "f23-worker",
      },
    ],
    [
      "an operator-shaped actor whose context does not say operator",
      operatorContext({ credentialKind: undefined }),
    ],
  ];
  test.each(refused)(
    "refuses %s holding project:manage before the port is asked",
    async (_, context) => {
      for (const name of names) {
        const { authorized, mutations, error } = await runCommand(
          name,
          context,
        );
        expect(error, name).toBeInstanceOf(DomainError);
        expect((error as DomainError).code, name).toBe("forbidden");
        expect(authorized, name).toEqual([]);
        expect(mutations, name).toEqual([]);
      }
    },
  );

  test.each(names)(
    "%s refuses an operator without project:manage, naming the scope",
    async (name) => {
      const { authorized, error } = await runCommand(
        name,
        operatorContext({ scopes: new Set(["operator:revoke"]) }),
      );
      expect((error as DomainError).details).toEqual({
        scope: "project:manage",
      });
      expect(authorized).toEqual([]);
    },
  );
});

/*
  The registry entries (Plan 13, F.2.3, as its log's "After F.3" list sets
  them): each command is a REST command an operator alone reaches, with no
  MCP tool (ruling 2), bound to the credential's organisation by the route,
  and checking `project:manage`, which an operator may carry and no agent
  grant can. The read that supplies their identifiers is REST only, under the
  administration prefix, operator only.
*/
describe("the registry entries", () => {
  test.each(names)(
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
        scope: { kind: "fixed", scope: "project:manage", checkedBy: "command" },
        routeRequiresProject: false,
        rateLimitClass: "mutation",
        mcpTool: null,
        credentialKinds: ["operator"],
      });
      expect(transport?.inputSchema).toBe(
        projectSettingsCommandInputSchemas[name],
      );
      expect(findMcpToolTransport(name)).toBeUndefined();
    },
  );

  test("the read is REST only, under the administration prefix, for an operator holding project:manage", () => {
    const entry = findQueryCapability("get_administration_project_settings");
    expect(entry).toEqual({
      kind: "query",
      name: "get_administration_project_settings",
      dispatch: {
        to: "administration-read",
        method: "get_administration_project_settings",
      },
      binding: "organization-or-project",
      scope: "project:manage",
      rest: {
        method: "GET",
        path: `${administrationBasePath}/projects/{projectId}/settings`,
        pathParameters: ["projectId"],
        queryParameters: [],
        routeRequiresProject: false,
        rateLimitClass: "token",
      },
      mcpTool: null,
      credentialKinds: ["operator"],
    });
    expect(
      restQueryTransports.filter(
        (transport) => transport.name === "get_administration_project_settings",
      ),
    ).toHaveLength(1);
    expect(
      findMcpToolTransport("get_administration_project_settings"),
    ).toBeUndefined();
  });

  test("project:manage is a scope an operator may carry and no agent grant can", () => {
    expect(operatorScopes).toContain("project:manage");
    expect(agentScopes as readonly string[]).not.toContain("project:manage");
  });

  test("the entries follow F.3's, in the order the commands are declared, then the read", () => {
    const at = (name: string) =>
      capabilityRegistry.findIndex((entry) => entry.name === name);
    const positions = [...names, "get_administration_project_settings"].map(at);
    expect(positions.every((position) => position > at("list_events"))).toBe(
      true,
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
