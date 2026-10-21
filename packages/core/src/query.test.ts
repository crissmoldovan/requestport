import {
  type AuthorizedCommandContext,
  agentScopes,
  capabilityRegistry,
  DomainError,
  operatorActor,
  type QueryCapability,
} from "@requestport/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ZodError } from "zod";

import {
  type AdministrationRead,
  administrationReads,
} from "./administration-reads.js";
import {
  type AgentQueries,
  type AgentQueryCaller,
  createAgentQueries,
  createQueryExecution,
  type QueryContext,
  resolveRestQuery,
} from "./query.js";

/*
 * Running a registry query through core (manifest-g.md §2.5; Done when 7,
 * for the registry's queries), as the REST route's GET handler ran it until
 * ruling 137 moved it here: the admission of each kind of query, the agent
 * queries' parameters, the answers `whoami` gives each kind, and the path
 * step the route hands its GET to (`resolveRestQuery`). The agent queries
 * and the administration reads are stand-ins that record what reached them,
 * so nothing here opens a database. `registry-through-core.test.ts` runs
 * every query entry through a RequestPort under each kind.
 */

const organizationId = "018f0000-0000-7000-8000-0000000c0f01";
const projectId = "018f0000-0000-7000-8000-0000000c0f02";
const agentId = "018f0000-0000-7000-8000-0000000c0f03";
const memberUserId = "018f0000-0000-7000-8000-0000000c0f04";

function agentContext(
  overrides: Partial<QueryContext> = {},
): QueryContext & { laneIds: ReadonlySet<string> } {
  return {
    actor: { type: "agent", id: agentId },
    organizationId,
    projectId,
    scopes: new Set([
      "org:read",
      "project:read",
      "request:read",
      "request:write",
    ]),
    credentialId: "core-query-grant",
    correlationId: "018f0000-0000-7000-8000-0000000c0f05",
    audience: "api",
    authorizationId: "core-query-grant",
    laneIds: new Set(["lane-b", "lane-a"]),
    ...overrides,
  } as QueryContext & { laneIds: ReadonlySet<string> };
}

function operatorContext(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    actor: operatorActor({
      lineageId: "018f0000-0000-7000-8000-0000000c0f06",
      memberUserId,
    }),
    credentialKind: "operator",
    organizationId,
    projectId: null,
    scopes: new Set(["routing:manage", "org:read"]),
    credentialId: "core-query-operator-key",
    correlationId: "018f0000-0000-7000-8000-0000000c0f07",
    authorizationId: "core-query-operator-key",
    ...overrides,
  };
}

/** Stand-in agent queries, each answering its own name, and every call. */
function recordingQueries(answers: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return method in answers ? answers[method] : { answeredBy: method };
    };
  const agentQueries = {
    getAgentPolicy: record("getAgentPolicy"),
    listOrganizations: record("listOrganizations"),
    listProjects: record("listProjects"),
    getProject: record("getProject"),
    listRequests: record("listRequests"),
    getRequest: record("getRequest"),
    listTimeline: record("listTimeline"),
    listOpenQuestions: record("listOpenQuestions"),
    listEvents: record("listEvents"),
  } as unknown as AgentQueries;
  return { agentQueries, calls };
}

const reading = {
  database: { handle: "the storage's" } as never,
  secrets: { operatorCredentials: "enabled" as const },
};

function querying(answers?: Partial<Record<string, unknown>>) {
  const { agentQueries, calls } = recordingQueries(answers);
  const query = createQueryExecution({
    agentQueries,
    administrationReading: reading,
  });
  return { query, calls };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the query was not refused");
}

const replaced: Array<[string, AdministrationRead]> = [];

/** Replaces one administration read with a recorder, for this case. */
function recordRead(name: string) {
  const reads = administrationReads as Record<string, AdministrationRead>;
  replaced.push([name, reads[name] as AdministrationRead]);
  const read = vi.fn(async (_input: unknown) => ({ readBy: name }));
  reads[name] = read;
  return read;
}

afterEach(() => {
  const reads = administrationReads as Record<string, AdministrationRead>;
  for (const [name, read] of replaced.splice(0)) reads[name] = read;
});

describe("query, by registry name", () => {
  test.each([
    "",
    "constructor",
    "__proto__",
    "Whoami",
    "claim_request",
    "/whoami",
  ])(
    "answers a name the registry holds no query for, %j, as not found, asking nothing",
    async (name) => {
      const { query, calls } = querying();

      const error = await refusal(
        query(name, {}, { context: agentContext(), credentialKind: "agent" }),
      );

      expect(error).toMatchObject({
        code: "not_found",
        message: "API resource was not found",
      });
      expect(calls).toEqual([]);
    },
  );

  test.each([
    ["an agent's context stated as an operator's", agentContext, "operator"],
    ["an operator's context stated as an agent's", operatorContext, "agent"],
    [
      "a person's context stated as an agent's",
      () =>
        ({
          actor: { type: "user", id: memberUserId },
          organizationId,
          scopes: new Set(["request:read"]),
          credentialId: "a-live-session",
          correlationId: "018f0000-0000-7000-8000-0000000c0f08",
        }) satisfies AuthorizedCommandContext,
      "agent",
    ],
  ] as const)("refuses %s, asking nothing", async (_, context, kind) => {
    const { query, calls } = querying();

    const error = await refusal(
      query(
        "list_requests",
        {},
        { context: context() as QueryContext, credentialKind: kind },
      ),
    );

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: "forbidden",
      message: "This kind of credential is not admitted to this read",
    });
    expect(calls).toEqual([]);
  });
});

describe("an agent's call to the agent queries", () => {
  test("whoami answers the agent's own context and its project's work policy, lanes and scopes sorted", async () => {
    const policy = {
      heartbeatIntervalSeconds: 30,
      leaseMultiplier: 3,
      graceSeconds: 60,
      requiredWorkspaceFields: [],
    };
    const { query, calls } = querying({ getAgentPolicy: policy });
    const context = agentContext();

    await expect(
      query("whoami", {}, { context, credentialKind: "agent" }),
    ).resolves.toEqual({
      actor: context.actor,
      organizationId,
      projectId,
      laneIds: ["lane-b", "lane-a"],
      scopes: ["org:read", "project:read", "request:read", "request:write"],
      audience: "api",
      authorizationId: "core-query-grant",
      serverSchemaVersion: 1,
      workPolicy: policy,
    });
    expect(calls).toEqual([
      { method: "getAgentPolicy", args: [{ ...context, projectId }] },
    ]);
  });

  test("whoami refuses an agent whose project has no work policy", async () => {
    const { query } = querying({ getAgentPolicy: null });

    await expect(
      query("whoami", {}, { context: agentContext(), credentialKind: "agent" }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Project work policy is unavailable",
    });
  });

  test("a credential bound to no project is refused before its scope is checked and before anything is read", async () => {
    const { query, calls } = querying();

    await expect(
      query(
        "list_requests",
        {},
        {
          context: agentContext({ projectId: null, scopes: new Set() }),
          credentialKind: "agent",
        },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message:
        "This credential is not bound to a project, so it cannot reach project data",
    });
    expect(calls).toEqual([]);
  });

  test("a credential lacking the scope the registry gives the query is refused before anything is read", async () => {
    const { query, calls } = querying();

    await expect(
      query(
        "list_events",
        {},
        {
          context: agentContext({ scopes: new Set(["org:read"]) }),
          credentialKind: "agent",
        },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Agent scope is not sufficient",
    });
    expect(calls).toEqual([]);
  });

  test("list_requests reads its cursor, its limit as a number, and each state, as many as twenty", async () => {
    const { query, calls } = querying();
    const context = agentContext();

    await query(
      "list_requests",
      {
        searchParams: new URLSearchParams([
          ["cursor", "page-2"],
          ["limit", "50"],
          ["state", "triage"],
          ["state", "blocked"],
        ]),
      },
      { context, credentialKind: "agent" },
    );
    await query("list_requests", {}, { context, credentialKind: "agent" });

    expect(calls).toEqual([
      {
        method: "listRequests",
        args: [
          { ...context, projectId },
          { cursor: "page-2", limit: 50, state: ["triage", "blocked"] },
        ],
      },
      {
        method: "listRequests",
        args: [
          { ...context, projectId },
          { cursor: undefined, limit: undefined, state: [] },
        ],
      },
    ]);
  });

  test.each([
    ["a state that is not a request state", [["state", "open"]]],
    [
      "more than twenty states",
      Array.from({ length: 21 }, () => ["state", "triage"]),
    ],
  ])(
    "list_requests refuses %s as invalid input, reading nothing",
    async (_, entries) => {
      const { query, calls } = querying();

      const error = await refusal(
        query(
          "list_requests",
          {
            searchParams: new URLSearchParams(
              entries as unknown as [string, string][],
            ),
          },
          { context: agentContext(), credentialKind: "agent" },
        ),
      );

      expect(error).toBeInstanceOf(ZodError);
      expect(calls).toEqual([]);
    },
  );

  test.each([
    ["list_organizations", {}, "listOrganizations", []],
    ["list_projects", {}, "listProjects", []],
    ["get_project", { projectId: "p-1" }, "getProject", ["p-1"]],
    [
      "get_request_timeline",
      { requestId: "r-1" },
      "listTimeline",
      ["r-1", "t-cursor"],
    ],
    ["get_request", { requestId: "r-1" }, "getRequest", ["r-1"]],
    ["list_open_questions", {}, "listOpenQuestions", ["t-cursor"]],
    ["list_events", {}, "listEvents", ["t-cursor"]],
  ] as const)(
    "%s reaches %s with its path parameters and cursor",
    async (name, pathParameters, method, args) => {
      const { query, calls } = querying();
      const context = agentContext();

      await expect(
        query(
          name,
          {
            pathParameters,
            searchParams: new URLSearchParams([["cursor", "t-cursor"]]),
          },
          { context, credentialKind: "agent" },
        ),
      ).resolves.toEqual({ answeredBy: method });
      expect(calls).toEqual([
        { method, args: [{ ...context, projectId }, ...args] },
      ]);
    },
  );

  test.each([
    ["get_project", "getProject", "Project was not found"],
    ["get_request", "getRequest", "Request was not found"],
  ])(
    "%s answers what it does not find as not found",
    async (name, method, message) => {
      const { query } = querying({ [method]: null });

      await expect(
        query(
          name,
          { pathParameters: { projectId: "p-1", requestId: "r-1" } },
          { context: agentContext(), credentialKind: "agent" },
        ),
      ).rejects.toMatchObject({ code: "not_found", message });
    },
  );

  test("an agent's context without its lanes or its authorisation is a fault, not a pass", async () => {
    const { query, calls } = querying();

    for (const context of [
      agentContext({ laneIds: undefined }),
      agentContext({ authorizationId: undefined }),
    ]) {
      const error = await refusal(
        query("list_events", {}, { context, credentialKind: "agent" }),
      );
      expect(error).not.toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(Error);
    }
    expect(calls).toEqual([]);
  });
});

describe("an operator's call outside the administration reads", () => {
  test("whoami answers the operator's own context, with no work policy, reading nothing", async () => {
    const { query, calls } = querying();
    const context = operatorContext();

    await expect(
      query("whoami", {}, { context, credentialKind: "operator" }),
    ).resolves.toEqual({
      actor: context.actor,
      credentialKind: "operator",
      organizationId,
      projectId: null,
      scopes: ["org:read", "routing:manage"],
      authorizationId: "core-query-operator-key",
      serverSchemaVersion: 1,
    });
    expect(calls).toEqual([]);
  });

  test("a query whose entry admits agents only is refused, reading nothing", async () => {
    const { query, calls } = querying();

    await expect(
      query(
        "list_requests",
        {},
        { context: operatorContext(), credentialKind: "operator" },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Operator credentials are not admitted to this read",
    });
    expect(calls).toEqual([]);
  });

  test("a query an entry admits operators to, other than whoami, has no dispatch: a fault, not a pass", async () => {
    const registry = capabilityRegistry as QueryCapability[];
    const listEvents = registry.find((entry) => entry.name === "list_events");
    if (!listEvents) throw new Error("the registry holds no list_events");
    registry.push({
      ...listEvents,
      name: "core_query_operator_probe",
      credentialKinds: ["operator"],
      scope: null,
    });
    try {
      const { query, calls } = querying();
      const error = await refusal(
        query(
          "core_query_operator_probe",
          {},
          { context: operatorContext(), credentialKind: "operator" },
        ),
      );
      expect(error).not.toBeInstanceOf(DomainError);
      expect(String(error)).toContain("No operator dispatch");
      expect(calls).toEqual([]);
    } finally {
      registry.splice(registry.length - 1, 1);
    }
  });
});

describe("an administration read", () => {
  test("is run, for an operator holding its scope, with its parameters and what the RequestPort hands it", async () => {
    const read = recordRead("test_administration_route");
    const { query } = querying();
    const context = operatorContext();
    const searchParams = new URLSearchParams([["priority", "high"]]);

    await expect(
      query(
        "test_administration_route",
        { searchParams },
        { context, credentialKind: "operator" },
      ),
    ).resolves.toEqual({ readBy: "test_administration_route" });
    expect(read).toHaveBeenCalledExactlyOnceWith({
      context,
      pathParameters: {},
      searchParams,
      reading,
    });
  });

  test("refuses an operator lacking the entry's scope, reading nothing", async () => {
    const read = recordRead("list_administration_operations");
    const { query } = querying();

    await expect(
      query(
        "list_administration_operations",
        {},
        { context: operatorContext(), credentialKind: "operator" },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Credential scope is not sufficient",
    });
    expect(read).not.toHaveBeenCalled();
  });

  test("refuses an agent first, whatever its scopes, reading nothing", async () => {
    const read = recordRead("list_administration_routing_rules");
    const { query } = querying();

    await expect(
      query(
        "list_administration_routing_rules",
        {},
        {
          context: agentContext({ scopes: new Set(["routing:manage"]) }),
          credentialKind: "agent",
        },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "An agent credential cannot reach an administration read",
    });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("resolveRestQuery, the path step of the REST route's GET", () => {
  test.each([
    [["whoami"], "whoami", {}],
    [["projects", "p-1"], "get_project", { projectId: "p-1" }],
    [
      ["requests", "r-1", "timeline"],
      "get_request_timeline",
      { requestId: "r-1" },
    ],
    [["requests", "r-1"], "get_request", { requestId: "r-1" }],
    [["events"], "list_events", {}],
  ] as const)("names the agent query %j: %s", (parts, name, pathParameters) => {
    expect(resolveRestQuery(parts, agentContext())).toEqual({
      name,
      pathParameters,
    });
    expect(resolveRestQuery(parts, operatorContext())).toEqual({
      name,
      pathParameters,
    });
  });

  test("names an administration read under the prefix, with its path parameters, for an operator", () => {
    expect(
      resolveRestQuery(
        ["administration", "import-runs", "run-1"],
        operatorContext(),
      ),
    ).toEqual({
      name: "get_administration_import_run",
      pathParameters: { runId: "run-1" },
    });
  });

  test.each([
    [["administration"]],
    [["administration", "nothing"]],
    [["administration", "projects"]],
  ])(
    "refuses an agent at %j under the administration prefix before anything is looked up",
    (parts) => {
      expect(() => resolveRestQuery(parts, agentContext())).toThrowError(
        expect.objectContaining({
          code: "forbidden",
          message: "An agent credential cannot reach an administration read",
        }),
      );
    },
  );

  test.each([[["administration"]], [["administration", "nothing"]]])(
    "refuses an operator at %j, a path under the prefix no entry holds, as one no entry admits",
    (parts) => {
      expect(() => resolveRestQuery(parts, operatorContext())).toThrowError(
        expect.objectContaining({
          code: "forbidden",
          message:
            "This credential is not admitted to this administration read",
        }),
      );
    },
  );

  test("refuses an agent bound to no project before its path is looked up, even a path no entry holds", () => {
    for (const parts of [["events"], ["nothing"]]) {
      expect(() =>
        resolveRestQuery(parts, agentContext({ projectId: null })),
      ).toThrowError(expect.objectContaining({ code: "forbidden" }));
    }
  });

  test.each([[["nothing"]], [["projects", ""]], [["whoami", "extra"]], [[]]])(
    "answers %j, a path no entry holds, as not found, for an agent and an operator",
    (parts) => {
      for (const context of [agentContext(), operatorContext()]) {
        expect(() => resolveRestQuery(parts, context)).toThrowError(
          expect.objectContaining({
            code: "not_found",
            message: "API resource was not found",
          }),
        );
      }
    },
  );
});

describe("createAgentQueries", () => {
  test("refuses a context bound to no project before its repository is built, and hands the repository the context with its project", async () => {
    const repository = {
      listEvents: vi.fn(async () => ({ events: [] })),
    };
    const build = vi.fn(() => repository as never);
    const queries = createAgentQueries(build);
    const context = agentContext() as Parameters<AgentQueries["listEvents"]>[0];

    await expect(
      queries.listEvents({ ...context, projectId: null }, "c-1"),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(build).not.toHaveBeenCalled();

    await expect(queries.listEvents(context, "c-1")).resolves.toEqual({
      events: [],
    });
    expect(build).toHaveBeenCalledOnce();
    expect(repository.listEvents).toHaveBeenCalledWith(
      { ...context, projectId },
      "c-1",
    );
  });

  /*
   * Ruling 230 item 1 (J.10): each agent query checks its context's project
   * and scope in process, with `query`'s rule, so a caller of the published
   * API who hands `agentQueries` an agent's context directly is refused a
   * query its context has no project or scope for, as `query` would refuse
   * it. The scope is the one the registry gives the query whose dispatch is
   * the method, asked when the method runs.
   */
  const requestId = "018f0000-0000-7000-8000-0000000c0f08";
  /** Each agent query's arguments past its context. */
  const methodArguments: Record<keyof AgentQueries, unknown[]> = {
    getAgentPolicy: [],
    listOrganizations: [],
    listProjects: [],
    getProject: [projectId],
    listRequests: [{ cursor: "c-1", state: [] }],
    getRequest: [requestId],
    listTimeline: [requestId, "c-1"],
    listOpenQuestions: ["c-1"],
    listEvents: ["c-1"],
  };
  const methods = Object.keys(methodArguments) as Array<keyof AgentQueries>;
  const registry = capabilityRegistry as QueryCapability[];
  /** The registry's agent query entries, as it stands when this is read. */
  const agentQueryEntries = () =>
    registry.filter(
      (entry) =>
        entry.kind === "query" &&
        entry.dispatch.to === "agent-query-repository",
    );

  /** A repository that records each call, and how often it was built. */
  function recordingRepository() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const repository = Object.fromEntries(
      methods.map((method) => [
        method,
        async (...args: unknown[]) => {
          calls.push({ method, args });
          return { answeredBy: method };
        },
      ]),
    );
    const build = vi.fn(() => repository as never);
    return { queries: createAgentQueries(build), build, calls };
  }

  function caller(overrides: Partial<QueryContext> = {}): AgentQueryCaller {
    return agentContext(overrides) as AgentQueryCaller;
  }

  /**
   * Calls `method` for `context` as a consumer calls it, with no wrapper, so
   * a refusal these cases see is the returned promise's rejection.
   */
  function run(
    queries: AgentQueries,
    method: keyof AgentQueries,
    context: AgentQueryCaller,
  ) {
    const call = queries[method] as (
      context: AgentQueryCaller,
      ...rest: unknown[]
    ) => Promise<unknown>;
    return call(context, ...methodArguments[method]);
  }

  test("covers each method the registry dispatches an agent query to, once", () => {
    expect(
      agentQueryEntries()
        .map((entry) => entry.dispatch.method)
        .sort(),
    ).toEqual([...methods].sort());
  });

  test.each(
    agentQueryEntries().flatMap((entry) =>
      entry.scope === null
        ? []
        : [[entry.dispatch.method, entry.name, entry.scope] as const],
    ),
  )(
    "%s, serving %s, refuses a context holding every agent scope but %s before its repository is built, in query's words, and answers one holding only that scope",
    async (method, _name, scope) => {
      const { queries, build, calls } = recordingRepository();
      const lacking = caller({
        scopes: new Set(agentScopes.filter((held) => held !== scope)),
      });

      const error = await refusal(
        run(queries, method as keyof AgentQueries, lacking),
      );

      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({
        code: "forbidden",
        message: "Agent scope is not sufficient",
      });
      expect(build).not.toHaveBeenCalled();

      const holding = caller({ scopes: new Set([scope]) });
      await expect(
        run(queries, method as keyof AgentQueries, holding),
      ).resolves.toEqual({ answeredBy: method });
      expect(build).toHaveBeenCalledOnce();
      expect(calls).toEqual([
        {
          method,
          args: [
            { ...holding, projectId },
            ...methodArguments[method as keyof AgentQueries],
          ],
        },
      ]);
    },
  );

  test("getAgentPolicy, serving whoami, is answered holding no scope, as query asks none of whoami", async () => {
    const whoami = agentQueryEntries().find((entry) => entry.name === "whoami");
    expect(whoami?.dispatch.method).toBe("getAgentPolicy");
    expect(whoami?.scope).toBeNull();
    const { queries, build } = recordingRepository();

    await expect(
      run(queries, "getAgentPolicy", caller({ scopes: new Set() })),
    ).resolves.toEqual({ answeredBy: "getAgentPolicy" });
    expect(build).toHaveBeenCalledOnce();
  });

  test.each(methods)(
    "%s refuses a context bound to no project and holding no scope for its project first, as query does",
    async (method) => {
      const { queries, build } = recordingRepository();

      await expect(
        run(queries, method, caller({ projectId: null, scopes: new Set() })),
      ).rejects.toMatchObject({
        code: "forbidden",
        message:
          "This credential is not bound to a project, so it cannot reach project data",
      });
      expect(build).not.toHaveBeenCalled();
    },
  );

  /*
   * The methods are typed to return promises, so a refusal is the promise's
   * rejection, as `administrationReads` answers one: a consumer who writes
   * `.catch(…)`, or hands the calls to `Promise.all`, sees it there and never
   * as an exception thrown by the call itself (the review of J.10).
   */
  test.each(methods)(
    "%s refuses by rejecting the promise it returns, never by throwing when it is called: a context bound to no project, and one lacking its query's scope",
    async (method) => {
      const { queries, build } = recordingRepository();
      const entry = agentQueryEntries().find(
        (candidate) => candidate.dispatch.method === method,
      );
      const refused = [caller({ projectId: null, scopes: new Set() })];
      if (entry?.scope) {
        const lacking = entry.scope;
        refused.push(
          caller({
            scopes: new Set(agentScopes.filter((held) => held !== lacking)),
          }),
        );
      }

      for (const context of refused) {
        let returned: unknown;
        expect(() => {
          returned = run(queries, method, context);
        }).not.toThrow();
        expect(returned).toBeInstanceOf(Promise);
        const caught = await (returned as Promise<unknown>).catch(
          (error: unknown) => error,
        );
        expect(caught).toBeInstanceOf(DomainError);
        expect(caught).toMatchObject({ code: "forbidden" });
      }
      expect(build).not.toHaveBeenCalled();
    },
  );

  test("asks the registry for the scope when the query runs, as query does", async () => {
    const events = registry.find((entry) => entry.name === "list_events");
    if (!events) throw new Error("the registry holds no list_events");
    const scope = events.scope;
    (events as { scope: string | null }).scope = "core:probe-scope";
    try {
      const { queries, build } = recordingRepository();
      await expect(
        run(
          queries,
          "listEvents",
          caller({ scopes: new Set(["request:read"]) }),
        ),
      ).rejects.toMatchObject({ message: "Agent scope is not sufficient" });
      expect(build).not.toHaveBeenCalled();
      await expect(
        run(
          queries,
          "listEvents",
          caller({ scopes: new Set(["core:probe-scope"]) }),
        ),
      ).resolves.toEqual({ answeredBy: "listEvents" });
    } finally {
      (events as { scope: string | null }).scope = scope;
    }
  });

  test("a method the registry dispatches no query to, or more than one, is a fault, never a pass", async () => {
    const events = registry.find((entry) => entry.name === "list_events");
    if (!events) throw new Error("the registry holds no list_events");
    const dispatch = events.dispatch;
    const { queries, build } = recordingRepository();
    const everyScope = caller({ scopes: new Set(agentScopes) });

    (events as { dispatch: unknown }).dispatch = {
      to: "agent-query-repository",
      method: "coreProbeMethod",
    };
    try {
      const error = await refusal(run(queries, "listEvents", everyScope));
      expect(error).not.toBeInstanceOf(DomainError);
      expect(String(error)).toContain("listEvents");
    } finally {
      (events as { dispatch: unknown }).dispatch = dispatch;
    }

    registry.push({ ...events, name: "core_query_second_events_probe" });
    try {
      const error = await refusal(run(queries, "listEvents", everyScope));
      expect(error).not.toBeInstanceOf(DomainError);
      expect(String(error)).toContain("listEvents");
    } finally {
      registry.splice(registry.length - 1, 1);
    }
    expect(build).not.toHaveBeenCalled();
  });
});
