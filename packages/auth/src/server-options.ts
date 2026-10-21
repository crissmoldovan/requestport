import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource as pinnedMetadataFetch } from "@better-auth/cimd/node";
import {
  type ClientMetadataResourceFetch,
  oauthProvider,
} from "@better-auth/oauth-provider";
import { localCredentialEnabled } from "@requestport/config/sign-in-methods";
import {
  hashLocalCredential,
  verifyLocalCredential,
} from "@requestport/domain";
import {
  APIError,
  type BetterAuthOptions,
  type BetterAuthPlugin,
} from "better-auth";
import {
  createAuthMiddleware,
  formCsrfMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { magicLink } from "better-auth/plugins/magic-link";
import { z } from "zod";
import { requestportAgentGrantFamiliesClaim } from "./agent/authenticate-bearer.js";
import { createAgentAccessTokenVerifier } from "./agent/verify-access-token.js";
import {
  createCimdOriginPredicate,
  parseCimdAllowedOrigins,
} from "./cimd-origin-allowlist.js";
import {
  normalizeSignupEmail,
  SignupPolicyDeniedError,
} from "./signup-policy.js";

type AuthEnvironment = {
  NODE_ENV: "development" | "test" | "production";
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  REQUESTPORT_LOCAL_CREDENTIAL?: "enabled" | "disabled";
  /*
    Not part of the parsed configuration: `server.ts` reads it from the
    process and hands it over, and a test there holds it to doing so. Absent
    means "not a Vercel deployment", where the local credential may be on.
  */
  VERCEL_ENV?: string | undefined;
  /*
    Strings, judged here rather than in `@requestport/config`: only
    "enabled" turns Client ID Metadata Documents on, and the list is parsed
    only then. The Trigger worker parses the same configuration and never
    composes Better Auth, so a stray value must not make its parse throw.
  */
  REQUESTPORT_OAUTH_CIMD?: string | undefined;
  REQUESTPORT_OAUTH_CIMD_ALLOWED_ORIGINS?: string | undefined;
};

function isLoopbackHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/u, "");

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host)
  );
}

/**
 * Whether a URL can be the OAuth issuer exactly as written.
 *
 * `@better-auth/oauth-provider` 1.7.6 advertises its issuer through
 * `validateIssuerUrl`, which rewrites any scheme but https on a host that is
 * not loopback to https, and drops a query and a fragment. Tokens are signed
 * with the issuer as configured. A URL that function would change therefore
 * advertises one issuer and mints another, and a client comparing a token's
 * `iss` to the discovery document refuses every token — on a self-host over
 * plain http on an internal name, silently. The loopback test here is a subset
 * of Better Auth's (`localhost`, `*.localhost`, 127.0.0.0/8, `[::1]`), so
 * anything it accepts over http Better Auth leaves alone. A trailing slash is
 * not refused: `issuerFor` drops it, as Better Auth does.
 *
 * A user name or a password is refused too (Plan 13, H.3). This URL is
 * published as it is written, less a trailing slash: the protected-resource
 * documents name it as the authorization server and build the agent
 * resources from it, as `createAuthOptions` does below, so a credential in it
 * would be handed to every agent that reads discovery. `isBindableServer` in
 * `packages/client/src/project.ts` restates this rule for a checkout's
 * binding, and both are held to `packages/client/src/origin-rule.cases.json`
 * (`server-options.origin-rule.test.ts` here; manifest-h.md §2.8.1). The
 * binding also refuses a path, which this does not.
 */
function isServableIssuerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.search || url.hash || value.includes("#") || value.includes("?")) {
      return false;
    }
    if (url.protocol === "https:") return true;

    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Refuses an issuer Better Auth would advertise differently from the one it
 * signs with.
 *
 * Here rather than in `@requestport/config`: the Trigger worker parses that
 * configuration and never composes Better Auth, and a check it cannot need
 * should not be a way for every task that reads `serverEnv` to throw. The web
 * application composes Better Auth as `server.ts` is imported, so it still
 * refuses to serve on such a URL.
 */
function assertServableIssuer(betterAuthUrl: string) {
  if (isServableIssuerUrl(betterAuthUrl)) return;

  throw new Error(
    "BETTER_AUTH_URL is the OAuth issuer: it must be https, or http on a loopback host, with no user name, password, query or fragment — otherwise the issuer advertised to agents differs from the one their tokens carry, or publishes a credential",
  );
}

/**
 * The issuer, in the canonical form the OAuth provider advertises.
 *
 * `@better-auth/oauth-provider` 1.7.6 publishes, in both discovery documents,
 * `validateIssuerUrl` of the JWT plugin's `issuer` (falling back to `baseURL`
 * when none is set): the URL with its trailing slash, query and fragment
 * removed, and an http scheme on a non-loopback host rewritten to https.
 * Tokens are signed with that `issuer` exactly as given, untouched. So the
 * configured issuer must already be canonical, or the tokens and discovery
 * disagree; this is that form. The scheme rewrite is not repeated here:
 * `createAuthOptions` refuses a URL that would need it before it calls this.
 * For `https://requestport.com` the result is the input.
 */
export function issuerFor(betterAuthUrl: string) {
  return new URL(betterAuthUrl).toString().replace(/\/$/u, "");
}

/** The `issuer` the composition's JWT plugin signs with. */
function signingIssuer(options: BetterAuthOptions) {
  const plugin = (options.plugins ?? []).find(
    (candidate) => candidate.id === "jwt",
  ) as { options?: { jwt?: { issuer?: unknown } } } | undefined;
  const issuer = plugin?.options?.jwt?.issuer;
  if (typeof issuer !== "string" || issuer.length === 0) {
    throw new Error("The composition signs no agent access token issuer");
  }
  return issuer;
}

/**
 * The bearer verifier for agent access tokens, built from the Better Auth
 * instance that mints them.
 *
 * The expected `iss` is read from that instance's own JWT plugin rather than
 * derived again from `BETTER_AUTH_URL`, so it is the string the tokens carry
 * by construction: a second spelling (with a trailing slash, say) would
 * refuse every agent token the instance issues.
 */
export function createAgentAccessTokenVerifierFor(
  auth: {
    options: BetterAuthOptions;
    api: { getJwks: () => Promise<{ keys: unknown[] }> };
  },
  audiences: readonly string[],
) {
  return createAgentAccessTokenVerifier({
    audiences,
    issuer: signingIssuer(auth.options),
    jwks: async () => await auth.api.getJwks(),
  });
}

const productionOrigins = [
  "https://requestport.com",
  "https://staging.requestport.com",
  "https://*.preview.requestport.com",
  "https://requestport.vercel.app",
  "https://requestport-*-cueplusplus.vercel.app",
] as const;

// Mirrors Better Auth 1.7.6's magic-link signInMagicLinkBodySchema, field for
// field (re-read on the upgrade from 1.6.29; the fields did not change). The
// eligibility preflight must not accept a body the pinned endpoint rejects.
const signInMagicLinkBodySchema = z.object({
  email: z.email(),
  name: z.string().optional(),
  callbackURL: z.string().optional(),
  newUserCallbackURL: z.string().optional(),
  errorCallbackURL: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

/**
 * Whether the request being served is the one this hook is about.
 *
 * `/oauth2/consent` completes by dispatching `/oauth2/authorize` itself —
 * through the same dispatcher, so every hook registered on authorization runs
 * again, with `path` set to authorization while the HTTP request being served
 * is still the consent POST. That is the one moment when the grant the repair
 * looks for cannot exist yet: the consent action binds it only once a code has
 * been issued. Running there blanked the consent that had just been written,
 * authorization then found no consent, and it returned the person to the
 * screen they had just completed rather than to their client.
 *
 * So the repair runs only where a person is arriving at authorization, which
 * is exactly where the strand it fixes is about to matter. Declining anywhere
 * else costs nothing but the repair.
 */
function arrivingAtAuthorization(context: {
  path?: string;
  request?: Request;
}) {
  const served = context.request?.url;
  if (!served || !context.path) return false;

  return new URL(served).pathname.endsWith(context.path);
}

/**
 * The agent keys' api-key configuration, exported so a test can hold it to a
 * literal copy: the composition golden records no plugin options, so it
 * cannot see a change here (Plan 13, F.3, Done when 3).
 */
export const agentApiKeyConfiguration = {
  configId: "requestport-agent",
  defaultPrefix: "rp_",
  defaultKeyLength: 64,
  requireName: true,
  /*
    The same bounds the domain publishes, stated rather than inherited.

    `issueInput.name` and `provision_agent`'s `displayName` both allow 160
    characters, and the provisioning path hands the display name straight
    through as the credential's name. Better Auth's own default maximum is
    32, so every name above it was refused with an `APIError` that nothing
    here recognised — the agent was told the operation failed and no reason
    was recorded anywhere. "<project> worker" reaches 35 characters with a
    two-word project, so provisioning worked for short names and failed for
    ordinary ones.

    Aligning upward rather than narrowing the domain: the name is a display
    string a person chooses, 160 is what every schema in front of it
    promises, and narrowing would break names the UI already accepts.
  */
  minimumNameLength: 1,
  maximumNameLength: 160,
  enableMetadata: false,
  enableSessionForAPIKeys: false,
  keyExpiration: {
    defaultExpiresIn: 90 * 24 * 60 * 60,
    disableCustomExpiresTime: false,
    /*
      Days, not seconds: the plugin divides the requested `expiresIn`
      (seconds) by 86,400 before comparing it with these two bounds, at
      create and at update. `defaultExpiresIn` above is in seconds.
    */
    minExpiresIn: 1,
    maxExpiresIn: 365,
  },
  rateLimit: {
    enabled: true,
    timeWindow: 60_000,
    maxRequests: 600,
  },
};

/**
 * Operator keys (Plan 13, F.3, F3-6, F3-10): prefix `rpo_`, a 30-day default
 * and a 90-day ceiling. The plugin reads `maxExpiresIn` and `minExpiresIn` in
 * days and `defaultExpiresIn` in seconds. The ceiling bounds a key at
 * creation and at any non-null update, but its owner can clear the plugin's
 * expiry through `/api/auth/api-key/update` with `expiresIn: null`, so the
 * authority is the binding row's `expires_at`, and a null plugin expiry fails
 * the join that resolves a key.
 *
 * `enableSessionForAPIKeys` stays false: the plugin's one `before` hook turns
 * a key sent in `x-api-key` into a session for its owner, on every
 * configuration that enables it, which would hand a script its member's Better
 * Auth session.
 */
export const operatorApiKeyConfiguration = {
  configId: "requestport-operator",
  defaultPrefix: "rpo_",
  defaultKeyLength: 64,
  requireName: true,
  minimumNameLength: 1,
  maximumNameLength: 160,
  enableMetadata: false,
  enableSessionForAPIKeys: false,
  keyExpiration: {
    defaultExpiresIn: 30 * 24 * 60 * 60,
    disableCustomExpiresTime: false,
    minExpiresIn: 1,
    maxExpiresIn: 90,
  },
  rateLimit: {
    enabled: true,
    timeWindow: 60_000,
    maxRequests: 600,
  },
};

export function createAuthOptions({
  database,
  env,
  assertSignupAllowed,
  sendMagicLink,
  resolveAgentGrantBindingFingerprints,
  repairUnboundAgentConsent,
  fetchClientMetadataResource = pinnedMetadataFetch,
}: {
  database: NonNullable<BetterAuthOptions["database"]>;
  env: AuthEnvironment;
  assertSignupAllowed: (email: string) => Promise<unknown>;
  sendMagicLink?: (input: { email: string; url: string }) => Promise<void>;
  resolveAgentGrantBindingFingerprints?: (input: {
    userId: string;
    audience: "mcp" | "api";
  }) => Promise<{ fingerprints: string[]; truncated: boolean }>;
  repairUnboundAgentConsent?: (input: {
    userId: string;
    clientId: string;
  }) => Promise<void>;
  /**
   * The transport CIMD fetches metadata documents through. Production uses
   * `@better-auth/cimd/node`'s, which resolves the host once, refuses any
   * non-public address, pins the connection to it and follows no redirect.
   * Tests hand in a fake.
   */
  fetchClientMetadataResource?: ClientMetadataResourceFetch;
}) {
  assertServableIssuer(env.BETTER_AUTH_URL);
  const resourceBaseUrl = env.BETTER_AUTH_URL.replace(/\/$/u, "");
  const agentResources = [
    `${resourceBaseUrl}/mcp`,
    `${resourceBaseUrl}/api/v1`,
  ] as const;
  async function enforceSignupPolicy(email: string) {
    try {
      return await assertSignupAllowed(email);
    } catch (error) {
      if (error instanceof SignupPolicyDeniedError) {
        throw new APIError("FORBIDDEN", {
          code: "signup_disabled",
          message: "signup_disabled",
        });
      }
      throw error;
    }
  }

  const trustedOrigins =
    env.NODE_ENV === "production"
      ? [...productionOrigins]
      : [
          ...new Set([
            ...productionOrigins,
            "http://localhost:3000",
            new URL(env.BETTER_AUTH_URL).origin,
          ]),
        ];

  const magicLinkPreflight = createAuthMiddleware(async (context) => {
    const parsed = signInMagicLinkBodySchema.safeParse(context.body);
    if (!parsed.success) return;

    try {
      await assertSignupAllowed(parsed.data.email);
    } catch (error) {
      if (error instanceof SignupPolicyDeniedError) {
        return context.json({ status: true });
      }
      throw error;
    }
  });
  const signupPolicyPlugin = {
    id: "requestport-signup-policy",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/sign-in/magic-link",
          handler: formCsrfMiddleware,
        },
        {
          matcher: (context) => context.path === "/sign-in/magic-link",
          handler: magicLinkPreflight,
        },
      ],
    },
  } satisfies BetterAuthPlugin;
  /**
   * A consent no usable grant stands behind is not a consent.
   *
   * The two records are written by two systems and share no transaction:
   * Better Auth commits its consent row, then this application binds the
   * grant. Anything that fails in between leaves a satisfied consent and no
   * grant — and from then on Better Auth skips the consent screen, because as
   * far as it is concerned the person already agreed. The screen is the only
   * thing that creates the grant, so the pair is stranded permanently and
   * silently. Seven clients reached that state in one evening.
   *
   * A repair on the consent page cannot work: that page is exactly what is
   * skipped. So the invariant is enforced where the skipping is decided, on
   * the way into authorization.
   *
   * The repair itself declines when a usable grant exists, so the ordinary
   * request pays one indexed lookup and nothing changes. It is deliberately
   * not conditioned on the scopes this request asks for: Better Auth falls
   * back to the client's own registered scopes when a request names none, so
   * a request with no `scope` would have skipped the repair and still been
   * handed a code.
   */
  const agentGrantIntegrityPlugin = {
    id: "requestport-agent-grant-integrity",
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path === "/oauth2/authorize" &&
            arrivingAtAuthorization(context),
          handler: createAuthMiddleware(async (context) => {
            if (!repairUnboundAgentConsent) return;
            const clientId = context.query?.client_id;
            if (typeof clientId !== "string" || !clientId) return;
            const session = await getSessionFromCtx(context);
            // No session means authorization is about to send them to sign in,
            // and there is no person yet to repair anything for.
            if (!session?.user?.id) return;
            try {
              await repairUnboundAgentConsent({
                userId: session.user.id,
                clientId,
              });
            } catch {
              /**
               * Swallowed on purpose. This hook stands between every agent and
               * authorization; a database hiccup here would refuse authorization
               * for everyone rather than for the one pair it could not check.
               * Declining to repair leaves the stranding this would have fixed,
               * which is the state that already exists — failing closed would
               * create a larger outage than the bug.
               */
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;

  /*
    Three switches, each on its own. GitHub needs its client pair; the magic
    link needs a sender, which the caller builds only from a complete Resend
    pair; the local credential follows `localCredentialEnabled`, which is off
    wherever `VERCEL_ENV` is set whatever the switch says. They used to
    be one gate: GitHub and the magic link together or neither, and with
    neither the signup policy and the grant repair were dropped as well.
  */
  const githubProvider =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
        }
      : undefined;
  const localCredential = localCredentialEnabled({
    github: Boolean(githubProvider),
    magicLink: Boolean(sendMagicLink),
    localCredentialSwitch: env.REQUESTPORT_LOCAL_CREDENTIAL,
    vercelEnv: env.VERCEL_ENV,
  });

  /*
    Client ID Metadata Documents (the MCP 2026-07-28 registration), off
    unless REQUESTPORT_OAUTH_CIMD is exactly "enabled" (R6). On, the
    allowlist is mandatory: without a non-empty, valid one this throws, as a
    bad issuer does above, so a half-made change stops this deployment's
    Better Auth rather than letting any client choose a URL it fetches. The
    predicate runs after the plugin's own syntactic check of the URL and
    before the transport, which is the only place a lookup happens.
  */
  const clientIdMetadataDocuments =
    env.REQUESTPORT_OAUTH_CIMD === "enabled"
      ? [
          cimd({
            fetchClientMetadataResource,
            metadataProfile: "mcp-2026-07-28",
            isMetadataDocumentUrlAllowed: createCimdOriginPredicate(
              parseCimdAllowedOrigins(
                env.REQUESTPORT_OAUTH_CIMD_ALLOWED_ORIGINS,
              ),
            ),
          }),
        ]
      : [];

  const agentPlugins = [
    jwt({
      disableSettingJwtHeader: true,
      jwt: {
        issuer: issuerFor(env.BETTER_AUTH_URL),
        expirationTime: "15 minutes",
      },
      jwks: {
        rotationInterval: 30 * 24 * 60 * 60,
        gracePeriod: 7 * 24 * 60 * 60,
      },
    }),
    /*
      Two configurations of one plugin, keyed by `configId`: agent keys, as
      they always were, and operator keys (Plan 13, F.3, F3-6). Neither is the
      default, so a call that names no configuration still fails.
    */
    apiKey([agentApiKeyConfiguration, operatorApiKeyConfiguration]),
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/oauth/agent-consent",
      scopes: [
        "openid",
        "offline_access",
        /**
         * Organization-wide, exclusive, and deliberately NOT in
         * `clientRegistrationDefaultScopes` below.
         *
         * The provider validates every requested scope against this list, so
         * omitting it made the whole provisioning path unreachable: dynamic
         * registration answered `invalid_scope`, `/oauth2/authorize` redirected
         * with `invalid_scope`, and the consent screen's organization branch
         * could never render. Every rule behind it was correct and unreachable.
         *
         * It must never join the defaults: that list is unioned into the
         * allowed list and handed to every client, which would give ordinary
         * clients the one scope that may be held alone.
         */
        "project:provision",
        "org:read",
        "project:read",
        "request:create",
        "request:read",
        "request:write",
        "request:triage",
        "request:complete",
        "request:verify",
        "question:answer",
        "work:claim",
        "work:update",
        "agent:register",
        "webhook:manage",
        "import:write",
      ],
      /*
        The two protected resources, as 1.7's persisted resource model. When
        the instance initialises, Better Auth inserts an `oauth_resource` row
        for each identifier the table does not already hold and never updates
        one (`resourceSeedMode` defaults to "insertOnly"). A token or refresh
        request may name only a resource listed here, and may only narrow
        what was authorised; anything wider is `invalid_target`.
      */
      resources: [...agentResources],
      /*
        Off, explicitly. On — 1.7's default — Better Auth requires an
        `oauth_client_resource` row linking the client to every resource it
        asks for, and no client registered before 1.7 has one. RequestPort
        binds the audience itself: a (person, client) pair holds at most one
        active grant (`agent_oauth_grants_active_client_user_unique`, migration
        0010), bound to one audience, and the bearer path refuses a token
        whose audience has no grant behind it (`authenticate-bearer.ts`).
      */
      enforcePerClientResources: false,
      /*
        A dynamic registration may ask to be linked to either resource and to
        nothing else (`invalid_target`). None is linked by default: with the
        enforcement above off, a link carries no authority.
      */
      clientRegistrationDefaultResources: [],
      clientRegistrationAllowedResources: [...agentResources],
      grantTypes: ["authorization_code", "refresh_token"],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      allowPublicClientPrelogin: true,
      clientRegistrationDefaultScopes: [
        "openid",
        "offline_access",
        "org:read",
        "project:read",
        "request:create",
        "request:read",
        "request:write",
        "question:answer",
        "work:claim",
        "work:update",
        "agent:register",
      ],
      clientRegistrationAllowedScopes: [
        // Registerable on request, never granted by default — see the comment
        // on `scopes` above.
        "project:provision",
        "request:triage",
        "request:complete",
        "request:verify",
        "webhook:manage",
        "import:write",
      ],
      rateLimit: {
        token: { window: 60, max: 20 },
        authorize: { window: 60, max: 30 },
        introspect: { window: 60, max: 100 },
        revoke: { window: 60, max: 30 },
        register: { window: 60, max: 5 },
        userinfo: { window: 60, max: 60 },
      },
      accessTokenExpiresIn: 15 * 60,
      refreshTokenExpiresIn: 30 * 24 * 60 * 60,
      storeClientSecret: "hashed",
      storeTokens: "hashed",
      customAccessTokenClaims: async ({ user, resources }) => {
        if (!user || !resolveAgentGrantBindingFingerprints) return {};
        /*
          1.7 hands over every resource the token is minted for. A token
          carries a grant family only when it names exactly one of the two
          agent resources: that is the audience whose grants the claim lists.
        */
        const named = resources ?? [];
        const audience =
          named.length !== 1
            ? null
            : named[0] === `${resourceBaseUrl}/mcp`
              ? "mcp"
              : named[0] === `${resourceBaseUrl}/api/v1`
                ? "api"
                : null;
        if (!audience) return {};
        const families = await resolveAgentGrantBindingFingerprints({
          userId: user.id,
          audience,
        });
        if (families.truncated) {
          /**
           * Logged rather than refused, and never silent.
           *
           * A person holding more grants than the claim can carry has some
           * agent that will be told only "OAuth agent grant is unavailable" —
           * the same answer a forged token gets — and nothing in that answer
           * names the cap as the reason. This line is the one place the cap is
           * ever mentioned, so it is what turns an unexplainable 401 into
           * something an operator can act on.
           *
           * It does not refuse the token: the person's other agents are all
           * working, and failing the mint would take every one of them down to
           * protect the one that is already broken.
           */
          console.warn("Agent grant family claim was truncated.", {
            userId: user.id,
            audience,
            claimed: families.fingerprints.length,
          });
        }
        return {
          [requestportAgentGrantFamiliesClaim]: families.fingerprints,
        };
      },
    }),
    ...clientIdMetadataDocuments,
  ] satisfies BetterAuthPlugin[];

  const options = {
    appName: "RequestPort",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database,
    /*
      `/change-password` is in Better Auth's core endpoint table whatever the
      composition, and its handler never reads `emailAndPassword.enabled`. It
      rewrites a credential `account` row with a session and the current
      password, and revokes no credential (only, on request, the person's
      other sessions). The owner's credential is rotated only by the domain's
      `bootstrapOwner` with `localCredential: "rotate"`, which runs on the
      database owner's storage, never through Better Auth: the private
      operator CLI's `bootstrap-owner --rotate-local-credential`, the
      `requestport` program's operator processes, and core's
      `RequestPort.bootstrapOwner` on its caller's owner storage. So this
      path answers 404 in every composition. The router matches exact
      paths.
    */
    disabledPaths: ["/change-password"],
    ...(githubProvider ? { socialProviders: { github: githubProvider } } : {}),
    plugins: [
      ...agentPlugins,
      ...(sendMagicLink
        ? [
            magicLink({
              storeToken: "hashed",
              sendMagicLink: async ({ email, url }) => {
                await sendMagicLink({
                  email,
                  url,
                });
              },
            }),
          ]
        : []),
      signupPolicyPlugin,
      agentGrantIntegrityPlugin,
    ],
    /*
      The local owner credential. Sign-in only: an account with a password is
      written only by the domain's `bootstrapOwner` with a `localCredential`
      mode (`"issue"`, or `"rotate"` for an active owner), which runs on the
      database owner's storage, never through Better Auth: the private
      operator CLI's `bootstrap-owner`, the `requestport` program's operator
      processes, and core's `RequestPort.bootstrapOwner` on its caller's
      owner storage. So sign-up stays off. Hashed and verified by the same
      functions the bootstrap writes with.
    */
    ...(localCredential
      ? {
          emailAndPassword: {
            enabled: true,
            disableSignUp: true,
            password: {
              hash: hashLocalCredential,
              verify: verifyLocalCredential,
            },
          },
        }
      : {}),
    account: {
      encryptOAuthTokens: true,
    },
    advanced: {
      /*
        `Secure`, and so named `__Secure-…`, in a production runtime whose
        issuer is https (Plan 13, H.3; ruling 108). WebKit keeps no `Secure`
        cookie over http loopback (K5, `track-h.md`), and `requestport start`
        is to serve a self-host on `http://127.0.0.1:<port>` under
        `NODE_ENV=production` (manifest-h.md §2.3), so this cannot follow
        `NODE_ENV` alone. `BETTER_AUTH_URL` is https or http on a loopback host
        by now (`assertServableIssuer`, above). Development and test runtimes
        keep plain cookies over either scheme, as they did.
      */
      useSecureCookies:
        env.NODE_ENV === "production" &&
        new URL(env.BETTER_AUTH_URL).protocol === "https:",
    },
    trustedOrigins,
    onAPIError: {
      errorURL: new URL("/auth-error", env.BETTER_AUTH_URL).toString(),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, _context) => {
            await enforceSignupPolicy(user.email);
            return {
              data: {
                ...user,
                email: normalizeSignupEmail(user.email),
              },
            };
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
  return options as typeof options & BetterAuthOptions;
}
