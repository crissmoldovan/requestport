import {
  type AuthorizedCommandContext,
  DomainError,
  isOperatorContext,
  memberAuthority,
} from "@requestport/domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { createAppearanceRepository } from "../../repositories/appearance-repository.js";
import { createCommandAuthorizationRepository } from "../../repositories/command-authorization.js";
import { requireOrganizationAdministrator } from "../../repositories/organization-management-repository.js";
import {
  invitations,
  organizationAppearanceDefaults,
} from "../../schema/index.js";
import type { Tx } from "../../transaction.js";

/*
  The administrative reads of organisation membership and appearance (Plan 13,
  F.2.7; `manifest-f2.md` §4.1):

  - `list_administration_invitations`: what revoking an invitation takes its
    identifier and its expected version from, and each invitation's role,
    because an owner invitation needs an owner to revoke it. No address and no
    expiry.
  - `get_administration_organization_appearance`: the version the
    organisation appearance write expects, and the current value of the three
    fields it replaces whole.

  Setting a member takes its identifiers from F.2.0's members read, and
  inviting needs no read.

  Both are organisation-bound (§4.1, rule 7). Every query here carries the
  organisation's predicate, with the value the caller hands in, so the
  tenant-scope sweep needs no ledger line for this file (§4.1, rule 9).

  `/api/v1` answers them for an operator credential only, through
  `readInvitationsForOperator` and `readOrganizationAppearanceForOperator` at
  the end of this file, which re-check the credential in the read's
  transaction before handing the read its member.
*/

export interface MemberReadInput {
  /** The member whose standing the read runs under: a person's user id. */
  memberUserId: string;
  /** The credential's organisation. */
  organizationId: string;
  /** The project the credential is bound to, or null when it is bound to none. */
  credentialProjectId: string | null;
}

function requireOrganizationBinding(input: MemberReadInput, what: string) {
  if (input.credentialProjectId !== null) {
    throw new DomainError(
      "forbidden",
      `${what} are read with a credential bound to no project`,
    );
  }
}

/**
 * The organisation's pending invitations — neither accepted, revoked nor
 * expired, as the members page lists them — in the caller's transaction,
 * ordered by id.
 *
 * Throws `forbidden`, before any query, for a credential bound to a project.
 * Throws `forbidden` unless the member is an active owner or admin of the
 * active organisation: `requireOrganizationAdministrator`, the check the
 * revocation runs, taking the organisation and membership rows `FOR SHARE`,
 * as the revocation does. A member id that
 * is not a person's (an operator's actor id) matches no membership row and is
 * refused the same way; the membership's user id is text, so nothing is
 * raised.
 */
export async function listAdministrationInvitations(
  tx: Tx,
  input: MemberReadInput,
) {
  requireOrganizationBinding(input, "Invitations");
  await requireOrganizationAdministrator(tx, {
    organizationId: input.organizationId,
    userId: input.memberUserId,
  });
  return tx
    .select({
      id: invitations.id,
      role: invitations.role,
      version: invitations.version,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, input.organizationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        sql`${invitations.expiresAt} > clock_timestamp()`,
      ),
    )
    .orderBy(asc(invitations.id));
}

/**
 * The organisation's appearance defaults: `version`, `theme`, `density` and
 * `mode`.
 *
 * Throws `forbidden`, before any query, for a credential bound to a project.
 * Throws `forbidden` unless the member is an active owner — not an admin — of
 * the active organisation, the write's rule, checked on the rows the write
 * reads, taken `FOR SHARE` by the same `lockOrganizationAuthorization`.
 * Throws `not_found` when the organisation has no defaults row.
 */
export async function getAdministrationOrganizationAppearance(
  tx: Tx,
  input: MemberReadInput,
) {
  requireOrganizationBinding(input, "Organization appearance defaults");
  const authorization = await createAppearanceRepository(
    tx,
  ).lockOrganizationAuthorization({
    organizationId: input.organizationId,
    userId: input.memberUserId,
  });
  if (
    authorization.organization?.status !== "active" ||
    authorization.membership?.status !== "active" ||
    authorization.membership.role !== "owner"
  ) {
    throw new DomainError(
      "forbidden",
      "Organization appearance ownership is required",
    );
  }
  const [row] = await tx
    .select({
      version: organizationAppearanceDefaults.version,
      theme: organizationAppearanceDefaults.theme,
      density: organizationAppearanceDefaults.density,
      mode: organizationAppearanceDefaults.mode,
    })
    .from(organizationAppearanceDefaults)
    .where(
      eq(organizationAppearanceDefaults.organizationId, input.organizationId),
    )
    .limit(1);
  if (!row) {
    throw new DomainError(
      "not_found",
      "Organization appearance defaults are not initialized",
    );
  }
  return row;
}

/** What `/api/v1` hands each of the two reads below. */
export interface MemberReadForOperatorInput {
  context: AuthorizedCommandContext;
  /** The deployment's `REQUESTPORT_OPERATOR_CREDENTIALS`. */
  operatorCredentials: "enabled" | "disabled" | undefined;
}

/**
 * The operator's re-check, in the caller's one transaction (`manifest-f2.md`
 * §4.1, rules 4 and 5): the bus's own `assertCurrent` on the context — the
 * deployment's operator switch, then F.3's `lockActiveOperatorAuthorization`
 * under share locks and the scopes' subset check — so nothing is read for a
 * switched-off deployment, a revoked or expired credential or key, a member
 * no longer active or a suspended organisation. Answers what the reads are
 * handed: the member `memberAuthority` names (never `context.actor.id`, which
 * is `operator:<lineage>`), the context's organisation, and its project.
 *
 * A context that is not an operator's is refused `forbidden` before anything
 * is read: these reads admit operators only (§4.1, rule 2).
 */
async function operatorReadInput(
  tx: Tx,
  input: MemberReadForOperatorInput,
): Promise<MemberReadInput> {
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
 * `list_administration_invitations` as `/api/v1` answers it for an operator
 * credential: the operator's re-check, then `listAdministrationInvitations`
 * for its member, in the caller's one transaction.
 */
export async function readInvitationsForOperator(
  tx: Tx,
  input: MemberReadForOperatorInput,
) {
  return listAdministrationInvitations(tx, await operatorReadInput(tx, input));
}

/**
 * `get_administration_organization_appearance` as `/api/v1` answers it for an
 * operator credential: the operator's re-check, then
 * `getAdministrationOrganizationAppearance` for its member, in the caller's
 * one transaction.
 */
export async function readOrganizationAppearanceForOperator(
  tx: Tx,
  input: MemberReadForOperatorInput,
) {
  return getAdministrationOrganizationAppearance(
    tx,
    await operatorReadInput(tx, input),
  );
}
