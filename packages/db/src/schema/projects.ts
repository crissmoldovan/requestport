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

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    description: text("description"),
    status: text("status").notNull(),
    version: integer("version").default(1).notNull(),
    heartbeatIntervalSeconds: integer("heartbeat_interval_seconds")
      .default(30)
      .notNull(),
    leaseMultiplier: integer("lease_multiplier").default(3).notNull(),
    graceSeconds: integer("grace_seconds").default(900).notNull(),
    requiredWorkspaceFields: jsonb("required_workspace_fields")
      .$type<string[]>()
      .default([])
      .notNull(),
    defaultLaneId: uuid("default_lane_id"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "projects_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    check("projects_version_check", sql`${table.version} > 0`),
    check(
      "projects_heartbeat_interval_check",
      sql`${table.heartbeatIntervalSeconds} between 10 and 300`,
    ),
    check(
      "projects_lease_multiplier_check",
      sql`${table.leaseMultiplier} between 2 and 10`,
    ),
    check(
      "projects_grace_seconds_check",
      sql`${table.graceSeconds} between 60 and 86400`,
    ),
    index("projects_organization_id_idx").on(table.organizationId),
    index("projects_default_lane_id_idx").on(table.defaultLaneId),
    unique("projects_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("projects_organization_slug_ci_unique").on(
      table.organizationId,
      sql`lower(${table.slug})`,
    ),
    uniqueIndex("projects_organization_key_prefix_ci_unique").on(
      table.organizationId,
      sql`lower(${table.keyPrefix})`,
    ),
  ],
);

export const projectAliases = pgTable(
  "project_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    alias: text("alias").notNull(),
    source: text("source").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "project_aliases_source_check",
      sql`${table.source} in ('manual', 'rename', 'import', 'agent')`,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "project_aliases_organization_project_fk",
    }).onDelete("cascade"),
    index("project_aliases_organization_id_idx").on(table.organizationId),
    index("project_aliases_project_id_idx").on(table.projectId),
    uniqueIndex("project_aliases_organization_alias_ci_unique").on(
      table.organizationId,
      sql`lower(${table.alias})`,
    ),
  ],
);

export const projectRepositories = pgTable(
  "project_repositories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    provider: text("provider").notNull(),
    browseUrl: text("browse_url").notNull(),
    cloneUrl: text("clone_url").notNull(),
    repositorySlug: text("repository_slug"),
    isDefault: boolean("is_default").default(false).notNull(),
    status: text("status").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "project_repositories_provider_check",
      sql`${table.provider} in ('github')`,
    ),
    check(
      "project_repositories_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "project_repositories_organization_project_fk",
    }).onDelete("cascade"),
    index("project_repositories_organization_id_idx").on(table.organizationId),
    index("project_repositories_project_id_idx").on(table.projectId),
    unique("project_repositories_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("project_repositories_project_default_unique")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.isDefault} = true`),
    uniqueIndex("project_repositories_provider_slug_ci_unique").on(
      table.organizationId,
      table.provider,
      sql`lower(${table.repositorySlug})`,
    ),
  ],
);

export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "project_members_role_check",
      sql`${table.role} in ('maintainer', 'contributor', 'viewer')`,
    ),
    check(
      "project_members_status_check",
      sql`${table.status} in ('active', 'revoked')`,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "project_members_organization_project_fk",
    }).onDelete("cascade"),
    index("project_members_organization_id_idx").on(table.organizationId),
    index("project_members_project_id_idx").on(table.projectId),
    index("project_members_user_id_idx").on(table.userId),
    uniqueIndex("project_members_project_user_unique").on(
      table.organizationId,
      table.projectId,
      table.userId,
    ),
  ],
);
