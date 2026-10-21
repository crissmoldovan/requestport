import { expect } from "@playwright/test";
import { testPool } from "@requestport/db/testing";

import { fixtureStorage } from "./auth.js";

/**
 * The consent journey's shared machinery, extracted so a second journey can
 * reach the same credential without rebuilding the dance.
 *
 * These were module-private functions inside `agent-consent.spec.ts`. Nothing
 * about them was specific to that spec — they are the OAuth client an agent
 * registers, the authorization it walks, and the code it redeems — and the
 * alternative to extracting them was a second copy, which is how two journeys
 * come to disagree about what the product's own front door does.
 */

/** Where the acceptance server answers. Fixed, like the lanes' own port. */
export const CONSENT_ORIGIN = "http://127.0.0.1:3100";

/**
 * The loopback receiver an agent hands the provider.
 *
 * Nothing listens there. A journey that needs the redirect to arrive intact
 * fulfils the route in the browser instead, because Chrome's own
 * connection-error page replaces the address — and the address is the answer.
 */
export const CONSENT_REDIRECT_URI = "http://127.0.0.1:41999/callback";

/**
 * RFC 7636's own example pair. The challenge below is the SHA-256 of this, and
 * redeeming the code needs the verifier that matches it.
 */
export const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/**
 * The scope a provisioning grant carries, and the reason it carries nothing
 * else: `project:provision` is organization-wide and exclusive, and
 * `agent-grant-service.ts` refuses a grant that pairs it with any other scope.
 */
export const PROVISIONING_SCOPE = "offline_access project:provision";

export async function registerClient(origin: string, clientName: string) {
  const response = await fetch(`${origin}/api/auth/oauth2/register`, {
    body: JSON.stringify({
      client_name: clientName,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [CONSENT_REDIRECT_URI],
      require_pkce: true,
      response_types: ["code"],
      scope: PROVISIONING_SCOPE,
      token_endpoint_auth_method: "none",
    }),
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "POST",
  });
  expect(response.ok, "dynamic client registration must succeed").toBe(true);
  const body = (await response.json()) as { client_id?: string };
  expect(typeof body.client_id).toBe("string");
  return body.client_id as string;
}

export function authorizeUrl(origin: string, clientId: string) {
  const query = new URLSearchParams({
    client_id: clientId,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    redirect_uri: CONSENT_REDIRECT_URI,
    response_type: "code",
    scope: PROVISIONING_SCOPE,
    state: "journey-state",
  });
  return `${origin}/api/auth/oauth2/authorize?${query.toString()}`;
}

/**
 * What the consent page's own gate would see.
 *
 * `page.tsx` answers a refused gate with `notFound()`, which is
 * indistinguishable from a mistyped address. When a journey fails there, the
 * rows it refused on are the only useful thing to say. The client columns are
 * the ones the gate reads: Better Auth 1.7.6 writes no `public`, so the gate
 * reads the token endpoint method instead.
 */
export async function consentGateState(clientId: string, email: string) {
  const client = await testPool(fixtureStorage()).query(
    'SELECT "token_endpoint_auth_method", "require_pkce", "disabled" FROM "oauth_client" WHERE "client_id" = $1',
    [clientId],
  );
  const membership = await testPool(fixtureStorage()).query(
    `SELECT m."role", m."status", o."status" AS "organization_status"
       FROM "organization_members" m
       JOIN "organizations" o ON o."id" = m."organization_id"
       JOIN "user" u ON u."id" = m."user_id"
      WHERE lower(u."email") = lower($1)`,
    [email],
  );
  return `client: ${JSON.stringify(client.rows)}\nmemberships: ${JSON.stringify(membership.rows)}`;
}

/**
 * Redeem the authorization code and hand back the access token itself.
 *
 * Split out from `redeemAndUse` because a journey that continues past consent
 * needs the credential, not a verdict about it. The assertions stay here so
 * that every caller gets the same refusal message when the token endpoint
 * declines, rather than each inventing one.
 */
export async function redeemAccessToken(
  origin: string,
  clientId: string,
  code: string,
) {
  const resource = mcpResource(origin);
  const token = await fetch(`${origin}/api/auth/oauth2/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: CODE_VERIFIER,
      grant_type: "authorization_code",
      redirect_uri: CONSENT_REDIRECT_URI,
      resource,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const body = (await token.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  expect(
    token.status,
    `the token endpoint refused the code: ${body.error ?? "?"} ${body.error_description ?? ""}`,
  ).toBe(200);
  expect(typeof body.access_token, "an access token must be issued").toBe(
    "string",
  );
  return body.access_token as string;
}

/** The resource an agent's token is bound to, and the address it is spent at. */
export function mcpResource(origin: string) {
  return `${origin}/mcp`;
}

/**
 * Redeem the code and use what comes back.
 *
 * A code is not a credential. Every fix on this path was made against a
 * journey that stopped at one — and the token those fixes were protecting
 * could not authenticate a single request, because it is verified against the
 * resource it names while the library checked it against the issuer's origin.
 * Nothing short of spending the token would have found that.
 */
export async function redeemAndUse(
  origin: string,
  clientId: string,
  code: string,
) {
  const accessToken = await redeemAccessToken(origin, clientId, code);
  const used = await fetch(mcpResource(origin), {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "agent-consent-journey", version: "1" },
        protocolVersion: "2025-06-18",
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const answer = await used.text();
  expect(
    used.status,
    `the issued token authenticated nothing: ${used.status} ${answer.slice(0, 200)}`,
  ).not.toBe(401);
  expect(answer, "the resource refused the credential").not.toContain(
    "unauthenticated",
  );
  return accessToken;
}
