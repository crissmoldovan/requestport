import { readFile } from "node:fs/promises";
import { APIError, type BetterAuthOptions } from "better-auth";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createAuthOptions } from "./server-options.js";
import { SignupPolicyDeniedError } from "./signup-policy.js";

const env = {
  NODE_ENV: "production" as const,
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "https://requestport.com",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};

function options(
  assertSignupAllowed = vi.fn(async () => ({
    allowed: true as const,
    reason: "allowlist" as const,
  })),
): import("better-auth").BetterAuthOptions {
  return createAuthOptions({
    assertSignupAllowed,
    database: {} as never,
    env,
    sendMagicLink: vi.fn(async () => undefined),
  });
}

function pluginIds(authOptions: BetterAuthOptions) {
  return (authOptions.plugins ?? []).map((plugin) => plugin.id);
}

/**
 * Better Auth's composition is written in `create-auth.ts`, the factory, and
 * installed by `server.ts` (manifest-g.md §2.12, option (A)). These read the
 * source of each: they are the only statements that production's instance is
 * built over that composition.
 */
async function sourceOf(file: "./create-auth.ts" | "./server.ts") {
  return readFile(new URL(file, import.meta.url), "utf8");
}

describe("Better Auth server configuration", () => {
  test("enables Drizzle transactions in production wiring", async () => {
    const factorySource = await sourceOf("./create-auth.ts");

    expect(factorySource).toMatch(
      /drizzleAdapter\([\s\S]*transaction:\s*true/u,
    );
  });

  test("hands Better Auth the Drizzle adapter inside both guards", async () => {
    const factorySource = await sourceOf("./create-auth.ts");

    // Ruling 38's CIMD guard and the signup guard are proven in
    // restricted-adapter.test.ts over composeAuthDatabase. Only this line
    // says production's instance is built over that composition; without it,
    // deleting the wrapper left every test green. The adapter is built over
    // `database()` when Better Auth initialises, not when this is composed.
    expect(factorySource).toMatch(
      /^\s+const authOptions = createAuthOptions\(\{\s*database: composeAuthDatabase\(\(options\) =>\s*drizzleAdapter\(database\(\), \{[^}]*\}\)\(options\),?\s*\),/mu,
    );
    expect(factorySource.match(/drizzleAdapter\(/gu)).toHaveLength(1);
    // …and that the one instance is built from exactly that composition.
    // (A call, not the name in a comment, which is quoted in backticks.)
    expect(factorySource.match(/(?<!`)\bbetterAuth\(/gu)).toHaveLength(1);
    expect(factorySource).toMatch(/return betterAuth\(authOptions\);/u);
  });

  test("builds the bearer verifier from the Better Auth instance that signs", async () => {
    const factorySource = await sourceOf("./create-auth.ts");

    // The verifier's issuer is read from the JWT plugin `auth` was composed
    // with; `server-options.sign-in-methods.test.ts` proves that function
    // accepts what the instance mints. Any other issuer here is a second
    // spelling that can drift from the one tokens carry.
    expect(factorySource).toMatch(
      /verifyJwt:\s*createAgentAccessTokenVerifierFor\(\s*auth,/u,
    );
    expect(factorySource).not.toMatch(/createAgentAccessTokenVerifier\(/u);
  });

  test("tells the sign-in methods and the composition whether this is Vercel", async () => {
    const [serverSource, factorySource] = await Promise.all([
      sourceOf("./server.ts"),
      sourceOf("./create-auth.ts"),
    ]);

    // The parsed configuration does not carry VERCEL_ENV, and an absent one
    // reads as "not Vercel", where the local credential may be on. So both
    // answers must be handed it from the process, and from one object:
    // server.ts builds it and hands it over, and the factory gives that one
    // object to both, reading no environment of its own.
    expect(serverSource).toMatch(
      /const authEnv = \{\s*\.\.\.serverEnv,\s*VERCEL_ENV: process\.env\.VERCEL_ENV,?\s*\}/u,
    );
    expect(serverSource).toMatch(/\benv: authEnv,/u);
    expect(serverSource).not.toMatch(/env: serverEnv,/u);
    expect(factorySource).toMatch(/signInMethodsFor\(env\)/u);
    expect(factorySource).toMatch(
      /createAuthOptions\(\{[\s\S]*?\n\s+env,\n[\s\S]*?\}\);/u,
    );
    expect(factorySource).not.toMatch(/\bserverEnv\b|process\.env/u);
  });

  test("composes Better Auth's options when the factory is called, and installs it as the module is imported", async () => {
    const [serverSource, factorySource] = await Promise.all([
      sourceOf("./server.ts"),
      sourceOf("./create-auth.ts"),
    ]);

    // What makes the composition's refusal of an unservable issuer, or of
    // CIMD without its allowlist, a refusal to serve: the factory composes
    // before it returns, and server.ts calls it at import, not on the first
    // sign-in, unless the host's handoff carries a Better Auth, which it
    // reads at import too (Plan 13, H.5; the cases at the end). Only the
    // instance, whose initialisation touches the database, waits for first
    // use (the cases below).
    expect(factorySource).toMatch(
      /^export function createAuth\([\s\S]*?\n {2}const authOptions = createAuthOptions\(/mu,
    );
    expect(serverSource).toMatch(/^const handed = handedAuth\(\);$/mu);
    expect(serverSource).toMatch(
      /^const \w+ =\s+handed \?\?\s+createAuth\(\{/mu,
    );
  });

  test("server.ts installs the factory and composes nothing itself", async () => {
    const serverSource = await sourceOf("./server.ts");

    expect(serverSource.match(/(?<!`)\bcreateAuth\(/gu)).toHaveLength(1);
    expect(serverSource).not.toMatch(
      /(?<!`)\b(?:betterAuth|drizzleAdapter|createAuthOptions)\(/u,
    );
  });

  test("enables only GitHub and hashed single-use magic links", () => {
    const authOptions = options();

    expect(authOptions.emailAndPassword).toBeUndefined();
    expect(authOptions.socialProviders).toEqual({
      github: {
        clientId: "github-client",
        clientSecret: "github-secret",
      },
    });
    expect(pluginIds(authOptions)).toEqual([
      "jwt",
      "api-key",
      "oauth-provider",
      "magic-link",
      "requestport-signup-policy",
      // A consent no usable grant stands behind is not a consent, and the
      // place that decides whether to skip the consent screen is the only
      // place that can still say so.
      "requestport-agent-grant-integrity",
    ]);
    expect(
      authOptions.plugins?.find((plugin) => plugin.id === "magic-link"),
    ).toMatchObject({
      id: "magic-link",
      options: { storeToken: "hashed" },
    });
    expect(authOptions.account).toMatchObject({ encryptOAuthTokens: true });
    expect(authOptions.advanced).toMatchObject({ useSecureCookies: true });
    expect(authOptions.advanced?.disableCSRFCheck).toBeUndefined();
    expect(authOptions.advanced?.disableOriginCheck).toBeUndefined();
    expect(authOptions.advanced?.crossSubDomainCookies).toBeUndefined();
  });

  test("keeps the signup policy and the grant repair when no external provider is configured", () => {
    const {
      GITHUB_CLIENT_ID: _githubClientId,
      GITHUB_CLIENT_SECRET: _githubClientSecret,
      ...providerlessEnv
    } = env;
    const authOptions = createAuthOptions({
      assertSignupAllowed: vi.fn(async () => ({
        allowed: true as const,
        reason: "allowlist" as const,
      })),
      database: {} as never,
      env: providerlessEnv,
    });

    expect(authOptions.socialProviders).toBeUndefined();
    // Both used to be dropped with the providers. The policy guards every
    // account Better Auth creates, and the repair every agent authorization;
    // neither depends on how a person signs in.
    expect(pluginIds(authOptions)).toEqual([
      "jwt",
      "api-key",
      "oauth-provider",
      "requestport-signup-policy",
      "requestport-agent-grant-integrity",
    ]);
  });

  test("trusts only canonical, stable, and controlled preview origins in production", () => {
    const authOptions = options();
    expect(authOptions.trustedOrigins).toEqual([
      "https://requestport.com",
      "https://staging.requestport.com",
      "https://*.preview.requestport.com",
      "https://requestport.vercel.app",
      "https://requestport-*-cueplusplus.vercel.app",
    ]);
    expect(authOptions.onAPIError?.errorURL).toBe(
      "https://requestport.com/auth-error",
    );

    const developmentOptions = createAuthOptions({
      assertSignupAllowed: vi.fn(async () => ({
        allowed: true as const,
        reason: "allowlist" as const,
      })),
      database: {} as never,
      env: { ...env, NODE_ENV: "development" },
      sendMagicLink: vi.fn(async () => undefined),
    });
    expect(developmentOptions.trustedOrigins).toContain(
      "http://localhost:3000",
    );

    const e2eOptions = createAuthOptions({
      assertSignupAllowed: vi.fn(async () => ({
        allowed: true as const,
        reason: "allowlist" as const,
      })),
      database: {} as never,
      env: {
        ...env,
        NODE_ENV: "development",
        BETTER_AUTH_URL: "http://127.0.0.1:3100",
      },
      sendMagicLink: vi.fn(async () => undefined),
    });
    expect(e2eOptions.trustedOrigins).toContain("http://127.0.0.1:3100");
  });

  test("runs policy before creation and translates every policy denial identically", async () => {
    const assertSignupAllowed = vi.fn(async () => {
      throw new SignupPolicyDeniedError("revoked");
    });
    const before =
      options(assertSignupAllowed).databaseHooks?.user?.create?.before;

    const call = before?.(
      {
        id: "user_1",
        name: "Person",
        email: "Person@Example.com",
        emailVerified: false,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      null,
    );

    await expect(call).rejects.toBeInstanceOf(APIError);
    await expect(call).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: "signup_disabled", message: "signup_disabled" },
    });
    expect(assertSignupAllowed).toHaveBeenCalledWith("Person@Example.com");
  });

  test("keeps delivery separate from the pre-handler eligibility boundary", async () => {
    const assertSignupAllowed = vi.fn(async () => ({
      allowed: true as const,
      reason: "allowlist" as const,
    }));
    const sendMagicLink = vi.fn(async () => undefined);
    const authOptions = createAuthOptions({
      assertSignupAllowed,
      database: {} as never,
      env,
      sendMagicLink,
    });
    const plugin = authOptions.plugins?.find(
      (candidate) => candidate.id === "magic-link",
    ) as unknown as {
      options: {
        sendMagicLink(input: { email: string; url: string }): Promise<void>;
      };
    };

    await plugin.options.sendMagicLink({
      email: "Person@Example.com",
      url: "https://requestport.test/credential",
    });

    expect(assertSignupAllowed).not.toHaveBeenCalled();
    expect(sendMagicLink).toHaveBeenCalledWith({
      email: "Person@Example.com",
      url: "https://requestport.test/credential",
    });
  });

  test("does not disguise unexpected policy failures as eligibility denials", async () => {
    const unexpected = new Error("database unavailable");
    const before = options(
      vi.fn(async () => {
        throw unexpected;
      }),
    ).databaseHooks?.user?.create?.before;

    await expect(
      before?.(
        {
          id: "user_1",
          name: "Person",
          email: "person@example.com",
          emailVerified: false,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        null,
      ),
    ).rejects.toBe(unexpected);
  });
});

/**
 * When the repair may run — which is a different question from what it does.
 *
 * `/oauth2/consent` finishes by dispatching `/oauth2/authorize` itself, hooks
 * and all. So this ran between the consent being written and authorization
 * reading it back, at the one instant when the grant it looks for cannot
 * exist: the consent action binds that grant only after a code is issued.
 * Finding none, the repair blanked the consent that had just been recorded,
 * authorization saw no consent, and it returned the person to the consent
 * screen instead of to their client. Every first consent failed that way, and
 * the only assertion about this plugin was that it was registered.
 */
describe("when the agent grant repair may run", () => {
  function repairMatcher() {
    const plugin = options().plugins?.find(
      (candidate) => candidate.id === "requestport-agent-grant-integrity",
    ) as
      | {
          hooks?: {
            before?: readonly { matcher: (context: unknown) => boolean }[];
          };
        }
      | undefined;
    const before = plugin?.hooks?.before?.[0];
    if (!before) throw new Error("the repair hook is not registered");

    return before.matcher;
  }

  test("runs when a person arrives at authorization", () => {
    expect(
      repairMatcher()({
        path: "/oauth2/authorize",
        request: new Request(
          "https://requestport.com/api/auth/oauth2/authorize?client_id=abc",
        ),
      }),
    ).toBe(true);
  });

  test("does not run when consent re-enters authorization itself", () => {
    expect(
      repairMatcher()({
        path: "/oauth2/authorize",
        request: new Request(
          "https://requestport.com/api/auth/oauth2/consent",
          { method: "POST" },
        ),
      }),
    ).toBe(false);
  });

  test("does not run where there is no request to judge", () => {
    // Declining costs only the repair, and leaves the state that already
    // exists. Running where the arrival cannot be confirmed costs a consent.
    expect(repairMatcher()({ path: "/oauth2/authorize" })).toBe(false);
  });

  test("does not run for any other endpoint", () => {
    expect(
      repairMatcher()({
        path: "/oauth2/token",
        request: new Request("https://requestport.com/api/auth/oauth2/token", {
          method: "POST",
        }),
      }),
    ).toBe(false);
  });
});

/**
 * When the production instance is built — which is not when the module is
 * imported.
 *
 * Better Auth 1.7.6 starts initialising the moment `betterAuth()` is called,
 * and its OAuth provider seeds `oauth_resource` while it does. When
 * `server.ts` built the instance at import, every importer queried the
 * database `DATABASE_URL` named: the workspace contract's `vitest list`, run
 * under a placeholder URL, collected `apps/web`'s scenarios route test, met an
 * unhandled rejection and listed nothing. And an initialisation that failed
 * once failed every later request on that instance, which awaits the same
 * rejected promise for as long as the process lives.
 *
 * Both cases point the module at a loopback port nothing listens on, over the
 * `pg` driver, so the failure is a refused connection, not a timeout.
 */
describe("when the production Better Auth instance is built", () => {
  const unreachableDatabase =
    "postgres://requestport:requestport@127.0.0.1:1/requestport";
  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  /*
   * The roots' storages live on `globalThis` (`@requestport/db/wiring`), which
   * `vi.resetModules()` does not clear, so a case that re-imports `server.ts`
   * clears them itself (ruling 123). One an earlier case left would be the
   * storage Better Auth's database is, and not the unreachable one these
   * cases build. So each case starts with none held, and closes the one it
   * built.
   */
  const ROOT_STORAGES = Symbol.for("requestport.root-storages");

  async function releaseRootStorages() {
    const holder = globalThis as Record<
      symbol,
      Partial<Record<string, { close(): Promise<void> }>> | undefined
    >;
    const held = holder[ROOT_STORAGES];

    delete holder[ROOT_STORAGES];
    await Promise.all(
      Object.values(held ?? {}).map((storage) => storage?.close()),
    );
  }

  beforeEach(releaseRootStorages);
  afterEach(releaseRootStorages);

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", recordUnhandled);
    vi.resetModules();
    vi.stubEnv("REQUESTPORT_DATABASE_DRIVER", "pg");
    vi.stubEnv("DATABASE_URL", unreachableDatabase);
    // The application root dials only this variable outside a preview (I.2
    // step 5), and a track's `.env.local` sets it: it is unreachable too.
    vi.stubEnv("REQUESTPORT_APPLICATION_DATABASE_URL", unreachableDatabase);
  });

  afterEach(() => {
    process.off("unhandledRejection", recordUnhandled);
    vi.doUnmock("better-auth");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function importServerCountingInstances() {
    const betterAuth = vi.fn();
    vi.doMock("better-auth", async (importOriginal) => {
      const actual = await importOriginal<typeof import("better-auth")>();
      betterAuth.mockImplementation(actual.betterAuth);
      return { ...actual, betterAuth };
    });
    const server = await import("./server.js");
    return { server, betterAuth };
  }

  test("builds nothing and queries nothing as the module is imported", async () => {
    const { server, betterAuth } = await importServerCountingInstances();
    // Long enough for a refused connection to have come back as a rejection.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(betterAuth).not.toHaveBeenCalled();
    // The bearer verifier reads the issuer from `auth.options` at import;
    // that is the composition, and reading it builds nothing either.
    expect(server.auth.options.baseURL).toBe(process.env.BETTER_AUTH_URL);
    expect(betterAuth).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  test("drops an instance whose initialisation failed, and builds afresh on the next use", async () => {
    const { server, betterAuth } = await importServerCountingInstances();

    const first = server.auth.$context;
    // Every member read while it stands is read from the same instance.
    void server.auth.api;
    expect(betterAuth).toHaveBeenCalledTimes(1);
    await expect(first).rejects.toBeInstanceOf(Error);

    // A request after the failure is served by a new instance, which tries
    // the database again, instead of awaiting the first one's rejection.
    await expect(
      server.auth.handler(new Request("http://localhost:3000/api/auth/ok")),
    ).rejects.toBeInstanceOf(Error);
    expect(betterAuth).toHaveBeenCalledTimes(2);
    expect(unhandled).toEqual([]);
  });
});

/*
 * Better Auth's installer and the host's handoff (Plan 13, H.5;
 * manifest-h.md §2.7.1; rulings 141, 145 and 160). While
 * `globalThis[Symbol.for("requestport.host")]` is set, `server.ts` installs
 * the Better Auth it carries, the whole installed object, and calls no
 * factory; a handoff without one is refused as the module is imported, by
 * name, with one console line. Unset, as on Vercel, which never sets it, it
 * composes through `createAuth` as before (the cases above).
 */
describe("server.ts and the host's handoff", () => {
  const HOST = Symbol.for("requestport.host");
  const holder = globalThis as Record<symbol, unknown>;
  /** The fourteen members `server.ts` exports from what it installs. */
  const INSTALLED_MEMBERS = [
    "auth",
    "signInMethods",
    "requireHumanSession",
    "authenticateAgentBearer",
    "operatorCredentialsSwitch",
    "operatorCredentialAvailability",
    "authenticateApiBearer",
    "operatorCredentialService",
    "agentApiKeyService",
    "createAgentApiKey",
    "agentGrantService",
    "oauthAuthorizationServerMetadata",
    "oauthOpenIdConfiguration",
    "assertSignupAllowed",
  ] as const;

  afterEach(() => {
    delete holder[HOST];
    vi.doUnmock("./create-auth.js");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** `server.ts`, freshly imported, with `createAuth` counted and stood in for. */
  async function importServerCountingFactoryCalls() {
    const createAuth = vi.fn(() =>
      Object.fromEntries(
        INSTALLED_MEMBERS.map((member) => [member, { composedHere: member }]),
      ),
    );
    vi.doMock("./create-auth.js", () => ({ createAuth }));
    vi.resetModules();
    return { load: () => import("./server.js"), createAuth };
  }

  test("absent, it installs what createAuth composes, once", async () => {
    const { load, createAuth } = await importServerCountingFactoryCalls();

    expect(HOST in holder).toBe(false);
    const server = await load();

    expect(createAuth).toHaveBeenCalledTimes(1);
    expect(server.auth).toEqual({ composedHere: "auth" });
  });

  test("present, it installs the handoff's Better Auth, all fourteen members, and calls createAuth not at all", async () => {
    const { load, createAuth } = await importServerCountingFactoryCalls();
    const handed = Object.fromEntries(
      INSTALLED_MEMBERS.map((member) => [member, { handed: member }]),
    );
    holder[HOST] = { auth: handed };

    const server = (await load()) as unknown as Record<string, unknown>;

    for (const member of INSTALLED_MEMBERS) {
      expect(server[member], member).toBe(handed[member]);
    }
    expect(createAuth).not.toHaveBeenCalled();
  });

  test("present without a Better Auth, importing it is refused with HostHandoffRefusalError and one console line naming the installer, and createAuth is not called", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { load, createAuth } = await importServerCountingFactoryCalls();
    holder[HOST] = { storage: {}, admitsConstruction: () => true };
    const line =
      "HostHandoffRefusalError: RequestPort's Better Auth installer " +
      "(@requestport/auth/server) refused: the host's handoff is present, " +
      "and it carries no auth. While it is present, the web answers the " +
      "storage, Better Auth and RequestPort it carries and builds none of " +
      "its own (manifest-h.md §2.7.1).";

    const refusal = await load().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((refusal as Error).name).toBe("HostHandoffRefusalError");
    expect(`${(refusal as Error).name}: ${(refusal as Error).message}`).toBe(
      line,
    );
    expect(logged.mock.calls).toEqual([[line]]);
    expect(createAuth).not.toHaveBeenCalled();
  });
});
