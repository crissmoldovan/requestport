import type { AgentAuthContext } from "@requestport/auth";
import type { RequestPort } from "@requestport/core";
import { DomainError } from "@requestport/domain";
import type { McpServerDependencies } from "@requestport/mcp";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMcp, MCP_MAX_BODY, type McpOptions } from "./mcp.js";

/**
 * `@requestport/mcp`'s `handleMcpRequest`, replaced so that what the handler
 * hands it is observed: the request, its body as read, and the dependencies.
 * The handler must import it from that package, as the web's
 * `route.modern-switch.test.ts` and the importers test rely on.
 */
const mcp = vi.hoisted(() => ({
  handed: [] as Array<{
    request: Request;
    body: string;
    dependencies: McpServerDependencies;
  }>,
  answer: undefined as
    | undefined
    | ((dependencies: McpServerDependencies) => Promise<Response>),
}));
vi.mock("@requestport/mcp", () => ({
  handleMcpRequest: async (
    request: Request,
    dependencies: McpServerDependencies,
  ) => {
    mcp.handed.push({
      request,
      body: request.body ? await request.clone().text() : "",
      dependencies,
    });
    return mcp.answer
      ? mcp.answer(dependencies)
      : Response.json(
          { jsonrpc: "2.0", id: 1, result: {} },
          { headers: { "cache-control": "public, max-age=60" } },
        );
  },
}));

afterEach(() => {
  mcp.handed.length = 0;
  mcp.answer = undefined;
});

const origin = "https://requestport.test";

/** An agent bound to a project, holding the two scopes the optional tools need. */
const agent: AgentAuthContext = {
  actor: {
    type: "agent",
    id: "agent-mcp",
    delegatedBy: { type: "user", id: "user-mcp" },
  },
  audience: "mcp",
  organizationId: "organization-mcp",
  projectId: "project-mcp",
  scopes: new Set(["request:read", "webhook:manage", "import:write"]),
  laneIds: new Set<string>(),
  authorizationId: "authorization-mcp",
  credentialId: "credential-mcp",
  correlationId: "correlation-mcp",
};

/**
 * The handler's collaborators as stand-ins, each writing what it was asked
 * into one log, in order.
 */
function mcpOver(
  overrides: Partial<McpOptions> = {},
  context: AgentAuthContext = agent,
) {
  const log: string[] = [];
  const webhooks = {
    list: vi.fn(async () => ["webhook"]),
    create: vi.fn(async (_context: unknown, input: unknown) => ({ input })),
    verify: vi.fn(async () => ({ verified: true })),
    rotate: vi.fn(async () => ({ rotated: true })),
    setStatus: vi.fn(async () => ({ status: true })),
    replay: vi.fn(async () => ({ replayed: true })),
  };
  const imports = {
    list: vi.fn(async () => ["run"]),
    detail: vi.fn(async () => ({ detail: true })),
    analyze: vi.fn(async () => ({ analyzed: true })),
    apply: vi.fn(async () => ({ applied: true })),
    correct: vi.fn(async () => ({ corrected: true })),
  };
  const port = {
    commandBus: { execute: vi.fn() },
    agentQueries: { listRequests: vi.fn() },
    execute: vi.fn(async (..._args: unknown[]) => ({ registered: true })),
    mcpOnly: {
      createProject: vi.fn(async (input: unknown) => ({ created: input })),
      provisionAgent: vi.fn(async (input: unknown) => ({ provisioned: input })),
      get webhooks() {
        log.push("mcpOnly.webhooks");
        return webhooks;
      },
      get imports() {
        log.push("mcpOnly.imports");
        return imports;
      },
    },
  };
  const requestPort = vi.fn(() => {
    log.push("requestPort");
    return port as unknown as RequestPort;
  });
  const authenticateAgentBearer = vi.fn(
    async (_request: Request, audience: string) => {
      log.push(`authenticate ${audience}`);
      return context;
    },
  );
  const fingerprint = vi.fn((...parts: Array<string | null | undefined>) => {
    log.push("fingerprint");
    return `fingerprint(${parts.join(" | ")})`;
  });
  const enforce = vi.fn(
    async (input: { endpointClass: string; fingerprint: string }) => {
      log.push(`enforce ${input.endpointClass}`);
      return { allowed: true, remaining: 1, retryAfterSeconds: 0 };
    },
  );
  const withProject = vi.fn((given: AgentAuthContext) => {
    log.push("withProject");
    if (!given.projectId) throw new DomainError("forbidden", "no project");
    return { projectId: given.projectId };
  });
  const challenge = vi.fn(
    (path: string, options: { reauthorizeWithResource?: boolean }) =>
      `Bearer at ${path}${options.reauthorizeWithResource ? ", again" : ""}`,
  );
  const privateTelemetry = vi.fn(() => {
    log.push("privateTelemetry");
    return true;
  });
  const modernProtocol = vi.fn(() => {
    log.push("modernProtocol");
    return false;
  });
  const logger = { error: vi.fn() };
  const metrics = { count: vi.fn(), observe: vi.fn() };
  const options: McpOptions = {
    authenticateAgentBearer,
    rateLimiter: { fingerprint, enforce },
    requestPort,
    withProject,
    challenge,
    privateTelemetry,
    modernProtocol,
    logger,
    metrics,
    ...overrides,
  };
  return {
    options,
    log,
    port,
    webhooks,
    imports,
    requestPort,
    authenticateAgentBearer,
    enforce,
    withProject,
    challenge,
    logger,
    metrics,
  };
}

function rpc(id: number, method: string, params: unknown = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function post(body: string, headers: Record<string, string> = {}) {
  return new Request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer an-mcp-credential",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

function handed() {
  const first = mcp.handed[0];
  if (!first) throw new Error("handleMcpRequest was handed nothing");
  return first;
}

describe("the MCP handler's admission, in the route's order", () => {
  test("POST: authenticates for the mcp audience, limits the mutation class by the grant and the agent, then asks for the RequestPort once, its webhooks and imports, and judges the two switches last", async () => {
    const { options, log } = mcpOver();

    const response = await handleMcp(post(rpc(1, "tools/list")), options);

    expect(response.status).toBe(200);
    expect(log).toEqual([
      "authenticate mcp",
      "fingerprint",
      "enforce mutation",
      "requestPort",
      "mcpOnly.webhooks",
      "mcpOnly.imports",
      "privateTelemetry",
      "modernProtocol",
    ]);
    expect(options.rateLimiter.fingerprint).toHaveBeenCalledExactlyOnceWith(
      "authorization-mcp",
      "agent-mcp",
    );
    expect(options.rateLimiter.enforce).toHaveBeenCalledExactlyOnceWith({
      endpointClass: "mutation",
      fingerprint: "fingerprint(authorization-mcp | agent-mcp)",
    });
  });

  test.each(["GET", "DELETE"])(
    "%s: limits the token class, and hands the request on as it came",
    async (method) => {
      const { options, log } = mcpOver();
      const request = new Request(`${origin}/mcp`, {
        method,
        headers: { authorization: "Bearer an-mcp-credential" },
      });

      const response = await handleMcp(request, options);

      expect(response.status).toBe(200);
      expect(log.slice(0, 4)).toEqual([
        "authenticate mcp",
        "fingerprint",
        "enforce token",
        "requestPort",
      ]);
      expect(handed().request).toBe(request);
    },
  );

  test.each([
    [
      "a content type other than JSON: 415",
      () => post(rpc(1, "tools/list"), { "content-type": "text/plain" }),
      415,
      {
        error: "unsupported_media_type",
        message: "MCP requests require application/json.",
      },
    ],
    [
      "invalid JSON: 400",
      () => post("{not json"),
      400,
      { error: "validation_failed", message: "The MCP request is invalid." },
    ],
    [
      "JSON nested past the depth bound: 400",
      () => post(`${"[".repeat(30)}${"]".repeat(30)}`),
      400,
      { error: "validation_failed", message: "The MCP request is invalid." },
    ],
    [
      "a declared body past the bound: 413",
      () =>
        post(rpc(1, "tools/list"), {
          "content-length": String(MCP_MAX_BODY + 1),
        }),
      413,
      {
        error: "request_too_large",
        message: "MCP request body is too large",
      },
    ],
  ])(
    "refuses %s before authenticating, and never asks for the RequestPort",
    async (_name, request, status, body) => {
      const { options, log } = mcpOver();

      const response = await handleMcp(request(), options);

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(body);
      expect(log).toEqual([]);
      expect(mcp.handed).toEqual([]);
    },
  );

  test.each([
    [
      "the bearer refused",
      {
        authenticateAgentBearer: vi.fn(async () =>
          Promise.reject(new DomainError("unauthenticated", "no")),
        ),
      },
      401,
    ],
    [
      "the mutation class refused",
      {
        rateLimiter: {
          fingerprint: () => "fingerprint",
          enforce: vi.fn(async () =>
            Promise.reject(
              new DomainError("rate_limited", "Too many requests", {
                retryAfterSeconds: 11,
              }),
            ),
          ),
        },
      },
      429,
    ],
  ])(
    "%s: refused with the challenge, and the RequestPort never asked for",
    async (_name, overrides, status) => {
      const { options, requestPort } = mcpOver(
        overrides as Partial<McpOptions>,
      );

      const response = await handleMcp(post(rpc(1, "tools/list")), options);

      expect(response.status).toBe(status);
      expect(response.headers.get("www-authenticate")).toBe(
        "Bearer at /.well-known/oauth-protected-resource/mcp",
      );
      expect(requestPort).not.toHaveBeenCalled();
      expect(mcp.handed).toEqual([]);
    },
  );

  test("bounds the body at maxBody when given, reading it as it streams", async () => {
    const { options } = mcpOver({ maxBody: 16 });
    const body = rpc(1, "tools/list");
    const request = new Request(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Blob([body]).stream(),
      duplex: "half",
    } as RequestInit);

    const response = await handleMcp(request, options);

    expect(response.status).toBe(413);
    expect(body.length).toBeGreaterThan(16);
  });
});

describe("what the MCP handler hands handleMcpRequest", () => {
  test("a request rebuilt from the bounded body, with the method, the headers and the signal", async () => {
    const { options } = mcpOver();
    const aborted = new AbortController();
    const request = new Request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer an-mcp-credential",
        "content-type": "application/json; charset=utf-8",
        "mcp-protocol-version": "2025-06-18",
      },
      body: rpc(2, "tools/list"),
      signal: aborted.signal,
    });

    await handleMcp(request, options);
    const { request: rebuilt, body } = handed();
    aborted.abort();

    expect(rebuilt).not.toBe(request);
    expect(rebuilt.url).toBe(`${origin}/mcp`);
    expect(rebuilt.method).toBe("POST");
    expect(rebuilt.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(body).toBe(rpc(2, "tools/list"));
    expect(rebuilt.signal.aborted).toBe(true);
  });

  test("the context, the RequestPort's command bus and agent queries, and the two switches' answers", async () => {
    const { options, port } = mcpOver({
      privateTelemetry: () => false,
      modernProtocol: () => true,
    });

    await handleMcp(post(rpc(1, "tools/list")), options);
    const { dependencies } = handed();

    expect(dependencies.context).toBe(agent);
    expect(dependencies.commandBus).toBe(port.commandBus);
    expect(dependencies.queries).toBe(port.agentQueries);
    expect(dependencies.acceptsPrivateTelemetry).toBe(false);
    expect(dependencies.modernProtocol).toBe(true);
  });

  test("judges modernProtocol on each request, as the web's switch is read per request", async () => {
    let enabled = false;
    const { options } = mcpOver({ modernProtocol: () => enabled });

    await handleMcp(post(rpc(1, "tools/list")), options);
    enabled = true;
    await handleMcp(post(rpc(2, "tools/list")), options);

    expect(
      mcp.handed.map(({ dependencies }) => dependencies.modernProtocol),
    ).toEqual([false, true]);
  });

  test("register_project runs on the RequestPort's execute, as an agent's call with the tool's meta", async () => {
    const { options, port } = mcpOver();

    await handleMcp(post(rpc(1, "tools/list")), options);
    const answer = await handed().dependencies.registerProject?.(
      { name: "Registered" },
      { idempotencyKey: "register-key-0001", expectedVersion: 0 },
    );

    expect(answer).toEqual({ registered: true });
    expect(port.execute).toHaveBeenCalledExactlyOnceWith(
      "register_project",
      { name: "Registered" },
      {
        context: agent,
        credentialKind: "agent",
        meta: { idempotencyKey: "register-key-0001", expectedVersion: 0 },
      },
    );
  });

  test("create_project and provision_agent run the RequestPort's mcpOnly, with the delegating user and the grant: for creation, the credential core re-checks; for provisioning, the key's lineage", async () => {
    const { options, port } = mcpOver();

    await handleMcp(post(rpc(1, "tools/list")), options);
    const { dependencies } = handed();
    await dependencies.createProject?.(
      { name: "Created" },
      { correlationId: "correlation-create" },
    );
    await dependencies.provisionAgent?.(
      { name: "Provisioned" },
      { idempotencyKey: "provision-key-0001" },
    );

    expect(port.mcpOnly.createProject).toHaveBeenCalledExactlyOnceWith({
      correlationId: "correlation-create",
      delegatedByUserId: "user-mcp",
      credentialId: "authorization-mcp",
      organizationId: "organization-mcp",
      project: { name: "Created" },
    });
    expect(port.mcpOnly.provisionAgent).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: "provision-key-0001",
      delegatedByUserId: "user-mcp",
      issuingGrantId: "authorization-mcp",
      organizationId: "organization-mcp",
      provision: { name: "Provisioned" },
    });
  });

  test("the webhook tools, for a webhook:manage grant, bind each write to the context's organisation and bound project, asked for when a tool runs", async () => {
    const { options, webhooks, withProject } = mcpOver();

    await handleMcp(post(rpc(1, "tools/list")), options);
    const tools = handed().dependencies.webhooks;
    expect(withProject).not.toHaveBeenCalled();
    await tools?.create(
      { url: "https://hooks.test/a", organizationId: "someone-else" },
      { idempotencyKey: "create-key-000001", expectedVersion: 0 },
    );

    expect(webhooks.create).toHaveBeenCalledExactlyOnceWith(
      agent,
      {
        url: "https://hooks.test/a",
        organizationId: "organization-mcp",
        projectId: "project-mcp",
        projectIds: ["project-mcp"],
        laneIds: [],
      },
      { idempotencyKey: "create-key-000001", expectedVersion: 0 },
    );
    expect(withProject).toHaveBeenCalledTimes(2);
  });

  test("no webhook tools without webhook:manage, and no import tools without import:write or on a lane", async () => {
    const { options } = mcpOver(
      {},
      {
        ...agent,
        scopes: new Set(["request:read", "import:write"]),
        laneIds: new Set(["lane-mcp"]),
      },
    );

    await handleMcp(post(rpc(1, "tools/list")), options);
    const { dependencies } = handed();

    expect(dependencies.webhooks).toBeUndefined();
    expect(dependencies.imports).toBeUndefined();
  });

  test("the import tools, for an import:write grant on no lane, run the RequestPort's mcpOnly imports as an agent's call", async () => {
    const { options, imports } = mcpOver();

    await handleMcp(post(rpc(1, "tools/list")), options);
    await handed().dependencies.imports?.analyze("source-mcp", "snapshot-mcp", {
      idempotencyKey: "analyze-key-000001",
      expectedVersion: 0,
    });

    expect(imports.analyze).toHaveBeenCalledExactlyOnceWith(
      { sourceId: "source-mcp", snapshotId: "snapshot-mcp" },
      {
        context: agent,
        credentialKind: "agent",
        meta: { idempotencyKey: "analyze-key-000001", expectedVersion: 0 },
      },
    );
  });

  test("the answer carries cache-control: no-store in place of the server's", async () => {
    const { options } = mcpOver();

    const response = await handleMcp(post(rpc(1, "tools/list")), options);

    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("what the MCP handler writes down", () => {
  test("a tool call's duration under the tool's name, its status ok", async () => {
    const { options, metrics } = mcpOver();

    await handleMcp(
      post(rpc(3, "tools/call", { name: "whoami", arguments: {} })),
      options,
    );

    expect(metrics.count).not.toHaveBeenCalled();
    expect(metrics.observe).toHaveBeenCalledExactlyOnceWith(
      "mcp.tool_duration_ms",
      expect.any(Number),
      { commandName: "whoami", status: "ok" },
    );
  });

  test("a refusal counted as mcp.tool_error_total under its code, the method standing for a tool's name", async () => {
    const { options, metrics } = mcpOver({
      authenticateAgentBearer: async () => {
        throw new DomainError("forbidden", "no");
      },
    });

    const response = await handleMcp(post(rpc(1, "tools/list")), options);

    expect(response.status).toBe(403);
    expect(metrics.count).toHaveBeenCalledExactlyOnceWith(
      "mcp.tool_error_total",
      1,
      { commandName: "post", errorCode: "forbidden" },
    );
    expect(metrics.observe).toHaveBeenCalledExactlyOnceWith(
      "mcp.tool_duration_ms",
      expect.any(Number),
      { commandName: "post", status: "forbidden" },
    );
  });

  test.each([
    [
      "a PostgreSQL error: its constructor, SQLSTATE and constraint",
      Object.assign(new Error("relation is gone: secret-value"), {
        code: "42P01",
        constraint: "requests_pkey",
      }),
      "Error.42P01.requests_pkey",
    ],
    [
      "Better Auth's APIError: its status and reason code, never body.message",
      {
        name: "APIError",
        status: "BAD_REQUEST",
        body: { code: "INVALID_TOKEN", message: "secret-value" },
      },
      "APIError.BAD_REQUEST.INVALID_TOKEN",
    ],
    [
      "parts reduced to the characters the logger keeps",
      { name: "Odd Name!", code: "a b" },
      "Odd-Name-.a-b",
    ],
    ["something that is not an object: its type", "a string", "string"],
  ])(
    "an error nothing recognised, %s, logged as mcp.unexpected_error and counted as mcp.unexpected_error_total",
    async (_name, error, errorCode) => {
      const { options, logger, metrics } = mcpOver();
      mcp.answer = async (dependencies) => {
        dependencies.reportUnexpectedError?.(error);
        return Response.json({ jsonrpc: "2.0", id: 4, result: {} });
      };

      await handleMcp(
        post(rpc(4, "tools/call", { name: "list_requests", arguments: {} })),
        options,
      );

      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        "mcp.unexpected_error",
        { commandName: "list_requests", errorCode },
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
        "secret-value",
      );
      expect(metrics.count).toHaveBeenCalledExactlyOnceWith(
        "mcp.unexpected_error_total",
        1,
        { commandName: "list_requests" },
      );
    },
  );

  test("an oversized body is counted as unexpected_error, as the route counted it", async () => {
    const { options, metrics } = mcpOver();

    await handleMcp(
      post(rpc(1, "tools/list"), {
        "content-length": String(MCP_MAX_BODY + 1),
      }),
      options,
    );

    expect(metrics.count).toHaveBeenCalledExactlyOnceWith(
      "mcp.tool_error_total",
      1,
      { commandName: "post", errorCode: "unexpected_error" },
    );
  });
});

test("MCP_MAX_BODY is the route's 524,288 bytes", () => {
  expect(MCP_MAX_BODY).toBe(524_288);
});
