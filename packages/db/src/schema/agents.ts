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
import { apiKeys, oauthClients, oauthConsents, user } from "./identity.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const agentPrincipals = pgTable(
  "agent_principals",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id"),
    displayName: text("display_name").notNull(),
    slug: text("slug").notNull(),
    softwareName: text("software_name"),
    status: text("status").default("active").notNull(),
    version: integer("version").default(1).notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "agent_principals_status_check",
      sql`${table.status} in ('active', 'suspended', 'revoked')`,
    ),
    check("agent_principals_version_check", sql`${table.version} > 0`),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "agent_principals_organization_project_fk",
    }).onDelete("cascade"),
    unique("agent_principals_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("agent_principals_organization_slug_ci_unique").on(
      table.organizationId,
      sql`lower(${table.slug})`,
    ),
    index("agent_principals_project_idx").on(
      table.organizationId,
      table.projectId,
    ),
  ],
);

export const agentOauthGrants = pgTable(
  "agent_oauth_grants",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    agentPrincipalId: uuid("agent_principal_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    oauthClientId: text("oauth_client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    providerGrantId: text("provider_grant_id")
      .notNull()
      .references(() => oauthConsents.id, { onDelete: "cascade" }),
    refreshFamilyId: text("refresh_family_id").notNull(),
    audience: text("audience").notNull(),
    /**
     * Null only for an exclusively-provisioning grant.
     *
     * A working grant names one project, which is what makes `context.projectId`
     * trustworthy. A provisioning grant's capability is organization-wide, and
     * requiring it to name a project is what made an organization's first
     * project impossible to create over MCP. The check below is the invariant,
     * in the database rather than in a comment.
     */
    projectId: uuid("project_id"),
    laneIds: jsonb("lane_ids").$type<string[]>().default([]).notNull(),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    status: text("status").default("active").notNull(),
    version: integer("version").default(1).notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    revokedAt: utcTimestamp("revoked_at"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "agent_oauth_grants_audience_check",
      sql`${table.audience} in ('mcp', 'api')`,
    ),
    check(
      "agent_oauth_grants_status_check",
      sql`${table.status} in ('active', 'revoked')`,
    ),
    check("agent_oauth_grants_version_check", sql`${table.version} > 0`),
    /**
     * A grant without a project is exclusively a provisioning grant, and a
     * provisioning grant holds nothing else. Both halves are one rule because
     * either half alone is unsafe: a projectless working grant would reach
     * project commands with no project, and a provisioning grant that also held
     * `work:claim` would be a credential that can both mint and act.
     */
    check(
      "agent_oauth_grants_provisioning_check",
      sql`(${table.projectId} is not null and not (${table.scopes} ? 'project:provision'))
          or (${table.projectId} is null and ${table.scopes} = '["project:provision"]'::jsonb)`,
    ),
    foreignKey({
      columns: [table.organizationId, table.agentPrincipalId],
      foreignColumns: [agentPrincipals.organizationId, agentPrincipals.id],
      name: "agent_oauth_grants_principal_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "agent_oauth_grants_project_fk",
    }).onDelete("cascade"),
    index("agent_oauth_grants_provider_binding_idx").on(
      table.userId,
      table.oauthClientId,
      table.providerGrantId,
    ),
    uniqueIndex("agent_oauth_grants_active_client_user_unique")
      .on(table.userId, table.oauthClientId)
      .where(sql`${table.status} = 'active' and ${table.revokedAt} is null`),
    unique("agent_oauth_grants_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("agent_oauth_grants_principal_idx").on(
      table.organizationId,
      table.agentPrincipalId,
    ),
    index("agent_oauth_grants_refresh_family_idx").on(table.refreshFamilyId),
  ],
);

export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    agentPrincipalId: uuid("agent_principal_id").notNull(),
    betterAuthApiKeyId: text("better_auth_api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    fingerprint: text("fingerprint").notNull(),
    audience: text("audience").notNull(),
    projectId: uuid("project_id").notNull(),
    laneIds: jsonb("lane_ids").$type<string[]>().default([]).notNull(),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    version: integer("version").default(1).notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    revokedAt: utcTimestamp("revoked_at"),
    overlapExpiresAt: utcTimestamp("overlap_expires_at"),
    lastUsedAt: utcTimestamp("last_used_at"),
    /**
     * The grant that minted this credential, when one did.
     *
     * Null for a credential a signed-in human issued in the UI, which is every
     * credential that existed before provisioning grants. Set when a
     * provisioning grant minted it, and validated on every use: revoking that
     * grant therefore revokes its children in one act.
     *
     * Without this, validation consulted the issuing *human's* current role and
     * nothing else, so a credential outlived the revocation of the grant that
     * authorized it and the only remaining remedy was demoting the human who
     * had been impersonated.
     *
     * Deliberately NOT a foreign key. It was one, `ON DELETE SET NULL`, and an
     * adversarial pass showed that inverting the whole guarantee took a single
     * ordinary action: grants cascade from `oauth_consent`, and the
     * session-authenticated "disconnect this app" endpoint deletes a consent.
     * So the one thing a person does when they believe a grant is compromised
     * destroyed the grant, nulled this column, and laundered every credential
     * it had minted into looking UI-issued — unrevokable, alive to its own
     * expiry.
     *
     * Lineage is a fact about the past, not a live reference, so nothing may be
     * permitted to erase it. With no foreign key the value survives, the
     * resolve join finds no grant, and the credential fails closed — which is
     * the correct reading of "the authority that minted this is gone".
     */
    issuedByGrantId: uuid("issued_by_grant_id"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "agent_credentials_audience_check",
      sql`${table.audience} in ('mcp', 'api')`,
    ),
    check("agent_credentials_version_check", sql`${table.version} > 0`),
    foreignKey({
      columns: [table.organizationId, table.agentPrincipalId],
      foreignColumns: [agentPrincipals.organizationId, agentPrincipals.id],
      name: "agent_credentials_principal_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "agent_credentials_project_fk",
    }).onDelete("cascade"),
    uniqueIndex("agent_credentials_better_auth_key_unique").on(
      table.betterAuthApiKeyId,
    ),
    uniqueIndex("agent_credentials_fingerprint_unique").on(table.fingerprint),
    unique("agent_credentials_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("agent_credentials_principal_idx").on(
      table.organizationId,
      table.agentPrincipalId,
    ),
  ],
);

export const agentInstallations = pgTable(
  "agent_installations",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    agentPrincipalId: uuid("agent_principal_id").notNull(),
    oauthGrantId: uuid("oauth_grant_id"),
    credentialId: uuid("credential_id"),
    softwareName: text("software_name").notNull(),
    softwareVersion: text("software_version").notNull(),
    capabilities: jsonb("capabilities")
      .$type<Record<string, boolean>>()
      .default({})
      .notNull(),
    status: text("status").default("active").notNull(),
    firstSeenAt: utcTimestamp("first_seen_at").defaultNow().notNull(),
    lastSeenAt: utcTimestamp("last_seen_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "agent_installations_status_check",
      sql`${table.status} in ('active', 'inactive', 'revoked')`,
    ),
    check(
      "agent_installations_credential_source_check",
      sql`num_nonnulls(${table.oauthGrantId}, ${table.credentialId}) = 1`,
    ),
    foreignKey({
      columns: [table.organizationId, table.agentPrincipalId],
      foreignColumns: [agentPrincipals.organizationId, agentPrincipals.id],
      name: "agent_installations_principal_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.oauthGrantId],
      foreignColumns: [agentOauthGrants.organizationId, agentOauthGrants.id],
      name: "agent_installations_oauth_grant_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.credentialId],
      foreignColumns: [agentCredentials.organizationId, agentCredentials.id],
      name: "agent_installations_credential_fk",
    }).onDelete("cascade"),
    unique("agent_installations_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("agent_installations_principal_idx").on(
      table.organizationId,
      table.agentPrincipalId,
    ),
  ],
);
