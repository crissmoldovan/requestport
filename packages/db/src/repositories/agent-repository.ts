import type {
  AgentInstallationRecord,
  AgentPrincipalRecord,
  AgentRepository,
} from "@requestport/domain";
import { auditActor, DomainError } from "@requestport/domain";
import { and, eq, isNull, or } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  agentInstallations,
  agentPrincipals,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  securityAuditRecords,
} from "../schema/index.js";
import { withTenantRead } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import {
  lockActiveApiKeyAuthorization,
  lockActiveOAuthAuthorization,
} from "./agent-authorization.js";

type AgentDatabase = Database | Tx;

function principalRecord(
  row: typeof agentPrincipals.$inferSelect,
): AgentPrincipalRecord {
  return {
    ...row,
    projectId: row.projectId,
    softwareName: row.softwareName,
    status: row.status as AgentPrincipalRecord["status"],
  };
}

/**
 * Whether a failed insert is the organization-wide agent name already being
 * taken, rather than anything else the database could refuse.
 *
 * `agent_principals` is unique on (organization, lower(slug)) across the whole
 * organization, while the MCP tool that reaches here offers to provision an
 * agent "in a project" — so the second project to ask for `deploy-bot` trips
 * it, and that is the ordinary case rather than a strange one. The driver error
 * arrives wrapped, so the chain is walked the same bounded way the foundation
 * mapper walks it. Only that one index is read as a taken name: another unique
 * violation here is still unexplained, and answering "change the slug" to one
 * of those would send the caller to edit a field that was never the problem.
 */
function isSlugAlreadyTaken(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (candidate.code === "23505") {
      return (
        candidate.constraint === "agent_principals_organization_slug_ci_unique"
      );
    }
    current = candidate.cause;
  }
  return false;
}

function installationRecord(
  row: typeof agentInstallations.$inferSelect,
): AgentInstallationRecord {
  return {
    ...row,
    status: row.status as AgentInstallationRecord["status"],
  };
}

export function createAgentRepository(
  database: AgentDatabase,
): AgentRepository {
  /**
   * The web calls `canManage` and `findPrincipal` on the pool, so they are
   * wrapped as manifest-i2.md §2.3 item 3 says (`canManage` locks, so its
   * transaction is not read-only); the rest are command ports, run in the
   * command transaction as it is bound.
   */
  const forOrganization = <T>(
    organizationId: string,
    work: (database: AgentDatabase) => Promise<T>,
    readOnly = false,
  ) => withTenantRead(organizationId, work, { database, readOnly });

  return {
    async canManage(input) {
      return forOrganization(input.organizationId, async (database) => {
        if (input.actor.type !== "user") return false;
        const [organization] = await database
          .select({ id: organizations.id })
          .from(organizations)
          .where(
            and(
              eq(organizations.id, input.organizationId),
              eq(organizations.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (!organization) return false;
        const [membership] = await database
          .select({ role: organizationMembers.role })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, input.organizationId),
              eq(organizationMembers.userId, input.actor.id),
              eq(organizationMembers.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (!membership) return false;
        const organizationManager =
          membership.role === "owner" || membership.role === "admin";
        if (!input.projectId) return organizationManager;
        const [project] = await database
          .select({ id: projects.id })
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
        if (!project) return false;
        if (organizationManager) return true;
        const [projectMembership] = await database
          .select({ role: projectMembers.role })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.organizationId, input.organizationId),
              eq(projectMembers.projectId, input.projectId),
              eq(projectMembers.userId, input.actor.id),
              eq(projectMembers.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        return Boolean(projectMembership?.role === "maintainer");
      });
    },

    async createPrincipal(input) {
      if (input.projectId) {
        const [project] = await database
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.organizationId, input.organizationId),
              eq(projects.id, input.projectId),
              eq(projects.status, "active"),
            ),
          )
          .limit(1);
        if (!project) throw new Error("Agent project binding is invalid");
      }
      let created: typeof agentPrincipals.$inferSelect | undefined;
      try {
        [created] = await database
          .insert(agentPrincipals)
          .values({
            id: input.id,
            organizationId: input.organizationId,
            projectId: input.projectId,
            displayName: input.displayName,
            slug: input.slug,
            softwareName: input.softwareName,
            status: "active",
            createdByUserId: input.createdByUserId,
          })
          .returning();
      } catch (error) {
        if (!isSlugAlreadyTaken(error)) throw error;
        /*
          Nothing between this insert and the caller turns a 23505 into an
          answer: the command bus rethrows what it is given and the transaction
          manager has no catch, so provisioning a second agent under a name the
          organization already uses reached the agent as `unexpected_error` —
          indistinguishable from an outage, with no field to act on. The
          transaction has already rolled back, so the only thing missing was
          saying what happened. Named the way `bindOAuthConsent` names it,
          because it is the same index and the same collision.
        */
        throw new DomainError(
          "conflict",
          "An agent principal with that stable slug already exists in this organization",
          { field: "slug" },
        );
      }
      if (!created) throw new Error("Agent principal persistence failed");
      return principalRecord(created);
    },

    async findPrincipal(organizationId, agentPrincipalId) {
      return forOrganization(
        organizationId,
        async (database) => {
          const [found] = await database
            .select({ principal: agentPrincipals })
            .from(agentPrincipals)
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, agentPrincipals.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .leftJoin(
              projects,
              and(
                eq(projects.organizationId, agentPrincipals.organizationId),
                eq(projects.id, agentPrincipals.projectId),
                eq(projects.status, "active"),
              ),
            )
            .where(
              and(
                eq(agentPrincipals.organizationId, organizationId),
                eq(agentPrincipals.id, agentPrincipalId),
                or(
                  isNull(agentPrincipals.projectId),
                  eq(projects.id, agentPrincipals.projectId),
                ),
              ),
            )
            .limit(1);
          return found ? principalRecord(found.principal) : null;
        },
        true,
      );
    },

    async setPrincipalStatus(input) {
      const [current] = await database
        .select()
        .from(agentPrincipals)
        .where(
          and(
            eq(agentPrincipals.organizationId, input.organizationId),
            eq(agentPrincipals.id, input.agentPrincipalId),
          ),
        )
        .for("update")
        .limit(1);
      if (!current) {
        throw new DomainError("not_found", "Agent principal was not found");
      }
      if (current.version !== input.expectedVersion) {
        throw new DomainError("version_conflict", "Agent principal changed");
      }
      if (current.status === input.status) {
        throw new DomainError("conflict", "Agent already has that status");
      }
      if (current.status === "revoked") {
        throw new DomainError(
          "conflict",
          "A revoked agent cannot be reactivated",
        );
      }
      const [updated] = await database
        .update(agentPrincipals)
        .set({
          status: input.status,
          version: input.expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentPrincipals.organizationId, input.organizationId),
            eq(agentPrincipals.id, input.agentPrincipalId),
            eq(agentPrincipals.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!updated) {
        throw new DomainError("version_conflict", "Agent principal changed");
      }
      // The actor who acts, as `auditActor` records it: a person as `user`
      // and their id, an operator as `service` and `operator:<lineage>`
      // (Plan 13, F.3, F3-2), never as its member.
      const { actorType, actorId } = auditActor(input);
      await database.insert(securityAuditRecords).values({
        organizationId: input.organizationId,
        actorType,
        actorId,
        action: `agent.${input.status}`,
        targetType: "agent_principal",
        targetId: input.agentPrincipalId,
        reason: input.reason,
        fieldNames: ["status"],
        correlationId: input.correlationId,
      });
      return {
        principal: principalRecord(updated),
        previousStatus: current.status as AgentPrincipalRecord["status"],
      };
    },

    async registerInstallation(input) {
      const credential = !input.delegatedByUserId
        ? await lockActiveApiKeyAuthorization(database, {
            organizationId: input.organizationId,
            agentPrincipalId: input.agentPrincipalId,
            authorizationId: input.authorizationId,
            projectId: input.projectId,
          })
        : null;
      const grant = input.delegatedByUserId
        ? await lockActiveOAuthAuthorization(database, {
            organizationId: input.organizationId,
            agentPrincipalId: input.agentPrincipalId,
            authorizationId: input.authorizationId,
            delegatedByUserId: input.delegatedByUserId,
            projectId: input.projectId,
          })
        : null;
      if (!credential && !grant) {
        throw new Error("Agent authorization binding is invalid");
      }
      const [created] = await database
        .insert(agentInstallations)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          agentPrincipalId: input.agentPrincipalId,
          oauthGrantId: grant?.id ?? null,
          credentialId: credential?.id ?? null,
          softwareName: input.softwareName,
          softwareVersion: input.softwareVersion,
          capabilities: input.capabilities,
          status: "active",
        })
        .returning();
      if (!created) throw new Error("Agent installation persistence failed");
      return installationRecord(created);
    },
  };
}
