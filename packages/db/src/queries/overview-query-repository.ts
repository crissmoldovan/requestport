import { DomainError, type TimelineEventView } from "@requestport/domain";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import type { Database } from "../client.js";
import {
  agentCredentials,
  agentOauthGrants,
  agentPrincipals,
  domainEvents,
  invitations,
  organizationMembers,
  organizations,
  outbox,
  projectMembers,
  projects,
  questions,
  requests,
  routingRules,
  webhookDeliveries,
  webhookSubscriptions,
  workSessions,
} from "../schema/index.js";
import { type TenantDatabase, withTenantRead } from "../tenant-context.js";
import { createRequestQueryRepository } from "./request-query-repository.js";

/*
  The console overview's and the agents page's reads (ruling 258): the setup
  checklist, the band of figures, what needs the person, recent activity, and
  each agent's sign-ins; since ruling 261 also when each agent last signed in,
  how many signed in within a day, and the worker and database health line.
  Every method runs in one read-only transaction bound
  to its organisation (`withTenantRead`, as `listAgents` does;
  `listRecentActivity` through `listOrganizationActivity`, which does the
  same), and every query here names that organisation on each table it reads,
  or joins a table through a composite `(organization_id, …)` foreign key to
  one that does.

  Who may see what is the request reads' rule, restated rather than imported:
  `listVisibility` and `visibleRequest` in request-query-repository.ts for a
  request, and `listOpenQuestions`'s audience rule for a question. The suite
  compares both figures with those reads, so the two cannot drift apart
  unnoticed for the shapes it seeds.
*/

/** Request states that are finished, or not yet submitted: not open. */
const notOpenStates = [
  "draft",
  "completed",
  "verified",
  "declined",
  "duplicate",
  "superseded",
  "cancelled",
] as const;

/** Request states that wait for someone with triage authority. */
const triageStates = ["submitted", "triage"] as const;

/**
 * A work session the agent is working in now: claimed or active, with a lease
 * that has not run out. A paused or blocked session is not work under way,
 * and a stale one is a session whose lease ran out
 * (`mark_work_session_stale` requires it), so none of those counts; nor does
 * a claimed or active one whose lease has run out before the worker marked it
 * stale.
 */
const workingSessionStates = ["claimed", "active"] as const;

/**
 * Outbox states the worker has not finished with: waiting to be claimed,
 * claimed by the dispatcher (`leased`), or handed to a run that has not
 * settled it (`accepted`). The operations page counts the same three as
 * pending (`operations-query-repository.ts`).
 */
const unprocessedOutboxStates = ["pending", "leased", "accepted"] as const;

/**
 * Event types the overview's "Recent activity" leaves out: bookkeeping that
 * no one did. `appearance.organization_defaults_initialized.v1` carries a
 * service actor and is written when an organisation's appearance defaults
 * are seeded: by 0014's backfill, or by the trigger
 * `requestport_initialize_organization_appearance` (0014, a definer since
 * 0019) when an active owner is written and no defaults row exists yet. The
 * row's primary key stops a second seeding while it exists, so there is one
 * such event per organisation. On an organisation nobody has used yet it can
 * be the only event, and drawing it would turn the first-run page's "No
 * activity yet" into "appearance organization defaults initialized ·
 * service". `/activity` still lists it.
 */
export const overviewHiddenActivityTypes: readonly string[] = [
  "appearance.organization_defaults_initialized.v1",
];

type OrganizationRole = "owner" | "admin" | "member";

interface Standing {
  role: OrganizationRole;
  administrator: boolean;
  /** Projects the person is an active member of, in any role. */
  memberProjectIds: string[];
  /** Projects the person actively maintains. */
  maintainedProjectIds: string[];
}

export interface OverviewSummary {
  role: OrganizationRole;
  /** Each setup step, done or not, from the organisation's own rows. */
  setup: {
    /** An active project exists. */
    project: boolean;
    /** An agent principal exists that is not revoked. */
    agent: boolean;
    /** A second active member, or an invitation still waiting, exists. */
    team: boolean;
    /** An enabled routing rule exists. */
    routing: boolean;
  };
  /** Agent principals whose status is active: registered. */
  activeAgents: number;
  /**
   * Of those, the ones that authenticated in the last 24 hours
   * (`connectedWindow`): a key or a grant of theirs, whatever its state now,
   * was last used since then. The stamp is at most `agentLastUseStampSeconds`
   * behind the newest request.
   */
  connectedAgents: number;
  /** Submitted and not yet finished requests the person can see. */
  openRequests: number;
  /** Open questions addressed to the person, on requests they can see. */
  questionsForYou: number;
  /** When the oldest of those was asked; null when there are none. */
  oldestQuestionAt: Date | null;
  /**
   * Webhook deliveries that ran out of retries in the last 24 hours. Null for
   * a member: webhooks are an owner's and an admin's alone.
   */
  failedDeliveries: number | null;
}

export interface TriageRequestItem {
  id: string;
  displayKey: string | null;
  title: string;
  state: string;
  targetProjectName: string;
  updatedAt: Date;
}

/**
 * The worker and database health line (ruling 261), for an owner or an
 * admin, every figure scoped to the reader's organisation: its outbox rows
 * are those whose event is its own. The outbox is instance-wide, so a figure
 * read across it would tell a reader about other organisations' work.
 */
export interface OverviewHealth {
  /** When the database ran this read, by its own clock: when it answered. */
  checkedAt: Date;
  /**
   * The organisation's events the worker has not finished: outbox rows
   * pending, leased or accepted (`unprocessedOutboxStates`).
   */
  unprocessedEvents: number;
  /** When the oldest of those was written; null when there are none. */
  oldestUnprocessedAt: Date | null;
  /** The organisation's outbox rows dead-lettered in the last 24 hours. */
  deadLetters: number;
  /**
   * The newest moment the dispatcher handed one of the organisation's events
   * to the worker (`outbox.accepted_at`); null when it never has.
   */
  lastDispatchAt: Date | null;
}

export interface FailedDeliveryItem {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  eventType: string;
  failedAt: Date;
}

/**
 * One agent principal's sign-ins and work. The key, grant and session counts
 * are zero for a principal that is suspended or revoked: a credential
 * authorizes only while its principal is active (`agent-authorization.ts`),
 * and suspending or revoking a principal leaves its keys and grants as they
 * were (`agent-repository.ts` changes only its status). `lastSignedInAt` is
 * history, and is read for every principal.
 */
export interface AgentConnection {
  agentPrincipalId: string;
  /**
   * API keys of an active principal that are not revoked, not expired and
   * not past their overlap.
   */
  activeKeyCount: number;
  /** Delegated OAuth grants of an active principal, active and not expired. */
  activeGrantCount: number;
  /**
   * When the agent last authenticated, by API key or by OAuth (ruling 261):
   * the newest use stamped on any key or grant it has held, whatever that
   * key's or grant's state now. Up to `agentLastUseStampSeconds` behind the
   * newest request; null when none has been used. OAuth use is stamped only
   * from migration 0027 on.
   */
  lastSignedInAt: Date | null;
  /** An active principal's working sessions (`workingSessionStates`). */
  workingSessionCount: number;
  /** Open requests assigned to the agent that the reader can see. */
  openAssignedCount: number;
}

/** The person's active membership of the active organisation, and projects. */
async function readStanding(
  database: TenantDatabase,
  userId: string,
  organizationId: string,
): Promise<Standing | null> {
  const [membership] = await database
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
      ),
    )
    .limit(1);
  if (!membership) return null;
  const projectRoles = await database
    .select({ projectId: projectMembers.projectId, role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, organizationId),
        eq(projectMembers.userId, userId),
        eq(projectMembers.status, "active"),
      ),
    );
  const role = membership.role as OrganizationRole;
  return {
    role,
    administrator: role === "owner" || role === "admin",
    memberProjectIds: projectRoles.map((entry) => entry.projectId),
    maintainedProjectIds: projectRoles
      .filter((entry) => entry.role === "maintainer")
      .map((entry) => entry.projectId),
  };
}

/**
 * `listVisibility`'s rule for the `requests` row of a query: an owner or an
 * admin sees every request; anyone else an organisation-wide request, one
 * they reported or are assigned, or one whose source or target project they
 * belong to.
 */
function visibleRequests(userId: string, standing: Standing): SQL {
  if (standing.administrator) return sql`true`;
  const ownRequest = [
    eq(requests.visibility, "organization"),
    and(eq(requests.reporterType, "user"), eq(requests.reporterId, userId)),
    and(eq(requests.assigneeType, "user"), eq(requests.assigneeId, userId)),
  ];
  const projectIds = standing.memberProjectIds;
  return (
    projectIds.length
      ? or(
          ...ownRequest,
          inArray(requests.sourceProjectId, projectIds),
          inArray(requests.targetProjectId, projectIds),
        )
      : or(...ownRequest)
  ) as SQL;
}

/**
 * `listOpenQuestions`'s audience rule: addressed to the person, to their
 * role, to the requester when they reported the request, or to the target
 * project's maintainers when they maintain it or administer the organisation.
 */
function addressedTo(userId: string, standing: Standing): SQL {
  const audiences = [
    and(eq(questions.audienceType, "user"), eq(questions.audienceId, userId)),
    and(
      eq(questions.audienceType, "role"),
      eq(questions.audienceId, standing.role),
    ),
    and(
      eq(questions.audienceType, "requester"),
      eq(requests.reporterType, "user"),
      eq(requests.reporterId, userId),
    ),
  ];
  if (standing.administrator) {
    audiences.push(eq(questions.audienceType, "project_maintainers"));
  } else if (standing.maintainedProjectIds.length) {
    audiences.push(
      and(
        eq(questions.audienceType, "project_maintainers"),
        inArray(requests.targetProjectId, standing.maintainedProjectIds),
      ),
    );
  }
  return or(...audiences) as SQL;
}

const failedDeliveryWindow = sql`clock_timestamp() - interval '24 hours'`;

/** "Agents connected": a key or grant last used within the last 24 hours. */
const connectedWindow = sql`clock_timestamp() - interval '24 hours'`;

/** The health line's dead letters: settled in the last 24 hours. */
const deadLetterWindow = sql`clock_timestamp() - interval '24 hours'`;

/**
 * A `webhook_deliveries` row that is the latest attempt at its event for its
 * subscription. A replay (`outbox-repository.ts`) inserts a new row with the
 * same subscription and event and the next `replay_number`, and leaves the
 * dead letter it replays as it was. Once a replay exists, the dead letter is
 * not waiting on anyone, whatever the replay's outcome: a replay that ran out
 * of retries as well is a dead letter of its own, and counts as one.
 */
const latestAttempt = sql`not exists (
  select 1 from ${webhookDeliveries} later
  where later.organization_id = ${webhookDeliveries.organizationId}
    and later.subscription_id = ${webhookDeliveries.subscriptionId}
    and later.event_id = ${webhookDeliveries.eventId}
    and later.replay_number > ${webhookDeliveries.replayNumber}
)`;

export function createOverviewQueryRepository(database: Database) {
  const forOrganization = <T>(
    organizationId: string,
    work: (database: TenantDatabase) => Promise<T>,
  ) => withTenantRead(organizationId, work, { database, readOnly: true });

  return {
    async summary(
      userId: string,
      organizationId: string,
    ): Promise<OverviewSummary> {
      return forOrganization(organizationId, async (database) => {
        const standing = await readStanding(database, userId, organizationId);
        if (!standing) {
          throw new DomainError("forbidden", "Overview access is denied");
        }
        const [project] = await database
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.organizationId, organizationId),
              eq(projects.status, "active"),
            ),
          )
          .limit(1);
        const [agent] = await database
          .select({ id: agentPrincipals.id })
          .from(agentPrincipals)
          .where(
            and(
              eq(agentPrincipals.organizationId, organizationId),
              ne(agentPrincipals.status, "revoked"),
            ),
          )
          .limit(1);
        const [members] = await database
          .select({ count: sql<number>`count(*)::integer` })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, organizationId),
              eq(organizationMembers.status, "active"),
            ),
          );
        const [invitation] = await database
          .select({ id: invitations.id })
          .from(invitations)
          .where(
            and(
              eq(invitations.organizationId, organizationId),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
              gt(invitations.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .limit(1);
        const [rule] = await database
          .select({ id: routingRules.id })
          .from(routingRules)
          .where(
            and(
              eq(routingRules.organizationId, organizationId),
              eq(routingRules.enabled, true),
            ),
          )
          .limit(1);
        const [activeAgents] = await database
          .select({ count: sql<number>`count(*)::integer` })
          .from(agentPrincipals)
          .where(
            and(
              eq(agentPrincipals.organizationId, organizationId),
              eq(agentPrincipals.status, "active"),
            ),
          );
        // Active agents with a key, or a grant, used within the window.
        const connectedByKey = await database
          .selectDistinct({ id: agentCredentials.agentPrincipalId })
          .from(agentCredentials)
          .innerJoin(
            agentPrincipals,
            and(
              eq(
                agentPrincipals.organizationId,
                agentCredentials.organizationId,
              ),
              eq(agentPrincipals.id, agentCredentials.agentPrincipalId),
              eq(agentPrincipals.status, "active"),
            ),
          )
          .where(
            and(
              eq(agentCredentials.organizationId, organizationId),
              gt(agentCredentials.lastUsedAt, connectedWindow),
            ),
          );
        const connectedByGrant = await database
          .selectDistinct({ id: agentOauthGrants.agentPrincipalId })
          .from(agentOauthGrants)
          .innerJoin(
            agentPrincipals,
            and(
              eq(
                agentPrincipals.organizationId,
                agentOauthGrants.organizationId,
              ),
              eq(agentPrincipals.id, agentOauthGrants.agentPrincipalId),
              eq(agentPrincipals.status, "active"),
            ),
          )
          .where(
            and(
              eq(agentOauthGrants.organizationId, organizationId),
              gt(agentOauthGrants.lastUsedAt, connectedWindow),
            ),
          );
        const connectedAgents = new Set(
          [...connectedByKey, ...connectedByGrant].map((row) => row.id),
        ).size;
        const [open] = await database
          .select({ count: sql<number>`count(*)::integer` })
          .from(requests)
          .where(
            and(
              eq(requests.organizationId, organizationId),
              notInArray(requests.state, [...notOpenStates]),
              visibleRequests(userId, standing),
            ),
          );
        const [asked] = await database
          .select({
            count: sql<number>`count(*)::integer`,
            oldest: sql<Date | null>`min(${questions.createdAt})`.mapWith(
              questions.createdAt,
            ),
          })
          .from(questions)
          .innerJoin(requests, eq(requests.id, questions.parentRequestId))
          .where(
            and(
              eq(questions.organizationId, organizationId),
              eq(questions.state, "open"),
              visibleRequests(userId, standing),
              addressedTo(userId, standing),
            ),
          );
        let failedDeliveries: number | null = null;
        if (standing.administrator) {
          const [failed] = await database
            .select({ count: sql<number>`count(*)::integer` })
            .from(webhookDeliveries)
            .where(
              and(
                eq(webhookDeliveries.organizationId, organizationId),
                eq(webhookDeliveries.status, "dead_letter"),
                gt(webhookDeliveries.completedAt, failedDeliveryWindow),
                latestAttempt,
              ),
            );
          failedDeliveries = failed?.count ?? 0;
        }
        return {
          role: standing.role,
          setup: {
            project: project !== undefined,
            agent: agent !== undefined,
            team: (members?.count ?? 0) > 1 || invitation !== undefined,
            routing: rule !== undefined,
          },
          activeAgents: activeAgents?.count ?? 0,
          connectedAgents,
          openRequests: open?.count ?? 0,
          questionsForYou: asked?.count ?? 0,
          oldestQuestionAt: asked?.oldest ?? null,
          failedDeliveries,
        };
      });
    },

    /**
     * Submitted requests, and requests in triage, that the person can see and
     * may triage: every one for an owner or an admin, those whose target
     * project they maintain for anyone else. Newest first.
     */
    async listTriageRequests(
      userId: string,
      organizationId: string,
      limit = 5,
    ): Promise<TriageRequestItem[]> {
      return forOrganization(organizationId, async (database) => {
        const standing = await readStanding(database, userId, organizationId);
        if (!standing) return [];
        if (!standing.administrator && !standing.maintainedProjectIds.length) {
          return [];
        }
        const authority = standing.administrator
          ? sql`true`
          : inArray(requests.targetProjectId, standing.maintainedProjectIds);
        return database
          .select({
            id: requests.id,
            displayKey: requests.displayKey,
            title: requests.title,
            state: requests.state,
            targetProjectName: projects.name,
            updatedAt: requests.updatedAt,
          })
          .from(requests)
          .innerJoin(projects, eq(projects.id, requests.targetProjectId))
          .where(
            and(
              eq(requests.organizationId, organizationId),
              inArray(requests.state, [...triageStates]),
              visibleRequests(userId, standing),
              authority,
            ),
          )
          .orderBy(desc(requests.updatedAt), desc(requests.id))
          .limit(limit);
      });
    },

    /**
     * Webhook deliveries that ran out of retries in the last 24 hours and
     * have not been replayed since (`latestAttempt`), newest first, for an
     * owner or an admin; nothing for anyone else.
     */
    async listFailedDeliveries(
      userId: string,
      organizationId: string,
      limit = 5,
    ): Promise<FailedDeliveryItem[]> {
      return forOrganization(organizationId, async (database) => {
        const standing = await readStanding(database, userId, organizationId);
        if (!standing?.administrator) return [];
        const rows = await database
          .select({
            id: webhookDeliveries.id,
            subscriptionId: webhookDeliveries.subscriptionId,
            subscriptionName: webhookSubscriptions.name,
            eventType: domainEvents.type,
            failedAt: webhookDeliveries.completedAt,
          })
          .from(webhookDeliveries)
          .innerJoin(
            webhookSubscriptions,
            eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId),
          )
          .innerJoin(
            domainEvents,
            eq(domainEvents.id, webhookDeliveries.eventId),
          )
          .where(
            and(
              eq(webhookDeliveries.organizationId, organizationId),
              eq(webhookDeliveries.status, "dead_letter"),
              gt(webhookDeliveries.completedAt, failedDeliveryWindow),
              latestAttempt,
            ),
          )
          .orderBy(
            desc(webhookDeliveries.completedAt),
            desc(webhookDeliveries.id),
          )
          .limit(limit);
        // A dead letter always carries its completion time
        // (`integrity-check.ts`); the filter above also requires it.
        return rows.map((row) => ({
          ...row,
          failedAt: row.failedAt as Date,
        }));
      });
    },

    /** Every agent principal's sign-ins, work and open assigned requests. */
    async listAgentConnections(
      userId: string,
      organizationId: string,
    ): Promise<AgentConnection[]> {
      return forOrganization(organizationId, async (database) => {
        const standing = await readStanding(database, userId, organizationId);
        if (!standing) return [];
        const agents = await database
          .select({ id: agentPrincipals.id })
          .from(agentPrincipals)
          .where(eq(agentPrincipals.organizationId, organizationId))
          .orderBy(agentPrincipals.displayName);
        const keys = await database
          .select({
            agentPrincipalId: agentCredentials.agentPrincipalId,
            count: sql<number>`count(*)::integer`,
          })
          .from(agentCredentials)
          .innerJoin(
            agentPrincipals,
            and(
              eq(
                agentPrincipals.organizationId,
                agentCredentials.organizationId,
              ),
              eq(agentPrincipals.id, agentCredentials.agentPrincipalId),
              eq(agentPrincipals.status, "active"),
            ),
          )
          .where(
            and(
              eq(agentCredentials.organizationId, organizationId),
              isNull(agentCredentials.revokedAt),
              gt(agentCredentials.expiresAt, sql`clock_timestamp()`),
              sql`(${agentCredentials.overlapExpiresAt} is null or ${agentCredentials.overlapExpiresAt} > clock_timestamp())`,
            ),
          )
          .groupBy(agentCredentials.agentPrincipalId);
        const grants = await database
          .select({
            agentPrincipalId: agentOauthGrants.agentPrincipalId,
            count: sql<number>`count(*)::integer`,
          })
          .from(agentOauthGrants)
          .innerJoin(
            agentPrincipals,
            and(
              eq(
                agentPrincipals.organizationId,
                agentOauthGrants.organizationId,
              ),
              eq(agentPrincipals.id, agentOauthGrants.agentPrincipalId),
              eq(agentPrincipals.status, "active"),
            ),
          )
          .where(
            and(
              eq(agentOauthGrants.organizationId, organizationId),
              eq(agentOauthGrants.status, "active"),
              isNull(agentOauthGrants.revokedAt),
              gt(agentOauthGrants.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .groupBy(agentOauthGrants.agentPrincipalId);
        const sessions = await database
          .select({
            agentPrincipalId: workSessions.agentPrincipalId,
            count: sql<number>`count(*)::integer`,
          })
          .from(workSessions)
          .innerJoin(
            agentPrincipals,
            and(
              eq(agentPrincipals.organizationId, workSessions.organizationId),
              eq(agentPrincipals.id, workSessions.agentPrincipalId),
              eq(agentPrincipals.status, "active"),
            ),
          )
          .where(
            and(
              eq(workSessions.organizationId, organizationId),
              inArray(workSessions.state, [...workingSessionStates]),
              gt(workSessions.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .groupBy(workSessions.agentPrincipalId);
        const assigned = await database
          .select({
            agentPrincipalId: requests.assigneeId,
            count: sql<number>`count(*)::integer`,
          })
          .from(requests)
          .where(
            and(
              eq(requests.organizationId, organizationId),
              eq(requests.assigneeType, "agent"),
              notInArray(requests.state, [...notOpenStates]),
              visibleRequests(userId, standing),
            ),
          )
          .groupBy(requests.assigneeId);
        // The newest use of each agent's keys and of its grants, whatever
        // their state now or the agent's.
        const keyUse = await database
          .select({
            agentPrincipalId: agentCredentials.agentPrincipalId,
            lastUsedAt:
              sql<Date | null>`max(${agentCredentials.lastUsedAt})`.mapWith(
                agentCredentials.lastUsedAt,
              ),
          })
          .from(agentCredentials)
          .where(eq(agentCredentials.organizationId, organizationId))
          .groupBy(agentCredentials.agentPrincipalId);
        const grantUse = await database
          .select({
            agentPrincipalId: agentOauthGrants.agentPrincipalId,
            lastUsedAt:
              sql<Date | null>`max(${agentOauthGrants.lastUsedAt})`.mapWith(
                agentOauthGrants.lastUsedAt,
              ),
          })
          .from(agentOauthGrants)
          .where(eq(agentOauthGrants.organizationId, organizationId))
          .groupBy(agentOauthGrants.agentPrincipalId);
        const keysBy = new Map(
          keys.map((row) => [row.agentPrincipalId, row.count]),
        );
        const grantsBy = new Map(
          grants.map((row) => [row.agentPrincipalId, row.count]),
        );
        const assignedBy = new Map(
          assigned.map((row) => [row.agentPrincipalId, row.count]),
        );
        const sessionsBy = new Map(
          sessions.map((row) => [row.agentPrincipalId, row.count]),
        );
        const signedInBy = new Map<string, Date>();
        for (const row of [...keyUse, ...grantUse]) {
          const known = signedInBy.get(row.agentPrincipalId);
          if (row.lastUsedAt && (!known || row.lastUsedAt > known)) {
            signedInBy.set(row.agentPrincipalId, row.lastUsedAt);
          }
        }
        return agents.map((agent) => ({
          agentPrincipalId: agent.id,
          activeKeyCount: keysBy.get(agent.id) ?? 0,
          activeGrantCount: grantsBy.get(agent.id) ?? 0,
          lastSignedInAt: signedInBy.get(agent.id) ?? null,
          workingSessionCount: sessionsBy.get(agent.id) ?? 0,
          openAssignedCount: assignedBy.get(agent.id) ?? 0,
        }));
      });
    },

    /**
     * The worker and database health line's figures (`OverviewHealth`), for
     * an owner or an admin; null for anyone else, who is not shown the line.
     * Each outbox query reaches the organisation through the row's event,
     * whose organisation it names, and the outbox's row policy admits only
     * rows whose event the binding admits.
     */
    async health(
      userId: string,
      organizationId: string,
    ): Promise<OverviewHealth | null> {
      return forOrganization(organizationId, async (database) => {
        const standing = await readStanding(database, userId, organizationId);
        if (!standing?.administrator) return null;
        // An aggregate answers one row whatever it finds, so the database's
        // clock is read with the first figure.
        const [unprocessed] = await database
          .select({
            checkedAt: sql<Date>`clock_timestamp()`.mapWith(outbox.createdAt),
            count: sql<number>`count(*)::integer`,
            oldest: sql<Date | null>`min(${outbox.createdAt})`.mapWith(
              outbox.createdAt,
            ),
          })
          .from(outbox)
          .innerJoin(domainEvents, eq(domainEvents.id, outbox.eventId))
          .where(
            and(
              eq(domainEvents.organizationId, organizationId),
              inArray(outbox.state, [...unprocessedOutboxStates]),
            ),
          );
        const [dead] = await database
          .select({ count: sql<number>`count(*)::integer` })
          .from(outbox)
          .innerJoin(domainEvents, eq(domainEvents.id, outbox.eventId))
          .where(
            and(
              eq(domainEvents.organizationId, organizationId),
              eq(outbox.state, "dead_letter"),
              gt(outbox.updatedAt, deadLetterWindow),
            ),
          );
        const [dispatched] = await database
          .select({
            at: sql<Date | null>`max(${outbox.acceptedAt})`.mapWith(
              outbox.acceptedAt,
            ),
          })
          .from(outbox)
          .innerJoin(domainEvents, eq(domainEvents.id, outbox.eventId))
          .where(eq(domainEvents.organizationId, organizationId));
        if (!unprocessed) throw new Error("The health read answered no row");
        return {
          checkedAt: unprocessed.checkedAt,
          unprocessedEvents: unprocessed.count,
          oldestUnprocessedAt: unprocessed.oldest ?? null,
          deadLetters: dead?.count ?? 0,
          lastDispatchAt: dispatched?.at ?? null,
        };
      });
    },

    /**
     * The organisation's latest events, newest first, as the activity page
     * reads them for this person (`listOrganizationActivity`, whose
     * visibility rules apply unchanged), without the types in
     * `overviewHiddenActivityTypes`. It asks for one more event per hidden
     * type than it returns, which is enough while each occurs once per
     * organisation, so a hidden event among the latest still leaves `limit`
     * others to draw.
     */
    async listRecentActivity(
      userId: string,
      organizationId: string,
      limit = 6,
    ): Promise<TimelineEventView[]> {
      const page = await createRequestQueryRepository(
        database,
      ).listOrganizationActivity({
        userId,
        organizationId,
        limit: limit + overviewHiddenActivityTypes.length,
      });
      return page.items
        .filter((event) => !overviewHiddenActivityTypes.includes(event.type))
        .slice(0, limit);
    },
  };
}
