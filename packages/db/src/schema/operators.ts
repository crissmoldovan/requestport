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
import { apiKeys, user } from "./identity.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

/**
 * An operator credential's authority (Plan 13, F.3, F3-6). Better Auth's
 * api-key plugin holds the secret, under the `requestport-operator`
 * configuration; this row holds everything that grants anything. The plugin
 * row may only narrow a credential — its `enabled` and `expires_at` are joined
 * as extra conditions — because a signed-in user can update their own key's
 * `enabled` and clear its expiry through `/api/auth/api-key/update`.
 */
export const operatorCredentials = pgTable(
  "operator_credentials",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The issuer, whose live authority the credential carries (F3-3). */
    memberUserId: text("member_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /** Null means organisation-wide (F3-5). */
    projectId: uuid("project_id"),
    /**
     * `SET NULL`, not `CASCADE` as `agent_credentials` has: Better Auth
     * deletes expired keys whenever certain of its endpoints run, and the
     * member can delete their own key. This row anchors
     * `operator:<lineage_id>` in the audit trail, so it must outlive its key;
     * with the key gone the resolve join finds nothing, and the credential
     * fails closed.
     */
    betterAuthApiKeyId: text("better_auth_api_key_id").references(
      () => apiKeys.id,
      { onDelete: "set null" },
    ),
    /**
     * The first credential's id, inherited by each rotation: the operator
     * actor's identity, and therefore its receipts' (F3-6). Lineage is a fact
     * about the past, so `rotated_from_id` is deliberately not a foreign key.
     */
    lineageId: uuid("lineage_id").notNull(),
    rotatedFromId: uuid("rotated_from_id"),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    /** HMAC-SHA256 of the key under `BETTER_AUTH_SECRET`. */
    fingerprint: text("fingerprint").notNull(),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    version: integer("version").default(1).notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    revokedAt: utcTimestamp("revoked_at"),
    overlapExpiresAt: utcTimestamp("overlap_expires_at"),
    lastUsedAt: utcTimestamp("last_used_at"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check("operator_credentials_version_check", sql`${table.version} > 0`),
    /**
     * F3-4: never admissible on an operator credential, whatever the code
     * above it says. The same list is `operatorExcludedScopes` in
     * `@requestport/domain`; the integration test refuses each one here on
     * its own.
     */
    check(
      "operator_credentials_scopes_check",
      sql`jsonb_typeof(${table.scopes}) = 'array' and not (${table.scopes} ?| array['project:provision', 'agent:manage', 'operator:manage', 'work:claim', 'work:update', 'work:sweep', 'agent:register', 'workspace:telemetry:reveal'])`,
    ),
    /** F3-10: an expiry is required, and at most 90 days after creation. */
    check(
      "operator_credentials_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '90 days'`,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "operator_credentials_project_fk",
    }).onDelete("cascade"),
    uniqueIndex("operator_credentials_better_auth_key_unique").on(
      table.betterAuthApiKeyId,
    ),
    uniqueIndex("operator_credentials_fingerprint_unique").on(
      table.fingerprint,
    ),
    unique("operator_credentials_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("operator_credentials_member_idx").on(table.memberUserId),
    index("operator_credentials_lineage_idx").on(
      table.organizationId,
      table.lineageId,
    ),
  ],
);
