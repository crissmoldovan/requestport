import {
  DomainError,
  decodeCursor,
  encodeCursor,
  type JsonValue,
  normalizePageLimit,
} from "@requestport/domain";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import type { Database } from "../client.js";
import { inTurn } from "../in-turn.js";
import {
  lockActiveApiKeyAuthorization,
  lockActiveOAuthAuthorization,
} from "../repositories/agent-authorization.js";
import {
  agentPrincipals,
  answers,
  artifacts,
  domainEvents,
  messages,
  organizationMembers,
  organizations,
  projectAliases,
  projectMembers,
  projectRepositories,
  projects,
  questions,
  requestAcceptanceCriteria,
  requestLabels,
  requestRelationships,
  requests,
  workSessions,
} from "../schema/index.js";
import { inTenantTransaction } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { publicEventProjection } from "./public-event.js";

export type AgentQueryContext = {
  actor: {
    type: "agent";
    id: string;
    delegatedBy?: { type: "user"; id: string };
  };
  organizationId: string;
  projectId: string;
  laneIds: ReadonlySet<string>;
  scopes: ReadonlySet<string>;
  authorizationId: string;
};

type AgentQueryDatabase = Database | Tx;

async function requireActiveAuthorization(
  database: AgentQueryDatabase,
  context: AgentQueryContext,
) {
  const [principal] = await database
    .select({ id: agentPrincipals.id })
    .from(agentPrincipals)
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, agentPrincipals.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .innerJoin(
      projects,
      and(
        eq(projects.organizationId, agentPrincipals.organizationId),
        eq(projects.id, context.projectId),
        eq(projects.status, "active"),
      ),
    )
    .where(
      and(
        eq(agentPrincipals.organizationId, context.organizationId),
        eq(agentPrincipals.id, context.actor.id),
        eq(agentPrincipals.status, "active"),
        or(
          isNull(agentPrincipals.projectId),
          eq(agentPrincipals.projectId, context.projectId),
        ),
      ),
    )
    .for("share")
    .limit(1);
  if (!principal) {
    throw new DomainError("forbidden", "Agent authorization is inactive");
  }
  const delegatedByUserId = context.actor.delegatedBy?.id ?? null;
  const credential = !delegatedByUserId
    ? await lockActiveApiKeyAuthorization(database, {
        organizationId: context.organizationId,
        agentPrincipalId: context.actor.id,
        authorizationId: context.authorizationId,
        projectId: context.projectId,
      })
    : null;
  const grant = delegatedByUserId
    ? await lockActiveOAuthAuthorization(database, {
        organizationId: context.organizationId,
        agentPrincipalId: context.actor.id,
        authorizationId: context.authorizationId,
        delegatedByUserId,
        projectId: context.projectId,
      })
    : null;
  if (!credential && !grant) {
    throw new DomainError("forbidden", "Agent authorization is inactive");
  }
}

async function withActiveAuthorization<T>(
  database: AgentQueryDatabase,
  context: AgentQueryContext,
  operation: (transaction: AgentQueryDatabase) => Promise<T>,
) {
  return inTenantTransaction(
    database,
    context.organizationId,
    async (transaction) => {
      await requireActiveAuthorization(transaction, context);
      return operation(transaction);
    },
  );
}

function visibleRequest(context: AgentQueryContext) {
  return and(
    eq(requests.organizationId, context.organizationId),
    or(
      eq(requests.sourceProjectId, context.projectId),
      and(
        eq(requests.targetProjectId, context.projectId),
        ...(context.laneIds.size > 0
          ? [inArray(requests.laneId, [...context.laneIds])]
          : []),
      ),
    ),
  ) as SQL;
}

function page<T extends { id: string; occurredAt?: Date; updatedAt?: Date }>(
  rows: T[],
  limit: number,
) {
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
    ...row,
    ...(row.occurredAt ? { occurredAt: row.occurredAt.toISOString() } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt.toISOString() } : {}),
  }));
  const last = (hasMore ? rows.slice(0, limit) : rows).at(-1);
  return {
    items: items as JsonValue[],
    nextCursor:
      hasMore && last
        ? encodeCursor({
            at: last.occurredAt ?? last.updatedAt ?? new Date(0),
            id: last.id,
          })
        : null,
  };
}

async function listEventsAuthorized(
  database: AgentQueryDatabase,
  context: AgentQueryContext,
  cursor?: string,
  requestId?: string,
): Promise<JsonValue> {
  const limit = 100;
  const parsed = decodeCursor(cursor);
  const targetLaneVisibility =
    context.laneIds.size > 0
      ? sql`and er.lane_id in (${sql.join(
          [...context.laneIds].map((laneId) => sql`${laneId}`),
          sql`, `,
        )})`
      : sql``;
  const conditions: SQL[] = [
    eq(domainEvents.organizationId, context.organizationId),
    requestId
      ? (and(
          eq(domainEvents.requestId, requestId),
          sql`exists (
            select 1 from ${requests} requested_event_request
            where requested_event_request.organization_id = ${context.organizationId}
              and requested_event_request.id = ${requestId}
              and (
                requested_event_request.source_project_id = ${context.projectId}
                or (
                  requested_event_request.target_project_id = ${context.projectId}
                  ${
                    context.laneIds.size > 0
                      ? sql`and requested_event_request.lane_id in (${sql.join(
                          [...context.laneIds].map((laneId) => sql`${laneId}`),
                          sql`, `,
                        )})`
                      : sql``
                  }
                )
              )
          )`,
        ) as SQL)
      : sql`(
        (${domainEvents.requestId} is null and ${domainEvents.projectId} = ${context.projectId})
        or exists (
          select 1 from ${requests} er
          where er.organization_id = ${context.organizationId}
            and er.id = ${domainEvents.requestId}
            and (
              er.source_project_id = ${context.projectId}
              or (
                er.target_project_id = ${context.projectId}
                ${targetLaneVisibility}
              )
            )
        ))`,
  ];
  if (parsed) {
    conditions.push(
      or(
        lt(domainEvents.occurredAt, parsed.at),
        and(
          eq(domainEvents.occurredAt, parsed.at),
          lt(domainEvents.id, parsed.id),
        ),
      ) as SQL,
    );
  }
  const rows = await database
    .select({
      id: domainEvents.id,
      type: domainEvents.type,
      schemaVersion: domainEvents.schemaVersion,
      occurredAt: domainEvents.occurredAt,
      aggregateType: domainEvents.aggregateType,
      aggregateId: domainEvents.aggregateId,
      aggregateVersion: domainEvents.aggregateVersion,
      projectId: domainEvents.projectId,
      requestId: domainEvents.requestId,
      actor: domainEvents.actor,
      data: domainEvents.data,
      links: domainEvents.links,
    })
    .from(domainEvents)
    .where(and(...conditions))
    .orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id))
    .limit(limit + 1);
  return page(
    rows.map((row) => ({ ...row, ...publicEventProjection(row) })),
    limit,
  );
}

export function createAgentQueryRepository(database: AgentQueryDatabase) {
  return {
    async getAgentPolicy(context: AgentQueryContext) {
      return withActiveAuthorization(database, context, async (authorized) => {
        const [policy] = await authorized
          .select({
            heartbeatIntervalSeconds: projects.heartbeatIntervalSeconds,
            leaseMultiplier: projects.leaseMultiplier,
            graceSeconds: projects.graceSeconds,
            requiredWorkspaceFields: projects.requiredWorkspaceFields,
          })
          .from(projects)
          .where(
            and(
              eq(projects.organizationId, context.organizationId),
              eq(projects.id, context.projectId),
              eq(projects.status, "active"),
            ),
          )
          .limit(1);
        return policy ?? null;
      });
    },

    async listOrganizations(context: AgentQueryContext): Promise<JsonValue> {
      return withActiveAuthorization(database, context, async (authorized) => {
        const [organization] = await authorized
          .select({
            id: organizations.id,
            name: organizations.name,
            slug: organizations.slug,
            status: organizations.status,
          })
          .from(organizations)
          .innerJoin(
            projects,
            and(
              eq(projects.organizationId, organizations.id),
              eq(projects.id, context.projectId),
              eq(projects.status, "active"),
            ),
          )
          .where(
            and(
              eq(organizations.id, context.organizationId),
              eq(organizations.status, "active"),
            ),
          )
          .limit(1);
        return { items: organization ? [organization] : [] };
      });
    },

    async listProjects(context: AgentQueryContext): Promise<JsonValue> {
      return withActiveAuthorization(database, context, async (authorized) => {
        const rows = await authorized
          .select({
            id: projects.id,
            name: projects.name,
            slug: projects.slug,
            keyPrefix: projects.keyPrefix,
            description: projects.description,
            status: projects.status,
            heartbeatIntervalSeconds: projects.heartbeatIntervalSeconds,
            leaseMultiplier: projects.leaseMultiplier,
            graceSeconds: projects.graceSeconds,
            requiredWorkspaceFields: projects.requiredWorkspaceFields,
          })
          .from(projects)
          .where(
            and(
              eq(projects.organizationId, context.organizationId),
              eq(projects.id, context.projectId),
              eq(projects.status, "active"),
            ),
          );
        return { items: rows };
      });
    },

    async getProject(
      context: AgentQueryContext,
      projectId: string,
    ): Promise<JsonValue> {
      return withActiveAuthorization(database, context, async (authorized) => {
        if (projectId !== context.projectId) return null;
        const [project] = await authorized
          .select({
            id: projects.id,
            name: projects.name,
            slug: projects.slug,
            keyPrefix: projects.keyPrefix,
            description: projects.description,
            status: projects.status,
            heartbeatIntervalSeconds: projects.heartbeatIntervalSeconds,
            leaseMultiplier: projects.leaseMultiplier,
            graceSeconds: projects.graceSeconds,
            requiredWorkspaceFields: projects.requiredWorkspaceFields,
          })
          .from(projects)
          .where(
            and(
              eq(projects.organizationId, context.organizationId),
              eq(projects.id, projectId),
              eq(projects.status, "active"),
            ),
          )
          .limit(1);
        if (!project) return null;
        const [repositories, aliases] = await inTurn([
          () =>
            authorized
              .select({
                id: projectRepositories.id,
                provider: projectRepositories.provider,
                browseUrl: projectRepositories.browseUrl,
                repositorySlug: projectRepositories.repositorySlug,
                isDefault: projectRepositories.isDefault,
              })
              .from(projectRepositories)
              .where(
                and(
                  eq(
                    projectRepositories.organizationId,
                    context.organizationId,
                  ),
                  eq(projectRepositories.projectId, projectId),
                  eq(projectRepositories.status, "active"),
                ),
              ),
          () =>
            authorized
              .select({ alias: projectAliases.alias })
              .from(projectAliases)
              .where(
                and(
                  eq(projectAliases.organizationId, context.organizationId),
                  eq(projectAliases.projectId, projectId),
                ),
              ),
        ]);
        return {
          ...project,
          repositories,
          aliases: aliases.map((row) => row.alias),
        };
      });
    },

    async listRequests(
      context: AgentQueryContext,
      input: { cursor?: string; limit?: number; state?: string[] },
    ): Promise<JsonValue> {
      return withActiveAuthorization(database, context, async (authorized) => {
        const limit = normalizePageLimit(input.limit);
        const cursor = decodeCursor(input.cursor);
        const conditions: SQL[] = [visibleRequest(context)];
        if (input.state?.length)
          conditions.push(inArray(requests.state, input.state));
        if (cursor) {
          conditions.push(
            or(
              lt(requests.updatedAt, cursor.at),
              and(
                eq(requests.updatedAt, cursor.at),
                lt(requests.id, cursor.id),
              ),
            ) as SQL,
          );
        }
        const rows = await authorized
          .select({
            id: requests.id,
            displayKey: requests.displayKey,
            title: requests.title,
            type: requests.type,
            priority: requests.priority,
            state: requests.state,
            sourceKind: requests.sourceKind,
            sourceProjectId: requests.sourceProjectId,
            targetProjectId: requests.targetProjectId,
            laneId: requests.laneId,
            version: requests.version,
            updatedAt: requests.updatedAt,
          })
          .from(requests)
          .where(and(...conditions))
          .orderBy(desc(requests.updatedAt), desc(requests.id))
          .limit(limit + 1);
        return page(rows, limit);
      });
    },

    async getRequest(
      context: AgentQueryContext,
      requestId: string,
    ): Promise<JsonValue> {
      return withActiveAuthorization(database, context, async (authorized) => {
        const [request] = await authorized
          .select()
          .from(requests)
          .where(and(visibleRequest(context), eq(requests.id, requestId)))
          .limit(1);
        if (!request) return null;
        const [
          labels,
          criteria,
          messageRows,
          questionRows,
          artifactRows,
          sessionRows,
          relationshipRows,
        ] = await inTurn([
          () =>
            authorized
              .select({ label: requestLabels.label })
              .from(requestLabels)
              .where(eq(requestLabels.requestId, requestId)),
          () =>
            authorized
              .select({
                id: requestAcceptanceCriteria.id,
                position: requestAcceptanceCriteria.position,
                text: requestAcceptanceCriteria.text,
                satisfiedAt: requestAcceptanceCriteria.satisfiedAt,
              })
              .from(requestAcceptanceCriteria)
              .where(eq(requestAcceptanceCriteria.requestId, requestId))
              .orderBy(requestAcceptanceCriteria.position),
          () =>
            authorized
              .select({
                id: messages.id,
                actorType: messages.actorType,
                actorId: messages.actorId,
                bodyMd: messages.bodyMd,
                visibility: messages.visibility,
                createdAt: messages.createdAt,
              })
              .from(messages)
              .where(
                and(
                  eq(messages.organizationId, context.organizationId),
                  eq(messages.requestId, requestId),
                ),
              )
              .orderBy(messages.createdAt),
          () =>
            authorized
              .select()
              .from(questions)
              .where(
                and(
                  eq(questions.organizationId, context.organizationId),
                  eq(questions.parentRequestId, requestId),
                ),
              )
              .orderBy(questions.createdAt),
          () =>
            authorized
              .select({
                id: artifacts.id,
                kind: artifacts.kind,
                externalUrl: artifacts.externalUrl,
                mediaType: artifacts.mediaType,
                byteSize: artifacts.byteSize,
                sha256: artifacts.sha256,
                provenance: artifacts.provenance,
                createdAt: artifacts.createdAt,
              })
              .from(artifacts)
              .where(
                and(
                  eq(artifacts.organizationId, context.organizationId),
                  eq(artifacts.requestId, requestId),
                ),
              )
              .orderBy(artifacts.createdAt),
          () =>
            authorized
              .select({
                id: workSessions.id,
                agentPrincipalId: workSessions.agentPrincipalId,
                state: workSessions.state,
                version: workSessions.version,
                heartbeatIntervalSeconds: workSessions.heartbeatIntervalSeconds,
                leaseExpiresAt: workSessions.leaseExpiresAt,
                startedAt: workSessions.startedAt,
                endedAt: workSessions.endedAt,
              })
              .from(workSessions)
              .where(
                and(
                  eq(workSessions.organizationId, context.organizationId),
                  eq(workSessions.requestId, requestId),
                ),
              )
              .orderBy(desc(workSessions.createdAt)),
          () =>
            authorized.execute<{
              id: string;
              direction: "incoming" | "outgoing";
              type: string;
              request_id: string;
              display_key: string | null;
              title: string;
            }>(sql`
            select
              rr.id,
              case when rr.from_request_id = ${requestId} then 'outgoing' else 'incoming' end as direction,
              rr.type,
              related.id as request_id,
              related.display_key,
              related.title
            from ${requestRelationships} rr
            inner join ${requests} related
              on related.id = case
                when rr.from_request_id = ${requestId} then rr.to_request_id
                else rr.from_request_id
              end
            where rr.organization_id = ${context.organizationId}
              and (rr.from_request_id = ${requestId} or rr.to_request_id = ${requestId})
              and related.organization_id = ${context.organizationId}
              and (
                related.source_project_id = ${context.projectId}
                or (
                  related.target_project_id = ${context.projectId}
                  ${
                    context.laneIds.size > 0
                      ? sql`and related.lane_id in (${sql.join(
                          [...context.laneIds].map((laneId) => sql`${laneId}`),
                          sql`, `,
                        )})`
                      : sql``
                  }
                )
              )
            order by rr.created_at, rr.id
          `),
        ]);
        const questionIds = questionRows.map((row) => row.id);
        const answerRows = questionIds.length
          ? await authorized
              .select({
                id: answers.id,
                questionId: answers.questionId,
                actorType: answers.actorType,
                actorId: answers.actorId,
                sourceChannel: answers.sourceChannel,
                bodyMd: answers.bodyMd,
                accepted: answers.accepted,
                createdAt: answers.createdAt,
              })
              .from(answers)
              .where(inArray(answers.questionId, questionIds))
              .orderBy(answers.createdAt)
          : [];
        return {
          id: request.id,
          displayKey: request.displayKey,
          title: request.title,
          descriptionMd: request.descriptionMd,
          type: request.type,
          priority: request.priority,
          state: request.state,
          stateReason: request.stateReason,
          sourceKind: request.sourceKind,
          sourceProjectId: request.sourceProjectId,
          targetProjectId: request.targetProjectId,
          laneId: request.laneId,
          reporter: { type: request.reporterType, id: request.reporterId },
          version: request.version,
          createdAt: request.createdAt.toISOString(),
          updatedAt: request.updatedAt.toISOString(),
          labels: labels.map((row) => row.label),
          acceptanceCriteria: criteria.map((row) => ({
            ...row,
            satisfiedAt: row.satisfiedAt?.toISOString() ?? null,
          })),
          relationships: relationshipRows.rows.map((row) => ({
            id: row.id,
            direction: row.direction,
            type: row.type,
            requestId: row.request_id,
            displayKey: row.display_key,
            title: row.title,
          })),
          messages: messageRows.map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
          })),
          questions: questionRows.map((question) => ({
            id: question.id,
            audienceType: question.audienceType,
            audienceId: question.audienceId,
            bodyMd: question.bodyMd,
            choices: question.choices,
            allowFreeText: question.allowFreeText,
            answerMode: question.answerMode,
            blocksRequest: question.blocksRequest,
            state: question.state,
            deadlineAt: question.deadlineAt?.toISOString() ?? null,
            version: question.version,
            answers: answerRows
              .filter((answer) => answer.questionId === question.id)
              .map((answer) => ({
                ...answer,
                createdAt: answer.createdAt.toISOString(),
              })),
          })),
          artifacts: artifactRows.map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
          })),
          sessions: sessionRows.map((row) => ({
            ...row,
            leaseExpiresAt: row.leaseExpiresAt.toISOString(),
            startedAt: row.startedAt?.toISOString() ?? null,
            endedAt: row.endedAt?.toISOString() ?? null,
          })),
        } as JsonValue;
      });
    },

    async listTimeline(
      context: AgentQueryContext,
      requestId: string,
      cursor?: string,
    ): Promise<JsonValue> {
      return withActiveAuthorization(database, context, async (authorized) => {
        const [visible] = await authorized
          .select({ id: requests.id })
          .from(requests)
          .where(and(visibleRequest(context), eq(requests.id, requestId)))
          .limit(1);
        if (!visible) return { items: [], nextCursor: null };
        return listEventsAuthorized(authorized, context, cursor, requestId);
      });
    },

    async listOpenQuestions(
      context: AgentQueryContext,
      cursor?: string,
    ): Promise<JsonValue> {
      return withActiveAuthorization(database, context, async (authorized) => {
        const limit = 50;
        const parsed = decodeCursor(cursor);
        const delegatedUserId = context.actor.delegatedBy?.id ?? null;
        const targetLaneAudience =
          context.laneIds.size > 0
            ? sql`and r.lane_id in (${sql.join(
                [...context.laneIds].map((laneId) => sql`${laneId}`),
                sql`, `,
              )})`
            : sql``;
        const delegatedAudience = delegatedUserId
          ? sql`or (
            (${questions.audienceType} = 'user' and ${questions.audienceId} = ${delegatedUserId})
            or (${questions.audienceType} = 'requester' and r.reporter_type = 'user' and r.reporter_id = ${delegatedUserId})
            or (${questions.audienceType} = 'role' and exists (
              select 1 from ${organizationMembers} delegated_role_member
              where delegated_role_member.organization_id = ${context.organizationId}
                and delegated_role_member.user_id = ${delegatedUserId}
                and delegated_role_member.status = 'active'
                and delegated_role_member.role = ${questions.audienceId}
            ))
            or (${questions.audienceType} = 'project_maintainers' and (
              exists (
                select 1 from ${organizationMembers} delegated_org_manager
                where delegated_org_manager.organization_id = ${context.organizationId}
                  and delegated_org_manager.user_id = ${delegatedUserId}
                  and delegated_org_manager.status = 'active'
                  and delegated_org_manager.role in ('owner', 'admin')
              )
              or exists (
                select 1 from ${projectMembers} delegated_project_manager
                where delegated_project_manager.organization_id = ${context.organizationId}
                  and delegated_project_manager.project_id = r.target_project_id
                  and delegated_project_manager.user_id = ${delegatedUserId}
                  and delegated_project_manager.status = 'active'
                  and delegated_project_manager.role = 'maintainer'
              )
            ))
          )`
          : sql``;
        const conditions: SQL[] = [
          eq(questions.organizationId, context.organizationId),
          eq(questions.state, "open"),
          sql`exists (
          select 1 from ${requests} r
          where r.id = ${questions.parentRequestId}
            and (
              r.source_project_id = ${context.projectId}
              or (
                r.target_project_id = ${context.projectId}
                ${targetLaneAudience}
              )
            )
            and (
              (${questions.audienceType} = 'agent' and ${questions.audienceId} = ${context.actor.id})
              or (${questions.audienceType} = 'requester' and r.reporter_type = 'agent' and r.reporter_id = ${context.actor.id})
              or (${context.scopes.has("request:triage")} and ${questions.audienceType} = 'project_maintainers' and r.target_project_id = ${context.projectId})
              ${delegatedAudience}
            )
        )`,
        ];
        if (parsed) {
          conditions.push(
            or(
              lt(questions.createdAt, parsed.at),
              and(
                eq(questions.createdAt, parsed.at),
                lt(questions.id, parsed.id),
              ),
            ) as SQL,
          );
        }
        const rows = await authorized
          .select({
            id: questions.id,
            requestId: questions.parentRequestId,
            audienceType: questions.audienceType,
            audienceId: questions.audienceId,
            bodyMd: questions.bodyMd,
            choices: questions.choices,
            allowFreeText: questions.allowFreeText,
            answerMode: questions.answerMode,
            blocksRequest: questions.blocksRequest,
            deadlineAt: questions.deadlineAt,
            version: questions.version,
            occurredAt: questions.createdAt,
          })
          .from(questions)
          .where(and(...conditions))
          .orderBy(desc(questions.createdAt), desc(questions.id))
          .limit(limit + 1);
        return page(rows, limit);
      });
    },

    async listEvents(
      context: AgentQueryContext,
      cursor?: string,
      requestId?: string,
    ): Promise<JsonValue> {
      return withActiveAuthorization(database, context, (authorized) =>
        listEventsAuthorized(authorized, context, cursor, requestId),
      );
    },
  };
}
