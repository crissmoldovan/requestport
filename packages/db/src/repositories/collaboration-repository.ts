import {
  type AnswerRecord,
  type CollaborationRepository,
  DomainError,
  type JsonValue,
  type QuestionAudience,
  type QuestionRecord,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  agentPrincipals,
  answers,
  artifacts,
  messageMentions,
  messages,
  organizationMembers,
  projects,
  questions,
  requestRelationships,
  requests,
} from "../schema/index.js";
import type { Tx } from "../transaction.js";

type CollaborationDatabase = Database | Tx;

function actor(type: string, id: string) {
  if (type === "user") return { type: "user" as const, id };
  if (type === "agent") return { type: "agent" as const, id };
  return { type: "service" as const, id };
}

function audience(type: string, id: string | null): QuestionAudience {
  if (type === "user") return { type, id: id as string };
  if (type === "agent") return { type, id: id as string };
  if (type === "role") return { type, id: id as "owner" | "admin" | "member" };
  if (type === "requester") return { type };
  return { type: "project_maintainers" };
}

function questionRecord(row: typeof questions.$inferSelect): QuestionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    requestId: row.parentRequestId as string,
    audience: audience(row.audienceType, row.audienceId),
    bodyMd: row.bodyMd,
    choices: row.choices,
    allowFreeText: row.allowFreeText,
    askedBy: actor(row.askedByType, row.askedById),
    answerMode: row.answerMode as QuestionRecord["answerMode"],
    blocksRequest: row.blocksRequest,
    resumeState: row.resumeState as QuestionRecord["resumeState"],
    state: row.state as QuestionRecord["state"],
    version: row.version,
    deadlineAt: row.deadlineAt,
  };
}

function answerRecord(row: typeof answers.$inferSelect): AnswerRecord {
  return {
    id: row.id,
    questionId: row.questionId,
    actor: actor(row.actorType, row.actorId),
    sourceChannel: row.sourceChannel as AnswerRecord["sourceChannel"],
    bodyMd: row.bodyMd,
    structuredValue: (row.structuredValue as JsonValue | null) ?? null,
    accepted: row.accepted,
    createdAt: row.createdAt,
  };
}

export function createCollaborationRepository(
  database: CollaborationDatabase,
): CollaborationRepository {
  return {
    async createMessage(input) {
      if (input.replyToId) {
        const [reply] = await database
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.id, input.replyToId),
              eq(messages.organizationId, input.request.organizationId),
              eq(messages.requestId, input.request.id),
            ),
          )
          .limit(1);
        if (!reply)
          throw new DomainError("not_found", "Reply target was not found");
      }
      if (input.mentionUserIds.length > 0) {
        const rows = await database.execute<{ user_id: string }>(
          sql`select ${organizationMembers.userId} as user_id
              from ${organizationMembers}
              where ${organizationMembers.organizationId} = ${input.request.organizationId}
                and ${organizationMembers.status} = 'active'
                and ${organizationMembers.userId} in (${sql.join(
                  input.mentionUserIds.map((id) => sql`${id}`),
                  sql`, `,
                )})`,
        );
        if (
          new Set(rows.rows.map((row) => row.user_id)).size !==
          input.mentionUserIds.length
        ) {
          throw new DomainError(
            "validation_failed",
            "Mentioned user is not an active organization member",
          );
        }
      }
      await database.insert(messages).values({
        id: input.id,
        organizationId: input.request.organizationId,
        requestId: input.request.id,
        actorType: input.actor.type,
        actorId: input.actor.id,
        bodyMd: input.bodyMd,
        visibility: input.visibility,
        replyToId: input.replyToId,
      });
      if (input.mentionUserIds.length > 0) {
        await database.insert(messageMentions).values(
          input.mentionUserIds.map((userId) => ({
            messageId: input.id,
            organizationId: input.request.organizationId,
            userId,
          })),
        );
      }
    },

    async createQuestion(input) {
      if (input.audience.type === "user") {
        const [recipient] = await database
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(
            and(
              eq(
                organizationMembers.organizationId,
                input.request.organizationId,
              ),
              eq(organizationMembers.userId, input.audience.id),
              eq(organizationMembers.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (!recipient) {
          throw new DomainError(
            "validation_failed",
            "Question recipient is not an active organization member",
          );
        }
      }
      if (input.audience.type === "agent") {
        const [recipient] = await database
          .select({ id: agentPrincipals.id })
          .from(agentPrincipals)
          .innerJoin(
            projects,
            and(
              eq(projects.organizationId, agentPrincipals.organizationId),
              eq(projects.id, input.request.targetProjectId),
              eq(projects.status, "active"),
            ),
          )
          .where(
            and(
              eq(agentPrincipals.organizationId, input.request.organizationId),
              eq(agentPrincipals.id, input.audience.id),
              eq(agentPrincipals.status, "active"),
              sql`(${agentPrincipals.projectId} is null or ${agentPrincipals.projectId} = ${input.request.targetProjectId})`,
            ),
          )
          .for("share")
          .limit(1);
        if (!recipient) {
          throw new DomainError(
            "validation_failed",
            "Question recipient is not an active target-project agent",
          );
        }
      }
      const [created] = await database
        .insert(questions)
        .values({
          id: input.id,
          organizationId: input.request.organizationId,
          subjectType: "request",
          subjectId: input.request.id,
          parentRequestId: input.request.id,
          audienceType: input.audience.type,
          audienceId: "id" in input.audience ? input.audience.id : null,
          bodyMd: input.bodyMd,
          choices: input.choices,
          allowFreeText: input.allowFreeText,
          askedByType: input.actor.type,
          askedById: input.actor.id,
          answerMode: input.answerMode,
          blocksRequest: input.blocksRequest,
          resumeState: input.resumeState,
          state: "open",
          version: 1,
          deadlineAt: input.deadlineAt,
          escalationPolicy: input.escalationPolicy,
        })
        .returning();
      if (!created) throw new Error("Question persistence failed");
      return questionRecord(created);
    },

    async findQuestionForUpdate(organizationId, questionId) {
      const [found] = await database
        .select()
        .from(questions)
        .where(
          and(
            eq(questions.organizationId, organizationId),
            eq(questions.id, questionId),
          ),
        )
        .for("update")
        .limit(1);
      return found ? questionRecord(found) : null;
    },

    async findCanonicalAnswer(questionId) {
      const [found] = await database
        .select()
        .from(answers)
        .where(
          and(eq(answers.questionId, questionId), eq(answers.accepted, true)),
        )
        .limit(1);
      return found ? answerRecord(found) : null;
    },

    async createAnswer(input) {
      const [created] = await database
        .insert(answers)
        .values({
          id: input.id,
          organizationId: input.question.organizationId,
          questionId: input.question.id,
          actorType: input.actor.type,
          actorId: input.actor.id,
          sourceChannel: input.sourceChannel,
          bodyMd: input.bodyMd,
          structuredValue: input.structuredValue,
          accepted: input.accepted,
        })
        .returning();
      if (!created) throw new Error("Answer persistence failed");
      return answerRecord(created);
    },

    async updateQuestion(input) {
      const closes = input.state === "answered" || input.state === "closed";
      const [updated] = await database
        .update(questions)
        .set({
          state: input.state,
          version: input.expectedVersion + 1,
          closedByType: closes ? input.closedBy?.type : null,
          closedById: closes ? input.closedBy?.id : null,
          closedReason: closes ? input.closedReason : null,
          closedAt: closes ? new Date() : null,
        })
        .where(
          and(
            eq(questions.id, input.questionId),
            eq(questions.organizationId, input.organizationId),
            eq(questions.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!updated)
        throw new DomainError(
          "version_conflict",
          "Question changed concurrently",
        );
      return questionRecord(updated);
    },

    async countOtherOpenBlockingQuestions(requestId, excludingQuestionId) {
      const result = await database.execute<{ count: string | number }>(
        sql`select count(*) as count
            from ${questions}
            where ${questions.parentRequestId} = ${requestId}
              and ${questions.blocksRequest} = true
              and ${questions.state} = 'open'
              and ${questions.id} <> ${excludingQuestionId}`,
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async createRelationship(input) {
      const endpoints = await database
        .select({ id: requests.id })
        .from(requests)
        .where(
          and(
            eq(requests.organizationId, input.organizationId),
            sql`${requests.id} in (${input.fromRequestId}, ${input.toRequestId})`,
          ),
        );
      if (new Set(endpoints.map((row) => row.id)).size !== 2) {
        throw new DomainError("not_found", "Related request was not found");
      }
      await database.insert(requestRelationships).values({
        id: input.id,
        organizationId: input.organizationId,
        fromRequestId: input.fromRequestId,
        toRequestId: input.toRequestId,
        type: input.type,
        createdByType: input.actor.type,
        createdById: input.actor.id,
      });
    },

    async removeRelationship(input) {
      const [removed] = await database
        .delete(requestRelationships)
        .where(
          and(
            eq(requestRelationships.organizationId, input.organizationId),
            eq(requestRelationships.id, input.relationshipId),
          ),
        )
        .returning({
          id: requestRelationships.id,
          fromRequestId: requestRelationships.fromRequestId,
          toRequestId: requestRelationships.toRequestId,
          type: requestRelationships.type,
        });
      return removed ?? null;
    },

    async createArtifact(input) {
      await database.insert(artifacts).values({
        id: input.id,
        organizationId: input.request.organizationId,
        requestId: input.request.id,
        kind: input.kind,
        externalUrl: input.externalUrl,
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        sha256: input.sha256,
        provenance: input.provenance,
        createdByType: input.actor.type,
        createdById: input.actor.id,
      });
    },
  };
}
