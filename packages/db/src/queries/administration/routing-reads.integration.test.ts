import {
  type AuthorizedCommandContext,
  DomainError,
  evaluateRouteForMember,
  operatorActor,
} from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../../client.js";
import { createFoundationQueryRepository } from "../../repositories/foundation-query.js";
import { createOperatorCredentialRepository } from "../../repositories/operator-credential-repository.js";
import { createRoutingRepository } from "../../repositories/routing-repository.js";
import { lanes, projects, routingRules } from "../../schema/index.js";
import { tenantWrappingEnabled } from "../../tenant-context.js";
import { endingEachMethodBinding } from "../../test-support/tenant-binding.js";
import type { Tx } from "../../transaction.js";
import {
  evaluateRouteForOperator,
  listAdministrationRoutingRules,
  readRoutingRulesForOperator,
} from "./routing-reads.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  `list_administration_routing_rules` (Plan 13, F.2.1; `manifest-f2.md`
  §4.1), at the repository: what it returns, and whom it refuses. Then, since
  F.2.1's registry half, the two compositions `/api/v1` dispatches for an
  operator credential, in one transaction each: `readRoutingRulesForOperator`
  (the read) and `evaluateRouteForOperator` (route evaluation, both
  purposes), each re-checking the operator with the bus's own
  `assertCurrent` before it reads, against credentials issued through F.3's
  repository.

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

async function seedUser(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Routing read user', ${email}, now())
  `);
  return userId;
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Routing read tenant',
      ${`routing-read-${organizationId}`}, 'active')
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

async function seedProject(tx: Tx, organizationId: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [project] = await tx
    .insert(projects)
    .values({
      organizationId,
      name: `Routing read ${suffix}`,
      slug: `routing-read-${suffix}`,
      keyPrefix: `Q${suffix.slice(0, 4).toUpperCase()}`,
      status: "active",
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  const [lane] = await tx
    .insert(lanes)
    .values({
      organizationId,
      projectId: project.id,
      name: "Main",
      slug: "main",
    })
    .returning({ id: lanes.id });
  if (!lane) throw new Error("no lane");
  return { projectId: project.id, laneId: lane.id };
}

/**
 * An organisation with its owner and two rules: an allow from one project to
 * another, constrained on every set, and a disabled human-direct deny.
 */
async function seedTenant(tx: Tx) {
  const organizationId = await seedOrganization(tx);
  const ownerUserId = await seedUser(tx);
  await seedMembership(tx, organizationId, ownerUserId, "owner");
  const source = await seedProject(tx, organizationId);
  const target = await seedProject(tx, organizationId);
  const agentPrincipalId = crypto.randomUUID();
  const rows = await tx
    .insert(routingRules)
    .values([
      {
        organizationId,
        sourceKind: "project",
        sourceProjectId: source.projectId,
        targetProjectId: target.projectId,
        decision: "allow",
        requestTypes: ["bug", "feature"],
        laneIds: [target.laneId],
        priorities: ["urgent"],
        humanRoles: [],
        agentPrincipalIds: [agentPrincipalId],
        specificity: 5_000,
        enabled: true,
        version: 4,
        createdBy: `user:${ownerUserId}`,
      },
      {
        organizationId,
        sourceKind: "human_direct",
        targetProjectId: target.projectId,
        decision: "deny",
        humanRoles: ["member"],
        specificity: 1_099,
        enabled: false,
        version: 2,
        createdBy: `user:${ownerUserId}`,
      },
    ])
    .returning({ id: routingRules.id });
  return {
    organizationId,
    ownerUserId,
    source,
    target,
    agentPrincipalId,
    ruleIds: rows.map((row) => row.id),
  };
}

function read(
  tx: Tx,
  input: {
    memberUserId: string;
    organizationId: string;
    credentialProjectId?: string | null;
  },
) {
  return listAdministrationRoutingRules(tx, {
    credentialProjectId: null,
    ...input,
  });
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the read was not refused");
}

const fields = [
  "id",
  "version",
  "enabled",
  "sourceKind",
  "sourceProjectId",
  "targetProjectId",
  "decision",
  "requestTypes",
  "priorities",
  "humanRoles",
  "laneIds",
  "agentPrincipalIds",
].sort();

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("list_administration_routing_rules", () => {
  test("answers an owner with exactly the identifiers, versions and the fields update resends", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const rules = await read(tx, {
        memberUserId: tenant.ownerUserId,
        organizationId: tenant.organizationId,
      });
      for (const rule of rules)
        expect(Object.keys(rule).sort()).toEqual(fields);
      const byId = new Map(rules.map((rule) => [rule.id, rule]));
      expect(byId.get(tenant.ruleIds[0] ?? "")).toEqual({
        id: tenant.ruleIds[0],
        version: 4,
        enabled: true,
        sourceKind: "project",
        sourceProjectId: tenant.source.projectId,
        targetProjectId: tenant.target.projectId,
        decision: "allow",
        requestTypes: ["bug", "feature"],
        priorities: ["urgent"],
        humanRoles: [],
        laneIds: [tenant.target.laneId],
        agentPrincipalIds: [tenant.agentPrincipalId],
      });
      expect(byId.get(tenant.ruleIds[1] ?? "")).toEqual({
        id: tenant.ruleIds[1],
        version: 2,
        enabled: false,
        sourceKind: "human_direct",
        sourceProjectId: null,
        targetProjectId: tenant.target.projectId,
        decision: "deny",
        requestTypes: [],
        priorities: [],
        humanRoles: ["member"],
        laneIds: [],
        agentPrincipalIds: [],
      });
      expect(rules.map((rule) => rule.id)).toEqual([...tenant.ruleIds].sort());
      // Nothing the writes do not take: no author, no specificity, no
      // organisation.
      expect(JSON.stringify(rules)).not.toContain(tenant.ownerUserId);
      expect(JSON.stringify(rules)).not.toContain(tenant.organizationId);
    });
  });

  test("answers an admin, and an owner of an organisation with no rules with an empty list", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const admin = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, admin, "admin");
      expect(
        await read(tx, {
          memberUserId: admin,
          organizationId: tenant.organizationId,
        }),
      ).toHaveLength(2);
      const empty = await seedOrganization(tx);
      await seedMembership(tx, empty, tenant.ownerUserId, "owner");
      expect(
        await read(tx, {
          memberUserId: tenant.ownerUserId,
          organizationId: empty,
        }),
      ).toEqual([]);
    });
  });

  test("refuses a plain member, a revoked member, a stranger, and anyone in a suspended organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const member = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, member, "member");
      const revoked = await seedUser(tx);
      await seedMembership(
        tx,
        tenant.organizationId,
        revoked,
        "owner",
        "revoked",
      );
      const stranger = await seedUser(tx);
      for (const memberUserId of [member, revoked, stranger]) {
        const error = await refusal(
          read(tx, { memberUserId, organizationId: tenant.organizationId }),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("forbidden");
      }
      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${tenant.organizationId}
      `);
      const suspended = await refusal(
        read(tx, {
          memberUserId: tenant.ownerUserId,
          organizationId: tenant.organizationId,
        }),
      );
      expect((suspended as DomainError).code).toBe("forbidden");
    });
  });

  test("never reads another organisation's rules, for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const other = await seedTenant(tx);
      await seedMembership(tx, other.organizationId, home.ownerUserId, "owner");
      const rules = await read(tx, {
        memberUserId: home.ownerUserId,
        organizationId: home.organizationId,
      });
      expect(rules.map((rule) => rule.id).sort()).toEqual(
        [...home.ruleIds].sort(),
      );
      const answer = JSON.stringify(rules);
      for (const id of [
        ...other.ruleIds,
        other.source.projectId,
        other.target.projectId,
        other.target.laneId,
        other.agentPrincipalId,
      ]) {
        expect(answer).not.toContain(id);
      }
    });
  });

  test("a credential bound to a project is refused: the read is the organisation's", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const error = await refusal(
        read(tx, {
          memberUserId: tenant.ownerUserId,
          organizationId: tenant.organizationId,
          credentialProjectId: tenant.target.projectId,
        }),
      );
      expect((error as DomainError).code).toBe("forbidden");
      expect((error as DomainError).message).toBe(
        "Routing rules are read with a credential bound to no project",
      );
    });
  });

  test("an operator's actor id given as the member is refused, never raised from the database", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const error = await refusal(
        read(tx, {
          memberUserId: "operator:lineage",
          organizationId: tenant.organizationId,
        }),
      );
      expect((error as DomainError).code).toBe("forbidden");
      // Nothing raised in PostgreSQL: the transaction is still usable.
      expect(
        await read(tx, {
          memberUserId: tenant.ownerUserId,
          organizationId: tenant.organizationId,
        }),
      ).toHaveLength(2);
    });
  });
});

/**
 * Issues an operator credential for `userId` in `organizationId`, as F.3's
 * repository writes one, with the Better Auth key row it is bound to.
 */
async function issueOperator(
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
    name: "Routing operator",
    prefix: "rpo_f21",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: input.scopes ?? ["routing:manage", "request:create"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
  return { ...credential, apiKeyId };
}

/** The context `authenticateApiBearer` builds for an operator credential. */
function operatorContext(
  credential: Awaited<ReturnType<typeof issueOperator>>,
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

type Changed = {
  organizationId: string;
  userId: string;
  credentialId: string;
  apiKeyId: string;
};

/** Each change after which an operator that was answered is refused. */
const changes: Array<[string, (tx: Tx, ids: Changed) => Promise<void>]> = [
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
    "its member is demoted to a plain member",
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

describe.sequential("readRoutingRulesForOperator, as REST dispatches it", () => {
  test("answers an owner's organisation-wide operator with exactly its member's projection", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerUserId,
      });
      const rules = await readRoutingRulesForOperator(tx, {
        context: operatorContext(credential),
        operatorCredentials: "enabled",
      });
      expect(rules).toEqual(
        await read(tx, {
          memberUserId: tenant.ownerUserId,
          organizationId: tenant.organizationId,
        }),
      );
      expect(rules).toHaveLength(2);
      for (const rule of rules)
        expect(Object.keys(rule).sort()).toEqual(fields);
    });
  });

  test.each(changes)(
    "is refused once %s, having answered before",
    async (_, change) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const credential = await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.ownerUserId,
        });
        const context = operatorContext(credential);
        expect(
          await readRoutingRulesForOperator(tx, {
            context,
            operatorCredentials: "enabled",
          }),
        ).toHaveLength(2);
        await change(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.ownerUserId,
          credentialId: credential.id,
          apiKeyId: credential.apiKeyId,
        });
        const error = await refusal(
          readRoutingRulesForOperator(tx, {
            context,
            operatorCredentials: "enabled",
          }),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("forbidden");
      });
    },
  );

  test("the deployment's switch unset or disabled refuses, having answered with it enabled", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerUserId,
      });
      const context = operatorContext(credential);
      expect(
        await readRoutingRulesForOperator(tx, {
          context,
          operatorCredentials: "enabled",
        }),
      ).toHaveLength(2);
      for (const operatorCredentials of [undefined, "disabled"] as const) {
        const error = await refusal(
          readRoutingRulesForOperator(tx, { context, operatorCredentials }),
        );
        expect(error, String(operatorCredentials)).toBeInstanceOf(DomainError);
      }
    });
  });

  test("an admin's operator is answered", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const admin = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, admin, "admin");
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: admin,
      });
      expect(
        await readRoutingRulesForOperator(tx, {
          context: operatorContext(credential),
          operatorCredentials: "enabled",
        }),
      ).toHaveLength(2);
    });
  });

  test("an operator issued for one organisation never reads another's rules, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const other = await seedTenant(tx);
      await seedMembership(tx, other.organizationId, home.ownerUserId, "owner");
      const credential = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.ownerUserId,
      });
      const rules = await readRoutingRulesForOperator(tx, {
        context: operatorContext(credential),
        operatorCredentials: "enabled",
      });
      expect(rules.map((rule) => rule.id).sort()).toEqual(
        [...home.ruleIds].sort(),
      );
      const answer = JSON.stringify(rules);
      for (const id of [
        ...other.ruleIds,
        other.source.projectId,
        other.target.projectId,
      ])
        expect(answer).not.toContain(id);
    });
  });

  test("an operator bound to a project is refused: the rules are the organisation's", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerUserId,
        projectId: tenant.target.projectId,
      });
      const error = await refusal(
        readRoutingRulesForOperator(tx, {
          context: operatorContext(credential),
          operatorCredentials: "enabled",
        }),
      );
      expect((error as DomainError).code).toBe("forbidden");
      expect((error as DomainError).message).toBe(
        "Routing rules are read with a credential bound to no project",
      );
    });
  });

  test("a context that is not an operator's is refused before anything is read", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      for (const context of [
        {
          actor: { type: "user", id: tenant.ownerUserId },
          organizationId: tenant.organizationId,
          scopes: new Set(["routing:manage"]),
          credentialId: "session_probe",
          correlationId: crypto.randomUUID(),
        },
        {
          actor: {
            type: "service",
            id: "operator:probe",
            originatingActor: { type: "user", id: tenant.ownerUserId },
          },
          organizationId: tenant.organizationId,
          scopes: new Set(["routing:manage"]),
          credentialId: "operator_probe",
          correlationId: crypto.randomUUID(),
        },
      ] satisfies AuthorizedCommandContext[]) {
        const error = await refusal(
          readRoutingRulesForOperator(tx, {
            context,
            operatorCredentials: "enabled",
          }),
        );
        expect((error as DomainError).message).toBe(
          "This read admits an operator credential only",
        );
      }
    });
  });
});

describe.sequential("evaluateRouteForOperator, as REST dispatches it", () => {
  function parameters(values: Record<string, string>) {
    return new URLSearchParams(values);
  }

  /** The route the tenant's enabled allow rule decides, for the tester. */
  function allowedRoute(tenant: Awaited<ReturnType<typeof seedTenant>>) {
    return {
      sourceProjectId: tenant.source.projectId,
      targetProjectId: tenant.target.projectId,
      requestType: "feature",
      priority: "urgent",
      laneId: tenant.target.laneId,
      agentPrincipalId: tenant.agentPrincipalId,
    };
  }

  test("the tester and the preview answer an operator as they answer its member", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      // An enabled deny for the organisation's owners, on a request a person
      // raises directly, beside the tenant's two rules.
      const [deny] = await tx
        .insert(routingRules)
        .values({
          organizationId: tenant.organizationId,
          sourceKind: "human_direct",
          targetProjectId: tenant.target.projectId,
          decision: "deny",
          humanRoles: ["owner"],
          specificity: 1_099,
          enabled: true,
          version: 1,
          createdBy: `user:${tenant.ownerUserId}`,
        })
        .returning({ id: routingRules.id });
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerUserId,
      });
      const person: AuthorizedCommandContext = {
        actor: { type: "user", id: tenant.ownerUserId },
        organizationId: tenant.organizationId,
        scopes: new Set(["routing:manage", "request:create"]),
        credentialId: "session_probe",
        correlationId: crypto.randomUUID(),
      };
      const sources = {
        rules: createRoutingRepository(tx),
        members: createFoundationQueryRepository(tx),
      };
      const direct = {
        targetProjectId: tenant.target.projectId,
        requestType: "bug",
        priority: "normal",
      };
      for (const [purpose, route, expected] of [
        [
          "test",
          allowedRoute(tenant),
          { allowed: true, matchedRuleId: tenant.ruleIds[0] },
        ],
        ["test", direct, { allowed: false, matchedRuleId: deny?.id }],
        ["preview", direct, { allowed: false, matchedRuleId: deny?.id }],
        [
          "preview",
          { ...direct, sourceProjectId: tenant.source.projectId },
          { allowed: true, reason: "default_same_org" },
        ],
      ] as const) {
        const decision = await evaluateRouteForOperator(tx, {
          context: operatorContext(credential),
          purpose,
          searchParams: parameters(route),
          operatorCredentials: "enabled",
        });
        expect(decision, `${purpose} ${JSON.stringify(route)}`).toMatchObject(
          expected,
        );
        expect(decision).toEqual(
          await evaluateRouteForMember(sources, person, {
            ...route,
            purpose,
            organizationId: tenant.organizationId,
          }),
        );
      }
    });
  });

  test("writes the credential's organisation over the caller's, and reads each parameter's first value", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const other = await seedTenant(tx);
      await seedMembership(
        tx,
        other.organizationId,
        tenant.ownerUserId,
        "owner",
      );
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerUserId,
      });
      const search = parameters({
        ...allowedRoute(tenant),
        organizationId: other.organizationId,
      });
      search.append("priority", "low");
      expect(
        await evaluateRouteForOperator(tx, {
          context: operatorContext(credential),
          purpose: "test",
          searchParams: search,
          operatorCredentials: "enabled",
        }),
      ).toMatchObject({ allowed: true, matchedRuleId: tenant.ruleIds[0] });
    });
  });

  test("another organisation's rules never decide a route for an operator, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const other = await seedTenant(tx);
      await seedMembership(tx, other.organizationId, home.ownerUserId, "owner");
      const credential = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.ownerUserId,
      });
      const decision = await evaluateRouteForOperator(tx, {
        context: operatorContext(credential),
        purpose: "test",
        searchParams: parameters(allowedRoute(other)),
        operatorCredentials: "enabled",
      });
      expect(decision).toMatchObject({ reason: "default_same_org" });
      expect(JSON.stringify(decision)).not.toContain(other.ruleIds[0]);
    });
  });

  test("a parameter the purpose does not take, an unknown one or a missing one is invalid input", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerUserId,
      });
      const { laneId, agentPrincipalId, ...previewRoute } =
        allowedRoute(tenant);
      for (const [purpose, route] of [
        ["preview", { ...previewRoute, laneId }],
        ["preview", { ...previewRoute, agentPrincipalId }],
        ["test", { ...previewRoute, unknown: "value" }],
        ["test", { requestType: "bug", priority: "normal" }],
        ["test", { ...previewRoute, targetProjectId: "not-a-uuid" }],
      ] as const) {
        const error = await refusal(
          evaluateRouteForOperator(tx, {
            context: operatorContext(credential),
            purpose,
            searchParams: parameters(route),
            operatorCredentials: "enabled",
          }),
        );
        expect(
          (error as Error).name,
          `${purpose} ${JSON.stringify(route)}`,
        ).toBe("ZodError");
      }
    });
  });

  test("the principal carries the credential's scopes: a person-direct test without request:create is no_matching_permission", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerUserId,
        scopes: ["routing:manage"],
      });
      expect(
        await evaluateRouteForOperator(tx, {
          context: operatorContext(credential),
          purpose: "test",
          searchParams: parameters({
            targetProjectId: tenant.target.projectId,
            requestType: "bug",
            priority: "normal",
          }),
          operatorCredentials: "enabled",
        }),
      ).toMatchObject({
        allowed: false,
        reason: "no_matching_permission",
        evaluatedConstraints: ["human_direct", "request:create"],
      });
    });
  });

  test.each(["test", "preview"] as const)(
    "%s refuses an operator bound to a project before it parses the route",
    async (purpose) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const credential = await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.ownerUserId,
          projectId: tenant.target.projectId,
        });
        // A well-formed route, then three the schema would refuse as invalid
        // input: each is refused `forbidden` (403), never as a ZodError
        // (422), because the binding is checked first.
        const routes: Record<string, string>[] = [
          {
            targetProjectId: tenant.target.projectId,
            requestType: "bug",
            priority: "normal",
          },
          {},
          { requestType: "bug", priority: "normal", unknown: "value" },
          {
            targetProjectId: "not-a-uuid",
            requestType: "bug",
            priority: "normal",
          },
        ];
        for (const route of routes) {
          const error = await refusal(
            evaluateRouteForOperator(tx, {
              context: operatorContext(credential),
              purpose,
              searchParams: parameters(route),
              operatorCredentials: "enabled",
            }),
          );
          expect(error, JSON.stringify(route)).toBeInstanceOf(DomainError);
          expect((error as DomainError).code).toBe("forbidden");
          expect((error as DomainError).message).toBe(
            "Routes are evaluated with a credential bound to no project",
          );
        }
      });
    },
  );

  test.each(changes)(
    "is refused once %s, having answered before",
    async (_, change) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const credential = await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.ownerUserId,
        });
        const context = operatorContext(credential);
        const evaluate = (purpose: "test" | "preview") =>
          evaluateRouteForOperator(tx, {
            context,
            purpose,
            searchParams: parameters({
              targetProjectId: tenant.target.projectId,
              requestType: "bug",
              priority: "normal",
            }),
            operatorCredentials: "enabled",
          });
        expect(await evaluate("test")).toMatchObject({ allowed: true });
        await change(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.ownerUserId,
          credentialId: credential.id,
          apiKeyId: credential.apiKeyId,
        });
        for (const purpose of ["test", "preview"] as const) {
          const error = await refusal(evaluate(purpose));
          expect(error, purpose).toBeInstanceOf(DomainError);
          expect((error as DomainError).code, purpose).toBe("forbidden");
        }
      });
    },
  );

  test("the deployment's switch unset or disabled refuses, and a context that is not an operator's is refused", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerUserId,
      });
      const route = parameters({
        targetProjectId: tenant.target.projectId,
        requestType: "bug",
        priority: "normal",
      });
      for (const operatorCredentials of [undefined, "disabled"] as const) {
        const error = await refusal(
          evaluateRouteForOperator(tx, {
            context: operatorContext(credential),
            purpose: "test",
            searchParams: route,
            operatorCredentials,
          }),
        );
        expect(error, String(operatorCredentials)).toBeInstanceOf(DomainError);
      }
      const person = await refusal(
        evaluateRouteForOperator(tx, {
          context: {
            actor: { type: "user", id: tenant.ownerUserId },
            organizationId: tenant.organizationId,
            scopes: new Set(["routing:manage", "request:create"]),
            credentialId: "session_probe",
            correlationId: crypto.randomUUID(),
          },
          purpose: "test",
          searchParams: route,
          operatorCredentials: "enabled",
        }),
      );
      expect((person as DomainError).message).toBe(
        "This read admits an operator credential only",
      );
    });
  });
});
