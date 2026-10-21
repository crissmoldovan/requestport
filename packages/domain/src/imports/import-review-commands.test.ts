import { describe, expect, test, vi } from "vitest";

import { agentScopes } from "../agents/agent-types.js";
import {
  coreCommandInputSchemas,
  createCoreCommandRegistry,
} from "../core/core-commands.js";
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
  createImportReviewCommandDefinitions,
  importReviewCommandInputSchemas,
  importReviewPortName,
  importReviewScope,
  importReviewTarget,
  splitImportEntryInputSchema,
} from "./import-review-commands.js";

/*
  Import review's command and the checks the split shares with it (Plan 13,
  F.2.6), against fakes. What a real database answers is
  `packages/db/src/repositories/import-repository.integration.test.ts`'s.
*/

const organizationId = "5d0c2f6e-0000-4000-8000-000000000010";
const otherOrganizationId = "5d0c2f6e-0000-4000-8000-000000000011";
const runId = "5d0c2f6e-0000-4000-8000-000000000020";
const entryId = "5d0c2f6e-0000-4000-8000-000000000021";
const projectId = "5d0c2f6e-0000-4000-8000-000000000030";
const requestId = "5d0c2f6e-0000-4000-8000-000000000040";
const userId = "user_01JQ0000000000000000000061";

function context(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set(["import:write"]),
    credentialId: "session_1",
    correlationId: "5d0c2f6e-0000-4000-8000-0000000000cc",
    ...overrides,
  };
}

const machineActors: Array<[string, ActorRef]> = [
  ["an agent", { type: "agent", id: "5d0c2f6e-0000-4000-8000-000000000050" }],
  [
    "a service actor shaped as an operator, in a context that does not say operator",
    {
      type: "service",
      id: "operator:probe",
      originatingActor: { type: "user", id: userId },
    },
  ],
];

const memberUserId = "user_01JQ0000000000000000000062";
const lineageId = "5d0c2f6e-0000-4000-8000-000000000060";

/** The context `/api/v1` builds for an operator credential (Plan 13, F.3). */
function operatorContext(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return context({
    actor: operatorActor({ lineageId, memberUserId }),
    credentialKind: "operator",
    projectId: null,
    laneIds: new Set(),
    credentialId: "5d0c2f6e-0000-4000-8000-000000000061",
    ...overrides,
  });
}

function unitOfWork() {
  const port = {
    authorize: vi.fn(async () => {}),
    reviewEntry: vi.fn(async () => ({ id: entryId, version: 4 })),
  };
  const opened = vi.fn();
  const uow = {
    port: (name: string) => {
      opened(name);
      if (name !== importReviewPortName)
        throw new Error(`unexpected port ${name}`);
      return port;
    },
  } as unknown as UnitOfWork;
  return { uow, port, opened };
}

function review() {
  const [definition] = createImportReviewCommandDefinitions();
  if (!definition) throw new Error("no definition");
  return definition;
}

const input = {
  organizationId,
  runId,
  entryId,
  decision: "create",
  targetProjectId: projectId,
  relationships: [{ type: "related_to", targetRequestId: requestId }],
};

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("not refused");
}

describe("review_legacy_import_entry", () => {
  test("is the one command this module registers, under the scope import:write, and the core registry holds it", () => {
    expect(
      createImportReviewCommandDefinitions().map(({ name }) => name),
    ).toEqual(["review_legacy_import_entry"]);
    expect(Object.keys(importReviewCommandInputSchemas)).toEqual([
      "review_legacy_import_entry",
    ]);
    expect(importReviewScope).toBe("import:write");
    expect(
      createCoreCommandRegistry().resolve("review_legacy_import_entry"),
    ).toBeDefined();
  });

  test("asks the port whether the person may review in the organisation, before it answers", async () => {
    const { uow, port } = unitOfWork();
    await review().authorize(context(), review().parse(input), uow);

    expect(port.authorize).toHaveBeenCalledExactlyOnceWith({
      userId,
      organizationId,
    });
    expect(port.reviewEntry).not.toHaveBeenCalled();
  });

  test.each(machineActors)(
    "refuses %s holding import:write before the port is opened",
    async (_, actor) => {
      const { uow, port, opened } = unitOfWork();
      const refused = await refusal(
        review().authorize(context({ actor }), review().parse(input), uow),
      );

      expect(refused).toBeInstanceOf(DomainError);
      expect((refused as DomainError).code).toBe("forbidden");
      expect((refused as DomainError).message).toBe(
        "Import review requires a person or an operator credential",
      );
      expect(port.authorize).not.toHaveBeenCalled();
      expect(opened).not.toHaveBeenCalled();
    },
  );

  test("refuses a context without import:write, naming the scope, before the port is opened", async () => {
    const { uow, port, opened } = unitOfWork();
    const refused = await refusal(
      review().authorize(
        context({ scopes: new Set(["project:manage"]) }),
        review().parse(input),
        uow,
      ),
    );

    expect((refused as DomainError).code).toBe("forbidden");
    expect((refused as DomainError).details).toMatchObject({
      scope: "import:write",
    });
    expect(port.authorize).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });

  test("refuses another organisation in the input before the port is opened", async () => {
    const { uow, port, opened } = unitOfWork();
    const refused = await refusal(
      review().authorize(
        context(),
        review().parse({ ...input, organizationId: otherOrganizationId }),
        uow,
      ),
    );

    expect((refused as DomainError).code).toBe("forbidden");
    expect(port.authorize).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });

  test("hands the port the person, the organisation, the version the caller expects and the decision", async () => {
    const { uow, port } = unitOfWork();
    const executed = await review().execute(
      uow,
      context(),
      review().parse(input),
      { idempotencyKey: "import-review-0000000000", expectedVersion: 3 },
    );

    expect(port.reviewEntry).toHaveBeenCalledExactlyOnceWith(
      {
        userId,
        organizationId,
        actor: { type: "user", id: userId },
        credentialProjectId: null,
        expectedVersion: 3,
      },
      {
        runId,
        entryId,
        decision: "create",
        proposedCanonicalId: null,
        targetProjectId: projectId,
        relationships: [{ type: "related_to", targetRequestId: requestId }],
      },
    );
    expect(executed).toEqual({
      result: { id: entryId, version: 4 },
      aggregateId: entryId,
      events: [],
    });
  });

  test("reads an absent canonical request, target project and relationship list as none", () => {
    expect(
      review().parse({ organizationId, runId, entryId, decision: "skip" }),
    ).toEqual({
      organizationId,
      runId,
      entryId,
      decision: "skip",
      proposedCanonicalId: null,
      targetProjectId: null,
      relationships: [],
    });
  });

  test("refuses a decision that is not one of the five, and more than twenty relationships", () => {
    expect(() => review().parse({ ...input, decision: "pending" })).toThrow();
    expect(() =>
      review().parse({
        ...input,
        relationships: Array.from({ length: 21 }, (_, index) => ({
          type: "related_to",
          targetRequestId: `5d0c2f6e-0000-4000-8000-${String(index).padStart(12, "0")}`,
        })),
      }),
    ).toThrow();
  });
});

describe("the checks a split shares with review", () => {
  test("answer the person and the organisation for a person holding import:write", () => {
    expect(importReviewTarget(context(), { organizationId })).toEqual({
      userId,
      organizationId,
      actor: { type: "user", id: userId },
      credentialProjectId: null,
    });
  });

  test.each(machineActors)("refuse %s", (_, actor) => {
    expect(() =>
      importReviewTarget(context({ actor }), { organizationId }),
    ).toThrow("Import review requires a person or an operator credential");
  });

  test("refuse a context without the scope, and another organisation", () => {
    expect(() =>
      importReviewTarget(context({ scopes: new Set() }), { organizationId }),
    ).toThrow(DomainError);
    expect(() =>
      importReviewTarget(context(), { organizationId: otherOrganizationId }),
    ).toThrow(DomainError);
  });

  test("a split names between one and nineteen lines, each after the first", () => {
    const split = { organizationId, runId, entryId };
    expect(
      splitImportEntryInputSchema.parse({ ...split, splitLines: [2] }),
    ).toEqual({ ...split, splitLines: [2] });
    expect(() =>
      splitImportEntryInputSchema.parse({ ...split, splitLines: [] }),
    ).toThrow();
    expect(() =>
      splitImportEntryInputSchema.parse({ ...split, splitLines: [1] }),
    ).toThrow();
    expect(() =>
      splitImportEntryInputSchema.parse({
        ...split,
        splitLines: Array.from({ length: 20 }, (_, index) => index + 2),
      }),
    ).toThrow();
  });
});

/*
  Plan 13, F.2.6's registry half: an operator credential reviews and splits
  for its issuing member (`memberAuthority`), and the write records the
  operator's own actor. A project-bound operator carries its project to the
  repository, which confines the run, the target project and the requests
  the decision names to it.
*/
describe("an operator credential", () => {
  test("import:write is a scope an operator credential may carry", () => {
    expect(operatorScopes).toContain("import:write");
  });

  test("an organisation-wide operator is answered as its member, with its own actor and no project", () => {
    const operator = operatorContext();
    expect(importReviewTarget(operator, { organizationId })).toEqual({
      userId: memberUserId,
      organizationId,
      actor: operator.actor,
      credentialProjectId: null,
    });
  });

  test("a project-bound operator carries its project", () => {
    const operator = operatorContext({ projectId });
    expect(importReviewTarget(operator, { organizationId })).toMatchObject({
      userId: memberUserId,
      credentialProjectId: projectId,
    });
  });

  test("a person's context never carries a project, whatever it says", () => {
    expect(
      importReviewTarget(context({ projectId }), { organizationId }),
    ).toMatchObject({ userId, credentialProjectId: null });
  });

  test("asks the port about the member, never the operator's actor id", async () => {
    const { uow, port } = unitOfWork();
    await review().authorize(operatorContext(), review().parse(input), uow);
    expect(port.authorize).toHaveBeenCalledExactlyOnceWith({
      userId: memberUserId,
      organizationId,
    });
  });

  test("hands the write the member, the operator's actor and its bound project", async () => {
    const { uow, port } = unitOfWork();
    const operator = operatorContext({ projectId });
    await review().execute(uow, operator, review().parse(input), {
      idempotencyKey: "import-review-operator-00",
      expectedVersion: 5,
    });
    expect(port.reviewEntry).toHaveBeenCalledExactlyOnceWith(
      {
        userId: memberUserId,
        organizationId,
        actor: operator.actor,
        credentialProjectId: projectId,
        expectedVersion: 5,
      },
      expect.objectContaining({ runId, entryId, decision: "create" }),
    );
  });

  test("refuses an operator without import:write, naming the scope, before the port is opened", async () => {
    const { uow, opened } = unitOfWork();
    const refused = await refusal(
      review().authorize(
        operatorContext({ scopes: new Set(["project:manage"]) }),
        review().parse(input),
        uow,
      ),
    );
    expect((refused as DomainError).code).toBe("forbidden");
    expect((refused as DomainError).details).toMatchObject({
      scope: "import:write",
    });
    expect(opened).not.toHaveBeenCalled();
  });

  test("refuses a context that says operator without an operator's actor, before the port is opened", async () => {
    const { uow, opened } = unitOfWork();
    const refused = await refusal(
      review().authorize(
        context({
          credentialKind: "operator",
          actor: { type: "service", id: "operator:probe" },
        }),
        review().parse(input),
        uow,
      ),
    );
    expect((refused as DomainError).message).toBe(
      "Import review requires a person or an operator credential",
    );
    expect(opened).not.toHaveBeenCalled();
  });
});

/*
  The registry entries (Plan 13, F.2.6's registry half, as the port half's
  "After F.3" list sets them): review on the bus, the split off it, and the
  two reads, each REST only and admitting an operator credential alone.
  `import:write` is also an agent scope, so `credentialKinds` is what keeps
  agents off these entries at the route.
*/
describe("the registry entries", () => {
  test("review_legacy_import_entry is a REST command an operator alone reaches, with no MCP tool", () => {
    const transport = findRestCommandTransport("review_legacy_import_entry");
    expect(transport).toEqual({
      name: "review_legacy_import_entry",
      method: "POST",
      path: `${restApiBasePath}/commands/review_legacy_import_entry`,
      dispatch: {
        to: "command-bus",
        commandName: "review_legacy_import_entry",
      },
      inputSchema: coreCommandInputSchemas.review_legacy_import_entry,
      injectedFields: [
        { field: "organizationId", from: "credential.organizationId" },
      ],
      scope: { kind: "fixed", scope: "import:write", checkedBy: "command" },
      routeRequiresProject: false,
      rateLimitClass: "mutation",
      mcpTool: null,
      credentialKinds: ["operator"],
    });
    expect(transport?.inputSchema).toBe(
      importReviewCommandInputSchemas.review_legacy_import_entry,
    );
    expect(findMcpToolTransport("review_legacy_import_entry")).toBeUndefined();
  });

  test("split_legacy_import_entry is a REST command off the bus, dispatched to the split handler, for an operator alone", () => {
    const transport = findRestCommandTransport("split_legacy_import_entry");
    expect(transport).toEqual({
      name: "split_legacy_import_entry",
      method: "POST",
      path: `${restApiBasePath}/commands/split_legacy_import_entry`,
      dispatch: { to: "import-split" },
      inputSchema: splitImportEntryInputSchema,
      injectedFields: [
        { field: "organizationId", from: "credential.organizationId" },
      ],
      scope: {
        kind: "fixed",
        scope: "import:write",
        checkedBy: "import-split-handler",
      },
      routeRequiresProject: false,
      rateLimitClass: "mutation",
      mcpTool: null,
      credentialKinds: ["operator"],
    });
    expect(findMcpToolTransport("split_legacy_import_entry")).toBeUndefined();
    // Not a bus command: the registry the bus resolves does not hold it.
    expect(
      createCoreCommandRegistry().resolve("split_legacy_import_entry"),
    ).toBeUndefined();
  });

  test.each([
    ["list_administration_import_runs", "/import-runs", []],
    ["get_administration_import_run", "/import-runs/{runId}", ["runId"]],
  ] as const)(
    "%s is REST only, under the administration prefix, for an operator holding import:write",
    (name, path, pathParameters) => {
      expect(findQueryCapability(name)).toEqual({
        kind: "query",
        name,
        dispatch: { to: "administration-read", method: name },
        binding: "organization-or-project",
        scope: "import:write",
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
      expect(
        restQueryTransports.filter((transport) => transport.name === name),
      ).toHaveLength(1);
      expect(findMcpToolTransport(name)).toBeUndefined();
    },
  );

  test("import:write is a scope an operator may carry, and an agent grant can hold it too", () => {
    expect(operatorScopes).toContain("import:write");
    expect(agentScopes as readonly string[]).toContain("import:write");
  });

  test("the entries are appended together after list_events, in order: review, the split, then the two reads", () => {
    const at = (name: string) =>
      capabilityRegistry.findIndex((entry) => entry.name === name);
    const positions = [
      "review_legacy_import_entry",
      "split_legacy_import_entry",
      "list_administration_import_runs",
      "get_administration_import_run",
    ].map(at);
    expect(positions.every((position) => position > at("list_events"))).toBe(
      true,
    );
    expect(positions).toEqual(
      Array.from({ length: 4 }, (_, index) => (positions[0] ?? 0) + index),
    );
  });
});
