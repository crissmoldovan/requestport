import type { ResolvedAgentAuthorization } from "@requestport/db";

import { describe, expect, test, vi } from "vitest";

import {
  createAuthenticateAgentBearer,
  requestportAgentGrantFamiliesClaim,
} from "./authenticate-bearer.js";

const base = "https://requestport.com";
const audiences = { api: `${base}/api/v1`, mcp: `${base}/mcp` } as const;
/** What the provider appends to the audience when `openid` is granted. */
const userinfo = `${base}/api/auth/oauth2/userinfo`;
const family = "a-binding-fingerprint";

function resolved(): ResolvedAgentAuthorization {
  return {
    agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
    audience: "mcp" as const,
    authorizationId: "00000000-0000-4000-8000-0000000000b1",
    credentialFingerprint: "fingerprint",
    delegatedByUserId: "person",
    laneIds: [],
    oauthTokenBindingFingerprint: family,
    organizationId: "00000000-0000-4000-8000-0000000000c1",
    projectId: null,
    scopes: ["project:provision", "request:read"],
    expiresAt: new Date(Date.now() + 60_000),
  };
}

/**
 * Every dependency is exposed, because what this function *asks* its
 * dependencies is as load-bearing as what it returns: a grant resolved for the
 * wrong subject, or an API key never actually verified, both end in a context
 * that looks perfectly well-formed.
 */
function harness(
  overrides: {
    apiKey?: { valid: boolean; key: { id: string } | null };
    grant?: ResolvedAgentAuthorization | null;
    payload?: Record<string, unknown> | null;
  } = {},
) {
  const grant = "grant" in overrides ? overrides.grant : resolved();
  const apiKey = overrides.apiKey ?? { key: null, valid: false };
  const payload = overrides.payload ?? null;

  const dependencies = {
    resolveApiKey: vi.fn(async () => grant ?? null),
    resolveOAuth: vi.fn(async () => grant ?? null),
    touchCredential: vi.fn(async () => {}),
    touchOAuthGrant: vi.fn(async () => {}),
    verifyApiKey: vi.fn(async (_token: string) => apiKey),
    verifyJwt: vi.fn(async () => payload),
  };

  return {
    ...dependencies,
    authenticate: createAuthenticateAgentBearer({
      audiences,
      userinfoAudience: userinfo,
      ...dependencies,
    }),
  };
}

function authenticate(payload: Record<string, unknown> | null) {
  return harness({ payload }).authenticate;
}

function bearer(token = "a.jwt.token") {
  return new Request(`${base}/mcp`, {
    headers: { authorization: `Bearer ${token}` },
    method: "POST",
  });
}

function authorization(value: string) {
  return new Request(`${base}/mcp`, {
    headers: { authorization: value },
    method: "POST",
  });
}

/**
 * An access token this application issued, which this application cannot read.
 *
 * `@better-auth/oauth-provider@1.7.6` mints a JWT only when the token request
 * resolves to a resource: the request's own `resource`, or, on refresh, the
 * resources the refresh row stores. A refresh row Better Auth 1.6.29 wrote
 * stores none, so refreshing it without `resource` hands out
 * `generateRandomString(32, "A-Z", "a-z")`: unexpired, database-backed, and
 * not a JWT. The alphabet holds no underscore, so it never reaches the `rp_`
 * branch either.
 */
const opaqueAccessToken = "GhgNRuXozsypRhhLUGyMEModMzBaRqDr";

/** Fifteen minutes ahead, as the provider mints them. */
function unexpired() {
  return Math.floor(Date.now() / 1_000) + 15 * 60;
}

function claims(aud: string | string[]) {
  return {
    aud,
    azp: "agent-client",
    exp: unexpired(),
    [requestportAgentGrantFamiliesClaim]: [family],
    scope: "project:provision request:read",
    sub: "person",
  };
}

describe("an agent's bearer credential", () => {
  test("authenticates a token whose audience is the endpoint asked", async () => {
    const context = await authenticate(claims(audiences.mcp))(bearer(), "mcp");

    expect(context.actor.type).toBe("agent");
    expect(context.audience).toBe("mcp");
    expect(context.scopes).toEqual(
      new Set(["project:provision", "request:read"]),
    );
  });

  /**
   * `openid` is an offered scope, and the provider appends its userinfo
   * endpoint to the audience of any token granted it. That made the audience
   * two values, and this path admitted exactly one — so an agent that asked
   * for `openid` alongside its resource completed consent, was issued a token,
   * and could authenticate nothing. The only symptom is a bare 401, which is
   * the same answer as a forged credential.
   */
  test("authenticates a token that also names the userinfo endpoint", async () => {
    const context = await authenticate(claims([audiences.mcp, userinfo]))(
      bearer(),
      "mcp",
    );

    expect(context.audience).toBe("mcp");
  });

  test("refuses a token minted for the other resource", async () => {
    // The confinement this rule exists for: an API token is not an MCP token.
    await expect(
      authenticate(claims(audiences.api))(bearer(), "mcp"),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("refuses the other resource even when userinfo is alongside it", async () => {
    await expect(
      authenticate(claims([audiences.api, userinfo]))(bearer(), "mcp"),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("refuses a token naming an audience this server does not answer", async () => {
    await expect(
      authenticate(claims([audiences.mcp, "https://elsewhere.example/mcp"]))(
        bearer(),
        "mcp",
      ),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("refuses a token that verifies to nothing", async () => {
    await expect(authenticate(null)(bearer(), "mcp")).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  test("refuses a request carrying no bearer credential", async () => {
    await expect(
      authenticate(claims(audiences.mcp))(
        new Request(`${base}/mcp`, { method: "POST" }),
        "mcp",
      ),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("refuses a token whose grant family the claim does not carry", async () => {
    const payload = {
      ...claims(audiences.mcp),
      [requestportAgentGrantFamiliesClaim]: ["a-different-family"],
    };

    await expect(authenticate(payload)(bearer(), "mcp")).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  test("refuses a token that has expired", async () => {
    const payload = {
      ...claims(audiences.mcp),
      exp: Math.floor(Date.now() / 1_000) - 60,
    };

    await expect(authenticate(payload)(bearer(), "mcp")).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  /**
   * A token with no `exp` is good for as long as its grant stands and its
   * signing key is published, rather than the fifteen minutes the provider
   * stamps on every token it mints. So a token without one was not minted by
   * the path this endpoint trusts, and is refused rather than read as
   * never-expiring.
   */
  test("refuses a token that carries no expiry", async () => {
    const { exp: _exp, ...payload } = claims(audiences.mcp);

    await expect(authenticate(payload)(bearer(), "mcp")).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  test.each([
    ["a string", String(unexpired())],
    ["null", null],
    ["not a finite number", Number.POSITIVE_INFINITY],
  ])("refuses a token whose expiry is %s", async (_name, exp) => {
    const payload = { ...claims(audiences.mcp), exp };

    await expect(authenticate(payload)(bearer(), "mcp")).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  /**
   * The stored grant is the ceiling, the token's `scope` is what was actually
   * issued against it, and consent never revisits the grant afterwards — so
   * this intersection is the only place the two are reconciled. Without it an
   * agent that asked for one scope receives every scope its grant ever held.
   */
  test("confines the agent to the scopes its token was issued for", async () => {
    const payload = { ...claims(audiences.mcp), scope: "request:read" };

    const context = await authenticate(payload)(bearer(), "mcp");

    expect(context.scopes).toEqual(new Set(["request:read"]));
  });

  test("grants nothing the stored grant does not already carry", async () => {
    const payload = {
      ...claims(audiences.mcp),
      scope: "request:read project:delete",
    };

    const context = await authenticate(payload)(bearer(), "mcp");

    expect(context.scopes).toEqual(new Set(["request:read"]));
  });

  /**
   * A token with no `scope` asked for nothing, so it gets nothing. Falling back
   * to the grant's scopes here would read as a kindness and would hand the
   * unscoped token the widest context this codebase can produce.
   */
  test("grants nothing to a token that carries no scope at all", async () => {
    const payload: Record<string, unknown> = { ...claims(audiences.mcp) };
    delete payload.scope;

    const context = await authenticate(payload)(bearer(), "mcp");

    expect(context.scopes).toEqual(new Set());
  });

  test("resolves the grant for the token's own subject and client", async () => {
    const { authenticate: authenticateBearer, resolveOAuth } = harness({
      payload: claims(audiences.mcp),
    });

    await authenticateBearer(bearer(), "mcp");

    // `audience` is the endpoint being asked, never the token's `aud` claim:
    // the token is what is being checked, so it cannot also be the check.
    expect(resolveOAuth).toHaveBeenCalledWith({
      audience: "mcp",
      clientId: "agent-client",
      userId: "person",
    });
  });

  test("stamps the OAuth grant a token authenticated against, in the grant's organisation (ruling 261)", async () => {
    const {
      authenticate: authenticateBearer,
      touchCredential,
      touchOAuthGrant,
    } = harness({ payload: claims(audiences.mcp) });
    const grant = resolved();

    await authenticateBearer(bearer(), "mcp");

    expect(touchOAuthGrant).toHaveBeenCalledTimes(1);
    expect(touchOAuthGrant).toHaveBeenCalledWith(
      grant.authorizationId,
      grant.organizationId,
    );
    expect(touchCredential).not.toHaveBeenCalled();
  });

  test.each([
    ["the grant lookup finds none", { grant: null }],
    [
      "the token's family claim does not carry the grant",
      {
        payload: {
          ...claims(audiences.mcp),
          [requestportAgentGrantFamiliesClaim]: ["another-family"],
        },
      },
    ],
  ])("stamps no grant when %s", async (_case, overrides) => {
    const { authenticate: authenticateBearer, touchOAuthGrant } = harness({
      payload: claims(audiences.mcp),
      ...overrides,
    });

    await expect(authenticateBearer(bearer(), "mcp")).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(touchOAuthGrant).not.toHaveBeenCalled();
  });

  test("authenticates an API key against the grant it resolves to", async () => {
    const {
      authenticate: authenticateBearer,
      resolveApiKey,
      touchCredential,
      touchOAuthGrant,
      verifyApiKey,
    } = harness({ apiKey: { key: { id: "an-api-key-id" }, valid: true } });
    const grant = resolved();

    const context = await authenticateBearer(bearer("rp_live_key"), "mcp");

    expect(verifyApiKey).toHaveBeenCalledWith("rp_live_key");
    expect(resolveApiKey).toHaveBeenCalledWith({
      apiKeyId: "an-api-key-id",
      audience: "mcp",
    });
    expect(context.actor).toMatchObject({
      id: grant.agentPrincipalId,
      type: "agent",
    });
    expect(context.organizationId).toBe(grant.organizationId);
    expect(context.authorizationId).toBe(grant.authorizationId);
    // An API key carries no scope claim of its own, so the grant is the whole
    // of what it may do.
    expect(context.scopes).toEqual(
      new Set(["project:provision", "request:read"]),
    );
    // Stamped bound to the organisation the lookup found (D15).
    expect(touchCredential).toHaveBeenCalledWith(
      grant.authorizationId,
      grant.organizationId,
    );
    expect(touchOAuthGrant).not.toHaveBeenCalled();
  });

  test("refuses an API key the verifier rejects", async () => {
    const { authenticate: authenticateBearer, resolveApiKey } = harness({
      apiKey: { key: null, valid: false },
    });

    await expect(
      authenticateBearer(bearer("rp_forged"), "mcp"),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  /**
   * Rejection and naming are separate answers, and the verifier can give both
   * at once. The gate refuses on `valid` alone, so a key the verifier rejected
   * is refused even when it came back named — were the refusal to rest on the
   * name, this key would be resolved to its grant and authenticated.
   */
  test("refuses a rejected API key the verifier still names", async () => {
    const { authenticate: authenticateBearer, resolveApiKey } = harness({
      apiKey: { key: { id: "a-rejected-key-id" }, valid: false },
    });

    await expect(
      authenticateBearer(bearer("rp_rejected"), "mcp"),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  test("refuses a verified API key the verifier cannot name", async () => {
    const { authenticate: authenticateBearer, resolveApiKey } = harness({
      apiKey: { key: null, valid: true },
    });

    await expect(
      authenticateBearer(bearer("rp_nameless"), "mcp"),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  test("refuses a valid API key whose grant is gone", async () => {
    const { authenticate: authenticateBearer, touchCredential } = harness({
      apiKey: { key: { id: "an-api-key-id" }, valid: true },
      grant: null,
    });

    await expect(
      authenticateBearer(bearer("rp_revoked"), "mcp"),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(touchCredential).not.toHaveBeenCalled();
  });

  /**
   * RFC 7235 makes the auth-scheme token case-insensitive, and clients send
   * `bearer` in lower case. Matching it exactly turned such a request into a
   * bare 401 before any verification ran — indistinguishable, to whoever is
   * debugging it, from a rejected credential.
   */
  test("authenticates a credential whose scheme is not capitalised", async () => {
    const { authenticate: authenticateBearer } = harness({
      payload: claims(audiences.mcp),
    });

    const context = await authenticateBearer(
      authorization("bearer a.jwt.token"),
      "mcp",
    );

    expect(context.audience).toBe("mcp");
  });

  test("passes the credential on exactly as sent, whatever the scheme's case", async () => {
    const { authenticate: authenticateBearer, verifyApiKey } = harness({
      apiKey: { key: { id: "an-api-key-id" }, valid: true },
    });

    await authenticateBearer(authorization("BEARER rp_MiXeD_CaSe"), "mcp");

    // The scheme is case-insensitive; the credential after it is not.
    expect(verifyApiKey).toHaveBeenCalledWith("rp_MiXeD_CaSe");
  });

  test("refuses a credential offered under another scheme", async () => {
    const { authenticate: authenticateBearer, verifyJwt } = harness({
      payload: claims(audiences.mcp),
    });

    await expect(
      authenticateBearer(authorization("Basic a.jwt.token"), "mcp"),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(verifyJwt).not.toHaveBeenCalled();
  });

  /**
   * Nothing here can verify an opaque access token — this endpoint has no
   * introspection path for this application's own opaque tokens — so it is
   * refused either way. What is at stake is *which* refusal. Told only that
   * its token is invalid, an agent has the same answer a forged credential
   * gets and nothing to act on; the grant behind it is still good, and the one
   * thing that recovers it is re-authorizing with the resource indicated.
   */
  test("tells an agent presenting a non-JWT credential how to recover", async () => {
    // `payload: null` is what the real verifier returns for this string: jose
    // throws `JWSInvalid — Invalid Compact JWS`, and `verify-access-token.ts`
    // turns any unverifiable token into null.
    const { authenticate: authenticateBearer, verifyJwt } = harness({
      payload: null,
    });

    await expect(
      authenticateBearer(bearer(opaqueAccessToken), "mcp"),
    ).rejects.toMatchObject({
      code: "unauthenticated",
      details: { reauthorizeWithResource: true },
    });
    // Nothing new is admitted: a credential with no compact-JWS form could
    // never have verified, so the verifier is not even asked.
    expect(verifyJwt).not.toHaveBeenCalled();
  });

  /**
   * The other half of the distinction, and the reason this is worth a separate
   * answer at all. A credential shaped like a JWT that does not verify is a
   * forged, tampered or wrongly-signed token; re-authorizing would not fix it,
   * so that remedy must not be offered for it.
   */
  test("offers no such remedy to a JWT-shaped credential that does not verify", async () => {
    const error = await authenticate(null)(bearer(), "mcp").catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({ code: "unauthenticated" });
    expect((error as { details: Record<string, unknown> }).details).toEqual({});
  });

  /**
   * An `alg: "none"` forgery is a compact JWS with an empty signature segment,
   * so the form test admits it on purpose and the verifier is what throws it
   * out — jose answers `JOSENotSupported`. Were the form test to demand a
   * signature, this forgery would be handed re-authorization advice that could
   * not help it, in place of being called invalid.
   */
  test("sends an unsigned JWT to the verifier rather than advising re-authorization", async () => {
    const unsigned = `${Buffer.from('{"alg":"none"}').toString(
      "base64url",
    )}.${Buffer.from('{"sub":"person"}').toString("base64url")}.`;
    const { authenticate: authenticateBearer, verifyJwt } = harness({
      payload: null,
    });

    const error = await authenticateBearer(bearer(unsigned), "mcp").catch(
      (thrown: unknown) => thrown,
    );

    expect(verifyJwt).toHaveBeenCalledWith(unsigned);
    expect((error as { details: Record<string, unknown> }).details).toEqual({});
  });

  /**
   * A JWT minted while no grant-family resolver is configured carries no such
   * claim at all — `customAccessTokenClaims` returns `{}` — which is what this
   * refuses. It is the surviving half of a check that also refused a claim of
   * more than a hundred entries; that half could not happen, because the query
   * building the claim is capped at a hundred rows.
   */
  test("refuses a token carrying no grant family claim at all", async () => {
    const payload: Record<string, unknown> = { ...claims(audiences.mcp) };
    delete payload[requestportAgentGrantFamiliesClaim];

    await expect(authenticate(payload)(bearer(), "mcp")).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  test("refuses a bearer scheme carrying no credential", async () => {
    const { authenticate: authenticateBearer, verifyJwt } = harness({
      payload: claims(audiences.mcp),
    });

    for (const header of ["Bearer", "bearer", "Bearer "]) {
      await expect(
        authenticateBearer(authorization(header), "mcp"),
      ).rejects.toMatchObject({ code: "unauthenticated" });
    }
    expect(verifyJwt).not.toHaveBeenCalled();
  });
});
