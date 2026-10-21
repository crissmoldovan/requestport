import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  or,
  type SQLWrapper,
  sql,
} from "drizzle-orm";

import type { Database } from "../client.js";
import { inTurn } from "../in-turn.js";
import {
  agentCredentials,
  agentInstallations,
  agentOauthGrants,
  agentPrincipals,
  lanes,
  machineWorkspaces,
  oauthClients,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  user,
  workSessions,
  workUpdates,
} from "../schema/index.js";
import {
  inTenantTransaction,
  withIsolatedTenantBinding,
  withTenantRead,
  withUserBinding,
} from "../tenant-context.js";
import type { Tx } from "../transaction.js";

function activeMembership(userId: string, organizationId: string | SQLWrapper) {
  return sql`exists (
    select 1 from ${organizationMembers} am
    inner join ${organizations} ao on ao.id = am.organization_id
    where am.user_id = ${userId}
      and am.organization_id = ${organizationId}
      and am.status = 'active'
      and ao.status = 'active'
  )`;
}

export function createAgentManagementRepository(database: Database) {
  /** For the pool reads the application makes (manifest-i2.md §2.3 item 3). */
  const forOrganization = <T>(
    organizationId: string,
    work: (database: Database) => Promise<T>,
    readOnly = false,
  ) => withTenantRead(organizationId, work, { database, readOnly });

  return {
    async listAgents(userId: string, organizationId: string) {
      return forOrganization(
        organizationId,
        async (database) => {
          const rows = await database
            .select({
              id: agentPrincipals.id,
              projectId: agentPrincipals.projectId,
              projectName: projects.name,
              displayName: agentPrincipals.displayName,
              slug: agentPrincipals.slug,
              softwareName: agentPrincipals.softwareName,
              status: agentPrincipals.status,
              version: agentPrincipals.version,
              updatedAt: agentPrincipals.updatedAt,
              installationCount: sql<number>`(
              select count(*)::integer from ${agentInstallations} ai
              where ai.agent_principal_id = ${agentPrincipals.id}
                and ai.status = 'active'
            )`,
              activeSessionCount: sql<number>`(
              select count(*)::integer from ${workSessions} aws
              where aws.agent_principal_id = ${agentPrincipals.id}
                and aws.state in ('claimed', 'active', 'paused', 'blocked', 'stale')
            )`,
            })
            .from(agentPrincipals)
            .leftJoin(
              projects,
              and(
                eq(projects.organizationId, agentPrincipals.organizationId),
                eq(projects.id, agentPrincipals.projectId),
              ),
            )
            .where(
              and(
                eq(agentPrincipals.organizationId, organizationId),
                activeMembership(userId, organizationId),
              ),
            )
            .orderBy(agentPrincipals.displayName);
          return rows;
        },
        true,
      );
    },

    async getAgent(userId: string, organizationId: string, agentId: string) {
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          const [access] = await transaction
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
          if (!access) return null;
          const [agent] = await transaction
            .select({
              id: agentPrincipals.id,
              projectId: agentPrincipals.projectId,
              projectName: projects.name,
              displayName: agentPrincipals.displayName,
              slug: agentPrincipals.slug,
              softwareName: agentPrincipals.softwareName,
              status: agentPrincipals.status,
              version: agentPrincipals.version,
              createdAt: agentPrincipals.createdAt,
              updatedAt: agentPrincipals.updatedAt,
            })
            .from(agentPrincipals)
            .leftJoin(
              projects,
              and(
                eq(projects.organizationId, agentPrincipals.organizationId),
                eq(projects.id, agentPrincipals.projectId),
              ),
            )
            .where(
              and(
                eq(agentPrincipals.organizationId, organizationId),
                eq(agentPrincipals.id, agentId),
                activeMembership(userId, organizationId),
              ),
            )
            .limit(1);
          if (!agent) return null;
          const [
            installations,
            credentials,
            oauthGrants,
            workspaces,
            sessions,
          ] = await inTurn([
            () =>
              transaction
                .select({
                  id: agentInstallations.id,
                  softwareName: agentInstallations.softwareName,
                  softwareVersion: agentInstallations.softwareVersion,
                  capabilities: agentInstallations.capabilities,
                  status: agentInstallations.status,
                  firstSeenAt: agentInstallations.firstSeenAt,
                  lastSeenAt: agentInstallations.lastSeenAt,
                })
                .from(agentInstallations)
                .where(
                  and(
                    eq(agentInstallations.organizationId, organizationId),
                    eq(agentInstallations.agentPrincipalId, agentId),
                    activeMembership(userId, organizationId),
                  ),
                )
                .orderBy(desc(agentInstallations.lastSeenAt)),
            () =>
              transaction
                .select({
                  id: agentCredentials.id,
                  agentPrincipalId: agentCredentials.agentPrincipalId,
                  name: agentCredentials.name,
                  prefix: agentCredentials.prefix,
                  fingerprint: agentCredentials.fingerprint,
                  audience: agentCredentials.audience,
                  projectId: agentCredentials.projectId,
                  laneIds: agentCredentials.laneIds,
                  scopes: agentCredentials.scopes,
                  version: agentCredentials.version,
                  expiresAt: agentCredentials.expiresAt,
                  revokedAt: agentCredentials.revokedAt,
                  overlapExpiresAt: agentCredentials.overlapExpiresAt,
                  lastUsedAt: agentCredentials.lastUsedAt,
                  createdByUserId: agentCredentials.createdByUserId,
                  createdAt: agentCredentials.createdAt,
                })
                .from(agentCredentials)
                .where(
                  and(
                    eq(agentCredentials.organizationId, organizationId),
                    eq(agentCredentials.agentPrincipalId, agentId),
                    activeMembership(userId, organizationId),
                  ),
                )
                .orderBy(desc(agentCredentials.createdAt)),
            () =>
              transaction
                .select({
                  id: agentOauthGrants.id,
                  userId: agentOauthGrants.userId,
                  userName: user.name,
                  userEmail: user.email,
                  clientId: agentOauthGrants.oauthClientId,
                  clientName: oauthClients.name,
                  audience: agentOauthGrants.audience,
                  projectId: agentOauthGrants.projectId,
                  laneIds: agentOauthGrants.laneIds,
                  scopes: agentOauthGrants.scopes,
                  status: agentOauthGrants.status,
                  version: agentOauthGrants.version,
                  expiresAt: agentOauthGrants.expiresAt,
                  revokedAt: agentOauthGrants.revokedAt,
                  createdAt: agentOauthGrants.createdAt,
                })
                .from(agentOauthGrants)
                .innerJoin(user, eq(user.id, agentOauthGrants.userId))
                .innerJoin(
                  oauthClients,
                  eq(oauthClients.clientId, agentOauthGrants.oauthClientId),
                )
                .where(
                  and(
                    eq(agentOauthGrants.organizationId, organizationId),
                    eq(agentOauthGrants.agentPrincipalId, agentId),
                    activeMembership(userId, organizationId),
                  ),
                )
                .orderBy(desc(agentOauthGrants.createdAt)),
            () =>
              transaction
                .select({
                  id: machineWorkspaces.id,
                  projectId: machineWorkspaces.projectId,
                  repositoryId: machineWorkspaces.repositoryId,
                  installationId: machineWorkspaces.installationId,
                  safeCapabilities: machineWorkspaces.safeCapabilities,
                  telemetrySchemaVersion:
                    machineWorkspaces.telemetrySchemaVersion,
                  status: machineWorkspaces.status,
                  lastSeenAt: machineWorkspaces.lastSeenAt,
                })
                .from(machineWorkspaces)
                .innerJoin(
                  agentInstallations,
                  and(
                    eq(
                      agentInstallations.organizationId,
                      machineWorkspaces.organizationId,
                    ),
                    eq(agentInstallations.id, machineWorkspaces.installationId),
                    eq(agentInstallations.agentPrincipalId, agentId),
                  ),
                )
                .where(
                  and(
                    eq(machineWorkspaces.organizationId, organizationId),
                    activeMembership(userId, organizationId),
                  ),
                )
                .orderBy(desc(machineWorkspaces.lastSeenAt)),
            () =>
              transaction
                .select({
                  id: workSessions.id,
                  requestId: workSessions.requestId,
                  state: workSessions.state,
                  version: workSessions.version,
                  heartbeatIntervalSeconds:
                    workSessions.heartbeatIntervalSeconds,
                  leaseExpiresAt: workSessions.leaseExpiresAt,
                  startedAt: workSessions.startedAt,
                  endedAt: workSessions.endedAt,
                  endedReason: workSessions.endedReason,
                  updatedAt: workSessions.updatedAt,
                  latestProgress: sql<string | null>`(
              select wu.body_md from ${workUpdates} wu
              where wu.work_session_id = ${workSessions.id}
              order by wu.created_at desc limit 1
            )`,
                })
                .from(workSessions)
                .where(
                  and(
                    eq(workSessions.organizationId, organizationId),
                    eq(workSessions.agentPrincipalId, agentId),
                    activeMembership(userId, organizationId),
                  ),
                )
                .orderBy(desc(workSessions.createdAt))
                .limit(100),
          ]);
          return {
            agent,
            installations,
            credentials,
            oauthGrants,
            workspaces,
            sessions,
          };
        },
      );
    },

    /**
     * What the agent consent screen offers, in three phases
     * (manifest-i2.md §2.5.1):
     *
     * 1. the client, from a global table, with no lock: binding re-reads it
     *    `FOR SHARE` in its own transaction (`bindOAuthConsent`; D8);
     * 2. the person's active memberships, in user mode, through
     *    `requestport_private.active_memberships()`;
     * 3. for each of those organisations, its projects, the person's
     *    maintained projects, its agents and its lanes, each organisation in
     *    a read bound to it alone, with the predicates this method had.
     *
     * No lock is held across organisations: this is a render, and binding
     * re-checks the membership in the organisation chosen. Projects, agents
     * and lanes come back in the order the single query this replaced gave
     * them: by name across organisations (`orderedByName`). The provisionable
     * organisations come in the listing's slug order.
     *
     * Its cost, declared (the driver's ruling R6, 2026-09-29): the listing's
     * transaction, one transaction per active membership, and, when rows
     * come from more than one organisation, one statement for the sort.
     */
    async getConsentOptions(userId: string, clientId: string) {
      const [client] = await database
        .select({
          clientId: oauthClients.clientId,
          name: oauthClients.name,
          uri: oauthClients.uri,
          icon: oauthClients.icon,
          redirectUris: oauthClients.redirectUris,
          tokenEndpointAuthMethod: oauthClients.tokenEndpointAuthMethod,
          requirePkce: oauthClients.requirePKCE,
          disabled: oauthClients.disabled,
        })
        .from(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
        .limit(1);
      if (
        !client ||
        client.disabled ||
        // A public client is one with no client secret at the token
        // endpoint. Better Auth 1.7 no longer writes the `public` column, so
        // it is not read here; 1.6.29 derived it from this same value.
        client.tokenEndpointAuthMethod !== "none" ||
        // Null means Better Auth will require PKCE; only an explicit false
        // means it will not. Dynamic client registration always leaves null,
        // so a falsy test hid the consent screen from every agent client.
        client.requirePkce === false
      ) {
        return null;
      }
      const memberships = await withUserBinding(
        userId,
        async (tx) =>
          (
            (
              await tx.execute(
                sql`select organization_id, organization_name, role from requestport_private.active_memberships()`,
              )
            ).rows as {
              organization_id: string;
              organization_name: string;
              role: string;
            }[]
          ).map((row) => ({
            organizationId: row.organization_id,
            organizationName: row.organization_name,
            role: row.role,
          })),
        { database },
      );
      /**
       * Where this person could approve an organization-wide grant.
       *
       * Only owners and admins, because that is the standing a provisioning
       * grant requires and the consent screen should not offer a choice that
       * binding would then refuse.
       *
       * Computed before the early returns below, not after: an organization
       * with no projects is exactly the case a provisioning grant exists for,
       * and those returns are the ones it takes. Leaving this until the end
       * meant the one caller that needed it got `undefined`.
       */
      const provisionableOrganizations = memberships
        .filter((row) => row.role === "owner" || row.role === "admin")
        .map((row) => ({
          id: row.organizationId,
          name: row.organizationName,
        }));
      const perOrganization: Awaited<
        ReturnType<typeof consentOptionsInOrganization>
      >[] = [];
      for (const membership of memberships) {
        perOrganization.push(
          await withIsolatedTenantBinding(
            membership.organizationId,
            (tx) => consentOptionsInOrganization(tx, userId, membership),
            { database },
          ),
        );
      }
      const projectRows = perOrganization.flatMap((found) => found.projects);
      if (!projectRows.length) {
        return {
          client,
          projects: [],
          agents: [],
          lanes: [],
          organizations: provisionableOrganizations,
        };
      }
      // An organisation where the person represents no project can still
      // offer its organisation-wide agents.
      const contributing = perOrganization.filter(
        (found) =>
          found.projects.length + found.agents.length + found.lanes.length > 0,
      ).length;
      const agentRows = perOrganization.flatMap((found) => found.agents);
      const laneRows = perOrganization.flatMap((found) => found.lanes);
      if (contributing < 2) {
        // One organisation's rows are already in its own name order, which
        // is the order the single query gave them.
        return {
          client,
          projects: projectRows,
          agents: agentRows,
          lanes: laneRows,
          organizations: provisionableOrganizations,
        };
      }
      const [projectsByName, agentsByName, lanesByName] = await orderedByName(
        database,
        [
          projectRows.map((project) => project.name),
          agentRows.map((agent) => agent.displayName),
          laneRows.map((lane) => lane.name),
        ],
      );
      return {
        client,
        projects: inOrder(projectRows, projectsByName),
        agents: inOrder(agentRows, agentsByName),
        lanes: inOrder(laneRows, lanesByName),
        organizations: provisionableOrganizations,
      };
    },
  };
}

/**
 * For each list of names, the positions that put it in the order
 * PostgreSQL's `ORDER BY` on a text column puts it, a tie kept in the
 * list's own order. The sort runs in PostgreSQL, over the values handed to
 * it and no table, so it uses the database's own collation — the one the
 * single consent query used for `order by name` — which a JavaScript
 * comparison need not match.
 */
async function orderedByName(
  database: Database,
  lists: string[][],
): Promise<number[][]> {
  // One element per name: [list, position, name]. `->> 2` is text in the
  // database's default collation, as a text column is.
  const entries = lists.flatMap((names, list) =>
    names.map((name, position) => [list, position, name]),
  );
  const { rows } = await database.execute(
    sql`select (entry ->> 0)::int as list, (entry ->> 1)::int as position
        from jsonb_array_elements(${JSON.stringify(entries)}::jsonb) as entry
        order by (entry ->> 0)::int, entry ->> 2, (entry ->> 1)::int`,
  );
  const ordered = lists.map((): number[] => []);
  for (const row of rows as { list: number; position: number }[]) {
    ordered[row.list]?.push(row.position);
  }
  return ordered;
}

function inOrder<T>(rows: T[], positions: number[] | undefined): T[] {
  return (positions ?? []).map((position) => rows[position] as T);
}

/**
 * One organisation's part of the consent options, read under a binding to
 * that organisation alone: its active projects the person may represent
 * (every one for an owner or admin, else the ones they maintain), its active
 * agents that are organisation-wide or on one of those projects, and those
 * projects' active lanes.
 */
async function consentOptionsInOrganization(
  tx: Tx,
  userId: string,
  membership: { organizationId: string; role: string },
) {
  const organizationId = membership.organizationId;
  // Sequential on purpose: these run on one transaction's client, which
  // serialises them anyway, and pg deprecates a query issued while another
  // is in flight on the same client (removed in pg@9).
  const allProjectRows = await tx
    .select({
      id: projects.id,
      organizationId: projects.organizationId,
      organizationName: organizations.name,
      name: projects.name,
      slug: projects.slug,
    })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.organizationId))
    .where(
      and(
        eq(projects.organizationId, organizationId),
        eq(projects.status, "active"),
        activeMembership(userId, projects.organizationId),
      ),
    )
    .orderBy(projects.name);
  const maintainedProjects = await tx
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, organizationId),
        eq(projectMembers.userId, userId),
        eq(projectMembers.status, "active"),
        eq(projectMembers.role, "maintainer"),
      ),
    );
  const manager = membership.role === "owner" || membership.role === "admin";
  const maintainedProjectIds = new Set(
    maintainedProjects.map((project) => project.projectId),
  );
  const projectRows = allProjectRows.filter(
    (project) => manager || maintainedProjectIds.has(project.id),
  );
  const projectIds = projectRows.map((project) => project.id);
  const agents = await tx
    .select({
      id: agentPrincipals.id,
      organizationId: agentPrincipals.organizationId,
      organizationName: organizations.name,
      projectId: agentPrincipals.projectId,
      displayName: agentPrincipals.displayName,
      slug: agentPrincipals.slug,
    })
    .from(agentPrincipals)
    .innerJoin(
      organizations,
      eq(organizations.id, agentPrincipals.organizationId),
    )
    .where(
      and(
        eq(agentPrincipals.organizationId, organizationId),
        eq(agentPrincipals.status, "active"),
        or(
          isNull(agentPrincipals.projectId),
          inArray(agentPrincipals.projectId, projectIds),
        ),
        activeMembership(userId, agentPrincipals.organizationId),
      ),
    )
    .orderBy(agentPrincipals.displayName);
  const laneRows =
    projectIds.length === 0
      ? []
      : await tx
          .select({
            id: lanes.id,
            organizationId: lanes.organizationId,
            projectId: lanes.projectId,
            name: lanes.name,
            slug: lanes.slug,
          })
          .from(lanes)
          .where(
            and(
              eq(lanes.organizationId, organizationId),
              inArray(lanes.projectId, projectIds),
              eq(lanes.status, "active"),
              activeMembership(userId, lanes.organizationId),
            ),
          )
          .orderBy(lanes.name);
  return { projects: projectRows, agents, lanes: laneRows };
}
