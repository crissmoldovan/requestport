import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import type { AgentAuthContext } from "@requestport/auth";
import {
  agentScopes,
  type CommandBus,
  type JsonValue,
} from "@requestport/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { z } from "zod";

import {
  createRequestPortMcpServer,
  handleMcpRequest,
  type McpServerDependencies,
} from "./server.js";
import { zod443Departures } from "./test-support/zod-departures.js";

/*
  The MCP tools' own input schemas answer as they did on zod 4.4.3, which
  RequestPort 0.2.0 published, though the workspace runs zod 4.6.7: string
  lengths in UTF-16 code units, a datetime's seconds optional, a URL kept as
  sent (`@requestport/domain`'s `zod-compat.ts`). The SDK validates a call
  against these schemas before a tool runs, so they decide what a caller is
  refused.
*/

const organizationId = "018f0000-0000-7000-8000-0000000b0001";
const projectId = "018f0000-0000-7000-8000-0000000b0002";
const requestId = "018f0000-0000-7000-8000-0000000b0003";

const unreachable = async (): Promise<never> => {
  throw new Error("not reached");
};

function context(): AgentAuthContext {
  return {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000b0004" },
    organizationId,
    projectId,
    laneIds: new Set(),
    scopes: new Set(agentScopes),
    credentialId: "zod-443-credential",
    authorizationId: "zod-443-authorization",
    audience: "mcp",
    correlationId: "018f0000-0000-7000-8000-0000000b0005",
  };
}

const queries = {
  getAgentPolicy: unreachable,
  listOrganizations: unreachable,
  listProjects: unreachable,
  getProject: unreachable,
  listRequests: unreachable,
  getRequest: unreachable,
  listTimeline: unreachable,
  listOpenQuestions: unreachable,
  listEvents: unreachable,
};

const service = {
  list: unreachable,
  create: unreachable,
  verify: unreachable,
  rotate: unreachable,
  setStatus: unreachable,
  replay: unreachable,
};

function dependencies(commandBus: CommandBus): McpServerDependencies {
  return {
    context: context(),
    commandBus,
    queries,
    acceptsPrivateTelemetry: true,
    registerProject: unreachable,
    createProject: unreachable,
    provisionAgent: unreachable,
    webhooks: service,
    imports: {
      list: unreachable,
      analyze: unreachable,
      detail: unreachable,
      apply: unreachable,
      correct: unreachable,
    },
  };
}

function build(commandBus: CommandBus) {
  return createRequestPortMcpServer(dependencies(commandBus));
}

const open: Array<{ client: Client; server: McpServer }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    open.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }),
  );
});

async function connect() {
  const calls: Array<{ name: string; input: unknown }> = [];
  const commandBus: CommandBus = {
    async execute<TInput, TOutput extends JsonValue>(args: {
      name: string;
      input: TInput;
    }): Promise<TOutput> {
      calls.push({ name: args.name, input: args.input });
      return { requestId } as unknown as TOutput;
    },
  };
  const server = build(commandBus);
  const client = new Client({ name: "zod 4.4.3 rules", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push({ client, server });
  return { client, calls };
}

const meta = { idempotencyKey: "zod-443-rules-0001", expectedVersion: 1 };

describe("the MCP tools keep zod 4.4.3's string rules", () => {
  test("no tool's input schema departs from them", () => {
    const schemas: [string, z.ZodType][] = [];
    const original = McpServer.prototype.registerTool;
    vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(function (
      this: McpServer,
      ...args: Parameters<McpServer["registerTool"]>
    ) {
      const [name, config] = args;
      schemas.push([name, config.inputSchema as unknown as z.ZodType]);
      return original.apply(this, args);
    });
    build({ execute: unreachable });
    expect(schemas.length).toBeGreaterThan(40);
    expect(
      schemas.flatMap(([name, schema]) => zod443Departures(schema, name)),
    ).toEqual([]);
  });

  test("ask_question passes a deadline without seconds on, as sent", async () => {
    const { client, calls } = await connect();
    const result = await client.callTool({
      name: "ask_question",
      arguments: {
        ...meta,
        requestId,
        audienceType: "requester",
        bodyMd: "Which one?",
        deadlineAt: "2026-10-05T12:30Z",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({
        name: "ask_question",
        input: expect.objectContaining({ deadlineAt: "2026-10-05T12:30Z" }),
      }),
    ]);
  });

  test("attach_artifact keeps a tab inside the URL, as sent", async () => {
    const { client, calls } = await connect();
    const result = await client.callTool({
      name: "attach_artifact",
      arguments: {
        ...meta,
        requestId,
        kind: "pull_request",
        externalUrl: "https://exa\tmple.com/pr/1",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          externalUrl: "https://exa\tmple.com/pr/1",
        }),
      }),
    ]);
  });

  test("register_project refuses a repository URL whose scheme holds a tab", async () => {
    const { client, calls } = await connect();
    const result = await client.callTool({
      name: "register_project",
      arguments: {
        ...meta,
        alias: "widget",
        repositoryUrl: "h\tttps://github.com/acme/widget",
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      'repositoryUrl: Invalid string: must start with \\"https://github.com/\\"',
    );
    expect(calls).toEqual([]);
  });

  test("a title is counted in UTF-16 code units", async () => {
    const { client, calls } = await connect();
    // 121 emoji: 242 units, over create_request_draft's 240.
    const result = await client.callTool({
      name: "create_request_draft",
      arguments: {
        idempotencyKey: "zod-443-rules-0002",
        expectedVersion: 0,
        targetProjectId: projectId,
        type: "feature",
        title: "\u{1F600}".repeat(121),
        descriptionMd: "Counted in units.",
        priority: "normal",
        visibility: "organization",
        sensitivity: "normal",
        labels: [],
        acceptanceCriteria: [],
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "title: Too big: expected string to have <=240 characters",
    );
    expect(calls).toEqual([]);
  });
});

/** A command bus that records each command it is handed. */
function recordingBus() {
  const calls: Array<{ name: string; input: unknown }> = [];
  const commandBus: CommandBus = {
    async execute<TInput, TOutput extends JsonValue>(args: {
      name: string;
      input: TInput;
    }): Promise<TOutput> {
      calls.push({ name: args.name, input: args.input });
      return { requestId } as unknown as TOutput;
    },
  };
  return { calls, commandBus };
}

const modernEnvelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "zod 4.4.3 rules",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/**
 * One `tools/call` of `ask_question` through `handleMcpRequest`, on the
 * 2025-era leg or the 2026-07-28 one, its arguments the JSON text given, so
 * that they can carry what an object literal cannot hand `JSON.stringify` (an
 * own `__proto__` key) and what it never writes (a non-finite number).
 */
async function callOverHttp(
  commandBus: CommandBus,
  argumentsJson: string,
  era: "2025-06-18" | "2026-07-28",
) {
  const modern = era === "2026-07-28";
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": era,
  };
  if (modern) {
    headers["mcp-method"] = "tools/call";
    headers["mcp-name"] = "ask_question";
  }
  const meta = modern ? `,"_meta":${JSON.stringify(modernEnvelope)}` : "";
  const response = await handleMcpRequest(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_question","arguments":${argumentsJson}${meta}}}`,
    }),
    { ...dependencies(commandBus), modernProtocol: modern },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  return {
    isError: body.result?.isError === true,
    text: body.result?.content?.map((part) => part.text).join("\n") ?? "",
  };
}

const askQuestion = `"idempotencyKey":"zod-443-rules-0003","requestId":"${requestId}","audienceType":"requester","bodyMd":"Which one?"`;

describe("the MCP transport answers as zod 4.4.3 did, beyond the string rules", () => {
  beforeEach(() => {
    // The 2026-07-28 leg's handler warns once per request about mid-call
    // notifications, which this server never emits (modern-wire.test.ts).
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  test.each(["2025-06-18", "2026-07-28"] as const)(
    "%s: drops an own __proto__ key in a tool's arguments, and ask_question's escalation policy reaches the bus without it",
    async (era) => {
      const { calls, commandBus } = recordingBus();
      const result = await callOverHttp(
        commandBus,
        `{${askQuestion},"expectedVersion":1,"escalationPolicy":{"__proto__":{"polluted":true}}}`,
        era,
      );
      expect(result).toMatchObject({ isError: false });
      expect(calls).toHaveLength(1);
      const input = calls[0]?.input as { escalationPolicy?: object };
      expect(input.escalationPolicy).toBeDefined();
      expect(Object.hasOwn(input.escalationPolicy ?? {}, "__proto__")).toBe(
        false,
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  test.each(["2025-06-18", "2026-07-28"] as const)(
    "%s: refuses a number too large to be finite in 4.4.3's words, received number",
    async (era) => {
      const { calls, commandBus } = recordingBus();
      const result = await callOverHttp(
        commandBus,
        `{${askQuestion},"expectedVersion":1e999}`,
        era,
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain(
        "expectedVersion: Invalid input: expected number, received number",
      );
      expect(calls).toEqual([]);
    },
  );
});
