import { sql } from "drizzle-orm";
import {
  check,
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

import { organizations } from "./organizations.js";
import { projects } from "./projects.js";
import { requests } from "./requests.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const domainEvents = pgTable(
  "domain_events",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull(),
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    occurredAt: utcTimestamp("occurred_at").defaultNow().notNull(),
    projectId: uuid("project_id"),
    requestId: uuid("request_id"),
    actor: jsonb("actor").$type<Record<string, unknown>>().notNull(),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    links: jsonb("links").$type<Record<string, string>>().default({}).notNull(),
  },
  (table) => [
    check(
      "domain_events_aggregate_version_check",
      sql`${table.aggregateVersion} > 0`,
    ),
    check(
      "domain_events_schema_version_check",
      sql`${table.schemaVersion} > 0`,
    ),
    unique("domain_events_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "domain_events_project_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "domain_events_request_fk",
    }).onDelete("restrict"),
    uniqueIndex("domain_events_aggregate_version_unique").on(
      table.organizationId,
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion,
    ),
    index("domain_events_organization_occurred_idx").on(
      table.organizationId,
      table.occurredAt,
      table.id,
    ),
    index("domain_events_project_idx").on(table.projectId, table.occurredAt),
    index("domain_events_request_idx").on(table.requestId, table.occurredAt),
    index("domain_events_type_idx").on(table.type, table.occurredAt),
    index("domain_events_correlation_idx").on(table.correlationId),
  ],
);

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => domainEvents.id, { onDelete: "cascade" }),
    state: text("state").default("pending").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: utcTimestamp("lease_expires_at"),
    triggerRunId: text("trigger_run_id"),
    acceptedAt: utcTimestamp("accepted_at"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: utcTimestamp("next_attempt_at").defaultNow().notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "outbox_state_check",
      sql`${table.state} in ('pending', 'leased', 'accepted', 'completed', 'dead_letter')`,
    ),
    check("outbox_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "outbox_lease_check",
      sql`(${table.state} = 'leased' and ${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null)
        or (${table.state} <> 'leased' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)`,
    ),
    uniqueIndex("outbox_event_unique").on(table.eventId),
    index("outbox_dispatch_idx").on(
      table.state,
      table.nextAttemptAt,
      table.createdAt,
    ),
    index("outbox_lease_expiry_idx").on(table.leaseExpiresAt),
  ],
);
