import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  BOOTSTRAP_OWNER_ACTOR,
  bootstrapOwner,
  createCoreCommandRegistry,
  operatorActor,
  revokeOperatorCredentialCommandName,
  verifyLocalCredential,
} from "@requestport/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import { account } from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import { ensureAppearanceCutover } from "../test-support/appearance-cutover.js";
import {
  endingEachCommandBinding,
  endingEachMethodBinding,
  endTenantBinding,
} from "../test-support/tenant-binding.js";
import type { Tx } from "../transaction.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";
import { createCommandTransactionManager } from "./command-repository.js";
import { createFoundationRepository } from "./foundation-repository.js";
import { createOperatorCredentialRepository } from "./operator-credential-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  Plan 13, F.3, F3-13 (ruling 11): rotating or recovering an owner's local
  credential through `bootstrapOwner` revokes every operator credential that
  person issued, in every organisation, in the rotation's own transaction.
  Done when 8, through the real foundation repository on native PostgreSQL
  (R1). Each refusal is paired with the same call succeeding before the
  rotation. "Refused at authentication" is `resolveApiKeyCredential`
  answering nothing, which is what `authenticateApiBearer` turns into a 401
  (the bearer itself is driven against a rotation in `@requestport/auth`'s
  `operator-bearer.integration.test.ts`); "at command time" is the real bus
  and `assertCurrent` refusing a context authenticated before it.
*/

const timeoutMs = 60_000;

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
  throw new Error("Expected the rotation transaction to roll back");
}

afterAll(async () => {
  await suiteStorage.close();
});

const context = () => ({
  actor: BOOTSTRAP_OWNER_ACTOR,
  correlationId: `corr_${crypto.randomUUID()}`,
});

function scenario() {
  return {
    email: `${crypto.randomUUID()}@example.invalid`,
    organizationSlug: `operator-rotation-${crypto.randomUUID()}`,
    organizationName: "Operator rotation",
  };
}

/**
 * The foundation repository on the case's transaction. `bootstrapOwner` runs
 * in a transaction of its own, which here is a savepoint, and the binding it
 * takes (the organisation it creates or authorises, manifest-i2.md D10)
 * would outlive it; this ends it with each transaction, as the CLI's own
 * transaction ends it (test-support/tenant-binding.ts).
 */
function foundation(tx: Tx) {
  return createFoundationRepository(tx, async (run) => {
    try {
      return await tx.transaction(run);
    } finally {
      await endTenantBinding(tx);
    }
  });
}

/** An owner with a local credential, issued the way the CLI issues one. */
async function seedOwner(tx: Tx) {
  const input = scenario();
  const issued = await bootstrapOwner(foundation(tx), context(), {
    ...input,
    localCredential: "issue",
  });
  if (issued.status !== "owner_active" || !issued.credential) {
    throw new Error("expected an owner with an issued credential");
  }
  return { input, issued, credential: issued.credential };
}

async function seedOrganization(tx: Tx, userId: string, role = "owner") {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Second tenant',
      ${`operator-rotation-second-${organizationId}`}, 'active')
  `);
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, 'active')
  `);
  return organizationId;
}

async function seedUser(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Another member', ${email}, now())
  `);
  return userId;
}

async function issueOperator(
  tx: Tx,
  input: { organizationId: string; userId: string },
) {
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "config_id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, 'requestport-operator', ${input.userId},
      ${`secret_${crypto.randomUUID()}`}, true, now() + interval '30 days',
      now(), now())
  `);
  // Issuance binds the credential's organisation; ended with the call, as
  // the issuing service's own transaction ends it.
  const credential = await endingEachMethodBinding(
    createOperatorCredentialRepository(tx),
    tx,
  ).createCredential({
    organizationId: input.organizationId,
    memberUserId: input.userId,
    projectId: null,
    betterAuthApiKeyId: apiKeyId,
    name: "Rotation",
    prefix: "rpo_rot",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["operator:revoke"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
  return { ...credential, apiKeyId };
}

type Issued = Awaited<ReturnType<typeof issueOperator>>;

/** The context `authenticateApiBearer` built for a credential, before the change. */
function contextFor(credential: Issued): AuthorizedCommandContext {
  return {
    actor: operatorActor({
      lineageId: credential.lineageId,
      memberUserId: credential.memberUserId,
    }),
    credentialKind: "operator",
    organizationId: credential.organizationId,
    projectId: credential.projectId,
    laneIds: new Set(),
    scopes: new Set(credential.scopes),
    credentialId: credential.id,
    correlationId: crypto.randomUUID(),
  };
}

/**
 * The tenant bus, as the web's RequestPort composes it
 * (`createCoreCommandBus`, `@requestport/core`), with the switch on.
 */
function bus(tx: Tx) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    // Each command's binding ends with it, as its own transaction ends it in
    // production (test-support/tenant-binding.ts).
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(
        tx as unknown as Database,
        (name, database) => {
          if (name === "commandAuthorization") {
            return createCommandAuthorizationRepository(database, {
              operatorCredentials: "enabled",
            });
          }
          if (name === "operatorCredentials") {
            return createOperatorCredentialRepository(database);
          }
          return undefined;
        },
      ),
      tx,
    ),
    fingerprintSecret: "operator-rotation-test-fingerprint-0001",
    authorizeContext: (commandContext, uow) =>
      uow
        .port<ReturnType<typeof createCommandAuthorizationRepository>>(
          "commandAuthorization",
        )
        .assertCurrent(commandContext),
  });
}

/** A credential revoking itself: the one command an operator reaches. */
async function revokesItself(tx: Tx, credential: Issued) {
  return bus(tx).execute({
    name: revokeOperatorCredentialCommandName,
    input: {
      organizationId: credential.organizationId,
      credentialId: credential.id,
    },
    context: contextFor(credential),
    meta: {
      idempotencyKey: `idempotency-${crypto.randomUUID()}`,
      expectedVersion: 1,
    },
  });
}

/** Runs `run` and undoes whatever it wrote, keeping only its answer. */
async function probe<T>(tx: Tx, run: () => Promise<T>) {
  await tx.execute(sql`savepoint operator_rotation_probe`);
  try {
    return await run();
  } finally {
    await tx.execute(sql`rollback to savepoint operator_rotation_probe`);
  }
}

async function resolves(tx: Tx, credential: Issued) {
  return createOperatorCredentialRepository(tx).resolveApiKeyCredential({
    apiKeyId: credential.apiKeyId,
  });
}

async function bindingRow(tx: Tx, credential: Issued) {
  const rows = await tx.execute<{
    revoked: boolean;
    version: number;
    enabled: boolean;
  }>(sql`
    select c."revoked_at" is not null as "revoked", c."version",
      k."enabled"
    from "operator_credentials" c
    join "apikey" k on k."id" = c."better_auth_api_key_id"
    where c."id" = ${credential.id}
  `);
  return rows.rows[0];
}

async function storedHash(tx: Tx, userId: string) {
  const [row] = await tx
    .select({ password: account.password })
    .from(account)
    .where(eq(account.userId, userId));
  return row?.password ?? "";
}

describe.sequential("a rotation ends the issuer's operator credentials (F3-13)", () => {
  test("revokes the issuer's credentials in every organisation, at both layers, and no one else's", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const { input, issued } = await seedOwner(tx);
      const named = await issueOperator(tx, {
        organizationId: issued.organizationId,
        userId: issued.userId,
      });
      // The same person owns a second organisation, which the command does
      // not name: the rotated credential is the person's, not the tenant's.
      const elsewhereOrganization = await seedOrganization(tx, issued.userId);
      const elsewhere = await issueOperator(tx, {
        organizationId: elsewhereOrganization,
        userId: issued.userId,
      });
      // Another member of the named organisation, with a credential of their own.
      const otherUser = await seedUser(tx);
      await tx.execute(sql`
        insert into "organization_members"
          ("organization_id", "user_id", "role", "status")
        values (${issued.organizationId}, ${otherUser}, 'admin', 'active')
      `);
      const others = await issueOperator(tx, {
        organizationId: issued.organizationId,
        userId: otherUser,
      });

      // Before the rotation, every one of them authenticates and runs.
      for (const credential of [named, elsewhere, others]) {
        await expect(resolves(tx, credential)).resolves.not.toBeNull();
        await expect(
          probe(tx, () => revokesItself(tx, credential)),
        ).resolves.toMatchObject({ revoked: true });
      }

      const correlation = context();
      const rotated = await bootstrapOwner(foundation(tx), correlation, {
        ...input,
        localCredential: "rotate",
      });
      expect(rotated).toMatchObject({
        status: "owner_active",
        localCredential: "rotated",
      });

      for (const credential of [named, elsewhere]) {
        await expect(resolves(tx, credential)).resolves.toBeNull();
        await expect(revokesItself(tx, credential)).rejects.toMatchObject({
          code: "forbidden",
        });
        await expect(bindingRow(tx, credential)).resolves.toEqual({
          revoked: true,
          version: 2,
          enabled: false,
        });
      }
      await expect(resolves(tx, others)).resolves.not.toBeNull();
      await expect(bindingRow(tx, others)).resolves.toEqual({
        revoked: false,
        version: 1,
        enabled: true,
      });

      // One audit row per revoked credential, in that credential's own
      // organisation, with the bootstrap's system actor and its correlation.
      const revocations = await tx.execute(sql`
        select "organization_id", "actor_type", "actor_id", "target_id"
        from "security_audit_records"
        where "action" = 'operator.credential_revoked'
          and "correlation_id" = ${correlation.correlationId}
        order by "organization_id", "target_id"
      `);
      expect(revocations.rows).toEqual(
        [
          {
            organization_id: issued.organizationId,
            actor_type: "system",
            actor_id: "bootstrap-owner-cli",
            target_id: named.id,
          },
          {
            organization_id: elsewhereOrganization,
            actor_type: "system",
            actor_id: "bootstrap-owner-cli",
            target_id: elsewhere.id,
          },
        ].sort((left, right) =>
          `${left.organization_id}${left.target_id}`.localeCompare(
            `${right.organization_id}${right.target_id}`,
          ),
        ),
      );
      // The bootstrap's own row is as it was before F.3.
      const bootstrapRows = await tx.execute(sql`
        select "actor_type", "actor_id", "reason", "field_names"
        from "security_audit_records"
        where "action" = 'organization.owner_bootstrapped'
          and "correlation_id" = ${correlation.correlationId}
      `);
      expect(bootstrapRows.rows).toEqual([
        {
          actor_type: "system",
          actor_id: "bootstrap-owner-cli",
          reason: "Local owner credential rotated and sessions revoked",
          field_names: ["localCredential", "sessions"],
        },
      ]);
    });
  });

  test("an issue, and an issue that finds a credential already there, revoke nothing", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const { input, issued } = await seedOwner(tx);
      const credential = await issueOperator(tx, {
        organizationId: issued.organizationId,
        userId: issued.userId,
      });

      const retry = await bootstrapOwner(foundation(tx), context(), {
        ...input,
        localCredential: "issue",
      });
      expect(retry).toMatchObject({ localCredential: "unchanged" });
      await expect(resolves(tx, credential)).resolves.not.toBeNull();

      // The same person made owner of a fresh organisation by an issue: the
      // person is found, and their credential is left alone.
      const fresh = await bootstrapOwner(foundation(tx), context(), {
        email: input.email,
        organizationSlug: `operator-rotation-fresh-${crypto.randomUUID()}`,
        organizationName: "Fresh tenant",
        localCredential: "issue",
      });
      expect(fresh).toMatchObject({
        status: "owner_active",
        userId: issued.userId,
        localCredential: "unchanged",
      });
      await expect(resolves(tx, credential)).resolves.not.toBeNull();
      await expect(bindingRow(tx, credential)).resolves.toEqual({
        revoked: false,
        version: 1,
        enabled: true,
      });
    });
  });

  test("revokes with operator credentials switched off, which gates use, not revocation (F3-14)", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const { input, issued } = await seedOwner(tx);
      const credential = await issueOperator(tx, {
        organizationId: issued.organizationId,
        userId: issued.userId,
      });
      await expect(
        createOperatorCredentialRepository(tx).availability({
          enabled: false,
          reason: "switched-off",
        }),
      ).resolves.toEqual({ available: false, reason: "switched-off" });

      await bootstrapOwner(foundation(tx), context(), {
        ...input,
        localCredential: "rotate",
      });

      await expect(bindingRow(tx, credential)).resolves.toEqual({
        revoked: true,
        version: 2,
        enabled: false,
      });
    });
  });

  test("completes, revoking nothing, while the table does not exist (R2 rule 1)", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const { input, issued, credential } = await seedOwner(tx);
      // Renamed rather than dropped: a drop also takes ACCESS EXCLUSIVE on
      // apikey, organizations, projects and user, which deadlocked suites the
      // gate runs beside this one on the same database. `to_regclass` finds
      // no `operator_credentials` either way, and the rollback restores it.
      await tx.execute(
        sql`alter table "operator_credentials" rename to "operator_credentials_absent"`,
      );

      const correlation = context();
      const rotated = await bootstrapOwner(foundation(tx), correlation, {
        ...input,
        localCredential: "rotate",
      });
      if (rotated.status !== "owner_active" || !rotated.credential) {
        throw new Error("expected a rotated credential");
      }
      const hash = await storedHash(tx, issued.userId);
      expect(await verifyLocalCredential({ hash, password: credential })).toBe(
        false,
      );
      expect(
        await verifyLocalCredential({ hash, password: rotated.credential }),
      ).toBe(true);
      const rows = await tx.execute(sql`
        select "action", "reason", "field_names"
        from "security_audit_records"
        where "correlation_id" = ${correlation.correlationId}
      `);
      expect(rows.rows).toEqual([
        {
          action: "organization.owner_bootstrapped",
          reason: "Local owner credential rotated and sessions revoked",
          field_names: ["localCredential", "sessions"],
        },
      ]);
    });
  });

  test("rolls the rotation back, old credential intact, for a caller row-level security applies to (F3-15)", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureAppearanceCutover(tx);
      const { input, issued, credential } = await seedOwner(tx);
      const operator = await issueOperator(tx, {
        organizationId: issued.organizationId,
        userId: issued.userId,
      });
      const role = `f3_rotation_${crypto.randomUUID().replaceAll("-", "")}`;
      // BYPASSRLS for the positive control; taken away below, so the refusal
      // is the same role's once row-level security applies to it.
      await tx.execute(sql.raw(`create role "${role}" nologin bypassrls`));
      await tx.execute(sql.raw(`grant usage on schema public to "${role}"`));
      await tx.execute(
        sql.raw(
          `grant select, insert, update, delete on all tables in schema public to "${role}"`,
        ),
      );
      // I.2's policies call the binding readers, so the role may reach them;
      // bound to the owner's organisation, every statement of the rotation
      // before the revocation is admitted, and the guard is what refuses.
      await tx.execute(
        sql.raw(`grant usage on schema requestport_private to "${role}"`),
      );
      await tx.execute(
        sql.raw(
          `grant execute on function requestport_private.bound_organization_id(), requestport_private.bound_user_id() to "${role}"`,
        ),
      );
      const rotateAsRole = async () => {
        await tx.execute(sql.raw(`set local role "${role}"`));
        try {
          return await bootstrapOwner(foundation(tx), context(), {
            ...input,
            localCredential: "rotate",
          });
        } finally {
          await tx.execute(sql`reset role`);
        }
      };

      // The positive control: the same role, while row-level security does
      // not apply to it, rotates and revokes.
      await expect(probe(tx, rotateAsRole)).resolves.toMatchObject({
        localCredential: "rotated",
      });

      // I.2's expand migration enabled row security on the table; this case
      // does not change the table, only whether it applies to the role.
      const enabled = await tx.execute<{ enabled: boolean }>(sql`
        select relrowsecurity as "enabled" from pg_catalog.pg_class
        where oid = 'public.operator_credentials'::regclass
      `);
      expect(enabled.rows[0]?.enabled).toBe(true);
      await tx.execute(sql.raw(`alter role "${role}" nobypassrls`));
      await tx.execute(sql`
        select pg_catalog.set_config('requestport.organization_id', ${issued.organizationId}, true),
               pg_catalog.set_config('requestport.user_id', ${issued.userId}, true)
      `);
      await expect(probe(tx, rotateAsRole)).rejects.toMatchObject({
        code: "configuration_error",
      });

      // Nothing the failed rotation wrote survived it: the old local
      // credential still verifies, and the operator credential is live.
      expect(
        await verifyLocalCredential({
          hash: await storedHash(tx, issued.userId),
          password: credential,
        }),
      ).toBe(true);
      await expect(bindingRow(tx, operator)).resolves.toEqual({
        revoked: false,
        version: 1,
        enabled: true,
      });
    });
  });
});
