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

import { domainEvents } from "./events.js";
import { user } from "./identity.js";
import { slackInstallations } from "./integrations.js";
import { invitations, organizations } from "./organizations.js";
import { answers, questions } from "./questions.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const notificationIntents = pgTable(
  "notification_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id"),
    invitationId: uuid("invitation_id"),
    questionId: uuid("question_id"),
    channel: text("channel").notNull(),
    recipientUserId: text("recipient_user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    recipientRef: text("recipient_ref").notNull(),
    template: text("template").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    viewModel: jsonb("view_model").$type<Record<string, unknown>>().notNull(),
    status: text("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: utcTimestamp("next_attempt_at").defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: utcTimestamp("lease_expires_at"),
    lastErrorCode: text("last_error_code"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "notification_intents_channel_check",
      sql`${table.channel} in ('email', 'slack')`,
    ),
    check(
      "notification_intents_status_check",
      sql`${table.status} in ('pending', 'delivering', 'delivered', 'suppressed', 'failed')`,
    ),
    check(
      "notification_intents_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "notification_intents_lease_check",
      sql`(${table.status} = 'delivering' and ${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null)
      or (${table.status} <> 'delivering' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)`,
    ),
    check(
      "notification_intents_schedule_check",
      sql`(${table.status} in ('delivered','suppressed') and ${table.nextAttemptAt} is null)
      or ${table.status} in ('pending','delivering','failed')`,
    ),
    unique("notification_intents_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.eventId],
      foreignColumns: [domainEvents.organizationId, domainEvents.id],
      name: "notification_intents_event_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.invitationId],
      foreignColumns: [invitations.organizationId, invitations.id],
      name: "notification_intents_invitation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.questionId],
      foreignColumns: [questions.organizationId, questions.id],
      name: "notification_intents_question_fk",
    }).onDelete("cascade"),
    index("notification_intents_pending_idx").on(
      table.channel,
      table.status,
      table.nextAttemptAt,
    ),
    index("notification_intents_lease_idx").on(
      table.status,
      table.leaseExpiresAt,
    ),
    index("notification_intents_invitation_idx").on(table.invitationId),
    index("notification_intents_recipient_idx").on(
      table.organizationId,
      table.recipientUserId,
      table.status,
    ),
    uniqueIndex("notification_intents_event_channel_recipient_unique").on(
      table.eventId,
      table.channel,
      table.recipientRef,
      table.template,
    ),
    uniqueIndex("notification_intents_dedupe_unique").on(table.dedupeKey),
  ],
);

export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    notificationIntentId: uuid("notification_intent_id").notNull(),
    providerMessageId: text("provider_message_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").default("pending").notNull(),
    lastProviderEventAt: utcTimestamp("last_provider_event_at"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "email_deliveries_status_check",
      sql`${table.status} in ('pending','queued','scheduled','sent','delivered','opened','clicked','delivery_delayed','failed','bounced','complained','suppressed','canceled')`,
    ),
    foreignKey({
      columns: [table.organizationId, table.notificationIntentId],
      foreignColumns: [
        notificationIntents.organizationId,
        notificationIntents.id,
      ],
      name: "email_deliveries_intent_fk",
    }).onDelete("cascade"),
    uniqueIndex("email_deliveries_idempotency_unique").on(table.idempotencyKey),
    uniqueIndex("email_deliveries_provider_unique").on(table.providerMessageId),
  ],
);

export const slackDeliveries = pgTable(
  "slack_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    notificationIntentId: uuid("notification_intent_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageTs: text("message_ts"),
    status: text("status").default("pending").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "slack_deliveries_status_check",
      sql`${table.status} in ('pending','delivered','failed')`,
    ),
    foreignKey({
      columns: [table.organizationId, table.notificationIntentId],
      foreignColumns: [
        notificationIntents.organizationId,
        notificationIntents.id,
      ],
      name: "slack_deliveries_intent_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.installationId],
      foreignColumns: [
        slackInstallations.organizationId,
        slackInstallations.id,
      ],
      name: "slack_deliveries_installation_fk",
    }).onDelete("cascade"),
    uniqueIndex("slack_deliveries_intent_unique").on(
      table.notificationIntentId,
      table.installationId,
      table.channelId,
    ),
  ],
);

export const slackActionTokens = pgTable(
  "slack_action_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    questionId: uuid("question_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    slackUserId: text("slack_user_id"),
    tokenType: text("token_type").notNull(),
    tokenHash: text("token_hash").notNull(),
    actionPayload: jsonb("action_payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    consumedAt: utcTimestamp("consumed_at"),
    consumedByUserId: text("consumed_by_user_id"),
    answerId: uuid("answer_id"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "slack_action_tokens_type_check",
      sql`${table.tokenType} in ('answer', 'modal_launch', 'modal_submit')`,
    ),
    foreignKey({
      columns: [table.organizationId, table.questionId],
      foreignColumns: [questions.organizationId, questions.id],
      name: "slack_action_tokens_question_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.installationId],
      foreignColumns: [
        slackInstallations.organizationId,
        slackInstallations.id,
      ],
      name: "slack_action_tokens_installation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.answerId],
      foreignColumns: [answers.organizationId, answers.id],
      name: "slack_action_tokens_answer_fk",
    }).onDelete("restrict"),
    uniqueIndex("slack_action_tokens_hash_unique").on(table.tokenHash),
    index("slack_action_tokens_expiry_idx").on(
      table.expiresAt,
      table.consumedAt,
    ),
  ],
);
