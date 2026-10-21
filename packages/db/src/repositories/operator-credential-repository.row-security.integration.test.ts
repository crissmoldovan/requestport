import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { revokeOperatorCredentialsIssuedBy } from "./operator-credential-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  Plan 13, F.3 (F3-15, ruling 47). F.3's migration landed before I.2's step 1,
  and I.2's expand migration (0019) enables row-level security on
  `operator_credentials` with its tenant policy; the policy's own cases are in
  `row-security.integration.test.ts`. This file holds the guard's. The guard:
  revoking by issuer runs across organisations, so under row-level security it
  would silently revoke only what the caller's binding shows. It refuses
  instead, and the rotation around it rolls back. Neither case alters the
  table: each asserts that the migration enabled row security, and whether it
  applies is decided by the caller's role (BYPASSRLS or not).
*/

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
}

async function seedIssuedCredential(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Row security issuer', ${email}, now())
  `);
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Row security tenant',
      ${`row-security-${organizationId}`}, 'active')
  `);
  const credentialId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "operator_credentials"
      ("id", "organization_id", "member_user_id", "lineage_id", "name",
       "prefix", "fingerprint", "scopes", "expires_at")
    values (${credentialId}, ${organizationId}, ${userId}, ${credentialId},
      'Row security', 'rpo_rls', ${`fingerprint_${crypto.randomUUID()}`},
      '[]'::jsonb, now() + interval '1 day')
  `);
  return { userId, credentialId };
}

async function revokedAt(tx: Tx, credentialId: string) {
  const row = await tx.execute<{ revoked: boolean }>(sql`
    select "revoked_at" is not null as "revoked"
    from "operator_credentials" where "id" = ${credentialId}
  `);
  return row.rows[0]?.revoked;
}

const bootstrapActor = {
  actorType: "system" as const,
  actorId: "bootstrap-owner-cli",
};

/** The migration enabled it; no case here changes the table. */
async function expectRowSecurityEnabled(tx: Tx) {
  const row = await tx.execute<{ enabled: boolean }>(sql`
    select relrowsecurity as "enabled" from pg_catalog.pg_class
    where oid = 'public.operator_credentials'::regclass
  `);
  expect(row.rows[0]?.enabled).toBe(true);
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("revoking by issuer under row-level security (F3-15)", () => {
  test("revokes for a caller row-level security does not apply to", async () => {
    await inRollbackTransaction(async (tx) => {
      const { userId, credentialId } = await seedIssuedCredential(tx);
      // Enabled but not forced: the table's owner still bypasses it, as the
      // CLI's owner connection does.
      await expectRowSecurityEnabled(tx);
      await expect(
        revokeOperatorCredentialsIssuedBy(tx, {
          userId,
          actor: bootstrapActor,
          correlationId: "correlation-f3-15-owner",
        }),
      ).resolves.toBe(1);
      await expect(revokedAt(tx, credentialId)).resolves.toBe(true);
    });
  });

  test("refuses, revoking nothing, for a caller row-level security applies to", async () => {
    await inRollbackTransaction(async (tx) => {
      const control = await seedIssuedCredential(tx);
      const guarded = await seedIssuedCredential(tx);
      const role = `f3_rls_${crypto.randomUUID().replaceAll("-", "")}`;
      // BYPASSRLS for the positive control; taken away below, so the refusal
      // is the same role's once row-level security applies to it.
      await tx.execute(sql.raw(`create role "${role}" nologin bypassrls`));
      // Explicit, because a local reset recreates public with no grant to
      // PUBLIC (track-i2.md, I.2.1 P9).
      await tx.execute(sql.raw(`grant usage on schema public to "${role}"`));
      await tx.execute(
        sql.raw(`grant select, update on "operator_credentials" to "${role}"`),
      );
      await tx.execute(sql.raw(`grant update on "apikey" to "${role}"`));
      await tx.execute(
        sql.raw(`grant insert on "security_audit_records" to "${role}"`),
      );

      await expectRowSecurityEnabled(tx);
      // The positive control: the same role, while row-level security does
      // not apply to it, revokes.
      await tx.execute(sql`savepoint as_role_without_rls`);
      await tx.execute(sql.raw(`set local role "${role}"`));
      await expect(
        revokeOperatorCredentialsIssuedBy(tx, {
          userId: control.userId,
          actor: bootstrapActor,
          correlationId: "correlation-f3-15-control",
        }),
      ).resolves.toBe(1);
      await tx.execute(sql`release savepoint as_role_without_rls`);
      await tx.execute(sql`reset role`);
      await expect(revokedAt(tx, control.credentialId)).resolves.toBe(true);

      await tx.execute(sql.raw(`alter role "${role}" nobypassrls`));
      await tx.execute(sql`savepoint as_tenant_role`);
      await tx.execute(sql.raw(`set local role "${role}"`));
      await expect(
        revokeOperatorCredentialsIssuedBy(tx, {
          userId: guarded.userId,
          actor: bootstrapActor,
          correlationId: "correlation-f3-15-tenant",
        }),
      ).rejects.toMatchObject({ code: "configuration_error" });

      await tx.execute(sql`rollback to savepoint as_tenant_role`);
      await expect(revokedAt(tx, guarded.credentialId)).resolves.toBe(false);
    });
  });
});
