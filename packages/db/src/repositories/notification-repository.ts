import { redactSensitiveText } from "@requestport/domain";
import { parseNotificationViewModel } from "@requestport/notifications/view-model";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "../client.js";
import { inTurn } from "../in-turn.js";
import {
  domainEvents,
  emailDeliveries,
  invitations,
  notificationIntents,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  questions,
  requests,
  slackDeliveries,
  slackUserMappings,
  user,
} from "../schema/index.js";
import { inTenantTransaction } from "../tenant-context.js";

type QuestionEscalationPolicy = {
  reminderOffsetsMinutes: number[];
  escalateAfterMinutes: number | null;
  escalationAudience: "project_maintainers" | "organization_admins" | null;
};

const maxNotificationAttempts = 8;

function notificationRetryDelaySeconds(attemptCount: number) {
  return Math.min(3_600, 30 * 2 ** Math.max(0, attemptCount - 1));
}

function outboundText(value: string, fallback: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized) return fallback;
  const redacted = redactSensitiveText(normalized);
  return redacted === normalized ? normalized.slice(0, maxLength) : fallback;
}

function questionEscalationPolicy(value: unknown): QuestionEscalationPolicy {
  const fallback: QuestionEscalationPolicy = {
    reminderOffsetsMinutes: [1_440, 0],
    escalateAfterMinutes: 60,
    escalationAudience: "project_maintainers",
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fallback;
  const candidate = value as Record<string, unknown>;
  const offsets = Array.isArray(candidate.reminderOffsetsMinutes)
    ? [
        ...new Set(
          candidate.reminderOffsetsMinutes.filter(
            (entry): entry is number =>
              Number.isInteger(entry) &&
              Number(entry) >= 0 &&
              Number(entry) <= 10_080,
          ),
        ),
      ].slice(0, 10)
    : fallback.reminderOffsetsMinutes;
  const escalateAfterMinutes =
    candidate.escalateAfterMinutes === null
      ? null
      : Number.isInteger(candidate.escalateAfterMinutes) &&
          Number(candidate.escalateAfterMinutes) >= 0 &&
          Number(candidate.escalateAfterMinutes) <= 43_200
        ? Number(candidate.escalateAfterMinutes)
        : fallback.escalateAfterMinutes;
  const escalationAudience =
    candidate.escalationAudience === null
      ? null
      : candidate.escalationAudience === "project_maintainers" ||
          candidate.escalationAudience === "organization_admins"
        ? candidate.escalationAudience
        : fallback.escalationAudience;
  return {
    reminderOffsetsMinutes: offsets,
    escalateAfterMinutes,
    escalationAudience,
  };
}

/**
 * How far along a provider status is: a callback moves a delivery forward,
 * never back. `requestport_private.record_provider_callback` applies these
 * ranks as a static CASE (0019), which names this map as its source;
 * row-security.integration.test.ts holds the function's CASE to it.
 */
export const providerStatusRank: ReadonlyMap<string, number> = new Map([
  ["pending", 0],
  ["queued", 1],
  ["scheduled", 1],
  ["sent", 2],
  ["delivered", 3],
  ["opened", 4],
  ["clicked", 5],
  ["delivery_delayed", 2],
  ["failed", 6],
  ["bounced", 6],
  ["complained", 6],
  ["suppressed", 6],
  ["canceled", 6],
]);

/** One question `dueQuestionReminders` found, and the instant it found it at. */
export type DueQuestionReminder = {
  questionId: string;
  organizationId: string;
  asOf: Date;
};

/** A discovery function's limit: an integer, or NULL for its default. */
function discoveryLimit(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? null
    : Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.trunc(value)));
}

export function createNotificationRepository(database: Database) {
  return {
    async materializeRequestIntents(eventId: string, baseUrl: string) {
      const eligibleTypes = [
        "request.submitted.v1",
        "request.updated.v1",
        "request.state_changed.v1",
        "request.completion_reported.v1",
        "request.verified.v1",
        "request.assigned.v1",
      ];
      const [record] = await database
        .select({ event: domainEvents, request: requests, project: projects })
        .from(domainEvents)
        .innerJoin(
          organizations,
          and(
            eq(organizations.id, domainEvents.organizationId),
            eq(organizations.status, "active"),
          ),
        )
        .innerJoin(
          requests,
          and(
            eq(requests.id, domainEvents.requestId),
            eq(requests.organizationId, domainEvents.organizationId),
          ),
        )
        .innerJoin(
          projects,
          and(
            eq(projects.id, requests.targetProjectId),
            eq(projects.organizationId, requests.organizationId),
            eq(projects.status, "active"),
          ),
        )
        .where(
          and(
            eq(domainEvents.id, eventId),
            inArray(domainEvents.type, eligibleTypes),
          ),
        )
        .limit(1);
      if (!record) return [];
      const members = await database
        .select({
          userId: organizationMembers.userId,
          organizationRole: organizationMembers.role,
          projectRole: projectMembers.role,
          name: user.name,
          email: user.email,
        })
        .from(organizationMembers)
        .innerJoin(user, eq(user.id, organizationMembers.userId))
        .leftJoin(
          projectMembers,
          and(
            eq(
              projectMembers.organizationId,
              organizationMembers.organizationId,
            ),
            eq(projectMembers.projectId, record.request.targetProjectId),
            eq(projectMembers.userId, organizationMembers.userId),
            eq(projectMembers.status, "active"),
          ),
        )
        .where(
          and(
            eq(
              organizationMembers.organizationId,
              record.request.organizationId,
            ),
            eq(organizationMembers.status, "active"),
          ),
        );
      const actor = record.event.actor as {
        type?: unknown;
        id?: unknown;
        delegatedBy?: { id?: unknown };
      };
      // An assignment (ruling 264) emails the person it names alone, and
      // only while the request is still theirs: an event the worker reaches
      // after a reassignment sends nothing, so only the latest assignee is
      // told. The assigner is never told — the person who assigned, or the
      // person an agent assigned for — and an unassignment names nobody.
      const isAssignment = record.event.type === "request.assigned.v1";
      const assigned = isAssignment
        ? ((
            record.event.data as {
              assignee?: { type?: unknown; id?: unknown } | null;
            }
          ).assignee ?? null)
        : null;
      const recipients = members.filter((member) => {
        if (actor.type === "user" && actor.id === member.userId) return false;
        if (isAssignment) {
          return (
            assigned?.type === "user" &&
            assigned.id === member.userId &&
            record.request.assigneeType === "user" &&
            record.request.assigneeId === member.userId &&
            actor.delegatedBy?.id !== member.userId
          );
        }
        return (
          (record.request.reporterType === "user" &&
            record.request.reporterId === member.userId) ||
          (record.request.assigneeType === "user" &&
            record.request.assigneeId === member.userId) ||
          member.organizationRole === "owner" ||
          member.organizationRole === "admin" ||
          member.projectRole === "maintainer"
        );
      });
      const created: Array<{ id: string; channel: "email" }> = [];
      for (const recipient of recipients) {
        const sensitive = record.request.sensitivity === "sensitive";
        const model = parseNotificationViewModel({
          kind: "request",
          requestId: record.request.id,
          requestKey:
            record.request.displayKey ?? record.request.id.slice(0, 8),
          requestTitle: sensitive
            ? "Sensitive request"
            : outboundText(record.request.title, "Request activity", 240),
          targetProjectName: outboundText(
            record.project.name,
            "Target project",
            160,
          ),
          deepLink: new URL(
            `/requests/${record.request.id}`,
            baseUrl,
          ).toString(),
          recipientName: outboundText(
            recipient.name,
            "RequestPort member",
            160,
          ),
          reason: isAssignment
            ? sensitive
              ? "A sensitive request was assigned to you. Open RequestPort to review it."
              : "This request was assigned to you."
            : sensitive
              ? "Sensitive request activity was recorded. Open RequestPort to review it."
              : `${record.event.type.replace(/\.v\d+$/u, "").replaceAll(".", " ")} was recorded.`,
        });
        const [intent] = await database
          .insert(notificationIntents)
          .values({
            organizationId: record.request.organizationId,
            eventId: record.event.id,
            channel: "email",
            recipientUserId: recipient.userId,
            recipientRef: recipient.email,
            template: "request_event_v1",
            dedupeKey: `request:${record.event.id}:email:${recipient.userId}`,
            viewModel: model,
          })
          .onConflictDoNothing()
          .returning({ id: notificationIntents.id });
        if (intent) created.push({ id: intent.id, channel: "email" });
      }
      return created;
    },

    async materializeInvitationIntents(eventId: string, baseUrl: string) {
      const [record] = await database
        .select({
          event: domainEvents,
          invitation: invitations,
          organizationName: organizations.name,
        })
        .from(domainEvents)
        .innerJoin(
          invitations,
          and(
            eq(invitations.id, domainEvents.aggregateId),
            eq(invitations.organizationId, domainEvents.organizationId),
          ),
        )
        .innerJoin(
          organizations,
          and(
            eq(organizations.id, invitations.organizationId),
            eq(organizations.status, "active"),
          ),
        )
        .where(
          and(
            eq(domainEvents.id, eventId),
            eq(domainEvents.type, "organization.invitation_created.v1"),
            // Only the invitation's current issue sends. Every emitter stamps
            // the event with the invitation's version at the time, and a
            // renewal or a resend raises the version, so an earlier issue's
            // event that reaches the worker late, after a resend, sends
            // nothing rather than a second email beside the resend's.
            eq(domainEvents.aggregateVersion, invitations.version),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            sql`${invitations.expiresAt} > clock_timestamp()`,
          ),
        )
        .limit(1);
      if (!record) return [];
      const model = parseNotificationViewModel({
        kind: "invitation",
        organizationName: outboundText(
          record.organizationName,
          "your organization",
          160,
        ),
        role: record.invitation.role,
        deepLink: new URL("/sign-in", baseUrl).toString(),
        expiresAt: record.invitation.expiresAt.toISOString(),
      });
      const [intent] = await database
        .insert(notificationIntents)
        .values({
          organizationId: record.event.organizationId,
          eventId: record.event.id,
          invitationId: record.invitation.id,
          channel: "email",
          recipientRef: record.invitation.normalizedEmail,
          template: "organization_invitation_v1",
          dedupeKey: `invitation:${record.event.id}:email`,
          viewModel: model,
        })
        .onConflictDoNothing()
        .returning({ id: notificationIntents.id });
      return intent ? [{ id: intent.id, channel: "email" as const }] : [];
    },

    async materializeQuestionIntents(eventId: string, baseUrl: string) {
      const [record] = await database
        .select({
          event: domainEvents,
          question: questions,
          request: requests,
          project: projects,
        })
        .from(domainEvents)
        .innerJoin(
          organizations,
          and(
            eq(organizations.id, domainEvents.organizationId),
            eq(organizations.status, "active"),
          ),
        )
        .innerJoin(
          questions,
          and(
            eq(questions.id, domainEvents.aggregateId),
            eq(questions.organizationId, domainEvents.organizationId),
          ),
        )
        .innerJoin(
          requests,
          and(
            eq(requests.id, questions.parentRequestId),
            eq(requests.organizationId, questions.organizationId),
          ),
        )
        .innerJoin(
          projects,
          and(
            eq(projects.id, requests.targetProjectId),
            eq(projects.organizationId, requests.organizationId),
            eq(projects.status, "active"),
          ),
        )
        .where(
          and(
            eq(domainEvents.id, eventId),
            eq(domainEvents.type, "question.asked.v1"),
            eq(questions.state, "open"),
          ),
        )
        .limit(1);
      if (!record) return [];
      const members = await database
        .select({
          userId: organizationMembers.userId,
          organizationRole: organizationMembers.role,
          projectRole: projectMembers.role,
          name: user.name,
          email: user.email,
        })
        .from(organizationMembers)
        .innerJoin(user, eq(user.id, organizationMembers.userId))
        .leftJoin(
          projectMembers,
          and(
            eq(
              projectMembers.organizationId,
              organizationMembers.organizationId,
            ),
            eq(projectMembers.projectId, record.request.targetProjectId),
            eq(projectMembers.userId, organizationMembers.userId),
            eq(projectMembers.status, "active"),
          ),
        )
        .where(
          and(
            eq(organizationMembers.organizationId, record.event.organizationId),
            eq(organizationMembers.status, "active"),
          ),
        );
      const recipients = members.filter((member) => {
        const type = record.question.audienceType;
        if (type === "user")
          return member.userId === record.question.audienceId;
        if (type === "role")
          return member.organizationRole === record.question.audienceId;
        if (type === "requester")
          return (
            record.request.reporterType === "user" &&
            member.userId === record.request.reporterId
          );
        if (type === "project_maintainers")
          return (
            member.organizationRole === "owner" ||
            member.organizationRole === "admin" ||
            member.projectRole === "maintainer"
          );
        return false;
      });
      if (!recipients.length) return [];
      const userIds = recipients.map((recipient) => recipient.userId);
      const mappings = await database
        .select({
          userId: slackUserMappings.userId,
          slackUserId: slackUserMappings.slackUserId,
        })
        .from(slackUserMappings)
        .where(
          and(
            eq(slackUserMappings.organizationId, record.event.organizationId),
            eq(slackUserMappings.status, "active"),
            inArray(slackUserMappings.userId, userIds),
          ),
        );
      const slackByUser = new Map(
        mappings.map((mapping) => [mapping.userId, mapping.slackUserId]),
      );
      const created: Array<{ id: string; channel: "email" | "slack" }> = [];
      for (const recipient of recipients) {
        const model = parseNotificationViewModel({
          kind: "question",
          requestId: record.request.id,
          requestKey:
            record.request.displayKey ?? record.request.id.slice(0, 8),
          requestTitle:
            record.request.sensitivity === "sensitive"
              ? "Sensitive request"
              : outboundText(record.request.title, "Request", 240),
          targetProjectName: outboundText(
            record.project.name,
            "Target project",
            160,
          ),
          deepLink: new URL(
            `/requests/${record.request.id}`,
            baseUrl,
          ).toString(),
          recipientName: outboundText(
            recipient.name,
            "RequestPort member",
            160,
          ),
          questionId: record.question.id,
          question:
            record.request.sensitivity === "sensitive"
              ? "Open RequestPort to review this sensitive question."
              : outboundText(
                  record.question.bodyMd,
                  "Open RequestPort to review this question.",
                  2_000,
                ),
          choices:
            record.request.sensitivity === "sensitive"
              ? []
              : record.question.choices.map((choice) =>
                  outboundText(
                    choice,
                    "Open RequestPort to review this option",
                    160,
                  ),
                ),
          allowFreeText:
            record.request.sensitivity === "sensitive"
              ? true
              : record.question.allowFreeText,
          actionsEnabled: true,
          deadlineAt: record.question.deadlineAt?.toISOString(),
        });
        const rows = [
          { channel: "email", recipientRef: recipient.email },
          ...(slackByUser.has(recipient.userId)
            ? [
                {
                  channel: "slack",
                  recipientRef: slackByUser.get(recipient.userId) as string,
                },
              ]
            : []),
        ];
        for (const delivery of rows) {
          const [intent] = await database
            .insert(notificationIntents)
            .values({
              organizationId: record.event.organizationId,
              eventId: record.event.id,
              questionId: record.question.id,
              channel: delivery.channel,
              recipientUserId: recipient.userId,
              recipientRef: delivery.recipientRef,
              template: "question_input_needed_v1",
              dedupeKey: `question:${record.event.id}:${delivery.channel}:${delivery.recipientRef}`,
              viewModel: model,
            })
            .onConflictDoNothing()
            .returning({ id: notificationIntents.id });
          if (intent)
            created.push({
              id: intent.id,
              channel: delivery.channel as "email" | "slack",
            });
        }
      }
      return created;
    },

    /**
     * Function 13, the reminders' discovery (manifest-i2.md §5.1): due open
     * questions' ids and organisations (1-200, default 200), with `asOf`, the
     * database's clock read once in the function. The bound half,
     * `materializeQuestionReminder`, uses that instant, so both halves see
     * one; the caller no longer supplies a clock.
     */
    async dueQuestionReminders(limit?: number): Promise<DueQuestionReminder[]> {
      const result = await database.execute<{
        question_id: string;
        organization_id: string;
        as_of: Date | string;
      }>(
        sql`select question_id, organization_id, as_of from requestport_private.due_question_reminders(${discoveryLimit(limit)}::integer)`,
      );
      return result.rows.map((row) => ({
        questionId: row.question_id,
        organizationId: row.organization_id,
        asOf: new Date(row.as_of),
      }));
    },

    /**
     * The bound half of the reminders, for one question discovered by
     * `dueQuestionReminders`, at its `asOf`: the question is read again with
     * its organisation and the same conditions (open, due within 168 hours of
     * `asOf`, its organisation and target project active), and its reminder
     * or escalation intents are created as before. Runs in the processor's
     * unit bound to `due.organizationId`; creates at most `maxIntents`.
     */
    async materializeQuestionReminder(
      baseUrl: string,
      due: DueQuestionReminder,
      maxIntents = 500,
    ) {
      const now = due.asOf;
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error("Database clock is unavailable for question reminders");
      }
      const records = await database
        .select({ question: questions, request: requests, project: projects })
        .from(questions)
        .innerJoin(
          organizations,
          and(
            eq(organizations.id, questions.organizationId),
            eq(organizations.status, "active"),
          ),
        )
        .innerJoin(
          requests,
          and(
            eq(requests.id, questions.parentRequestId),
            eq(requests.organizationId, questions.organizationId),
          ),
        )
        .innerJoin(
          projects,
          and(
            eq(projects.id, requests.targetProjectId),
            eq(projects.organizationId, requests.organizationId),
            eq(projects.status, "active"),
          ),
        )
        .where(
          and(
            eq(questions.organizationId, due.organizationId),
            eq(questions.id, due.questionId),
            eq(questions.state, "open"),
            isNotNull(questions.deadlineAt),
            lte(
              questions.deadlineAt,
              new Date(now.getTime() + 7 * 24 * 60 * 60_000),
            ),
          ),
        )
        .limit(1);
      const created: Array<{ id: string; channel: "email" | "slack" }> = [];
      for (const record of records) {
        const deadline = record.question.deadlineAt;
        if (!deadline) continue;
        const policy = questionEscalationPolicy(
          record.question.escalationPolicy,
        );
        const escalationDue =
          policy.escalateAfterMinutes !== null &&
          policy.escalationAudience !== null &&
          now.getTime() >=
            deadline.getTime() + policy.escalateAfterMinutes * 60_000;
        const dueReminderOffsets = policy.reminderOffsetsMinutes
          .filter(
            (offset) => now.getTime() >= deadline.getTime() - offset * 60_000,
          )
          .sort((left, right) => left - right);
        const reminderOffset = dueReminderOffsets[0];
        if (!escalationDue && reminderOffset === undefined) continue;
        const stage = escalationDue
          ? `escalation:${policy.escalateAfterMinutes}`
          : `reminder:${reminderOffset}`;
        const members = await database
          .select({
            userId: organizationMembers.userId,
            organizationRole: organizationMembers.role,
            projectRole: projectMembers.role,
            name: user.name,
            email: user.email,
          })
          .from(organizationMembers)
          .innerJoin(user, eq(user.id, organizationMembers.userId))
          .leftJoin(
            projectMembers,
            and(
              eq(
                projectMembers.organizationId,
                organizationMembers.organizationId,
              ),
              eq(projectMembers.projectId, record.request.targetProjectId),
              eq(projectMembers.userId, organizationMembers.userId),
              eq(projectMembers.status, "active"),
            ),
          )
          .where(
            and(
              eq(
                organizationMembers.organizationId,
                record.question.organizationId,
              ),
              eq(organizationMembers.status, "active"),
            ),
          );
        const recipients = members.filter((member) => {
          if (escalationDue) {
            return policy.escalationAudience === "organization_admins"
              ? member.organizationRole === "owner" ||
                  member.organizationRole === "admin"
              : member.organizationRole === "owner" ||
                  member.organizationRole === "admin" ||
                  member.projectRole === "maintainer";
          }
          if (record.question.audienceType === "user")
            return member.userId === record.question.audienceId;
          if (record.question.audienceType === "role")
            return member.organizationRole === record.question.audienceId;
          if (record.question.audienceType === "requester")
            return (
              record.request.reporterType === "user" &&
              member.userId === record.request.reporterId
            );
          if (record.question.audienceType === "project_maintainers")
            return (
              member.organizationRole === "owner" ||
              member.organizationRole === "admin" ||
              member.projectRole === "maintainer"
            );
          return false;
        });
        if (!recipients.length) continue;
        const mappings = await database
          .select({
            userId: slackUserMappings.userId,
            slackUserId: slackUserMappings.slackUserId,
          })
          .from(slackUserMappings)
          .where(
            and(
              eq(
                slackUserMappings.organizationId,
                record.question.organizationId,
              ),
              eq(slackUserMappings.status, "active"),
              inArray(
                slackUserMappings.userId,
                recipients.map((item) => item.userId),
              ),
            ),
          );
        const slackByUser = new Map(
          mappings.map((mapping) => [mapping.userId, mapping.slackUserId]),
        );
        for (const recipient of recipients) {
          const model = parseNotificationViewModel({
            kind: "question",
            requestId: record.request.id,
            requestKey:
              record.request.displayKey ?? record.request.id.slice(0, 8),
            requestTitle:
              record.request.sensitivity === "sensitive"
                ? "Sensitive request"
                : outboundText(record.request.title, "Request", 240),
            targetProjectName: outboundText(
              record.project.name,
              "Target project",
              160,
            ),
            deepLink: new URL(
              `/requests/${record.request.id}`,
              baseUrl,
            ).toString(),
            recipientName: outboundText(
              recipient.name,
              "RequestPort member",
              160,
            ),
            questionId: record.question.id,
            question:
              record.request.sensitivity === "sensitive"
                ? "Open RequestPort to review this sensitive question."
                : outboundText(
                    record.question.bodyMd,
                    "Open RequestPort to review this question.",
                    2_000,
                  ),
            choices:
              record.request.sensitivity === "sensitive"
                ? []
                : record.question.choices.map((choice) =>
                    outboundText(
                      choice,
                      "Open RequestPort to review this option",
                      160,
                    ),
                  ),
            allowFreeText:
              record.request.sensitivity === "sensitive"
                ? true
                : record.question.allowFreeText,
            actionsEnabled: !escalationDue,
            escalationAudience: escalationDue
              ? policy.escalationAudience
              : undefined,
            reason: escalationDue
              ? "Escalation: this question remains unanswered after its deadline."
              : reminderOffset === 0
                ? "Reminder: this question is due now."
                : `Reminder: this question is due in ${reminderOffset} minutes.`,
            deadlineAt: record.question.deadlineAt?.toISOString(),
          });
          const channels = [
            { channel: "email" as const, recipientRef: recipient.email },
            ...(slackByUser.has(recipient.userId)
              ? [
                  {
                    channel: "slack" as const,
                    recipientRef: slackByUser.get(recipient.userId) as string,
                  },
                ]
              : []),
          ];
          for (const channel of channels) {
            if (created.length >= maxIntents) return created;
            const intent = await database.transaction(async (transaction) => {
              await transaction.execute(sql`
                select pg_advisory_xact_lock(hashtextextended(
                  'requestport:question-reminder:' || ${record.question.id} || ':' || ${channel.channel} || ':' || ${channel.recipientRef},
                  0
                ))
              `);
              const recent = await transaction.execute<{ count: number }>(sql`
                select count(*)::integer as count
                from ${notificationIntents}
                where ${notificationIntents.organizationId} = ${record.question.organizationId}
                  and ${notificationIntents.recipientUserId} = ${recipient.userId}
                  and ${notificationIntents.channel} = ${channel.channel}
                  and ${notificationIntents.createdAt} > clock_timestamp() - interval '1 hour'
              `);
              if (Number(recent.rows[0]?.count ?? 0) >= 20) return null;
              const quiet = await transaction.execute<{ present: number }>(sql`
                select 1::integer as present
                from ${notificationIntents}
                where ${notificationIntents.organizationId} = ${record.question.organizationId}
                  and ${notificationIntents.questionId} = ${record.question.id}
                  and ${notificationIntents.recipientUserId} = ${recipient.userId}
                  and ${notificationIntents.channel} = ${channel.channel}
                  and ${notificationIntents.createdAt} > clock_timestamp() - interval '15 minutes'
                limit 1
              `);
              if (quiet.rows.length > 0) return null;
              const [inserted] = await transaction
                .insert(notificationIntents)
                .values({
                  organizationId: record.question.organizationId,
                  questionId: record.question.id,
                  channel: channel.channel,
                  recipientUserId: recipient.userId,
                  recipientRef: channel.recipientRef,
                  template: escalationDue
                    ? "question_escalation_v1"
                    : "question_reminder_v1",
                  dedupeKey: `question:${record.question.id}:${stage}:${channel.channel}:${recipient.userId}`,
                  viewModel: model,
                })
                .onConflictDoNothing()
                .returning({ id: notificationIntents.id });
              return inserted ?? null;
            });
            if (intent)
              created.push({ id: intent.id, channel: channel.channel });
          }
        }
      }
      return created;
    },

    async claimNotificationIntent(input: {
      intentId: string;
      channel: "email" | "slack";
      leaseOwner: string;
    }) {
      const [claimed] = await database
        .update(notificationIntents)
        .set({
          status: "delivering",
          attemptCount: sql`${notificationIntents.attemptCount} + 1`,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: sql`clock_timestamp() + interval '20 minutes'`,
          lastErrorCode: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(notificationIntents.id, input.intentId),
            eq(notificationIntents.channel, input.channel),
            lt(notificationIntents.attemptCount, maxNotificationAttempts),
            or(
              and(
                inArray(notificationIntents.status, ["pending", "failed"]),
                isNotNull(notificationIntents.nextAttemptAt),
                lte(notificationIntents.nextAttemptAt, sql`clock_timestamp()`),
              ),
              and(
                eq(notificationIntents.status, "delivering"),
                or(
                  isNull(notificationIntents.leaseExpiresAt),
                  lte(
                    notificationIntents.leaseExpiresAt,
                    sql`clock_timestamp()`,
                  ),
                ),
              ),
            ),
          ),
        )
        .returning({ attemptCount: notificationIntents.attemptCount });
      return claimed ?? null;
    },

    /**
     * Function 6: due intents' ids, organisations and channels (1-500,
     * default 100); the repair enqueues by channel.
     */
    async dueNotificationIntents(limit = 100) {
      const result = await database.execute<{
        intent_id: string;
        organization_id: string;
        channel: string;
      }>(
        sql`select intent_id, organization_id, channel from requestport_private.due_notification_intents(${discoveryLimit(limit)}::integer)`,
      );
      return result.rows.map((row) => ({
        id: row.intent_id,
        organizationId: row.organization_id,
        channel: row.channel,
      }));
    },

    async loadPendingIntent(
      intentId: string,
      channel: "email" | "slack",
      leaseOwner?: string,
    ) {
      const [baseIntent] = await database
        .select()
        .from(notificationIntents)
        .where(
          and(
            eq(notificationIntents.id, intentId),
            eq(notificationIntents.channel, channel),
            eq(notificationIntents.status, "delivering"),
            leaseOwner
              ? eq(notificationIntents.leaseOwner, leaseOwner)
              : sql`false`,
            isNotNull(notificationIntents.leaseExpiresAt),
            gt(notificationIntents.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .limit(1);
      if (!baseIntent) return null;
      if (baseIntent.invitationId) {
        if (channel !== "email") return null;
        const [activeInvitation] = await database
          .select({ email: invitations.normalizedEmail })
          .from(invitations)
          .innerJoin(
            organizations,
            and(
              eq(organizations.id, invitations.organizationId),
              eq(organizations.status, "active"),
            ),
          )
          .where(
            and(
              eq(invitations.id, baseIntent.invitationId),
              eq(invitations.organizationId, baseIntent.organizationId),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
              sql`${invitations.expiresAt} > clock_timestamp()`,
            ),
          )
          .limit(1);
        return activeInvitation
          ? { ...baseIntent, recipientRef: activeInvitation.email }
          : null;
      }
      if (!baseIntent.questionId) {
        if (
          channel !== "email" ||
          !baseIntent.eventId ||
          !baseIntent.recipientUserId
        ) {
          return null;
        }
        const [activeRecipient] = await database
          .select({
            email: user.email,
            userId: organizationMembers.userId,
            organizationRole: organizationMembers.role,
            projectRole: projectMembers.role,
            reporterType: requests.reporterType,
            reporterId: requests.reporterId,
            assigneeType: requests.assigneeType,
            assigneeId: requests.assigneeId,
          })
          .from(notificationIntents)
          .innerJoin(
            domainEvents,
            and(
              eq(domainEvents.id, notificationIntents.eventId),
              eq(
                domainEvents.organizationId,
                notificationIntents.organizationId,
              ),
            ),
          )
          .innerJoin(
            requests,
            and(
              eq(requests.id, domainEvents.requestId),
              eq(requests.organizationId, notificationIntents.organizationId),
            ),
          )
          .innerJoin(
            organizations,
            and(
              eq(organizations.id, notificationIntents.organizationId),
              eq(organizations.status, "active"),
            ),
          )
          .innerJoin(
            projects,
            and(
              eq(projects.id, requests.targetProjectId),
              eq(projects.organizationId, notificationIntents.organizationId),
              eq(projects.status, "active"),
            ),
          )
          .innerJoin(
            organizationMembers,
            and(
              eq(
                organizationMembers.organizationId,
                notificationIntents.organizationId,
              ),
              eq(
                organizationMembers.userId,
                notificationIntents.recipientUserId,
              ),
              eq(organizationMembers.status, "active"),
            ),
          )
          .innerJoin(user, eq(user.id, notificationIntents.recipientUserId))
          .leftJoin(
            projectMembers,
            and(
              eq(
                projectMembers.organizationId,
                notificationIntents.organizationId,
              ),
              eq(projectMembers.projectId, requests.targetProjectId),
              eq(projectMembers.userId, notificationIntents.recipientUserId),
              eq(projectMembers.status, "active"),
            ),
          )
          .where(eq(notificationIntents.id, baseIntent.id))
          .limit(1);
        if (!activeRecipient) return null;
        const stillEligible =
          (activeRecipient.reporterType === "user" &&
            activeRecipient.reporterId === activeRecipient.userId) ||
          (activeRecipient.assigneeType === "user" &&
            activeRecipient.assigneeId === activeRecipient.userId) ||
          activeRecipient.organizationRole === "owner" ||
          activeRecipient.organizationRole === "admin" ||
          activeRecipient.projectRole === "maintainer";
        return stillEligible
          ? { ...baseIntent, recipientRef: activeRecipient.email }
          : null;
      }
      const [intent] = await database
        .select({
          intent: notificationIntents,
          currentEmail: user.email,
          audienceType: questions.audienceType,
          audienceId: questions.audienceId,
          reporterType: requests.reporterType,
          reporterId: requests.reporterId,
          organizationRole: organizationMembers.role,
          projectRole: projectMembers.role,
          currentSlackUserId: slackUserMappings.slackUserId,
        })
        .from(notificationIntents)
        .innerJoin(
          questions,
          and(
            eq(questions.id, notificationIntents.questionId),
            eq(questions.organizationId, notificationIntents.organizationId),
            eq(questions.state, "open"),
          ),
        )
        .innerJoin(
          requests,
          and(
            eq(requests.id, questions.parentRequestId),
            eq(requests.organizationId, notificationIntents.organizationId),
          ),
        )
        .innerJoin(
          organizations,
          and(
            eq(organizations.id, notificationIntents.organizationId),
            eq(organizations.status, "active"),
          ),
        )
        .innerJoin(
          projects,
          and(
            eq(projects.id, requests.targetProjectId),
            eq(projects.organizationId, notificationIntents.organizationId),
            eq(projects.status, "active"),
          ),
        )
        .innerJoin(
          organizationMembers,
          and(
            eq(
              organizationMembers.organizationId,
              notificationIntents.organizationId,
            ),
            eq(organizationMembers.userId, notificationIntents.recipientUserId),
            eq(organizationMembers.status, "active"),
          ),
        )
        .innerJoin(user, eq(user.id, notificationIntents.recipientUserId))
        .leftJoin(
          projectMembers,
          and(
            eq(
              projectMembers.organizationId,
              notificationIntents.organizationId,
            ),
            eq(projectMembers.projectId, requests.targetProjectId),
            eq(projectMembers.userId, notificationIntents.recipientUserId),
            eq(projectMembers.status, "active"),
          ),
        )
        .leftJoin(
          slackUserMappings,
          and(
            eq(
              slackUserMappings.organizationId,
              notificationIntents.organizationId,
            ),
            eq(slackUserMappings.userId, notificationIntents.recipientUserId),
            eq(slackUserMappings.slackUserId, notificationIntents.recipientRef),
            eq(slackUserMappings.status, "active"),
          ),
        )
        .where(and(eq(notificationIntents.id, baseIntent.id)))
        .limit(1);
      if (!intent) return null;
      const parsedModel = parseNotificationViewModel(intent.intent.viewModel);
      const escalationAudience =
        parsedModel.kind === "question"
          ? parsedModel.escalationAudience
          : undefined;
      const stillEligible =
        intent.intent.template === "question_escalation_v1"
          ? intent.organizationRole === "owner" ||
            intent.organizationRole === "admin" ||
            (escalationAudience === "project_maintainers" &&
              intent.projectRole === "maintainer")
          : (intent.audienceType === "user" &&
              intent.audienceId === intent.intent.recipientUserId) ||
            (intent.audienceType === "role" &&
              intent.audienceId === intent.organizationRole) ||
            (intent.audienceType === "requester" &&
              intent.reporterType === "user" &&
              intent.reporterId === intent.intent.recipientUserId) ||
            (intent.audienceType === "project_maintainers" &&
              (intent.organizationRole === "owner" ||
                intent.organizationRole === "admin" ||
                intent.projectRole === "maintainer"));
      if (!stillEligible) return null;
      if (
        channel === "slack" &&
        intent.currentSlackUserId !== intent.intent.recipientRef
      ) {
        return null;
      }
      return {
        ...intent.intent,
        recipientRef:
          channel === "email"
            ? intent.currentEmail
            : intent.intent.recipientRef,
      };
    },

    async completeNotificationIntent(
      intentId: string,
      channel: "email" | "slack",
      leaseOwner: string,
      status: "delivered" | "suppressed",
    ) {
      const [completed] = await database
        .update(notificationIntents)
        .set({
          status,
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(notificationIntents.id, intentId),
            eq(notificationIntents.channel, channel),
            eq(notificationIntents.status, "delivering"),
            eq(notificationIntents.leaseOwner, leaseOwner),
          ),
        )
        .returning({ id: notificationIntents.id });
      return Boolean(completed);
    },

    async failNotificationIntent(input: {
      intentId: string;
      channel: "email" | "slack";
      leaseOwner: string;
      attemptCount: number;
      errorCode: string;
    }) {
      const terminal = input.attemptCount >= maxNotificationAttempts;
      const retryDelay = notificationRetryDelaySeconds(input.attemptCount);
      const [failed] = await database
        .update(notificationIntents)
        .set({
          status: "failed",
          nextAttemptAt: terminal
            ? null
            : sql`clock_timestamp() + (${retryDelay} * interval '1 second')`,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: input.errorCode,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(notificationIntents.id, input.intentId),
            eq(notificationIntents.channel, input.channel),
            eq(notificationIntents.status, "delivering"),
            eq(notificationIntents.leaseOwner, input.leaseOwner),
          ),
        )
        .returning({ id: notificationIntents.id });
      return { updated: Boolean(failed), terminal };
    },

    async suppressPendingIntent(
      intentId: string,
      channel: "email" | "slack",
      leaseOwner: string,
    ) {
      await database
        .update(notificationIntents)
        .set({
          status: "suppressed",
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(notificationIntents.id, intentId),
            eq(notificationIntents.channel, channel),
            eq(notificationIntents.status, "delivering"),
            eq(notificationIntents.leaseOwner, leaseOwner),
          ),
        );
    },

    async ensureEmailDelivery(organizationId: string, intentId: string) {
      const idempotencyKey = `requestport-notification-${intentId}`;
      const [created] = await database
        .insert(emailDeliveries)
        .values({
          organizationId,
          notificationIntentId: intentId,
          idempotencyKey,
        })
        .onConflictDoNothing()
        .returning({ id: emailDeliveries.id });
      if (created) return { id: created.id, idempotencyKey };
      const [existing] = await database
        .select({ id: emailDeliveries.id })
        .from(emailDeliveries)
        .where(
          and(
            eq(emailDeliveries.organizationId, organizationId),
            eq(emailDeliveries.notificationIntentId, intentId),
            eq(emailDeliveries.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Email delivery allocation failed");
      return { id: existing.id, idempotencyKey };
    },

    async completeEmailDelivery(input: {
      intentId: string;
      deliveryId: string;
      providerMessageId: string;
      leaseOwner: string;
    }) {
      return database.transaction(async (tx) => {
        const [completed] = await tx
          .update(notificationIntents)
          .set({
            status: "delivered",
            nextAttemptAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(notificationIntents.id, input.intentId),
              eq(notificationIntents.channel, "email"),
              eq(notificationIntents.status, "delivering"),
              eq(notificationIntents.leaseOwner, input.leaseOwner),
            ),
          )
          .returning({ id: notificationIntents.id });
        if (!completed) return false;
        await tx
          .update(emailDeliveries)
          .set({
            providerMessageId: input.providerMessageId,
            status: "sent",
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(emailDeliveries.id, input.deliveryId));
        return true;
      });
    },

    async failEmailDelivery(input: {
      intentId: string;
      deliveryId: string;
      leaseOwner: string;
      attemptCount: number;
      errorCode: string;
    }) {
      const terminal = input.attemptCount >= maxNotificationAttempts;
      const retryDelay = notificationRetryDelaySeconds(input.attemptCount);
      const updated = await database.transaction(async (tx) => {
        const [failed] = await tx
          .update(notificationIntents)
          .set({
            status: "failed",
            nextAttemptAt: terminal
              ? null
              : sql`clock_timestamp() + (${retryDelay} * interval '1 second')`,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: input.errorCode,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(notificationIntents.id, input.intentId),
              eq(notificationIntents.channel, "email"),
              eq(notificationIntents.status, "delivering"),
              eq(notificationIntents.leaseOwner, input.leaseOwner),
            ),
          )
          .returning({ id: notificationIntents.id });
        if (!failed) return false;
        await tx
          .update(emailDeliveries)
          .set({ status: "failed", updatedAt: sql`clock_timestamp()` })
          .where(eq(emailDeliveries.id, input.deliveryId));
        return true;
      });
      return { terminal, updated };
    },

    /**
     * Record a provider's callback once, and move the delivery it names
     * forward. The receipt is global and the delivery is found by the
     * provider's message id in whichever organisation holds it, so a definer
     * function does both (manifest-i2.md §2.5.0). It answers only
     * `processed`, `duplicate` or `conflict`, never whether a delivery
     * matched, and computes the body's SHA-256 over its UTF-8 bytes, as
     * Node's `createHash` does over the same string. It writes, so it runs
     * in a transaction
     * (§2.5.0 item 7).
     */
    async recordProviderCallback(input: {
      provider: string;
      eventId: string;
      rawBody: string;
      occurredAt: Date;
      providerMessageId?: string;
      status: string;
    }) {
      return database.transaction(async (tx) => {
        const { rows } = await tx.execute(
          sql`select requestport_private.record_provider_callback(${input.provider}, ${input.eventId}, ${input.rawBody}, ${input.occurredAt}::timestamptz, ${input.providerMessageId ?? null}, ${input.status}) as outcome`,
        );
        const outcome = (rows[0] as { outcome: string } | undefined)?.outcome;
        if (outcome === "processed")
          return { duplicate: false, conflict: false };
        if (outcome === "duplicate")
          return { duplicate: true, conflict: false };
        if (outcome === "conflict") return { duplicate: true, conflict: true };
        throw new Error("Provider callback outcome is unrecognised");
      });
    },

    async listQuestionDeliveries(
      organizationId: string,
      questionId: string,
      userId: string,
    ) {
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          const [access] = await transaction
            .select({ role: organizationMembers.role })
            .from(organizationMembers)
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, organizationMembers.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .where(
              and(
                eq(organizationMembers.organizationId, organizationId),
                eq(organizationMembers.userId, userId),
                eq(organizationMembers.status, "active"),
                inArray(organizationMembers.role, ["owner", "admin"]),
              ),
            )
            .for("share")
            .limit(1);
          if (!access) return [];
          const intents = await transaction
            .select({
              id: notificationIntents.id,
              channel: notificationIntents.channel,
              recipientUserId: notificationIntents.recipientUserId,
              template: notificationIntents.template,
              status: notificationIntents.status,
              attemptCount: notificationIntents.attemptCount,
              nextAttemptAt: notificationIntents.nextAttemptAt,
              lastErrorCode: notificationIntents.lastErrorCode,
              createdAt: notificationIntents.createdAt,
            })
            .from(notificationIntents)
            .where(
              and(
                eq(notificationIntents.organizationId, organizationId),
                eq(notificationIntents.questionId, questionId),
              ),
            )
            .orderBy(asc(notificationIntents.createdAt));
          if (!intents.length) return [];
          const ids = intents.map((intent) => intent.id);
          const [emails, slack] = await inTurn([
            () =>
              transaction
                .select({
                  intentId: emailDeliveries.notificationIntentId,
                  providerMessageId: emailDeliveries.providerMessageId,
                  status: emailDeliveries.status,
                  updatedAt: emailDeliveries.updatedAt,
                })
                .from(emailDeliveries)
                .where(inArray(emailDeliveries.notificationIntentId, ids)),
            () =>
              transaction
                .select({
                  intentId: slackDeliveries.notificationIntentId,
                  channelId: slackDeliveries.channelId,
                  messageTs: slackDeliveries.messageTs,
                  status: slackDeliveries.status,
                  updatedAt: slackDeliveries.updatedAt,
                })
                .from(slackDeliveries)
                .where(inArray(slackDeliveries.notificationIntentId, ids)),
          ]);
          return intents.map((intent) => ({
            ...intent,
            attempts:
              intent.channel === "email"
                ? emails.filter((item) => item.intentId === intent.id)
                : slack.filter((item) => item.intentId === intent.id),
          }));
        },
      );
    },
  };
}
