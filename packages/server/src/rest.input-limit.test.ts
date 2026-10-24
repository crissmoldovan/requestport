import { readFileSync } from "node:fs";

import type { ApiAuthContext } from "@requestport/auth";
import type { RequestPort } from "@requestport/core";
import {
  AtomicCommandBus,
  agentScopes,
  createCoreCommandRegistry,
  DomainError,
  findRestCommandTransport,
  restCommandTransports,
  type TransactionManager,
} from "@requestport/domain";
import { beforeEach, describe, expect, test } from "vitest";

import { assertJsonDepth } from "./input-limits.js";
import { withProject } from "./project-scope.js";
import { handleRestCommand, REST_MAX_BODY, type RestOptions } from "./rest.js";

/*
  The REST command route, over the domain's own parse (ruling 237 item 3).

  `handleRestCommand` runs here with a RequestPort whose `execute` hands each
  bus command to a real `AtomicCommandBus` over the core registry, so the
  command's input is parsed by the schema production parses it with. The
  bus's transaction manager records the command and answers without running
  it, so a command recorded in `executed` is one whose input the domain
  accepted, and nothing is stored.
*/

const organizationId = "018f0000-0000-7000-8000-0000000f1001";
const projectId = "018f0000-0000-7000-8000-0000000f1002";

const agent: ApiAuthContext = {
  actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000f1003" },
  audience: "api",
  organizationId,
  projectId,
  scopes: new Set(agentScopes),
  laneIds: new Set<string>(),
  authorizationId: "rest-input-limit-authorization",
  credentialId: "rest-input-limit-credential",
  correlationId: "018f0000-0000-7000-8000-0000000f1004",
};

/** Each command `execute` was asked to run, as it was asked. */
const dispatched: string[] = [];
/** The transaction, then the command, for each whose input the domain accepted. */
const executed: string[] = [];

const transactions: TransactionManager = {
  run: async <T>(): Promise<T> => {
    executed.push("transaction");
    return { output: { accepted: true }, events: [] } as T;
  },
};

const bus = new AtomicCommandBus({
  registry: createCoreCommandRegistry(),
  transactions,
  fingerprintSecret: "rest-input-limit-fingerprint-secret",
});

/** A RequestPort that runs bus commands through `bus`, and answers the rest. */
function requestPort(): Pick<RequestPort, "execute" | "query"> {
  return {
    execute: (async (
      name: string,
      input: Record<string, unknown>,
      call: {
        context: ApiAuthContext;
        meta: { idempotencyKey: string; expectedVersion: number };
      },
    ) => {
      dispatched.push(name);
      const transport = findRestCommandTransport(name);
      if (transport?.dispatch.to !== "command-bus") {
        executed.push(name);
        return { accepted: true };
      }
      const result = await bus.execute({
        name: transport.dispatch.commandName,
        input,
        context: call.context as never,
        meta: call.meta,
      });
      executed.push(name);
      return result;
    }) as unknown as RequestPort["execute"],
    query: (async () => ({})) as unknown as RequestPort["query"],
  };
}

const options = (): RestOptions => ({
  authenticateApiBearer: async () => agent,
  rateLimiter: {
    fingerprint: () => "fingerprint",
    enforce: async () => ({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 0,
    }),
  },
  requestPort,
  withProject,
  challenge: () => "Bearer",
});

function post(command: string, body: unknown) {
  return new Request(`https://requestport.test/api/v1/commands/${command}`, {
    method: "POST",
    headers: {
      authorization: "Bearer a-rest-credential",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** The body `send` posts for `input`. */
const bodyOf = (input: Record<string, unknown>) => ({
  input,
  idempotencyKey: "rest-input-limit-0001",
  expectedVersion: 0,
});

async function send(command: string, input: Record<string, unknown>) {
  const response = await handleRestCommand(
    post(command, bodyOf(input)),
    async () => ["commands", command],
    options(),
  );
  return { status: response.status, body: (await response.json()) as unknown };
}

const zeros = (count: number) => Array.from({ length: count }, () => 0);

/** `[[[…[0]…]]]`, its innermost zero at depth `levels`. */
function nested(levels: number): unknown {
  let value: unknown = 0;
  for (let level = 0; level < levels; level += 1) value = [value];
  return value;
}

const workUpdate = (evidence: unknown) => ({
  workSessionId: "018f0000-0000-7000-8000-0000000f1005",
  kind: "progress",
  bodyMd: "Progress.",
  evidence,
});

const artifact = (provenance: unknown) => ({
  requestId: "018f0000-0000-7000-8000-0000000f1006",
  kind: "log",
  externalUrl: "https://example.com/artifact",
  provenance,
});

const answer = (structuredValue: unknown) => ({
  questionId: "018f0000-0000-7000-8000-0000000f1007",
  bodyMd: "Answer.",
  structuredValue,
  sourceChannel: "web",
});

/**
 * Each free-form input at each of its three bounds, and one past it. The
 * byte cases pad one string: `[{"data":"…"}]` is its length and 13,
 * `{"data":"…"}` its length and 11, and a bare string its length and 2.
 */
const freeFormBoundCases = [
  {
    input: "evidence",
    command: "post_work_update",
    bound: "10,000 elements",
    refused: { bound: "elements", maximum: 10_000 },
    at: workUpdate([{ data: zeros(10_000) }]),
    over: workUpdate([{ data: zeros(10_001) }]),
  },
  {
    input: "evidence",
    command: "post_work_update",
    bound: "depth 8",
    refused: { bound: "depth", maximum: 8 },
    at: workUpdate([{ data: nested(8) }]),
    over: workUpdate([{ data: nested(9) }]),
  },
  {
    input: "evidence",
    command: "post_work_update",
    bound: "262,144 bytes",
    refused: { bound: "bytes", maximum: 262_144 },
    at: workUpdate([{ data: "x".repeat(262_144 - 13) }]),
    over: workUpdate([{ data: "x".repeat(262_144 - 12) }]),
  },
  {
    input: "provenance",
    command: "attach_artifact",
    bound: "2,000 elements",
    refused: { bound: "elements", maximum: 2_000 },
    at: artifact({ a: zeros(1_000), b: zeros(1_000) }),
    over: artifact({ a: zeros(1_000), b: zeros(1_001) }),
  },
  {
    input: "provenance",
    command: "attach_artifact",
    bound: "depth 8",
    refused: { bound: "depth", maximum: 8 },
    at: artifact({ data: nested(8) }),
    over: artifact({ data: nested(9) }),
  },
  {
    input: "provenance",
    command: "attach_artifact",
    bound: "65,536 bytes",
    refused: { bound: "bytes", maximum: 65_536 },
    at: artifact({ data: "x".repeat(65_536 - 11) }),
    over: artifact({ data: "x".repeat(65_536 - 10) }),
  },
  {
    input: "structuredValue",
    command: "answer_question",
    bound: "2,000 elements",
    refused: { bound: "elements", maximum: 2_000 },
    at: answer(zeros(2_000)),
    over: answer(zeros(2_001)),
  },
  {
    input: "structuredValue",
    command: "answer_question",
    bound: "depth 8",
    refused: { bound: "depth", maximum: 8 },
    at: answer(nested(8)),
    over: answer(nested(9)),
  },
  {
    input: "structuredValue",
    command: "answer_question",
    bound: "65,536 bytes",
    refused: { bound: "bytes", maximum: 65_536 },
    at: answer("x".repeat(65_536 - 2)),
    over: answer("x".repeat(65_536 - 1)),
  },
] as const;

beforeEach(() => {
  dispatched.length = 0;
  executed.length = 0;
});

describe("the free-form inputs' bounds, on REST (ruling 237 item 3)", () => {
  test.each(freeFormBoundCases)(
    "$command: $input at $bound runs the command",
    async ({ command, at }) => {
      const { status, body } = await send(command, at);
      expect({ status, body }).toEqual({
        status: 200,
        body: { result: { accepted: true } },
      });
      expect(executed).toEqual(["transaction", command]);
    },
  );

  test.each(freeFormBoundCases)(
    "$command: $input past $bound is refused, validation_failed naming $input and the bound, and runs nothing",
    async ({ command, input, refused, over }) => {
      const { status, body } = await send(command, over);
      expect({ status, body }).toEqual({
        status: 422,
        body: {
          error: "validation_failed",
          message: "The request input is invalid.",
          details: { field: input, ...refused },
        },
      });
      expect(executed).toEqual([]);
    },
  );

  test.each(freeFormBoundCases)(
    "$command: the refusal of $input past $bound has the details openapi.json's ErrorDetails describes",
    async ({ command, over }) => {
      const { body } = await send(command, over);
      const details = (body as { details: Record<string, unknown> }).details;
      expect(errorDetailsViolations(details)).toEqual([]);
    },
  );
});

/*
  The route publishes a bound only as the domain's bus names one: one of
  the three bounds with a positive integer `maximum`, together. A
  DomainError carrying anything else keeps it inside.
*/
describe("the REST route publishes a refusal's bound only as the domain names one (ruling 237 item 3)", () => {
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
      const throwing = () =>
        ({
          execute: async () => {
            throw new DomainError(
              "validation_failed",
              "internal wording",
              given,
            );
          },
          query: async () => ({}),
        }) as unknown as ReturnType<RestOptions["requestPort"]>;
      const response = await handleRestCommand(
        post("post_work_update", bodyOf(workUpdate([]))),
        async () => ["commands", "post_work_update"],
        { ...options(), requestPort: throwing },
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "validation_failed",
        message: "The request input is invalid.",
        details: published,
      });
    },
  );
});

/**
 * What `details` breaks in the published `ErrorDetails`, which declares
 * `additionalProperties: false`: a key it does not list, or a value its
 * type, enum, pattern or minimum refuses.
 */
function errorDetailsViolations(details: Record<string, unknown>): string[] {
  const schema = openapi.components.schemas.ErrorDetails as {
    properties: Record<
      string,
      { type: string; enum?: unknown[]; pattern?: string; minimum?: number }
    >;
    additionalProperties: boolean;
  };
  expect(schema.additionalProperties).toBe(false);
  return Object.entries(details).flatMap(([key, value]) => {
    const property = schema.properties[key];
    if (!property) return [`${key}: not in ErrorDetails`];
    const found: string[] = [];
    if (property.type === "string" && typeof value !== "string")
      found.push(`${key}: not a string`);
    if (property.type === "integer" && !Number.isInteger(value))
      found.push(`${key}: not an integer`);
    if (property.enum && !property.enum.includes(value))
      found.push(`${key}: ${String(value)} is not one of ${property.enum}`);
    if (
      property.pattern &&
      !new RegExp(property.pattern, "u").test(String(value))
    )
      found.push(`${key}: does not match ${property.pattern}`);
    if (
      property.minimum !== undefined &&
      typeof value === "number" &&
      value < property.minimum
    )
      found.push(`${key}: below ${property.minimum}`);
    return found;
  });
}

/*
  The REST command route's walk (ruling 237 item 3): `handleRestCommand`
  walks each body with `assertJsonDepth`, whose bound is 17,000 values, so a
  body of more JSON values is refused before its command is dispatched. The
  body is `{ input, idempotencyKey, expectedVersion }`, and the walk counts
  the body, its three members and every value in `input`.
*/

/** The most JSON values one REST command body may hold: the route's bound. */
const ROUTE_VALUES = 17_000;

/** Every value the route's walk visits in `value`, the root included. */
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

describe(`the REST command route's walk admits ${ROUTE_VALUES} JSON values in a body (ruling 237 item 3)`, () => {
  /** post_work_update whose body holds exactly `total` values. */
  const workUpdateOf = (total: number) =>
    workUpdate([
      { data: zeros(total - values(bodyOf(workUpdate([{ data: [] }])))) },
    ]);

  test("the route's bound is assertJsonDepth's", () => {
    const atBound = bodyOf(workUpdateOf(ROUTE_VALUES));
    expect(values(atBound)).toBe(ROUTE_VALUES);
    expect(() => assertJsonDepth(atBound)).not.toThrow();
    expect(() =>
      assertJsonDepth(bodyOf(workUpdateOf(ROUTE_VALUES + 1))),
    ).toThrow("JSON input is too complex");
  });

  test(`a body of ${ROUTE_VALUES} values reaches its command, where the domain refuses evidence past its bound`, async () => {
    const { status, body } = await send(
      "post_work_update",
      workUpdateOf(ROUTE_VALUES),
    );
    expect({ status, body }).toEqual({
      status: 422,
      body: {
        error: "validation_failed",
        message: "The request input is invalid.",
        details: { field: "evidence", bound: "elements", maximum: 10_000 },
      },
    });
    expect(dispatched).toEqual(["post_work_update"]);
  });

  test("one value more is refused by the walk, and nothing is dispatched", async () => {
    const { status, body } = await send(
      "post_work_update",
      workUpdateOf(ROUTE_VALUES + 1),
    );
    expect({ status, body }).toEqual({
      status: 422,
      body: {
        error: "validation_failed",
        message: "The request input is invalid.",
        details: {},
      },
    });
    expect(dispatched).toEqual([]);
    expect(executed).toEqual([]);
  });
});

/*
  The largest body each REST command can carry, worked out from the schemas
  the REST API publishes (`openapi.json`, which `scripts/generate-openapi.mjs`
  writes from the domain's own and its test keeps current), as packages/mcp's
  `server.tool-input-limit.test.ts` works out each MCP tool's (ruling 237
  item 3).

  For each command, the walk builds the largest input its published schema
  bounds: every property, optional ones too; every array at its `maxItems`
  (an array without one fails the case); for `anyOf` or `oneOf`, the branch
  with the most elements; and every record at the key count the domain's refine
  allows, which JSON Schema does not show, so `RECORD_KEYS` names each by its
  path (a record not named there fails the case). Each free-form JSON value
  gets the budget `FREE_FORM` names for its path, the most elements the
  domain lets that input's free-form values hold in all, put in the first
  value at the path as an array of zeros, the rest scalars (a free-form value
  not named there fails the case).

  Each figure is an upper bound on what the command accepts: the domain's
  refinements that JSON Schema does not show (formats, distinct values,
  rules across fields) can only refuse more. The largest, post_work_update's,
  is sent through the route over the domain's parse and accepted, so that
  figure is exact. The last two cases show each count `RECORD_KEYS` and
  `FREE_FORM` name is the domain's own: one more is refused, naming its field.
*/

/** The largest body a REST command can carry, in the walk's values: post_work_update's. */
const LARGEST_BODY = 16_509;

type Schema = Record<string, unknown>;

const openapi = JSON.parse(
  readFileSync(
    new URL(
      "../../../apps/web/src/app/docs/api/generated/openapi.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  paths: Record<string, { post?: Schema }>;
  components: { schemas: Record<string, Schema> };
};

/** Each record's key count, by the path the walk names it with: the domain's refines, and the field each refusal names. */
const RECORD_KEYS: Record<string, { keys: number; field: string }> = {
  "attach_artifact.provenance": { keys: 64, field: "provenance" },
  "post_work_update.evidence[]": { keys: 64, field: "evidence.0" },
  "register_agent_installation.capabilities": {
    keys: 128,
    field: "capabilities",
  },
  "register_machine_workspace.safeCapabilities": {
    keys: 128,
    field: "safeCapabilities",
  },
  "register_machine_workspace.privateTelemetry.toolVersions": {
    keys: 128,
    field: "privateTelemetry.toolVersions",
  },
};

/** Each free-form value's budget, by the path the walk names it with: the domain's bounds, and the field each refusal names. */
const FREE_FORM: Record<string, { elements: number; field: string }> = {
  "post_work_update.evidence[]{}": { elements: 10_000, field: "evidence" },
  "attach_artifact.provenance{}": { elements: 2_000, field: "provenance" },
  "answer_question.structuredValue": {
    elements: 2_000,
    field: "structuredValue",
  },
};

/** A value each string schema the commands publish accepts; a new pattern fails here. */
function stringFor(schema: Schema, path: string): string {
  if (Array.isArray(schema.enum)) return schema.enum[0] as string;
  if (schema.format === "uuid") return projectId;
  if (schema.format === "date-time") return "2026-10-21T00:00:00Z";
  const patterns: Record<string, string> = {
    "^[0-9a-f]{7,64}$": "abcdef0",
    "^[0-9a-f]{64}$": "0".repeat(64),
    "^[a-z][a-z0-9_.:-]{0,63}$": "a",
    "^[a-z0-9][a-z0-9-]{0,62}$": "a",
    "^[UW][A-Z0-9]{4,}$": "U0000",
    "^C[A-Z0-9]{4,}$": "C0000",
  };
  if (typeof schema.pattern === "string") {
    const value = patterns[schema.pattern];
    if (value === undefined)
      throw new Error(`${path}: no value for pattern ${schema.pattern}`);
    return value;
  }
  return "x".repeat(Math.max(1, (schema.minLength as number | undefined) ?? 1));
}

/** Whether `$ref` names a recursive definition of the kind zod writes for `z.json()`. */
function isFreeFormJson(ref: string): boolean {
  const definition =
    openapi.components.schemas[ref.replace("#/components/schemas/", "")];
  return (
    Array.isArray(definition?.anyOf) &&
    (definition.anyOf as Schema[]).some(
      (branch) =>
        branch.type === "array" && (branch.items as Schema)?.$ref === ref,
    )
  );
}

/** The SDK's count, which the budgets are in: every array element and every own object key, at every level. */
const elements = (value: unknown) => values(value) - 1;

type Walk = {
  budgets: Map<string, number>;
  recordKeys: Record<string, number>;
};

function largestInput(schema: Schema, path: string, walk: Walk): unknown {
  if (typeof schema.$ref === "string") {
    if (isFreeFormJson(schema.$ref)) {
      const left = walk.budgets.get(path);
      if (left === undefined)
        throw new Error(`${path}: a free-form value whose budget is not named`);
      if (left === 0) return "v";
      walk.budgets.set(path, 0);
      return zeros(left);
    }
    const definition =
      openapi.components.schemas[
        schema.$ref.replace("#/components/schemas/", "")
      ];
    if (!definition) throw new Error(`${path}: ${schema.$ref} is not defined`);
    return largestInput(definition, path, walk);
  }
  if ("const" in schema) return schema.const;
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) {
    let best: unknown;
    let bestElements = -1;
    let bestBudgets = walk.budgets;
    for (const branch of branches as Schema[]) {
      if (branch.type === "null") continue;
      const budgets = new Map(walk.budgets);
      const value = largestInput(branch, path, { ...walk, budgets });
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
        value[key] = largestInput(child, `${path}.${key}`, walk);
      const extra = schema.additionalProperties;
      if (extra !== undefined && extra !== false) {
        const keys = walk.recordKeys[path] ?? RECORD_KEYS[path]?.keys;
        if (keys === undefined)
          throw new Error(`${path}: a record whose key count is not named`);
        for (let index = 0; index < keys; index += 1)
          value[`k${index}`] = largestInput(extra as Schema, `${path}{}`, walk);
      }
      return value;
    }
    case "array":
      if (typeof schema.maxItems !== "number")
        throw new Error(`${path}: an array with no maxItems`);
      return Array.from({ length: schema.maxItems }, () =>
        largestInput(schema.items as Schema, `${path}[]`, walk),
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

/** Every command the API publishes, by name, with its envelope's schema. */
const commands = Object.entries(openapi.paths).flatMap(([path, item]) =>
  path.startsWith("/api/v1/commands/") && item.post
    ? [
        {
          name: path.slice("/api/v1/commands/".length),
          envelope: (
            (item.post.requestBody as Schema).content as Record<
              string,
              { schema: Schema }
            >
          )["application/json"]?.schema as Schema,
        },
      ]
    : [],
);

/**
 * `name`'s largest input. `recordKeys` overrides a record's key count by
 * path (the third case's one more), and `budgets` a free-form path's budget
 * (the fourth case's one more).
 */
function largestInputOf(
  name: string,
  recordKeys: Record<string, number> = {},
  budgets: Record<string, number> = {},
) {
  const command = commands.find((published) => published.name === name);
  if (!command) throw new Error(`${name}: not published`);
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
    (command.envelope.properties as Record<string, Schema>).input as Schema,
    name,
    walk,
  ) as Record<string, unknown>;
}

describe(`the largest body a REST command can carry is ${LARGEST_BODY} values, post_work_update's, under the route's bound (ruling 237 item 3)`, () => {
  test("every command the registry exposes over REST is published, and walked", () => {
    expect(new Set(commands.map((command) => command.name))).toEqual(
      new Set(restCommandTransports.map((transport) => transport.name)),
    );
    expect(commands).toHaveLength(71);
  });

  test("each command's largest body fits the route's bounds; the largest is post_work_update's, and the domain accepts it", async () => {
    const sizes = commands.map(({ name }) => {
      const body = bodyOf(largestInputOf(name));
      expect(
        new TextEncoder().encode(JSON.stringify(body)).byteLength,
      ).toBeLessThanOrEqual(REST_MAX_BODY);
      return { name, values: values(body) };
    });
    sizes.sort((a, b) => b.values - a.values);
    expect(sizes[0]).toEqual({
      name: "post_work_update",
      values: LARGEST_BODY,
    });
    expect(sizes[1]?.values).toBeLessThan(LARGEST_BODY);
    expect(LARGEST_BODY).toBeLessThanOrEqual(ROUTE_VALUES);
    const { status, body } = await send(
      "post_work_update",
      largestInputOf("post_work_update"),
    );
    expect({ status, body }).toEqual({
      status: 200,
      body: { result: { accepted: true } },
    });
    expect(executed).toEqual(["transaction", "post_work_update"]);
  });

  test.each(Object.entries(RECORD_KEYS))(
    "%s: one key more than its count is refused by the domain",
    async (path, { keys, field }) => {
      const name = path.split(".")[0] as string;
      expect((await send(name, largestInputOf(name))).status).toBe(200);
      executed.length = 0;
      const { status, body } = await send(
        name,
        largestInputOf(name, { [path]: keys + 1 }),
      );
      expect({ status, body }).toEqual({
        status: 422,
        body: {
          error: "validation_failed",
          message: "The request input is invalid.",
          details: { field },
        },
      });
      expect(executed).toEqual([]);
    },
  );

  test.each(Object.entries(FREE_FORM))(
    "%s: one element more than its budget is refused by the domain, naming the elements bound",
    async (path, { elements: budget, field }) => {
      const name = path.split(".")[0] as string;
      expect((await send(name, largestInputOf(name))).status).toBe(200);
      executed.length = 0;
      const { status, body } = await send(
        name,
        largestInputOf(name, {}, { [path]: budget + 1 }),
      );
      expect({ status, body }).toEqual({
        status: 422,
        body: {
          error: "validation_failed",
          message: "The request input is invalid.",
          details: { field, bound: "elements", maximum: budget },
        },
      });
      expect(executed).toEqual([]);
    },
  );
});
