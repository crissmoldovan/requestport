import {
  type AppearancePort,
  type AppearanceSnapshot,
  type AuditRecordInput,
  auditRecordRow,
  type OrganizationAppearanceRecord,
  parseAppearanceDefaults,
  parseAppearanceOverrides,
  resolveAppearanceSnapshot,
  type UserAppearanceRecord,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  organizationAppearanceDefaults,
  organizationMembers,
  organizations,
  securityAuditRecords,
  userAppearancePreferences,
} from "../schema/index.js";
import {
  isTransaction,
  tenantBindingFor,
  withTenantRead,
  withUserBinding,
} from "../tenant-context.js";
import type { Tx } from "../transaction.js";

type AppearanceDatabase = Database | Tx;

type UserRow = {
  userId: string;
  aggregateId: string;
  theme: string | null;
  density: string | null;
  mode: string | null;
  font: string | null;
  look: string | null;
  paint: string | null;
  version: number;
};

type OrganizationRow = {
  organizationId: string;
  aggregateId: string;
  theme: string;
  density: string;
  mode: string;
  font: string;
  look: string;
  paint: string;
  lastUpdatedByUserId: string | null;
  version: number;
};

function userRecord(row: UserRow): UserAppearanceRecord {
  return {
    userId: row.userId,
    aggregateId: row.aggregateId,
    version: row.version,
    ...parseAppearanceOverrides(row),
  };
}

function organizationRecord(
  row: OrganizationRow,
): OrganizationAppearanceRecord {
  return {
    organizationId: row.organizationId,
    aggregateId: row.aggregateId,
    lastUpdatedByUserId: row.lastUpdatedByUserId,
    version: row.version,
    ...parseAppearanceDefaults(row),
  };
}

const userColumns = {
  userId: userAppearancePreferences.userId,
  aggregateId: userAppearancePreferences.aggregateId,
  theme: userAppearancePreferences.theme,
  density: userAppearancePreferences.density,
  mode: userAppearancePreferences.mode,
  font: userAppearancePreferences.font,
  look: userAppearancePreferences.look,
  paint: userAppearancePreferences.paint,
  version: userAppearancePreferences.version,
};

const organizationColumns = {
  organizationId: organizationAppearanceDefaults.organizationId,
  aggregateId: organizationAppearanceDefaults.aggregateId,
  theme: organizationAppearanceDefaults.theme,
  density: organizationAppearanceDefaults.density,
  mode: organizationAppearanceDefaults.mode,
  font: organizationAppearanceDefaults.font,
  look: organizationAppearanceDefaults.look,
  paint: organizationAppearanceDefaults.paint,
  lastUpdatedByUserId: organizationAppearanceDefaults.lastUpdatedByUserId,
  version: organizationAppearanceDefaults.version,
};

export type AppearanceRepository = AppearancePort & {
  readAppearanceSnapshot(input: {
    userId: string;
    organizationId?: string | null;
  }): Promise<AppearanceSnapshot>;
};

export function createAppearanceRepository(
  database: AppearanceDatabase,
): AppearanceRepository {
  return {
    async lockUserPreferences(userId) {
      // `SELECT … FOR UPDATE` locks nothing when the row does not exist yet, so
      // two first-time writers would both see "absent" and race to insert the
      // same primary key. The identity lock serializes them before the read.
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('requestport:appearance:user:' || ${userId}, 0))`,
      );
      const [row] = await database
        .select(userColumns)
        .from(userAppearancePreferences)
        .where(eq(userAppearancePreferences.userId, userId))
        .for("update")
        .limit(1);
      return row ? userRecord(row) : null;
    },

    async createUserPreferences(input) {
      const [created] = await database
        .insert(userAppearancePreferences)
        .values({
          userId: input.userId,
          theme: input.theme,
          density: input.density,
          mode: input.mode,
          font: input.font,
          look: input.look,
          paint: input.paint,
        })
        .onConflictDoNothing({ target: userAppearancePreferences.userId })
        .returning(userColumns);
      return created ? userRecord(created) : null;
    },

    async updateUserPreferences(input) {
      const [updated] = await database
        .update(userAppearancePreferences)
        .set({
          theme: input.theme,
          density: input.density,
          mode: input.mode,
          font: input.font,
          look: input.look,
          paint: input.paint,
          version: sql`${userAppearancePreferences.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(userAppearancePreferences.userId, input.userId),
            eq(userAppearancePreferences.version, input.expectedVersion),
          ),
        )
        .returning(userColumns);
      return updated ? userRecord(updated) : null;
    },

    async lockOrganizationAuthorization(input) {
      // Organization first, then the exact tenant/user membership. Every human
      // authorization path in RequestPort takes them in this order so
      // concurrent writers cannot deadlock against each other.
      const [organization] = await database
        .select({ id: organizations.id, status: organizations.status })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .for("share")
        .limit(1);
      if (!organization) return { organization: null, membership: null };
      const [membership] = await database
        .select({
          id: organizationMembers.id,
          role: organizationMembers.role,
          status: organizationMembers.status,
        })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, input.organizationId),
            eq(organizationMembers.userId, input.userId),
          ),
        )
        .for("share")
        .limit(1);
      return { organization, membership: membership ?? null };
    },

    async lockOrganizationDefaults(organizationId) {
      const [row] = await database
        .select(organizationColumns)
        .from(organizationAppearanceDefaults)
        .where(
          eq(organizationAppearanceDefaults.organizationId, organizationId),
        )
        .for("update")
        .limit(1);
      return row ? organizationRecord(row) : null;
    },

    async updateOrganizationDefaults(input) {
      const [updated] = await database
        .update(organizationAppearanceDefaults)
        .set({
          theme: input.theme,
          density: input.density,
          mode: input.mode,
          font: input.font,
          look: input.look,
          paint: input.paint,
          lastUpdatedByUserId: input.lastUpdatedByUserId,
          version: sql`${organizationAppearanceDefaults.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(
              organizationAppearanceDefaults.organizationId,
              input.organizationId,
            ),
            eq(organizationAppearanceDefaults.version, input.expectedVersion),
          ),
        )
        .returning(organizationColumns);
      return updated ? organizationRecord(updated) : null;
    },

    async appendAuditRecord(input: AuditRecordInput) {
      // The actor and the action → target pairing are validated by the one
      // shared projection every audit writer uses, so this repository cannot
      // drift into a weaker guard than the foundation one.
      await database.insert(securityAuditRecords).values(auditRecordRow(input));
    },

    /**
     * The web renders this on the pool. Its first read is the user's own
     * preferences, under the user policy, and its second an organisation's
     * defaults, under the tenant policy, so on a pool whose reads are wrapped
     * (`tenantBindingFor`: its storage's `tenantBinding`, `"wrapped"` for a
     * storage built without one) it runs in a read-only
     * transaction bound to both — or to the user alone when no organisation
     * is named (manifest-i2.md §2.3 item 3, D1). Handed a transaction, it
     * runs in it as its opener bound it.
     */
    async readAppearanceSnapshot(input) {
      const read = async (database: AppearanceDatabase) => {
        const [user] = await database
          .select(userColumns)
          .from(userAppearancePreferences)
          .where(eq(userAppearancePreferences.userId, input.userId))
          .limit(1);
        // The organization default is read through the caller's own active
        // membership, so a tenant identifier the caller does not belong to
        // resolves to the fixed fallback rather than leaking another tenant's
        // presentation.
        const [organization] = input.organizationId
          ? await database
              .select(organizationColumns)
              .from(organizationAppearanceDefaults)
              .innerJoin(
                organizations,
                and(
                  eq(
                    organizations.id,
                    organizationAppearanceDefaults.organizationId,
                  ),
                  eq(organizations.status, "active"),
                ),
              )
              .innerJoin(
                organizationMembers,
                and(
                  eq(organizationMembers.organizationId, organizations.id),
                  eq(organizationMembers.userId, input.userId),
                  eq(organizationMembers.status, "active"),
                ),
              )
              .where(
                eq(
                  organizationAppearanceDefaults.organizationId,
                  input.organizationId,
                ),
              )
              .limit(1)
          : [];
        return resolveAppearanceSnapshot({
          user: user ? userRecord(user) : null,
          organization: organization ? organizationRecord(organization) : null,
        });
      };
      if (!input.organizationId) {
        return !isTransaction(database) &&
          tenantBindingFor(database) === "wrapped"
          ? withUserBinding(input.userId, read, { database })
          : read(database);
      }
      return withTenantRead(input.organizationId, read, {
        database,
        readOnly: true,
        userId: input.userId,
      });
    },
  };
}
