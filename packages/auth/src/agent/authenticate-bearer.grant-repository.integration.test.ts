import {
  createAgentAuthRepository,
  createStorage,
  type Tx,
} from "@requestport/db";
import { storageOptionsFromEnv } from "@requestport/db/wiring";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import {
  createAuthenticateAgentBearer,
  requestportAgentGrantFamiliesClaim,
} from "./authenticate-bearer.js";

/**
 * GHSA-p2fr-6hmx-4528, at the bearer path, against the real grant lookup.
 *
 * `@better-auth/oauth-provider@1.7.6` refuses a token request wider than the
 * resource a client was authorised for, but a client that named no resource
 * when it was authorised is minted a token for whichever resource its token
 * request names (`cross-audience-token.integration.test.ts`). Such a token is
 * signed, unexpired, and carries the other resource as its audience, so
 * `exactAudience` admits it at that resource: its audience is that endpoint's
 * own. Only the grant lookup stands between it and a context.
 *
 * `authenticate-bearer.test.ts` stubs that lookup, so it cannot show the
 * lookup refusing anything. Here the signature is the only thing assumed —
 * `verifyJwt` hands back the claims such a token would carry — and the grant
 * is bound and resolved by the repository production uses.
 *
 * The token below also carries the grant's own family fingerprint, which a
 * minted one would not (the claim is computed per audience). That is
 * deliberate: it takes the claim out of the question, so what refuses the
 * token is the per-audience lookup and nothing else.
 */

const base = "https://requestport.com";
const audiences = { api: `${base}/api/v1`, mcp: `${base}/mcp` } as const;
const seedingTimeoutMs = 30_000;

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage(storageOptionsFromEnv(process.env));

afterAll(async () => {
  await suiteStorage.close();
});

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  try {
    await suiteStorage.db.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    });
  } catch (error) {
    if (error instanceof TestRollback) return;
    throw error;
  }
  throw new Error("Expected the bearer transaction to roll back");
}

async function seedBoundGrant(tx: Tx, audience: "mcp" | "api") {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Bearer owner', ${email}, now())
  `);
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Bearer tenant',
      ${`bearer-${organizationId}`}, 'active')
  `);
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, 'owner', 'active')
  `);
  const projectId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "projects"
      ("id", "organization_id", "name", "slug", "key_prefix", "status")
    values (${projectId}, ${organizationId}, 'Bearer project',
      ${`project-${projectId}`}, ${`BP${projectId.slice(0, 6)}`}, 'active')
  `);
  const agentPrincipalId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_principals"
      ("id", "organization_id", "project_id", "display_name", "slug",
       "status", "created_by_user_id")
    values (${agentPrincipalId}, ${organizationId}, ${projectId},
      'Bearer agent', ${`agent-${agentPrincipalId}`}, 'active', ${userId})
  `);
  const clientId = `client_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_client"
      ("id", "client_id", "redirect_uris", "disabled",
       "token_endpoint_auth_method")
    values (${clientId}, ${clientId},
      ${sql`array['http://127.0.0.1:41234/callback']`}, false, 'none')
  `);
  await tx.execute(sql`
    insert into "oauth_consent" ("id", "client_id", "user_id", "scopes")
    values (${`consent_${crypto.randomUUID()}`}, ${clientId}, ${userId},
      ${sql`array['request:read']`})
  `);

  const repository = createAgentAuthRepository(tx);
  await repository.bindOAuthConsent({
    organizationId,
    agentPrincipalId,
    userId,
    clientId,
    audience,
    projectId,
    laneIds: [],
    scopes: ["request:read"],
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    correlationId: crypto.randomUUID(),
    expectedVersion: 0,
    idempotencyKey: crypto.randomUUID(),
    fingerprintSecret: "bearer-binding-fingerprint-secret",
  });
  const bound = await repository.resolveOAuthGrant({
    userId,
    clientId,
    audience,
  });
  if (!bound?.oauthTokenBindingFingerprint) {
    throw new Error("The bound grant did not resolve for its own audience");
  }

  return {
    agentPrincipalId,
    clientId,
    family: bound.oauthTokenBindingFingerprint,
    repository,
    userId,
  };
}

function bearerFor(
  seeded: Awaited<ReturnType<typeof seedBoundGrant>>,
  tokenAudience: string,
) {
  const authenticate = createAuthenticateAgentBearer({
    audiences,
    userinfoAudience: `${base}/api/auth/oauth2/userinfo`,
    verifyApiKey: async () => ({ key: null, valid: false }),
    resolveApiKey: async () => null,
    // What a signed, unexpired token minted for `tokenAudience` verifies to.
    verifyJwt: async () => ({
      aud: tokenAudience,
      azp: seeded.clientId,
      exp: Math.floor(Date.now() / 1_000) + 15 * 60,
      scope: "request:read",
      sub: seeded.userId,
      [requestportAgentGrantFamiliesClaim]: [seeded.family],
    }),
    resolveOAuth: (input) => seeded.repository.resolveOAuthGrant(input),
  });
  return (endpoint: "mcp" | "api") =>
    authenticate(
      new Request(audiences[endpoint], {
        headers: { authorization: "Bearer a.jwt.token" },
        method: "POST",
      }),
      endpoint,
    );
}

describe.sequential("a bearer token for the other resource", () => {
  test.each([
    ["mcp", "api"],
    ["api", "mcp"],
  ] as const)(
    "a client bound for %s is refused at %s with a token minted for it",
    async (bound, other) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedBoundGrant(tx, bound);

        // The control: the same client, the same claims, its own audience.
        // Without it, the refusal below could be the fixture's fault.
        await expect(
          bearerFor(seeded, audiences[bound])(bound),
        ).resolves.toMatchObject({
          actor: { type: "agent", id: seeded.agentPrincipalId },
          audience: bound,
          scopes: new Set(["request:read"]),
        });

        // The advisory's token: its audience is the endpoint's own, so it
        // passes every check before the grant lookup. The message says the
        // refusal came from the grant, not from the token's form.
        await expect(
          bearerFor(seeded, audiences[other])(other),
        ).rejects.toMatchObject({
          code: "unauthenticated",
          message: "OAuth agent grant is unavailable",
        });
      });
    },
    seedingTimeoutMs,
  );

  test.each([
    ["mcp", "api"],
    ["api", "mcp"],
  ] as const)(
    "a token for %s presented at %s is refused before any grant is read",
    async (bound, other) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedBoundGrant(tx, bound);

        await expect(
          bearerFor(seeded, audiences[bound])(other),
        ).rejects.toMatchObject({
          code: "unauthenticated",
          message: "OAuth access token is invalid",
        });
      });
    },
    seedingTimeoutMs,
  );
});
