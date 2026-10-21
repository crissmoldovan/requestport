import { readFile } from "node:fs/promises";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { hashLocalCredential } from "@requestport/domain";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { decodeJwt } from "jose";
import { describe, expect, test, vi } from "vitest";

import {
  createAgentAccessTokenVerifierFor,
  createAuthOptions,
  issuerFor,
} from "./server-options.js";

const secret = "a".repeat(32);
const github = {
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
} as const;

type Composition = {
  github: boolean;
  magicLink: boolean;
  localCredential?: "enabled" | "disabled";
  vercelEnv?: string;
  url?: string;
  nodeEnv?: "development" | "test" | "production";
  database?: NonNullable<BetterAuthOptions["database"]>;
};

function compose({
  github: withGitHub,
  magicLink,
  localCredential,
  vercelEnv,
  url = "https://requestport.com",
  nodeEnv = "production",
  database = {} as never,
}: Composition) {
  return createAuthOptions({
    database,
    env: {
      NODE_ENV: nodeEnv,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: url,
      ...(withGitHub ? github : {}),
      ...(localCredential
        ? { REQUESTPORT_LOCAL_CREDENTIAL: localCredential }
        : {}),
      VERCEL_ENV: vercelEnv,
    },
    assertSignupAllowed: vi.fn(async () => ({})),
    ...(magicLink ? { sendMagicLink: vi.fn(async () => undefined) } : {}),
    resolveAgentGrantBindingFingerprints: async () => ({
      fingerprints: [],
      truncated: false,
    }),
    repairUnboundAgentConsent: async () => undefined,
  });
}

function pluginIds(options: BetterAuthOptions) {
  return (options.plugins ?? []).map((plugin) => plugin.id);
}

/** Functions become a marker; everything else is compared by value. */
function shape(value: unknown, depth = 0): unknown {
  if (typeof value === "function") return "[function]";
  if (Array.isArray(value)) return value.map((item) => shape(item, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 6) return "[deep]";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, shape(item, depth + 1)]),
    );
  }
  return value;
}

function compositionShape(options: BetterAuthOptions) {
  return shape({
    ...options,
    plugins: (options.plugins ?? []).map((plugin) => {
      const hooks = (
        plugin as { hooks?: { before?: unknown[]; after?: unknown[] } }
      ).hooks;
      return {
        id: plugin.id,
        options: (plugin as { options?: unknown }).options,
        hooks: hooks
          ? {
              before: hooks.before?.length ?? 0,
              after: hooks.after?.length ?? 0,
            }
          : null,
        endpoints: Object.keys(
          (plugin as { endpoints?: object }).endpoints ?? {},
        ).sort(),
      };
    }),
  });
}

/**
 * Production is the full composition: GitHub, the magic link, no local
 * credential. The golden beside this file was first recorded from
 * `createAuthOptions` as it stood before the sign-in switches were separated
 * (at `d5396aa`), with this same `compositionShape`, and has been re-recorded
 * only on purpose since, each time in a commit that names the keys it changed:
 * Track K.3 added `disabledPaths` (`/change-password` closed), then recorded
 * Better Auth 1.7.6's composition — `validAudiences` gone, `resources`,
 * `enforcePerClientResources` and the two registration resource lists added,
 * `refreshTokenReuseInterval` filled in by the provider, and eight provider
 * endpoints added (seven server-only resource administration calls and the
 * end-session confirmation). So any other drift in what production composes
 * — a plugin, an option, a hook, an endpoint — fails here.
 */
describe("the production composition", () => {
  test("is exactly the recorded composition", async () => {
    const golden = JSON.parse(
      await readFile(
        new URL(
          "./server-options.full-composition.golden.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    expect(
      compositionShape(compose({ github: true, magicLink: true })),
    ).toEqual(golden);
  });
});

describe("the four combinations of external sign-in methods", () => {
  const always = [
    "jwt",
    "api-key",
    "oauth-provider",
    // In every composition: the signup policy and the grant repair were
    // dropped whenever the providers were, which left a providerless
    // deployment without either.
    "requestport-signup-policy",
    "requestport-agent-grant-integrity",
  ];

  test("neither: the local credential is the way in, and the policy stays", () => {
    const options = compose({ github: false, magicLink: false });

    expect(options.socialProviders).toBeUndefined();
    expect(pluginIds(options)).toEqual(always);
    expect(options.emailAndPassword).toMatchObject({
      enabled: true,
      disableSignUp: true,
    });
  });

  test("GitHub only", () => {
    const options = compose({ github: true, magicLink: false });

    expect(options.socialProviders).toEqual({
      github: { clientId: "github-client", clientSecret: "github-secret" },
    });
    expect(pluginIds(options)).toEqual(always);
    expect(options.emailAndPassword).toBeUndefined();
  });

  test("magic link only", () => {
    const options = compose({ github: false, magicLink: true });

    expect(options.socialProviders).toBeUndefined();
    expect(pluginIds(options)).toEqual([
      "jwt",
      "api-key",
      "oauth-provider",
      "magic-link",
      "requestport-signup-policy",
      "requestport-agent-grant-integrity",
    ]);
    expect(options.emailAndPassword).toBeUndefined();
  });

  test("both", () => {
    const options = compose({ github: true, magicLink: true });

    expect(options.socialProviders).toBeDefined();
    expect(pluginIds(options)).toEqual([
      "jwt",
      "api-key",
      "oauth-provider",
      "magic-link",
      "requestport-signup-policy",
      "requestport-agent-grant-integrity",
    ]);
    expect(options.emailAndPassword).toBeUndefined();
  });

  test("the local credential can be switched on beside both, and off alone", () => {
    expect(
      compose({ github: true, magicLink: true, localCredential: "enabled" })
        .emailAndPassword,
    ).toMatchObject({ enabled: true, disableSignUp: true });
    expect(
      compose({ github: false, magicLink: false, localCredential: "disabled" })
        .emailAndPassword,
    ).toBeUndefined();
  });

  test("never lets anyone create an account with a password", () => {
    const options = compose({ github: false, magicLink: false });

    expect(options.emailAndPassword?.disableSignUp).toBe(true);
    expect(options.emailAndPassword?.password).toMatchObject({
      hash: expect.any(Function),
      verify: expect.any(Function),
    });
  });
});

/**
 * The composition applies the same rule the sign-in page reads: on any Vercel
 * deployment the local credential is off, and the switch cannot turn it on.
 */
describe("the local credential on a Vercel deployment", () => {
  test.each([
    {
      name: "production, switched on beside both methods",
      composition: {
        github: true,
        magicLink: true,
        localCredential: "enabled" as const,
        vercelEnv: "production",
      },
    },
    {
      name: "a Preview with no external method and no switch",
      composition: { github: false, magicLink: false, vercelEnv: "preview" },
    },
    {
      name: "a Preview switched on",
      composition: {
        github: false,
        magicLink: false,
        localCredential: "enabled" as const,
        vercelEnv: "preview",
      },
    },
    {
      name: "development switched on",
      composition: {
        github: false,
        magicLink: false,
        localCredential: "enabled" as const,
        vercelEnv: "development",
      },
    },
  ])("is not composed in $name", ({ composition }) => {
    expect(compose(composition).emailAndPassword).toBeUndefined();
  });

  test("is composed off Vercel with no external method, as before", () => {
    expect(
      compose({ github: false, magicLink: false }).emailAndPassword,
    ).toMatchObject({ enabled: true, disableSignUp: true });
  });

  test("is not composed off Vercel when switched off", () => {
    expect(
      compose({ github: false, magicLink: false, localCredential: "disabled" })
        .emailAndPassword,
    ).toBeUndefined();
  });
});

/**
 * Whether `BETTER_AUTH_URL` can be the OAuth issuer is decided here, where
 * Better Auth is composed, and not in the configuration parse the Trigger
 * worker shares. `server.ts` composes at import, so a refusal here is a
 * refusal of every module that imports `@requestport/auth/server`.
 *
 * `@better-auth/oauth-provider` advertises `validateIssuerUrl(issuer)`, which
 * rewrites plain http on a host that is not loopback to https and drops a
 * query and a fragment; tokens carry the issuer as given. A URL it would
 * change advertises one issuer and mints another.
 */
describe("which BETTER_AUTH_URL the composition accepts as its issuer", () => {
  test.each([
    "https://requestport.com",
    "https://requestport.com/",
    "https://requestport.internal:8443",
    "http://localhost:3000",
    "http://127.0.0.1:3100",
    "http://127.8.9.10",
    "http://[::1]:3000",
    "http://tenant.localhost:3000",
  ])("accepts %s", (url) => {
    expect(() =>
      compose({ github: false, magicLink: false, url }),
    ).not.toThrow();
  });

  test.each([
    "http://requestport.internal:3000",
    "http://10.0.0.5:3000",
    "http://requestport.com",
    "http://localhost.example.com",
    "https://requestport.com/?tenant=a",
    "https://requestport.com/#fragment",
    "https://requestport.com/?",
    "ftp://requestport.com",
  ])("refuses %s", (url) => {
    expect(() => compose({ github: true, magicLink: true, url })).toThrow(
      /BETTER_AUTH_URL[\s\S]*issuer/u,
    );
  });
});

function memoryDatabase() {
  return memoryAdapter({
    user: [],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    apikey: [],
    oauthClient: [],
    oauthRefreshToken: [],
    oauthAccessToken: [],
    oauthConsent: [],
    oauthResource: [],
    oauthClientResource: [],
    oauthClientAssertion: [],
  });
}

/**
 * The issuer an agent reads from discovery must be the issuer in the tokens
 * it is handed. `@better-auth/oauth-provider` advertises its own rewriting of
 * `BETTER_AUTH_URL` (https unless loopback, no trailing slash, no query) and
 * signs with the JWT plugin's `issuer`, so the two are compared here through
 * the library's own discovery handlers and its own signer.
 */
describe("the advertised issuer and a minted token's iss", () => {
  test.each([
    "https://requestport.com",
    "https://requestport.com/",
    "http://localhost:3000",
    "http://127.0.0.1:3100/",
  ])("agree for %s", async (url) => {
    const auth = betterAuth(
      compose({
        github: false,
        magicLink: false,
        url,
        nodeEnv: "development",
        database: memoryDatabase(),
      }),
    );
    const origin = new URL(url).origin;
    const authorizationServer = await (
      await oauthProviderAuthServerMetadata(auth)(
        new Request(`${origin}/.well-known/oauth-authorization-server`),
      )
    ).json();
    const openId = await (
      await oauthProviderOpenIdConfigMetadata(auth)(
        new Request(`${origin}/.well-known/openid-configuration`),
      )
    ).json();
    const { token } = await auth.api.signJWT({
      body: { payload: { sub: "user_probe" } },
    });

    expect(decodeJwt(token).iss).toBe(authorizationServer.issuer);
    expect(openId.issuer).toBe(authorizationServer.issuer);
    expect(issuerFor(url)).toBe(authorizationServer.issuer);
  });

  /*
    The bearer verifier is the third party to the agreement: a token signed
    with one spelling and checked against another is refused, so every agent
    request would fail. This builds it exactly as `create-auth.ts` does, from the
    Better Auth instance, and hands it a token that instance minted.
  */
  test.each([
    "https://requestport.com",
    "https://requestport.com/",
    "http://127.0.0.1:3100/",
  ])("the bearer verifier accepts a token minted for %s", async (url) => {
    const auth = betterAuth(
      compose({
        github: false,
        magicLink: false,
        url,
        nodeEnv: "development",
        database: memoryDatabase(),
      }),
    );
    const audience = new URL("/mcp", url).toString();
    const { token } = await auth.api.signJWT({
      body: { payload: { sub: "user_probe", aud: audience } },
    });

    const verify = createAgentAccessTokenVerifierFor(auth, [audience]);

    expect(await verify(token)).toMatchObject({
      sub: "user_probe",
      iss: decodeJwt(token).iss,
    });
  });
});

/**
 * Signing in with a credential written the way the operator command writes
 * it: the hash from `@requestport/domain`, in an `account` row with
 * `providerId` "credential". Through Better Auth's own handler, so this is the
 * request a browser makes.
 */
describe("signing in with the local credential", () => {
  async function seededAuth(options: Partial<Composition> = {}) {
    const credential = "a-local-credential-of-sufficient-length-0123";
    const database = {
      user: [
        {
          id: "user_owner",
          name: "owner",
          email: "owner@example.com",
          emailVerified: true,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      session: [],
      account: [
        {
          id: "account_owner",
          accountId: "user_owner",
          providerId: "credential",
          userId: "user_owner",
          password: await hashLocalCredential(credential),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      verification: [],
      jwks: [],
      apikey: [],
      oauthClient: [],
      oauthRefreshToken: [],
      oauthAccessToken: [],
      oauthConsent: [],
      oauthResource: [],
      oauthClientResource: [],
      oauthClientAssertion: [],
    };
    const auth = betterAuth(
      compose({
        github: false,
        magicLink: false,
        url: "http://localhost:3000",
        nodeEnv: "development",
        database: memoryAdapter(database),
        ...options,
      }),
    );
    return { auth, credential, database };
  }

  function signIn(
    auth: { handler: (request: Request) => Promise<Response> },
    body: Record<string, unknown>,
    path = "/api/auth/sign-in/email",
  ) {
    return auth.handler(
      new Request(`http://localhost:3000${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      }),
    );
  }

  test("the issued credential opens a session", async () => {
    const { auth, credential, database } = await seededAuth();

    const response = await signIn(auth, {
      email: "owner@example.com",
      password: credential,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(
      /better-auth\.session_token=/u,
    );
    expect(database.session).toHaveLength(1);
  });

  test("anything else is refused", async () => {
    const { auth, credential } = await seededAuth();

    const response = await signIn(auth, {
      email: "owner@example.com",
      password: `${credential}-wrong`,
    });

    expect(response.status).toBe(401);
  });

  test("no one can create an account with a password", async () => {
    const { auth, database } = await seededAuth();

    const response = await signIn(
      auth,
      {
        email: "stranger@example.com",
        password: "a-password-of-sufficient-length",
        name: "Stranger",
      },
      "/api/auth/sign-up/email",
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(database.user).toHaveLength(1);
  });

  test("on a Vercel Preview, even switched on, the credential opens nothing", async () => {
    const { auth, credential } = await seededAuth({
      localCredential: "enabled",
      vercelEnv: "preview",
    });

    const response = await signIn(auth, {
      email: "owner@example.com",
      password: credential,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test("switched off, the credential opens nothing", async () => {
    const { auth, credential } = await seededAuth({
      localCredential: "disabled",
    });

    const response = await signIn(auth, {
      email: "owner@example.com",
      password: credential,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

/**
 * `/change-password` is closed in every composition.
 *
 * Better Auth mounts it from its core endpoint table whatever the composition,
 * and its handler never reads `emailAndPassword.enabled`: it needs only a
 * session and the current password, rewrites the credential `account` row,
 * and revokes nothing but, on request, other sessions. The owner's credential
 * is rotated by `bootstrap-owner --rotate-local-credential`, which revokes the
 * member's operator credentials in the same transaction; a second way to
 * rewrite the same row would rotate it and revoke nothing. So the path is in
 * `disabledPaths`, which Better Auth's router answers with 404 before rate
 * limiting, plugins or the handler run. A server-side
 * `auth.api.changePassword` call is not stopped by it, and nothing makes one.
 */
describe("changing a password through Better Auth", () => {
  async function seededOwner(options: Partial<Composition> = {}) {
    const credential = "a-local-credential-of-sufficient-length-0123";
    const database = {
      user: [
        {
          id: "user_owner",
          name: "owner",
          email: "owner@example.com",
          emailVerified: true,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      session: [],
      account: [
        {
          id: "account_owner",
          accountId: "user_owner",
          providerId: "credential",
          userId: "user_owner",
          password: await hashLocalCredential(credential),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      verification: [],
      jwks: [],
      apikey: [],
      oauthClient: [],
      oauthRefreshToken: [],
      oauthAccessToken: [],
      oauthConsent: [],
      oauthResource: [],
      oauthClientResource: [],
      oauthClientAssertion: [],
    } as {
      account: ({ password: string } & Record<string, unknown>)[];
      [model: string]: unknown[];
    };
    const auth = betterAuth(
      compose({
        github: false,
        magicLink: false,
        url: "http://localhost:3000",
        nodeEnv: "development",
        database: memoryAdapter(database),
        ...options,
      }),
    );
    return { auth, credential, database };
  }

  function post(
    auth: { handler: (request: Request) => Promise<Response> },
    path: string,
    body: Record<string, unknown>,
    cookie?: string,
  ) {
    return auth.handler(
      new Request(`http://localhost:3000${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  function sessionCookie(response: Response) {
    const header = response.headers.get("set-cookie") ?? "";
    const match = /better-auth\.session_token=[^;]+/u.exec(header);
    if (!match) throw new Error("sign-in set no session cookie");
    return match[0];
  }

  test("a signed-in owner cannot rewrite their credential, and it still opens a session", async () => {
    const { auth, credential, database } = await seededOwner();
    const signedIn = await post(auth, "/api/auth/sign-in/email", {
      email: "owner@example.com",
      password: credential,
    });
    expect(signedIn.status).toBe(200);
    const before = database.account[0]?.password;

    const response = await post(
      auth,
      "/api/auth/change-password",
      {
        currentPassword: credential,
        newPassword: "a-different-credential-of-sufficient-length",
      },
      sessionCookie(signedIn),
    );

    expect(response.status).toBe(404);
    expect(database.account[0]?.password).toBe(before);
    const again = await post(auth, "/api/auth/sign-in/email", {
      email: "owner@example.com",
      password: credential,
    });
    expect(again.status).toBe(200);
  });

  test("with the local credential switched off, the path is not there at all", async () => {
    const { auth, credential } = await seededOwner({
      localCredential: "disabled",
    });

    const response = await post(auth, "/api/auth/change-password", {
      currentPassword: credential,
      newPassword: "a-different-credential-of-sufficient-length",
    });

    expect(response.status).toBe(404);
  });

  test("is disabled in every composition, by exact path", () => {
    for (const composition of [
      { github: true, magicLink: true },
      { github: false, magicLink: false },
      { github: false, magicLink: false, localCredential: "disabled" as const },
    ]) {
      expect(compose(composition).disabledPaths).toEqual(["/change-password"]);
    }
  });
});
