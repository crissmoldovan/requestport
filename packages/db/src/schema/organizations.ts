import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "organizations_status_check",
      sql`${table.status} in ('active', 'suspended', 'archived')`,
    ),
    check("organizations_version_check", sql`${table.version} > 0`),
    uniqueIndex("organizations_slug_ci_unique").on(sql`lower(${table.slug})`),
  ],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    version: integer("version").default(1).notNull(),
    joinedAt: utcTimestamp("joined_at").defaultNow().notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "organization_members_role_check",
      sql`${table.role} in ('owner', 'admin', 'member')`,
    ),
    check(
      "organization_members_status_check",
      sql`${table.status} in ('active', 'revoked')`,
    ),
    check("organization_members_version_check", sql`${table.version} > 0`),
    index("organization_members_organization_id_idx").on(table.organizationId),
    index("organization_members_user_id_idx").on(table.userId),
    uniqueIndex("organization_members_organization_user_unique").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export const signupAllowlist = pgTable(
  "signup_allowlist",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    normalizedEmail: text("normalized_email").notNull(),
    status: text("status").notNull(),
    expiresAt: utcTimestamp("expires_at"),
    createdByUserId: text("created_by_user_id"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "signup_allowlist_status_check",
      sql`${table.status} in ('active', 'revoked')`,
    ),
    uniqueIndex("signup_allowlist_normalized_email_ci_unique").on(
      sql`lower(${table.normalizedEmail})`,
    ),
    index("signup_allowlist_created_by_user_id_idx").on(table.createdByUserId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    normalizedEmail: text("normalized_email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    acceptedAt: utcTimestamp("accepted_at"),
    revokedAt: utcTimestamp("revoked_at"),
    version: integer("version").default(1).notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "invitations_role_check",
      sql`${table.role} in ('owner', 'admin', 'member')`,
    ),
    check("invitations_version_check", sql`${table.version} > 0`),
    unique("invitations_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("invitations_organization_id_idx").on(table.organizationId),
    index("invitations_normalized_email_ci_idx").on(
      sql`lower(${table.normalizedEmail})`,
    ),
    index("invitations_created_by_user_id_idx").on(table.createdByUserId),
    uniqueIndex("invitations_organization_email_ci_unique").on(
      table.organizationId,
      sql`lower(${table.normalizedEmail})`,
    ),
    uniqueIndex("invitations_token_hash_unique").on(table.tokenHash),
  ],
);
