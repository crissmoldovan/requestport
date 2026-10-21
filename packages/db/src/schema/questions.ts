import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { domainEvents } from "./events.js";
import { organizations } from "./organizations.js";
import { requests } from "./requests.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    bodyMd: text("body_md").notNull(),
    visibility: text("visibility").default("organization").notNull(),
    replyToId: uuid("reply_to_id"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "messages_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'service')`,
    ),
    check(
      "messages_visibility_check",
      sql`${table.visibility} in ('organization', 'restricted')`,
    ),
    unique("messages_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "messages_request_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.replyToId],
      foreignColumns: [table.organizationId, table.id],
      name: "messages_reply_to_fk",
    }).onDelete("cascade"),
    index("messages_request_created_idx").on(
      table.requestId,
      table.createdAt,
      table.id,
    ),
    index("messages_reply_to_idx").on(table.replyToId),
  ],
);

export const messageMentions = pgTable(
  "message_mentions",
  {
    messageId: uuid("message_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
    foreignKey({
      columns: [table.organizationId, table.messageId],
      foreignColumns: [messages.organizationId, messages.id],
      name: "message_mentions_message_fk",
    }).onDelete("cascade"),
    index("message_mentions_user_idx").on(
      table.organizationId,
      table.userId,
      table.createdAt,
    ),
  ],
);

export const userRequestReadStates = pgTable(
  "user_request_read_states",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    requestId: uuid("request_id").notNull(),
    lastSeenEventId: uuid("last_seen_event_id"),
    lastSeenAt: utcTimestamp("last_seen_at"),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.userId, table.requestId],
    }),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "user_request_read_states_request_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.lastSeenEventId],
      foreignColumns: [domainEvents.organizationId, domainEvents.id],
      name: "user_request_read_states_event_fk",
    }).onDelete("restrict"),
    index("user_request_read_states_user_idx").on(
      table.organizationId,
      table.userId,
      table.updatedAt,
    ),
  ],
);

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    parentRequestId: uuid("parent_request_id"),
    audienceType: text("audience_type").notNull(),
    audienceId: text("audience_id"),
    bodyMd: text("body_md").notNull(),
    choices: jsonb("choices").$type<string[]>().default([]).notNull(),
    allowFreeText: boolean("allow_free_text").default(true).notNull(),
    askedByType: text("asked_by_type").notNull(),
    askedById: text("asked_by_id").notNull(),
    answerMode: text("answer_mode").default("single").notNull(),
    blocksRequest: boolean("blocks_request").default(false).notNull(),
    resumeState: text("resume_state"),
    state: text("state").default("open").notNull(),
    version: integer("version").default(1).notNull(),
    deadlineAt: utcTimestamp("deadline_at"),
    escalationPolicy: jsonb("escalation_policy")
      .$type<Record<string, unknown> | null>()
      .default(null),
    closedByType: text("closed_by_type"),
    closedById: text("closed_by_id"),
    closedReason: text("closed_reason"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    closedAt: utcTimestamp("closed_at"),
  },
  (table) => [
    check(
      "questions_subject_type_check",
      sql`${table.subjectType} in ('request', 'evaluation_run')`,
    ),
    check(
      "questions_request_subject_check",
      sql`${table.subjectType} <> 'request' or ${table.parentRequestId} = ${table.subjectId}`,
    ),
    check(
      "questions_audience_type_check",
      sql`${table.audienceType} in ('user', 'agent', 'role', 'requester', 'project_maintainers')`,
    ),
    check(
      "questions_audience_id_check",
      sql`${table.audienceType} in ('requester', 'project_maintainers') or ${table.audienceId} is not null`,
    ),
    check(
      "questions_answer_mode_check",
      sql`${table.answerMode} in ('single', 'multiple')`,
    ),
    check(
      "questions_asked_by_type_check",
      sql`${table.askedByType} in ('user', 'agent', 'service')`,
    ),
    check(
      "questions_blocking_mode_check",
      sql`${table.blocksRequest} = false or ${table.answerMode} = 'single'`,
    ),
    check(
      "questions_answer_input_check",
      sql`${table.allowFreeText} = true or jsonb_array_length(${table.choices}) > 0`,
    ),
    check(
      "questions_resume_state_check",
      sql`${table.resumeState} is null or ${table.resumeState} in ('triage', 'accepted', 'planned', 'in_progress', 'completed')`,
    ),
    check(
      "questions_state_check",
      sql`${table.state} in ('open', 'answered', 'closed')`,
    ),
    check("questions_version_check", sql`${table.version} > 0`),
    check(
      "questions_closed_actor_check",
      sql`(${table.state} = 'open' and ${table.closedByType} is null and ${table.closedById} is null and ${table.closedReason} is null and ${table.closedAt} is null)
        or (${table.state} in ('answered', 'closed') and ${table.closedByType} in ('user', 'agent', 'service') and ${table.closedById} is not null and ${table.closedReason} is not null and ${table.closedAt} is not null)`,
    ),
    unique("questions_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.parentRequestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "questions_parent_request_fk",
    }).onDelete("cascade"),
    index("questions_request_state_idx").on(
      table.parentRequestId,
      table.state,
      table.createdAt,
    ),
    index("questions_audience_state_idx").on(
      table.organizationId,
      table.audienceType,
      table.audienceId,
      table.state,
    ),
    index("questions_deadline_idx").on(table.state, table.deadlineAt),
  ],
);

export const answers = pgTable(
  "answers",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    questionId: uuid("question_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    sourceChannel: text("source_channel").notNull(),
    bodyMd: text("body_md").notNull(),
    structuredValue: jsonb("structured_value").$type<unknown>(),
    accepted: boolean("accepted").default(true).notNull(),
    supersedesAnswerId: uuid("supersedes_answer_id"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "answers_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'service')`,
    ),
    check(
      "answers_source_channel_check",
      sql`${table.sourceChannel} in ('web', 'mcp', 'slack', 'email', 'import')`,
    ),
    unique("answers_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.questionId],
      foreignColumns: [questions.organizationId, questions.id],
      name: "answers_question_fk",
    }).onDelete("cascade"),
    uniqueIndex("answers_question_single_accepted_unique")
      .on(table.questionId)
      .where(sql`${table.accepted} = true`),
    index("answers_question_created_idx").on(
      table.questionId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    kind: text("kind").notNull(),
    externalUrl: text("external_url").notNull(),
    mediaType: text("media_type"),
    byteSize: integer("byte_size"),
    sha256: text("sha256"),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "artifacts_actor_type_check",
      sql`${table.createdByType} in ('user', 'agent', 'service')`,
    ),
    check(
      "artifacts_byte_size_check",
      sql`${table.byteSize} is null or ${table.byteSize} >= 0`,
    ),
    check(
      "artifacts_sha256_check",
      sql`${table.sha256} is null or ${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    foreignKey({
      columns: [table.organizationId, table.requestId],
      foreignColumns: [requests.organizationId, requests.id],
      name: "artifacts_request_fk",
    }).onDelete("cascade"),
    index("artifacts_request_created_idx").on(
      table.requestId,
      table.createdAt,
      table.id,
    ),
  ],
);
