import { describe, expect, test } from "vitest";

import { agentScopes } from "../agents/agent-types.js";
import {
  coreCommandInputSchemas,
  createCoreCommandRegistry,
} from "../core/core-commands.js";
import {
  memberAuthority,
  operatorActor,
  operatorScopes,
} from "../operators/operator-types.js";
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
  type SlackAdministrationMutation,
  type SlackAdministrationTarget,
  slackAdministrationCommandInputSchemas,
  slackAdministrationTarget,
  slackConnectionTestInputSchema,
} from "./slack-administration-commands.js";

/*
  Plan 13, F.2.5's registry half: the three Slack administration commands
  take the acting member from `memberAuthority(context)` (F3-2), so an
  operator credential acts with its issuing member's authority and a person
  with their own, and nothing else is admitted. Slack configuration is the
  organisation's, so an operator bound to a project is refused (binding
  `organization`, `manifest-f2.md` §4.1 rule 7). The mutation the port
  receives carries the context's actor, which the repository records. Run
  against a fake port, so what is proved is what the command hands the
  repository and when it refuses before reaching it.
*/

const organizationId = "018f0000-0000-7000-8000-0000000f2501";
const projectId = "018f0000-0000-7000-8000-0000000f2502";
const installationId = "018f0000-0000-7000-8000-0000000f2503";
const lineageId = "018f0000-0000-7000-8000-0000000f2504";
const memberUserId = "user_f25_member";

const fields: Record<
  keyof typeof slackAdministrationCommandInputSchemas,
  Record<string, unknown>
> = {
  set_slack_user_mapping: {
    installationId,
    userId: "user_f25_target",
    slackUserId: "U0TARGET1",
  },
  set_slack_route: {
    projectId: null,
    mode: "channel",
    channelId: "C0ROUTE01",
    fallback: "none",
  },
  set_slack_installation_status: { installationId, status: "disabled" },
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
    scopes: new Set(["slack:manage"]),
    credentialId: "018f0000-0000-7000-8000-0000000f2505",
    correlationId: "f25-correlation",
    ...overrides,
  };
}

/** A port that records what it was asked, and answers every write. */
function recordingUnitOfWork() {
  const authorized: SlackAdministrationTarget[] = [];
  const mutations: SlackAdministrationMutation[] = [];
  const port = new Proxy(
    {},
    {
      get(_, property) {
        if (property === "then") return undefined;
        if (property === "authorize")
          return async (target: SlackAdministrationTarget) => {
            authorized.push(target);
          };
        return async (mutation: SlackAdministrationMutation) => {
          mutations.push(mutation);
          return { id: installationId, version: 2, status: "disabled" };
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
) {
  const definition = createCoreCommandRegistry().resolve(name);
  if (!definition) throw new Error(`No command ${name}`);
  const parsed = definition.parse({ organizationId, ...fields[name] });
  const recorded = recordingUnitOfWork();
  try {
    await definition.authorize(context, parsed, recorded.uow);
    await definition.execute(recorded.uow, context, parsed, {
      idempotencyKey: "f25-idempotency-key-0001",
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
      const target = { actorUserId: memberUserId, organizationId };
      expect(authorized).toEqual([target]);
      expect(mutations).toHaveLength(1);
      expect(mutations[0]).toEqual({
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
      const actor = { type: "user", id: "user_f25_person" } as const;
      const { authorized, mutations, error } = await runCommand(name, {
        actor,
        organizationId,
        scopes: new Set(["slack:manage"]),
        credentialId: "session",
        correlationId: "f25-person",
      });
      expect(error).toBeNull();
      expect(authorized).toEqual([{ actorUserId: actor.id, organizationId }]);
      expect(mutations[0]).toMatchObject({ actorUserId: actor.id, actor });
    },
  );

  test.each(names)(
    "%s refuses an operator bound to a project before the port is asked",
    async (name) => {
      const { authorized, mutations, error } = await runCommand(
        name,
        operatorContext({ projectId }),
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
        actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000f2506" },
        organizationId,
        projectId,
        scopes: new Set(["slack:manage"]),
        credentialId: "agent-credential",
        correlationId: "f25-agent",
      },
    ],
    [
      "the worker's own service actor",
      {
        actor: { type: "service", id: "trigger:slack-connection-test-repair" },
        organizationId,
        scopes: new Set(["slack:manage"]),
        credentialId: "worker",
        correlationId: "f25-worker",
      },
    ],
    [
      "an operator-shaped actor whose context does not say operator",
      operatorContext({ credentialKind: undefined }),
    ],
  ];
  test.each(refused)(
    "refuses %s holding slack:manage before the port is asked",
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

  /*
    A `user` actor in a context that says `credentialKind: "operator"`:
    `memberAuthority` gives it the person it names, so `actingMember` lets it
    through, and `requireAgentProject` is the check that refuses it
    (`claimsOperator` by its kind, not `isOperatorContext`). The message is
    that check's, so this fails if the refusal comes from anywhere else, or
    from nowhere.
  */
  const personClaimingOperator: Array<[string, string | null]> = [
    ["bound to no project", null],
    ["bound to a project", projectId],
  ];
  test.each(personClaimingOperator)(
    "a user actor whose context says operator, %s, is refused by the project check before the port is asked",
    async (_, boundProjectId) => {
      const context: AuthorizedCommandContext = {
        actor: { type: "user", id: memberUserId },
        credentialKind: "operator",
        organizationId,
        projectId: boundProjectId,
        scopes: new Set(["slack:manage"]),
        credentialId: "018f0000-0000-7000-8000-0000000f2507",
        correlationId: "f25-person-claiming-operator",
      };
      expect(memberAuthority(context)).toEqual({
        userId: memberUserId,
        via: "session",
      });
      for (const name of names) {
        const { authorized, mutations, error } = await runCommand(
          name,
          context,
        );
        expect(error, name).toBeInstanceOf(DomainError);
        expect((error as DomainError).code, name).toBe("forbidden");
        expect((error as DomainError).message, name).toBe(
          "Operator project access is denied",
        );
        expect(authorized, name).toEqual([]);
        expect(mutations, name).toEqual([]);
      }
    },
  );

  test.each(names)(
    "%s refuses an operator without slack:manage, naming the scope",
    async (name) => {
      const { authorized, error } = await runCommand(
        name,
        operatorContext({ scopes: new Set(["operator:revoke"]) }),
      );
      expect((error as DomainError).details).toEqual({
        scope: "slack:manage",
      });
      expect(authorized).toEqual([]);
    },
  );
});

/*
  The connection test stays off the bus, and its handler
  (`packages/core/src/slack-connection-test.ts`) runs these checks itself,
  before its transaction opens, through `slackAdministrationTarget`: the
  commands' own `slackTarget`, so it admits and refuses exactly whom they do
  (Plan 13, F.2.5's connection test follow-up).
*/
describe("the connection test's target is the commands' own", () => {
  test("an organisation-wide operator acts with its issuing member", () => {
    expect(
      slackAdministrationTarget(operatorContext(), { organizationId }),
    ).toEqual({ actorUserId: memberUserId, organizationId });
  });

  test("a signed-in person acts as that person", () => {
    expect(
      slackAdministrationTarget(
        {
          actor: { type: "user", id: "user_f25_person" },
          organizationId,
          scopes: new Set(["slack:manage"]),
          credentialId: "session",
          correlationId: "f25-person",
        },
        { organizationId },
      ),
    ).toEqual({ actorUserId: "user_f25_person", organizationId });
  });

  const refusedTargets: Array<[string, AuthorizedCommandContext, string]> = [
    [
      "an operator bound to a project",
      operatorContext({ projectId }),
      "Operator project access is denied",
    ],
    [
      "an agent holding slack:manage",
      {
        actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000f2506" },
        organizationId,
        projectId,
        scopes: new Set(["slack:manage"]),
        credentialId: "agent-credential",
        correlationId: "f25-agent",
      },
      "Slack administration requires a person or an operator credential",
    ],
    [
      "an operator without slack:manage",
      operatorContext({ scopes: new Set(["operator:revoke"]) }),
      "Required capability is missing",
    ],
  ];
  test.each(refusedTargets)("refuses %s", (_, context, message) => {
    expect(() =>
      slackAdministrationTarget(context, { organizationId }),
    ).toThrow(message);
  });

  test("refuses another organisation than the credential's", () => {
    expect(() =>
      slackAdministrationTarget(operatorContext(), {
        organizationId: "018f0000-0000-7000-8000-0000000f25ff",
      }),
    ).toThrow(DomainError);
  });

  test("its input names the organisation, an installation and a channel Slack issues", () => {
    const input = {
      organizationId,
      installationId,
      channelId: "C0TESTING",
    };
    expect(slackConnectionTestInputSchema.parse(input)).toEqual(input);
    expect(
      slackConnectionTestInputSchema.safeParse({
        ...input,
        channelId: "general",
      }).success,
    ).toBe(false);
  });
});

/*
  The registry entries (Plan 13, F.2.5, as its log's "After F.3" list sets
  them): each of the three commands is a REST command an operator alone
  reaches, with no MCP tool (ruling 2), bound to the credential's
  organisation by the route, and checking `slack:manage`, which an operator
  may carry and no agent grant can. The read that supplies their identifiers
  is REST only, under the administration prefix, operator only, bound to the
  organisation.
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
        scope: { kind: "fixed", scope: "slack:manage", checkedBy: "command" },
        routeRequiresProject: false,
        rateLimitClass: "mutation",
        mcpTool: null,
        credentialKinds: ["operator"],
      });
      expect(transport?.inputSchema).toBe(
        slackAdministrationCommandInputSchemas[name],
      );
      expect(findMcpToolTransport(name)).toBeUndefined();
    },
  );

  test("the read is REST only, under the administration prefix, for an organisation-wide operator holding slack:manage", () => {
    const entry = findQueryCapability("get_administration_slack_configuration");
    expect(entry).toEqual({
      kind: "query",
      name: "get_administration_slack_configuration",
      dispatch: {
        to: "administration-read",
        method: "get_administration_slack_configuration",
      },
      binding: "organization",
      scope: "slack:manage",
      rest: {
        method: "GET",
        path: `${administrationBasePath}/slack`,
        pathParameters: [],
        queryParameters: [],
        routeRequiresProject: false,
        rateLimitClass: "token",
      },
      mcpTool: null,
      credentialKinds: ["operator"],
    });
    expect(
      restQueryTransports.filter(
        (transport) =>
          transport.name === "get_administration_slack_configuration",
      ),
    ).toHaveLength(1);
    expect(
      findMcpToolTransport("get_administration_slack_configuration"),
    ).toBeUndefined();
  });

  test("the connection test is a REST command an operator alone reaches, dispatched off the bus to its handler, with no MCP tool", () => {
    const name = "send_slack_connection_test";
    const transport = findRestCommandTransport(name);
    expect(transport).toEqual({
      name,
      method: "POST",
      path: `${restApiBasePath}/commands/${name}`,
      dispatch: { to: "slack-connection-test" },
      inputSchema: slackConnectionTestInputSchema,
      injectedFields: [
        { field: "organizationId", from: "credential.organizationId" },
      ],
      scope: {
        kind: "fixed",
        scope: "slack:manage",
        checkedBy: "slack-connection-test-handler",
      },
      routeRequiresProject: false,
      rateLimitClass: "mutation",
      mcpTool: null,
      credentialKinds: ["operator"],
    });
    expect(transport?.inputSchema).toBe(slackConnectionTestInputSchema);
    expect(findMcpToolTransport(name)).toBeUndefined();
  });

  test("slack:manage is a scope an operator may carry and no agent grant can", () => {
    expect(operatorScopes).toContain("slack:manage");
    expect(agentScopes as readonly string[]).not.toContain("slack:manage");
  });

  test("the entries follow F.2.3's, in the order the commands are declared, then the connection test, then the read", () => {
    const at = (name: string) =>
      capabilityRegistry.findIndex((entry) => entry.name === name);
    const positions = [
      ...names,
      "send_slack_connection_test",
      "get_administration_slack_configuration",
    ].map(at);
    expect(positions).not.toContain(-1);
    expect(
      positions.every(
        (position) => position > at("get_administration_project_settings"),
      ),
    ).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
