import { randomBytes, randomUUID } from "node:crypto";

/*
 * No provider is called from this suite: Resend is unconfigured (the e-mail
 * body then fails as `provider_unavailable` before any call), and the
 * webhook and Slack bodies meet ciphertexts that do not decrypt, so they
 * fail before any request. The webhook key is one made for this run, so the
 * secret rotation can decrypt what this suite encrypted. Set before anything
 * reads the server configuration, which `serverEnv` parses on first use.
 */
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM_EMAIL;
process.env.REQUESTPORT_WEBHOOK_KEK = randomBytes(32).toString("base64");
process.env.REQUESTPORT_WEBHOOK_KEK_VERSION = "wjs-test";
delete process.env.REQUESTPORT_WEBHOOK_KEK_PREVIOUS;
delete process.env.REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION;
// A notification's deep link must be https, as production's origin is.
process.env.BETTER_AUTH_URL = "https://requestport.example";

import {
  type ClaimSettlement,
  createImportTaskDispatchRepository,
  createNotificationRepository,
  createOperationalMetricsRepository,
  createOutboxRepository,
  createWebhookRepository,
  createWorkerStorages,
  type Database,
  DatabaseRoleGuardError,
  readDatabaseUrl,
  type WorkerStorages,
} from "@requestport/db";
import {
  createTestStorage,
  openSession,
  type TestSession,
  testPool,
} from "@requestport/db/testing";
import { rootStorageFromEnv } from "@requestport/db/wiring";
import { serializeEncryptedEnvelope } from "@requestport/domain";
import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { runEmailDelivery } from "./jobs/email-delivery.js";
import { runImportAnalyze } from "./jobs/import-analyze.js";
import { runImportApply } from "./jobs/import-apply.js";
import { repairNotificationDeliveries } from "./jobs/notification-repair.js";
import { recordOperationalMetrics } from "./jobs/operational-metrics.js";
import { deliverOutboxEvent } from "./jobs/outbox-delivery.js";
import { sendQuestionReminders } from "./jobs/question-reminders.js";
import { cleanUpRetention } from "./jobs/retention-cleanup.js";
import {
  repairSlackConnectionTests,
  runSlackConnectionTest,
} from "./jobs/slack-connection-test.js";
import {
  repairSlackMessageUpdates,
  runSlackMessageUpdate,
} from "./jobs/slack-message-update.js";
import { runSlackQuestionDelivery } from "./jobs/slack-question-delivery.js";
import { sweepStaleWorkSessions } from "./jobs/stale-sessions.js";
import {
  repairWebhookDeliveries,
  runWebhookDelivery,
} from "./jobs/webhook-delivery.js";
import { rotateWebhookSecrets } from "./jobs/webhook-secret-rotation.js";
import type { JobName, JobPayloads, JobRunner } from "./port.js";
import { createImportDispatchPoller } from "./postgres/import-dispatch-poller.js";
import {
  createOutboxPoller,
  type LeaseSettlement,
} from "./postgres/outbox-poller.js";
import { SettlementPendingError } from "./settlement.js";
import { webhookAad, webhookEncryption } from "./webhook-encryption.js";
// The package's own module, which registers the worker root the holder fills
// from (`index.ts`), as each Trigger.dev task module loads it: the bodies'
// settings are the root's, from the configuration set above.
import "./index.js";
import { inUnit, useWorkerStorages } from "./worker-storages.js";

/*
 * b2's worker half, as the worker roles (Plan 13, Track I.2b;
 * manifest-i2.md §5.3 Done when 2, 4, 7, 11, 12 and 13).
 *
 * The suite makes its own logins on the run's database: one in each worker
 * group, and an owner-shaped one — `NOSUPERUSER BYPASSRLS`, a member of no
 * role, granted the table privileges and the `EXECUTE` the migrating role
 * holds, a subset of what production's owner holds (§2.9). Done when 12 then
 * makes it a member of `requestport_definer`, as 0019 makes the migrating
 * role, and shows it refused each of the seventeen since 0023. Each name is
 * unique to the run, its password is made here and never written down, and
 * the run that made it drops it. The seeds and the reads that check the
 * effects go through the owner (`DATABASE_URL`, the local superuser), with
 * triggers off for the seeds, as packages/db's worker suite does.
 *
 * Every job runs through its real body, installed storages and all; the
 * runner is a recorder, so a child is recorded rather than started.
 */

const DISPATCHER = "requestport_dispatcher";
const PROCESSOR = "requestport_tenant_processor";
const MAINTENANCE = "requestport_maintenance";
const VARIABLES = {
  dispatcher: "REQUESTPORT_DISPATCHER_DATABASE_URL",
  processor: "REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL",
  maintenance: "REQUESTPORT_MAINTENANCE_DATABASE_URL",
} as const;

type Login = { name: string; url: string };
type Logins = {
  dispatcher: Login;
  processor: Login;
  maintenance: Login;
  ownerShaped: Login;
};

/*
 * The storage the wiring builds for the worker surface
 * (`rootStorageFromEnv("worker")`) and keeps for the process, over
 * `DATABASE_URL`, the owner. Until b5 it was the worker root's own storage,
 * whose handle the worker's three storages were when their variables were
 * unset (Plan 13, G.5); since b5 the root builds none, and refuses the unset
 * case (ruling 214 item 1). The owner's session (`owner`) is checked out of
 * it.
 */
const rootStorage = rootStorageFromEnv("worker");
let owner: TestSession;
let logins: Logins;
/** The three storages as the three logins: the variables set. */
let bound: WorkerStorages;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The environment the worker's three storages are built from: the driver
 * this run selected and the three variables naming `logins` (a role left
 * out has its variable left out), and no other name. So it names none of
 * the owner's: since I.2b's b6 each storage's guard refuses its first use
 * in an environment that names `DATABASE_URL`, which names the owner here,
 * or any other owner-capable name (ruling 217 item 1).
 */
function workerEnv(
  as: Partial<Record<keyof typeof VARIABLES, Login>> | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    REQUESTPORT_DATABASE_DRIVER: process.env.REQUESTPORT_DATABASE_DRIVER,
  };
  for (const [role, variable] of Object.entries(VARIABLES)) {
    const login = as?.[role as keyof typeof VARIABLES];
    if (login) env[variable] = login.url;
  }
  return env;
}

async function query<Row extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) {
  return (await owner.query<Row>(text, values)).rows;
}

/** Runs `statements` as the owner, committed, with triggers and foreign-key checks off. */
async function seed(statements: Array<[string, unknown[]]>) {
  await owner.query("BEGIN");
  try {
    await owner.query("SET LOCAL session_replication_role = replica");
    for (const [text, values] of statements) await owner.query(text, values);
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }
}

/** The SQLSTATE of a failure, through Drizzle's wrapping. */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The role guard's refusal, through Drizzle's wrapping, or undefined. */
async function guardRefusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      if (current instanceof DatabaseRoleGuardError) return current;
      current = (current as { cause?: unknown }).cause;
    }
    throw error;
  }
  return undefined;
}

async function refusedWith(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return sqlState(error);
  }
  return "resolved";
}

/*
 * `rootStorage`'s handle, where an unset worker path landed until b5, is the
 * owner here (`DATABASE_URL`), as that variable is in production until b6,
 * so a worker path that reached it instead of its storage would pass as the
 * owner and prove nothing. While a case in the describes below runs, every
 * use of that storage's pool is recorded, and the case fails if there was
 * one. The seeds and reads above go through `owner`, a connection checked
 * out of it before, which this does not watch.
 */
function watchRootPool() {
  const pool = testPool(rootStorage) as unknown as Record<
    "query" | "connect",
    (...args: unknown[]) => unknown
  >;
  const uses: string[] = [];
  const saved = { query: pool.query, connect: pool.connect };
  for (const name of ["query", "connect"] as const) {
    const original = saved[name];
    Object.defineProperty(pool, name, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        uses.push(name);
        return original.apply(pool, args);
      },
    });
  }
  return {
    uses,
    restore() {
      for (const name of ["query", "connect"] as const) {
        Object.defineProperty(pool, name, {
          configurable: true,
          writable: true,
          value: saved[name],
        });
      }
    },
  };
}

function refusingTheRootHandle() {
  let watch: ReturnType<typeof watchRootPool> | undefined;
  beforeEach(() => {
    watch = watchRootPool();
  });
  afterEach(() => {
    watch?.restore();
    expect(watch?.uses, "a use of rootStorage").toEqual([]);
  });
}

type Recorded = {
  enqueued: Array<[JobName, unknown]>;
  dispatched: Array<[string, string]>;
};

/** A runner that records what a body asks of it, and starts nothing. */
function recorder(
  hold?: (name: JobName) => Promise<void>,
): JobRunner & Recorded {
  const enqueued: Recorded["enqueued"] = [];
  const dispatched: Recorded["dispatched"] = [];
  return {
    kind: "postgres",
    enqueued,
    dispatched,
    async enqueue<N extends JobName>(name: N, payload: JobPayloads[N]) {
      enqueued.push([name, payload]);
      await hold?.(name);
      return { id: randomUUID() };
    },
    async sleep() {},
    async waitBeforeRetry() {},
    async dispatchOutbox(outboxId: string, organizationId: string) {
      dispatched.push([outboxId, organizationId]);
      return { accepted: false };
    },
  };
}

function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function withStorages<T>(
  storages: WorkerStorages,
  work: () => Promise<T>,
): Promise<T> {
  useWorkerStorages(storages);
  try {
    return await work();
  } finally {
    useWorkerStorages(undefined);
  }
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

type Tenant = Awaited<ReturnType<typeof seedTenant>>;
let seededAt = Date.UTC(1971, 0, 1);

/** A timestamp older than anything else in the run's database, each new. */
function old() {
  seededAt += 60_000;
  return new Date(seededAt).toISOString();
}

/**
 * One organisation with an owner, a project, two requests, an active Slack
 * installation mapped to the owner, a webhook subscription for every event,
 * and a legacy import source whose snapshot has one clear artefact.
 */
async function seedTenant(label: string) {
  const tag = randomUUID().slice(0, 8);
  const t = {
    label,
    tag,
    organizationId: randomUUID(),
    userId: `wjs-user-${tag}`,
    projectId: randomUUID(),
    requestId: randomUUID(),
    secondRequestId: randomUUID(),
    installationId: randomUUID(),
    subscriptionId: randomUUID(),
    sourceId: randomUUID(),
    snapshotId: randomUUID(),
    artifactId: randomUUID(),
  };
  const sha = "b".repeat(64);
  const bytes = Buffer.from(`# FR-${tag} Imported ${label}\n\nBody.\n`);
  await seed([
    [
      `insert into public.organizations (id, name, slug, status) values ($1, $2, $2, 'active')`,
      [t.organizationId, `wjs-${label}-${tag}`],
    ],
    [
      `insert into public."user" (id, name, email) values ($1, 'Worker Job Seed', $2)`,
      [t.userId, `${t.userId}@example.test`],
    ],
    [
      `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'owner', 'active')`,
      [t.organizationId, t.userId],
    ],
    [
      `insert into public.projects (id, organization_id, name, slug, key_prefix, status) values ($1, $2, 'Jobs', $3, $4, 'active')`,
      [
        t.projectId,
        t.organizationId,
        `wjs-${tag}`,
        `J${tag.slice(0, 4).toUpperCase()}`,
      ],
    ],
    [
      `insert into public.project_members (organization_id, project_id, user_id, role, status) values ($1, $2, $3, 'maintainer', 'active')`,
      [t.organizationId, t.projectId, t.userId],
    ],
    [
      `insert into public.requests (id, organization_id, source_kind, target_project_id, type, title, description_md, reporter_type, reporter_id)
       values ($1, $3, 'human_direct', $4, 'bug', 'Jobs', '', 'user', $5),
              ($2, $3, 'human_direct', $4, 'bug', 'Jobs 2', '', 'user', $5)`,
      [t.requestId, t.secondRequestId, t.organizationId, t.projectId, t.userId],
    ],
    [
      // An envelope of the right shape that no key here decrypts: a claim
      // reads it, and the body then fails before any Slack call.
      `insert into public.slack_installations (id, organization_id, workspace_id, workspace_name, bot_token_ciphertext, bot_user_id, installed_by_user_id, status)
       values ($1, $2, $3, 'Workspace', $5, 'B1', $4, 'active')`,
      [
        t.installationId,
        t.organizationId,
        `T${tag}`,
        t.userId,
        JSON.stringify({
          ciphertext: "bm9uZQ",
          nonce: "bm9uY2U",
          wrappedDek: "ZGVr",
          kekVersion: "wjs-none",
        }),
      ],
    ],
    [
      `insert into public.slack_user_mappings (organization_id, installation_id, slack_user_id, user_id, verified_at) values ($1, $2, $3, $4, now())`,
      [t.organizationId, t.installationId, `U${tag}`, t.userId],
    ],
    [
      `insert into public.webhook_subscriptions (id, organization_id, name, endpoint_url, current_secret_ciphertext, current_secret_key_id, created_by, status, verified_at)
       values ($1, $2, 'hook', 'https://example.test/hook', '{}', 'k1', $3, 'active', now())`,
      [t.subscriptionId, t.organizationId, t.userId],
    ],
    [
      `insert into public.import_sources (id, organization_id, project_id, created_by) values ($1, $2, $3, $4)`,
      [t.sourceId, t.organizationId, t.projectId, t.userId],
    ],
    [
      `insert into public.source_snapshots (id, organization_id, import_source_id, manifest_sha256) values ($1, $2, $3, $4)`,
      [t.snapshotId, t.organizationId, t.sourceId, sha],
    ],
    [
      `insert into public.source_artifacts (id, organization_id, import_source_id, source_snapshot_id, relative_path, media_type, byte_size, sha256, exact_bytes)
       values ($1, $2, $3, $4, 'legacy.md', 'text/markdown', $5, $6, $7)`,
      [
        t.artifactId,
        t.organizationId,
        t.sourceId,
        t.snapshotId,
        bytes.length,
        sha,
        bytes,
      ],
    ],
  ]);
  return t;
}

/** A pending outbox row for a registered event of `t`, the oldest there is. */
async function seedOutboxRow(t: Tenant) {
  const eventId = randomUUID();
  const outboxId = randomUUID();
  const at = old();
  await seed([
    [
      `insert into public.domain_events (id, organization_id, aggregate_type, aggregate_id, aggregate_version, type, schema_version, actor, correlation_id, causation_id, data)
       values ($1, $2, 'organization', gen_random_uuid(), 1, 'retention.hold_changed.v1', 1, '{"type":"system","id":"wjs"}', 'wjs', 'wjs', '{"category":"all","status":"active"}')`,
      [eventId, t.organizationId],
    ],
    [
      `insert into public.outbox (id, event_id, state, created_at, next_attempt_at) values ($1, $2, 'pending', $3, $3)`,
      [outboxId, eventId, at],
    ],
  ]);
  return { outboxId, eventId };
}

/** An import run in `state` with a pending dispatch of `kind`, the oldest there is. */
async function seedDispatch(
  t: Tenant,
  kind: "analyze" | "apply",
  state: "analyzing" | "applied",
) {
  const runId = randomUUID();
  const dispatchId = randomUUID();
  const payload =
    kind === "analyze"
      ? { kind, runId }
      : {
          kind,
          organizationId: t.organizationId,
          runId,
          manifestSha256: "c".repeat(64),
          actor: { type: "user", id: t.userId },
        };
  await seed([
    [
      `insert into public.import_runs (id, organization_id, import_source_id, source_snapshot_id, requested_by_type, requested_by_id, parser_version, state)
       values ($1, $2, $3, $4, 'user', $5, 'v1', $6)`,
      [runId, t.organizationId, t.sourceId, t.snapshotId, t.userId, state],
    ],
    [
      `insert into public.import_task_dispatches (id, organization_id, import_run_id, task_kind, task_payload, state, updated_at)
       values ($1, $2, $3, $4, $5, 'pending', $6)`,
      [
        dispatchId,
        t.organizationId,
        runId,
        kind,
        JSON.stringify(payload),
        old(),
      ],
    ],
  ]);
  return { runId, dispatchId };
}

/** Every other kind of due work of `t`: intents, a delivery, Slack operations, a session, a question, a promotion. */
async function seedDueWork(t: Tenant, eventId: string) {
  const w = {
    emailIntentId: randomUUID(),
    slackIntentId: randomUUID(),
    deliveryId: randomUUID(),
    updateId: randomUUID(),
    testId: randomUUID(),
    sessionId: randomUUID(),
    questionId: randomUUID(),
    promotedId: randomUUID(),
  };
  const at = old();
  const key = randomUUID().slice(0, 8);
  const sessionRequestId = randomUUID();
  const next = await webhookEncryption().encrypt(
    { secret: `next-${t.tag}` },
    webhookAad(t.organizationId, w.promotedId, "next"),
  );
  await seed([
    [
      `insert into public.notification_intents (id, organization_id, channel, recipient_ref, recipient_user_id, template, dedupe_key, view_model, status, next_attempt_at, created_at)
       values ($1, $3, 'email', $4, $5, 'seed', $6, '{}', 'pending', $8, $8),
              ($2, $3, 'slack', $5, $5, 'seed', $7, '{}', 'pending', $8, $8)`,
      [
        w.emailIntentId,
        w.slackIntentId,
        t.organizationId,
        `${t.userId}@example.test`,
        t.userId,
        `wjs-email-${key}`,
        `wjs-slack-${key}`,
        at,
      ],
    ],
    [
      `insert into public.webhook_deliveries (id, organization_id, subscription_id, event_id, status, created_at) values ($1, $2, $3, $4, 'pending', $5)`,
      [w.deliveryId, t.organizationId, t.subscriptionId, eventId, at],
    ],
    [
      `insert into public.slack_delivery_operations (id, installation_id, operation_key, operation_type, next_attempt_at, created_at)
       values ($1, $3, $4, 'message_update', $6, $6), ($2, $3, $5, 'connection_test', $6, $6)`,
      [
        w.updateId,
        w.testId,
        t.installationId,
        `wjs-u-${key}`,
        `wjs-t-${key}`,
        at,
      ],
    ],
    [
      `insert into public.requests (id, organization_id, source_kind, target_project_id, type, title, description_md, reporter_type, reporter_id)
       values ($1, $2, 'human_direct', $3, 'bug', 'Worked', '', 'user', $4)`,
      [sessionRequestId, t.organizationId, t.projectId, t.userId],
    ],
    [
      `insert into public.work_sessions (id, organization_id, request_id, agent_principal_id, installation_id, workspace_id, authorization_chain, credential_fingerprint, state, heartbeat_interval_seconds, lease_expires_at, grace_expires_at)
       values ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}', $4, 'stale', 30, $5, $5)`,
      [w.sessionId, t.organizationId, sessionRequestId, `wjs-${key}`, at],
    ],
    [
      `insert into public.questions (id, organization_id, subject_type, subject_id, parent_request_id, audience_type, body_md, asked_by_type, asked_by_id, deadline_at)
       values ($1, $2, 'request', $3, $3, 'requester', 'Due?', 'user', 'wjs', $4)`,
      [w.questionId, t.organizationId, t.requestId, at],
    ],
    [
      `insert into public.webhook_subscriptions (id, organization_id, name, endpoint_url, current_secret_ciphertext, current_secret_key_id, next_secret_ciphertext, next_secret_key_id, overlap_ends_at, created_by, status, verified_at)
       values ($1, $2, 'rotating', 'https://example.test/rotating', '{}', 'k-current', $3, 'k-next', $4, 'wjs', 'disabled', now())`,
      [
        w.promotedId,
        t.organizationId,
        JSON.stringify(serializeEncryptedEnvelope(next)),
        at,
      ],
    ],
  ]);
  return w;
}

/**
 * Leaves nothing of this suite claimable, or due, for the suites after it:
 * its outbox rows and import dispatches completed, and the due work
 * `seedDueWork` and the bodies leave behind settled, so that no schedule
 * finds it. A later file's worker runs every schedule against the run's
 * database when it starts (`bin.integration.test.ts` starts
 * requestport-jobs), and would otherwise claim these and fail delivering
 * them. Notification intents are suppressed, webhook deliveries cancelled
 * and Slack operations failed, each with no lease and nothing to retry; a
 * rotating subscription's next secret is dropped, so that it has no
 * promotion due; an open question's deadline is dropped, so that
 * question-reminders creates no escalation for it; a live work session is
 * ended as abandoned, so that stale-work-sessions abandons none and emits
 * no event; and each webhook subscription is disabled, so that an event
 * still routed creates no delivery.
 */
async function settleEverything(organizationIds: string[]) {
  if (organizationIds.length === 0) return;
  await query(
    `update public.notification_intents
     set status = 'suppressed', next_attempt_at = null, lease_owner = null, lease_expires_at = null
     where organization_id = any($1::uuid[]) and status in ('pending', 'delivering', 'failed')`,
    [organizationIds],
  );
  await query(
    `update public.webhook_deliveries set status = 'cancelled'
     where organization_id = any($1::uuid[]) and status in ('pending', 'delivering', 'retry')`,
    [organizationIds],
  );
  await query(
    `update public.slack_delivery_operations o
     set status = 'failed', lease_owner = null, lease_expires_at = null
     from public.slack_installations si
     where si.id = o.installation_id and si.organization_id = any($1::uuid[])
       and o.status in ('pending', 'delivering', 'retry')`,
    [organizationIds],
  );
  await query(
    `update public.webhook_subscriptions
     set next_secret_ciphertext = null, next_secret_key_id = null, overlap_ends_at = null
     where organization_id = any($1::uuid[]) and next_secret_ciphertext is not null`,
    [organizationIds],
  );
  await query(
    `update public.questions set deadline_at = null
     where organization_id = any($1::uuid[]) and state = 'open' and deadline_at is not null`,
    [organizationIds],
  );
  await query(
    `update public.work_sessions set state = 'abandoned', ended_at = clock_timestamp()
     where organization_id = any($1::uuid[]) and state in ('claimed', 'active', 'paused', 'blocked', 'stale')`,
    [organizationIds],
  );
  await query(
    `update public.webhook_subscriptions set status = 'disabled'
     where organization_id = any($1::uuid[]) and status = 'active'`,
    [organizationIds],
  );
  await query(
    `update public.outbox o set state = 'completed', lease_owner = null, lease_expires_at = null
     from public.domain_events d
     where d.id = o.event_id and d.organization_id = any($1::uuid[]) and o.state in ('pending', 'leased', 'accepted')`,
    [organizationIds],
  );
  await query(
    `update public.import_task_dispatches
     set state = 'completed', lease_owner = null, lease_expires_at = null,
         accepted_at = coalesce(accepted_at, clock_timestamp()), completed_at = clock_timestamp()
     where organization_id = any($1::uuid[]) and state in ('pending', 'leased', 'accepted')`,
    [organizationIds],
  );
}

// ---------------------------------------------------------------------------
// Logins
// ---------------------------------------------------------------------------

beforeAll(async () => {
  owner = await openSession(rootStorage);
  const [{ prefix } = { prefix: "" }] = await query<{ prefix: string }>(
    "select left(current_database(), 24) || '_wjs_' || substr(md5(random()::text), 1, 8) as prefix",
  );
  const made: Partial<Logins> = {};
  logins = made as Logins;
  const base = readDatabaseUrl(process.env);
  const urlFor = (name: string, password: string) => {
    const url = new URL(base);
    url.username = name;
    url.password = password;
    return url.toString();
  };
  await owner.query("SET scram_iterations = 1");
  try {
    for (const [key, group, suffix] of [
      ["dispatcher", DISPATCHER, "d"],
      ["processor", PROCESSOR, "p"],
      ["maintenance", MAINTENANCE, "m"],
    ] as const) {
      const name = `${prefix}_${suffix}`;
      const password = randomUUID().replaceAll("-", "");
      await owner.query(
        `create role "${name}" login password '${password}' nosuperuser nobypassrls nocreatedb nocreaterole noreplication in role ${group}`,
      );
      made[key] = { name, url: urlFor(name, password) };
    }
    // The owner-shaped login (§2.9): BYPASSRLS, not a superuser, a member of
    // no role, granted what production's owner holds by owning: every table,
    // both schemas, and the EXECUTE the migrating role holds by its own
    // entries (since 0023, on none of the seventeen). Done when 12 gives it
    // the migrating role's membership in requestport_definer.
    const name = `${prefix}_o`;
    const password = randomUUID().replaceAll("-", "");
    await owner.query(
      `create role "${name}" login password '${password}' nosuperuser bypassrls nocreatedb nocreaterole noreplication`,
    );
    made.ownerShaped = { name, url: urlFor(name, password) };
    await owner.query(
      `grant usage on schema public, requestport_private to "${name}"`,
    );
    await owner.query(`grant all on all tables in schema public to "${name}"`);
    const functions = await query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace,
       pg_catalog.aclexplode(p.proacl) a
       where n.nspname = 'requestport_private'
         and a.grantee = (select oid from pg_catalog.pg_roles where rolname = current_user)
         and a.privilege_type = 'EXECUTE'`,
    );
    for (const { fn } of functions) {
      await owner.query(`grant execute on function ${fn} to "${name}"`);
    }
  } finally {
    await owner.query("RESET scram_iterations").catch(() => undefined);
  }
  bound = createWorkerStorages(workerEnv(logins));
});

afterAll(async () => {
  useWorkerStorages(undefined);
  await bound?.close();
  if (!owner) return;
  try {
    for (const login of Object.values(logins ?? {})) {
      await owner.query(`drop owned by "${login.name}"`);
      await owner.query(`drop role if exists "${login.name}"`);
    }
  } finally {
    owner.release();
  }
});

// ---------------------------------------------------------------------------
// Done when 13: the guard's per-storage expectations
// ---------------------------------------------------------------------------

describe.sequential("each storage's role guard (Done when 13, and the report of Done when 15)", () => {
  // Each guard judges `worker` in this process, which has declared `test`:
  // `createWorkerStorages` builds them so, and takes no surface from its
  // caller (ruling 215 item 4).
  test("with the three set, each storage acts as its own login, a member of its group only, and the guard says so", async () => {
    const lines: string[] = [];
    const storages = createWorkerStorages(workerEnv(logins), {
      guard: { write: (line) => lines.push(line) },
    });
    try {
      const reports = await storages.roleReports();
      for (const role of ["dispatcher", "processor", "maintenance"] as const) {
        const finding = reports?.[role].findings.find(
          (item) => item.check === "role",
        );
        expect(reports?.[role].storage, role).toBe(role);
        expect(finding, role).toMatchObject({
          status: "passed",
          surface: "worker",
          role: logins[role].name,
          objections: [],
        });
      }
      // Each line names the mode its check ran in: enforce, the worker's
      // since b5, with no mode handed to the guards (ruling 214 item 2).
      const passed = lines.map((line) => JSON.parse(line));
      expect(
        passed
          .map(({ storage, role, status, mode }) => ({
            storage,
            role,
            status,
            mode,
          }))
          .sort((a, b) => a.storage.localeCompare(b.storage)),
      ).toEqual([
        {
          storage: "dispatcher",
          role: logins.dispatcher.name,
          status: "passed",
          mode: "enforce",
        },
        {
          storage: "maintenance",
          role: logins.maintenance.name,
          status: "passed",
          mode: "enforce",
        },
        {
          storage: "processor",
          role: logins.processor.name,
          status: "passed",
          mode: "enforce",
        },
      ]);
    } finally {
      await storages.close();
    }
  });

  test("in its default modes, with no mode handed to it, it refuses a storage whose login belongs to the wrong worker group", async () => {
    // The dispatcher's variable names the processor's login.
    const storages = createWorkerStorages(
      workerEnv({ ...logins, dispatcher: logins.processor }),
      {
        guard: {
          write: () => undefined,
        },
      },
    );
    try {
      const refusal = await guardRefusal(
        storages.dispatcher.execute(sql`select 1`),
      );
      expect(refusal).toBeInstanceOf(DatabaseRoleGuardError);
      expect(refusal?.finding).toMatchObject({
        status: "refused",
        role: logins.processor.name,
        objections: [
          "not_member_of_requestport_dispatcher",
          "member_of_requestport_tenant_processor",
        ],
      });
      // Its own storages are served.
      await expect(
        storages.maintenance.execute(sql`select 1`),
      ).resolves.toBeDefined();
    } finally {
      await storages.close();
    }
  });

  test("in its default modes, with no mode handed to it, it refuses the owner-shaped login on every storage", async () => {
    const storages = createWorkerStorages(
      workerEnv({
        dispatcher: logins.ownerShaped,
        processor: logins.ownerShaped,
        maintenance: logins.ownerShaped,
      }),
      {
        guard: {
          write: () => undefined,
        },
      },
    );
    try {
      for (const [role, use] of [
        ["dispatcher", () => storages.dispatcher.execute(sql`select 1`)],
        ["maintenance", () => storages.maintenance.execute(sql`select 1`)],
        [
          "processor",
          () => storages.withTenant(randomUUID(), async () => undefined),
        ],
      ] as const) {
        const refusal = await guardRefusal(use());
        expect(refusal, role).toBeInstanceOf(DatabaseRoleGuardError);
        expect(refusal?.finding.objections, role).toEqual(
          expect.arrayContaining([
            "bypassrls",
            `not_member_of_requestport_${role === "processor" ? "tenant_processor" : role}`,
          ]),
        );
      }
    } finally {
      await storages.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Done when 2, through b2's code: an A-bound unit cannot claim, resolve,
// inspect or maintain B
// ---------------------------------------------------------------------------

describe.sequential("a processing unit bound to A (Done when 2, through b2's code)", () => {
  refusingTheRootHandle();
  let a: Tenant;
  let b: Tenant;
  let bOutbox: { outboxId: string; eventId: string };

  beforeAll(async () => {
    a = await seedTenant("a2");
    b = await seedTenant("b2");
    await seedOutboxRow(a);
    bOutbox = await seedOutboxRow(b);
  });

  afterAll(async () => {
    await settleEverything(
      [a?.organizationId, b?.organizationId].filter(
        (id): id is `${string}-${string}-${string}-${string}-${string}` =>
          typeof id === "string",
      ),
    );
  });

  test("is refused every claim, discovery and maintenance function with 42501", async () => {
    await withStorages(bound, async () => {
      const probes: Array<[string, (database: Database) => Promise<unknown>]> =
        [
          [
            "claim_outbox_batch",
            (d) => createOutboxRepository(d).claimBatch(1),
          ],
          [
            "claim_import_dispatch_batch",
            (d) => createImportTaskDispatchRepository(d).claimBatch(1),
          ],
          [
            "accept_outbox_claim",
            (d) =>
              createOutboxRepository(d).acceptClaim(
                bOutbox.outboxId,
                randomUUID(),
                "run_x",
              ),
          ],
          [
            "due_notification_intents",
            (d) => createNotificationRepository(d).dueNotificationIntents(),
          ],
          [
            "due_question_reminders",
            (d) => createNotificationRepository(d).dueQuestionReminders(),
          ],
          [
            "due_webhook_secret_promotions",
            (d) => createWebhookRepository(d).listDueSecretPromotions(),
          ],
          [
            "operational_metrics_snapshot",
            (d) => createOperationalMetricsRepository(d).snapshot(),
          ],
          [
            "outbox_pending_backlog",
            (d) => createOutboxRepository(d).pendingBacklog(),
          ],
          [
            "resolve_job_organization",
            (d) =>
              d.execute(
                sql`select requestport_private.resolve_job_organization('outbox', ${bOutbox.outboxId}::uuid)`,
              ),
          ],
        ];
      for (const [name, probe] of probes) {
        expect(await refusedWith(inUnit(a.organizationId, probe)), name).toBe(
          "42501",
        );
      }
    });
  });

  test("finds B's row missing, and no settlement of it changes anything", async () => {
    await withStorages(bound, async () => {
      const lease: ClaimSettlement = { kind: "lease", leaseId: randomUUID() };
      const seen = await inUnit(a.organizationId, async (database) => {
        const outbox = createOutboxRepository(database);
        return {
          event: await outbox.loadEvent(bOutbox.outboxId),
          standing: await outbox.claimStanding(bOutbox.outboxId, lease),
          completed: await outbox.markCompleted(bOutbox.outboxId, lease),
          dead: await outbox.deadLetter(bOutbox.outboxId, {
            kind: "trigger_run",
            runId: "run_x",
          }),
        };
      });
      expect(seen).toEqual({
        event: null,
        standing: "superseded",
        completed: false,
        dead: false,
      });
      expect(
        await query("select state from public.outbox where id = $1", [
          bOutbox.outboxId,
        ]),
      ).toEqual([{ state: "pending" }]);
    });
  });
});

// ---------------------------------------------------------------------------
// Done when 7: each job and each repair, with the variables set
// ---------------------------------------------------------------------------

describe.sequential("each job and each repair with the variables set, work pending in A and B (Done when 7)", () => {
  refusingTheRootHandle();
  let a: Tenant;
  let b: Tenant;
  const outboxOf = new Map<string, { outboxId: string; eventId: string }>();
  const workOf = new Map<string, Awaited<ReturnType<typeof seedDueWork>>>();
  const dispatchesOf = new Map<
    string,
    {
      analyze: { runId: string; dispatchId: string };
      apply: { runId: string; dispatchId: string };
    }
  >();
  let bucketId: string;

  beforeAll(async () => {
    a = await seedTenant("a7");
    b = await seedTenant("b7");
    for (const t of [a, b]) {
      const row = await seedOutboxRow(t);
      outboxOf.set(t.organizationId, row);
      workOf.set(t.organizationId, await seedDueWork(t, row.eventId));
      dispatchesOf.set(t.organizationId, {
        analyze: await seedDispatch(t, "analyze", "analyzing"),
        apply: await seedDispatch(t, "apply", "applied"),
      });
    }
    const [bucket] = await query<{ id: string }>(
      `insert into public.rate_limit_buckets (environment, endpoint_class, principal_fingerprint, window_started_at, expires_at)
       values ('wjs', 'wjs', $1, now() - interval '2 days', now() - interval '1 day') returning id::text`,
      [`wjs-${randomUUID()}`],
    );
    bucketId = (bucket as { id: string }).id;
    useWorkerStorages(bound);
  });

  afterAll(async () => {
    useWorkerStorages(undefined);
    await settleEverything(
      [a?.organizationId, b?.organizationId].filter(
        (id): id is `${string}-${string}-${string}-${string}-${string}` =>
          typeof id === "string",
      ),
    );
  });

  const both = () => [a, b];
  const work = (t: Tenant) =>
    workOf.get(t.organizationId) as Awaited<ReturnType<typeof seedDueWork>>;

  test("the repairs discover A's and B's due work through the dispatcher, and start each", async () => {
    const runner = recorder();
    await repairNotificationDeliveries(runner);
    await repairWebhookDeliveries(runner);
    await repairSlackMessageUpdates(runner);
    await repairSlackConnectionTests(runner);
    for (const t of both()) {
      const w = work(t);
      expect(runner.enqueued, t.label).toEqual(
        expect.arrayContaining([
          ["email-delivery", { intentId: w.emailIntentId }],
          ["slack-question-delivery", { intentId: w.slackIntentId }],
          ["webhook-delivery", { deliveryId: w.deliveryId }],
          ["slack-message-update", { operationId: w.updateId }],
          ["slack-connection-test", { operationId: w.testId }],
        ]),
      );
    }
  });

  test("outbox-delivery: claimed as the dispatcher, routed and completed in each row's own organisation", async () => {
    const claimed = await createOutboxRepository(bound.dispatcher).claimBatch(
      10,
    );
    const runner = recorder();
    for (const t of both()) {
      const { outboxId } = outboxOf.get(t.organizationId) as {
        outboxId: string;
      };
      const row = claimed.find((item) => item.id === outboxId);
      expect(row?.organizationId, t.label).toBe(t.organizationId);
      await expect(
        deliverOutboxEvent(outboxId, runner, {
          kind: "lease",
          leaseId: row?.leaseId as string,
        }),
      ).resolves.toMatchObject({ status: "routed" });
      expect(
        await query("select state from public.outbox where id = $1", [
          outboxId,
        ]),
      ).toEqual([{ state: "completed" }]);
      // Its webhook delivery is its own organisation's, for its own
      // subscription.
      const deliveries = await query<{ organization_id: string; id: string }>(
        `select organization_id, id::text from public.webhook_deliveries
         where event_id = $1 and subscription_id = $2`,
        [
          (outboxOf.get(t.organizationId) as { eventId: string }).eventId,
          t.subscriptionId,
        ],
      );
      expect(deliveries.map((row) => row.organization_id)).toContain(
        t.organizationId,
      );
    }
    for (const leftover of claimed.filter(
      (item) =>
        ![a, b].some(
          (t) =>
            (outboxOf.get(t.organizationId) as { outboxId: string })
              .outboxId === item.id,
        ),
    )) {
      await createOutboxRepository(bound.dispatcher).releaseClaim(
        leftover.id,
        leftover.leaseId,
        false,
        1_000,
      );
    }
  });

  test("webhook-delivery: the attempt is recorded in the delivery's organisation, and B's is untouched", async () => {
    const delivery = work(a).deliveryId;
    await expect(
      runWebhookDelivery({ deliveryId: delivery }, recorder()),
    ).rejects.toThrow();
    expect(
      await query(
        `select d.status, count(t.id)::int as attempts, bool_and(t.finished_at is not null) as finished
         from public.webhook_deliveries d join public.webhook_attempts t on t.delivery_id = d.id
         where d.id = $1 group by d.status`,
        [delivery],
      ),
    ).toEqual([{ status: "retry", attempts: 1, finished: true }]);
    expect(
      await query(
        "select status, (select count(*)::int from public.webhook_attempts where delivery_id = $1) as attempts from public.webhook_deliveries where id = $1",
        [work(b).deliveryId],
      ),
    ).toEqual([{ status: "pending", attempts: 0 }]);
  });

  test("email-delivery and slack-question-delivery: each intent is claimed and settled in its own organisation", async () => {
    // Neither seeded intent is deliverable, so each is claimed and then
    // suppressed: both writes in A's own units.
    await expect(
      runEmailDelivery({ intentId: work(a).emailIntentId }),
    ).resolves.toEqual({ status: "suppressed" });
    await expect(
      runSlackQuestionDelivery({ intentId: work(a).slackIntentId }, recorder()),
    ).resolves.toEqual({ status: "suppressed" });
    const intents = await query<{
      id: string;
      status: string;
      attempt_count: number;
    }>(
      `select id::text, status, attempt_count from public.notification_intents where id = any($1::uuid[]) order by id`,
      [
        [
          work(a).emailIntentId,
          work(a).slackIntentId,
          work(b).emailIntentId,
          work(b).slackIntentId,
        ],
      ],
    );
    const statusOf = (id: string) => intents.find((row) => row.id === id);
    expect(statusOf(work(a).emailIntentId)).toMatchObject({
      status: "suppressed",
      attempt_count: 1,
    });
    expect(statusOf(work(a).slackIntentId)).toMatchObject({
      status: "suppressed",
      attempt_count: 1,
    });
    expect(statusOf(work(b).emailIntentId)).toMatchObject({
      status: "pending",
      attempt_count: 0,
    });
    expect(statusOf(work(b).slackIntentId)).toMatchObject({
      status: "pending",
      attempt_count: 0,
    });
  });

  test("slack-message-update and slack-connection-test: each operation is claimed and failed in its own organisation", async () => {
    await expect(
      runSlackMessageUpdate({ operationId: work(a).updateId }, recorder()),
    ).rejects.toThrow();
    await expect(
      runSlackConnectionTest({ operationId: work(a).testId }, recorder()),
    ).rejects.toThrow();
    const operations = await query<{
      id: string;
      status: string;
      attempt_count: number;
    }>(
      `select id::text, status, attempt_count from public.slack_delivery_operations where id = any($1::uuid[])`,
      [[work(a).updateId, work(a).testId, work(b).updateId, work(b).testId]],
    );
    for (const id of [work(a).updateId, work(a).testId]) {
      expect(operations.find((row) => row.id === id)).toMatchObject({
        status: "retry",
        attempt_count: 1,
      });
    }
    for (const id of [work(b).updateId, work(b).testId]) {
      expect(operations.find((row) => row.id === id)).toMatchObject({
        status: "pending",
        attempt_count: 0,
      });
    }
  });

  test("legacy-import-analyze and -apply: claimed as the dispatcher, each settled under its lease in its own organisation", async () => {
    const claimed = await createImportTaskDispatchRepository(
      bound.dispatcher,
    ).claimBatch(10, 600);
    const runner = recorder();
    for (const t of both()) {
      const { analyze, apply } = dispatchesOf.get(t.organizationId) as {
        analyze: { runId: string; dispatchId: string };
        apply: { runId: string; dispatchId: string };
      };
      const lease = (id: string): LeaseSettlement => ({
        kind: "lease",
        leaseId: claimed.find((row) => row.id === id)?.leaseId as string,
      });
      const analyzeRow = claimed.find((row) => row.id === analyze.dispatchId);
      expect(analyzeRow?.organizationId, t.label).toBe(t.organizationId);
      await expect(
        runImportAnalyze(
          { dispatchId: analyze.dispatchId, attemptCount: 1 },
          lease(analyze.dispatchId),
        ),
      ).resolves.toMatchObject({ status: "completed", entries: 1 });
      await expect(
        runImportApply(
          { dispatchId: apply.dispatchId, attemptCount: 1 },
          runner,
          lease(apply.dispatchId),
        ),
      ).resolves.toEqual({ status: "suppressed" });
      expect(
        await query(
          `select r.state as run, (select count(*)::int from public.import_manifest_entries e where e.import_run_id = r.id and e.organization_id = $2) as entries
           from public.import_runs r where r.id = $1`,
          [analyze.runId, t.organizationId],
        ),
      ).toEqual([{ run: "reviewing", entries: 1 }]);
      expect(
        await query(
          "select id::text, state from public.import_task_dispatches where id = any($1::uuid[]) order by id",
          [[analyze.dispatchId, apply.dispatchId].sort()],
        ),
      ).toEqual(
        [analyze.dispatchId, apply.dispatchId]
          .sort()
          .map((id) => ({ id, state: "completed" })),
      );
    }
  });

  test("legacy-import-apply: an approved run's entries applied by command units bound to its organisation, its events handed on with it", async () => {
    const runId = randomUUID();
    const dispatchId = randomUUID();
    const skipped = randomUUID();
    const messaged = randomUUID();
    const manifestSha256 = "d".repeat(64);
    await seed([
      [
        `insert into public.import_runs (id, organization_id, import_source_id, source_snapshot_id, requested_by_type, requested_by_id, parser_version, state, manifest_sha256)
         values ($1, $2, $3, $4, 'user', $5, 'v1', 'approved', $6)`,
        [
          runId,
          a.organizationId,
          a.sourceId,
          a.snapshotId,
          a.userId,
          manifestSha256,
        ],
      ],
      [
        `insert into public.import_manifest_entries (id, import_run_id, source_artifact_id, record_index, proposed_kind, parsed_json, organization_id, decision, proposed_canonical_id)
         values ($1, $3, $4, 10, 'request', '{"kind":"request","bodyMarkdown":"Skipped."}', $5, 'skip', null),
                ($2, $3, $4, 11, 'request', '{"kind":"request","bodyMarkdown":"Carried over."}', $5, 'message', $6)`,
        [skipped, messaged, runId, a.artifactId, a.organizationId, a.requestId],
      ],
      [
        `insert into public.import_task_dispatches (id, organization_id, import_run_id, task_kind, task_payload, state, updated_at)
         values ($1, $2, $3, 'apply', $4, 'pending', $5)`,
        [
          dispatchId,
          a.organizationId,
          runId,
          JSON.stringify({
            kind: "apply",
            organizationId: a.organizationId,
            runId,
            manifestSha256,
            actor: { type: "user", id: a.userId },
          }),
          old(),
        ],
      ],
    ]);
    const claimed = (
      await createImportTaskDispatchRepository(bound.dispatcher).claimBatch(
        10,
        600,
      )
    ).find((row) => row.id === dispatchId);
    expect(claimed?.organizationId).toBe(a.organizationId);
    const runner = recorder();

    await expect(
      runImportApply({ dispatchId, attemptCount: 1 }, runner, {
        kind: "lease",
        leaseId: claimed?.leaseId as string,
      }),
    ).resolves.toMatchObject({
      alreadyApplied: false,
      counts: { messages: 1, skipped: 1 },
    });
    expect(
      await query(
        `select r.state as run,
           (select array_agg(e.outcome order by e.outcome) from public.import_entry_applications e where e.import_run_id = r.id and e.organization_id = $2) as outcomes,
           (select count(*)::int from public.messages m where m.request_id = $3 and m.organization_id = $2) as messages,
           (select state from public.import_task_dispatches where id = $4) as dispatch
         from public.import_runs r where r.id = $1`,
        [runId, a.organizationId, a.requestId, dispatchId],
      ),
    ).toEqual([
      {
        run: "applied",
        outcomes: ["message", "skipped"],
        messages: 1,
        dispatch: "completed",
      },
    ]);
    // Each committed event's outbox row was handed to the runner, bound to
    // the run's organisation.
    expect(runner.dispatched.length).toBeGreaterThan(0);
    expect(
      new Set(runner.dispatched.map(([, organization]) => organization)),
    ).toEqual(new Set([a.organizationId]));
  });

  // The seeded sessions are stale with their grace run out, so the sweep
  // abandons them. A lease-expired live session is not seeded: its command
  // is refused before any write, today as before b2 (the track log, "b2, the
  // packages/jobs and trigger half").
  test("stale-work-sessions: each grace-expired session is abandoned by a command bound to its own organisation", async () => {
    await sweepStaleWorkSessions();
    for (const t of both()) {
      expect(
        await query("select state from public.work_sessions where id = $1", [
          work(t).sessionId,
        ]),
        t.label,
      ).toEqual([{ state: "abandoned" }]);
      expect(
        await query(
          `select organization_id from public.domain_events where aggregate_id = $1 and type = 'work.session_abandoned.v1'`,
          [work(t).sessionId],
        ),
      ).toEqual([{ organization_id: t.organizationId }]);
    }
  });

  test("question-reminders: discovered as the dispatcher, each escalation created in its question's organisation", async () => {
    const runner = recorder();
    await sendQuestionReminders(runner);
    for (const t of both()) {
      const intents = await query<{
        id: string;
        organization_id: string;
        recipient_user_id: string;
      }>(
        `select id::text, organization_id, recipient_user_id from public.notification_intents where question_id = $1`,
        [work(t).questionId],
      );
      expect(intents.length, t.label).toBeGreaterThan(0);
      for (const intent of intents) {
        expect(intent).toMatchObject({
          organization_id: t.organizationId,
          recipient_user_id: t.userId,
        });
        expect(runner.enqueued.map(([, payload]) => payload)).toContainEqual({
          intentId: intent.id,
        });
      }
    }
  });

  test("webhook-secret-rotation: each staged secret is promoted in its own organisation", async () => {
    await rotateWebhookSecrets();
    for (const t of both()) {
      expect(
        await query(
          `select current_secret_key_id, next_secret_key_id from public.webhook_subscriptions where id = $1 and organization_id = $2`,
          [work(t).promotedId, t.organizationId],
        ),
        t.label,
      ).toEqual([
        { current_secret_key_id: "k-next", next_secret_key_id: null },
      ]);
    }
  });

  test("operational-metrics and retention-cleanup run as the maintenance login", async () => {
    await expect(recordOperationalMetrics()).resolves.toEqual({
      status: "recorded",
      count: 8,
    });
    const { categories } = await cleanUpRetention();
    expect(categories.map((result) => result.category)).toHaveLength(9);
    expect(
      await query("select id from public.rate_limit_buckets where id = $1", [
        bucketId,
      ]),
    ).toEqual([]);
  });

  test("a B row carried into an A-bound transaction is found missing, not processed", async () => {
    // A processing bug: every row resolved to A.
    const carried: WorkerStorages = {
      ...bound,
      resolveJobOrganization: async () => a.organizationId,
      withTenant: bound.withTenant,
    };
    const fresh = await seedOutboxRow(b);
    const w = await seedDueWork(b, fresh.eventId);
    const dispatch = await seedDispatch(b, "analyze", "analyzing");
    await withStorages(carried, async () => {
      const runner = recorder();
      await expect(
        deliverOutboxEvent(fresh.outboxId, runner, {
          kind: "lease",
          leaseId: randomUUID(),
        }),
      ).resolves.toEqual({ status: "superseded" });
      await expect(
        runWebhookDelivery({ deliveryId: w.deliveryId }, runner),
      ).resolves.toEqual({ status: "suppressed" });
      await expect(
        runEmailDelivery({ intentId: w.emailIntentId }),
      ).resolves.toEqual({ status: "not_due" });
      await expect(
        runSlackQuestionDelivery({ intentId: w.slackIntentId }, runner),
      ).resolves.toEqual({ status: "not_due" });
      await expect(
        runSlackMessageUpdate({ operationId: w.updateId }, runner),
      ).resolves.toEqual({ status: "suppressed" });
      await expect(
        runImportAnalyze(
          { dispatchId: dispatch.dispatchId, attemptCount: 1 },
          { kind: "lease", leaseId: randomUUID() },
        ),
      ).resolves.toEqual({ status: "superseded" });
      expect(runner.enqueued).toEqual([]);
    });
    expect(
      await query(
        `select
           (select state from public.outbox where id = $1) as outbox,
           (select status from public.webhook_deliveries where id = $2) as delivery,
           (select status from public.notification_intents where id = $3) as email,
           (select status from public.notification_intents where id = $4) as slack,
           (select status from public.slack_delivery_operations where id = $5) as operation,
           (select state from public.import_task_dispatches where id = $6) as dispatch`,
        [
          fresh.outboxId,
          w.deliveryId,
          w.emailIntentId,
          w.slackIntentId,
          w.updateId,
          dispatch.dispatchId,
        ],
      ),
    ).toEqual([
      {
        outbox: "pending",
        delivery: "pending",
        email: "pending",
        slack: "pending",
        operation: "pending",
        dispatch: "pending",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Done when 4: the stale body, through both pollers; the early run
// ---------------------------------------------------------------------------

describe.sequential("settlement through the pollers and the bodies (Done when 4)", () => {
  refusingTheRootHandle();
  let a: Tenant;

  beforeAll(async () => {
    a = await seedTenant("a4");
    useWorkerStorages(bound);
  });

  afterAll(async () => {
    useWorkerStorages(undefined);
    await settleEverything(a ? [a.organizationId] : []);
  });

  const expireLease = (
    table: "outbox" | "import_task_dispatches",
    id: string,
  ) =>
    query(
      `update public.${table} set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
      [id],
    );

  test.each(["completes", "dead-letters"] as const)(
    "outbox poller: a body held past its timeout, released after the row is claimed again, %s nothing; only the second claim settles",
    async (arm) => {
      const { outboxId } = await seedOutboxRow(a);
      const dispatcher = createOutboxRepository(bound.dispatcher);
      const release = gate();
      let staleResult: boolean | undefined;
      const first = createOutboxPoller({
        repository: dispatcher,
        deliver: async (id, settlement) => {
          await release.opened;
          staleResult = await inUnit(a.organizationId, (database) =>
            arm === "completes"
              ? createOutboxRepository(database).markCompleted(id, settlement)
              : createOutboxRepository(database).deadLetter(id, settlement),
          );
        },
        batchSize: 1,
        leaseMs: 60_000,
        jobTimeoutMs: 200,
      });
      await expect(first.drainOnce()).resolves.toMatchObject({
        claimed: 1,
        timedOut: 1,
      });
      await expireLease("outbox", outboxId);

      // The second claim takes the same row under a new lease. Before its
      // body settles, the first body is released, and settles nothing.
      const leases: string[] = [];
      const second = createOutboxPoller({
        repository: dispatcher,
        deliver: async (id, settlement) => {
          leases.push(settlement.leaseId);
          release.open();
          await expect.poll(() => staleResult, { timeout: 20_000 }).toBe(false);
          expect(
            await query(
              "select state, lease_owner from public.outbox where id = $1",
              [id],
            ),
          ).toEqual([{ state: "leased", lease_owner: settlement.leaseId }]);
          return deliverOutboxEvent(id, recorder(), settlement);
        },
        batchSize: 1,
        // Room for a loaded host: the first body settles inside this one.
        leaseMs: 180_000,
        jobTimeoutMs: 60_000,
      });
      await expect(second.drainOnce()).resolves.toMatchObject({
        claimed: 1,
        routed: 1,
      });
      expect(leases).toHaveLength(1);
      expect(staleResult).toBe(false);
      expect(
        await query(
          "select state, attempt_count, lease_owner from public.outbox where id = $1",
          [outboxId],
        ),
      ).toEqual([{ state: "completed", attempt_count: 2, lease_owner: null }]);
    },
    90_000,
  );

  test("import poller: a body held past its timeout settles nothing, before and after the re-claim; only the second claim completes", async () => {
    const { dispatchId } = await seedDispatch(a, "analyze", "analyzing");
    const dispatcher = createImportTaskDispatchRepository(bound.dispatcher);
    const released = [gate(), gate()];
    const staleResults: boolean[] = [];
    const heldAnalyze = async (
      payload: JobPayloads["legacy-import-analyze"],
      settlement: ClaimSettlement,
    ) => {
      for (const step of released) {
        await step.opened;
        staleResults.push(
          await inUnit(a.organizationId, (database) =>
            createImportTaskDispatchRepository(database).markCompleted(
              payload.dispatchId,
              payload.attemptCount,
              settlement,
            ),
          ),
        );
      }
    };
    const first = createImportDispatchPoller({
      repository: dispatcher,
      handlers: {
        "legacy-import-analyze": heldAnalyze,
        "legacy-import-apply": async () => undefined,
      },
      batchSize: 1,
      leaseMs: 600_000,
      jobTimeoutMs: 200,
    });
    await expect(first.drainOnce()).resolves.toMatchObject({
      claimed: 1,
      timedOut: 1,
    });
    await expireLease("import_task_dispatches", dispatchId);
    // Before the re-claim: the lease has run out, and the settlement is refused.
    (released[0] as ReturnType<typeof gate>).open();
    await expect.poll(() => staleResults.length, { timeout: 20_000 }).toBe(1);
    expect(staleResults[0]).toBe(false);

    let secondRan: unknown;
    const second = createImportDispatchPoller({
      repository: dispatcher,
      handlers: {
        "legacy-import-analyze": async (payload, settlement) => {
          // After the re-claim, and before the second settles: refused again.
          (released[1] as ReturnType<typeof gate>).open();
          await expect
            .poll(() => staleResults.length, { timeout: 20_000 })
            .toBe(2);
          secondRan = await runImportAnalyze(payload, settlement);
        },
        "legacy-import-apply": async () => undefined,
      },
      batchSize: 1,
      leaseMs: 600_000,
      jobTimeoutMs: 60_000,
    });
    await expect(second.drainOnce()).resolves.toMatchObject({
      claimed: 1,
      ran: 1,
    });
    expect(staleResults).toEqual([false, false]);
    expect(secondRan).toMatchObject({ status: "completed" });
    expect(
      await query(
        "select state, attempt_count from public.import_task_dispatches where id = $1",
        [dispatchId],
      ),
    ).toEqual([{ state: "completed", attempt_count: 2 }]);
  }, 90_000);

  test("the early run: a trigger_run body started while its row is still leased retries before any effect, and completes once accepted", async () => {
    const { outboxId } = await seedOutboxRow(a);
    const dispatcher = createOutboxRepository(bound.dispatcher);
    const claimed = (await dispatcher.claimBatch(1)).find(
      (row) => row.id === outboxId,
    );
    expect(claimed).toBeDefined();
    const runId = `run_${randomUUID()}`;
    const run: ClaimSettlement = { kind: "trigger_run", runId };
    const runner = recorder();

    await expect(
      deliverOutboxEvent(outboxId, runner, run),
    ).rejects.toBeInstanceOf(SettlementPendingError);
    expect(runner.enqueued).toEqual([]);
    expect(
      await query(
        "select count(*)::int as deliveries from public.webhook_deliveries where event_id = (select event_id from public.outbox where id = $1)",
        [outboxId],
      ),
    ).toEqual([{ deliveries: 0 }]);

    await expect(
      dispatcher.acceptClaim(outboxId, claimed?.leaseId as string, runId),
    ).resolves.toBe(true);
    await expect(
      deliverOutboxEvent(outboxId, runner, run),
    ).resolves.toMatchObject({
      status: "routed",
    });
    expect(
      await query("select state from public.outbox where id = $1", [outboxId]),
    ).toEqual([{ state: "completed" }]);
  });
});

// ---------------------------------------------------------------------------
// Done when 11: a run of the pre-b2 shape
// ---------------------------------------------------------------------------

describe.sequential("a run enqueued by the pre-b2 shape, with only an id (Done when 11)", () => {
  refusingTheRootHandle();
  let a: Tenant;

  beforeAll(async () => {
    a = await seedTenant("a11");
  });

  afterAll(async () => {
    await settleEverything(a ? [a.organizationId] : []);
  });

  test("resolves its organisation and completes under the run id the old acceptance recorded", async () => {
    const { outboxId } = await seedOutboxRow(a);
    const { dispatchId, runId } = await seedDispatch(a, "analyze", "analyzing");
    // The pre-b2 dispatcher: claimOne and markAccepted by id, under an owner
    // string, recording the run id trigger() returned — as the web does.
    const owned = createOutboxRepository(owner.db);
    const ownedDispatches = createImportTaskDispatchRepository(owner.db);
    const ownerString = `web:${randomUUID()}`;
    expect(await owned.claimOne(outboxId, ownerString)).not.toBeNull();
    expect(
      await owned.markAccepted(outboxId, ownerString, "run_pre_b2_outbox"),
    ).toBe(true);
    const claimedDispatch = await ownedDispatches.claimOne(
      dispatchId,
      ownerString,
    );
    expect(claimedDispatch?.attemptCount).toBe(1);
    expect(
      await ownedDispatches.markAccepted(
        dispatchId,
        ownerString,
        "run_pre_b2_import",
      ),
    ).toBe(true);

    await withStorages(bound, async () => {
      // The payloads are the pre-b2 ones; the settlement is the run's own id.
      await expect(
        deliverOutboxEvent(outboxId, recorder(), {
          kind: "trigger_run",
          runId: "run_pre_b2_outbox",
        }),
      ).resolves.toMatchObject({ status: "routed" });
      await expect(
        runImportAnalyze(
          { dispatchId, attemptCount: 1 },
          { kind: "trigger_run", runId: "run_pre_b2_import" },
        ),
      ).resolves.toMatchObject({ status: "completed", runId });
    });
    expect(
      await query(
        `select (select state from public.outbox where id = $1) as outbox,
                (select state from public.import_task_dispatches where id = $2) as dispatch`,
        [outboxId, dispatchId],
      ),
    ).toEqual([{ outbox: "completed", dispatch: "completed" }]);
  });
});

// ---------------------------------------------------------------------------
// Done when 12: the owner-shaped lane, after b5's contract (0023)
// ---------------------------------------------------------------------------

/*
 * §5.1's 1-17, each with its group and a call its group's login is served
 * with: random ids, a bound of one, one retention category. Every call is
 * made in a transaction that is rolled back, so a call that is allowed
 * changes nothing.
 */
const WORKER_FUNCTION_CALLS: ReadonlyArray<
  [name: string, group: string, call: string]
> = [
  [
    "claim_outbox_batch",
    DISPATCHER,
    "select * from requestport_private.claim_outbox_batch(1, 10)",
  ],
  [
    "accept_outbox_claim",
    DISPATCHER,
    "select requestport_private.accept_outbox_claim(gen_random_uuid(), gen_random_uuid(), 'run_owner_shaped')",
  ],
  [
    "release_outbox_claim",
    DISPATCHER,
    "select requestport_private.release_outbox_claim(gen_random_uuid(), gen_random_uuid(), false, 0)",
  ],
  [
    "claim_import_dispatch_batch",
    DISPATCHER,
    "select * from requestport_private.claim_import_dispatch_batch(1, 10)",
  ],
  [
    "accept_import_dispatch_claim",
    DISPATCHER,
    "select requestport_private.accept_import_dispatch_claim(gen_random_uuid(), gen_random_uuid(), 'run_owner_shaped')",
  ],
  [
    "due_notification_intents",
    DISPATCHER,
    "select * from requestport_private.due_notification_intents(1)",
  ],
  [
    "pending_webhook_deliveries",
    DISPATCHER,
    "select * from requestport_private.pending_webhook_deliveries(1)",
  ],
  [
    "due_slack_message_updates",
    DISPATCHER,
    "select * from requestport_private.due_slack_message_updates(1)",
  ],
  [
    "due_slack_connection_tests",
    DISPATCHER,
    "select * from requestport_private.due_slack_connection_tests(1)",
  ],
  [
    "lease_expired_work_sessions",
    DISPATCHER,
    "select * from requestport_private.lease_expired_work_sessions(1)",
  ],
  [
    "grace_expired_work_sessions",
    DISPATCHER,
    "select * from requestport_private.grace_expired_work_sessions(1)",
  ],
  [
    "due_webhook_secret_promotions",
    DISPATCHER,
    "select * from requestport_private.due_webhook_secret_promotions(1)",
  ],
  [
    "due_question_reminders",
    DISPATCHER,
    "select * from requestport_private.due_question_reminders(1)",
  ],
  [
    "resolve_job_organization",
    PROCESSOR,
    "select requestport_private.resolve_job_organization('outbox', gen_random_uuid())",
  ],
  [
    "operational_metrics_snapshot",
    MAINTENANCE,
    "select * from requestport_private.operational_metrics_snapshot()",
  ],
  [
    "outbox_pending_backlog",
    MAINTENANCE,
    "select * from requestport_private.outbox_pending_backlog()",
  ],
  [
    "retention_cleanup",
    MAINTENANCE,
    "select * from requestport_private.retention_cleanup('verification', 1)",
  ],
];

/**
 * Each of `calls` made as `login`, in one transaction that is rolled back,
 * each behind a savepoint: "ok", or the failure's SQLSTATE and message.
 */
async function callEachAs(
  login: Login,
  calls: ReadonlyArray<[name: string, group: string, call: string]>,
) {
  const storage = createTestStorage({
    driver: "pg",
    connectionString: login.url,
  });
  const outcomes: Record<string, string> = {};
  try {
    const session = await openSession(storage);
    try {
      await session.query("BEGIN");
      for (const [name, , call] of calls) {
        await session.query("SAVEPOINT probe");
        try {
          await session.query(call);
          outcomes[name] = "ok";
          await session.query("RELEASE SAVEPOINT probe");
        } catch (error) {
          outcomes[name] = `${sqlState(error)} ${(error as Error).message}`;
          await session.query("ROLLBACK TO SAVEPOINT probe");
        }
      }
    } finally {
      await session.query("ROLLBACK").catch(() => undefined);
      session.release();
    }
  } finally {
    await storage.close();
  }
  return outcomes;
}

describe.sequential("the owner-shaped lane after b5's contract: a NOSUPERUSER BYPASSRLS login in requestport_definer, as 0019 makes the migrating role, is refused each of the seventeen, and each group's login is allowed its own (Done when 12)", () => {
  refusingTheRootHandle();

  beforeAll(async () => {
    // Production's owner, the migrating role, holds 0019's membership in the
    // functions' owner, WITH INHERIT TRUE and SET TRUE, granted to the
    // migrating role. Without it this login could be refused while
    // production's owner still executed through the owner's own entry
    // (track-i2.md, "I.2b b5, the survey", §(d) finding 2), so the lane
    // could not fail.
    await owner.query(
      `grant requestport_definer to "${logins.ownerShaped.name}" with inherit true, set true`,
    );
  });

  afterAll(async () => {
    await owner.query(
      `revoke requestport_definer from "${logins.ownerShaped.name}"`,
    );
  });

  test("the login is not a superuser, bypasses row security, and is a member of requestport_definer alone, with INHERIT and SET", async () => {
    expect(
      await query(
        `select r.rolsuper, r.rolbypassrls,
           array(select g.rolname::text || ' inherit=' || m.inherit_option || ' set=' || m.set_option
                 from pg_catalog.pg_auth_members m
                 join pg_catalog.pg_roles g on g.oid = m.roleid
                 where m.member = r.oid order by 1) as memberships
         from pg_catalog.pg_roles r where r.rolname = $1`,
        [logins.ownerShaped.name],
      ),
    ).toEqual([
      {
        rolsuper: false,
        rolbypassrls: true,
        memberships: ["requestport_definer inherit=true set=true"],
      },
    ]);
  });

  test("the calls are §5.1's seventeen, each with the one group the catalogue grants it to", async () => {
    // A worker group's functions that the application group may not call:
    // bound_organization_id() and 0021's two locks (18 and 19) are the
    // application's too, and stay out of this contract.
    const granted = await query<{ name: string; grp: string }>(
      `select p.proname::text as name, g.rolname::text as grp
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace,
       pg_catalog.aclexplode(p.proacl) a
       join pg_catalog.pg_roles g on g.oid = a.grantee
       where n.nspname = 'requestport_private' and g.rolname = any($1)
         and not pg_catalog.has_function_privilege('requestport_application', p.oid, 'EXECUTE')`,
      [[DISPATCHER, PROCESSOR, MAINTENANCE]],
    );
    const byName = (x: { name: string }, y: { name: string }) =>
      x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
    expect([...granted].sort(byName)).toEqual(
      WORKER_FUNCTION_CALLS.map(([name, grp]) => ({ name, grp })).sort(byName),
    );
  });

  test("the owner-shaped login is refused each of the seventeen with 42501 by its name, and holds EXECUTE on none", async () => {
    const outcomes = await callEachAs(
      logins.ownerShaped,
      WORKER_FUNCTION_CALLS,
    );
    expect(outcomes).toEqual(
      Object.fromEntries(
        WORKER_FUNCTION_CALLS.map(([name]) => [
          name,
          `42501 permission denied for function ${name}`,
        ]),
      ),
    );
    const executable = await query<{ name: string }>(
      `select p.proname::text as name
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'requestport_private' and p.proname = any($2)
         and pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')`,
      [logins.ownerShaped.name, WORKER_FUNCTION_CALLS.map(([name]) => name)],
    );
    expect(executable).toEqual([]);
  });

  test("each group's login is allowed each of its own", async () => {
    for (const [key, group] of [
      ["dispatcher", DISPATCHER],
      ["processor", PROCESSOR],
      ["maintenance", MAINTENANCE],
    ] as const) {
      const own = WORKER_FUNCTION_CALLS.filter(([, grp]) => grp === group);
      expect(await callEachAs(logins[key], own), group).toEqual(
        Object.fromEntries(own.map(([name]) => [name, "ok"])),
      );
    }
  });
});
