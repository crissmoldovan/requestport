import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { createAgentAuthRepository } from "./agent-auth-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/**
 * GHSA-p2fr-6hmx-4528, from the database's side.
 *
 * `@better-auth/oauth-provider@1.7.6` refuses a token request wider than the
 * resource a client was authorised for, but a client that named no resource
 * when it was authorised is minted an access token for whichever resource the
 * token request names. So a client a person connected to MCP without naming a
 * resource can ask the token endpoint for an `/api/v1` token, and receive one
 * that verifies.
 *
 * What stops that token doing anything is here: a grant is resolved for the
 * audience the endpoint asked, and a (person, client) pair holds at most one
 * active grant, with one audience. These cases pin both halves, because
 * nothing else did — every other test of this lookup asked for the audience
 * the grant was bound for.
 */

const seedingTimeoutMs = 30_000;

afterAll(async () => {
  await suiteStorage.close();
});

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  try {
    await suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    });
  } catch (error) {
    if (error instanceof TestRollback) return;
    throw error;
  }
  throw new Error("Expected the audience transaction to roll back");
}

/**
 * A person who owns an organization with one project and one agent principal,
 * and a client they registered and consented to — the state the consent screen
 * leaves just before it binds the grant.
 */
async function seedConsentedClient(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Audience owner', ${email}, now())
  `);
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Audience tenant',
      ${`audience-${organizationId}`}, 'active')
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
    values (${projectId}, ${organizationId}, 'Audience project',
      ${`project-${projectId}`}, ${`AP${projectId.slice(0, 6)}`}, 'active')
  `);
  const agentPrincipalId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_principals"
      ("id", "organization_id", "project_id", "display_name", "slug",
       "status", "created_by_user_id")
    values (${agentPrincipalId}, ${organizationId}, ${projectId},
      'Audience agent', ${`agent-${agentPrincipalId}`}, 'active', ${userId})
  `);
  // As dynamic client registration writes it: public, no secret, and
  // `require_pkce` left null, which Better Auth reads as "required".
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
  return { agentPrincipalId, clientId, organizationId, projectId, userId };
}

type Seeded = Awaited<ReturnType<typeof seedConsentedClient>>;

function bindFor(
  repository: ReturnType<typeof createAgentAuthRepository>,
  seeded: Seeded,
  audience: "mcp" | "api",
) {
  return repository.bindOAuthConsent({
    organizationId: seeded.organizationId,
    agentPrincipalId: seeded.agentPrincipalId,
    userId: seeded.userId,
    clientId: seeded.clientId,
    audience,
    projectId: seeded.projectId,
    laneIds: [],
    scopes: ["request:read"],
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    correlationId: crypto.randomUUID(),
    expectedVersion: 0,
    idempotencyKey: crypto.randomUUID(),
    fingerprintSecret: "audience-binding-fingerprint-secret",
  });
}

function resolveFor(
  repository: ReturnType<typeof createAgentAuthRepository>,
  seeded: Seeded,
  audience: "mcp" | "api",
) {
  return repository.resolveOAuthGrant({
    userId: seeded.userId,
    clientId: seeded.clientId,
    audience,
  });
}

describe.sequential("an OAuth grant is confined to the audience it was bound for", () => {
  test.each([
    ["mcp", "api"],
    ["api", "mcp"],
  ] as const)(
    "a grant bound for %s resolves for it, and not for %s",
    async (bound, other) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedConsentedClient(tx);
        const repository = createAgentAuthRepository(tx);
        const grant = await bindFor(repository, seeded, bound);

        // The control: without it, `null` below could mean the fixture never
        // produced a resolvable grant at all.
        await expect(
          resolveFor(repository, seeded, bound),
        ).resolves.toMatchObject({
          authorizationId: grant.id,
          audience: bound,
        });
        await expect(resolveFor(repository, seeded, other)).resolves.toBeNull();
      });
    },
    seedingTimeoutMs,
  );

  test("binding the other audience ends the first grant rather than adding one", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedConsentedClient(tx);
      const repository = createAgentAuthRepository(tx);
      const first = await bindFor(repository, seeded, "mcp");
      const second = await bindFor(repository, seeded, "api");

      // One pair, one active grant: the client now reaches the API and nothing
      // else, so no single client ever holds both audiences at once.
      await expect(resolveFor(repository, seeded, "mcp")).resolves.toBeNull();
      await expect(
        resolveFor(repository, seeded, "api"),
      ).resolves.toMatchObject({ authorizationId: second.id });

      const statuses = await tx.execute(sql`
        select "id", "status" from "agent_oauth_grants"
        where "user_id" = ${seeded.userId}
          and "oauth_client_id" = ${seeded.clientId}
      `);
      expect(
        Object.fromEntries(
          (statuses.rows as { id: string; status: string }[]).map((row) => [
            row.id,
            row.status,
          ]),
        ),
      ).toEqual({ [first.id]: "revoked", [second.id]: "active" });
    });
  });

  /**
   * The binder above is one writer. The partial unique index from migration
   * 0010 is what holds the rule for every writer, so it is asked directly: a
   * second active grant for the same pair, for the other audience, is refused.
   */
  test("the database refuses a second active grant for the same person and client", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedConsentedClient(tx);
      const repository = createAgentAuthRepository(tx);
      await bindFor(repository, seeded, "mcp");

      const consent = await tx.execute(sql`
        select "id" from "oauth_consent" where "client_id" = ${seeded.clientId}
      `);
      const refused = tx.execute(sql`
        insert into "agent_oauth_grants"
          ("id", "organization_id", "agent_principal_id", "user_id",
           "oauth_client_id", "provider_grant_id", "refresh_family_id",
           "audience", "project_id", "lane_ids", "scopes", "status",
           "expires_at")
        values (${crypto.randomUUID()}, ${seeded.organizationId},
          ${seeded.agentPrincipalId}, ${seeded.userId}, ${seeded.clientId},
          ${(consent.rows[0] as { id: string }).id}, ${crypto.randomUUID()},
          'api', ${seeded.projectId}, '[]'::jsonb, '["request:read"]'::jsonb,
          'active', now() + interval '30 days')
      `);

      // The last statement in this transaction: a refused insert aborts it,
      // and the rollback that follows is the one this helper takes anyway.
      await expect(refused).rejects.toMatchObject({
        cause: expect.objectContaining({
          code: "23505",
          constraint: "agent_oauth_grants_active_client_user_unique",
        }),
      });
    });
  });
});
