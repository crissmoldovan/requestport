import { request as httpRequest } from "node:http";

import type { RequestPort } from "@requestport/core";
import type { Storage } from "@requestport/db";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createRequestPortHost, DEFAULT_HTTP_LIMITS } from "./host.js";
import { listen, type RunningHost } from "./node.js";
import {
  RATE_LIMIT_POLICIES,
  type RateLimitConsumption,
} from "./rate-limit.js";

/*
  The auth family through the whole host: `createRequestPortHost` served by
  `listen`, the Node adapter, over a socket (manifest-h.md §5, Done when 3).
  The rate limiter's repository counts what each principal consumed in each
  class, and no window turns while a case runs, so a refusal is a real one:
  a class allows `limit` requests and refuses the next. Every request is
  sent from 127.0.0.1 with `node:http`, which lets a case choose its
  headers, `Host` included.
*/

const counted = vi.hoisted(() => ({
  consumed: [] as RateLimitConsumption[],
  totals: new Map<string, number>(),
}));
vi.mock("@requestport/db", () => ({
  createRateLimitRepository: () => ({
    consume: async (input: RateLimitConsumption) => {
      counted.consumed.push(input);
      const key = `${input.endpointClass} ${input.principalFingerprint}`;
      const total = (counted.totals.get(key) ?? 0) + (input.cost ?? 1);
      counted.totals.set(key, total);
      const allowed = total <= input.limit;
      return {
        allowed,
        remaining: Math.max(0, input.limit - total),
        retryAfterSeconds: allowed ? 0 : 42,
      };
    },
  }),
  createImportRepository: () => {
    throw new Error("no artifact import is sent here");
  },
}));

const publicUrl = "http://requestport.test";
const running: RunningHost[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((host) => host.close()));
  counted.consumed.length = 0;
  counted.totals.clear();
});

/** What Better Auth's handler was handed: the headers a limit could read. */
type Handed = { path: string; forwardedFor: string | null; vercel: boolean };

async function start(options: { trustedProxy?: string } = {}) {
  const handed: Handed[] = [];
  const betterAuth = {
    handler: async (request: Request) => {
      handed.push({
        path: new URL(request.url).pathname,
        forwardedFor: request.headers.get("x-forwarded-for"),
        vercel: request.headers.has("x-vercel-forwarded-for"),
      });
      return Response.json({ handledBy: "auth.handler" });
    },
  };
  const refuse = async () => {
    throw new Error("only the auth family is sent here");
  };
  const handler = createRequestPortHost({
    requestPort: {} as RequestPort,
    auth: {
      auth: betterAuth,
      authenticateAgentBearer: refuse,
      authenticateApiBearer: refuse,
      oauthAuthorizationServerMetadata: refuse,
      oauthOpenIdConfiguration: refuse,
    },
    publicUrl,
    storage: { db: { handle: "the storage's" } } as unknown as Storage,
    secrets: { fingerprintKey: "client-address-fingerprint-key" },
    mcp: { modernProtocol: false, privateTelemetry: false },
    environment: "client-address",
    limits: {
      ...DEFAULT_HTTP_LIMITS,
      rateLimits: {
        ...RATE_LIMIT_POLICIES,
        token: { limit: 2, windowSeconds: 60 },
      },
    },
  });
  const host = await listen(handler, {
    host: "127.0.0.1",
    port: 0,
    publicUrl,
    ...(options.trustedProxy ? { trustedProxy: options.trustedProxy } : {}),
  });
  running.push(host);
  return { host, handed };
}

type Sent = { status: number; headers: Record<string, unknown>; body: string };

/** A POST from 127.0.0.1, naming the public URL's host, with these headers. */
function post(
  host: RunningHost,
  path: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
  options: { chunked?: boolean } = {},
): Promise<Sent> {
  const { port } = new URL(host.url);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(port),
        method: "POST",
        path,
        headers: {
          host: "requestport.test",
          "content-type": "application/json",
          ...(options.chunked
            ? { "transfer-encoding": "chunked" }
            : { "content-length": String(Buffer.byteLength(body)) }),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

const token = "/api/auth/oauth2/token";
const refresh = "grant_type=refresh_token&refresh_token=client-address";
const form = { "content-type": "application/x-www-form-urlencoded" };

describe("the auth family through the host and the Node adapter (Done when 3)", () => {
  test.each([
    ["declared by its content-length", false],
    ["streamed in chunks, with no length declared", true],
  ])(
    "a POST of 262,145 bytes, %s, answers 413, and one of 262,144 is handed on",
    async (_name, chunked) => {
      const { host, handed } = await start();

      const over = await post(
        host,
        "/api/auth/sign-in/email",
        "a".repeat(262_145),
        {},
        { chunked },
      );
      const at = await post(
        host,
        "/api/auth/sign-in/email",
        "a".repeat(262_144),
        {},
        { chunked },
      );

      expect(over.status).toBe(413);
      expect(JSON.parse(over.body)).toEqual({
        error: "request_too_large",
        message: "Authentication request body is too large.",
      });
      expect(at.status).toBe(200);
      expect(handed.map(({ path }) => path)).toEqual([
        "/api/auth/sign-in/email",
      ]);
    },
  );

  test("the token class refuses with 429 and retry-after, and a fresh x-vercel-forwarded-for or x-forwarded-for from the same socket is still refused", async () => {
    const { host, handed } = await start();

    const first = await post(host, token, refresh, form);
    const second = await post(host, token, refresh, form);
    const refused = await post(host, token, refresh, form);
    const vercel = await post(host, token, refresh, {
      ...form,
      "x-vercel-forwarded-for": "198.51.100.1",
    });
    const forwarded = await post(host, token, refresh, {
      ...form,
      "x-forwarded-for": "198.51.100.2",
    });
    const both = await post(host, token, refresh, {
      ...form,
      "x-vercel-forwarded-for": "198.51.100.3",
      "x-forwarded-for": "198.51.100.4",
    });

    expect([first.status, second.status]).toEqual([200, 200]);
    for (const answer of [refused, vercel, forwarded, both]) {
      expect(answer.status).toBe(429);
      expect(answer.headers["retry-after"]).toBe("42");
      expect(JSON.parse(answer.body)).toEqual({
        error: "rate_limited",
        message: "Too many requests",
      });
    }
    // One principal throughout: the socket's address.
    expect(
      new Set(counted.consumed.map((input) => input.principalFingerprint)).size,
    ).toBe(1);
    expect(counted.consumed.map((input) => input.endpointClass)).toEqual(
      Array(6).fill("token"),
    );
    // Better Auth saw the address the adapter set, never the client's.
    expect(handed).toEqual([
      { path: token, forwardedFor: "127.0.0.1", vercel: false },
      { path: token, forwardedFor: "127.0.0.1", vercel: false },
    ]);
  });

  test("an invalid dynamic registration answers 400 invalid_client_metadata, never reaching Better Auth", async () => {
    const { host, handed } = await start();

    const answer = await post(
      host,
      "/api/auth/oauth2/register",
      JSON.stringify({
        redirect_uris: ["http://127.0.0.1:43211/callback"],
        token_endpoint_auth_method: "none",
        require_pkce: false,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "An agent",
      }),
    );

    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toEqual({
      error: "invalid_client_metadata",
      error_description: "Public client metadata is invalid.",
    });
    expect(handed).toEqual([]);
  });

  test("with trustedProxy naming the proxy, two clients behind it are limited separately", async () => {
    const { host } = await start({ trustedProxy: "127.0.0.1" });
    const from = (client: string) =>
      post(host, token, refresh, { ...form, "x-forwarded-for": client });

    const first = [
      await from("203.0.113.1"),
      await from("203.0.113.1"),
      await from("203.0.113.1"),
    ];
    const second = await from("203.0.113.2");

    expect(first.map(({ status }) => status)).toEqual([200, 200, 429]);
    expect(second.status).toBe(200);
    expect(
      new Set(counted.consumed.map((input) => input.principalFingerprint)).size,
    ).toBe(2);
  });

  test("with trustedProxy naming another address, a forwarded header from this socket is ignored: every client is the socket", async () => {
    const { host } = await start({ trustedProxy: "192.0.2.1" });
    const from = (client: string) =>
      post(host, token, refresh, { ...form, "x-forwarded-for": client });

    const answers = [
      await from("203.0.113.1"),
      await from("203.0.113.2"),
      await from("203.0.113.3"),
    ];

    expect(answers.map(({ status }) => status)).toEqual([200, 200, 429]);
    expect(
      new Set(counted.consumed.map((input) => input.principalFingerprint)).size,
    ).toBe(1);
  });
});
