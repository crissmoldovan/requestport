import { eq, type SQL, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import { user } from "./schema/identity.js";
import type { Tx } from "./transaction.js";

/*
 * What sign-up reads before any organisation is known (Plan 13, Track I.2;
 * manifest-i2.md §2.5.0). Invitations are tenant rows in every organisation,
 * and the allowlist is read by the application only here (D13), so both are
 * read through definer functions that return exactly the columns below and
 * no organisation id. `user` is a global table, read under grants.
 */

/**
 * A timestamp from a raw row. Drizzle's drivers hand `timestamptz` back from
 * `execute` as text, because its column mappers parse it for builder
 * queries; this parses it the way they do.
 */
function timestamp(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}

export function createSignupEligibilityRepository(database: Database | Tx) {
  return {
    async findExistingUser(normalizedEmail: string) {
      const [existingUser] = await database
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, normalizedEmail))
        .limit(1);
      return existingUser ?? null;
    },
    async findInvitations(normalizedEmail: string) {
      const { rows } = await database.execute(
        buildInvitationEligibilityQuery(normalizedEmail),
      );
      return (
        rows as {
          invitation_id: string;
          accepted_at: unknown;
          revoked_at: unknown;
          expires_at: unknown;
        }[]
      ).map((row) => ({
        id: row.invitation_id,
        acceptedAt: timestamp(row.accepted_at),
        revokedAt: timestamp(row.revoked_at),
        // Not null in the table.
        expiresAt: timestamp(row.expires_at) as Date,
      }));
    },
    async findAllowlistEntries(normalizedEmail: string) {
      const { rows } = await database.execute(
        buildAllowlistEligibilityQuery(normalizedEmail),
      );
      return (rows as { status: string; expires_at: Date | null }[]).map(
        (row) => ({ status: row.status, expiresAt: row.expires_at }),
      );
    },
  };
}

/**
 * Every invitation for the address, in any organisation. The function
 * compares `lower(normalized_email)` with the address, which is the
 * functional index's expression.
 */
export function buildInvitationEligibilityQuery(normalizedEmail: string): SQL {
  return sql`select invitation_id, accepted_at, revoked_at, expires_at from requestport_private.invitation_eligibility(${normalizedEmail})`;
}

/** The allowlist's rows for the address (D13), compared the same way. */
export function buildAllowlistEligibilityQuery(normalizedEmail: string): SQL {
  return sql`select status, expires_at from requestport_private.signup_allowlist_eligibility(${normalizedEmail})`;
}
