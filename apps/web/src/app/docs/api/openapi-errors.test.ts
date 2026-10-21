import { DomainError, type DomainErrorCode } from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ZodError } from "zod";

import document from "./generated/openapi.json";

/**
 * The error answers the committed OpenAPI document gives, held to what the
 * `/api/v1` route really answers.
 *
 * `scripts/generate-openapi.mjs` restates `responseError` as data, because the
 * transport metadata records no errors; this runs the route itself and checks
 * each answer against the document: its status is documented for the
 * operation, its `error` code is in that status's enum, and its body and
 * headers conform to that response. Nothing past authentication runs for the
 * thrown cases — the credential check is made to throw — so no database, bus
 * or limiter is reached.
 */

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
}));

vi.mock("@requestport/auth/server", () => ({
  authenticateAgentBearer: mocks.authenticate,
  authenticateApiBearer: (request: Request) =>
    mocks.authenticate(request, "api"),
}));
vi.mock("@requestport/config/server", () => ({
  serverEnv: {
    BETTER_AUTH_URL: "https://requestport.example.invalid",
    BETTER_AUTH_SECRET: "openapi-errors-test-signing-material",
  },
}));
vi.mock("@requestport/db", () => ({
  createAgentQueryRepository: () => ({}),
  createProjectRegistrationRepository: () => ({}),
}));
vi.mock("../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "openapi-errors-test",
}));

const route = await import("../../api/v1/[[...path]]/route.js");
const { RequestTooLargeError } = await import(
  "../../../lib/security/input-limits.js"
);

type JsonSchema = {
  $ref?: string;
  type?: string;
  enum?: readonly unknown[];
  pattern?: string;
  minimum?: number;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
};

type DocumentedResponse = {
  $ref?: string;
  headers?: Record<string, unknown>;
  content?: Record<string, { schema: JsonSchema }>;
};

/** Follows one local reference inside the committed document. */
function resolveReference<T>(reference: string): T {
  let target: unknown = document;
  for (const segment of reference.replace(/^#\//u, "").split("/")) {
    target = (target as Record<string, unknown>)[segment];
    if (target === undefined) throw new Error(`${reference} does not resolve`);
  }
  return target as T;
}

/**
 * What the body breaks in `schema`, for the few keywords the error responses
 * use. An unknown keyword fails, so a richer schema cannot pass unread.
 */
function violations(value: unknown, schema: JsonSchema, at = "body"): string[] {
  if (schema.$ref) return violations(value, resolveReference(schema.$ref), at);
  const known = new Set([
    "type",
    "enum",
    "pattern",
    "minimum",
    "properties",
    "required",
    "additionalProperties",
  ]);
  const unknown = Object.keys(schema).filter((keyword) => !known.has(keyword));
  if (unknown.length > 0) return [`${at}: unread keywords ${unknown}`];

  const found: string[] = [];
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return [`${at}: not an object`];
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) found.push(`${at}.${key}: missing`);
    }
    for (const [key, child] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (property) found.push(...violations(child, property, `${at}.${key}`));
      else if (schema.additionalProperties === false) {
        found.push(`${at}.${key}: not in the schema`);
      }
    }
  }
  if (schema.type === "string" && typeof value !== "string") {
    found.push(`${at}: not a string`);
  }
  if (
    schema.type === "integer" &&
    !(typeof value === "number" && Number.isInteger(value))
  ) {
    found.push(`${at}: not an integer`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    found.push(`${at}: ${String(value)} is not one of ${schema.enum}`);
  }
  if (
    schema.pattern &&
    typeof value === "string" &&
    !new RegExp(schema.pattern, "u").test(value)
  ) {
    found.push(`${at}: does not match ${schema.pattern}`);
  }
  if (
    schema.minimum !== undefined &&
    typeof value === "number" &&
    value < schema.minimum
  ) {
    found.push(`${at}: below ${schema.minimum}`);
  }
  return found;
}

type Call = {
  path: string;
  method: "get" | "post";
  send: () => Promise<Response>;
};

const whoami: Call = {
  path: "/api/v1/whoami",
  method: "get",
  send: () =>
    route.GET(
      new Request("https://requestport.example.invalid/api/v1/whoami"),
      {
        params: Promise.resolve({ path: ["whoami"] }),
      },
    ),
};

function postMessage(init: { contentType?: string; body?: string } = {}): Call {
  return {
    path: "/api/v1/commands/post_message",
    method: "post",
    send: () =>
      route.POST(
        new Request(
          "https://requestport.example.invalid/api/v1/commands/post_message",
          {
            method: "POST",
            headers: {
              "content-type": init.contentType ?? "application/json",
            },
            body:
              init.body ??
              JSON.stringify({
                idempotencyKey: "openapi-errors-test-0001",
                expectedVersion: 0,
                input: {},
              }),
          },
        ),
        { params: Promise.resolve({ path: ["commands", "post_message"] }) },
      ),
  };
}

/** Calls the route and checks its answer against the document. */
async function answersAsDocumented(call: Call) {
  const response = await call.send();
  const paths = document.paths as Record<
    string,
    Record<string, { responses: Record<string, DocumentedResponse> }>
  >;
  const operation = paths[call.path]?.[call.method];
  expect(operation, `${call.method} ${call.path}`).toBeDefined();
  const listed = operation?.responses[String(response.status)];
  expect(
    listed,
    `${call.method} ${call.path} answered ${response.status}, which the document does not list`,
  ).toBeDefined();
  const documented = listed?.$ref
    ? resolveReference<DocumentedResponse>(listed.$ref)
    : (listed as DocumentedResponse);
  const schema = documented.content?.["application/json"]?.schema;
  expect(schema, `${response.status} has no documented body`).toBeDefined();

  const body: unknown = await response.json();
  expect(violations(body, schema as JsonSchema)).toEqual([]);
  for (const header of ["www-authenticate", "retry-after"]) {
    if (response.headers.has(header)) {
      expect(
        Object.keys(documented.headers ?? {}).map((name) => name.toLowerCase()),
        `${response.status} sends ${header}, which the document does not list`,
      ).toContain(header);
    }
  }
  return { status: response.status, body: body as { error: string } };
}

/**
 * Typed over `DomainErrorCode`, so a code added to the domain fails the
 * typecheck here until someone decides it is documented.
 */
const everyDomainErrorCode: Record<DomainErrorCode, true> = {
  unauthenticated: true,
  forbidden: true,
  not_found: true,
  conflict: true,
  validation_failed: true,
  idempotency_conflict: true,
  version_conflict: true,
  route_denied: true,
  invalid_state: true,
  invalid_transition: true,
  already_answered: true,
  rate_limited: true,
  configuration_error: true,
};

const signedIn = {
  actor: { type: "agent", id: "openapi-errors-test-agent" },
  authorizationId: "openapi-errors-test-authorization",
  organizationId: "018f0000-0000-7000-8000-0000000000e1",
  projectId: "018f0000-0000-7000-8000-0000000000e2",
  laneIds: new Set<string>(),
  scopes: new Set<string>(),
  audience: "api",
};

beforeEach(() => {
  mocks.authenticate.mockReset();
});

describe("the documented error answers, against the route", () => {
  test.each(Object.keys(everyDomainErrorCode) as DomainErrorCode[])(
    "a DomainError %s is answered as the document says, on GET and POST",
    async (code) => {
      for (const call of [whoami, postMessage()]) {
        mocks.authenticate.mockRejectedValue(
          new DomainError(code, "internal wording", {
            field: "input.title",
            retryAfterSeconds: 2.5,
            internal: "never sent",
          }),
        );

        const answer = await answersAsDocumented(call);

        expect(answer.body.error).toBe(code);
      }
    },
  );

  test("the document names every DomainError code and nothing the route cannot send", () => {
    const schemas = Object.values(
      document.components.responses as Record<string, DocumentedResponse>,
    ).map((response) => response.content?.["application/json"]?.schema);
    const documented = schemas.flatMap(
      (schema) => (schema?.properties?.error?.enum ?? []) as string[],
    );

    expect(documented.toSorted()).toEqual(
      [
        ...Object.keys(everyDomainErrorCode),
        // Built by the route itself, not from a DomainError.
        "request_too_large",
        "unsupported_media_type",
        "unexpected_error",
      ].toSorted(),
    );
  });

  test.each([
    ["a ZodError", () => new ZodError([]), 422, "validation_failed"],
    ["an Error", () => new Error("internal"), 500, "unexpected_error"],
    [
      "a RequestTooLargeError",
      () => new RequestTooLargeError(),
      413,
      "request_too_large",
    ],
  ] as const)(
    "%s is answered as the document says",
    async (_label, thrown, status, code) => {
      mocks.authenticate.mockRejectedValue(thrown());

      const answer = await answersAsDocumented(postMessage());

      expect(answer).toMatchObject({ status, body: { error: code } });
    },
  );

  test("a body over the size limit is answered 413 as the document says", async () => {
    mocks.authenticate.mockResolvedValue(signedIn);

    const answer = await answersAsDocumented(
      postMessage({ body: "x".repeat(524_289) }),
    );

    expect(answer).toMatchObject({
      status: 413,
      body: { error: "request_too_large" },
    });
  });

  test("a request that is not Content-Type: application/json is answered 415 as the document says", async () => {
    mocks.authenticate.mockResolvedValue(signedIn);

    const answer = await answersAsDocumented(
      postMessage({ contentType: "text/plain" }),
    );

    expect(answer).toMatchObject({
      status: 415,
      body: { error: "unsupported_media_type" },
    });
  });

  test("an invalid envelope is answered 422 as the document says", async () => {
    mocks.authenticate.mockResolvedValue(signedIn);

    const answer = await answersAsDocumented(
      postMessage({ body: JSON.stringify({ input: {} }) }),
    );

    expect(answer).toMatchObject({
      status: 422,
      body: { error: "validation_failed" },
    });
  });
});
