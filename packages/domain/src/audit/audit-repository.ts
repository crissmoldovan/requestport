import {
  isOperatorContext,
  operatorLineageId,
} from "../operators/operator-types.js";
import type { ActorRef } from "../shared/authorization.js";
import type { DomainEvent } from "../shared/command.js";
import type { CommandActor } from "../shared/context.js";
import { DomainError } from "../shared/errors.js";

export type OrganizationRole = "owner" | "admin" | "member";

export type OrganizationRecord = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended" | "archived";
};

export type MembershipRecord = {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  status: "active" | "revoked";
};

export type InvitationRecord = {
  id: string;
  organizationId: string;
  normalizedEmail: string;
  role: OrganizationRole;
  tokenHash: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  /** The lifetime the current token was issued with: expiry less issue time. */
  expiresInSeconds: number;
  version: number;
};

export type ProjectRecord = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  keyPrefix: string;
  description: string | null;
  status: "active" | "archived";
  version: number;
  heartbeatIntervalSeconds: number;
  leaseMultiplier: number;
  graceSeconds: number;
  requiredWorkspaceFields: string[];
};

export type ProjectRepositoryRecord = {
  id: string;
  organizationId: string;
  projectId: string;
  provider: "github";
  browseUrl: string;
  cloneUrl: string;
  repositorySlug: string;
  isDefault: boolean;
  status: "active" | "archived";
};

/**
 * Every audit action, as runtime values rather than a type-only union, so the
 * pairing map below can be proved total at runtime instead of only by
 * `satisfies`.
 */
export const auditActions = [
  "organization.created",
  "organization.bootstrap_requested",
  "organization.owner_bootstrapped",
  "organization.invitation_created",
  "organization.invitation_renewed",
  "project.created",
  // Personal appearance is global, so its audit row is the only durable record
  // of the write; it carries a null organization and never carries values.
  "appearance.personal_preferences_updated",
  "appearance.organization_defaults_updated",
] as const;

export const auditTargetTypes = [
  "organization",
  "invitation",
  "project",
  "user_appearance",
  "organization_appearance",
] as const;

export type AuditAction = (typeof auditActions)[number];
export type AuditTargetType = (typeof auditTargetTypes)[number];

/**
 * The one action → target pairing each audit action is allowed to use, so a
 * new action cannot silently be filed under an unrelated target type.
 */
export const auditActionTargets = {
  "organization.created": "organization",
  "organization.bootstrap_requested": "organization",
  "organization.owner_bootstrapped": "organization",
  "organization.invitation_created": "invitation",
  "organization.invitation_renewed": "invitation",
  "project.created": "project",
  "appearance.personal_preferences_updated": "user_appearance",
  "appearance.organization_defaults_updated": "organization_appearance",
} as const satisfies Record<AuditAction, AuditTargetType>;

/**
 * An operator credential, as an audit row records it: the `service` actor
 * `operator:<lineage>`, never the member it acts for (Plan 13, F.3, F3-2). The
 * member is one join away, through the credential row.
 */
export type AuditServiceActor = { type: "service"; id: string };

export type AuditRecordInput = {
  organizationId: string | null;
  actor: CommandActor | AuditServiceActor;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  reason: string;
  fieldNames: string[];
  correlationId: string;
};

export type AuditRecordRow = {
  organizationId: string | null;
  actorType: "user" | "system" | "service";
  actorId: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  reason: string;
  fieldNames: string[];
  correlationId: string;
};

/**
 * A validated audit row, for the writers that ask for one.
 *
 * `security_audit_records` is append-only, so an actor or an action → target
 * pairing that slips through can never be corrected: a row filed under the
 * wrong target makes the trail permanently unqueryable by target.
 *
 * This used to claim that every repository builds its insert from this
 * projection, so a second, weaker writer could not exist. It is not true and
 * was not when it was written: there are 31 direct `insert(securityAuditRecords)`
 * sites across the repositories and 2 of them come through here. The table
 * carries no action → target constraint either, so nothing below this function
 * enforces the pairing for the other 29.
 *
 * Written down rather than quietly fixed because routing the rest through here
 * is a real change to append-only writes, not a tidy-up, and a comment claiming
 * a guarantee the code does not give is worse than the gap itself — a reviewer
 * checking the thirtieth writer would have been told by this docstring that the
 * pairing was already unavoidable.
 */
export function auditRecordRow(input: AuditRecordInput): AuditRecordRow {
  if (input.actor.type === "unauthenticated") {
    throw new DomainError(
      "forbidden",
      "Unauthenticated audit actors are forbidden",
    );
  }
  if (
    input.actor.type === "service" &&
    operatorLineageId({ type: "service", id: input.actor.id }) === null
  ) {
    throw new DomainError(
      "forbidden",
      "Only an operator credential is recorded as a service actor",
    );
  }
  if (auditActionTargets[input.action] !== input.targetType) {
    throw new DomainError(
      "validation_failed",
      "Audit target does not match the recorded action",
    );
  }
  return {
    organizationId: input.organizationId,
    actorType: input.actor.type,
    actorId:
      input.actor.type === "user"
        ? input.actor.userId
        : input.actor.type === "service"
          ? input.actor.id
          : input.actor.system,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    fieldNames: [...input.fieldNames],
    correlationId: input.correlationId,
  };
}

/**
 * The actor an audit row written through `auditRecordRow` records for a
 * tenant command's context: a person as `user` and their id, and an operator
 * credential as the `service` actor `operator:<lineage>`, never its member
 * (Plan 13, F.3, F3-2). Throws `forbidden` for every other actor, and for a
 * context that claims to be an operator's without an operator's shape.
 */
export function auditRecordActor(context: {
  actor: ActorRef;
  credentialKind?: unknown;
}): CommandActor | AuditServiceActor {
  if (context.actor.type === "user")
    return { type: "user", userId: context.actor.id };
  if (isOperatorContext(context))
    return { type: "service", id: context.actor.id };
  throw new DomainError(
    "forbidden",
    "Only a person or an operator credential is recorded here",
  );
}

export interface AuditRepository {
  appendAuditRecord(input: AuditRecordInput): Promise<void>;
  appendDomainEvent(event: DomainEvent): Promise<void>;
}

export interface FoundationTransaction extends AuditRepository {
  createOrganization(input: {
    name: string;
    slug: string;
  }): Promise<OrganizationRecord>;
  lockBootstrapSlug(slug: string): Promise<void>;
  findOrganizationBySlugForUpdate(
    slug: string,
  ): Promise<OrganizationRecord | null>;
  createOrganizationMembership(input: {
    organizationId: string;
    userId: string;
    role: OrganizationRole;
  }): Promise<MembershipRecord>;
  /**
   * Locks the organization first and then the exact tenant/user membership.
   * All authorization commands use this order to avoid deadlocks and stale
   * authorization decisions while still allowing concurrent safe readers.
   */
  findOrganizationAuthorization(
    organizationId: string,
    userId: string,
  ): Promise<{
    organization: OrganizationRecord | null;
    membership: MembershipRecord | null;
  }>;
  findActiveOrganizationOwners(
    organizationId: string,
  ): Promise<MembershipRecord[]>;
  activateOwnerMembership(input: {
    organizationId: string;
    userId: string;
  }): Promise<{ membership: MembershipRecord; changed: boolean }>;
  findUserByNormalizedEmail(
    normalizedEmail: string,
  ): Promise<{ id: string; normalizedEmail: string } | null>;
  ensureActiveAllowlist(normalizedEmail: string): Promise<{ changed: boolean }>;
  /**
   * The organisation's one invitation for the address, in whatever state,
   * locked for update. `active` is pending: neither accepted nor revoked, and
   * unexpired by database time.
   */
  findInvitation(
    organizationId: string,
    normalizedEmail: string,
  ): Promise<(InvitationRecord & { active: boolean }) | null>;
  /**
   * The active membership in the organisation of the person who signed up
   * with the address, if there is one.
   */
  findActiveMembershipByEmail(
    organizationId: string,
    normalizedEmail: string,
  ): Promise<MembershipRecord | null>;
  lockInvitation(
    organizationId: string,
    normalizedEmail: string,
  ): Promise<void>;
  createInvitation(input: {
    organizationId: string;
    normalizedEmail: string;
    role: OrganizationRole;
    tokenHash: string;
    expiresInSeconds: number;
    createdByUserId: string;
  }): Promise<InvitationRecord>;
  /**
   * Re-issues an invitation that is no longer pending — accepted, revoked or
   * expired — as a pending one: a new token hash, a new expiry from database
   * time, the given role and inviter, and version + 1. Refuses, with
   * `version_conflict`, a row that is pending or no longer at
   * `expectedVersion`.
   */
  renewInvitation(input: {
    organizationId: string;
    invitationId: string;
    expectedVersion: number;
    role: OrganizationRole;
    tokenHash: string;
    expiresInSeconds: number;
    createdByUserId: string;
  }): Promise<InvitationRecord>;
  createProject(input: {
    organizationId: string;
    name: string;
    slug: string;
    keyPrefix: string;
    description: string | null;
  }): Promise<ProjectRecord>;
  createProjectRepository(input: {
    organizationId: string;
    projectId: string;
    browseUrl: string;
    cloneUrl: string;
    repositorySlug: string;
  }): Promise<ProjectRepositoryRecord>;
}

export interface FoundationRepository {
  transaction<T>(run: (tx: FoundationTransaction) => Promise<T>): Promise<T>;
}
