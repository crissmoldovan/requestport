import { DomainError } from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  agentContext,
  ids,
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
const { coreCommandBus } = await import(
  "../../../../lib/server-core-commands.js"
);
const { rateLimitFingerprint } = await import(
  "../../../../lib/security/rate-limit.js"
);
const api = restClient(route);

const maxBodyBytes = 524_288;
const json = { "content-type": "application/json" };
const validEnvelope = JSON.stringify({
  input: { requestId: ids.request, bodyMd: "Hello." },
  idempotencyKey: "b1-idempotency-key-0001",
  expectedVersion: 0,
});

beforeEach(() => {
  resetApiV1Fakes();
  vi.restoreAllMocks();
});

function streamOf(bytes: number) {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      const next = chunk.subarray(0, Math.min(chunk.length, bytes - sent));
      sent += next.length;
      controller.enqueue(next);
    },
  });
}

/**
 * The refusals `/api/v1` makes before anything is dispatched, and the order it
 * makes them in, Plan 13 track B1. Order is the part a status code alone does
 * not show, so each case also watches what was — and was not — reached.
 */
describe("before anything else: authentication, then the limiter", () => {
  /**
   * Authentication comes before the path is looked at, so an unauthenticated
   * caller learns nothing about which paths exist: a real path and an unknown
   * one answer the same 401.
   */
  test.each([
    ["GET", ["whoami"], undefined],
    ["GET", ["no-such-resource"], undefined],
    ["POST", ["commands", "post_message"], "text/plain"],
    ["POST", ["no-such-resource"], "application/json"],
    ["POST", ["commands", "no_such_command"], "application/json"],
  ] as const)(
    "%s /%s authenticates for the api audience first, and an unauthenticated caller costs the limiter nothing",
    async (verb, path, contentType) => {
      apiV1.authenticate.mockRejectedValue(
        new DomainError("unauthenticated", "no credential"),
      );

      const response =
        verb === "GET"
          ? await api.get(path)
          : await api.postRaw(path, {
              body:
                contentType === "text/plain" ? "not even json" : validEnvelope,
              headers: { "content-type": contentType ?? "application/json" },
            });

      expect(response.status).toBe(401);
      expect(apiV1.authenticate).toHaveBeenCalledWith(
        expect.any(Request),
        "api",
      );
      expect(apiV1.rateLimitConsume).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["GET", "token", 60],
    ["POST", "mutation", 120],
  ] as const)(
    "%s is charged to the %s class, per authorization and agent",
    async (verb, endpointClass, limit) => {
      const context = signInAs(agentContext());

      if (verb === "GET") await api.get(["no-such-resource"]);
      else await api.command("no_such_command", {});

      expect(apiV1.rateLimitConsume).toHaveBeenCalledWith({
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
        endpointClass,
        principalFingerprint: rateLimitFingerprint(
          context.authorizationId,
          context.actor.id,
        ),
        limit,
        windowSeconds: 60,
        cost: undefined,
      });
    },
  );

  test("a rate-limited POST is refused before its content type is looked at", async () => {
    signInAs(agentContext());
    apiV1.rateLimitConsume.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 5,
    });

    const response = await api.postRaw(["commands", "post_message"], {
      body: "plain",
      headers: { "content-type": "text/plain" },
    });

    expect(response.status).toBe(429);
  });
});

describe("POST: the content type, then the path, then the body", () => {
  test.each([
    ["missing", undefined],
    ["text/plain", "text/plain"],
    ["a JSON-suffixed type", "application/merge-patch+json"],
    ["form data", "application/x-www-form-urlencoded"],
  ])(
    "a %s content type is refused 415, even for a command that does not exist",
    async (_label, contentType) => {
      signInAs(agentContext());
      const execute = vi.spyOn(coreCommandBus, "execute");

      for (const name of ["post_message", "no_such_command"]) {
        const response = await api.postRaw(["commands", name], {
          body: validEnvelope,
          headers: contentType ? { "content-type": contentType } : {},
        });

        expect(response.status).toBe(415);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.json()).resolves.toEqual({
          error: "unsupported_media_type",
          message: "API commands require application/json.",
        });
      }
      expect(execute).not.toHaveBeenCalled();
    },
  );

  test.each([
    "application/json; charset=utf-8",
    "Application/JSON",
    "  application/json  ;charset=utf-8",
  ])("%s is accepted as JSON", async (contentType) => {
    signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");

    await api.postRaw(["commands", "post_message"], {
      body: validEnvelope,
      headers: { "content-type": contentType },
    });

    expect(execute).toHaveBeenCalledOnce();
  });

  test("an unknown command is refused 404 before its body is read, however large", async () => {
    signInAs(agentContext());

    const response = await api.postRaw(["commands", "no_such_command"], {
      body: "x".repeat(maxBodyBytes + 1),
      headers: json,
    });

    expect(response.status).toBe(404);
  });

  test("a declared length over 512 KiB is refused 413 without reading the body", async () => {
    signInAs(agentContext());

    const response = await api.postRaw(["commands", "post_message"], {
      body: validEnvelope,
      headers: { ...json, "content-length": String(maxBodyBytes + 1) },
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "request_too_large",
      message: "API request body is too large",
    });
  });

  test("an undeclared body that streams past 512 KiB is refused 413", async () => {
    signInAs(agentContext());

    const response = await api.postRaw(["commands", "post_message"], {
      body: streamOf(maxBodyBytes + 1),
      headers: json,
    });

    expect(response.status).toBe(413);
  });

  test("a body of exactly 512 KiB is read, and judged on its content", async () => {
    signInAs(agentContext());

    const response = await api.postRaw(["commands", "post_message"], {
      body: streamOf(maxBodyBytes),
      headers: json,
    });

    // All spaces: read in full, then refused as JSON, not as size.
    expect(response.status).toBe(422);
  });

  test.each([
    ["a malformed content length", { "content-length": "lots" }],
    ["a negative content length", { "content-length": "-1" }],
  ])("%s is refused 422", async (_label, headers) => {
    signInAs(agentContext());

    const response = await api.postRaw(["commands", "post_message"], {
      body: validEnvelope,
      headers: { ...json, ...headers },
    });

    expect(response.status).toBe(422);
  });
});

describe("POST: the envelope", () => {
  async function expectDomain422(response: Response) {
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "validation_failed",
      message: "The request input is invalid.",
      details: {},
    });
  }

  async function expectSchema422(response: Response) {
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "validation_failed",
      message: "API command input is invalid",
    });
  }

  test.each([
    ["invalid JSON", "{not json"],
    ["an empty body", ""],
    ["an array", "[]"],
    ["null", "null"],
    ["a number", "42"],
  ])(
    "%s is refused as a DomainError, with no dispatch",
    async (_label, body) => {
      signInAs(agentContext());
      const execute = vi.spyOn(coreCommandBus, "execute");

      await expectDomain422(
        await api.postRaw(["commands", "post_message"], {
          body,
          headers: json,
        }),
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  /**
   * The UTF-8 and depth guards, each placed inside an otherwise valid envelope,
   * so that no later check (JSON syntax, the envelope's shape) could refuse the
   * body in their stead. Without the fatal decoder the byte becomes U+FFFD and
   * the message is dispatched; without the depth guard the envelope is.
   */
  function envelopeBytes(bodyMd: Uint8Array, extra = "") {
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `{"input":{"requestId":"${ids.request}","bodyMd":"`,
    );
    const tail = encoder.encode(
      `"${extra}},"idempotencyKey":"b1-idempotency-key-0001","expectedVersion":0}`,
    );
    const bytes = new Uint8Array(head.length + bodyMd.length + tail.length);
    bytes.set(head, 0);
    bytes.set(bodyMd, head.length);
    bytes.set(tail, head.length + bodyMd.length);
    return bytes;
  }

  /** `input.deep` holding `levels` nested arrays: the innermost is at depth `levels + 1`. */
  function nestedInput(levels: number) {
    return `{"input":{"requestId":"${ids.request}","bodyMd":"Hello.","deep":${"[".repeat(levels)}${"]".repeat(levels)}},"idempotencyKey":"b1-idempotency-key-0001","expectedVersion":0}`;
  }

  test("a lone 0xff byte inside a string of a valid envelope is refused as invalid UTF-8, with no dispatch", async () => {
    signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");

    await expectDomain422(
      await api.postRaw(["commands", "post_message"], {
        body: envelopeBytes(new Uint8Array([0x48, 0xff, 0x69])),
        headers: json,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test("the same envelope with valid multi-byte UTF-8 in that string is dispatched", async () => {
    signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");

    await api.postRaw(["commands", "post_message"], {
      body: envelopeBytes(new TextEncoder().encode("H\u00e9llo \u{1F600}")),
      headers: json,
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ bodyMd: "H\u00e9llo \u{1F600}" }),
      }),
    );
  });

  test("a valid envelope whose input nests past depth 20 is refused, with no dispatch", async () => {
    signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");

    await expectDomain422(
      await api.postRaw(["commands", "post_message"], {
        body: nestedInput(20),
        headers: json,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test("the same envelope nesting to exactly depth 20 passes the depth guard and is dispatched", async () => {
    signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");

    await api.postRaw(["commands", "post_message"], {
      body: nestedInput(19),
      headers: json,
    });

    expect(execute).toHaveBeenCalledOnce();
  });

  /**
   * The envelope schema raises a ZodError, which `responseError` answers with
   * a different message and no `details` key at all — a second shape for the
   * same status and code.
   */
  test.each([
    ["no idempotency key", { expectedVersion: 0 }],
    [
      "an idempotency key of 15 characters",
      { idempotencyKey: "k".repeat(15), expectedVersion: 0 },
    ],
    [
      "an idempotency key of 201 characters",
      { idempotencyKey: "k".repeat(201), expectedVersion: 0 },
    ],
    ["no expected version", { idempotencyKey: "b1-idempotency-key-0001" }],
    [
      "a negative expected version",
      { idempotencyKey: "b1-idempotency-key-0001", expectedVersion: -1 },
    ],
    [
      "a fractional expected version",
      { idempotencyKey: "b1-idempotency-key-0001", expectedVersion: 1.5 },
    ],
    [
      "an unknown envelope key",
      {
        idempotencyKey: "b1-idempotency-key-0001",
        expectedVersion: 0,
        organizationId: ids.otherOrganization,
      },
    ],
    [
      "an array input",
      {
        idempotencyKey: "b1-idempotency-key-0001",
        expectedVersion: 0,
        input: [],
      },
    ],
    [
      "a string input",
      {
        idempotencyKey: "b1-idempotency-key-0001",
        expectedVersion: 0,
        input: "x",
      },
    ],
  ])(
    "%s is refused by the envelope schema, with no dispatch",
    async (_label, envelope) => {
      signInAs(agentContext());
      const execute = vi.spyOn(coreCommandBus, "execute");

      await expectSchema422(
        await api.postRaw(["commands", "post_message"], {
          body: JSON.stringify(envelope),
          headers: json,
        }),
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  test("an omitted input is dispatched as the injected fields alone", async () => {
    const context = signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");

    await api.postRaw(["commands", "post_message"], {
      body: JSON.stringify({
        idempotencyKey: "b1-idempotency-key-0001",
        expectedVersion: 0,
      }),
      headers: json,
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { organizationId: context.organizationId },
      }),
    );
  });

  /**
   * A key the envelope accepts and the bus refuses: the envelope does not
   * trim, `validateCommandMeta` does. The same mistake therefore answers in
   * the DomainError shape here and in the schema shape one test up.
   */
  test("an idempotency key with surrounding space passes the envelope and is refused by the bus", async () => {
    signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");

    const response = await api.postRaw(["commands", "post_message"], {
      body: JSON.stringify({
        input: { requestId: ids.request, bodyMd: "Hello." },
        idempotencyKey: " b1-idempotency-key-0001",
        expectedVersion: 0,
      }),
      headers: json,
    });

    await expectDomain422(response);
    expect(execute).toHaveBeenCalledOnce();
    expect(apiV1.transactionsRun).toBe(0);
  });

  test("input the command's schema refuses is answered 422 naming the field, before any transaction", async () => {
    signInAs(agentContext());

    const response = await api.command("post_message", {
      input: { requestId: "not-a-uuid", bodyMd: "Hello." },
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "validation_failed",
      message: "The request input is invalid.",
      details: { field: "requestId" },
    });
    expect(apiV1.transactionsRun).toBe(0);
  });
});
