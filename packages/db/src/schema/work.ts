import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentInstallations, agentPrincipals } from "./agents.js";
import { domainEvents } from "./events.js";
import { organizations } from "./organizations.js";
import { projectRepositories, projects } from "./projects.js";
import { requests } from "./requests.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const machineWorkspaces = pgTable(
  "machine_workspaces",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    repositoryId: uuid("repository_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    safeCapabilities: jsonb("safe_capabilities")
      .$type<Record<string, boolean>>()
      .default({})
      .notNull(),
    privateCiphertext: bytea("private_ciphertext").notNull(),
    privateNonce: bytea("private_nonce").notNull(),
    wrappedDek: bytea("wrapped_dek").notNull(),
    kekVersion: text("kek_version").notNull(),
    telemetrySchemaVersion: integer("telemetry_schema_version")
      .default(1)
      .notNull(),
    status: text("status").default("active").notNull(),
    lastSeenAt: utcTimestamp("last_seen_at").defaultNow().notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "machine_workspaces_status_check",
      sql`${table.status} in ('active', 'inactive', 'revoked')`,
    ),
    check(
      "machine_workspaces_telemetry_schema_check",
      sql`${table.telemetrySchemaVersion} > 0`,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "machine_workspaces_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.installationId],
      foreignColumns: [
        agentInstallations.organizationId,
        agentInstallations.id,
      ],
      name: "machine_workspaces_installation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.repositoryId],
      foreignColumns: [
        projectRepositories.organizationId,
        projectRepositories.id,
      ],
      name: "machine_workspaces_repository_fk",
    }).onDelete("cascade"),
    unique("machine_workspaces_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("machine_workspaces_project_idx").on(
      table.organizationId,
      table.projectId,
    ),
  ],
);

export const workSessions = pgTable(
  "work_sessions",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    requestId: uuid("request_id").notNull(),
    agentPrincipalId: uuid("agent_principal_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    authorizationChain: jsonb("authorization_chain")
      .$type<Record<string, unknown>>()
      .notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    claimMode: text("claim_mode").default("exclusive").notNull(),
    state: text("state").notNull(),
    version: integer("version").default(1).notNull(),
    eventVersion: integer("event_version").default(1).notNull(),
    heartbeatIntervalSeconds: integer("heartbeat_interval_seconds").notNull(),
    leaseMultiplier: integer("lease_multiplier").default(3).notNull(),
    graceSeconds: integer("grace_seconds").default(900).notNull(),
    leaseExpiresAt: utcTimestamp("lease_expires_at").notNull(),
    graceExpiresAt: utcTimestamp("grace_expires_at").notNull(),
    startedAt: utcTimestamp("started_at"),
    endedAt: utcTimestamp("ended_at"),
    endedReason: text("ended_reason"),
    outcomeSummaryMd: text("outcome_summary_md"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "work_sessions_claim_mode_check",
      sql`${table.claimMode} = 'exclusive'`,
    ),
    check(
      "work_sessions_state_check",
      sql`${table.state} in ('claimed', 'active', 'paused', 'blocked', 'stale', 'abandoned', 'ended')`,
    ),
    check(
      "work_sessions_terminal_timestamp_check",
      sql`(${table.state} in ('abandoned', 'ended') and ${table.endedAt} is not null)
        or (${table.state} not in ('abandoned', 'ended') and ${table.endedAt} is null)`,
    ),
    check("work_sessions_version_check", sql`${table.version} > 0`),
    check(
      "work_sessions_event_version_check",
      sql`${table.eventVersion} > 0 and ${table.eventVersion} <= ${table.version}`,
    ),
    check(
      "work_sessions_lease_policy_check",
      sql`${table.heartbeatIntervalSeconds} between 10 and 3600 and ${table.leaseMultiplier} between 2 and 10 and ${table.graceSeconds} between 60 and 86400 and ${table.graceExpiresAt} >= ${table.leaseExpiresAt}`,
    ),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "work_sessions_request_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.agentPrincipalId],
      foreignColumns: [agentPrincipals.organizationId, agentPrincipals.id],
      name: "work_sessions_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.installationId],
      foreignColumns: [
        agentInstallations.organizationId,
        agentInstallations.id,
      ],
      name: "work_sessions_installation_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.workspaceId],
      foreignColumns: [machineWorkspaces.organizationId, machineWorkspaces.id],
      name: "work_sessions_workspace_fk",
    }).onDelete("restrict"),
    unique("work_sessions_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("work_sessions_request_live_claim_unique")
      .on(table.requestId)
      .where(
        sql`${table.state} in ('claimed', 'active', 'paused', 'blocked', 'stale')`,
      ),
    index("work_sessions_agent_idx").on(
      table.organizationId,
      table.agentPrincipalId,
    ),
    index("work_sessions_lease_idx").on(table.state, table.leaseExpiresAt),
  ],
);

export const workUpdates = pgTable(
  "work_updates",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    requestId: uuid("request_id").notNull(),
    workSessionId: uuid("work_session_id").notNull(),
    actor: jsonb("actor").$type<Record<string, unknown>>().notNull(),
    kind: text("kind").notNull(),
    bodyMd: text("body_md").notNull(),
    progressPercent: integer("progress_percent"),
    evidence: jsonb("evidence")
      .$type<Array<Record<string, unknown>>>()
      .default([])
      .notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "work_updates_kind_check",
      sql`${table.kind} in ('progress', 'checkpoint', 'blocker', 'note')`,
    ),
    check(
      "work_updates_progress_check",
      sql`${table.progressPercent} is null or ${table.progressPercent} between 0 and 100`,
    ),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "work_updates_request_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.workSessionId],
      foreignColumns: [workSessions.organizationId, workSessions.id],
      name: "work_updates_session_fk",
    }).onDelete("cascade"),
    index("work_updates_session_created_idx").on(
      table.workSessionId,
      table.createdAt,
    ),
  ],
);

export const completionReports = pgTable(
  "completion_reports",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    outcomeMd: text("outcome_md").notNull(),
    changedRepositories: jsonb("changed_repositories")
      .$type<Array<Record<string, unknown>>>()
      .default([])
      .notNull(),
    validations: jsonb("validations")
      .$type<Array<Record<string, unknown>>>()
      .default([])
      .notNull(),
    risksMd: text("risks_md").notNull(),
    followupsMd: text("followups_md").notNull(),
    verificationStepsMd: text("verification_steps_md").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "completion_reports_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'service')`,
    ),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "completion_reports_request_fk",
    }).onDelete("cascade"),
    uniqueIndex("completion_reports_request_unique").on(table.requestId),
    index("completion_reports_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export const stateTransitions = pgTable(
  "state_transitions",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    action: text("action").notNull(),
    reason: text("reason"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    requestVersion: integer("request_version").notNull(),
    eventId: uuid("event_id").notNull(),
    occurredAt: utcTimestamp("occurred_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "state_transitions_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'service')`,
    ),
    check("state_transitions_version_check", sql`${table.requestVersion} > 0`),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "state_transitions_request_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [domainEvents.organizationId, domainEvents.id],
      name: "state_transitions_event_fk",
    }).onDelete("restrict"),
    uniqueIndex("state_transitions_request_version_unique").on(
      table.requestId,
      table.requestVersion,
    ),
    uniqueIndex("state_transitions_event_unique").on(table.eventId),
    index("state_transitions_request_occurred_idx").on(
      table.requestId,
      table.occurredAt,
      table.id,
    ),
  ],
);
