import { randomUUID } from "node:crypto";

import type {
  ResolvedAgentAuthorization,
  ResolvedOperatorAuthorization,
} from "@requestport/db";
import type {
  AuthorizedCommandContext,
  OperatorActor,
} from "@requestport/domain";

import {
  DomainError,
  operatorActor,
  operatorKeyPrefix,
} from "@requestport/domain";

export type AgentAudience = "mcp" | "api";

export type AgentAuthContext = AuthorizedCommandContext & {
  actor: {
    type: "agent";
    id: string;
    delegatedBy?: { type: "user"; id: string };
  };
  audience: AgentAudience;
  /**
   * Null for an exclusively-provisioning grant, which names no project because
   * its capability is organization-wide.
   *
   * Every project-scoped path already refuses a context without a project —
   * `requireAgentProject` throws "Agent project access is denied" — so widening
   * this type does not widen any command. It makes the absence expressible
   * where it was previously unrepresentable, which is what let a provisioning
   * grant exist before an organization has any project at all.
   */
  projectId: string | null;
  laneIds: ReadonlySet<string>;
  authorizationId: string;
};

type JwtPayload = {
  sub?: string;
  azp?: string;
  aud?: string | string[];
  scope?: string;
  exp?: number;
  [requestportAgentGrantFamiliesClaim]?: unknown;
};

export const requestportAgentGrantFamiliesClaim =
  "https://requestport.com/claims/agent-grant-families";

const defaultAudiences = {
  mcp: "https://requestport.com/mcp",
  api: "https://requestport.com/api/v1",
} as const;

/**
 * Exactly this endpoint's audience, and nothing else that grants anything.
 *
 * The rule is confinement: a token minted for the API is not a token for MCP,
 * so one value, and it must be this endpoint's own. The provider breaks that
 * arithmetic in one benign way — a token granted `openid` carries its userinfo
 * endpoint alongside the resource — and an agent that asked for `openid` with
 * its resource therefore completed consent, was issued a token, and could
 * authenticate nothing. The only symptom is a bare 401, indistinguishable from
 * a forged credential.
 *
 * So that one value is set aside before counting, and it is set aside by
 * naming it rather than by loosening the count: anything else alongside the
 * resource still refuses, and the resource itself must still be this
 * endpoint's. A token for the other resource does not become usable here
 * because it happens to mention userinfo too.
 */
function exactAudience(
  payload: JwtPayload,
  expected: AgentAudience,
  audiences: Readonly<Record<AgentAudience, string>>,
  userinfoAudience?: string,
) {
  const values = (
    Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  ).filter((value) => !userinfoAudience || value !== userinfoAudience);

  return values.length === 1 && values[0] === audiences[expected];
}

/**
 * An expiry is required, and must lie in the future.
 *
 * The provider stamps `exp` on every access token it mints, fifteen minutes
 * out. This used to be checked only when present, so a validly signed token
 * without one was accepted as never expiring — good for as long as its grant
 * stood and its signing key was published. A token without one was not minted
 * by the path this endpoint trusts, and it is refused rather than excused.
 */
function unexpired(exp: unknown) {
  return (
    typeof exp === "number" && Number.isFinite(exp) && exp * 1_000 > Date.now()
  );
}

function context(
  resolved: ResolvedAgentAuthorization,
  requestedScopes?: ReadonlySet<string>,
): AgentAuthContext {
  const effectiveScopes = requestedScopes
    ? resolved.scopes.filter((scope) => requestedScopes.has(scope))
    : resolved.scopes;
  return {
    actor: {
      type: "agent",
      id: resolved.agentPrincipalId,
      ...(resolved.delegatedByUserId
        ? {
            delegatedBy: {
              type: "user" as const,
              id: resolved.delegatedByUserId,
            },
          }
        : {}),
    },
    organizationId: resolved.organizationId,
    scopes: new Set(effectiveScopes),
    credentialId: resolved.authorizationId,
    credentialFingerprint: resolved.credentialFingerprint,
    correlationId: randomUUID(),
    audience: resolved.audience,
    projectId: resolved.projectId,
    laneIds: new Set(resolved.laneIds),
    authorizationId: resolved.authorizationId,
  };
}

/**
 * The scheme and the credential are captured separately because only one of
 * them is a word. RFC 7235 makes the auth-scheme case-insensitive and clients
 * do send `bearer`, so matching `Bearer` exactly answered those with a bare
 * 401 raised before any verification ran — the same answer as a forged
 * credential, which leaves whoever is debugging it nothing to go on. The
 * credential after the scheme stays exactly as sent: it is a secret, and
 * folding its case would change what is being verified.
 */
const credentialHeader = /^(?<scheme>[^\s]+) (?<credential>[^\s]+)$/u;

/**
 * Compact JWS serialization: three base64url segments (RFC 7515 §7.1).
 *
 * Deliberately shaped to over-admit rather than under-admit. The signature
 * segment may be empty, so an `alg: "none"` forgery still reaches the verifier
 * and is refused as the invalid token it is, instead of being handed the
 * re-authorization advice below — which is for a credential that is not a JWT
 * at all, and would be no help to a token that is one.
 *
 * Nothing is let through either way: a string this rejects has no compact-JWS
 * form, and `jwtVerify` refuses it — an opaque access token is thrown out as
 * `JWSInvalid: Invalid Compact JWS`. So the form test changes which refusal is
 * raised, never whether one is.
 */
const compactJws = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u;

export function createAuthenticateAgentBearer(dependencies: {
  verifyApiKey: (key: string) => Promise<{
    valid: boolean;
    key: { id: string } | null;
  }>;
  verifyJwt: (token: string) => Promise<JwtPayload | null>;
  resolveApiKey: (input: {
    apiKeyId: string;
    audience: AgentAudience;
  }) => Promise<ResolvedAgentAuthorization | null>;
  resolveOAuth: (input: {
    userId: string;
    clientId: string;
    audience: AgentAudience;
  }) => Promise<ResolvedAgentAuthorization | null>;
  /**
   * Stamps the credential just resolved, bound to the organisation the
   * lookup found (manifest-i2.md D15).
   */
  touchCredential?: (
    credentialId: string,
    organizationId: string,
  ) => Promise<void>;
  audiences?: Readonly<Record<AgentAudience, string>>;
  /**
   * The provider's userinfo endpoint, which it appends to the audience of any
   * token granted `openid`. Named so it can be set aside rather than counted.
   */
  userinfoAudience?: string;
}) {
  return async function authenticateAgentBearer(
    request: Request,
    expectedAudience: AgentAudience,
  ): Promise<AgentAuthContext> {
    const header = request.headers.get("authorization");
    const offered = header ? credentialHeader.exec(header) : null;
    const token = offered?.groups?.credential;
    if (!token || offered?.groups?.scheme.toLowerCase() !== "bearer") {
      throw new DomainError(
        "unauthenticated",
        "A bearer credential is required",
      );
    }
    /*
      An operator key (Plan 13, F.3, F3-11) is for `/api/v1/[[...path]]`
      only, whose `authenticateApiBearer` routes it before it can reach here.
      This function serves `/mcp` and the artifact upload, which admit agents
      alone, so an operator key is refused outright: not verified, not looked
      up, and not told to re-authorise, since no OAuth flow would help it.
      `"rpo_…".startsWith("rp_")` is false, so without this it fell through to
      the non-JWS refusal below and its re-authorisation advice.
    */
    if (token.startsWith(operatorKeyPrefix)) {
      throw new DomainError("unauthenticated", "Agent credential is invalid");
    }
    if (token.startsWith("rp_")) {
      const verified = await dependencies.verifyApiKey(token);
      if (!verified.valid || !verified.key) {
        throw new DomainError("unauthenticated", "Agent credential is invalid");
      }
      const resolved = await dependencies.resolveApiKey({
        apiKeyId: verified.key.id,
        audience: expectedAudience,
      });
      if (!resolved) {
        throw new DomainError(
          "unauthenticated",
          "Agent credential is unavailable",
        );
      }
      await dependencies.touchCredential?.(
        resolved.authorizationId,
        resolved.organizationId,
      );
      return context(resolved);
    }

    if (!compactJws.test(token)) {
      /**
       * A credential that is neither an API key nor a JWT.
       *
       * `@better-auth/oauth-provider@1.7.6` mints a JWT only when the token
       * request resolves to a resource: the request's own `resource`, or, on
       * refresh, the resources the refresh row stores. A refresh row Better
       * Auth 1.6.29 wrote stores none, so refreshing it without `resource`
       * issues `generateRandomString(32, "A-Z", "a-z")`: a real, unexpired,
       * database-backed access token that is not a JWT
       * (`better-auth-legacy-rows.integration.test.ts`). This endpoint has no
       * introspection path for this application's own opaque tokens, so it
       * cannot be spent here.
       *
       * From here that string and one an attacker invented are the same
       * string, and this claims nothing about which it is. It reports what is
       * true of both — the credential is not in a form this resource can
       * verify — and names the remedy that recovers the first: authorize
       * again, indicating this resource. `details` carries only the fact that
       * the remedy applies; the wording an agent reads belongs to whatever
       * speaks HTTP, which for MCP is `@requestport/server`'s MCP handler
       * (`packages/server/src/mcp.ts`, its refusal in `unauthorized.ts`),
       * which the web's `/mcp` route composes.
       */
      throw new DomainError(
        "unauthenticated",
        "Bearer credential is not a resource-indicated access token",
        { reauthorizeWithResource: true },
      );
    }

    const payload = await dependencies.verifyJwt(token);
    if (
      !payload?.sub ||
      !payload.azp ||
      !exactAudience(
        payload,
        expectedAudience,
        dependencies.audiences ?? defaultAudiences,
        dependencies.userinfoAudience,
      ) ||
      !unexpired(payload.exp)
    ) {
      throw new DomainError("unauthenticated", "OAuth access token is invalid");
    }
    const familyClaim = payload[requestportAgentGrantFamiliesClaim];
    if (
      !Array.isArray(familyClaim) ||
      !familyClaim.every((value) => typeof value === "string")
    ) {
      throw new DomainError("unauthenticated", "OAuth access token is invalid");
    }
    /**
     * This lookup, not the audience check above, is what refuses
     * GHSA-p2fr-6hmx-4528.
     *
     * `@better-auth/oauth-provider@1.7.6` refuses a token or refresh request
     * wider than the resource a client was authorised for (`invalid_target`),
     * but a client that named no resource when it was authorised has nothing
     * to narrow, and is minted a token for whichever resource its token
     * request names. Such a token's audience is this endpoint's own, so
     * `exactAudience` admits it. What it cannot carry is a grant: the lookup
     * below asks for one bound to this audience, and a (person, client) pair
     * holds at most one active grant. The family claim is a second,
     * independent refusal: `server-options.ts` stamps it at mint time from the
     * grants bound to the audience the token names, which never include this
     * client's grant for the other one.
     * `cross-audience-token.integration.test.ts` mints the token through the
     * provider's own endpoints and shows the refusal.
     */
    const resolved = await dependencies.resolveOAuth({
      userId: payload.sub,
      clientId: payload.azp,
      audience: expectedAudience,
    });
    if (
      !resolved?.oauthTokenBindingFingerprint ||
      !familyClaim.includes(resolved.oauthTokenBindingFingerprint)
    ) {
      throw new DomainError(
        "unauthenticated",
        "OAuth agent grant is unavailable",
      );
    }
    const tokenScopes = new Set(
      payload.scope?.split(/\s+/u).filter(Boolean) ?? [],
    );
    return context(resolved, tokenScopes);
  };
}

/**
 * The context an operator credential authenticates to (Plan 13, F.3, F3-2): a
 * service actor named for the credential's lineage, whose origin is the member
 * who issued it, marked `credentialKind: "operator"`. `credentialId` and
 * `authorizationId` are this key's binding row; the project is null for an
 * organisation-wide credential; there are never lanes.
 */
export type OperatorAuthContext = AuthorizedCommandContext & {
  actor: OperatorActor;
  credentialKind: "operator";
  projectId: string | null;
  laneIds: ReadonlySet<string>;
  authorizationId: string;
};

/** What `/api/v1/[[...path]]` authenticates: an agent or an operator. */
export type ApiAuthContext = AgentAuthContext | OperatorAuthContext;

function operatorContext(
  resolved: ResolvedOperatorAuthorization,
): OperatorAuthContext {
  return {
    actor: operatorActor({
      lineageId: resolved.lineageId,
      memberUserId: resolved.memberUserId,
    }),
    credentialKind: "operator",
    organizationId: resolved.organizationId,
    projectId: resolved.projectId,
    laneIds: new Set(),
    scopes: new Set(resolved.scopes),
    credentialId: resolved.credentialId,
    credentialFingerprint: resolved.credentialFingerprint,
    correlationId: randomUUID(),
    authorizationId: resolved.credentialId,
  };
}

/**
 * The bearer path of `/api/v1/[[...path]]`, and of nothing else (F3-11): the
 * one place an operator credential can authenticate. An `rpo_` key goes to the
 * operator branch; every other credential goes to `authenticateAgentBearer`
 * for the `api` audience, exactly as before.
 *
 * The prefix only routes. What refuses a key of the other kind is the
 * configuration the plugin verifies it under (`verifyOperatorKey` names the
 * operator configuration, and the plugin refuses a key from another) and the
 * binding row (`resolveOperatorKey` looks only in `operator_credentials`), so
 * a key a user created with a chosen prefix, or with no binding, resolves
 * nothing.
 *
 * While operator credentials are off (F3-14) an `rpo_` key is refused before
 * the plugin or the binding is consulted, with the answer an unknown key gets.
 */
export function createAuthenticateApiBearer(dependencies: {
  authenticateAgentBearer: (
    request: Request,
    audience: AgentAudience,
  ) => Promise<AgentAuthContext>;
  operatorCredentialsAvailable: () => Promise<boolean>;
  verifyOperatorKey: (key: string) => Promise<{
    valid: boolean;
    key: { id: string } | null;
  }>;
  resolveOperatorKey: (input: {
    apiKeyId: string;
  }) => Promise<ResolvedOperatorAuthorization | null>;
  /**
   * Stamps the credential just resolved, bound to the organisation the
   * lookup found (manifest-i2.md D15).
   */
  touchOperatorCredential?: (
    credentialId: string,
    organizationId: string,
  ) => Promise<void>;
}) {
  return async function authenticateApiBearer(
    request: Request,
  ): Promise<ApiAuthContext> {
    const header = request.headers.get("authorization");
    const offered = header ? credentialHeader.exec(header) : null;
    const token = offered?.groups?.credential;
    if (
      !token ||
      offered?.groups?.scheme.toLowerCase() !== "bearer" ||
      !token.startsWith(operatorKeyPrefix)
    ) {
      return dependencies.authenticateAgentBearer(request, "api");
    }
    const invalid = () =>
      new DomainError("unauthenticated", "Operator credential is invalid");
    if (!(await dependencies.operatorCredentialsAvailable())) throw invalid();
    const verified = await dependencies.verifyOperatorKey(token);
    if (!verified.valid || !verified.key) throw invalid();
    const resolved = await dependencies.resolveOperatorKey({
      apiKeyId: verified.key.id,
    });
    if (!resolved) throw invalid();
    await dependencies.touchOperatorCredential?.(
      resolved.credentialId,
      resolved.organizationId,
    );
    return operatorContext(resolved);
  };
}
