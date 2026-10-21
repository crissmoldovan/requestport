import {
  BOOTSTRAP_OWNER_ACTOR,
  bootstrapOwner,
  LOCAL_CREDENTIAL_PROVIDER_ID,
  verifyLocalCredential,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  account,
  organizationMembers,
  securityAuditRecords,
  session,
  signupAllowlist,
  user,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import { ensureAppearanceCutover } from "../test-support/appearance-cutover.js";
import type { Tx } from "../transaction.js";
import { createFoundationRepository } from "./foundation-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

afterAll(async () => {
  await suiteStorage.close();
});

/**
 * The local owner credential against the real tables.
 *
 * The domain tests prove the decisions; these prove the rows. In particular
 * that the person is created through the signup-eligibility guard the
 * database enforces on `user`, and that the credential lands in the one place
 * Better Auth's email-and-password sign-in looks: an `account` row with
 * `providerId` "credential" and the hash in `password`.
 */
const timeoutMs = 30_000;

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  try {
    await suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    });
  } catch (error) {
    if (error instanceof TestRollback) return;
    throw error;
  }
  throw new Error("Expected the local credential transaction to roll back");
}

function scenario() {
  return {
    email: `${crypto.randomUUID()}@example.invalid`,
    organizationSlug: `local-owner-${crypto.randomUUID()}`,
    organizationName: "Local owner",
  };
}

const context = () => ({
  actor: BOOTSTRAP_OWNER_ACTOR,
  correlationId: `corr_${crypto.randomUUID()}`,
});

async function credentialRows(tx: Tx, userId: string) {
  return tx
    .select({
      accountId: account.accountId,
      providerId: account.providerId,
      password: account.password,
    })
    .from(account)
    .where(eq(account.userId, userId));
}

describe("bootstrap-owner with a local credential, in PostgreSQL", () => {
  test("creates the person, the credential and the ownership in one run", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const input = scenario();

      const result = await bootstrapOwner(
        createFoundationRepository(tx),
        context(),
        { ...input, localCredential: "issue" },
      );

      if (result.status !== "owner_active" || !result.credential) {
        throw new Error("expected an owner with an issued credential");
      }
      const [person] = await tx
        .select()
        .from(user)
        .where(eq(user.id, result.userId));
      expect(person).toMatchObject({
        email: input.email,
        emailVerified: true,
      });
      const rows = await credentialRows(tx, result.userId);
      expect(rows).toEqual([
        {
          accountId: result.userId,
          providerId: LOCAL_CREDENTIAL_PROVIDER_ID,
          password: expect.stringMatching(/^scrypt\$v1\$/u),
        },
      ]);
      expect(
        await verifyLocalCredential({
          hash: rows[0]?.password ?? "",
          password: result.credential,
        }),
      ).toBe(true);
      expect(
        await tx
          .select({ role: organizationMembers.role })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, result.organizationId),
              eq(organizationMembers.userId, result.userId),
              eq(organizationMembers.status, "active"),
            ),
          ),
      ).toEqual([{ role: "owner" }]);
    });
  });

  test("a retry leaves the credential exactly as it was", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const repository = createFoundationRepository(tx);
      const input = { ...scenario(), localCredential: "issue" as const };

      const first = await bootstrapOwner(repository, context(), input);
      if (first.status !== "owner_active") throw new Error("expected owner");
      const before = await credentialRows(tx, first.userId);
      const retry = await bootstrapOwner(repository, context(), input);

      expect(retry).toMatchObject({ localCredential: "unchanged" });
      expect(await credentialRows(tx, first.userId)).toEqual(before);
    });
  });

  test("rotation replaces the hash in place and deletes every session", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const repository = createFoundationRepository(tx);
      const input = scenario();
      const first = await bootstrapOwner(repository, context(), {
        ...input,
        localCredential: "issue",
      });
      if (first.status !== "owner_active" || !first.credential) {
        throw new Error("expected an issued credential");
      }
      await tx.insert(session).values(
        [1, 2].map((index) => ({
          id: `session_${crypto.randomUUID()}`,
          token: `token_${index}_${crypto.randomUUID()}`,
          userId: first.userId,
          expiresAt: new Date(Date.now() + 60_000),
          updatedAt: new Date(),
        })),
      );

      const rotated = await bootstrapOwner(repository, context(), {
        ...input,
        localCredential: "rotate",
      });

      if (rotated.status !== "owner_active" || !rotated.credential) {
        throw new Error("expected a rotated credential");
      }
      const rows = await credentialRows(tx, first.userId);
      expect(rows).toHaveLength(1);
      const hash = rows[0]?.password ?? "";
      expect(
        await verifyLocalCredential({ hash, password: first.credential }),
      ).toBe(false);
      expect(
        await verifyLocalCredential({ hash, password: rotated.credential }),
      ).toBe(true);
      expect(
        await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(session)
          .where(eq(session.userId, first.userId)),
      ).toEqual([{ count: 0 }]);
      const reasons = await tx
        .select({ reason: securityAuditRecords.reason })
        .from(securityAuditRecords)
        .where(eq(securityAuditRecords.organizationId, rotated.organizationId));
      expect(reasons.map((row) => row.reason).sort()).toEqual([
        "First organization owner activated with a local credential",
        "Local owner credential rotated and sessions revoked",
      ]);
    });
  });

  test("gives a person who signed in through GitHub a credential beside it", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const repository = createFoundationRepository(tx);
      const input = scenario();
      // Stage one allowlists the address, which is what lets the person exist.
      await bootstrapOwner(repository, context(), input);
      const userId = `user_${crypto.randomUUID()}`;
      await tx
        .insert(user)
        .values({ id: userId, name: "GitHub owner", email: input.email });
      await tx.insert(account).values({
        id: `account_${crypto.randomUUID()}`,
        accountId: "12345",
        providerId: "github",
        userId,
        updatedAt: new Date(),
      });

      const result = await bootstrapOwner(repository, context(), {
        ...input,
        localCredential: "issue",
      });

      expect(result).toMatchObject({
        status: "owner_active",
        userId,
        localCredential: "issued",
      });
      expect(
        (await credentialRows(tx, userId)).map((row) => row.providerId).sort(),
      ).toEqual(["credential", "github"]);
    });
  });

  test("rotates and issues for either owner once there are two", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const repository = createFoundationRepository(tx);
      const input = scenario();
      const first = await bootstrapOwner(repository, context(), {
        ...input,
        localCredential: "issue",
      });
      if (first.status !== "owner_active") throw new Error("expected owner");
      // A second owner, as `invite-user --role owner` leaves one once the
      // invitation is accepted: an allowlisted person with an active
      // owner membership and no local credential.
      const secondEmail = `${crypto.randomUUID()}@example.invalid`;
      const secondUserId = `user_${crypto.randomUUID()}`;
      await tx
        .insert(signupAllowlist)
        .values({ normalizedEmail: secondEmail, status: "active" });
      await tx
        .insert(user)
        .values({ id: secondUserId, name: "Second owner", email: secondEmail });
      await tx.insert(organizationMembers).values({
        organizationId: first.organizationId,
        userId: secondUserId,
        role: "owner",
        status: "active",
      });

      const rotated = await bootstrapOwner(repository, context(), {
        ...input,
        localCredential: "rotate",
      });
      const issued = await bootstrapOwner(repository, context(), {
        ...input,
        email: secondEmail,
        localCredential: "issue",
      });

      expect(rotated).toMatchObject({
        status: "owner_active",
        userId: first.userId,
        localCredential: "rotated",
      });
      if (issued.status !== "owner_active" || !issued.credential) {
        throw new Error("expected a credential for the second owner");
      }
      expect(issued.userId).toBe(secondUserId);
      const [row] = await credentialRows(tx, secondUserId);
      expect(
        await verifyLocalCredential({
          hash: row?.password ?? "",
          password: issued.credential,
        }),
      ).toBe(true);
      expect(
        await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(organizationMembers)
          .where(eq(organizationMembers.organizationId, first.organizationId)),
      ).toEqual([{ count: 2 }]);
    });
  });
});
