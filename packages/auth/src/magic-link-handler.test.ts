import { memoryAdapter } from "better-auth/adapters/memory";
import { betterAuth } from "better-auth/minimal";
import { expect, test, vi } from "vitest";

import { createAuthRouteHandler } from "./auth-handler.js";
import { createAuthOptions } from "./server-options.js";
import { SignupPolicyDeniedError } from "./signup-policy.js";

const env = {
  NODE_ENV: "test" as const,
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};

function createMemoryDatabase() {
  return {
    user: [],
    session: [],
    account: [],
    verification: [],
    oauthResource: [],
    oauthClientResource: [],
    oauthClientAssertion: [],
  };
}

function magicLinkRequest(
  email: string,
  overrides: Record<string, unknown> = {},
) {
  return new Request("http://localhost:3000/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      callbackURL: "/app",
      errorCallbackURL: "/auth-error",
      ...overrides,
    }),
  });
}

test.each([
  ["name", { name: 42 }],
  ["callbackURL", { callbackURL: 42 }],
  ["newUserCallbackURL", { newUserCallbackURL: [] }],
  ["errorCallbackURL", { errorCallbackURL: {} }],
  ["metadata", { metadata: "not-a-record" }],
])(
  "malformed %s is rejected identically before eligibility is disclosed",
  async (_field, invalidBody) => {
    const deniedPolicy = vi.fn(async () => {
      throw new SignupPolicyDeniedError("signup_disabled");
    });
    const allowedPolicy = vi.fn(async () => ({
      allowed: true as const,
      reason: "allowlist" as const,
    }));
    const deniedAuth = betterAuth(
      createAuthOptions({
        database: memoryAdapter(createMemoryDatabase()),
        env,
        assertSignupAllowed: deniedPolicy,
        sendMagicLink: vi.fn(async () => undefined),
      }),
    );
    const allowedAuth = betterAuth(
      createAuthOptions({
        database: memoryAdapter(createMemoryDatabase()),
        env,
        assertSignupAllowed: allowedPolicy,
        sendMagicLink: vi.fn(async () => undefined),
      }),
    );

    const [deniedResponse, allowedResponse] = await Promise.all([
      deniedAuth.handler(magicLinkRequest("denied@example.com", invalidBody)),
      allowedAuth.handler(magicLinkRequest("allowed@example.com", invalidBody)),
    ]);

    expect(deniedResponse.status).toBe(400);
    expect(allowedResponse.status).toBe(400);
    expect(await deniedResponse.json()).toEqual(await allowedResponse.json());
    expect(deniedPolicy).not.toHaveBeenCalled();
    expect(allowedPolicy).not.toHaveBeenCalled();
  },
);

test("ineligible magic-link initiation is neutral and has no verification or email side effect", async () => {
  const deniedStore = createMemoryDatabase();
  const deniedSend = vi.fn(async () => undefined);
  const deniedAuth = betterAuth(
    createAuthOptions({
      database: memoryAdapter(deniedStore),
      env,
      assertSignupAllowed: vi.fn(async () => {
        throw new SignupPolicyDeniedError("signup_disabled");
      }),
      sendMagicLink: deniedSend,
    }),
  );

  const allowedStore = createMemoryDatabase();
  const allowedAuth = betterAuth(
    createAuthOptions({
      database: memoryAdapter(allowedStore),
      env,
      assertSignupAllowed: vi.fn(async () => ({
        allowed: true as const,
        reason: "allowlist" as const,
      })),
      sendMagicLink: vi.fn(async () => undefined),
    }),
  );

  const [deniedResponse, allowedResponse] = await Promise.all([
    deniedAuth.handler(magicLinkRequest("denied@example.com")),
    allowedAuth.handler(magicLinkRequest("allowed@example.com")),
  ]);

  expect(deniedResponse.status).toBe(allowedResponse.status);
  await expect(deniedResponse.json()).resolves.toEqual({ status: true });
  await expect(allowedResponse.json()).resolves.toEqual({ status: true });
  expect(deniedStore.verification).toHaveLength(0);
  expect(deniedSend).not.toHaveBeenCalled();
  expect(allowedStore.verification).toHaveLength(1);
});

test("the preflight retains Better Auth form CSRF validation", async () => {
  const assertSignupAllowed = vi.fn(async () => ({
    allowed: true as const,
    reason: "allowlist" as const,
  }));
  const options = createAuthOptions({
    database: memoryAdapter(createMemoryDatabase()),
    env,
    assertSignupAllowed,
    sendMagicLink: vi.fn(async () => undefined),
  });
  // Better Auth skips origin checks automatically under NODE_ENV=test. Force
  // production semantics in this fixture without changing production options.
  const auth = betterAuth({
    ...options,
    advanced: { ...options.advanced, disableOriginCheck: false },
  });
  const request = magicLinkRequest("person@example.com");
  request.headers.set("cookie", "better-auth.session_token=present");
  request.headers.set("origin", "https://untrusted.example");

  const response = await auth.handler(request);

  expect(response.status).toBe(403);
  expect(assertSignupAllowed).not.toHaveBeenCalled();
});

test("global callback-origin validation runs before a neutral policy response", async () => {
  const assertSignupAllowed = vi.fn(async () => {
    throw new SignupPolicyDeniedError("signup_disabled");
  });
  const options = createAuthOptions({
    database: memoryAdapter(createMemoryDatabase()),
    env,
    assertSignupAllowed,
    sendMagicLink: vi.fn(async () => undefined),
  });
  // Better Auth skips origin checks automatically under NODE_ENV=test. Force
  // production semantics in this fixture without changing production options.
  const auth = betterAuth({
    ...options,
    advanced: { ...options.advanced, disableOriginCheck: false },
  });

  const response = await auth.handler(
    magicLinkRequest("denied@example.com", {
      callbackURL: "https://untrusted.example/app",
    }),
  );

  expect(response.status).toBe(403);
  expect(assertSignupAllowed).not.toHaveBeenCalled();
});

test("rate limiting runs before a neutral policy response", async () => {
  const options = createAuthOptions({
    database: memoryAdapter(createMemoryDatabase()),
    env,
    assertSignupAllowed: vi.fn(async () => {
      throw new SignupPolicyDeniedError("signup_disabled");
    }),
    sendMagicLink: vi.fn(async () => undefined),
  });
  const auth = betterAuth({
    ...options,
    rateLimit: { enabled: true },
  });

  const responses = [];
  for (let requestNumber = 0; requestNumber < 6; requestNumber += 1) {
    responses.push(await auth.handler(magicLinkRequest("denied@example.com")));
  }

  expect(responses.slice(0, 5).map((response) => response.status)).toEqual([
    200, 200, 200, 200, 200,
  ]);
  expect(responses[5]?.status).toBe(429);
});

test("a verification-time policy denial redirects to the fixed auth error", async () => {
  let eligible = true;
  let magicLinkUrl: string | undefined;
  const store = createMemoryDatabase();
  const auth = betterAuth(
    createAuthOptions({
      database: memoryAdapter(store),
      env,
      assertSignupAllowed: vi.fn(async () => {
        if (!eligible) throw new SignupPolicyDeniedError("revoked");
        return { allowed: true as const, reason: "allowlist" as const };
      }),
      sendMagicLink: vi.fn(async ({ url }) => {
        magicLinkUrl = url;
      }),
    }),
  );
  await auth.handler(magicLinkRequest("person@example.com"));
  eligible = false;

  const response = await createAuthRouteHandler(auth.handler)(
    new Request(magicLinkUrl as string),
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    "/auth-error?error=signup_disabled",
  );
  expect(store.user).toHaveLength(0);
});

test("does not redirect a suffix lookalike verification path", async () => {
  const response = await createAuthRouteHandler(async () =>
    Response.json(
      { code: "signup_disabled", message: "signup_disabled" },
      { status: 403 },
    ),
  )(new Request("http://localhost:3000/api/auth/lookalike/magic-link/verify"));

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    code: "signup_disabled",
    message: "signup_disabled",
  });
});
