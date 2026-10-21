import { sql } from "drizzle-orm";
import {
  boolean,
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

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const lanes = pgTable(
  "lanes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status").default("active").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check("lanes_status_check", sql`${table.status} in ('active', 'archived')`),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "lanes_organization_project_fk",
    }).onDelete("cascade"),
    unique("lanes_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("lanes_project_slug_ci_unique").on(
      table.organizationId,
      table.projectId,
      sql`lower(${table.slug})`,
    ),
    index("lanes_project_idx").on(table.organizationId, table.projectId),
  ],
);

export const routingRules = pgTable(
  "routing_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    sourceProjectId: uuid("source_project_id"),
    targetProjectId: uuid("target_project_id").notNull(),
    decision: text("decision").notNull(),
    requestTypes: jsonb("request_types")
      .$type<string[]>()
      .default([])
      .notNull(),
    laneIds: jsonb("lane_ids").$type<string[]>().default([]).notNull(),
    priorities: jsonb("priorities").$type<string[]>().default([]).notNull(),
    humanRoles: jsonb("human_roles").$type<string[]>().default([]).notNull(),
    agentPrincipalIds: jsonb("agent_principal_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    specificity: integer("specificity").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    version: integer("version").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "routing_rules_source_kind_check",
      sql`${table.sourceKind} in ('project', 'human_direct')`,
    ),
    check(
      "routing_rules_source_project_check",
      sql`(${table.sourceKind} = 'project' and ${table.sourceProjectId} is not null)
        or (${table.sourceKind} = 'human_direct' and ${table.sourceProjectId} is null)`,
    ),
    check(
      "routing_rules_decision_check",
      sql`${table.decision} in ('allow', 'deny')`,
    ),
    check("routing_rules_version_check", sql`${table.version} > 0`),
    check("routing_rules_specificity_check", sql`${table.specificity} >= 0`),
    unique("routing_rules_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.sourceProjectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "routing_rules_source_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.targetProjectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "routing_rules_target_project_fk",
    }).onDelete("cascade"),
    index("routing_rules_organization_idx").on(table.organizationId),
    index("routing_rules_route_idx").on(
      table.organizationId,
      table.sourceKind,
      table.sourceProjectId,
      table.targetProjectId,
    ),
    index("routing_rules_target_idx").on(table.targetProjectId),
  ],
);
