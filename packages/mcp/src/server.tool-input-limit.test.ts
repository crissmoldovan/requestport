import { readFileSync } from "node:fs";

import type { AgentAuthContext } from "@requestport/auth";
import {
  agentScopes,
  type CommandBus,
  type JsonValue,
} from "@requestport/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { handleMcpRequest, type McpServerDependencies } from "./server.js";

/*
  `McpServer`'s `maxToolInputElements` (ruling 236 item 3, ruling 237;
  GHSA-46jr-4wx8-v453), on both legs of `handleMcpRequest`: the 2025 stateless
  transport, with the 2026-07-28 leg off and on, and `createMcpHandler`.

  @modelcontextprotocol/server counts, through every level of a `tools/call`'s
  `arguments`, each array element and each own object key (a scalar value adds
  nothing), and answers a call over the limit with an `isError` result before
  the input is validated, so the tool does not run. `elements` below is that
  count, so each case shows the size of its own input.

  The limit is 100,000: the JSON values packages/server's MCP handler, the
  route production serves `/mcp` through, lets one message hold
  (`assertJsonDepth`) before it reaches `handleMcpRequest`. A call that
  handler admits carries fewer elements than that, so behind it the limit
  refuses nothing; it guards a caller of `handleMcpRequest` with no such
  handler in front. packages/server's `mcp.tool-input-limit.test.ts` ties the
  two numbers.

  The largest input the tools' schemas bound is `post_work_update`'s: its
  seven keys, 100 evidence records, and 64 fields in each, 6,507 in all, with
  each field's free-form JSON value a scalar. The second describe below works
  that out from what `tools/list` answers. The first describe's inputs are
  that call, and those beyond it nest an array of zeros in one evidence field,
  which the schema accepts, so only the limit stands between them and the
  command.
*/

const LIMIT = 100_000;
const LARGEST = 6_507;
/** `handleMcpRequest`'s `maxRequestBodySize`, which every request here must fit. */
const MAX_BODY = 524_288;

const organizationId = "018f0000-0000-7000-8000-0000000c3001";
const projectId = "018f0000-0000-7000-8000-0000000c3002";
const workSessionId = "018f0000-0000-7000-8000-0000000c3005";

function context(): AgentAuthContext {
  return {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000c3003" },
    organizationId,
    projectId,
    laneIds: new Set(),
    scopes: new Set(agentScopes),
    credentialId: "r236-input-limit-credential",
    authorizationId: "r236-input-limit-authorization",
    audience: "mcp",
    correlationId: "018f0000-0000-7000-8000-0000000c3004",
  };
}

const unreachable = async (): Promise<never> => {
  throw new Error("the input limit cases reach no query");
};

const executed: string[] = [];

const commandBus: CommandBus = {
  async execute<_TInput, TOutput extends JsonValue>(command: {
    name: string;
  }): Promise<TOutput> {
    executed.push(command.name);
    return { accepted: true } as unknown as TOutput;
  },
} as CommandBus;

function dependencies(modernProtocol: boolean): McpServerDependencies {
  return {
    context: context(),
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

/** The SDK's count: every array element and every own object key, at every level. */
function elements(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((sum: number, child) => sum + 1 + elements(child), 0);
  if (value !== null && typeof value === "object")
    return Object.values(value).reduce(
      (sum: number, child) => sum + 1 + elements(child),
      0,
    );
  return 0;
}

/**
 * `post_work_update` with 100 evidence records of 64 fields, and `extra`
 * zeros in an array nested in the first record's first field.
 */
function postWorkUpdate(extra = 0) {
  const evidence = Array.from({ length: 100 }, (_, record) =>
    Object.fromEntries(
      Array.from({ length: 64 }, (_, field) => [
        `field${field}`,
        `record ${record}`,
      ]),
    ),
  );
  if (extra > 0)
    (evidence[0] as Record<string, unknown>).field0 = Array.from(
      { length: extra },
      () => 0,
    );
  return {
    idempotencyKey: "r236-input-limit-post-work-update",
    expectedVersion: 0,
    workSessionId,
    kind: "progress",
    bodyMd: "Progress.",
    progressPercent: 50,
    evidence,
  };
}

const legacyCall = (args: Record<string, unknown>, name = "post_work_update") =>
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
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

const modernCall = (args: Record<string, unknown>) =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": "post_work_update",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "post_work_update",
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "RequestPort input limit",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });

const legs = [
  ["the 2025 transport", legacyCall, false],
  ["the 2025 transport, with the 2026-07-28 leg on", legacyCall, true],
  ["createMcpHandler, the 2026-07-28 leg", modernCall, true],
] as const;

async function answer(
  request: Request,
  serverDependencies: McpServerDependencies,
): Promise<Record<string, unknown>> {
  const response = await handleMcpRequest(request, serverDependencies);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result?: Record<string, unknown>;
    error?: unknown;
  };
  expect(body.error).toBeUndefined();
  return body.result as Record<string, unknown>;
}

async function call(
  request: (args: Record<string, unknown>) => Request,
  modernProtocol: boolean,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return answer(request(args), dependencies(modernProtocol));
}

const bodyBytes = (request: Request) =>
  request.arrayBuffer().then((body) => body.byteLength);

beforeEach(() => {
  executed.length = 0;
  // `responseMode: "json"` warns once per handler, and the 2026-07-28 leg
  // builds one per request.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe(`a tools/call's arguments are limited to ${LIMIT} elements on both legs (rulings 236 and 237)`, () => {
  test("the inputs are the sizes the cases name, and each request fits the body bound", async () => {
    expect(elements(postWorkUpdate())).toBe(LARGEST);
    expect(elements(postWorkUpdate(LIMIT - LARGEST))).toBe(LIMIT);
    expect(elements(postWorkUpdate(LIMIT - LARGEST + 1))).toBe(LIMIT + 1);
    for (const [, request] of legs)
      expect(
        await bodyBytes(request(postWorkUpdate(LIMIT - LARGEST + 1))),
      ).toBeLessThanOrEqual(MAX_BODY);
  });

  test.each(legs)(
    "%s: the largest input the schemas bound runs the command",
    async (_leg, request, modernProtocol) => {
      const result = await call(request, modernProtocol, postWorkUpdate());
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        result: { accepted: true },
      });
      expect(executed).toEqual(["post_work_update"]);
    },
  );

  test.each(legs)(
    `%s: an input of exactly ${LIMIT} elements runs the command`,
    async (_leg, request, modernProtocol) => {
      const result = await call(
        request,
        modernProtocol,
        postWorkUpdate(LIMIT - LARGEST),
      );
      expect(result.isError).not.toBe(true);
      expect(executed).toEqual(["post_work_update"]);
    },
  );

  test.each(legs)(
    `%s: one element more gets the SDK's isError result, and runs nothing`,
    async (_leg, request, modernProtocol) => {
      const result = await call(
        request,
        modernProtocol,
        postWorkUpdate(LIMIT - LARGEST + 1),
      );
      expect(result).toMatchObject({
        content: [
          {
            type: "text",
            text: `Invalid arguments for tool post_work_update: arguments contain more than the maximum of ${LIMIT} elements`,
          },
        ],
        isError: true,
      });
      expect(executed).toEqual([]);
    },
  );
});

/*
  The largest input each tool's schema bounds, worked out from what
  `tools/list` answers (the review of ruling 236's change asked for this, so
  that a schema change which moves the largest input toward the limit fails a
  case here rather than a call in production).

  Every tool the server can register is listed: a context holding every agent
  scope, with every optional host dependency present, lists the tools of all
  four hosts the tools/list golden records. From each listed input schema the
  walk builds the largest input it bounds: every property, optional ones too;
  every array at its `maxItems` (an array without one fails the case); every
  record at the key count its zod `refine` allows, which JSON Schema does not
  show, so `RECORD_KEYS` names each by its path (a record not named there
  fails the case, and the third case shows each count is the schema's); and
  each free-form JSON value (`z.json()`) as a scalar, which the SDK does not
  count. What a free-form value nests is bounded by no tool schema; the limit
  and, behind packages/server's handler, its walk bound it.
*/

/** Each record's key count, by the path the walk names it with: the refines in server.ts. */
const RECORD_KEYS: Record<string, { keys: number; refusal: string }> = {
  "agent_hello.capabilities": {
    keys: 128,
    refusal: "At most 128 capabilities may be reported",
  },
  "register_agent_installation.capabilities": {
    keys: 128,
    refusal: "At most 128 capabilities may be reported",
  },
  "register_machine_workspace.safeCapabilities": {
    keys: 128,
    refusal: "At most 128 capabilities may be reported",
  },
  "register_machine_workspace.privateTelemetry": {
    keys: 128,
    refusal: "At most 128 fields may be supplied",
  },
  "attach_artifact.provenance": {
    keys: 64,
    refusal: "At most 64 fields may be supplied",
  },
  "post_work_update.evidence[]": {
    keys: 64,
    refusal: "At most 64 fields may be supplied",
  },
};

type Schema = Record<string, unknown>;

/** The context's project: a value every UUID field accepts. */
const UUID = projectId;

/** A value each string schema the tools list accepts; a new pattern fails here. */
function stringFor(schema: Schema, path: string): string {
  if (Array.isArray(schema.enum)) return schema.enum[0] as string;
  if (schema.format === "uuid") return UUID;
  if (schema.format === "uri")
    return "https://github.com/requestport/requestport";
  if (schema.format === "date-time") return "2026-10-21T00:00:00Z";
  const values: Record<string, string> = {
    "^[0-9a-f]{64}$": "0".repeat(64),
    "^[0-9a-f]{7,64}$": "abcdef0",
    "^[a-z0-9][a-z0-9-]*$": "a",
    "^[A-Z][A-Z0-9]*$": "A",
    "^[a-z][a-z0-9_.:-]{0,63}$": "a",
  };
  if (typeof schema.pattern === "string") {
    const value = values[schema.pattern];
    if (value === undefined)
      throw new Error(`${path}: no value for pattern ${schema.pattern}`);
    return value;
  }
  return "x".repeat(Math.max(1, (schema.minLength as number | undefined) ?? 1));
}

/** Whether `$ref` names the recursive definition zod writes for `z.json()`. */
function isFreeFormJson(ref: string, defs: Record<string, Schema>): boolean {
  const definition = defs[ref.replace("#/$defs/", "")];
  return (
    Array.isArray(definition?.anyOf) &&
    (definition.anyOf as Schema[]).some(
      (branch) =>
        branch.type === "array" && (branch.items as Schema)?.$ref === ref,
    )
  );
}

/**
 * The largest input `schema` bounds at `path`. `recordKeys` overrides a
 * record's key count by path (the third case's one more).
 */
function largestInput(
  schema: Schema,
  path: string,
  defs: Record<string, Schema>,
  recordKeys: Record<string, number> = {},
): unknown {
  if (typeof schema.$ref === "string") {
    if (isFreeFormJson(schema.$ref, defs)) return "v";
    const definition = defs[schema.$ref.replace("#/$defs/", "")];
    if (!definition) throw new Error(`${path}: ${schema.$ref} is not defined`);
    return largestInput(definition, path, defs, recordKeys);
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.anyOf)) {
    let best: unknown;
    let bestElements = -1;
    for (const branch of schema.anyOf as Schema[]) {
      if (branch.type === "null") continue;
      const value = largestInput(branch, path, defs, recordKeys);
      if (elements(value) > bestElements) {
        best = value;
        bestElements = elements(value);
      }
    }
    return best;
  }
  switch (schema.type) {
    case "object": {
      const value: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(
        (schema.properties ?? {}) as Record<string, Schema>,
      ))
        value[key] = largestInput(child, `${path}.${key}`, defs, recordKeys);
      const extra = schema.additionalProperties;
      if (extra !== undefined && extra !== false) {
        const keys = recordKeys[path] ?? RECORD_KEYS[path]?.keys;
        if (keys === undefined)
          throw new Error(`${path}: a record whose key count is not named`);
        for (let index = 0; index < keys; index += 1)
          value[`k${index}`] = largestInput(
            extra as Schema,
            `${path}{}`,
            defs,
            recordKeys,
          );
      }
      return value;
    }
    case "array":
      if (typeof schema.maxItems !== "number")
        throw new Error(`${path}: an array with no maxItems`);
      return Array.from({ length: schema.maxItems }, () =>
        largestInput(schema.items as Schema, `${path}[]`, defs, recordKeys),
      );
    case "string":
      return stringFor(schema, path);
    case "integer":
    case "number":
      return typeof schema.minimum === "number"
        ? schema.minimum
        : typeof schema.exclusiveMinimum === "number"
          ? schema.exclusiveMinimum + 1
          : 0;
    case "boolean":
      return true;
    default:
      throw new Error(`${path}: no value for ${JSON.stringify(schema)}`);
  }
}

const answers = async () => ({ answered: true });

/** Every optional host dependency, each answering, and every query answering. */
function everyTool(): McpServerDependencies {
  return {
    ...dependencies(false),
    acceptsPrivateTelemetry: true,
    queries: {
      getAgentPolicy: async () => ({
        heartbeatIntervalSeconds: 60,
        leaseMultiplier: 3,
        graceSeconds: 30,
        requiredWorkspaceFields: [],
      }),
      listOrganizations: answers,
      listProjects: answers,
      getProject: answers,
      listRequests: answers,
      getRequest: answers,
      listTimeline: answers,
      listOpenQuestions: answers,
      listEvents: answers,
    },
    registerProject: answers,
    createProject: answers,
    provisionAgent: answers,
    webhooks: {
      list: answers,
      create: answers,
      verify: answers,
      rotate: answers,
      setStatus: answers,
      replay: answers,
    },
    imports: {
      list: answers,
      analyze: answers,
      detail: answers,
      apply: answers,
      correct: answers,
    },
  };
}

type ListedTool = {
  name: string;
  inputSchema: Schema & { $defs?: Record<string, Schema> };
};

async function listedTools(): Promise<ListedTool[]> {
  const response = await handleMcpRequest(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    everyTool(),
  );
  return ((await response.json()) as { result: { tools: ListedTool[] } }).result
    .tools;
}

function largestInputOf(
  tool: ListedTool,
  recordKeys: Record<string, number> = {},
) {
  return largestInput(
    tool.inputSchema,
    tool.name,
    tool.inputSchema.$defs ?? {},
    recordKeys,
  ) as Record<string, unknown>;
}

describe(`the largest input each tool's schema bounds is ${LARGEST} elements, post_work_update's, and under the limit (ruling 237)`, () => {
  test("every tool the server can register is listed", async () => {
    const golden = JSON.parse(
      readFileSync(
        new URL("./server.tools-list.golden.json", import.meta.url),
        {
          encoding: "utf8",
        },
      ),
    ) as Record<string, Array<{ name: string }>>;
    const everyHost = new Set(
      Object.values(golden).flatMap((tools) => tools.map((tool) => tool.name)),
    );
    const listed = (await listedTools()).map((tool) => tool.name);
    expect(new Set(listed)).toEqual(everyHost);
    expect(listed).toHaveLength(52);
  });

  test("each tool's largest input passes its schema and is at most the limit; the largest is post_work_update's", async () => {
    const sizes: Array<{ name: string; elements: number }> = [];
    for (const tool of await listedTools()) {
      const args = largestInputOf(tool);
      const result = await answer(legacyCall(args, tool.name), everyTool());
      expect(
        { tool: tool.name, isError: result.isError === true },
        JSON.stringify(result.content),
      ).toEqual({ tool: tool.name, isError: false });
      sizes.push({ name: tool.name, elements: elements(args) });
    }
    sizes.sort((a, b) => b.elements - a.elements);
    expect(sizes[0]).toEqual({ name: "post_work_update", elements: LARGEST });
    expect(sizes[1]?.elements).toBeLessThan(LARGEST);
    expect(LARGEST).toBeLessThanOrEqual(LIMIT);
  });

  test.each(Object.entries(RECORD_KEYS))(
    "%s: one key more than its count is refused by the schema",
    async (path, { keys, refusal }) => {
      const tool = (await listedTools()).find(
        (listed) => listed.name === path.split(".")[0],
      );
      if (!tool) throw new Error(`${path}: no such tool`);
      const result = await answer(
        legacyCall(largestInputOf(tool, { [path]: keys + 1 }), tool.name),
        everyTool(),
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        "Input validation error",
      );
      expect(JSON.stringify(result.content)).toContain(refusal);
    },
  );
});
