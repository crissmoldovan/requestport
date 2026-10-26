import { readFile } from "node:fs/promises";
import type { AgentCredentialSummary, Database } from "@requestport/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * Better Auth's factory and its lifecycle (manifest-g.md §2.12, Done when
 * 15): the lifecycle server.ts had at import, moved unchanged into
 * `createAuth`, with the database a function asked for when an instance is
 * built rather than a handle taken at import.
 */

const env = {
  NODE_ENV: "production" as const,
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "https://requestport.com",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", recordUnhandled);
  vi.resetModules();
});

afterEach(() => {
  process.off("unhandledRejection", recordUnhandled);
  vi.doUnmock("better-auth");
  vi.doUnmock("better-auth/adapters/drizzle");
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The factory, with `betterAuth` counted. */
async function factoryCountingInstances() {
  const betterAuth = vi.fn();
  vi.doMock("better-auth", async (importOriginal) => {
    const actual = await importOriginal<typeof import("better-auth")>();
    betterAuth.mockImplementation(actual.betterAuth);
    return { ...actual, betterAuth };
  });
  const { createAuth } = await import("./create-auth.js");
  return { createAuth, betterAuth };
}

/** A database function nothing may call yet: it fails whoever does. */
function refusingDatabase() {
  return vi.fn((): Database => {
    throw new Error("no database in this test");
  });
}

describe("createAuth's lifecycle", () => {
  test("calling it, and reading auth.options, builds no instance and asks for no database", async () => {
    const { createAuth, betterAuth } = await factoryCountingInstances();
    const database = refusingDatabase();

    const installed = createAuth({ database, env });

    // The bearer verifier read the issuer from `auth.options` as the factory
    // ran; that is the composition, and reading it builds nothing.
    expect(installed.auth.options.baseURL).toBe(env.BETTER_AUTH_URL);
    expect(installed.signInMethods).toEqual({
      github: true,
      magicLink: false,
      localCredential: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(betterAuth).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  test("the first other member builds one instance and asks for the database once", async () => {
    const { createAuth, betterAuth } = await factoryCountingInstances();
    const database = refusingDatabase();
    const installed = createAuth({ database, env });

    const first = installed.auth.$context;
    // Every member read while it stands is read from the same instance.
    void installed.auth.api;

    expect(betterAuth).toHaveBeenCalledTimes(1);
    // Better Auth asks for its adapter as its initialisation starts, inside
    // `betterAuth()` itself.
    expect(database).toHaveBeenCalledTimes(1);
    await expect(first).rejects.toThrow("no database in this test");
    expect(unhandled).toEqual([]);
  });

  test("drops an instance whose initialisation failed, and the next use builds afresh and asks again", async () => {
    const { createAuth, betterAuth } = await factoryCountingInstances();
    const database = refusingDatabase();
    const installed = createAuth({ database, env });

    await expect(installed.auth.$context).rejects.toThrow(
      "no database in this test",
    );
    await expect(
      installed.auth.handler(new Request("http://localhost:3000/api/auth/ok")),
    ).rejects.toThrow("no database in this test");

    expect(betterAuth).toHaveBeenCalledTimes(2);
    expect(database).toHaveBeenCalledTimes(2);
    expect(unhandled).toEqual([]);
  });

  test("builds the signup policy over the database on its first call, and keeps it", async () => {
    const { createAuth } = await factoryCountingInstances();
    // Not a database: the policy's first query fails on it, which is all
    // this needs to see that the repository was built over it.
    const database = vi.fn(() => ({}) as Database);
    const installed = createAuth({ database, env });

    expect(database).not.toHaveBeenCalled();
    await expect(
      installed.assertSignupAllowed("person@example.com"),
    ).rejects.toBeInstanceOf(TypeError);
    expect(database).toHaveBeenCalledTimes(1);
    await expect(
      installed.assertSignupAllowed("person@example.com"),
    ).rejects.toBeInstanceOf(TypeError);
    expect(database).toHaveBeenCalledTimes(1);
  });

  test("builds the repositories it composes over the database when one is first used, and keeps it", async () => {
    const { createAuth } = await factoryCountingInstances();
    const database = vi.fn(() => ({}) as Database);
    const installed = createAuth({ database, env });
    const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";
    const revoke = () =>
      installed.agentGrantService.revokeGrant(
        {
          actor: { type: "user", id: "user_1" },
          organizationId,
          scopes: new Set(["agent:manage"]),
          credentialId: "session_1",
          correlationId: "correlation_1",
        },
        {
          organizationId,
          agentPrincipalId: "1d0f5c6e-2a7b-4c9d-8e1f-3a4b5c6d7e8f",
          grantId: "2e1f6d7a-3b8c-4dae-9f20-4b5c6d7e8f90",
          reason: "the reason this grant is revoked",
          expectedVersion: 1,
          idempotencyKey: "create-auth-test-revoke-0001",
        },
      );

    // Composing the services and the bearer paths asked for nothing.
    expect(database).not.toHaveBeenCalled();
    // Its first query fails on a handle that is not a database: the agent
    // repository was built over what `database()` returned.
    await expect(revoke()).rejects.toBeInstanceOf(TypeError);
    expect(database).toHaveBeenCalledTimes(1);
    await expect(revoke()).rejects.toBeInstanceOf(TypeError);
    expect(database).toHaveBeenCalledTimes(1);
  });
});

/*
 * Better Auth's factory and the host's handoff (Plan 13, H.5; manifest-h.md
 * §2.7.1; ruling 145: the token-gated refusal in `createAuth`, tested on its
 * own; ruling 160). While `globalThis[Symbol.for("requestport.host")]` is
 * set, `createAuth` composes only for a caller whose options carry a
 * construction token the handoff admits, and refuses any other before it
 * composes, by name, with one console line. Unset, as on Vercel, which never
 * sets it, it composes as it always has. It reads the symbols itself:
 * `@requestport/db/wiring` is not in its bundle (`packages/core/bundle.mjs`,
 * `forbiddenModule`).
 */
describe("createAuth and the host's handoff", () => {
  const HOST = Symbol.for("requestport.host");
  const holder = globalThis as Record<symbol, unknown>;
  const refusalLine =
    "HostHandoffRefusalError: RequestPort's createAuth refused: the host's " +
    "handoff is present, and the caller passed no construction token it " +
    "admits. While it is present, the web answers the storage, Better Auth " +
    "and RequestPort it carries and builds none of its own " +
    "(manifest-h.md §2.7.1).";

  afterEach(() => {
    delete holder[HOST];
    vi.restoreAllMocks();
  });

  /** Captures console.error's lines, and prints none. */
  function consoleErrors() {
    return vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  test("absent, it composes as it always has, and writes nothing to the console", async () => {
    const logged = consoleErrors();
    const { createAuth } = await import("./create-auth.js");

    expect(HOST in holder).toBe(false);
    const installed = createAuth({ database: refusingDatabase(), env });

    expect(installed.auth.options.baseURL).toBe(env.BETTER_AUTH_URL);
    expect(logged).not.toHaveBeenCalled();
  });

  test("present, it refuses a caller that passes no token before it composes, with HostHandoffRefusalError and one console line naming createAuth, and asks for no database", async () => {
    const logged = consoleErrors();
    const { createAuth, betterAuth } = await factoryCountingInstances();
    const database = refusingDatabase();
    holder[HOST] = { admitsConstruction: () => true };

    let refusal: unknown;
    try {
      // An environment without an issuer would be refused as the factory
      // composes; here the construction is refused first.
      createAuth({ database, env: {} as typeof env });
    } catch (error) {
      refusal = error;
    }

    expect((refusal as Error).name).toBe("HostHandoffRefusalError");
    expect(`${(refusal as Error).name}: ${(refusal as Error).message}`).toBe(
      refusalLine,
    );
    expect(logged.mock.calls).toEqual([[refusalLine]]);
    expect(database).not.toHaveBeenCalled();
    expect(betterAuth).not.toHaveBeenCalled();
  });

  test("present, it refuses a token the handoff does not admit", async () => {
    const logged = consoleErrors();
    const { createAuth } = await import("./create-auth.js");
    const { withHostConstructionToken } = await import(
      "@requestport/db/wiring"
    );
    const token = Object.freeze({});
    holder[HOST] = {
      admitsConstruction: (candidate: unknown) => candidate === token,
    };

    expect(() =>
      createAuth(
        withHostConstructionToken(
          { database: refusingDatabase(), env },
          Object.freeze({}),
        ),
      ),
    ).toThrow("RequestPort's createAuth refused");
    expect(logged.mock.calls).toEqual([[refusalLine]]);
  });

  test("present, it composes for the token the handoff admits, handed through @requestport/db/wiring's withHostConstructionToken, and writes nothing to the console", async () => {
    const logged = consoleErrors();
    const { createAuth } = await import("./create-auth.js");
    const { withHostConstructionToken } = await import(
      "@requestport/db/wiring"
    );
    const token = Object.freeze({});
    const asked: unknown[] = [];
    holder[HOST] = {
      admitsConstruction: (candidate: unknown) => {
        asked.push(candidate);
        return candidate === token;
      },
    };

    const installed = createAuth(
      withHostConstructionToken({ database: refusingDatabase(), env }, token),
    );

    expect(installed.auth.options.baseURL).toBe(env.BETTER_AUTH_URL);
    expect(asked).toEqual([token]);
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("createAuth's agent key minter", () => {
  test("mints through the instance under the requestport-agent configuration, and is the minter the agent key service issues with", async () => {
    const createApiKey = vi.fn(async () => ({
      id: "better-auth-key-1",
      key: "rp_plaintext-key",
      prefix: "rp_",
      start: "plai",
      expiresAt: null,
    }));
    vi.doMock("better-auth", async (importOriginal) => {
      const actual = await importOriginal<typeof import("better-auth")>();
      return {
        ...actual,
        betterAuth: () => ({
          api: { createApiKey },
          $context: Promise.resolve({}),
        }),
      };
    });
    const { createAuth } = await import("./create-auth.js");
    const installed = createAuth({ database: refusingDatabase(), env });

    await expect(
      installed.createAgentApiKey({
        name: "Build agent",
        userId: "user_1",
        expiresIn: 3_600,
      }),
    ).resolves.toMatchObject({ id: "better-auth-key-1" });
    expect(createApiKey.mock.calls).toEqual([
      [
        {
          body: {
            configId: "requestport-agent",
            name: "Build agent",
            userId: "user_1",
            expiresIn: 3_600,
          },
        },
      ],
    ]);

    // One minting call under that configuration, and the service is handed
    // the function returned, not a second copy of it.
    const factorySource = await readFile(
      new URL("./create-auth.ts", import.meta.url),
      "utf8",
    );
    expect(
      factorySource.match(
        /auth\.api\.createApiKey\(\{\s*body: \{\s*configId: "requestport-agent"/gu,
      ),
    ).toHaveLength(1);
    expect(factorySource).toMatch(
      /createAgentApiKeyService\(\{\s*createApiKey: createAgentApiKey,/u,
    );
  });
});

/*
 * The two agent services `createAuth` composes, the instances the web's key,
 * rotation and consent forms call through `@requestport/auth/server`, run the
 * command bus's re-check of a person (ruling 233 item 2) with the repository
 * `createAuth` builds over its database. Composed without one, each refuses
 * a person as `configuration_error`, and `tsc` cannot see the omission: the
 * dependency is optional in core's types. Here db's
 * `createCommandAuthorizationRepository` is replaced by a re-check that
 * records what it is asked and refuses in the bus's words, so each call
 * stops there.
 */
describe("createAuth's agent services and the bus's re-check of a person", () => {
  afterEach(() => {
    vi.doUnmock("@requestport/db");
  });

  test("issue, rotate and bindConsent for a person run the re-check createAuth builds over its database, and refuse in its words", async () => {
    const built: unknown[] = [];
    const asked: unknown[] = [];
    vi.doMock("@requestport/db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@requestport/db")>();
      const { DomainError } = await import("@requestport/domain");
      return {
        ...actual,
        createCommandAuthorizationRepository: (database: unknown) => {
          built.push(database);
          return {
            assertCurrent: async (context: unknown) => {
              asked.push(context);
              throw new DomainError(
                "forbidden",
                "Current human authorization is no longer active",
              );
            },
          };
        },
      };
    });
    const { createAuth } = await import("./create-auth.js");
    const handle = {} as Database;
    const database = vi.fn(() => handle);
    const installed = createAuth({ database, env });
    const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";
    const agentPrincipalId = "1d0f5c6e-2a7b-4c9d-8e1f-3a4b5c6d7e8f";
    const projectId = "3f2a7e8b-4c9d-4ebf-8a31-5c6d7e8f9a01";
    const person = (credentialId: string) => ({
      actor: { type: "user" as const, id: "user_1" },
      organizationId,
      scopes: new Set(["agent:manage"]),
      credentialId,
      correlationId: `correlation_${credentialId}`,
    });
    const issuing = person("session_issue");
    const rotating = person("session_rotate");
    const consenting = person("session_consent");
    const refusal = {
      code: "forbidden",
      message: "Current human authorization is no longer active",
    };
    const credential: AgentCredentialSummary = {
      id: "4a3b8f9c-5dae-4fc0-9b42-6d7e8f9a0b12",
      issuedByGrantId: null,
      agentPrincipalId,
      name: "Build agent key",
      prefix: "rp_abcd",
      fingerprint: "fingerprint_1",
      audience: "api",
      projectId,
      laneIds: [],
      scopes: ["request:read"],
      version: 1,
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      overlapExpiresAt: null,
      lastUsedAt: null,
      createdByUserId: "user_1",
      createdAt: new Date(),
    };

    await expect(
      installed.agentApiKeyService.issue(
        issuing,
        {
          organizationId,
          agentPrincipalId,
          projectId,
          name: "Build agent key",
          audience: "api",
          scopes: ["request:read"],
        },
        { idempotencyKey: "create-auth-test-issue-0001", expectedVersion: 0 },
      ),
    ).rejects.toMatchObject(refusal);
    await expect(
      installed.agentApiKeyService.rotate(rotating, {
        organizationId,
        credential,
        overlapMinutes: 5,
        meta: {
          idempotencyKey: "create-auth-test-rotate-0001",
          expectedVersion: 1,
        },
      }),
    ).rejects.toMatchObject(refusal);
    await expect(
      installed.agentGrantService.bindConsent(consenting, {
        organizationId,
        agentPrincipalId,
        projectId,
        clientId: "client_1",
        audience: "mcp",
        scopes: ["request:read"],
        expectedVersion: 0,
        idempotencyKey: "create-auth-test-consent-0001",
      }),
    ).rejects.toMatchObject(refusal);

    // Each call was stopped by the re-check, asked about the person's own
    // context, and that re-check was built once, over `database()`'s handle.
    expect(asked).toEqual([issuing, rotating, consenting]);
    expect(built).toEqual([handle]);
  });
});

/*
 * The last-use stamps the bearer path `createAuth` composes calls (ruling
 * 261). The bearer path's own suites hand it stamps of their own, so this is
 * the one place the production wiring is pinned: db's
 * `createAgentAuthRepository` is replaced by one whose two stamps record
 * what they are asked, and `createAuthenticateAgentBearer` by the real one,
 * with the dependencies `createAuth` hands it kept.
 */
describe("createAuth's bearer path and the last-use stamps", () => {
  afterEach(() => {
    vi.doUnmock("@requestport/db");
    vi.doUnmock("./agent/authenticate-bearer.js");
  });

  test("an OAuth grant is stamped through the repository's touchOAuthGrant, and an API key through its touchCredential", async () => {
    const touchCredential = vi.fn(async () => true);
    const touchOAuthGrant = vi.fn(async () => true);
    vi.doMock("@requestport/db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@requestport/db")>();
      return {
        ...actual,
        createAgentAuthRepository: () => ({ touchCredential, touchOAuthGrant }),
      };
    });
    type Dependencies = Parameters<
      typeof import("./agent/authenticate-bearer.js").createAuthenticateAgentBearer
    >[0];
    const handed: Dependencies[] = [];
    vi.doMock("./agent/authenticate-bearer.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("./agent/authenticate-bearer.js")>();
      return {
        ...actual,
        createAuthenticateAgentBearer: (dependencies: Dependencies) => {
          handed.push(dependencies);
          return actual.createAuthenticateAgentBearer(dependencies);
        },
      };
    });
    const { createAuth } = await import("./create-auth.js");
    createAuth({ database: vi.fn(() => ({}) as Database), env });

    expect(handed).toHaveLength(1);
    const [dependencies] = handed;
    if (!dependencies) throw new Error("the bearer path was not composed");

    await dependencies.touchOAuthGrant("grant_1", "organization_1");
    expect(touchOAuthGrant.mock.calls).toEqual([["grant_1", "organization_1"]]);
    expect(touchCredential).not.toHaveBeenCalled();

    await dependencies.touchCredential?.("credential_1", "organization_1");
    expect(touchCredential.mock.calls).toEqual([
      ["credential_1", "organization_1"],
    ]);
    expect(touchOAuthGrant).toHaveBeenCalledTimes(1);
  });
});

/** Where `@requestport/db`'s role guard keeps this process's declaration. */
const DECLARATION = Symbol.for("requestport.database-surface");

type DeclarationHolder = Record<symbol, unknown>;

/**
 * The installer, over a database nothing answers on, with every database
 * `drizzleAdapter` is handed recorded.
 */
async function installerRecordingAdapters() {
  vi.stubEnv("REQUESTPORT_DATABASE_DRIVER", "pg");
  vi.stubEnv(
    "DATABASE_URL",
    "postgres://requestport:requestport@127.0.0.1:1/requestport",
  );
  // The application root dials only this variable outside a preview (I.2
  // step 5), and a track's `.env.local` sets it: it names nothing either.
  vi.stubEnv(
    "REQUESTPORT_APPLICATION_DATABASE_URL",
    "postgres://requestport:requestport@127.0.0.1:1/requestport",
  );
  const handedTo: unknown[] = [];
  vi.doMock("better-auth/adapters/drizzle", async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("better-auth/adapters/drizzle")>();
    return {
      ...actual,
      drizzleAdapter: (database: unknown, config: never) => {
        handedTo.push(database);
        return actual.drizzleAdapter(database as never, config);
      },
    };
  });

  const server = await import("./server.js");
  return { server, handedTo };
}

describe("server.ts, the installer", () => {
  test("hands Better Auth the web process's application storage", async () => {
    const { server, handedTo } = await installerRecordingAdapters();
    const { applicationStorageFromEnv } = await import(
      "@requestport/db/wiring"
    );

    expect(handedTo).toEqual([]);
    // Building the instance asks for the adapter, over the storage the web
    // root gets from the same function.
    await expect(server.auth.$context).rejects.toBeInstanceOf(Error);
    expect(handedTo).toHaveLength(1);
    expect(handedTo[0]).toBe(applicationStorageFromEnv().db);

    // And the same storage from another copy of the wiring, as a bundler's
    // second copy of the module would answer it (manifest-g.md §2.12, Done
    // when 15): the wiring keeps it for the process, not for its module.
    vi.resetModules();
    const fresh = await import("@requestport/db/wiring");

    expect(handedTo[0]).toBe(fresh.applicationStorageFromEnv().db);
    expect(unhandled).toEqual([]);
  });

  /*
   * What the case above does not show is that the installer asks the
   * application root, rather than some other storage it could reach: the
   * root's declaration check tells them apart, so this builds the instance
   * in a process that has declared nothing.
   */
  test("asks the application root, which refuses an undeclared process before Better Auth is handed a database", async () => {
    const { server, handedTo } = await installerRecordingAdapters();
    const { DatabaseSurfaceError } = await import("@requestport/db");
    const holder = globalThis as DeclarationHolder;
    const declared = holder[DECLARATION];

    delete holder[DECLARATION];
    let refusal: unknown;
    try {
      refusal = await server.auth.$context.then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      holder[DECLARATION] = declared;
    }

    expect(refusal).toBeInstanceOf(DatabaseSurfaceError);
    expect((refusal as Error).message).toContain(
      'the application root builds no storage until its entry point has called declareDatabaseSurface("application")',
    );
    expect(handedTo).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});

/*
 * `auth:schema` (`packages/auth/package.json`) runs the Better Auth CLI over
 * the module its `--config` names (ruling 120). That process is an entry
 * point, so the module declares its database surface before the installer
 * is loaded (ruling 37). The CLI's loader merges the module's `auth` with
 * `defu`, which spreads it, so `{ ...auth }` is what the CLI reads.
 */
describe("auth:schema's configuration", () => {
  test("declares the operator surface before it loads the installer, and hands the CLI the composition as a plain object", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const configPath = /--config (\S+)/u.exec(
      manifest.scripts["auth:schema"] ?? "",
    )?.[1];
    expect(configPath).toBeDefined();

    const { declaredDatabaseSurface } = await import("@requestport/db");
    let declaredAsTheInstallerLoads: unknown = "never loaded";
    vi.doMock("./server.js", async (importOriginal) => {
      declaredAsTheInstallerLoads = declaredDatabaseSurface();
      return importOriginal();
    });
    const holder = globalThis as DeclarationHolder;
    const declared = holder[DECLARATION];
    let config: { auth?: object } = {};
    let declaredOnceLoaded: unknown;
    let installed: typeof import("./server.js") | undefined;

    delete holder[DECLARATION];
    try {
      config = await import(
        new URL(`../${configPath}`, import.meta.url).pathname
      );
      declaredOnceLoaded = declaredDatabaseSurface();
      installed = await import("./server.js");
    } finally {
      holder[DECLARATION] = declared;
      vi.doUnmock("./server.js");
    }

    expect(declaredAsTheInstallerLoads).toBe("operator");
    expect(declaredOnceLoaded).toBe("operator");
    expect({ ...config.auth }).toEqual({ options: installed?.auth.options });
  });
});
