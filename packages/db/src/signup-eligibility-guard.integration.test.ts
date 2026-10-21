import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "./client.js";
import { tenantWrappingEnabled } from "./tenant-context.js";
import { openSession, rawQuery, type TestSession } from "./testing.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

const marker = {
  code: "P0001",
  constraint: "requestport_user_signup_eligibility_guard",
  message: "requestport_signup_disabled",
};

type DatabaseError = {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
};

function signupGuardMarker(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as DatabaseError;
    if (
      candidate.code === marker.code &&
      candidate.constraint === marker.constraint &&
      candidate.message === marker.message
    ) {
      return {
        code: candidate.code,
        constraint: candidate.constraint,
        message: candidate.message,
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

async function rollback(client: TestSession) {
  await client.query("ROLLBACK").catch(() => undefined);
}

async function pauseForLockAttempt() {
  await new Promise<void>((resolve) => setTimeout(resolve, 75));
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("live signup eligibility insert guard", () => {
  test("has the tracked migration hash and trigger installed", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/0005_invitation_membership_activation.sql",
        import.meta.url,
      ),
    );
    const expectedHash = createHash("sha256").update(migration).digest("hex");
    const applied = await rawQuery<{ installed: boolean }>(
      suiteStorage,
      `SELECT EXISTS (
         SELECT 1 FROM "drizzle"."__drizzle_migrations"
         WHERE "hash" = $1
       ) AS "installed"`,
      [expectedHash],
    );
    const trigger = await rawQuery<{ installed: boolean }>(
      suiteStorage,
      `SELECT EXISTS (
         SELECT 1 FROM "pg_trigger"
         WHERE "tgname" = 'requestport_user_signup_eligibility_guard'
           AND NOT "tgisinternal"
       ) AS "installed"`,
    );

    expect(applied.rows).toEqual([{ installed: true }]);
    expect(trigger.rows).toEqual([{ installed: true }]);
  });

  test("returns the exact nested Postgres marker for an unauthorized insert", async () => {
    const client = await openSession(suiteStorage);
    try {
      await client.query("BEGIN");
      const result = await client
        .query(
          'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
          [randomUUID(), "Denied user", `${randomUUID()}@example.invalid`],
        )
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );

      expect(signupGuardMarker(result.error)).toEqual(marker);
    } finally {
      await rollback(client);
      client.release();
    }
  });

  test("uses database time to deny an expired allowlist row", async () => {
    const client = await openSession(suiteStorage);
    const email = `${randomUUID()}@example.invalid`;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "signup_allowlist"
          ("normalized_email", "status", "expires_at")
         VALUES ($1, 'active', clock_timestamp() - interval '1 second')`,
        [email],
      );
      const result = await client
        .query(
          'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
          [randomUUID(), "Expired user", email],
        )
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );

      expect(signupGuardMarker(result.error)).toEqual(marker);
    } finally {
      await rollback(client);
      client.release();
    }
  });

  test("consumes an active invitation at the user insert linearization point", async () => {
    const client = await openSession(suiteStorage);
    const email = `${randomUUID()}@example.invalid`;
    const organizationId = randomUUID();
    const invitationId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "organizations" ("id", "name", "slug", "status")
         VALUES ($1, 'Guard test', $2, 'active')`,
        [organizationId, `guard-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO "invitations"
          ("id", "organization_id", "normalized_email", "role", "token_hash",
           "expires_at", "created_by_user_id")
         VALUES ($1, $2, $3, 'member', $4,
           clock_timestamp() + interval '5 minutes', 'guard-test')`,
        [invitationId, organizationId, email, randomUUID()],
      );

      await client.query(
        'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
        [randomUUID(), "Invited user", email.toUpperCase()],
      );
      const accepted = await client.query<{ accepted_at: Date | null }>(
        'SELECT "accepted_at" FROM "invitations" WHERE "id" = $1',
        [invitationId],
      );

      expect(accepted.rows[0]?.accepted_at).toBeInstanceOf(Date);
    } finally {
      await rollback(client);
      client.release();
    }
  });

  test("accepts every active invitation and creates the exact invited memberships", async () => {
    const client = await openSession(suiteStorage);
    const email = `${randomUUID()}@example.invalid`;
    const userId = randomUUID();
    const memberOrganizationId = randomUUID();
    const adminOrganizationId = randomUUID();
    const memberInvitationId = randomUUID();
    const adminInvitationId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "organizations" ("id", "name", "slug", "status")
         VALUES
           ($1, 'Member organization', $2, 'active'),
           ($3, 'Admin organization', $4, 'active')`,
        [
          memberOrganizationId,
          `guard-member-${randomUUID()}`,
          adminOrganizationId,
          `guard-admin-${randomUUID()}`,
        ],
      );
      await client.query(
        `INSERT INTO "invitations"
          ("id", "organization_id", "normalized_email", "role", "token_hash",
           "expires_at", "created_by_user_id")
         VALUES
           ($1, $2, $3, 'member', $4,
             clock_timestamp() + interval '5 minutes', 'guard-test'),
           ($5, $6, $3, 'admin', $7,
             clock_timestamp() + interval '10 minutes', 'guard-test')`,
        [
          memberInvitationId,
          memberOrganizationId,
          email,
          randomUUID(),
          adminInvitationId,
          adminOrganizationId,
          randomUUID(),
        ],
      );

      await client.query(
        'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
        [userId, "Invited memberships user", email.toUpperCase()],
      );
      const invitations = await client.query<{
        id: string;
        accepted_at: Date | null;
      }>(
        `SELECT "id", "accepted_at"
         FROM "invitations"
         WHERE "id" = ANY($1::uuid[])
         ORDER BY "id"`,
        [[memberInvitationId, adminInvitationId]],
      );
      const memberships = await client.query<{
        organization_id: string;
        role: string;
        status: string;
      }>(
        `SELECT "organization_id", "role", "status"
         FROM "organization_members"
         WHERE "user_id" = $1
         ORDER BY "organization_id"`,
        [userId],
      );

      expect(invitations.rows).toHaveLength(2);
      expect(
        invitations.rows.every(
          (invitation) => invitation.accepted_at instanceof Date,
        ),
      ).toBe(true);
      expect(memberships.rows).toEqual(
        [
          {
            organization_id: memberOrganizationId,
            role: "member",
            status: "active",
          },
          {
            organization_id: adminOrganizationId,
            role: "admin",
            status: "active",
          },
        ].sort((left, right) =>
          left.organization_id.localeCompare(right.organization_id),
        ),
      );
    } finally {
      await rollback(client);
      client.release();
    }
  });

  test("allows an allowlisted user without inventing an organization membership", async () => {
    const client = await openSession(suiteStorage);
    const email = `${randomUUID()}@example.invalid`;
    const userId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "signup_allowlist" ("normalized_email", "status")
         VALUES ($1, 'active')`,
        [email],
      );
      await client.query(
        'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
        [userId, "Allowlisted user", email],
      );
      const memberships = await client.query<{ id: string }>(
        'SELECT "id" FROM "organization_members" WHERE "user_id" = $1',
        [userId],
      );

      expect(memberships.rows).toEqual([]);
    } finally {
      await rollback(client);
      client.release();
    }
  });

  test("denies revoked and expired invitations without accepting or granting either", async () => {
    const client = await openSession(suiteStorage);
    const email = `${randomUUID()}@example.invalid`;
    const userId = randomUUID();
    const revokedOrganizationId = randomUUID();
    const expiredOrganizationId = randomUUID();
    const revokedInvitationId = randomUUID();
    const expiredInvitationId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "organizations" ("id", "name", "slug", "status")
         VALUES
           ($1, 'Revoked invitation organization', $2, 'active'),
           ($3, 'Expired invitation organization', $4, 'active')`,
        [
          revokedOrganizationId,
          `guard-revoked-${randomUUID()}`,
          expiredOrganizationId,
          `guard-expired-${randomUUID()}`,
        ],
      );
      await client.query(
        `INSERT INTO "invitations"
          ("id", "organization_id", "normalized_email", "role", "token_hash",
           "expires_at", "revoked_at", "created_by_user_id")
         VALUES
           ($1, $2, $3, 'member', $4,
             clock_timestamp() + interval '5 minutes', clock_timestamp(), 'guard-test'),
           ($5, $6, $3, 'admin', $7,
             clock_timestamp() - interval '1 second', NULL, 'guard-test')`,
        [
          revokedInvitationId,
          revokedOrganizationId,
          email,
          randomUUID(),
          expiredInvitationId,
          expiredOrganizationId,
          randomUUID(),
        ],
      );
      await client.query("SAVEPOINT signup_attempt");

      const result = await client
        .query(
          'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
          [userId, "Denied invitation user", email],
        )
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      await client.query("ROLLBACK TO SAVEPOINT signup_attempt");
      const invitations = await client.query<{
        accepted_at: Date | null;
      }>(
        'SELECT "accepted_at" FROM "invitations" WHERE "id" = ANY($1::uuid[])',
        [[revokedInvitationId, expiredInvitationId]],
      );
      const memberships = await client.query<{ id: string }>(
        'SELECT "id" FROM "organization_members" WHERE "user_id" = $1',
        [userId],
      );

      expect(signupGuardMarker(result.error)).toEqual(marker);
      expect(invitations.rows).toEqual([
        { accepted_at: null },
        { accepted_at: null },
      ]);
      expect(memberships.rows).toEqual([]);
    } finally {
      await rollback(client);
      client.release();
    }
  });

  test("invitation revocation that locks first denies signup and membership", async () => {
    const revoker = await openSession(suiteStorage);
    const inserter = await openSession(suiteStorage);
    const email = `${randomUUID()}@example.invalid`;
    const userId = randomUUID();
    const organizationId = randomUUID();
    const invitationId = randomUUID();
    await rawQuery(
      suiteStorage,
      `INSERT INTO "organizations" ("id", "name", "slug", "status")
       VALUES ($1, 'Invitation revocation race', $2, 'active')`,
      [organizationId, `guard-revoke-race-${randomUUID()}`],
    );
    await rawQuery(
      suiteStorage,
      `INSERT INTO "invitations"
        ("id", "organization_id", "normalized_email", "role", "token_hash",
         "expires_at", "created_by_user_id")
       VALUES ($1, $2, $3, 'member', $4,
         clock_timestamp() + interval '5 minutes', 'guard-test')`,
      [invitationId, organizationId, email, randomUUID()],
    );

    try {
      await revoker.query("BEGIN");
      await inserter.query("BEGIN");
      await revoker.query(
        'UPDATE "invitations" SET "revoked_at" = clock_timestamp() WHERE "id" = $1',
        [invitationId],
      );

      let insertSettled = false;
      const insertResult = inserter
        .query(
          'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
          [userId, "Invitation race loser", email],
        )
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          insertSettled = true;
        });

      await pauseForLockAttempt();
      expect(insertSettled).toBe(false);
      await revoker.query("COMMIT");

      const result = await insertResult;
      expect(signupGuardMarker(result.error)).toEqual(marker);
      const memberships = await rawQuery<{ id: string }>(
        suiteStorage,
        'SELECT "id" FROM "organization_members" WHERE "user_id" = $1',
        [userId],
      );
      expect(memberships.rows).toEqual([]);
    } finally {
      await rollback(revoker);
      await rollback(inserter);
      revoker.release();
      inserter.release();
      await rawQuery(suiteStorage, 'DELETE FROM "user" WHERE "id" = $1', [
        userId,
      ]);
      await rawQuery(
        suiteStorage,
        'DELETE FROM "organizations" WHERE "id" = $1',
        [organizationId],
      );
    }
  });

  test("an invitation insertion blocked past expiry grants no membership", async () => {
    const blocker = await openSession(suiteStorage);
    const inserter = await openSession(suiteStorage);
    const email = `${randomUUID()}@example.invalid`;
    const userId = randomUUID();
    const organizationId = randomUUID();
    const invitationId = randomUUID();
    await rawQuery(
      suiteStorage,
      `INSERT INTO "organizations" ("id", "name", "slug", "status")
       VALUES ($1, 'Invitation expiry race', $2, 'active')`,
      [organizationId, `guard-expiry-race-${randomUUID()}`],
    );
    await rawQuery(
      suiteStorage,
      `INSERT INTO "invitations"
        ("id", "organization_id", "normalized_email", "role", "token_hash",
         "expires_at", "created_by_user_id")
       VALUES ($1, $2, $3, 'member', $4,
         clock_timestamp() + interval '1 second', 'guard-test')`,
      [invitationId, organizationId, email, randomUUID()],
    );

    try {
      await blocker.query("BEGIN");
      await inserter.query("BEGIN");
      await blocker.query(
        'SELECT "id" FROM "invitations" WHERE "id" = $1 FOR UPDATE',
        [invitationId],
      );

      let insertSettled = false;
      const insertResult = inserter
        .query(
          'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
          [userId, "Expired invitation waiter", email],
        )
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          insertSettled = true;
        });

      await pauseForLockAttempt();
      expect(insertSettled).toBe(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
      await blocker.query("COMMIT");

      const result = await insertResult;
      expect(signupGuardMarker(result.error)).toEqual(marker);
      const memberships = await rawQuery<{ id: string }>(
        suiteStorage,
        'SELECT "id" FROM "organization_members" WHERE "user_id" = $1',
        [userId],
      );
      expect(memberships.rows).toEqual([]);
    } finally {
      await rollback(blocker);
      await rollback(inserter);
      blocker.release();
      inserter.release();
      await rawQuery(suiteStorage, 'DELETE FROM "user" WHERE "id" = $1', [
        userId,
      ]);
      await rawQuery(
        suiteStorage,
        'DELETE FROM "organizations" WHERE "id" = $1',
        [organizationId],
      );
    }
  });

  test("revocation wins when it locks the allowlist row before user insertion", async () => {
    const revoker = await openSession(suiteStorage);
    const inserter = await openSession(suiteStorage);
    const email = `${randomUUID()}@example.invalid`;
    await rawQuery(
      suiteStorage,
      `INSERT INTO "signup_allowlist" ("normalized_email", "status")
       VALUES ($1, 'active')`,
      [email],
    );

    try {
      await revoker.query("BEGIN");
      await inserter.query("BEGIN");
      await revoker.query(
        `UPDATE "signup_allowlist" SET "status" = 'revoked'
         WHERE lower("normalized_email") = $1`,
        [email],
      );

      let insertSettled = false;
      const insertResult = inserter
        .query(
          'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
          [randomUUID(), "Race loser", email],
        )
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          insertSettled = true;
        });

      await pauseForLockAttempt();
      expect(insertSettled).toBe(false);
      await revoker.query("COMMIT");

      const result = await insertResult;
      expect(signupGuardMarker(result.error)).toEqual(marker);
    } finally {
      await rollback(revoker);
      await rollback(inserter);
      revoker.release();
      inserter.release();
      await rawQuery(
        suiteStorage,
        'DELETE FROM "signup_allowlist" WHERE lower("normalized_email") = $1',
        [email],
      );
    }
  });

  test("a blocked insertion rechecks database time after eligibility expires", async () => {
    const blocker = await openSession(suiteStorage);
    const inserter = await openSession(suiteStorage);
    const email = `${randomUUID()}@example.invalid`;
    await rawQuery(
      suiteStorage,
      `INSERT INTO "signup_allowlist"
        ("normalized_email", "status", "expires_at")
       VALUES ($1, 'active', clock_timestamp() + interval '1 second')`,
      [email],
    );

    try {
      await blocker.query("BEGIN");
      await inserter.query("BEGIN");
      await blocker.query(
        `SELECT "id" FROM "signup_allowlist"
         WHERE lower("normalized_email") = $1 FOR UPDATE`,
        [email],
      );

      let insertSettled = false;
      const insertResult = inserter
        .query(
          'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
          [randomUUID(), "Expired while waiting", email],
        )
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          insertSettled = true;
        });

      await pauseForLockAttempt();
      expect(insertSettled).toBe(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
      await blocker.query("COMMIT");

      const result = await insertResult;
      expect(signupGuardMarker(result.error)).toEqual(marker);
    } finally {
      await rollback(blocker);
      await rollback(inserter);
      blocker.release();
      inserter.release();
      await rawQuery(
        suiteStorage,
        'DELETE FROM "signup_allowlist" WHERE lower("normalized_email") = $1',
        [email],
      );
    }
  });

  test("user insertion wins when its share lock precedes revocation", async () => {
    const inserter = await openSession(suiteStorage);
    const revoker = await openSession(suiteStorage);
    const email = `${randomUUID()}@example.invalid`;
    const userId = randomUUID();
    await rawQuery(
      suiteStorage,
      `INSERT INTO "signup_allowlist" ("normalized_email", "status")
       VALUES ($1, 'active')`,
      [email],
    );

    try {
      await inserter.query("BEGIN");
      await revoker.query("BEGIN");
      await inserter.query(
        'INSERT INTO "user" ("id", "name", "email") VALUES ($1, $2, $3)',
        [userId, "Race winner", email],
      );

      let revokeSettled = false;
      const revokeResult = revoker
        .query(
          `UPDATE "signup_allowlist" SET "status" = 'revoked'
           WHERE lower("normalized_email") = $1`,
          [email],
        )
        .finally(() => {
          revokeSettled = true;
        });

      await pauseForLockAttempt();
      expect(revokeSettled).toBe(false);
      await inserter.query("COMMIT");
      await revokeResult;
      await revoker.query("COMMIT");

      const inserted = await rawQuery<{ id: string }>(
        suiteStorage,
        'SELECT "id" FROM "user" WHERE "id" = $1',
        [userId],
      );
      expect(inserted.rows).toEqual([{ id: userId }]);
    } finally {
      await rollback(inserter);
      await rollback(revoker);
      inserter.release();
      revoker.release();
      await rawQuery(suiteStorage, 'DELETE FROM "user" WHERE "id" = $1', [
        userId,
      ]);
      await rawQuery(
        suiteStorage,
        'DELETE FROM "signup_allowlist" WHERE lower("normalized_email") = $1',
        [email],
      );
    }
  });
});
