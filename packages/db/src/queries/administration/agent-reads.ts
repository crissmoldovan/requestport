import {
  type AuthorizedCommandContext,
  DomainError,
  isOperatorContext,
  memberAuthority,
} from "@requestport/domain";
import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";

import { createAgentRepository } from "../../repositories/agent-repository.js";
import { createCommandAuthorizationRepository } from "../../repositories/command-authorization.js";
import {
  agentCredentials,
  agentOauthGrants,
  agentPrincipals,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
} from "../../schema/index.js";
import type { Tx } from "../../transaction.js";

/*
  `list_administration_agent_principals` and
  `get_administration_agent_principal` (Plan 13, F.2.2; `manifest-f2.md`
  §4.1): what suspending a principal, revoking a key and revoking a grant
  take their identifiers and expected versions from. Nothing else: no name of
  a principal, its software, a credential, a client or a person, and never a
  key's prefix, fingerprint or plaintext.

  The rule is suspension's: `agentRepository.canManage` on the principal's
  project, which `set_agent_principal_status` applies — an active owner or
  admin of the active organisation, or an active maintainer of the
  principal's active project. An organisation-wide principal (no project) is
  an owner's or admin's alone.

  That is narrower than the two revocations. Revoking a key asks `canManage`
  on the key's project, so a maintainer of P may revoke a key an
  organisation-wide principal holds in P; revoking a grant also admits the
  human who delegated it, with no project role. Both reads refuse those
  people the principal, so neither can discover the ids of a revocation it
  may perform.

  Every query here carries the organisation's predicate, with the value the
  caller hands in, so the tenant-scope sweep needs no ledger line for this
  file (§4.1, rule 9).
*/

const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface AgentReadInput {
  /** The member whose standing the read runs under: a person's user id. */
  memberUserId: string;
  /** The credential's organisation. */
  organizationId: string;
  /** The project the credential is bound to, or null when it is bound to none. */
  credentialProjectId: string | null;
}

/**
 * The member's standing in the organisation, as `canManage` reads it first:
 * the organisation row, active, and the member's organisation membership,
 * active, each locked `FOR SHARE`. Throws `forbidden` when either is missing,
 * so a revoked member and a suspended organisation read nothing.
 */
async function lockStanding(tx: Tx, input: AgentReadInput) {
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
    throw new DomainError("forbidden", "Agent management access is denied");
  }
  return {
    organizationManager:
      membership.role === "owner" || membership.role === "admin",
  };
}

/**
 * Each principal the member may manage: its `id`, `projectId`, `status` and
 * `version`, ordered by id, in the caller's transaction.
 *
 * An owner or admin sees every organisation-wide principal and every principal
 * of an active project. Anyone else sees the principals of the active projects
 * they actively maintain, and is refused `forbidden` when that is none. A
 * credential bound to a project narrows either to that project's principals;
 * then someone who neither manages the organisation nor maintains that
 * project is refused.
 *
 * Locks, besides `lockStanding`'s: for a member who is neither owner nor
 * admin, their maintainer rows and those projects' rows `FOR SHARE`. The
 * principals themselves are read without a lock, as the page read reads them.
 */
export async function listAdministrationAgentPrincipals(
  tx: Tx,
  input: AgentReadInput,
) {
  const { organizationManager } = await lockStanding(tx, input);
  let maintained: string[] | null = null;
  if (!organizationManager) {
    const rows = await tx
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, projectMembers.organizationId),
          eq(projects.id, projectMembers.projectId),
          eq(projects.status, "active"),
        ),
      )
      .where(
        and(
          eq(projectMembers.organizationId, input.organizationId),
          eq(projectMembers.userId, input.memberUserId),
          eq(projectMembers.status, "active"),
          eq(projectMembers.role, "maintainer"),
        ),
      )
      .for("share");
    maintained = rows
      .map((row) => row.projectId)
      .filter(
        (projectId) =>
          input.credentialProjectId === null ||
          projectId === input.credentialProjectId,
      );
    if (maintained.length === 0) {
      throw new DomainError("forbidden", "Agent management access is denied");
    }
  }
  const projectFilter =
    maintained !== null
      ? inArray(agentPrincipals.projectId, maintained)
      : input.credentialProjectId !== null
        ? and(
            eq(agentPrincipals.projectId, input.credentialProjectId),
            isNotNull(projects.id),
          )
        : or(isNull(agentPrincipals.projectId), isNotNull(projects.id));
  return tx
    .select({
      id: agentPrincipals.id,
      projectId: agentPrincipals.projectId,
      status: agentPrincipals.status,
      version: agentPrincipals.version,
    })
    .from(agentPrincipals)
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
        eq(agentPrincipals.organizationId, input.organizationId),
        projectFilter,
      ),
    )
    .orderBy(asc(agentPrincipals.id));
}

/**
 * One principal as the three writes need it, in the caller's transaction:
 * its `id`, `status` and `version`; per credential `id`, `version`,
 * `expiresAt` and `revokedAt`; per OAuth grant `id`, `status`, `version`,
 * `expiresAt` and `revokedAt`, each list ordered by id.
 *
 * Throws `not_found` before any query when the id is not a UUID. Throws
 * `forbidden` when the member has no active standing in the active
 * organisation (`lockStanding`), `not_found` when the principal is not in the
 * organisation or not in the project a bound credential names, and then
 * `forbidden` unless `canManage` admits the member for the principal's
 * project — the same call `set_agent_principal_status` makes. That call locks
 * the organisation and membership rows `FOR SHARE` again; for a principal in
 * a project, the project row `FOR SHARE`; and, when the member is neither
 * owner nor admin, their project membership row `FOR SHARE`.
 *
 * The two lists are read one after another, not at once: they share the
 * transaction's one client, and pg is withdrawing concurrent queries on a
 * single client (its deprecation warning names pg@9).
 */
export async function getAdministrationAgentPrincipal(
  tx: Tx,
  input: AgentReadInput & {
    /** The principal the path names. Not trusted to be a UUID. */
    agentPrincipalId: string;
  },
) {
  if (!uuidShape.test(input.agentPrincipalId)) {
    throw new DomainError("not_found", "Agent principal was not found");
  }
  await lockStanding(tx, input);
  const [principal] = await tx
    .select({
      id: agentPrincipals.id,
      projectId: agentPrincipals.projectId,
      status: agentPrincipals.status,
      version: agentPrincipals.version,
    })
    .from(agentPrincipals)
    .where(
      and(
        eq(agentPrincipals.organizationId, input.organizationId),
        eq(agentPrincipals.id, input.agentPrincipalId),
      ),
    )
    .limit(1);
  if (
    !principal ||
    (input.credentialProjectId !== null &&
      principal.projectId !== input.credentialProjectId)
  ) {
    throw new DomainError("not_found", "Agent principal was not found");
  }
  if (
    !(await createAgentRepository(tx).canManage({
      organizationId: input.organizationId,
      projectId: principal.projectId,
      actor: { type: "user", id: input.memberUserId },
    }))
  ) {
    throw new DomainError("forbidden", "Agent management access is denied");
  }
  const credentials = await tx
    .select({
      id: agentCredentials.id,
      version: agentCredentials.version,
      expiresAt: agentCredentials.expiresAt,
      revokedAt: agentCredentials.revokedAt,
    })
    .from(agentCredentials)
    .where(
      and(
        eq(agentCredentials.organizationId, input.organizationId),
        eq(agentCredentials.agentPrincipalId, principal.id),
      ),
    )
    .orderBy(asc(agentCredentials.id));
  const oauthGrants = await tx
    .select({
      id: agentOauthGrants.id,
      status: agentOauthGrants.status,
      version: agentOauthGrants.version,
      expiresAt: agentOauthGrants.expiresAt,
      revokedAt: agentOauthGrants.revokedAt,
    })
    .from(agentOauthGrants)
    .where(
      and(
        eq(agentOauthGrants.organizationId, input.organizationId),
        eq(agentOauthGrants.agentPrincipalId, principal.id),
      ),
    )
    .orderBy(asc(agentOauthGrants.id));
  return {
    id: principal.id,
    status: principal.status,
    version: principal.version,
    credentials,
    oauthGrants,
  };
}

/** What `/api/v1` hands an agent read it dispatches for an operator. */
export interface AgentReadForOperatorInput {
  context: AuthorizedCommandContext;
  /** The deployment's `REQUESTPORT_OPERATOR_CREDENTIALS`. */
  operatorCredentials: "enabled" | "disabled" | undefined;
}

/**
 * The operator re-check both reads below run first, in the caller's one
 * transaction (`manifest-f2.md` §4.1, rules 4 and 5): a context that is not an
 * operator's is refused `forbidden` before anything is read, since these
 * reads admit operators only (rule 2); then the bus's own `assertCurrent` —
 * the deployment's switch, F.3's `lockActiveOperatorAuthorization` under
 * share locks and the scopes' subset check — so nothing is read for a
 * switched-off deployment, a revoked or expired credential or key, a member no
 * longer active or a suspended organisation. Answers what the reads take:
 * the member `memberAuthority` names (never `context.actor.id`, which is
 * `operator:<lineage>`), the context's organisation, and its project or null.
 */
async function operatorReadInput(
  tx: Tx,
  input: AgentReadForOperatorInput,
): Promise<AgentReadInput> {
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
  return {
    memberUserId: member.userId,
    organizationId: context.organizationId,
    credentialProjectId: context.projectId ?? null,
  };
}

/**
 * `list_administration_agent_principals` as `/api/v1` answers it for an
 * operator credential (Plan 13, F.2.2's registry half): the re-check above,
 * then `listAdministrationAgentPrincipals` for that member, organisation and
 * project, in the same transaction.
 */
export async function readAgentPrincipalsForOperator(
  tx: Tx,
  input: AgentReadForOperatorInput,
) {
  return listAdministrationAgentPrincipals(
    tx,
    await operatorReadInput(tx, input),
  );
}

/**
 * `get_administration_agent_principal` as `/api/v1` answers it for an
 * operator credential: the re-check above, then
 * `getAdministrationAgentPrincipal` for the path's principal, in the same
 * transaction.
 */
export async function readAgentPrincipalForOperator(
  tx: Tx,
  input: AgentReadForOperatorInput & {
    /** The path's principal. Not trusted to be a UUID. */
    agentPrincipalId: string;
  },
) {
  return getAdministrationAgentPrincipal(tx, {
    ...(await operatorReadInput(tx, input)),
    agentPrincipalId: input.agentPrincipalId,
  });
}
