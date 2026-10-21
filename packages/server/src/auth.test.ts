import { DomainError } from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import {
  AUTH_MAX_BODY,
  type AuthOptions,
  handleAuthGet,
  handleAuthPost,
} from "./auth.js";

const origin = "https://requestport.test";

type Received = {
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  redirect: RequestRedirect;
  signal: AbortSignal;
  self: unknown;
};

/**
 * Better Auth's installed object as a stand-in: its `handler` records what it
 * was handed, and the object it was called on, and answers by path.
 */
function authOver(overrides: Partial<AuthOptions> = {}) {
  const log: string[] = [];
  const received: Received[] = [];
  const auth = {
    answer: (request: Request): Response => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/auth/oauth2/register")
        return Response.json({ client_id: "registered" }, { status: 201 });
      return Response.json({ handledBy: "auth.handler" });
    },
    async handler(this: unknown, request: Request): Promise<Response> {
      log.push(`auth.handler ${new URL(request.url).pathname}`);
      received.push({
        method: request.method,
        url: request.url,
        headers: [...request.headers],
        body: request.body ? await request.clone().text() : "",
        redirect: request.redirect,
        signal: request.signal,
        self: this,
      });
      return auth.answer(request);
    },
  };
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
  const requestIp = vi.fn((request: Request) => {
    log.push("requestIp");
    return request.headers.get("x-client") ?? "unknown";
  });
  const options: AuthOptions = {
    auth,
    rateLimiter: { fingerprint, enforce },
    requestIp,
    ...overrides,
  };
  return { options, auth, log, received, fingerprint, enforce, requestIp };
}

function post(
  path: string,
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
  init: RequestInit = {},
) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers,
    body,
    ...init,
  });
}

const registration = {
  redirect_uris: ["http://127.0.0.1:43211/callback"],
  token_endpoint_auth_method: "none",
  require_pkce: true,
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  client_name: "An agent",
};

describe("GET, as the route's GET answered it", () => {
  test("hands the request to auth.handler, called on Better Auth's object, as toNextJsHandler calls it", async () => {
    const { options, auth, received, log } = authOver();
    const request = new Request(`${origin}/api/auth/get-session`);

    const response = await handleAuthGet(request, options);

    expect(await response.json()).toEqual({ handledBy: "auth.handler" });
    expect(received).toHaveLength(1);
    expect(received[0]?.self).toBe(auth);
    expect(received[0]?.url).toBe(`${origin}/api/auth/get-session`);
    // No class limits a GET, and nothing reads its address.
    expect(log).toEqual(["auth.handler /api/auth/get-session"]);
  });

  test("sends a magic-link verification the signup policy refused to /auth-error, through createAuthRouteHandler", async () => {
    const { options, auth } = authOver();
    auth.answer = () =>
      new Response(null, {
        status: 302,
        headers: {
          location: `${origin}/sign-in?error=signup_disabled`,
        },
      });

    const response = await handleAuthGet(
      new Request(`${origin}/api/auth/magic-link/verify?token=t`),
      options,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/auth-error?error=signup_disabled",
    );
  });
});

describe("POST: the bounded body", () => {
  test(`hands on a body of AUTH_MAX_BODY bytes (${AUTH_MAX_BODY}), rebuilt with the method, the headers, the body, redirect and the signal`, async () => {
    const { options, received } = authOver();
    const aborted = new AbortController();
    const body = "a".repeat(AUTH_MAX_BODY);

    const response = await handleAuthPost(
      post(
        "/api/auth/sign-in/email",
        body,
        { "content-type": "application/json", "x-extra": "kept" },
        { redirect: "manual", signal: aborted.signal },
      ),
      options,
    );
    aborted.abort();

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe("POST");
    expect(received[0]?.body).toBe(body);
    expect(received[0]?.redirect).toBe("manual");
    expect(received[0]?.signal.aborted).toBe(true);
    expect(received[0]?.headers).toEqual(
      expect.arrayContaining([["x-extra", "kept"]]),
    );
  });

  test.each([
    [
      "declared",
      () =>
        post("/api/auth/sign-in/email", "a".repeat(AUTH_MAX_BODY + 1), {
          "content-type": "application/json",
          "content-length": String(AUTH_MAX_BODY + 1),
        }),
    ],
    [
      "streamed, with no length declared",
      () =>
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: "POST",
          body: new Blob(["a".repeat(AUTH_MAX_BODY + 1)]).stream(),
          duplex: "half",
        } as RequestInit),
    ],
  ])(
    "answers a body of one byte more, %s, 413, never handing it on",
    async (_name, request) => {
      const { options, received } = authOver();

      const response = await handleAuthPost(request(), options);

      expect(response.status).toBe(413);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: "request_too_large",
        message: "Authentication request body is too large.",
      });
      expect(received).toEqual([]);
    },
  );

  test("bounds the body at maxBody when given", async () => {
    const { options } = authOver({ maxBody: 8 });

    const response = await handleAuthPost(
      post("/api/auth/sign-in/email", "123456789"),
      options,
    );

    expect(response.status).toBe(413);
  });

  test("answers an invalid content-length 500, as the route did", async () => {
    const { options, received } = authOver();

    const response = await handleAuthPost(
      post("/api/auth/sign-in/email", "{}", {
        "content-type": "application/json",
        "content-length": "lots",
      }),
      options,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "unexpected_error",
      message: "Authentication request failed.",
    });
    expect(received).toEqual([]);
  });
});

describe("POST: the two rate-limit classes", () => {
  test("a magic link: the auth_initiation class, keyed by the client's address and the email, before Better Auth", async () => {
    const { options, log, fingerprint, enforce } = authOver();

    await handleAuthPost(
      post(
        "/api/auth/sign-in/magic-link",
        JSON.stringify({ email: "Person@Example.test" }),
        { "content-type": "application/json", "x-client": "203.0.113.7" },
      ),
      options,
    );

    expect(log).toEqual([
      "requestIp",
      "fingerprint",
      "enforce auth_initiation",
      "auth.handler /api/auth/sign-in/magic-link",
    ]);
    expect(fingerprint).toHaveBeenCalledExactlyOnceWith(
      "203.0.113.7",
      "Person@Example.test",
    );
    expect(enforce).toHaveBeenCalledExactlyOnceWith({
      endpointClass: "auth_initiation",
      fingerprint: "fingerprint(203.0.113.7 | Person@Example.test)",
    });
  });

  test("a magic link whose body is not JSON naming an email: keyed as invalid", async () => {
    const { options, fingerprint } = authOver();

    await handleAuthPost(
      post("/api/auth/sign-in/magic-link", "not json", {
        "content-type": "application/json",
        "x-client": "203.0.113.7",
      }),
      options,
    );

    expect(fingerprint).toHaveBeenCalledExactlyOnceWith(
      "203.0.113.7",
      "invalid",
    );
  });

  test.each([
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/consent",
    "/api/auth/device/token",
  ])(
    "%s: the token class, keyed by the client's address alone",
    async (path) => {
      const { options, log, fingerprint } = authOver();

      await handleAuthPost(
        post(path, "{}", {
          "content-type": "application/json",
          "x-client": "198.51.100.9",
        }),
        options,
      );

      expect(log).toEqual([
        "requestIp",
        "fingerprint",
        "enforce token",
        `auth.handler ${path}`,
      ]);
      expect(fingerprint).toHaveBeenCalledExactlyOnceWith("198.51.100.9");
    },
  );

  test("any other path: no class", async () => {
    const { options, log } = authOver();

    await handleAuthPost(post("/api/auth/sign-in/email", "{}"), options);

    expect(log).toEqual(["auth.handler /api/auth/sign-in/email"]);
  });

  test("a refusal: 429 with retry-after, and Better Auth never reached", async () => {
    const { options, received } = authOver({
      rateLimiter: {
        fingerprint: () => "fingerprint",
        enforce: async () => {
          throw new DomainError("rate_limited", "Too many requests", {
            retryAfterSeconds: 30,
          });
        },
      },
    });

    const response = await handleAuthPost(
      post("/api/auth/oauth2/token", "grant_type=refresh_token", {
        "content-type": "application/x-www-form-urlencoded",
      }),
      options,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "rate_limited",
      message: "Too many requests",
    });
    expect(received).toEqual([]);
  });

  test("a limiter that throws anything else: 500", async () => {
    const { options } = authOver({
      rateLimiter: {
        fingerprint: () => "fingerprint",
        enforce: async () => {
          throw new Error("limiter down");
        },
      },
    });

    const response = await handleAuthPost(
      post("/api/auth/sign-in/magic-link", "{}"),
      options,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "unexpected_error",
      message: "Authentication request failed.",
    });
  });
});

describe("POST: createAuthRouteHandler's registration check", () => {
  test("an invalid public registration: 400 invalid_client_metadata, never handed on", async () => {
    const { options, received } = authOver();

    const response = await handleAuthPost(
      post(
        "/api/auth/oauth2/register",
        JSON.stringify({ ...registration, require_pkce: false }),
      ),
      options,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_client_metadata",
      error_description: "Public client metadata is invalid.",
    });
    expect(received).toEqual([]);
  });

  test("a valid one without application_type: handed on as native", async () => {
    const { options, received } = authOver();

    const response = await handleAuthPost(
      post("/api/auth/oauth2/register", JSON.stringify(registration)),
      options,
    );

    expect(response.status).toBe(201);
    expect(JSON.parse(received[0]?.body ?? "{}")).toEqual({
      ...registration,
      application_type: "native",
    });
  });
});

test("a failure inside Better Auth is not turned into the route's 500: it rejects, as the route's unawaited return let it", async () => {
  const { options, auth } = authOver();
  auth.answer = () => {
    throw new Error("better auth failed");
  };

  await expect(
    handleAuthPost(post("/api/auth/sign-in/email", "{}"), options),
  ).rejects.toThrow("better auth failed");
});

test("AUTH_MAX_BODY is the route's 262,144 bytes", () => {
  expect(AUTH_MAX_BODY).toBe(262_144);
});
