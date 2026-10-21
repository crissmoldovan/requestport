import { operatorExcludedScopes } from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import { endingEachMethodBinding } from "../test-support/tenant-binding.js";
import type { Tx } from "../transaction.js";
import {
  createOperatorCredentialRepository,
  revokeOperatorCredentialsIssuedBy,
} from "./operator-credential-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  Plan 13, F.3: the operator credential's repository on native PostgreSQL
  (R1). Every case runs in a transaction that is rolled back, and every
  negative is paired with the identical call succeeding first: a detector that
  cannot fire proves nothing.
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

const on = { enabled: true } as const;

/**
 * The repository on the case's transaction. Its methods bind the
 * credential's organisation (manifest-i2.md §2.3), and a case here works in
 * several organisations on one transaction, so each call's binding is ended
 * as its own transaction would end it (test-support/tenant-binding.ts).
 */
function operatorRepository(tx: Tx) {
  return endingEachMethodBinding(createOperatorCredentialRepository(tx), tx);
}

async function seedUser(tx: Tx, label: string) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, ${label}, ${email}, now())
  `);
  return userId;
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Operator tenant',
      ${`operator-${organizationId}`}, 'active')
  `);
  return organizationId;
}

async function seedMember(
  tx: Tx,
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member",
) {
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, 'active')
  `);
}

async function seedProject(tx: Tx, organizationId: string) {
  const projectId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "projects"
      ("id", "organization_id", "name", "slug", "key_prefix", "status")
    values (${projectId}, ${organizationId}, 'Operator project',
      ${`project-${projectId}`}, ${`OP${projectId.slice(0, 6)}`}, 'active')
  `);
  return projectId;
}

async function seedProjectMember(
  tx: Tx,
  organizationId: string,
  projectId: string,
  userId: string,
  role: "maintainer" | "contributor",
) {
  await tx.execute(sql`
    insert into "project_members"
      ("organization_id", "project_id", "user_id", "role", "status")
    values (${organizationId}, ${projectId}, ${userId}, ${role}, 'active')
  `);
}

async function seedApiKey(
  tx: Tx,
  userId: string,
  configId = "requestport-operator",
) {
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "config_id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, ${configId}, ${userId},
      ${`secret_${crypto.randomUUID()}`}, true, now() + interval '30 days',
      now(), now())
  `);
  return apiKeyId;
}

/** An owner, an organisation, and a live organisation-wide credential. */
async function seedCredential(
  tx: Tx,
  options: {
    role?: "owner" | "admin" | "member";
    project?: "maintainer" | "contributor" | "owner";
    scopes?: string[];
    configId?: string;
  } = {},
) {
  const userId = await seedUser(tx, "Operator issuer");
  const organizationId = await seedOrganization(tx);
  const role =
    options.project === "owner"
      ? "owner"
      : options.project
        ? "member"
        : (options.role ?? "owner");
  await seedMember(tx, organizationId, userId, role);
  let projectId: string | null = null;
  if (options.project) {
    projectId = await seedProject(tx, organizationId);
    if (options.project !== "owner") {
      await seedProjectMember(
        tx,
        organizationId,
        projectId,
        userId,
        options.project,
      );
    }
  }
  const apiKeyId = await seedApiKey(tx, userId, options.configId);
  const repository = operatorRepository(tx);
  const credential = await repository.createCredential({
    organizationId,
    memberUserId: userId,
    projectId,
    betterAuthApiKeyId: apiKeyId,
    name: "CI deploy",
    prefix: "rpo_abc",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: options.scopes ?? ["operator:revoke"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
  return {
    userId,
    organizationId,
    projectId,
    apiKeyId,
    credential,
    repository,
  };
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("operator credential availability (F3-14)", () => {
  test("is on only with the switch on and the table present", async () => {
    await inRollbackTransaction(async (tx) => {
      const repository = operatorRepository(tx);
      await expect(repository.availability(on)).resolves.toEqual({
        available: true,
      });
      await expect(
        repository.availability({ enabled: false, reason: "switched-off" }),
      ).resolves.toEqual({ available: false, reason: "switched-off" });
      await expect(
        repository.availability({
          enabled: false,
          reason: "change-password-mounted",
        }),
      ).resolves.toEqual({
        available: false,
        reason: "change-password-mounted",
      });

      // Renamed rather than dropped: a drop also takes ACCESS EXCLUSIVE on
      // apikey, organizations, projects and user, which deadlocked suites the
      // gate runs beside this one on the same database. `to_regclass` finds
      // no `operator_credentials` either way, and the rollback restores it.
      await tx.execute(
        sql`alter table "operator_credentials" rename to "operator_credentials_absent"`,
      );
      await expect(repository.availability(on)).resolves.toEqual({
        available: false,
        reason: "not-migrated",
      });
    });
  });
});

describe.sequential("issuing an operator credential", () => {
  test("binds a key for an owner, with the lineage as its own id, and audits it", async () => {
    await inRollbackTransaction(async (tx) => {
      const { credential, organizationId, userId } = await seedCredential(tx);

      expect(credential).toMatchObject({
        organizationId,
        memberUserId: userId,
        projectId: null,
        scopes: ["operator:revoke"],
        version: 1,
      });
      expect(credential.lineageId).toBe(credential.id);
      const audit = await tx.execute(sql`
        select "actor_type", "actor_id", "action", "target_type"
        from "security_audit_records"
        where "organization_id" = ${organizationId}
          and "target_id" = ${credential.id}
      `);
      expect(audit.rows).toEqual([
        {
          actor_type: "user",
          actor_id: userId,
          action: "operator.credential_issued",
          target_type: "operator_credential",
        },
      ]);
    });
  });

  test("admits an admin and a project maintainer, and refuses a member and a contributor", async () => {
    await inRollbackTransaction(async (tx) => {
      await expect(seedCredential(tx, { role: "admin" })).resolves.toBeTruthy();
      await expect(
        seedCredential(tx, { project: "maintainer" }),
      ).resolves.toBeTruthy();
      await expect(
        seedCredential(tx, { role: "member" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        seedCredential(tx, { project: "contributor" }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  test("refuses a scope outside the allow-list before writing anything", async () => {
    await inRollbackTransaction(async (tx) => {
      await expect(
        seedCredential(tx, { scopes: ["operator:revoke"] }),
      ).resolves.toBeTruthy();
      for (const scope of ["request:read", ...operatorExcludedScopes]) {
        await expect(
          seedCredential(tx, { scopes: [scope] }),
        ).rejects.toMatchObject({ code: "validation_failed" });
      }
    });
  });

  test("the table's CHECK refuses each excluded scope and an expiry beyond 90 days on its own", async () => {
    await inRollbackTransaction(async (tx) => {
      const { credential } = await seedCredential(tx);
      const insertWith = async (scopes: string[], days: number) => {
        await tx.execute(sql`savepoint check_case`);
        try {
          await tx.execute(sql`
            insert into "operator_credentials"
              ("id", "organization_id", "member_user_id", "lineage_id",
               "name", "prefix", "fingerprint", "scopes", "expires_at")
            values (${crypto.randomUUID()}, ${credential.organizationId},
              ${credential.memberUserId}, ${crypto.randomUUID()}, 'raw',
              'rpo_raw', ${`fingerprint_${crypto.randomUUID()}`},
              ${JSON.stringify(scopes)}::jsonb,
              now() + make_interval(days => ${days}))
          `);
          await tx.execute(sql`release savepoint check_case`);
          return "inserted";
        } catch (error) {
          await tx.execute(sql`rollback to savepoint check_case`);
          const cause = (error as { cause?: { constraint?: string } }).cause;
          return (
            cause?.constraint ??
            (error as { constraint?: string }).constraint ??
            String(error)
          );
        }
      };

      await expect(insertWith(["operator:revoke"], 90)).resolves.toBe(
        "inserted",
      );
      for (const scope of operatorExcludedScopes) {
        await expect(insertWith(["operator:revoke", scope], 30)).resolves.toBe(
          "operator_credentials_scopes_check",
        );
      }
      await expect(insertWith(["operator:revoke"], 91)).resolves.toBe(
        "operator_credentials_expiry_check",
      );
    });
  });
});

describe.sequential("resolving an operator key (F3-11, F3-3)", () => {
  test("resolves a live key to its binding, and stamps its use", async () => {
    await inRollbackTransaction(async (tx) => {
      const { apiKeyId, credential, repository } = await seedCredential(tx);

      const resolved = await repository.resolveApiKeyCredential({ apiKeyId });
      expect(resolved).toEqual({
        credentialId: credential.id,
        lineageId: credential.lineageId,
        organizationId: credential.organizationId,
        memberUserId: credential.memberUserId,
        projectId: null,
        scopes: ["operator:revoke"],
        // No expiry: the definer lookup returns none, and refused an expired
        // credential already (manifest-i2.md §2.1, F3-15's first path).
        credentialFingerprint: credential.fingerprint,
      });

      await repository.touchCredential(
        credential.id,
        credential.organizationId,
      );
      const touched = await tx.execute(sql`
        select "last_used_at" is not null as "touched"
        from "operator_credentials" where "id" = ${credential.id}
      `);
      expect(touched.rows[0]).toEqual({ touched: true });
    });
  });

  const negatives: Array<
    [
      string,
      Parameters<typeof seedCredential>[1],
      (
        tx: Tx,
        seeded: Awaited<ReturnType<typeof seedCredential>>,
      ) => Promise<void>,
    ]
  > = [
    [
      "the issuer's membership revoked",
      {},
      async (tx, { organizationId, userId }) => {
        await tx.execute(sql`
          update "organization_members" set "status" = 'revoked'
          where "organization_id" = ${organizationId} and "user_id" = ${userId}
        `);
      },
    ],
    [
      "the organisation suspended",
      {},
      async (tx, { organizationId }) => {
        await tx.execute(sql`
          update "organizations" set "status" = 'suspended'
          where "id" = ${organizationId}
        `);
      },
    ],
    [
      "the organisation archived",
      {},
      async (tx, { organizationId }) => {
        await tx.execute(sql`
          update "organizations" set "status" = 'archived'
          where "id" = ${organizationId}
        `);
      },
    ],
    [
      "an admin demoted to member, for an organisation-wide credential",
      { role: "admin" },
      async (tx, { organizationId, userId }) => {
        await tx.execute(sql`
          update "organization_members" set "role" = 'member'
          where "organization_id" = ${organizationId} and "user_id" = ${userId}
        `);
      },
    ],
    [
      "a maintainer removed, for a project-bound credential",
      { project: "maintainer" },
      async (tx, { organizationId, userId }) => {
        await tx.execute(sql`
          update "project_members" set "status" = 'revoked'
          where "organization_id" = ${organizationId} and "user_id" = ${userId}
        `);
      },
    ],
    [
      "the bound project archived",
      { project: "owner" },
      async (tx, { organizationId, projectId }) => {
        await tx.execute(sql`
          update "projects" set "status" = 'archived'
          where "organization_id" = ${organizationId} and "id" = ${projectId}
        `);
      },
    ],
    [
      "the binding revoked",
      {},
      async (tx, { credential }) => {
        await tx.execute(sql`
          update "operator_credentials" set "revoked_at" = now()
          where "id" = ${credential.id}
        `);
      },
    ],
    [
      "the binding expired",
      {},
      async (tx, { credential }) => {
        await tx.execute(sql`
          update "operator_credentials"
          set "created_at" = now() - interval '2 days',
              "expires_at" = now() - interval '1 second'
          where "id" = ${credential.id}
        `);
      },
    ],
    [
      "the plugin key disabled",
      {},
      async (tx, { apiKeyId }) => {
        await tx.execute(sql`
          update "apikey" set "enabled" = false where "id" = ${apiKeyId}
        `);
      },
    ],
    [
      "the plugin key expired",
      {},
      async (tx, { apiKeyId }) => {
        await tx.execute(sql`
          update "apikey" set "expires_at" = now() - interval '1 second'
          where "id" = ${apiKeyId}
        `);
      },
    ],
    [
      "the plugin key's expiry cleared",
      {},
      async (tx, { apiKeyId }) => {
        await tx.execute(sql`
          update "apikey" set "expires_at" = null where "id" = ${apiKeyId}
        `);
      },
    ],
    [
      "the plugin key deleted (the binding's reference becomes null)",
      {},
      async (tx, { apiKeyId }) => {
        await tx.execute(sql`delete from "apikey" where "id" = ${apiKeyId}`);
      },
    ],
    [
      "the key moved to the agent configuration",
      {},
      async (tx, { apiKeyId }) => {
        await tx.execute(sql`
          update "apikey" set "config_id" = 'requestport-agent'
          where "id" = ${apiKeyId}
        `);
      },
    ],
  ];

  test.each(negatives)(
    "refuses a key after %s",
    async (_label, options, change) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedCredential(tx, options);
        await expect(
          seeded.repository.resolveApiKeyCredential({
            apiKeyId: seeded.apiKeyId,
          }),
        ).resolves.toMatchObject({ credentialId: seeded.credential.id });

        await change(tx, seeded);

        await expect(
          seeded.repository.resolveApiKeyCredential({
            apiKeyId: seeded.apiKeyId,
          }),
        ).resolves.toBeNull();
      });
    },
  );

  test("keeps the binding when its key is deleted, with the reference null", async () => {
    await inRollbackTransaction(async (tx) => {
      const { apiKeyId, credential } = await seedCredential(tx);
      await tx.execute(sql`delete from "apikey" where "id" = ${apiKeyId}`);
      const row = await tx.execute(sql`
        select "better_auth_api_key_id" from "operator_credentials"
        where "id" = ${credential.id}
      `);
      expect(row.rows).toEqual([{ better_auth_api_key_id: null }]);
    });
  });

  test("resolves nothing for a key with no binding", async () => {
    await inRollbackTransaction(async (tx) => {
      const { userId, repository } = await seedCredential(tx);
      const unbound = await seedApiKey(tx, userId);
      await expect(
        repository.resolveApiKeyCredential({ apiKeyId: unbound }),
      ).resolves.toBeNull();
    });
  });
});

describe.sequential("revoking an operator credential", () => {
  test("sets revoked_at, moves the version, disables the key and audits the actor it is given", async () => {
    await inRollbackTransaction(async (tx) => {
      const { apiKeyId, credential, repository } = await seedCredential(tx);
      const lineageActor = `operator:${credential.lineageId}`;

      await expect(
        repository.revokeCredential({
          organizationId: credential.organizationId,
          credentialId: credential.id,
          expectedVersion: 1,
          actor: { actorType: "service", actorId: lineageActor },
          reason: "An operator credential was revoked",
          correlationId: "correlation-f3-revoke",
        }),
      ).resolves.toEqual({ id: credential.id, revoked: true, version: 2 });

      const rows = await tx.execute(sql`
        select c."revoked_at" is not null as "revoked", c."version",
          k."enabled"
        from "operator_credentials" c
        join "apikey" k on k."id" = c."better_auth_api_key_id"
        where c."id" = ${credential.id}
      `);
      expect(rows.rows).toEqual([
        { revoked: true, version: 2, enabled: false },
      ]);
      const audit = await tx.execute(sql`
        select "actor_type", "actor_id", "action"
        from "security_audit_records"
        where "target_id" = ${credential.id}
          and "action" = 'operator.credential_revoked'
      `);
      expect(audit.rows).toEqual([
        {
          actor_type: "service",
          actor_id: lineageActor,
          action: "operator.credential_revoked",
        },
      ]);
      await expect(
        repository.resolveApiKeyCredential({ apiKeyId }),
      ).resolves.toBeNull();
    });
  });

  test("refuses a stale version and a second revocation", async () => {
    await inRollbackTransaction(async (tx) => {
      const { credential, repository } = await seedCredential(tx);
      const revoke = (expectedVersion: number) =>
        repository.revokeCredential({
          organizationId: credential.organizationId,
          credentialId: credential.id,
          expectedVersion,
          actor: { actorType: "user", actorId: credential.memberUserId },
          reason: "An operator credential was revoked",
          correlationId: "correlation-f3-stale",
        });
      await expect(revoke(2)).rejects.toMatchObject({
        code: "version_conflict",
      });
      await expect(revoke(1)).resolves.toMatchObject({ version: 2 });
      await expect(revoke(2)).rejects.toMatchObject({
        code: "version_conflict",
      });
    });
  });

  test("finds no credential of another organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const first = await seedCredential(tx);
      const second = await seedCredential(tx);
      await expect(
        first.repository.lockCredential({
          organizationId: first.organizationId,
          credentialId: first.credential.id,
        }),
      ).resolves.toMatchObject({ id: first.credential.id });
      await expect(
        first.repository.lockCredential({
          organizationId: first.organizationId,
          credentialId: second.credential.id,
        }),
      ).resolves.toBeNull();
    });
  });
});

describe.sequential("revoking every credential a member issued (F3-13)", () => {
  test("revokes the issuer's live credentials in every organisation, and no one else's", async () => {
    await inRollbackTransaction(async (tx) => {
      const first = await seedCredential(tx);
      // The same person, owner of a second organisation.
      const secondOrganization = await seedOrganization(tx);
      await seedMember(tx, secondOrganization, first.userId, "owner");
      const secondKey = await seedApiKey(tx, first.userId);
      const second = await first.repository.createCredential({
        organizationId: secondOrganization,
        memberUserId: first.userId,
        projectId: null,
        betterAuthApiKeyId: secondKey,
        name: "Second tenant",
        prefix: "rpo_def",
        fingerprint: `fingerprint_${crypto.randomUUID()}`,
        scopes: [],
        expiresInDays: 30,
        correlationId: crypto.randomUUID(),
      });
      // Another member of the first organisation, with their own credential.
      const otherUser = await seedUser(tx, "Other member");
      await seedMember(tx, first.organizationId, otherUser, "admin");
      const otherKey = await seedApiKey(tx, otherUser);
      await first.repository.createCredential({
        organizationId: first.organizationId,
        memberUserId: otherUser,
        projectId: null,
        betterAuthApiKeyId: otherKey,
        name: "Other member's",
        prefix: "rpo_ghi",
        fingerprint: `fingerprint_${crypto.randomUUID()}`,
        scopes: [],
        expiresInDays: 30,
        correlationId: crypto.randomUUID(),
      });

      for (const apiKeyId of [first.apiKeyId, secondKey, otherKey]) {
        await expect(
          first.repository.resolveApiKeyCredential({ apiKeyId }),
        ).resolves.not.toBeNull();
      }

      await expect(
        revokeOperatorCredentialsIssuedBy(tx, {
          userId: first.userId,
          actor: { actorType: "system", actorId: "bootstrap-owner-cli" },
          correlationId: "correlation-f3-13",
        }),
      ).resolves.toBe(2);

      for (const apiKeyId of [first.apiKeyId, secondKey]) {
        await expect(
          first.repository.resolveApiKeyCredential({ apiKeyId }),
        ).resolves.toBeNull();
      }
      await expect(
        first.repository.resolveApiKeyCredential({ apiKeyId: otherKey }),
      ).resolves.not.toBeNull();
      const audit = await tx.execute(sql`
        select "organization_id", "actor_type", "target_id"
        from "security_audit_records"
        where "action" = 'operator.credential_revoked'
          and "correlation_id" = 'correlation-f3-13'
        order by "organization_id"
      `);
      expect(audit.rows).toEqual(
        [
          {
            organization_id: first.organizationId,
            actor_type: "system",
            target_id: first.credential.id,
          },
          {
            organization_id: secondOrganization,
            actor_type: "system",
            target_id: second.id,
          },
        ].sort((a, b) => a.organization_id.localeCompare(b.organization_id)),
      );
      // Already revoked: a second pass revokes nothing and writes nothing.
      await expect(
        revokeOperatorCredentialsIssuedBy(tx, {
          userId: first.userId,
          actor: { actorType: "system", actorId: "bootstrap-owner-cli" },
          correlationId: "correlation-f3-13-again",
        }),
      ).resolves.toBe(0);
    });
  });

  test("revokes nothing, and does not fail, while the table does not exist", async () => {
    await inRollbackTransaction(async (tx) => {
      const userId = await seedUser(tx, "Before the migration");
      // Renamed rather than dropped: a drop also takes ACCESS EXCLUSIVE on
      // apikey, organizations, projects and user, which deadlocked suites the
      // gate runs beside this one on the same database. `to_regclass` finds
      // no `operator_credentials` either way, and the rollback restores it.
      await tx.execute(
        sql`alter table "operator_credentials" rename to "operator_credentials_absent"`,
      );
      await expect(
        revokeOperatorCredentialsIssuedBy(tx, {
          userId,
          actor: { actorType: "system", actorId: "bootstrap-owner-cli" },
          correlationId: "correlation-f3-13-absent",
        }),
      ).resolves.toBe(0);
    });
  });
});

async function seedSession(
  tx: Tx,
  userId: string,
  expiresAt = "now() + interval '1 hour'",
) {
  const sessionId = `session_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "session" ("id", "token", "user_id", "expires_at", "updated_at")
    values (${sessionId}, ${`token_${crypto.randomUUID()}`}, ${userId},
      ${sql.raw(expiresAt)}, now())
  `);
  return sessionId;
}

const fingerprintSecret = "operator-issuance-test-fingerprint-00001";

function issuanceRequest(
  seeded: { userId: string; organizationId: string },
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    actorUserId: seeded.userId,
    sessionId,
    organizationId: seeded.organizationId,
    projectId: null,
    commandName: "issue_operator_credential" as const,
    idempotencyKey: `idempotency-${crypto.randomUUID()}`,
    fingerprintSecret,
    normalizedInput: { name: "CI deploy", scopes: ["operator:revoke"] },
    ...overrides,
  };
}

async function receiptRows(tx: Tx, commandName: string) {
  const rows = await tx.execute<{ result: { status: string } }>(sql`
    select "result_json" as "result" from "command_receipts"
    where "command_name" = ${commandName}
  `);
  return rows.rows.map((row) => row.result.status);
}

describe.sequential("issuance, rotation and listing (F3-7, F3-8)", () => {
  test("reserves an issuance only for a live session of the issuing person", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const live = await seedSession(tx, seeded.userId);
      const expired = await seedSession(
        tx,
        seeded.userId,
        "now() - interval '1 second'",
      );
      const otherUser = await seedUser(tx, "Someone else");
      const theirs = await seedSession(tx, otherUser);

      await expect(
        seeded.repository.reserveIssuance(issuanceRequest(seeded, live)),
      ).resolves.toMatchObject({
        reserved: true,
        result: { status: "pending" },
      });
      // The delegated provisioning context carries a grant id, not a session.
      for (const sessionId of [expired, theirs, crypto.randomUUID()]) {
        await expect(
          seeded.repository.reserveIssuance(issuanceRequest(seeded, sessionId)),
        ).rejects.toMatchObject({ code: "forbidden" });
      }
    });
  });

  test("reserves only for an issuer who may manage what the credential reaches", async () => {
    await inRollbackTransaction(async (tx) => {
      const owner = await seedCredential(tx);
      const ownerSession = await seedSession(tx, owner.userId);
      await expect(
        owner.repository.reserveIssuance(issuanceRequest(owner, ownerSession)),
      ).resolves.toMatchObject({ reserved: true });

      const member = await seedUser(tx, "Plain member");
      await seedMember(tx, owner.organizationId, member, "member");
      const memberSession = await seedSession(tx, member);
      await expect(
        owner.repository.reserveIssuance(
          issuanceRequest(
            { userId: member, organizationId: owner.organizationId },
            memberSession,
          ),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  test("answers a replay with the stored receipt, and settles or cancels it", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const sessionId = await seedSession(tx, seeded.userId);
      const request = issuanceRequest(seeded, sessionId);
      const receipt = await seeded.repository.reserveIssuance(request);
      await expect(
        seeded.repository.reserveIssuance(request),
      ).resolves.toMatchObject({
        reserved: false,
        result: { status: "pending" },
      });

      const apiKeyId = await seedApiKey(tx, seeded.userId);
      const created = await seeded.repository.createCredential({
        organizationId: seeded.organizationId,
        memberUserId: seeded.userId,
        projectId: null,
        betterAuthApiKeyId: apiKeyId,
        name: "CI deploy",
        prefix: "rpo_rcp",
        fingerprint: `fingerprint_${crypto.randomUUID()}`,
        scopes: ["operator:revoke"],
        expiresInDays: 30,
        correlationId: crypto.randomUUID(),
        issuanceReceipt: receipt,
      });
      await expect(
        seeded.repository.reserveIssuance(request),
      ).resolves.toMatchObject({
        reserved: false,
        result: { status: "complete", credential: { id: created.id } },
      });
      // A settled receipt cannot bind a second key.
      await expect(
        seeded.repository.createCredential({
          organizationId: seeded.organizationId,
          memberUserId: seeded.userId,
          projectId: null,
          betterAuthApiKeyId: await seedApiKey(tx, seeded.userId),
          name: "CI deploy",
          prefix: "rpo_rcq",
          fingerprint: `fingerprint_${crypto.randomUUID()}`,
          scopes: ["operator:revoke"],
          expiresInDays: 30,
          correlationId: crypto.randomUUID(),
          issuanceReceipt: receipt,
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });

      const cancelled = await seeded.repository.reserveIssuance(
        issuanceRequest(seeded, sessionId),
      );
      await seeded.repository.cancelIssuance(cancelled);
      expect(await receiptRows(tx, "issue_operator_credential")).toEqual([
        "complete",
      ]);
    });
  });

  test("binds a replacement to the old credential's expiry, and starts the old one's overlap", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      const oldExpiry = new Date(seeded.credential.expiresAt);
      const replacement = await seeded.repository.createCredential({
        organizationId: seeded.organizationId,
        memberUserId: seeded.userId,
        projectId: null,
        betterAuthApiKeyId: await seedApiKey(tx, seeded.userId),
        name: "CI deploy (rotated)",
        prefix: "rpo_rot",
        fingerprint: `fingerprint_${crypto.randomUUID()}`,
        scopes: ["operator:revoke"],
        expiresAt: oldExpiry,
        lineageId: seeded.credential.lineageId,
        rotatedFromId: seeded.credential.id,
        correlationId: crypto.randomUUID(),
      });
      expect(replacement).toMatchObject({
        lineageId: seeded.credential.lineageId,
        rotatedFromId: seeded.credential.id,
        expiresAt: oldExpiry,
      });

      const overlapEnd = new Date(Date.now() + 15 * 60_000);
      const stale = {
        organizationId: seeded.organizationId,
        credentialId: seeded.credential.id,
        expectedVersion: 2,
        overlapExpiresAt: overlapEnd,
        actorUserId: seeded.userId,
        correlationId: crypto.randomUUID(),
      };
      await expect(
        seeded.repository.setCredentialOverlap(stale),
      ).rejects.toMatchObject({ code: "version_conflict" });
      await expect(
        seeded.repository.setCredentialOverlap({
          ...stale,
          expectedVersion: 1,
        }),
      ).resolves.toEqual({ id: seeded.credential.id, version: 2 });
      const row = await tx.execute<{ ends: boolean; overlap: boolean }>(sql`
        select "expires_at" = ${overlapEnd.toISOString()}::timestamptz as "ends",
          "overlap_expires_at" = ${overlapEnd.toISOString()}::timestamptz
            as "overlap"
        from "operator_credentials" where "id" = ${seeded.credential.id}
      `);
      expect(row.rows).toEqual([{ ends: true, overlap: true }]);
      const audit = await tx.execute(sql`
        select "action" from "security_audit_records"
        where "target_id" = ${seeded.credential.id}
      `);
      expect(audit.rows.map((entry) => entry.action).sort()).toEqual([
        "operator.credential_issued",
        "operator.credential_rotation_started",
      ]);
    });
  });

  test("never lengthens a credential when its overlap would outlive it", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      await tx.execute(sql`
        update "operator_credentials"
        set "expires_at" = now() + interval '5 minutes'
        where "id" = ${seeded.credential.id}
      `);
      await seeded.repository.setCredentialOverlap({
        organizationId: seeded.organizationId,
        credentialId: seeded.credential.id,
        expectedVersion: 1,
        overlapExpiresAt: new Date(Date.now() + 60 * 60_000),
        actorUserId: seeded.userId,
        correlationId: crypto.randomUUID(),
      });
      const row = await tx.execute<{ within: boolean }>(sql`
        select "expires_at" <= now() + interval '5 minutes' as "within"
        from "operator_credentials" where "id" = ${seeded.credential.id}
      `);
      expect(row.rows).toEqual([{ within: true }]);
    });
  });

  test("revokes a replacement for compensation, disabling its key", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedCredential(tx);
      await expect(
        seeded.repository.resolveApiKeyCredential({
          apiKeyId: seeded.apiKeyId,
        }),
      ).resolves.not.toBeNull();
      await expect(
        seeded.repository.revokeCredentialForCompensation({
          organizationId: seeded.organizationId,
          credentialId: seeded.credential.id,
          actorUserId: seeded.userId,
          correlationId: crypto.randomUUID(),
          reason: "Replacement revoked because rotation could not complete",
        }),
      ).resolves.toMatchObject({ id: seeded.credential.id });
      await expect(
        seeded.repository.resolveApiKeyCredential({
          apiKeyId: seeded.apiKeyId,
        }),
      ).resolves.toBeNull();
      const key = await tx.execute(sql`
        select "enabled" from "apikey" where "id" = ${seeded.apiKeyId}
      `);
      expect(key.rows).toEqual([{ enabled: false }]);
    });
  });

  test("lists one organisation's credentials, newest first", async () => {
    await inRollbackTransaction(async (tx) => {
      const first = await seedCredential(tx);
      const second = await first.repository.createCredential({
        organizationId: first.organizationId,
        memberUserId: first.userId,
        projectId: null,
        betterAuthApiKeyId: await seedApiKey(tx, first.userId),
        name: "Nightly import",
        prefix: "rpo_two",
        fingerprint: `fingerprint_${crypto.randomUUID()}`,
        scopes: [],
        expiresInDays: 7,
        correlationId: crypto.randomUUID(),
      });
      await tx.execute(sql`
        update "operator_credentials"
        set "created_at" = "created_at" + interval '1 second'
        where "id" = ${second.id}
      `);
      const elsewhere = await seedCredential(tx);

      const listed = await first.repository.listCredentials(
        first.organizationId,
      );
      expect(listed.map((credential) => credential.id)).toEqual([
        second.id,
        first.credential.id,
      ]);
      expect(listed[0]).toMatchObject({
        name: "Nightly import",
        memberUserId: first.userId,
        projectId: null,
        scopes: [],
        version: 1,
        revokedAt: null,
        overlapExpiresAt: null,
        lastUsedAt: null,
      });
      expect(
        listed.some((credential) => credential.id === elsewhere.credential.id),
      ).toBe(false);
    });
  });
});
