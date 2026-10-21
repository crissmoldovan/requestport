import {
  type AuthorizedCommandContext,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../../client.js";
import { createOperatorCredentialRepository } from "../../repositories/operator-credential-repository.js";
import {
  lanes,
  projectMembers,
  projectRepositories,
  projects,
} from "../../schema/index.js";
import { tenantWrappingEnabled } from "../../tenant-context.js";
import type { Tx } from "../../transaction.js";
import { createProjectSettingsRepository } from "../project-settings-repository.js";
import {
  getAdministrationProjectSettings,
  readProjectSettingsForOperator,
} from "./project-settings-reads.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  `get_administration_project_settings` (Plan 13, F.2.3; `manifest-f2.md`
  §4.1), at the repository: what it returns, and whom it refuses. The first
  describe runs the projection alone, handed a member. The second runs
  `readProjectSettingsForOperator`, which is what the REST dispatch
  (`packages/core/src/administration-reads.ts`) calls inside its one
  transaction: the bus's `assertCurrent` on the operator's context — so
  `lockActiveOperatorAuthorization` — then the projection, for the member
  `memberAuthority` names, bound as the credential is.

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

async function seedUser(tx: Tx, name = "Settings reader") {
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
    values (${organizationId}, 'Settings read tenant',
      ${`settings-read-${organizationId}`}, 'active')
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

async function seedProject(tx: Tx, organizationId: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [project] = await tx
    .insert(projects)
    .values({
      organizationId,
      name: `Readable ${suffix}`,
      slug: `readable-${suffix}`,
      // All eight hex characters: with four, two projects seeded in one
      // organisation drew the same prefix often enough to fail a gate
      // (`projects_organization_key_prefix_ci_unique`, 2026-09-29).
      keyPrefix: `R${suffix.toUpperCase()}`,
      description: "What the metadata form resends",
      status: "active",
      heartbeatIntervalSeconds: 45,
      leaseMultiplier: 4,
      graceSeconds: 1_200,
      requiredWorkspaceFields: ["hostname"],
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  const [main, archived] = await tx
    .insert(lanes)
    .values([
      { organizationId, projectId: project.id, name: "Main", slug: "main" },
      {
        organizationId,
        projectId: project.id,
        name: "Old",
        slug: "old",
        status: "archived",
      },
    ])
    .returning({ id: lanes.id });
  await tx
    .update(projects)
    .set({ defaultLaneId: main?.id, version: 3 })
    .where(eq(projects.id, project.id));
  const [repository] = await tx
    .insert(projectRepositories)
    .values({
      organizationId,
      projectId: project.id,
      provider: "github",
      browseUrl: `https://github.com/settings-read/${suffix}`,
      cloneUrl: `https://github.com/settings-read/${suffix}.git`,
      repositorySlug: `settings-read/${suffix}`,
      isDefault: true,
      status: "active",
    })
    .returning({ id: projectRepositories.id });
  if (!main || !archived || !repository) throw new Error("no rows");
  return {
    projectId: project.id,
    mainLaneId: main.id,
    archivedLaneId: archived.id,
    repositoryId: repository.id,
  };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the read was not refused");
}

function read(
  tx: Tx,
  input: {
    memberUserId: string;
    organizationId: string;
    projectId: string;
    credentialProjectId?: string | null;
  },
) {
  return getAdministrationProjectSettings(tx, {
    credentialProjectId: null,
    ...input,
  });
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("get_administration_project_settings", () => {
  test("answers an owner with exactly the identifiers, versions and wholesale-replaced fields", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx, "Owner Person");
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const seeded = await seedProject(tx, organizationId);
      const member = await seedUser(tx, "Project Person");
      await seedMembership(tx, organizationId, member.userId, "member");
      await seedProjectRole(
        tx,
        organizationId,
        seeded.projectId,
        member.userId,
        "contributor",
      );

      const result = await read(tx, {
        memberUserId: owner.userId,
        organizationId,
        projectId: seeded.projectId,
      });

      expect(result).toEqual({
        id: seeded.projectId,
        version: 3,
        status: "active",
        defaultLaneId: seeded.mainLaneId,
        name: expect.stringMatching(/^Readable /u),
        description: "What the metadata form resends",
        heartbeatIntervalSeconds: 45,
        leaseMultiplier: 4,
        graceSeconds: 1_200,
        requiredWorkspaceFields: ["hostname"],
        repositories: [
          { id: seeded.repositoryId, isDefault: true, status: "active" },
        ],
        lanes: expect.arrayContaining([
          { id: seeded.mainLaneId, status: "active" },
          { id: seeded.archivedLaneId, status: "archived" },
        ]),
        members: [
          { userId: member.userId, role: "contributor", status: "active" },
        ],
      });
      expect(result.lanes).toHaveLength(2);
      // The keys are these and no others, so a later join cannot add a name
      // or an email without failing here.
      expect(Object.keys(result).sort()).toEqual(
        [
          "id",
          "version",
          "status",
          "defaultLaneId",
          "name",
          "description",
          "heartbeatIntervalSeconds",
          "leaseMultiplier",
          "graceSeconds",
          "requiredWorkspaceFields",
          "repositories",
          "lanes",
          "members",
        ].sort(),
      );
      for (const row of result.repositories)
        expect(Object.keys(row).sort()).toEqual(["id", "isDefault", "status"]);
      for (const row of result.lanes)
        expect(Object.keys(row).sort()).toEqual(["id", "status"]);
      for (const row of result.members)
        expect(Object.keys(row).sort()).toEqual(["role", "status", "userId"]);
      const text = JSON.stringify(result);
      for (const person of [owner, member]) {
        expect(text).not.toContain(person.name);
        expect(text).not.toContain(person.email);
      }
    });
  });

  test.each([
    ["an organisation admin", "admin", null],
    ["a maintainer of the project", "member", "maintainer"],
  ] as const)("answers %s", async (_, organizationRole, projectRole) => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const reader = await seedUser(tx);
      await seedMembership(tx, organizationId, reader.userId, organizationRole);
      const seeded = await seedProject(tx, organizationId);
      if (projectRole)
        await seedProjectRole(
          tx,
          organizationId,
          seeded.projectId,
          reader.userId,
          projectRole,
        );
      const result = await read(tx, {
        memberUserId: reader.userId,
        organizationId,
        projectId: seeded.projectId,
      });
      expect(result.id).toBe(seeded.projectId);
    });
  });

  test.each([
    ["a contributor", "contributor", "this"],
    ["a viewer", "viewer", "this"],
    ["a maintainer of another project", "maintainer", "other"],
    ["a member with no project role", null, "this"],
  ] as const)(
    "refuses %s, where the page read would answer with canManage false",
    async (_, projectRole, where) => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const reader = await seedUser(tx);
        await seedMembership(tx, organizationId, reader.userId, "member");
        const seeded = await seedProject(tx, organizationId);
        const other = await seedProject(tx, organizationId);
        if (projectRole)
          await seedProjectRole(
            tx,
            organizationId,
            where === "this" ? seeded.projectId : other.projectId,
            reader.userId,
            projectRole,
          );
        const page = await createProjectSettingsRepository(
          tx as never,
        ).getProject(reader.userId, organizationId, seeded.projectId);
        expect(page?.canManage).toBe(false);

        const error = await refusal(
          read(tx, {
            memberUserId: reader.userId,
            organizationId,
            projectId: seeded.projectId,
          }),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("forbidden");
      });
    },
  );

  test("refuses a revoked member, a revoked maintainer, and anyone in a suspended organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const seeded = await seedProject(tx, organizationId);
      const revoked = await seedUser(tx);
      await seedMembership(
        tx,
        organizationId,
        revoked.userId,
        "owner",
        "revoked",
      );
      const formerMaintainer = await seedUser(tx);
      await seedMembership(
        tx,
        organizationId,
        formerMaintainer.userId,
        "member",
      );
      await seedProjectRole(
        tx,
        organizationId,
        seeded.projectId,
        formerMaintainer.userId,
        "maintainer",
        "revoked",
      );
      for (const reader of [revoked, formerMaintainer]) {
        const error = await refusal(
          read(tx, {
            memberUserId: reader.userId,
            organizationId,
            projectId: seeded.projectId,
          }),
        );
        expect((error as DomainError).code).toBe("forbidden");
      }

      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${organizationId}
      `);
      const suspended = await refusal(
        read(tx, {
          memberUserId: owner.userId,
          organizationId,
          projectId: seeded.projectId,
        }),
      );
      expect((suspended as DomainError).code).toBe("forbidden");
    });
  });

  test("never reads another organisation's project, for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedOrganization(tx);
      const other = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, home, owner.userId, "owner");
      await seedMembership(tx, other, owner.userId, "owner");
      const own = await seedProject(tx, home);
      const foreign = await seedProject(tx, other);

      const error = await refusal(
        read(tx, {
          memberUserId: owner.userId,
          organizationId: home,
          projectId: foreign.projectId,
        }),
      );
      expect((error as DomainError).code).toBe("not_found");

      const result = await read(tx, {
        memberUserId: owner.userId,
        organizationId: home,
        projectId: own.projectId,
      });
      const text = JSON.stringify(result);
      for (const id of [
        foreign.projectId,
        foreign.mainLaneId,
        foreign.archivedLaneId,
        foreign.repositoryId,
      ])
        expect(text).not.toContain(id);
    });
  });

  test("a credential bound to one project reads that project, and no other", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const bound = await seedProject(tx, organizationId);
      const other = await seedProject(tx, organizationId);

      const own = await read(tx, {
        memberUserId: owner.userId,
        organizationId,
        projectId: bound.projectId,
        credentialProjectId: bound.projectId,
      });
      expect(own.id).toBe(bound.projectId);

      const error = await refusal(
        read(tx, {
          memberUserId: owner.userId,
          organizationId,
          projectId: other.projectId,
          credentialProjectId: bound.projectId,
        }),
      );
      expect((error as DomainError).code).toBe("not_found");
    });
  });

  test("an id that is not a UUID, and a member id that is an operator's, are answered, never raised from the database", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const seeded = await seedProject(tx, organizationId);

      for (const projectId of ["not-a-uuid", "operator:lineage", ""]) {
        const error = await refusal(
          read(tx, { memberUserId: owner.userId, organizationId, projectId }),
        );
        expect(error, projectId).toBeInstanceOf(DomainError);
        expect((error as DomainError).code, projectId).toBe("not_found");
      }
      // The operator's actor id is `operator:<lineageId>` (F3-2). It is not a
      // user id, so it holds no membership, and is refused as one.
      const operator = await refusal(
        read(tx, {
          memberUserId: `operator:${crypto.randomUUID()}`,
          organizationId,
          projectId: seeded.projectId,
        }),
      );
      expect((operator as DomainError).code).toBe("forbidden");
      // The transaction is still usable: nothing above raised in PostgreSQL.
      const [row] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, seeded.projectId));
      expect(row?.id).toBe(seeded.projectId);
    });
  });
});

/** A live operator credential holding `project:manage`, as F.3 issues one. */
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
  const credential = await createOperatorCredentialRepository(
    tx,
  ).createCredential({
    organizationId: input.organizationId,
    memberUserId: input.userId,
    projectId: input.projectId ?? null,
    betterAuthApiKeyId: apiKeyId,
    name: "Settings reader",
    prefix: "rpo_f23",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["project:manage"],
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

/**
 * The read as REST dispatches it. `operatorCredentials` is the deployment's
 * switch, `enabled` unless the case says otherwise (an explicit `undefined`
 * included, so a case can pass the unset switch).
 */
function readAsOperator(
  tx: Tx,
  context: AuthorizedCommandContext,
  projectId: string,
  ...switchValue: ["enabled" | "disabled" | undefined] | []
) {
  return readProjectSettingsForOperator(tx, {
    context,
    projectId,
    operatorCredentials: switchValue.length === 0 ? "enabled" : switchValue[0],
  });
}

describe.sequential("readProjectSettingsForOperator, as REST dispatches it", () => {
  test("answers an owner's operator with the projection its member would get", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const seeded = await seedProject(tx, organizationId);
      const { context } = await issueOperator(tx, {
        organizationId,
        userId: owner.userId,
      });
      expect(await readAsOperator(tx, context, seeded.projectId)).toEqual(
        await read(tx, {
          memberUserId: owner.userId,
          organizationId,
          projectId: seeded.projectId,
        }),
      );
    });
  });

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
  test.each(changes)(
    "refuses once %s, having answered before",
    async (_, change) => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedProject(tx, organizationId);
        const { credential, context, apiKeyId } = await issueOperator(tx, {
          organizationId,
          userId: owner.userId,
        });
        expect((await readAsOperator(tx, context, seeded.projectId)).id).toBe(
          seeded.projectId,
        );
        await change(tx, {
          organizationId,
          userId: owner.userId,
          credentialId: credential.id,
          apiKeyId,
        });
        const error = await refusal(
          readAsOperator(tx, context, seeded.projectId),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("forbidden");
      });
    },
  );

  test("refuses every operator while operator credentials are switched off", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const seeded = await seedProject(tx, organizationId);
      const { context } = await issueOperator(tx, {
        organizationId,
        userId: owner.userId,
      });
      expect(
        (await readAsOperator(tx, context, seeded.projectId, "enabled")).id,
      ).toBe(seeded.projectId);
      for (const setting of ["disabled", undefined] as const) {
        const error = await refusal(
          readAsOperator(tx, context, seeded.projectId, setting),
        );
        expect((error as DomainError).code, String(setting)).toBe("forbidden");
      }
    });
  });

  test("a contributor's operator is refused where the page read would answer canManage false", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const member = await seedUser(tx);
      await seedMembership(tx, organizationId, member.userId, "member");
      const seeded = await seedProject(tx, organizationId);
      await seedProjectRole(
        tx,
        organizationId,
        seeded.projectId,
        member.userId,
        "maintainer",
      );
      // F.3 issues a project-bound credential to a member only for a project
      // they maintain. The member is then made a contributor, and the
      // credential outlives the role.
      const { context } = await issueOperator(tx, {
        organizationId,
        userId: member.userId,
        projectId: seeded.projectId,
      });
      expect((await readAsOperator(tx, context, seeded.projectId)).id).toBe(
        seeded.projectId,
      );
      await tx
        .update(projectMembers)
        .set({ role: "contributor" })
        .where(eq(projectMembers.userId, member.userId));
      const page = await createProjectSettingsRepository(tx).getProject(
        member.userId,
        organizationId,
        seeded.projectId,
      );
      expect(page?.canManage).toBe(false);
      const error = await refusal(
        readAsOperator(tx, context, seeded.projectId),
      );
      expect((error as DomainError).code).toBe("forbidden");
    });
  });

  test("an operator issued for one organisation finds no project of another, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedOrganization(tx);
      const other = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, home, owner.userId, "owner");
      await seedMembership(tx, other, owner.userId, "owner");
      const foreign = await seedProject(tx, other);
      const { context } = await issueOperator(tx, {
        organizationId: home,
        userId: owner.userId,
      });
      const error = await refusal(
        readAsOperator(tx, context, foreign.projectId),
      );
      expect((error as DomainError).code).toBe("not_found");
    });
  });

  test("an operator bound to a project reads it, and finds no other project of its organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const bound = await seedProject(tx, organizationId);
      const other = await seedProject(tx, organizationId);
      const { context } = await issueOperator(tx, {
        organizationId,
        userId: owner.userId,
        projectId: bound.projectId,
      });
      expect((await readAsOperator(tx, context, bound.projectId)).id).toBe(
        bound.projectId,
      );
      const error = await refusal(readAsOperator(tx, context, other.projectId));
      expect((error as DomainError).code).toBe("not_found");
    });
  });

  test("a context that is not an operator's is refused before anything is read", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const seeded = await seedProject(tx, organizationId);
      const { context } = await issueOperator(tx, {
        organizationId,
        userId: owner.userId,
      });
      for (const stranger of [
        { ...context, credentialKind: undefined },
        { ...context, actor: { type: "user" as const, id: owner.userId } },
        {
          ...context,
          actor: { type: "agent" as const, id: crypto.randomUUID() },
          credentialKind: undefined,
        },
      ]) {
        const error = await refusal(
          readAsOperator(tx, stranger, seeded.projectId),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect(["forbidden", "unauthenticated"]).toContain(
          (error as DomainError).code,
        );
      }
    });
  });
});

type Changed = {
  organizationId: string;
  userId: string;
  credentialId: string;
  apiKeyId: string;
};
