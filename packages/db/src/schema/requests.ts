import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations } from "./organizations.js";
import { projects } from "./projects.js";
import { lanes, routingRules } from "./routing.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const projectSequences = pgTable(
  "project_sequences",
  {
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    nextRequestNumber: integer("next_request_number").default(1).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.projectId] }),
    check(
      "project_sequences_next_request_number_check",
      sql`${table.nextRequestNumber} > 0`,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "project_sequences_organization_project_fk",
    }).onDelete("cascade"),
  ],
);

export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number"),
    displayKey: text("display_key"),
    sourceKind: text("source_kind").notNull(),
    sourceProjectId: uuid("source_project_id"),
    targetProjectId: uuid("target_project_id").notNull(),
    laneId: uuid("lane_id"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    descriptionMd: text("description_md").notNull(),
    priority: text("priority").default("normal").notNull(),
    state: text("state").default("draft").notNull(),
    resumeState: text("resume_state"),
    stateReason: text("state_reason"),
    reporterType: text("reporter_type").notNull(),
    reporterId: text("reporter_id").notNull(),
    assigneeType: text("assignee_type"),
    assigneeId: text("assignee_id"),
    visibility: text("visibility").default("organization").notNull(),
    sensitivity: text("sensitivity").default("normal").notNull(),
    version: integer("version").default(0).notNull(),
    routingRuleId: uuid("routing_rule_id"),
    routingPolicyVersion: integer("routing_policy_version"),
    dueAt: utcTimestamp("due_at"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    submittedAt: utcTimestamp("submitted_at"),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "requests_source_kind_check",
      sql`${table.sourceKind} in ('project', 'human_direct')`,
    ),
    check(
      "requests_source_project_check",
      sql`(${table.sourceKind} = 'project' and ${table.sourceProjectId} is not null)
        or (${table.sourceKind} = 'human_direct' and ${table.sourceProjectId} is null)`,
    ),
    check(
      "requests_type_check",
      sql`${table.type} in ('feature', 'bug', 'question', 'chore', 'investigation')`,
    ),
    check(
      "requests_priority_check",
      sql`${table.priority} in ('urgent', 'high', 'normal', 'low')`,
    ),
    check(
      "requests_state_check",
      sql`${table.state} in ('draft', 'submitted', 'triage', 'accepted', 'planned', 'in_progress', 'blocked', 'waiting_human', 'waiting_requester', 'completed', 'verified', 'declined', 'duplicate', 'superseded', 'cancelled')`,
    ),
    check(
      "requests_resume_state_check",
      sql`${table.resumeState} is null or ${table.resumeState} in ('triage', 'accepted', 'planned', 'in_progress', 'completed')`,
    ),
    check(
      "requests_resume_state_lifecycle_check",
      sql`(${table.state} in ('blocked', 'waiting_human', 'waiting_requester') and ${table.resumeState} is not null)
        or (${table.state} not in ('blocked', 'waiting_human', 'waiting_requester') and ${table.resumeState} is null)`,
    ),
    check(
      "requests_reporter_type_check",
      sql`${table.reporterType} in ('user', 'agent', 'service')`,
    ),
    check(
      "requests_assignee_check",
      sql`(${table.assigneeType} is null and ${table.assigneeId} is null)
        or (${table.assigneeType} in ('user', 'agent') and ${table.assigneeId} is not null)`,
    ),
    check(
      "requests_visibility_check",
      sql`${table.visibility} in ('organization', 'restricted')`,
    ),
    check(
      "requests_sensitivity_check",
      sql`${table.sensitivity} in ('normal', 'sensitive')`,
    ),
    check(
      "requests_sensitive_visibility_check",
      sql`${table.sensitivity} <> 'sensitive' or ${table.visibility} = 'restricted'`,
    ),
    check("requests_version_check", sql`${table.version} >= 0`),
    check(
      "requests_display_sequence_check",
      sql`(${table.state} = 'draft' and ${table.sequenceNumber} is null and ${table.displayKey} is null)
        or (${table.state} <> 'draft' and ${table.sequenceNumber} is not null and ${table.displayKey} is not null)`,
    ),
    unique("requests_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.sourceProjectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "requests_source_project_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.targetProjectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "requests_target_project_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.laneId],
      foreignColumns: [lanes.organizationId, lanes.id],
      name: "requests_lane_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.routingRuleId],
      foreignColumns: [routingRules.organizationId, routingRules.id],
      name: "requests_routing_rule_fk",
    }).onDelete("restrict"),
    uniqueIndex("requests_project_sequence_unique")
      .on(table.targetProjectId, table.sequenceNumber)
      .where(sql`${table.sequenceNumber} is not null`),
    uniqueIndex("requests_project_display_key_unique")
      .on(table.targetProjectId, table.displayKey)
      .where(sql`${table.displayKey} is not null`),
    index("requests_organization_updated_idx").on(
      table.organizationId,
      table.updatedAt,
      table.id,
    ),
    index("requests_target_state_idx").on(table.targetProjectId, table.state),
    index("requests_source_project_idx").on(table.sourceProjectId),
    index("requests_assignee_idx").on(table.assigneeType, table.assigneeId),
    index("requests_reporter_idx").on(table.reporterType, table.reporterId),
  ],
);

export const requestLabels = pgTable(
  "request_labels",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
  },
  (table) => [primaryKey({ columns: [table.requestId, table.label] })],
);

export const requestAcceptanceCriteria = pgTable(
  "request_acceptance_criteria",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    satisfiedAt: utcTimestamp("satisfied_at"),
  },
  (table) => [
    check(
      "request_acceptance_criteria_position_check",
      sql`${table.position} >= 0`,
    ),
    uniqueIndex("request_acceptance_criteria_position_unique").on(
      table.requestId,
      table.position,
    ),
  ],
);

export const requestRelationships = pgTable(
  "request_relationships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fromRequestId: uuid("from_request_id").notNull(),
    toRequestId: uuid("to_request_id").notNull(),
    type: text("type").notNull(),
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "request_relationships_type_check",
      sql`${table.type} in ('blocks', 'depends_on', 'duplicates', 'supersedes', 'related_to', 'derived_from')`,
    ),
    check(
      "request_relationships_actor_type_check",
      sql`${table.createdByType} in ('user', 'agent', 'service')`,
    ),
    check(
      "request_relationships_distinct_endpoints_check",
      sql`${table.fromRequestId} <> ${table.toRequestId}`,
    ),
    foreignKey({
      columns: [table.organizationId, table.fromRequestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "request_relationships_from_request_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.toRequestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "request_relationships_to_request_fk",
    }).onDelete("cascade"),
    uniqueIndex("request_relationships_unique").on(
      table.organizationId,
      table.fromRequestId,
      table.toRequestId,
      table.type,
    ),
    index("request_relationships_from_idx").on(table.fromRequestId),
    index("request_relationships_to_idx").on(table.toRequestId),
  ],
);
