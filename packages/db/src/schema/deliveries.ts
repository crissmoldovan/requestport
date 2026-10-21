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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { domainEvents } from "./events.js";
import { slackInstallations, webhookSubscriptions } from "./integrations.js";
import { organizations } from "./organizations.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").notNull(),
    eventId: uuid("event_id").notNull(),
    replayNumber: integer("replay_number").default(0).notNull(),
    status: text("status").default("pending").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    completedAt: utcTimestamp("completed_at"),
  },
  (table) => [
    check(
      "webhook_deliveries_status_check",
      sql`${table.status} in ('pending', 'delivering', 'delivered', 'retry', 'dead_letter', 'cancelled')`,
    ),
    check("webhook_deliveries_replay_check", sql`${table.replayNumber} >= 0`),
    foreignKey({
      columns: [table.organizationId, table.subscriptionId],
      foreignColumns: [
        webhookSubscriptions.organizationId,
        webhookSubscriptions.id,
      ],
      name: "webhook_deliveries_subscription_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [domainEvents.organizationId, domainEvents.id],
      name: "webhook_deliveries_event_fk",
    }).onDelete("cascade"),
    uniqueIndex("webhook_deliveries_replay_unique").on(
      table.subscriptionId,
      table.eventId,
      table.replayNumber,
    ),
    index("webhook_deliveries_status_idx").on(table.status, table.createdAt),
  ],
);

export const webhookAttempts = pgTable(
  "webhook_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => webhookDeliveries.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    resolvedIps: jsonb("resolved_ips").$type<string[]>().default([]).notNull(),
    requestTimestamp: utcTimestamp("request_timestamp").notNull(),
    signingKeyId: text("signing_key_id").notNull(),
    startedAt: utcTimestamp("started_at").defaultNow().notNull(),
    finishedAt: utcTimestamp("finished_at"),
    responseStatus: integer("response_status"),
    responseExcerpt: text("response_excerpt"),
    errorCode: text("error_code"),
    nextAttemptAt: utcTimestamp("next_attempt_at"),
  },
  (table) => [
    check("webhook_attempts_attempt_check", sql`${table.attemptNumber} > 0`),
    uniqueIndex("webhook_attempts_delivery_attempt_unique").on(
      table.deliveryId,
      table.attemptNumber,
    ),
    index("webhook_attempts_retry_idx").on(table.nextAttemptAt),
  ],
);

export const providerCallbackReceipts = pgTable(
  "provider_callback_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    bodySha256: text("body_sha256").notNull(),
    receivedAt: utcTimestamp("received_at").defaultNow().notNull(),
    processedAt: utcTimestamp("processed_at"),
    outcome: text("outcome"),
  },
  (table) => [
    uniqueIndex("provider_callback_receipts_event_unique").on(
      table.provider,
      table.providerEventId,
    ),
    check(
      "provider_callback_receipts_sha_check",
      sql`${table.bodySha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const dispatcherReceipts = pgTable(
  "dispatcher_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outboxId: uuid("outbox_id").notNull(),
    taskName: text("task_name").notNull(),
    triggerRunId: text("trigger_run_id"),
    state: text("state").default("pending").notNull(),
    leasedBy: text("leased_by"),
    leaseExpiresAt: utcTimestamp("lease_expires_at"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("dispatcher_receipts_outbox_task_unique").on(
      table.outboxId,
      table.taskName,
    ),
    index("dispatcher_receipts_lease_idx").on(
      table.state,
      table.leaseExpiresAt,
    ),
  ],
);

export const slackDeliveryOperations = pgTable(
  "slack_delivery_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => slackInstallations.id, { onDelete: "cascade" }),
    operationKey: text("operation_key").notNull(),
    operationType: text("operation_type").default("message_update").notNull(),
    operationPayload: jsonb("operation_payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    providerMessageTs: text("provider_message_ts"),
    status: text("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: utcTimestamp("next_attempt_at").defaultNow().notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: utcTimestamp("lease_expires_at"),
    lastErrorCode: text("last_error_code"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "slack_delivery_operations_type_check",
      sql`${table.operationType} in ('message_update', 'connection_test')`,
    ),
    check(
      "slack_delivery_operations_status_check",
      sql`${table.status} in ('pending', 'delivering', 'retry', 'delivered', 'failed')`,
    ),
    check(
      "slack_delivery_operations_attempt_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "slack_delivery_operations_lease_check",
      sql`(${table.status} = 'delivering' and ${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null)
      or (${table.status} <> 'delivering' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)`,
    ),
    uniqueIndex("slack_delivery_operations_key_unique").on(table.operationKey),
    index("slack_delivery_operations_pending_idx").on(
      table.operationType,
      table.status,
      table.nextAttemptAt,
    ),
    index("slack_delivery_operations_lease_idx").on(
      table.status,
      table.leaseExpiresAt,
    ),
  ],
);
