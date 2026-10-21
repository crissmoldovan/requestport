import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { createFileStore } from "@requestport/client/credentials";
import type { TokenSource } from "@requestport/client/token-source";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { runMcpBridge, UPSTREAM_FAILED } from "./mcp-bridge.js";
import { WhoamiError, whoamiOverMcp } from "./whoami.js";

/*
  The CLI's two MCP transports refuse a redirect to another origin
  (GHSA-6prh-2h8m-c8cw; ruling 236 item 4). Before
  @modelcontextprotocol/client 2.3.0, `StreamableHTTPClientTransport` let
  `fetch` follow a 307 or 308 anywhere, and the request went on with its
  `mcp-session-id` and its JSON-RPC body. Across origins `fetch` drops the
  `Authorization` header, as it drops `Cookie` and `Proxy-Authorization`,
  which the transport does not send. From 2.3.0 the transport follows a
  redirect only within the request's origin, unless it is built with
  `redirectPolicy: "follow"` or handed a `fetch` that follows one itself.

  Each transport is built here as the CLI builds it, by the CLI's own code
  (`whoamiOverMcp` in whoami.ts, and the relay `runMcpBridge` starts in
  mcp-bridge.ts), with no `fetch` handed in, so each request is the
  platform's. Two HTTP servers listen on loopback, on ports the system
  chooses: the server the CLI is pointed at, which serves MCP and answers the
  chosen request with a 307 to the other, and the other, which records
  whatever reaches it.
*/

const organizationId = "018f0000-0000-7000-8000-00000000f001";
const projectId = "018f0000-0000-7000-8000-00000000a001";
const TOKEN = "redirect-test-token";
const SESSION = "session-from-the-bound-server";

type Seen = {
  method: string;
  path: string;
  sessionId: string | null;
  authorization: boolean;
  body: string;
};

type Listening = { origin: string; seen: Seen[]; close(): Promise<void> };

/** The parts of a JSON-RPC message the bound server reads. */
type Message = { method?: string; params?: { name?: string } };

async function listen(
  answer: (request: Request, body: string) => Promise<Response>,
): Promise<Listening> {
  const seen: Seen[] = [];
  const server: Server = createServer(
    async (incoming: IncomingMessage, outgoing: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const each of Array.isArray(value) ? value : [value ?? ""])
          headers.append(name, each);
      }
      seen.push({
        method: incoming.method ?? "",
        path: incoming.url ?? "",
        sessionId: headers.get("mcp-session-id"),
        authorization: headers.has("authorization"),
        body,
      });
      const request = new Request(`${origin}${incoming.url}`, {
        method: incoming.method,
        headers,
        ...(incoming.method === "POST" ? { body } : {}),
      });
      const response = await answer(request, body);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    },
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One request served by a stateless MCP server holding `whoami`. */
async function serveMcp(request: Request): Promise<Response> {
  const server = new McpServer(
    { name: "the bound server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "whoami",
    { description: "The credential's identity.", inputSchema: z.object({}) },
    async () => ({
      content: [{ type: "text", text: "{}" }],
      structuredContent: { organizationId, projectId },
    }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

let other: Listening;
let bound: Listening;
/** Which JSON-RPC message the bound server answers with a 307 to `other`. */
let redirects: (message: Message) => boolean;

beforeEach(async () => {
  other = await listen(async () =>
    Response.json({ error: "not the bound server" }, { status: 404 }),
  );
  bound = await listen(async (request, body) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(body) as Message;
    if (redirects(message))
      return new Response(null, {
        status: 307,
        headers: { location: `${other.origin}/elsewhere` },
      });
    const response = await serveMcp(request);
    // A session id on `initialize`'s answer, as a stateful server sends, so
    // that a request sent on after it would carry one.
    if (message.method === "initialize")
      response.headers.set("mcp-session-id", SESSION);
    return response;
  });
});

afterEach(async () => {
  await bound.close();
  await other.close();
});

const tokens: TokenSource = { accessToken: async () => TOKEN };

/** The `tools/call` requests the bound server answered, by tool name. */
const calls = () =>
  bound.seen
    .filter((seen) => seen.method === "POST")
    .map((seen) => JSON.parse(seen.body) as Message)
    .filter((message) => message.method === "tools/call")
    .map((message) => message.params?.name);

describe("the CLI's MCP transports refuse a redirect to another origin (ruling 236 item 4)", () => {
  test("whoami.ts: whoami is not asked of the other origin, which receives nothing", async () => {
    redirects = (message) => message.method === "tools/call";

    const failure = await whoamiOverMcp({ server: bound.origin, tokens }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(other.seen).toEqual([]);
    expect(calls()).toEqual(["whoami"]);
    expect(failure).toBeInstanceOf(WhoamiError);
    expect((failure as Error).message).toBe(
      `whoami over MCP on ${bound.origin} failed: the server answered HTTP 307.`,
    );
  });

  test("mcp-bridge.ts: the relay answers a redirected request with a JSON-RPC error, and the other origin receives nothing", async () => {
    // The bridge's own whoami is served; the agent's tools/call is redirected.
    redirects = (message) =>
      message.method === "tools/call" && message.params?.name !== "whoami";
    const home = mkdtempSync(join(tmpdir(), "requestport-redirect-home-"));
    const checkout = mkdtempSync(
      join(tmpdir(), "requestport-redirect-checkout-"),
    );
    try {
      mkdirSync(join(checkout, ".requestport"));
      writeFileSync(
        join(checkout, ".requestport", "project.json"),
        JSON.stringify({
          organizationId,
          projectId,
          projectSlug: "redirect",
          server: bound.origin,
        }),
      );
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let written = "";
      stdout.setEncoding("utf8");
      stdout.on("data", (text: string) => {
        written += text;
      });
      const exit = runMcpBridge(
        [],
        { HOME: home, REQUESTPORT_AGENT_TOKEN: TOKEN },
        {
          cwd: checkout,
          openBrowser: null,
          stderr: () => {},
          stdin,
          stdout,
          store: createFileStore({ home }),
        },
      );
      const send = (message: Record<string, unknown>) =>
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      const answer = async (id: number) => {
        const until = Date.now() + 10_000;
        for (;;) {
          const found = written
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as { id?: unknown })
            .find((line) => line.id === id);
          if (found !== undefined) return found;
          if (Date.now() > until) throw new Error(`no answer to request ${id}`);
          await new Promise((resume) => setTimeout(resume, 5));
        }
      };

      send({
        id: 1,
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "the agent", version: "1.0.0" },
          protocolVersion: "2025-11-25",
        },
      });
      expect(await answer(1)).toMatchObject({ result: {} });
      send({
        id: 2,
        method: "tools/call",
        params: { arguments: {}, name: "list_requests" },
      });

      const refused = await answer(2);

      expect(other.seen).toEqual([]);
      expect(calls()).toEqual(["whoami", "list_requests"]);
      expect(refused).toEqual({
        error: {
          code: UPSTREAM_FAILED,
          message: `requestport mcp: The request could not be forwarded to ${bound.origin}/mcp: the server answered HTTP 307.`,
        },
        id: 2,
        jsonrpc: "2.0",
      });
      stdin.end();
      expect(await exit).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
