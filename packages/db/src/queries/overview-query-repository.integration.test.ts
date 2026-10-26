import {
  BOOTSTRAP_OWNER_ACTOR,
  bootstrapOwner,
  OrganizationService,
} from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test, vi } from "vitest";

import {
  createStorage,
  selectDriver,
  storageOptionsFromEnv,
} from "../client.js";
import { createFoundationRepository } from "../repositories/foundation-repository.js";
import { projectMembers, projects, user } from "../schema/index.js";
import { bindTenant, tenantWrappingEnabled } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { createOverviewQueryRepository } from "./overview-query-repository.js";
import { createRequestQueryRepository } from "./request-query-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  The console overview's and the agents page's reads (ruling 258): the setup
  checklist, the figures, what needs the person, and each agent's sign-ins.
  Every case seeds a second organisation with rows of every kind the reads
  count, so a figure that leaked across organisations would be wrong here, and
  the two figures that repeat a predicate the request reads already apply —
  open requests and open questions — are compared with those reads.
*/

class TestRollback extends Error {}

/** A health read without the moment it ran, which differs between reads. */
function withoutClock<T extends { checkedAt: Date }>(health: T | null) {
  return health === null ? null : { ...health, checkedAt: undefined };
}

/** The database's clock, in epoch milliseconds, read by the database. */
async function databaseNow(tx: Tx) {
  const { rows } = await tx.execute<{ ms: number | string }>(
    sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as "ms"`,
  );
  return Number(rows[0]?.ms);
}

/**
 * Runs `work` with this process's clock a day ahead of the database's (only
 * `Date` is faked, so timers run as they do), then puts it back: a moment
 * the code took from this process rather than from the database would be a
 * day off.
 *
 * Not on PGlite, which runs inside this process: its `clock_timestamp()`
 * follows this process's `Date` (measured 2026-10-25 with PGlite 0.5.8, a day
 * ahead under the same fake), so there the skew would move both clocks, tell
 * them apart no better, and put the health read a day after the rows this
 * suite seeds. There `work` runs as it is.
 */
async function withProcessClockADayAhead<T>(work: () => Promise<T>) {
  if (selectDriver(process.env) === "pglite") return work();
  vi.useFakeTimers({ now: Date.now() + 86_400_000, toFake: ["Date"] });
  try {
    return await work();
  } finally {
    vi.useRealTimers();
  }
}

/** How many minutes before now a moment was; infinitely many for none. */
function minutesAgo(moment: Date | null | undefined) {
  return moment
    ? (Date.now() - moment.getTime()) / 60_000
    : Number.POSITIVE_INFINITY;
}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
}

afterAll(async () => {
  await suiteStorage.close();
});

type Role = "owner" | "admin" | "member";
type ProjectRole = "maintainer" | "contributor" | "viewer";

async function seedUser(tx: Tx, name: string) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, ${name}, ${email}, now())
  `);
  return userId;
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Overview tenant',
      ${`overview-${organizationId}`}, 'active')
  `);
  return organizationId;
}

async function seedMembership(
  tx: Tx,
  organizationId: string,
  userId: string,
  role: Role,
  status: "active" | "revoked" = "active",
) {
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, ${status})
  `);
}

async function seedProject(
  tx: Tx,
  organizationId: string,
  status: "active" | "archived" = "active",
) {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const [project] = await tx
    .insert(projects)
    .values({
      organizationId,
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      keyPrefix: `P${suffix.toUpperCase()}`,
      status,
    })
    .returning({ id: projects.id, name: projects.name });
  if (!project) throw new Error("no project");
  return project;
}

async function seedProjectRole(
  tx: Tx,
  organizationId: string,
  projectId: string,
  userId: string,
  role: ProjectRole,
) {
  await tx
    .insert(projectMembers)
    .values({ organizationId, projectId, userId, role, status: "active" });
}

let sequence = 0;

async function seedRequest(
  tx: Tx,
  input: {
    organizationId: string;
    targetProjectId: string;
    reporterId: string;
    state: string;
    visibility?: "organization" | "restricted";
    reporterType?: "user" | "agent";
    assignee?: { type: "user" | "agent"; id: string };
    updatedAt?: string;
  },
) {
  const id = crypto.randomUUID();
  sequence += 1;
  const draft = input.state === "draft";
  await tx.execute(sql`
    insert into "requests"
      ("id", "organization_id", "sequence_number", "display_key",
       "source_kind", "target_project_id", "type", "title", "description_md",
       "state", "reporter_type", "reporter_id", "assignee_type", "assignee_id",
       "visibility", "sensitivity", "version", "updated_at")
    values (${id}, ${input.organizationId},
      ${draft ? null : sequence}, ${draft ? null : `OVR-${sequence}`},
      'human_direct', ${input.targetProjectId}, 'feature',
      ${`Request ${sequence} (${input.state})`}, 'Overview fixture.',
      ${input.state}, ${input.reporterType ?? "user"}, ${input.reporterId},
      ${input.assignee?.type ?? null}, ${input.assignee?.id ?? null},
      ${input.visibility ?? "organization"}, 'normal', 1,
      ${input.updatedAt ? sql`now() - ${input.updatedAt}::interval` : sql`now()`})
  `);
  return id;
}

async function seedQuestion(
  tx: Tx,
  input: {
    organizationId: string;
    requestId: string;
    audienceType: "user" | "role" | "requester" | "project_maintainers";
    audienceId?: string | null;
    state?: "open" | "answered" | "closed";
    createdAt?: string;
  },
) {
  const id = crypto.randomUUID();
  const state = input.state ?? "open";
  // A question that is no longer open names who closed it, why and when
  // (`questions_closed_actor_check`).
  const closed = state === "open" ? sql`null` : sql`now()`;
  await tx.execute(sql`
    insert into "questions"
      ("id", "organization_id", "subject_type", "subject_id",
       "parent_request_id", "audience_type", "audience_id", "body_md",
       "asked_by_type", "asked_by_id", "state", "created_at",
       "closed_by_type", "closed_by_id", "closed_reason", "closed_at")
    values (${id}, ${input.organizationId}, 'request', ${input.requestId},
      ${input.requestId}, ${input.audienceType}, ${input.audienceId ?? null},
      'Which one?', 'agent', 'agent-asker', ${state},
      ${input.createdAt ? sql`now() - ${input.createdAt}::interval` : sql`now()`},
      ${state === "open" ? null : "user"},
      ${state === "open" ? null : "fixture-closer"},
      ${state === "open" ? null : "answered"}, ${closed})
  `);
  return id;
}

async function seedPrincipal(
  tx: Tx,
  input: {
    organizationId: string;
    projectId: string | null;
    createdByUserId: string;
    status?: "active" | "suspended" | "revoked";
  },
) {
  const id = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_principals"
      ("id", "organization_id", "project_id", "display_name", "slug",
       "software_name", "status", "created_by_user_id")
    values (${id}, ${input.organizationId}, ${input.projectId},
      ${`Agent ${id.slice(0, 8)}`}, ${`agent-${id}`}, 'Agent software',
      ${input.status ?? "active"}, ${input.createdByUserId})
  `);
  return id;
}

async function seedCredential(
  tx: Tx,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    projectId: string;
    userId: string;
    revoked?: boolean;
    expired?: boolean;
    lastUsed?: string | null;
  },
) {
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, ${input.userId}, ${`plaintext_${apiKeyId}`},
      true, now() + interval '1 hour', now(), now())
  `);
  const id = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_credentials"
      ("id", "organization_id", "agent_principal_id",
       "better_auth_api_key_id", "name", "prefix", "fingerprint", "audience",
       "project_id", "lane_ids", "scopes", "version", "expires_at",
       "revoked_at", "last_used_at", "created_by_user_id")
    values (${id}, ${input.organizationId}, ${input.agentPrincipalId},
      ${apiKeyId}, 'Key', ${`rp_${id.slice(0, 6)}`}, ${`fingerprint_${id}`},
      'mcp', ${input.projectId}, '[]'::jsonb, '["request:read"]'::jsonb, 1,
      ${input.expired ? sql`now() - interval '1 minute'` : sql`now() + interval '30 days'`},
      ${input.revoked ? sql`now()` : sql`null`},
      ${input.lastUsed ? sql`now() - ${input.lastUsed}::interval` : sql`null`},
      ${input.userId})
  `);
  return id;
}

async function seedGrant(
  tx: Tx,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    projectId: string;
    userId: string;
    status?: "active" | "revoked";
    lastUsed?: string;
  },
) {
  const clientId = `client_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_client"
      ("id", "client_id", "name", "redirect_uris", "disabled",
       "token_endpoint_auth_method", "require_pkce")
    values (${clientId}, ${clientId}, 'OAuth client',
      ${sql`array['https://example.invalid/callback']`}, false, 'none', true)
  `);
  const consentId = `consent_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_consent" ("id", "client_id", "user_id", "scopes")
    values (${consentId}, ${clientId}, ${input.userId},
      ${sql`array['request:read']`})
  `);
  const revoked = input.status === "revoked";
  await tx.execute(sql`
    insert into "agent_oauth_grants"
      ("id", "organization_id", "agent_principal_id", "user_id",
       "oauth_client_id", "provider_grant_id", "refresh_family_id",
       "audience", "project_id", "lane_ids", "scopes", "status", "version",
       "expires_at", "revoked_at", "last_used_at")
    values (${crypto.randomUUID()}, ${input.organizationId},
      ${input.agentPrincipalId}, ${input.userId}, ${clientId}, ${consentId},
      ${crypto.randomUUID()}, 'mcp', ${input.projectId}, '[]'::jsonb,
      '["request:read"]'::jsonb, ${revoked ? "revoked" : "active"}, 1,
      now() + interval '30 days', ${revoked ? sql`now()` : sql`null`},
      ${input.lastUsed ? sql`now() - ${input.lastUsed}::interval` : sql`null`})
  `);
}

async function seedInvitation(
  tx: Tx,
  input: {
    organizationId: string;
    createdByUserId: string;
    state: "pending" | "expired" | "revoked" | "accepted";
  },
) {
  const email = `${crypto.randomUUID()}@example.invalid`;
  await tx.execute(sql`
    insert into "invitations"
      ("organization_id", "normalized_email", "role", "token_hash",
       "expires_at", "accepted_at", "revoked_at", "created_by_user_id")
    values (${input.organizationId}, ${email}, 'member',
      ${`hash_${crypto.randomUUID()}`},
      ${input.state === "expired" ? sql`now() - interval '1 minute'` : sql`now() + interval '7 days'`},
      ${input.state === "accepted" ? sql`now()` : sql`null`},
      ${input.state === "revoked" ? sql`now()` : sql`null`},
      ${input.createdByUserId})
  `);
}

async function seedRoutingRule(
  tx: Tx,
  input: {
    organizationId: string;
    targetProjectId: string;
    createdBy: string;
    enabled: boolean;
  },
) {
  await tx.execute(sql`
    insert into "routing_rules"
      ("organization_id", "source_kind", "target_project_id", "decision",
       "specificity", "enabled", "created_by")
    values (${input.organizationId}, 'human_direct', ${input.targetProjectId},
      'allow', 1, ${input.enabled}, ${input.createdBy})
  `);
}

async function seedSubscription(tx: Tx, organizationId: string, name: string) {
  const id = crypto.randomUUID();
  await tx.execute(sql`
    insert into "webhook_subscriptions"
      ("id", "organization_id", "name", "endpoint_url", "status",
       "current_secret_ciphertext", "current_secret_key_id", "created_by")
    values (${id}, ${organizationId}, ${name},
      'https://hooks.example.invalid/requestport', 'pending_verification',
      '{}'::jsonb, 'key-1', 'overview-fixture')
  `);
  return id;
}

/**
 * The event types the fixtures write, each with a payload its registered
 * schema accepts: the activity read parses every event it returns
 * (`publicEventProjection`) and refuses one it cannot.
 */
const fixtureEvents = {
  "integration.webhook_changed.v1": () => ({
    aggregateType: "webhook_subscription",
    data: {
      changeType: "updated",
      status: "active",
      subscriptionId: crypto.randomUUID(),
    },
  }),
  "organization.member_changed.v1": () => ({
    aggregateType: "organization_member",
    data: {
      membershipId: crypto.randomUUID(),
      role: "member",
      status: "active",
    },
  }),
  "project.registered.v1": () => ({
    aggregateType: "project",
    data: {
      keyPrefix: "FIX",
      name: "Fixture project",
      projectId: crypto.randomUUID(),
      slug: "fixture-project",
      status: "active",
    },
  }),
} as const;

type FixtureEventType = keyof typeof fixtureEvents;

/** A domain event of the organisation, with no request, `ago` in the past. */
async function seedEvent(
  tx: Tx,
  input: { organizationId: string; type: FixtureEventType; ago?: string },
) {
  const id = crypto.randomUUID();
  const event = fixtureEvents[input.type]();
  await tx.execute(sql`
    insert into "domain_events"
      ("id", "organization_id", "aggregate_type", "aggregate_id",
       "aggregate_version", "type", "schema_version", "occurred_at", "actor",
       "correlation_id", "causation_id", "data", "links")
    values (${id}, ${input.organizationId}, ${event.aggregateType},
      ${crypto.randomUUID()}, 1, ${input.type}, 1,
      ${input.ago ? sql`now() - ${input.ago}::interval` : sql`now()`},
      '{"type":"user","id":"fixture"}'::jsonb, ${crypto.randomUUID()},
      ${crypto.randomUUID()}, ${JSON.stringify(event.data)}::jsonb,
      '{}'::jsonb)
  `);
  return id;
}

async function seedDelivery(
  tx: Tx,
  input: {
    organizationId: string;
    subscriptionId: string;
    status: "dead_letter" | "delivered" | "retry";
    finished?: string;
    eventType?: FixtureEventType;
  },
) {
  const eventId = await seedEvent(tx, {
    organizationId: input.organizationId,
    type: input.eventType ?? "integration.webhook_changed.v1",
  });
  const id = crypto.randomUUID();
  const finished = input.finished
    ? sql`now() - ${input.finished}::interval`
    : sql`now()`;
  await tx.execute(sql`
    insert into "webhook_deliveries"
      ("id", "organization_id", "subscription_id", "event_id", "status",
       "created_at", "completed_at")
    values (${id}, ${input.organizationId}, ${input.subscriptionId}, ${eventId},
      ${input.status}, ${finished},
      ${input.status === "retry" ? sql`null` : finished})
  `);
  return id;
}

/** A replay of a delivery: the same subscription and event, the next number. */
async function seedReplay(
  tx: Tx,
  input: {
    organizationId: string;
    deliveryId: string;
    replayNumber: number;
    status: "dead_letter" | "delivered" | "retry";
    finished: string;
  },
) {
  const id = crypto.randomUUID();
  const finished = sql`now() - ${input.finished}::interval`;
  await tx.execute(sql`
    insert into "webhook_deliveries"
      ("id", "organization_id", "subscription_id", "event_id",
       "replay_number", "status", "created_at", "completed_at")
    select ${id}, "organization_id", "subscription_id", "event_id",
      ${input.replayNumber}, ${input.status}, ${finished},
      ${input.status === "retry" ? sql`null` : finished}
    from "webhook_deliveries"
    where "organization_id" = ${input.organizationId}
      and "id" = ${input.deliveryId}
  `);
  return id;
}

/**
 * An outbox row for a new event of the organisation, the event and the row
 * both written `written` ago. `dispatched` is when the dispatcher handed it
 * to the worker (`accepted_at`), and `settled` when its state last changed
 * (`updated_at`, which a dead letter's settlement writes).
 */
async function seedOutbox(
  tx: Tx,
  input: {
    organizationId: string;
    state: "pending" | "leased" | "accepted" | "completed" | "dead_letter";
    written: string;
    dispatched?: string;
    settled?: string;
  },
) {
  const eventId = await seedEvent(tx, {
    organizationId: input.organizationId,
    type: "project.registered.v1",
    ago: input.written,
  });
  const leased = input.state === "leased";
  await tx.execute(sql`
    insert into "outbox"
      ("event_id", "state", "lease_owner", "lease_expires_at", "accepted_at",
       "created_at", "updated_at")
    values (${eventId}, ${input.state}, ${leased ? "overview-fixture" : null},
      ${leased ? sql`now() + interval '1 minute'` : sql`null`},
      ${input.dispatched ? sql`now() - ${input.dispatched}::interval` : sql`null`},
      now() - ${input.written}::interval,
      now() - ${input.settled ?? input.written}::interval)
  `);
}

/**
 * A work session on the agent. A session references an installation, a
 * machine workspace and a request, none of which these reads look at, so the
 * row is written with foreign keys off for the one statement, as
 * worker-row-security.integration.test.ts seeds its sessions; each session
 * gets a request id of its own, which the live-claim unique index requires.
 */
async function seedWorkSession(
  tx: Tx,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    state: "claimed" | "active" | "paused" | "blocked" | "stale" | "ended";
    leaseExpired?: boolean;
  },
) {
  const lease = input.leaseExpired
    ? sql`now() - interval '1 minute'`
    : sql`now() + interval '10 minutes'`;
  await tx.execute(sql`set local session_replication_role = replica`);
  await tx.execute(sql`
    insert into "work_sessions"
      ("id", "organization_id", "request_id", "agent_principal_id",
       "installation_id", "workspace_id", "authorization_chain",
       "credential_fingerprint", "state", "heartbeat_interval_seconds",
       "lease_expires_at", "grace_expires_at", "ended_at", "ended_reason")
    values (${crypto.randomUUID()}, ${input.organizationId},
      ${crypto.randomUUID()}, ${input.agentPrincipalId}, ${crypto.randomUUID()},
      ${crypto.randomUUID()}, '{}'::jsonb, 'overview-fixture', ${input.state},
      30, ${lease}, now() + interval '1 hour',
      ${input.state === "ended" ? sql`now()` : sql`null`},
      ${input.state === "ended" ? "completed" : null})
  `);
  await tx.execute(sql`set local session_replication_role = origin`);
}

/** An organisation whose every table the reads count holds something. */
async function seedPopulatedOrganization(tx: Tx) {
  const organizationId = await seedOrganization(tx);
  const owner = await seedUser(tx, "Owner Person");
  const member = await seedUser(tx, "Member Person");
  await seedMembership(tx, organizationId, owner, "owner");
  await seedMembership(tx, organizationId, member, "member");
  const shared = await seedProject(tx, organizationId);
  const closed = await seedProject(tx, organizationId);
  // The member maintains `shared` and belongs to nothing else.
  await seedProjectRole(tx, organizationId, shared.id, member, "maintainer");

  const requests = {
    submittedShared: await seedRequest(tx, {
      organizationId,
      targetProjectId: shared.id,
      reporterId: owner,
      state: "submitted",
      updatedAt: "3 minutes",
    }),
    triageClosed: await seedRequest(tx, {
      organizationId,
      targetProjectId: closed.id,
      reporterId: owner,
      state: "triage",
      visibility: "restricted",
      updatedAt: "2 minutes",
    }),
    triageClosedPublic: await seedRequest(tx, {
      organizationId,
      targetProjectId: closed.id,
      reporterId: owner,
      state: "triage",
      updatedAt: "1 minute",
    }),
    inProgressRestrictedClosed: await seedRequest(tx, {
      organizationId,
      targetProjectId: closed.id,
      reporterId: owner,
      state: "in_progress",
      visibility: "restricted",
    }),
    inProgressRestrictedShared: await seedRequest(tx, {
      organizationId,
      targetProjectId: shared.id,
      reporterId: owner,
      state: "in_progress",
      visibility: "restricted",
    }),
    reportedByMemberRestricted: await seedRequest(tx, {
      organizationId,
      targetProjectId: closed.id,
      reporterId: member,
      state: "accepted",
      visibility: "restricted",
    }),
    assignedToMemberRestricted: await seedRequest(tx, {
      organizationId,
      targetProjectId: closed.id,
      reporterId: owner,
      state: "planned",
      visibility: "restricted",
      assignee: { type: "user", id: member },
    }),
  };
  for (const state of [
    "draft",
    "completed",
    "verified",
    "declined",
    "duplicate",
    "superseded",
    "cancelled",
  ]) {
    await seedRequest(tx, {
      organizationId,
      targetProjectId: shared.id,
      reporterId: owner,
      state,
    });
  }

  // Questions: one per audience shape, from both people's side.
  await seedQuestion(tx, {
    organizationId,
    requestId: requests.submittedShared,
    audienceType: "user",
    audienceId: member,
    createdAt: "2 hours",
  });
  await seedQuestion(tx, {
    organizationId,
    requestId: requests.submittedShared,
    audienceType: "user",
    audienceId: owner,
    createdAt: "30 minutes",
  });
  await seedQuestion(tx, {
    organizationId,
    requestId: requests.inProgressRestrictedShared,
    audienceType: "project_maintainers",
    createdAt: "10 minutes",
  });
  await seedQuestion(tx, {
    organizationId,
    requestId: requests.inProgressRestrictedClosed,
    audienceType: "project_maintainers",
  });
  await seedQuestion(tx, {
    organizationId,
    requestId: requests.reportedByMemberRestricted,
    audienceType: "requester",
  });
  await seedQuestion(tx, {
    organizationId,
    requestId: requests.triageClosedPublic,
    audienceType: "role",
    audienceId: "member",
  });
  await seedQuestion(tx, {
    organizationId,
    requestId: requests.triageClosedPublic,
    audienceType: "user",
    audienceId: member,
    state: "answered",
  });
  // Addressed to the member, on a request the member cannot see.
  await seedQuestion(tx, {
    organizationId,
    requestId: requests.triageClosed,
    audienceType: "user",
    audienceId: member,
  });

  const agents = {
    keyed: await seedPrincipal(tx, {
      organizationId,
      projectId: shared.id,
      createdByUserId: owner,
    }),
    delegated: await seedPrincipal(tx, {
      organizationId,
      projectId: null,
      createdByUserId: owner,
    }),
    revoked: await seedPrincipal(tx, {
      organizationId,
      projectId: shared.id,
      createdByUserId: owner,
      status: "revoked",
    }),
  };
  await seedCredential(tx, {
    organizationId,
    agentPrincipalId: agents.keyed,
    projectId: shared.id,
    userId: owner,
    lastUsed: "2 days",
  });
  await seedCredential(tx, {
    organizationId,
    agentPrincipalId: agents.keyed,
    projectId: shared.id,
    userId: owner,
    lastUsed: "1 hour",
  });
  await seedCredential(tx, {
    organizationId,
    agentPrincipalId: agents.keyed,
    projectId: shared.id,
    userId: owner,
    revoked: true,
    lastUsed: "1 minute",
  });
  await seedCredential(tx, {
    organizationId,
    agentPrincipalId: agents.keyed,
    projectId: shared.id,
    userId: owner,
    expired: true,
  });
  await seedGrant(tx, {
    organizationId,
    agentPrincipalId: agents.delegated,
    projectId: shared.id,
    userId: owner,
    lastUsed: "20 minutes",
  });
  await seedGrant(tx, {
    organizationId,
    agentPrincipalId: agents.delegated,
    projectId: shared.id,
    userId: owner,
    status: "revoked",
  });
  // The keyed agent works now in one session; the revoked agent's live
  // session counts for nothing.
  await seedWorkSession(tx, {
    organizationId,
    agentPrincipalId: agents.keyed,
    state: "active",
  });
  await seedWorkSession(tx, {
    organizationId,
    agentPrincipalId: agents.revoked,
    state: "active",
  });
  // Assigned to the keyed agent: two open (one restricted to a project the
  // member is not in), one finished.
  await seedRequest(tx, {
    organizationId,
    targetProjectId: shared.id,
    reporterId: owner,
    state: "in_progress",
    assignee: { type: "agent", id: agents.keyed },
  });
  await seedRequest(tx, {
    organizationId,
    targetProjectId: closed.id,
    reporterId: owner,
    state: "accepted",
    visibility: "restricted",
    assignee: { type: "agent", id: agents.keyed },
  });
  await seedRequest(tx, {
    organizationId,
    targetProjectId: shared.id,
    reporterId: owner,
    state: "completed",
    assignee: { type: "agent", id: agents.keyed },
  });

  await seedRoutingRule(tx, {
    organizationId,
    targetProjectId: shared.id,
    createdBy: owner,
    enabled: true,
  });

  const billing = await seedSubscription(tx, organizationId, "billing-events");
  const failures = {
    recent: await seedDelivery(tx, {
      organizationId,
      subscriptionId: billing,
      status: "dead_letter",
      finished: "40 minutes",
      eventType: "organization.member_changed.v1",
    }),
    newest: await seedDelivery(tx, {
      organizationId,
      subscriptionId: billing,
      status: "dead_letter",
      finished: "5 minutes",
    }),
  };
  await seedDelivery(tx, {
    organizationId,
    subscriptionId: billing,
    status: "dead_letter",
    finished: "25 hours",
  });
  await seedDelivery(tx, {
    organizationId,
    subscriptionId: billing,
    status: "delivered",
  });
  await seedDelivery(tx, {
    organizationId,
    subscriptionId: billing,
    status: "retry",
  });

  // The worker's outbox: four events not yet processed (two pending, the
  // oldest written 30 minutes ago, one leased, one accepted), the newest
  // dispatch 3 minutes ago, two dead letters in the last day and one before.
  // One of the two was written 30 hours ago and dead-lettered 2 hours ago,
  // so a window on when a row was written, not when it was dead-lettered,
  // would count one.
  // A fifth waits too: the appearance trigger's, whose event and outbox row
  // the owner's membership wrote (0014, reseeded by 0026), pending until a
  // worker takes it.
  for (const row of [
    { state: "pending", written: "30 minutes" },
    { state: "pending", written: "2 minutes" },
    { state: "leased", written: "1 minute" },
    { state: "accepted", written: "6 minutes", dispatched: "5 minutes" },
    {
      state: "completed",
      written: "4 minutes",
      dispatched: "3 minutes",
      settled: "2 minutes",
    },
    { state: "completed", written: "2 days", dispatched: "2 days" },
    { state: "dead_letter", written: "3 hours", settled: "2 hours" },
    { state: "dead_letter", written: "30 hours", settled: "2 hours" },
    { state: "dead_letter", written: "26 hours", settled: "25 hours" },
  ] as const) {
    await seedOutbox(tx, { organizationId, ...row });
  }

  return {
    organizationId,
    owner,
    member,
    shared,
    closed,
    requests,
    agents,
    billing,
    failures,
  };
}

/** The same kinds of rows in another organisation, which no read may count. */
async function seedNeighbour(tx: Tx) {
  const neighbour = await seedPopulatedOrganization(tx);
  await seedInvitation(tx, {
    organizationId: neighbour.organizationId,
    createdByUserId: neighbour.owner,
    state: "pending",
  });
  // Outbox rows that would change every health figure were they read for
  // another organisation: an older pending event, another recent dead letter
  // and a newer dispatch.
  await seedOutbox(tx, {
    organizationId: neighbour.organizationId,
    state: "pending",
    written: "3 hours",
  });
  await seedOutbox(tx, {
    organizationId: neighbour.organizationId,
    state: "dead_letter",
    written: "2 hours",
    settled: "1 hour",
  });
  await seedOutbox(tx, {
    organizationId: neighbour.organizationId,
    state: "completed",
    written: "1 minute",
    dispatched: "10 seconds",
  });
  return neighbour;
}

describe.sequential("the overview's reads", () => {
  test("an empty organisation: nothing set up, every figure zero, nothing listed", async () => {
    await inRollbackTransaction(async (tx) => {
      await seedNeighbour(tx);
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx, "Lonely Owner");
      await seedMembership(tx, organizationId, owner, "owner");
      const overview = createOverviewQueryRepository(tx);

      await expect(overview.summary(owner, organizationId)).resolves.toEqual({
        role: "owner",
        setup: { agent: false, project: false, routing: false, team: false },
        activeAgents: 0,
        connectedAgents: 0,
        openRequests: 0,
        questionsForYou: 0,
        oldestQuestionAt: null,
        failedDeliveries: 0,
      });
      await expect(
        overview.listTriageRequests(owner, organizationId),
      ).resolves.toEqual([]);
      await expect(
        overview.listFailedDeliveries(owner, organizationId),
      ).resolves.toEqual([]);
      await expect(
        overview.listAgentConnections(owner, organizationId),
      ).resolves.toEqual([]);
      // The one event waiting is the appearance trigger's, which the owner's
      // membership wrote with its outbox row; nothing was ever dispatched.
      await expect(overview.health(owner, organizationId)).resolves.toEqual({
        checkedAt: expect.any(Date),
        unprocessedEvents: 1,
        oldestUnprocessedAt: expect.any(Date),
        deadLetters: 0,
        lastDispatchAt: null,
      });
    });
  });

  test("marks each setup step done from its own rows", async () => {
    await inRollbackTransaction(async (tx) => {
      await seedNeighbour(tx);
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx, "Setting Up");
      await seedMembership(tx, organizationId, owner, "owner");
      const overview = createOverviewQueryRepository(tx);
      const setup = async () =>
        (await overview.summary(owner, organizationId)).setup;

      // An archived project, a revoked agent, a revoked member, an expired,
      // a revoked and an accepted invitation, and a disabled rule are none of
      // them a finished step.
      const archived = await seedProject(tx, organizationId, "archived");
      await seedPrincipal(tx, {
        organizationId,
        projectId: null,
        createdByUserId: owner,
        status: "revoked",
      });
      const departed = await seedUser(tx, "Departed");
      await seedMembership(tx, organizationId, departed, "member", "revoked");
      for (const state of ["expired", "revoked", "accepted"] as const) {
        await seedInvitation(tx, {
          organizationId,
          createdByUserId: owner,
          state,
        });
      }
      await seedRoutingRule(tx, {
        organizationId,
        targetProjectId: archived.id,
        createdBy: owner,
        enabled: false,
      });
      await expect(setup()).resolves.toEqual({
        agent: false,
        project: false,
        routing: false,
        team: false,
      });

      // Each step is asserted whole after its seed, so a step that turned
      // done on another step's rows fails here.
      const project = await seedProject(tx, organizationId);
      await expect(setup()).resolves.toEqual({
        agent: false,
        project: true,
        routing: false,
        team: false,
      });

      await seedPrincipal(tx, {
        organizationId,
        projectId: project.id,
        createdByUserId: owner,
        status: "suspended",
      });
      await expect(setup()).resolves.toEqual({
        agent: true,
        project: true,
        routing: false,
        team: false,
      });

      await seedInvitation(tx, {
        organizationId,
        createdByUserId: owner,
        state: "pending",
      });
      await expect(setup()).resolves.toEqual({
        agent: true,
        project: true,
        routing: false,
        team: true,
      });

      await seedRoutingRule(tx, {
        organizationId,
        targetProjectId: project.id,
        createdBy: owner,
        enabled: true,
      });
      await expect(setup()).resolves.toEqual({
        agent: true,
        project: true,
        routing: true,
        team: true,
      });
    });
  });

  test("counts a second active member as a team, with no invitation", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx, "Owner");
      await seedMembership(tx, organizationId, owner, "owner");
      const overview = createOverviewQueryRepository(tx);
      await expect(
        overview.summary(owner, organizationId),
      ).resolves.toMatchObject({ setup: { team: false } });

      const colleague = await seedUser(tx, "Colleague");
      await seedMembership(tx, organizationId, colleague, "admin");
      await expect(
        overview.summary(owner, organizationId),
      ).resolves.toMatchObject({ setup: { team: true } });
    });
  });

  test("counts the open requests each person can see, as the request list does", async () => {
    await inRollbackTransaction(async (tx) => {
      await seedNeighbour(tx);
      const seeded = await seedPopulatedOrganization(tx);
      const overview = createOverviewQueryRepository(tx);
      const requestQueries = createRequestQueryRepository(tx);
      const listed = async (userId: string) =>
        (
          await requestQueries.listRequests({
            userId,
            organizationId: seeded.organizationId,
            limit: 100,
            filters: {
              state: [
                "submitted",
                "triage",
                "accepted",
                "planned",
                "in_progress",
                "blocked",
                "waiting_human",
                "waiting_requester",
              ],
            },
          })
        ).items.length;

      const ownerSummary = await overview.summary(
        seeded.owner,
        seeded.organizationId,
      );
      const memberSummary = await overview.summary(
        seeded.member,
        seeded.organizationId,
      );
      // The owner sees all nine open requests; the member does not see the
      // three restricted to the project they are not in, reported by and
      // assigned to someone else (two in triage or in progress, one assigned
      // to the keyed agent).
      expect(ownerSummary.openRequests).toBe(9);
      expect(memberSummary.openRequests).toBe(6);
      expect(ownerSummary.openRequests).toBe(await listed(seeded.owner));
      expect(memberSummary.openRequests).toBe(await listed(seeded.member));
    });
  });

  test("counts the open questions addressed to each person, as the questions page does", async () => {
    await inRollbackTransaction(async (tx) => {
      await seedNeighbour(tx);
      const seeded = await seedPopulatedOrganization(tx);
      const overview = createOverviewQueryRepository(tx);
      const requestQueries = createRequestQueryRepository(tx);
      const listed = async (userId: string) =>
        (
          await requestQueries.listOpenQuestions({
            userId,
            organizationId: seeded.organizationId,
            limit: 100,
          })
        ).items;

      const ownerSummary = await overview.summary(
        seeded.owner,
        seeded.organizationId,
      );
      const memberSummary = await overview.summary(
        seeded.member,
        seeded.organizationId,
      );
      const ownerQuestions = await listed(seeded.owner);
      const memberQuestions = await listed(seeded.member);

      // The owner: theirs, and both maintainers' questions.
      expect(ownerSummary.questionsForYou).toBe(3);
      // The member: theirs, the maintainers' one on `shared`, the requester's,
      // and the role's — not the one on a request they cannot see.
      expect(memberSummary.questionsForYou).toBe(4);
      expect(ownerSummary.questionsForYou).toBe(ownerQuestions.length);
      expect(memberSummary.questionsForYou).toBe(memberQuestions.length);
      expect(memberSummary.oldestQuestionAt).toEqual(
        memberQuestions.at(-1)?.createdAt,
      );
      expect(ownerSummary.oldestQuestionAt).toEqual(
        ownerQuestions.at(-1)?.createdAt,
      );
    });
  });

  test("counts failed deliveries of the last day for an owner, and none at all for a member", async () => {
    await inRollbackTransaction(async (tx) => {
      await seedNeighbour(tx);
      const seeded = await seedPopulatedOrganization(tx);
      const overview = createOverviewQueryRepository(tx);

      await expect(
        overview.summary(seeded.owner, seeded.organizationId),
      ).resolves.toMatchObject({ role: "owner", failedDeliveries: 2 });
      await expect(
        overview.summary(seeded.member, seeded.organizationId),
      ).resolves.toMatchObject({ role: "member", failedDeliveries: null });

      const failed = await overview.listFailedDeliveries(
        seeded.owner,
        seeded.organizationId,
      );
      expect(failed).toEqual([
        {
          id: seeded.failures.newest,
          subscriptionId: seeded.billing,
          subscriptionName: "billing-events",
          eventType: "integration.webhook_changed.v1",
          failedAt: expect.any(Date),
        },
        {
          id: seeded.failures.recent,
          subscriptionId: seeded.billing,
          subscriptionName: "billing-events",
          eventType: "organization.member_changed.v1",
          failedAt: expect.any(Date),
        },
      ]);
      await expect(
        overview.listFailedDeliveries(seeded.member, seeded.organizationId),
      ).resolves.toEqual([]);
    });
  });

  test("lists the requests waiting for triage that each person may triage, newest first", async () => {
    await inRollbackTransaction(async (tx) => {
      await seedNeighbour(tx);
      const seeded = await seedPopulatedOrganization(tx);
      const overview = createOverviewQueryRepository(tx);

      const ownerTriage = await overview.listTriageRequests(
        seeded.owner,
        seeded.organizationId,
      );
      expect(ownerTriage.map((item) => item.id)).toEqual([
        seeded.requests.triageClosedPublic,
        seeded.requests.triageClosed,
        seeded.requests.submittedShared,
      ]);
      expect(ownerTriage[0]).toEqual({
        id: seeded.requests.triageClosedPublic,
        displayKey: expect.stringMatching(/^OVR-\d+$/u),
        title: expect.stringContaining("(triage)"),
        state: "triage",
        targetProjectName: seeded.closed.name,
        updatedAt: expect.any(Date),
      });
      // The member maintains `shared` alone: the public request in triage on
      // the other project is one they can read but not triage.
      await expect(
        overview
          .listTriageRequests(seeded.member, seeded.organizationId)
          .then((items) => items.map((item) => item.id)),
      ).resolves.toEqual([seeded.requests.submittedShared]);
      await expect(
        overview
          .listTriageRequests(seeded.owner, seeded.organizationId, 1)
          .then((items) => items.length),
      ).resolves.toBe(1);
    });
  });

  test("reads each agent's keys, grants and open assigned requests", async () => {
    await inRollbackTransaction(async (tx) => {
      await seedNeighbour(tx);
      const seeded = await seedPopulatedOrganization(tx);
      const overview = createOverviewQueryRepository(tx);

      const connections = await overview.listAgentConnections(
        seeded.owner,
        seeded.organizationId,
      );
      const byAgent = new Map(
        connections.map((entry) => [entry.agentPrincipalId, entry]),
      );
      expect(connections).toHaveLength(3);
      expect(byAgent.get(seeded.agents.keyed)).toEqual({
        agentPrincipalId: seeded.agents.keyed,
        activeKeyCount: 2,
        activeGrantCount: 0,
        lastSignedInAt: expect.any(Date),
        workingSessionCount: 1,
        openAssignedCount: 2,
      });
      // The newest use of any of its keys: the one revoked since, a minute
      // ago, which still says when the agent last signed in.
      expect(
        minutesAgo(byAgent.get(seeded.agents.keyed)?.lastSignedInAt),
      ).toBeGreaterThanOrEqual(1);
      expect(
        minutesAgo(byAgent.get(seeded.agents.keyed)?.lastSignedInAt),
      ).toBeLessThan(3);
      expect(byAgent.get(seeded.agents.delegated)).toEqual({
        agentPrincipalId: seeded.agents.delegated,
        activeKeyCount: 0,
        activeGrantCount: 1,
        lastSignedInAt: expect.any(Date),
        workingSessionCount: 0,
        openAssignedCount: 0,
      });
      // OAuth included: its grant's use, 20 minutes ago.
      expect(
        minutesAgo(byAgent.get(seeded.agents.delegated)?.lastSignedInAt),
      ).toBeGreaterThanOrEqual(20);
      expect(
        minutesAgo(byAgent.get(seeded.agents.delegated)?.lastSignedInAt),
      ).toBeLessThan(22);
      expect(byAgent.get(seeded.agents.revoked)).toEqual({
        agentPrincipalId: seeded.agents.revoked,
        activeKeyCount: 0,
        activeGrantCount: 0,
        lastSignedInAt: null,
        workingSessionCount: 0,
        openAssignedCount: 0,
      });

      // The member cannot see the restricted request assigned to the agent.
      const memberView = await overview.listAgentConnections(
        seeded.member,
        seeded.organizationId,
      );
      expect(
        memberView.find(
          (entry) => entry.agentPrincipalId === seeded.agents.keyed,
        )?.openAssignedCount,
      ).toBe(1);
    });
  });

  test("draws no sign-in or work for an agent that is suspended or revoked, whatever it still holds", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx, "Owner");
      await seedMembership(tx, organizationId, owner, "owner");
      const project = await seedProject(tx, organizationId);
      const overview = createOverviewQueryRepository(tx);
      // Each principal holds an unrevoked, unexpired key used an hour ago, an
      // active grant and a live session: suspending or revoking a principal
      // changes only its status, and none of these authorizes it then.
      const principals = new Map<string, string>();
      for (const status of ["active", "suspended", "revoked"] as const) {
        const id = await seedPrincipal(tx, {
          organizationId,
          projectId: project.id,
          createdByUserId: owner,
          status,
        });
        await seedCredential(tx, {
          organizationId,
          agentPrincipalId: id,
          projectId: project.id,
          userId: owner,
          lastUsed: "1 hour",
        });
        await seedGrant(tx, {
          organizationId,
          agentPrincipalId: id,
          projectId: project.id,
          userId: owner,
        });
        await seedWorkSession(tx, {
          organizationId,
          agentPrincipalId: id,
          state: "active",
        });
        principals.set(status, id);
      }

      const byAgent = new Map(
        (await overview.listAgentConnections(owner, organizationId)).map(
          (entry) => [entry.agentPrincipalId, entry],
        ),
      );
      expect(byAgent.get(principals.get("active") ?? "")).toEqual({
        agentPrincipalId: principals.get("active"),
        activeKeyCount: 1,
        lastSignedInAt: expect.any(Date),
        activeGrantCount: 1,
        workingSessionCount: 1,
        openAssignedCount: 0,
      });
      // When each last signed in is history, kept whatever its status is now.
      for (const status of ["suspended", "revoked"]) {
        expect(byAgent.get(principals.get(status) ?? "")).toEqual({
          agentPrincipalId: principals.get(status),
          activeKeyCount: 0,
          lastSignedInAt: expect.any(Date),
          activeGrantCount: 0,
          workingSessionCount: 0,
          openAssignedCount: 0,
        });
      }
      // Each signed in an hour ago; only the active one is connected.
      await expect(
        overview.summary(owner, organizationId),
      ).resolves.toMatchObject({ activeAgents: 1, connectedAgents: 1 });
    });
  });

  test("counts as working only a claimed or active session whose lease has not run out", async () => {
    await inRollbackTransaction(async (tx) => {
      await seedNeighbour(tx);
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx, "Owner");
      await seedMembership(tx, organizationId, owner, "owner");
      const project = await seedProject(tx, organizationId);
      const overview = createOverviewQueryRepository(tx);
      const busy = await seedPrincipal(tx, {
        organizationId,
        projectId: project.id,
        createdByUserId: owner,
      });
      const idle = await seedPrincipal(tx, {
        organizationId,
        projectId: project.id,
        createdByUserId: owner,
      });
      for (const state of ["active", "claimed"] as const) {
        await seedWorkSession(tx, {
          organizationId,
          agentPrincipalId: busy,
          state,
        });
      }
      for (const agentPrincipalId of [busy, idle]) {
        // A lease that ran out before the worker marked the session stale,
        // a stale session, and sessions paused, blocked or ended.
        await seedWorkSession(tx, {
          organizationId,
          agentPrincipalId,
          state: "active",
          leaseExpired: true,
        });
        await seedWorkSession(tx, {
          organizationId,
          agentPrincipalId,
          state: "stale",
          leaseExpired: true,
        });
        for (const state of ["paused", "blocked", "ended"] as const) {
          await seedWorkSession(tx, {
            organizationId,
            agentPrincipalId,
            state,
          });
        }
      }

      const byAgent = new Map(
        (await overview.listAgentConnections(owner, organizationId)).map(
          (entry) => [entry.agentPrincipalId, entry.workingSessionCount],
        ),
      );
      expect(byAgent).toEqual(
        new Map([
          [busy, 2],
          [idle, 0],
        ]),
      );
      // Working is not signing in: neither agent has authenticated, so none
      // is connected, and the neighbour's connected agents are not counted.
      await expect(
        overview.summary(owner, organizationId),
      ).resolves.toMatchObject({ activeAgents: 2, connectedAgents: 0 });
    });
  });

  test("leaves out a dead letter once a replay of it exists, and counts a replay that failed on its own", async () => {
    await inRollbackTransaction(async (tx) => {
      await seedNeighbour(tx);
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx, "Owner");
      await seedMembership(tx, organizationId, owner, "owner");
      const subscriptionId = await seedSubscription(
        tx,
        organizationId,
        "replayed-hook",
      );
      const overview = createOverviewQueryRepository(tx);

      // Replayed, and the replay was delivered.
      const delivered = await seedDelivery(tx, {
        organizationId,
        subscriptionId,
        status: "dead_letter",
        finished: "30 minutes",
      });
      await seedReplay(tx, {
        organizationId,
        deliveryId: delivered,
        replayNumber: 1,
        status: "delivered",
        finished: "10 minutes",
      });
      // Replayed, and the replay is still being retried.
      const retrying = await seedDelivery(tx, {
        organizationId,
        subscriptionId,
        status: "dead_letter",
        finished: "40 minutes",
      });
      await seedReplay(tx, {
        organizationId,
        deliveryId: retrying,
        replayNumber: 1,
        status: "retry",
        finished: "5 minutes",
      });
      // Replayed, and the replay ran out of retries as well.
      const failedTwice = await seedDelivery(tx, {
        organizationId,
        subscriptionId,
        status: "dead_letter",
        finished: "50 minutes",
      });
      const replayFailed = await seedReplay(tx, {
        organizationId,
        deliveryId: failedTwice,
        replayNumber: 1,
        status: "dead_letter",
        finished: "20 minutes",
      });

      await expect(
        overview.summary(owner, organizationId),
      ).resolves.toMatchObject({ failedDeliveries: 1 });
      await expect(
        overview
          .listFailedDeliveries(owner, organizationId)
          .then((rows) => rows.map((row) => row.id)),
      ).resolves.toEqual([replayFailed]);
    });
  });

  test("leaves the appearance trigger's bookkeeping out of a new organisation's recent activity, as the console creates one", async () => {
    await inRollbackTransaction(async (tx) => {
      const userId = await seedUser(tx, "First Owner");
      const organization = await new OrganizationService({
        repository: createFoundationRepository(tx),
      }).create(
        {
          actor: { type: "user", userId },
          correlationId: `corr_${crypto.randomUUID()}`,
        },
        { name: "First organization", slug: `first-${crypto.randomUUID()}` },
      );
      const overview = createOverviewQueryRepository(tx);

      // The activity page lists both; the overview only what a person did.
      const listed = await createRequestQueryRepository(
        tx,
      ).listOrganizationActivity({
        userId,
        organizationId: organization.id,
        limit: 10,
      });
      expect(listed.items.map((event) => event.type).sort()).toEqual([
        "appearance.organization_defaults_initialized.v1",
        "organization.created.v1",
      ]);
      await expect(
        overview
          .listRecentActivity(userId, organization.id)
          .then((events) => events.map((event) => event.type)),
      ).resolves.toEqual(["organization.created.v1"]);
    });
  });

  test("reads a first-run organisation, as the operator bootstrap makes one, with nothing done, zeros and no activity", async () => {
    await inRollbackTransaction(async (tx) => {
      // The two-stage bootstrap, as the operator CLI's `bootstrap-owner` runs
      // it without `--local-credential` (apps/cli): stage one makes the
      // organisation, stage two activates its owner once the person exists.
      // The self-hosted first start (apps/requestport's operator step) calls
      // bootstrapOwner once with localCredential "issue" instead, creating the
      // local user and activating the owner in one transaction. bootstrapOwner
      // writes no domain event in either mode, so both reach the state read
      // here.
      const repository = createFoundationRepository(tx);
      const email = `${crypto.randomUUID()}@example.invalid`;
      const input = {
        email,
        organizationName: "Bootstrapped",
        organizationSlug: `bootstrap-${crypto.randomUUID()}`,
      };
      const context = {
        actor: BOOTSTRAP_OWNER_ACTOR,
        correlationId: `corr_${crypto.randomUUID()}`,
      };
      const stageOne = await bootstrapOwner(repository, context, input);
      const userId = `user_${crypto.randomUUID()}`;
      await tx.insert(user).values({ id: userId, name: "First Owner", email });
      await expect(
        bootstrapOwner(repository, context, input),
      ).resolves.toMatchObject({ status: "owner_active" });
      const organizationId = stageOne.organizationId;
      const overview = createOverviewQueryRepository(tx);

      await expect(overview.summary(userId, organizationId)).resolves.toEqual({
        role: "owner",
        setup: { agent: false, project: false, routing: false, team: false },
        activeAgents: 0,
        connectedAgents: 0,
        openRequests: 0,
        questionsForYou: 0,
        oldestQuestionAt: null,
        failedDeliveries: 0,
      });
      const listed = await createRequestQueryRepository(
        tx,
      ).listOrganizationActivity({ userId, organizationId, limit: 10 });
      expect(listed.items.map((event) => event.type)).toEqual([
        "appearance.organization_defaults_initialized.v1",
      ]);
      await expect(
        overview.listRecentActivity(userId, organizationId),
      ).resolves.toEqual([]);

      // An older event of a person's: with a limit of one, the read still
      // reaches past the newer bookkeeping event to it.
      await seedEvent(tx, {
        organizationId,
        type: "project.registered.v1",
        ago: "1 minute",
      });
      await expect(
        overview
          .listRecentActivity(userId, organizationId, 1)
          .then((events) => events.map((event) => event.type)),
      ).resolves.toEqual(["project.registered.v1"]);
    });
  });

  test("counts as connected an active agent whose key or grant authenticated in the last 24 hours, OAuth included", async () => {
    await inRollbackTransaction(async (tx) => {
      // The neighbour has two connected agents, which must not count here.
      await seedNeighbour(tx);
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx, "Owner");
      await seedMembership(tx, organizationId, owner, "owner");
      const project = await seedProject(tx, organizationId);
      const overview = createOverviewQueryRepository(tx);
      const principal = (status?: "suspended") =>
        seedPrincipal(tx, {
          organizationId,
          projectId: project.id,
          createdByUserId: owner,
          ...(status ? { status } : {}),
        });
      const key = (agentPrincipalId: string, lastUsed?: string) =>
        seedCredential(tx, {
          organizationId,
          agentPrincipalId,
          projectId: project.id,
          userId: owner,
          ...(lastUsed ? { lastUsed } : {}),
        });
      const grant = (agentPrincipalId: string, lastUsed?: string) =>
        seedGrant(tx, {
          organizationId,
          agentPrincipalId,
          projectId: project.id,
          userId: owner,
          ...(lastUsed ? { lastUsed } : {}),
        });

      const byKey = await principal();
      await key(byKey, "23 hours");
      const byGrant = await principal();
      await grant(byGrant, "10 minutes");
      // A key revoked since still says the agent signed in an hour ago.
      const byRevokedKey = await principal();
      await seedCredential(tx, {
        organizationId,
        agentPrincipalId: byRevokedKey,
        projectId: project.id,
        userId: owner,
        revoked: true,
        lastUsed: "1 hour",
      });
      const stale = await principal();
      await key(stale, "25 hours");
      await grant(stale, "2 days");
      const never = await principal();
      await key(never);
      await grant(never);
      const suspended = await principal("suspended");
      await key(suspended, "1 hour");

      await expect(
        overview.summary(owner, organizationId),
      ).resolves.toMatchObject({ activeAgents: 5, connectedAgents: 3 });

      const signedIn = new Map(
        (await overview.listAgentConnections(owner, organizationId)).map(
          (entry) => [entry.agentPrincipalId, minutesAgo(entry.lastSignedInAt)],
        ),
      );
      for (const [agent, minutes] of [
        [byKey, 23 * 60],
        [byGrant, 10],
        [byRevokedKey, 60],
        // The newer of a key's use and a grant's.
        [stale, 25 * 60],
        [suspended, 60],
      ] as const) {
        expect(signedIn.get(agent)).toBeGreaterThanOrEqual(minutes);
        expect(signedIn.get(agent)).toBeLessThan(minutes + 2);
      }
      expect(signedIn.get(never)).toBe(Number.POSITIVE_INFINITY);
    });
  });

  test("reads the worker's state from this organisation's outbox alone, for an owner or an admin, and nothing for a member", async () => {
    await inRollbackTransaction(async (tx) => {
      await seedNeighbour(tx);
      const seeded = await seedPopulatedOrganization(tx);
      const admin = await seedUser(tx, "Admin Person");
      await seedMembership(tx, seeded.organizationId, admin, "admin");
      const overview = createOverviewQueryRepository(tx);

      for (const reader of [seeded.owner, admin]) {
        const health = await withProcessClockADayAhead(() =>
          overview.health(reader, seeded.organizationId),
        );
        expect(health).toEqual({
          checkedAt: expect.any(Date),
          unprocessedEvents: 5,
          oldestUnprocessedAt: expect.any(Date),
          deadLetters: 2,
          lastDispatchAt: expect.any(Date),
        });
        if (!health) throw new Error("no health");
        // The database's own clock, when the read ran: within a minute of the
        // database's now, though on PostgreSQL this process's clock read a
        // day later (`withProcessClockADayAhead`).
        expect(
          Math.abs(health.checkedAt.getTime() - (await databaseNow(tx))),
        ).toBeLessThan(60_000);
        const before = (moment: Date | null) =>
          (health.checkedAt.getTime() - (moment?.getTime() ?? 0)) / 60_000;
        // The oldest event not yet processed was written 30 minutes ago; the
        // neighbour's, 3 hours ago, is not read.
        expect(before(health.oldestUnprocessedAt)).toBeGreaterThanOrEqual(30);
        expect(before(health.oldestUnprocessedAt)).toBeLessThan(32);
        // The newest dispatch, 3 minutes ago; the neighbour's, 10 seconds ago.
        expect(before(health.lastDispatchAt)).toBeGreaterThanOrEqual(3);
        expect(before(health.lastDispatchAt)).toBeLessThan(5);
      }
      await expect(
        overview.health(seeded.member, seeded.organizationId),
      ).resolves.toBeNull();
    });
  });

  test("refuses someone who is not an active member, reading nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedPopulatedOrganization(tx);
      const outsider = await seedUser(tx, "Outsider");
      const departed = await seedUser(tx, "Departed");
      await seedMembership(
        tx,
        seeded.organizationId,
        departed,
        "admin",
        "revoked",
      );
      const overview = createOverviewQueryRepository(tx);
      for (const userId of [outsider, departed]) {
        await expect(
          overview.summary(userId, seeded.organizationId),
        ).rejects.toMatchObject({ code: "forbidden" });
        await expect(
          overview.listTriageRequests(userId, seeded.organizationId),
        ).resolves.toEqual([]);
        await expect(
          overview.listFailedDeliveries(userId, seeded.organizationId),
        ).resolves.toEqual([]);
        await expect(
          overview.listAgentConnections(userId, seeded.organizationId),
        ).resolves.toEqual([]);
        await expect(
          overview.listRecentActivity(userId, seeded.organizationId),
        ).resolves.toEqual([]);
        await expect(
          overview.health(userId, seeded.organizationId),
        ).resolves.toBeNull();
      }
    });
  });

  // Row-level security is proved on native PostgreSQL only (manifest-i2.md
  // §2.8 item 5, the reason vitest.config.ts gives for leaving the
  // row-security suites out of the PGlite lane): PGlite connects as a
  // superuser, so on that lane this case is skipped rather than run there.
  test.skipIf(selectDriver(process.env) === "pglite")(
    "reads the same under row-level security as the application role, bound to the organisation",
    async () => {
      await inRollbackTransaction(async (tx) => {
        await seedNeighbour(tx);
        const seeded = await seedPopulatedOrganization(tx);
        const overview = createOverviewQueryRepository(tx);
        const asOwner = {
          summary: await overview.summary(seeded.owner, seeded.organizationId),
          triage: await overview.listTriageRequests(
            seeded.owner,
            seeded.organizationId,
          ),
          failed: await overview.listFailedDeliveries(
            seeded.owner,
            seeded.organizationId,
          ),
          agents: await overview.listAgentConnections(
            seeded.owner,
            seeded.organizationId,
          ),
          activity: await overview.listRecentActivity(
            seeded.owner,
            seeded.organizationId,
          ),
          health: withoutClock(
            await overview.health(seeded.owner, seeded.organizationId),
          ),
        };
        // The case would prove nothing about these reads if they found nothing.
        expect(asOwner.summary.connectedAgents).toBe(2);
        expect(asOwner.failed).toHaveLength(2);
        expect(asOwner.activity.length).toBeGreaterThan(0);
        expect(asOwner.health).toMatchObject({
          unprocessedEvents: 5,
          deadLetters: 2,
        });

        await tx.execute(sql`savepoint overview_as_application`);
        await bindTenant(tx, seeded.organizationId);
        await tx.execute(sql`set local role requestport_application`);
        const role = await tx.execute<{ bypass: boolean }>(sql`
        select rolbypassrls as "bypass" from pg_catalog.pg_roles
        where rolname = current_user
      `);
        expect(role.rows[0]?.bypass).toBe(false);
        await expect(
          overview.summary(seeded.owner, seeded.organizationId),
        ).resolves.toEqual(asOwner.summary);
        await expect(
          overview.listTriageRequests(seeded.owner, seeded.organizationId),
        ).resolves.toEqual(asOwner.triage);
        await expect(
          overview.listFailedDeliveries(seeded.owner, seeded.organizationId),
        ).resolves.toEqual(asOwner.failed);
        await expect(
          overview.listAgentConnections(seeded.owner, seeded.organizationId),
        ).resolves.toEqual(asOwner.agents);
        await expect(
          overview.listRecentActivity(seeded.owner, seeded.organizationId),
        ).resolves.toEqual(asOwner.activity);
        await expect(
          overview
            .health(seeded.owner, seeded.organizationId)
            .then(withoutClock),
        ).resolves.toEqual(asOwner.health);
        await tx.execute(sql`rollback to savepoint overview_as_application`);
        await tx.execute(sql`reset role`);
      });
    },
  );
});
