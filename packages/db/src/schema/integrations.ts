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

import { user } from "./identity.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id"),
    name: text("name").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    eventTypes: jsonb("event_types").$type<string[]>().default([]).notNull(),
    projectIds: jsonb("project_ids").$type<string[]>().default([]).notNull(),
    laneIds: jsonb("lane_ids").$type<string[]>().default([]).notNull(),
    requestTypes: jsonb("request_types")
      .$type<string[]>()
      .default([])
      .notNull(),
    status: text("status").default("pending_verification").notNull(),
    version: integer("version").default(1).notNull(),
    currentSecretCiphertext: jsonb("current_secret_ciphertext")
      .$type<Record<string, unknown>>()
      .notNull(),
    currentSecretKeyId: text("current_secret_key_id").notNull(),
    nextSecretCiphertext: jsonb("next_secret_ciphertext").$type<
      Record<string, unknown>
    >(),
    nextSecretKeyId: text("next_secret_key_id"),
    overlapEndsAt: utcTimestamp("overlap_ends_at"),
    verifiedAt: utcTimestamp("verified_at"),
    createdBy: text("created_by").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "webhook_subscriptions_status_check",
      sql`${table.status} in ('pending_verification', 'active', 'disabled', 'revoked')`,
    ),
    check("webhook_subscriptions_version_check", sql`${table.version} > 0`),
    check(
      "webhook_subscriptions_rotation_check",
      sql`(${table.nextSecretCiphertext} is null and ${table.nextSecretKeyId} is null and ${table.overlapEndsAt} is null) or (${table.nextSecretCiphertext} is not null and ${table.nextSecretKeyId} is not null and ${table.overlapEndsAt} is not null and ${table.nextSecretKeyId} <> ${table.currentSecretKeyId})`,
    ),
    check(
      "webhook_subscriptions_verification_check",
      sql`${table.status} <> 'active' or ${table.verifiedAt} is not null`,
    ),
    unique("webhook_subscriptions_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "webhook_subscriptions_project_fk",
    }).onDelete("cascade"),
    index("webhook_subscriptions_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("webhook_subscriptions_project_idx").on(table.projectId),
  ],
);

export const slackInstallations = pgTable(
  "slack_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    workspaceName: text("workspace_name").notNull(),
    botTokenCiphertext: jsonb("bot_token_ciphertext")
      .$type<Record<string, unknown>>()
      .notNull(),
    botUserId: text("bot_user_id").notNull(),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    status: text("status").default("active").notNull(),
    version: integer("version").default(1).notNull(),
    installedByUserId: text("installed_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "slack_installations_status_check",
      sql`${table.status} in ('active', 'disabled', 'revoked')`,
    ),
    check("slack_installations_version_check", sql`${table.version} > 0`),
    unique("slack_installations_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("slack_installations_active_workspace_unique")
      .on(table.organizationId, table.workspaceId)
      .where(sql`${table.status} = 'active'`),
    index("slack_installations_org_idx").on(table.organizationId, table.status),
  ],
);

export const slackOauthStates = pgTable(
  "slack_oauth_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    stateHash: text("state_hash").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    consumedAt: utcTimestamp("consumed_at"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("slack_oauth_states_hash_unique").on(table.stateHash),
    index("slack_oauth_states_expiry_idx").on(table.expiresAt),
  ],
);

export const slackUserMappings = pgTable(
  "slack_user_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").default("active").notNull(),
    version: integer("version").default(1).notNull(),
    verifiedAt: utcTimestamp("verified_at").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "slack_user_mappings_status_check",
      sql`${table.status} in ('active', 'disabled', 'revoked')`,
    ),
    check("slack_user_mappings_version_check", sql`${table.version} > 0`),
    foreignKey({
      columns: [table.organizationId, table.installationId],
      foreignColumns: [
        slackInstallations.organizationId,
        slackInstallations.id,
      ],
      name: "slack_user_mappings_installation_fk",
    }).onDelete("cascade"),
    uniqueIndex("slack_user_mappings_installation_slack_unique").on(
      table.installationId,
      table.slackUserId,
    ),
    uniqueIndex("slack_user_mappings_installation_user_unique").on(
      table.installationId,
      table.userId,
    ),
    index("slack_user_mappings_org_idx").on(table.organizationId, table.status),
  ],
);

export const slackRoutes = pgTable(
  "slack_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id"),
    mode: text("mode").notNull(),
    channelId: text("channel_id"),
    fallback: text("fallback").default("none").notNull(),
    status: text("status").default("active").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "slack_routes_mode_check",
      sql`${table.mode} in ('dm', 'channel', 'both')`,
    ),
    check(
      "slack_routes_channel_check",
      sql`${table.mode} = 'dm' or ${table.channelId} is not null`,
    ),
    check(
      "slack_routes_fallback_check",
      sql`${table.fallback} in ('none', 'organization_channel', 'email')`,
    ),
    check(
      "slack_routes_status_check",
      sql`${table.status} in ('active', 'disabled')`,
    ),
    check("slack_routes_version_check", sql`${table.version} > 0`),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "slack_routes_project_fk",
    }).onDelete("cascade"),
    uniqueIndex("slack_routes_active_project_unique")
      .on(table.organizationId, table.projectId)
      .where(
        sql`${table.status} = 'active' and ${table.projectId} is not null`,
      ),
    uniqueIndex("slack_routes_active_organization_unique")
      .on(table.organizationId)
      .where(sql`${table.status} = 'active' and ${table.projectId} is null`),
  ],
);
