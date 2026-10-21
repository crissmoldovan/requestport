import {
  type AuthorizedCommandContext,
  type CompletionReportInput,
  DomainError,
  type RequestActorAccess,
  type RequestRecord,
  type RequestRepository,
} from "@requestport/domain";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  agentPrincipals,
  artifacts,
  completionReports,
  lanes,
  organizationMembers,
  organizations,
  projectMembers,
  projectRepositories,
  projectSequences,
  projects,
  requestAcceptanceCriteria,
  requestLabels,
  requestRelationships,
  requests,
  stateTransitions,
  workSessions,
} from "../schema/index.js";
import type { Tx } from "../transaction.js";
import {
  lockActiveApiKeyAuthorization,
  lockActiveOAuthAuthorization,
} from "./agent-authorization.js";

type RequestDatabase = Database | Tx;

function actor(type: string, id: string) {
  if (type === "user") return { type: "user" as const, id };
  if (type === "agent") return { type: "agent" as const, id };
  return { type: "service" as const, id };
}

function requestRecord(row: typeof requests.$inferSelect): RequestRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    sequenceNumber: row.sequenceNumber,
    displayKey: row.displayKey,
    source:
      row.sourceKind === "project"
        ? { kind: "project", projectId: row.sourceProjectId as string }
        : { kind: "human_direct" },
    targetProjectId: row.targetProjectId,
    laneId: row.laneId,
    type: row.type as RequestRecord["type"],
    title: row.title,
    descriptionMd: row.descriptionMd,
    priority: row.priority as RequestRecord["priority"],
    visibility: row.visibility as RequestRecord["visibility"],
    sensitivity: row.sensitivity as RequestRecord["sensitivity"],
    state: row.state as RequestRecord["state"],
    resumeState: row.resumeState as RequestRecord["resumeState"],
    stateReason: row.stateReason,
    reporter: actor(row.reporterType, row.reporterId),
    assignee:
      row.assigneeType && row.assigneeId
        ? actor(row.assigneeType, row.assigneeId)
        : null,
    version: row.version,
    routingRuleId: row.routingRuleId,
    routingPolicyVersion: row.routingPolicyVersion,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt,
    updatedAt: row.updatedAt,
  };
}

function sameActor(
  left: RequestRecord["reporter"],
  right: RequestRecord["reporter"],
) {
  return left.type === right.type && left.id === right.id;
}

async function lockActiveOrganization(
  database: RequestDatabase,
  organizationId: string,
) {
  const [organization] = await database
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .for("share")
    .limit(1);
  return Boolean(organization);
}

async function lockActiveActor(
  database: RequestDatabase,
  context: AuthorizedCommandContext,
) {
  if (!(await lockActiveOrganization(database, context.organizationId))) {
    return false;
  }
  if (context.actor.type === "user") {
    const [membership] = await database
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, context.organizationId),
          eq(organizationMembers.userId, context.actor.id),
          eq(organizationMembers.status, "active"),
        ),
      )
      .for("share")
      .limit(1);
    return Boolean(membership);
  }
  if (context.actor.type !== "agent" || !context.projectId) return false;
  const [principal] = await database
    .select({ id: agentPrincipals.id })
    .from(agentPrincipals)
    .where(
      and(
        eq(agentPrincipals.organizationId, context.organizationId),
        eq(agentPrincipals.id, context.actor.id),
        or(
          isNull(agentPrincipals.projectId),
          eq(agentPrincipals.projectId, context.projectId),
        ),
        eq(agentPrincipals.status, "active"),
      ),
    )
    .for("share")
    .limit(1);
  if (!principal) return false;
  const credential = !context.actor.delegatedBy
    ? await lockActiveApiKeyAuthorization(database, {
        organizationId: context.organizationId,
        agentPrincipalId: context.actor.id,
        authorizationId: context.credentialId,
        projectId: context.projectId,
      })
    : null;
  if (credential) return true;
  const grant = context.actor.delegatedBy
    ? await lockActiveOAuthAuthorization(database, {
        organizationId: context.organizationId,
        agentPrincipalId: context.actor.id,
        authorizationId: context.credentialId,
        delegatedByUserId: context.actor.delegatedBy.id,
        projectId: context.projectId,
      })
    : null;
  return Boolean(grant);
}

export function createRequestRepository(
  database: RequestDatabase,
): RequestRepository {
  return {
    async validateDraftOwnership(input) {
      if (!(await lockActiveActor(database, input.context))) return false;
      if (
        input.context.actor.type === "agent" &&
        input.targetProjectId === input.context.projectId &&
        input.context.laneIds?.size &&
        (!input.laneId || !input.context.laneIds.has(input.laneId))
      ) {
        return false;
      }
      /*
        The projects this draft touches, deduplicated.

        A set rather than a list because the two can be the same project, and
        the comparison below counts distinct rows: an agent filing into the
        project it is bound to supplies the same id as source and as target, so
        a list of length two was measured against one distinct row found and
        the most ordinary request an agent can make was refused as "outside the
        active organization". Nothing noticed, because this function had no test
        and a fake repository cannot reproduce arithmetic that lives here.
      */
      const projectIds = new Set([input.targetProjectId]);
      if (input.source.kind === "project")
        projectIds.add(input.source.projectId);
      const owned = await database.execute<{ id: string }>(
        sql`select ${projects.id} as id
            from ${projects}
            where ${projects.organizationId} = ${input.organizationId}
              and ${projects.status} = 'active'
              and ${projects.id} in (${sql.join(
                [...projectIds].map((id) => sql`${id}`),
                sql`, `,
              )})
            for share`,
      );
      if (new Set(owned.rows.map((row) => row.id)).size !== projectIds.size)
        return false;
      if (
        input.context.actor.type === "user" &&
        input.source.kind === "project"
      ) {
        const [organizationAccess] = await database
          .select({ role: organizationMembers.role })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, input.organizationId),
              eq(organizationMembers.userId, input.context.actor.id),
              eq(organizationMembers.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (
          organizationAccess?.role !== "owner" &&
          organizationAccess?.role !== "admin"
        ) {
          const [projectAccess] = await database
            .select({ id: projectMembers.id })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.organizationId, input.organizationId),
                eq(projectMembers.projectId, input.source.projectId),
                eq(projectMembers.userId, input.context.actor.id),
                eq(projectMembers.status, "active"),
              ),
            )
            .for("share")
            .limit(1);
          if (!projectAccess) return false;
        }
      }
      if (!input.laneId) return true;
      const [lane] = await database
        .select({ id: lanes.id })
        .from(lanes)
        .where(
          and(
            eq(lanes.id, input.laneId),
            eq(lanes.organizationId, input.organizationId),
            eq(lanes.projectId, input.targetProjectId),
            eq(lanes.status, "active"),
          ),
        )
        .for("share")
        .limit(1);
      return Boolean(lane);
    },

    async createDraft(input) {
      const [created] = await database
        .insert(requests)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          sourceKind: input.source.kind,
          sourceProjectId:
            input.source.kind === "project" ? input.source.projectId : null,
          targetProjectId: input.targetProjectId,
          laneId: input.laneId,
          type: input.type,
          title: input.title,
          descriptionMd: input.descriptionMd,
          priority: input.priority,
          visibility: input.visibility,
          sensitivity: input.sensitivity,
          state: "draft",
          reporterType: input.reporter.type,
          reporterId: input.reporter.id,
          version: 1,
        })
        .returning();
      if (!created) throw new Error("Request persistence failed");
      if (input.labels.length > 0) {
        await database
          .insert(requestLabels)
          .values(
            input.labels.map((label) => ({ requestId: created.id, label })),
          );
      }
      if (input.acceptanceCriteria.length > 0) {
        await database.insert(requestAcceptanceCriteria).values(
          input.acceptanceCriteria.map((text, position) => ({
            requestId: created.id,
            position,
            text,
          })),
        );
      }
      return requestRecord(created);
    },

    async findForUpdate(organizationId, requestId) {
      if (!(await lockActiveOrganization(database, organizationId)))
        return null;
      const [candidate] = await database
        .select({ targetProjectId: requests.targetProjectId })
        .from(requests)
        .where(
          and(
            eq(requests.organizationId, organizationId),
            eq(requests.id, requestId),
          ),
        )
        .limit(1);
      if (!candidate) return null;
      const [project] = await database
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, organizationId),
            eq(projects.id, candidate.targetProjectId),
            eq(projects.status, "active"),
          ),
        )
        .for("share")
        .limit(1);
      if (!project) return null;
      const [found] = await database
        .select()
        .from(requests)
        .where(
          and(
            eq(requests.organizationId, organizationId),
            eq(requests.id, requestId),
          ),
        )
        .for("update")
        .limit(1);
      return found ? requestRecord(found) : null;
    },

    async actorAccess(request, context): Promise<RequestActorAccess> {
      const actorRef = context.actor;
      if (
        actorRef.type === "agent" &&
        request.targetProjectId === context.projectId &&
        context.laneIds?.size &&
        (!request.laneId || !context.laneIds.has(request.laneId))
      ) {
        return {
          organizationRole: null,
          projectRole: null,
          isReporter: false,
          hasExclusiveClaim: false,
          isActiveWorker: false,
          explicitTriageGrant: false,
        };
      }
      if (!(await lockActiveActor(database, context))) {
        return {
          organizationRole: null,
          projectRole: null,
          isReporter: false,
          hasExclusiveClaim: false,
          isActiveWorker: false,
          explicitTriageGrant: false,
        };
      }
      if (actorRef.type === "agent") {
        const [claim] = await database
          .select({ state: workSessions.state })
          .from(workSessions)
          .where(
            and(
              eq(workSessions.organizationId, request.organizationId),
              eq(workSessions.requestId, request.id),
              eq(workSessions.agentPrincipalId, actorRef.id),
              sql`${workSessions.state} in ('claimed', 'active', 'paused', 'blocked')`,
              sql`${workSessions.leaseExpiresAt} > clock_timestamp()`,
              sql`${workSessions.authorizationChain}->>'authorizationId' = ${context.credentialId}`,
              actorRef.delegatedBy
                ? sql`${workSessions.authorizationChain}->>'delegatedByUserId' = ${actorRef.delegatedBy.id}`
                : sql`coalesce(${workSessions.authorizationChain}->>'delegatedByUserId', '') = ''`,
            ),
          )
          .for("share")
          .limit(1);
        const [delegatedMembership] = actorRef.delegatedBy
          ? await database
              .select({ role: organizationMembers.role })
              .from(organizationMembers)
              .where(
                and(
                  eq(
                    organizationMembers.organizationId,
                    request.organizationId,
                  ),
                  eq(organizationMembers.userId, actorRef.delegatedBy.id),
                  eq(organizationMembers.status, "active"),
                ),
              )
              .for("share")
              .limit(1)
          : [];
        const [delegatedProjectMembership] = actorRef.delegatedBy
          ? await database
              .select({ role: projectMembers.role })
              .from(projectMembers)
              .where(
                and(
                  eq(projectMembers.organizationId, request.organizationId),
                  eq(projectMembers.projectId, request.targetProjectId),
                  eq(projectMembers.userId, actorRef.delegatedBy.id),
                  eq(projectMembers.status, "active"),
                ),
              )
              .for("share")
              .limit(1)
          : [];
        const delegatedReporter = Boolean(
          actorRef.delegatedBy &&
            request.reporter.type === "user" &&
            request.reporter.id === actorRef.delegatedBy.id,
        );
        return {
          organizationRole:
            (delegatedMembership?.role as RequestActorAccess["organizationRole"]) ??
            null,
          projectRole:
            (delegatedProjectMembership?.role as RequestActorAccess["projectRole"]) ??
            null,
          isReporter:
            sameActor(request.reporter, actorRef) || delegatedReporter,
          hasExclusiveClaim: Boolean(claim),
          isActiveWorker:
            claim?.state === "active" ||
            claim?.state === "paused" ||
            claim?.state === "blocked",
          explicitTriageGrant:
            delegatedMembership?.role === "owner" ||
            delegatedMembership?.role === "admin" ||
            delegatedProjectMembership?.role === "maintainer",
        };
      }
      if (actorRef.type !== "user") {
        return {
          organizationRole: null,
          projectRole: null,
          isReporter: false,
          hasExclusiveClaim: false,
          isActiveWorker: false,
          explicitTriageGrant: false,
        };
      }
      const [membership] = await database
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, request.organizationId),
            eq(organizationMembers.userId, actorRef.id),
            eq(organizationMembers.status, "active"),
          ),
        )
        .for("share")
        .limit(1);
      const [projectMembership] = await database
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.organizationId, request.organizationId),
            eq(projectMembers.projectId, request.targetProjectId),
            eq(projectMembers.userId, actorRef.id),
            eq(projectMembers.status, "active"),
          ),
        )
        .for("share")
        .limit(1);
      return {
        organizationRole:
          (membership?.role as RequestActorAccess["organizationRole"]) ?? null,
        projectRole:
          (projectMembership?.role as RequestActorAccess["projectRole"]) ??
          null,
        isReporter: sameActor(request.reporter, actorRef),
        hasExclusiveClaim: false,
        isActiveWorker: false,
        explicitTriageGrant:
          membership?.role === "owner" ||
          membership?.role === "admin" ||
          projectMembership?.role === "maintainer",
      };
    },

    async canReference(organizationId, requestId, context) {
      if (context.organizationId !== organizationId) return false;
      if (!(await lockActiveActor(database, context))) return false;
      const [candidate] = await database
        .select({
          visibility: requests.visibility,
          sourceProjectId: requests.sourceProjectId,
          targetProjectId: requests.targetProjectId,
          laneId: requests.laneId,
          reporterType: requests.reporterType,
          reporterId: requests.reporterId,
          assigneeType: requests.assigneeType,
          assigneeId: requests.assigneeId,
        })
        .from(requests)
        .innerJoin(
          projects,
          and(
            eq(projects.organizationId, requests.organizationId),
            eq(projects.id, requests.targetProjectId),
            eq(projects.status, "active"),
          ),
        )
        .where(
          and(
            eq(requests.organizationId, organizationId),
            eq(requests.id, requestId),
          ),
        )
        .limit(1);
      if (!candidate) return false;
      if (context.actor.type === "agent") {
        if (
          context.projectId !== candidate.sourceProjectId &&
          context.projectId !== candidate.targetProjectId
        ) {
          return false;
        }
        if (
          context.projectId === candidate.targetProjectId &&
          context.laneIds?.size &&
          (!candidate.laneId || !context.laneIds.has(candidate.laneId))
        ) {
          return false;
        }
        return true;
      }
      if (context.actor.type !== "user") return false;
      const [membership] = await database
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, context.actor.id),
            eq(organizationMembers.status, "active"),
          ),
        )
        .for("share")
        .limit(1);
      if (!membership) return false;
      if (
        candidate.visibility === "organization" ||
        membership.role === "owner" ||
        membership.role === "admin" ||
        (candidate.reporterType === "user" &&
          candidate.reporterId === context.actor.id) ||
        (candidate.assigneeType === "user" &&
          candidate.assigneeId === context.actor.id)
      ) {
        return true;
      }
      const projectIds = [
        candidate.targetProjectId,
        ...(candidate.sourceProjectId ? [candidate.sourceProjectId] : []),
      ];
      const [projectMembership] = await database
        .select({ id: projectMembers.id })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.organizationId, organizationId),
            eq(projectMembers.userId, context.actor.id),
            eq(projectMembers.status, "active"),
            sql`${projectMembers.projectId} in (${sql.join(
              projectIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
        .for("share")
        .limit(1);
      return Boolean(projectMembership);
    },

    async hasAcceptanceCriteria(requestId) {
      const [criterion] = await database
        .select({ id: requestAcceptanceCriteria.id })
        .from(requestAcceptanceCriteria)
        .where(eq(requestAcceptanceCriteria.requestId, requestId))
        .limit(1);
      return Boolean(criterion);
    },

    async allocateDisplayKey(request) {
      await database
        .insert(projectSequences)
        .values({
          organizationId: request.organizationId,
          projectId: request.targetProjectId,
          nextRequestNumber: 1,
        })
        .onConflictDoNothing();
      const allocation = await database.execute<{
        next_request_number: number;
        key_prefix: string;
      }>(sql`select ps.next_request_number, p.key_prefix
             from ${projectSequences} ps
             inner join ${projects} p
               on p.organization_id = ps.organization_id
              and p.id = ps.project_id
             where ps.organization_id = ${request.organizationId}
               and ps.project_id = ${request.targetProjectId}
             for update of ps`);
      const row = allocation.rows[0];
      if (!row) throw new Error("Request display key allocation failed");
      await database
        .update(projectSequences)
        .set({ nextRequestNumber: row.next_request_number + 1 })
        .where(
          and(
            eq(projectSequences.organizationId, request.organizationId),
            eq(projectSequences.projectId, request.targetProjectId),
          ),
        );
      return {
        sequenceNumber: row.next_request_number,
        displayKey: `${row.key_prefix}-${row.next_request_number}`,
      };
    },

    async transition(input) {
      const now = new Date();
      const [updated] = await database
        .update(requests)
        .set({
          state: input.toState,
          resumeState: input.resumeState,
          stateReason: input.reason,
          sequenceNumber: input.display?.sequenceNumber,
          displayKey: input.display?.displayKey,
          routingRuleId: input.routingRuleId,
          routingPolicyVersion: input.routingPolicyVersion,
          version: input.expectedVersion + 1,
          submittedAt: input.fromState === "draft" ? now : undefined,
          updatedAt: now,
        })
        .where(
          and(
            eq(requests.id, input.requestId),
            eq(requests.organizationId, input.organizationId),
            eq(requests.state, input.fromState),
            eq(requests.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!updated) {
        throw new DomainError(
          "version_conflict",
          "Request changed concurrently",
        );
      }
      return requestRecord(updated);
    },

    async updateContent(input) {
      const [updated] = await database
        .update(requests)
        .set({
          title: input.title,
          descriptionMd: input.descriptionMd,
          priority: input.priority,
          visibility: input.visibility,
          sensitivity: input.sensitivity,
          version: input.expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(requests.id, input.requestId),
            eq(requests.organizationId, input.organizationId),
            eq(requests.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!updated) {
        throw new DomainError(
          "version_conflict",
          "Request changed concurrently",
        );
      }
      return requestRecord(updated);
    },

    async insertStateTransition(input) {
      await database.insert(stateTransitions).values({
        id: input.id,
        organizationId: input.request.organizationId,
        requestId: input.request.id,
        fromState: input.fromState,
        toState: input.request.state,
        action: input.action,
        reason: input.reason,
        actorType: input.actor.type,
        actorId: input.actor.id,
        requestVersion: input.request.version,
        eventId: input.eventId,
      });
    },

    async createCompletionReport(input) {
      await database.insert(completionReports).values({
        id: input.id,
        organizationId: input.request.organizationId,
        requestId: input.request.id,
        actorType: input.actor.type,
        actorId: input.actor.id,
        outcomeMd: input.report.outcomeMd,
        changedRepositories: input.report.changedRepositories,
        validations: input.report.validations,
        risksMd: input.report.risksMd,
        followupsMd: input.report.followupsMd,
        verificationStepsMd: input.report.verificationStepsMd,
      });
    },

    async validateCompletionReferences(request, report: CompletionReportInput) {
      const repositoryIds = [
        ...new Set(
          report.changedRepositories.flatMap((entry) =>
            entry.repositoryId ? [entry.repositoryId] : [],
          ),
        ),
      ];
      const artifactIds = [
        ...new Set(
          report.changedRepositories.flatMap((entry) =>
            entry.artifactId ? [entry.artifactId] : [],
          ),
        ),
      ];

      if (repositoryIds.length > 0) {
        const found = await database.execute<{ id: string }>(
          sql`select ${projectRepositories.id} as id
              from ${projectRepositories}
              where ${projectRepositories.organizationId} = ${request.organizationId}
                and ${projectRepositories.id} in (${sql.join(
                  repositoryIds.map((id) => sql`${id}`),
                  sql`, `,
                )})
              for share`,
        );
        if (
          new Set(found.rows.map((row) => row.id)).size !== repositoryIds.length
        ) {
          return false;
        }
      }

      if (artifactIds.length > 0) {
        const found = await database.execute<{ id: string }>(
          sql`select ${artifacts.id} as id
              from ${artifacts}
              where ${artifacts.organizationId} = ${request.organizationId}
                and ${artifacts.requestId} = ${request.id}
                and ${artifacts.id} in (${sql.join(
                  artifactIds.map((id) => sql`${id}`),
                  sql`, `,
                )})
              for share`,
        );
        if (
          new Set(found.rows.map((row) => row.id)).size !== artifactIds.length
        ) {
          return false;
        }
      }

      return true;
    },

    async addRelationship(input) {
      const [target] = await database
        .select({ id: requests.id })
        .from(requests)
        .where(
          and(
            eq(requests.organizationId, input.organizationId),
            eq(requests.id, input.toRequestId),
          ),
        )
        .limit(1);
      if (!target)
        throw new DomainError("not_found", "Related request was not found");
      const [created] = await database
        .insert(requestRelationships)
        .values({
          organizationId: input.organizationId,
          fromRequestId: input.fromRequestId,
          toRequestId: input.toRequestId,
          type: input.type,
          createdByType: input.actor.type,
          createdById: input.actor.id,
        })
        .returning({ id: requestRelationships.id });
      if (!created) throw new Error("Request relationship persistence failed");
      return created;
    },
  };
}
