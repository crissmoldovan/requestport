import { readFileSync, writeFileSync } from "node:fs";

import type { AgentAuthContext } from "@requestport/auth";
import { agentScopes, type CommandBus, DomainError } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import { handleMcpRequest, type McpServerDependencies } from "./server.js";

/*
  The 2025-era wire, as `handleMcpRequest` answered it on the v1 SDK at
  1.30.1, before Plan 13 K.1 moved the package to the v2 SDK. Every agent
  connected today speaks this wire, so while the 2026-07-28 leg is off the move
  keeps it as it was, except for the four SDK differences the driver accepted
  on 2026-09-29 and described below (`manifest-k.md`, Scope K.1 items 2 and 3a;
  R6).

  Each case is one HTTP exchange through `handleMcpRequest`, which is what
  `@requestport/server`'s MCP handler (`packages/server/src/mcp.ts`), which
  the web's `/mcp` route composes, calls after authenticating the bearer.
  What is pinned is what a client can observe: the status, the
  `content-type`, and the body parsed as JSON. The GET is the exception: on
  1.30.1 it opens an SSE stream that stays idle until the host's time limit,
  so its body is not read.

  The full tool list is deliberately not pinned here: Plan 13's F.2 groups keep
  adding tools, and `server.tools-list.test.ts` owns that list. For each scope
  set this pins the `tools/list` envelope, `whoami` exactly, and the set of
  keys the tools carry, which is where a change of SDK would show.

  Recording: `RECORD_LEGACY_WIRE_GOLDEN=1` rewrites the golden from whatever
  SDK is installed (then `biome check --write` it, which reflows the JSON
  without changing a value). It was recorded on 1.30.1 in the commit that
  added this file, and re-recorded once on `@modelcontextprotocol/server`
  2.1.0, in its own commit, where the SDK itself changed four cases: each
  tool's `inputSchema` declares JSON Schema 2020-12 instead of draft-07 (the
  dialect the 2025-11-25 revision makes the default), no tool carries
  `execution: { taskSupport: "forbidden" }` (v2 has no tasks, and `forbidden`
  is what an absent field means), and an input-validation refusal's text is
  worded differently, still as an `isError` tool result. Re-recording again is
  a deliberate change to the wire, and belongs in its own commit that says
  why.
*/

const goldenUrl = new URL("./legacy-wire.golden.json", import.meta.url);
const recording = process.env.RECORD_LEGACY_WIRE_GOLDEN === "1";

const organizationId = "018f0000-0000-7000-8000-0000000c1001";
const projectId = "018f0000-0000-7000-8000-0000000c1002";

function context(scopes: readonly string[]): AgentAuthContext {
  return {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000c1003" },
    organizationId,
    projectId,
    laneIds: new Set(),
    scopes: new Set(scopes),
    credentialId: "k1-legacy-wire-credential",
    authorizationId: "k1-legacy-wire-authorization",
    audience: "mcp",
    correlationId: "018f0000-0000-7000-8000-0000000c1004",
  };
}

const unreachable = async (): Promise<never> => {
  throw new Error("the legacy wire cases reach no other dependency");
};

const commandBus: CommandBus = { execute: unreachable };

function dependencies(scopes: readonly string[]): McpServerDependencies {
  return {
    context: context(scopes),
    commandBus,
    queries: {
      getAgentPolicy: unreachable,
      listOrganizations: unreachable,
      listProjects: unreachable,
      getProject: async () => {
        throw new DomainError("not_found", "project is not visible", {
          field: "projectId",
        });
      },
      listRequests: unreachable,
      getRequest: unreachable,
      listTimeline: unreachable,
      listOpenQuestions: unreachable,
      listEvents: unreachable,
    },
  };
}

const scopeSets = {
  "no scope": [],
  "request:read": ["request:read"],
  "every agent scope": agentScopes,
} as const satisfies Record<string, readonly string[]>;

const clientInfo = { name: "RequestPort legacy wire", version: "1.0.0" };

function post(
  body: unknown,
  protocolVersion: string | null,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...extraHeaders,
  };
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function call(id: number, name: string, args: Record<string, unknown>) {
  return post(
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    },
    "2025-06-18",
  );
}

type Exchange = {
  scopes: readonly string[];
  request: () => Request;
  /** Reduce a body the golden must not pin in full. */
  project?: (body: unknown) => unknown;
  /** The body is an SSE stream that never ends; record the head only. */
  headOnly?: boolean;
};

/**
 * `tools/list` without the list: its envelope, `whoami` exactly, and the key
 * sets the tools carry. F.2's groups grow the list; an SDK change shows in the
 * keys or in `whoami`.
 */
function toolsListProjection(body: unknown) {
  const response = body as {
    result: { tools: Array<Record<string, unknown>> } & Record<string, unknown>;
  } & Record<string, unknown>;
  const { tools, ...resultRest } = response.result;
  const keySets = [
    ...new Set(tools.map((tool) => Object.keys(tool).sort().join(","))),
  ].sort();
  return {
    ...response,
    result: {
      ...resultRest,
      whoami: tools.find((tool) => tool.name === "whoami") ?? null,
      toolKeySets: keySets,
      whoamiIsFirst: tools[0]?.name === "whoami",
    },
  };
}

export const exchanges: Record<string, Exchange> = {
  "initialize at 2025-06-18": {
    scopes: agentScopes,
    request: () =>
      post(
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
  },
  "initialize at 2025-11-25": {
    scopes: agentScopes,
    request: () =>
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo,
          },
        },
        null,
      ),
  },
  ...Object.fromEntries(
    Object.entries(scopeSets).map(([label, scopes]) => [
      `tools/list with ${label}`,
      {
        scopes,
        request: () =>
          post(
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
            "2025-06-18",
          ),
        project: toolsListProjection,
      } satisfies Exchange,
    ]),
  ),
  "tools/call whoami": {
    scopes: ["request:read"],
    request: () => call(3, "whoami", {}),
  },
  "tools/call refused by the domain": {
    scopes: ["project:read"],
    request: () => call(4, "get_project", { projectId }),
  },
  "tools/call refused by input validation": {
    scopes: ["project:read"],
    request: () => call(5, "get_project", { projectId: "not-a-uuid" }),
  },
  GET: {
    scopes: agentScopes,
    request: () =>
      new Request("http://localhost/mcp", {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
      }),
    headOnly: true,
  },
  DELETE: {
    scopes: agentScopes,
    request: () =>
      new Request("http://localhost/mcp", {
        method: "DELETE",
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
      }),
  },
  "a batch of 101 pings": {
    scopes: agentScopes,
    request: () =>
      post(
        Array.from({ length: 101 }, (_, index) => ({
          jsonrpc: "2.0",
          id: index + 1,
          method: "ping",
        })),
        "2025-06-18",
      ),
  },
  "a 2026-07-28 server/discover probe": {
    scopes: agentScopes,
    request: () =>
      post(
        {
          jsonrpc: "2.0",
          id: 6,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": clientInfo,
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
        "2026-07-28",
        { "mcp-method": "server/discover" },
      ),
  },
};

export type WireRecord = {
  status: number;
  contentType: string | null;
  body?: unknown;
};

/** One exchange through `handleMcpRequest`, as a client observes it. */
export async function observe(
  exchange: Exchange,
  extra: Partial<McpServerDependencies> = {},
): Promise<WireRecord> {
  const response = await handleMcpRequest(exchange.request(), {
    ...dependencies(exchange.scopes),
    ...extra,
  });
  const record: WireRecord = {
    status: response.status,
    contentType: response.headers.get("content-type"),
  };
  if (exchange.headOnly) {
    await response.body?.cancel();
    return record;
  }
  const text = await response.text();
  let body: unknown = text === "" ? null : text;
  if (text !== "" && record.contentType?.includes("application/json"))
    body = JSON.parse(text);
  record.body = exchange.project ? exchange.project(body) : body;
  return record;
}

function readGolden(): Record<string, WireRecord> {
  return JSON.parse(readFileSync(goldenUrl, { encoding: "utf8" }));
}

describe("the 2025-era wire, recorded on SDK 1.30.1, four cases re-recorded on 2.1.0", () => {
  if (recording) {
    test("records the golden", async () => {
      const recorded: Record<string, WireRecord> = {};
      for (const [name, exchange] of Object.entries(exchanges))
        recorded[name] = await observe(exchange);
      writeFileSync(goldenUrl, `${JSON.stringify(recorded, null, 2)}\n`);
    });
    return;
  }

  const golden = readGolden();

  test("the golden records every exchange, in order", () => {
    expect(Object.keys(golden)).toEqual(Object.keys(exchanges));
  });

  test.each(Object.keys(exchanges))("%s", async (name) => {
    const observed = await observe(exchanges[name] as Exchange);
    // As serialised text too, so a reordered key fails as surely as a value.
    expect(observed).toStrictEqual(golden[name]);
    expect(JSON.stringify(observed)).toBe(JSON.stringify(golden[name]));
  });

  // Turning the 2026-07-28 leg on must not move 2025-era traffic: every
  // exchange but the 2026 probe (which the leg exists to answer) still gets
  // the golden answer.
  test.each(
    Object.keys(exchanges).filter(
      (name) => name !== "a 2026-07-28 server/discover probe",
    ),
  )("%s, with the 2026-07-28 leg on", async (name) => {
    const observed = await observe(exchanges[name] as Exchange, {
      modernProtocol: true,
    });
    expect(JSON.stringify(observed)).toBe(JSON.stringify(golden[name]));
  });
});
