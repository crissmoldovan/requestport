import {
  type AuthorizedCommandContext,
  DomainError,
  memberAuthority,
  operatorActor,
} from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../../client.js";
import { createCommandAuthorizationRepository } from "../../repositories/command-authorization.js";
import { createOperatorCredentialRepository } from "../../repositories/operator-credential-repository.js";
import { lanes, projectMembers, projects } from "../../schema/index.js";
import { tenantWrappingEnabled } from "../../tenant-context.js";
import type { Tx } from "../../transaction.js";
import {
  listAdministrationLanes,
  listAdministrationMembers,
  listAdministrationProjects,
  type OrganizationReadInput,
} from "./organization-reads.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  F.2.0b's three shared administration reads (Plan 13; `manifest-f2.md` §4.1):
  `list_administration_projects`, `list_administration_lanes` and
  `list_administration_members`, at the repository, on PostgreSQL.

  Each checks one rule, the rule of the page reads it replaces: the member is
  active in an active organisation. The operator's own rule is F.3's, checked
  by `assertCurrent` before the read runs: the second half of this file runs
  each read exactly as `packages/core/src/administration-reads.ts` runs
  it — `assertCurrent` on the operator's context, then the read with the
  member `memberAuthority` names, in one transaction — and shows the
  revocations, the expiry and the demotion refused there.

  Every case runs in a transaction that is rolled back at the end.
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

async function seedUser(tx: Tx, name = "Shared reader") {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, ${name}, ${email}, now())
  `);
  return { userId, email, name };
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Shared read tenant',
      ${`shared-read-${organizationId}`}, 'active')
  `);
  return organizationId;
}

async function seedMembership(
  tx: Tx,
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member",
  status: "active" | "revoked" = "active",
) {
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, ${status})
  `);
}

async function seedProject(
  tx: Tx,
  organizationId: string,
  status: "active" | "archived" = "active",
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [project] = await tx
    .insert(projects)
    .values({
      organizationId,
      name: `Shared ${suffix}`,
      slug: `shared-${suffix}`,
      // All eight hex characters, as #131 made the other suites use: with four,
      // two projects seeded in one organisation drew the same prefix often
      // enough to fail a gate (`projects_organization_key_prefix_ci_unique`).
      keyPrefix: `S${suffix.toUpperCase()}`,
      status,
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  return project.id;
}

async function seedProjectRole(
  tx: Tx,
  organizationId: string,
  projectId: string,
  userId: string,
  role: "maintainer" | "contributor" | "viewer",
  status: "active" | "revoked" = "active",
) {
  await tx
    .insert(projectMembers)
    .values({ organizationId, projectId, userId, role, status });
}

async function seedLane(
  tx: Tx,
  organizationId: string,
  projectId: string,
  status: "active" | "archived" = "active",
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [lane] = await tx
    .insert(lanes)
    .values({
      organizationId,
      projectId,
      name: `Lane ${suffix}`,
      slug: `lane-${suffix}`,
      status,
    })
    .returning({ id: lanes.id });
  if (!lane) throw new Error("no lane");
  return lane.id;
}

/**
 * Two organisations, A and B, with one person who owns both, and in A: two
 * active projects and an archived one, lanes in each (one archived), a plain
 * member with an active role in the first project and a revoked one in the
 * second, and a revoked member.
 */
async function seedTenants(tx: Tx) {
  const owner = await seedUser(tx, "Owner of both");
  const member = await seedUser(tx, "Plain member");
  const revoked = await seedUser(tx, "Revoked member");
  const outsider = await seedUser(tx, "Member of B only");
  const a = await seedOrganization(tx);
  const b = await seedOrganization(tx);
  await seedMembership(tx, a, owner.userId, "owner");
  await seedMembership(tx, b, owner.userId, "owner");
  await seedMembership(tx, a, member.userId, "member");
  await seedMembership(tx, a, revoked.userId, "admin", "revoked");
  await seedMembership(tx, b, outsider.userId, "admin");
  const p1 = await seedProject(tx, a);
  const p2 = await seedProject(tx, a);
  const archived = await seedProject(tx, a, "archived");
  const q = await seedProject(tx, b);
  await seedProjectRole(tx, a, p1, member.userId, "viewer");
  await seedProjectRole(tx, a, p2, member.userId, "contributor", "revoked");
  const laneP1 = await seedLane(tx, a, p1);
  const laneP2 = await seedLane(tx, a, p2);
  const laneP2Archived = await seedLane(tx, a, p2, "archived");
  const laneArchivedProject = await seedLane(tx, a, archived);
  const laneQ = await seedLane(tx, b, q);
  return {
    owner,
    member,
    revoked,
    outsider,
    a,
    b,
    p1,
    p2,
    archived,
    q,
    laneP1,
    laneP2,
    laneP2Archived,
    laneArchivedProject,
    laneQ,
  };
}

function input(
  memberUserId: string,
  organizationId: string,
  credentialProjectId: string | null = null,
): OrganizationReadInput {
  return { memberUserId, organizationId, credentialProjectId };
}

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return "answered";
}

const byId = (left: { id: string }, right: { id: string }) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/** The transaction took no PostgreSQL error: a refusal was a refusal, not a failed query. */
async function stillUsable(tx: Tx) {
  const result = await tx.execute(sql`select 1 as "one"`);
  expect(result.rows).toEqual([{ one: 1 }]);
}

afterAll(async () => {
  await suiteStorage.close();
});

describe("list_administration_projects", () => {
  test("answers an owner with every project of the organisation, id, status and canRepresent alone, ordered by id", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      const rows = await listAdministrationProjects(
        tx,
        input(t.owner.userId, t.a),
      );
      expect(rows).toEqual(
        [
          { id: t.p1, status: "active", canRepresent: true },
          { id: t.p2, status: "active", canRepresent: true },
          { id: t.archived, status: "archived", canRepresent: true },
        ].sort(byId),
      );
      for (const row of rows)
        expect(Object.keys(row)).toEqual(["id", "status", "canRepresent"]);
      expect(JSON.stringify(rows)).not.toContain(t.q);
    });
  });

  test("answers a plain member, who may represent only the project they actively belong to", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      const rows = await listAdministrationProjects(
        tx,
        input(t.member.userId, t.a),
      );
      expect(rows).toEqual(
        [
          { id: t.p1, status: "active", canRepresent: true },
          { id: t.p2, status: "active", canRepresent: false },
          { id: t.archived, status: "archived", canRepresent: false },
        ].sort(byId),
      );
    });
  });

  test("answers a credential bound to a project about that project alone", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      expect(
        await listAdministrationProjects(tx, input(t.owner.userId, t.a, t.p2)),
      ).toEqual([{ id: t.p2, status: "active", canRepresent: true }]);
    });
  });

  test("names none of another organisation's projects for an owner of both, and none of A's when read for B", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      const forB = await listAdministrationProjects(
        tx,
        input(t.owner.userId, t.b),
      );
      expect(forB).toEqual([{ id: t.q, status: "active", canRepresent: true }]);
      // A credential bound to B's project, read for A, finds nothing of B's.
      expect(
        await listAdministrationProjects(tx, input(t.owner.userId, t.a, t.q)),
      ).toEqual([]);
    });
  });
});

describe("list_administration_lanes", () => {
  test("answers every active lane of the organisation, id and projectId alone, ordered by id", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      const rows = await listAdministrationLanes(tx, {
        ...input(t.member.userId, t.a),
        projectId: null,
      });
      expect(rows).toEqual(
        [
          { id: t.laneP1, projectId: t.p1 },
          { id: t.laneP2, projectId: t.p2 },
          { id: t.laneArchivedProject, projectId: t.archived },
        ].sort(byId),
      );
      for (const row of rows)
        expect(Object.keys(row)).toEqual(["id", "projectId"]);
    });
  });

  test("narrows to the project the query names", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      expect(
        await listAdministrationLanes(tx, {
          ...input(t.owner.userId, t.a),
          projectId: t.p2,
        }),
      ).toEqual([{ id: t.laneP2, projectId: t.p2 }]);
    });
  });

  test("answers not_found for another organisation's project, a malformed id and an operator's actor id", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      for (const projectId of [
        t.q,
        "not-a-uuid",
        `operator:${crypto.randomUUID()}`,
        crypto.randomUUID(),
      ])
        expect(
          await refusal(() =>
            listAdministrationLanes(tx, {
              ...input(t.owner.userId, t.a),
              projectId,
            }),
          ),
          projectId,
        ).toBe("not_found");
      await stillUsable(tx);
    });
  });

  test("answers a credential bound to a project about its lanes alone, and not_found for another project's", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      const bound = input(t.owner.userId, t.a, t.p1);
      const own = [{ id: t.laneP1, projectId: t.p1 }];
      expect(
        await listAdministrationLanes(tx, { ...bound, projectId: null }),
      ).toEqual(own);
      expect(
        await listAdministrationLanes(tx, { ...bound, projectId: t.p1 }),
      ).toEqual(own);
      for (const projectId of [t.p2, t.q])
        expect(
          await refusal(() =>
            listAdministrationLanes(tx, { ...bound, projectId }),
          ),
          projectId,
        ).toBe("not_found");
    });
  });

  test("names none of another organisation's lanes for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      expect(
        await listAdministrationLanes(tx, {
          ...input(t.owner.userId, t.b),
          projectId: null,
        }),
      ).toEqual([{ id: t.laneQ, projectId: t.q }]);
    });
  });
});

describe("list_administration_members", () => {
  test("answers every active member, userId, role and version alone, with no name or email", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      await tx.execute(sql`
        update "organization_members" set "version" = 4
        where "organization_id" = ${t.a} and "user_id" = ${t.member.userId}
      `);
      const rows = await listAdministrationMembers(
        tx,
        input(t.member.userId, t.a),
      );
      const byUser = (left: { userId: string }, right: { userId: string }) =>
        left.userId < right.userId ? -1 : 1;
      expect(rows).toEqual(
        [
          { userId: t.owner.userId, role: "owner", version: 1 },
          { userId: t.member.userId, role: "member", version: 4 },
        ].sort(byUser),
      );
      for (const row of rows)
        expect(Object.keys(row)).toEqual(["userId", "role", "version"]);
      const text = JSON.stringify(rows);
      for (const person of [t.owner, t.member, t.revoked, t.outsider]) {
        expect(text).not.toContain(person.name);
        expect(text).not.toContain(person.email);
      }
      expect(text).not.toContain(t.revoked.userId);
      expect(text).not.toContain(t.outsider.userId);
    });
  });

  test("answers a credential bound to a project with every member of the organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      expect(
        await listAdministrationMembers(tx, input(t.owner.userId, t.a, t.p1)),
      ).toEqual(
        await listAdministrationMembers(tx, input(t.owner.userId, t.a)),
      );
    });
  });

  test("names B's members only when read for B, with B's role", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      const rows = await listAdministrationMembers(
        tx,
        input(t.owner.userId, t.b),
      );
      expect(rows.map((row) => row.userId).sort()).toEqual(
        [t.owner.userId, t.outsider.userId].sort(),
      );
      expect(JSON.stringify(rows)).not.toContain(t.member.userId);
    });
  });
});

describe("the shared rule: an active member of an active organisation", () => {
  const reads = {
    list_administration_projects: (tx: Tx, read: OrganizationReadInput) =>
      listAdministrationProjects(tx, read),
    list_administration_lanes: (tx: Tx, read: OrganizationReadInput) =>
      listAdministrationLanes(tx, { ...read, projectId: null }),
    list_administration_members: (tx: Tx, read: OrganizationReadInput) =>
      listAdministrationMembers(tx, read),
  };

  test.each(Object.entries(reads))(
    "%s refuses a revoked member, a member of another organisation only, a suspended organisation and an operator's actor id",
    async (_name, read) => {
      await inRollbackTransaction(async (tx) => {
        const t = await seedTenants(tx);
        expect(
          await refusal(() => read(tx, input(t.revoked.userId, t.a))),
        ).toBe("forbidden");
        expect(
          await refusal(() => read(tx, input(t.outsider.userId, t.a))),
        ).toBe("forbidden");
        expect(
          await refusal(() =>
            read(tx, input(`operator:${crypto.randomUUID()}`, t.a)),
          ),
        ).toBe("forbidden");
        expect(await refusal(() => read(tx, input(t.member.userId, t.a)))).toBe(
          "answered",
        );
        await tx.execute(sql`
          update "organizations" set "status" = 'suspended' where "id" = ${t.a}
        `);
        expect(await refusal(() => read(tx, input(t.owner.userId, t.a)))).toBe(
          "forbidden",
        );
        await stillUsable(tx);
      });
    },
  );
});

/*
  As the dispatch runs them: F.3's `assertCurrent` on the operator's context
  (switched on, as a deployment with REQUESTPORT_OPERATOR_CREDENTIALS=enabled
  runs it), then the read, handed the member `memberAuthority` names, the
  credential's organisation and its project, in the one transaction.
*/
describe("an operator's read, after F.3's re-check in the same transaction", () => {
  async function issue(
    tx: Tx,
    input: {
      organizationId: string;
      userId: string;
      projectId?: string | null;
      scopes?: string[];
    },
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
    return createOperatorCredentialRepository(tx).createCredential({
      organizationId: input.organizationId,
      memberUserId: input.userId,
      projectId: input.projectId ?? null,
      betterAuthApiKeyId: apiKeyId,
      name: "Shared reads operator",
      prefix: "rpo_tst",
      fingerprint: `fingerprint_${crypto.randomUUID()}`,
      scopes: input.scopes ?? ["project:read", "org:read"],
      expiresInDays: 30,
      correlationId: crypto.randomUUID(),
    });
  }

  function contextFor(
    credential: Awaited<ReturnType<typeof issue>>,
  ): AuthorizedCommandContext {
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

  async function asOperator<T>(
    tx: Tx,
    context: AuthorizedCommandContext,
    read: (tx: Tx, input: OrganizationReadInput) => Promise<T>,
    switchValue: { operatorCredentials?: "enabled" | "disabled" } = {
      operatorCredentials: "enabled",
    },
  ) {
    await createCommandAuthorizationRepository(tx, switchValue).assertCurrent(
      context,
    );
    const member = memberAuthority(context);
    if (member?.via !== "operator") throw new Error("not an operator");
    return read(tx, {
      memberUserId: member.userId,
      organizationId: context.organizationId,
      credentialProjectId: context.projectId ?? null,
    });
  }

  const reads = {
    list_administration_projects: (tx: Tx, read: OrganizationReadInput) =>
      listAdministrationProjects(tx, read),
    list_administration_lanes: (tx: Tx, read: OrganizationReadInput) =>
      listAdministrationLanes(tx, { ...read, projectId: null }),
    list_administration_members: (tx: Tx, read: OrganizationReadInput) =>
      listAdministrationMembers(tx, read),
  };

  test("an operator issued for A by an owner of A and B reads A's rows and never B's", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      const context = contextFor(
        await issue(tx, { organizationId: t.a, userId: t.owner.userId }),
      );
      const projectsRead = await asOperator(
        tx,
        context,
        reads.list_administration_projects,
      );
      expect(projectsRead.map((row) => row.id).sort()).toEqual(
        [t.p1, t.p2, t.archived].sort(),
      );
      const lanesRead = await asOperator(
        tx,
        context,
        reads.list_administration_lanes,
      );
      expect(lanesRead.map((row) => row.id)).not.toContain(t.laneQ);
      const membersRead = await asOperator(
        tx,
        context,
        reads.list_administration_members,
      );
      expect(membersRead.map((row) => row.userId)).not.toContain(
        t.outsider.userId,
      );
      // B's identifiers in the query answer not_found.
      expect(
        await refusal(() =>
          asOperator(tx, context, (inner, read) =>
            listAdministrationLanes(inner, { ...read, projectId: t.q }),
          ),
        ),
      ).toBe("not_found");
      for (const rows of [projectsRead, lanesRead, membersRead])
        for (const id of [t.q, t.laneQ, t.b])
          expect(JSON.stringify(rows)).not.toContain(id);
    });
  });

  test("an operator bound to a project its member maintains reads that project alone, and not_found for another's lanes", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      const maintainer = await seedUser(tx, "Maintainer");
      await seedMembership(tx, t.a, maintainer.userId, "member");
      await seedProjectRole(tx, t.a, t.p1, maintainer.userId, "maintainer");
      const context = contextFor(
        await issue(tx, {
          organizationId: t.a,
          userId: maintainer.userId,
          projectId: t.p1,
        }),
      );
      expect(
        await asOperator(tx, context, reads.list_administration_projects),
      ).toEqual([{ id: t.p1, status: "active", canRepresent: true }]);
      expect(
        await asOperator(tx, context, reads.list_administration_lanes),
      ).toEqual([{ id: t.laneP1, projectId: t.p1 }]);
      for (const projectId of [t.p2, t.q])
        expect(
          await refusal(() =>
            asOperator(tx, context, (inner, read) =>
              listAdministrationLanes(inner, { ...read, projectId }),
            ),
          ),
          projectId,
        ).toBe("not_found");
      // Membership belongs to the organisation: every member is listed.
      expect(
        (await asOperator(tx, context, reads.list_administration_members))
          .map((row) => row.userId)
          .sort(),
      ).toEqual([t.owner.userId, t.member.userId, maintainer.userId].sort());
    });
  });

  /*
    Each change is made in the same rolled-back transaction, after the same
    call has been answered once in it, so a refusal below is the change's and
    not the setup's.
  */
  const changes: Record<
    string,
    (
      tx: Tx,
      t: Awaited<ReturnType<typeof seedTenants>>,
      id: string,
    ) => Promise<unknown>
  > = {
    "the operator credential is revoked": (tx, _t, id) =>
      tx.execute(sql`
        update "operator_credentials" set "revoked_at" = clock_timestamp()
        where "id" = ${id}
      `),
    "the operator credential has expired": (tx, _t, id) =>
      tx.execute(sql`
        update "operator_credentials"
        set "created_at" = clock_timestamp() - interval '2 days',
            "expires_at" = clock_timestamp() - interval '1 second'
        where "id" = ${id}
      `),
    "the member is demoted below an organisation-wide operator's rule": (
      tx,
      t,
    ) =>
      tx.execute(sql`
        update "organization_members" set "role" = 'member'
        where "organization_id" = ${t.a} and "user_id" = ${t.owner.userId}
      `),
    "the membership is revoked": (tx, t) =>
      tx.execute(sql`
        update "organization_members" set "status" = 'revoked'
        where "organization_id" = ${t.a} and "user_id" = ${t.owner.userId}
      `),
    "the organisation is suspended": (tx, t) =>
      tx.execute(sql`
        update "organizations" set "status" = 'suspended' where "id" = ${t.a}
      `),
  };

  /** Each read, typed alike, for the cases that only ask whether it answers. */
  const eachRead: [
    string,
    (tx: Tx, read: OrganizationReadInput) => Promise<unknown>,
  ][] = Object.entries(reads);

  for (const [name, read] of eachRead) {
    test.each(Object.keys(changes))(
      `${name} answers 403 with no rows when %s`,
      async (change) => {
        await inRollbackTransaction(async (tx) => {
          const t = await seedTenants(tx);
          const credential = await issue(tx, {
            organizationId: t.a,
            userId: t.owner.userId,
          });
          const context = contextFor(credential);
          expect(await refusal(() => asOperator(tx, context, read))).toBe(
            "answered",
          );
          await changes[change]?.(tx, t, credential.id);
          expect(await refusal(() => asOperator(tx, context, read))).toBe(
            "forbidden",
          );
          await stillUsable(tx);
        });
      },
    );
  }

  test("each read is refused while the deployment leaves operator credentials switched off", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      const context = contextFor(
        await issue(tx, { organizationId: t.a, userId: t.owner.userId }),
      );
      for (const [, read] of eachRead)
        expect(await refusal(() => asOperator(tx, context, read, {}))).toBe(
          "forbidden",
        );
    });
  });

  test("the operator's actor id reaches no query: a context naming a lineage that is not a uuid is refused, not failed", async () => {
    await inRollbackTransaction(async (tx) => {
      const t = await seedTenants(tx);
      const credential = await issue(tx, {
        organizationId: t.a,
        userId: t.owner.userId,
      });
      const context = {
        ...contextFor(credential),
        actor: operatorActor({
          lineageId: "not-a-uuid",
          memberUserId: t.owner.userId,
        }),
      };
      for (const [, read] of eachRead)
        expect(await refusal(() => asOperator(tx, context, read))).toBe(
          "forbidden",
        );
      await stillUsable(tx);
    });
  });
});
