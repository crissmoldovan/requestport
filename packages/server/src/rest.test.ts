import type { ApiAuthContext } from "@requestport/auth";
import {
  DomainError,
  operatorActor,
  operatorScopes,
  restCommandTransports,
} from "@requestport/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { z } from "zod";

import { reauthorizeWithResourceDescription } from "./bearer-challenge.js";
import { withProject } from "./project-scope.js";
import {
  handleRestCommand,
  handleRestQuery,
  REST_MAX_BODY,
  type RestOptions,
  restPathParts,
} from "./rest.js";

/**
 * `@requestport/domain`'s `findRestCommandTransport`, watched, and
 * replaceable for one test: the handler must ask that module, when a request
 * names its command, as `route.registry.test.ts` in `apps/web` relies on.
 */
const registry = vi.hoisted(() => ({
  lookups: [] as string[],
  replaced: undefined as undefined | ((name: string) => unknown),
}));
vi.mock("@requestport/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@requestport/domain")>();
  return {
    ...actual,
    findRestCommandTransport: (name: string) => {
      registry.lookups.push(name);
      return registry.replaced
        ? registry.replaced(name)
        : actual.findRestCommandTransport(name);
    },
  };
});

afterEach(() => {
  registry.lookups.length = 0;
  registry.replaced = undefined;
});

const origin = "https://requestport.test";

/** An agent bound to a project, holding the scopes the cases below use. */
const agent = {
  actor: { type: "agent" as const, id: "agent-rest" },
  audience: "api" as const,
  organizationId: "organization-rest",
  projectId: "project-rest",
  scopes: new Set(["request:read", "request:create"]),
  laneIds: new Set<string>(),
  authorizationId: "authorization-rest",
  credentialId: "credential-rest",
  correlationId: "correlation-rest",
};

/** An operator credential, bound to no project. */
const operator = {
  actor: operatorActor({
    lineageId: "lineage-rest",
    memberUserId: "member-rest",
  }),
  credentialKind: "operator" as const,
  organizationId: "organization-rest",
  projectId: null,
  laneIds: new Set<string>(),
  scopes: new Set(operatorScopes),
  credentialId: "operator-credential-rest",
  credentialFingerprint: "operator-fingerprint-rest",
  correlationId: "correlation-rest",
  authorizationId: "operator-credential-rest",
} as unknown as ApiAuthContext;

/**
 * The handlers' collaborators as stand-ins, each writing what it was asked
 * into one log, in order.
 */
function restOver(overrides: Partial<RestOptions> = {}) {
  const log: string[] = [];
  const query = vi.fn(async (..._args: unknown[]) => {
    log.push("query");
    return { items: ["queried"] };
  });
  const execute = vi.fn(async (..._args: unknown[]) => {
    log.push("execute");
    return { executed: true };
  });
  const port = { query, execute };
  const requestPort = vi.fn(() => {
    log.push("requestPort");
    return port as unknown as ReturnType<RestOptions["requestPort"]>;
  });
  const authenticateApiBearer = vi.fn(
    async (_request: Request): Promise<ApiAuthContext> => {
      log.push("authenticate");
      return agent;
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
  const challenge = vi.fn(
    (path: string, options: { reauthorizeWithResource?: boolean }) =>
      `Bearer at ${path}${options.reauthorizeWithResource ? ", again" : ""}`,
  );
  const options: RestOptions = {
    authenticateApiBearer,
    rateLimiter: { fingerprint, enforce },
    requestPort,
    withProject,
    challenge,
    ...overrides,
  };
  /** The path's parts, as a route hands them, logged when they are asked for. */
  const parts =
    (...values: string[]) =>
    async () => {
      log.push("pathParts");
      return values;
    };
  return {
    options,
    log,
    query,
    execute,
    requestPort,
    authenticateApiBearer,
    enforce,
    challenge,
    parts,
  };
}

const get = (path: string) =>
  new Request(`${origin}${path}`, {
    headers: { authorization: "Bearer a-rest-credential" },
  });

function post(
  name: string,
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
) {
  return new Request(`${origin}/api/v1/commands/${name}`, {
    method: "POST",
    headers: { authorization: "Bearer a-rest-credential", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const envelope = (input: Record<string, unknown> = {}) => ({
  input,
  idempotencyKey: "rest-idempotency-key-0001",
  expectedVersion: 3,
});

describe("restPathParts: a path's parts, as Next hands them to the route's [[...path]]", () => {
  test.each([
    ["/api/v1", []],
    ["/api/v1/whoami", ["whoami"]],
    ["/api/v1/requests/a%20b/timeline", ["requests", "a b", "timeline"]],
    ["/api/v1/a%2Fb", ["a/b"]],
    ["/api/v1/", []],
    ["/api/v1/whoami/", ["whoami"]],
  ])("%s gives %j", (pathname, parts) => {
    expect(restPathParts(pathname)).toEqual(parts);
  });

  test.each([
    ["/api/v1%20", "a path outside /api/v1"],
    ["/api/v10/whoami", "a path outside /api/v1"],
    ["/api/v1/%E0%A4%A", "a segment that does not decode"],
  ])("%s gives none: %s", (pathname) => {
    expect(restPathParts(pathname)).toBeUndefined();
  });
});

describe("handleRestQuery: GET", () => {
  test("authenticates, limits the token class, then asks for the path's parts, has core resolve them, and asks the RequestPort for the query, once", async () => {
    const rest = restOver();
    const request = get("/api/v1/requests/a%20b?state=submitted");

    const response = await handleRestQuery(
      request,
      rest.parts("requests", "a b"),
      rest.options,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe('{"items":["queried"]}');
    expect(rest.log).toEqual([
      "authenticate",
      "fingerprint",
      "enforce token",
      "pathParts",
      "requestPort",
      "query",
    ]);
    expect(rest.authenticateApiBearer).toHaveBeenCalledExactlyOnceWith(request);
    expect(rest.enforce).toHaveBeenCalledExactlyOnceWith({
      endpointClass: "token",
      fingerprint: "fingerprint(authorization-rest | agent-rest)",
    });
    const [name, parameters, call] = rest.query.mock.calls[0] ?? [];
    expect(name).toBe("get_request");
    expect(parameters).toEqual({
      pathParameters: { requestId: "a b" },
      searchParams: new URLSearchParams("state=submitted"),
    });
    expect(call).toEqual({ context: agent, credentialKind: "agent" });
  });

  test("tells the RequestPort an operator credential's kind", async () => {
    const rest = restOver({
      authenticateApiBearer: async () => operator,
    });

    const response = await handleRestQuery(
      get("/api/v1/whoami"),
      rest.parts("whoami"),
      rest.options,
    );

    expect(response.status).toBe(200);
    expect(rest.query.mock.calls[0]?.[2]).toEqual({
      context: operator,
      credentialKind: "operator",
    });
  });

  test("answers a path no entry holds 404, having asked the RequestPort for nothing", async () => {
    const rest = restOver();

    const response = await handleRestQuery(
      get("/api/v1"),
      rest.parts(),
      rest.options,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "not_found",
      message: "The requested resource was not found.",
      details: {},
    });
    expect(rest.requestPort).not.toHaveBeenCalled();
  });

  test("answers a refused credential 401 with the challenge for /api/v1's document, asking for nothing else", async () => {
    const rest = restOver({
      authenticateApiBearer: async () => {
        throw new DomainError("unauthenticated", "No bearer");
      },
    });

    const response = await handleRestQuery(
      get("/api/v1/whoami"),
      rest.parts("whoami"),
      rest.options,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      "Bearer at /.well-known/oauth-protected-resource/api/v1",
    );
    expect(rest.challenge).toHaveBeenCalledExactlyOnceWith(
      "/.well-known/oauth-protected-resource/api/v1",
      { reauthorizeWithResource: false },
    );
    expect(await response.json()).toEqual({
      error: "unauthenticated",
      message: "A valid agent credential is required.",
      details: {},
    });
    expect(rest.log).toEqual([]);
  });

  test("asks a token without the resource indicator to authorize again, in the message and in the challenge", async () => {
    const rest = restOver({
      authenticateApiBearer: async () => {
        throw new DomainError("unauthenticated", "Opaque", {
          reauthorizeWithResource: true,
        });
      },
    });

    const response = await handleRestQuery(
      get("/api/v1/whoami"),
      rest.parts("whoami"),
      rest.options,
    );

    expect(response.headers.get("www-authenticate")).toBe(
      "Bearer at /.well-known/oauth-protected-resource/api/v1, again",
    );
    expect((await response.json()).message).toBe(
      reauthorizeWithResourceDescription,
    );
  });

  test("answers a refused limit 429, the header the raw delay and the body's whole seconds", async () => {
    const rest = restOver({
      rateLimiter: {
        fingerprint: () => "limited",
        enforce: async () => {
          throw new DomainError("rate_limited", "Too many", {
            retryAfterSeconds: 0.4,
          });
        },
      },
    });

    const response = await handleRestQuery(
      get("/api/v1/whoami"),
      rest.parts("whoami"),
      rest.options,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("0.4");
    expect(await response.json()).toEqual({
      error: "rate_limited",
      message: "Too many requests. Retry later.",
      details: { retryAfterSeconds: 1 },
    });
    expect(rest.requestPort).not.toHaveBeenCalled();
  });

  test("answers anything else it is thrown 500, naming nothing", async () => {
    const rest = restOver({
      authenticateApiBearer: async () => {
        throw new Error("authenticator down");
      },
    });

    const response = await handleRestQuery(
      get("/api/v1/whoami"),
      rest.parts("whoami"),
      rest.options,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(
      '{"error":"unexpected_error","message":"The RequestPort operation failed."}',
    );
  });
});

describe("handleRestCommand: POST", () => {
  const draft = restCommandTransports.find(
    (transport) => transport.name === "create_request_draft",
  );

  test("hands the RequestPort the command, the caller's input with the registry's injected fields written over it, and the envelope's meta", async () => {
    const rest = restOver();

    const response = await handleRestCommand(
      post(
        "create_request_draft",
        envelope({
          title: "A draft",
          organizationId: "spoofed",
          sourceProjectId: "spoofed",
        }),
      ),
      rest.parts("commands", "create_request_draft"),
      rest.options,
    );

    expect(draft?.injectedFields.map((field) => field.field)).toEqual([
      "organizationId",
      "sourceKind",
      "sourceProjectId",
    ]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"result":{"executed":true}}');
    expect(rest.log).toEqual([
      "authenticate",
      "fingerprint",
      "enforce mutation",
      "pathParts",
      "requestPort",
      "execute",
    ]);
    expect(registry.lookups).toEqual(["create_request_draft"]);
    const [name, input, call] = rest.execute.mock.calls[0] ?? [];
    expect(name).toBe("create_request_draft");
    expect(JSON.stringify(input)).toBe(
      JSON.stringify({
        title: "A draft",
        organizationId: "organization-rest",
        sourceProjectId: "project-rest",
        sourceKind: "project",
      }),
    );
    expect(call).toEqual({
      context: agent,
      credentialKind: "agent",
      meta: {
        idempotencyKey: "rest-idempotency-key-0001",
        expectedVersion: 3,
      },
    });
  });

  test("finds the command through @requestport/domain's findRestCommandTransport, asked when the request names it", async () => {
    const rest = restOver();
    registry.replaced = () => undefined;

    const response = await handleRestCommand(
      post("update_request", envelope()),
      rest.parts("commands", "update_request"),
      rest.options,
    );

    expect(response.status).toBe(404);
    expect(registry.lookups).toEqual(["update_request"]);
    expect(rest.requestPort).not.toHaveBeenCalled();
  });

  test("answers a body that is not JSON 415, before it asks for the path's parts", async () => {
    const rest = restOver();

    const response = await handleRestCommand(
      post("update_request", envelope(), { "content-type": "text/plain" }),
      rest.parts("commands", "update_request"),
      rest.options,
    );

    expect(response.status).toBe(415);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "unsupported_media_type",
      message: "API commands require application/json.",
    });
    expect(rest.log).toEqual([
      "authenticate",
      "fingerprint",
      "enforce mutation",
    ]);
  });

  test("refuses a credential whose kind the entry does not admit 403, before it reads the body", async () => {
    const rest = restOver({ authenticateApiBearer: async () => operator });
    const request = post("create_request_draft", "{not json");

    const response = await handleRestCommand(
      request,
      rest.parts("commands", "create_request_draft"),
      rest.options,
    );

    expect(response.status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(rest.requestPort).not.toHaveBeenCalled();
  });

  test("refuses a credential bound to no project where the entry requires one, before the RequestPort is asked", async () => {
    const rest = restOver({
      authenticateApiBearer: async () => ({ ...agent, projectId: null }),
    });

    const response = await handleRestCommand(
      post("create_request_draft", envelope({ title: "A draft" })),
      rest.parts("commands", "create_request_draft"),
      rest.options,
    );

    expect(response.status).toBe(403);
    expect(rest.requestPort).not.toHaveBeenCalled();
  });

  test.each([
    ["{not json", "API JSON input is invalid"],
    ["[]", "an array"],
    [JSON.stringify({ input: {}, expectedVersion: 1 }), "no idempotency key"],
  ])("answers %s 422 (%s)", async (body) => {
    const rest = restOver();

    const response = await handleRestCommand(
      post("update_request", body),
      rest.parts("commands", "update_request"),
      rest.options,
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("validation_failed");
    expect(rest.requestPort).not.toHaveBeenCalled();
  });

  test("counts the idempotency key in UTF-16 code units, as zod 4.4.3 did: eight emoji, sixteen units, reach the RequestPort", async () => {
    const rest = restOver();
    const idempotencyKey = "\u{1F600}".repeat(8);

    const response = await handleRestCommand(
      post("create_request_draft", { ...envelope(), idempotencyKey }),
      rest.parts("commands", "create_request_draft"),
      rest.options,
    );

    expect(response.status).toBe(200);
    expect(rest.execute.mock.calls[0]?.[2]).toMatchObject({
      meta: { idempotencyKey, expectedVersion: 3 },
    });
  });

  test("refuses an idempotency key of 101 emoji, 202 UTF-16 code units, 422, as zod 4.4.3 did", async () => {
    const rest = restOver();

    const response = await handleRestCommand(
      post("create_request_draft", {
        ...envelope(),
        idempotencyKey: "\u{1F600}".repeat(101),
      }),
      rest.parts("commands", "create_request_draft"),
      rest.options,
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("validation_failed");
    expect(rest.requestPort).not.toHaveBeenCalled();
  });

  test("drops an own __proto__ key of the envelope, as zod 4.4.3 did, and the command reaches the RequestPort", async () => {
    const rest = restOver();

    const response = await handleRestCommand(
      post(
        "create_request_draft",
        '{"input":{},"idempotencyKey":"rest-idempotency-key-0001","expectedVersion":3,"__proto__":{"polluted":true}}',
      ),
      rest.parts("commands", "create_request_draft"),
      rest.options,
    );

    expect(response.status).toBe(200);
    expect(rest.execute).toHaveBeenCalledTimes(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("drops an own __proto__ key inside a command's input, so ask_question's escalation policy parses as 0.2.0 parsed it", async () => {
    const rest = restOver();
    const requestId = "018f0000-0000-7000-8000-0000000c0001";

    const response = await handleRestCommand(
      post(
        "ask_question",
        `{"input":{"requestId":"${requestId}","audience":{"type":"requester"},"bodyMd":"Which one?","escalationPolicy":{"__proto__":{"polluted":true}}},"idempotencyKey":"rest-idempotency-key-0001","expectedVersion":3}`,
      ),
      rest.parts("commands", "ask_question"),
      rest.options,
    );

    expect(response.status).toBe(200);
    const input = rest.execute.mock.calls[0]?.[1] as {
      escalationPolicy: object;
    };
    expect(Object.hasOwn(input.escalationPolicy, "__proto__")).toBe(false);
    const askQuestion = restCommandTransports.find(
      (transport) => transport.name === "ask_question",
    );
    const escalationPolicy = (
      askQuestion?.inputSchema as
        | z.ZodObject<Record<string, z.ZodType>>
        | undefined
    )?.shape.escalationPolicy;
    expect(escalationPolicy?.safeParse(input.escalationPolicy).success).toBe(
      true,
    );
  });

  test("bounds the body at REST_MAX_BODY, 524,288 bytes, unless maxBody says otherwise", async () => {
    const declared = (bytes: number) =>
      post("update_request", envelope(), {
        "content-type": "application/json",
        "content-length": String(bytes),
      });
    const rest = restOver();
    const bounded = restOver({ maxBody: 10 });

    const over = await handleRestCommand(
      declared(REST_MAX_BODY + 1),
      rest.parts("commands", "update_request"),
      rest.options,
    );
    const under = await handleRestCommand(
      post("update_request", envelope()),
      bounded.parts("commands", "update_request"),
      bounded.options,
    );

    expect(REST_MAX_BODY).toBe(524_288);
    expect(over.status).toBe(413);
    expect(await over.text()).toBe(
      '{"error":"request_too_large","message":"API request body is too large"}',
    );
    expect(under.status).toBe(413);
    expect(bounded.requestPort).not.toHaveBeenCalled();
  });
});

test("asks its collaborators for nothing until a request arrives", () => {
  const rest = restOver();

  expect(rest.log).toEqual([]);
  expect(rest.requestPort).not.toHaveBeenCalled();
});
