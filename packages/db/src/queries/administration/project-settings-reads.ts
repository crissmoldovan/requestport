import {
  type AuthorizedCommandContext,
  DomainError,
  isOperatorContext,
  memberAuthority,
} from "@requestport/domain";
import { and, asc, eq } from "drizzle-orm";

import { createCommandAuthorizationRepository } from "../../repositories/command-authorization.js";

import {
  lanes,
  projectMembers,
  projectRepositories,
  projects,
} from "../../schema/index.js";
import type { Tx } from "../../transaction.js";
import { requireProjectManagement } from "../project-settings-repository.js";

/*
  `get_administration_project_settings` (Plan 13, F.2.3; `manifest-f2.md`
  §4.1): what the eleven project settings writes take their identifiers and
  their expected version from, and the current values of the fields two of
  them resend whole — the project's name and description, and its work
  policy. Nothing else: no slug, key prefix, alias, URL, name of a person or
  email.

  Every query here carries the organisation's predicate, with the value the
  caller hands in, so the tenant-scope sweep needs no ledger line for this
  file (§4.1, rule 9).
*/

const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ProjectSettingsReadInput {
  /** The member whose standing the read runs under: a person's user id. */
  memberUserId: string;
  /** The credential's organisation. */
  organizationId: string;
  /** The project the path names. Not trusted to be a UUID. */
  projectId: string;
  /** The project the credential is bound to, or null when it is bound to none. */
  credentialProjectId: string | null;
}

/**
 * The project's settings as the writes need them, in the caller's
 * transaction.
 *
 * Throws `not_found` when the path's project is not a UUID, is not the
 * project a project-bound credential is bound to, or is not in the
 * organisation — before any query in the first two cases, so a malformed id
 * never reaches PostgreSQL. Throws `forbidden` unless the member may manage
 * the project, by the rule every one of the writes applies: an active owner or
 * admin of the active organisation, or an active maintainer of the project.
 * It locks the organisation row and the organisation membership row
 * `FOR SHARE`, as the writes do; the project membership row `FOR SHARE` only
 * when the member is neither owner nor admin (it is not read otherwise), as
 * the writes do; and the project row `FOR SHARE`, where the writes take it
 * `FOR UPDATE`.
 *
 * The three lists are read one after another, not at once: they share the
 * transaction's one client, and pg is withdrawing concurrent queries on a
 * single client (its deprecation warning names pg@9).
 */
export async function getAdministrationProjectSettings(
  tx: Tx,
  input: ProjectSettingsReadInput,
) {
  if (
    !uuidShape.test(input.projectId) ||
    (input.credentialProjectId !== null &&
      input.credentialProjectId !== input.projectId)
  ) {
    throw new DomainError("not_found", "Project was not found");
  }
  await requireProjectManagement(
    tx,
    {
      userId: input.memberUserId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    },
    "share",
  );
  const [project] = await tx
    .select({
      id: projects.id,
      version: projects.version,
      status: projects.status,
      defaultLaneId: projects.defaultLaneId,
      name: projects.name,
      description: projects.description,
      heartbeatIntervalSeconds: projects.heartbeatIntervalSeconds,
      leaseMultiplier: projects.leaseMultiplier,
      graceSeconds: projects.graceSeconds,
      requiredWorkspaceFields: projects.requiredWorkspaceFields,
    })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, input.organizationId),
        eq(projects.id, input.projectId),
      ),
    )
    .limit(1);
  if (!project) throw new DomainError("not_found", "Project was not found");
  const repositories = await tx
    .select({
      id: projectRepositories.id,
      isDefault: projectRepositories.isDefault,
      status: projectRepositories.status,
    })
    .from(projectRepositories)
    .where(
      and(
        eq(projectRepositories.organizationId, input.organizationId),
        eq(projectRepositories.projectId, input.projectId),
      ),
    )
    .orderBy(asc(projectRepositories.id));
  const laneRows = await tx
    .select({ id: lanes.id, status: lanes.status })
    .from(lanes)
    .where(
      and(
        eq(lanes.organizationId, input.organizationId),
        eq(lanes.projectId, input.projectId),
      ),
    )
    .orderBy(asc(lanes.id));
  const members = await tx
    .select({
      userId: projectMembers.userId,
      role: projectMembers.role,
      status: projectMembers.status,
    })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, input.organizationId),
        eq(projectMembers.projectId, input.projectId),
      ),
    )
    .orderBy(asc(projectMembers.userId));
  return { ...project, repositories, lanes: laneRows, members };
}

/**
 * `get_administration_project_settings` as `/api/v1` answers it for an
 * operator credential, in the caller's one transaction (`manifest-f2.md`
 * §4.1, rules 4 and 5): first the bus's own `assertCurrent` on the context —
 * the deployment's operator switch, then F.3's
 * `lockActiveOperatorAuthorization` under share locks and the scopes'
 * subset check — so nothing is read for a switched-off deployment, a revoked
 * or expired credential or key, a member no longer active or a suspended
 * organisation. Then the projection above, for the member `memberAuthority`
 * names (never `context.actor.id`, which is `operator:<lineage>`), in the
 * context's organisation, bound to the context's project when it has one.
 *
 * A context that is not an operator's is refused `forbidden` before anything
 * is read: this read admits operators only (§4.1, rule 2).
 */
export async function readProjectSettingsForOperator(
  tx: Tx,
  input: {
    context: AuthorizedCommandContext;
    /** The path's project. Not trusted to be a UUID. */
    projectId: string;
    /** The deployment's `REQUESTPORT_OPERATOR_CREDENTIALS`. */
    operatorCredentials: "enabled" | "disabled" | undefined;
  },
) {
  const { context } = input;
  const member = memberAuthority(context);
  if (!isOperatorContext(context) || member?.via !== "operator") {
    throw new DomainError(
      "forbidden",
      "This read admits an operator credential only",
    );
  }
  await createCommandAuthorizationRepository(tx, {
    operatorCredentials: input.operatorCredentials,
  }).assertCurrent(context);
  return getAdministrationProjectSettings(tx, {
    memberUserId: member.userId,
    organizationId: context.organizationId,
    projectId: input.projectId,
    credentialProjectId: context.projectId ?? null,
  });
}
