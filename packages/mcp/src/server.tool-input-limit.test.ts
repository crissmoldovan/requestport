import { readFileSync } from "node:fs";

import type { AgentAuthContext } from "@requestport/auth";
import {
  AtomicCommandBus,
  agentScopes,
  type CommandBus,
  createCoreCommandRegistry,
  DomainError,
  type JsonValue,
  privateWorkspaceTelemetrySchema,
  type TransactionManager,
} from "@requestport/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

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

  The limit is 17,000: the JSON values packages/server's MCP handler, the
  route production serves `/mcp` through, lets one message hold
  (`assertJsonDepth`'s bound) before it reaches `handleMcpRequest`. A call that handler admits carries fewer elements than
  that, so behind it the limit refuses nothing; it guards a caller of
  `handleMcpRequest` with no such handler in front. packages/server's
  `mcp.tool-input-limit.test.ts` ties the two numbers.

  17,000 is the largest message a legitimate call sends, rounded up to the
  next 1,000 (ruling 237 item 3). That call is `post_work_update`'s: its seven
  keys, 100 evidence records, 64 fields in each, and the 10,000 elements the
  domain lets evidence's field values hold in all, 16,507 elements; its
  message on the 2026-07-28 leg, with the six-value `_meta` these cases send,
  holds 16,520 values, which leaves 480 for a longer one. The second describe below
  works that out from what `tools/list` answers and the domain's bounds.

  The first describe's inputs nest an array of zeros in one evidence field.
  Past 16,507 elements the domain would refuse them, but that describe's
  command bus is a stand-in that parses nothing, so only the limit stands
  between them and the command.
*/

const LIMIT = 17_000;
/** `post_work_update`'s largest input with each free-form value a scalar. */
const SCALARS = 6_507;
/** The largest input a tool can legitimately carry: `post_work_update`'s. */
const LARGEST = 16_507;
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

/** A `post_work_update` call's message on the 2026-07-28 leg, with a `_meta` of protocol version, client and capabilities: six values. */
const modernMessage = (args: Record<string, unknown>) => ({
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
    body: JSON.stringify(modernMessage(args)),
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
    expect(elements(postWorkUpdate())).toBe(SCALARS);
    expect(elements(postWorkUpdate(LARGEST - SCALARS))).toBe(LARGEST);
    expect(elements(postWorkUpdate(LIMIT - SCALARS))).toBe(LIMIT);
    expect(elements(postWorkUpdate(LIMIT - SCALARS + 1))).toBe(LIMIT + 1);
    for (const [, request] of legs)
      expect(
        await bodyBytes(request(postWorkUpdate(LIMIT - SCALARS + 1))),
      ).toBeLessThanOrEqual(MAX_BODY);
  });

  test.each(legs)(
    "%s: the largest input a tool can legitimately carry runs the command",
    async (_leg, request, modernProtocol) => {
      const result = await call(
        request,
        modernProtocol,
        postWorkUpdate(LARGEST - SCALARS),
      );
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
        postWorkUpdate(LIMIT - SCALARS),
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
        postWorkUpdate(LIMIT - SCALARS + 1),
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
  The free-form inputs' bounds, on MCP (ruling 237 item 3). The domain bounds
  `evidence`, `provenance` and `structuredValue` where REST and MCP both parse
  them, not the tool schemas, so a call past one passes the SDK and reaches
  the command bus. The bus here is a real `AtomicCommandBus` over the core
  registry, so the command's input is parsed by the schema production parses
  it with; its transaction manager records the command and answers without
  running it, so a recorded command is one whose input the domain accepted.
*/

const transacted: string[] = [];

const domainTransactions: TransactionManager = {
  run: async <T>(): Promise<T> => {
    transacted.push("transaction");
    return { output: { accepted: true }, events: [] } as T;
  },
};

const domainBus = new AtomicCommandBus({
  registry: createCoreCommandRegistry(),
  transactions: domainTransactions,
  fingerprintSecret: "mcp-input-limit-fingerprint-secret",
});

const zeros = (count: number) => Array.from({ length: count }, () => 0);

/** `[[[…[0]…]]]`, its innermost zero at depth `levels`. */
function nested(levels: number): unknown {
  let value: unknown = 0;
  for (let level = 0; level < levels; level += 1) value = [value];
  return value;
}

const meta = {
  idempotencyKey: "mcp-input-limit-free-form",
  expectedVersion: 0,
};

const workUpdate = (evidence: unknown) => ({
  ...meta,
  workSessionId,
  kind: "progress",
  bodyMd: "Progress.",
  evidence,
});

const artifact = (provenance: unknown) => ({
  ...meta,
  requestId: "018f0000-0000-7000-8000-0000000c3006",
  kind: "log",
  externalUrl: "https://example.com/artifact",
  provenance,
});

const answerOf = (structuredValue: unknown) => ({
  ...meta,
  questionId: "018f0000-0000-7000-8000-0000000c3007",
  bodyMd: "Answer.",
  structuredValue,
});

/**
 * Each free-form input at each of its three bounds, and one past it. The
 * byte cases pad one string: `[{"data":"…"}]` is its length and 13,
 * `{"data":"…"}` its length and 11, and a bare string its length and 2.
 */
const freeFormBoundCases = [
  {
    input: "evidence",
    tool: "post_work_update",
    bound: "10,000 elements",
    refused: { bound: "elements", maximum: 10_000 },
    at: workUpdate([{ data: zeros(10_000) }]),
    over: workUpdate([{ data: zeros(10_001) }]),
  },
  {
    input: "evidence",
    tool: "post_work_update",
    bound: "depth 8",
    refused: { bound: "depth", maximum: 8 },
    at: workUpdate([{ data: nested(8) }]),
    over: workUpdate([{ data: nested(9) }]),
  },
  {
    input: "evidence",
    tool: "post_work_update",
    bound: "262,144 bytes",
    refused: { bound: "bytes", maximum: 262_144 },
    at: workUpdate([{ data: "x".repeat(262_144 - 13) }]),
    over: workUpdate([{ data: "x".repeat(262_144 - 12) }]),
  },
  {
    input: "provenance",
    tool: "attach_artifact",
    bound: "2,000 elements",
    refused: { bound: "elements", maximum: 2_000 },
    at: artifact({ a: zeros(1_000), b: zeros(1_000) }),
    over: artifact({ a: zeros(1_000), b: zeros(1_001) }),
  },
  {
    input: "provenance",
    tool: "attach_artifact",
    bound: "depth 8",
    refused: { bound: "depth", maximum: 8 },
    at: artifact({ data: nested(8) }),
    over: artifact({ data: nested(9) }),
  },
  {
    input: "provenance",
    tool: "attach_artifact",
    bound: "65,536 bytes",
    refused: { bound: "bytes", maximum: 65_536 },
    at: artifact({ data: "x".repeat(65_536 - 11) }),
    over: artifact({ data: "x".repeat(65_536 - 10) }),
  },
  {
    input: "structuredValue",
    tool: "answer_question",
    bound: "2,000 elements",
    refused: { bound: "elements", maximum: 2_000 },
    at: answerOf(zeros(2_000)),
    over: answerOf(zeros(2_001)),
  },
  {
    input: "structuredValue",
    tool: "answer_question",
    bound: "depth 8",
    refused: { bound: "depth", maximum: 8 },
    at: answerOf(nested(8)),
    over: answerOf(nested(9)),
  },
  {
    input: "structuredValue",
    tool: "answer_question",
    bound: "65,536 bytes",
    refused: { bound: "bytes", maximum: 65_536 },
    at: answerOf("x".repeat(65_536 - 2)),
    over: answerOf("x".repeat(65_536 - 1)),
  },
] as const;

const overDomain = (): McpServerDependencies => ({
  ...dependencies(false),
  commandBus: domainBus,
});

/*
  The server publishes a bound only as the domain's bus names one: one of
  the three bounds with a positive integer `maximum`, together. A
  DomainError carrying anything else keeps it inside.
*/
describe("the MCP server publishes a refusal's bound only as the domain names one (ruling 237 item 3)", () => {
  test.each([
    [
      { field: "evidence", bound: "elements", maximum: 10_000 },
      { field: "evidence", bound: "elements", maximum: 10_000 },
    ],
    [{ field: "evidence", bound: "keys", maximum: 3 }, { field: "evidence" }],
    [{ field: "evidence", bound: "depth", maximum: 0 }, { field: "evidence" }],
    [
      { field: "evidence", bound: "depth", maximum: 2.5 },
      { field: "evidence" },
    ],
    [
      { field: "evidence", bound: "bytes", maximum: "65536" },
      { field: "evidence" },
    ],
    [{ field: "evidence", bound: "bytes" }, { field: "evidence" }],
    [{ field: "evidence", maximum: 3 }, { field: "evidence" }],
  ])(
    "a DomainError's details %j are published as %j",
    async (given, published) => {
      const throwing = {
        execute: async () => {
          throw new DomainError("validation_failed", "internal wording", given);
        },
      } as unknown as CommandBus;
      const result = await answer(legacyCall(workUpdate([])), {
        ...dependencies(false),
        commandBus: throwing,
      });
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "validation_failed",
              message: "The tool input is invalid.",
              details: published,
            }),
          },
        ],
      });
    },
  );
});

describe("the free-form inputs' bounds, on MCP (ruling 237 item 3)", () => {
  beforeEach(() => {
    transacted.length = 0;
  });

  test.each(freeFormBoundCases)(
    "$tool: $input at $bound runs the command",
    async ({ tool, at }) => {
      const result = await answer(legacyCall(at, tool), overDomain());
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        result: { accepted: true },
      });
      expect(transacted).toEqual(["transaction"]);
    },
  );

  test.each(freeFormBoundCases)(
    "$tool: $input past $bound is refused, validation_failed naming $input and the bound, and runs nothing",
    async ({ tool, input, refused, over }) => {
      const result = await answer(legacyCall(over, tool), overDomain());
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "validation_failed",
              message: "The tool input is invalid.",
              details: { field: input, ...refused },
            }),
          },
        ],
      });
      expect(transacted).toEqual([]);
    },
  );
});

/*
  The largest input each tool can legitimately carry, worked out from what
  `tools/list` answers and the domain's bounds (the review of ruling 236's
  change asked for the walk, so that a schema change which moves the largest
  input toward the limit fails a case here rather than a call in production;
  ruling 237 item 3 set the limit from what it finds).

  Every tool the server can register is listed: a context holding every agent
  scope, with every optional host dependency present, lists the tools of all
  four hosts the tools/list golden records. From each listed input schema the
  walk builds the largest input it bounds: every property, optional ones too;
  every array at its `maxItems` (an array without one fails the case); for
  `anyOf`, the branch with the most elements; and every record at the key
  count its zod `refine` allows, which JSON Schema does not show, so
  `RECORD_KEYS` names each by its path (a record not named there fails the
  case).

  What a free-form JSON value (`z.json()`) nests no tool schema bounds; the
  domain bounds it, where REST and MCP both parse it. So `FREE_FORM` names
  each free-form value's path with the most elements the domain lets that
  input's free-form values hold in all; the walk puts that budget in the first
  value at the path, as an array of zeros, and makes the rest scalars, which
  the SDK does not count (a free-form value not named there fails the case).
  `privateTelemetry` is free-form in the tool's schema, and the domain parses
  it strictly, so the walk builds it from the domain's schema
  (`DOMAIN_SHAPED`).

  Each input is sent through the 2025 leg. The commands whose input the domain
  bounds beyond the tool's schema go to `domainBus` (above), which parses as
  production does, and the rest to fakes that answer. The last two cases
  show that each count `RECORD_KEYS` and `FREE_FORM` name is the tool's or
  the domain's own: one more is refused.
*/

/**
 * Each record's key count, by the path the walk names it with: the refines in
 * server.ts, which the SDK enforces, and the domain's, which the command bus
 * does (refusing with the field it names).
 */
const RECORD_KEYS: Record<
  string,
  | { keys: number; refusedBy: "tool"; refusal: string }
  | { keys: number; refusedBy: "domain"; field: string }
> = {
  "agent_hello.capabilities": {
    keys: 128,
    refusedBy: "tool",
    refusal: "At most 128 capabilities may be reported",
  },
  "register_agent_installation.capabilities": {
    keys: 128,
    refusedBy: "tool",
    refusal: "At most 128 capabilities may be reported",
  },
  "register_machine_workspace.safeCapabilities": {
    keys: 128,
    refusedBy: "tool",
    refusal: "At most 128 capabilities may be reported",
  },
  "register_machine_workspace.privateTelemetry": {
    keys: 128,
    refusedBy: "tool",
    refusal: "At most 128 fields may be supplied",
  },
  "register_machine_workspace.privateTelemetry.toolVersions": {
    keys: 128,
    refusedBy: "domain",
    field: "privateTelemetry.toolVersions",
  },
  "attach_artifact.provenance": {
    keys: 64,
    refusedBy: "tool",
    refusal: "At most 64 fields may be supplied",
  },
  "post_work_update.evidence[]": {
    keys: 64,
    refusedBy: "tool",
    refusal: "At most 64 fields may be supplied",
  },
};

/**
 * Each free-form value's budget, by the path the walk names it with: the most
 * elements the domain lets that input's free-form values hold in all, and the
 * field its refusal names.
 */
const FREE_FORM: Record<string, { elements: number; field: string }> = {
  "post_work_update.evidence[]{}": { elements: 10_000, field: "evidence" },
  "attach_artifact.provenance{}": { elements: 2_000, field: "provenance" },
  "answer_question.structuredValue": {
    elements: 2_000,
    field: "structuredValue",
  },
};

type Schema = Record<string, unknown>;

/**
 * The inputs the walk builds from the domain's schema rather than the tool's,
 * by path. Under the third case's one key more, `privateTelemetry` is built in
 * the tool's shape instead, each of its free-form values a scalar.
 */
const DOMAIN_SHAPED: Record<string, Schema> = {
  "register_machine_workspace.privateTelemetry": z.toJSONSchema(
    privateWorkspaceTelemetrySchema,
    { io: "input" },
  ) as Schema,
};

/** The commands the walk sends to `domainBus`: those whose input the domain bounds beyond the tool's schema. */
const DOMAIN_PARSED = new Set([
  "post_work_update",
  "attach_artifact",
  "answer_question",
  "register_machine_workspace",
]);

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

/** What one walk changes: each free-form path's budget still unspent, and the counts the third and fourth cases raise. */
type Walk = {
  budgets: Map<string, number>;
  recordKeys: Record<string, number>;
};

/** A free-form value at `path`: the budget left there as zeros, then scalars. */
function freeFormValue(path: string, walk: Walk): unknown {
  const left = walk.budgets.get(path);
  if (left === undefined) {
    if (Object.keys(DOMAIN_SHAPED).some((shaped) => path.startsWith(shaped)))
      return "v";
    throw new Error(`${path}: a free-form value whose budget is not named`);
  }
  if (left === 0) return "v";
  walk.budgets.set(path, 0);
  return Array.from({ length: left }, () => 0);
}

/** The largest input `schema` bounds at `path`. */
function largestInput(
  schema: Schema,
  path: string,
  defs: Record<string, Schema>,
  walk: Walk,
): unknown {
  const shaped = DOMAIN_SHAPED[path];
  if (shaped && schema !== shaped && walk.recordKeys[path] === undefined)
    return largestInput(shaped, path, {}, walk);
  if (typeof schema.$ref === "string") {
    if (isFreeFormJson(schema.$ref, defs)) return freeFormValue(path, walk);
    const definition = defs[schema.$ref.replace("#/$defs/", "")];
    if (!definition) throw new Error(`${path}: ${schema.$ref} is not defined`);
    return largestInput(definition, path, defs, walk);
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.anyOf)) {
    let best: unknown;
    let bestElements = -1;
    let bestBudgets = walk.budgets;
    for (const branch of schema.anyOf as Schema[]) {
      if (branch.type === "null") continue;
      const budgets = new Map(walk.budgets);
      const value = largestInput(branch, path, defs, { ...walk, budgets });
      if (elements(value) > bestElements) {
        best = value;
        bestElements = elements(value);
        bestBudgets = budgets;
      }
    }
    for (const [key, left] of bestBudgets) walk.budgets.set(key, left);
    return best;
  }
  switch (schema.type) {
    case "object": {
      const value: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(
        (schema.properties ?? {}) as Record<string, Schema>,
      ))
        value[key] = largestInput(child, `${path}.${key}`, defs, walk);
      const extra = schema.additionalProperties;
      if (extra !== undefined && extra !== false) {
        const keys = walk.recordKeys[path] ?? RECORD_KEYS[path]?.keys;
        if (keys === undefined)
          throw new Error(`${path}: a record whose key count is not named`);
        for (let index = 0; index < keys; index += 1)
          value[`k${index}`] = largestInput(
            extra as Schema,
            `${path}{}`,
            defs,
            walk,
          );
      }
      return value;
    }
    case "array":
      if (typeof schema.maxItems !== "number")
        throw new Error(`${path}: an array with no maxItems`);
      return Array.from({ length: schema.maxItems }, () =>
        largestInput(schema.items as Schema, `${path}[]`, defs, walk),
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

/** Bus commands go to `domainBus` when the domain bounds their input, and to the stand-in otherwise. */
const walkBus: CommandBus = {
  execute: (command) =>
    DOMAIN_PARSED.has(command.name)
      ? domainBus.execute(command)
      : commandBus.execute(command),
} as CommandBus;

/** Every optional host dependency, each answering, and every query answering. */
function everyTool(): McpServerDependencies {
  return {
    ...dependencies(false),
    commandBus: walkBus,
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

/**
 * `tool`'s largest input. `recordKeys` overrides a record's key count by path
 * (the third case's one more), and `budgets` a free-form path's budget (the
 * fourth case's one more).
 */
function largestInputOf(
  tool: ListedTool,
  recordKeys: Record<string, number> = {},
  budgets: Record<string, number> = {},
) {
  const walk: Walk = {
    budgets: new Map(
      Object.entries(FREE_FORM).map(([path, { elements: budget }]) => [
        path,
        budgets[path] ?? budget,
      ]),
    ),
    recordKeys,
  };
  return largestInput(
    tool.inputSchema,
    tool.name,
    tool.inputSchema.$defs ?? {},
    walk,
  ) as Record<string, unknown>;
}

/**
 * The validation_failed result the domain's refusal of `field` gets on MCP;
 * with `refused`, a free-form bound's, which names the bound and its value.
 */
const domainRefusal = (
  field: string,
  refused: { bound: string; maximum: number } | Record<string, never> = {},
) => ({
  isError: true,
  content: [
    {
      type: "text",
      text: JSON.stringify({
        error: "validation_failed",
        message: "The tool input is invalid.",
        details: { field, ...refused },
      }),
    },
  ],
});

describe(`the largest input a tool can legitimately carry is ${LARGEST} elements, post_work_update's, and the limit is its message rounded up to the next 1,000 (ruling 237 item 3)`, () => {
  beforeEach(() => {
    transacted.length = 0;
  });

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
    expect(listed).toHaveLength(53);
  });

  test("each tool's largest input runs it; the largest is post_work_update's, and its message fits the limit, rounded up", async () => {
    const sizes: Array<{ name: string; elements: number }> = [];
    let largest: Record<string, unknown> = {};
    for (const tool of await listedTools()) {
      const args = largestInputOf(tool);
      const result = await answer(legacyCall(args, tool.name), everyTool());
      expect(
        { tool: tool.name, isError: result.isError === true },
        JSON.stringify(result.content),
      ).toEqual({ tool: tool.name, isError: false });
      sizes.push({ name: tool.name, elements: elements(args) });
      if (tool.name === "post_work_update") largest = args;
    }
    // Each of the four the domain bounds reached its transaction.
    expect(transacted).toHaveLength(DOMAIN_PARSED.size);
    sizes.sort((a, b) => b.elements - a.elements);
    expect(sizes[0]).toEqual({ name: "post_work_update", elements: LARGEST });
    expect(sizes[1]?.elements).toBeLessThan(LARGEST);
    // The route's walk counts the message: on the 2026-07-28 leg, its
    // `_meta` too. The limit is that figure rounded up to the next 1,000.
    const message = elements(modernMessage(largest)) + 1;
    expect(message).toBe(16_520);
    expect(LIMIT).toBe(Math.ceil(message / 1_000) * 1_000);
  });

  test.each(Object.entries(RECORD_KEYS))(
    "%s: one key more than its count is refused",
    async (path, record) => {
      const tool = (await listedTools()).find(
        (listed) => listed.name === path.split(".")[0],
      );
      if (!tool) throw new Error(`${path}: no such tool`);
      const result = await answer(
        legacyCall(
          largestInputOf(tool, { [path]: record.keys + 1 }),
          tool.name,
        ),
        everyTool(),
      );
      if (record.refusedBy === "domain") {
        expect(result).toEqual(domainRefusal(record.field));
      } else {
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(
          "Input validation error",
        );
        expect(JSON.stringify(result.content)).toContain(record.refusal);
      }
      expect(transacted).toEqual([]);
    },
  );

  test.each(Object.entries(FREE_FORM))(
    "%s: one element more than its budget is refused by the domain, naming the elements bound",
    async (path, { elements: budget, field }) => {
      const tool = (await listedTools()).find(
        (listed) => listed.name === path.split(".")[0],
      );
      if (!tool) throw new Error(`${path}: no such tool`);
      const result = await answer(
        legacyCall(largestInputOf(tool, {}, { [path]: budget + 1 }), tool.name),
        everyTool(),
      );
      expect(result).toEqual(
        domainRefusal(field, { bound: "elements", maximum: budget }),
      );
      expect(transacted).toEqual([]);
    },
  );
});
