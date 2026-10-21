import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  canonicalJson,
  type RetentionCategory,
  retentionCategories,
  retentionCutoff,
} from "@requestport/domain";
import { sql } from "drizzle-orm";
import type * as Pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createStorage,
  type Database,
  selectDriver,
  storageOptionsFromEnv,
} from "./client.js";
import { readDatabaseUrl } from "./database-url.js";
import {
  lockActiveApiKeyAuthorization,
  lockActiveOAuthAuthorization,
} from "./repositories/agent-authorization.js";
import {
  createImportRepository,
  createImportTaskDispatchRepository,
} from "./repositories/import-repository.js";
import {
  createNotificationRepository,
  type DueQuestionReminder,
} from "./repositories/notification-repository.js";
import { createOperationalMetricsRepository } from "./repositories/operational-metrics-repository.js";
import {
  type ClaimSettlement,
  createOutboxRepository,
} from "./repositories/outbox-repository.js";
import { createRetentionRepository } from "./repositories/retention-repository.js";
import { createSlackRepository } from "./repositories/slack-repository.js";
import { createWebhookRepository } from "./repositories/webhook-repository.js";
import { createWorkSweepRepository } from "./repositories/work-repository.js";
import {
  DatabaseRoleGuardError,
  declaredDatabaseSurface,
  ownerCapableVariableNames,
  resetDatabaseSurfaceDeclaration,
  UNDECLARED_SURFACE_MESSAGE,
} from "./role-guard.js";
import {
  createWorkerStorages,
  inTenantTransaction,
  isTransaction,
  TenantBindingError,
  tenantWrappingEnabled,
  WORKER_DATABASE_URL_VARIABLES,
  type WorkerStorages,
} from "./tenant-context.js";
import {
  CREDENTIAL_LOCK_FUNCTIONS,
  PROCESSOR_GRANTS,
  WORKER_FUNCTIONS,
  workerFunctionAcl,
} from "./test-support/worker-grants.js";
import { createTestStorage, openSession, type TestSession } from "./testing.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
 * The worker on tenant-bound roles, at the SQL level (plan 13, Track I.2b,
 * step b1; manifest-i2.md §5.1, §5.3 Done when 1-3, 5, 6, 8-10).
 *
 * Migration 0020 creates three group roles and seventeen functions; nothing
 * calls them until b2. These cases call them directly, as logins that are
 * members of one group each. The logins are made by this run, with names
 * unique to it, and dropped when it ends (roles are cluster-wide, and every
 * track's database shares this server).
 *
 * Two kinds of case. Done when 1 and 2 connect as the logins themselves, so
 * what they read was committed by the owner connection first and is deleted
 * again at the end. Every other case runs in one transaction on the owner's
 * connection that is rolled back, acting as a login through SET LOCAL ROLE,
 * which evaluates privileges and policies as that role exactly as a
 * connection would; seeded rows go with the rollback. None of them changes a
 * table's definition.
 */

const DISPATCHER = "requestport_dispatcher";
const PROCESSOR = "requestport_tenant_processor";
const MAINTENANCE = "requestport_maintenance";
const APPLICATION = "requestport_application";
const DEFINER = "requestport_definer";
const GROUPS = [DISPATCHER, PROCESSOR, MAINTENANCE] as const;
type WorkerGroup = (typeof GROUPS)[number];

/** §5.1: each function, its one role, its exact result, and a harmless call. */
const FUNCTIONS: readonly {
  name: string;
  args: string;
  role: WorkerGroup;
  result: string;
  call: string;
}[] = [
  {
    name: "claim_outbox_batch",
    args: "p_limit integer, p_lease_seconds integer",
    role: DISPATCHER,
    result:
      "TABLE(outbox_id uuid, event_id uuid, organization_id uuid, attempt_count integer, lease_id uuid, lease_expires_at timestamp with time zone)",
    call: "select * from requestport_private.claim_outbox_batch(1, 60)",
  },
  {
    name: "accept_outbox_claim",
    args: "p_outbox_id uuid, p_lease_id uuid, p_run_id text",
    role: DISPATCHER,
    result: "boolean",
    call: "select requestport_private.accept_outbox_claim(gen_random_uuid(), gen_random_uuid(), 'run')",
  },
  {
    name: "release_outbox_claim",
    args: "p_outbox_id uuid, p_lease_id uuid, p_dead_letter boolean, p_delay_ms integer",
    role: DISPATCHER,
    result: "boolean",
    call: "select requestport_private.release_outbox_claim(gen_random_uuid(), gen_random_uuid(), false, 1000)",
  },
  {
    name: "claim_import_dispatch_batch",
    args: "p_limit integer, p_lease_seconds integer",
    role: DISPATCHER,
    result:
      "TABLE(dispatch_id uuid, organization_id uuid, task_kind text, attempt_count integer, lease_id uuid, lease_expires_at timestamp with time zone)",
    call: "select * from requestport_private.claim_import_dispatch_batch(1, 60)",
  },
  {
    name: "accept_import_dispatch_claim",
    args: "p_dispatch_id uuid, p_lease_id uuid, p_run_id text",
    role: DISPATCHER,
    result: "boolean",
    call: "select requestport_private.accept_import_dispatch_claim(gen_random_uuid(), gen_random_uuid(), 'run')",
  },
  {
    name: "due_notification_intents",
    args: "p_limit integer",
    role: DISPATCHER,
    result: "TABLE(intent_id uuid, organization_id uuid, channel text)",
    call: "select * from requestport_private.due_notification_intents(1)",
  },
  {
    name: "pending_webhook_deliveries",
    args: "p_limit integer",
    role: DISPATCHER,
    result: "TABLE(delivery_id uuid, organization_id uuid)",
    call: "select * from requestport_private.pending_webhook_deliveries(1)",
  },
  {
    name: "due_slack_message_updates",
    args: "p_limit integer",
    role: DISPATCHER,
    result: "TABLE(operation_id uuid, organization_id uuid)",
    call: "select * from requestport_private.due_slack_message_updates(1)",
  },
  {
    name: "due_slack_connection_tests",
    args: "p_limit integer",
    role: DISPATCHER,
    result: "TABLE(operation_id uuid, organization_id uuid)",
    call: "select * from requestport_private.due_slack_connection_tests(1)",
  },
  {
    name: "lease_expired_work_sessions",
    args: "p_limit integer",
    role: DISPATCHER,
    result: "TABLE(session_id uuid, organization_id uuid, version integer)",
    call: "select * from requestport_private.lease_expired_work_sessions(1)",
  },
  {
    name: "grace_expired_work_sessions",
    args: "p_limit integer",
    role: DISPATCHER,
    result: "TABLE(session_id uuid, organization_id uuid, version integer)",
    call: "select * from requestport_private.grace_expired_work_sessions(1)",
  },
  {
    name: "due_webhook_secret_promotions",
    args: "p_limit integer",
    role: DISPATCHER,
    result: "TABLE(subscription_id uuid, organization_id uuid)",
    call: "select * from requestport_private.due_webhook_secret_promotions(1)",
  },
  {
    name: "due_question_reminders",
    args: "p_limit integer",
    role: DISPATCHER,
    result:
      "TABLE(question_id uuid, organization_id uuid, as_of timestamp with time zone)",
    call: "select * from requestport_private.due_question_reminders(1)",
  },
  {
    name: "resolve_job_organization",
    args: "p_kind text, p_id uuid",
    role: PROCESSOR,
    result: "uuid",
    call: "select requestport_private.resolve_job_organization('outbox', gen_random_uuid())",
  },
  {
    name: "operational_metrics_snapshot",
    args: "",
    role: MAINTENANCE,
    result:
      "TABLE(pending_outbox bigint, oldest_outbox_seconds numeric, dead_letter_webhooks bigint, notification_backlog bigint, stale_sessions bigint, open_import_conflicts bigint, slack_operation_backlog bigint, dead_letter_import_dispatches bigint)",
    call: "select * from requestport_private.operational_metrics_snapshot()",
  },
  {
    name: "outbox_pending_backlog",
    args: "",
    role: MAINTENANCE,
    result: "TABLE(pending_count integer, oldest_age_seconds integer)",
    call: "select * from requestport_private.outbox_pending_backlog()",
  },
  {
    name: "retention_cleanup",
    args: "p_category text, p_batch_size integer",
    role: MAINTENANCE,
    result: "TABLE(category text, deleted integer, tombstone_id uuid)",
    call: "select * from requestport_private.retention_cleanup('rate_limit_bucket', 1)",
  },
];

/**
 * 0021 (the driver's ruling of 2026-09-30; manifest-i2.md §5.1, rows 18 and
 * 19): the live-credential locks the agent authorization helpers call in
 * place of joining apikey or oauth_client. Each is executable by the
 * processor and by the application, whose command path shares the helpers.
 */
const LOCKS: readonly {
  name: string;
  args: string;
  result: string;
  call: string;
}[] = [
  {
    name: "lock_live_api_key",
    args: "p_api_key_id text",
    result: "boolean",
    call: "select requestport_private.lock_live_api_key('wrs-absent')",
  },
  {
    name: "lock_live_oauth_client",
    args: "p_client_id text",
    result: "boolean",
    call: "select requestport_private.lock_live_oauth_client('wrs-absent')",
  },
];
const LOCK_ROLES: readonly string[] = [PROCESSOR, APPLICATION];

const S = "SELECT";
const U = "UPDATE";
const UID = "UPDATE (id)";

/**
 * Global tables in the matrix: no tenant policy. command_receipts left this
 * set with step 8's policy (0024), and is judged as a tenant table below.
 */
const GLOBAL_IN_MATRIX = new Set(["user"]);

/** §5.1 Grants: refused to the processor outright. */
const REFUSED_BETTER_AUTH = [
  "account",
  "apikey",
  "jwks",
  "oauth_client",
  "oauth_consent",
  "session",
  "verification",
  "oauth_access_token",
  "oauth_refresh_token",
];

/** How a tenant table's row belongs to an organisation ($1). */
const INDIRECT: Record<string, { column: string; parent: string }> = {
  outbox: { column: "event_id", parent: "domain_events" },
  request_acceptance_criteria: { column: "request_id", parent: "requests" },
  request_labels: { column: "request_id", parent: "requests" },
  slack_delivery_operations: {
    column: "installation_id",
    parent: "slack_installations",
  },
  webhook_attempts: { column: "delivery_id", parent: "webhook_deliveries" },
};

/** A column every row has, for an UPDATE that changes nothing. */
function unchangedColumn(table: string) {
  return (
    {
      message_mentions: "message_id",
      project_sequences: "organization_id",
      request_labels: "request_id",
    }[table] ?? "id"
  );
}

function belongsTo(table: string) {
  if (table === "organizations") return "t.id = $1";
  const indirect = INDIRECT[table];
  if (indirect) {
    return `exists (select 1 from public.${indirect.parent} p where p.id = t.${indirect.column} and p.organization_id = $1)`;
  }
  return "t.organization_id = $1";
}

type Querier = Pick<TestSession, "query">;

/**
 * Runs one statement that must fail, inside a savepoint so the transaction
 * survives it, and returns the error for the case to judge.
 */
async function failure(
  q: Querier,
  text: string,
  values: unknown[] = [],
): Promise<{ code?: string; message?: string }> {
  await q.query("SAVEPOINT expected_failure");
  try {
    await q.query(text, values);
  } catch (error) {
    await q.query("ROLLBACK TO SAVEPOINT expected_failure");
    return error as { code?: string; message?: string };
  }
  await q.query("RELEASE SAVEPOINT expected_failure");
  throw new Error(`expected this statement to fail: ${text}`);
}

/** Runs `work` inside a savepoint that is then rolled back, and returns its value. */
async function undone<T>(q: Querier, work: () => Promise<T>): Promise<T> {
  await q.query("SAVEPOINT undone");
  try {
    return await work();
  } finally {
    await q.query("ROLLBACK TO SAVEPOINT undone");
  }
}

async function inRolledBackTransaction<T>(
  work: (session: TestSession) => Promise<T>,
  isolation = "",
): Promise<T> {
  const session = await openSession(suiteStorage);
  try {
    await session.query(
      `BEGIN${isolation ? ` ISOLATION LEVEL ${isolation}` : ""}`,
    );
    // Bound any lock a case waits for behind another suite's transaction.
    await session.query("SET LOCAL lock_timeout = '5s'");
    return await work(session);
  } finally {
    await session.query("ROLLBACK").catch(() => undefined);
    session.release();
  }
}

/**
 * Seeds as the superuser with triggers and foreign-key checks off, and puts
 * back whatever was set before, so seeds nest.
 */
async function seeding<T>(q: Querier, work: () => Promise<T>): Promise<T> {
  const { rows } = await q.query<{ role: string }>(
    "select current_setting('session_replication_role') as role",
  );
  const before = (rows[0] as { role: string }).role;
  await q.query("SET LOCAL session_replication_role = replica");
  try {
    return await work();
  } finally {
    // After a failed statement this fails too; the failure is the seed's.
    await q
      .query(`SET LOCAL session_replication_role = ${before}`)
      .catch(() => undefined);
  }
}

async function bind(q: Querier, organizationId: string | null) {
  await q.query(
    "select pg_catalog.set_config('requestport.organization_id', $1, true)",
    [organizationId ?? ""],
  );
}

type Logins = Record<WorkerGroup, { name: string; url: string }>;
let logins: Logins;

/** Acts as `login` for `work`, then takes the owner back. */
async function as<T>(
  session: TestSession,
  group: WorkerGroup | typeof APPLICATION,
  work: () => Promise<T>,
): Promise<T> {
  const role = group === APPLICATION ? APPLICATION : logins[group].name;
  await session.query(`SET LOCAL ROLE "${role}"`);
  try {
    return await work();
  } finally {
    // After a statement failed outside a savepoint this fails too, and the
    // rollback that follows takes the role back.
    await session.query("RESET ROLE").catch(() => undefined);
  }
}

async function connectAs(group: WorkerGroup): Promise<Pg.Client> {
  const { Client } = createRequire(import.meta.url)("pg") as typeof Pg;
  const client = new Client({
    connectionString: logins[group].url,
    ssl: false,
  });
  await client.connect();
  return client;
}

beforeAll(async () => {
  const session = await openSession(suiteStorage);
  try {
    const { rows } = await session.query<{ prefix: string }>(
      "select left(current_database(), 24) || '_wrs_' || substr(md5(random()::text), 1, 8) as prefix",
    );
    const prefix = (rows[0] as { prefix: string }).prefix;
    await session.query("SET scram_iterations = 1");
    // Filled as each is made, so the end of the run drops whatever exists.
    const made: Partial<Logins> = {};
    logins = made as Logins;
    for (const [group, suffix] of [
      [DISPATCHER, "d"],
      [PROCESSOR, "p"],
      [MAINTENANCE, "m"],
    ] as const) {
      const name = `${prefix}_${suffix}`;
      const password = randomUUID().replaceAll("-", "");
      await session.query(
        `create role "${name}" login password '${password}' ` +
          `nosuperuser nobypassrls nocreatedb nocreaterole noreplication in role ${group}`,
      );
      const url = new URL(readDatabaseUrl(process.env));
      url.username = name;
      url.password = password;
      made[group] = { name, url: url.toString() };
    }
  } finally {
    await session.query("RESET scram_iterations").catch(() => undefined);
    session.release();
  }
});

afterAll(async () => {
  try {
    if (logins) {
      const session = await openSession(suiteStorage);
      try {
        for (const { name } of Object.values(logins)) {
          await session.query(`drop role if exists "${name}"`);
        }
      } finally {
        session.release();
      }
    }
  } finally {
    await suiteStorage.close();
  }
});

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

type Graph = Awaited<ReturnType<typeof seedGraph>>;

/**
 * One organisation with a row in every tenant table of the processor's
 * matrix, its work in flight: an outbox row and an import dispatch leased, a
 * notification intent, a webhook delivery and a Slack operation pending.
 * Seeded as the superuser with triggers and foreign-key checks off, every id
 * consistent.
 */
async function seedGraph(q: Querier) {
  const tag = randomUUID().slice(0, 8);
  const g = {
    organizationId: randomUUID(),
    userId: `wrs-user-${tag}`,
    projectId: randomUUID(),
    requestId: randomUUID(),
    otherRequestId: randomUUID(),
    eventId: randomUUID(),
    outboxId: randomUUID(),
    principalId: randomUUID(),
    questionId: randomUUID(),
    intentId: randomUUID(),
    installationId: randomUUID(),
    operationId: randomUUID(),
    messageId: randomUUID(),
    importSourceId: randomUUID(),
    snapshotId: randomUUID(),
    artifactId: randomUUID(),
    importRunId: randomUUID(),
    dispatchId: randomUUID(),
    entryId: randomUUID(),
    subscriptionId: randomUUID(),
    deliveryId: randomUUID(),
    workSessionId: randomUUID(),
    tag,
  };
  const sha = "a".repeat(64);
  const statements: [string, unknown[]][] = [
    [
      `insert into public.organizations (id, name, slug, status) values ($1, $2, $2, 'active')`,
      [g.organizationId, `wrs-${tag}`],
    ],
    [
      `insert into public."user" (id, name, email) values ($1, 'Worker Seed', $2)`,
      [g.userId, `${g.userId}@example.test`],
    ],
    [
      `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'owner', 'active')`,
      [g.organizationId, g.userId],
    ],
    [
      `insert into public.projects (id, organization_id, name, slug, key_prefix, status) values ($1, $2, 'Worker', $3, $4, 'active')`,
      [
        g.projectId,
        g.organizationId,
        `wrs-${tag}`,
        `W${tag.slice(0, 4).toUpperCase()}`,
      ],
    ],
    [
      `insert into public.project_members (organization_id, project_id, user_id, role, status) values ($1, $2, $3, 'maintainer', 'active')`,
      [g.organizationId, g.projectId, g.userId],
    ],
    [
      `insert into public.project_sequences (organization_id, project_id) values ($1, $2)`,
      [g.organizationId, g.projectId],
    ],
    [
      `insert into public.requests (id, organization_id, source_kind, target_project_id, type, title, description_md, reporter_type, reporter_id)
       values ($1, $3, 'human_direct', $4, 'bug', 'Worker', '', 'user', $5),
              ($2, $3, 'human_direct', $4, 'bug', 'Worker 2', '', 'user', $5)`,
      [g.requestId, g.otherRequestId, g.organizationId, g.projectId, g.userId],
    ],
    [
      `insert into public.request_labels (request_id, label) values ($1, 'seeded')`,
      [g.requestId],
    ],
    [
      `insert into public.request_acceptance_criteria (request_id, position, text) values ($1, 0, 'seeded')`,
      [g.requestId],
    ],
    [
      `insert into public.request_relationships (organization_id, from_request_id, to_request_id, type, created_by_type, created_by_id)
       values ($1, $2, $3, 'related_to', 'user', $4)`,
      [g.organizationId, g.requestId, g.otherRequestId, g.userId],
    ],
    [
      `insert into public.domain_events (id, organization_id, aggregate_type, aggregate_id, aggregate_version, type, schema_version, actor, correlation_id, causation_id, data)
       values ($1, $2, 'request', $3, 1, 'request.created.v1', 1, '{}', 'wrs', 'wrs', '{}')`,
      [g.eventId, g.organizationId, g.requestId],
    ],
    [
      `insert into public.outbox (id, event_id, state, lease_owner, lease_expires_at, attempt_count)
       values ($1, $2, 'leased', gen_random_uuid()::text, now() + interval '1 hour', 1)`,
      [g.outboxId, g.eventId],
    ],
    [
      `insert into public.agent_principals (id, organization_id, display_name, slug, created_by_user_id) values ($1, $2, 'Agent', $3, $4)`,
      [g.principalId, g.organizationId, `wrs-agent-${tag}`, g.userId],
    ],
    [
      `insert into public.agent_credentials (id, organization_id, agent_principal_id, better_auth_api_key_id, name, prefix, fingerprint, audience, project_id, expires_at, created_by_user_id)
       values (gen_random_uuid(), $1, $2, $3, 'key', 'rp_', $4, 'api', $5, now() + interval '1 day', $6)`,
      [
        g.organizationId,
        g.principalId,
        `wrs-key-${tag}`,
        `wrs-fp-${tag}`,
        g.projectId,
        g.userId,
      ],
    ],
    [
      `insert into public.agent_oauth_grants (id, organization_id, agent_principal_id, user_id, oauth_client_id, provider_grant_id, refresh_family_id, audience, expires_at, project_id)
       values (gen_random_uuid(), $1, $2, $3, $4, $4, $4, 'mcp', now() + interval '1 day', $5)`,
      [
        g.organizationId,
        g.principalId,
        g.userId,
        `wrs-client-${tag}`,
        g.projectId,
      ],
    ],
    [
      `insert into public.invitations (organization_id, normalized_email, role, token_hash, expires_at, created_by_user_id)
       values ($1, $2, 'member', $3, now() + interval '1 day', $4)`,
      [
        g.organizationId,
        `wrs-invitee-${tag}@example.test`,
        `wrs-token-${tag}`,
        g.userId,
      ],
    ],
    [
      `insert into public.questions (id, organization_id, subject_type, subject_id, parent_request_id, audience_type, body_md, asked_by_type, asked_by_id)
       values ($1, $2, 'request', $3, $3, 'requester', 'Question?', 'user', $4)`,
      [g.questionId, g.organizationId, g.requestId, g.userId],
    ],
    [
      `insert into public.notification_intents (id, organization_id, channel, recipient_ref, template, dedupe_key, view_model, status)
       values ($1, $2, 'email', 'seed@example.test', 'seed', $3, '{}', 'pending')`,
      [g.intentId, g.organizationId, `wrs-dedupe-${tag}`],
    ],
    [
      `insert into public.email_deliveries (notification_intent_id, idempotency_key, organization_id) values ($1, $2, $3)`,
      [g.intentId, `wrs-email-${tag}`, g.organizationId],
    ],
    [
      `insert into public.slack_installations (id, organization_id, workspace_id, workspace_name, bot_token_ciphertext, bot_user_id, installed_by_user_id, status)
       values ($1, $2, $3, 'Workspace', '{}', 'B1', $4, 'active')`,
      [g.installationId, g.organizationId, `T${tag}`, g.userId],
    ],
    [
      `insert into public.slack_routes (organization_id, mode) values ($1, 'dm')`,
      [g.organizationId],
    ],
    [
      `insert into public.slack_user_mappings (organization_id, installation_id, slack_user_id, user_id, verified_at) values ($1, $2, $3, $4, now())`,
      [g.organizationId, g.installationId, `U${tag}`, g.userId],
    ],
    [
      `insert into public.slack_deliveries (notification_intent_id, installation_id, channel_id, organization_id) values ($1, $2, 'C1', $3)`,
      [g.intentId, g.installationId, g.organizationId],
    ],
    [
      `insert into public.slack_action_tokens (organization_id, question_id, installation_id, token_type, token_hash, expires_at)
       values ($1, $2, $3, 'answer', $4, now() + interval '1 day')`,
      [g.organizationId, g.questionId, g.installationId, `wrs-action-${tag}`],
    ],
    [
      `insert into public.slack_delivery_operations (id, installation_id, operation_key) values ($1, $2, $3)`,
      [g.operationId, g.installationId, `wrs-op-${tag}`],
    ],
    [
      `insert into public.messages (id, organization_id, request_id, actor_type, actor_id, body_md) values ($1, $2, $3, 'user', $4, 'Hello')`,
      [g.messageId, g.organizationId, g.requestId, g.userId],
    ],
    [
      `insert into public.message_mentions (message_id, organization_id, user_id) values ($1, $2, $3)`,
      [g.messageId, g.organizationId, g.userId],
    ],
    [
      `insert into public.routing_rules (organization_id, source_kind, target_project_id, decision, specificity, created_by) values ($1, 'human_direct', $2, 'allow', 0, $3)`,
      [g.organizationId, g.projectId, g.userId],
    ],
    [
      `insert into public.security_audit_records (organization_id, actor_type, actor_id, action, target_type, target_id, reason, correlation_id)
       values ($1, 'user', $2, 'seed', 'request', $3, 'seed', 'wrs')`,
      [g.organizationId, g.userId, g.requestId],
    ],
    [
      `insert into public.state_transitions (id, organization_id, request_id, from_state, to_state, action, actor_type, actor_id, request_version, event_id)
       values (gen_random_uuid(), $1, $2, 'draft', 'submitted', 'submit_request', 'user', $3, 1, $4)`,
      [g.organizationId, g.requestId, g.userId, g.eventId],
    ],
    [
      `insert into public.import_sources (id, organization_id, project_id, created_by) values ($1, $2, $3, $4)`,
      [g.importSourceId, g.organizationId, g.projectId, g.userId],
    ],
    [
      `insert into public.source_snapshots (id, organization_id, import_source_id, manifest_sha256) values ($1, $2, $3, $4)`,
      [g.snapshotId, g.organizationId, g.importSourceId, sha],
    ],
    [
      `insert into public.source_artifacts (id, organization_id, import_source_id, source_snapshot_id, relative_path, media_type, byte_size, sha256, exact_bytes)
       values ($1, $2, $3, $4, 'a.md', 'text/markdown', 0, $5, '\\x')`,
      [g.artifactId, g.organizationId, g.importSourceId, g.snapshotId, sha],
    ],
    [
      `insert into public.import_runs (id, organization_id, import_source_id, source_snapshot_id, requested_by_type, requested_by_id, parser_version)
       values ($1, $2, $3, $4, 'user', $5, 'v1')`,
      [
        g.importRunId,
        g.organizationId,
        g.importSourceId,
        g.snapshotId,
        g.userId,
      ],
    ],
    [
      `insert into public.import_task_dispatches (id, organization_id, import_run_id, task_kind, task_payload, state, lease_owner, lease_expires_at, attempt_count)
       values ($1, $2, $3, 'analyze', '{}', 'leased', gen_random_uuid()::text, now() + interval '1 hour', 1)`,
      [g.dispatchId, g.organizationId, g.importRunId],
    ],
    [
      `insert into public.import_manifest_entries (id, import_run_id, source_artifact_id, record_index, proposed_kind, parsed_json, organization_id)
       values ($1, $2, $3, 0, 'request', '{}', $4)`,
      [g.entryId, g.importRunId, g.artifactId, g.organizationId],
    ],
    [
      `insert into public.import_conflicts (import_run_id, entry_id, kind, severity, details, organization_id) values ($1, $2, 'duplicate', 'warning', '{}', $3)`,
      [g.importRunId, g.entryId, g.organizationId],
    ],
    [
      `insert into public.import_entry_applications (organization_id, import_run_id, entry_id, outcome) values ($1, $2, $3, 'skipped')`,
      [g.organizationId, g.importRunId, g.entryId],
    ],
    [
      `insert into public.import_apply_reports (organization_id, import_run_id, counts, manifest_sha256) values ($1, $2, '{}', $3)`,
      [g.organizationId, g.importRunId, sha],
    ],
    [
      `insert into public.legacy_mappings (organization_id, source_artifact_id, record_index, canonical_type, canonical_id, import_run_id)
       values ($1, $2, 0, 'request', $3, $4)`,
      [g.organizationId, g.artifactId, g.requestId, g.importRunId],
    ],
    [
      `insert into public.legacy_aliases (organization_id, source_project_id, namespace, normalized_key, source_artifact_id, record_index, canonical_request_id)
       values ($1, $2, 'legacy', $3, $4, 0, $5)`,
      [g.organizationId, g.projectId, `wrs-${tag}`, g.artifactId, g.requestId],
    ],
    [
      `insert into public.webhook_subscriptions (id, organization_id, name, endpoint_url, current_secret_ciphertext, current_secret_key_id, created_by, status, verified_at)
       values ($1, $2, 'hook', 'https://example.test/hook', '{}', 'k1', $3, 'active', now())`,
      [g.subscriptionId, g.organizationId, g.userId],
    ],
    [
      `insert into public.webhook_deliveries (id, organization_id, subscription_id, event_id, status) values ($1, $2, $3, $4, 'pending')`,
      [g.deliveryId, g.organizationId, g.subscriptionId, g.eventId],
    ],
    [
      `insert into public.webhook_attempts (delivery_id, attempt_number, request_timestamp, signing_key_id) values ($1, 1, now(), 'k1')`,
      [g.deliveryId],
    ],
    [
      `insert into public.command_receipts (actor_fingerprint, command_name, idempotency_fingerprint, normalized_input_hash, result_json, expires_at, organization_id)
       values ($1, 'wrs', $1, 'h', '{}', now() + interval '1 hour', $2)`,
      [`wrs-receipt-${tag}`, g.organizationId],
    ],
    [
      `insert into public.work_sessions (id, organization_id, request_id, agent_principal_id, installation_id, workspace_id, authorization_chain, credential_fingerprint, state, heartbeat_interval_seconds, lease_expires_at, grace_expires_at)
       values ($1, $2, $3, $4, gen_random_uuid(), gen_random_uuid(), '{}', $5, 'claimed', 30, now() + interval '1 hour', now() + interval '2 hours')`,
      [
        g.workSessionId,
        g.organizationId,
        g.requestId,
        g.principalId,
        `wrs-${tag}`,
      ],
    ],
  ];
  await seeding(q, async () => {
    for (const [text, values] of statements) await q.query(text, values);
  });
  return g;
}

/** Deletes a committed graph again, as the superuser with triggers off. */
async function deleteGraph(q: Querier, g: Graph) {
  await q.query("BEGIN");
  try {
    await q.query("SET LOCAL session_replication_role = replica");
    for (const [table, { column, parent }] of Object.entries(INDIRECT)) {
      await q.query(
        `delete from public.${table} t where exists (select 1 from public.${parent} p where p.id = t.${column} and p.organization_id = $1)`,
        [g.organizationId],
      );
    }
    for (const table of Object.keys(PROCESSOR_GRANTS)) {
      if (table in INDIRECT || GLOBAL_IN_MATRIX.has(table)) continue;
      if (table === "organizations") continue;
      await q.query(`delete from public.${table} where organization_id = $1`, [
        g.organizationId,
      ]);
    }
    await q.query("delete from public.organizations where id = $1", [
      g.organizationId,
    ]);
    await q.query(`delete from public."user" where id = $1`, [g.userId]);
    await q.query("COMMIT");
  } catch (error) {
    await q.query("ROLLBACK");
    throw error;
  }
}

/** n pending outbox rows of `organizationId`, older than anything else there. */
async function seedOutbox(
  q: Querier,
  organizationId: string,
  n: number,
  base = "1990-01-01",
) {
  await seeding(q, () =>
    q.query(
      `with ev as (
         insert into public.domain_events (id, organization_id, aggregate_type, aggregate_id, aggregate_version, type, schema_version, actor, correlation_id, causation_id, data)
         select gen_random_uuid(), $1, 'request', gen_random_uuid(), 1, 'request.created.v1', 1, '{}', 'wrs', 'wrs', '{}'
         from generate_series(1, $2)
         returning id
       ), numbered as (select id, row_number() over (order by id) as n from ev)
       insert into public.outbox (event_id, state, created_at, next_attempt_at)
       select id, 'pending', $3::timestamptz + n * interval '1 millisecond', $3::timestamptz from numbered`,
      [organizationId, n, base],
    ),
  );
  const { rows } = await q.query<{ id: string }>(
    `select o.id from public.outbox o join public.domain_events d on d.id = o.event_id
     where d.organization_id = $1 order by o.created_at, o.id`,
    [organizationId],
  );
  return rows.map((row) => row.id);
}

/**
 * n pending import dispatches of `organizationId`, older than anything else
 * there, each under an import run of its own (one dispatch per run and kind).
 * The organisation and the runs are real rows: a claim updates the dispatch,
 * and PostgreSQL checks the foreign keys of a row updated in the transaction
 * that inserted it, whatever the seed skipped.
 */
async function seedDispatches(q: Querier, organizationId: string, n: number) {
  await seeding(q, async () => {
    await q.query(
      `insert into public.organizations (id, name, slug, status) values ($1, $2, $2, 'active') on conflict (id) do nothing`,
      [organizationId, `wrs-d-${organizationId.slice(0, 8)}`],
    );
    await q.query(
      `with runs as (
         insert into public.import_runs (id, organization_id, import_source_id, source_snapshot_id, requested_by_type, requested_by_id, parser_version)
         select gen_random_uuid(), $1, gen_random_uuid(), gen_random_uuid(), 'user', 'wrs', 'v1'
         from generate_series(1, $2)
         returning id
       ), numbered as (select id, row_number() over (order by id) as g from runs)
       insert into public.import_task_dispatches (organization_id, import_run_id, task_kind, task_payload, state, updated_at)
       select $1, id, 'apply', '{}', 'pending', timestamptz '1990-01-01' + g * interval '1 millisecond'
       from numbered`,
      [organizationId, n],
    );
  });
  const { rows } = await q.query<{ id: string }>(
    "select id from public.import_task_dispatches where organization_id = $1 order by updated_at, id",
    [organizationId],
  );
  return rows.map((row) => row.id);
}

/** An active organisation with a project, a request and an active Slack installation and webhook subscription. */
async function seedOrganization(q: Querier) {
  const tag = randomUUID().slice(0, 8);
  const o = {
    organizationId: randomUUID(),
    projectId: randomUUID(),
    requestId: randomUUID(),
    installationId: randomUUID(),
    subscriptionId: randomUUID(),
  };
  await seeding(q, async () => {
    await q.query(
      `insert into public.organizations (id, name, slug, status) values ($1, $2, $2, 'active')`,
      [o.organizationId, `wrs-o-${tag}`],
    );
    await q.query(
      `insert into public.projects (id, organization_id, name, slug, key_prefix, status) values ($1, $2, 'P', $3, $4, 'active')`,
      [
        o.projectId,
        o.organizationId,
        `wrs-o-${tag}`,
        `O${tag.slice(0, 4).toUpperCase()}`,
      ],
    );
    await q.query(
      `insert into public.requests (id, organization_id, source_kind, target_project_id, type, title, description_md, reporter_type, reporter_id)
       values ($1, $2, 'human_direct', $3, 'bug', 'R', '', 'user', 'wrs')`,
      [o.requestId, o.organizationId, o.projectId],
    );
    await q.query(
      `insert into public.slack_installations (id, organization_id, workspace_id, workspace_name, bot_token_ciphertext, bot_user_id, installed_by_user_id, status)
       values ($1, $2, $3, 'W', '{}', 'B1', 'wrs', 'active')`,
      [o.installationId, o.organizationId, `T${tag}`],
    );
    await q.query(
      `insert into public.webhook_subscriptions (id, organization_id, name, endpoint_url, current_secret_ciphertext, current_secret_key_id, created_by, status, verified_at)
       values ($1, $2, 'hook', 'https://example.test/hook', '{}', 'k1', 'wrs', 'active', now())`,
      [o.subscriptionId, o.organizationId],
    );
  });
  return o;
}

type Organization = Awaited<ReturnType<typeof seedOrganization>>;

/** n due rows of every discovery function's kind, older than anything else there. */
async function seedDue(q: Querier, o: Organization, n: number) {
  const base = "timestamptz '1990-01-01' + g * interval '1 millisecond'";
  await seeding(q, async () => {
    await q.query(
      `insert into public.notification_intents (organization_id, channel, recipient_ref, template, dedupe_key, view_model, status, next_attempt_at, created_at)
       select $1, 'email', 'due@example.test', 'seed', 'wrs-due-' || gen_random_uuid(), '{}', 'pending', ${base}, ${base}
       from generate_series(1, $2) g`,
      [o.organizationId, n],
    );
    await q.query(
      `insert into public.webhook_deliveries (organization_id, subscription_id, event_id, status, created_at)
       select $1, $2, gen_random_uuid(), 'pending', ${base} from generate_series(1, $3) g`,
      [o.organizationId, o.subscriptionId, n],
    );
    for (const type of ["message_update", "connection_test"]) {
      await q.query(
        `insert into public.slack_delivery_operations (installation_id, operation_key, operation_type, next_attempt_at, created_at)
         select $1, 'wrs-' || gen_random_uuid(), $2, ${base}, ${base} from generate_series(1, $3) g`,
        [o.installationId, type, n],
      );
    }
    await q.query(
      `insert into public.work_sessions (organization_id, id, request_id, agent_principal_id, installation_id, workspace_id, authorization_chain, credential_fingerprint, state, heartbeat_interval_seconds, lease_expires_at, grace_expires_at)
       select $1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}', 'wrs', 'claimed', 30, ${base}, ${base} + interval '1 minute'
       from generate_series(1, $2) g`,
      [o.organizationId, n],
    );
    await q.query(
      `insert into public.work_sessions (organization_id, id, request_id, agent_principal_id, installation_id, workspace_id, authorization_chain, credential_fingerprint, state, heartbeat_interval_seconds, lease_expires_at, grace_expires_at)
       select $1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}', 'wrs', 'stale', 30, ${base}, ${base}
       from generate_series(1, $2) g`,
      [o.organizationId, n],
    );
    await q.query(
      `insert into public.webhook_subscriptions (organization_id, name, endpoint_url, current_secret_ciphertext, current_secret_key_id, next_secret_ciphertext, next_secret_key_id, overlap_ends_at, created_by)
       select $1, 'due', 'https://example.test/due', '{}', 'k1', '{}', 'k2', ${base}, 'wrs' from generate_series(1, $2) g`,
      [o.organizationId, n],
    );
    await q.query(
      `insert into public.questions (id, organization_id, subject_type, subject_id, parent_request_id, audience_type, body_md, asked_by_type, asked_by_id, deadline_at)
       select gen_random_uuid(), $1, 'request', $2, $2, 'requester', 'Due?', 'user', 'wrs', ${base} from generate_series(1, $3) g`,
      [o.organizationId, o.requestId, n],
    );
  });
}

async function databaseNow(q: Querier) {
  const { rows } = await q.query<{ now: Date }>(
    "select clock_timestamp() as now",
  );
  return (rows[0] as { now: Date }).now;
}

// ---------------------------------------------------------------------------
// The catalogue: roles, functions, grants (Done when 2's matrix, 6, 8, 9)
// ---------------------------------------------------------------------------

describe.sequential("the three worker groups and their functions, from the catalogue", () => {
  test("each group is NOLOGIN, not a superuser, cannot bypass row security, is a member of nothing and owns nothing", async () => {
    await inRolledBackTransaction(async (session) => {
      const { rows } = await session.query<Record<string, unknown>>(
        `select r.rolname, r.rolsuper, r.rolcanlogin, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
           (select count(*) from pg_catalog.pg_auth_members m where m.member = r.oid)::int as memberships,
           ((select count(*) from pg_catalog.pg_class c where c.relowner = r.oid)
             + (select count(*) from pg_catalog.pg_proc p where p.proowner = r.oid)
             + (select count(*) from pg_catalog.pg_namespace n where n.nspowner = r.oid))::int as owned
         from pg_catalog.pg_roles r where r.rolname = any($1) order by r.rolname`,
        [[...GROUPS]],
      );
      expect(rows).toEqual(
        [...GROUPS].sort().map((rolname) => ({
          rolname,
          rolsuper: false,
          rolcanlogin: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          memberships: 0,
          owned: 0,
        })),
      );
    });
  });

  test("each of the seventeen is a SECURITY DEFINER owned by the definer, with the pinned path, and executable by its group alone: no PUBLIC, no migrating role and no owner's entry (0023)", async () => {
    await inRolledBackTransaction(async (session) => {
      const { rows } = await session.query<{
        name: string;
        args: string;
        result: string;
        definer: boolean;
        owner: string;
        config: string[] | null;
        acl: string[] | null;
        grantees: string[];
      }>(
        `select p.proname as name, pg_catalog.pg_get_function_arguments(p.oid) as args,
           pg_catalog.pg_get_function_result(p.oid) as result, p.prosecdef as definer,
           pg_catalog.pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
           p.proacl::text[] as acl,
           coalesce((select array_agg(case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee)::text end order by 1)
                     from pg_catalog.aclexplode(p.proacl) a where a.grantee <> p.proowner), '{}') as grantees
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'requestport_private' and p.proname = any($1)`,
        [FUNCTIONS.map((fn) => fn.name)],
      );
      expect(rows).toHaveLength(17);
      // The same seventeen, and roles, as the catalogue ratchet holds.
      expect(
        Object.fromEntries(
          FUNCTIONS.map((fn) => [
            `requestport_private.${fn.name}(${fn.args})`,
            fn.role,
          ]),
        ),
      ).toEqual(WORKER_FUNCTIONS);
      for (const fn of FUNCTIONS) {
        const found = rows.find((row) => row.name === fn.name);
        expect(found, fn.name).toBeDefined();
        expect(found?.args, fn.name).toBe(fn.args);
        // Done when 9: the returned columns, exactly.
        expect(found?.result, fn.name).toBe(fn.result);
        expect(found?.definer, fn.name).toBe(true);
        expect(found?.owner, fn.name).toBe(DEFINER);
        expect(found?.config, fn.name).toEqual([
          "search_path=pg_catalog, pg_temp",
        ]);
        // 0023 revoked 0020's grant to the migrating role and the owner's
        // own entry, so the whole ACL is the group's, granted by the owner.
        expect(found?.grantees, fn.name).toEqual([fn.role]);
        expect(found?.acl, fn.name).toEqual(workerFunctionAcl(fn.role));
      }
    });
  });

  test("each of 0021's two is a SECURITY DEFINER owned by the definer, with the pinned path, no PUBLIC, and exactly the processor and the application: no migrating role and no owner's entry (I.2 step 5's contract)", async () => {
    await inRolledBackTransaction(async (session) => {
      const { rows } = await session.query<{
        name: string;
        args: string;
        result: string;
        definer: boolean;
        volatility: string;
        language: string;
        owner: string;
        config: string[] | null;
        acl: string[] | null;
        grantees: string[];
      }>(
        `select p.proname as name, pg_catalog.pg_get_function_arguments(p.oid) as args,
           pg_catalog.pg_get_function_result(p.oid) as result, p.prosecdef as definer,
           p.provolatile::text as volatility, l.lanname::text as language,
           pg_catalog.pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
           p.proacl::text[] as acl,
           coalesce((select array_agg(case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee)::text end order by 1)
                     from pg_catalog.aclexplode(p.proacl) a where a.grantee <> p.proowner), '{}') as grantees
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         join pg_catalog.pg_language l on l.oid = p.prolang
         where n.nspname = 'requestport_private' and p.proname = any($1)`,
        [LOCKS.map((fn) => fn.name)],
      );
      expect(rows).toHaveLength(2);
      expect(
        Object.fromEntries(
          LOCKS.map((fn) => [
            `requestport_private.${fn.name}(${fn.args})`,
            [...LOCK_ROLES].sort(),
          ]),
        ),
      ).toEqual(
        Object.fromEntries(
          Object.entries(CREDENTIAL_LOCK_FUNCTIONS).map(
            ([signature, roles]) => [signature, [...roles].sort()],
          ),
        ),
      );
      for (const fn of LOCKS) {
        const found = rows.find((row) => row.name === fn.name);
        expect(found, fn.name).toBeDefined();
        expect(found?.args, fn.name).toBe(fn.args);
        expect(found?.result, fn.name).toBe(fn.result);
        expect(found?.definer, fn.name).toBe(true);
        // A row lock is refused in a function that is not VOLATILE.
        expect(found?.volatility, fn.name).toBe("v");
        expect(found?.language, fn.name).toBe("plpgsql");
        expect(found?.owner, fn.name).toBe(DEFINER);
        expect(found?.config, fn.name).toEqual([
          "search_path=pg_catalog, pg_temp",
        ]);
        expect(found?.acl, fn.name).not.toBeNull();
        expect(
          found?.acl?.some((item) => item.startsWith("=")),
          fn.name,
        ).toBe(false);
        expect([...(found?.grantees ?? [])].sort(), fn.name).toEqual(
          [...LOCK_ROLES].sort(),
        );
        // Step 5's contract revoked the migrating role's grant and the
        // owner's own entry, through which the migrating role inherits
        // EXECUTE (0019's membership): the whole ACL is the two groups'.
        expect([...(found?.acl ?? [])].sort(), fn.name).toEqual(
          LOCK_ROLES.map((role) => `${role}=X/${DEFINER}`).sort(),
        );
      }
    });
  });

  test("each role may execute exactly its own functions, and the application group and the owner none of the seventeen; the processor and the application both of 0021's two (Done when 2, 9)", async () => {
    await inRolledBackTransaction(async (session) => {
      // The owner, requestport_definer, is not a superuser: since 0023 its
      // own entry is gone from each of the seventeen, and since step 5's
      // contract from 0021's two.
      for (const role of [...GROUPS, APPLICATION, DEFINER, "PUBLIC"]) {
        const { rows } = await session.query<{
          name: string;
          allowed: boolean;
        }>(
          `select p.proname as name,
             case when $1 = 'PUBLIC'
               then exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
               else pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') end as allowed
           from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'requestport_private' and p.proname = any($2)`,
          [role, [...FUNCTIONS, ...LOCKS].map((fn) => fn.name)],
        );
        for (const fn of FUNCTIONS) {
          expect(
            rows.find((row) => row.name === fn.name)?.allowed,
            `${role} on ${fn.name}`,
          ).toBe(fn.role === role);
        }
        for (const fn of LOCKS) {
          expect(
            rows.find((row) => row.name === fn.name)?.allowed,
            `${role} on ${fn.name}`,
          ).toBe(LOCK_ROLES.includes(role));
        }
      }
    });
  });

  test("neither the dispatcher nor the maintenance role holds a grant on any table or column, in any schema", async () => {
    await inRolledBackTransaction(async (session) => {
      const { rows } = await session.query<{ grant: string }>(
        `select n.nspname || '.' || c.relname || ': ' || a.privilege_type || ' to ' || pg_catalog.pg_get_userbyid(a.grantee) as grant
         from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
           pg_catalog.aclexplode(c.relacl) a
         where pg_catalog.pg_get_userbyid(a.grantee) = any($1)
         union all
         select n.nspname || '.' || c.relname || '.' || at.attname || ': ' || a.privilege_type || ' to ' || pg_catalog.pg_get_userbyid(a.grantee)
         from pg_catalog.pg_attribute at join pg_catalog.pg_class c on c.oid = at.attrelid
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
           pg_catalog.aclexplode(at.attacl) a
         where pg_catalog.pg_get_userbyid(a.grantee) = any($1)`,
        [[DISPATCHER, MAINTENANCE]],
      );
      expect(rows).toEqual([]);
      const { rows: any } = await session.query<{ table: string }>(
        `select c.relname as "table" from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'requestport_private') and c.relkind in ('r', 'p')
           and (pg_catalog.has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
             or pg_catalog.has_table_privilege($2, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
             or pg_catalog.has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
             or pg_catalog.has_any_column_privilege($2, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))`,
        [DISPATCHER, MAINTENANCE],
      );
      expect(any).toEqual([]);
    });
  });

  test("the processor's grants are exactly the matrix, refused on nine Better Auth tables and on user's other columns (Done when 8)", async () => {
    await inRolledBackTransaction(async (session) => {
      const { rows } = await session.query<{
        schema: string;
        table: string;
        privilege: string;
      }>(
        `select n.nspname as schema, c.relname as "table", a.privilege_type as privilege
         from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
           pg_catalog.aclexplode(c.relacl) a
         where pg_catalog.pg_get_userbyid(a.grantee) = $1
         union all
         select n.nspname, c.relname, a.privilege_type || ' (' || at.attname || ')'
         from pg_catalog.pg_attribute at join pg_catalog.pg_class c on c.oid = at.attrelid
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
           pg_catalog.aclexplode(at.attacl) a
         where pg_catalog.pg_get_userbyid(a.grantee) = $1`,
        [PROCESSOR],
      );
      expect(rows.filter((row) => row.schema !== "public")).toEqual([]);
      const actual: Record<string, string[]> = {};
      for (const row of rows) {
        const privileges = actual[row.table] ?? [];
        privileges.push(row.privilege);
        actual[row.table] = privileges;
      }
      for (const privileges of Object.values(actual)) privileges.sort();
      const expected = Object.fromEntries(
        Object.entries(PROCESSOR_GRANTS).map(([table, privileges]) => [
          table,
          [...privileges].sort(),
        ]),
      );
      expect(actual).toEqual(expected);

      for (const table of REFUSED_BETTER_AUTH) {
        const { rows: allowed } = await session.query<{ allowed: boolean }>(
          `select pg_catalog.has_table_privilege($1, $2, 'SELECT, INSERT, UPDATE, DELETE')
             or pg_catalog.has_any_column_privilege($1, $2, 'SELECT, INSERT, UPDATE') as allowed`,
          [PROCESSOR, `public."${table}"`],
        );
        expect(allowed[0]?.allowed, table).toBe(false);
      }
      const { rows: userColumns } = await session.query<{
        column: string;
        readable: boolean;
      }>(
        `select at.attname as "column", pg_catalog.has_column_privilege($1, at.attrelid, at.attnum, 'SELECT') as readable
         from pg_catalog.pg_attribute at
         where at.attrelid = 'public."user"'::regclass and at.attnum > 0 and not at.attisdropped`,
        [PROCESSOR],
      );
      expect(
        userColumns
          .filter((column) => column.readable)
          .map((c) => c.column)
          .sort(),
      ).toEqual(["email", "id", "name"]);
      expect(userColumns.length).toBeGreaterThan(3);
    });
  });

  test("every tenant table the processor touches has row security and one permissive policy for everyone (Done when 8)", async () => {
    await inRolledBackTransaction(async (session) => {
      const tables = Object.keys(PROCESSOR_GRANTS).filter(
        (table) => !GLOBAL_IN_MATRIX.has(table),
      );
      const { rows } = await session.query<{
        table: string;
        rls: boolean;
        permissive: number;
        restrictive: number;
        to_public: boolean;
      }>(
        `select c.relname as "table", c.relrowsecurity as rls,
           (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid and p.polpermissive)::int as permissive,
           (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid and not p.polpermissive)::int as restrictive,
           coalesce((select bool_and(p.polroles = '{0}') from pg_catalog.pg_policy p where p.polrelid = c.oid), false) as to_public
         from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = any($1) order by 1`,
        [tables],
      );
      expect(rows).toHaveLength(tables.length);
      for (const row of rows) {
        expect(row, row.table).toEqual({
          table: row.table,
          rls: true,
          permissive: 1,
          restrictive: 0,
          to_public: true,
        });
      }
    });
  });

  // USAGE is read from each schema's own grants: whether PUBLIC may use
  // public is the database's (a template's public grants it; production's,
  // with a NULL ACL, does not), and the migration grants nothing to PUBLIC.
  test("schemas: USAGE granted on requestport_private to all three, on public to the processor only, CREATE for none; the processor evaluates the policies' binding reader", async () => {
    await inRolledBackTransaction(async (session) => {
      for (const role of GROUPS) {
        const { rows } = await session.query<Record<string, boolean>>(
          `select exists (select 1 from pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
                     where n.nspname = 'requestport_private' and a.grantee = $1::regrole and a.privilege_type = 'USAGE') as private_usage,
             exists (select 1 from pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
                     where n.nspname = 'public' and a.grantee = $1::regrole and a.privilege_type = 'USAGE') as public_usage,
             pg_catalog.has_schema_privilege($1, 'requestport_private', 'CREATE') as private_create,
             pg_catalog.has_schema_privilege($1, 'public', 'CREATE') as public_create,
             pg_catalog.has_function_privilege($1, 'requestport_private.bound_organization_id()', 'EXECUTE') as binding,
             pg_catalog.has_function_privilege($1, 'requestport_private.bound_user_id()', 'EXECUTE') as user_binding`,
          [role],
        );
        expect(rows[0], role).toEqual({
          private_usage: true,
          public_usage: role === PROCESSOR,
          private_create: false,
          public_create: false,
          binding: role === PROCESSOR,
          user_binding: false,
        });
      }
    });
  });

  test("§2.5.0 in every body, 0021's two included: every relation qualified, no dynamic SQL, syntax built-ins bare (Done when 6)", async () => {
    await inRolledBackTransaction(async (session) => {
      const { rows } = await session.query<{ name: string; source: string }>(
        `select p.proname as name, p.prosrc as source from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'requestport_private' and p.proname = any($1)`,
        [[...FUNCTIONS, ...LOCKS].map((fn) => fn.name)],
      );
      expect(rows).toHaveLength(19);
      const unqualified =
        /\b(?:FROM|JOIN|(?<!\bFOR\s)UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?!public\.|requestport_private\.|\(|eligible\b|claimed\b)[a-z_"]/iu;
      for (const { name, source } of rows) {
        const code = source.replace(/--[^\n]*/gu, "");
        expect(unqualified.exec(code)?.[0] ?? null, name).toBeNull();
        expect(code, name).not.toMatch(/\bEXECUTE\b|\bformat\s*\(/iu);
        expect(code, name).not.toMatch(
          /pg_catalog\.(?:nullif|coalesce|greatest|least)\b/iu,
        );
      }
    });
  });

  test("retention's ages are a table only the definer reads, and equal retentionAgeMs (Done when 10)", async () => {
    await inRolledBackTransaction(async (session) => {
      const { rows } = await session.query<{
        category: string;
        age_ms: string;
      }>(
        "select category, age_ms from requestport_private.retention_ages order by category",
      );
      const now = new Date();
      expect(
        Object.fromEntries(
          rows.map((row) => [row.category, Number(row.age_ms)]),
        ),
      ).toEqual(
        Object.fromEntries(
          [...retentionCategories]
            .sort()
            .map((category) => [
              category,
              now.getTime() - retentionCutoff(category, now).getTime(),
            ]),
        ),
      );
      const { rows: readers } = await session.query<{ grantee: string }>(
        `select pg_catalog.pg_get_userbyid(a.grantee) as grantee
         from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
         where c.oid = 'requestport_private.retention_ages'::regclass and a.grantee <> c.relowner`,
      );
      expect(readers).toEqual([{ grantee: DEFINER }]);
    });
  });
});

// ---------------------------------------------------------------------------
// Done when 1 and 2, as the logins themselves
// ---------------------------------------------------------------------------

describe.sequential("as the tenant processor's login, bound to A (Done when 1, 2)", () => {
  let a: Graph;
  let b: Graph;
  let owner: TestSession;

  beforeAll(async () => {
    owner = await openSession(suiteStorage);
    await owner.query("BEGIN");
    try {
      a = await seedGraph(owner);
      b = await seedGraph(owner);
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      if (a) await deleteGraph(owner, a);
      if (b) await deleteGraph(owner, b);
    } finally {
      owner.release();
    }
  });

  async function asProcessor<T>(work: (client: Querier) => Promise<T>) {
    const client = await connectAs(PROCESSOR);
    const q = client as unknown as Querier;
    try {
      await q.query("BEGIN");
      await q.query("SET LOCAL lock_timeout = '5s'");
      return await work(q);
    } finally {
      await q.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  }

  test("the login is a member of the processor group only, not a superuser, cannot bypass row security and owns nothing", async () => {
    await asProcessor(async (q) => {
      const { rows } = await q.query<Record<string, unknown>>(
        `select r.rolsuper, r.rolbypassrls,
           array(select g.rolname::text from pg_catalog.pg_roles g
                 where g.oid <> r.oid and pg_catalog.pg_has_role(r.oid, g.oid, 'MEMBER') order by 1) as member_of,
           ((select count(*) from pg_catalog.pg_class c where c.relowner = r.oid)
             + (select count(*) from pg_catalog.pg_proc p where p.proowner = r.oid))::int as owned,
           current_user = session_user as is_login
         from pg_catalog.pg_roles r where r.rolname = current_user`,
      );
      expect(rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        member_of: [PROCESSOR],
        owned: 0,
        is_login: true,
      });
    });
  });

  test("with every predicate removed, B's rows are neither seen nor touched in any table of the matrix, and a B row is refused (Done when 1)", async () => {
    const aCounts: Record<string, number> = {};
    for (const table of Object.keys(PROCESSOR_GRANTS)) {
      if (GLOBAL_IN_MATRIX.has(table)) continue;
      const { rows } = await owner.query<{ n: number }>(
        `select count(*)::int as n from public."${table}" t where ${belongsTo(table)}`,
        [a.organizationId],
      );
      aCounts[table] = (rows[0] as { n: number }).n;
      const { rows: bRows } = await owner.query<{ n: number }>(
        `select count(*)::int as n from public."${table}" t where ${belongsTo(table)}`,
        [b.organizationId],
      );
      // The check means something only if B has a row there.
      expect((bRows[0] as { n: number }).n, `B's ${table}`).toBeGreaterThan(0);
    }

    await asProcessor(async (q) => {
      await bind(q, a.organizationId);
      for (const [table, privileges] of Object.entries(PROCESSOR_GRANTS)) {
        if (GLOBAL_IN_MATRIX.has(table)) continue;
        const readable = privileges.includes(S);
        const updatable = privileges.includes(U) || privileges.includes(UID);

        if (readable) {
          const { rows } = await q.query<{ n: number }>(
            `select count(*)::int as n from public."${table}"`,
          );
          expect((rows[0] as { n: number }).n, `${table}: select`).toBe(
            aCounts[table],
          );
        } else {
          expect(
            (await failure(q, `select count(*) from public."${table}"`)).code,
            `${table}: select`,
          ).toBe("42501");
        }

        if (updatable) {
          const column = unchangedColumn(table);
          const updated = await undone(q, () =>
            q.query(`update public."${table}" set ${column} = ${column}`),
          );
          expect(updated.rowCount, `${table}: update`).toBe(aCounts[table]);
        } else {
          const column = unchangedColumn(table);
          expect(
            (
              await failure(
                q,
                `update public."${table}" set ${column} = ${column}`,
              )
            ).code,
            `${table}: update`,
          ).toBe("42501");
        }

        expect(
          (await failure(q, `delete from public."${table}"`)).code,
          `${table}: delete`,
        ).toBe("42501");

        const indirect = INDIRECT[table];
        const insert =
          table === "organizations"
            ? {
                text: "insert into public.organizations (id) values ($1)",
                values: [b.organizationId],
              }
            : indirect
              ? {
                  text: `insert into public."${table}" (${indirect.column}) values ($1)`,
                  values: [
                    {
                      domain_events: b.eventId,
                      requests: b.requestId,
                      slack_installations: b.installationId,
                      webhook_deliveries: b.deliveryId,
                    }[indirect.parent],
                  ],
                }
              : {
                  text: `insert into public."${table}" (organization_id) values ($1)`,
                  values: [b.organizationId],
                };
        expect(
          (await failure(q, insert.text, insert.values)).code,
          `${table}: insert a B row`,
        ).toBe("42501");
      }

      // The positive control: the processor writes A's own rows, a child
      // under its parent's policy and an audit row under its own.
      const label = await undone(q, () =>
        q.query(
          "insert into public.request_labels (request_id, label) values ($1, 'processed')",
          [a.requestId],
        ),
      );
      expect(label.rowCount).toBe(1);
      const audit = await undone(q, () =>
        q.query(
          `insert into public.security_audit_records (organization_id, actor_type, actor_id, action, target_type, target_id, reason, correlation_id)
           values ($1, 'system', 'worker', 'processed', 'request', $2, 'processed', 'wrs')`,
          [a.organizationId, a.requestId],
        ),
      );
      expect(audit.rowCount).toBe(1);

      // Better Auth's user: its three columns, and nothing else.
      const { rows: users } = await q.query<{ id: string }>(
        `select id, name, email from public."user" where id = any($1)`,
        [[a.userId, b.userId]],
      );
      expect(users.map((user) => user.id).sort()).toEqual(
        [a.userId, b.userId].sort(),
      );
      expect((await failure(q, `select * from public."user"`)).code).toBe(
        "42501",
      );
    });
    // Every table of the matrix, several statements each, one after another:
    // 2-17 s in a gate, and 25.9 s, 31.2 s and 30.3 s at the worst
    // (2026-09-30 to 2026-10-01, X23), against the package's 30 s default.
    // row-security.integration.test.ts gives its own matrix case 120 s.
  }, 120_000);

  test("bound to A, it cannot claim, discover, resolve or maintain, and B's work is invisible to it (Done when 2)", async () => {
    await asProcessor(async (q) => {
      await bind(q, a.organizationId);
      for (const fn of FUNCTIONS) {
        if (fn.role === PROCESSOR) continue;
        const refused = await failure(q, fn.call);
        expect(refused.code, fn.name).toBe("42501");
        expect(refused.message, fn.name).toMatch(
          /permission denied for function/u,
        );
      }
      for (const [kind, id] of [
        ["outbox", b.outboxId],
        ["outbox", a.outboxId],
        ["import_task_dispatch", b.dispatchId],
        ["import_task_dispatch", a.dispatchId],
        ["notification_intent", b.intentId],
        ["webhook_delivery", b.deliveryId],
        ["slack_delivery_operation", b.operationId],
      ] as const) {
        const raised = await failure(
          q,
          "select requestport_private.resolve_job_organization($1, $2)",
          [kind, id],
        );
        expect(raised.code, `${kind} ${id}`).toBe("42501");
        expect(raised.message).toMatch(/resolved only before one is bound/u);
      }
      for (const [table, id] of [
        ["outbox", b.outboxId],
        ["import_task_dispatches", b.dispatchId],
        ["notification_intents", b.intentId],
        ["webhook_deliveries", b.deliveryId],
        ["work_sessions", b.workSessionId],
        ["slack_delivery_operations", b.operationId],
      ] as const) {
        const { rows } = await q.query(
          `select * from public.${table} where id = $1`,
          [id],
        );
        expect(rows, table).toEqual([]);
      }
      // A completion or a dead letter of B's outbox row by id, as the
      // repository writes one today, changes nothing.
      const completed = await q.query(
        "update public.outbox set state = 'completed', lease_owner = null, lease_expires_at = null where id = $1",
        [b.outboxId],
      );
      expect(completed.rowCount).toBe(0);
      const dead = await q.query(
        "update public.outbox set state = 'dead_letter', lease_owner = null, lease_expires_at = null where id = $1",
        [b.outboxId],
      );
      expect(dead.rowCount).toBe(0);
      // The positive control: A's own row is the processor's to settle.
      const own = await undone(q, () =>
        q.query(
          "update public.outbox set state = 'completed', lease_owner = null, lease_expires_at = null where id = $1",
          [a.outboxId],
        ),
      );
      expect(own.rowCount).toBe(1);
    });
    const { rows } = await owner.query<{ state: string }>(
      "select state from public.outbox where id = any($1) order by state",
      [[a.outboxId, b.outboxId]],
    );
    expect(rows).toEqual([{ state: "leased" }, { state: "leased" }]);
  });

  test("unbound, it resolves any in-flight id's organisation, and reads no tenant row", async () => {
    await asProcessor(async (q) => {
      const { rows } = await q.query<{ a: string; b: string }>(
        `select requestport_private.resolve_job_organization('outbox', $1) as a,
                requestport_private.resolve_job_organization('outbox', $2) as b`,
        [a.outboxId, b.outboxId],
      );
      expect(rows[0]).toEqual({ a: a.organizationId, b: b.organizationId });
      const refused = await failure(q, "select count(*) from public.outbox");
      expect(refused).toMatchObject({
        code: "42501",
        message: "requestport: no organisation is bound to this transaction",
      });
    });
  });

  test("the dispatcher's and the maintenance login's own sessions reach no table directly", async () => {
    for (const group of [DISPATCHER, MAINTENANCE] as const) {
      const client = await connectAs(group);
      const q = client as unknown as Querier;
      try {
        await q.query("BEGIN");
        await bind(q, a.organizationId);
        for (const table of [
          "outbox",
          "organizations",
          "import_task_dispatches",
        ]) {
          expect(
            (await failure(q, `select count(*) from public.${table}`)).code,
            `${group}: ${table}`,
          ).toBe("42501");
        }
      } finally {
        await q.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Leases (Done when 3) and hostile arguments (Done when 5)
// ---------------------------------------------------------------------------

type Claimed = {
  id: string;
  organization_id: string;
  attempt_count: number;
  lease_id: string;
  lease_expires_at: Date;
};

async function claimOutbox(
  session: TestSession,
  limit: number | null,
  leaseSeconds: number | null,
): Promise<Claimed[]> {
  return as(session, DISPATCHER, async () => {
    const { rows } = await session.query<Claimed & { outbox_id: string }>(
      "select * from requestport_private.claim_outbox_batch($1, $2)",
      [limit, leaseSeconds],
    );
    return rows.map((row) => ({ ...row, id: row.outbox_id }));
  });
}

async function claimDispatches(
  session: TestSession,
  limit: number | null,
  leaseSeconds: number | null,
): Promise<Claimed[]> {
  return as(session, DISPATCHER, async () => {
    const { rows } = await session.query<Claimed & { dispatch_id: string }>(
      "select * from requestport_private.claim_import_dispatch_batch($1, $2)",
      [limit, leaseSeconds],
    );
    return rows.map((row) => ({ ...row, id: row.dispatch_id }));
  });
}

const kinds = [
  {
    kind: "outbox",
    table: "outbox",
    seed: async (session: TestSession, organizationId: string, n: number) =>
      seedOutbox(session, organizationId, n),
    claim: claimOutbox,
    accept: "accept_outbox_claim",
    leaseBounds: { min: 10, max: 600, fallback: 60 },
  },
  {
    kind: "import dispatch",
    table: "import_task_dispatches",
    seed: seedDispatches,
    claim: claimDispatches,
    accept: "accept_import_dispatch_claim",
    leaseBounds: { min: 60, max: 1800, fallback: 60 },
  },
] as const;

describe.sequential("leases are the database's, and settle only while they hold (Done when 3)", () => {
  test.each(kinds)(
    "$kind: a wrong, another claim's or an expired lease changes nothing; the right one accepts",
    async ({ table, seed, claim, accept }) => {
      await inRolledBackTransaction(async (session) => {
        const organizationId = randomUUID();
        const [first, second] = await seed(session, organizationId, 2);
        const [claimed] = await claim(session, 1, null);
        const [other] = await claim(session, 1, null);
        expect(claimed?.id).toBe(first);
        expect(other?.id).toBe(second);
        const row = claimed as Claimed;

        // The lease is the one the claim stored, a version-4 uuid it generated.
        const stored = await session.query<{ lease_owner: string }>(
          `select lease_owner from public.${table} where id = $1`,
          [row.id],
        );
        expect(stored.rows[0]?.lease_owner).toBe(row.lease_id);
        expect(row.lease_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        expect(row.lease_id).not.toBe(other?.lease_id);

        const unchanged = async () => {
          const { rows } = await session.query<{
            state: string;
            lease_owner: string | null;
            trigger_run_id: string | null;
          }>(
            `select state, lease_owner, trigger_run_id from public.${table} where id = $1`,
            [row.id],
          );
          expect(rows[0]).toEqual({
            state: "leased",
            lease_owner: row.lease_id,
            trigger_run_id: null,
          });
        };

        await as(session, DISPATCHER, async () => {
          for (const lease of [randomUUID(), other?.lease_id, null]) {
            const { rows } = await session.query<{ accepted: boolean }>(
              `select requestport_private.${accept}($1, $2, 'run-wrong') as accepted`,
              [row.id, lease],
            );
            expect(rows[0]?.accepted, `lease ${lease}`).toBe(false);
          }
          if (table === "outbox") {
            // Both arms: a retry (false or null) and a dead letter (true).
            for (const deadLetter of [false, null, true]) {
              const { rows } = await session.query<{ released: boolean }>(
                "select requestport_private.release_outbox_claim($1, $2, $3, 1000) as released",
                [row.id, other?.lease_id, deadLetter],
              );
              expect(rows[0]?.released, `dead letter ${deadLetter}`).toBe(
                false,
              );
            }
          }
        });
        await unchanged();

        // The suite's one privileged fixture: the owner moves the expiry.
        await session.query(
          `update public.${table} set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
          [row.id],
        );
        await as(session, DISPATCHER, async () => {
          const { rows } = await session.query<{ accepted: boolean }>(
            `select requestport_private.${accept}($1, $2, 'run-late') as accepted`,
            [row.id, row.lease_id],
          );
          expect(rows[0]?.accepted).toBe(false);
          if (table === "outbox") {
            // Under the row's own, expired lease, neither arm settles it: the
            // retry (false, and null, which retries) as well as the dead letter.
            for (const deadLetter of [true, false, null]) {
              const released = await session.query<{ released: boolean }>(
                "select requestport_private.release_outbox_claim($1, $2, $3, 1000) as released",
                [row.id, row.lease_id, deadLetter],
              );
              expect(
                released.rows[0]?.released,
                `dead letter ${deadLetter}`,
              ).toBe(false);
            }
          }
        });
        const { rows: expired } = await session.query<{
          state: string;
          lease_owner: string | null;
          trigger_run_id: string | null;
        }>(
          `select state, lease_owner, trigger_run_id from public.${table} where id = $1`,
          [row.id],
        );
        expect(expired[0]).toEqual({
          state: "leased",
          lease_owner: row.lease_id,
          trigger_run_id: null,
        });

        // Claimed again, it carries a new lease, and that one accepts. (A
        // dispatch's claim order is updated_at, which the first claim moved,
        // so older rows of other suites may come first: it is found by id.)
        const again = (await claim(session, 200, null)).find(
          (each) => each.id === row.id,
        );
        expect(again).toBeDefined();
        expect(again?.lease_id).not.toBe(row.lease_id);
        await as(session, DISPATCHER, async () => {
          const { rows } = await session.query<{ accepted: boolean }>(
            `select requestport_private.${accept}($1, $2, 'run-1') as accepted`,
            [row.id, again?.lease_id],
          );
          expect(rows[0]?.accepted).toBe(true);
        });
        const { rows: accepted } = await session.query(
          `select state, trigger_run_id, lease_owner, lease_expires_at from public.${table} where id = $1`,
          [row.id],
        );
        expect(accepted[0]).toEqual({
          state: "accepted",
          trigger_run_id: "run-1",
          lease_owner: null,
          lease_expires_at: null,
        });
      });
    },
  );

  test("outbox: a release under the lease retries after the clamped delay, or dead-letters", async () => {
    await inRolledBackTransaction(async (session) => {
      const organizationId = randomUUID();
      // Each retry's delay, as clamped: 1 000 ms is the floor (null, 0 and -1
      // reach it), 3 600 000 ms the ceiling. next_attempt_at is the clock at
      // the release plus that delay, so it falls between the clock read just
      // before its release and the one just after, each plus the delay. One
      // read before all five releases, with a fixed second of slack, failed
      // under load (X23).
      const retries = [
        { delay: 5_000, from: 5_000 },
        { delay: null, from: 1_000 },
        { delay: 0, from: 1_000 },
        { delay: -1, from: 1_000 },
        { delay: 2_147_483_647, from: 3_600_000 },
      ] as const;
      const ids = await seedOutbox(session, organizationId, retries.length + 1);
      const deadId = ids[retries.length] as string;
      const claimed = await claimOutbox(session, ids.length, null);
      const byId = new Map(claimed.map((row) => [row.id, row]));
      expect([...byId.keys()].sort()).toEqual([...ids].sort());
      const windows: { before: Date; after: Date }[] = [];
      await as(session, DISPATCHER, async () => {
        for (const [index, { delay }] of retries.entries()) {
          const id = ids[index] as string;
          const before = await databaseNow(session);
          const retried = await session.query<{ released: boolean }>(
            "select requestport_private.release_outbox_claim($1, $2, null, $3) as released",
            [id, byId.get(id)?.lease_id, delay],
          );
          windows[index] = { before, after: await databaseNow(session) };
          expect(retried.rows[0]?.released, `delay ${delay}`).toBe(true);
        }
        const dead = await session.query<{ released: boolean }>(
          "select requestport_private.release_outbox_claim($1, $2, true, null) as released",
          [deadId, byId.get(deadId)?.lease_id],
        );
        expect(dead.rows[0]?.released).toBe(true);
      });
      const { rows } = await session.query<{
        id: string;
        state: string;
        next_attempt_at: Date;
        lease_owner: string | null;
      }>(
        "select id, state, next_attempt_at, lease_owner from public.outbox where id = any($1)",
        [ids],
      );
      for (const [index, { delay, from }] of retries.entries()) {
        const retried = rows.find((row) => row.id === ids[index]);
        expect(retried?.state, `delay ${delay}`).toBe("pending");
        expect(retried?.lease_owner, `delay ${delay}`).toBeNull();
        const window = windows[index] as { before: Date; after: Date };
        const at = retried?.next_attempt_at.getTime() ?? 0;
        expect(at, `delay ${delay}`).toBeGreaterThanOrEqual(
          window.before.getTime() + from,
        );
        expect(at, `delay ${delay}`).toBeLessThanOrEqual(
          window.after.getTime() + from,
        );
      }
      expect(rows.find((row) => row.id === deadId)?.state).toBe("dead_letter");
    });
  });

  test.each(["accept_outbox_claim", "accept_import_dispatch_claim"])(
    "%s refuses a run id outside 1-255 characters with 22023",
    async (fn) => {
      await inRolledBackTransaction(async (session) => {
        await as(session, DISPATCHER, async () => {
          for (const runId of ["", "x".repeat(256), null]) {
            const refused = await failure(
              session,
              `select requestport_private.${fn}(gen_random_uuid(), gen_random_uuid(), $1)`,
              [runId],
            );
            expect(refused.code, `run id ${runId?.length}`).toBe("22023");
          }
          const { rows } = await session.query<{ accepted: boolean }>(
            `select requestport_private.${fn}(gen_random_uuid(), gen_random_uuid(), $1) as accepted`,
            ["x".repeat(255)],
          );
          expect(rows[0]?.accepted).toBe(false);
        });
      });
    },
  );
});

describe.sequential("hostile arguments, called directly in SQL (Done when 5)", () => {
  test.each(kinds)(
    "$kind: limits and leases are clamped to the stated bounds",
    async ({ seed, claim, leaseBounds }) => {
      await inRolledBackTransaction(async (session) => {
        await seed(session, randomUUID(), 201);
        for (const [limit, expected] of [
          [null, 50],
          [0, 1],
          [-1, 1],
          [2_147_483_647, 200],
        ] as const) {
          const rows = await undone(session, () => claim(session, limit, null));
          expect(rows, `limit ${limit}`).toHaveLength(expected);
        }
        for (const [lease, expected] of [
          [null, leaseBounds.fallback],
          [0, leaseBounds.min],
          [-1, leaseBounds.min],
          [1_000_000_000, leaseBounds.max],
        ] as const) {
          await undone(session, async () => {
            // The lease is the clock at the claim plus the clamped seconds,
            // so it falls between the reads just before and just after the
            // call, each plus those seconds (X23).
            const before = await databaseNow(session);
            const [row] = await claim(session, 1, lease);
            const after = await databaseNow(session);
            const expires = (row as Claimed).lease_expires_at.getTime();
            expect(expires, `lease ${lease}`).toBeGreaterThanOrEqual(
              before.getTime() + expected * 1_000,
            );
            expect(expires, `lease ${lease}`).toBeLessThanOrEqual(
              after.getTime() + expected * 1_000,
            );
          });
        }
      });
    },
  );

  test("each discovery function clamps its limit", async () => {
    await inRolledBackTransaction(async (session) => {
      const organization = await seedOrganization(session);
      await seedDue(session, organization, 501);
      const discoveries = [
        ["due_notification_intents", 100, 500],
        ["pending_webhook_deliveries", 100, 500],
        ["due_slack_message_updates", 100, 500],
        ["due_slack_connection_tests", 100, 500],
        ["lease_expired_work_sessions", 100, 500],
        ["grace_expired_work_sessions", 100, 500],
        ["due_webhook_secret_promotions", 100, 500],
        ["due_question_reminders", 200, 200],
      ] as const;
      await as(session, DISPATCHER, async () => {
        for (const [fn, fallback, max] of discoveries) {
          for (const [limit, expected] of [
            [null, fallback],
            [0, 1],
            [-1, 1],
            [2_147_483_647, max],
          ] as const) {
            const { rows } = await session.query(
              `select * from requestport_private.${fn}($1)`,
              [limit],
            );
            expect(rows, `${fn}(${limit})`).toHaveLength(expected);
          }
          // Its own oldest rows come first, with their organisation.
          const { rows } = await session.query<{ organization_id: string }>(
            `select * from requestport_private.${fn}(1)`,
          );
          expect(rows[0]?.organization_id, fn).toBe(
            organization.organizationId,
          );
        }
      });
    });
  });

  test("the resolver answers NULL alike for an absent id, a finished row, an unlisted kind and a mismatched kind", async () => {
    await inRolledBackTransaction(async (session) => {
      const o = await seedOrganization(session);
      const ids: Record<string, Record<string, string>> = {
        outbox: {},
        import_task_dispatch: {},
        webhook_delivery: {},
        notification_intent: {},
        slack_delivery_operation: {},
      };
      await seeding(session, async () => {
        for (const state of [
          "pending",
          "leased",
          "accepted",
          "completed",
          "dead_letter",
        ]) {
          const [outboxId] = await seedOutbox(session, randomUUID(), 1);
          // Moved into o's organisation through its event.
          await session.query(
            `update public.domain_events set organization_id = $1 where id = (select event_id from public.outbox where id = $2)`,
            [o.organizationId, outboxId],
          );
          await session.query(
            `update public.outbox set state = $2,
               lease_owner = case when $2 = 'leased' then 'x' end,
               lease_expires_at = case when $2 = 'leased' then now() + interval '1 hour' end,
               trigger_run_id = case when $2 = 'accepted' then 'run' end
             where id = $1`,
            [outboxId, state],
          );
          ids.outbox[state] = outboxId as string;
          const dispatch = await session.query<{ id: string }>(
            `insert into public.import_task_dispatches (organization_id, import_run_id, task_kind, task_payload, state, lease_owner, lease_expires_at, trigger_run_id, accepted_at, completed_at)
             values ($1, gen_random_uuid(), 'apply', '{}', $2,
               case when $2 = 'leased' then 'x' end,
               case when $2 = 'leased' then now() + interval '1 hour' end,
               case when $2 = 'accepted' then 'run' end,
               case when $2 = 'accepted' then now() end,
               case when $2 = 'completed' then now() end)
             returning id`,
            [o.organizationId, state],
          );
          ids.import_task_dispatch[state] = dispatch.rows[0]?.id as string;
        }
        for (const status of [
          "pending",
          "delivering",
          "delivered",
          "retry",
          "dead_letter",
          "cancelled",
        ]) {
          const delivery = await session.query<{ id: string }>(
            `insert into public.webhook_deliveries (organization_id, subscription_id, event_id, status) values ($1, $2, gen_random_uuid(), $3) returning id`,
            [o.organizationId, o.subscriptionId, status],
          );
          ids.webhook_delivery[status] = delivery.rows[0]?.id as string;
        }
        for (const status of [
          "pending",
          "delivering",
          "delivered",
          "suppressed",
          "failed",
        ]) {
          const intent = await session.query<{ id: string }>(
            `insert into public.notification_intents (organization_id, channel, recipient_ref, template, dedupe_key, view_model, status, lease_owner, lease_expires_at, next_attempt_at)
             values ($1, 'email', 'x@example.test', 'seed', 'wrs-' || gen_random_uuid(), '{}', $2,
               case when $2 = 'delivering' then 'x' end,
               case when $2 = 'delivering' then now() + interval '1 hour' end,
               case when $2 in ('delivered', 'suppressed') then null else now() end)
             returning id`,
            [o.organizationId, status],
          );
          ids.notification_intent[status] = intent.rows[0]?.id as string;
        }
        for (const status of [
          "pending",
          "delivering",
          "retry",
          "delivered",
          "failed",
        ]) {
          const operation = await session.query<{ id: string }>(
            `insert into public.slack_delivery_operations (installation_id, operation_key, status, lease_owner, lease_expires_at)
             values ($1, 'wrs-' || gen_random_uuid(), $2,
               case when $2 = 'delivering' then 'x' end,
               case when $2 = 'delivering' then now() + interval '1 hour' end)
             returning id`,
            [o.installationId, status],
          );
          ids.slack_delivery_operation[status] = operation.rows[0]
            ?.id as string;
        }
      });
      const inFlight: Record<string, string[]> = {
        outbox: ["leased", "accepted"],
        import_task_dispatch: ["leased", "accepted"],
        webhook_delivery: ["pending", "delivering", "retry"],
        notification_intent: ["pending", "delivering", "failed"],
        slack_delivery_operation: ["pending", "delivering", "retry"],
      };
      const resolve = async (kind: string | null, id: string | null) => {
        const { rows } = await session.query<{
          organization_id: string | null;
        }>(
          "select requestport_private.resolve_job_organization($1, $2) as organization_id",
          [kind, id],
        );
        return rows[0]?.organization_id ?? null;
      };
      await as(session, PROCESSOR, async () => {
        for (const [kind, byState] of Object.entries(ids)) {
          for (const [state, id] of Object.entries(byState)) {
            expect(await resolve(kind, id), `${kind} ${state}`).toBe(
              inFlight[kind]?.includes(state) ? o.organizationId : null,
            );
            // Another kind than the id's is NULL, never another row.
            const other = kind === "outbox" ? "webhook_delivery" : "outbox";
            expect(await resolve(other, id), `${kind} as ${other}`).toBeNull();
          }
        }
        const leased = ids.outbox.leased as string;
        for (const kind of ["OUTBOX", "outbox ", "unknown", "", null]) {
          expect(await resolve(kind, leased), `kind ${kind}`).toBeNull();
        }
        for (const kind of Object.keys(ids)) {
          expect(
            await resolve(kind, randomUUID()),
            `absent ${kind}`,
          ).toBeNull();
          expect(await resolve(kind, null), `null ${kind}`).toBeNull();
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Maintenance (Done when 10) and the application group (Done when 9)
// ---------------------------------------------------------------------------

/** One row of each retention category, expiring `at`. */
const retentionSeeds: Record<
  RetentionCategory,
  {
    table: string;
    insert: (
      at: string,
      tag: string,
      organizationId?: string,
    ) => [string, unknown[]];
  }
> = {
  verification: {
    table: "verification",
    insert: (at, tag) => [
      `insert into public.verification (id, identifier, value, expires_at) values ($1, $1, 'v', ${at}) returning id::text`,
      [`wrs-v-${tag}`],
    ],
  },
  session: {
    table: "session",
    insert: (at, tag) => [
      `insert into public.session (id, expires_at, token, updated_at, user_id) values ($1, ${at}, $1, now(), 'wrs') returning id::text`,
      [`wrs-s-${tag}`],
    ],
  },
  oauth_access_token: {
    table: "oauth_access_token",
    insert: (at, tag) => [
      `insert into public.oauth_access_token (id, client_id, scopes, expires_at) values ($1, 'wrs', '{}', ${at}) returning id::text`,
      [`wrs-a-${tag}`],
    ],
  },
  oauth_refresh_token: {
    table: "oauth_refresh_token",
    insert: (at, tag) => [
      `insert into public.oauth_refresh_token (id, token, client_id, user_id, scopes, expires_at) values ($1, $1, 'wrs', 'wrs', '{}', ${at}) returning id::text`,
      [`wrs-r-${tag}`],
    ],
  },
  command_receipt: {
    table: "command_receipts",
    insert: (at, tag) => [
      `insert into public.command_receipts (actor_fingerprint, command_name, idempotency_fingerprint, normalized_input_hash, result_json, expires_at)
       values ($1, 'wrs', $1, 'h', '{}', ${at}) returning id::text`,
      [`wrs-c-${tag}`],
    ],
  },
  slack_oauth_state: {
    table: "slack_oauth_states",
    insert: (at, tag, organizationId) => [
      `insert into public.slack_oauth_states (organization_id, user_id, state_hash, redirect_uri, expires_at) values ($1, 'wrs', $2, 'https://example.test', ${at}) returning id::text`,
      [organizationId, `wrs-o-${tag}`],
    ],
  },
  slack_action_token: {
    table: "slack_action_tokens",
    insert: (at, tag, organizationId) => [
      `insert into public.slack_action_tokens (organization_id, question_id, installation_id, token_type, token_hash, expires_at) values ($1, gen_random_uuid(), gen_random_uuid(), 'answer', $2, ${at}) returning id::text`,
      [organizationId, `wrs-t-${tag}`],
    ],
  },
  provider_callback_receipt: {
    table: "provider_callback_receipts",
    insert: (at, tag) => [
      `insert into public.provider_callback_receipts (provider, provider_event_id, body_sha256, received_at) values ('wrs', $1, $2, ${at}) returning id::text`,
      [`wrs-p-${tag}`, "b".repeat(64)],
    ],
  },
  rate_limit_bucket: {
    table: "rate_limit_buckets",
    insert: (at, tag) => [
      `insert into public.rate_limit_buckets (environment, endpoint_class, principal_fingerprint, window_started_at, expires_at) values ('wrs', 'wrs', $1, now(), ${at}) returning id::text`,
      [`wrs-b-${tag}`],
    ],
  },
};

describe.sequential("the maintenance functions (Done when 10)", () => {
  test("the metrics snapshot and the outbox backlog equal the owner's own counts", async () => {
    await inRolledBackTransaction(async (session) => {
      const organization = await seedOrganization(session);
      await seedDue(session, organization, 2);
      await seedOutbox(session, organization.organizationId, 3);
      await seeding(session, async () => {
        await session.query(
          `insert into public.webhook_deliveries (organization_id, subscription_id, event_id, status) values ($1, $2, gen_random_uuid(), 'dead_letter')`,
          [organization.organizationId, organization.subscriptionId],
        );
        await session.query(
          `insert into public.import_conflicts (import_run_id, entry_id, kind, severity, details, organization_id) values (gen_random_uuid(), gen_random_uuid(), 'duplicate', 'blocking', '{}', $1)`,
          [organization.organizationId],
        );
        await session.query(
          `insert into public.import_task_dispatches (organization_id, import_run_id, task_kind, task_payload, state) values ($1, gen_random_uuid(), 'apply', '{}', 'dead_letter')`,
          [organization.organizationId],
        );
      });

      const snapshot = await as(session, MAINTENANCE, async () => {
        const { rows } = await session.query<Record<string, string>>(
          "select * from requestport_private.operational_metrics_snapshot()",
        );
        return rows[0] as Record<string, string>;
      });
      const backlog = await as(session, MAINTENANCE, async () => {
        const { rows } = await session.query<{
          pending_count: number;
          oldest_age_seconds: number;
        }>("select * from requestport_private.outbox_pending_backlog()");
        return rows[0];
      });
      const owners = await createOperationalMetricsRepository(
        session.db,
      ).snapshot();
      const ownersBacklog = await createOutboxRepository(
        session.db,
      ).pendingBacklog();

      expect({
        pendingOutbox: Number(snapshot.pending_outbox),
        deadLetterWebhooks: Number(snapshot.dead_letter_webhooks),
        notificationBacklog: Number(snapshot.notification_backlog),
        staleSessions: Number(snapshot.stale_sessions),
        openImportConflicts: Number(snapshot.open_import_conflicts),
        slackOperationBacklog: Number(snapshot.slack_operation_backlog),
        deadLetterImportDispatches: Number(
          snapshot.dead_letter_import_dispatches,
        ),
      }).toEqual({
        pendingOutbox: owners.pendingOutbox,
        deadLetterWebhooks: owners.deadLetterWebhooks,
        notificationBacklog: owners.notificationBacklog,
        staleSessions: owners.staleSessions,
        openImportConflicts: owners.openImportConflicts,
        slackOperationBacklog: owners.slackOperationBacklog,
        deadLetterImportDispatches: owners.deadLetterImportDispatches,
      });
      for (const count of [
        owners.pendingOutbox,
        owners.deadLetterWebhooks,
        owners.notificationBacklog,
        owners.staleSessions,
        owners.openImportConflicts,
        owners.slackOperationBacklog,
        owners.deadLetterImportDispatches,
      ]) {
        expect(count).toBeGreaterThan(0);
      }
      // Each read its own clock a moment apart.
      expect(
        Math.abs(
          Number(snapshot.oldest_outbox_seconds) - owners.oldestOutboxSeconds,
        ),
      ).toBeLessThanOrEqual(1);
      expect(backlog?.pending_count).toBe(ownersBacklog.count);
      expect(
        Math.abs(
          (backlog?.oldest_age_seconds ?? 0) - ownersBacklog.oldestAgeSeconds,
        ),
      ).toBeLessThanOrEqual(1);
    }, "REPEATABLE READ");
  });

  test.each([...retentionCategories])(
    "retention deletes %s's expired rows, keeps what is newer than its cutoff or held, and writes its tombstone",
    async (category) => {
      await inRolledBackTransaction(async (session) => {
        const seed = retentionSeeds[category];
        const held = await seedOrganization(session);
        const free = await seedOrganization(session);
        const ids = await seeding(session, async () => {
          await session.query(
            `insert into public.retention_holds (organization_id, category, reason, created_by_user_id) values ($1, 'all', 'held', 'wrs')`,
            [held.organizationId],
          );
          const { rows: age } = await session.query<{ age_ms: string }>(
            "select age_ms from requestport_private.retention_ages where category = $1",
            [category],
          );
          const ageMs = Number(age[0]?.age_ms);
          const insert = async (at: string, organizationId: string) => {
            const [text, values] = seed.insert(
              at,
              randomUUID().slice(0, 12),
              organizationId,
            );
            const { rows } = await session.query<{ id: string }>(text, values);
            return rows[0]?.id as string;
          };
          return {
            expired: await insert(
              "timestamptz '2000-01-01'",
              free.organizationId,
            ),
            // Newer than the cutoff by an hour: in the future where the age is 0.
            fresh: await insert(
              `clock_timestamp() - ${ageMs} * interval '1 millisecond' + interval '1 hour'`,
              free.organizationId,
            ),
            held: await insert("timestamptz '2000-01-01'", held.organizationId),
          };
        });
        const idsNow = async () => {
          const { rows } = await session.query<{ id: string }>(
            `select id::text as id from public.${seed.table}`,
          );
          return new Set(rows.map((row) => row.id));
        };
        const before = await idsNow();
        const called = await databaseNow(session);
        const result = await as(session, MAINTENANCE, async () => {
          const { rows } = await session.query<{
            category: string;
            deleted: number;
            tombstone_id: string;
          }>("select * from requestport_private.retention_cleanup($1, 500)", [
            category,
          ]);
          return rows[0];
        });
        const after = await idsNow();
        const deleted = [...before].filter((id) => !after.has(id)).sort();

        expect(after.has(ids.expired)).toBe(false);
        expect(after.has(ids.fresh)).toBe(true);
        const holdable =
          category === "slack_oauth_state" || category === "slack_action_token";
        // A hold keeps the Slack categories; the others take no hold.
        expect(after.has(ids.held)).toBe(holdable);
        expect(result?.category).toBe(category);
        expect(result?.deleted).toBe(deleted.length);

        const { rows } = await session.query<{
          category: string;
          organization_id: string | null;
          deleted_count: number;
          selected_ids_sha256: string;
          metadata: Record<string, unknown>;
          cutoff_at: Date;
        }>(
          "select category, organization_id, deleted_count, selected_ids_sha256, metadata, cutoff_at from public.retention_tombstones where id = $1",
          [result?.tombstone_id],
        );
        expect(rows[0]).toMatchObject({
          category,
          organization_id: null,
          deleted_count: deleted.length,
          selected_ids_sha256: createHash("sha256")
            .update(canonicalJson(deleted))
            .digest("hex"),
          metadata: { batchSize: 500 },
        });
        const expectedCutoff = retentionCutoff(category, called).getTime();
        expect(
          Math.abs((rows[0]?.cutoff_at.getTime() ?? 0) - expectedCutoff),
        ).toBeLessThan(5_000);
      });
    },
  );

  test("retention clamps its batch, and refuses an unknown category with 22023", async () => {
    await inRolledBackTransaction(async (session) => {
      await seeding(session, () =>
        session.query(
          `insert into public.rate_limit_buckets (environment, endpoint_class, principal_fingerprint, window_started_at, expires_at)
           select 'wrs', 'wrs', 'wrs-' || gen_random_uuid(), now(), timestamptz '2000-01-01' + g * interval '1 millisecond'
           from generate_series(1, 1001) g`,
        ),
      );
      await as(session, MAINTENANCE, async () => {
        for (const [batch, expected] of [
          [null, 500],
          [0, 1],
          [-1, 1],
          [2_147_483_647, 1_000],
        ] as const) {
          const deleted = await undone(session, async () => {
            const { rows } = await session.query<{ deleted: number }>(
              "select * from requestport_private.retention_cleanup('rate_limit_bucket', $1)",
              [batch],
            );
            return rows[0]?.deleted;
          });
          expect(deleted, `batch ${batch}`).toBe(expected);
        }
        for (const category of [
          "unknown",
          "VERIFICATION",
          "",
          "rate_limit_bucket ",
          null,
        ]) {
          const refused = await failure(
            session,
            "select * from requestport_private.retention_cleanup($1, 1)",
            [category],
          );
          expect(refused.code, `category ${category}`).toBe("22023");
        }
      });
    });
  });
});

describe.sequential("the application group (Done when 9)", () => {
  test("is refused every one of the seventeen with 42501", async () => {
    await inRolledBackTransaction(async (session) => {
      await as(session, APPLICATION, async () => {
        for (const fn of FUNCTIONS) {
          const refused = await failure(session, fn.call);
          expect(refused.code, fn.name).toBe("42501");
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 0021: the live-credential locks (the driver's ruling of 2026-09-30)
// ---------------------------------------------------------------------------

/** Better Auth rows for 0021's cases, each liveness case once. */
async function seedCredentials(q: Querier) {
  const tag = randomUUID().slice(0, 8);
  const keys = {
    live: `wrs-k-live-${tag}`,
    disabled: `wrs-k-disabled-${tag}`,
    expired: `wrs-k-expired-${tag}`,
    noExpiry: `wrs-k-noexpiry-${tag}`,
    revoked: `wrs-k-revoked-${tag}`,
  };
  const clients = {
    live: `wrs-c-live-${tag}`,
    disabled: `wrs-c-disabled-${tag}`,
    nullDisabled: `wrs-c-nulldisabled-${tag}`,
  };
  await seeding(q, async () => {
    for (const [id, enabled, expiresAt] of [
      [keys.live, true, "now() + interval '1 day'"],
      [keys.disabled, false, "now() + interval '1 day'"],
      [keys.expired, true, "clock_timestamp() - interval '1 second'"],
      [keys.noExpiry, true, "null"],
      [keys.revoked, true, "now() + interval '1 day'"],
    ] as const) {
      await q.query(
        `insert into public.apikey (id, reference_id, key, enabled, expires_at, created_at, updated_at)
         values ($1, 'wrs', $1, $2, ${expiresAt}, now(), now())`,
        [id, enabled],
      );
    }
    for (const [clientId, disabled] of [
      [clients.live, false],
      [clients.disabled, true],
      [clients.nullDisabled, null],
    ] as const) {
      await q.query(
        `insert into public.oauth_client (id, client_id, redirect_uris, disabled)
         values ($1, $1, '{}', $2)`,
        [clientId, disabled],
      );
    }
  });
  // Revoked the way an agent credential's revocation revokes its key
  // (agent-auth-repository.ts: `enabled: false`), after the seed.
  await q.query(
    "update public.apikey set enabled = false, updated_at = now() where id = $1",
    [keys.revoked],
  );
  return { keys, clients };
}

describe.sequential("the live-credential locks, 0021 (the driver's ruling of 2026-09-30)", () => {
  test.each([PROCESSOR, APPLICATION] as const)(
    "as %s: a live key and a live client answer true; a disabled, expired, unexpiring, revoked or absent one answers false",
    async (role) => {
      await inRolledBackTransaction(async (session) => {
        const { keys, clients } = await seedCredentials(session);
        await as(session, role, async () => {
          const key = async (id: string | null) =>
            (
              await session.query<{ live: boolean }>(
                "select requestport_private.lock_live_api_key($1) as live",
                [id],
              )
            ).rows[0]?.live;
          const client = async (id: string | null) =>
            (
              await session.query<{ live: boolean }>(
                "select requestport_private.lock_live_oauth_client($1) as live",
                [id],
              )
            ).rows[0]?.live;

          expect(await key(keys.live)).toBe(true);
          for (const [what, id] of [
            ["disabled", keys.disabled],
            ["expired", keys.expired],
            ["no expiry", keys.noExpiry],
            ["revoked", keys.revoked],
            ["absent", `wrs-k-absent-${randomUUID()}`],
            ["null", null],
          ] as const) {
            expect(await key(id), `key ${what}`).toBe(false);
          }
          expect(await client(clients.live)).toBe(true);
          for (const [what, id] of [
            ["disabled", clients.disabled],
            ["disabled null", clients.nullDisabled],
            ["absent", `wrs-c-absent-${randomUUID()}`],
            ["null", null],
          ] as const) {
            expect(await client(id), `client ${what}`).toBe(false);
          }
          // Neither reads the other's table: a client id is not a key id.
          expect(await key(clients.live)).toBe(false);
          expect(await client(keys.live)).toBe(false);
        });
      });
    },
  );

  test.each([
    {
      what: "key",
      fn: "lock_live_api_key",
      revoke:
        "update public.apikey set enabled = false, updated_at = now() where id = $1",
    },
    {
      what: "client",
      fn: "lock_live_oauth_client",
      revoke:
        "update public.oauth_client set disabled = true where client_id = $1",
    },
  ])(
    "a concurrent revocation of the $what waits on the processor's share lock until its transaction ends, and the $what then answers false",
    async ({ fn, revoke }) => {
      const owner = await openSession(suiteStorage);
      const revoker = await openSession(suiteStorage);
      const processor = await connectAs(PROCESSOR);
      const q = processor as unknown as Querier;
      let seeded: Awaited<ReturnType<typeof seedCredentials>> | undefined;
      try {
        await owner.query("BEGIN");
        seeded = await seedCredentials(owner);
        await owner.query("COMMIT");
        const id =
          fn === "lock_live_api_key" ? seeded.keys.live : seeded.clients.live;

        await q.query("BEGIN");
        const { rows: pid } = await q.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        );
        const processorPid = (pid[0] as { pid: number }).pid;
        const { rows: first } = await q.query<{ live: boolean }>(
          `select requestport_private.${fn}($1) as live`,
          [id],
        );
        expect(first[0]?.live).toBe(true);

        const { rows: revokerPid } = await revoker.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        );
        await revoker.query("SET lock_timeout = '20s'");
        let settled = false;
        const revocation = revoker.query(revoke, [id]).finally(() => {
          settled = true;
        });

        // The revocation is waiting, and on the processor's transaction.
        let blockers: number[] = [];
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const { rows } = await owner.query<{ blockers: number[] }>(
            "select pg_catalog.pg_blocking_pids($1) as blockers",
            [(revokerPid[0] as { pid: number }).pid],
          );
          blockers = rows[0]?.blockers ?? [];
          if (blockers.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(blockers).toEqual([processorPid]);
        expect(settled).toBe(false);

        await q.query("COMMIT");
        const revoked = await revocation;
        expect(revoked.rowCount).toBe(1);

        const { rows: after } = await q.query<{ live: boolean }>(
          `select requestport_private.${fn}($1) as live`,
          [id],
        );
        expect(after[0]?.live).toBe(false);
      } finally {
        await q.query("ROLLBACK").catch(() => undefined);
        await processor.end().catch(() => undefined);
        await revoker.query("RESET lock_timeout").catch(() => undefined);
        revoker.release();
        if (seeded) {
          await owner.query("ROLLBACK").catch(() => undefined);
          for (const key of Object.values(seeded.keys)) {
            await owner.query("delete from public.apikey where id = $1", [key]);
          }
          for (const client of Object.values(seeded.clients)) {
            await owner.query(
              "delete from public.oauth_client where client_id = $1",
              [client],
            );
          }
        }
        owner.release();
      }
    },
  );
});

/**
 * An agent's import authorization as the processor's login (the design's
 * finding, track-i2.md "I.2b design" §2): the two helpers joined apikey and
 * oauth_client, which §5.1 refuses the processor, so it failed with 42501;
 * 0021's locks are what let it run.
 */
describe.sequential("an agent's import authorization, as the tenant processor's login (0021)", () => {
  const tag = randomUUID().slice(0, 8);
  const graph = {
    organizationId: randomUUID(),
    userId: `wrs-ia-user-${tag}`,
    projectId: randomUUID(),
    principalId: randomUUID(),
    credentialId: randomUUID(),
    grantId: randomUUID(),
    apiKeyId: `wrs-ia-key-${tag}`,
    clientId: `wrs-ia-client-${tag}`,
  };
  let owner: TestSession;
  let seeded = false;

  beforeAll(async () => {
    owner = await openSession(suiteStorage);
    await owner.query("BEGIN");
    try {
      await seeding(owner, async () => {
        for (const [text, values] of [
          [
            `insert into public.organizations (id, name, slug, status) values ($1, $2, $2, 'active')`,
            [graph.organizationId, `wrs-ia-${tag}`],
          ],
          [
            `insert into public."user" (id, name, email) values ($1, 'Import Owner', $2)`,
            [graph.userId, `${graph.userId}@example.test`],
          ],
          [
            `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'owner', 'active')`,
            [graph.organizationId, graph.userId],
          ],
          [
            `insert into public.projects (id, organization_id, name, slug, key_prefix, status) values ($1, $2, 'Import', $3, $4, 'active')`,
            [
              graph.projectId,
              graph.organizationId,
              `wrs-ia-${tag}`,
              `I${tag.slice(0, 4).toUpperCase()}`,
            ],
          ],
          [
            `insert into public.agent_principals (id, organization_id, display_name, slug, created_by_user_id) values ($1, $2, 'Importer', $3, $4)`,
            [
              graph.principalId,
              graph.organizationId,
              `wrs-ia-${tag}`,
              graph.userId,
            ],
          ],
          [
            `insert into public.apikey (id, reference_id, key, enabled, expires_at, created_at, updated_at)
             values ($1, $2, $1, true, now() + interval '1 day', now(), now())`,
            [graph.apiKeyId, graph.userId],
          ],
          [
            `insert into public.agent_credentials (id, organization_id, agent_principal_id, better_auth_api_key_id, name, prefix, fingerprint, audience, project_id, scopes, expires_at, created_by_user_id)
             values ($1, $2, $3, $4, 'key', 'rp_', $5, 'api', $6, '["import:write"]', now() + interval '1 day', $7)`,
            [
              graph.credentialId,
              graph.organizationId,
              graph.principalId,
              graph.apiKeyId,
              `wrs-ia-fp-${tag}`,
              graph.projectId,
              graph.userId,
            ],
          ],
          [
            `insert into public.oauth_client (id, client_id, redirect_uris, disabled) values ($1, $1, '{}', false)`,
            [graph.clientId],
          ],
          [
            `insert into public.agent_oauth_grants (id, organization_id, agent_principal_id, user_id, oauth_client_id, provider_grant_id, refresh_family_id, audience, scopes, expires_at, project_id)
             values ($1, $2, $3, $4, $5, $5, $5, 'mcp', '["import:write"]', now() + interval '1 day', $6)`,
            [
              graph.grantId,
              graph.organizationId,
              graph.principalId,
              graph.userId,
              graph.clientId,
              graph.projectId,
            ],
          ],
        ] as const) {
          await owner.query(text, [...values]);
        }
      });
      await owner.query("COMMIT");
      seeded = true;
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      if (seeded) {
        await owner.query("BEGIN");
        await owner.query("SET LOCAL session_replication_role = replica");
        for (const table of [
          "agent_oauth_grants",
          "agent_credentials",
          "agent_principals",
          "projects",
          "organization_members",
        ]) {
          await owner.query(
            `delete from public.${table} where organization_id = $1`,
            [graph.organizationId],
          );
        }
        await owner.query("delete from public.organizations where id = $1", [
          graph.organizationId,
        ]);
        await owner.query("delete from public.apikey where id = $1", [
          graph.apiKeyId,
        ]);
        await owner.query(
          "delete from public.oauth_client where client_id = $1",
          [graph.clientId],
        );
        await owner.query(`delete from public."user" where id = $1`, [
          graph.userId,
        ]);
        await owner.query("COMMIT");
      }
    } finally {
      owner.release();
    }
  });

  async function asProcessorStorage<T>(
    work: (
      database: Parameters<typeof createImportRepository>[0],
    ) => Promise<T>,
  ): Promise<T> {
    const storage = createTestStorage({
      driver: selectDriver(process.env),
      connectionString: logins[PROCESSOR].url,
    });
    try {
      return await inTenantTransaction(storage.db, graph.organizationId, (tx) =>
        work(tx as unknown as Parameters<typeof createImportRepository>[0]),
      );
    } finally {
      await storage.close();
    }
  }

  test.each([
    { actor: "an API key", delegated: false },
    { actor: "an OAuth grant", delegated: true },
  ])(
    "through $actor, it is authorised while the credential lives, and refused once it is revoked",
    async ({ delegated }) => {
      const input = {
        organizationId: graph.organizationId,
        projectId: graph.projectId,
        agentPrincipalId: graph.principalId,
        authorizationId: delegated ? graph.grantId : graph.credentialId,
        delegatedByUserId: delegated ? graph.userId : null,
      };
      const granted = await asProcessorStorage((database) =>
        createImportRepository(database).requireAgentAccess(input),
      );
      expect(granted).toEqual({ laneIds: [], scopes: ["import:write"] });

      // The Better Auth row is what 0021's lock answers for: revoked, the
      // same authorization is refused as it is on the application's path.
      const [revoke, restore] = delegated
        ? [
            "update public.oauth_client set disabled = true where client_id = $1",
            "update public.oauth_client set disabled = false where client_id = $1",
          ]
        : [
            "update public.apikey set enabled = false where id = $1",
            "update public.apikey set enabled = true where id = $1",
          ];
      const id = delegated ? graph.clientId : graph.apiKeyId;
      await owner.query(revoke, [id]);
      try {
        await expect(
          asProcessorStorage((database) =>
            createImportRepository(database).requireAgentAccess(input),
          ),
        ).rejects.toMatchObject({ code: "forbidden" });
      } finally {
        await owner.query(restore, [id]);
      }
    },
  );

  /**
   * §2.5.0 item 7 for the two helpers: 0021's functions take a row lock, so
   * handed the pool a helper opens exactly one transaction of its own and
   * sends every statement, the lock included, inside it. The handle below is
   * this suite's pool with its `transaction` counted, its own `select` and
   * `execute` recorded as uses outside a transaction, and each transaction's
   * `execute` recorded.
   */
  function recordingPool() {
    const outside: string[] = [];
    const inside: string[] = [];
    let transactions = 0;
    const pool = new Proxy(suiteStorage.db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return (work: (tx: unknown) => Promise<unknown>) => {
            transactions += 1;
            return target.transaction((tx) =>
              work(
                new Proxy(tx, {
                  get(txTarget, txProperty) {
                    const value = Reflect.get(txTarget, txProperty, txTarget);
                    if (txProperty === "execute")
                      return (query: unknown) => {
                        inside.push(JSON.stringify(query));
                        return value.call(txTarget, query);
                      };
                    return typeof value === "function"
                      ? value.bind(txTarget)
                      : value;
                  },
                }),
              ),
            );
          };
        }
        if (property === "select" || property === "execute")
          outside.push(String(property));
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return {
      pool: pool as Database,
      outside,
      inside,
      transactions: () => transactions,
    };
  }

  test.each([
    {
      helper: "lockActiveApiKeyAuthorization",
      fn: "lock_live_api_key",
      call: (database: Database) =>
        lockActiveApiKeyAuthorization(database, {
          organizationId: graph.organizationId,
          agentPrincipalId: graph.principalId,
          authorizationId: graph.credentialId,
          projectId: graph.projectId,
        }),
    },
    {
      helper: "lockActiveOAuthAuthorization",
      fn: "lock_live_oauth_client",
      call: (database: Database) =>
        lockActiveOAuthAuthorization(database, {
          organizationId: graph.organizationId,
          agentPrincipalId: graph.principalId,
          authorizationId: graph.grantId,
          delegatedByUserId: graph.userId,
          projectId: graph.projectId,
        }),
    },
  ])(
    "$helper, handed the pool, opens one transaction and calls $fn inside it (§2.5.0 item 7)",
    async ({ fn, call }) => {
      const recording = recordingPool();
      const authorization = await call(recording.pool);

      expect(authorization).not.toBeNull();
      expect(recording.transactions()).toBe(1);
      expect(recording.outside).toEqual([]);
      expect(
        recording.inside.filter((query) =>
          query.includes(`requestport_private.${fn}(`),
        ),
      ).toHaveLength(1);
    },
  );
});

describe.sequential("two dispatcher sessions claiming at once never share a row (Done when 9)", () => {
  test("the second skips what the first holds", async () => {
    const owner = await openSession(suiteStorage);
    const organizationId = randomUUID();
    const first = await connectAs(DISPATCHER);
    const second = await connectAs(DISPATCHER);
    try {
      await owner.query("BEGIN");
      const mine = await seedOutbox(owner, organizationId, 6, "1980-01-01");
      await owner.query("COMMIT");

      const q1 = first as unknown as Querier;
      const q2 = second as unknown as Querier;
      await q1.query("BEGIN");
      await q2.query("BEGIN");
      const one = await q1.query<{ outbox_id: string }>(
        "select outbox_id from requestport_private.claim_outbox_batch(4, 60)",
      );
      const two = await q2.query<{ outbox_id: string }>(
        "select outbox_id from requestport_private.claim_outbox_batch(4, 60)",
      );
      const a = one.rows.map((row) => row.outbox_id);
      const b = two.rows.map((row) => row.outbox_id);
      expect(a.filter((id) => b.includes(id))).toEqual([]);
      expect(a.sort()).toEqual(mine.slice(0, 4).sort());
      expect(b.filter((id) => mine.includes(id)).sort()).toEqual(
        mine.slice(4).sort(),
      );
      await q1.query("ROLLBACK");
      await q2.query("ROLLBACK");
    } finally {
      await first.end().catch(() => undefined);
      await second.end().catch(() => undefined);
      await owner.query("ROLLBACK").catch(() => undefined);
      await owner.query("BEGIN");
      await owner.query("SET LOCAL session_replication_role = replica");
      await owner.query(
        "delete from public.outbox o using public.domain_events d where d.id = o.event_id and d.organization_id = $1",
        [organizationId],
      );
      await owner.query(
        "delete from public.domain_events where organization_id = $1",
        [organizationId],
      );
      await owner.query("COMMIT");
      owner.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Temporary objects cannot steer a body (Done when 6; ruling 41)
// ---------------------------------------------------------------------------

/** Names every body reads, made as temporary tables with a row each. */
const SHADOWED = [
  "organizations",
  "organization_members",
  "user",
  "outbox",
  "invitations",
  "domain_events",
  "import_task_dispatches",
  "notification_intents",
  "webhook_deliveries",
  "webhook_subscriptions",
  "webhook_attempts",
  "slack_delivery_operations",
  "slack_installations",
  "work_sessions",
  "questions",
  "requests",
  "projects",
  "import_conflicts",
  "retention_holds",
  "retention_tombstones",
  "retention_ages",
  "rate_limit_buckets",
  // 0021's two read these.
  "apikey",
  "oauth_client",
];

async function shadow(session: TestSession) {
  for (const name of SHADOWED) {
    await session.query(
      `create temporary table "${name}" (id uuid, organization_id uuid, event_id uuid, state text, status text, category text, age_ms bigint, created_at timestamptz, next_attempt_at timestamptz, expires_at timestamptz) on commit drop`,
    );
    await session.query(
      `insert into pg_temp."${name}" values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'pending', 'pending', 'rate_limit_bucket', 0, '1900-01-01', '1900-01-01', '1900-01-01')`,
    );
  }
}

/** Every answer `group`'s functions give on the seeded rows, rolled back after. */
async function answers(
  session: TestSession,
  group: WorkerGroup,
  leased: string,
  credentials: Awaited<ReturnType<typeof seedCredentials>>,
) {
  return undone(session, () =>
    as(session, group, async () => {
      const one = async (text: string, values: unknown[] = []) =>
        (await session.query(text, values)).rows;
      if (group === DISPATCHER) {
        const claims = await one(
          "select outbox_id, organization_id, attempt_count, lease_id from requestport_private.claim_outbox_batch(3, 60)",
        );
        const accepted = await one(
          "select requestport_private.accept_outbox_claim($1, $2, 'run') as accepted",
          [claims[0]?.outbox_id, claims[0]?.lease_id],
        );
        const released = await one(
          "select requestport_private.release_outbox_claim($1, $2, false, 1000) as released",
          [claims[1]?.outbox_id, claims[1]?.lease_id],
        );
        const dispatches = await one(
          "select dispatch_id, organization_id, task_kind, attempt_count, lease_id from requestport_private.claim_import_dispatch_batch(3, 60)",
        );
        const dispatchAccepted = await one(
          "select requestport_private.accept_import_dispatch_claim($1, $2, 'run') as accepted",
          [dispatches[0]?.dispatch_id, dispatches[0]?.lease_id],
        );
        const without = (rows: Record<string, unknown>[]) =>
          rows.map(({ lease_id: _lease, ...rest }) => rest);
        const discovered: Record<string, unknown> = {};
        for (const fn of [
          "due_notification_intents",
          "pending_webhook_deliveries",
          "due_slack_message_updates",
          "due_slack_connection_tests",
          "lease_expired_work_sessions",
          "grace_expired_work_sessions",
          "due_webhook_secret_promotions",
        ]) {
          discovered[fn] = await one(
            `select * from requestport_private.${fn}(5)`,
          );
        }
        discovered.due_question_reminders = await one(
          "select question_id, organization_id from requestport_private.due_question_reminders(5)",
        );
        return {
          claims: without(claims),
          accepted,
          released,
          dispatches: without(dispatches),
          dispatchAccepted,
          discovered,
        };
      }
      if (group === PROCESSOR) {
        const resolved = await one(
          "select requestport_private.resolve_job_organization('outbox', $1) as organization_id",
          [leased],
        );
        // 0021's two, for a live and a dead credential of each kind.
        const locks = await one(
          `select requestport_private.lock_live_api_key($1) as live_key,
                  requestport_private.lock_live_api_key($2) as disabled_key,
                  requestport_private.lock_live_oauth_client($3) as live_client,
                  requestport_private.lock_live_oauth_client($4) as disabled_client`,
          [
            credentials.keys.live,
            credentials.keys.disabled,
            credentials.clients.live,
            credentials.clients.disabled,
          ],
        );
        return { resolved, locks };
      }
      const [snapshot] = await one(
        "select * from requestport_private.operational_metrics_snapshot()",
      );
      const { oldest_outbox_seconds: _clock, ...counts } = snapshot as Record<
        string,
        unknown
      >;
      const [backlog] = await one(
        "select pending_count from requestport_private.outbox_pending_backlog()",
      );
      const [retention] = await one(
        "select category, deleted from requestport_private.retention_cleanup('rate_limit_bucket', 500)",
      );
      return { counts, backlog, retention };
    }),
  );
}

describe.sequential("temporary objects do not steer a body (Done when 6, ruling 41)", () => {
  test.each([...GROUPS])(
    "as %s, every answer is the same with same-named temporary tables in the session",
    async (group) => {
      await inRolledBackTransaction(async (session) => {
        const organization = await seedOrganization(session);
        await seedDue(session, organization, 5);
        const outbox = await seedOutbox(
          session,
          organization.organizationId,
          3,
          "1970-01-01",
        );
        await seedDispatches(session, organization.organizationId, 2);
        await seeding(session, async () => {
          await session.query(
            "update public.outbox set state = 'leased', lease_owner = 'x', lease_expires_at = now() + interval '1 hour' where id = $1",
            [outbox[2]],
          );
          await session.query(
            `insert into public.rate_limit_buckets (environment, endpoint_class, principal_fingerprint, window_started_at, expires_at)
             select 'wrs', 'wrs', 'wrs-' || gen_random_uuid(), now(), timestamptz '2000-01-01' from generate_series(1, 3)`,
          );
        });
        const leased = outbox[2] as string;
        const credentials = await seedCredentials(session);

        const plain = await answers(session, group, leased, credentials);
        await as(session, group, () => shadow(session));
        const shadowed = await answers(session, group, leased, credentials);

        expect(shadowed).toEqual(plain);
        // The shadows were there, and readable to the role that made them.
        const { rows } = await as(session, group, () =>
          session.query<{ n: number }>(
            "select count(*)::int as n from pg_temp.outbox",
          ),
        );
        expect(rows[0]?.n).toBe(1);
        if (group === PROCESSOR) {
          expect(plain).toEqual({
            resolved: [{ organization_id: organization.organizationId }],
            locks: [
              {
                live_key: true,
                disabled_key: false,
                live_client: true,
                disabled_client: false,
              },
            ],
          });
        }
      });
    },
  );
});

// ---------------------------------------------------------------------------
// b2, the packages/db half: the three storages, and the repositories on the
// functions (manifest-i2.md §5.1's signature table; Done when 3, 4 and 10 at
// the method level). The stale-body and early-run cases through the pollers
// and the bodies are part B's.
// ---------------------------------------------------------------------------

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type ClaimedLease = { id: string; leaseId: string };

/*
 * These cases commit their rows and claim through the real functions, which
 * take the oldest eligible rows first. So each seed is older than every
 * earlier one (a row an earlier case left leased becomes eligible again when
 * its lease runs out), and a seed's own rows are the first it returns.
 */
let nextOutboxYear = 1959;
async function seedNewOutbox(
  owner: TestSession,
  organizationId: string,
  n: number,
) {
  const base = `${nextOutboxYear}-01-01`;
  nextOutboxYear -= 1;
  return (await seedOutbox(owner, organizationId, n, base)).slice(0, n);
}
async function seedNewDispatches(
  owner: TestSession,
  organizationId: string,
  n: number,
) {
  return (await seedDispatches(owner, organizationId, n)).slice(0, n);
}

/**
 * `env` as a worker's environment is since I.2b's b6: every owner-capable
 * name in it removed (`ownerCapableVariableNames`; `DATABASE_URL`, which
 * names the owner here, among them), which each worker storage's guard
 * otherwise refuses at its first use (ruling 217 item 1).
 */
function withoutOwnerCapableNames(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const name of ownerCapableVariableNames(kept)) delete kept[name];
  return kept;
}

/** This process's environment, as a worker's, with the three set to this file's logins. */
function workerEnv(): NodeJS.ProcessEnv {
  return {
    ...withoutOwnerCapableNames(process.env),
    [WORKER_DATABASE_URL_VARIABLES.dispatcher]: logins[DISPATCHER].url,
    [WORKER_DATABASE_URL_VARIABLES.processor]: logins[PROCESSOR].url,
    [WORKER_DATABASE_URL_VARIABLES.maintenance]: logins[MAINTENANCE].url,
  };
}

function unsetWorkerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.values(WORKER_DATABASE_URL_VARIABLES)) {
    delete env[name];
  }
  return env;
}

/** Runs `work`'s seeds on the owner's session and commits them. */
async function committed<T>(owner: TestSession, work: () => Promise<T>) {
  await owner.query("BEGIN");
  try {
    const result = await work();
    await owner.query("COMMIT");
    return result;
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }
}

/** Deletes a committed organisation's rows again, as deleteGraph does. */
async function dropOrganization(owner: TestSession, organizationId: string) {
  await deleteGraph(owner, {
    organizationId,
    userId: "wrs-no-such-user",
  } as Graph);
}

async function stateOf(owner: TestSession, table: string, id: string) {
  const { rows } = await owner.query<{
    state: string;
    lease_owner: string | null;
    trigger_run_id: string | null;
  }>(
    `select state, lease_owner, trigger_run_id from public.${table} where id = $1`,
    [id],
  );
  return rows[0];
}

describe.sequential("the worker's three storages, and withTenant on the processor's (b2)", () => {
  test("with the three variables unset and no exception asked for, it refuses, naming the three", () => {
    let message = "";
    try {
      createWorkerStorages(unsetWorkerEnv());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      "RequestPort's worker connects as its three roles",
    );
    for (const name of Object.values(WORKER_DATABASE_URL_VARIABLES)) {
      expect(message).toContain(name);
    }
  });

  test("with the three variables unset, on the test exception, every storage is the handle of the storage the caller gives, and withTenant hands work that handle", async () => {
    const storages = createWorkerStorages(unsetWorkerEnv(), {
      unbound: "test",
      storage: suiteStorage,
    });
    try {
      expect(storages.bound).toBe(false);
      expect(storages.dispatcher).toBe(suiteStorage.db);
      expect(storages.maintenance).toBe(suiteStorage.db);
      let handed: unknown;
      const answer = await storages.withTenant(
        randomUUID(),
        async (database) => {
          handed = database;
          return "done";
        },
      );
      expect(answer).toBe("done");
      expect(handed).toBe(suiteStorage.db);
      await expect(
        storages.withTenant("not-an-organisation", async () => "never"),
      ).rejects.toBeInstanceOf(TenantBindingError);
      // The resolver runs through its function in both modes. Here it runs
      // as DATABASE_URL's role, the local stack's superuser, which still
      // executes it after 0023. A login that is not a superuser, in
      // requestport_definer as the migrating role is, does not (jobs'
      // worker-row-security suite, Done when 12).
      expect(
        await storages.resolveJobOrganization("outbox", randomUUID()),
      ).toBeNull();
    } finally {
      await storages.close();
    }
  });

  test("a partial set of the three variables is refused, by name and never by value", () => {
    for (const missing of Object.values(WORKER_DATABASE_URL_VARIABLES)) {
      const env = workerEnv();
      delete env[missing];
      let message = "";
      try {
        createWorkerStorages(env);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, missing).toContain(missing);
      for (const login of Object.values(logins)) {
        expect(message).not.toContain(new URL(login.url).password);
      }
    }
    const blank = workerEnv();
    blank[WORKER_DATABASE_URL_VARIABLES.processor] = "   ";
    expect(() => createWorkerStorages(blank)).toThrow(
      WORKER_DATABASE_URL_VARIABLES.processor,
    );
    const invalid = workerEnv();
    invalid[WORKER_DATABASE_URL_VARIABLES.maintenance] =
      "https://example.test/db";
    expect(() => createWorkerStorages(invalid)).toThrow(
      "RequestPort database configuration is invalid.",
    );
  });

  test("with the three set, each storage connects as its own login, and withTenant binds a transaction on the processor's", async () => {
    const storages = createWorkerStorages(workerEnv());
    const owner = await openSession(suiteStorage);
    const organization = await committed(owner, () => seedOrganization(owner));
    try {
      expect(storages.bound).toBe(true);
      const who = async (database: Database) =>
        (
          await database.execute<{ name: string }>(
            sql`select current_user as name`,
          )
        ).rows[0]?.name;
      expect(await who(storages.dispatcher)).toBe(logins[DISPATCHER].name);
      expect(await who(storages.maintenance)).toBe(logins[MAINTENANCE].name);

      const inside = await storages.withTenant(
        organization.organizationId,
        async (database) => {
          const { rows } = await database.execute<{
            name: string;
            bound: string;
            projects: number;
          }>(
            sql`select current_user as name,
                  pg_catalog.current_setting('requestport.organization_id', true) as bound,
                  (select count(*)::int from public.projects) as projects`,
          );
          return { transaction: isTransaction(database), ...rows[0] };
        },
      );
      expect(inside).toEqual({
        transaction: true,
        name: logins[PROCESSOR].name,
        bound: organization.organizationId,
        projects: 1,
      });
      await expect(
        storages.withTenant("not-an-organisation", async () => "never"),
      ).rejects.toBeInstanceOf(TenantBindingError);

      // The resolver, on the processor's storage and unbound: an in-flight
      // outbox row's organisation, and NULL for an absent one.
      const [outboxId] = await committed(owner, () =>
        seedNewOutbox(owner, organization.organizationId, 1),
      );
      await owner.query(
        "update public.outbox set state = 'leased', lease_owner = gen_random_uuid()::text, lease_expires_at = now() + interval '1 hour' where id = $1",
        [outboxId],
      );
      expect(
        await storages.resolveJobOrganization("outbox", outboxId as string),
      ).toBe(organization.organizationId);
      expect(
        await storages.resolveJobOrganization("outbox", randomUUID()),
      ).toBeNull();
    } finally {
      await storages.close();
      await dropOrganization(owner, organization.organizationId);
      owner.release();
    }
  });

  /** The guard's refusal in `error`'s chain of causes, or undefined. */
  function guardRefusalIn(error: unknown): DatabaseRoleGuardError | undefined {
    for (let found = error; found instanceof Error; found = found.cause) {
      if (found instanceof DatabaseRoleGuardError) return found;
    }
    return undefined;
  }

  test("each storage's guard judges worker whatever the process declared, and a caller cannot hand it another surface: in this process, declared test, a login the role check refuses is refused on first use (ruling 215 item 4)", async () => {
    expect(declaredDatabaseSurface()).toBe("test");
    // DATABASE_URL's role, the local stack's superuser, in no worker group.
    const superuserUrl = process.env.DATABASE_URL as string;
    const env = {
      ...withoutOwnerCapableNames(process.env),
      [WORKER_DATABASE_URL_VARIABLES.dispatcher]: superuserUrl,
      [WORKER_DATABASE_URL_VARIABLES.processor]: superuserUrl,
      [WORKER_DATABASE_URL_VARIABLES.maintenance]: superuserUrl,
    };
    const lines: string[] = [];
    const plain = createWorkerStorages(env);
    const handed = createWorkerStorages(env, {
      guard: {
        // @ts-expect-error -- the guard's surface is not the caller's to give
        surface: () => "test",
        write: (line: string) => lines.push(line),
      },
    });

    try {
      for (const [name, storages] of [
        ["no guard option", plain],
        ["handed a test surface", handed],
      ] as const) {
        const refusal = await storages.dispatcher
          .execute(sql`select 1`)
          .then(() => undefined, guardRefusalIn);

        expect(refusal, name).toBeInstanceOf(DatabaseRoleGuardError);
        expect(refusal?.finding, name).toMatchObject({
          check: "role",
          status: "refused",
          surface: "worker",
        });
        // A superuser counts as a member of every role, so it is in other
        // groups than its own as well.
        expect(refusal?.finding.objections, name).toEqual(
          expect.arrayContaining(["superuser", `member_of_${MAINTENANCE}`]),
        );
        await expect(storages.roleReports(), name).rejects.toBeDefined();
      }
      // A refusal is thrown, not written.
      expect(lines).toEqual([]);
    } finally {
      await plain.close();
      await handed.close();
    }
  });

  test("used in a process that has declared no surface, each storage is refused by its declaration check, its guard judging no surface until one is declared", async () => {
    const storages = createWorkerStorages(workerEnv());
    resetDatabaseSurfaceDeclaration();
    try {
      const refusal = await storages.dispatcher
        .execute(sql`select 1`)
        .then(() => undefined, guardRefusalIn);

      expect(refusal).toBeInstanceOf(DatabaseRoleGuardError);
      expect(refusal?.message).toBe(UNDECLARED_SURFACE_MESSAGE);
      expect(refusal?.finding).toMatchObject({
        check: "declaration",
        status: "refused",
        surface: undefined,
        objections: ["undeclared"],
      });
    } finally {
      resetDatabaseSurfaceDeclaration("test");
      await storages.close();
    }
  });
});

describe("every writing function is called inside a transaction on its storage (§2.5.0 item 7, b2)", () => {
  /**
   * A handle whose own execute refuses, and whose transactions record what
   * ran in them: a writing function sent on the pool would be a read the
   * read retry could send twice.
   */
  function recordingDatabase() {
    const inTransaction: string[] = [];
    const tx = {
      execute: async (query: unknown) => {
        inTransaction.push(JSON.stringify(query));
        // One row every caller here can read, whatever its columns.
        return { rows: [{ category: "rate_limit_bucket", deleted: 0 }] };
      },
    };
    const database = {
      execute: async () => {
        throw new Error("a writing function was called outside a transaction");
      },
      transaction: async (work: (handle: typeof tx) => Promise<unknown>) =>
        work(tx),
    } as unknown as Database;
    return { database, inTransaction };
  }

  test.each([
    [
      "claim_outbox_batch",
      (database: Database) =>
        createOutboxRepository(database).claimBatch(1, 60),
    ],
    [
      "accept_outbox_claim",
      (database: Database) =>
        createOutboxRepository(database).acceptClaim(
          randomUUID(),
          randomUUID(),
          "run",
        ),
    ],
    [
      "release_outbox_claim",
      (database: Database) =>
        createOutboxRepository(database).releaseClaim(
          randomUUID(),
          randomUUID(),
          false,
          1_000,
        ),
    ],
    [
      "claim_import_dispatch_batch",
      (database: Database) =>
        createImportTaskDispatchRepository(database).claimBatch(1, 600),
    ],
    [
      "accept_import_dispatch_claim",
      (database: Database) =>
        createImportTaskDispatchRepository(database).acceptClaim(
          randomUUID(),
          randomUUID(),
          "run",
        ),
    ],
    [
      "retention_cleanup",
      (database: Database) =>
        createRetentionRepository(database).cleanup({
          category: "rate_limit_bucket",
          batchSize: 1,
        }),
    ],
  ] as const)("%s", async (fn, call) => {
    const { database, inTransaction } = recordingDatabase();
    await call(database);
    expect(inTransaction).toHaveLength(1);
    expect(inTransaction[0]).toContain(`requestport_private.${fn}(`);
  });
});

describe.sequential("leases through the repositories, as the dispatcher's login (Done when 3, b2)", () => {
  let owner: TestSession;
  let storages: WorkerStorages;
  let organization: Organization;

  beforeAll(async () => {
    owner = await openSession(suiteStorage);
    organization = await committed(owner, () => seedOrganization(owner));
    storages = createWorkerStorages(workerEnv());
  });

  afterAll(async () => {
    await storages?.close();
    if (owner) {
      if (organization)
        await dropOrganization(owner, organization.organizationId);
      owner.release();
    }
  });

  const kinds = [
    {
      kind: "outbox",
      table: "outbox",
      seed: (n: number) => seedNewOutbox(owner, organization.organizationId, n),
      repository: () => createOutboxRepository(storages.dispatcher),
      // A re-claim takes the oldest first: the outbox orders by created_at,
      // which the seed put first; a dispatch by updated_at, which the claim
      // moved, so the fixture moves it back with the expiry.
      expire: "lease_expires_at = clock_timestamp() - interval '1 second'",
    },
    {
      kind: "import dispatch",
      table: "import_task_dispatches",
      seed: (n: number) =>
        seedNewDispatches(owner, organization.organizationId, n),
      repository: () => createImportTaskDispatchRepository(storages.dispatcher),
      expire:
        "lease_expires_at = clock_timestamp() - interval '1 second', updated_at = timestamptz '1960-01-01'",
    },
  ] as const;

  test.each(kinds)(
    "$kind: the claim's lease is the database's; a wrong, another claim's or an expired lease accepts nothing; the right one accepts",
    async ({ table, seed, repository, expire }) => {
      const [first, second] = await committed(owner, () => seed(2));
      const before = await databaseNow(owner);
      const [claimed] = await repository().claimBatch(1);
      const after = await databaseNow(owner);
      const [other] = await repository().claimBatch(1);
      if (!claimed || !other)
        throw new Error("the seeded rows were not claimed");
      expect(claimed.id).toBe(first);
      expect(other.id).toBe(second);
      expect(claimed.organizationId).toBe(organization.organizationId);
      expect(claimed.leaseId).toMatch(UUID_V4);
      expect(claimed.leaseId).not.toBe(other.leaseId);
      // The lease is the clock at the claim plus 60 s, between the reads
      // just before and just after it (X23).
      const expires = claimed.leaseExpiresAt.getTime();
      expect(expires).toBeGreaterThanOrEqual(before.getTime() + 60_000);
      expect(expires).toBeLessThanOrEqual(after.getTime() + 60_000);
      expect((await stateOf(owner, table, claimed.id))?.lease_owner).toBe(
        claimed.leaseId,
      );

      const unchanged = async () =>
        expect(await stateOf(owner, table, claimed.id)).toEqual({
          state: "leased",
          lease_owner: claimed.leaseId,
          trigger_run_id: null,
        });

      for (const lease of [randomUUID(), other.leaseId, "not-a-lease"]) {
        expect(
          await repository().acceptClaim(claimed.id, lease, "run-wrong"),
          `lease ${lease}`,
        ).toBe(false);
      }
      if (table === "outbox") {
        const outbox = createOutboxRepository(storages.dispatcher);
        for (const deadLetter of [false, true]) {
          expect(
            await outbox.releaseClaim(
              claimed.id,
              other.leaseId,
              deadLetter,
              1_000,
            ),
          ).toBe(false);
        }
      }
      await unchanged();

      // The suite's privileged fixture: the owner moves the expiry.
      await owner.query(`update public.${table} set ${expire} where id = $1`, [
        claimed.id,
      ]);
      expect(
        await repository().acceptClaim(claimed.id, claimed.leaseId, "run-late"),
      ).toBe(false);
      if (table === "outbox") {
        const outbox = createOutboxRepository(storages.dispatcher);
        for (const deadLetter of [false, true]) {
          expect(
            await outbox.releaseClaim(
              claimed.id,
              claimed.leaseId,
              deadLetter,
              1_000,
            ),
          ).toBe(false);
        }
      }
      await unchanged();

      const [again] = await repository().claimBatch(1);
      expect(again?.id).toBe(claimed.id);
      expect(again?.leaseId).not.toBe(claimed.leaseId);
      expect(
        await repository().acceptClaim(
          claimed.id,
          again?.leaseId as string,
          "run-1",
        ),
      ).toBe(true);
      expect(await stateOf(owner, table, claimed.id)).toEqual({
        state: "accepted",
        lease_owner: null,
        trigger_run_id: "run-1",
      });
    },
  );

  test("outbox: a release under its live lease retries after the delay, or dead-letters", async () => {
    const ids = await committed(owner, () =>
      seedNewOutbox(owner, organization.organizationId, 2),
    );
    const outbox = createOutboxRepository(storages.dispatcher);
    const [retried] = await outbox.claimBatch(1);
    const [dead] = await outbox.claimBatch(1);
    expect([retried?.id, dead?.id]).toEqual(ids);
    const before = await databaseNow(owner);
    expect(
      await outbox.releaseClaim(
        retried?.id as string,
        retried?.leaseId as string,
        false,
        5_000,
      ),
    ).toBe(true);
    const after = await databaseNow(owner);
    expect(
      await outbox.releaseClaim(
        dead?.id as string,
        dead?.leaseId as string,
        true,
        0,
      ),
    ).toBe(true);
    const { rows } = await owner.query<{
      id: string;
      state: string;
      next_attempt_at: Date;
      lease_owner: string | null;
    }>(
      "select id, state, next_attempt_at, lease_owner from public.outbox where id = any($1)",
      [ids],
    );
    const pending = rows.find((row) => row.id === retried?.id);
    expect(pending?.state).toBe("pending");
    expect(pending?.lease_owner).toBeNull();
    // The clock at the release plus 5 s, between the reads just before and
    // just after it (X23).
    const at = pending?.next_attempt_at.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before.getTime() + 5_000);
    expect(at).toBeLessThanOrEqual(after.getTime() + 5_000);
    expect(rows.find((row) => row.id === dead?.id)?.state).toBe("dead_letter");
  });

  test("markAccepted by id, the web's and outbox-dispatcher's path, accepts only under an unexpired lease", async () => {
    const [outboxId] = await committed(owner, () =>
      seedNewOutbox(owner, organization.organizationId, 1),
    );
    const [dispatchId] = await committed(owner, () =>
      seedNewDispatches(owner, organization.organizationId, 1),
    );
    const outbox = createOutboxRepository(owner.db);
    const dispatches = createImportTaskDispatchRepository(owner.db);
    // claimOne and markAccepted by id are the application's and the bound
    // processor's; here the owner's session runs them, as production does
    // until b3, which the lease clause applies to alike.
    for (const [repository, id, table] of [
      [outbox, outboxId as string, "outbox"],
      [dispatches, dispatchId as string, "import_task_dispatches"],
    ] as const) {
      const claimed = await repository.claimOne(id, "web:wrs");
      expect(claimed?.organizationId, table).toBe(organization.organizationId);
      await owner.query(
        `update public.${table} set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
        [id],
      );
      expect(
        await repository.markAccepted(id, "web:wrs", "run-late"),
        table,
      ).toBe(false);
      expect((await stateOf(owner, table, id))?.state, table).toBe("leased");
      await owner.query(
        `update public.${table} set lease_expires_at = clock_timestamp() + interval '1 minute' where id = $1`,
        [id],
      );
      expect(
        await repository.markAccepted(id, "web:other", "run-other"),
        table,
      ).toBe(false);
      expect(await repository.markAccepted(id, "web:wrs", "run-1"), table).toBe(
        true,
      );
      expect(await stateOf(owner, table, id), table).toEqual({
        state: "accepted",
        lease_owner: null,
        trigger_run_id: "run-1",
      });
    }
  });
});

describe.sequential("settlement through the repositories, as the tenant processor's login bound to the row's organisation (Done when 4, b2)", () => {
  let owner: TestSession;
  let storages: WorkerStorages;
  let a: Organization;
  let b: Organization;

  beforeAll(async () => {
    owner = await openSession(suiteStorage);
    a = await committed(owner, () => seedOrganization(owner));
    b = await committed(owner, () => seedOrganization(owner));
    storages = createWorkerStorages(workerEnv());
  });

  afterAll(async () => {
    await storages?.close();
    if (owner) {
      for (const organization of [a, b]) {
        if (organization)
          await dropOrganization(owner, organization.organizationId);
      }
      owner.release();
    }
  });

  const lease = (row: { leaseId: string }): ClaimSettlement => ({
    kind: "lease",
    leaseId: row.leaseId,
  });
  const run = (runId: string): ClaimSettlement => ({
    kind: "trigger_run",
    runId,
  });
  const outboxIn = <T>(
    organizationId: string,
    work: (repository: ReturnType<typeof createOutboxRepository>) => Promise<T>,
  ) =>
    storages.withTenant(organizationId, (database) =>
      work(createOutboxRepository(database as Database)),
    );
  const dispatchesIn = <T>(
    organizationId: string,
    work: (
      repository: ReturnType<typeof createImportTaskDispatchRepository>,
    ) => Promise<T>,
  ) =>
    storages.withTenant(organizationId, (database) =>
      work(createImportTaskDispatchRepository(database as Database)),
    );

  test("outbox: a lease settlement completes or dead-letters only under its own unexpired lease", async () => {
    const ids = await committed(owner, () =>
      seedNewOutbox(owner, a.organizationId, 3),
    );
    const dispatcher = createOutboxRepository(storages.dispatcher);
    const rows: ClaimedLease[] = [];
    for (const _ of ids) {
      const [row] = await dispatcher.claimBatch(1);
      if (row) rows.push(row);
    }
    expect(rows.map((row) => row.id)).toEqual(ids);
    const [r1, r2, r3] = rows as [ClaimedLease, ClaimedLease, ClaimedLease];

    await outboxIn(a.organizationId, async (repository) => {
      expect(await repository.claimStanding(r1.id, lease(r1))).toBe("held");
      for (const wrong of [{ leaseId: randomUUID() }, r2]) {
        expect(await repository.claimStanding(r1.id, lease(wrong))).toBe(
          "superseded",
        );
        expect(await repository.markCompleted(r1.id, lease(wrong))).toBe(false);
        expect(await repository.deadLetter(r1.id, lease(wrong))).toBe(false);
      }
    });
    expect(await stateOf(owner, "outbox", r1.id)).toEqual({
      state: "leased",
      lease_owner: r1.leaseId,
      trigger_run_id: null,
    });

    // The suite's privileged fixture: the owner moves r1's expiry.
    await owner.query(
      "update public.outbox set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [r1.id],
    );
    await outboxIn(a.organizationId, async (repository) => {
      expect(await repository.markCompleted(r1.id, lease(r1))).toBe(false);
      expect(await repository.deadLetter(r1.id, lease(r1))).toBe(false);
      expect(await repository.claimStanding(r1.id, lease(r1))).toBe(
        "superseded",
      );
      // Under their own live leases, r2 completes and r3 dead-letters, once.
      expect(await repository.markCompleted(r2.id, lease(r2))).toBe(true);
      expect(await repository.deadLetter(r3.id, lease(r3))).toBe(true);
      expect(await repository.markCompleted(r2.id, lease(r2))).toBe(false);
      expect(await repository.claimStanding(r2.id, lease(r2))).toBe(
        "superseded",
      );
    });
    expect((await stateOf(owner, "outbox", r1.id))?.state).toBe("leased");
    expect((await stateOf(owner, "outbox", r2.id))?.state).toBe("completed");
    expect((await stateOf(owner, "outbox", r3.id))?.state).toBe("dead_letter");
  });

  test("outbox: a trigger_run settlement settles only an accepted row carrying its run id, a re-claimed row included", async () => {
    const [id] = (await committed(owner, () =>
      seedNewOutbox(owner, a.organizationId, 1),
    )) as [string];
    const dispatcher = createOutboxRepository(storages.dispatcher);
    const [claim] = await dispatcher.claimBatch(1);
    expect(claim?.id).toBe(id);

    // The early run: its row is still leased.
    await outboxIn(a.organizationId, async (repository) => {
      expect(await repository.claimStanding(id, run("run-1"))).toBe(
        "pending_acceptance",
      );
      expect(await repository.markCompleted(id, run("run-1"))).toBe(false);
      expect(await repository.deadLetter(id, run("run-1"))).toBe(false);
    });
    expect(
      await dispatcher.acceptClaim(id, claim?.leaseId as string, "run-1"),
    ).toBe(true);
    await outboxIn(a.organizationId, async (repository) => {
      expect(await repository.claimStanding(id, run("run-1"))).toBe("held");
      expect(await repository.claimStanding(id, run("run-2"))).toBe(
        "superseded",
      );
      // Acceptance clears the lease, so the claim's lease holds nothing now.
      expect(
        await repository.claimStanding(id, lease(claim as ClaimedLease)),
      ).toBe("superseded");
      expect(await repository.markCompleted(id, run("run-2"))).toBe(false);
      expect(await repository.deadLetter(id, run("run-2"))).toBe(false);
    });

    // Re-claimed after the accepted-retry window, which the owner fixture
    // moves past (10 minutes for the outbox): leased again, still carrying
    // run-1's id, which settles nothing.
    await owner.query(
      "update public.outbox set updated_at = clock_timestamp() - interval '11 minutes' where id = $1",
      [id],
    );
    const [again] = await dispatcher.claimBatch(1);
    expect(again?.id).toBe(id);
    expect(await stateOf(owner, "outbox", id)).toEqual({
      state: "leased",
      lease_owner: again?.leaseId,
      trigger_run_id: "run-1",
    });
    await outboxIn(a.organizationId, async (repository) => {
      expect(await repository.claimStanding(id, run("run-1"))).toBe(
        "pending_acceptance",
      );
      expect(await repository.markCompleted(id, run("run-1"))).toBe(false);
      expect(await repository.deadLetter(id, run("run-1"))).toBe(false);
    });
    expect(
      await dispatcher.acceptClaim(id, again?.leaseId as string, "run-2"),
    ).toBe(true);
    await outboxIn(a.organizationId, async (repository) => {
      expect(await repository.claimStanding(id, run("run-1"))).toBe(
        "superseded",
      );
      expect(await repository.markCompleted(id, run("run-1"))).toBe(false);
      expect(await repository.markCompleted(id, run("run-2"))).toBe(true);
    });
    expect((await stateOf(owner, "outbox", id))?.state).toBe("completed");
  });

  test("dispatch: settlement also names the attempt, and a lease or a run as the outbox's", async () => {
    const [first, second] = await committed(owner, () =>
      seedNewDispatches(owner, a.organizationId, 2),
    );
    const dispatcher = createImportTaskDispatchRepository(storages.dispatcher);
    const [d1] = await dispatcher.claimBatch(1);
    const [d2] = await dispatcher.claimBatch(1);
    expect([d1?.id, d2?.id]).toEqual([first, second]);
    const one = d1 as ClaimedLease & { attemptCount: number };
    const two = d2 as ClaimedLease & { attemptCount: number };

    await dispatchesIn(a.organizationId, async (repository) => {
      expect(
        await repository.claimStanding(one.id, one.attemptCount, lease(one)),
      ).toBe("held");
      expect(
        await repository.claimStanding(
          one.id,
          one.attemptCount + 1,
          lease(one),
        ),
      ).toBe("superseded");
      expect(
        await repository.claimStanding(one.id, one.attemptCount, run("run-x")),
      ).toBe("pending_acceptance");
      for (const [attempt, settlement] of [
        [one.attemptCount, lease({ leaseId: randomUUID() })],
        [one.attemptCount, lease(two)],
        [one.attemptCount + 1, lease(one)],
        [one.attemptCount, run("run-x")],
      ] as const) {
        expect(
          await repository.markCompleted(one.id, attempt, settlement),
        ).toBe(false);
      }
    });
    await owner.query(
      "update public.import_task_dispatches set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [one.id],
    );
    await dispatchesIn(a.organizationId, async (repository) => {
      expect(
        await repository.markCompleted(one.id, one.attemptCount, lease(one)),
      ).toBe(false);
      expect(
        await repository.claimStanding(one.id, one.attemptCount, lease(one)),
      ).toBe("superseded");
    });
    expect(
      (await stateOf(owner, "import_task_dispatches", one.id))?.state,
    ).toBe("leased");

    // d2 by its run: accepted, then re-claimed after the window (15 minutes;
    // the fixture moves updated_at past it, and first in claim order).
    expect(await dispatcher.acceptClaim(two.id, two.leaseId, "run-d2")).toBe(
      true,
    );
    await dispatchesIn(a.organizationId, async (repository) => {
      expect(
        await repository.claimStanding(two.id, two.attemptCount, run("run-d2")),
      ).toBe("held");
      expect(
        await repository.claimStanding(
          two.id,
          two.attemptCount,
          run("run-other"),
        ),
      ).toBe("superseded");
      expect(
        await repository.markCompleted(
          two.id,
          two.attemptCount,
          run("run-other"),
        ),
      ).toBe(false);
    });
    await owner.query(
      "update public.import_task_dispatches set updated_at = timestamptz '1960-01-01' where id = $1",
      [two.id],
    );
    const [again] = await dispatcher.claimBatch(1);
    expect(again?.id).toBe(two.id);
    expect(again?.attemptCount).toBe(two.attemptCount + 1);
    await dispatchesIn(a.organizationId, async (repository) => {
      for (const attempt of [two.attemptCount, two.attemptCount + 1]) {
        expect(
          await repository.markCompleted(two.id, attempt, run("run-d2")),
          `attempt ${attempt}`,
        ).toBe(false);
      }
      expect(
        await repository.claimStanding(
          two.id,
          two.attemptCount + 1,
          run("run-d2"),
        ),
      ).toBe("pending_acceptance");
    });
    expect(
      await dispatcher.acceptClaim(two.id, again?.leaseId as string, "run-d2b"),
    ).toBe(true);
    await dispatchesIn(a.organizationId, async (repository) => {
      expect(
        await repository.markCompleted(
          two.id,
          two.attemptCount + 1,
          run("run-d2"),
        ),
      ).toBe(false);
      expect(
        await repository.markCompleted(
          two.id,
          two.attemptCount + 1,
          run("run-d2b"),
        ),
      ).toBe(true);
    });
    expect(
      (await stateOf(owner, "import_task_dispatches", two.id))?.state,
    ).toBe("completed");
  });

  test("bound to another organisation, a row is superseded as an absent one is, and no settlement of it changes anything", async () => {
    const [outboxId] = (await committed(owner, () =>
      seedNewOutbox(owner, a.organizationId, 1),
    )) as [string];
    const [dispatchId] = (await committed(owner, () =>
      seedNewDispatches(owner, a.organizationId, 1),
    )) as [string];
    const [claim] = await createOutboxRepository(
      storages.dispatcher,
    ).claimBatch(1);
    const [dispatch] = await createImportTaskDispatchRepository(
      storages.dispatcher,
    ).claimBatch(1);
    expect([claim?.id, dispatch?.id]).toEqual([outboxId, dispatchId]);
    const held = lease(claim as ClaimedLease);
    const dispatchHeld = lease(dispatch as ClaimedLease);
    const attempt = dispatch?.attemptCount as number;

    await outboxIn(b.organizationId, async (repository) => {
      for (const id of [outboxId, randomUUID()]) {
        expect(await repository.claimStanding(id, held)).toBe("superseded");
        expect(await repository.claimStanding(id, run("run-a"))).toBe(
          "superseded",
        );
      }
      expect(await repository.markCompleted(outboxId, held)).toBe(false);
      expect(await repository.deadLetter(outboxId, held)).toBe(false);
    });
    await dispatchesIn(b.organizationId, async (repository) => {
      for (const id of [dispatchId, randomUUID()]) {
        expect(await repository.claimStanding(id, attempt, dispatchHeld)).toBe(
          "superseded",
        );
      }
      expect(
        await repository.markCompleted(dispatchId, attempt, dispatchHeld),
      ).toBe(false);
    });
    // Its own organisation holds it, which is what the refusals above mean.
    await outboxIn(a.organizationId, async (repository) => {
      expect(await repository.claimStanding(outboxId, held)).toBe("held");
    });
    await dispatchesIn(a.organizationId, async (repository) => {
      expect(
        await repository.claimStanding(dispatchId, attempt, dispatchHeld),
      ).toBe("held");
    });
    expect((await stateOf(owner, "outbox", outboxId))?.state).toBe("leased");
    expect(
      (await stateOf(owner, "import_task_dispatches", dispatchId))?.state,
    ).toBe("leased");
  });
});

describe.sequential("discovery and maintenance through the repositories (Done when 10, b2)", () => {
  test("each discovery method returns its function's ids and organisations, and nothing more", async () => {
    await inRolledBackTransaction(async (session) => {
      const organization = await seedOrganization(session);
      await seedDue(session, organization, 2);
      const before = await databaseNow(session);
      await as(session, DISPATCHER, async () => {
        const mine = <T extends { organizationId: string }>(rows: T[]) =>
          rows.filter(
            (row) => row.organizationId === organization.organizationId,
          );
        const intents = mine(
          await createNotificationRepository(session.db).dueNotificationIntents(
            500,
          ),
        );
        expect(intents).toHaveLength(2);
        expect(Object.keys(intents[0] ?? {}).sort()).toEqual([
          "channel",
          "id",
          "organizationId",
        ]);
        expect(intents[0]?.channel).toBe("email");
        for (const [name, rows, keys] of [
          [
            "pendingWebhookDeliveries",
            await createOutboxRepository(session.db).pendingWebhookDeliveries(
              500,
            ),
            ["id", "organizationId"],
          ],
          [
            "message updates",
            await createSlackRepository(session.db).dueSlackDeliveryOperations(
              "message_update",
              500,
            ),
            ["id", "organizationId"],
          ],
          [
            "connection tests",
            await createSlackRepository(session.db).dueSlackDeliveryOperations(
              "connection_test",
              500,
            ),
            ["id", "organizationId"],
          ],
          [
            "listLeaseExpired",
            await createWorkSweepRepository(session.db).listLeaseExpired(500),
            ["id", "organizationId", "version"],
          ],
          [
            "listGraceExpired",
            await createWorkSweepRepository(session.db).listGraceExpired(500),
            ["id", "organizationId", "version"],
          ],
          [
            "listDueSecretPromotions",
            await createWebhookRepository(session.db).listDueSecretPromotions(
              500,
            ),
            ["id", "organizationId"],
          ],
        ] as const) {
          const own = mine([...rows] as { organizationId: string }[]);
          expect(own, name).toHaveLength(2);
          expect(Object.keys(own[0] ?? {}).sort(), name).toEqual([...keys]);
        }
        const reminders = mine(
          await createNotificationRepository(session.db).dueQuestionReminders(
            200,
          ),
        );
        expect(reminders).toHaveLength(2);
        expect(Object.keys(reminders[0] ?? {}).sort()).toEqual([
          "asOf",
          "organizationId",
          "questionId",
        ]);
        const asOf = reminders[0]?.asOf as Date;
        expect(asOf).toBeInstanceOf(Date);
        expect(asOf.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(asOf.getTime() - before.getTime()).toBeLessThan(5_000);
        // One instant for the whole discovery.
        expect(reminders[1]?.asOf.getTime()).toBe(asOf.getTime());
      });
    });
  });

  test("the metrics snapshot and the outbox backlog, as the maintenance login, equal the owner's own counts", async () => {
    await inRolledBackTransaction(async (session) => {
      const organization = await seedOrganization(session);
      await seedDue(session, organization, 2);
      await seedOutbox(session, organization.organizationId, 3);
      await seeding(session, async () => {
        await session.query(
          `insert into public.webhook_deliveries (organization_id, subscription_id, event_id, status) values ($1, $2, gen_random_uuid(), 'dead_letter')`,
          [organization.organizationId, organization.subscriptionId],
        );
        await session.query(
          `insert into public.import_conflicts (import_run_id, entry_id, kind, severity, details, organization_id) values (gen_random_uuid(), gen_random_uuid(), 'duplicate', 'blocking', '{}', $1)`,
          [organization.organizationId],
        );
        await session.query(
          `insert into public.import_task_dispatches (organization_id, import_run_id, task_kind, task_payload, state) values ($1, gen_random_uuid(), 'apply', '{}', 'dead_letter')`,
          [organization.organizationId],
        );
      });
      const snapshot = await as(session, MAINTENANCE, () =>
        createOperationalMetricsRepository(session.db).snapshot(),
      );
      const backlog = await as(session, MAINTENANCE, () =>
        createOutboxRepository(session.db).pendingBacklog(),
      );
      // The owner's counts, by the queries the methods ran before b2.
      const { rows } = await session.query<Record<string, string>>(
        `select
           (select count(*) from public.outbox where state in ('pending','leased','accepted')) as pending_outbox,
           coalesce((select greatest(0, extract(epoch from (clock_timestamp() - min(created_at)))) from public.outbox where state in ('pending','leased','accepted')), 0) as oldest_outbox_seconds,
           (select count(*) from public.webhook_deliveries where status = 'dead_letter') as dead_letter_webhooks,
           (select count(*) from public.notification_intents where status in ('pending','delivering','failed')) as notification_backlog,
           (select count(*) from public.work_sessions where state = 'stale') as stale_sessions,
           (select count(*) from public.import_conflicts where severity = 'blocking' and resolved_at is null) as open_import_conflicts,
           (select count(*) from public.slack_delivery_operations where status in ('pending','delivering','retry')) as slack_operation_backlog,
           (select count(*) from public.import_task_dispatches where state = 'dead_letter') as dead_letter_import_dispatches,
           (select count(*) from public.outbox o where (o.state = 'pending' or (o.state = 'leased' and o.lease_expires_at < clock_timestamp()) or (o.state = 'accepted' and o.updated_at < clock_timestamp() - interval '10 minutes')) and o.next_attempt_at <= clock_timestamp()) as backlog_count,
           coalesce((select extract(epoch from (clock_timestamp() - min(o.created_at))) from public.outbox o where (o.state = 'pending' or (o.state = 'leased' and o.lease_expires_at < clock_timestamp()) or (o.state = 'accepted' and o.updated_at < clock_timestamp() - interval '10 minutes')) and o.next_attempt_at <= clock_timestamp()), 0)::integer as backlog_age`,
      );
      const owners = rows[0] as Record<string, string>;
      const { oldestOutboxSeconds, ...counts } = snapshot;
      expect(counts).toEqual({
        pendingOutbox: Number(owners.pending_outbox),
        deadLetterWebhooks: Number(owners.dead_letter_webhooks),
        notificationBacklog: Number(owners.notification_backlog),
        staleSessions: Number(owners.stale_sessions),
        openImportConflicts: Number(owners.open_import_conflicts),
        slackOperationBacklog: Number(owners.slack_operation_backlog),
        deadLetterImportDispatches: Number(
          owners.dead_letter_import_dispatches,
        ),
      });
      for (const count of Object.values(counts))
        expect(count).toBeGreaterThan(0);
      expect(
        Math.abs(oldestOutboxSeconds - Number(owners.oldest_outbox_seconds)),
      ).toBeLessThanOrEqual(1);
      expect(backlog.count).toBe(Number(owners.backlog_count));
      expect(backlog.count).toBeGreaterThan(0);
      expect(
        Math.abs(backlog.oldestAgeSeconds - Number(owners.backlog_age)),
      ).toBeLessThanOrEqual(1);
    }, "REPEATABLE READ");
  });

  test.each([...retentionCategories])(
    "retention through cleanup(), as the maintenance login: %s's oldest expired row goes, with its tombstone",
    async (category) => {
      const owner = await openSession(suiteStorage);
      const storages = createWorkerStorages(workerEnv());
      let organization: Organization | undefined;
      let tombstoneId: string | null = null;
      const seed = retentionSeeds[category];
      let id = "";
      try {
        organization = await committed(owner, () => seedOrganization(owner));
        id = await committed(owner, () =>
          seeding(owner, async () => {
            const [text, values] = seed.insert(
              "timestamptz '1970-01-01'",
              randomUUID().slice(0, 12),
              organization?.organizationId,
            );
            const { rows } = await owner.query<{ id: string }>(text, values);
            return rows[0]?.id as string;
          }),
        );
        const result = await createRetentionRepository(
          storages.maintenance,
        ).cleanup({ category, batchSize: 1 });
        tombstoneId = result.tombstoneId;
        expect(result).toMatchObject({ category, deleted: 1 });
        const { rows: left } = await owner.query(
          `select 1 from public.${seed.table} where id::text = $1`,
          [id],
        );
        expect(left).toEqual([]);
        const { rows } = await owner.query<{
          category: string;
          deleted_count: number;
          selected_ids_sha256: string;
          metadata: Record<string, unknown>;
        }>(
          "select category, deleted_count, selected_ids_sha256, metadata from public.retention_tombstones where id = $1",
          [tombstoneId],
        );
        expect(rows[0]).toEqual({
          category,
          deleted_count: 1,
          selected_ids_sha256: createHash("sha256")
            .update(canonicalJson([id]))
            .digest("hex"),
          metadata: { batchSize: 1 },
        });
      } finally {
        await storages.close();
        await owner.query("BEGIN");
        await owner.query("SET LOCAL session_replication_role = replica");
        if (tombstoneId) {
          await owner.query(
            "delete from public.retention_tombstones where id = $1",
            [tombstoneId],
          );
        }
        if (id) {
          await owner.query(
            `delete from public.${seed.table} where id::text = $1`,
            [id],
          );
        }
        await owner.query("COMMIT");
        if (organization)
          await dropOrganization(owner, organization.organizationId);
        owner.release();
      }
    },
  );
});

describe.sequential("the bound halves, as the tenant processor's login (b2)", () => {
  let owner: TestSession;
  let storages: WorkerStorages;
  let organization: Organization;
  const userId = `wrs-bh-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    owner = await openSession(suiteStorage);
    organization = await committed(owner, async () => {
      const o = await seedOrganization(owner);
      await seeding(owner, async () => {
        await owner.query(
          `insert into public."user" (id, name, email) values ($1, 'Reminded Owner', $2)`,
          [userId, `${userId}@example.test`],
        );
        await owner.query(
          `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'owner', 'active')`,
          [o.organizationId, userId],
        );
      });
      return o;
    });
    storages = createWorkerStorages(workerEnv());
  });

  afterAll(async () => {
    await storages?.close();
    if (owner) {
      if (organization)
        await dropOrganization(owner, organization.organizationId);
      await owner.query(`delete from public."user" where id = $1`, [userId]);
      owner.release();
    }
  });

  test("the reminders: discovery as the dispatcher, then the bound materialisation at its instant creates the escalation", async () => {
    const questionId = randomUUID();
    await committed(owner, () =>
      seeding(owner, () =>
        owner.query(
          `insert into public.questions (id, organization_id, subject_type, subject_id, parent_request_id, audience_type, body_md, asked_by_type, asked_by_id, deadline_at)
           values ($1, $2, 'request', $3, $3, 'requester', 'Due?', 'user', 'wrs', timestamptz '1960-01-01')`,
          [questionId, organization.organizationId, organization.requestId],
        ),
      ),
    );
    const due = (
      await createNotificationRepository(
        storages.dispatcher,
      ).dueQuestionReminders(200)
    ).find((row) => row.questionId === questionId);
    expect(due?.organizationId).toBe(organization.organizationId);

    const created = await storages.withTenant(
      organization.organizationId,
      (database) =>
        createNotificationRepository(
          database as Database,
        ).materializeQuestionReminder(
          "https://requestport.example",
          due as DueQuestionReminder,
        ),
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.channel).toBe("email");
    const { rows } = await owner.query<{
      template: string;
      dedupe_key: string;
      recipient_user_id: string;
    }>(
      "select template, dedupe_key, recipient_user_id from public.notification_intents where id = $1",
      [created[0]?.id],
    );
    expect(rows[0]).toEqual({
      template: "question_escalation_v1",
      dedupe_key: `question:${questionId}:escalation:60:email:${userId}`,
      recipient_user_id: userId,
    });

    // Bound to another organisation, the same question is not found.
    const other = await committed(owner, () => seedOrganization(owner));
    try {
      expect(
        await storages.withTenant(other.organizationId, (database) =>
          createNotificationRepository(
            database as Database,
          ).materializeQuestionReminder("https://requestport.example", {
            ...(due as DueQuestionReminder),
            organizationId: other.organizationId,
          }),
        ),
      ).toEqual([]);
    } finally {
      await dropOrganization(owner, other.organizationId);
    }
  });

  test("the secret promotion: discovery returns ids only, and the bound read loads the next secret", async () => {
    const subscriptionId = randomUUID();
    const envelope = {
      ciphertext: "bmV4dA",
      nonce: "bm9uY2U",
      wrappedDek: "ZGVr",
      kekVersion: "wrs-1",
    };
    await committed(owner, () =>
      seeding(owner, () =>
        owner.query(
          `insert into public.webhook_subscriptions (id, organization_id, name, endpoint_url, current_secret_ciphertext, current_secret_key_id, next_secret_ciphertext, next_secret_key_id, overlap_ends_at, created_by)
           values ($1, $2, 'due', 'https://example.test/due', '{}', 'k1', $3, 'k2', timestamptz '1960-01-01', 'wrs')`,
          [
            subscriptionId,
            organization.organizationId,
            JSON.stringify(envelope),
          ],
        ),
      ),
    );
    const listed = (
      await createWebhookRepository(
        storages.dispatcher,
      ).listDueSecretPromotions(500)
    ).find((row) => row.id === subscriptionId);
    expect(listed).toEqual({
      id: subscriptionId,
      organizationId: organization.organizationId,
    });
    const loaded = await storages.withTenant(
      organization.organizationId,
      (database) =>
        createWebhookRepository(database as Database).loadDueSecretPromotion(
          organization.organizationId,
          subscriptionId,
        ),
    );
    expect(loaded).toMatchObject({
      id: subscriptionId,
      organizationId: organization.organizationId,
      nextSecretKeyId: "k2",
    });
    expect(
      Buffer.from(loaded?.nextSecretCiphertext.ciphertext ?? []).toString(),
    ).toBe("next");
    // A subscription that is not due is not loaded.
    expect(
      await storages.withTenant(organization.organizationId, (database) =>
        createWebhookRepository(database as Database).loadDueSecretPromotion(
          organization.organizationId,
          organization.subscriptionId,
        ),
      ),
    ).toBeNull();
  });
});
