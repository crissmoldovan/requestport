import { DomainError, type DomainErrorCode } from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ZodError } from "zod";

import { reauthorizeWithResourceDescription } from "../../../../lib/security/bearer-challenge.js";
import { RequestTooLargeError } from "../../../../lib/security/input-limits.js";
import {
  agentContext,
  restClient,
  signInAs,
} from "../../../../test/api-v1/agent-client.js";
import {
  apiV1,
  resetApiV1Fakes,
} from "../../../../test/api-v1/fake-database.js";

vi.mock(
  "@requestport/db",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeDatabaseModule,
);
vi.mock(
  "@requestport/auth/server",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeAuthServerModule,
);
vi.mock(
  "@requestport/config/server",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeServerConfigModule,
);
vi.mock(
  "../../../../lib/observability.js",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeObservabilityModule,
);
vi.mock(
  "../../../../lib/trigger-client.js",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeTriggerClientModule,
);
// The web root runs, and the web's RequestPort is composed over the storage
// the wiring answers here (`server-web-request-port.ts`): the routes, the
// handlers and the rate limiter reach the faked package through it (Plan 13,
// G.3, G.6; ruling 140).
vi.mock(
  "@requestport/db/wiring",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js")).fakeWiringModule,
);

const route = await import("./route.js");
const api = restClient(route);

beforeEach(() => {
  resetApiV1Fakes();
});

const resourceMetadata =
  "https://requestport.test/.well-known/oauth-protected-resource/api/v1";

/** Both verbs share `responseError`; each case is run through each. */
const verbs = {
  GET: () => api.get(["whoami"]),
  POST: () => api.command("post_message", { input: {} }),
} as const;

/**
 * `responseError`'s mapping from a thrown value to an HTTP answer, Plan 13
 * track B1. The table is typed as a `Record` over `DomainErrorCode`, so a code
 * added to the domain without a decision about its status fails the typecheck
 * here rather than silently becoming a 409.
 */
const domainErrorAnswers: Record<
  DomainErrorCode,
  { status: number; message: string }
> = {
  unauthenticated: {
    status: 401,
    message: "A valid agent credential is required.",
  },
  forbidden: {
    status: 403,
    message: "The credential is not permitted to perform this operation.",
  },
  not_found: { status: 404, message: "The requested resource was not found." },
  validation_failed: { status: 422, message: "The request input is invalid." },
  configuration_error: {
    status: 503,
    message: "RequestPort is temporarily unavailable.",
  },
  rate_limited: { status: 429, message: "Too many requests. Retry later." },
  conflict: {
    status: 409,
    message: "The requested operation conflicts with current state.",
  },
  idempotency_conflict: {
    status: 409,
    message: "The idempotency key was already used with different input.",
  },
  version_conflict: {
    status: 409,
    message: "The resource changed. Reload it and retry.",
  },
  route_denied: {
    status: 409,
    message: "The current routing policy denies this request.",
  },
  invalid_state: {
    status: 409,
    message: "The requested resource is unavailable from its current state.",
  },
  invalid_transition: {
    status: 409,
    message: "The requested state transition is unavailable.",
  },
  already_answered: {
    status: 409,
    message: "That question already has a canonical answer.",
  },
};

describe("responseError: DomainError codes", () => {
  for (const [verb, call] of Object.entries(verbs)) {
    test.each(
      Object.entries(domainErrorAnswers).map(
        ([code, answer]) => [code, answer.status, answer.message] as const,
      ),
    )(
      `${verb}: %s answers %i with its fixed public message`,
      async (code, status, message) => {
        apiV1.authenticate.mockRejectedValue(
          new DomainError(
            code as DomainErrorCode,
            "internal wording, never sent",
            {
              secretDetail: "never sent",
            },
          ),
        );

        const response = await call();

        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.json()).resolves.toEqual({
          error: code,
          message,
          details: {},
        });
        expect(response.headers.get("www-authenticate")).toBe(
          status === 401
            ? `Bearer resource_metadata="${resourceMetadata}"`
            : null,
        );
        expect(response.headers.get("retry-after")).toBeNull();
      },
    );
  }
});

describe("responseError: what survives into details", () => {
  test.each([
    ["a field name", { field: "input.title" }, { field: "input.title" }],
    ["a field name with a space", { field: "input title" }, {}],
    ["an over-long field name", { field: "f".repeat(129) }, {}],
    ["a non-string field", { field: 7 }, {}],
    ["a scope", { scope: "request:triage" }, {}],
    ["a current version", { currentVersion: 4 }, {}],
    [
      "a whole retry delay",
      { retryAfterSeconds: 30 },
      { retryAfterSeconds: 30 },
    ],
    [
      "a fractional retry delay",
      { retryAfterSeconds: 2.1 },
      { retryAfterSeconds: 3 },
    ],
    [
      "a sub-second retry delay",
      { retryAfterSeconds: 0.2 },
      { retryAfterSeconds: 1 },
    ],
    [
      "an infinite retry delay",
      { retryAfterSeconds: Number.POSITIVE_INFINITY },
      {},
    ],
    ["a string retry delay", { retryAfterSeconds: "30" }, {}],
  ])("%s", async (_label, details, expected) => {
    apiV1.authenticate.mockRejectedValue(
      new DomainError("conflict", "internal", details),
    );

    const response = await api.get(["whoami"]);

    const body = (await response.json()) as { details: object };
    expect(body.details).toEqual(expected);
  });
});

describe("responseError: rate limiting", () => {
  test("a refusal from the real limiter answers 429 with Retry-After", async () => {
    signInAs(agentContext());
    apiV1.rateLimitConsume.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 17,
    });

    const response = await api.get(["whoami"]);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    await expect(response.json()).resolves.toEqual({
      error: "rate_limited",
      message: "Too many requests. Retry later.",
      details: { retryAfterSeconds: 17 },
    });
    expect(apiV1.agentQueries.getAgentPolicy).not.toHaveBeenCalled();
  });

  /**
   * Characterised, not endorsed: the body rounds the delay up to a whole
   * second of at least one, but the header repeats the raw number. RFC 9110
   * allows only whole seconds in `Retry-After`. Unreachable today — the
   * limiter only ever reports whole seconds of at least one — so recorded
   * rather than fixed. The same expression is copied, not shared, into
   * `/mcp`, `/api/auth`, the imports route, Slack interactions and the Resend
   * webhook, so fixing this copy alone would split them.
   */
  test("a fractional delay is a whole second in the body and the raw number in the header", async () => {
    apiV1.authenticate.mockRejectedValue(
      new DomainError("rate_limited", "internal", { retryAfterSeconds: 0.4 }),
    );

    const response = await api.get(["whoami"]);

    expect(response.headers.get("retry-after")).toBe("0.4");
    await expect(response.json()).resolves.toMatchObject({
      details: { retryAfterSeconds: 1 },
    });
  });

  test("a rate_limited refusal with no delay sends no Retry-After", async () => {
    apiV1.authenticate.mockRejectedValue(
      new DomainError("rate_limited", "internal"),
    );

    const response = await api.get(["whoami"]);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeNull();
  });
});

describe("responseError: the re-authorization advice", () => {
  test("a 401 for a credential this resource cannot verify says how to recover", async () => {
    apiV1.authenticate.mockRejectedValue(
      new DomainError("unauthenticated", "opaque token", {
        reauthorizeWithResource: true,
      }),
    );

    const response = await api.command("post_message", { input: {} });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="${reauthorizeWithResourceDescription}", resource_metadata="${resourceMetadata}"`,
    );
    await expect(response.json()).resolves.toEqual({
      error: "unauthenticated",
      message: reauthorizeWithResourceDescription,
      details: {},
    });
  });

  /**
   * Characterised: the body's advice follows the detail whatever the code, but
   * the challenge header is only ever sent with a 401. Nothing raises the
   * detail on another code today.
   */
  test("the advice replaces the message on any code, and the challenge stays 401-only", async () => {
    apiV1.authenticate.mockRejectedValue(
      new DomainError("forbidden", "internal", {
        reauthorizeWithResource: true,
      }),
    );

    const response = await api.get(["whoami"]);

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      message: reauthorizeWithResourceDescription,
    });
  });
});

describe("responseError: everything that is not a DomainError", () => {
  test.each([
    [
      "a ZodError",
      new ZodError([]),
      422,
      { error: "validation_failed", message: "API command input is invalid" },
    ],
    [
      "a RequestTooLargeError",
      new RequestTooLargeError(),
      413,
      { error: "request_too_large", message: "API request body is too large" },
    ],
    [
      "an Error",
      new Error("database is on fire"),
      500,
      {
        error: "unexpected_error",
        message: "The RequestPort operation failed.",
      },
    ],
    [
      "a thrown string",
      "database is on fire",
      500,
      {
        error: "unexpected_error",
        message: "The RequestPort operation failed.",
      },
    ],
  ] as const)(
    "%s answers %i, with no details and no challenge",
    async (_label, thrown, status, body) => {
      for (const call of Object.values(verbs)) {
        apiV1.authenticate.mockRejectedValue(thrown);

        const response = await call();

        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("www-authenticate")).toBeNull();
        await expect(response.json()).resolves.toEqual(body);
      }
    },
  );
});
