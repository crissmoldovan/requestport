import type {
  FoundationQueryRepository,
  OrganizationAccess,
  OrganizationMember,
  OrganizationProject,
  PendingInvitation,
} from "@requestport/domain";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "../client.js";
import {
  invitations,
  lanes,
  organizationMembers,
  organizations,
  projectMembers,
  projectRepositories,
  projects,
  user,
} from "../schema/index.js";
import { withTenantRead, withUserBinding } from "../tenant-context.js";
import type { Tx } from "../transaction.js";

type FoundationReadDatabase = Database | Tx;
const actorMemberships = alias(organizationMembers, "actor_memberships");

const organizationProjection = {
  id: organizations.id,
  name: organizations.name,
  slug: organizations.slug,
  role: organizationMembers.role,
};

function organizationAccess(row: {
  id: string;
  name: string;
  slug: string;
  role: string;
}): OrganizationAccess {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role as OrganizationAccess["role"],
  };
}

export function createFoundationQueryRepository(
  database: FoundationReadDatabase,
): FoundationQueryRepository {
  /**
   * Every read below but the membership listing names its organisation, and
   * the web calls them on the pool: each is wrapped in a read-only
   * transaction bound to that organisation once the application variable is
   * set (manifest-i2.md §2.3 item 3, ruling 17), and runs as before until
   * then. Handed a transaction, it runs in it as its opener bound it.
   */
  const forOrganization = <T>(
    organizationId: string,
    work: (database: FoundationReadDatabase) => Promise<T>,
    readOnly = false,
  ) => withTenantRead(organizationId, work, { database, readOnly });

  return {
    /**
     * Every active organisation the user is an active member of, by slug
     * then id. Before any organisation is chosen, so in user mode, through
     * `requestport_private.active_memberships()`, which answers from the
     * binding alone and returns exactly these rows (manifest-i2.md §2.5.1).
     */
    async listActiveOrganizationsForUser(userId) {
      const rows = await withUserBinding(
        userId,
        async (tx) =>
          (
            await tx.execute(
              sql`select organization_id, organization_name, organization_slug, role from requestport_private.active_memberships()`,
            )
          ).rows as {
            organization_id: string;
            organization_name: string;
            organization_slug: string;
            role: string;
          }[],
        { database },
      );
      return rows.map((row) =>
        organizationAccess({
          id: row.organization_id,
          name: row.organization_name,
          slug: row.organization_slug,
          role: row.role,
        }),
      );
    },

    async findActiveOrganizationForUser(userId, organizationId) {
      return forOrganization(
        organizationId,
        async (database) => {
          const [row] = await database
            .select(organizationProjection)
            .from(organizationMembers)
            .innerJoin(
              organizations,
              eq(organizations.id, organizationMembers.organizationId),
            )
            .where(
              and(
                eq(organizationMembers.userId, userId),
                eq(organizationMembers.organizationId, organizationId),
                eq(organizationMembers.status, "active"),
                eq(organizations.status, "active"),
              ),
            )
            .limit(1);
          return row ? organizationAccess(row) : null;
        },
        true,
      );
    },

    async listOrganizationProjects(userId, organizationId) {
      return forOrganization(
        organizationId,
        async (database) => {
          const rows = await database
            .select({
              id: projects.id,
              name: projects.name,
              slug: projects.slug,
              keyPrefix: projects.keyPrefix,
              status: projects.status,
              canRepresent: sql<boolean>`(${actorMemberships.role} in ('owner', 'admin') or (${projectMembers.status} = 'active'))`,
              repositoryBrowseUrl: projectRepositories.browseUrl,
              repositorySlug: projectRepositories.repositorySlug,
            })
            .from(projects)
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, projects.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .innerJoin(
              actorMemberships,
              and(
                eq(actorMemberships.organizationId, projects.organizationId),
                eq(actorMemberships.userId, userId),
                eq(actorMemberships.status, "active"),
              ),
            )
            .leftJoin(
              projectMembers,
              and(
                eq(projectMembers.organizationId, projects.organizationId),
                eq(projectMembers.projectId, projects.id),
                eq(projectMembers.userId, userId),
              ),
            )
            .leftJoin(
              projectRepositories,
              and(
                eq(projectRepositories.organizationId, projects.organizationId),
                eq(projectRepositories.projectId, projects.id),
                eq(projectRepositories.isDefault, true),
                eq(projectRepositories.status, "active"),
              ),
            )
            .where(eq(projects.organizationId, organizationId))
            .orderBy(asc(projects.name), asc(projects.id));
          return rows.map(
            (row): OrganizationProject => ({
              id: row.id,
              name: row.name,
              slug: row.slug,
              keyPrefix: row.keyPrefix,
              status: row.status as OrganizationProject["status"],
              canRepresent: row.canRepresent,
              defaultRepository:
                row.repositoryBrowseUrl && row.repositorySlug
                  ? {
                      browseUrl: row.repositoryBrowseUrl,
                      repositorySlug: row.repositorySlug,
                    }
                  : null,
            }),
          );
        },
        true,
      );
    },

    async listOrganizationLanes(userId: string, organizationId: string) {
      return forOrganization(
        organizationId,
        async (database) => {
          return database
            .select({
              id: lanes.id,
              projectId: lanes.projectId,
              name: lanes.name,
              slug: lanes.slug,
            })
            .from(lanes)
            .innerJoin(
              actorMemberships,
              and(
                eq(actorMemberships.organizationId, lanes.organizationId),
                eq(actorMemberships.userId, userId),
                eq(actorMemberships.status, "active"),
              ),
            )
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, lanes.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .where(
              and(
                eq(lanes.organizationId, organizationId),
                eq(lanes.status, "active"),
              ),
            )
            .orderBy(asc(lanes.name));
        },
        true,
      );
    },

    async listOrganizationMembers(userId, organizationId) {
      return forOrganization(
        organizationId,
        async (database) => {
          const rows = await database
            .select({
              userId: organizationMembers.userId,
              name: user.name,
              email: user.email,
              role: organizationMembers.role,
              version: organizationMembers.version,
            })
            .from(organizationMembers)
            .innerJoin(user, eq(user.id, organizationMembers.userId))
            .innerJoin(
              actorMemberships,
              and(
                eq(
                  actorMemberships.organizationId,
                  organizationMembers.organizationId,
                ),
                eq(actorMemberships.userId, userId),
                eq(actorMemberships.status, "active"),
              ),
            )
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
                eq(organizationMembers.status, "active"),
              ),
            )
            .orderBy(asc(user.name), asc(organizationMembers.userId));
          return rows.map(
            (row): OrganizationMember => ({
              userId: row.userId,
              name: row.name,
              email: row.email,
              role: row.role as OrganizationMember["role"],
              version: row.version,
            }),
          );
        },
        true,
      );
    },

    async listPendingInvitations(userId, organizationId) {
      return forOrganization(
        organizationId,
        async (database) => {
          const rows = await database
            .select({
              id: invitations.id,
              email: invitations.normalizedEmail,
              role: invitations.role,
              expiresAt: invitations.expiresAt,
              version: invitations.version,
            })
            .from(invitations)
            .innerJoin(
              actorMemberships,
              and(
                eq(actorMemberships.organizationId, invitations.organizationId),
                eq(actorMemberships.userId, userId),
                eq(actorMemberships.status, "active"),
                inArray(actorMemberships.role, ["owner", "admin"]),
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
                eq(invitations.organizationId, organizationId),
                isNull(invitations.acceptedAt),
                isNull(invitations.revokedAt),
                sql`${invitations.expiresAt} > clock_timestamp()`,
              ),
            )
            .orderBy(asc(invitations.expiresAt), asc(invitations.id));
          return rows.map(
            (row): PendingInvitation => ({
              id: row.id,
              email: row.email,
              role: row.role as PendingInvitation["role"],
              expiresAt: row.expiresAt,
              version: row.version,
            }),
          );
        },
        true,
      );
    },
  };
}
