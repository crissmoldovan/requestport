import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test, vi } from "vitest";

import type { Database } from "../client.js";
import {
  createStorage,
  selectDriver,
  storageOptionsFromEnv,
} from "../client.js";
import { createAgentManagementRepository } from "../queries/agent-management-repository.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import { openSession } from "../testing.js";
import type { Tx } from "../transaction.js";
import {
  agentLastUseStampSeconds,
  createAgentAuthRepository,
} from "./agent-auth-repository.js";

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

/*
 * Ruling 234 (c): a person's credential, read again in the reservation's and
 * the binding's own transactions. Off the bus, `./agent-services` re-checks a
 * person in a transaction that ends before these writes start, so each write
 * is handed the credential the person's call names (`personCredentialId`)
 * and reads it again under its own locks: a session deleted (Better Auth's
 * revocation) or expired since is refused in the bus's words, and nothing is
 * written. Without one, the person is checked by membership and role alone,
 * as every caller before ruling 234 (c) did.
 */
describe.sequential("a person's credential, read again inside the reservation and the binding (ruling 234 (c))", () => {
  const refusal = {
    code: "forbidden",
    message: "Current human authorization is no longer active",
  };

  async function seedSessionOf(
    tx: Tx,
    userId: string,
    state: "live" | "expired" | "deleted",
  ) {
    const sessionId = `session_${crypto.randomUUID()}`;
    await tx.execute(sql`
      insert into "session" ("id", "expires_at", "token", "updated_at", "user_id")
      values (${sessionId},
        now() + ${state === "expired" ? "-1 minute" : "1 hour"}::interval,
        ${`token_${crypto.randomUUID()}`}, now(), ${userId})
    `);
    if (state === "deleted") {
      await tx.execute(sql`delete from "session" where "id" = ${sessionId}`);
    }
    return sessionId;
  }

  /** Another person, with a live session and no membership. */
  async function seedOutsiderSession(tx: Tx) {
    const userId = `user_${crypto.randomUUID()}`;
    const email = `${userId}@example.invalid`;
    await tx.execute(sql`
      insert into "signup_allowlist" ("normalized_email", "status")
      values (${email}, 'active')
    `);
    await tx.execute(sql`
      insert into "user" ("id", "name", "email", "updated_at")
      values (${userId}, 'Outsider', ${email}, now())
    `);
    return seedSessionOf(tx, userId, "live");
  }

  /**
   * Another active member of the organisation, an admin, with a live
   * session: the membership join admits that session's own person, so only
   * the session's owner, read against the person the call names, refuses it.
   */
  async function seedMemberSession(tx: Tx, organizationId: string) {
    const sessionId = await seedOutsiderSession(tx);
    await tx.execute(sql`
      insert into "organization_members" ("organization_id", "user_id", "role", "status")
      select ${organizationId}, "user_id", 'admin', 'active'
      from "session" where "id" = ${sessionId}
    `);
    return sessionId;
  }

  async function countFor(tx: Tx, table: string, organizationId: string) {
    const counted = await tx.execute(
      sql`select count(*)::int as n from ${sql.identifier(table)} where "organization_id" = ${organizationId}`,
    );
    return Number((counted.rows[0] as { n: number }).n);
  }

  function reservation(
    seeded: Awaited<ReturnType<typeof seedCredential>>,
    personCredentialId?: string,
  ) {
    return {
      actorUserId: seeded.userId,
      ...(personCredentialId === undefined ? {} : { personCredentialId }),
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      idempotencyKey: crypto.randomUUID(),
      expectedVersion: 0,
      fingerprintSecret: "credential-reservation-fingerprint-secret",
      normalizedInput: { case: crypto.randomUUID() },
    };
  }

  test("reserveCredentialIssuance refuses an expired session, a deleted one, a non-member's and another member's, in the bus's words, and saves no receipt", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const repository = createAgentAuthRepository(tx);
      const credentials = [
        await seedSessionOf(tx, seeded.userId, "expired"),
        await seedSessionOf(tx, seeded.userId, "deleted"),
        await seedOutsiderSession(tx),
        await seedMemberSession(tx, seeded.organizationId),
      ];

      for (const personCredentialId of credentials) {
        await expect(
          repository.reserveCredentialIssuance(
            reservation(seeded, personCredentialId),
          ),
        ).rejects.toMatchObject(refusal);
      }
      expect(
        await countFor(tx, "command_receipts", seeded.organizationId),
      ).toBe(0);
    });
  });

  test("reserveCredentialIssuance reserves for the person's live session, and, given no credential, as before", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const repository = createAgentAuthRepository(tx);
      const live = await seedSessionOf(tx, seeded.userId, "live");

      await expect(
        repository.reserveCredentialIssuance(reservation(seeded, live)),
      ).resolves.toMatchObject({ reserved: true });
      await expect(
        repository.reserveCredentialIssuance(reservation(seeded)),
      ).resolves.toMatchObject({ reserved: true });
      expect(
        await countFor(tx, "command_receipts", seeded.organizationId),
      ).toBe(2);
    });
  });

  test("reserveCredentialIssuance refuses a replay of an earlier reservation once its session has ended, before the earlier receipt is answered", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const repository = createAgentAuthRepository(tx);
      const live = await seedSessionOf(tx, seeded.userId, "live");
      // One input, so each call names the same receipt.
      const input = reservation(seeded, live);

      await expect(
        repository.reserveCredentialIssuance(input),
      ).resolves.toMatchObject({ reserved: true });
      // The control: while the session is live, a replay is answered with
      // the earlier receipt.
      await expect(
        repository.reserveCredentialIssuance(input),
      ).resolves.toMatchObject({ reserved: false });
      await tx.execute(sql`delete from "session" where "id" = ${live}`);

      await expect(
        repository.reserveCredentialIssuance(input),
      ).rejects.toMatchObject(refusal);
      expect(
        await countFor(tx, "command_receipts", seeded.organizationId),
      ).toBe(1);
    });
  });

  function binding(
    seeded: Awaited<ReturnType<typeof seedCredential>>,
    clientId: string,
    personCredentialId?: string,
  ) {
    return {
      organizationId: seeded.organizationId,
      agentPrincipalId: seeded.agentPrincipalId,
      userId: seeded.userId,
      ...(personCredentialId === undefined ? {} : { personCredentialId }),
      clientId,
      audience: "mcp" as const,
      projectId: seeded.projectId,
      laneIds: [],
      scopes: ["request:read"],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      correlationId: crypto.randomUUID(),
      expectedVersion: 0 as const,
      idempotencyKey: crypto.randomUUID(),
      fingerprintSecret: "consent-binding-fingerprint-secret",
    };
  }

  test("bindOAuthConsent refuses an expired session, a deleted one, a non-member's and another member's, in the bus's words, and writes no grant", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const clientId = await seedRegisteredClient(tx, seeded.userId);
      const repository = createAgentAuthRepository(tx);
      const credentials = [
        await seedSessionOf(tx, seeded.userId, "expired"),
        await seedSessionOf(tx, seeded.userId, "deleted"),
        await seedOutsiderSession(tx),
        await seedMemberSession(tx, seeded.organizationId),
      ];

      for (const personCredentialId of credentials) {
        await expect(
          repository.bindOAuthConsent(
            binding(seeded, clientId, personCredentialId),
          ),
        ).rejects.toMatchObject(refusal);
      }
      expect(
        await countFor(tx, "agent_oauth_grants", seeded.organizationId),
      ).toBe(0);
      expect(
        await countFor(tx, "command_receipts", seeded.organizationId),
      ).toBe(0);
    });
  });

  test("bindOAuthConsent binds for the person's live session, and, given no credential, as before", {
    timeout: seedingTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const first = await seedRegisteredClient(tx, seeded.userId);
      const second = await seedRegisteredClient(tx, seeded.userId);
      const repository = createAgentAuthRepository(tx);
      const live = await seedSessionOf(tx, seeded.userId, "live");

      await expect(
        repository.bindOAuthConsent(binding(seeded, first, live)),
      ).resolves.toMatchObject({ id: expect.any(String) });
      await expect(
        repository.bindOAuthConsent(binding(seeded, second)),
      ).resolves.toMatchObject({ id: expect.any(String) });
      expect(
        await countFor(tx, "agent_oauth_grants", seeded.organizationId),
      ).toBe(2);
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

/*
  The last-use stamp (ruling 261): the bearer path stamps the key or the
  grant it has just resolved, bound to the organisation the lookup found, and
  writes at most once per `agentLastUseStampSeconds` for each key or grant.
  The stamp and its comparison both read the database's clock.
*/

type StampedTable = "agent_credentials" | "agent_oauth_grants";

const stampedKinds = [
  ["an API key", "agent_credentials"],
  ["an OAuth grant", "agent_oauth_grants"],
] as const satisfies readonly (readonly [string, StampedTable])[];

/** The key or grant a seeded credential stands for, by table. */
function stampedId(
  seeded: Awaited<ReturnType<typeof seedCredential>>,
  table: StampedTable,
) {
  const id =
    table === "agent_credentials"
      ? seeded.credentialId
      : seeded.issuedByGrantId;
  if (!id) throw new Error("the seed has no issuing grant");
  return id;
}

function touch(
  repository: ReturnType<typeof createAgentAuthRepository>,
  table: StampedTable,
  id: string,
  organizationId: string,
) {
  return table === "agent_credentials"
    ? repository.touchCredential(id, organizationId)
    : repository.touchOAuthGrant(id, organizationId);
}

/**
 * `last_used_at` in epoch milliseconds, read outside the repository: a raw
 * read hands a timestamp back as text, so the database converts it.
 */
async function lastUsedAt(tx: Tx, table: StampedTable, id: string) {
  const { rows } = await tx.execute<{ ms: number | string | null }>(
    table === "agent_credentials"
      ? sql`select (extract(epoch from "last_used_at") * 1000)::float8 as "ms" from "agent_credentials" where "id" = ${id}`
      : sql`select (extract(epoch from "last_used_at") * 1000)::float8 as "ms" from "agent_oauth_grants" where "id" = ${id}`,
  );
  const ms = rows[0]?.ms ?? null;
  return ms === null ? null : Number(ms);
}

/** The database's clock, in epoch milliseconds, read by the database. */
async function databaseNow(tx: Tx) {
  const { rows } = await tx.execute<{ ms: number | string }>(
    sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as "ms"`,
  );
  return Number(rows[0]?.ms);
}

/** Moves `last_used_at` to `ago` before the database's now. */
async function stampedAgo(
  tx: Tx,
  table: StampedTable,
  id: string,
  ago: string,
) {
  await tx.execute(
    table === "agent_credentials"
      ? sql`update "agent_credentials" set "last_used_at" = clock_timestamp() - ${ago}::interval where "id" = ${id}`
      : sql`update "agent_oauth_grants" set "last_used_at" = clock_timestamp() - ${ago}::interval where "id" = ${id}`,
  );
}

describe.sequential("the last-use stamp (ruling 261)", () => {
  test("stamps at most once every five minutes", () => {
    expect(agentLastUseStampSeconds).toBe(300);
  });

  test.each(stampedKinds)(
    "stamps %s once per interval, by the database's clock",
    async (_kind, table) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedCredential(tx, { issuingGrant: "active" });
        const id = stampedId(seeded, table);
        const repository = createAgentAuthRepository(tx);
        expect(await lastUsedAt(tx, table, id)).toBeNull();

        // On PostgreSQL this process's clock runs a day ahead of the
        // database's from here on (only `Date` is faked, so timers run as
        // they do). A stamp taken from it would be a day off the database's
        // now, and a threshold taken from it would find the 280-second-old
        // stamp below due. Not on PGlite, which runs inside this process and
        // whose `clock_timestamp()` follows this process's `Date` (measured
        // 2026-10-25 with PGlite 0.5.8): there the skew would move both
        // clocks, so the case runs without it.
        if (selectDriver(process.env) !== "pglite") {
          vi.useFakeTimers({ now: Date.now() + 86_400_000, toFake: ["Date"] });
        }
        try {
          // The first authentication stamps, with the database's now.
          await expect(
            touch(repository, table, id, seeded.organizationId),
          ).resolves.toBe(true);
          const first = await lastUsedAt(tx, table, id);
          expect(first).toEqual(expect.any(Number));
          expect(Math.abs((first ?? 0) - (await databaseNow(tx)))).toBeLessThan(
            60_000,
          );

          // A second one inside the interval writes nothing.
          await expect(
            touch(repository, table, id, seeded.organizationId),
          ).resolves.toBe(false);
          expect(await lastUsedAt(tx, table, id)).toEqual(first);

          // Twenty seconds short of the interval, still nothing.
          await stampedAgo(tx, table, id, "280 seconds");
          const almost = await lastUsedAt(tx, table, id);
          await expect(
            touch(repository, table, id, seeded.organizationId),
          ).resolves.toBe(false);
          expect(await lastUsedAt(tx, table, id)).toEqual(almost);

          // Past it, a fresh stamp from the database's now.
          await stampedAgo(tx, table, id, "301 seconds");
          const stale = await lastUsedAt(tx, table, id);
          await expect(
            touch(repository, table, id, seeded.organizationId),
          ).resolves.toBe(true);
          const fresh = await lastUsedAt(tx, table, id);
          expect(fresh).toBeGreaterThan((stale ?? 0) + 300_000);
          expect(Math.abs((fresh ?? 0) - (await databaseNow(tx)))).toBeLessThan(
            60_000,
          );
        } finally {
          vi.useRealTimers();
        }
      });
    },
    seedingTimeoutMs,
  );

  test.each(stampedKinds)(
    "stamps %s only in the organisation it is handed",
    async (_kind, table) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedCredential(tx, { issuingGrant: "active" });
        const id = stampedId(seeded, table);

        await expect(
          touch(createAgentAuthRepository(tx), table, id, crypto.randomUUID()),
        ).resolves.toBe(false);
        expect(await lastUsedAt(tx, table, id)).toBeNull();
      });
    },
    seedingTimeoutMs,
  );

  /*
    Two sessions at once, which PGlite's one connection cannot hold: the
    second stamp waits for the first one's row lock and, once it commits,
    reads the row again and finds it fresh, so the pair writes once. Skipped
    on PGlite for that reason alone; the lane's single-session exclusions are
    the same kind of case (packages/db/vitest.config.ts).
  */
  test.skipIf(selectDriver(process.env) === "pglite").each(stampedKinds)(
    "writes once when two authentications of %s stamp at the same moment",
    async (_kind, table) => {
      let seeded: Awaited<ReturnType<typeof seedCredential>> | undefined;
      await suiteStorage.transaction(async (tx) => {
        seeded = await seedCredential(tx, { issuingGrant: "active" });
      });
      if (!seeded) throw new Error("no seed");
      const organizationId = seeded.organizationId;
      const id = stampedId(seeded, table);
      const first = await openSession(suiteStorage);
      const second = await openSession(suiteStorage);
      let releaseFirst = () => {};
      const firstHolds = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const transactions: Promise<unknown>[] = [];
      try {
        let firstStamped: (stamped: boolean) => void = () => {};
        let firstFailed: (reason: unknown) => void = () => {};
        const firstAnswer = new Promise<boolean>((resolve, reject) => {
          firstStamped = resolve;
          firstFailed = reject;
        });
        const firstTransaction = first.db.transaction(async (tx) => {
          firstStamped(
            await touch(
              createAgentAuthRepository(tx),
              table,
              id,
              organizationId,
            ),
          );
          // Holds the row lock the stamp took until the second one waits.
          await firstHolds;
        });
        transactions.push(firstTransaction);
        // A stamp that throws ends the first transaction before it answers.
        // Its failure settles the answer, so the case fails at once rather
        // than waiting out its timeout, and the `finally` below still
        // releases both sessions.
        void firstTransaction.catch(firstFailed);
        expect(await firstAnswer).toBe(true);

        const secondTransaction = second.db.transaction((tx) =>
          touch(createAgentAuthRepository(tx), table, id, organizationId),
        );
        transactions.push(secondTransaction);
        let settled = false;
        void secondTransaction.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        expect(settled).toBe(false);

        releaseFirst();
        await firstTransaction;
        await expect(secondTransaction).resolves.toBe(false);
      } finally {
        // A failed expectation must not leave the first transaction holding
        // its row lock over the teardown below.
        releaseFirst();
        await Promise.allSettled(transactions);
        first.release();
        second.release();
        // Committed rows: the tenant is archived and its key and grant
        // revoked, as committed choreography fixtures are released
        // (appearance-repository.integration.test.ts), since the owner
        // membership's appearance event cannot be deleted.
        await suiteStorage.transaction(async (tx) => {
          await tx.execute(sql`
            update "agent_credentials" set "revoked_at" = now()
            where "organization_id" = ${organizationId}
          `);
          await tx.execute(sql`
            update "agent_oauth_grants"
            set "status" = 'revoked', "revoked_at" = now()
            where "organization_id" = ${organizationId}
          `);
          await tx.execute(sql`
            update "organizations" set "status" = 'archived'
            where "id" = ${organizationId}
          `);
        });
      }
    },
    seedingTimeoutMs,
  );
});
