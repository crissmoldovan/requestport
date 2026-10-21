import { DomainError } from "@requestport/domain";
import { and, asc, eq } from "drizzle-orm";

import {
  lanes,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
} from "../../schema/index.js";
import type { Tx } from "../../transaction.js";

/*
  F.2.0b's three shared administration reads (Plan 13; `manifest-f2.md` §4.1):
  `list_administration_projects`, `list_administration_lanes` and
  `list_administration_members`. They serve the writes of F.2.1, F.2.3, F.2.5,
  F.2.6 and F.2.7, which take project, lane and member ids from them, and
  `setMember`'s expected version.

  Each checks one rule, the rule of the page reads it replaces
  (`foundation-query.ts`'s `listOrganizationProjects`, `listOrganizationLanes`
  and `listOrganizationMembers`): the member is active in an active
  organisation. Each write still checks its own rule when it runs.

  Each returns identifiers and versions, and the state a write's precondition
  reads (a project's `status`, whether the member may represent it). Never a
  person's name or email, and never a project's or lane's name or slug.

  Every query here carries the organisation's predicate, with the value the
  caller hands in, so the tenant-scope sweep needs no ledger line for this
  file (§4.1, rule 9).
*/

const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface OrganizationReadInput {
  /** The member whose standing the read runs under: a person's user id. */
  memberUserId: string;
  /** The credential's organisation. */
  organizationId: string;
  /** The project the credential is bound to, or null when it is bound to none. */
  credentialProjectId: string | null;
}

/**
 * The shared rule: the organisation row, active, and the member's
 * organisation membership, active, each locked `FOR SHARE`. Throws
 * `forbidden` when either is missing, so a revoked member, a member of
 * another organisation only and a suspended organisation read nothing.
 * Answers whether the member is an owner or admin.
 */
async function lockStanding(tx: Tx, input: OrganizationReadInput) {
  const [organization] = await tx
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
  const [membership] = organization
    ? await tx
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, input.organizationId),
            eq(organizationMembers.userId, input.memberUserId),
            eq(organizationMembers.status, "active"),
          ),
        )
        .for("share")
        .limit(1)
    : [];
  if (!membership) {
    throw new DomainError("forbidden", "Organization access is denied");
  }
  return {
    organizationManager:
      membership.role === "owner" || membership.role === "admin",
  };
}

/**
 * Each project of the organisation, whatever its status: its `id`, `status`
 * and `canRepresent`, ordered by id, in the caller's transaction. A
 * credential bound to a project is answered about that project alone.
 *
 * `canRepresent` is the page read's: true for an owner or admin, and
 * otherwise exactly when the member's own project membership is active.
 */
export async function listAdministrationProjects(
  tx: Tx,
  input: OrganizationReadInput,
) {
  const { organizationManager } = await lockStanding(tx, input);
  const rows = await tx
    .select({
      id: projects.id,
      status: projects.status,
      membershipId: projectMembers.id,
    })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.organizationId, projects.organizationId),
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.userId, input.memberUserId),
        eq(projectMembers.status, "active"),
      ),
    )
    .where(
      and(
        eq(projects.organizationId, input.organizationId),
        input.credentialProjectId === null
          ? undefined
          : eq(projects.id, input.credentialProjectId),
      ),
    )
    .orderBy(asc(projects.id));
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    canRepresent: organizationManager || row.membershipId !== null,
  }));
}

/**
 * Each active lane of the organisation: its `id` and `projectId`, ordered by
 * id, in the caller's transaction.
 *
 * `projectId`, from the query, narrows the list to that project. It is
 * `not_found` when it is not a UUID (checked before any query, since the
 * column would raise rather than match nothing), when it is not a project of
 * this organisation, or when the credential is bound to another project. A
 * credential bound to a project that names none is answered about its own
 * project's lanes.
 */
export async function listAdministrationLanes(
  tx: Tx,
  input: OrganizationReadInput & {
    /** From the query string, or null when absent. Not trusted to be a UUID. */
    projectId: string | null;
  },
) {
  if (
    input.projectId !== null &&
    (!uuidShape.test(input.projectId) ||
      (input.credentialProjectId !== null &&
        input.projectId !== input.credentialProjectId))
  ) {
    throw new DomainError("not_found", "Project was not found");
  }
  await lockStanding(tx, input);
  if (input.projectId !== null) {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, input.organizationId),
          eq(projects.id, input.projectId),
        ),
      )
      .limit(1);
    if (!project) throw new DomainError("not_found", "Project was not found");
  }
  const projectId = input.projectId ?? input.credentialProjectId;
  return tx
    .select({ id: lanes.id, projectId: lanes.projectId })
    .from(lanes)
    .where(
      and(
        eq(lanes.organizationId, input.organizationId),
        eq(lanes.status, "active"),
        projectId === null ? undefined : eq(lanes.projectId, projectId),
      ),
    )
    .orderBy(asc(lanes.id));
}

/**
 * Each active member of the organisation: `userId`, `role` and `version`,
 * ordered by user id, in the caller's transaction. Membership belongs to the
 * organisation, so a credential bound to a project is answered with every
 * member too.
 */
export async function listAdministrationMembers(
  tx: Tx,
  input: OrganizationReadInput,
) {
  await lockStanding(tx, input);
  return tx
    .select({
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      version: organizationMembers.version,
    })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, input.organizationId),
        eq(organizationMembers.status, "active"),
      ),
    )
    .orderBy(asc(organizationMembers.userId));
}
