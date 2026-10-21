import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import type { AgentAuthContext } from "@requestport/auth";
import {
  agentScopes,
  type CommandBus,
  capabilityRegistry,
  findMcpToolTransport,
  type McpToolTransport,
  mcpOnlyTools,
  mcpToolTransports,
} from "@requestport/domain";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createRequestPortMcpServer,
  type McpServerDependencies,
} from "./server.js";

/*
  The MCP server registers its tools from the capability registry (Plan 13,
  F.1 step 2), and this file holds it to that at runtime rather than by
  reading its source.

  The first block changes the registry under the server, through
  `findMcpToolTransport`, and expects the server to follow: the scope that
  gates a tool, where a command dispatches, the action a lifecycle tool sends,
  the actions the generic `transition_request` admits, and a refusal to build
  at all, on any host, with a tool the registry does not name. The second
  block leaves the registry alone and checks the two agree: the tools listed
  are exactly the registry's and the declared MCP-only ones, each behind its
  registry scope, each reaching what its entry says it reaches, and every
  entry's own MCP tool name (including an entry reached by action through
  another tool) names a listed tool that admits that action.

  What each tool says about itself (names, descriptions, input schemas,
  annotations, order) is pinned separately by `server.tools-list.test.ts`.
*/

vi.mock("@requestport/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@requestport/domain")>();
  return {
    ...actual,
    findMcpToolTransport: vi.fn(actual.findMcpToolTransport),
  };
});

const { findMcpToolTransport: registryLookup } = await vi.importActual<
  typeof import("@requestport/domain")
>("@requestport/domain");

afterEach(() => {
  vi.mocked(findMcpToolTransport).mockImplementation(registryLookup);
  vi.restoreAllMocks();
});

/** Serve the registry with `change` applied to the named tools. */
function changeRegistry(
  changes: Record<string, (tool: McpToolTransport) => McpToolTransport | null>,
) {
  vi.mocked(findMcpToolTransport).mockImplementation((name) => {
    const tool = registryLookup(name);
    const change = changes[name];
    if (!tool || !change) return tool;
    return change(tool) ?? undefined;
  });
}

const organizationId = "018f0000-0000-7000-8000-0000000f2001";
const project = "018f0000-0000-7000-8000-0000000f2002";
const uuid = "018f0000-0000-7000-8000-0000000f2003";

function context(scopes: readonly string[]): AgentAuthContext {
  return {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000f2004" },
    organizationId,
    projectId: project,
    laneIds: new Set(),
    scopes: new Set(scopes),
    credentialId: "f1-registry-credential",
    authorizationId: "f1-registry-authorization",
    audience: "mcp",
    correlationId: "018f0000-0000-7000-8000-0000000f2005",
  };
}

/** Every dependency a tool can be gated on, each recording what reached it. */
function host(scopes: readonly string[]) {
  const reached: Array<{ via: string; name: string; input?: unknown }> = [];
  const record =
    (via: string, name: string) =>
    async (...args: unknown[]) => {
      reached.push({ via, name, input: args[0] });
      return {};
    };
  const commandBus: CommandBus = {
    execute: (async (command: { name: string; input: unknown }) => {
      reached.push({ via: "bus", name: command.name, input: command.input });
      return {};
    }) as CommandBus["execute"],
  };
  const queries = Object.fromEntries(
    [
      "getAgentPolicy",
      "listOrganizations",
      "listProjects",
      "getProject",
      "listRequests",
      "getRequest",
      "listTimeline",
      "listOpenQuestions",
      "listEvents",
    ].map((method) => [method, record("queries", method)]),
  ) as unknown as McpServerDependencies["queries"];
  const dependencies: McpServerDependencies = {
    context: context(scopes),
    commandBus,
    queries,
    acceptsPrivateTelemetry: true,
    registerProject: record("registerProject", "register"),
    createProject: record("createProject", "create"),
    provisionAgent: record("provisionAgent", "provision"),
    webhooks: {
      list: record("webhooks", "list"),
      create: record("webhooks", "create"),
      verify: record("webhooks", "verify"),
      rotate: record("webhooks", "rotate"),
      setStatus: record("webhooks", "setStatus"),
      replay: record("webhooks", "replay"),
    },
    imports: {
      list: record("imports", "list"),
      analyze: record("imports", "analyze"),
      detail: record("imports", "detail"),
      apply: record("imports", "apply"),
      correct: record("imports", "correct"),
    },
  };
  return { dependencies, reached };
}

/**
 * A host with only the dependencies the server requires, none of the
 * optional ones, private telemetry refused, and `projectId` as given.
 */
function bareHost(
  scopes: readonly string[],
  projectId: string | null,
): McpServerDependencies {
  const { dependencies } = host(scopes);
  return {
    context: { ...dependencies.context, projectId },
    commandBus: dependencies.commandBus,
    queries: dependencies.queries,
    acceptsPrivateTelemetry: false,
  };
}

async function connected(dependencies: McpServerDependencies) {
  const server = createRequestPortMcpServer(dependencies);
  const client = new Client({ name: "F.1 registry", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

async function listed(scopes: readonly string[]) {
  const { client, close } = await connected(host(scopes).dependencies);
  try {
    return (await client.listTools()).tools;
  } finally {
    await close();
  }
}

async function listedNames(scopes: readonly string[]) {
  return (await listed(scopes)).map((tool) => tool.name);
}

type Handler = (
  input: Record<string, unknown>,
  extra: unknown,
) => Promise<unknown>;

/**
 * The handler the server registers for `name`, caught on its way into the
 * SDK's `registerTool`, so it can be run without an input that passes the
 * tool's schema.
 */
function registeredHandler(
  dependencies: McpServerDependencies,
  name: string,
): Handler | undefined {
  const spy = vi.spyOn(McpServer.prototype, "registerTool");
  createRequestPortMcpServer(dependencies);
  const calls = spy.mock.calls as unknown as Array<[string, unknown, Handler]>;
  spy.mockRestore();
  return calls.find(([registered]) => registered === name)?.[2];
}

const meta = { idempotencyKey: "f1-registry-idempotency", expectedVersion: 0 };

/** A valid claim_request call, which the probes below dispatch. */
const claim = {
  ...meta,
  requestId: uuid,
  installationId: uuid,
  workspaceId: uuid,
};

describe("the server follows the registry", () => {
  /** One tool of each registration form the server has. */
  const gatedForms = [
    "close_question",
    "claim_request",
    "begin_request_work",
    "transition_request",
    "register_project",
    "list_events",
    "whoami",
  ];

  test.each(gatedForms)(
    "gates %s on the scope the registry gives it",
    async (name) => {
      changeRegistry({
        [name]: (tool) => ({ ...tool, requiredScope: "f1:probe" }),
      });
      expect(await listedNames(["f1:probe"])).toContain(name);
      expect(await listedNames(agentScopes)).not.toContain(name);
    },
  );

  test("dispatches a command tool to the command the registry names", async () => {
    changeRegistry({
      claim_request: (tool) =>
        tool.kind === "command"
          ? {
              ...tool,
              dispatch: {
                to: "command-bus",
                commandName: "f1_probe_command" as "claim_request",
              },
            }
          : tool,
    });
    const { dependencies, reached } = host(agentScopes);
    const { client, close } = await connected(dependencies);
    try {
      const result = await client.callTool({
        name: "claim_request",
        arguments: claim,
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await close();
    }
    expect(reached.map((entry) => entry.name)).toEqual(["f1_probe_command"]);
  });

  test("sends the lifecycle action the registry names", async () => {
    changeRegistry({
      claim_request: (tool) =>
        tool.kind === "command"
          ? { ...tool, action: "f1_probe_action" as "submit_request" }
          : tool,
    });
    const { dependencies, reached } = host(agentScopes);
    const { client, close } = await connected(dependencies);
    try {
      await client.callTool({ name: "claim_request", arguments: claim });
    } finally {
      await close();
    }
    expect(reached[0]?.input).toMatchObject({ action: "f1_probe_action" });
  });

  test("admits through transition_request the actions the registry gives it", async () => {
    changeRegistry({
      transition_request: (tool) =>
        tool.kind === "command"
          ? { ...tool, actions: ["cancel_request", "begin_triage"] }
          : tool,
    });
    const tool = (await listed(agentScopes)).find(
      (entry) => entry.name === "transition_request",
    );
    expect(tool?.inputSchema.properties?.action).toMatchObject({
      enum: ["cancel_request", "begin_triage"],
    });
  });

  /**
   * The hosts a missing entry must fail on: the fullest, and three on which
   * every tool below but `whoami` goes unlisted, so a server that skipped the
   * lookup for a tool it was not going to register would build there.
   */
  const hosts: Record<string, () => McpServerDependencies> = {
    "every agent scope": () => host(agentScopes).dependencies,
    "no scope": () => bareHost([], project),
    "one unrelated scope": () => bareHost(["webhook:manage"], project),
    "a provisioning grant with no project": () =>
      bareHost(["project:provision"], null),
  };

  /** One tool of each registration form, and each host condition. */
  const missable = [
    "claim_request",
    "begin_request_work",
    "transition_request",
    "register_project",
    "register_machine_workspace",
    "list_events",
    "whoami",
  ];

  test.each(
    Object.keys(hosts).flatMap((label) =>
      missable.map((name) => [name, label] as const),
    ),
  )(
    "will not build with %s missing from the registry, on %s",
    (name, label) => {
      changeRegistry({ [name]: () => null });
      const dependencies = hosts[label]?.();
      if (!dependencies) throw new Error(label);
      expect(() => createRequestPortMcpServer(dependencies)).toThrow(name);
    },
  );
});

describe("the server and the registry agree", () => {
  test("every host lists only registry tools and declared MCP-only tools, and the fullest lists each once", async () => {
    const accounted = new Set<string>([
      ...mcpToolTransports.map((tool) => tool.name),
      ...mcpOnlyTools,
    ]);
    expect(accounted.size).toBe(mcpToolTransports.length + mcpOnlyTools.length);
    const fullest = await listedNames(agentScopes);
    expect([...fullest].sort()).toEqual([...accounted].sort());
    for (const scope of agentScopes)
      for (const name of await listedNames([scope]))
        expect(accounted.has(name), `${scope}: ${name}`).toBe(true);
  });

  /*
    Every entry's own `mcpTool.name`, including the lifecycle entries whose
    tool carries `action` and which `mcpToolTransports` leaves out because
    they add no tool: each must name a tool the server lists, and one reached
    by action must list that action in its `action` input.
  */
  test("every registry entry's MCP tool is listed, admitting the action it sends", async () => {
    const tools = new Map(
      (await listed(agentScopes)).map((tool) => [tool.name, tool]),
    );
    const named = capabilityRegistry.flatMap((capability) =>
      capability.mcpTool
        ? [[capability.name, capability.mcpTool] as const]
        : [],
    );
    expect(named.some(([, mcpTool]) => mcpTool.action)).toBe(true);
    for (const [name, mcpTool] of named) {
      const tool = tools.get(mcpTool.name);
      expect(tool, `${name} names ${mcpTool.name}`).toBeDefined();
      if (mcpTool.action)
        expect(
          tool?.inputSchema.properties?.action,
          `${name} sends ${mcpTool.action} through ${mcpTool.name}`,
        ).toMatchObject({ enum: expect.arrayContaining([mcpTool.action]) });
    }
  });

  test.each(mcpToolTransports.map((tool) => [tool.name, tool] as const))(
    "%s is listed behind its registry scope and no other",
    async (name, tool) => {
      if (tool.requiredScope === null) {
        expect(await listedNames([])).toContain(name);
        return;
      }
      expect(await listedNames([tool.requiredScope])).toContain(name);
      expect(
        await listedNames(
          agentScopes.filter((scope) => scope !== tool.requiredScope),
        ),
      ).not.toContain(name);
    },
  );

  test.each(
    mcpToolTransports.flatMap((tool) =>
      tool.kind === "command" ? [[tool.name, tool] as const] : [],
    ),
  )("%s dispatches where its registry entry does", async (name, tool) => {
    const { dependencies, reached } = host(agentScopes);
    const callback = registeredHandler(dependencies, name);
    expect(callback, name).toBeDefined();
    // The handler is reached directly, so no input schema stands in the way.
    await callback?.({ ...meta, audienceType: "user" }, {});
    if (tool.dispatch.to !== "command-bus") {
      // `register_project` is the one MCP tool off the bus. Plan 13, F.2.2's
      // two agent revocations, F.2.5's connection test and F.2.6's import
      // split are off the bus too, and have no MCP tool (ruling 2), so none
      // reaches here.
      expect(tool.dispatch.to).toBe("project-registration-repository");
      expect(reached.map((entry) => entry.via)).toEqual(["registerProject"]);
      return;
    }
    expect(reached).toHaveLength(1);
    expect(reached[0]?.name).toBe(tool.dispatch.commandName);
    expect(reached[0]?.input).toMatchObject({ organizationId });
    if (tool.action)
      expect(reached[0]?.input).toMatchObject({ action: tool.action });
    else expect(reached[0]?.input).not.toHaveProperty("action");
  });

  // Every agent query but whoami. An administration read (Plan 13, F.2) has
  // no MCP tool (ruling 2); `transport-metadata.test.ts` holds that its
  // `mcpTool` is null, and the projection above leaves it out.
  test.each(
    capabilityRegistry.flatMap((capability) =>
      capability.kind === "query" &&
      capability.dispatch.to === "agent-query-repository" &&
      capability.name !== "whoami"
        ? [[capability.name, capability.dispatch.method] as const]
        : [],
    ),
  )(
    "%s reads the repository method its registry entry does",
    async (name, method) => {
      const { dependencies, reached } = host(agentScopes);
      const callback = registeredHandler(dependencies, name);
      expect(callback, name).toBeDefined();
      await callback?.({ requestId: uuid, projectId: uuid }, {});
      expect(reached).toEqual([
        expect.objectContaining({ via: "queries", name: method }),
      ]);
    },
  );

  test("whoami answers from the credential, reaching no repository", async () => {
    const { dependencies, reached } = host([]);
    const { client, close } = await connected(dependencies);
    try {
      await client.callTool({ name: "whoami", arguments: {} });
    } finally {
      await close();
    }
    expect(reached).toEqual([]);
  });

  test("transition_request admits the actions the registry gives it, in order", async () => {
    const generic = findMcpToolTransport("transition_request");
    const tool = (await listed(agentScopes)).find(
      (entry) => entry.name === "transition_request",
    );
    expect(generic?.kind === "command" && generic.actions).toBeTruthy();
    expect(tool?.inputSchema.properties?.action).toMatchObject({
      enum: generic?.kind === "command" ? generic.actions : [],
    });
  });
});
