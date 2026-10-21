import { readFileSync } from "node:fs";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { AgentAuthContext } from "@requestport/auth";
import {
  agentScopes,
  type CommandBus,
  type JsonValue,
} from "@requestport/domain";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { handleMcpRequest, type McpServerDependencies } from "./server.js";

/*
  The 2026-07-28 leg of `handleMcpRequest` (Plan 13 K.1, `manifest-k.md`
  Scope K.1 items 3, 3a and 4, Done when K.1 3).

  `handleMcpRequest` serves both eras. With `modernProtocol` true, a request
  the SDK's own `isLegacyRequest` does not classify as 2025-era goes to
  `createMcpHandler(…, { legacy: "reject", responseMode: "json" })`, built per
  request; everything else, and every request while `modernProtocol` is false
  (the route sets it only for `REQUESTPORT_MCP_MODERN=enabled`), goes to the
  2025 transport exactly as before, which `legacy-wire.test.ts` pins.

  `InMemoryTransport` connects 2025-era instances only, so the 2026 lane here
  is HTTP: raw `Request`s, and the v2 client negotiating 2026-07-28 with a
  `fetch` that is `handleMcpRequest` itself.
*/

const organizationId = "018f0000-0000-7000-8000-0000000c2001";
const projectId = "018f0000-0000-7000-8000-0000000c2002";
const requestId = "018f0000-0000-7000-8000-0000000c2005";

function context(scopes: readonly string[]): AgentAuthContext {
  return {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000c2003" },
    organizationId,
    projectId,
    laneIds: new Set(),
    scopes: new Set(scopes),
    credentialId: "k1-modern-wire-credential",
    authorizationId: "k1-modern-wire-authorization",
    audience: "mcp",
    correlationId: "018f0000-0000-7000-8000-0000000c2004",
  };
}

const unreachable = async (): Promise<never> => {
  throw new Error("the modern wire cases reach no other dependency");
};

const executed: Array<{ name: string; input: unknown }> = [];

const commandBus: CommandBus = {
  async execute<_TInput, TOutput extends JsonValue>(command: {
    name: string;
    input: unknown;
  }): Promise<TOutput> {
    executed.push({ name: command.name, input: command.input });
    return { accepted: true } as unknown as TOutput;
  },
} as CommandBus;

function dependencies(
  scopes: readonly string[],
  modernProtocol = true,
): McpServerDependencies {
  return {
    context: context(scopes),
    commandBus,
    queries: {
      getAgentPolicy: unreachable,
      listOrganizations: unreachable,
      listProjects: unreachable,
      getProject: unreachable,
      listRequests: unreachable,
      getRequest: unreachable,
      listTimeline: unreachable,
      listOpenQuestions: unreachable,
      listEvents: unreachable,
    },
    modernProtocol,
  };
}

const clientInfo = { name: "RequestPort modern wire", version: "1.0.0" };

const envelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": clientInfo,
  "io.modelcontextprotocol/clientCapabilities": {},
};

function modernPost(
  method: string,
  params: Record<string, unknown> = {},
  options: { protocolHeader?: boolean; name?: string; id?: number } = {},
) {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": method,
  };
  if (options.protocolHeader !== false)
    headers["mcp-protocol-version"] = "2026-07-28";
  if (options.name) headers["mcp-name"] = options.name;
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: options.id ?? 7,
      method,
      params: { ...params, _meta: envelope },
    }),
  });
}

async function json(response: Response) {
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as {
    result?: Record<string, unknown> & {
      tools?: Array<{ name: string }>;
    };
    error?: { code: number; message: string };
  };
}

beforeEach(() => {
  executed.length = 0;
  // `responseMode: "json"` warns once per handler, and K.1 builds one per
  // request; the warning is about mid-call notifications, which this server
  // never emits.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the 2026-07-28 leg, with modernProtocol on", () => {
  test("server/discover offers 2026-07-28", async () => {
    const response = await handleMcpRequest(
      modernPost("server/discover"),
      dependencies(agentScopes),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.error).toBeUndefined();
    expect(body.result?.supportedVersions).toContain("2026-07-28");
  });

  test("server/discover does not advertise tools.listChanged", async () => {
    const response = await handleMcpRequest(
      modernPost("server/discover"),
      dependencies(agentScopes),
    );
    const body = await json(response);
    expect(body.result?.capabilities).toMatchObject({
      tools: { listChanged: false },
    });
  });

  test("tools/list is the scope-filtered set, in one order, cached privately", async () => {
    const list = async (scopes: readonly string[]) => {
      const response = await handleMcpRequest(
        modernPost("tools/list"),
        dependencies(scopes),
      );
      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body.error).toBeUndefined();
      return body.result as {
        tools: Array<{ name: string }>;
        cacheScope?: string;
        ttlMs?: number;
      };
    };
    const legacyNames = async (scopes: readonly string[]) => {
      const response = await handleMcpRequest(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
          }),
        }),
        dependencies(scopes),
      );
      return ((await json(response)).result?.tools ?? []).map(
        (tool) => tool.name,
      );
    };

    const readOnly = await list(["request:read"]);
    const names = readOnly.tools.map((tool) => tool.name);
    expect(names).toContain("whoami");
    expect(names).toContain("list_requests");
    expect(names).not.toContain("submit_request");
    expect(names).toStrictEqual(await legacyNames(["request:read"]));

    const first = await list(agentScopes);
    const second = await list(agentScopes);
    const order = first.tools.map((tool) => tool.name);
    expect(order).toContain("submit_request");
    expect(second.tools.map((tool) => tool.name)).toStrictEqual(order);
    expect(order).toStrictEqual(await legacyNames(agentScopes));

    // The list varies with the credential's scopes, so it may never be
    // cached for anyone else.
    for (const result of [readOnly, first, second])
      expect(result.cacheScope).toBe("private");
  });

  test("tools/call to whoami and to a command both complete", async () => {
    const whoami = await json(
      await handleMcpRequest(
        modernPost(
          "tools/call",
          { name: "whoami", arguments: {} },
          {
            name: "whoami",
          },
        ),
        dependencies(["request:read"]),
      ),
    );
    expect(whoami.error).toBeUndefined();
    expect(whoami.result?.resultType).toBe("complete");
    expect(whoami.result?.structuredContent).toMatchObject({
      organizationId,
      scopes: ["request:read"],
    });

    const submit = await json(
      await handleMcpRequest(
        modernPost(
          "tools/call",
          {
            name: "submit_request",
            arguments: {
              idempotencyKey: "k1-modern-wire-submit",
              expectedVersion: 1,
              requestId,
            },
          },
          { name: "submit_request" },
        ),
        dependencies(agentScopes),
      ),
    );
    expect(submit.error).toBeUndefined();
    expect(submit.result?.resultType).toBe("complete");
    expect(submit.result?.isError).not.toBe(true);
    // The registry decides which command the tool runs; the call reached it.
    expect(executed).toEqual([
      {
        name: expect.any(String),
        input: expect.objectContaining({ requestId, organizationId }),
      },
    ]);
  });

  test("a modern POST without MCP-Protocol-Version is refused 400/-32020", async () => {
    const response = await handleMcpRequest(
      modernPost("tools/list", {}, { protocolHeader: false }),
      dependencies(agentScopes),
    );
    expect(response.status).toBe(400);
    expect((await json(response)).error?.code).toBe(-32020);
  });

  test("a body over 524,288 bytes is refused by RequestPort's bound, not the SDK's 4 MiB", async () => {
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "whoami",
        arguments: { padding: "x".repeat(600_000) },
        _meta: envelope,
      },
    });
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "whoami",
    };

    const declared = await handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(Buffer.byteLength(oversized)),
        },
        body: oversized,
      }),
      dependencies(agentScopes),
    );
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "request_too_large" });

    // With no length declared, the SDK reads the body, under the same bound.
    const streamed = await handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers,
        body: new Blob([oversized]).stream(),
        duplex: "half",
      } as RequestInit),
      dependencies(agentScopes),
    );
    expect(streamed.status).toBe(413);
    expect((await json(streamed)).error?.message).toContain("524288");
  });

  test("a streamed 2025-era body over 524,288 bytes is refused, not handed to the 2025 transport", async () => {
    // Telling the eras apart means reading the body. With the leg on, that
    // read is bounded at 524,288 bytes too, so an undeclared length cannot
    // reach the 2025 transport, whose own default is 4 MiB.
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "whoami", arguments: { padding: "x".repeat(600_000) } },
    });
    const response = await handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
        },
        body: new Blob([oversized]).stream(),
        duplex: "half",
      } as RequestInit),
      dependencies(agentScopes),
    );
    expect(response.status).toBe(413);
    expect((await json(response)).error?.message).toContain("524288");
  });

  test("a subscriptions/listen stream is closed at once, gracefully", async () => {
    const response = await handleMcpRequest(
      modernPost("subscriptions/listen", {
        notifications: { toolsListChanged: true },
      }),
      dependencies(agentScopes),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // `text()` resolves only when the stream ends: a stream held open would
    // hold a serverless function until its time limit.
    const frames = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)));
    expect(frames[0]).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: {} },
    });
    expect(frames.at(-1)).toMatchObject({
      id: 7,
      result: { resultType: "complete" },
    });
  });

  test("2025-era traffic still takes the 2025 transport", async () => {
    const legacy = (body: unknown, protocolVersion: string | null) => {
      const headers: Record<string, string> = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };
      if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
      return () =>
        new Request("http://localhost/mcp", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
    };
    for (const request of [
      legacy(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo,
          },
        },
        null,
      ),
      legacy(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        },
        "2025-06-18",
      ),
    ]) {
      expect(
        await observe(request(), dependencies(["request:read"], true)),
      ).toStrictEqual(
        await observe(request(), dependencies(["request:read"], false)),
      );
    }
  });
});

describe("the 2026-07-28 leg, with modernProtocol off", () => {
  test("a server/discover probe gets the answer recorded on SDK 1.30.1", async () => {
    const golden = JSON.parse(
      readFileSync(new URL("./legacy-wire.golden.json", import.meta.url), {
        encoding: "utf8",
      }),
    ) as Record<string, unknown>;
    expect(
      await observe(
        modernPost("server/discover", {}, { id: 6 }),
        dependencies(agentScopes, false),
      ),
    ).toStrictEqual(golden["a 2026-07-28 server/discover probe"]);
  });
});

/** What a client observes of one exchange: status, content type, JSON body. */
async function observe(request: Request, with_: McpServerDependencies) {
  const response = await handleMcpRequest(request, with_);
  const text = await response.text();
  const contentType = response.headers.get("content-type");
  return {
    status: response.status,
    contentType,
    body:
      text === ""
        ? null
        : contentType?.includes("application/json")
          ? JSON.parse(text)
          : text,
  };
}

describe("the v2 client, negotiating 2026-07-28 through handleMcpRequest", () => {
  async function connect(scopes: readonly string[]) {
    const client = new Client(clientInfo, {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/mcp"),
      {
        fetch: async (input, init) =>
          handleMcpRequest(new Request(input, init), dependencies(scopes)),
      },
    );
    await client.connect(transport);
    return client;
  }

  test("lists and calls tools on the modern era", async () => {
    const client = await connect(["request:read"]);
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools[0]).toBe("whoami");
      expect(tools).toContain("list_requests");
      expect(tools).not.toContain("submit_request");

      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        organizationId,
        scopes: ["request:read"],
      });
    } finally {
      await client.close();
    }
  });

  test("falls back to the 2025 handshake when the leg is off", async () => {
    const client = new Client(clientInfo, {
      versionNegotiation: { mode: "auto" },
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/mcp"),
      {
        fetch: async (input, init) =>
          handleMcpRequest(
            new Request(input, init),
            dependencies(["request:read"], false),
          ),
      },
    );
    await client.connect(transport);
    try {
      expect(client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28");
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain("whoami");
    } finally {
      await client.close();
    }
  });
});
