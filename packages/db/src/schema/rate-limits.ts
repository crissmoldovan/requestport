import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environment: text("environment").notNull(),
    endpointClass: text("endpoint_class").notNull(),
    principalFingerprint: text("principal_fingerprint").notNull(),
    windowStartedAt: utcTimestamp("window_started_at").notNull(),
    count: integer("count").default(0).notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check("rate_limit_buckets_count_check", sql`${table.count} >= 0`),
    uniqueIndex("rate_limit_buckets_identity_unique").on(
      table.environment,
      table.endpointClass,
      table.principalFingerprint,
      table.windowStartedAt,
    ),
    index("rate_limit_buckets_expiry_idx").on(table.expiresAt),
  ],
);
