import type { AgentAuthContext } from "@requestport/auth";
import type { RequestPort } from "@requestport/core";
import { agentScopes, DomainError } from "@requestport/domain";
import { handleMcpRequest } from "@requestport/mcp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { assertJsonDepth } from "./input-limits.js";
import { handleMcp, MCP_MAX_BODY, type McpOptions } from "./mcp.js";

/*
  The two bounds on one MCP tool call's size, held to one number (ruling 237).

  - This package's MCP handler (`handleMcp`, the route production serves
    `/mcp` through) refuses a message whose JSON holds more than 100,000
    values. `assertJsonDepth` counts every value its walk visits: the message
    itself, each array element and each object member's value, at every
    level. The handler refuses before the bearer is checked and before
    `handleMcpRequest` is reached.
  - `@requestport/mcp` builds its `McpServer` with `maxToolInputElements`
    100,000. @modelcontextprotocol/server counts each array element and each
    own object key in a `tools/call`'s `arguments`, and answers a call over
    the limit with an `isError` result, so its tool does not run.

  Each element or key the SDK counts in `arguments` is a value the walk visits
  under it, and the walk also visits the message, its `params` and
  `arguments` itself. So a call the handler admits holds at most 99,997
  elements, and behind the handler the SDK's limit refuses nothing.

  These cases fail if either number moves without the other. On each leg, the
  first three show with the real `assertJsonDepth` that ROUTE_VALUES is the
  walk's bound, send the largest call the handler admits through it to the
  command, and see one value more refused before the bearer is checked. The
  fourth sends ROUTE_VALUES elements, then one more, to `handleMcpRequest`
  itself.

  `@requestport/mcp` cannot import this package, which depends on it, so this
  test ties the two numbers, not a constant both import. Such a constant would
  be a new export of a published package. It would also make `assertJsonDepth`,
  which REST uses too, depend on the MCP package.
*/

const ROUTE_VALUES = 100_000;

const projectId = "018f0000-0000-7000-8000-0000000c3702";

const agent: AgentAuthContext = {
  actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000c3703" },
  audience: "mcp",
  organizationId: "018f0000-0000-7000-8000-0000000c3701",
  projectId,
  scopes: new Set(agentScopes),
  laneIds: new Set<string>(),
  authorizationId: "r237-input-limit-authorization",
  credentialId: "r237-input-limit-credential",
  correlationId: "018f0000-0000-7000-8000-0000000c3704",
};

/** Every value `assertJsonDepth`'s walk visits in `value`, the root included. */
function values(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((sum: number, child) => sum + values(child), 1);
  if (value !== null && typeof value === "object")
    return Object.values(value).reduce(
      (sum: number, child) => sum + values(child),
      1,
    );
  return 1;
}

/** The SDK's count: every array element and every own object key, at every level. */
function elements(value: unknown): number {
  return values(value) - 1;
}

/** `post_work_update` with one evidence record, whose one field holds `zeros` zeros. */
function postWorkUpdate(zeros: number) {
  return {
    idempotencyKey: "r237-input-limit-post-work-update",
    expectedVersion: 0,
    workSessionId: "018f0000-0000-7000-8000-0000000c3705",
    kind: "progress",
    bodyMd: "Progress.",
    evidence: [{ data: Array.from({ length: zeros }, () => 0) }],
  };
}

const legs = [
  {
    leg: "the 2025 transport",
    modernProtocol: false,
    headers: { "mcp-protocol-version": "2025-06-18" },
    meta: undefined,
  },
  {
    leg: "createMcpHandler, the 2026-07-28 leg",
    modernProtocol: true,
    headers: {
      "mcp-method": "tools/call",
      "mcp-name": "post_work_update",
      "mcp-protocol-version": "2026-07-28",
    },
    meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "RequestPort input limit",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
] as const;

type Leg = (typeof legs)[number];

function message(leg: Leg, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "post_work_update",
      arguments: args,
      ...(leg.meta ? { _meta: leg.meta } : {}),
    },
  };
}

function post(leg: Leg, body: unknown) {
  return new Request("https://requestport.test/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer an-mcp-credential",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...leg.headers,
    },
    body: JSON.stringify(body),
  });
}

/** The largest call on `leg` the walk admits: ROUTE_VALUES values, by `values`. */
function largestAdmitted(leg: Leg) {
  const envelope = values(message(leg, postWorkUpdate(0)));
  return message(leg, postWorkUpdate(ROUTE_VALUES - envelope));
}

/** The same call with one zero more. */
function oneValueMore(leg: Leg) {
  const envelope = values(message(leg, postWorkUpdate(0)));
  return message(leg, postWorkUpdate(ROUTE_VALUES - envelope + 1));
}

const executed: string[] = [];

/** The handler's collaborators, admitting every request, over a RequestPort whose bus records each command. */
function options(leg: Leg) {
  const authenticateAgentBearer = vi.fn(async () => agent);
  const port = {
    commandBus: {
      execute: vi.fn(async (command: { name: string }) => {
        executed.push(command.name);
        return { accepted: true };
      }),
    },
    agentQueries: {},
    execute: vi.fn(),
    mcpOnly: { createProject: vi.fn(), provisionAgent: vi.fn() },
  };
  const handlerOptions: McpOptions = {
    authenticateAgentBearer,
    rateLimiter: {
      fingerprint: () => "fingerprint",
      enforce: async () => ({
        allowed: true,
        remaining: 1,
        retryAfterSeconds: 0,
      }),
    },
    requestPort: () => port as unknown as RequestPort,
    withProject: () => ({ projectId }),
    challenge: () => "Bearer",
    privateTelemetry: () => false,
    modernProtocol: () => leg.modernProtocol,
    logger: { error: vi.fn() },
    metrics: { count: vi.fn(), observe: vi.fn() },
  };
  return { handlerOptions, authenticateAgentBearer };
}

beforeEach(() => {
  executed.length = 0;
  // `responseMode: "json"` warns once per handler, and the 2026-07-28 leg
  // builds one per request.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe(`one MCP tool call: the handler's walk and the SDK's maxToolInputElements are both ${ROUTE_VALUES} (ruling 237)`, () => {
  test.each(legs)(
    "$leg: ROUTE_VALUES is the walk's bound, and each request fits the body bound",
    async (leg) => {
      const admitted = largestAdmitted(leg);
      expect(values(admitted)).toBe(ROUTE_VALUES);
      expect(() => assertJsonDepth(admitted)).not.toThrow();
      const over = oneValueMore(leg);
      expect(() => assertJsonDepth(over)).toThrow(
        new DomainError("validation_failed", "JSON input is too complex"),
      );
      for (const body of [admitted, over])
        expect(
          (await post(leg, body).arrayBuffer()).byteLength,
        ).toBeLessThanOrEqual(MCP_MAX_BODY);
    },
  );

  test.each(legs)(
    "$leg: the largest call the handler admits runs its command, under the SDK's limit",
    async (leg) => {
      const admitted = largestAdmitted(leg);
      expect(elements(admitted.params.arguments)).toBeLessThan(ROUTE_VALUES);
      const { handlerOptions } = options(leg);
      const response = await handleMcp(post(leg, admitted), handlerOptions);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result?: { isError?: boolean; structuredContent?: unknown };
      };
      expect(body.result?.isError).not.toBe(true);
      expect(body.result?.structuredContent).toMatchObject({
        result: { accepted: true },
      });
      expect(executed).toEqual(["post_work_update"]);
    },
  );

  test.each(legs)(
    "$leg: one value more is refused by the walk, before the bearer and the SDK",
    async (leg) => {
      const { handlerOptions, authenticateAgentBearer } = options(leg);
      const response = await handleMcp(
        post(leg, oneValueMore(leg)),
        handlerOptions,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "validation_failed",
        message: "The MCP request is invalid.",
      });
      expect(authenticateAgentBearer).not.toHaveBeenCalled();
      expect(executed).toEqual([]);
    },
  );

  test.each(legs)(
    "$leg: handleMcpRequest alone runs ROUTE_VALUES elements, and refuses one more with the SDK's isError",
    async (leg) => {
      const atLimit = postWorkUpdate(
        ROUTE_VALUES - elements(postWorkUpdate(0)),
      );
      const overLimit = postWorkUpdate(
        ROUTE_VALUES - elements(postWorkUpdate(0)) + 1,
      );
      expect(elements(atLimit)).toBe(ROUTE_VALUES);
      expect(elements(overLimit)).toBe(ROUTE_VALUES + 1);
      const answers: Array<Record<string, unknown> | undefined> = [];
      for (const args of [atLimit, overLimit]) {
        const response = await handleMcpRequest(post(leg, message(leg, args)), {
          context: agent,
          commandBus: {
            execute: async (command: { name: string }) => {
              executed.push(command.name);
              return { accepted: true };
            },
          } as never,
          queries: {} as never,
          modernProtocol: leg.modernProtocol,
        });
        expect(response.status).toBe(200);
        answers.push(
          ((await response.json()) as { result?: Record<string, unknown> })
            .result,
        );
      }
      expect(answers[0]?.isError).not.toBe(true);
      expect(answers[1]).toMatchObject({
        content: [
          {
            type: "text",
            text: `Invalid arguments for tool post_work_update: arguments contain more than the maximum of ${ROUTE_VALUES} elements`,
          },
        ],
        isError: true,
      });
      expect(executed).toEqual(["post_work_update"]);
    },
  );
});
