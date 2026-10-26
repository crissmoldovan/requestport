import {
  type CursorPage,
  decodeCursor,
  encodeCursor,
  type JsonValue,
  normalizePageLimit,
  type RequestDetail,
  type RequestFilters,
  type RequestListItem,
  type RequestQueryRepository,
  type RequestQuestionView,
  type TimelineEventView,
} from "@requestport/domain";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "../client.js";
import { inTurn } from "../in-turn.js";
import {
  agentPrincipals,
  answers,
  artifacts,
  completionReports,
  domainEvents,
  emailDeliveries,
  lanes,
  legacyAliases,
  legacyMappings,
  messageMentions,
  messages,
  notificationIntents,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  questions,
  requestAcceptanceCriteria,
  requestLabels,
  requestRelationships,
  requests,
  slackDeliveries,
  sourceArtifacts,
  user,
  userRequestReadStates,
  workSessions,
  workUpdates,
} from "../schema/index.js";
import { bindTenant, withTenantRead } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { publicEventProjection } from "./public-event.js";

type RequestQueryDatabase = Database | Tx;
const actorMembership = alias(organizationMembers, "request_actor_membership");
const sourceProject = alias(projects, "request_source_project");
const targetProject = alias(projects, "request_target_project");
const requestLane = alias(lanes, "request_lane");
const accessRequest = alias(requests, "access_request");
const accessMembership = alias(organizationMembers, "access_membership");
const accessProjectMembership = alias(
  projectMembers,
  "access_project_membership",
);
const accessOrganization = alias(organizations, "access_organization");
/*
  The reporter's and the assignee's membership of the request's own
  organisation, and the person behind each (ruling 262). A left join on
  `organization_id = requests.organization_id` and the person's id, so a name
  is read only for someone who is or was a member of that organisation — the
  table's row security admits the bound organisation's rows only, and its
  unique (organisation, user) index gives each request at most one row — and
  is null for an agent, a service or anyone else.
*/
const reporterMembership = alias(
  organizationMembers,
  "request_reporter_membership",
);
const reporterPerson = alias(user, "request_reporter_person");
const assigneeMembership = alias(
  organizationMembers,
  "request_assignee_membership",
);
const assigneePerson = alias(user, "request_assignee_person");
/*
  The reporter and the assignee when either is an agent (ruling 264): the
  organisation's agent principal of that id, on `organization_id =
  requests.organization_id`, so an agent is named only by its own
  organisation's principal. The row holds the id as text, the principal's key
  is a uuid, so the key is compared as text.
*/
const reporterAgent = alias(agentPrincipals, "request_reporter_agent");
const assigneeAgent = alias(agentPrincipals, "request_assignee_agent");
/*
  Who wrote a message or an answer, and who an event's actor is (ruling
  264): a person by their membership of the row's organisation, an agent by
  that organisation's principal, as the reporter and the assignee are named.
*/
const messageMembership = alias(
  organizationMembers,
  "request_message_membership",
);
const messagePerson = alias(user, "request_message_person");
const messageAgent = alias(agentPrincipals, "request_message_agent");
const answerMembership = alias(
  organizationMembers,
  "request_answer_membership",
);
const answerPerson = alias(user, "request_answer_person");
const answerAgent = alias(agentPrincipals, "request_answer_agent");
const eventMembership = alias(organizationMembers, "request_event_membership");
const eventPerson = alias(user, "request_event_person");
const eventAgent = alias(agentPrincipals, "request_event_agent");

/**
 * On the pool, the method's own transaction, bound to its organisation at
 * its start whatever the switch says (manifest-i2.md §2.3 item 2); handed a
 * transaction, `undefined`, and the method runs in it as its opener bound it.
 */
function requestQueryTransaction<T>(
  database: RequestQueryDatabase,
  organizationId: string,
  operation: (transaction: Tx) => Promise<T>,
) {
  if (
    typeof (database as RequestQueryDatabase & { rollback?: unknown })
      .rollback === "function"
  ) {
    return undefined;
  }
  const candidate = database as RequestQueryDatabase & {
    transaction?: <TResult>(
      callback: (transaction: Tx) => Promise<TResult>,
    ) => Promise<TResult>;
  };
  return candidate.transaction
    ? candidate.transaction(async (transaction) => {
        await bindTenant(transaction, organizationId);
        return operation(transaction);
      })
    : undefined;
}

async function lockActiveHumanAccess(
  database: RequestQueryDatabase,
  userId: string,
  organizationId: string,
) {
  const [membership] = await database
    .select({ id: organizationMembers.id })
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
      ),
    )
    .for("share")
    .limit(1);
  if (!membership) return false;
  await database
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, organizationId),
        eq(projectMembers.userId, userId),
        eq(projectMembers.status, "active"),
      ),
    )
    .for("share");
  return true;
}

function authorized(userId: string, organizationId: string) {
  return sql`exists (
    select 1
    from ${organizationMembers} om
    inner join ${organizations} o on o.id = om.organization_id
    where om.organization_id = ${organizationId}
      and om.user_id = ${userId}
      and om.status = 'active'
      and o.status = 'active'
  )`;
}

function visibleRequest(
  userId: string,
  organizationId: string,
  requestId: SQLWrapper | string,
) {
  return sql`exists (
    select 1
    from ${requests} access_request
    inner join ${organizationMembers} access_membership
      on ${accessMembership.organizationId} = ${accessRequest.organizationId}
      and ${accessMembership.userId} = ${userId}
      and ${accessMembership.status} = 'active'
    inner join ${organizations} access_organization
      on ${accessOrganization.id} = ${accessRequest.organizationId}
      and ${accessOrganization.status} = 'active'
    left join ${projectMembers} access_project_membership
      on ${accessProjectMembership.organizationId} = ${accessRequest.organizationId}
      and ${accessProjectMembership.projectId} in (
        ${accessRequest.sourceProjectId},
        ${accessRequest.targetProjectId}
      )
      and ${accessProjectMembership.userId} = ${userId}
      and ${accessProjectMembership.status} = 'active'
    where ${accessRequest.organizationId} = ${organizationId}
      and ${accessRequest.id} = ${requestId}
      and (
        ${accessRequest.visibility} = 'organization'
        or ${accessMembership.role} in ('owner', 'admin')
        or ${accessProjectMembership.id} is not null
        or (${accessRequest.reporterType} = 'user' and ${accessRequest.reporterId} = ${userId})
        or (${accessRequest.assigneeType} = 'user' and ${accessRequest.assigneeId} = ${userId})
      )
  )`;
}

function listVisibility(userId: string) {
  return sql`(
    ${requests.visibility} = 'organization'
    or ${actorMembership.role} in ('owner', 'admin')
    or (${requests.reporterType} = 'user' and ${requests.reporterId} = ${userId})
    or (${requests.assigneeType} = 'user' and ${requests.assigneeId} = ${userId})
    or exists (
      select 1 from ${projectMembers} visibility_pm
      where visibility_pm.organization_id = ${requests.organizationId}
        and visibility_pm.project_id in (
          ${requests.sourceProjectId},
          ${requests.targetProjectId}
        )
        and visibility_pm.user_id = ${userId}
        and visibility_pm.status = 'active'
    )
  )`;
}

const listProjection = {
  id: requests.id,
  displayKey: requests.displayKey,
  title: requests.title,
  type: requests.type,
  priority: requests.priority,
  visibility: requests.visibility,
  sensitivity: requests.sensitivity,
  state: requests.state,
  sourceKind: requests.sourceKind,
  sourceProjectId: requests.sourceProjectId,
  sourceProjectName: sourceProject.name,
  targetProjectId: requests.targetProjectId,
  targetProjectName: targetProject.name,
  laneId: requests.laneId,
  laneName: requestLane.name,
  reporterType: requests.reporterType,
  reporterId: requests.reporterId,
  assigneeType: requests.assigneeType,
  assigneeId: requests.assigneeId,
  reporterName: reporterPerson.name,
  reporterEmail: reporterPerson.email,
  assigneeName: assigneePerson.name,
  assigneeEmail: assigneePerson.email,
  reporterAgentName: reporterAgent.displayName,
  assigneeAgentName: assigneeAgent.displayName,
  updatedAt: requests.updatedAt,
  unread: sql<boolean>`exists (
    select 1 from ${domainEvents} de
    where de.request_id = ${requests.id}
      and de.organization_id = ${requests.organizationId}
      and (
        de.occurred_at > coalesce(${userRequestReadStates.lastSeenAt}, to_timestamp(0))
        or (
          de.occurred_at = ${userRequestReadStates.lastSeenAt}
          and (
            ${userRequestReadStates.lastSeenEventId} is null
            or de.id > ${userRequestReadStates.lastSeenEventId}
          )
        )
      )
  )`,
  openQuestionCount: sql<number>`(
    select count(*)::integer from ${questions} oq
    where oq.parent_request_id = ${requests.id} and oq.state = 'open'
  )`,
};

type ListRow = Awaited<ReturnType<typeof selectListRows>>[number];

/** A person's name, or their email when the name is blank; null for neither. */
function personDisplayName(name: string | null, email: string | null) {
  return name?.trim() || email || null;
}

/**
 * What the console calls an actor: a person's name or email, else an agent's
 * display name, else null (the console falls back to the short id).
 */
function actorDisplayName(row: {
  personName: string | null;
  personEmail: string | null;
  agentName: string | null;
}) {
  return (
    personDisplayName(row.personName, row.personEmail) ??
    (row.agentName?.trim() || null)
  );
}

function listItem(row: ListRow): RequestListItem {
  return {
    id: row.id,
    displayKey: row.displayKey,
    title: row.title,
    type: row.type as RequestListItem["type"],
    priority: row.priority as RequestListItem["priority"],
    visibility: row.visibility as RequestListItem["visibility"],
    sensitivity: row.sensitivity as RequestListItem["sensitivity"],
    state: row.state as RequestListItem["state"],
    sourceKind: row.sourceKind as RequestListItem["sourceKind"],
    sourceProjectId: row.sourceProjectId,
    sourceProjectName: row.sourceProjectName,
    targetProjectId: row.targetProjectId,
    targetProjectName: row.targetProjectName,
    laneId: row.laneId,
    laneName: row.laneName,
    reporterType: row.reporterType as RequestListItem["reporterType"],
    reporterId: row.reporterId,
    assigneeType: row.assigneeType as RequestListItem["assigneeType"],
    assigneeId: row.assigneeId,
    reporterDisplayName: actorDisplayName({
      personName: row.reporterName,
      personEmail: row.reporterEmail,
      agentName: row.reporterAgentName,
    }),
    assigneeDisplayName: actorDisplayName({
      personName: row.assigneeName,
      personEmail: row.assigneeEmail,
      agentName: row.assigneeAgentName,
    }),
    updatedAt: row.updatedAt,
    unread: row.unread,
    openQuestionCount: row.openQuestionCount,
  };
}

function selectListRows(
  database: RequestQueryDatabase,
  conditions: SQL[],
  limit: number,
) {
  return database
    .select(listProjection)
    .from(requests)
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, requests.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .innerJoin(
      actorMembership,
      and(
        eq(actorMembership.organizationId, requests.organizationId),
        eq(actorMembership.status, "active"),
      ),
    )
    .leftJoin(sourceProject, eq(sourceProject.id, requests.sourceProjectId))
    .innerJoin(targetProject, eq(targetProject.id, requests.targetProjectId))
    .leftJoin(requestLane, eq(requestLane.id, requests.laneId))
    .leftJoin(
      userRequestReadStates,
      and(
        eq(userRequestReadStates.organizationId, requests.organizationId),
        eq(userRequestReadStates.userId, actorMembership.userId),
        eq(userRequestReadStates.requestId, requests.id),
      ),
    )
    .leftJoin(
      reporterMembership,
      and(
        eq(reporterMembership.organizationId, requests.organizationId),
        eq(requests.reporterType, "user"),
        eq(reporterMembership.userId, requests.reporterId),
      ),
    )
    .leftJoin(reporterPerson, eq(reporterPerson.id, reporterMembership.userId))
    .leftJoin(
      assigneeMembership,
      and(
        eq(assigneeMembership.organizationId, requests.organizationId),
        eq(requests.assigneeType, "user"),
        eq(assigneeMembership.userId, requests.assigneeId),
      ),
    )
    .leftJoin(assigneePerson, eq(assigneePerson.id, assigneeMembership.userId))
    .leftJoin(
      reporterAgent,
      and(
        eq(reporterAgent.organizationId, requests.organizationId),
        eq(requests.reporterType, "agent"),
        sql`${reporterAgent.id}::text = ${requests.reporterId}`,
      ),
    )
    .leftJoin(
      assigneeAgent,
      and(
        eq(assigneeAgent.organizationId, requests.organizationId),
        eq(requests.assigneeType, "agent"),
        sql`${assigneeAgent.id}::text = ${requests.assigneeId}`,
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(requests.updatedAt), desc(requests.id))
    .limit(limit);
}

/**
 * How many requests `conditions` admit, over the joins of `selectListRows`
 * that can drop or qualify a row: the organisation, the reader's membership
 * and read state, and the target project. The left joins that only add
 * columns are left out, as is the order and the page.
 */
async function countListRows(
  database: RequestQueryDatabase,
  conditions: SQL[],
) {
  const [row] = await database
    .select({ count: sql<number>`count(*)::integer` })
    .from(requests)
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, requests.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .innerJoin(
      actorMembership,
      and(
        eq(actorMembership.organizationId, requests.organizationId),
        eq(actorMembership.status, "active"),
      ),
    )
    .innerJoin(targetProject, eq(targetProject.id, requests.targetProjectId))
    .leftJoin(
      userRequestReadStates,
      and(
        eq(userRequestReadStates.organizationId, requests.organizationId),
        eq(userRequestReadStates.userId, actorMembership.userId),
        eq(userRequestReadStates.requestId, requests.id),
      ),
    )
    .where(and(...conditions));
  return row?.count ?? 0;
}

/**
 * A page of the events `conditions` admit, newest first, each with what the
 * console calls its actor (ruling 264): a person by their membership of the
 * event's organisation, an agent by that organisation's principal.
 */
async function readTimelinePage(
  database: RequestQueryDatabase,
  conditions: SQL[],
  limit: number,
) {
  const rows = await database
    .select({
      event: domainEvents,
      personName: eventPerson.name,
      personEmail: eventPerson.email,
      agentName: eventAgent.displayName,
    })
    .from(domainEvents)
    .leftJoin(
      eventMembership,
      and(
        eq(eventMembership.organizationId, domainEvents.organizationId),
        sql`${domainEvents.actor}->>'type' = 'user'`,
        sql`${eventMembership.userId} = ${domainEvents.actor}->>'id'`,
      ),
    )
    .leftJoin(eventPerson, eq(eventPerson.id, eventMembership.userId))
    .leftJoin(
      eventAgent,
      and(
        eq(eventAgent.organizationId, domainEvents.organizationId),
        sql`${domainEvents.actor}->>'type' = 'agent'`,
        sql`${eventAgent.id}::text = ${domainEvents.actor}->>'id'`,
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id))
    .limit(limit + 1);
  const items: TimelineEventView[] = rows.map(({ event, ...names }) => ({
    id: event.id,
    type: event.type,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    ...publicEventProjection(event),
    actorDisplayName: actorDisplayName(names),
  }));
  return cursorPage(items, limit, (item) => item.occurredAt);
}

function cursorPage<T extends { id: string }>(
  items: T[],
  limit: number,
  date: (item: T) => Date,
) {
  const hasMore = items.length > limit;
  const visible = hasMore ? items.slice(0, limit) : items;
  const last = visible.at(-1);
  return {
    items: visible,
    nextCursor:
      hasMore && last ? encodeCursor({ at: date(last), id: last.id }) : null,
  };
}

function questionView(
  row: typeof questions.$inferSelect,
  questionAnswers: RequestQuestionView["answers"],
  deliveries: RequestQuestionView["deliveries"] = [],
  permissions: { canAnswer: boolean; canClose: boolean } = {
    canAnswer: false,
    canClose: false,
  },
): RequestQuestionView {
  return {
    id: row.id,
    audienceType: row.audienceType,
    audienceId: row.audienceId,
    bodyMd: row.bodyMd,
    choices: row.choices,
    allowFreeText: row.allowFreeText,
    answerMode: row.answerMode as RequestQuestionView["answerMode"],
    blocksRequest: row.blocksRequest,
    state: row.state as RequestQuestionView["state"],
    deadlineAt: row.deadlineAt,
    version: row.version,
    createdAt: row.createdAt,
    ...permissions,
    answers: questionAnswers,
    deliveries,
  };
}

/**
 * The list a reader asked for, as a page of rows or as how many rows it
 * holds. One body for both, so a view's count is taken under exactly the
 * conditions its list is read under: the organisation, the reader's
 * membership and visibility, the filters and the view's mode.
 */
async function readRequestList(
  database: RequestQueryDatabase,
  input: {
    userId: string;
    organizationId: string;
    filters?: RequestFilters;
    cursor?: string;
    limit?: number;
  },
  shape: "page" | "count",
): Promise<
  | { shape: "page"; page: CursorPage<RequestListItem> }
  | { shape: "count"; count: number }
> {
  const limit = normalizePageLimit(input.limit);
  // A count reads every page, so it takes no cursor.
  const cursor = shape === "page" ? decodeCursor(input.cursor) : null;
  const filters = input.filters ?? {};
  const conditions: SQL[] = [
    eq(requests.organizationId, input.organizationId),
    eq(actorMembership.userId, input.userId),
    listVisibility(input.userId),
  ];
  if (cursor) {
    conditions.push(
      or(
        lt(requests.updatedAt, cursor.at),
        and(eq(requests.updatedAt, cursor.at), lt(requests.id, cursor.id)),
      ) as SQL,
    );
  }
  if (filters.sourceProjectId)
    conditions.push(eq(requests.sourceProjectId, filters.sourceProjectId));
  if (filters.targetProjectId)
    conditions.push(eq(requests.targetProjectId, filters.targetProjectId));
  if (filters.laneId) conditions.push(eq(requests.laneId, filters.laneId));
  if (filters.state?.length)
    conditions.push(inArray(requests.state, filters.state));
  if (filters.type?.length)
    conditions.push(inArray(requests.type, filters.type));
  if (filters.priority?.length)
    conditions.push(inArray(requests.priority, filters.priority));
  if (filters.reporterId)
    conditions.push(eq(requests.reporterId, filters.reporterId));
  if (filters.assigneeId)
    conditions.push(eq(requests.assigneeId, filters.assigneeId));
  if (filters.updatedAfter)
    conditions.push(gt(requests.updatedAt, filters.updatedAfter));
  if (filters.label) {
    conditions.push(
      sql`exists (select 1 from ${requestLabels} rl where rl.request_id = ${requests.id} and rl.label = ${filters.label})`,
    );
  }
  if (filters.unanswered) {
    conditions.push(
      sql`exists (select 1 from ${questions} uq where uq.parent_request_id = ${requests.id} and uq.state = 'open')`,
    );
  }
  if (filters.mode === "my_work") {
    conditions.push(
      or(
        eq(requests.assigneeId, input.userId),
        and(
          eq(requests.reporterType, "user"),
          eq(requests.reporterId, input.userId),
        ),
      ) as SQL,
    );
  }
  if (filters.mode === "inbox") {
    conditions.push(sql`(
      exists (select 1 from ${domainEvents} ide where ide.request_id = ${requests.id}
        and (
          ide.occurred_at > coalesce(${userRequestReadStates.lastSeenAt}, to_timestamp(0))
          or (
            ide.occurred_at = ${userRequestReadStates.lastSeenAt}
            and (
              ${userRequestReadStates.lastSeenEventId} is null
              or ide.id > ${userRequestReadStates.lastSeenEventId}
            )
          )
        ))
      or exists (select 1 from ${questions} iq where iq.parent_request_id = ${requests.id}
        and iq.state = 'open' and (
          (iq.audience_type = 'user' and iq.audience_id = ${input.userId})
          or (iq.audience_type = 'requester' and ${requests.reporterType} = 'user' and ${requests.reporterId} = ${input.userId})
          or (iq.audience_type = 'role' and iq.audience_id = ${actorMembership.role})
          or (iq.audience_type = 'project_maintainers' and (
            ${actorMembership.role} in ('owner', 'admin')
            or exists (
              select 1 from ${projectMembers} ipm
              where ipm.organization_id = ${requests.organizationId}
                and ipm.project_id = ${requests.targetProjectId}
                and ipm.user_id = ${input.userId}
                and ipm.role = 'maintainer'
                and ipm.status = 'active'
            )
          ))
        ))
      or exists (
        select 1 from ${messageMentions} imm
        inner join ${messages} im on im.id = imm.message_id
        where imm.organization_id = ${requests.organizationId}
          and imm.user_id = ${input.userId}
          and im.request_id = ${requests.id}
          and im.created_at > coalesce(${userRequestReadStates.lastSeenAt}, to_timestamp(0))
      )
      or (${requests.assigneeType} = 'user' and ${requests.assigneeId} = ${input.userId})
    )`);
  }
  if (shape === "count") {
    return { shape, count: await countListRows(database, conditions) };
  }
  const rows = await selectListRows(database, conditions, limit + 1);
  return {
    shape,
    page: cursorPage(rows.map(listItem), limit, (item) => item.updatedAt),
  };
}

export function createRequestQueryRepository(
  database: RequestQueryDatabase,
): RequestQueryRepository {
  /**
   * The lists below are pool reads the web makes: each is wrapped in a
   * read-only transaction bound to its organisation once the application
   * variable is set (manifest-i2.md §2.3 item 3, ruling 17), and runs as
   * before until then; handed a transaction, it runs in it as it is.
   */
  const forOrganization = <T>(
    organizationId: string,
    work: (database: RequestQueryDatabase) => Promise<T>,
    readOnly = false,
  ) => withTenantRead(organizationId, work, { database, readOnly });

  return {
    async listRequests(input) {
      return forOrganization(
        input.organizationId,
        async (database) => {
          const read = await readRequestList(database, input, "page");
          if (read.shape !== "page") throw new Error("A page was not read");
          return read.page;
        },
        true,
      );
    },

    async countRequests(input) {
      return forOrganization(
        input.organizationId,
        async (database) => {
          const counts = {} as Record<keyof typeof input.views, number>;
          // One view at a time on the one transaction, as getRequest reads.
          for (const view of Object.keys(input.views) as Array<
            keyof typeof input.views
          >) {
            const read = await readRequestList(
              database,
              {
                userId: input.userId,
                organizationId: input.organizationId,
                filters: input.views[view],
              },
              "count",
            );
            if (read.shape !== "count") throw new Error("A count was not read");
            counts[view] = read.count;
          }
          return counts;
        },
        true,
      );
    },

    async getRequest(input) {
      const transactional = requestQueryTransaction(
        database,
        input.organizationId,
        (transaction) =>
          createRequestQueryRepository(transaction).getRequest(input),
      );
      if (transactional) return transactional;
      if (
        !(await lockActiveHumanAccess(
          database,
          input.userId,
          input.organizationId,
        ))
      ) {
        return null;
      }
      const [base] = await database
        .select({
          ...listProjection,
          descriptionMd: requests.descriptionMd,
          version: requests.version,
          stateReason: requests.stateReason,
          resumeState: requests.resumeState,
          routingRuleId: requests.routingRuleId,
          routingPolicyVersion: requests.routingPolicyVersion,
          createdAt: requests.createdAt,
          submittedAt: requests.submittedAt,
          organizationRole: actorMembership.role,
          projectRole: sql<string | null>`(
            select pm.role from ${projectMembers} pm
            where pm.organization_id = ${requests.organizationId}
              and pm.project_id = ${requests.targetProjectId}
              and pm.user_id = ${input.userId}
              and pm.status = 'active'
            limit 1
          )`,
        })
        .from(requests)
        .innerJoin(
          organizations,
          and(
            eq(organizations.id, requests.organizationId),
            eq(organizations.status, "active"),
          ),
        )
        .innerJoin(
          actorMembership,
          and(
            eq(actorMembership.organizationId, requests.organizationId),
            eq(actorMembership.userId, input.userId),
            eq(actorMembership.status, "active"),
          ),
        )
        .leftJoin(sourceProject, eq(sourceProject.id, requests.sourceProjectId))
        .innerJoin(
          targetProject,
          eq(targetProject.id, requests.targetProjectId),
        )
        .leftJoin(requestLane, eq(requestLane.id, requests.laneId))
        .leftJoin(
          userRequestReadStates,
          and(
            eq(userRequestReadStates.organizationId, requests.organizationId),
            eq(userRequestReadStates.userId, input.userId),
            eq(userRequestReadStates.requestId, requests.id),
          ),
        )
        .leftJoin(
          reporterMembership,
          and(
            eq(reporterMembership.organizationId, requests.organizationId),
            eq(requests.reporterType, "user"),
            eq(reporterMembership.userId, requests.reporterId),
          ),
        )
        .leftJoin(
          reporterPerson,
          eq(reporterPerson.id, reporterMembership.userId),
        )
        .leftJoin(
          assigneeMembership,
          and(
            eq(assigneeMembership.organizationId, requests.organizationId),
            eq(requests.assigneeType, "user"),
            eq(assigneeMembership.userId, requests.assigneeId),
          ),
        )
        .leftJoin(
          assigneePerson,
          eq(assigneePerson.id, assigneeMembership.userId),
        )
        .leftJoin(
          reporterAgent,
          and(
            eq(reporterAgent.organizationId, requests.organizationId),
            eq(requests.reporterType, "agent"),
            sql`${reporterAgent.id}::text = ${requests.reporterId}`,
          ),
        )
        .leftJoin(
          assigneeAgent,
          and(
            eq(assigneeAgent.organizationId, requests.organizationId),
            eq(requests.assigneeType, "agent"),
            sql`${assigneeAgent.id}::text = ${requests.assigneeId}`,
          ),
        )
        .where(
          and(
            eq(requests.organizationId, input.organizationId),
            eq(requests.id, input.requestId),
            listVisibility(input.userId),
          ),
        )
        .limit(1);
      if (!base) return null;
      const auth = authorized(input.userId, input.organizationId);
      const [
        labels,
        criteria,
        messageRows,
        questionRows,
        artifactRows,
        reportRows,
        outgoing,
        incoming,
      ] = await inTurn([
        () =>
          database
            .select({ label: requestLabels.label })
            .from(requestLabels)
            .where(and(eq(requestLabels.requestId, input.requestId), auth)),
        () =>
          database
            .select()
            .from(requestAcceptanceCriteria)
            .where(
              and(
                eq(requestAcceptanceCriteria.requestId, input.requestId),
                auth,
              ),
            )
            .orderBy(requestAcceptanceCriteria.position),
        () =>
          database
            .select({
              id: messages.id,
              actorType: messages.actorType,
              actorId: messages.actorId,
              bodyMd: messages.bodyMd,
              visibility: messages.visibility,
              replyToId: messages.replyToId,
              createdAt: messages.createdAt,
              personName: messagePerson.name,
              personEmail: messagePerson.email,
              agentName: messageAgent.displayName,
            })
            .from(messages)
            .leftJoin(
              messageMembership,
              and(
                eq(messageMembership.organizationId, messages.organizationId),
                eq(messages.actorType, "user"),
                eq(messageMembership.userId, messages.actorId),
              ),
            )
            .leftJoin(
              messagePerson,
              eq(messagePerson.id, messageMembership.userId),
            )
            .leftJoin(
              messageAgent,
              and(
                eq(messageAgent.organizationId, messages.organizationId),
                eq(messages.actorType, "agent"),
                sql`${messageAgent.id}::text = ${messages.actorId}`,
              ),
            )
            .where(
              and(
                eq(messages.requestId, input.requestId),
                eq(messages.organizationId, input.organizationId),
                auth,
                sql`(
            ${messages.visibility} = 'organization'
            or (${messages.actorType} = 'user' and ${messages.actorId} = ${input.userId})
            or ${base.organizationRole} in ('owner', 'admin')
            or ${base.projectRole}::text is not null
            or (${base.reporterType} = 'user' and ${base.reporterId} = ${input.userId})
            or (${base.assigneeType} = 'user' and ${base.assigneeId} = ${input.userId})
            or exists (
              select 1 from ${projectMembers} restricted_project_member
              where restricted_project_member.organization_id = ${input.organizationId}
                and restricted_project_member.project_id in (
                  ${base.sourceProjectId},
                  ${base.targetProjectId}
                )
                and restricted_project_member.user_id = ${input.userId}
                and restricted_project_member.status = 'active'
            )
            or exists (
              select 1 from ${messageMentions} restricted_mention
              where restricted_mention.organization_id = ${input.organizationId}
                and restricted_mention.message_id = ${messages.id}
                and restricted_mention.user_id = ${input.userId}
            )
          )`,
              ),
            )
            .orderBy(messages.createdAt, messages.id),
        () =>
          database
            .select()
            .from(questions)
            .where(
              and(
                eq(questions.parentRequestId, input.requestId),
                eq(questions.organizationId, input.organizationId),
                auth,
              ),
            )
            .orderBy(questions.createdAt, questions.id),
        () =>
          database
            .select()
            .from(artifacts)
            .where(
              and(
                eq(artifacts.requestId, input.requestId),
                eq(artifacts.organizationId, input.organizationId),
                auth,
              ),
            )
            .orderBy(artifacts.createdAt, artifacts.id),
        () =>
          database
            .select()
            .from(completionReports)
            .where(
              and(
                eq(completionReports.requestId, input.requestId),
                eq(completionReports.organizationId, input.organizationId),
                auth,
              ),
            )
            .limit(1),
        () =>
          database.execute<{
            id: string;
            type: string;
            request_id: string;
            display_key: string | null;
            title: string;
          }>(sql`
          select rr.id, rr.type, rr.to_request_id as request_id, r.display_key, r.title
          from ${requestRelationships} rr inner join ${requests} r on r.id = rr.to_request_id
          where rr.organization_id = ${input.organizationId}
            and rr.from_request_id = ${input.requestId}
            and ${auth}
            and ${visibleRequest(input.userId, input.organizationId, sql`r.id`)}`),
        () =>
          database.execute<{
            id: string;
            type: string;
            request_id: string;
            display_key: string | null;
            title: string;
          }>(sql`
          select rr.id, rr.type, rr.from_request_id as request_id, r.display_key, r.title
          from ${requestRelationships} rr inner join ${requests} r on r.id = rr.from_request_id
          where rr.organization_id = ${input.organizationId}
            and rr.to_request_id = ${input.requestId}
            and ${auth}
            and ${visibleRequest(input.userId, input.organizationId, sql`r.id`)}`),
      ]);
      const questionIds = questionRows.map((question) => question.id);
      const answerRows =
        questionIds.length === 0
          ? []
          : await database
              .select({
                id: answers.id,
                questionId: answers.questionId,
                actorType: answers.actorType,
                actorId: answers.actorId,
                sourceChannel: answers.sourceChannel,
                bodyMd: answers.bodyMd,
                structuredValue: answers.structuredValue,
                accepted: answers.accepted,
                createdAt: answers.createdAt,
                personName: answerPerson.name,
                personEmail: answerPerson.email,
                agentName: answerAgent.displayName,
              })
              .from(answers)
              .leftJoin(
                answerMembership,
                and(
                  eq(answerMembership.organizationId, answers.organizationId),
                  eq(answers.actorType, "user"),
                  eq(answerMembership.userId, answers.actorId),
                ),
              )
              .leftJoin(
                answerPerson,
                eq(answerPerson.id, answerMembership.userId),
              )
              .leftJoin(
                answerAgent,
                and(
                  eq(answerAgent.organizationId, answers.organizationId),
                  eq(answers.actorType, "agent"),
                  sql`${answerAgent.id}::text = ${answers.actorId}`,
                ),
              )
              .where(and(inArray(answers.questionId, questionIds), auth))
              .orderBy(answers.createdAt, answers.id);
      const answersByQuestion = new Map<
        string,
        RequestQuestionView["answers"]
      >();
      for (const row of answerRows) {
        const values = answersByQuestion.get(row.questionId) ?? [];
        values.push({
          id: row.id,
          actorType: row.actorType,
          actorId: row.actorId,
          actorDisplayName: actorDisplayName(row),
          sourceChannel: row.sourceChannel,
          bodyMd: row.bodyMd,
          structuredValue: (row.structuredValue as JsonValue | null) ?? null,
          accepted: row.accepted,
          createdAt: row.createdAt,
        });
        answersByQuestion.set(row.questionId, values);
      }
      const intentRows =
        questionIds.length === 0
          ? []
          : await database
              .select({
                id: notificationIntents.id,
                questionId: notificationIntents.questionId,
                channel: notificationIntents.channel,
                status: notificationIntents.status,
                createdAt: notificationIntents.createdAt,
              })
              .from(notificationIntents)
              .where(
                and(
                  inArray(notificationIntents.questionId, questionIds),
                  eq(notificationIntents.organizationId, input.organizationId),
                  auth,
                ),
              )
              .orderBy(notificationIntents.createdAt);
      const intentIds = intentRows.map((intent) => intent.id);
      const [emailAttemptRows, slackAttemptRows] =
        intentIds.length === 0
          ? ([[], []] as const)
          : await inTurn([
              () =>
                database
                  .select({
                    intentId: emailDeliveries.notificationIntentId,
                    status: emailDeliveries.status,
                    updatedAt: emailDeliveries.updatedAt,
                  })
                  .from(emailDeliveries)
                  .where(
                    inArray(emailDeliveries.notificationIntentId, intentIds),
                  ),
              () =>
                database
                  .select({
                    intentId: slackDeliveries.notificationIntentId,
                    status: slackDeliveries.status,
                    updatedAt: slackDeliveries.updatedAt,
                  })
                  .from(slackDeliveries)
                  .where(
                    inArray(slackDeliveries.notificationIntentId, intentIds),
                  ),
            ]);
      const deliveriesByQuestion = new Map<
        string,
        RequestQuestionView["deliveries"]
      >();
      for (const intent of intentRows) {
        if (!intent.questionId) continue;
        const values = deliveriesByQuestion.get(intent.questionId) ?? [];
        values.push({
          id: intent.id,
          channel: intent.channel,
          status: intent.status,
          createdAt: intent.createdAt,
          attempts: (intent.channel === "email"
            ? emailAttemptRows
            : slackAttemptRows
          )
            .filter((attempt) => attempt.intentId === intent.id)
            .map(({ status, updatedAt }) => ({ status, updatedAt })),
        });
        deliveriesByQuestion.set(intent.questionId, values);
      }
      const [sessionRows, provenanceMappings, provenanceAliases] = await inTurn(
        [
          () =>
            database
              .select({
                id: workSessions.id,
                agentPrincipalId: workSessions.agentPrincipalId,
                agentDisplayName: agentPrincipals.displayName,
                state: workSessions.state,
                startedAt: workSessions.startedAt,
                endedAt: workSessions.endedAt,
                leaseExpiresAt: workSessions.leaseExpiresAt,
                updatedAt: workSessions.updatedAt,
                latestProgress: sql<string | null>`(
              select wu.body_md from ${workUpdates} wu
              where wu.work_session_id = ${workSessions.id}
              order by wu.created_at desc limit 1
            )`,
                progressPercent: sql<number | null>`(
              select wu.progress_percent from ${workUpdates} wu
              where wu.work_session_id = ${workSessions.id}
              order by wu.created_at desc limit 1
            )`,
              })
              .from(workSessions)
              .innerJoin(
                agentPrincipals,
                and(
                  eq(
                    agentPrincipals.organizationId,
                    workSessions.organizationId,
                  ),
                  eq(agentPrincipals.id, workSessions.agentPrincipalId),
                ),
              )
              .where(
                and(
                  eq(workSessions.organizationId, input.organizationId),
                  eq(workSessions.requestId, input.requestId),
                  auth,
                ),
              )
              .orderBy(desc(workSessions.updatedAt)),
          () =>
            database
              .select({
                id: legacyMappings.id,
                recordIndex: legacyMappings.recordIndex,
                relativePath: sourceArtifacts.relativePath,
                sha256: sourceArtifacts.sha256,
                importRunId: legacyMappings.importRunId,
                appliedAt: legacyMappings.appliedAt,
              })
              .from(legacyMappings)
              .innerJoin(
                sourceArtifacts,
                eq(sourceArtifacts.id, legacyMappings.sourceArtifactId),
              )
              .where(
                and(
                  eq(legacyMappings.organizationId, input.organizationId),
                  eq(legacyMappings.canonicalType, "request"),
                  eq(legacyMappings.canonicalId, input.requestId),
                  auth,
                ),
              )
              .orderBy(legacyMappings.appliedAt),
          () =>
            database
              .select({
                id: legacyAliases.id,
                namespace: legacyAliases.namespace,
                normalizedKey: legacyAliases.normalizedKey,
                relativePath: sourceArtifacts.relativePath,
                sha256: sourceArtifacts.sha256,
              })
              .from(legacyAliases)
              .innerJoin(
                sourceArtifacts,
                eq(sourceArtifacts.id, legacyAliases.sourceArtifactId),
              )
              .where(
                and(
                  eq(legacyAliases.organizationId, input.organizationId),
                  eq(legacyAliases.canonicalRequestId, input.requestId),
                  auth,
                ),
              )
              .orderBy(legacyAliases.namespace, legacyAliases.normalizedKey),
        ],
      );
      const maintains =
        base.organizationRole === "owner" ||
        base.organizationRole === "admin" ||
        base.projectRole === "maintainer";
      const isReporter =
        base.reporterType === "user" && base.reporterId === input.userId;
      const allowedActions: RequestDetail["allowedActions"] = [];
      if (base.state === "draft" && isReporter)
        allowedActions.push("submit_request");
      if (base.state === "submitted") {
        if (maintains) allowedActions.push("begin_triage", "cancel_request");
        if (isReporter) allowedActions.push("withdraw_request");
      }
      if (base.state === "triage" && maintains) {
        allowedActions.push(
          "accept_request",
          "decline_request",
          "mark_duplicate",
          "supersede_request",
          "block_request",
          "cancel_request",
        );
      }
      if (base.state === "accepted" && maintains) {
        allowedActions.push(
          "begin_request_work",
          "plan_request",
          "block_request",
          "cancel_request",
        );
      }
      if (base.state === "accepted" && base.projectRole === "contributor") {
        allowedActions.push("plan_request");
      }
      if (base.state === "planned" && maintains) {
        allowedActions.push(
          "begin_request_work",
          "block_request",
          "cancel_request",
        );
      }
      if (base.state === "in_progress" && maintains) {
        allowedActions.push(
          "complete_request",
          "block_request",
          "cancel_request",
        );
      }
      if (base.state === "blocked" && maintains) {
        allowedActions.push("resume_request", "cancel_request");
      }
      if (
        (base.state === "waiting_human" ||
          base.state === "waiting_requester") &&
        maintains
      ) {
        allowedActions.push("cancel_request");
      }
      if (base.state === "completed" && maintains) {
        allowedActions.push("verify_request", "reopen_request");
      }
      if (
        (base.state === "declined" ||
          base.state === "duplicate" ||
          base.state === "verified") &&
        maintains
      ) {
        allowedActions.push("reopen_request");
      }
      const detail: RequestDetail = {
        ...listItem(base),
        descriptionMd: base.descriptionMd,
        version: base.version,
        stateReason: base.stateReason,
        resumeState: base.resumeState,
        routingRuleId: base.routingRuleId,
        routingPolicyVersion: base.routingPolicyVersion,
        createdAt: base.createdAt,
        submittedAt: base.submittedAt,
        allowedActions,
        permissions: {
          // Who `assign_request` admits (ruling 262), in the states it
          // assigns in: the same terminal states `canEdit` excludes.
          canAssign:
            maintains &&
            ![
              "completed",
              "verified",
              "declined",
              "duplicate",
              "superseded",
              "cancelled",
            ].includes(base.state),
          canAskBlocking: maintains,
          canEdit:
            (maintains || isReporter) &&
            ![
              "completed",
              "verified",
              "declined",
              "duplicate",
              "superseded",
              "cancelled",
            ].includes(base.state),
          canParticipate:
            maintains || isReporter || base.projectRole === "contributor",
        },
        labels: labels.map((row) => row.label),
        acceptanceCriteria: criteria.map((row) => ({
          id: row.id,
          position: row.position,
          text: row.text,
          satisfiedAt: row.satisfiedAt,
        })),
        relationships: [
          ...outgoing.rows.map((row) => ({
            id: row.id,
            direction: "outgoing" as const,
            type: row.type,
            requestId: row.request_id,
            displayKey: row.display_key,
            title: row.title,
          })),
          ...incoming.rows.map((row) => ({
            id: row.id,
            direction: "incoming" as const,
            type: row.type,
            requestId: row.request_id,
            displayKey: row.display_key,
            title: row.title,
          })),
        ],
        messages: messageRows.map((row) => ({
          id: row.id,
          actorType: row.actorType,
          actorId: row.actorId,
          actorDisplayName: actorDisplayName(row),
          bodyMd: row.bodyMd,
          visibility: row.visibility,
          replyToId: row.replyToId,
          createdAt: row.createdAt,
        })),
        questions: questionRows.map((row) => {
          const maintains =
            base.organizationRole === "owner" ||
            base.organizationRole === "admin" ||
            base.projectRole === "maintainer";
          const canAnswer =
            (row.audienceType === "user" && row.audienceId === input.userId) ||
            (row.audienceType === "role" &&
              row.audienceId === base.organizationRole) ||
            (row.audienceType === "requester" &&
              base.reporterType === "user" &&
              base.reporterId === input.userId) ||
            (row.audienceType === "project_maintainers" && maintains);
          return questionView(
            row,
            answersByQuestion.get(row.id) ?? [],
            deliveriesByQuestion.get(row.id) ?? [],
            {
              canAnswer,
              canClose:
                maintains ||
                (row.askedByType === "user" && row.askedById === input.userId),
            },
          );
        }),
        artifacts: artifactRows.map((row) => ({
          id: row.id,
          kind: row.kind,
          externalUrl: row.externalUrl,
          mediaType: row.mediaType,
          byteSize: row.byteSize,
          sha256: row.sha256,
          provenance: row.provenance as Record<string, JsonValue>,
          createdAt: row.createdAt,
        })),
        completionReport: reportRows[0]
          ? {
              id: reportRows[0].id,
              outcomeMd: reportRows[0].outcomeMd,
              changedRepositories: reportRows[0].changedRepositories as Array<
                Record<string, JsonValue>
              >,
              validations: reportRows[0].validations as Array<
                Record<string, JsonValue>
              >,
              risksMd: reportRows[0].risksMd,
              followupsMd: reportRows[0].followupsMd,
              verificationStepsMd: reportRows[0].verificationStepsMd,
              createdAt: reportRows[0].createdAt,
            }
          : null,
        workSessions: sessionRows,
        provenance: {
          aliases: provenanceAliases,
          mappings: provenanceMappings,
        },
      };
      return detail;
    },

    async listTimeline(input) {
      return forOrganization(
        input.organizationId,
        async (database) => {
          const limit = normalizePageLimit(input.limit);
          const cursor = decodeCursor(input.cursor);
          const conditions: SQL[] = [
            eq(domainEvents.organizationId, input.organizationId),
            eq(domainEvents.requestId, input.requestId),
            visibleRequest(
              input.userId,
              input.organizationId,
              domainEvents.requestId,
            ),
          ];
          if (cursor) {
            conditions.push(
              or(
                lt(domainEvents.occurredAt, cursor.at),
                and(
                  eq(domainEvents.occurredAt, cursor.at),
                  lt(domainEvents.id, cursor.id),
                ),
              ) as SQL,
            );
          }
          return readTimelinePage(database, conditions, limit);
        },
        true,
      );
    },

    async listOrganizationActivity(input) {
      return forOrganization(
        input.organizationId,
        async (database) => {
          const limit = normalizePageLimit(input.limit);
          const cursor = decodeCursor(input.cursor);
          const conditions: SQL[] = [
            eq(domainEvents.organizationId, input.organizationId),
            authorized(input.userId, input.organizationId),
            sql`(${domainEvents.requestId} is null or ${visibleRequest(input.userId, input.organizationId, domainEvents.requestId)})`,
          ];
          if (cursor) {
            conditions.push(
              or(
                lt(domainEvents.occurredAt, cursor.at),
                and(
                  eq(domainEvents.occurredAt, cursor.at),
                  lt(domainEvents.id, cursor.id),
                ),
              ) as SQL,
            );
          }
          return readTimelinePage(database, conditions, limit);
        },
        true,
      );
    },

    async listOpenQuestions(input) {
      return forOrganization(
        input.organizationId,
        async (database) => {
          const limit = normalizePageLimit(input.limit);
          const cursor = decodeCursor(input.cursor);
          const conditions: SQL[] = [
            eq(questions.organizationId, input.organizationId),
            eq(questions.state, "open"),
            visibleRequest(
              input.userId,
              input.organizationId,
              questions.parentRequestId,
            ),
          ];
          if (cursor)
            conditions.push(
              or(
                lt(questions.createdAt, cursor.at),
                and(
                  eq(questions.createdAt, cursor.at),
                  lt(questions.id, cursor.id),
                ),
              ) as SQL,
            );
          const rows = await database
            .select({
              question: questions,
              requestId: requests.id,
              displayKey: requests.displayKey,
              title: requests.title,
              reporterType: requests.reporterType,
              reporterId: requests.reporterId,
              membershipRole: organizationMembers.role,
              projectRole: projectMembers.role,
            })
            .from(questions)
            .innerJoin(requests, eq(requests.id, questions.parentRequestId))
            .innerJoin(
              organizationMembers,
              and(
                eq(
                  organizationMembers.organizationId,
                  questions.organizationId,
                ),
                eq(organizationMembers.userId, input.userId),
                eq(organizationMembers.status, "active"),
              ),
            )
            .leftJoin(
              projectMembers,
              and(
                eq(projectMembers.organizationId, questions.organizationId),
                eq(projectMembers.projectId, requests.targetProjectId),
                eq(projectMembers.userId, input.userId),
                eq(projectMembers.status, "active"),
              ),
            )
            .where(
              and(
                ...conditions,
                sql`(
            (${questions.audienceType} = 'user' and ${questions.audienceId} = ${input.userId})
            or (${questions.audienceType} = 'role' and ${questions.audienceId} = ${organizationMembers.role})
            or (${questions.audienceType} = 'requester' and ${requests.reporterType} = 'user' and ${requests.reporterId} = ${input.userId})
            or (${questions.audienceType} = 'project_maintainers' and (${projectMembers.role} = 'maintainer' or ${organizationMembers.role} in ('owner','admin')))
          )`,
              ),
            )
            .orderBy(desc(questions.createdAt), desc(questions.id))
            .limit(limit + 1);
          const items = rows.map((row) => ({
            ...questionView(row.question, [], [], {
              canAnswer: true,
              canClose:
                row.question.askedByType === "user" &&
                row.question.askedById === input.userId,
            }),
            requestId: row.requestId,
            displayKey: row.displayKey,
            title: row.title,
          }));
          return cursorPage(items, limit, (item) => item.createdAt);
        },
        true,
      );
    },

    async markRequestRead(input) {
      const transactional = requestQueryTransaction(
        database,
        input.organizationId,
        (transaction) =>
          createRequestQueryRepository(transaction).markRequestRead(input),
      );
      if (transactional) return transactional;
      if (
        !(await lockActiveHumanAccess(
          database,
          input.userId,
          input.organizationId,
        ))
      ) {
        return;
      }
      const [request] = await database
        .select({ id: requests.id })
        .from(requests)
        .where(
          and(
            eq(requests.id, input.requestId),
            eq(requests.organizationId, input.organizationId),
            visibleRequest(input.userId, input.organizationId, requests.id),
          ),
        )
        .limit(1);
      if (!request) return;
      if (!input.lastSeenEventId) return;
      const [event] = await database
        .select({ id: domainEvents.id, occurredAt: domainEvents.occurredAt })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.id, input.lastSeenEventId),
            eq(domainEvents.requestId, input.requestId),
            eq(domainEvents.organizationId, input.organizationId),
          ),
        )
        .limit(1);
      if (!event) return;
      await database
        .insert(userRequestReadStates)
        .values({
          organizationId: input.organizationId,
          userId: input.userId,
          requestId: input.requestId,
          lastSeenEventId: input.lastSeenEventId,
          lastSeenAt: event.occurredAt,
          updatedAt: sql`clock_timestamp()`,
        })
        .onConflictDoUpdate({
          target: [
            userRequestReadStates.organizationId,
            userRequestReadStates.userId,
            userRequestReadStates.requestId,
          ],
          set: {
            lastSeenEventId: sql`case
              when excluded.last_seen_at > coalesce(${userRequestReadStates.lastSeenAt}, to_timestamp(0))
                or (
                  excluded.last_seen_at = ${userRequestReadStates.lastSeenAt}
                  and (
                    ${userRequestReadStates.lastSeenEventId} is null
                    or excluded.last_seen_event_id > ${userRequestReadStates.lastSeenEventId}
                  )
                )
              then excluded.last_seen_event_id
              else ${userRequestReadStates.lastSeenEventId}
            end`,
            lastSeenAt: sql`greatest(coalesce(${userRequestReadStates.lastSeenAt}, to_timestamp(0)), excluded.last_seen_at)`,
            updatedAt: sql`clock_timestamp()`,
          },
        });
    },
  };
}
