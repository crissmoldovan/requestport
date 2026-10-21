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
  type OperationsMutation,
  type OperationsOperator,
  operationsCommandInputSchemas,
} from "./operations-commands.js";

/*
  Plan 13, F.2.4's registry half: the six operations commands take the
  acting member from `memberAuthority(context)` (F3-2), so an operator
  credential acts with its issuing member's authority and a person with their
  own, and nothing else is admitted. Every row they act on belongs to the
  organisation, so an operator bound to a project is refused all six. The
  mutation the port receives carries the context's actor, which the
  repositories record (`auditActor` for the audit row, the actor itself on a
  hold's event). Run against a fake port, so what is proved is what the
  command hands the repository and when it refuses before reaching it.
*/

const organizationId = "018f0000-0000-7000-8000-0000000f2401";
const projectId = "018f0000-0000-7000-8000-0000000f2402";
const rowId = "018f0000-0000-7000-8000-0000000f2403";
const lineageId = "018f0000-0000-7000-8000-0000000f2404";
const memberUserId = "user_f24_member";

type CommandName = keyof typeof operationsCommandInputSchemas;

const fields: Record<CommandName, Record<string, unknown>> = {
  requeue_outbox: { outboxId: rowId },
  requeue_notification: { notificationIntentId: rowId },
  requeue_slack_operation: { operationId: rowId },
  requeue_import_dispatch: { dispatchId: rowId },
  create_retention_hold: { category: "all", reason: "Keep for the audit" },
  release_retention_hold: { holdId: rowId },
};
const names = Object.keys(fields) as CommandName[];

/** What each port method answers, as the repositories answer it. */
const answers: Record<string, unknown> = {
  requeueOutbox: { outboxId: rowId, eventId: rowId },
  requeueNotification: { notificationIntentId: rowId },
  requeueSlackOperation: {
    operationId: rowId,
    operationType: "message_update",
  },
  requeueImportDispatch: { dispatchId: rowId },
  create: { id: rowId, version: 1 },
  release: { id: rowId, version: 2 },
};

function operatorContext(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator",
    organizationId,
    projectId: null,
    laneIds: new Set(),
    scopes: new Set(["operations:manage"]),
    credentialId: "018f0000-0000-7000-8000-0000000f2405",
    correlationId: "f24-correlation",
    ...overrides,
  };
}

/** A port that records what it was asked, and answers every write. */
function recordingUnitOfWork() {
  const authorized: OperationsOperator[] = [];
  const mutations: OperationsMutation[] = [];
  const port = new Proxy(
    {},
    {
      get(_, property) {
        if (property === "then" || typeof property !== "string")
          return undefined;
        if (property === "authorize")
          return async (operator: OperationsOperator) => {
            authorized.push(operator);
          };
        return async (mutation: OperationsMutation) => {
          mutations.push(mutation);
          return answers[property];
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
  name: CommandName,
  context: AuthorizedCommandContext,
) {
  const definition = createCoreCommandRegistry().resolve(name);
  if (!definition) throw new Error(`No command ${name}`);
  const parsed = definition.parse({ organizationId, ...fields[name] });
  const recorded = recordingUnitOfWork();
  try {
    await definition.authorize(context, parsed, recorded.uow);
    await definition.execute(recorded.uow, context, parsed, {
      idempotencyKey: "f24-idempotency-key-0001",
      expectedVersion: 3,
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
      const operator = { userId: memberUserId, organizationId };
      expect(authorized).toEqual([operator]);
      expect(mutations).toEqual([
        {
          ...operator,
          actor: context.actor,
          correlationId: context.correlationId,
          expectedVersion: 3,
        },
      ]);
    },
  );

  test.each(names)(
    "%s still acts for a signed-in person as that person",
    async (name) => {
      const actor = { type: "user", id: "user_f24_person" } as const;
      const { authorized, mutations, error } = await runCommand(name, {
        actor,
        organizationId,
        scopes: new Set(["operations:manage"]),
        credentialId: "session",
        correlationId: "f24-person",
      });
      expect(error).toBeNull();
      expect(authorized).toEqual([{ userId: actor.id, organizationId }]);
      expect(mutations[0]).toMatchObject({ userId: actor.id, actor });
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
      expect((error as DomainError).message).toBe(
        "Operations require a credential bound to no project",
      );
      expect(authorized).toEqual([]);
      expect(mutations).toEqual([]);
    },
  );

  const refused: Array<[string, AuthorizedCommandContext]> = [
    [
      "an agent",
      {
        actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000f2406" },
        organizationId,
        projectId,
        scopes: new Set(["operations:manage"]),
        credentialId: "agent-credential",
        correlationId: "f24-agent",
      },
    ],
    [
      "the worker's own service actor",
      {
        actor: { type: "service", id: "trigger:outbox-repair" },
        organizationId,
        scopes: new Set(["operations:manage"]),
        credentialId: "worker",
        correlationId: "f24-worker",
      },
    ],
    [
      "an operator-shaped actor whose context does not say operator",
      operatorContext({ credentialKind: undefined }),
    ],
  ];
  test.each(refused)(
    "refuses %s holding operations:manage before the port is asked",
    async (_, context) => {
      for (const name of names) {
        const { authorized, mutations, error } = await runCommand(
          name,
          context,
        );
        expect(error, name).toBeInstanceOf(DomainError);
        expect((error as DomainError).code, name).toBe("forbidden");
        expect((error as DomainError).message, name).toBe(
          "Operations require a person or an operator credential",
        );
        expect(authorized, name).toEqual([]);
        expect(mutations, name).toEqual([]);
      }
    },
  );

  test.each(names)(
    "%s refuses an operator without operations:manage, naming the scope",
    async (name) => {
      const { authorized, error } = await runCommand(
        name,
        operatorContext({ scopes: new Set(["operator:revoke"]) }),
      );
      expect((error as DomainError).details).toEqual({
        scope: "operations:manage",
      });
      expect(authorized).toEqual([]);
    },
  );

  test.each(names)(
    "%s refuses an operator naming another organisation than its own",
    async (name) => {
      const { authorized, error } = await runCommand(
        name,
        operatorContext({
          organizationId: "018f0000-0000-7000-8000-0000000f2407",
        }),
      );
      expect((error as DomainError).code).toBe("forbidden");
      expect((error as DomainError).message).toBe(
        "Organization access is denied",
      );
      expect(authorized).toEqual([]);
    },
  );
});

/*
  The registry entries (Plan 13, F.2.4, as its log's "After F.3" list sets
  them): each command is a REST command an operator alone reaches, with no
  MCP tool (ruling 2), bound to the credential's organisation by the route,
  and checking `operations:manage`, which an operator may carry and no agent
  grant can. The two reads that supply their identifiers and versions are
  REST only, under the administration prefix, operator only, and bound to the
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
        scope: {
          kind: "fixed",
          scope: "operations:manage",
          checkedBy: "command",
        },
        routeRequiresProject: false,
        rateLimitClass: "mutation",
        mcpTool: null,
        credentialKinds: ["operator"],
      });
      expect(transport?.inputSchema).toBe(operationsCommandInputSchemas[name]);
      expect(findMcpToolTransport(name)).toBeUndefined();
    },
  );

  test.each([
    ["list_administration_operations", "/operations"],
    ["list_administration_retention_holds", "/retention-holds"],
  ] as const)(
    "%s is REST only, under the administration prefix, for an organisation-wide operator holding operations:manage",
    (name, path) => {
      expect(findQueryCapability(name)).toEqual({
        kind: "query",
        name,
        dispatch: { to: "administration-read", method: name },
        binding: "organization",
        scope: "operations:manage",
        rest: {
          method: "GET",
          path: `${administrationBasePath}${path}`,
          pathParameters: [],
          queryParameters: [],
          routeRequiresProject: false,
          rateLimitClass: "token",
        },
        mcpTool: null,
        credentialKinds: ["operator"],
      });
      expect(
        restQueryTransports.filter((transport) => transport.name === name),
      ).toHaveLength(1);
      expect(findMcpToolTransport(name)).toBeUndefined();
    },
  );

  test("operations:manage is a scope an operator may carry and no agent grant can", () => {
    expect(operatorScopes).toContain("operations:manage");
    expect(agentScopes as readonly string[]).not.toContain("operations:manage");
  });

  test("the entries follow F.2.3's, in the order the commands are declared, then the two reads", () => {
    const at = (name: string) =>
      capabilityRegistry.findIndex((entry) => entry.name === name);
    const positions = [
      ...names,
      "list_administration_operations",
      "list_administration_retention_holds",
    ].map(at);
    expect(
      positions.every(
        (position) => position > at("get_administration_project_settings"),
      ),
    ).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
