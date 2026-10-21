import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import { endingEachMethodBinding } from "../test-support/tenant-binding.js";
import type { Tx } from "../transaction.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/**
 * The repository on the case's transaction. `assertCurrent` binds the
 * context's organisation, and a case here re-checks contexts of several
 * organisations on one transaction, so each call's binding is ended as the
 * caller's own transaction would end it (test-support/tenant-binding.ts).
 */
function authorizationOn(tx: Tx) {
  return endingEachMethodBinding(createCommandAuthorizationRepository(tx), tx);
}

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
}

async function seedSession(tx: Tx, { expired = false } = {}) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Authorization user', ${email}, now())
  `);
  const sessionId = `session_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "session" ("id", "expires_at", "token", "updated_at", "user_id")
    values (${sessionId},
      now() + ${expired ? "-1 hour" : "1 hour"}::interval,
      ${`token_${crypto.randomUUID()}`}, now(), ${userId})
  `);
  return { userId, sessionId };
}

function personalContext(input: { userId: string; sessionId: string }) {
  return {
    actor: { type: "user" as const, id: input.userId },
    credentialId: input.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("live session-only command authorization", () => {
  test("accepts a signed-in user with no organization at all", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedSession(tx);
      const repository = authorizationOn(tx);

      await expect(
        repository.assertCurrentUser(personalContext(seeded)),
      ).resolves.toBeUndefined();
    });
  });

  test("accepts a user whose every organization is suspended", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedSession(tx);
      const organizationId = crypto.randomUUID();
      await tx.execute(sql`
        insert into "organizations" ("id", "name", "slug", "status")
        values (${organizationId}, 'Suspended tenant',
          ${`suspended-${organizationId}`}, 'suspended')
      `);
      await tx.execute(sql`
        insert into "organization_members"
          ("organization_id", "user_id", "role", "status")
        values (${organizationId}, ${seeded.userId}, 'owner', 'active')
      `);
      const repository = authorizationOn(tx);

      await expect(
        repository.assertCurrentUser(personalContext(seeded)),
      ).resolves.toBeUndefined();
      // The tenant path is unchanged: a suspended organization still denies
      // every organization-scoped command for the same session.
      await expect(
        repository.assertCurrent({
          ...personalContext(seeded),
          organizationId,
          scopes: new Set<string>(),
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  test("denies an expired session, a foreign session, and an unknown one", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const valid = await seedSession(tx);
      const other = await seedSession(tx);
      const expired = await seedSession(tx, { expired: true });
      const repository = authorizationOn(tx);

      for (const context of [
        personalContext(expired),
        personalContext({ userId: valid.userId, sessionId: other.sessionId }),
        personalContext({
          userId: valid.userId,
          sessionId: `session_${crypto.randomUUID()}`,
        }),
      ]) {
        await expect(
          repository.assertCurrentUser(context),
        ).rejects.toMatchObject({
          code: "forbidden",
          message: "Current human authorization is no longer active",
        });
      }
    });
  });

  test("denies a session whose user record has been removed", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedSession(tx);
      await tx.execute(sql`
        delete from "user" where "id" = ${seeded.userId}
      `);
      const repository = authorizationOn(tx);

      await expect(
        repository.assertCurrentUser(personalContext(seeded)),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });
});

/**
 * Seeds the organization-wide provisioning grant an agent holds between
 * consent and its first working credential.
 *
 * It names no project on purpose. `project:provision` is organization-wide and
 * exclusive, so the grant, and the principal it belongs to, both carry a null
 * project — the schema declares both columns nullable for exactly this.
 */
async function seedProvisioningGrant(
  tx: Tx,
  { role = "owner", revoked = false } = {},
) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const clientId = `client_${crypto.randomUUID()}`;

  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Provisioning owner', ${email}, now())
  `);
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Provisioning tenant',
      ${`provisioning-${organizationId}`}, 'active')
  `);
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, 'active')
  `);
  await tx.execute(sql`
    insert into "agent_principals"
      ("id", "organization_id", "project_id", "display_name", "slug",
       "status", "created_by_user_id")
    values (${principalId}, ${organizationId}, null, 'Provisioning agent',
      ${`provisioning-${principalId}`}, 'active', ${userId})
  `);
  await tx.execute(sql`
    insert into "oauth_client"
      ("id", "client_id", "disabled", "name", "redirect_uris")
    values (${clientId}, ${clientId}, false, 'Provisioning client',
      ${sql`array['http://127.0.0.1:41999/callback']`})
  `);
  // The grant points at the consent that produced it, so the consent has to
  // exist: `provider_grant_id` is a foreign key into `oauth_consent`.
  await tx.execute(sql`
    insert into "oauth_consent" ("id", "client_id", "user_id", "scopes")
    values (${`provider_${grantId}`}, ${clientId}, ${userId},
      ${sql`array['project:provision']`})
  `);
  await tx.execute(sql`
    insert into "agent_oauth_grants"
      ("id", "organization_id", "agent_principal_id", "user_id",
       "oauth_client_id", "provider_grant_id", "refresh_family_id",
       "audience", "project_id", "scopes", "status", "expires_at",
       "revoked_at")
    values (${grantId}, ${organizationId}, ${principalId}, ${userId},
      ${clientId}, ${`provider_${grantId}`}, ${`family_${grantId}`},
      'mcp', null, ${JSON.stringify(["project:provision"])}::jsonb,
      ${revoked ? "revoked" : "active"}, now() + '1 hour'::interval,
      ${revoked ? sql`now()` : sql`null`})
  `);

  return { clientId, grantId, organizationId, principalId, userId };
}

/**
 * The context `provision_agent` builds for a delegated provisioning call
 * (`packages/core/src/mcp-only/project-provisioning.ts`, which the MCP route
 * runs): the human the consent screen named, acting, carrying the agent
 * authorization that delegates to them.
 */
function delegatedProvisioningContext(seeded: {
  grantId: string;
  organizationId: string;
  userId: string;
}) {
  return {
    actor: { type: "user" as const, id: seeded.userId },
    organizationId: seeded.organizationId,
    credentialId: seeded.grantId,
    correlationId: crypto.randomUUID(),
    scopes: new Set(["agent:manage"]),
  };
}

describe.sequential("delegated provisioning authorization", () => {
  /**
   * The journey this unblocks: an agent completes consent, creates a project,
   * and asks for its first working credential. `provision_agent` runs
   * `create_agent_principal` on the command bus, and the bus revalidates the
   * acting context inside the transaction before the command's own authorize
   * runs.
   *
   * Every such command was refused. The context names a human — deliberately,
   * so the audit trail names the person who consented — but carries an agent
   * authorization as its credential, and the human recheck looked for a
   * browser session with that identifier. No session can ever have one, so a
   * registered tool could not succeed on any input.
   */
  test("accepts the human a live organization-wide grant delegates to", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedProvisioningGrant(tx);
      const repository = authorizationOn(tx);

      await expect(
        repository.assertCurrent(delegatedProvisioningContext(seeded)),
      ).resolves.toBeUndefined();
    });
  });

  test("denies a revoked grant, a foreign one, and an unknown one", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const live = await seedProvisioningGrant(tx);
      const revoked = await seedProvisioningGrant(tx, { revoked: true });
      const other = await seedProvisioningGrant(tx);
      const repository = authorizationOn(tx);

      for (const context of [
        delegatedProvisioningContext(revoked),
        // Somebody else's grant, presented by this human.
        delegatedProvisioningContext({ ...live, grantId: other.grantId }),
        delegatedProvisioningContext({
          ...live,
          grantId: crypto.randomUUID(),
        }),
      ]) {
        await expect(repository.assertCurrent(context)).rejects.toMatchObject({
          code: "forbidden",
        });
      }
    });
  });

  /**
   * The delegated lookup must not turn an ordinary refusal into a failed
   * query.
   *
   * Grant identifiers are `uuid`; Better Auth session identifiers are
   * `session_<uuid>`. PostgreSQL raises on malformed uuid input rather than
   * matching no row, so a signed-in human whose organization has gone away
   * would have been answered with a database error instead of a refusal —
   * which is how the first version of this fallback behaved.
   */
  test("refuses a non-grant credential without failing the query", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedProvisioningGrant(tx);
      const repository = authorizationOn(tx);

      await expect(
        repository.assertCurrent({
          ...delegatedProvisioningContext(seeded),
          credentialId: `session_${crypto.randomUUID()}`,
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "Current human authorization is no longer active",
      });
    });
  });

  /**
   * Organization-wide authority has no project to fall back to, so the
   * project-maintainer route that a working grant may travel does not exist
   * here. A member who is neither owner nor admin holds nothing to delegate.
   */
  test("denies a grant whose human is not an organization manager", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedProvisioningGrant(tx, { role: "member" });
      const repository = authorizationOn(tx);

      await expect(
        repository.assertCurrent(delegatedProvisioningContext(seeded)),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });
});
