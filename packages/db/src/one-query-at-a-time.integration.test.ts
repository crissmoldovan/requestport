import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import {
  createStorage,
  type Database,
  storageOptionsFromEnv,
} from "./client.js";
import { createAgentManagementRepository } from "./queries/agent-management-repository.js";
import { createAgentQueryRepository } from "./queries/agent-query-repository.js";
import { createOperationsQueryRepository } from "./queries/operations-query-repository.js";
import { createProjectSettingsRepository } from "./queries/project-settings-repository.js";
import { createRequestQueryRepository } from "./queries/request-query-repository.js";
import { createSearchRepository } from "./queries/search-repository.js";
import { createNotificationRepository } from "./repositories/notification-repository.js";
import { createSlackRepository } from "./repositories/slack-repository.js";
import { requests } from "./schema/index.js";
import { tenantWrappingEnabled } from "./tenant-context.js";
import { takeConcurrentQueries } from "./test-support/one-query-at-a-time.js";
import type { Tx } from "./transaction.js";

/*
 * X24 (ruling 202 item 2): every read that ran several queries at once on one
 * transaction, and so on one `pg` client, runs them in turn
 * (`./in-turn.ts`), under the guard this package's Vitest setup installs
 * (`./test-support/one-query-at-a-time.ts`).
 *
 * Each case below seeds what one read needs to reach its reads, in a
 * transaction it rolls back, calls it on that transaction, and asks the guard
 * what it recorded. A read handed a transaction runs in it, or in a savepoint
 * of it: one client either way, as in production, where the read opens its
 * own transaction on the pool. The seeds run as this run's login, which
 * locally is a superuser (`test-support/declare-test-surface.ts`), so no
 * policy refuses them; the file is not in the application-role lane.
 */

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

afterAll(async () => {
  await suiteStorage.close();
});

class Rollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

/** A repository typed for the pool, handed a transaction, as the web's own transactions do. */
function asDatabase(tx: Tx): Database {
  return tx as unknown as Database;
}

interface Tenant {
  organizationId: string;
  userId: string;
  email: string;
  projectId: string;
}

async function seedTenant(tx: Tx): Promise<Tenant> {
  const organizationId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);

  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'One query at a time', ${email}, now())
  `);
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'In turn tenant', ${`in-turn-${organizationId}`}, 'active')
  `);
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, 'owner', 'active')
  `);
  await tx.execute(sql`
    insert into "projects"
      ("id", "organization_id", "name", "slug", "key_prefix", "status")
    values (${projectId}, ${organizationId}, ${`Turnstile ${suffix}`},
      ${`turnstile-${suffix}`}, ${`T${suffix.toUpperCase()}`}, 'active')
  `);
  return { organizationId, userId, email, projectId };
}

async function seedRequest(tx: Tx, tenant: Tenant) {
  const requestId = crypto.randomUUID();

  await tx.insert(requests).values({
    id: requestId,
    organizationId: tenant.organizationId,
    sequenceNumber: 1,
    displayKey: "TRN-1",
    sourceKind: "human_direct",
    sourceProjectId: null,
    targetProjectId: tenant.projectId,
    type: "feature",
    title: "Turnstile request",
    descriptionMd: "Read in turn.",
    state: "submitted",
    reporterType: "user",
    reporterId: tenant.userId,
    visibility: "organization",
    sensitivity: "normal",
    version: 1,
    submittedAt: new Date("2026-10-13T08:00:00.000Z"),
  });
  return requestId;
}

/** A question on the request, and one email intent for it. */
async function seedQuestionWithIntent(
  tx: Tx,
  tenant: Tenant,
  requestId: string,
) {
  const questionId = crypto.randomUUID();
  const intentId = crypto.randomUUID();

  await tx.execute(sql`
    insert into "questions"
      ("id", "organization_id", "subject_type", "subject_id",
       "parent_request_id", "audience_type", "body_md", "asked_by_type",
       "asked_by_id")
    values (${questionId}, ${tenant.organizationId}, 'request', ${requestId},
      ${requestId}, 'requester', 'Which way?', 'user', ${tenant.userId})
  `);
  await tx.execute(sql`
    insert into "notification_intents"
      ("id", "organization_id", "question_id", "channel",
       "recipient_user_id", "recipient_ref", "template", "dedupe_key",
       "view_model")
    values (${intentId}, ${tenant.organizationId}, ${questionId}, 'email',
      ${tenant.userId}, ${tenant.email}, 'question.asked',
      ${`in-turn-${intentId}`}, '{}'::jsonb)
  `);
  return { questionId, intentId };
}

/** An agent in the project, with a live API credential its owner issued. */
async function seedAgentWithCredential(tx: Tx, tenant: Tenant) {
  const agentId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const apiKeyId = `apikey_${crypto.randomUUID()}`;

  await tx.execute(sql`
    insert into "agent_principals"
      ("id", "organization_id", "project_id", "display_name", "slug",
       "software_name", "status", "version", "created_by_user_id")
    values (${agentId}, ${tenant.organizationId}, ${tenant.projectId},
      'Turnstile agent', ${`turnstile-${agentId}`}, 'Agent software', 'active',
      1, ${tenant.userId})
  `);
  await tx.execute(sql`
    insert into "apikey"
      ("id", "reference_id", "key", "enabled", "expires_at", "created_at",
       "updated_at")
    values (${apiKeyId}, ${tenant.userId}, ${`plaintext_${apiKeyId}`}, true,
      now() + interval '1 hour', now(), now())
  `);
  await tx.execute(sql`
    insert into "agent_credentials"
      ("id", "organization_id", "agent_principal_id",
       "better_auth_api_key_id", "name", "prefix", "fingerprint", "audience",
       "project_id", "lane_ids", "scopes", "version", "expires_at",
       "created_by_user_id")
    values (${credentialId}, ${tenant.organizationId}, ${agentId}, ${apiKeyId},
      'Turnstile credential', ${`rp_prefix_${credentialId.slice(0, 6)}`},
      ${`fingerprint_${credentialId}`}, 'api', ${tenant.projectId},
      '[]'::jsonb, '["request:read"]'::jsonb, 1, now() + interval '30 days',
      ${tenant.userId})
  `);
  return {
    agentId,
    context: {
      actor: { type: "agent" as const, id: agentId },
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      laneIds: new Set<string>(),
      scopes: new Set(["request:read"]),
      authorizationId: credentialId,
    },
  };
}

describe("the one-query-at-a-time guard (test-support/one-query-at-a-time.ts)", () => {
  test("records a query issued on the storage's own pg client while another is in flight", async () => {
    await inRollbackTransaction(async (tx) => {
      await Promise.all([
        tx.execute(sql`select pg_catalog.pg_sleep(0.05) as first`),
        tx.execute(sql`select 2 as second`),
      ]);
    });

    expect(takeConcurrentQueries()).toEqual([
      {
        test: expect.stringContaining("records a query issued"),
        issued: "select 2 as second",
        inFlight: ["select pg_catalog.pg_sleep(0.05) as first"],
      },
    ]);
  });

  test("records nothing for queries in turn on one client, or at once on separate clients", async () => {
    await inRollbackTransaction(async (tx) => {
      await tx.execute(sql`select pg_catalog.pg_sleep(0.05) as first`);
      await tx.execute(sql`select 2 as second`);
    });
    await Promise.all([
      suiteStorage.db.execute(sql`select pg_catalog.pg_sleep(0.05) as first`),
      suiteStorage.db.execute(sql`select 2 as second`),
    ]);

    expect(takeConcurrentQueries()).toEqual([]);
  });
});

describe("each read that ran several queries at once on one transaction runs them in turn (X24)", () => {
  test("agent management: an agent's detail", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { agentId } = await seedAgentWithCredential(tx, tenant);

      const detail = await createAgentManagementRepository(
        asDatabase(tx),
      ).getAgent(tenant.userId, tenant.organizationId, agentId);

      expect(detail?.agent.id).toBe(agentId);
      expect(detail?.credentials).toHaveLength(1);
    });

    expect(takeConcurrentQueries()).toEqual([]);
  });

  test("agent queries: a project", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { context } = await seedAgentWithCredential(tx, tenant);

      const project = await createAgentQueryRepository(tx).getProject(
        context,
        tenant.projectId,
      );

      expect(project).toMatchObject({
        id: tenant.projectId,
        repositories: [],
        aliases: [],
      });
    });

    expect(takeConcurrentQueries()).toEqual([]);
  });

  test("agent queries: a request", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { context } = await seedAgentWithCredential(tx, tenant);
      const requestId = await seedRequest(tx, tenant);

      const request = await createAgentQueryRepository(tx).getRequest(
        context,
        requestId,
      );

      expect(request).toMatchObject({ id: requestId });
    });

    expect(takeConcurrentQueries()).toEqual([]);
  });

  test("operations: the details", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);

      const details = await createOperationsQueryRepository(
        asDatabase(tx),
      ).details(tenant.userId, tenant.organizationId);

      expect(Object.keys(details)).toEqual([
        "outbox",
        "notifications",
        "sessions",
        "importConflicts",
        "importDispatches",
        "slackOperations",
      ]);
    });

    expect(takeConcurrentQueries()).toEqual([]);
  });

  test("project settings: a project", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);

      const detail = await createProjectSettingsRepository(
        asDatabase(tx),
      ).getProject(tenant.userId, tenant.organizationId, tenant.projectId);

      expect(detail?.project.id).toBe(tenant.projectId);
      expect(detail?.availableMembers).toHaveLength(1);
    });

    expect(takeConcurrentQueries()).toEqual([]);
  });

  test("request queries: a request with a question and its delivery", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const requestId = await seedRequest(tx, tenant);
      const { intentId } = await seedQuestionWithIntent(tx, tenant, requestId);

      const detail = await createRequestQueryRepository(tx).getRequest({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        requestId,
      });

      expect(detail).toMatchObject({ id: requestId });
      // The intent was read, so its deliveries were too.
      expect(JSON.stringify(detail)).toContain(intentId);
    });

    expect(takeConcurrentQueries()).toEqual([]);
  });

  test("search: projects and requests", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      await seedRequest(tx, tenant);

      const found = await createSearchRepository(asDatabase(tx)).search(
        tenant.userId,
        tenant.organizationId,
        "Turnstile",
      );

      expect(found.projects.map((project) => project.id)).toEqual([
        tenant.projectId,
      ]);
      expect(found.requests).toHaveLength(1);
    });

    expect(takeConcurrentQueries()).toEqual([]);
  });

  test("notifications: a question's deliveries", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const requestId = await seedRequest(tx, tenant);
      const { questionId, intentId } = await seedQuestionWithIntent(
        tx,
        tenant,
        requestId,
      );

      const deliveries = await createNotificationRepository(
        asDatabase(tx),
      ).listQuestionDeliveries(
        tenant.organizationId,
        questionId,
        tenant.userId,
      );

      expect(deliveries.map((intent) => intent.id)).toEqual([intentId]);
    });

    expect(takeConcurrentQueries()).toEqual([]);
  });

  test("Slack: the organisation's installations, mappings and routes", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);

      const listed = await createSlackRepository(tx).list(
        tenant.organizationId,
        tenant.userId,
      );

      expect(listed).toEqual({
        installations: [],
        mappings: [],
        routes: [],
        operations: [],
      });
    });

    expect(takeConcurrentQueries()).toEqual([]);
  });
});

/*
 * The guard sees a site only when a suite runs it. This sees one in any file:
 * `Promise.all` and its kin in packages/db/src, test files left out. The two
 * left are tenant-context.ts's, over the worker's three storages, each with
 * a pool of its own, not one client. A new one either runs its reads in turn
 * or is named here with its reason.
 */
describe("packages/db's code hands Promise.all nothing that shares a client", () => {
  test("only tenant-context.ts's two, over the worker's three storages, remain", () => {
    const root = import.meta.dirname;
    const found: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          /\.ts$/u.test(entry.name) &&
          !/\.test\.ts$/u.test(entry.name)
        ) {
          const lines = readFileSync(path, "utf8").split("\n");
          for (const [index, line] of lines.entries()) {
            if (/\bPromise\s*\.\s*(?:all|allSettled|any|race)\s*\(/u.test(line))
              found.push(`${relative(root, path)}:${index + 1}`);
          }
        }
      }
    };

    walk(root);
    const elsewhere = found.filter(
      (site) => !site.startsWith("tenant-context.ts:"),
    );

    expect(elsewhere).toEqual([]);
    expect(found.length - elsewhere.length).toBe(2);
  });
});
