import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./identity.js";
import { organizations } from "./organizations.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const retentionHolds = pgTable(
  "retention_holds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    reason: text("reason").notNull(),
    status: text("status").default("active").notNull(),
    version: integer("version").default(1).notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    releasedByUserId: text("released_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    releasedAt: utcTimestamp("released_at"),
  },
  (table) => [
    check(
      "retention_holds_status_check",
      sql`${table.status} in ('active','released')`,
    ),
    check(
      "retention_holds_category_check",
      sql`${table.category} in ('all','slack_oauth_state','slack_action_token')`,
    ),
    check("retention_holds_version_check", sql`${table.version} > 0`),
    check(
      "retention_holds_release_check",
      sql`(${table.status} = 'active' and ${table.releasedAt} is null and ${table.releasedByUserId} is null) or (${table.status} = 'released' and ${table.releasedAt} is not null and ${table.releasedByUserId} is not null)`,
    ),
    uniqueIndex("retention_holds_active_unique")
      .on(table.organizationId, table.category)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const retentionTombstones = pgTable(
  "retention_tombstones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    category: text("category").notNull(),
    cutoffAt: utcTimestamp("cutoff_at").notNull(),
    deletedCount: integer("deleted_count").notNull(),
    selectedIdsSha256: text("selected_ids_sha256").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check("retention_tombstones_count_check", sql`${table.deletedCount} >= 0`),
    check(
      "retention_tombstones_sha_check",
      sql`${table.selectedIdsSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    index("retention_tombstones_category_idx").on(
      table.category,
      table.createdAt,
    ),
  ],
);
