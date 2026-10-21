import {
  DomainError,
  type WorkRepository,
  type WorkSessionRecord,
} from "@requestport/domain";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  agentInstallations,
  agentPrincipals,
  machineWorkspaces,
  organizations,
  projects,
  requests,
  workSessions,
  workUpdates,
} from "../schema/index.js";
import type { Tx } from "../transaction.js";
import {
  lockActiveApiKeyAuthorization,
  lockActiveOAuthAuthorization,
} from "./agent-authorization.js";

type WorkDatabase = Database | Tx;

function record(row: typeof workSessions.$inferSelect): WorkSessionRecord {
  return {
    ...row,
    authorizationChain: row.authorizationChain,
    claimMode: "exclusive",
    state: row.state as WorkSessionRecord["state"],
  };
}

function isUniqueViolation(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      current.code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? current.cause
        : undefined;
  }
  return false;
}

async function lockActiveAuthorization(
  database: WorkDatabase,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    authorizationId: string;
    delegatedByUserId?: string | null;
    projectId: string;
  },
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
        eq(projects.id, input.projectId),
        eq(projects.status, "active"),
      ),
    )
    .where(
      and(
        eq(agentPrincipals.organizationId, input.organizationId),
        eq(agentPrincipals.id, input.agentPrincipalId),
        eq(agentPrincipals.status, "active"),
        or(
          isNull(agentPrincipals.projectId),
          eq(agentPrincipals.projectId, input.projectId),
        ),
      ),
    )
    .for("share")
    .limit(1);
  if (!principal) return false;
  const credential = !input.delegatedByUserId
    ? await lockActiveApiKeyAuthorization(database, {
        organizationId: input.organizationId,
        agentPrincipalId: input.agentPrincipalId,
        authorizationId: input.authorizationId,
        projectId: input.projectId,
      })
    : null;
  if (credential) return true;
  const grant = input.delegatedByUserId
    ? await lockActiveOAuthAuthorization(database, {
        organizationId: input.organizationId,
        agentPrincipalId: input.agentPrincipalId,
        authorizationId: input.authorizationId,
        delegatedByUserId: input.delegatedByUserId,
        projectId: input.projectId,
      })
    : null;
  return Boolean(grant);
}

export function createWorkRepository(database: WorkDatabase): WorkRepository {
  return {
    async currentTime() {
      const result = await database.execute<{ now: string | Date }>(
        sql`select clock_timestamp() as now`,
      );
      const value = result.rows[0]?.now;
      if (!value) throw new Error("Database clock unavailable");
      return value instanceof Date ? value : new Date(value);
    },

    async projectLeasePolicy(input) {
      const [policy] = await database
        .select({
          heartbeatIntervalSeconds: projects.heartbeatIntervalSeconds,
          leaseMultiplier: projects.leaseMultiplier,
          graceSeconds: projects.graceSeconds,
        })
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, input.organizationId),
            eq(projects.id, input.projectId),
            eq(projects.status, "active"),
          ),
        )
        .for("share")
        .limit(1);
      return policy ?? null;
    },

    async validateAgentBinding(input) {
      const [binding] = await database
        .select({
          id: agentPrincipals.id,
          credentialId: agentInstallations.credentialId,
          oauthGrantId: agentInstallations.oauthGrantId,
        })
        .from(agentPrincipals)
        .innerJoin(
          agentInstallations,
          and(
            eq(
              agentInstallations.organizationId,
              agentPrincipals.organizationId,
            ),
            eq(agentInstallations.agentPrincipalId, agentPrincipals.id),
            eq(agentInstallations.id, input.installationId),
            eq(agentInstallations.status, "active"),
          ),
        )
        .innerJoin(
          machineWorkspaces,
          and(
            eq(
              machineWorkspaces.organizationId,
              agentPrincipals.organizationId,
            ),
            eq(machineWorkspaces.installationId, agentInstallations.id),
            eq(machineWorkspaces.id, input.workspaceId),
            eq(machineWorkspaces.projectId, input.request.targetProjectId),
            eq(machineWorkspaces.status, "active"),
          ),
        )
        .where(
          and(
            eq(agentPrincipals.organizationId, input.organizationId),
            eq(agentPrincipals.id, input.agentPrincipalId),
            eq(agentPrincipals.status, "active"),
            or(
              isNull(agentPrincipals.projectId),
              eq(agentPrincipals.projectId, input.request.targetProjectId),
            ),
          ),
        )
        .for("share")
        .limit(1);
      if (!binding) return false;
      if (
        binding.credentialId !== input.authorizationId &&
        binding.oauthGrantId !== input.authorizationId
      )
        return false;
      return lockActiveAuthorization(database, {
        organizationId: input.organizationId,
        agentPrincipalId: input.agentPrincipalId,
        authorizationId: input.authorizationId,
        delegatedByUserId: input.delegatedByUserId,
        projectId: input.request.targetProjectId,
      });
    },

    async validateSessionAuthorization(input) {
      const [binding] = await database
        .select({
          id: workSessions.id,
          authorizationChain: workSessions.authorizationChain,
        })
        .from(workSessions)
        .innerJoin(
          requests,
          and(
            eq(requests.organizationId, workSessions.organizationId),
            eq(requests.id, workSessions.requestId),
            eq(requests.targetProjectId, input.projectId),
          ),
        )
        .innerJoin(
          agentPrincipals,
          and(
            eq(agentPrincipals.organizationId, workSessions.organizationId),
            eq(agentPrincipals.id, workSessions.agentPrincipalId),
            eq(agentPrincipals.status, "active"),
            or(
              isNull(agentPrincipals.projectId),
              eq(agentPrincipals.projectId, input.projectId),
            ),
          ),
        )
        .where(
          and(
            eq(workSessions.organizationId, input.organizationId),
            eq(workSessions.id, input.workSessionId),
            eq(workSessions.agentPrincipalId, input.agentPrincipalId),
          ),
        )
        .for("share")
        .limit(1);
      if (!binding) return false;
      if (
        binding.authorizationChain.authorizationId !== input.authorizationId ||
        binding.authorizationChain.agentPrincipalId !==
          input.agentPrincipalId ||
        binding.authorizationChain.organizationId !== input.organizationId ||
        (binding.authorizationChain.delegatedByUserId ?? null) !==
          (input.delegatedByUserId ?? null)
      ) {
        return false;
      }
      return lockActiveAuthorization(database, input);
    },

    async createClaim(input) {
      try {
        const [created] = await database
          .insert(workSessions)
          .values({
            id: input.id,
            organizationId: input.organizationId,
            requestId: input.requestId,
            agentPrincipalId: input.agentPrincipalId,
            installationId: input.installationId,
            workspaceId: input.workspaceId,
            authorizationChain: input.authorizationChain,
            credentialFingerprint: input.credentialFingerprint,
            claimMode: "exclusive",
            state: "claimed",
            version: 1,
            eventVersion: 1,
            heartbeatIntervalSeconds: input.heartbeatIntervalSeconds,
            leaseMultiplier: input.leaseMultiplier,
            graceSeconds: input.graceSeconds,
            leaseExpiresAt: input.leaseExpiresAt,
            graceExpiresAt: input.graceExpiresAt,
          })
          .returning();
        if (!created) throw new Error("Work session persistence failed");
        return record(created);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DomainError(
            "conflict",
            "Request already has an exclusive claim",
          );
        }
        throw error;
      }
    },

    async findForUpdate(organizationId, workSessionId) {
      const [found] = await database
        .select()
        .from(workSessions)
        .where(
          and(
            eq(workSessions.organizationId, organizationId),
            eq(workSessions.id, workSessionId),
          ),
        )
        .for("update")
        .limit(1);
      return found ? record(found) : null;
    },

    async transition(input) {
      const [updated] = await database
        .update(workSessions)
        .set({
          state: input.toState,
          version: input.expectedVersion + 1,
          eventVersion: sql`${workSessions.eventVersion} + 1`,
          leaseExpiresAt: input.leaseExpiresAt,
          graceExpiresAt: input.graceExpiresAt,
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          endedReason: input.endedReason,
          outcomeSummaryMd: input.outcomeSummaryMd,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(workSessions.organizationId, input.organizationId),
            eq(workSessions.id, input.workSessionId),
            eq(workSessions.version, input.expectedVersion),
            eq(workSessions.state, input.fromState),
          ),
        )
        .returning();
      if (!updated) {
        throw new DomainError(
          "version_conflict",
          "Work session changed concurrently",
        );
      }
      return record(updated);
    },

    async heartbeat(input) {
      const [updated] = await database
        .update(workSessions)
        .set({
          version: input.expectedVersion + 1,
          leaseExpiresAt: input.leaseExpiresAt,
          graceExpiresAt: input.graceExpiresAt,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(workSessions.organizationId, input.organizationId),
            eq(workSessions.id, input.workSessionId),
            eq(workSessions.version, input.expectedVersion),
            eq(workSessions.state, input.state),
          ),
        )
        .returning();
      if (!updated) {
        throw new DomainError(
          "version_conflict",
          "Work session changed concurrently",
        );
      }
      return record(updated);
    },

    async appendUpdate(input) {
      await database.insert(workUpdates).values({
        id: input.id,
        organizationId: input.session.organizationId,
        requestId: input.session.requestId,
        workSessionId: input.session.id,
        actor: input.actor,
        kind: input.kind,
        bodyMd: input.bodyMd,
        progressPercent: input.progressPercent,
        evidence: input.evidence,
      });
    },
  };
}

/** A discovery function's limit: an integer, or NULL for its default. */
function sweepLimit(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? null
    : Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.trunc(value)));
}

/**
 * The stale-session sweep's discovery, through functions 10 and 11 (Plan 13,
 * I.2b; manifest-i2.md §5.1): ids, organisations and versions only (1-500,
 * default 100). The sweep's commands then run bound to each organisation.
 */
export function createWorkSweepRepository(database: Database) {
  const sessions = async (
    query: ReturnType<typeof sql>,
  ): Promise<
    Array<{ id: string; organizationId: string; version: number }>
  > => {
    const result = await database.execute<{
      session_id: string;
      organization_id: string;
      version: number;
    }>(query);
    return result.rows.map((row) => ({
      id: row.session_id,
      organizationId: row.organization_id,
      version: row.version,
    }));
  };
  return {
    listLeaseExpired(limit = 100) {
      return sessions(
        sql`select session_id, organization_id, version from requestport_private.lease_expired_work_sessions(${sweepLimit(limit)}::integer)`,
      );
    },
    listGraceExpired(limit = 100) {
      return sessions(
        sql`select session_id, organization_id, version from requestport_private.grace_expired_work_sessions(${sweepLimit(limit)}::integer)`,
      );
    },
  };
}
