import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { createRequestRepository } from "./request-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
}

/** An organization with one active project and one agent bound to it. */
async function seedBoundAgent(tx: Tx) {
  const userId = `owner_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  const organizationId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const principalId = crypto.randomUUID();

  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (lower(${email}), 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Draft owner', ${email}, now())
  `);
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Draft tenant',
      ${`draft-${organizationId}`}, 'active')
  `);
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, 'owner', 'active')
  `);
  await tx.execute(sql`
    insert into "projects"
      ("id", "organization_id", "name", "slug", "key_prefix", "status")
    values (${projectId}, ${organizationId}, 'Draft project',
      ${`draft-project-${projectId}`}, 'DRF', 'active')
  `);
  await tx.execute(sql`
    insert into "agent_principals"
      ("id", "organization_id", "project_id", "display_name", "slug",
       "status", "created_by_user_id")
    values (${principalId}, ${organizationId}, ${projectId}, 'Draft agent',
      ${`draft-agent-${principalId}`}, 'active', ${userId})
  `);

  // A live credential, because the actor check demands one: an agent is active
  // only while the key it presented is still enabled and unexpired.
  const credentialId = crypto.randomUUID();
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "config_id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, 'requestport-agent', ${userId},
      ${`key_${crypto.randomUUID()}`}, true,
      now() + '90 days'::interval, now(), now())
  `);
  await tx.execute(sql`
    insert into "agent_credentials"
      ("id", "organization_id", "agent_principal_id", "better_auth_api_key_id",
       "name", "prefix", "fingerprint", "audience", "project_id", "scopes",
       "expires_at", "created_by_user_id")
    values (${credentialId}, ${organizationId}, ${principalId}, ${apiKeyId},
      'Draft agent key', 'rp_', ${`fp_${crypto.randomUUID()}`}, 'mcp',
      ${projectId}, ${JSON.stringify(["request:create"])}::jsonb,
      now() + '90 days'::interval, ${userId})
  `);

  return { credentialId, organizationId, principalId, projectId, userId };
}

function agentContext(seeded: {
  credentialId: string;
  organizationId: string;
  principalId: string;
  projectId: string;
}) {
  return {
    actor: { type: "agent" as const, id: seeded.principalId },
    organizationId: seeded.organizationId,
    projectId: seeded.projectId,
    laneIds: new Set<string>(),
    scopes: new Set(["request:create"]),
    credentialId: seeded.credentialId,
    correlationId: crypto.randomUUID(),
  };
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("live draft ownership", () => {
  /**
   * The ordinary case, and the one that was refused.
   *
   * An agent files a request into the project it is bound to, so the draft's
   * source project and its target project are the same project. The ownership
   * check collected both into a list and then compared the number of *distinct*
   * projects it found against the *length of that list* — one against two — so
   * the single most common thing an agent does was answered "source or target
   * is outside the active organization", which it was not.
   *
   * Nothing covered this before: `validateDraftOwnership` had no test at all,
   * and the failure is invisible to any fake repository because the arithmetic
   * that goes wrong is inside the real one.
   */
  test("accepts an agent filing into its own bound project", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedBoundAgent(tx);
      const repository = createRequestRepository(tx);

      await expect(
        repository.validateDraftOwnership({
          context: agentContext(seeded) as never,
          organizationId: seeded.organizationId,
          source: { kind: "project", projectId: seeded.projectId },
          targetProjectId: seeded.projectId,
          laneId: null,
        }),
      ).resolves.toBe(true);
    });
  });

  /**
   * The same check, still refusing what it exists to refuse. Deduplicating the
   * projects must not turn "two projects, one of them missing" into a pass.
   */
  test("refuses a target project outside the organization", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedBoundAgent(tx);
      const repository = createRequestRepository(tx);

      await expect(
        repository.validateDraftOwnership({
          context: agentContext(seeded) as never,
          organizationId: seeded.organizationId,
          source: { kind: "project", projectId: seeded.projectId },
          targetProjectId: crypto.randomUUID(),
          laneId: null,
        }),
      ).resolves.toBe(false);
    });
  });

  /** And an archived project is not a project this may reach. */
  test("refuses an archived source project", { timeout: 30_000 }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedBoundAgent(tx);
      await tx.execute(sql`
        update "projects" set "status" = 'archived' where "id" = ${seeded.projectId}
      `);
      const repository = createRequestRepository(tx);

      await expect(
        repository.validateDraftOwnership({
          context: agentContext(seeded) as never,
          organizationId: seeded.organizationId,
          source: { kind: "project", projectId: seeded.projectId },
          targetProjectId: seeded.projectId,
          laneId: null,
        }),
      ).resolves.toBe(false);
    });
  });
});
