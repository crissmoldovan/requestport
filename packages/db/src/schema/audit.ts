import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations } from "./organizations.js";

export const securityAuditRecords = pgTable(
  "security_audit_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    reason: text("reason").notNull(),
    fieldNames: jsonb("field_names").$type<string[]>().default([]).notNull(),
    correlationId: text("correlation_id").notNull(),
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    /*
      'service' since Plan 13, F.3: a revocation by an operator credential is
      recorded as the service actor it is, `operator:<lineage>` (F3-2).
      Migration 0018 widened it with ADD … NOT VALID, then VALIDATE (ruling 10).
    */
    check(
      "security_audit_records_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'service', 'system')`,
    ),
    index("security_audit_records_organization_id_idx").on(
      table.organizationId,
    ),
    index("security_audit_records_actor_idx").on(
      table.actorType,
      table.actorId,
    ),
    index("security_audit_records_target_idx").on(
      table.targetType,
      table.targetId,
    ),
    index("security_audit_records_correlation_id_idx").on(table.correlationId),
    index("security_audit_records_occurred_at_idx").on(table.occurredAt),
  ],
);
