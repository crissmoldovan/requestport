import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  createCoreCommandRegistry,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../../client.js";
import { createStorage, storageOptionsFromEnv } from "../../client.js";
import { createAppearanceRepository } from "../../repositories/appearance-repository.js";
import { createCommandAuthorizationRepository } from "../../repositories/command-authorization.js";
import { createCommandTransactionManager } from "../../repositories/command-repository.js";
import { createOperatorCredentialRepository } from "../../repositories/operator-credential-repository.js";
import { createOrganizationManagementRepository } from "../../repositories/organization-management-repository.js";
import {
  commandReceipts,
  domainEvents,
  invitations,
  organizationAppearanceDefaults,
  projects,
  securityAuditRecords,
} from "../../schema/index.js";
import { tenantWrappingEnabled } from "../../tenant-context.js";
import {
  endingEachCommandBinding,
  endingEachMethodBinding,
  endTenantBinding,
} from "../../test-support/tenant-binding.js";
import type { Tx } from "../../transaction.js";
import {
  getAdministrationOrganizationAppearance,
  listAdministrationInvitations,
  readInvitationsForOperator,
  readOrganizationAppearanceForOperator,
} from "./member-reads.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  `list_administration_invitations` and
  `get_administration_organization_appearance` (Plan 13, F.2.7;
  `manifest-f2.md` §4.1), at the repository: what they return, and whom they
  refuse. The first two describes run each projection alone, handed a member.
  The last runs `readInvitationsForOperator` and
  `readOrganizationAppearanceForOperator`, which are what the REST dispatch
  (`packages/core/src/administration-reads.ts`) calls inside its one
  transaction: the bus's `assertCurrent` on the operator's context — so
  `lockActiveOperatorAuthorization` — then the projection, for the member
  `memberAuthority` names, in the credential's organisation. It also runs the
  appearance write for an operator, which that read serves.

  Every case runs in a transaction that is rolled back at the end, and reports
  its own failure rather than the rollback's.
*/

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  let failure: unknown;
  await expect(
    suiteStorage.transaction(async (tx) => {
      try {
        await run(tx);
      } catch (error) {
        failure = error;
      }
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
  if (failure !== undefined) throw failure;
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
    values (${userId}, 'Member read user', ${email}, now())
  `);
  return userId;
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Member read tenant',
      ${`member-read-${organizationId}`}, 'active')
  `);
  return organizationId;
}

type Role = "owner" | "admin" | "member";

async function seedMembership(
  tx: Tx,
  organizationId: string,
  userId: string,
  role: Role,
  status: "active" | "revoked" = "active",
) {
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, ${status})
  `);
}

async function seedMember(
  tx: Tx,
  organizationId: string,
  role: Role,
  status: "active" | "revoked" = "active",
) {
  const userId = await seedUser(tx);
  await seedMembership(tx, organizationId, userId, role, status);
  return userId;
}

async function seedInvitation(
  tx: Tx,
  organizationId: string,
  createdBy: string,
  role: Role,
  state: "pending" | "revoked" | "accepted" | "expired" = "pending",
) {
  const [row] = await tx
    .insert(invitations)
    .values({
      organizationId,
      normalizedEmail: `invited-${crypto.randomUUID()}@example.invalid`,
      role,
      tokenHash: `test-token-hash-${crypto.randomUUID()}`,
      expiresAt: new Date(
        Date.now() + (state === "expired" ? -60_000 : 86_400_000),
      ),
      createdByUserId: createdBy,
      ...(state === "revoked" ? { revokedAt: new Date(), version: 2 } : {}),
      ...(state === "accepted" ? { acceptedAt: new Date() } : {}),
    })
    .returning({ id: invitations.id });
  if (!row) throw new Error("no invitation");
  return row.id;
}

/**
 * An organisation with its owner (whose membership gives it its appearance
 * defaults, through migration 0014's trigger), an admin, a member, two pending
 * invitations — one of them an owner invitation — and one each revoked,
 * accepted and expired.
 */
async function seedTenant(tx: Tx) {
  const organizationId = await seedOrganization(tx);
  const owner = await seedMember(tx, organizationId, "owner");
  const admin = await seedMember(tx, organizationId, "admin");
  const member = await seedMember(tx, organizationId, "member");
  const pending = [
    await seedInvitation(tx, organizationId, owner, "member"),
    await seedInvitation(tx, organizationId, owner, "owner"),
  ];
  const settled = [
    await seedInvitation(tx, organizationId, owner, "member", "revoked"),
    await seedInvitation(tx, organizationId, owner, "admin", "accepted"),
    await seedInvitation(tx, organizationId, owner, "member", "expired"),
  ];
  return { organizationId, owner, admin, member, pending, settled };
}

function read(organizationId: string, memberUserId: string) {
  return { memberUserId, organizationId, credentialProjectId: null };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the read was not refused");
}

async function stillUsable(tx: Tx) {
  const [row] = (await tx.execute<{ one: number }>(sql`select 1 as "one"`))
    .rows;
  expect(row?.one).toBe(1);
}

afterAll(async () => {
  await suiteStorage.close();
});

describe("list_administration_invitations", () => {
  test("answers an owner with each pending invitation's id, role and version, and nothing else", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const answer = await listAdministrationInvitations(
        tx,
        read(tenant.organizationId, tenant.owner),
      );

      const [member, owner] = tenant.pending;
      expect(answer).toEqual(
        [
          { id: member, role: "member", version: 1 },
          { id: owner, role: "owner", version: 1 },
        ].sort((left, right) => (left.id < right.id ? -1 : 1)),
      );
      for (const row of answer)
        expect(Object.keys(row).sort()).toEqual(["id", "role", "version"]);
      expect(JSON.stringify(answer)).not.toContain("@");
      for (const id of tenant.settled)
        expect(JSON.stringify(answer)).not.toContain(id);
    });
  });

  test("answers an admin the same, and an organisation with no pending invitation with []", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      expect(
        await listAdministrationInvitations(
          tx,
          read(tenant.organizationId, tenant.admin),
        ),
      ).toHaveLength(2);

      const empty = await seedOrganization(tx);
      const owner = await seedMember(tx, empty, "owner");
      expect(
        await listAdministrationInvitations(tx, read(empty, owner)),
      ).toEqual([]);
    });
  });

  test("refuses a member, a revoked owner, and anyone in a suspended organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const revoked = await seedMember(
        tx,
        tenant.organizationId,
        "owner",
        "revoked",
      );
      for (const memberUserId of [tenant.member, revoked]) {
        const error = await refusal(
          listAdministrationInvitations(
            tx,
            read(tenant.organizationId, memberUserId),
          ),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({ code: "forbidden" });
      }
      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${tenant.organizationId}
      `);
      expect(
        await refusal(
          listAdministrationInvitations(
            tx,
            read(tenant.organizationId, tenant.owner),
          ),
        ),
      ).toMatchObject({ code: "forbidden" });
    });
  });

  test("never answers another organisation's invitations, for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const away = await seedTenant(tx);
      await seedMembership(tx, away.organizationId, home.owner, "owner");
      const answer = JSON.stringify(
        await listAdministrationInvitations(
          tx,
          read(home.organizationId, home.owner),
        ),
      );

      for (const id of [...away.pending, ...away.settled])
        expect(answer).not.toContain(id);
      expect(answer).toContain(home.pending[0]);
    });
  });

  test("refuses a credential bound to a project, before any query", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      expect(
        await refusal(
          listAdministrationInvitations(tx, {
            ...read(tenant.organizationId, tenant.owner),
            credentialProjectId: crypto.randomUUID(),
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
      // An organisation id that is not a UUID would raise in PostgreSQL if a
      // query ran; the refusal comes first.
      expect(
        await refusal(
          listAdministrationInvitations(tx, {
            memberUserId: tenant.owner,
            organizationId: "not-a-uuid",
            credentialProjectId: crypto.randomUUID(),
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
      await stillUsable(tx);
    });
  });

  test("refuses an operator's actor id given as the member, and the transaction stays usable", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      expect(
        await refusal(
          listAdministrationInvitations(
            tx,
            read(tenant.organizationId, `operator:${crypto.randomUUID()}`),
          ),
        ),
      ).toMatchObject({ code: "forbidden" });
      await stillUsable(tx);
    });
  });

  test("each version it reads is what the revocation accepts, and one more is a version conflict", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const bus = new AtomicCommandBus({
        registry: createCoreCommandRegistry(),
        transactions: createCommandTransactionManager(
          tx as unknown as Database,
          (name, database) =>
            name === "organizationManagement"
              ? createOrganizationManagementRepository(database)
              : undefined,
        ),
        fingerprintSecret: "member-reads-live-bus-fingerprint-secret-000000",
      });
      const context: AuthorizedCommandContext = {
        actor: { type: "user", id: tenant.owner },
        organizationId: tenant.organizationId,
        scopes: new Set(["members:manage"]),
        credentialId: "session-not-checked-here",
        correlationId: crypto.randomUUID(),
      };
      const [first, second] = await listAdministrationInvitations(
        tx,
        read(tenant.organizationId, tenant.owner),
      );
      if (!first || !second) throw new Error("two invitations were seeded");

      await expect(
        bus.execute({
          name: "revoke_organization_invitation",
          context,
          input: {
            organizationId: tenant.organizationId,
            invitationId: first.id,
          },
          meta: {
            idempotencyKey: `member-reads-${crypto.randomUUID()}`,
            expectedVersion: first.version,
          },
        }),
      ).resolves.toMatchObject({ id: first.id, version: first.version + 1 });
      await expect(
        bus.execute({
          name: "revoke_organization_invitation",
          context,
          input: {
            organizationId: tenant.organizationId,
            invitationId: second.id,
          },
          meta: {
            idempotencyKey: `member-reads-${crypto.randomUUID()}`,
            expectedVersion: second.version + 1,
          },
        }),
      ).rejects.toMatchObject({ code: "version_conflict" });
    });
  });
});

async function defaults(tx: Tx, organizationId: string) {
  const [row] = await tx
    .select({
      version: organizationAppearanceDefaults.version,
      theme: organizationAppearanceDefaults.theme,
      density: organizationAppearanceDefaults.density,
      mode: organizationAppearanceDefaults.mode,
    })
    .from(organizationAppearanceDefaults)
    .where(eq(organizationAppearanceDefaults.organizationId, organizationId));
  if (!row) throw new Error("no appearance defaults");
  return row;
}

describe("get_administration_organization_appearance", () => {
  test("answers an owner with the version, theme, density and mode, and nothing else", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const answer = await getAdministrationOrganizationAppearance(
        tx,
        read(tenant.organizationId, tenant.owner),
      );

      expect(answer).toEqual(await defaults(tx, tenant.organizationId));
      expect(Object.keys(answer).sort()).toEqual([
        "density",
        "mode",
        "theme",
        "version",
      ]);
    });
  });

  test("refuses an admin who is not an owner, a member, a revoked owner, and anyone in a suspended organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const revoked = await seedMember(
        tx,
        tenant.organizationId,
        "owner",
        "revoked",
      );
      for (const memberUserId of [tenant.admin, tenant.member, revoked]) {
        const error = await refusal(
          getAdministrationOrganizationAppearance(
            tx,
            read(tenant.organizationId, memberUserId),
          ),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({
          code: "forbidden",
          message: "Organization appearance ownership is required",
        });
      }
      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${tenant.organizationId}
      `);
      expect(
        await refusal(
          getAdministrationOrganizationAppearance(
            tx,
            read(tenant.organizationId, tenant.owner),
          ),
        ),
      ).toMatchObject({ code: "forbidden" });
    });
  });

  test("answers not_found for an organisation with no defaults row", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      await tx
        .delete(organizationAppearanceDefaults)
        .where(
          eq(
            organizationAppearanceDefaults.organizationId,
            tenant.organizationId,
          ),
        );

      expect(
        await refusal(
          getAdministrationOrganizationAppearance(
            tx,
            read(tenant.organizationId, tenant.owner),
          ),
        ),
      ).toMatchObject({ code: "not_found" });
    });
  });

  test("answers only its own organisation's defaults, for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const away = await seedTenant(tx);
      await seedMembership(tx, away.organizationId, home.owner, "owner");
      await tx
        .update(organizationAppearanceDefaults)
        .set({ theme: "terminal", version: 7 })
        .where(
          eq(
            organizationAppearanceDefaults.organizationId,
            away.organizationId,
          ),
        );

      const answer = await getAdministrationOrganizationAppearance(
        tx,
        read(home.organizationId, home.owner),
      );
      expect(answer).toEqual(await defaults(tx, home.organizationId));
      expect(answer).not.toEqual(await defaults(tx, away.organizationId));
    });
  });

  test("refuses a credential bound to a project, before any query, and an operator's actor id as the member", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      expect(
        await refusal(
          getAdministrationOrganizationAppearance(tx, {
            memberUserId: tenant.owner,
            organizationId: "not-a-uuid",
            credentialProjectId: crypto.randomUUID(),
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
      expect(
        await refusal(
          getAdministrationOrganizationAppearance(
            tx,
            read(tenant.organizationId, `operator:${crypto.randomUUID()}`),
          ),
        ),
      ).toMatchObject({ code: "forbidden" });
      await stillUsable(tx);
    });
  });

  test("the version it reads is what the appearance write accepts, and one more is a version conflict", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const bus = new AtomicCommandBus({
        registry: createCoreCommandRegistry(),
        transactions: createCommandTransactionManager(
          tx as unknown as Database,
          (name, database) =>
            name === "appearance"
              ? createAppearanceRepository(database)
              : undefined,
        ),
        fingerprintSecret: "member-reads-live-bus-fingerprint-secret-000000",
      });
      const context: AuthorizedCommandContext = {
        actor: { type: "user", id: tenant.owner },
        organizationId: tenant.organizationId,
        scopes: new Set(["members:manage"]),
        credentialId: "session-not-checked-here",
        correlationId: crypto.randomUUID(),
      };
      const current = await getAdministrationOrganizationAppearance(
        tx,
        read(tenant.organizationId, tenant.owner),
      );
      const write = (expectedVersion: number) =>
        bus.execute({
          name: "appearance.update_organization_defaults.v1",
          context,
          input: {
            organizationId: tenant.organizationId,
            theme: current.theme === "terminal" ? "signal" : "terminal",
            density: current.density,
            mode: current.mode,
          },
          meta: {
            idempotencyKey: `member-reads-${crypto.randomUUID()}`,
            expectedVersion,
          },
        });

      await expect(write(current.version + 1)).rejects.toMatchObject({
        code: "version_conflict",
      });
      await expect(write(current.version)).resolves.toMatchObject({
        version: current.version + 1,
      });
    });
  });

  test("the appearance write refuses an owner without members:manage, and writes and receipts nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const bus = new AtomicCommandBus({
        registry: createCoreCommandRegistry(),
        transactions: createCommandTransactionManager(
          tx as unknown as Database,
          (name, database) =>
            name === "appearance"
              ? createAppearanceRepository(database)
              : undefined,
        ),
        fingerprintSecret: "member-reads-live-bus-fingerprint-secret-000000",
      });
      const before = await getAdministrationOrganizationAppearance(
        tx,
        read(tenant.organizationId, tenant.owner),
      );

      const refused = await refusal(
        bus.execute({
          name: "appearance.update_organization_defaults.v1",
          context: {
            actor: { type: "user", id: tenant.owner },
            organizationId: tenant.organizationId,
            // Scopes a person holds, but not the one this command requires.
            scopes: new Set(["org:read", "project:manage", "slack:manage"]),
            credentialId: "session-not-checked-here",
            correlationId: crypto.randomUUID(),
          },
          input: {
            organizationId: tenant.organizationId,
            theme: before.theme === "terminal" ? "signal" : "terminal",
            density: before.density,
            mode: before.mode,
          },
          meta: {
            idempotencyKey: `member-reads-${crypto.randomUUID()}`,
            expectedVersion: before.version,
          },
        }),
      );

      expect(refused).toBeInstanceOf(DomainError);
      expect(refused).toMatchObject({
        code: "forbidden",
        details: { scope: "members:manage" },
      });
      await expect(
        getAdministrationOrganizationAppearance(
          tx,
          read(tenant.organizationId, tenant.owner),
        ),
      ).resolves.toEqual(before);
      const receipts = await tx
        .select({ id: commandReceipts.id })
        .from(commandReceipts)
        .where(sql`${commandReceipts.createdAt} = now()`);
      expect(receipts).toEqual([]);
    });
  });
});

/** A live operator credential holding `members:manage`, as F.3 issues one. */
async function issueOperator(
  tx: Tx,
  input: { organizationId: string; userId: string; projectId?: string | null },
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
    projectId: input.projectId ?? null,
    betterAuthApiKeyId: apiKeyId,
    name: "Member reader",
    prefix: "rpo_f27",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["members:manage"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
  const context: AuthorizedCommandContext = {
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
  return { credential, context, apiKeyId };
}

async function seedProject(tx: Tx, organizationId: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [project] = await tx
    .insert(projects)
    .values({
      organizationId,
      name: `Bound ${suffix}`,
      slug: `bound-${suffix}`,
      keyPrefix: `M${suffix.toUpperCase()}`,
      status: "active",
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  return project.id;
}

type Switch = "enabled" | "disabled" | undefined;

/**
 * The two reads as REST dispatches them. `operatorCredentials` is the
 * deployment's switch, `enabled` unless the case says otherwise (an explicit
 * `undefined` included, so a case can pass the unset switch).
 */
const asOperator = {
  invitations: (
    tx: Tx,
    context: AuthorizedCommandContext,
    ...switchValue: [Switch] | []
  ) =>
    endingReadBinding(
      tx,
      readInvitationsForOperator(tx, {
        context,
        operatorCredentials:
          switchValue.length === 0 ? "enabled" : switchValue[0],
      }),
    ),
  appearance: (
    tx: Tx,
    context: AuthorizedCommandContext,
    ...switchValue: [Switch] | []
  ) =>
    endingReadBinding(
      tx,
      readOrganizationAppearanceForOperator(tx, {
        context,
        operatorCredentials:
          switchValue.length === 0 ? "enabled" : switchValue[0],
      }),
    ),
};

/**
 * Each read runs in a transaction of its own in production, opened and bound
 * for it (`withAdministrationReadTransaction`), whose binding ends with it;
 * here the binding the read's re-check takes is ended when the read settles,
 * so a case can read for one organisation and then ask about another.
 */
async function endingReadBinding<T>(tx: Tx, read: Promise<T>) {
  try {
    return await read;
  } finally {
    await endTenantBinding(tx);
  }
}

/** The appearance write on the tenant bus, as REST reaches it: `assertCurrent` first, switched on. */
function appearanceBus(tx: Tx) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    // A case runs writes for more than one actor or organisation on one
    // transaction; each command's binding ends with it, as its own
    // transaction ends it in production (test-support/tenant-binding.ts).
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(
        tx as unknown as Database,
        (name, database) => {
          if (name === "appearance")
            return createAppearanceRepository(database);
          if (name === "commandAuthorization")
            return createCommandAuthorizationRepository(database, {
              operatorCredentials: "enabled",
            });
          return undefined;
        },
      ),
      tx,
    ),
    fingerprintSecret: "member-reads-live-bus-fingerprint-secret-000000",
    authorizeContext: (context: AuthorizedCommandContext, uow) =>
      uow
        .port<ReturnType<typeof createCommandAuthorizationRepository>>(
          "commandAuthorization",
        )
        .assertCurrent(context),
  });
}

type Changed = {
  organizationId: string;
  userId: string;
  credentialId: string;
  apiKeyId: string;
};

const changes: Array<[string, (tx: Tx, at: Changed) => Promise<void>]> = [
  [
    "the credential is revoked",
    async (tx, { credentialId }) => {
      await tx.execute(sql`
        update "operator_credentials" set "revoked_at" = now()
        where "id" = ${credentialId}
      `);
    },
  ],
  [
    "the credential has expired",
    async (tx, { credentialId }) => {
      await tx.execute(sql`
        update "operator_credentials"
        set "created_at" = now() - interval '2 days',
            "expires_at" = now() - interval '1 second'
        where "id" = ${credentialId}
      `);
    },
  ],
  [
    "its key has expired",
    async (tx, { apiKeyId }) => {
      await tx.execute(sql`
        update "apikey" set "expires_at" = now() - interval '1 second'
        where "id" = ${apiKeyId}
      `);
    },
  ],
  [
    "its member is demoted below the rule",
    async (tx, { organizationId, userId }) => {
      await tx.execute(sql`
        update "organization_members" set "role" = 'member'
        where "organization_id" = ${organizationId}
          and "user_id" = ${userId}
      `);
    },
  ],
  [
    "its member's membership is revoked",
    async (tx, { organizationId, userId }) => {
      await tx.execute(sql`
        update "organization_members" set "status" = 'revoked'
        where "organization_id" = ${organizationId}
          and "user_id" = ${userId}
      `);
    },
  ],
  [
    "the organisation is suspended",
    async (tx, { organizationId }) => {
      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${organizationId}
      `);
    },
  ],
];

describe.sequential("the two reads as REST dispatches them, and the appearance write, for an operator credential", () => {
  test("an owner's operator reads exactly what its member would", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { context } = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner,
      });
      expect(await asOperator.invitations(tx, context)).toEqual(
        await listAdministrationInvitations(
          tx,
          read(tenant.organizationId, tenant.owner),
        ),
      );
      expect(await asOperator.appearance(tx, context)).toEqual(
        await getAdministrationOrganizationAppearance(
          tx,
          read(tenant.organizationId, tenant.owner),
        ),
      );
    });
  });

  test("an admin's operator reads the invitations, and is refused the appearance, as its member is", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { context } = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.admin,
      });
      expect(await asOperator.invitations(tx, context)).toHaveLength(2);
      expect(await refusal(asOperator.appearance(tx, context))).toMatchObject({
        code: "forbidden",
        message: "Organization appearance ownership is required",
      });
    });
  });

  test.each(changes)(
    "both refuse once %s, having answered before",
    async (_, change) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const { credential, context, apiKeyId } = await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.owner,
        });
        expect(await asOperator.invitations(tx, context)).toHaveLength(2);
        expect((await asOperator.appearance(tx, context)).version).toBe(1);
        await change(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.owner,
          credentialId: credential.id,
          apiKeyId,
        });
        for (const refused of [
          await refusal(asOperator.invitations(tx, context)),
          await refusal(asOperator.appearance(tx, context)),
        ]) {
          expect(refused).toBeInstanceOf(DomainError);
          expect((refused as DomainError).code).toBe("forbidden");
        }
      });
    },
  );

  test("both refuse every operator while operator credentials are switched off", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { context } = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner,
      });
      expect(await asOperator.invitations(tx, context, "enabled")).toHaveLength(
        2,
      );
      for (const setting of ["disabled", undefined] as const) {
        for (const refused of [
          await refusal(asOperator.invitations(tx, context, setting)),
          await refusal(asOperator.appearance(tx, context, setting)),
        ])
          expect((refused as DomainError).code, String(setting)).toBe(
            "forbidden",
          );
      }
    });
  });

  test("an operator bound to a project is refused both, though its member owns the organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const projectId = await seedProject(tx, tenant.organizationId);
      const { context } = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner,
        projectId,
      });
      expect(context.projectId).toBe(projectId);
      for (const refused of [
        await refusal(asOperator.invitations(tx, context)),
        await refusal(asOperator.appearance(tx, context)),
      ])
        expect(refused).toMatchObject({ code: "forbidden" });
      await stillUsable(tx);
    });
  });

  test("an operator issued for one organisation reads none of another's, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const away = await seedTenant(tx);
      await seedMembership(tx, away.organizationId, home.owner, "owner");
      await tx
        .update(organizationAppearanceDefaults)
        .set({ theme: "terminal", version: 7 })
        .where(
          eq(
            organizationAppearanceDefaults.organizationId,
            away.organizationId,
          ),
        );
      const { context } = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.owner,
      });
      const listed = JSON.stringify(await asOperator.invitations(tx, context));
      for (const id of [...away.pending, ...away.settled])
        expect(listed).not.toContain(id);
      expect(await asOperator.appearance(tx, context)).toEqual(
        await defaults(tx, home.organizationId),
      );
      // A context naming the other organisation is refused by the
      // credential's re-check: the credential is bound to its own.
      const named = { ...context, organizationId: away.organizationId };
      for (const refused of [
        await refusal(asOperator.invitations(tx, named)),
        await refusal(asOperator.appearance(tx, named)),
      ])
        expect(refused).toMatchObject({ code: "forbidden" });
    });
  });

  test("a context that is not an operator's is refused before anything is read", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const person: AuthorizedCommandContext = {
        actor: { type: "user", id: tenant.owner },
        organizationId: tenant.organizationId,
        scopes: new Set(["members:manage"]),
        credentialId: "session-not-checked-here",
        correlationId: crypto.randomUUID(),
      };
      for (const refused of [
        await refusal(asOperator.invitations(tx, person)),
        await refusal(asOperator.appearance(tx, person)),
      ])
        expect(refused).toMatchObject({
          code: "forbidden",
          message: "This read admits an operator credential only",
        });
      await stillUsable(tx);
    });
  });

  test("an owner's operator writes the appearance at the version it read, recorded as the service it is, the member named as last updater", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { credential, context } = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner,
      });
      const current = await asOperator.appearance(tx, context);
      const write = (expectedVersion: number) =>
        appearanceBus(tx).execute({
          name: "appearance.update_organization_defaults.v1",
          context,
          input: {
            organizationId: tenant.organizationId,
            theme: current.theme === "terminal" ? "signal" : "terminal",
            density: current.density,
            mode: current.mode,
          },
          meta: {
            idempotencyKey: `member-reads-${crypto.randomUUID()}`,
            expectedVersion,
          },
        });
      await expect(write(current.version + 1)).rejects.toMatchObject({
        code: "version_conflict",
      });
      await expect(write(current.version)).resolves.toMatchObject({
        version: current.version + 1,
      });

      const [row] = await tx
        .select({
          lastUpdatedByUserId:
            organizationAppearanceDefaults.lastUpdatedByUserId,
          aggregateId: organizationAppearanceDefaults.aggregateId,
        })
        .from(organizationAppearanceDefaults)
        .where(
          eq(
            organizationAppearanceDefaults.organizationId,
            tenant.organizationId,
          ),
        );
      expect(row?.lastUpdatedByUserId).toBe(tenant.owner);
      const audits = await tx
        .select({
          actorType: securityAuditRecords.actorType,
          actorId: securityAuditRecords.actorId,
        })
        .from(securityAuditRecords)
        .where(
          and(
            eq(securityAuditRecords.organizationId, tenant.organizationId),
            eq(
              securityAuditRecords.action,
              "appearance.organization_defaults_updated",
            ),
          ),
        );
      expect(audits).toEqual([
        { actorType: "service", actorId: `operator:${credential.lineageId}` },
      ]);
      const events = await tx
        .select({ actor: domainEvents.actor })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.organizationId, tenant.organizationId),
            eq(
              domainEvents.type,
              "appearance.organization_defaults_updated.v1",
            ),
          ),
        );
      expect(events.map((event) => event.actor)).toEqual([context.actor]);
    });
  });

  test("an admin's operator is refused the appearance write, and a person's write still records the person", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { context } = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.admin,
      });
      const before = await defaults(tx, tenant.organizationId);
      const input = {
        organizationId: tenant.organizationId,
        theme: before.theme === "terminal" ? "signal" : "terminal",
        density: before.density,
        mode: before.mode,
      };
      expect(
        await refusal(
          appearanceBus(tx).execute({
            name: "appearance.update_organization_defaults.v1",
            context,
            input,
            meta: {
              idempotencyKey: `member-reads-${crypto.randomUUID()}`,
              expectedVersion: before.version,
            },
          }),
        ),
      ).toMatchObject({
        code: "forbidden",
        message: "Organization appearance ownership is required",
      });
      expect(await defaults(tx, tenant.organizationId)).toEqual(before);

      // The human path: the owner's own write is recorded as `user` and the
      // owner's id, as before the registry half.
      const sessionId = `session_${crypto.randomUUID()}`;
      await tx.execute(sql`
        insert into "session" ("id", "expires_at", "token", "updated_at", "user_id")
        values (${sessionId}, now() + interval '1 hour',
          ${`token_${crypto.randomUUID()}`}, now(), ${tenant.owner})
      `);
      await appearanceBus(tx).execute({
        name: "appearance.update_organization_defaults.v1",
        context: {
          actor: { type: "user", id: tenant.owner },
          organizationId: tenant.organizationId,
          scopes: new Set(["members:manage"]),
          credentialId: sessionId,
          correlationId: crypto.randomUUID(),
        },
        input,
        meta: {
          idempotencyKey: `member-reads-${crypto.randomUUID()}`,
          expectedVersion: before.version,
        },
      });
      const audits = await tx
        .select({
          actorType: securityAuditRecords.actorType,
          actorId: securityAuditRecords.actorId,
        })
        .from(securityAuditRecords)
        .where(
          and(
            eq(securityAuditRecords.organizationId, tenant.organizationId),
            eq(
              securityAuditRecords.action,
              "appearance.organization_defaults_updated",
            ),
          ),
        );
      expect(audits).toEqual([{ actorType: "user", actorId: tenant.owner }]);
    });
  });

  test("an operator bound to a project is refused the appearance write, though its member owns the organisation, and nothing is written or receipted", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const projectId = await seedProject(tx, tenant.organizationId);
      const { context } = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner,
        projectId,
      });
      expect(context.projectId).toBe(projectId);
      const before = await defaults(tx, tenant.organizationId);
      const written = await appearanceWrites(tx);

      expect(
        await refusal(
          appearanceBus(tx).execute({
            name: "appearance.update_organization_defaults.v1",
            context,
            input: changedAppearance(tenant.organizationId, before),
            meta: {
              idempotencyKey: `member-reads-${crypto.randomUUID()}`,
              expectedVersion: before.version,
            },
          }),
        ),
      ).toMatchObject({
        code: "forbidden",
        message:
          "Organization appearance defaults require a credential bound to no project",
      });
      expect(await defaults(tx, tenant.organizationId)).toEqual(before);
      expect(await appearanceWrites(tx)).toEqual(written);
      await stillUsable(tx);
    });
  });

  test("an operator issued for one organisation cannot write another's appearance, though its member owns both, and nothing is written or receipted", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const away = await seedTenant(tx);
      await seedMembership(tx, away.organizationId, home.owner, "owner");
      const { context } = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.owner,
      });
      const homeBefore = await defaults(tx, home.organizationId);
      const awayBefore = await defaults(tx, away.organizationId);
      const written = await appearanceWrites(tx);
      const write = (named: AuthorizedCommandContext) =>
        refusal(
          appearanceBus(tx).execute({
            name: "appearance.update_organization_defaults.v1",
            context: named,
            input: changedAppearance(away.organizationId, awayBefore),
            meta: {
              idempotencyKey: `member-reads-${crypto.randomUUID()}`,
              expectedVersion: awayBefore.version,
            },
          }),
        );

      // The other organisation named in the input, the credential's own in
      // the context: the command's organisation check refuses it.
      expect(await write(context)).toMatchObject({
        code: "forbidden",
        message: "Organization access is denied",
      });
      // The other organisation named in the context as well: the bus's
      // `assertCurrent` refuses it, the credential being bound to its own.
      expect(
        await write({ ...context, organizationId: away.organizationId }),
      ).toMatchObject({
        code: "forbidden",
        message: "Current operator authorization is no longer active",
      });
      expect(await defaults(tx, home.organizationId)).toEqual(homeBefore);
      expect(await defaults(tx, away.organizationId)).toEqual(awayBefore);
      expect(await appearanceWrites(tx)).toEqual(written);
      await stillUsable(tx);
    });
  });
});

/** The organisation appearance input, with the theme changed from `current`'s. */
function changedAppearance(
  organizationId: string,
  current: Awaited<ReturnType<typeof defaults>>,
) {
  return {
    organizationId,
    theme: current.theme === "terminal" ? "signal" : "terminal",
    density: current.density,
    mode: current.mode,
  };
}

/**
 * How many receipts, audit rows and events the organisation appearance write
 * has left in this transaction's view, in every organisation: a refused write
 * leaves all three where they were.
 */
async function appearanceWrites(tx: Tx) {
  const count = async (query: ReturnType<typeof sql>) =>
    Number(
      (await tx.execute<{ count: string | number }>(query)).rows[0]?.count,
    );
  return {
    receipts: await count(sql`
      select count(*) as "count" from ${commandReceipts}
      where ${commandReceipts.commandName} =
        'appearance.update_organization_defaults.v1'
    `),
    audits: await count(sql`
      select count(*) as "count" from ${securityAuditRecords}
      where ${securityAuditRecords.action} =
        'appearance.organization_defaults_updated'
    `),
    events: await count(sql`
      select count(*) as "count" from ${domainEvents}
      where ${domainEvents.type} =
        'appearance.organization_defaults_updated.v1'
    `),
  };
}
