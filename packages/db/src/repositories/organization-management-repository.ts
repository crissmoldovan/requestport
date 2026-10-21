import {
  auditActor,
  DomainError,
  type OrganizationManagementMutation,
  type OrganizationManagementPort,
  type OrganizationManagementTarget,
  type OrganizationRole,
  sanitizeEventActor,
} from "@requestport/domain";
import { and, eq, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import type { Database } from "../client.js";
import {
  domainEvents,
  invitations,
  organizationMembers,
  organizations,
  outbox,
  securityAuditRecords,
} from "../schema/index.js";
import { inTenantTransaction } from "../tenant-context.js";
import type { Tx } from "../transaction.js";

/*
  Organisation access: changing a member's role or access, and revoking a
  pending invitation (Plan 13, F.2.7). This is the `organizationManagement`
  port of the tenant bus, opened on the bus's transaction; the
  `set_organization_member` and `revoke_organization_invitation` commands
  (`@requestport/domain`, `organization-administration-commands.ts`) are its
  only callers, for the members page's forms and for an operator credential
  on `/api/v1`. Each method's role rules run for `userId`, the member whose
  authority the command runs with; the records name `actor`, who acted. The
  bus keeps the one receipt, so nothing here keys, locks or saves one.
*/

/**
 * Throws `forbidden` unless the organisation is active and `userId` is an
 * active owner or admin of it; answers that role. Takes the organisation row
 * and then the membership row `FOR SHARE`: the same rows, in the same mode, as
 * the bus's `assertCurrent` has already taken for a signed-in person, so this
 * never asks to upgrade a lock another in-flight command also holds. Writers
 * that must be serialised say so separately (`lockOrganizationAccessChanges`).
 */
export async function requireOrganizationAdministrator(
  transaction: Database | Tx,
  input: { organizationId: string; userId: string },
) {
  const [organization] = await transaction
    .select({ status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .for("share")
    .limit(1);
  if (organization?.status !== "active") {
    throw new DomainError("forbidden", "An active organization is required");
  }
  const [actor] = await transaction
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, input.organizationId),
        eq(organizationMembers.userId, input.userId),
        eq(organizationMembers.status, "active"),
      ),
    )
    .for("share")
    .limit(1);
  if (actor?.role !== "owner" && actor?.role !== "admin") {
    throw new DomainError(
      "forbidden",
      "Organization administration is required",
    );
  }
  return actor.role as "owner" | "admin";
}

/**
 * Serialises member changes in one organisation: a transaction-scoped
 * advisory lock, held to the end of the bus's transaction, so two owners
 * cannot each demote themselves after seeing the other as the remaining
 * owner.
 *
 * It replaces locking the organisation row `FOR UPDATE`, which the repository
 * did before it became the bus's port. The bus runs `assertCurrent` first, and
 * that holds the organisation row `FOR SHARE` for every in-flight command in
 * the organisation, so asking for it `FOR UPDATE` made any two overlapping
 * access changes wait for each other: PostgreSQL ended one with `40P01
 * deadlock detected` (F.2.7, review round 1). An advisory lock is not a row
 * lock, and no share lock stands in its way.
 *
 * It does not remove every cycle. A member change still locks its target's
 * membership `FOR UPDATE`, and when that target is itself changing a member at
 * the same moment, the target's `assertCurrent` holds that row `FOR SHARE`
 * while it waits here: one of the two is ended with 40P01.
 *
 * In production the bus's transaction is a top-level one:
 * `createCommandTransactionManager` opens it on `db`
 * (`apps/web/src/lib/server-core-commands.ts`). The port method that takes
 * this lock runs in a savepoint inside it; the 40P01 propagates out of that
 * savepoint and out of the bus, so the victim's whole transaction rolls back
 * and writes nothing: no member change, audit row, event, outbox row or
 * receipt. The two-session suite that measures the cycle
 * (`organization-management-repository.sessions.integration.test.ts`) runs
 * the bus's transaction as a savepoint inside a test transaction it rolls
 * back, so there the victim's rollback is a savepoint's; that is the test
 * harness's shape, not production's. The members form sends the same key once
 * more when a 40P01 reaches it
 * (`apps/web/src/app/(app)/settings/members/actions.ts`).
 */
async function lockOrganizationAccessChanges(
  transaction: Tx,
  organizationId: string,
) {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('requestport:organization-access:' || ${organizationId}, 0))`,
  );
}

/** The target membership, locked `FOR UPDATE`; `not_found` outside the organisation. */
async function lockTargetMember(
  transaction: Tx,
  organizationId: string,
  userId: string,
) {
  const [target] = await transaction
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .for("update")
    .limit(1);
  if (!target) {
    throw new DomainError("not_found", "Organization member was not found");
  }
  return target;
}

/** The invitation, locked `FOR UPDATE`; `not_found` outside the organisation. */
async function lockInvitation(
  transaction: Tx,
  organizationId: string,
  invitationId: string,
) {
  const [invitation] = await transaction
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.organizationId, organizationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!invitation) {
    throw new DomainError("not_found", "Invitation was not found");
  }
  return invitation;
}

/** Only an owner manages an owner, or makes one. */
function requireOwnerAuthority(
  actorRole: "owner" | "admin",
  targetRole: string,
  role: OrganizationRole,
) {
  if (actorRole !== "owner" && (targetRole === "owner" || role === "owner")) {
    throw new DomainError("forbidden", "Only an owner may manage owners");
  }
}

/** Only an owner revokes an owner invitation. */
function requireInvitationOwnerAuthority(
  actorRole: "owner" | "admin",
  invitationRole: string,
) {
  if (invitationRole === "owner" && actorRole !== "owner") {
    throw new DomainError(
      "forbidden",
      "Only an owner may revoke an owner invitation",
    );
  }
}

/**
 * The write's audit row, event and outbox row. Both name the mutation's
 * actor: the audit row as `auditActor` records it — a person as `user` and
 * their id, an operator as `service` and `operator:<lineage>`, never its
 * member (Plan 13, F.3, F3-2) — and the event through the sanitiser the event
 * factory applies to every other event, so an operator's event carries its
 * member as `originatingActor`.
 */
async function appendChange(
  transaction: Tx,
  input: {
    context: OrganizationManagementMutation;
    action: string;
    targetType: string;
    targetId: string;
    aggregateType: string;
    aggregateVersion: number;
    eventType: string;
    fieldNames: string[];
    data: Record<string, unknown>;
  },
) {
  const { actorType, actorId } = auditActor(input.context);
  await transaction.insert(securityAuditRecords).values({
    organizationId: input.context.organizationId,
    actorType,
    actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: "Organization access configuration changed",
    fieldNames: input.fieldNames,
    correlationId: input.context.correlationId,
  });
  const eventId = uuidv7();
  await transaction.insert(domainEvents).values({
    id: eventId,
    organizationId: input.context.organizationId,
    aggregateType: input.aggregateType,
    aggregateId: input.targetId,
    aggregateVersion: input.aggregateVersion,
    type: input.eventType,
    schemaVersion: 1,
    actor: sanitizeEventActor(input.context.actor),
    correlationId: input.context.correlationId,
    causationId: input.context.correlationId,
    data: input.data,
    links: {},
  });
  await transaction.insert(outbox).values({ eventId, state: "pending" });
}

/**
 * The `organizationManagement` port. Each method runs in its own transaction,
 * a savepoint when `database` is the bus's transaction. The two
 * `authorize…` methods run the writes' role rules, so the command can refuse
 * before the bus answers a replay; each write runs them again, then its
 * version check and its own rules, before it writes. A member change takes
 * `lockOrganizationAccessChanges` before anything else, in `authorize` and
 * again in the write. Revoking an invitation does not: it changes no
 * membership, and nothing earlier in the bus's transaction has locked the
 * invitation row it takes `FOR UPDATE`, so it has no lock to upgrade.
 */
export function createOrganizationManagementRepository(
  database: Database | Tx,
): OrganizationManagementPort {
  return {
    async authorizeMemberChange(target: OrganizationManagementTarget, change) {
      await inTenantTransaction(
        database,
        target.organizationId,
        async (transaction) => {
          await lockOrganizationAccessChanges(
            transaction,
            target.organizationId,
          );
          const actorRole = await requireOrganizationAdministrator(
            transaction,
            target,
          );
          const member = await lockTargetMember(
            transaction,
            target.organizationId,
            change.userId,
          );
          requireOwnerAuthority(actorRole, member.role, change.role);
        },
      );
    },

    async authorizeInvitationRevocation(
      target: OrganizationManagementTarget,
      invitationId,
    ) {
      await inTenantTransaction(
        database,
        target.organizationId,
        async (transaction) => {
          const actorRole = await requireOrganizationAdministrator(
            transaction,
            target,
          );
          const invitation = await lockInvitation(
            transaction,
            target.organizationId,
            invitationId,
          );
          requireInvitationOwnerAuthority(actorRole, invitation.role);
        },
      );
    },

    async setMember(context: OrganizationManagementMutation, input) {
      return inTenantTransaction(
        database,
        context.organizationId,
        async (transaction) => {
          await lockOrganizationAccessChanges(
            transaction,
            context.organizationId,
          );
          const actorRole = await requireOrganizationAdministrator(
            transaction,
            context,
          );
          const target = await lockTargetMember(
            transaction,
            context.organizationId,
            input.userId,
          );
          if (target.version !== context.expectedVersion) {
            throw new DomainError(
              "version_conflict",
              "Member version changed",
              {
                currentVersion: target.version,
                expectedVersion: context.expectedVersion,
              },
            );
          }
          requireOwnerAuthority(actorRole, target.role, input.role);
          if (context.userId === input.userId && input.status === "revoked") {
            throw new DomainError(
              "forbidden",
              "Use another owner to revoke your organization access",
            );
          }
          if (
            target.role === "owner" &&
            target.status === "active" &&
            (input.role !== "owner" || input.status !== "active")
          ) {
            const [otherOwner] = await transaction
              .select({ id: organizationMembers.id })
              .from(organizationMembers)
              .where(
                and(
                  eq(
                    organizationMembers.organizationId,
                    context.organizationId,
                  ),
                  eq(organizationMembers.role, "owner"),
                  eq(organizationMembers.status, "active"),
                  ne(organizationMembers.id, target.id),
                ),
              )
              .for("share")
              .limit(1);
            if (!otherOwner) {
              throw new DomainError(
                "conflict",
                "The organization must retain an active owner",
              );
            }
          }
          if (target.role === input.role && target.status === input.status) {
            return {
              id: target.id,
              role: target.role,
              status: target.status,
              version: target.version,
            };
          }
          const [updated] = await transaction
            .update(organizationMembers)
            .set({
              role: input.role,
              status: input.status,
              version: sql`${organizationMembers.version} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(organizationMembers.id, target.id),
                eq(organizationMembers.version, context.expectedVersion),
              ),
            )
            .returning({
              id: organizationMembers.id,
              role: organizationMembers.role,
              status: organizationMembers.status,
              version: organizationMembers.version,
            });
          if (!updated) {
            throw new DomainError("version_conflict", "Member version changed");
          }
          await appendChange(transaction, {
            context,
            action: "organization.member_changed",
            targetType: "organization_member",
            targetId: updated.id,
            aggregateType: "organization_member",
            aggregateVersion: updated.version,
            eventType: "organization.member_changed.v1",
            fieldNames: ["role", "status"],
            data: {
              membershipId: updated.id,
              role: updated.role,
              status: updated.status,
            },
          });
          return updated;
        },
      );
    },

    async revokeInvitation(
      context: OrganizationManagementMutation,
      invitationId,
    ) {
      return inTenantTransaction(
        database,
        context.organizationId,
        async (transaction) => {
          const actorRole = await requireOrganizationAdministrator(
            transaction,
            context,
          );
          const invitation = await lockInvitation(
            transaction,
            context.organizationId,
            invitationId,
          );
          if (invitation.version !== context.expectedVersion) {
            throw new DomainError(
              "version_conflict",
              "Invitation version changed",
              {
                currentVersion: invitation.version,
                expectedVersion: context.expectedVersion,
              },
            );
          }
          requireInvitationOwnerAuthority(actorRole, invitation.role);
          if (invitation.acceptedAt || invitation.revokedAt) {
            throw new DomainError(
              "invalid_transition",
              "Only a pending invitation may be revoked",
            );
          }
          const [updated] = await transaction
            .update(invitations)
            .set({
              revokedAt: new Date(),
              version: sql`${invitations.version} + 1`,
            })
            .where(
              and(
                eq(invitations.id, invitation.id),
                eq(invitations.version, context.expectedVersion),
              ),
            )
            .returning({ id: invitations.id, version: invitations.version });
          if (!updated) {
            throw new DomainError(
              "version_conflict",
              "Invitation version changed",
            );
          }
          await appendChange(transaction, {
            context,
            action: "organization.invitation_revoked",
            targetType: "invitation",
            targetId: updated.id,
            aggregateType: "invitation",
            aggregateVersion: updated.version,
            eventType: "organization.invitation_revoked.v1",
            fieldNames: ["revokedAt"],
            data: { invitationId: updated.id },
          });
          return updated;
        },
      );
    },
  };
}
