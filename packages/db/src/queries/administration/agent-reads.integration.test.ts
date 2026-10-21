import {
  type AuthorizedCommandContext,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../../client.js";
import { createAgentRepository } from "../../repositories/agent-repository.js";
import { createOperatorCredentialRepository } from "../../repositories/operator-credential-repository.js";
import {
  agentPrincipals,
  projectMembers,
  projects,
} from "../../schema/index.js";
import { tenantWrappingEnabled } from "../../tenant-context.js";
import { endingEachMethodBinding } from "../../test-support/tenant-binding.js";
import type { Tx } from "../../transaction.js";
import {
  getAdministrationAgentPrincipal,
  listAdministrationAgentPrincipals,
  readAgentPrincipalForOperator,
  readAgentPrincipalsForOperator,
} from "./agent-reads.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  `list_administration_agent_principals` and
  `get_administration_agent_principal` (Plan 13, F.2.2; `manifest-f2.md`
  §4.1), at the repository: what they return, and whom they refuse. `/api/v1`
  reaches them for an operator credential through
  `readAgentPrincipalsForOperator` and `readAgentPrincipalForOperator`, which
  hand them the member F.3's `memberAuthority` names and the credential's
  organisation and project, after the bus's own `assertCurrent` in the same
  transaction; the last block below runs those.

  The rule both apply is `agentRepository.canManage`'s, the rule suspension
  applies: an active owner or admin of the active organisation, or an active
  maintainer of the principal's active project. The two revocations admit
  more people (`agent-reads.ts` says who), so the reads are narrower than
  those writes.

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

async function seedUser(tx: Tx, name = "Agent reader") {
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
    values (${organizationId}, 'Agent read tenant',
      ${`agent-read-${organizationId}`}, 'active')
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
      name: `Agents ${suffix}`,
      slug: `agents-${suffix}`,
      // All eight hex characters: with four, two projects seeded in one
      // organisation drew the same prefix often enough to fail a gate
      // (`projects_organization_key_prefix_ci_unique`, 2026-09-29).
      keyPrefix: `A${suffix.toUpperCase()}`,
      status,
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  return project.id;
}

async function seedPrincipal(
  tx: Tx,
  input: {
    organizationId: string;
    projectId: string | null;
    createdByUserId: string;
    status?: "active" | "suspended" | "revoked";
    version?: number;
  },
) {
  const id = crypto.randomUUID();
  await tx.insert(agentPrincipals).values({
    id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    displayName: `Readable agent ${id.slice(0, 8)}`,
    slug: `readable-${id}`,
    softwareName: "Agent software name",
    status: input.status ?? "active",
    version: input.version ?? 1,
    createdByUserId: input.createdByUserId,
  });
  return id;
}

/** One credential per api key, so every credential needs its own key. */
async function seedCredential(
  tx: Tx,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    projectId: string;
    userId: string;
    revoked?: boolean;
  },
) {
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, ${input.userId}, ${`plaintext_${apiKeyId}`},
      true, now() + interval '1 hour', now(), now())
  `);
  const id = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_credentials"
      ("id", "organization_id", "agent_principal_id",
       "better_auth_api_key_id", "name", "prefix", "fingerprint", "audience",
       "project_id", "lane_ids", "scopes", "version", "expires_at",
       "revoked_at", "created_by_user_id")
    values (${id}, ${input.organizationId}, ${input.agentPrincipalId},
      ${apiKeyId}, 'Credential display name', ${`rp_prefix_${id.slice(0, 6)}`},
      ${`fingerprint_${id}`}, 'mcp', ${input.projectId},
      '[]'::jsonb, '["request:read"]'::jsonb, 2,
      now() + interval '30 days',
      ${input.revoked ? sql`now()` : sql`null`}, ${input.userId})
  `);
  return { id, apiKeyId };
}

async function seedGrant(
  tx: Tx,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    projectId: string;
    userId: string;
  },
) {
  const clientId = `client_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_client"
      ("id", "client_id", "name", "redirect_uris", "disabled",
       "token_endpoint_auth_method", "require_pkce")
    values (${clientId}, ${clientId}, 'OAuth client display name',
      ${sql`array['https://example.invalid/callback']`}, false,
      'none', true)
  `);
  const consentId = `consent_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_consent" ("id", "client_id", "user_id", "scopes")
    values (${consentId}, ${clientId}, ${input.userId},
      ${sql`array['request:read']`})
  `);
  const id = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_oauth_grants"
      ("id", "organization_id", "agent_principal_id", "user_id",
       "oauth_client_id", "provider_grant_id", "refresh_family_id",
       "audience", "project_id", "lane_ids", "scopes", "status", "version",
       "expires_at", "revoked_at")
    values (${id}, ${input.organizationId}, ${input.agentPrincipalId},
      ${input.userId}, ${clientId}, ${consentId}, ${crypto.randomUUID()},
      'mcp', ${input.projectId}, '[]'::jsonb, '["request:read"]'::jsonb,
      'active', 3, now() + interval '30 days', null)
  `);
  return id;
}

/**
 * An organisation with an organisation-wide principal, a principal in each of
 * two active projects, and one in an archived project, which `canManage`
 * answers `false` for whoever asks.
 */
async function seedOrganizationWithAgents(tx: Tx) {
  const organizationId = await seedOrganization(tx);
  const owner = await seedUser(tx, "Owner Person");
  await seedMembership(tx, organizationId, owner.userId, "owner");
  const projectP = await seedProject(tx, organizationId);
  const projectQ = await seedProject(tx, organizationId);
  const archivedProject = await seedProject(tx, organizationId, "archived");
  const organizationWide = await seedPrincipal(tx, {
    organizationId,
    projectId: null,
    createdByUserId: owner.userId,
    status: "suspended",
    version: 4,
  });
  const inP = await seedPrincipal(tx, {
    organizationId,
    projectId: projectP,
    createdByUserId: owner.userId,
  });
  const inQ = await seedPrincipal(tx, {
    organizationId,
    projectId: projectQ,
    createdByUserId: owner.userId,
  });
  const inArchived = await seedPrincipal(tx, {
    organizationId,
    projectId: archivedProject,
    createdByUserId: owner.userId,
  });
  return {
    organizationId,
    owner,
    projectP,
    projectQ,
    archivedProject,
    principals: { organizationWide, inP, inQ, inArchived },
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

async function refusalCode(promise: Promise<unknown>) {
  const error = await refusal(promise);
  expect(error).toBeInstanceOf(DomainError);
  return (error as DomainError).code;
}

function list(
  tx: Tx,
  input: {
    memberUserId: string;
    organizationId: string;
    credentialProjectId?: string | null;
  },
) {
  return listAdministrationAgentPrincipals(tx, {
    credentialProjectId: null,
    ...input,
  });
}

function get(
  tx: Tx,
  input: {
    memberUserId: string;
    organizationId: string;
    agentPrincipalId: string;
    credentialProjectId?: string | null;
  },
) {
  return getAdministrationAgentPrincipal(tx, {
    credentialProjectId: null,
    ...input,
  });
}

const sorted = (values: readonly string[]) => [...values].sort();

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("list_administration_agent_principals", () => {
  test("answers an owner with exactly each manageable principal's id, project, status and version", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);

      const result = await list(tx, {
        memberUserId: seeded.owner.userId,
        organizationId: seeded.organizationId,
      });

      expect(result).toEqual(
        [
          {
            id: seeded.principals.organizationWide,
            projectId: null,
            status: "suspended",
            version: 4,
          },
          {
            id: seeded.principals.inP,
            projectId: seeded.projectP,
            status: "active",
            version: 1,
          },
          {
            id: seeded.principals.inQ,
            projectId: seeded.projectQ,
            status: "active",
            version: 1,
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      // The keys are these and no others, so a later join cannot add a name
      // without failing here.
      for (const row of result)
        expect(Object.keys(row).sort()).toEqual([
          "id",
          "projectId",
          "status",
          "version",
        ]);
      const text = JSON.stringify(result);
      expect(text).not.toContain("Readable agent");
      expect(text).not.toContain("Agent software name");
      expect(text).not.toContain(seeded.owner.name);
      expect(text).not.toContain(seeded.owner.email);
    });
  });

  test("holds exactly the principals canManage admits, for every standing", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const admin = await seedUser(tx);
      await seedMembership(tx, seeded.organizationId, admin.userId, "admin");
      const maintainerOfP = await seedUser(tx);
      await seedMembership(
        tx,
        seeded.organizationId,
        maintainerOfP.userId,
        "member",
      );
      await seedProjectRole(
        tx,
        seeded.organizationId,
        seeded.projectP,
        maintainerOfP.userId,
        "maintainer",
      );
      // A maintainer of the archived project too: canManage still says no.
      await seedProjectRole(
        tx,
        seeded.organizationId,
        seeded.archivedProject,
        maintainerOfP.userId,
        "maintainer",
      );
      const agents = createAgentRepository(tx);
      const everyPrincipal = Object.values(seeded.principals);

      for (const reader of [seeded.owner, admin, maintainerOfP]) {
        const admitted: string[] = [];
        for (const id of everyPrincipal) {
          const [principal] = await tx
            .select({ projectId: agentPrincipals.projectId })
            .from(agentPrincipals)
            .where(eq(agentPrincipals.id, id));
          if (
            await agents.canManage({
              organizationId: seeded.organizationId,
              projectId: principal?.projectId ?? null,
              actor: { type: "user", id: reader.userId },
            })
          )
            admitted.push(id);
        }
        const result = await list(tx, {
          memberUserId: reader.userId,
          organizationId: seeded.organizationId,
        });
        expect(sorted(result.map((row) => row.id)), reader.userId).toEqual(
          sorted(admitted),
        );
      }
      // And what that means for the maintainer: their project's principal only.
      const own = await list(tx, {
        memberUserId: maintainerOfP.userId,
        organizationId: seeded.organizationId,
      });
      expect(own.map((row) => row.id)).toEqual([seeded.principals.inP]);
    });
  });

  test.each([
    ["a contributor", "contributor"],
    ["a viewer", "viewer"],
    ["a member with no project role", null],
  ] as const)("refuses %s", async (_, projectRole) => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const reader = await seedUser(tx);
      await seedMembership(tx, seeded.organizationId, reader.userId, "member");
      if (projectRole)
        await seedProjectRole(
          tx,
          seeded.organizationId,
          seeded.projectP,
          reader.userId,
          projectRole,
        );
      expect(
        await refusalCode(
          list(tx, {
            memberUserId: reader.userId,
            organizationId: seeded.organizationId,
          }),
        ),
      ).toBe("forbidden");
    });
  });

  test("refuses a revoked member, a revoked maintainer, and anyone in a suspended organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const revoked = await seedUser(tx);
      await seedMembership(
        tx,
        seeded.organizationId,
        revoked.userId,
        "owner",
        "revoked",
      );
      const formerMaintainer = await seedUser(tx);
      await seedMembership(
        tx,
        seeded.organizationId,
        formerMaintainer.userId,
        "member",
      );
      await seedProjectRole(
        tx,
        seeded.organizationId,
        seeded.projectP,
        formerMaintainer.userId,
        "maintainer",
        "revoked",
      );
      for (const reader of [revoked, formerMaintainer])
        expect(
          await refusalCode(
            list(tx, {
              memberUserId: reader.userId,
              organizationId: seeded.organizationId,
            }),
          ),
        ).toBe("forbidden");

      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${seeded.organizationId}
      `);
      expect(
        await refusalCode(
          list(tx, {
            memberUserId: seeded.owner.userId,
            organizationId: seeded.organizationId,
          }),
        ),
      ).toBe("forbidden");
    });
  });

  test("never lists another organisation's principals, for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedOrganizationWithAgents(tx);
      const foreign = await seedOrganizationWithAgents(tx);
      await seedMembership(
        tx,
        foreign.organizationId,
        home.owner.userId,
        "owner",
      );

      const result = await list(tx, {
        memberUserId: home.owner.userId,
        organizationId: home.organizationId,
      });
      expect(result).toHaveLength(3);
      const text = JSON.stringify(result);
      for (const id of [
        ...Object.values(foreign.principals),
        foreign.projectP,
        foreign.projectQ,
      ])
        expect(text).not.toContain(id);
    });
  });

  test("a credential bound to one project lists that project's principals, and no organisation-wide one", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const bound = await list(tx, {
        memberUserId: seeded.owner.userId,
        organizationId: seeded.organizationId,
        credentialProjectId: seeded.projectP,
      });
      expect(bound.map((row) => row.id)).toEqual([seeded.principals.inP]);

      // A maintainer of Q holding a credential bound to P stands below the
      // rule for everything that credential could see.
      const maintainerOfQ = await seedUser(tx);
      await seedMembership(
        tx,
        seeded.organizationId,
        maintainerOfQ.userId,
        "member",
      );
      await seedProjectRole(
        tx,
        seeded.organizationId,
        seeded.projectQ,
        maintainerOfQ.userId,
        "maintainer",
      );
      expect(
        await refusalCode(
          list(tx, {
            memberUserId: maintainerOfQ.userId,
            organizationId: seeded.organizationId,
            credentialProjectId: seeded.projectP,
          }),
        ),
      ).toBe("forbidden");
    });
  });

  test("a member id that is an operator's is refused, never raised from the database", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      // The operator's actor id is `operator:<lineageId>` (F3-2). It is not a
      // user id, so it holds no membership, and is refused as one.
      expect(
        await refusalCode(
          list(tx, {
            memberUserId: `operator:${crypto.randomUUID()}`,
            organizationId: seeded.organizationId,
          }),
        ),
      ).toBe("forbidden");
      const [row] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, seeded.projectP));
      expect(row?.id).toBe(seeded.projectP);
    });
  });
});

describe.sequential("get_administration_agent_principal", () => {
  test("answers an owner with exactly the ids, versions and states the revocations and suspension compare", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const live = await seedCredential(tx, {
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.principals.inP,
        projectId: seeded.projectP,
        userId: seeded.owner.userId,
      });
      const revoked = await seedCredential(tx, {
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.principals.inP,
        projectId: seeded.projectP,
        userId: seeded.owner.userId,
        revoked: true,
      });
      const delegator = await seedUser(tx, "Delegating Person");
      await seedMembership(
        tx,
        seeded.organizationId,
        delegator.userId,
        "member",
      );
      const grantId = await seedGrant(tx, {
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.principals.inP,
        projectId: seeded.projectP,
        userId: delegator.userId,
      });

      const result = await get(tx, {
        memberUserId: seeded.owner.userId,
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.principals.inP,
      });

      expect(result).toEqual({
        id: seeded.principals.inP,
        status: "active",
        version: 1,
        credentials: [
          {
            id: live.id,
            version: 2,
            expiresAt: expect.any(Date),
            revokedAt: null,
          },
          {
            id: revoked.id,
            version: 2,
            expiresAt: expect.any(Date),
            revokedAt: expect.any(Date),
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
        oauthGrants: [
          {
            id: grantId,
            status: "active",
            version: 3,
            expiresAt: expect.any(Date),
            revokedAt: null,
          },
        ],
      });
      expect(Object.keys(result).sort()).toEqual([
        "credentials",
        "id",
        "oauthGrants",
        "status",
        "version",
      ]);
      for (const row of result.credentials)
        expect(Object.keys(row).sort()).toEqual([
          "expiresAt",
          "id",
          "revokedAt",
          "version",
        ]);
      for (const row of result.oauthGrants)
        expect(Object.keys(row).sort()).toEqual([
          "expiresAt",
          "id",
          "revokedAt",
          "status",
          "version",
        ]);
      // Never a key's prefix, fingerprint or plaintext, and never a name or
      // an email.
      const text = JSON.stringify(result);
      for (const credential of [live, revoked]) {
        expect(text).not.toContain(`rp_prefix_${credential.id.slice(0, 6)}`);
        expect(text).not.toContain(`fingerprint_${credential.id}`);
        expect(text).not.toContain(`plaintext_${credential.apiKeyId}`);
        expect(text).not.toContain(credential.apiKeyId);
      }
      for (const forbidden of [
        "Credential display name",
        "OAuth client display name",
        "Readable agent",
        "Agent software name",
        seeded.owner.name,
        seeded.owner.email,
        delegator.name,
        delegator.email,
        delegator.userId,
      ])
        expect(text).not.toContain(forbidden);
    });
  });

  test("answers a maintainer for their project's principal, and refuses them another project's and an organisation-wide one", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const maintainer = await seedUser(tx);
      await seedMembership(
        tx,
        seeded.organizationId,
        maintainer.userId,
        "member",
      );
      await seedProjectRole(
        tx,
        seeded.organizationId,
        seeded.projectP,
        maintainer.userId,
        "maintainer",
      );
      const own = await get(tx, {
        memberUserId: maintainer.userId,
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.principals.inP,
      });
      expect(own.id).toBe(seeded.principals.inP);

      for (const agentPrincipalId of [
        seeded.principals.inQ,
        seeded.principals.organizationWide,
        seeded.principals.inArchived,
      ])
        expect(
          await refusalCode(
            get(tx, {
              memberUserId: maintainer.userId,
              organizationId: seeded.organizationId,
              agentPrincipalId,
            }),
          ),
          agentPrincipalId,
        ).toBe("forbidden");

      const admin = await seedUser(tx);
      await seedMembership(tx, seeded.organizationId, admin.userId, "admin");
      const organizationWide = await get(tx, {
        memberUserId: admin.userId,
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.principals.organizationWide,
      });
      expect(organizationWide).toMatchObject({
        status: "suspended",
        version: 4,
      });
    });
  });

  test.each([
    ["a contributor", "contributor"],
    ["a viewer", "viewer"],
    ["a member with no project role", null],
  ] as const)("refuses %s", async (_, projectRole) => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const reader = await seedUser(tx);
      await seedMembership(tx, seeded.organizationId, reader.userId, "member");
      if (projectRole)
        await seedProjectRole(
          tx,
          seeded.organizationId,
          seeded.projectP,
          reader.userId,
          projectRole,
        );
      expect(
        await refusalCode(
          get(tx, {
            memberUserId: reader.userId,
            organizationId: seeded.organizationId,
            agentPrincipalId: seeded.principals.inP,
          }),
        ),
      ).toBe("forbidden");
    });
  });

  test("refuses a revoked member and anyone in a suspended organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const revoked = await seedUser(tx);
      await seedMembership(
        tx,
        seeded.organizationId,
        revoked.userId,
        "owner",
        "revoked",
      );
      expect(
        await refusalCode(
          get(tx, {
            memberUserId: revoked.userId,
            organizationId: seeded.organizationId,
            agentPrincipalId: seeded.principals.inP,
          }),
        ),
      ).toBe("forbidden");

      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${seeded.organizationId}
      `);
      expect(
        await refusalCode(
          get(tx, {
            memberUserId: seeded.owner.userId,
            organizationId: seeded.organizationId,
            agentPrincipalId: seeded.principals.inP,
          }),
        ),
      ).toBe("forbidden");
    });
  });

  test("never reads another organisation's principal, for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedOrganizationWithAgents(tx);
      const foreign = await seedOrganizationWithAgents(tx);
      await seedMembership(
        tx,
        foreign.organizationId,
        home.owner.userId,
        "owner",
      );
      const foreignCredential = await seedCredential(tx, {
        organizationId: foreign.organizationId,
        agentPrincipalId: foreign.principals.inP,
        projectId: foreign.projectP,
        userId: foreign.owner.userId,
      });

      expect(
        await refusalCode(
          get(tx, {
            memberUserId: home.owner.userId,
            organizationId: home.organizationId,
            agentPrincipalId: foreign.principals.inP,
          }),
        ),
      ).toBe("not_found");

      const own = await get(tx, {
        memberUserId: home.owner.userId,
        organizationId: home.organizationId,
        agentPrincipalId: home.principals.inP,
      });
      const text = JSON.stringify(own);
      expect(text).not.toContain(foreignCredential.id);
      expect(text).not.toContain(foreign.principals.inP);
    });
  });

  test("a credential bound to one project reads that project's principal, and no other", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const own = await get(tx, {
        memberUserId: seeded.owner.userId,
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.principals.inP,
        credentialProjectId: seeded.projectP,
      });
      expect(own.id).toBe(seeded.principals.inP);

      for (const agentPrincipalId of [
        seeded.principals.inQ,
        seeded.principals.organizationWide,
      ])
        expect(
          await refusalCode(
            get(tx, {
              memberUserId: seeded.owner.userId,
              organizationId: seeded.organizationId,
              agentPrincipalId,
              credentialProjectId: seeded.projectP,
            }),
          ),
          agentPrincipalId,
        ).toBe("not_found");
    });
  });

  test("an id that is not a UUID, and a member id that is an operator's, are answered, never raised from the database", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      for (const agentPrincipalId of ["not-a-uuid", "operator:lineage", ""])
        expect(
          await refusalCode(
            get(tx, {
              memberUserId: seeded.owner.userId,
              organizationId: seeded.organizationId,
              agentPrincipalId,
            }),
          ),
          agentPrincipalId,
        ).toBe("not_found");
      expect(
        await refusalCode(
          get(tx, {
            memberUserId: `operator:${crypto.randomUUID()}`,
            organizationId: seeded.organizationId,
            agentPrincipalId: seeded.principals.inP,
          }),
        ),
      ).toBe("forbidden");
      // The transaction is still usable: nothing above raised in PostgreSQL.
      const [row] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, seeded.projectP));
      expect(row?.id).toBe(seeded.projectP);
    });
  });
});

/*
  Plan 13, F.2.2's registry half: the two reads as `/api/v1` dispatches them
  for an operator credential (`packages/core/src/administration-reads.ts`),
  each in the caller's one transaction — the bus's own `assertCurrent` on the
  context first, under the deployment's switch, then the projection for the
  member `memberAuthority` names, in the credential's organisation and bound
  to its project. The credentials are issued through F.3's repository.
*/

/**
 * Issues an operator credential for `userId` in `organizationId`, holding
 * `agent:revoke`, as F.3's repository writes one, with the Better Auth key row
 * it is bound to, and the context `authenticateApiBearer` builds for it.
 */
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
    name: "Agent reader",
    prefix: "rpo_f22",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["agent:revoke"],
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

type Switch = "enabled" | "disabled" | undefined;

/** The list as REST dispatches it, with the switch `enabled` unless given. */
function listAsOperator(
  tx: Tx,
  context: AuthorizedCommandContext,
  ...switchValue: [Switch] | []
) {
  return readAgentPrincipalsForOperator(tx, {
    context,
    operatorCredentials: switchValue.length === 0 ? "enabled" : switchValue[0],
  });
}

/** The detail as REST dispatches it, with the switch `enabled` unless given. */
function getAsOperator(
  tx: Tx,
  context: AuthorizedCommandContext,
  agentPrincipalId: string,
  ...switchValue: [Switch] | []
) {
  return readAgentPrincipalForOperator(tx, {
    context,
    agentPrincipalId,
    operatorCredentials: switchValue.length === 0 ? "enabled" : switchValue[0],
  });
}

type Changed = {
  organizationId: string;
  userId: string;
  credentialId: string;
  apiKeyId: string;
};

describe.sequential("the agent reads for an operator, as REST dispatches them", () => {
  test("answer an owner's operator with exactly what its member would get", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      await seedCredential(tx, {
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.principals.inP,
        projectId: seeded.projectP,
        userId: seeded.owner.userId,
      });
      await seedGrant(tx, {
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.principals.inP,
        projectId: seeded.projectP,
        userId: seeded.owner.userId,
      });
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      const member = {
        memberUserId: seeded.owner.userId,
        organizationId: seeded.organizationId,
      };
      expect(await listAsOperator(tx, context)).toEqual(await list(tx, member));
      expect(await getAsOperator(tx, context, seeded.principals.inP)).toEqual(
        await get(tx, { ...member, agentPrincipalId: seeded.principals.inP }),
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
    "refuse once %s, having answered before",
    async (_, change) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedOrganizationWithAgents(tx);
        const { credential, context, apiKeyId } = await issueOperator(tx, {
          organizationId: seeded.organizationId,
          userId: seeded.owner.userId,
        });
        expect((await listAsOperator(tx, context)).length).toBe(3);
        expect(
          (await getAsOperator(tx, context, seeded.principals.inP)).id,
        ).toBe(seeded.principals.inP);
        await change(tx, {
          organizationId: seeded.organizationId,
          userId: seeded.owner.userId,
          credentialId: credential.id,
          apiKeyId,
        });
        expect(await refusalCode(listAsOperator(tx, context))).toBe(
          "forbidden",
        );
        expect(
          await refusalCode(getAsOperator(tx, context, seeded.principals.inP)),
        ).toBe("forbidden");
      });
    },
  );

  test("refuse every operator while operator credentials are switched off", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      expect((await listAsOperator(tx, context, "enabled")).length).toBe(3);
      for (const setting of ["disabled", undefined] as const) {
        expect(
          await refusalCode(listAsOperator(tx, context, setting)),
          String(setting),
        ).toBe("forbidden");
        expect(
          await refusalCode(
            getAsOperator(tx, context, seeded.principals.inP, setting),
          ),
          String(setting),
        ).toBe("forbidden");
      }
    });
  });

  test("a maintainer's operator bound to the maintained project reads that project's principals alone, and is refused once the member is a contributor", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const maintainer = await seedUser(tx);
      await seedMembership(
        tx,
        seeded.organizationId,
        maintainer.userId,
        "member",
      );
      await seedProjectRole(
        tx,
        seeded.organizationId,
        seeded.projectP,
        maintainer.userId,
        "maintainer",
      );
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: maintainer.userId,
        projectId: seeded.projectP,
      });
      expect((await listAsOperator(tx, context)).map((row) => row.id)).toEqual([
        seeded.principals.inP,
      ]);
      expect((await getAsOperator(tx, context, seeded.principals.inP)).id).toBe(
        seeded.principals.inP,
      );
      await tx
        .update(projectMembers)
        .set({ role: "contributor" })
        .where(eq(projectMembers.userId, maintainer.userId));
      expect(await refusalCode(listAsOperator(tx, context))).toBe("forbidden");
      expect(
        await refusalCode(getAsOperator(tx, context, seeded.principals.inP)),
      ).toBe("forbidden");
    });
  });

  test("an operator issued for one organisation finds no principal of another, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedOrganizationWithAgents(tx);
      const foreign = await seedOrganizationWithAgents(tx);
      await seedMembership(
        tx,
        foreign.organizationId,
        home.owner.userId,
        "owner",
      );
      const { context } = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.owner.userId,
      });
      const listed = JSON.stringify(await listAsOperator(tx, context));
      for (const id of Object.values(foreign.principals)) {
        expect(listed).not.toContain(id);
        expect(await refusalCode(getAsOperator(tx, context, id)), id).toBe(
          "not_found",
        );
      }
    });
  });

  test("an operator bound to a project reads that project's principal, and finds no other", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
        projectId: seeded.projectP,
      });
      expect((await listAsOperator(tx, context)).map((row) => row.id)).toEqual([
        seeded.principals.inP,
      ]);
      expect((await getAsOperator(tx, context, seeded.principals.inP)).id).toBe(
        seeded.principals.inP,
      );
      for (const id of [
        seeded.principals.inQ,
        seeded.principals.organizationWide,
      ])
        expect(await refusalCode(getAsOperator(tx, context, id)), id).toBe(
          "not_found",
        );
    });
  });

  test("a context that is not an operator's is refused before anything is read", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedOrganizationWithAgents(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      for (const stranger of [
        { ...context, credentialKind: undefined },
        {
          ...context,
          actor: { type: "user" as const, id: seeded.owner.userId },
        },
        {
          ...context,
          actor: { type: "agent" as const, id: crypto.randomUUID() },
          credentialKind: undefined,
        },
      ]) {
        const listed = await refusal(listAsOperator(tx, stranger));
        const got = await refusal(
          getAsOperator(tx, stranger, seeded.principals.inP),
        );
        for (const error of [listed, got]) {
          expect(error).toBeInstanceOf(DomainError);
          expect((error as DomainError).code).toBe("forbidden");
          expect((error as DomainError).message).toBe(
            "This read admits an operator credential only",
          );
        }
      }
    });
  });
});
