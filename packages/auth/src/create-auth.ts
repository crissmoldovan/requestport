import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { signInMethodsFor } from "@requestport/config/sign-in-methods";
import {
  createAgentApiKeyService,
  createAgentGrantService,
} from "@requestport/core/agent-services";
import {
  createAgentAuthRepository,
  createAgentRepository,
  createCommandAuthorizationRepository,
  createOperatorCredentialRepository,
  type Database,
  identitySchema,
} from "@requestport/db";
import {
  type OperatorCredentialAvailability,
  type OperatorCredentialSwitch,
  operatorApiKeyConfigId,
} from "@requestport/domain";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  createAuthenticateAgentBearer,
  createAuthenticateApiBearer,
} from "./agent/authenticate-bearer.js";
import { createDatabaseSignupPolicy } from "./database-signup-policy.js";
import { createOperatorCredentialService } from "./operator/operator-credential-service.js";
import { operatorCredentialSwitch } from "./operator/operator-switch.js";
import { composeAuthDatabase } from "./restricted-adapter.js";
import type { ServerMagicLinkSender } from "./server-magic-link.js";
import {
  createAgentAccessTokenVerifierFor,
  createAuthOptions,
} from "./server-options.js";
import { createRequireHumanSession } from "./server-session.js";

/**
 * What the bearer authenticators `createAuth` composes answer, and the
 * audience an agent credential names, as types only: `@requestport/mcp` and
 * `@requestport/server` name them through this published subpath (Plan 13,
 * H.7's fourth round; ruling 193 item 3), not through the package's `.`,
 * which installs Better Auth from the process's environment as it is
 * imported (`server.ts`) and is not published.
 */
export type {
  AgentAudience,
  AgentAuthContext,
  ApiAuthContext,
} from "./agent/authenticate-bearer.js";

/**
 * What the factory composes from: the configuration `createAuthOptions` and
 * `signInMethodsFor` read, and the operator credentials' switch. One object,
 * handed to both, so the two answers cannot disagree.
 */
export type CreateAuthEnvironment = Parameters<
  typeof createAuthOptions
>[0]["env"] &
  Parameters<typeof signInMethodsFor>[0] & {
    REQUESTPORT_OPERATOR_CREDENTIALS?: "enabled" | "disabled" | undefined;
  };

export interface CreateAuthOptions {
  /**
   * The database Better Auth and its repositories run on. Called when Better
   * Auth builds an instance, and when a repository is first used: never
   * while the factory composes.
   */
  database: () => Database;
  env: CreateAuthEnvironment;
  /** Absent, the composition offers no magic link. */
  sendMagicLink?: ServerMagicLinkSender;
}

/**
 * A stand-in for the repository `create` builds, which builds it the first
 * time anything is read from it, and forwards to it from then on.
 */
function builtOnFirstUse<T extends object>(create: () => T): T {
  let built: T | undefined;

  return new Proxy({} as T, {
    get(_target, property) {
      built ??= create();
      return Reflect.get(built, property);
    },
    has(_target, property) {
      built ??= create();
      return Reflect.has(built, property);
    },
  });
}

/*
 * The host's handoff (Plan 13, H.5; manifest-h.md §2.7.1; rulings 145 and
 * 160): `globalThis[Symbol.for("requestport.host")]`, which a host that
 * serves Next's request handler in its own process sets to what it built.
 * While it is set, `createAuth` composes only for a caller whose options
 * carry a construction token its `admitsConstruction` admits, under the key
 * `withHostConstructionToken` (`@requestport/db/wiring`) writes, and refuses
 * any other before it composes, with one console line. Where nothing sets
 * it, as on Vercel, it composes as it always has. Both symbols are read here
 * rather than through `@requestport/db/wiring`, which this module's bundle
 * may not carry (`packages/core/bundle.mjs`, `forbiddenModule`).
 */
const HOST_HANDOFF = Symbol.for("requestport.host");
const HOST_CONSTRUCTION_TOKEN = Symbol.for(
  "requestport.host-construction-token",
);

/**
 * Throws, after its console line, unless the handoff is unset, or `options`
 * carries a token its `admitsConstruction` admits: options without a token
 * are refused without asking.
 */
function refuseUnlessHostAdmits(options: object): void {
  const handoff: unknown = (globalThis as Record<symbol, unknown>)[
    HOST_HANDOFF
  ];

  if (handoff === undefined) return;
  const admits =
    typeof handoff === "object" && handoff !== null
      ? (handoff as { admitsConstruction?: unknown }).admitsConstruction
      : undefined;
  const token = (options as unknown as Record<symbol, unknown>)[
    HOST_CONSTRUCTION_TOKEN
  ];

  if (
    token !== undefined &&
    typeof admits === "function" &&
    admits.call(handoff, token) === true
  ) {
    return;
  }
  const refusal = new Error(
    "RequestPort's createAuth refused: the host's handoff is present, and " +
      "the caller passed no construction token it admits. While it is " +
      "present, the web answers the storage, Better Auth and RequestPort it " +
      "carries and builds none of its own (manifest-h.md §2.7.1).",
  );

  refusal.name = "HostHandoffRefusalError";
  console.error(`${refusal.name}: ${refusal.message}`);
  throw refusal;
}

/**
 * Better Auth for one process (manifest-g.md §2.12, option (A)): the
 * composition, the lazy instance, and everything built over either.
 * `server.ts` installs it for the web process.
 *
 * Composing reads its configuration and opens no connection. The database
 * is asked for only when Better Auth builds an instance and when a
 * repository below is first used. While the host's handoff is set, it
 * composes only for the token the handoff admits (above): the token is a
 * symbol-keyed property of the options, which the rest below keeps, since
 * object rest copies symbol-keyed properties too. The three options stay
 * destructured where they are received, which is where the tenant-scope
 * sweep (`packages/db/src/tenant-scope-sweep.test.ts`) follows `database`.
 */
export function createAuth({
  database,
  env,
  sendMagicLink,
  ...rest
}: CreateAuthOptions) {
  refuseUnlessHostAdmits(rest);
  /**
   * Which ways in this deployment offers. The composition below reaches the
   * same answer on its own — GitHub from its pair, the magic link from
   * whether a sender was handed in, which `server.ts` does exactly when the
   * Resend pair is present, the local credential by the same rule — and
   * both are tested over the same combinations, on and off Vercel:
   * `sign-in-methods.test.ts` in `@requestport/config`, and
   * `server-options.sign-in-methods.test.ts` here.
   */
  const signInMethods = signInMethodsFor(env);
  const agentAuthRepository = builtOnFirstUse(() =>
    createAgentAuthRepository(database()),
  );
  const agentRepository = builtOnFirstUse(() =>
    createAgentRepository(database()),
  );
  /*
    The command bus's re-check of a person (`assertCurrent`), which the agent
    key service runs before it issues or rotates a key for a person, and the
    grant service before it binds a person's consent (ruling 233 item 2).
    Built without the operator switch: those calls admit a person only.
  */
  const commandAuthorization = builtOnFirstUse(() =>
    createCommandAuthorizationRepository(database()),
  );
  const assertSignupAllowed = createDatabaseSignupPolicy(database);

  /*
    Composed as the factory is called, so a refusal here — an issuer that
    cannot be served, CIMD switched on without its allowlist — is a refusal
    of whatever calls it. Composing reads configuration only; it opens no
    connection. Better Auth calls the adapter factory once, as each instance
    starts its initialisation, and that is when `database()` is asked.
  */
  const authOptions = createAuthOptions({
    database: composeAuthDatabase((options) =>
      drizzleAdapter(database(), {
        provider: "pg",
        schema: identitySchema,
        transaction: true,
      })(options),
    ),
    env,
    assertSignupAllowed,
    sendMagicLink,
    resolveAgentGrantBindingFingerprints: (input) =>
      agentAuthRepository.listOAuthGrantBindingFingerprints(input),
    repairUnboundAgentConsent: (input) =>
      agentAuthRepository.invalidateUnboundOAuthProviderAuthorization(input),
  });

  function instantiateAuth() {
    return betterAuth(authOptions);
  }

  type Auth = ReturnType<typeof instantiateAuth>;

  let instance: Auth | undefined;

  /**
   * The Better Auth instance, built on first use rather than when the
   * factory is called.
   *
   * `betterAuth()` starts its initialisation at once and keeps the promise
   * for the life of the instance (`better-auth@1.7.6`
   * `dist/auth/base.mjs:9`), with nothing attached to catch a rejection.
   * Under 1.7.6 that initialisation reads and writes the database: the OAuth
   * provider seeds its `resources` into `oauth_resource`
   * (`@better-auth/oauth-provider@1.7.6` `authorize-CLuqtSXQ.mjs:4407`,
   * `introspect-CbYi2MJT.mjs:805-870`). It means to tolerate two errors, a
   * missing table and a row another instance inserted first, and recognises
   * both by matching the error's message. Through Drizzle that message is
   * "Failed query: …", with Postgres's own words only on its `cause`, so
   * neither match can succeed and both would reject. `composeAuthDatabase`
   * restores the second: it hands the seed a duplicate identifier with
   * Postgres's message, and the seed skips the row (`restricted-adapter.ts`).
   * A missing table still rejects.
   *
   * Built at import, the instance made every importer — `next build`
   * collecting routes, a test runner listing files — query whatever
   * `DATABASE_URL` named, and a database it could not reach became an
   * unhandled rejection. It also meant a seed that failed once, at a cold
   * start, failed every later request on that instance, because each one
   * awaits the same rejected promise.
   *
   * So the instance is built when something first asks for it. If its
   * initialisation rejects, it is dropped, and the next use builds a fresh
   * one; every request that took the instance before the rejection still
   * fails with it. The seed is insert-only and idempotent, so running it
   * again costs one lookup per resource, and once the rows exist it inserts
   * nothing.
   */
  function currentAuth(): Auth {
    if (instance) return instance;
    const created = instantiateAuth();
    instance = created;
    created.$context.catch(() => {
      if (instance === created) instance = undefined;
    });
    return created;
  }

  /**
   * Stands for the instance `currentAuth()` returns, member for member, and
   * builds nothing until a member is read. `options` is answered from the
   * composition itself, which is the object the instance carries
   * (`dist/auth/base.mjs:57`), so reading it builds nothing either.
   */
  const auth: Auth = new Proxy({} as Auth, {
    get(_target, property) {
      if (property === "options") return authOptions;
      return Reflect.get(currentAuth(), property);
    },
    has(_target, property) {
      return Reflect.has(currentAuth(), property);
    },
  });

  const requireHumanSession = createRequireHumanSession(
    (input: { headers: Headers }) => auth.api.getSession(input),
  );

  const agentAudiences = {
    mcp: new URL("/mcp", env.BETTER_AUTH_URL).toString(),
    api: new URL("/api/v1", env.BETTER_AUTH_URL).toString(),
  } as const;

  const authenticateAgentBearer = createAuthenticateAgentBearer({
    audiences: agentAudiences,
    /*
      The provider appends this to the audience of any token granted
      `openid`, which is an offered scope. Naming it is what lets the count
      below stay "exactly one resource" instead of becoming "one or two of
      anything".
    */
    userinfoAudience: new URL(
      "/api/auth/oauth2/userinfo",
      env.BETTER_AUTH_URL,
    ).toString(),
    verifyApiKey: async (key) => {
      const result = await auth.api.verifyApiKey({
        body: { key, configId: "requestport-agent" },
      });
      return { valid: result.valid, key: result.key };
    },
    /*
      Verified against the resource it was minted for, not the issuer's
      origin.

      `auth.api.verifyJWT` compares `aud` to the origin and takes no override
      for it, so every access token this application issues — each carrying
      `…/mcp` or `…/api/v1`, which is what a resource indicator is for —
      failed with `unexpected "aud" claim value`. The bearer path read that
      as an invalid token and refused every agent request. Which of the two
      was required is still decided by `exactAudience` below, on the
      endpoint that was asked.
    */
    verifyJwt: createAgentAccessTokenVerifierFor(
      auth,
      Object.values(agentAudiences),
    ),
    resolveApiKey: (input) =>
      agentAuthRepository.resolveApiKeyCredential(input),
    resolveOAuth: (input) => agentAuthRepository.resolveOAuthGrant(input),
    touchCredential: (credentialId, organizationId) =>
      agentAuthRepository.touchCredential(credentialId, organizationId),
  });

  /*
    Operator credentials (Plan 13, F.3). Off unless F3-14's answer is on: the
    configuration's REQUESTPORT_OPERATOR_CREDENTIALS is `enabled`, the Better
    Auth composition above closes /change-password, and migration 0018's
    table exists. The composition is fixed for the life of the factory's
    result, so the first two are read once, from the same resolved context
    the router reads; the table is asked each time, since the migration runs
    after the deploy (R2).
  */
  const operatorCredentials = builtOnFirstUse(() =>
    createOperatorCredentialRepository(database()),
  );
  let operatorSwitch: Promise<OperatorCredentialSwitch> | undefined;

  /** F3-14's switch for this deployment: the variable and the guard. */
  function operatorCredentialsSwitch(): Promise<OperatorCredentialSwitch> {
    operatorSwitch ??= auth.$context.then(
      (context) =>
        operatorCredentialSwitch({
          variable: env.REQUESTPORT_OPERATOR_CREDENTIALS,
          authContext: context,
        }),
      (error: unknown) => {
        operatorSwitch = undefined;
        throw error;
      },
    );
    return operatorSwitch;
  }

  /** F3-14's whole answer, with the reason the page shows when it is off. */
  async function operatorCredentialAvailability(): Promise<OperatorCredentialAvailability> {
    return operatorCredentials.availability(await operatorCredentialsSwitch());
  }

  /**
   * The `/api/v1/[[...path]]` route's bearer path: agents as
   * `authenticateAgentBearer` admits them for the `api` audience, and
   * operator keys, verified under the operator configuration and resolved
   * through their binding row. `/mcp` and the artifact upload keep calling
   * `authenticateAgentBearer`, which refuses an operator key.
   */
  const authenticateApiBearer = createAuthenticateApiBearer({
    authenticateAgentBearer,
    operatorCredentialsAvailable: async () =>
      (await operatorCredentialAvailability()).available,
    verifyOperatorKey: async (key) => {
      const result = await auth.api.verifyApiKey({
        body: { key, configId: operatorApiKeyConfigId },
      });
      return { valid: result.valid, key: result.key };
    },
    resolveOperatorKey: (input) =>
      operatorCredentials.resolveApiKeyCredential(input),
    touchOperatorCredential: (credentialId, organizationId) =>
      operatorCredentials.touchCredential(credentialId, organizationId),
  });

  /**
   * Issuing and rotating operator credentials, for the `/settings/operators`
   * page (F3-7, F3-8): a person in a session only, and nothing while F3-14's
   * answer is off. The key is created server-side under the operator
   * configuration; the binding row is what gives it any authority.
   */
  const operatorCredentialService = createOperatorCredentialService({
    availability: operatorCredentialAvailability,
    createApiKey: async ({ name, userId, expiresIn }) =>
      auth.api.createApiKey({
        body: { configId: operatorApiKeyConfigId, name, userId, expiresIn },
      }),
    repository: operatorCredentials,
    fingerprintSecret: env.BETTER_AUTH_SECRET,
  });

  /**
   * Mints an agent API key, through the instance, under the
   * `requestport-agent` configuration. The agent key service below issues
   * and rotates with it, and it is returned as well, so that core's
   * `provision_agent` mints through this same function (manifest-g.md §2.5;
   * `RequestPortBetterAuth.createAgentApiKey`, `@requestport/core`), since
   * core imports no Better Auth.
   */
  const createAgentApiKey = async ({
    name,
    userId,
    expiresIn,
  }: {
    name: string;
    userId: string;
    expiresIn: number;
  }) =>
    auth.api.createApiKey({
      body: {
        configId: "requestport-agent",
        name,
        userId,
        expiresIn,
      },
    });

  const agentApiKeyService = createAgentApiKeyService({
    createApiKey: createAgentApiKey,
    authRepository: agentAuthRepository,
    agentRepository,
    authorization: commandAuthorization,
    fingerprintSecret: env.BETTER_AUTH_SECRET,
  });

  const agentGrantService = createAgentGrantService({
    authRepository: agentAuthRepository,
    agentRepository,
    authorization: commandAuthorization,
    fingerprintSecret: env.BETTER_AUTH_SECRET,
  });

  const oauthAuthorizationServerMetadata: (
    request: Request,
  ) => Promise<Response> = oauthProviderAuthServerMetadata(auth);
  const oauthOpenIdConfiguration: (request: Request) => Promise<Response> =
    oauthProviderOpenIdConfigMetadata(auth);

  return {
    auth,
    signInMethods,
    requireHumanSession,
    authenticateAgentBearer,
    operatorCredentialsSwitch,
    operatorCredentialAvailability,
    authenticateApiBearer,
    operatorCredentialService,
    agentApiKeyService,
    createAgentApiKey,
    agentGrantService,
    oauthAuthorizationServerMetadata,
    oauthOpenIdConfiguration,
    assertSignupAllowed,
  };
}
