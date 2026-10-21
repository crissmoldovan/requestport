import type { ApiAuthContext } from "@requestport/auth";
import type { RequestPort } from "@requestport/core";
import type { Storage } from "@requestport/db";
import { DomainError } from "@requestport/domain";
import type { McpServerDependencies } from "@requestport/mcp";
import { afterEach, describe, expect, test, vi } from "vitest";

import { protectedResourceDocument } from "./discovery.js";
import {
  createRequestPortHost,
  DEFAULT_HTTP_LIMITS,
  type HostOptions,
  hostServes,
} from "./host.js";
import {
  RATE_LIMIT_POLICIES,
  type RateLimitConsumption,
  rateLimitFingerprint,
} from "./rate-limit.js";
import { ROUTE_TABLE } from "./route-table.js";
import { requestSecurityHeaders } from "./security-headers.js";

const publicUrl = "https://requestport.test";

/**
 * The two repositories the host's artifact import reaches through
 * `@requestport/db`: the rate limiter's, built over the storage's handle, and
 * the import repository, built over the transaction's. Each records the
 * handle it was built on and what it was asked.
 */
const database = vi.hoisted(() => ({
  consumed: [] as Array<{ handle: unknown; input: RateLimitConsumption }>,
  allowed: true,
  imports: [] as Array<{ handle: unknown; method: string; input: unknown }>,
}));
vi.mock("@requestport/db", () => ({
  createRateLimitRepository: (handle: unknown) => ({
    consume: async (input: RateLimitConsumption) => {
      database.consumed.push({ handle, input });
      return {
        allowed: database.allowed,
        remaining: 0,
        retryAfterSeconds: 9,
      };
    },
  }),
  createImportRepository: (handle: unknown) =>
    new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== "string" || method === "then") return;
          return async (input: unknown) => {
            database.imports.push({ handle, method, input });
            return method === "beginCapture" ? { version: 1 } : undefined;
          };
        },
      },
    ),
}));

/** The end-to-end fence, as the host reads it, with a way to force it open. */
const fence = vi.hoisted(() => ({ forcedOpen: false }));
vi.mock("@requestport/auth/e2e", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@requestport/auth/e2e")>();
  return {
    ...actual,
    isE2EEmailMode: (env: Parameters<typeof actual.isE2EEmailMode>[0]) =>
      fence.forcedOpen || actual.isE2EEmailMode(env),
  };
});

/**
 * `@requestport/mcp`'s `handleMcpRequest`, replaced so that what the host's
 * MCP handler hands it is observed.
 */
const mcpServer = vi.hoisted(() => ({
  handed: [] as McpServerDependencies[],
}));
vi.mock("@requestport/mcp", () => ({
  handleMcpRequest: async (
    _request: Request,
    dependencies: McpServerDependencies,
  ) => {
    mcpServer.handed.push(dependencies);
    return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  database.consumed.length = 0;
  database.imports.length = 0;
  database.allowed = true;
  mcpServer.handed.length = 0;
});

/** The agent the host's authenticator admits, unless a test says otherwise. */
const admitted = {
  actor: { type: "agent" as const, id: "agent-host" },
  audience: "api" as const,
  organizationId: "organization-host",
  projectId: "project-host",
  scopes: new Set(["import:write"]),
  laneIds: new Set<string>(),
  authorizationId: "authorization-host",
  credentialId: "credential-host",
  correlationId: "correlation-host",
};

/** A host over stand-ins, and the stand-ins themselves. */
function hostOver(overrides: Partial<HostOptions> = {}) {
  const ready = vi.fn(async () => {});
  const handle = { handle: "the storage's" };
  const transactionHandle = { handle: "the transaction's" };
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
    work(transactionHandle),
  );
  const authenticateAgentBearer = vi.fn(
    async (_request: Request, _audience: string) => admitted,
  );
  const authenticateApiBearer = vi.fn(
    async (_request: Request): Promise<ApiAuthContext> => admitted,
  );
  const query = vi.fn(async (..._args: unknown[]) => ({ queried: true }));
  const execute = vi.fn(async (..._args: unknown[]) => ({ executed: true }));
  const commandBus = { execute: vi.fn() };
  const agentQueries = { listRequests: vi.fn() };
  const mcpOnly = {
    createProject: vi.fn(),
    provisionAgent: vi.fn(),
    webhooks: undefined,
    imports: { list: vi.fn(async () => ["run"]) },
  };
  const requestPort = {
    query,
    execute,
    commandBus,
    agentQueries,
    mcpOnly,
  } as unknown as RequestPort;
  const metrics = {
    count: vi.fn(),
    observe: vi.fn(),
    gauge: vi.fn(),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  /** Better Auth's installed object: its handler answers every auth path. */
  const betterAuth = {
    handler: vi.fn(async (request: Request) =>
      Response.json(
        { handledBy: "auth.handler", path: new URL(request.url).pathname },
        { headers: { "set-cookie": "session=1; Path=/; HttpOnly" } },
      ),
    ),
  };
  const authorizationServer = vi.fn(async () =>
    Response.json(
      { issuer: publicUrl },
      { headers: { "cache-control": "public, max-age=15" } },
    ),
  );
  const openIdConfiguration = vi.fn(async () =>
    Response.json({ issuer: publicUrl, subject_types_supported: ["public"] }),
  );
  const fallback = vi.fn(async (request: Request) =>
    Response.json(
      { servedBy: "fallback", path: new URL(request.url).pathname },
      {
        headers: { "x-fallback": "yes", "cache-control": "public, max-age=1" },
      },
    ),
  );
  const host = createRequestPortHost({
    requestPort,
    auth: {
      auth: betterAuth,
      authenticateAgentBearer,
      authenticateApiBearer,
      oauthAuthorizationServerMetadata: authorizationServer,
      oauthOpenIdConfiguration: openIdConfiguration,
    },
    publicUrl,
    // The host asks its storage whether it is ready, opens the artifact
    // import's transaction on it, and builds the rate limiter's repository
    // over its handle.
    storage: { ready, transaction, db: handle } as unknown as Storage,
    secrets: { fingerprintKey: "host-fingerprint-key" },
    mcp: { modernProtocol: false, privateTelemetry: true },
    logger,
    metrics,
    fallback,
    ...overrides,
  });
  return {
    host,
    ready,
    authorizationServer,
    openIdConfiguration,
    fallback,
    betterAuth,
    authenticateAgentBearer,
    authenticateApiBearer,
    query,
    execute,
    commandBus,
    agentQueries,
    mcpOnly,
    transaction,
    handle,
    transactionHandle,
    metrics,
    logger,
  };
}

/** A start of an import capture, as the private CLI's `import-capture` sends one. */
const importStart = JSON.stringify({
  expectedVersion: 0,
  idempotencyKey: "host-import-idempotency-01",
  action: "start",
  repositoryUrl: null,
  repositoryId: null,
  gitCommitSha: null,
  dirty: false,
  manifestSha256: "c".repeat(64),
});

const postImport = (path = "/api/v1/imports/artifacts", body = importStart) =>
  new Request(`${publicUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer a-host-credential",
      "content-type": "application/json",
    },
    body,
  });

const get = (path: string, init: RequestInit = {}) =>
  new Request(`${publicUrl}${path}`, init);

/** The nonce the policy names, and the policy with it replaced. */
function nonceOf(response: Response) {
  const policy = response.headers.get("content-security-policy") ?? "";
  const nonces = [...policy.matchAll(/'nonce-([0-9a-f]{32})'/gu)].map(
    (match) => match[1],
  );
  return { nonces, policy };
}

describe("the route table's dispatch", () => {
  test("serves the four discovery documents: Better Auth's two through its own handlers, the protected-resource two from the public URL", async () => {
    const { host, authorizationServer, openIdConfiguration, fallback } =
      hostOver();

    const authorization = await host(
      get("/.well-known/oauth-authorization-server"),
    );
    const openId = await host(get("/.well-known/openid-configuration"));
    const api = await host(get("/.well-known/oauth-protected-resource/api/v1"));
    const mcp = await host(get("/.well-known/oauth-protected-resource/mcp"));

    expect(await authorization.json()).toEqual({ issuer: publicUrl });
    expect(await openId.json()).toEqual({
      issuer: publicUrl,
      subject_types_supported: ["public"],
    });
    expect(await api.json()).toStrictEqual(
      protectedResourceDocument(publicUrl, "api"),
    );
    expect(await mcp.json()).toStrictEqual(
      protectedResourceDocument(publicUrl, "mcp"),
    );
    expect(authorizationServer).toHaveBeenCalledOnce();
    expect(openIdConfiguration).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  test("serves liveness, and readiness from its storage, asked on each request", async () => {
    const { host, ready, fallback } = hostOver();

    const live = await host(get("/api/health/live"));
    const first = await host(get("/api/health/ready"));
    ready.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const second = await host(get("/api/health/ready"));

    expect(live.status).toBe(200);
    expect(await live.text()).toBe('{"ok":true}');
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('{"ready":true}');
    expect(second.status).toBe(503);
    expect(await second.text()).toBe('{"ready":false}');
    expect(ready).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
  });

  test("serves the artifact import, entry 6: a POST to /api/v1/imports/artifacts reaches its handler, not REST's (Done when 2)", async () => {
    const { host, fallback, authenticateAgentBearer } = hostOver();
    authenticateAgentBearer.mockRejectedValueOnce(
      new DomainError("unauthenticated", "No bearer"),
    );
    const request = postImport();

    const response = await host(request);

    expect(response.status).toBe(401);
    expect(authenticateAgentBearer).toHaveBeenCalledExactlyOnceWith(
      request,
      "api",
    );
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/api/v1"`,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "unauthenticated",
      message: "A valid agent credential is required.",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  test.each(
    ROUTE_TABLE.map((entry) => [
      entry.name,
      entry.exact[0] ?? `${entry.prefix ?? "/"}sample`,
    ]),
  )(
    "serves entry %s (%s) itself: no entry of the table is the fallback's",
    async (_name, path) => {
      const { host, fallback } = hostOver();

      const response = await host(
        get(path, { headers: { authorization: "Bearer a-host-credential" } }),
      );

      expect(fallback).not.toHaveBeenCalled();
      expect(response.headers.get("x-fallback")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  test("serves the auth family, entry 1: a POST under /api/auth reaches auth.handler, not the fallback", async () => {
    const { host, fallback, betterAuth } = hostOver();

    const response = await host(
      get("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      handledBy: "auth.handler",
      path: "/api/auth/sign-in/email",
    });
    expect(betterAuth.handler).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  test("serves MCP, entry 8: a POST to /mcp reaches the MCP handler, not the fallback", async () => {
    const { host, fallback, authenticateAgentBearer } = hostOver();

    const response = await host(
      get("/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer a-host-credential",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(authenticateAgentBearer).toHaveBeenCalledExactlyOnceWith(
      expect.any(Request),
      "mcp",
    );
    expect(mcpServer.handed).toHaveLength(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  test("hands /api/auth, which the auth family's catch-all does not match, to the fallback untouched", async () => {
    const { host, fallback, betterAuth } = hostOver();

    const response = await host(get("/api/auth"));

    expect(fallback).toHaveBeenCalledOnce();
    expect(response.headers.get("x-fallback")).toBe("yes");
    expect(betterAuth.handler).not.toHaveBeenCalled();
  });

  test.each([
    "/",
    "/sign-in",
    "/api/slack/install",
    "/docs/api/openapi.json",
    "/.well-known/security.txt",
    "/api/health",
    "/api/healthy",
    "/mcp/session",
  ])(
    "hands %s, which no entry serves, to the fallback untouched",
    async (path) => {
      const { host, fallback } = hostOver();

      const response = await host(get(path));

      expect(fallback).toHaveBeenCalledOnce();
      expect(response.headers.get("x-fallback")).toBe("yes");
      expect(response.headers.get("content-security-policy")).toBeNull();
    },
  );

  test("without a fallback, answers what it does not serve 404, with the proxy's headers", async () => {
    const { host } = hostOver({ fallback: undefined });

    const response = await host(get("/sign-in"));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(nonceOf(response).nonces).toHaveLength(2);
  });
});

describe("the artifact import, composed from the host's options", () => {
  test("opens its transaction on the storage, builds the import repository on that transaction's handle, and keys its receipt and its rate limit with secrets.fingerprintKey", async () => {
    const { host, transaction, handle, transactionHandle, metrics } = hostOver({
      environment: "host-environment",
    });

    const response = await host(postImport());

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"version":1}');
    expect(transaction).toHaveBeenCalledOnce();
    expect(
      database.imports.map(({ handle, method }) => [handle, method]),
    ).toEqual([
      [transactionHandle, "requireAgentAccess"],
      [transactionHandle, "beginCapture"],
    ]);
    expect(database.imports[1]?.input).toMatchObject({
      fingerprintSecret: "host-fingerprint-key",
    });
    expect(database.consumed).toEqual([
      {
        handle,
        input: {
          environment: "host-environment",
          endpointClass: "import_ingestion",
          principalFingerprint: rateLimitFingerprint("host-fingerprint-key", [
            "authorization-host",
            "agent-host",
          ]),
          limit: 60,
          windowSeconds: 60,
          cost: 1,
        },
      },
    ]);
    expect(metrics.count).toHaveBeenCalledExactlyOnceWith(
      "rate_limit.decision_total",
      1,
      { endpointClass: "import_ingestion", status: "allowed" },
    );
  });

  test("limits by limits.rateLimits, and answers a denial 429 with retry-after", async () => {
    database.allowed = false;
    const { host, transaction } = hostOver({
      limits: {
        ...DEFAULT_HTTP_LIMITS,
        rateLimits: {
          ...RATE_LIMIT_POLICIES,
          import_ingestion: { limit: 5, windowSeconds: 7 },
        },
      },
    });

    const response = await host(postImport());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect(database.consumed[0]?.input).toMatchObject({
      limit: 5,
      windowSeconds: 7,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  test.each([
    [undefined, "test", "test"],
    ["preview", "production", "preview"],
  ])(
    "labels the rate limit's rows VERCEL_ENV ?? NODE_ENV, read for each decision, when no environment is given (VERCEL_ENV=%s, NODE_ENV=%s)",
    async (vercelEnv, nodeEnv, label) => {
      vi.stubEnv("VERCEL_ENV", "before-the-request");
      const { host } = hostOver();
      vi.stubEnv("VERCEL_ENV", vercelEnv);
      vi.stubEnv("NODE_ENV", nodeEnv);

      expect((await host(postImport())).status).toBe(201);
      expect(database.consumed[0]?.input.environment).toBe(label);
    },
  );

  test("bounds the body at limits.bodies.artifactImport", async () => {
    const { host, transaction } = hostOver({
      limits: {
        ...DEFAULT_HTTP_LIMITS,
        bodies: {
          ...DEFAULT_HTTP_LIMITS.bodies,
          artifactImport: importStart.length - 1,
        },
      },
    });

    const response = await host(postImport());

    expect(response.status).toBe(413);
    expect(await response.text()).toBe('{"error":"request_too_large"}');
    expect(transaction).not.toHaveBeenCalled();
  });

  test("answers the methods a route exporting only POST answers: GET 405, OPTIONS 204 allowing OPTIONS and POST", async () => {
    const { host, authenticateAgentBearer } = hostOver();

    const read = await host(get("/api/v1/imports/artifacts"));
    const options = await host(
      get("/api/v1/imports/artifacts", { method: "OPTIONS" }),
    );

    expect(read.status).toBe(405);
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("OPTIONS, POST");
    expect(authenticateAgentBearer).not.toHaveBeenCalled();
  });
});

describe("REST, entry 7, composed from the host's options", () => {
  test.each([
    "/api/v1",
    "/api/v1/imports",
    "/api/v1/imports/artifacts/more",
    "/api/v1/commands",
  ])(
    "serves GET %s through REST's handler, not the fallback: a path no entry holds answers 404 (Done when 2)",
    async (path) => {
      const { host, fallback, authenticateApiBearer, query } = hostOver();
      const request = get(path);

      const response = await host(request);

      expect(response.status).toBe(404);
      expect(authenticateApiBearer).toHaveBeenCalledExactlyOnceWith(request);
      expect(await response.json()).toEqual({
        error: "not_found",
        message: "The requested resource was not found.",
        details: {},
      });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(query).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  test("hands REST the path's parts as Next hands them, each segment decoded, and runs the query on options.requestPort", async () => {
    const { host, query, execute } = hostOver();

    const response = await host(
      get("/api/v1/requests/a%20b%2Fc/timeline?cursor=c1"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"queried":true}');
    const [name, parameters, call] = query.mock.calls[0] ?? [];
    expect(name).toBe("get_request_timeline");
    expect(parameters).toEqual({
      pathParameters: { requestId: "a b/c" },
      searchParams: new URLSearchParams("cursor=c1"),
    });
    expect(call).toEqual({ context: admitted, credentialKind: "agent" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("answers a path whose segment does not decode 400, the status Next answers before any route runs, with no body where Next renders its error page, reaching no handler", async () => {
    const { host, authenticateApiBearer, fallback } = hostOver();

    const response = await host(get("/api/v1/requests/%E0%A4%A"));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(authenticateApiBearer).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  test("runs a command on options.requestPort, limiting the mutation class over the storage's handle, keyed with secrets.fingerprintKey", async () => {
    const { host, execute, handle, metrics } = hostOver({
      environment: "host-environment",
    });

    const response = await host(
      new Request(`${publicUrl}/api/v1/commands/update_request`, {
        method: "POST",
        headers: {
          authorization: "Bearer a-host-credential",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: { requestId: "request-host" },
          idempotencyKey: "host-rest-idempotency-01",
          expectedVersion: 2,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"result":{"executed":true}}');
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "update_request",
      { requestId: "request-host", organizationId: "organization-host" },
      {
        context: admitted,
        credentialKind: "agent",
        meta: {
          idempotencyKey: "host-rest-idempotency-01",
          expectedVersion: 2,
        },
      },
    );
    expect(database.consumed).toEqual([
      {
        handle,
        input: {
          environment: "host-environment",
          endpointClass: "mutation",
          principalFingerprint: rateLimitFingerprint("host-fingerprint-key", [
            "authorization-host",
            "agent-host",
          ]),
          limit: 120,
          windowSeconds: 60,
          cost: undefined,
        },
      },
    ]);
    expect(metrics.count).toHaveBeenCalledExactlyOnceWith(
      "rate_limit.decision_total",
      1,
      { endpointClass: "mutation", status: "allowed" },
    );
  });

  test("limits GET by limits.rateLimits' token class, and answers a denial 429 with retry-after and the API's challenge-free body", async () => {
    database.allowed = false;
    const { host, query } = hostOver({
      limits: {
        ...DEFAULT_HTTP_LIMITS,
        rateLimits: {
          ...RATE_LIMIT_POLICIES,
          token: { limit: 4, windowSeconds: 11 },
        },
      },
    });

    const response = await host(get("/api/v1/whoami"));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect(await response.json()).toEqual({
      error: "rate_limited",
      message: "Too many requests. Retry later.",
      details: { retryAfterSeconds: 9 },
    });
    expect(database.consumed[0]?.input).toMatchObject({
      endpointClass: "token",
      limit: 4,
      windowSeconds: 11,
    });
    expect(query).not.toHaveBeenCalled();
  });

  test("names the public URL's /api/v1 document in a refusal's challenge", async () => {
    const { host, authenticateApiBearer } = hostOver();
    authenticateApiBearer.mockRejectedValueOnce(
      new DomainError("unauthenticated", "No bearer"),
    );

    const response = await host(get("/api/v1/whoami"));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/api/v1"`,
    );
  });

  test("bounds a command's body at limits.bodies.rest", async () => {
    const body = JSON.stringify({
      input: {},
      idempotencyKey: "host-rest-idempotency-01",
      expectedVersion: 0,
    });
    const { host, execute } = hostOver({
      limits: {
        ...DEFAULT_HTTP_LIMITS,
        bodies: { ...DEFAULT_HTTP_LIMITS.bodies, rest: body.length - 1 },
      },
    });

    const response = await host(
      new Request(`${publicUrl}/api/v1/commands/update_request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.text()).toBe(
      '{"error":"request_too_large","message":"API request body is too large"}',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test("answers the methods a route exporting GET and POST answers: HEAD by GET's handler, OPTIONS 204 allowing GET, HEAD, OPTIONS and POST, DELETE 405", async () => {
    const { host, query, authenticateApiBearer } = hostOver();

    const head = await host(get("/api/v1/whoami", { method: "HEAD" }));
    const options = await host(get("/api/v1/whoami", { method: "OPTIONS" }));
    const remove = await host(get("/api/v1/whoami", { method: "DELETE" }));

    expect(head.status).toBe(200);
    expect(query).toHaveBeenCalledOnce();
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST");
    expect(remove.status).toBe(405);
    expect(authenticateApiBearer).toHaveBeenCalledOnce();
  });
});

describe("the auth family, entry 1, composed from the host's options", () => {
  test("GET hands the request to auth.auth's handler, called on that object, and limits nothing", async () => {
    const { host, betterAuth } = hostOver();
    const request = get("/api/auth/get-session");

    const response = await host(request);

    expect(response.status).toBe(200);
    expect(betterAuth.handler).toHaveBeenCalledExactlyOnceWith(request);
    expect(betterAuth.handler.mock.contexts[0]).toBe(betterAuth);
    expect(response.headers.getSetCookie()).toEqual([
      "session=1; Path=/; HttpOnly",
    ]);
    expect(database.consumed).toEqual([]);
  });

  test("POST limits the token class over the storage's handle, keyed with secrets.fingerprintKey by the request's address", async () => {
    const { host, handle, betterAuth } = hostOver({
      environment: "host-environment",
    });

    const response = await host(
      get("/api/auth/oauth2/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": "198.51.100.9, 10.0.0.1",
        },
        body: "grant_type=refresh_token&refresh_token=host",
      }),
    );

    expect(response.status).toBe(200);
    expect(database.consumed).toEqual([
      {
        handle,
        input: {
          environment: "host-environment",
          endpointClass: "token",
          principalFingerprint: rateLimitFingerprint("host-fingerprint-key", [
            "198.51.100.9",
          ]),
          limit: 60,
          windowSeconds: 60,
          cost: undefined,
        },
      },
    ]);
    const handed = betterAuth.handler.mock.calls[0]?.[0];
    expect(await handed?.text()).toBe(
      "grant_type=refresh_token&refresh_token=host",
    );
  });

  test("POST: a refusal of the auth_initiation class answers 429 with retry-after", async () => {
    database.allowed = false;
    const { host, betterAuth } = hostOver();

    const response = await host(
      get("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@example.test" }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect(database.consumed[0]?.input.endpointClass).toBe("auth_initiation");
    expect(betterAuth.handler).not.toHaveBeenCalled();
  });

  test("bounds a POST's body at limits.bodies.auth", async () => {
    const { host, betterAuth } = hostOver({
      limits: {
        ...DEFAULT_HTTP_LIMITS,
        bodies: { ...DEFAULT_HTTP_LIMITS.bodies, auth: 4 },
      },
    });

    const response = await host(
      get("/api/auth/sign-in/email", { method: "POST", body: "12345" }),
    );

    expect(response.status).toBe(413);
    expect(betterAuth.handler).not.toHaveBeenCalled();
  });

  test("answers the methods a route exporting GET and POST answers: OPTIONS 204 allowing GET, HEAD, OPTIONS and POST, PUT 405", async () => {
    const { host, betterAuth } = hostOver();

    const options = await host(get("/api/auth/session", { method: "OPTIONS" }));
    const put = await host(get("/api/auth/session", { method: "PUT" }));

    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST");
    expect(put.status).toBe(405);
    expect(betterAuth.handler).not.toHaveBeenCalled();
  });
});

describe("MCP, entry 8, composed from the host's options", () => {
  const mcpPost = (body: string) =>
    get("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer a-host-credential",
        "content-type": "application/json",
      },
      body,
    });

  test("hands its server the RequestPort's command bus and agent queries, and options.mcp's two switches, fixed when the host was made", async () => {
    const mcp = { modernProtocol: true, privateTelemetry: false };
    const { host, commandBus, agentQueries } = hostOver({ mcp });

    await host(mcpPost(JSON.stringify({ jsonrpc: "2.0", id: 1 })));
    mcp.modernProtocol = false;
    mcp.privateTelemetry = true;
    await host(mcpPost(JSON.stringify({ jsonrpc: "2.0", id: 2 })));

    expect(mcpServer.handed).toHaveLength(2);
    for (const dependencies of mcpServer.handed) {
      expect(dependencies.commandBus).toBe(commandBus);
      expect(dependencies.queries).toBe(agentQueries);
      expect(dependencies.modernProtocol).toBe(true);
      expect(dependencies.acceptsPrivateTelemetry).toBe(false);
    }
  });

  test("limits POST by the mutation class over the storage's handle, keyed with secrets.fingerprintKey by the grant and the agent", async () => {
    const { host, handle } = hostOver({ environment: "host-environment" });

    await host(mcpPost(JSON.stringify({ jsonrpc: "2.0", id: 1 })));

    expect(database.consumed).toEqual([
      {
        handle,
        input: {
          environment: "host-environment",
          endpointClass: "mutation",
          principalFingerprint: rateLimitFingerprint("host-fingerprint-key", [
            "authorization-host",
            "agent-host",
          ]),
          limit: 120,
          windowSeconds: 60,
          cost: undefined,
        },
      },
    ]);
  });

  test("writes an error nothing recognised to options.logger and counts it on options.metrics", async () => {
    const { host, logger, metrics } = hostOver();

    await host(
      mcpPost(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_requests", arguments: {} },
        }),
      ),
    );
    mcpServer.handed[0]?.reportUnexpectedError?.(new TypeError("boom"));

    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      "mcp.unexpected_error",
      { commandName: "list_requests", errorCode: "TypeError" },
    );
    expect(metrics.count).toHaveBeenCalledWith(
      "mcp.unexpected_error_total",
      1,
      { commandName: "list_requests" },
    );
  });

  test("names the public URL's /mcp document in a refusal's challenge", async () => {
    const { host, authenticateAgentBearer } = hostOver();
    authenticateAgentBearer.mockRejectedValueOnce(
      new DomainError("unauthenticated", "No bearer"),
    );

    const response = await host(mcpPost("{}"));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test("bounds a POST's body at limits.bodies.mcp", async () => {
    const { host, authenticateAgentBearer } = hostOver({
      limits: {
        ...DEFAULT_HTTP_LIMITS,
        bodies: { ...DEFAULT_HTTP_LIMITS.bodies, mcp: 4 },
      },
    });

    const response = await host(mcpPost("{ }  "));

    expect(response.status).toBe(413);
    expect(authenticateAgentBearer).not.toHaveBeenCalled();
  });

  test("answers the methods the route exports: GET and DELETE served, OPTIONS 204 allowing DELETE, GET, HEAD, OPTIONS and POST, PUT 405", async () => {
    const { host } = hostOver();
    const bearer = { authorization: "Bearer a-host-credential" };

    const read = await host(get("/mcp", { headers: bearer }));
    const remove = await host(
      get("/mcp", { method: "DELETE", headers: bearer }),
    );
    const options = await host(get("/mcp", { method: "OPTIONS" }));
    const put = await host(get("/mcp", { method: "PUT" }));

    expect(read.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(mcpServer.handed).toHaveLength(2);
    expect(database.consumed.map(({ input }) => input.endpointClass)).toEqual([
      "token",
      "token",
    ]);
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe(
      "DELETE, GET, HEAD, OPTIONS, POST",
    );
    expect(put.status).toBe(405);
  });
});

describe("the proxy's headers, on every answer the host's families give", () => {
  test("sets apps/web/src/proxy.ts's headers over the route's: its cache-control replaces the document's", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const { host } = hostOver();

    const response = await host(
      get("/.well-known/oauth-protected-resource/api/v1"),
    );
    const { nonces } = nonceOf(response);

    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBe(nonces[1]);
    expect(
      Object.fromEntries(
        [...response.headers].filter(
          ([name]) => name !== "content-security-policy",
        ),
      ),
    ).toEqual({
      "cache-control": "private, no-store",
      "content-type": "application/json",
      "permissions-policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    expect(response.headers.get("content-security-policy")).toBe(
      requestSecurityHeaders({
        nonce: nonces[0] ?? "",
        production: false,
        canonicalProductionHost: false,
        upgradeInsecureRequests: true,
      })["content-security-policy"],
    );
  });

  test("mints a fresh nonce for each response", async () => {
    const { host } = hostOver();

    const first = nonceOf(await host(get("/api/health/live"))).nonces[0];
    const second = nonceOf(await host(get("/api/health/live"))).nonces[0];

    expect(first).toMatch(/^[0-9a-f]{32}$/u);
    expect(second).not.toBe(first);
  });

  test("appends the route's set-cookie, www-authenticate, proxy-authenticate and vary beside the proxy's, and keeps any header the proxy does not set", async () => {
    const answered = new Headers({
      "cache-control": "public, max-age=15",
      "x-frame-options": "SAMEORIGIN",
      "www-authenticate": 'Bearer resource_metadata="x"',
      "proxy-authenticate": "Basic",
      vary: "accept",
      "x-route": "kept",
    });
    answered.append("set-cookie", "one=1; Path=/");
    answered.append("set-cookie", "two=2; Path=/");
    const { host } = hostOver({
      auth: {
        auth: {
          handler: async () => {
            throw new Error("no auth request is sent here");
          },
        },
        authenticateAgentBearer: async () => {
          throw new Error("no artifact import is sent here");
        },
        authenticateApiBearer: async () => {
          throw new Error("no REST request is sent here");
        },
        oauthAuthorizationServerMetadata: async () =>
          new Response("{}", { status: 201, headers: answered }),
        oauthOpenIdConfiguration: async () => new Response("{}"),
      },
    });

    const response = await host(get("/.well-known/oauth-authorization-server"));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.getSetCookie()).toEqual([
      "one=1; Path=/",
      "two=2; Path=/",
    ]);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="x"',
    );
    expect(response.headers.get("proxy-authenticate")).toBe("Basic");
    expect(response.headers.get("vary")).toBe("accept");
    expect(response.headers.get("x-route")).toBe("kept");
  });

  test.each([
    ["test", "https://requestport.test", false, false],
    ["production", "https://requestport.test", true, false],
    ["production", "https://requestport.com", true, true],
  ] as const)(
    "derives the policy's inputs as proxy.ts does: NODE_ENV=%s at %s",
    async (nodeEnv, origin, production, canonicalProductionHost) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const { host } = hostOver({ publicUrl: origin });

      const response = await host(new Request(`${origin}/api/health/live`));
      const nonce = nonceOf(response).nonces[0] ?? "";

      expect(
        Object.fromEntries(
          [...response.headers].filter(
            ([name]) => !["cache-control", "content-type"].includes(name),
          ),
        ),
      ).toEqual(
        requestSecurityHeaders({
          nonce,
          production,
          canonicalProductionHost,
          upgradeInsecureRequests: true,
        }),
      );
    },
  );

  test("leaves upgrade-insecure-requests out of a production policy where the end-to-end fence is open, as proxy.ts does", async () => {
    // At run time the fence opens only for a NODE_ENV of development or
    // test, so it is forced open here: it stands for a build that folds
    // `process.env.NODE_ENV` to "production", as `next build` does for
    // proxy.ts, while the fence reads the environment object it is handed.
    vi.stubEnv("NODE_ENV", "production");
    fence.forcedOpen = true;
    const { host } = hostOver();

    try {
      const response = await host(get("/api/health/live"));
      const nonce = nonceOf(response).nonces[0] ?? "";

      expect(response.headers.get("content-security-policy")).toBe(
        requestSecurityHeaders({
          nonce,
          production: true,
          canonicalProductionHost: false,
          upgradeInsecureRequests: false,
        })["content-security-policy"],
      );
      expect(response.headers.get("content-security-policy")).not.toContain(
        "upgrade-insecure-requests",
      );
    } finally {
      fence.forcedOpen = false;
    }
  });
});

describe("upgrade-insecure-requests, by the host's public URL (H.5)", () => {
  /** The policy the host sets on a family's answer and on its own 404. */
  async function policiesAt(publicUrl: string) {
    const { host } = hostOver({ publicUrl, fallback: undefined });
    const served = await host(new Request(`${publicUrl}/api/health/live`));
    const unserved = await host(new Request(`${publicUrl}/sign-in`));
    expect(unserved.status).toBe(404);
    return [served, unserved].map((response) => ({
      nonce: nonceOf(response).nonces[0] ?? "",
      policy: response.headers.get("content-security-policy") ?? "",
    }));
  }

  test.each([
    ["http://127.0.0.1:3200", false],
    ["http://localhost:3200", false],
    ["http://[::1]:3200", false],
    ["https://127.0.0.1:3200", true],
    ["https://requestport.test", true],
    ["http://rp.internal:3200", true],
  ] as const)(
    "in a production runtime, as proxy.ts judges BETTER_AUTH_URL: at %s the policy carries it: %s",
    async (publicUrl, carries) => {
      vi.stubEnv("NODE_ENV", "production");

      for (const { nonce, policy } of await policiesAt(publicUrl)) {
        expect(policy.includes("upgrade-insecure-requests")).toBe(carries);
        expect(policy).toBe(
          requestSecurityHeaders({
            nonce,
            production: true,
            canonicalProductionHost: false,
            upgradeInsecureRequests: carries,
          })["content-security-policy"],
        );
      }
    },
  );

  test("reads the public URL it was made with, not the process's BETTER_AUTH_URL", async () => {
    vi.stubEnv("NODE_ENV", "production");

    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3200");
    for (const { policy } of await policiesAt("https://requestport.test")) {
      expect(policy).toContain("upgrade-insecure-requests");
    }

    vi.stubEnv("BETTER_AUTH_URL", "https://requestport.com");
    for (const { policy } of await policiesAt("http://127.0.0.1:3200")) {
      expect(policy).not.toContain("upgrade-insecure-requests");
    }
  });
});

describe("methods, as Next answers a route that exports only GET", () => {
  test("HEAD is answered by GET's handler", async () => {
    const { host, ready } = hostOver();

    const response = await host(get("/api/health/ready", { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(ready).toHaveBeenCalledOnce();
  });

  test("OPTIONS answers 204, allowing GET, HEAD and OPTIONS", async () => {
    const { host } = hostOver();

    const response = await host(
      get("/.well-known/oauth-protected-resource/mcp", { method: "OPTIONS" }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test.each(["POST", "PUT", "DELETE", "PATCH"])(
    "%s answers 405 with no body, and reaches no handler",
    async (method) => {
      const { host, ready, fallback } = hostOver();

      const response = await host(
        get("/api/health/ready", {
          method,
          ...(method === "DELETE" ? {} : { body: "{}" }),
        }),
      );

      expect(response.status).toBe(405);
      expect(await response.text()).toBe("");
      expect(response.headers.get("allow")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(ready).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  test("a method Next does not recognise answers 400 with no body", async () => {
    const { host, ready } = hostOver();

    const response = await host(
      get("/api/health/ready", { method: "PROPFIND" }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(ready).not.toHaveBeenCalled();
  });
});

test("HttpLimits' defaults are today's constants", () => {
  expect(DEFAULT_HTTP_LIMITS).toEqual({
    bodies: {
      auth: 262_144,
      rest: 524_288,
      mcp: 524_288,
      artifactImport: 9 * 1_024 * 1_024,
    },
    rateLimits: RATE_LIMIT_POLICIES,
  });
});

/*
  What `listen`'s Node-level fallback asks (H.5's slice e): a path the host
  serves stays the host's, and every other path, Next's pages among them,
  goes to the fallback.
*/
describe("hostServes", () => {
  test.each(
    ROUTE_TABLE.flatMap((entry) => [
      ...entry.exact,
      ...(entry.prefix ? [`${entry.prefix}sample`, `${entry.prefix}a/b`] : []),
    ]),
  )("%s: the host's", (path) => {
    expect(hostServes(path)).toBe(true);
  });

  test.each([
    "/",
    "/sign-in",
    "/oauth/agent-consent",
    "/settings/projects/new",
    "/api/auth",
    "/api/health",
    "/.well-known/security.txt",
    "/_next/static/chunks/main.js",
    "/API/V1",
  ])("%s: the fallback's", (path) => {
    expect(hostServes(path)).toBe(false);
  });
});
