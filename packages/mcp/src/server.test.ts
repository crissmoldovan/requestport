import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { AgentAuthContext } from "@requestport/auth";
import type {
  AuthorizedCommandContext,
  CommandBus,
  CommandMeta,
  JsonValue,
} from "@requestport/domain";
import { afterEach, describe, expect, test } from "vitest";

import { createRequestPortMcpServer, type McpQueryServices } from "./server.js";

const organizationId = "018f0000-0000-7000-8000-000000000001";
const projectId = "018f0000-0000-7000-8000-000000000002";
const agentId = "018f0000-0000-7000-8000-000000000003";

function context(scopes: string[]): AgentAuthContext {
  return {
    actor: { type: "agent", id: agentId },
    organizationId,
    projectId,
    laneIds: new Set(),
    scopes: new Set(scopes),
    credentialId: "api-key-1",
    authorizationId: "authorization-1",
    audience: "mcp",
    correlationId: "018f0000-0000-7000-8000-000000000004",
  };
}

function queries(): McpQueryServices {
  return {
    getAgentPolicy: async () => ({
      heartbeatIntervalSeconds: 30,
      leaseMultiplier: 3,
      graceSeconds: 900,
      requiredWorkspaceFields: ["hostname", "pwd"],
    }),
    listOrganizations: async () => ({ items: [{ id: organizationId }] }),
    listProjects: async () => ({ items: [{ id: projectId }] }),
    getProject: async () => ({ id: projectId }),
    listRequests: async () => ({ items: [] }),
    getRequest: async () => ({ id: "request-1" }),
    listTimeline: async () => ({ items: [] }),
    listOpenQuestions: async () => ({ items: [] }),
    listEvents: async () => ({ items: [] }),
  };
}

const openConnections: Array<{
  client: Client;
  server: ReturnType<typeof createRequestPortMcpServer>;
}> = [];

afterEach(async () => {
  await Promise.all(
    openConnections.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }),
  );
});

async function connect(input: {
  scopes: string[];
  commandBus?: CommandBus;
  acceptsPrivateTelemetry?: boolean;
  context?: AgentAuthContext;
  createProject?: (
    input: Record<string, unknown>,
    meta: { correlationId: string },
  ) => Promise<JsonValue>;
  provisionAgent?: (
    input: Record<string, unknown>,
    meta: { idempotencyKey: string },
  ) => Promise<JsonValue>;
}) {
  const commandBus: CommandBus = input.commandBus ?? {
    async execute<_TInput, TOutput extends JsonValue>(): Promise<TOutput> {
      return { ok: true } as unknown as TOutput;
    },
  };
  const server = createRequestPortMcpServer({
    context: input.context ?? context(input.scopes),
    commandBus,
    queries: queries(),
    acceptsPrivateTelemetry: input.acceptsPrivateTelemetry,
    createProject: input.createProject,
    provisionAgent: input.provisionAgent,
  });
  const client = new Client({
    name: "RequestPort test client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openConnections.push({ client, server });
  return client;
}

describe("MCP least-privilege discovery", () => {
  test("advertises only tools allowed by the effective scopes", async () => {
    const client = await connect({ scopes: ["request:read"] });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("whoami");
    expect(names).toContain("agent_hello");
    expect(names).toContain("list_requests");
    expect(names).not.toContain("list_organizations");
    expect(names).not.toContain("list_projects");
    expect(names).not.toContain("create_request_draft");
    expect(names).not.toContain("register_machine_workspace");
    expect(names).not.toContain("create_event_subscription");
    expect(names).not.toContain("apply_legacy_import");
  });

  test("exposes organization and workspace tools only with scope and server support", async () => {
    const withoutEncryption = await connect({
      scopes: ["org:read", "agent:register"],
      acceptsPrivateTelemetry: false,
    });
    const first = (await withoutEncryption.listTools()).tools.map(
      (tool) => tool.name,
    );
    expect(first).toContain("list_organizations");
    expect(first).not.toContain("register_machine_workspace");

    const withEncryption = await connect({
      scopes: ["org:read", "agent:register"],
      acceptsPrivateTelemetry: true,
    });
    const second = (await withEncryption.listTools()).tools.map(
      (tool) => tool.name,
    );
    expect(second).toContain("register_machine_workspace");
  });
});

describe("MCP command and negotiation boundary", () => {
  test("defaults private telemetry negotiation to false", async () => {
    const client = await connect({ scopes: [] });
    const result = await client.callTool({
      name: "agent_hello",
      arguments: {
        softwareName: "Claude Code",
        softwareVersion: "1.0.0",
        capabilities: {},
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      agentPrincipalId: agentId,
      projectId,
      acceptsPrivateTelemetry: false,
      heartbeatIntervalSeconds: 30,
    });
  });

  test("injects the authenticated organization and strips command metadata from input", async () => {
    const calls: Array<{
      name: string;
      input: unknown;
      context: AuthorizedCommandContext;
      meta: CommandMeta;
    }> = [];
    const commandBus: CommandBus = {
      async execute<TInput, TOutput extends JsonValue>(args: {
        name: string;
        input: TInput;
        context: AuthorizedCommandContext;
        meta: CommandMeta;
      }): Promise<TOutput> {
        calls.push(args);
        return { requestId: "request-1" } as unknown as TOutput;
      },
    };
    const client = await connect({
      scopes: ["request:create"],
      commandBus,
    });
    const result = await client.callTool({
      name: "create_request_draft",
      arguments: {
        idempotencyKey: "mcp-idempotency-0001",
        expectedVersion: 0,
        targetProjectId: projectId,
        type: "feature",
        title: "Add durable handoffs",
        descriptionMd: "Create the canonical request.",
        priority: "normal",
        visibility: "organization",
        sensitivity: "normal",
        labels: [],
        acceptanceCriteria: [],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "create_request_draft",
      input: {
        organizationId,
        sourceKind: "project",
        sourceProjectId: projectId,
      },
      meta: {
        idempotencyKey: "mcp-idempotency-0001",
        expectedVersion: 0,
      },
    });
    expect(calls[0]?.input).not.toHaveProperty("idempotencyKey");
    expect(calls[0]?.input).not.toHaveProperty("expectedVersion");
  });
});

/**
 * Creating a project over MCP, and refusing to when the caller is not what the
 * consent screen promised.
 *
 * A provisioning grant is the one credential here that names no project — its
 * capability is organization-wide — so these tests use a context with a null
 * project on purpose. That is the shape the database now permits and nothing
 * else in this file exercises.
 */
function provisioningContext(
  overrides: Partial<AgentAuthContext> = {},
): AgentAuthContext {
  return {
    ...context(["project:provision"]),
    actor: {
      type: "agent",
      id: agentId,
      delegatedBy: { type: "user", id: "user-1" },
    },
    projectId: null,
    ...overrides,
  };
}

describe("creating a project", () => {
  /**
   * The dependency is supplied and only the scope is withheld, so the scope
   * gate is the only thing that can keep the tool out of the list.
   *
   * The first version of this test withheld both, and a mutation deleting the
   * scope check survived it: the absent dependency explained the absent tool
   * on its own. An assertion that passes for the wrong reason is worse than
   * none, because it is counted as coverage.
   */
  test("is not offered without the provisioning scope", async () => {
    const client = await connect({
      scopes: ["request:read"],
      createProject: async () => ({ id: "must-not-be-reachable" }),
    });
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).not.toContain("create_project");
  });

  test("is offered to a delegated provisioning grant", async () => {
    const created: unknown[] = [];
    const client = await connect({
      scopes: ["project:provision"],
      context: provisioningContext(),
      createProject: async (input) => {
        created.push(input);
        return { id: "project-created", slug: "orchard" };
      },
    });
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toContain("create_project");

    const result = await client.callTool({
      name: "create_project",
      arguments: {
        correlationId: "018f0000-0000-7000-8000-00000000aaaa",
        keyPrefix: "NOW",
        name: "Orchard",
        slug: "orchard",
      },
    });

    expect(result.isError ?? false).toBe(false);
    expect(created).toHaveLength(1);
  });

  /**
   * A provisioning grant holds nothing else, so a session carrying one must not
   * be able to reach a single project-scoped tool. Asserted against the tool
   * list rather than reasoned about, because the registration gate is the only
   * thing enforcing it.
   */
  /**
   * `agent_hello` negotiates the bound project's work policy, so a session with
   * no project could only ever be refused by it. RequestPort's own connection
   * sequence puts it at step four, so an agent following the documentation met
   * a wall the documentation did not mention.
   */
  test("does not offer agent_hello to a session with no project", async () => {
    const client = await connect({
      scopes: ["project:provision"],
      context: provisioningContext(),
      createProject: async () => ({ id: "project-1" }),
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("whoami");
    expect(names).not.toContain("agent_hello");
  });

  test("still offers agent_hello to an ordinary project session", async () => {
    const client = await connect({ scopes: ["request:read"] });
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("agent_hello");
  });

  test("leaves a provisioning session with no project-scoped tools", async () => {
    const client = await connect({
      scopes: ["project:provision"],
      context: provisioningContext(),
      createProject: async () => ({ id: "project-created" }),
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    for (const forbidden of [
      "claim_request",
      "list_requests",
      "get_request",
      "start_work_session",
      "post_work_update",
      "register_machine_workspace",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("provisioning an agent", () => {
  /**
   * Separate from `create_project` on purpose: making a project and minting a
   * credential are distinct audited acts, and a caller that only wants the
   * first should never be handed a secret it did not ask for.
   */
  test("is a separate tool from creating the project", async () => {
    const client = await connect({
      scopes: ["project:provision"],
      context: provisioningContext(),
      createProject: async () => ({ id: "project-1" }),
      provisionAgent: async () => ({ credential: "redacted" }),
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("create_project");
    expect(names).toContain("provision_agent");
  });

  /**
   * The dependency is supplied and only the scope withheld, so the scope gate
   * is the only thing that can keep the tool out of the list.
   */
  test("is not offered without the provisioning scope", async () => {
    const client = await connect({
      scopes: ["agent:register", "work:claim"],
      provisionAgent: async () => ({ credential: "must-not-be-reachable" }),
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).not.toContain("provision_agent");
  });

  test("provisions into the project it is given", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = await connect({
      scopes: ["project:provision"],
      context: provisioningContext(),
      provisionAgent: async (input) => {
        calls.push(input);
        return { credentialId: "credential-1" };
      },
    });

    const result = await client.callTool({
      name: "provision_agent",
      arguments: {
        displayName: "orchard",
        idempotencyKey: "018f0000-0000-7000-8000-00000000bbbb",
        projectId: "018f0000-0000-7000-8000-0000000000cc",
        scopes: ["agent:register", "work:claim", "work:update"],
        slug: "orchard",
      },
    });

    expect(result.isError ?? false).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.projectId).toBe("018f0000-0000-7000-8000-0000000000cc");
  });

  /**
   * A provisioning grant must not be able to mint another one. Minting
   * authority that can reproduce itself is a foothold rather than a
   * capability, and the exclusivity rule elsewhere would be pointless if the
   * scope could be handed out from here.
   */
  test("refuses to mint another provisioning credential", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = await connect({
      scopes: ["project:provision"],
      context: provisioningContext(),
      provisionAgent: async (input) => {
        calls.push(input);
        return { credentialId: "must-not-happen" };
      },
    });

    const result = await client.callTool({
      name: "provision_agent",
      arguments: {
        displayName: "self-replicating",
        idempotencyKey: "018f0000-0000-7000-8000-00000000cccc",
        projectId: "018f0000-0000-7000-8000-0000000000cc",
        scopes: ["project:provision"],
        slug: "self-replicating",
      },
    });

    expect(result.isError).toBe(true);
    // An error answer is the cheap half of the refusal. The secret is minted by
    // the dependency, so only an untouched dependency proves nothing was handed
    // out — a refusal that ran after the call would still answer with an error
    // while the credential existed.
    expect(calls).toHaveLength(0);
  });
});
