import { createHash, randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";

import type {
  AuditRecordInput,
  FoundationRepository,
  FoundationTransaction,
  InvitationRecord,
  OrganizationRole,
} from "../audit/audit-repository.js";
import { redactSensitiveText } from "../security/sensitive-content.js";
import {
  type CommandContext,
  validateCommandContext,
} from "../shared/context.js";
import { DomainError } from "../shared/errors.js";
import {
  normalizeEmail,
  normalizeName,
  normalizeSlug,
  validateUuid,
  validationError,
} from "../shared/validation.js";
import {
  generateLocalCredential,
  hashLocalCredential,
} from "./local-credential.js";

export * from "./local-credential.js";

export const BOOTSTRAP_OWNER_ACTOR = {
  type: "system" as const,
  system: "bootstrap-owner-cli" as const,
};

const DEFAULT_INVITATION_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
const MIN_INVITATION_EXPIRY_SECONDS = 60;
const MAX_INVITATION_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

function requireInputRecord(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("input", "Command input is invalid");
  }
  return input as Record<string, unknown>;
}

function requireUser(context: CommandContext) {
  validateCommandContext(context);
  if (context.actor.type === "unauthenticated") {
    throw new DomainError("unauthenticated", "Authentication is required");
  }
  if (context.actor.type !== "user") {
    throw new DomainError("forbidden", "A human user is required");
  }
  return context.actor;
}

/** A fresh invitation token hash: 32 random bytes, hashed with SHA-256. */
export function defaultInvitationTokenHash() {
  return createHash("sha256").update(randomBytes(32)).digest("hex");
}

const renewalReasons = {
  revoked: "Organization invitation renewed after it was revoked",
  expired: "Organization invitation renewed after it expired",
  accepted: "Organization invitation renewed after its member's access ended",
} as const;

function invitationProjection(invitation: InvitationRecord) {
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    normalizedEmail: invitation.normalizedEmail,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
  };
}

/**
 * The event an invitation's creation or renewal records, and whose outbox row
 * sends its email.
 */
export const organizationInvitationCreatedEvent =
  "organization.invitation_created.v1";

/**
 * An invitation's input, validated and normalised: the one reading of it that
 * `OrganizationService.inviteUser` and the `invite_organization_member` command
 * (`organization-administration-commands.ts`) share.
 */
export type OrganizationInvitationInput = {
  organizationId: string;
  normalizedEmail: string;
  role: OrganizationRole;
  expiresInSeconds: number;
};

/**
 * Validates an invitation's input and normalises its email. Throws
 * `validation_failed` naming the field: `input`, `organizationId`, `email`,
 * `role` or `expiresInSeconds`. The expiry defaults to seven days and must lie
 * between 60 seconds and 30 days.
 */
export function parseOrganizationInvitationInput(
  input: unknown,
): OrganizationInvitationInput {
  const values = requireInputRecord(input);
  const organizationId = validateUuid(values.organizationId, "organizationId");
  const normalizedEmail = normalizeEmail(values.email);
  const role = values.role;
  if (role !== "owner" && role !== "admin" && role !== "member") {
    throw validationError("role", "Invitation role is invalid");
  }
  const expiresInSeconds =
    values.expiresInSeconds ?? DEFAULT_INVITATION_EXPIRY_SECONDS;
  if (
    typeof expiresInSeconds !== "number" ||
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < MIN_INVITATION_EXPIRY_SECONDS ||
    expiresInSeconds > MAX_INVITATION_EXPIRY_SECONDS
  ) {
    throw validationError(
      "expiresInSeconds",
      "Invitation expiry must be between 60 seconds and 30 days",
    );
  }
  return { organizationId, normalizedEmail, role, expiresInSeconds };
}

/**
 * Throws `forbidden` unless the organisation is active and `userId` is an
 * active owner or admin of it, and, for an owner invitation, an owner. The
 * organisation row and then the membership row are read `FOR SHARE`
 * (`findOrganizationAuthorization`), in that order.
 */
export async function requireInvitationAuthority(
  tx: Pick<FoundationTransaction, "findOrganizationAuthorization">,
  input: { organizationId: string; userId: string; role: OrganizationRole },
) {
  const { organization, membership } = await tx.findOrganizationAuthorization(
    input.organizationId,
    input.userId,
  );
  if (organization?.status !== "active") {
    throw new DomainError("forbidden", "An active organization is required");
  }
  if (
    membership?.status !== "active" ||
    !(["owner", "admin"] as string[]).includes(membership.role)
  ) {
    throw new DomainError(
      "forbidden",
      "Organization administration is required",
    );
  }
  if (input.role === "owner" && membership.role !== "owner") {
    throw new DomainError(
      "forbidden",
      "Only an owner may invite another owner",
    );
  }
}

/** What an invitation that is no longer pending was before it was renewed. */
export type InvitationRenewedFrom = "revoked" | "expired" | "accepted";

/**
 * What `createOrganizationInvitation` did: answered the pending invitation
 * unchanged (`created: false`), created one, or renewed the address's row.
 * `created` is true for a renewal too: to the inviter, and to the email, it is
 * a newly issued invitation.
 */
export type OrganizationInvitationOutcome =
  | { invitation: InvitationRecord; created: false; outcome: "unchanged" }
  | { invitation: InvitationRecord; created: true; outcome: "created" }
  | {
      invitation: InvitationRecord;
      created: true;
      outcome: "renewed";
      renewedFrom: InvitationRenewedFrom;
    };

/**
 * Creates or renews the organisation's invitation for the address, with its
 * audit row, or answers the pending one. The one set of invitation rules that
 * `OrganizationService.inviteUser` and the `invite_organization_member` command
 * (`organization-administration-commands.ts`, the members form's path) share.
 *
 * Under the invitation's advisory lock and its row locked `FOR UPDATE`
 * (`findInvitation`), in this order:
 *
 * 1. A pending invitation with the same role and lifetime is answered
 *    `unchanged`, writing nothing; any other request for a pending address is
 *    `conflict` on `email`, reason `already_invited`.
 * 2. An address whose person is an active member of the organisation is
 *    `conflict` on `email`, reason `already_member`.
 * 3. An address that already has a `"user"` row is `conflict` on `email`,
 *    reason `existing_account`: only the signup trigger accepts an invitation,
 *    so one made for an existing account would never be accepted.
 * 4. Otherwise a missing row is created (`organization.invitation_created`),
 *    and a revoked, expired or accepted one is renewed
 *    (`organization.invitation_renewed`; `renewInvitation` also suppresses the
 *    email intents its earlier issue still has scheduled).
 *
 * A refusal writes nothing. Writes no event: each caller records
 * `organization.invitation_created.v1` its own way, at the invitation's
 * version, with `invitationCreatedEventData`.
 *
 * `userId` is the member whose authority the invitation is created or renewed
 * under, and is recorded as its creator (`createdByUserId`); `actor` is who
 * acted, and is what both audit rows, `organization.invitation_created` and
 * `organization.invitation_renewed`, record — the same person, or an operator
 * credential as the service it is (Plan 13, F.2.7).
 */
export async function createOrganizationInvitation(
  tx: Pick<
    FoundationTransaction,
    | "lockInvitation"
    | "findInvitation"
    | "findActiveMembershipByEmail"
    | "findUserByNormalizedEmail"
    | "createInvitation"
    | "renewInvitation"
    | "appendAuditRecord"
  >,
  input: OrganizationInvitationInput & {
    userId: string;
    actor: AuditRecordInput["actor"];
    correlationId: string;
    tokenHash: () => string;
  },
): Promise<OrganizationInvitationOutcome> {
  const { organizationId, normalizedEmail, role, expiresInSeconds, actor } =
    input;

  await tx.lockInvitation(organizationId, normalizedEmail);
  const existing = await tx.findInvitation(organizationId, normalizedEmail);
  if (existing?.active) {
    // A request matching the pending invitation exactly — a retry of the one
    // that issued it, typically — is answered with it, unchanged.
    if (
      existing.role === role &&
      existing.expiresInSeconds === expiresInSeconds
    ) {
      return { invitation: existing, created: false, outcome: "unchanged" };
    }
    throw new DomainError(
      "conflict",
      "The address already has a pending invitation",
      { field: "email", reason: "already_invited" },
    );
  }

  // No pending invitation: one is about to be created, or the address's row
  // renewed. Neither is made for an address whose person is an active member,
  // or for one that already has an account.
  const member = await tx.findActiveMembershipByEmail(
    organizationId,
    normalizedEmail,
  );
  if (member) {
    throw new DomainError(
      "conflict",
      "The address already belongs to an active member",
      { field: "email", reason: "already_member" },
    );
  }
  // Only the signup trigger accepts an invitation (migration 0005), and it runs
  // when the person's "user" row is inserted; nothing accepts one on sign-in.
  // For an address that already has that row — a removed member, or someone
  // who signed up through another organisation — an invitation would be
  // reported as sent and never accepted, so it is refused before anything is
  // written, whether it would be created or renewed.
  const account = await tx.findUserByNormalizedEmail(normalizedEmail);
  if (account) {
    throw new DomainError(
      "conflict",
      "The address already has a RequestPort account",
      { field: "email", reason: "existing_account" },
    );
  }

  if (existing) {
    // One row per address and organisation, so an invitation that is no
    // longer pending is renewed rather than created beside it.
    const renewedFrom: InvitationRenewedFrom = existing.revokedAt
      ? "revoked"
      : existing.acceptedAt
        ? "accepted"
        : "expired";
    const invitation = await tx.renewInvitation({
      organizationId,
      invitationId: existing.id,
      expectedVersion: existing.version,
      role,
      tokenHash: input.tokenHash(),
      expiresInSeconds,
      createdByUserId: input.userId,
    });
    await tx.appendAuditRecord({
      organizationId,
      actor,
      action: "organization.invitation_renewed",
      targetType: "invitation",
      targetId: invitation.id,
      reason: renewalReasons[renewedFrom],
      fieldNames: [
        "role",
        "expiresAt",
        "tokenHash",
        "createdByUserId",
        "acceptedAt",
        "revokedAt",
      ],
      correlationId: input.correlationId,
    });
    return { invitation, created: true, outcome: "renewed", renewedFrom };
  }

  const invitation = await tx.createInvitation({
    organizationId,
    normalizedEmail,
    role,
    tokenHash: input.tokenHash(),
    expiresInSeconds,
    createdByUserId: input.userId,
  });
  await tx.appendAuditRecord({
    organizationId,
    actor,
    action: "organization.invitation_created",
    targetType: "invitation",
    targetId: invitation.id,
    reason: "Organization invitation created",
    fieldNames: ["normalizedEmail", "role", "expiresAt"],
    correlationId: input.correlationId,
  });
  return { invitation, created: true, outcome: "created" };
}

/**
 * The payload of `organization.invitation_created.v1`: no address, no token.
 * A renewal is evented as this type too, because the invitation email and
 * every worker already deployed send for it and dead-letter a type they do not
 * know; `renewedFrom`, present only on a renewal, is what marks one.
 */
export function invitationCreatedEventData(
  invitation: InvitationRecord,
  renewedFrom?: InvitationRenewedFrom,
) {
  return {
    invitationId: invitation.id,
    role: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
    ...(renewedFrom ? { renewedFrom } : {}),
  };
}

export class OrganizationService {
  private readonly repository: FoundationRepository;
  private readonly invitationTokenHash: () => string;

  constructor({
    repository,
    invitationTokenHash = defaultInvitationTokenHash,
  }: {
    repository: FoundationRepository;
    invitationTokenHash?: () => string;
  }) {
    this.repository = repository;
    this.invitationTokenHash = invitationTokenHash;
  }

  async create(context: CommandContext, input: { name: string; slug: string }) {
    const actor = requireUser(context);
    const values = requireInputRecord(input);
    const name = normalizeName(values.name);
    const slug = normalizeSlug(values.slug);

    return this.repository.transaction(async (tx) => {
      const organization = await tx.createOrganization({ name, slug });
      await tx.createOrganizationMembership({
        organizationId: organization.id,
        userId: actor.userId,
        role: "owner",
      });
      await tx.appendAuditRecord({
        organizationId: organization.id,
        actor,
        action: "organization.created",
        targetType: "organization",
        targetId: organization.id,
        reason: "Organization created",
        fieldNames: ["name", "slug"],
        correlationId: context.correlationId,
      });
      await tx.appendDomainEvent({
        id: uuidv7(),
        type: "organization.created.v1",
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        organizationId: organization.id,
        aggregateType: "organization",
        aggregateId: organization.id,
        aggregateVersion: 1,
        actor: { type: "user", id: actor.userId },
        correlationId: context.correlationId,
        causationId: context.correlationId,
        data: {
          organizationId: organization.id,
          name: redactSensitiveText(organization.name),
          slug: organization.slug,
          status: organization.status,
        },
        links: {},
      });
      return organization;
    });
  }

  async inviteUser(
    context: CommandContext,
    input: {
      organizationId: string;
      email: string;
      role: OrganizationRole;
      expiresInSeconds?: number;
    },
  ) {
    const actor = requireUser(context);
    const invitationInput = parseOrganizationInvitationInput(input);

    return this.repository.transaction(async (tx) => {
      await requireInvitationAuthority(tx, {
        organizationId: invitationInput.organizationId,
        userId: actor.userId,
        role: invitationInput.role,
      });
      const result = await createOrganizationInvitation(tx, {
        ...invitationInput,
        userId: actor.userId,
        actor,
        correlationId: context.correlationId,
        tokenHash: this.invitationTokenHash,
      });
      const invitation = invitationProjection(result.invitation);
      if (result.outcome === "unchanged") {
        return { invitation, created: false as const, outcome: result.outcome };
      }
      const renewedFrom =
        result.outcome === "renewed" ? result.renewedFrom : undefined;
      await tx.appendDomainEvent({
        id: uuidv7(),
        type: organizationInvitationCreatedEvent,
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        organizationId: invitationInput.organizationId,
        aggregateType: "invitation",
        aggregateId: result.invitation.id,
        aggregateVersion: result.invitation.version,
        actor: { type: "user", id: actor.userId },
        correlationId: context.correlationId,
        causationId: context.correlationId,
        data: invitationCreatedEventData(result.invitation, renewedFrom),
        links: {},
      });
      return renewedFrom
        ? {
            invitation,
            created: true as const,
            outcome: "renewed" as const,
            renewedFrom,
          }
        : { invitation, created: true as const, outcome: "created" as const };
    });
  }
}

export type BootstrapOwnerInput = {
  email: string;
  organizationSlug: string;
  organizationName: string;
  /**
   * Absent: the original two-stage bootstrap — allowlist the address, wait for
   * the person to sign in through GitHub or a magic link, then run again.
   *
   * `"issue"`: finish in one run with no external provider. Create the person
   * if they do not exist, give them a local credential if they have none, and
   * make them the owner. A retry changes nothing, so it can never lock out an
   * owner whose credential was already handed over. It also gives a
   * credential to someone who is already an active owner, however many other
   * owners there are; it refuses only to make a new owner beside another.
   *
   * `"rotate"`: replace an active owner's local credential, end every
   * session they hold, and revoke every operator credential they issued, in
   * every organisation (Plan 13, F3-13): a rotation is a suspicion of
   * compromise, and a credential minted with the old one must not outlive it.
   * All in one transaction. Needs no old credential, so it is also how a lost
   * one is recovered — by whoever can run operator commands against the
   * database. It works for any active owner, not only the first, and refuses
   * anyone who is not one: it never makes an owner.
   */
  localCredential?: "issue" | "rotate";
};

type BootstrapOwnerIdentity = {
  organizationId: string;
  organizationSlug: string;
  normalizedEmail: string;
};

export type BootstrapOwnerResult =
  | ({ status: "awaiting_authentication" } & BootstrapOwnerIdentity)
  | ({
      status: "owner_active";
      userId: string;
      /** Present only when the command was asked about a local credential. */
      localCredential?: "issued" | "rotated" | "unchanged";
      /**
       * The credential itself, only when one was issued or rotated. Shown
       * once: only its hash is stored.
       */
      credential?: string;
    } & BootstrapOwnerIdentity);

/**
 * What a local credential needs from storage beyond the foundation's own
 * operations: all of it in the bootstrap's transaction, so the person, their
 * credential and their ownership are created together or not at all.
 */
export interface BootstrapOwnerTransaction extends FoundationTransaction {
  /** Creates the person. The address must already be allowlisted. */
  createLocalUser(input: {
    normalizedEmail: string;
    name: string;
  }): Promise<{ id: string; normalizedEmail: string }>;
  hasLocalCredential(userId: string): Promise<boolean>;
  /** Writes the credential's hash, replacing any the person already had. */
  setLocalCredential(input: {
    userId: string;
    credentialHash: string;
  }): Promise<void>;
  /** Ends every session the person holds; answers how many there were. */
  revokeUserSessions(userId: string): Promise<number>;
  /**
   * Revokes every operator credential the person issued, in every
   * organisation, recording each in its own organisation as `actor`; answers
   * how many it revoked (Plan 13, F3-13). Before operator credentials'
   * migration is applied there are none, and it revokes nothing.
   */
  revokeOperatorCredentialsIssuedBy(input: {
    userId: string;
    actor: typeof BOOTSTRAP_OWNER_ACTOR;
    correlationId: string;
  }): Promise<number>;
}

export interface BootstrapOwnerRepository extends FoundationRepository {
  transaction<T>(
    run: (tx: BootstrapOwnerTransaction) => Promise<T>,
  ): Promise<T>;
}

const localCredentialTransactionMethods = [
  "createLocalUser",
  "hasLocalCredential",
  "setLocalCredential",
  "revokeUserSessions",
  "revokeOperatorCredentialsIssuedBy",
] as const;

function holdsLocalCredentials(
  tx: FoundationTransaction,
): tx is BootstrapOwnerTransaction {
  return localCredentialTransactionMethods.every(
    (method) =>
      typeof (tx as unknown as Record<string, unknown>)[method] === "function",
  );
}

function localCredentialMode(value: unknown) {
  if (value === undefined) return undefined;
  if (value === "issue" || value === "rotate") return value;
  throw new DomainError(
    "validation_failed",
    "Local credential mode is invalid",
    { field: "localCredential" },
  );
}

export async function bootstrapOwner(
  repository: FoundationRepository | BootstrapOwnerRepository,
  context: CommandContext,
  input: BootstrapOwnerInput,
): Promise<BootstrapOwnerResult> {
  validateCommandContext(context);
  if (
    context.actor.type !== "system" ||
    context.actor.system !== BOOTSTRAP_OWNER_ACTOR.system
  ) {
    throw new DomainError(
      "forbidden",
      "The bootstrap operator command is required",
    );
  }
  const values = requireInputRecord(input);
  const normalizedEmail = normalizeEmail(values.email);
  const organizationSlug = normalizeSlug(values.organizationSlug);
  const organizationName = normalizeName(values.organizationName);
  const mode = localCredentialMode(values.localCredential);
  // Derived before the transaction: hashing is deliberately slow, and the
  // transaction holds the slug's advisory lock.
  const credential = mode ? generateLocalCredential() : undefined;
  const credentialHash = credential
    ? await hashLocalCredential(credential)
    : undefined;

  return (repository as FoundationRepository).transaction(async (tx) => {
    if (mode && !holdsLocalCredentials(tx)) {
      throw new Error("This repository cannot hold a local credential");
    }
    await tx.lockBootstrapSlug(organizationSlug);
    let organization =
      await tx.findOrganizationBySlugForUpdate(organizationSlug);
    let organizationCreated = false;
    if (organization) {
      if (organization.status !== "active") {
        throw new DomainError(
          "forbidden",
          "An active organization is required",
        );
      }
      if (organization.name !== organizationName) {
        throw new DomainError("conflict", "Organization name does not match", {
          field: "name",
        });
      }
    } else if (mode === "rotate") {
      // Rotation is for an owner who exists; it never creates an organization.
      throw new DomainError("not_found", "Organization was not found", {
        field: "slug",
      });
    } else {
      organization = await tx.createOrganization({
        name: organizationName,
        slug: organizationSlug,
      });
      organizationCreated = true;
    }

    let authenticatedUser = await tx.findUserByNormalizedEmail(normalizedEmail);
    if (mode === "rotate" && !authenticatedUser) {
      throw new DomainError("not_found", "No such person", { field: "email" });
    }
    const activeOwners = await tx.findActiveOrganizationOwners(organization.id);
    const userId = authenticatedUser?.id;
    const alreadyActiveOwner =
      userId !== undefined &&
      activeOwners.some((owner) => owner.userId === userId);
    if (mode === "rotate" && !alreadyActiveOwner) {
      // Rotation replaces an owner's credential; it never makes an owner.
      throw new DomainError(
        "conflict",
        "Only an active owner's local credential can be rotated",
        { field: "owner" },
      );
    }
    // Bootstrap makes the first owner and never adds one beside another, so
    // anyone else being an active owner refuses it. A credential for someone
    // who is already an active owner adds no owner, so the other owners an
    // organization gained through invitations do not stand in its way.
    if (
      !(mode && alreadyActiveOwner) &&
      activeOwners.some((owner) => owner.userId !== userId)
    ) {
      throw new DomainError(
        "conflict",
        "Organization already has an active owner",
        {
          field: "owner",
        },
      );
    }

    const allowlist = await tx.ensureActiveAllowlist(normalizedEmail);
    if (!authenticatedUser && mode === "issue" && holdsLocalCredentials(tx)) {
      authenticatedUser = await tx.createLocalUser({
        normalizedEmail,
        name: normalizedEmail.split("@", 1)[0] || normalizedEmail,
      });
    }
    if (!authenticatedUser) {
      if (organizationCreated || allowlist.changed) {
        await tx.appendAuditRecord({
          organizationId: organization.id,
          actor: context.actor,
          action: "organization.bootstrap_requested",
          targetType: "organization",
          targetId: organization.id,
          reason: "First owner authentication requested",
          fieldNames: ["allowlistStatus"],
          correlationId: context.correlationId,
        });
      }
      return {
        status: "awaiting_authentication",
        organizationId: organization.id,
        organizationSlug,
        normalizedEmail,
      };
    }

    let credentialOutcome: "issued" | "rotated" | "unchanged" | undefined;
    if (mode && credentialHash && holdsLocalCredentials(tx)) {
      if (
        mode === "issue" &&
        (await tx.hasLocalCredential(authenticatedUser.id))
      ) {
        credentialOutcome = "unchanged";
      } else {
        await tx.setLocalCredential({
          userId: authenticatedUser.id,
          credentialHash,
        });
        if (mode === "rotate") {
          await tx.revokeUserSessions(authenticatedUser.id);
          await tx.revokeOperatorCredentialsIssuedBy({
            userId: authenticatedUser.id,
            actor: BOOTSTRAP_OWNER_ACTOR,
            correlationId: context.correlationId,
          });
        }
        credentialOutcome = mode === "rotate" ? "rotated" : "issued";
      }
    }

    const ownerMembership = await tx.activateOwnerMembership({
      organizationId: organization.id,
      userId: authenticatedUser.id,
    });
    const credentialChanged =
      credentialOutcome === "issued" || credentialOutcome === "rotated";
    if (
      organizationCreated ||
      allowlist.changed ||
      ownerMembership.changed ||
      credentialChanged
    ) {
      await tx.appendAuditRecord({
        organizationId: organization.id,
        actor: context.actor,
        action: "organization.owner_bootstrapped",
        targetType: "organization",
        targetId: organization.id,
        reason:
          credentialOutcome === "rotated"
            ? "Local owner credential rotated and sessions revoked"
            : credentialOutcome === "issued"
              ? "First organization owner activated with a local credential"
              : "First organization owner activated",
        fieldNames:
          credentialOutcome === "rotated"
            ? ["localCredential", "sessions"]
            : credentialOutcome === "issued"
              ? [
                  "membershipRole",
                  "membershipStatus",
                  "allowlistStatus",
                  "localCredential",
                ]
              : ["membershipRole", "membershipStatus", "allowlistStatus"],
        correlationId: context.correlationId,
      });
    }
    const identity = {
      organizationId: organization.id,
      organizationSlug,
      normalizedEmail,
      userId: authenticatedUser.id,
    };
    if (credentialChanged && credential) {
      return {
        status: "owner_active",
        ...identity,
        localCredential: credentialOutcome as "issued" | "rotated",
        credential,
      };
    }
    if (credentialOutcome === "unchanged") {
      return {
        status: "owner_active",
        ...identity,
        localCredential: "unchanged",
      };
    }
    return { status: "owner_active", ...identity };
  });
}
