import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import { createAgentManagementRepository } from "../queries/agent-management-repository.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { createAgentAuthRepository } from "./agent-auth-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

// Every case below opens a database connection and seeds a whole organization
// before it asserts anything, and each statement is a network round trip.
// Vitest's 5s default is a local-Postgres budget, so bound these explicitly.
const seedingTimeoutMs = 30_000;

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  try {
    await suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    });
  } catch (error) {
    // Rethrow anything that is not the deliberate rollback, so a failed
    // expectation reports itself rather than arriving as "not a TestRollback".
    if (error instanceof TestRollback) return;
    throw error;
  }
  throw new Error("Expected the agent auth transaction to roll back");
}

/**
 * How the grant that minted a credential stands at the moment the credential is
 * presented. `revoked` and `expired` are the two ways an owner ends a grant.
 *
 * The last two split `revoked` down the middle: nothing in the database ties
 * `status` to `revoked_at`, so a half-written revocation can leave either one
 * set alone. Each is its own case so that each half of the check is provable
 * on its own rather than shadowed by the other.
 */
type IssuingGrantState =
  | "active"
  | "revoked"
  | "expired"
  | "status-inactive"
  | "revoked-timestamp-only";

const statusOf = (state: IssuingGrantState) =>
  state === "revoked" || state === "status-inactive" ? "revoked" : "active";

const revokedAtOf = (state: IssuingGrantState) =>
  state === "revoked" || state === "revoked-timestamp-only"
    ? sql`now()`
    : sql`null`;

async function seedCredential(
  tx: Tx,
  options: { issuingGrant?: IssuingGrantState } = {},
) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Credential owner', ${email}, now())
  `);
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Lineage tenant',
      ${`lineage-${organizationId}`}, 'active')
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
    values (${projectId}, ${organizationId}, 'Lineage project',
      ${`project-${projectId}`}, ${`LP${projectId.slice(0, 6)}`}, 'active')
  `);
  const agentPrincipalId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_principals"
      ("id", "organization_id", "project_id", "display_name", "slug",
       "status", "created_by_user_id")
    values (${agentPrincipalId}, ${organizationId}, ${projectId},
      'Lineage agent', ${`agent-${agentPrincipalId}`}, 'active', ${userId})
  `);
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, ${userId}, ${`secret_${crypto.randomUUID()}`},
      true, now() + interval '1 hour', now(), now())
  `);

  let issuedByGrantId: string | null = null;
  if (options.issuingGrant) {
    const clientId = `client_${crypto.randomUUID()}`;
    await tx.execute(sql`
      insert into "oauth_client"
        ("id", "client_id", "redirect_uris", "disabled",
         "token_endpoint_auth_method", "require_pkce")
      values (${clientId}, ${clientId},
        ${sql`array['https://example.invalid/callback']`}, false,
        'none', true)
    `);
    const consentId = `consent_${crypto.randomUUID()}`;
    await tx.execute(sql`
      insert into "oauth_consent" ("id", "client_id", "user_id", "scopes")
      values (${consentId}, ${clientId}, ${userId},
        ${sql`array['project:provision']`})
    `);
    issuedByGrantId = crypto.randomUUID();
    // A provisioning grant is the only kind that mints a credential, and the
    // database check forbids it from naming a project or holding any other
    // scope — so this is the shape the lineage column will actually reference.
    await tx.execute(sql`
      insert into "agent_oauth_grants"
        ("id", "organization_id", "agent_principal_id", "user_id",
         "oauth_client_id", "provider_grant_id", "refresh_family_id",
         "audience", "project_id", "lane_ids", "scopes", "status",
         "expires_at", "revoked_at")
      values (${issuedByGrantId}, ${organizationId}, ${agentPrincipalId},
        ${userId}, ${clientId}, ${consentId}, ${crypto.randomUUID()},
        'mcp', null, '[]'::jsonb, '["project:provision"]'::jsonb,
        ${statusOf(options.issuingGrant)},
        ${options.issuingGrant === "expired" ? sql`now() - interval '1 hour'` : sql`now() + interval '30 days'`},
        ${revokedAtOf(options.issuingGrant)})
    `);
  }

  const credentialId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_credentials"
      ("id", "organization_id", "agent_principal_id",
       "better_auth_api_key_id", "name", "prefix", "fingerprint", "audience",
       "project_id", "lane_ids", "scopes", "expires_at",
       "issued_by_grant_id", "created_by_user_id")
    values (${credentialId}, ${organizationId}, ${agentPrincipalId},
      ${apiKeyId}, 'Lineage credential', 'rp_live',
      ${`fingerprint_${credentialId}`}, 'mcp', ${projectId},
      '[]'::jsonb, '["request:read"]'::jsonb, now() + interval '30 days',
      ${issuedByGrantId}, ${userId})
  `);
  return {
    agentPrincipalId,
    apiKeyId,
    credentialId,
    issuedByGrantId,
    organizationId,
    projectId,
    userId,
  };
}

/**
 * A client the way dynamic client registration actually writes one.
 *
 * `require_pkce` is left null on purpose: the public register endpoint strips
 * `require_pkce` from the request body, so every self-registered agent client
 * has a null there. Better Auth reads null as "PKCE required" and enforces it,
 * so a fixture that wrote `true` here would be testing a row no agent can
 * produce.
 */
async function seedRegisteredClient(tx: Tx, userId: string) {
  const clientId = `client_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_client"
      ("id", "client_id", "redirect_uris", "disabled",
       "token_endpoint_auth_method")
    values (${clientId}, ${clientId},
      ${sql`array['http://127.0.0.1:41234/callback']`}, false, 'none')
  `);
  // Better Auth writes this row when the human approves the consent screen,
  // and binding refuses to invent a grant for an approval that did not happen.
  const consentId = `consent_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_consent" ("id", "client_id", "user_id", "scopes")
    values (${consentId}, ${clientId}, ${userId},
      ${sql`array['request:read']`})
  `);
  return clientId;
}

/** One credential per api key, so every extra credential needs an extra key. */
async function seedApiKey(tx: Tx, userId: string) {
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, ${userId}, ${`secret_${crypto.randomUUID()}`},
      true, now() + interval '1 hour', now(), now())
  `);
  return apiKeyId;
}

function mintInput(
  seeded: Awaited<ReturnType<typeof seedCredential>>,
  apiKeyId: string,
  issuedByGrantId: string,
) {
  return {
    organizationId: seeded.organizationId,
    agentPrincipalId: seeded.agentPrincipalId,
    betterAuthApiKeyId: apiKeyId,
    name: "Minted credential",
    prefix: "rp_live",
    fingerprint: `fingerprint_${apiKeyId}`,
    audience: "mcp" as const,
    projectId: seeded.projectId,
    laneIds: [],
    scopes: ["request:read"],
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    createdByUserId: seeded.userId,
    correlationId: crypto.randomUUID(),
    issuedByGrantId,
  };
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("live agent credential lineage", () => {
  test("resolves a credential a human issued in the UI, which records no grant", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const repository = createAgentAuthRepository(tx);

      // Every credential that existed before provisioning grants has a null
      // issued_by_grant_id. If the lineage check ever demands a grant row
      // unconditionally, all agent authentication stops here.
      await expect(
        repository.resolveApiKeyCredential({
          apiKeyId: seeded.apiKeyId,
          audience: "mcp",
        }),
      ).resolves.toMatchObject({
        authorizationId: seeded.credentialId,
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
      });
    });
  });

  test("resolves a credential whose issuing grant is still usable", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx, { issuingGrant: "active" });
      const repository = createAgentAuthRepository(tx);

      await expect(
        repository.resolveApiKeyCredential({
          apiKeyId: seeded.apiKeyId,
          audience: "mcp",
        }),
      ).resolves.toMatchObject({ authorizationId: seeded.credentialId });
    });
  });

  test("refuses a credential whose issuing grant was revoked", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx, { issuingGrant: "revoked" });
      const repository = createAgentAuthRepository(tx);

      // The point of the whole change: revoking the grant revokes what it
      // minted, without demoting the human the grant was delegated by.
      await expect(
        repository.resolveApiKeyCredential({
          apiKeyId: seeded.apiKeyId,
          audience: "mcp",
        }),
      ).resolves.toBeNull();
    });
  });

  test("refuses a credential whose issuing grant expired", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx, { issuingGrant: "expired" });
      const repository = createAgentAuthRepository(tx);

      // Expiry is a revocation nobody had to perform, so a grant that lapsed
      // on its own must take its credentials with it just the same.
      await expect(
        repository.resolveApiKeyCredential({
          apiKeyId: seeded.apiKeyId,
          audience: "mcp",
        }),
      ).resolves.toBeNull();
    });
  });

  test("refuses a credential whose recorded grant belongs to another tenant", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const credential = await seedCredential(tx);
      const foreign = await seedCredential(tx, { issuingGrant: "active" });
      // The foreign key names the grant's primary key alone, so nothing in
      // the database stops a credential recording a grant in a tenant it has
      // no relationship with. Such a credential must fail closed rather than
      // borrow the other tenant's still-active grant as its own liveness.
      await tx.execute(sql`
          update "agent_credentials"
          set "issued_by_grant_id" = ${foreign.issuedByGrantId}
          where "id" = ${credential.credentialId}
        `);
      const repository = createAgentAuthRepository(tx);

      await expect(
        repository.resolveApiKeyCredential({
          apiKeyId: credential.apiKeyId,
          audience: "mcp",
        }),
      ).resolves.toBeNull();
    });
  });

  test("stops resolving a minted credential the moment its grant is revoked", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx, { issuingGrant: "active" });
      const repository = createAgentAuthRepository(tx);
      const grantId = seeded.issuedByGrantId;
      if (!grantId) throw new Error("Expected the seed to record a grant");

      // Issued through the repository rather than by raw insert, because the
      // lineage is only worth anything if the issuing path actually records
      // it.
      const apiKeyId = await seedApiKey(tx, seeded.userId);
      const minted = await repository.createCredential(
        mintInput(seeded, apiKeyId, grantId),
      );
      expect(minted.issuedByGrantId).toBe(grantId);

      await expect(
        repository.resolveApiKeyCredential({ apiKeyId, audience: "mcp" }),
      ).resolves.toMatchObject({ authorizationId: minted.id });

      await repository.revokeOAuthGrant({
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.agentPrincipalId,
        grantId,
        actorUserId: seeded.userId,
        correlationId: crypto.randomUUID(),
        reason: "Owner revoked a compromised provisioning grant",
        expectedVersion: 1,
        idempotencyKey: `revoke-${crypto.randomUUID()}`,
        fingerprintSecret: "test-fingerprint-secret-at-least-32-chars",
      });

      // One revocation, and the credential it minted is done — the owner
      // never has to demote themselves to take back what the grant issued.
      await expect(
        repository.resolveApiKeyCredential({ apiKeyId, audience: "mcp" }),
      ).resolves.toBeNull();
    });
  });

  test("refuses a credential whose issuing grant is no longer active", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx, {
        issuingGrant: "status-inactive",
      });
      const repository = createAgentAuthRepository(tx);

      // A non-active status with no revoked_at timestamp is reachable, so
      // status is checked in its own right rather than inferred from the
      // timestamp beside it.
      await expect(
        repository.resolveApiKeyCredential({
          apiKeyId: seeded.apiKeyId,
          audience: "mcp",
        }),
      ).resolves.toBeNull();
    });
  });

  test("refuses a credential whose issuing grant carries a revocation timestamp", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx, {
        issuingGrant: "revoked-timestamp-only",
      });
      const repository = createAgentAuthRepository(tx);

      // The mirror of the case above: a revocation timestamp with the status
      // still reading `active`. Neither half may be inferred from the other,
      // because nothing in the database ties them together.
      await expect(
        repository.resolveApiKeyCredential({
          apiKeyId: seeded.apiKeyId,
          audience: "mcp",
        }),
      ).resolves.toBeNull();
    });
  });

  for (const state of [
    "revoked",
    "expired",
    "status-inactive",
    "revoked-timestamp-only",
  ] as const) {
    test(`refuses to mint from a grant that is ${state}`, {
      timeout: seedingTimeoutMs,
    }, async () => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedCredential(tx, { issuingGrant: state });
        const repository = createAgentAuthRepository(tx);
        const grantId = seeded.issuedByGrantId;
        if (!grantId) throw new Error("Expected the seed to record a grant");
        const apiKeyId = await seedApiKey(tx, seeded.userId);

        // Resolution would refuse the result anyway, so this exists to make
        // the refusal legible at the moment of minting rather than shipping a
        // caller a plaintext secret that was never going to authenticate.
        await expect(
          repository.createCredential(mintInput(seeded, apiKeyId, grantId)),
        ).rejects.toMatchObject({ code: "forbidden" });
      });
    });
  }

  test("refuses to mint from a grant that belongs to another tenant", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const foreign = await seedCredential(tx, { issuingGrant: "active" });
      const foreignGrantId = foreign.issuedByGrantId;
      if (!foreignGrantId) {
        throw new Error("Expected the seed to record a grant");
      }
      const repository = createAgentAuthRepository(tx);
      const apiKeyId = await seedApiKey(tx, seeded.userId);

      // An active grant is still no authority outside its own organization,
      // and no foreign key says so — the check has to.
      await expect(
        repository.createCredential(
          mintInput(seeded, apiKeyId, foreignGrantId),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });
});

describe.sequential("binding a consent to a self-registered client", () => {
  test("binds a grant for a client registered through the public endpoint", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const clientId = await seedRegisteredClient(tx, seeded.userId);
      const repository = createAgentAuthRepository(tx);

      await expect(
        repository.bindOAuthConsent({
          organizationId: seeded.organizationId,
          agentPrincipalId: seeded.agentPrincipalId,
          userId: seeded.userId,
          clientId,
          audience: "mcp",
          projectId: seeded.projectId,
          laneIds: [],
          scopes: ["request:read"],
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
          correlationId: crypto.randomUUID(),
          expectedVersion: 0,
          idempotencyKey: crypto.randomUUID(),
          fingerprintSecret: "consent-binding-fingerprint-secret",
        }),
      ).resolves.toMatchObject({ id: expect.any(String) });
    });
  });

  /**
   * Connecting the same agent a second time.
   *
   * The proposed principal id is derived from the request, so a new connection
   * derives a new one; the proposed slug is derived from the client's name, so
   * it does not change. The insert conflicts on (organization, slug), inserts
   * nothing, and the fallback looks the principal up by the id that was never
   * written — leaving "you do not have permission to authorize this
   * connection" as the answer to reconnecting an agent, every time, for as
   * long as the first principal exists.
   */
  test("says a name is taken rather than refusing the person", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const clientId = await seedRegisteredClient(tx, seeded.userId);
      const repository = createAgentAuthRepository(tx);
      const bind = (principalId: string) =>
        repository.bindOAuthConsent({
          organizationId: seeded.organizationId,
          agentPrincipalId: principalId,
          userId: seeded.userId,
          clientId,
          audience: "mcp" as const,
          projectId: seeded.projectId,
          laneIds: [],
          scopes: ["request:read"],
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
          correlationId: crypto.randomUUID(),
          expectedVersion: 0,
          idempotencyKey: crypto.randomUUID(),
          fingerprintSecret: "consent-binding-fingerprint-secret",
          newPrincipal: {
            id: principalId,
            displayName: "Release bot",
            slug: "release-bot",
            softwareName: "Release bot",
          },
        });

      const first = crypto.randomUUID();
      await expect(bind(first)).resolves.toMatchObject({
        id: expect.any(String),
      });

      // The same agent, connecting again: same name, therefore same slug, and
      // a different derived id.
      await expect(bind(crypto.randomUUID())).rejects.toMatchObject({
        code: "conflict",
      });
    });
  });

  /**
   * The consent gates tell a public client by its token endpoint method:
   * `none` is admitted, and a method that sends a secret is refused.
   *
   * Better Auth 1.6.29 also wrote a `public` column, as exactly "the method
   * is `none`". 1.7.6 has no field for it, and 0022 (K.4) dropped the column,
   * so the method is the only record of it left.
   */
  test("admits a public client and refuses a confidential one by the token endpoint method", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const publicClient = await seedRegisteredClient(tx, seeded.userId);
      const confidentialClient = await seedRegisteredClient(tx, seeded.userId);
      await tx.execute(sql`
        update "oauth_client"
        set "token_endpoint_auth_method" = 'client_secret_basic'
        where "client_id" = ${confidentialClient}
      `);
      const repository = createAgentAuthRepository(tx);
      const management = createAgentManagementRepository(
        tx as unknown as Database,
      );
      const bind = (clientId: string, agentPrincipalId: string) =>
        repository.bindOAuthConsent({
          organizationId: seeded.organizationId,
          agentPrincipalId,
          userId: seeded.userId,
          clientId,
          audience: "mcp",
          projectId: seeded.projectId,
          laneIds: [],
          scopes: ["request:read"],
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
          correlationId: crypto.randomUUID(),
          expectedVersion: 0,
          idempotencyKey: crypto.randomUUID(),
          fingerprintSecret: "consent-binding-fingerprint-secret",
        });

      await expect(
        management.getConsentOptions(seeded.userId, publicClient),
      ).resolves.toMatchObject({ client: { clientId: publicClient } });
      await expect(
        management.getConsentOptions(seeded.userId, confidentialClient),
      ).resolves.toBeNull();
      await expect(
        bind(confidentialClient, seeded.agentPrincipalId),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        bind(publicClient, seeded.agentPrincipalId),
      ).resolves.toMatchObject({ id: expect.any(String) });
    });
  });

  test("refuses a client whose registration turned PKCE off", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const clientId = await seedRegisteredClient(tx, seeded.userId);
      await tx.execute(sql`
        update "oauth_client" set "require_pkce" = false
        where "client_id" = ${clientId}
      `);
      const repository = createAgentAuthRepository(tx);

      // Null means "required" and false means "not required". Treating the two
      // alike in either direction is the whole hazard: one way no agent can
      // ever consent, the other way a client that opted out of proof of
      // possession can.
      await expect(
        repository.bindOAuthConsent({
          organizationId: seeded.organizationId,
          agentPrincipalId: seeded.agentPrincipalId,
          userId: seeded.userId,
          clientId,
          audience: "mcp",
          projectId: seeded.projectId,
          laneIds: [],
          scopes: ["request:read"],
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
          correlationId: crypto.randomUUID(),
          expectedVersion: 0,
          idempotencyKey: crypto.randomUUID(),
          fingerprintSecret: "consent-binding-fingerprint-secret",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });
});

describe.sequential("repairing a consent no grant stands behind", () => {
  async function seedPair(
    tx: Tx,
    grant: "usable" | "expired" | "revoked" | "none",
  ) {
    const seeded = await seedCredential(tx);
    const clientId = await seedRegisteredClient(tx, seeded.userId);
    if (grant !== "none") {
      await tx.execute(sql`
        insert into "agent_oauth_grants"
          ("id", "organization_id", "agent_principal_id", "user_id",
           "oauth_client_id", "provider_grant_id", "refresh_family_id",
           "audience", "project_id", "lane_ids", "scopes", "status",
           "expires_at", "revoked_at")
        values (${crypto.randomUUID()}, ${seeded.organizationId},
          ${seeded.agentPrincipalId}, ${seeded.userId}, ${clientId},
          ${(await tx.execute(sql`select "id" from "oauth_consent" where "client_id" = ${clientId} limit 1`)).rows[0].id},
          ${crypto.randomUUID()}, 'mcp', null, '[]'::jsonb,
          '["project:provision"]'::jsonb,
          ${grant === "revoked" ? "revoked" : "active"},
          ${grant === "expired" ? sql`now() - interval '1 hour'` : sql`now() + interval '30 days'`},
          ${grant === "revoked" ? sql`now()` : sql`null`})
      `);
    }
    return { clientId, userId: seeded.userId };
  }

  async function consentScopes(tx: Tx, clientId: string) {
    const found = await tx.execute(
      sql`select "scopes" from "oauth_consent" where "client_id" = ${clientId}`,
    );
    return (found.rows[0] as { scopes: string[] }).scopes;
  }

  test("leaves a consent a usable grant stands behind", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const { clientId, userId } = await seedPair(tx, "usable");
      const repository = createAgentAuthRepository(tx);

      await repository.invalidateUnboundOAuthProviderAuthorization({
        userId,
        clientId,
      });

      // The ordinary case, and the one that must stay silent: emptying this
      // would send every working agent back through the consent screen.
      expect(await consentScopes(tx, clientId)).not.toEqual([]);
    });
  });

  test.each(["none", "expired", "revoked"] as const)(
    "repairs a consent standing on a %s grant",
    async (grant) => {
      await inRollbackTransaction(async (tx) => {
        const { clientId, userId } = await seedPair(tx, grant);
        const repository = createAgentAuthRepository(tx);

        await repository.invalidateUnboundOAuthProviderAuthorization({
          userId,
          clientId,
        });

        // `expired` and `revoked` are the cases a stand-in cannot model. The
        // bearer path refuses both, so leaving the consent satisfied leaves the
        // client exactly as stranded as one with no grant at all — and the
        // consent screen, which would have fixed it, is skipped in that state.
        expect(await consentScopes(tx, clientId)).toEqual([]);
      });
    },
    seedingTimeoutMs,
  );
});
