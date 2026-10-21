import { randomBytes, randomUUID } from "node:crypto";

import {
  type AuditRecordInput,
  auditRecordRow,
  type BootstrapOwnerRepository,
  type BootstrapOwnerTransaction,
  DomainError,
  type InvitationRecord,
  LOCAL_CREDENTIAL_PROVIDER_ID,
  type MembershipRecord,
  type OrganizationRecord,
  type ProjectRecord,
  type ProjectRepositoryRecord,
} from "@requestport/domain";
import { and, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  account,
  domainEvents,
  invitations,
  notificationIntents,
  organizationMembers,
  organizations,
  outbox,
  projectRepositories,
  projects,
  securityAuditRecords,
  session,
  signupAllowlist,
  user,
} from "../schema/index.js";
import { bindTenant } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { revokeOperatorCredentialsIssuedBy } from "./operator-credential-repository.js";

type FoundationDatabase = Database | Tx;
export type FoundationTransactionRunner = <T>(
  run: (tx: Tx) => Promise<T>,
) => Promise<T>;

type DatabaseError = {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
};

const uniquenessFields = new Map<string, string>([
  ["organizations_slug_ci_unique", "slug"],
  ["organization_members_organization_user_unique", "membership"],
  ["projects_organization_slug_ci_unique", "slug"],
  ["projects_organization_key_prefix_ci_unique", "keyPrefix"],
  ["project_repositories_provider_slug_ci_unique", "repositoryUrl"],
  ["project_repositories_project_default_unique", "repositoryUrl"],
  ["invitations_organization_email_ci_unique", "email"],
  ["invitations_token_hash_unique", "invitation"],
  ["signup_allowlist_normalized_email_ci_unique", "email"],
]);

const notFoundConstraints = new Map<string, string>([
  ["projects_organization_id_organizations_id_fk", "organizationId"],
  ["invitations_organization_id_organizations_id_fk", "organizationId"],
  ["project_repositories_organization_project_fk", "projectId"],
]);

function findDatabaseError(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as DatabaseError;
    if (typeof candidate.code === "string") return candidate;
    current = candidate.cause;
  }
  return undefined;
}

export function mapFoundationDatabaseError(error: unknown): Error {
  if (error instanceof DomainError) return error;
  const databaseError = findDatabaseError(error);
  if (
    databaseError?.code === "23505" &&
    typeof databaseError.constraint === "string"
  ) {
    const field = uniquenessFields.get(databaseError.constraint);
    if (field)
      return new DomainError("conflict", "Canonical value already exists", {
        field,
      });
  }
  if (
    databaseError?.code === "23503" &&
    typeof databaseError.constraint === "string"
  ) {
    const field = notFoundConstraints.get(databaseError.constraint);
    if (field)
      return new DomainError("not_found", "Referenced record was not found", {
        field,
      });
  }
  return new Error("Foundation persistence failed");
}

function organizationRecord(
  row: typeof organizations.$inferSelect,
): OrganizationRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status as OrganizationRecord["status"],
  };
}

function membershipRecord(
  row: typeof organizationMembers.$inferSelect,
): MembershipRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    role: row.role as MembershipRecord["role"],
    status: row.status as MembershipRecord["status"],
  };
}

function invitationRecord(
  row: typeof invitations.$inferSelect,
): InvitationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    normalizedEmail: row.normalizedEmail,
    role: row.role as InvitationRecord["role"],
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    expiresInSeconds: Math.round(
      (row.expiresAt.getTime() - row.createdAt.getTime()) / 1_000,
    ),
    version: row.version,
  };
}

function projectRecord(row: typeof projects.$inferSelect): ProjectRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    keyPrefix: row.keyPrefix,
    description: row.description,
    status: row.status as ProjectRecord["status"],
    version: row.version,
    heartbeatIntervalSeconds: row.heartbeatIntervalSeconds,
    leaseMultiplier: row.leaseMultiplier,
    graceSeconds: row.graceSeconds,
    requiredWorkspaceFields: row.requiredWorkspaceFields,
  };
}

function projectRepositoryRecord(
  row: typeof projectRepositories.$inferSelect,
): ProjectRepositoryRecord {
  if (row.repositorySlug === null) {
    throw new Error("Foundation persistence failed");
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    provider: row.provider as "github",
    browseUrl: row.browseUrl,
    cloneUrl: row.cloneUrl,
    repositorySlug: row.repositorySlug,
    isDefault: row.isDefault,
    status: row.status as ProjectRepositoryRecord["status"],
  };
}

const identifierAlphabet =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * An identifier in the shape Better Auth gives its own rows: 32 characters
 * from [a-zA-Z0-9]. Rows this repository writes into Better Auth's tables are
 * then indistinguishable by id from the ones Better Auth writes.
 */
function betterAuthStyleId() {
  const bytes = randomBytes(64);
  let id = "";
  for (const byte of bytes) {
    // 248 is the largest multiple of 62 below 256; rejecting above it keeps
    // every character equally likely.
    if (byte >= 248) continue;
    id += identifierAlphabet[byte % identifierAlphabet.length];
    if (id.length === 32) return id;
  }
  return betterAuthStyleId();
}

function createTransactionAdapter(
  database: FoundationDatabase,
): BootstrapOwnerTransaction {
  return {
    async createOrganization(input) {
      // D10: the root policy checks the new row against the binding, and so
      // does RETURNING's read of it, so the id is generated here and the
      // transaction bound to it before the insert (manifest-i2.md §2.3).
      const id = randomUUID();
      await bindTenant(database as Tx, id);
      const [created] = await database
        .insert(organizations)
        .values({ ...input, id, status: "active" })
        .returning();
      if (!created) throw new Error("Foundation persistence failed");
      return organizationRecord(created);
    },

    async findOrganizationBySlugForUpdate(slug) {
      const [organization] = await database
        .select()
        .from(organizations)
        .where(sql`lower(${organizations.slug}) = ${slug}`)
        .for("update")
        .limit(1);
      return organization ? organizationRecord(organization) : null;
    },

    async findOrganizationAuthorization(organizationId, userId) {
      // The first read of an invitation or a project creation: it binds the
      // transaction to the organisation it authorises (manifest-i2.md §2.3
      // item 2, track-i2.md §6).
      await bindTenant(database as Tx, organizationId);
      const [organization] = await database
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for("share")
        .limit(1);
      if (!organization) {
        return { organization: null, membership: null };
      }
      const [membership] = await database
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, userId),
          ),
        )
        .for("share")
        .limit(1);
      return {
        organization: organizationRecord(organization),
        membership: membership ? membershipRecord(membership) : null,
      };
    },

    async lockBootstrapSlug(slug) {
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('requestport:bootstrap-owner:' || ${slug}, 0))`,
      );
    },

    async createOrganizationMembership(input) {
      const [created] = await database
        .insert(organizationMembers)
        .values({ ...input, status: "active" })
        .returning();
      if (!created) throw new Error("Foundation persistence failed");
      return membershipRecord(created);
    },

    async findActiveOrganizationOwners(organizationId) {
      const owners = await database
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.role, "owner"),
            eq(organizationMembers.status, "active"),
          ),
        );
      return owners.map(membershipRecord);
    },

    async activateOwnerMembership(input) {
      const [existing] = await database
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, input.organizationId),
            eq(organizationMembers.userId, input.userId),
          ),
        )
        .for("update")
        .limit(1);
      if (existing) {
        const changed =
          existing.role !== "owner" || existing.status !== "active";
        if (!changed)
          return { membership: membershipRecord(existing), changed };
        const [updated] = await database
          .update(organizationMembers)
          .set({ role: "owner", status: "active", updatedAt: new Date() })
          .where(
            and(
              eq(organizationMembers.organizationId, input.organizationId),
              eq(organizationMembers.userId, input.userId),
            ),
          )
          .returning();
        if (!updated) throw new Error("Foundation persistence failed");
        return { membership: membershipRecord(updated), changed: true };
      }
      const [created] = await database
        .insert(organizationMembers)
        .values({ ...input, role: "owner", status: "active" })
        .returning();
      if (!created) throw new Error("Foundation persistence failed");
      return { membership: membershipRecord(created), changed: true };
    },

    async findUserByNormalizedEmail(normalizedEmail) {
      const [found] = await database
        .select({ id: user.id, email: user.email })
        .from(user)
        .where(sql`lower(${user.email}) = ${normalizedEmail}`)
        .limit(1);
      return found
        ? {
            id: found.id,
            normalizedEmail: found.email.normalize("NFC").toLowerCase(),
          }
        : null;
    },

    async createLocalUser(input) {
      // Inserted directly rather than through Better Auth, so the database's
      // signup-eligibility guard is the check: bootstrap allowlists the
      // address first, in this same transaction. The address is verified
      // because the operator who ran the command vouched for it.
      const [created] = await database
        .insert(user)
        .values({
          id: betterAuthStyleId(),
          name: input.name,
          email: input.normalizedEmail,
          emailVerified: true,
        })
        .returning({ id: user.id, email: user.email });
      if (!created) throw new Error("Foundation persistence failed");
      return {
        id: created.id,
        normalizedEmail: created.email.normalize("NFC").toLowerCase(),
      };
    },

    async hasLocalCredential(userId) {
      const [found] = await database
        .select({ id: account.id })
        .from(account)
        .where(
          and(
            eq(account.userId, userId),
            eq(account.providerId, LOCAL_CREDENTIAL_PROVIDER_ID),
          ),
        )
        .limit(1);
      return Boolean(found);
    },

    async setLocalCredential(input) {
      // Better Auth keys a credential account by the user's own id, and the
      // (provider_id, account_id) unique index makes that one row per person.
      await database
        .insert(account)
        .values({
          id: betterAuthStyleId(),
          accountId: input.userId,
          providerId: LOCAL_CREDENTIAL_PROVIDER_ID,
          userId: input.userId,
          password: input.credentialHash,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [account.providerId, account.accountId],
          set: { password: input.credentialHash, updatedAt: new Date() },
        });
    },

    async revokeUserSessions(userId) {
      const revoked = await database
        .delete(session)
        .where(eq(session.userId, userId))
        .returning({ id: session.id });
      return revoked.length;
    },

    /*
      Plan 13, F3-13: the same revocation `revoke_operator_credential` writes,
      on this transaction's handle, so a failure rolls the rotation back.
    */
    async revokeOperatorCredentialsIssuedBy(input) {
      return revokeOperatorCredentialsIssuedBy(database, {
        userId: input.userId,
        actor: { actorType: "system", actorId: input.actor.system },
        correlationId: input.correlationId,
      });
    },

    async ensureActiveAllowlist(normalizedEmail) {
      const changed = await database.execute<{ id: string }>(
        sql`insert into ${signupAllowlist}
              ("normalized_email", "status", "expires_at")
            values (${normalizedEmail}, 'active', null)
            on conflict (lower("normalized_email")) do update
              set "status" = 'active', "expires_at" = null
              where ${signupAllowlist.status} <> 'active'
                 or ${signupAllowlist.expiresAt} is not null
            returning ${signupAllowlist.id} as id`,
      );
      return { changed: changed.rows.length > 0 };
    },

    async lockInvitation(organizationId, normalizedEmail) {
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(
          'requestport:organization-invitation:' || ${organizationId} || ':' || ${normalizedEmail},
          0
        ))`,
      );
    },

    async findInvitation(organizationId, normalizedEmail) {
      const [found] = await database
        .select({
          invitation: invitations,
          active: sql<boolean>`${invitations.acceptedAt} is null
            and ${invitations.revokedAt} is null
            and ${invitations.expiresAt} > clock_timestamp()`,
        })
        .from(invitations)
        .where(
          and(
            eq(invitations.organizationId, organizationId),
            sql`lower(${invitations.normalizedEmail}) = ${normalizedEmail}`,
          ),
        )
        // Held until the command commits, so a renewal decides on the state
        // it replaces; the signup trigger locks a pending row the same way.
        .for("update")
        .limit(1);
      return found
        ? { ...invitationRecord(found.invitation), active: found.active }
        : null;
    },

    async findActiveMembershipByEmail(organizationId, normalizedEmail) {
      const [found] = await database
        .select({ membership: organizationMembers })
        .from(organizationMembers)
        .innerJoin(user, eq(user.id, organizationMembers.userId))
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.status, "active"),
            sql`lower(${user.email}) = ${normalizedEmail}`,
          ),
        )
        .limit(1);
      return found ? membershipRecord(found.membership) : null;
    },

    async renewInvitation(input) {
      const databaseTime = await database.execute<{ now: string | Date }>(
        sql`select clock_timestamp() as now`,
      );
      const issuedAt = new Date(databaseTime.rows[0]?.now ?? Number.NaN);
      if (Number.isNaN(issuedAt.getTime())) {
        throw new Error("Foundation persistence failed");
      }
      const [renewed] = await database
        .update(invitations)
        .set({
          role: input.role,
          tokenHash: input.tokenHash,
          // `created_at` becomes the issue time of the current token: the
          // lifetime an exact retry is compared on is expiry less this. The
          // original creation stays in the audit trail and the event log.
          createdAt: issuedAt,
          expiresAt: new Date(
            issuedAt.getTime() + input.expiresInSeconds * 1_000,
          ),
          acceptedAt: null,
          revokedAt: null,
          createdByUserId: input.createdByUserId,
          version: sql`${invitations.version} + 1`,
        })
        .where(
          and(
            eq(invitations.organizationId, input.organizationId),
            eq(invitations.id, input.invitationId),
            eq(invitations.version, input.expectedVersion),
            or(
              isNotNull(invitations.acceptedAt),
              isNotNull(invitations.revokedAt),
              lte(invitations.expiresAt, issuedAt),
            ),
          ),
        )
        .returning();
      if (!renewed) {
        throw new DomainError("version_conflict", "Invitation version changed");
      }
      // An email the invitation's earlier issue still has scheduled would
      // otherwise go out beside the renewal's, now that the row is pending
      // again. One already being delivered holds a lease and is left to finish.
      await database
        .update(notificationIntents)
        .set({
          status: "suppressed",
          nextAttemptAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(notificationIntents.organizationId, input.organizationId),
            eq(notificationIntents.invitationId, renewed.id),
            inArray(notificationIntents.status, ["pending", "failed"]),
            isNotNull(notificationIntents.nextAttemptAt),
          ),
        );
      return invitationRecord(renewed);
    },

    async createInvitation(input) {
      const databaseTime = await database.execute<{ now: string | Date }>(
        sql`select clock_timestamp() as now`,
      );
      const createdAt = new Date(databaseTime.rows[0]?.now ?? Number.NaN);
      if (Number.isNaN(createdAt.getTime())) {
        throw new Error("Foundation persistence failed");
      }
      const [created] = await database
        .insert(invitations)
        .values({
          organizationId: input.organizationId,
          normalizedEmail: input.normalizedEmail,
          role: input.role,
          tokenHash: input.tokenHash,
          createdAt,
          expiresAt: new Date(
            createdAt.getTime() + input.expiresInSeconds * 1_000,
          ),
          createdByUserId: input.createdByUserId,
        })
        .returning();
      if (!created) throw new Error("Foundation persistence failed");
      return invitationRecord(created);
    },

    async createProject(input) {
      const [created] = await database
        .insert(projects)
        .values({ ...input, status: "active" })
        .returning();
      if (!created) throw new Error("Foundation persistence failed");
      return projectRecord(created);
    },

    async createProjectRepository(input) {
      const [created] = await database
        .insert(projectRepositories)
        .values({
          ...input,
          provider: "github",
          isDefault: true,
          status: "active",
        })
        .returning();
      if (!created) throw new Error("Foundation persistence failed");
      return projectRepositoryRecord(created);
    },

    async appendAuditRecord(input: AuditRecordInput) {
      // Shared with the appearance repository so both writers enforce the same
      // actor rule and the same action → target pairing. `security_audit_records`
      // is append-only: a mismatched row here could never be corrected.
      await database.insert(securityAuditRecords).values(auditRecordRow(input));
    },

    async appendDomainEvent(event) {
      await database.insert(domainEvents).values({
        id: event.id,
        organizationId: event.organizationId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        aggregateVersion: event.aggregateVersion,
        type: event.type,
        schemaVersion: event.schemaVersion,
        occurredAt: new Date(event.occurredAt),
        projectId: event.projectId,
        requestId: event.requestId,
        actor: event.actor,
        correlationId: event.correlationId,
        causationId: event.causationId,
        data: event.data,
        links: event.links,
      });
      await database
        .insert(outbox)
        .values({ eventId: event.id, state: "pending" });
    },
  };
}

export function createFoundationRepository(
  database: FoundationDatabase,
  transactionRunner?: FoundationTransactionRunner,
): BootstrapOwnerRepository {
  const runTransaction: FoundationTransactionRunner =
    transactionRunner ?? ((run) => database.transaction(run));
  return {
    async transaction(run) {
      try {
        return await runTransaction((tx) => run(createTransactionAdapter(tx)));
      } catch (error) {
        throw mapFoundationDatabaseError(error);
      }
    },
  };
}
