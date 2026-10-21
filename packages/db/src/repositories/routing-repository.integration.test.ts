import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  actorFingerprint,
  createCoreCommandRegistry,
  DomainError,
  evaluateRouteForMember,
  type JsonObject,
  keyedFingerprint,
  operatorActor,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  agentPrincipals,
  commandReceipts,
  domainEvents,
  lanes,
  projectMembers,
  projects,
  routingRules,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import {
  endingEachCommandBinding,
  endingEachMethodBinding,
  endTenantBinding,
} from "../test-support/tenant-binding.js";
import type { Tx } from "../transaction.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";
import { createCommandTransactionManager } from "./command-repository.js";
import { createFoundationQueryRepository } from "./foundation-query.js";
import { createOperatorCredentialRepository } from "./operator-credential-repository.js";
import { createRoutingRepository } from "./routing-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  The first real-database suite for the routing repository (Plan 13, F.2.1;
  `manifest-f2.md` §2.7). The three rule commands run through the command
  bus the settings forms use, with the real unit of work, the real `routing`
  port and the real `assertCurrent`. Route evaluation runs through
  `evaluateRouteForMember` on this transaction's repositories, after
  `assertCurrent`, which is what `apps/web/src/lib/server-routing-actions.ts`
  does for the tester and the preview.

  Each case runs inside a transaction that is rolled back at the end. The bus
  opens its own transaction per command, which Drizzle turns into a savepoint
  inside the outer one.
*/

const busSecret = "routing-live-bus-fingerprint-secret-00000000000";

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
}

/**
 * The ports the bus opens. Operator credentials are switched on here, as a
 * deployment with `REQUESTPORT_OPERATOR_CREDENTIALS=enabled` has them; the
 * switch changes nothing for a person, and with it off `assertCurrent`
 * refuses every operator before these commands run (F.3's own suite holds
 * that, and *an operator credential* below holds it for these commands).
 */
function portFactory(
  name: string,
  database: Database | Tx,
  operatorCredentials: "enabled" | "disabled" | undefined,
) {
  if (name === "routing") return createRoutingRepository(database);
  if (name === "commandAuthorization")
    return createCommandAuthorizationRepository(database, {
      operatorCredentials,
    });
  return undefined;
}

function bus(
  tx: Tx,
  options: {
    assertCurrent?: boolean;
    operatorCredentials?: "enabled" | "disabled" | undefined;
  } = {},
) {
  const switchValue =
    "operatorCredentials" in options ? options.operatorCredentials : "enabled";
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    // A case runs commands for several people or organisations on one
    // transaction; each command's binding ends with it, as its own
    // transaction ends it in production (test-support/tenant-binding.ts).
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(
        tx as unknown as Database,
        (name, database) => portFactory(name, database, switchValue),
      ),
      tx,
    ),
    fingerprintSecret: busSecret,
    ...(options.assertCurrent === false
      ? {}
      : {
          authorizeContext: (context: AuthorizedCommandContext, uow) =>
            uow
              .port<ReturnType<typeof createCommandAuthorizationRepository>>(
                "commandAuthorization",
              )
              .assertCurrent(context),
        }),
  });
}

/**
 * What the web's evaluation helper does, on this transaction. The re-check
 * binds the context's organisation, and the helper's own transaction would
 * end that binding with it; here it is ended when the evaluation settles.
 */
async function evaluate(
  tx: Tx,
  context: AuthorizedCommandContext,
  input: Record<string, unknown>,
) {
  try {
    await createCommandAuthorizationRepository(tx).assertCurrent(context);
    return await evaluateRouteForMember(
      {
        rules: createRoutingRepository(tx),
        members: createFoundationQueryRepository(tx),
      },
      context,
      input,
    );
  } finally {
    await endTenantBinding(tx);
  }
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
    values (${userId}, 'Routing user', ${email}, now())
  `);
  const sessionId = `session_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "session" ("id", "expires_at", "token", "updated_at", "user_id")
    values (${sessionId}, now() + interval '1 hour',
      ${`token_${crypto.randomUUID()}`}, now(), ${userId})
  `);
  return { userId, sessionId };
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Routing tenant',
      ${`routing-live-${organizationId}`}, 'active')
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
      name: `Routing ${suffix}`,
      slug: `routing-${suffix}`,
      keyPrefix: `R${suffix.slice(0, 4).toUpperCase()}`,
      status,
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

async function seedAgentPrincipal(
  tx: Tx,
  organizationId: string,
  createdByUserId: string,
) {
  const id = crypto.randomUUID();
  await tx.insert(agentPrincipals).values({
    id,
    organizationId,
    displayName: "Routing agent",
    slug: `routing-agent-${id.slice(0, 8)}`,
    createdByUserId,
  });
  return id;
}

/** An organisation, its owner, and two active projects. */
async function seedTenant(tx: Tx) {
  const organizationId = await seedOrganization(tx);
  const owner = await seedUser(tx);
  await seedMembership(tx, organizationId, owner.userId, "owner");
  const source = await seedProject(tx, organizationId);
  const target = await seedProject(tx, organizationId);
  return { organizationId, owner, source, target };
}

function humanContext(input: {
  userId: string;
  sessionId: string;
  organizationId: string;
  scopes?: readonly string[];
}): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: input.userId },
    organizationId: input.organizationId,
    scopes: new Set(input.scopes ?? ["routing:manage", "request:create"]),
    credentialId: input.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

function key() {
  return `routing-live-${crypto.randomUUID()}`;
}

function ruleInput(
  organizationId: string,
  targetProjectId: string,
  fields: Record<string, unknown> = {},
) {
  return {
    organizationId,
    sourceKind: "human_direct",
    targetProjectId,
    decision: "deny",
    ...fields,
  };
}

async function run(
  tx: Tx,
  input: {
    name:
      | "create_routing_rule"
      | "update_routing_rule"
      | "disable_routing_rule";
    context: AuthorizedCommandContext;
    input: Record<string, unknown>;
    expectedVersion: number;
    idempotencyKey?: string;
  },
  options: {
    assertCurrent?: boolean;
    operatorCredentials?: "enabled" | "disabled" | undefined;
  } = {},
) {
  return bus(tx, options).execute<unknown, JsonObject>({
    name: input.name,
    context: input.context,
    input: input.input,
    meta: {
      idempotencyKey: input.idempotencyKey ?? key(),
      expectedVersion: input.expectedVersion,
    },
  });
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the call was not refused");
}

async function rulesOf(tx: Tx, organizationId: string) {
  return tx
    .select({
      id: routingRules.id,
      version: routingRules.version,
      enabled: routingRules.enabled,
      decision: routingRules.decision,
      createdBy: routingRules.createdBy,
    })
    .from(routingRules)
    .where(eq(routingRules.organizationId, organizationId));
}

async function ruleEvents(tx: Tx, organizationId: string) {
  return tx
    .select({
      actor: domainEvents.actor,
      aggregateId: domainEvents.aggregateId,
      data: domainEvents.data,
    })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.organizationId, organizationId),
        eq(domainEvents.type, "routing_rule.changed.v1"),
      ),
    );
}

async function receiptsFor(tx: Tx, commandName: string, userId: string) {
  return tx
    .select({
      idempotencyFingerprint: commandReceipts.idempotencyFingerprint,
      resultJson: commandReceipts.resultJson,
    })
    .from(commandReceipts)
    .where(
      and(
        eq(commandReceipts.commandName, commandName),
        eq(
          commandReceipts.actorFingerprint,
          actorFingerprint({ type: "user", id: userId }),
        ),
      ),
    );
}

/** Every receipt the person holds, under any command name. */
async function allReceiptsOf(tx: Tx, userId: string) {
  return tx
    .select({ commandName: commandReceipts.commandName })
    .from(commandReceipts)
    .where(
      eq(
        commandReceipts.actorFingerprint,
        actorFingerprint({ type: "user", id: userId }),
      ),
    );
}

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
    scopes: input.scopes ?? ["routing:manage"],
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

/** A rule the owner creates, to update, disable or evaluate against. */
async function ownerRule(
  tx: Tx,
  tenant: Awaited<ReturnType<typeof seedTenant>>,
  fields: Record<string, unknown> = {},
) {
  const rule = await run(tx, {
    name: "create_routing_rule",
    context: humanContext({
      ...tenant.owner,
      organizationId: tenant.organizationId,
    }),
    input: ruleInput(tenant.organizationId, tenant.target.projectId, fields),
    expectedVersion: 0,
  });
  return rule.id as string;
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("routing rules through the command bus", () => {
  describe("the role matrix", () => {
    test.each([
      ["an organisation owner", "owner"],
      ["an organisation admin", "admin"],
    ] as const)("%s may create, update and disable a rule", async (_, role) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const actor = await seedUser(tx);
        await seedMembership(tx, tenant.organizationId, actor.userId, role);
        const context = humanContext({
          ...actor,
          organizationId: tenant.organizationId,
        });
        const created = await run(tx, {
          name: "create_routing_rule",
          context,
          input: ruleInput(tenant.organizationId, tenant.target.projectId),
          expectedVersion: 0,
        });
        expect(created).toMatchObject({ version: 1, enabled: true });
        const updated = await run(tx, {
          name: "update_routing_rule",
          context,
          input: {
            ...ruleInput(tenant.organizationId, tenant.target.projectId, {
              decision: "allow",
            }),
            ruleId: created.id,
          },
          expectedVersion: 1,
        });
        expect(updated).toMatchObject({ version: 2, decision: "allow" });
        const disabled = await run(tx, {
          name: "disable_routing_rule",
          context,
          input: { organizationId: tenant.organizationId, ruleId: created.id },
          expectedVersion: 2,
        });
        expect(disabled).toMatchObject({ version: 3, enabled: false });
        expect(await rulesOf(tx, tenant.organizationId)).toEqual([
          {
            id: created.id,
            version: 3,
            enabled: false,
            decision: "allow",
            createdBy: `user:${actor.userId}`,
          },
        ]);
      });
    });

    test("a plain member is refused every rule command, and nothing is written", async () => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const ruleId = await ownerRule(tx, tenant);
        const member = await seedUser(tx);
        await seedMembership(
          tx,
          tenant.organizationId,
          member.userId,
          "member",
        );
        const context = humanContext({
          ...member,
          organizationId: tenant.organizationId,
        });
        const attempts = [
          {
            name: "create_routing_rule" as const,
            input: ruleInput(tenant.organizationId, tenant.target.projectId),
            expectedVersion: 0,
          },
          {
            name: "update_routing_rule" as const,
            input: {
              ...ruleInput(tenant.organizationId, tenant.target.projectId),
              ruleId,
            },
            expectedVersion: 1,
          },
          {
            name: "disable_routing_rule" as const,
            input: { organizationId: tenant.organizationId, ruleId },
            expectedVersion: 1,
          },
        ];
        for (const attempt of attempts) {
          const error = await refusal(run(tx, { ...attempt, context }));
          expect(error, attempt.name).toBeInstanceOf(DomainError);
          expect((error as DomainError).code, attempt.name).toBe("forbidden");
          expect((error as DomainError).message, attempt.name).toBe(
            "Organization routing authority is required",
          );
          expect(
            await receiptsFor(tx, attempt.name, member.userId),
            attempt.name,
          ).toEqual([]);
        }
        expect(await rulesOf(tx, tenant.organizationId)).toEqual([
          expect.objectContaining({ id: ruleId, version: 1, enabled: true }),
        ]);
        expect(await ruleEvents(tx, tenant.organizationId)).toHaveLength(1);
      });
    });

    test("a revoked membership, and a suspended organisation, are refused", async () => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const revoked = await seedUser(tx);
        await seedMembership(
          tx,
          tenant.organizationId,
          revoked.userId,
          "owner",
          "revoked",
        );
        const first = await refusal(
          run(tx, {
            name: "create_routing_rule",
            context: humanContext({
              ...revoked,
              organizationId: tenant.organizationId,
            }),
            input: ruleInput(tenant.organizationId, tenant.target.projectId),
            expectedVersion: 0,
          }),
        );
        expect((first as DomainError).code).toBe("forbidden");

        await tx.execute(sql`
          update "organizations" set "status" = 'suspended'
          where "id" = ${tenant.organizationId}
        `);
        const second = await refusal(
          run(tx, {
            name: "create_routing_rule",
            context: humanContext({
              ...tenant.owner,
              organizationId: tenant.organizationId,
            }),
            input: ruleInput(tenant.organizationId, tenant.target.projectId),
            expectedVersion: 0,
          }),
        );
        expect((second as DomainError).code).toBe("forbidden");
        expect(await rulesOf(tx, tenant.organizationId)).toEqual([]);
      });
    });

    test("another organisation's rule is not found, even for an owner of both", async () => {
      await inRollbackTransaction(async (tx) => {
        const home = await seedTenant(tx);
        const other = await seedTenant(tx);
        await seedMembership(
          tx,
          other.organizationId,
          home.owner.userId,
          "owner",
        );
        const foreignRuleId = await ownerRule(tx, other);
        const context = humanContext({
          ...home.owner,
          organizationId: home.organizationId,
        });
        const update = await refusal(
          run(tx, {
            name: "update_routing_rule",
            context,
            input: {
              ...ruleInput(home.organizationId, home.target.projectId),
              ruleId: foreignRuleId,
            },
            expectedVersion: 1,
          }),
        );
        expect((update as DomainError).code).toBe("not_found");
        expect((update as DomainError).message).toBe(
          "Routing rule was not found",
        );
        const disable = await refusal(
          run(tx, {
            name: "disable_routing_rule",
            context,
            input: {
              organizationId: home.organizationId,
              ruleId: foreignRuleId,
            },
            expectedVersion: 1,
          }),
        );
        expect((disable as DomainError).code).toBe("not_found");
        expect(await rulesOf(tx, other.organizationId)).toEqual([
          expect.objectContaining({
            id: foreignRuleId,
            version: 1,
            enabled: true,
          }),
        ]);
      });
    });

    test("a rule naming another organisation's project or agent, or another project's lane, is invalid", async () => {
      await inRollbackTransaction(async (tx) => {
        const home = await seedTenant(tx);
        const other = await seedTenant(tx);
        const foreignAgent = await seedAgentPrincipal(
          tx,
          other.organizationId,
          other.owner.userId,
        );
        const context = humanContext({
          ...home.owner,
          organizationId: home.organizationId,
        });
        for (const input of [
          ruleInput(home.organizationId, other.target.projectId),
          ruleInput(home.organizationId, home.target.projectId, {
            laneIds: [home.source.laneId],
          }),
          ruleInput(home.organizationId, home.target.projectId, {
            sourceKind: "project",
            sourceProjectId: home.source.projectId,
            agentPrincipalIds: [foreignAgent],
          }),
        ]) {
          const error = await refusal(
            run(tx, {
              name: "create_routing_rule",
              context,
              input,
              expectedVersion: 0,
            }),
          );
          expect((error as DomainError).code).toBe("validation_failed");
        }
        expect(await rulesOf(tx, home.organizationId)).toEqual([]);
      });
    });
  });

  describe("what the bus checks before the repository runs", () => {
    test("a context without routing:manage is refused naming that scope", async () => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const error = await refusal(
          run(tx, {
            name: "create_routing_rule",
            context: humanContext({
              ...tenant.owner,
              organizationId: tenant.organizationId,
              scopes: ["project:manage", "request:create"],
            }),
            input: ruleInput(tenant.organizationId, tenant.target.projectId),
            expectedVersion: 0,
          }),
        );
        expect((error as DomainError).details).toEqual({
          scope: "routing:manage",
        });
        expect(await rulesOf(tx, tenant.organizationId)).toEqual([]);
      });
    });

    test("an input naming another organisation than the context's is refused", async () => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const error = await refusal(
          run(tx, {
            name: "create_routing_rule",
            context: humanContext({
              ...tenant.owner,
              organizationId: tenant.organizationId,
            }),
            input: ruleInput(crypto.randomUUID(), tenant.target.projectId),
            expectedVersion: 0,
          }),
        );
        expect((error as DomainError).message).toBe(
          "Organization access is denied",
        );
      });
    });

    test.each([
      ["an agent", { type: "agent", id: crypto.randomUUID() }],
      [
        "a service actor",
        {
          type: "service",
          id: "operator:probe",
          originatingActor: { type: "user", id: "someone" },
        },
      ],
    ] as const)(
      "%s holding routing:manage is refused by the command itself",
      async (_, actor) => {
        await inRollbackTransaction(async (tx) => {
          const tenant = await seedTenant(tx);
          // The bus's own `assertCurrent` is left out: it would refuse these
          // contexts for having no credential row, which would hide whether
          // the command refuses them itself.
          const error = await refusal(
            run(
              tx,
              {
                name: "create_routing_rule",
                context: {
                  actor,
                  organizationId: tenant.organizationId,
                  scopes: new Set(["routing:manage"]),
                  credentialId: "not-a-person",
                  correlationId: crypto.randomUUID(),
                },
                input: ruleInput(
                  tenant.organizationId,
                  tenant.target.projectId,
                ),
                expectedVersion: 0,
              },
              { assertCurrent: false },
            ),
          );
          expect((error as DomainError).code).toBe("forbidden");
          expect((error as DomainError).message).toBe(
            "Routing requires a person or an operator credential",
          );
          expect(await rulesOf(tx, tenant.organizationId)).toEqual([]);
        });
      },
    );
  });

  describe("versions, replays and conflicts", () => {
    test("creation expects version zero, and a stale version writes nothing", async () => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const context = humanContext({
          ...tenant.owner,
          organizationId: tenant.organizationId,
        });
        const create = await refusal(
          run(tx, {
            name: "create_routing_rule",
            context,
            input: ruleInput(tenant.organizationId, tenant.target.projectId),
            expectedVersion: 1,
          }),
        );
        expect((create as DomainError).code).toBe("version_conflict");
        const ruleId = await ownerRule(tx, tenant);
        for (const attempt of [
          {
            name: "update_routing_rule" as const,
            input: {
              ...ruleInput(tenant.organizationId, tenant.target.projectId),
              ruleId,
            },
          },
          {
            name: "disable_routing_rule" as const,
            input: { organizationId: tenant.organizationId, ruleId },
          },
        ]) {
          const error = await refusal(
            run(tx, { ...attempt, context, expectedVersion: 2 }),
          );
          expect((error as DomainError).code, attempt.name).toBe(
            "version_conflict",
          );
          expect(
            await receiptsFor(tx, attempt.name, tenant.owner.userId),
          ).toEqual([]);
        }
        expect(await rulesOf(tx, tenant.organizationId)).toEqual([
          expect.objectContaining({ id: ruleId, version: 1, enabled: true }),
        ]);
      });
    });

    test("a replay with the same key and input answers the first result, writing nothing more", async () => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const context = humanContext({
          ...tenant.owner,
          organizationId: tenant.organizationId,
        });
        const idempotencyKey = key();
        const input = ruleInput(tenant.organizationId, tenant.target.projectId);
        const first = await run(tx, {
          name: "create_routing_rule",
          context,
          input,
          expectedVersion: 0,
          idempotencyKey,
        });
        const again = await run(tx, {
          name: "create_routing_rule",
          context: { ...context, correlationId: crypto.randomUUID() },
          input,
          expectedVersion: 0,
          idempotencyKey,
        });
        expect(again).toEqual(first);
        expect(await rulesOf(tx, tenant.organizationId)).toHaveLength(1);
        expect(await ruleEvents(tx, tenant.organizationId)).toHaveLength(1);

        const conflicting = await refusal(
          run(tx, {
            name: "create_routing_rule",
            context,
            input: { ...input, decision: "allow" },
            expectedVersion: 0,
            idempotencyKey,
          }),
        );
        expect((conflicting as DomainError).code).toBe("idempotency_conflict");
        expect(await rulesOf(tx, tenant.organizationId)).toHaveLength(1);
      });
    });

    test("a replay by a member who has since lost the role is refused, not answered", async () => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const admin = await seedUser(tx);
        await seedMembership(tx, tenant.organizationId, admin.userId, "admin");
        const context = humanContext({
          ...admin,
          organizationId: tenant.organizationId,
        });
        const idempotencyKey = key();
        const input = ruleInput(tenant.organizationId, tenant.target.projectId);
        await run(tx, {
          name: "create_routing_rule",
          context,
          input,
          expectedVersion: 0,
          idempotencyKey,
        });
        await tx.execute(sql`
          update "organization_members" set "role" = 'member'
          where "organization_id" = ${tenant.organizationId}
            and "user_id" = ${admin.userId}
        `);
        const error = await refusal(
          run(tx, {
            name: "create_routing_rule",
            context,
            input,
            expectedVersion: 0,
            idempotencyKey,
          }),
        );
        expect((error as DomainError).code).toBe("forbidden");
      });
    });
  });

  describe("records", () => {
    test("the human path publishes as the user, and records the rule's author as the user", async () => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const rule = await run(tx, {
          name: "create_routing_rule",
          context: humanContext({
            ...tenant.owner,
            organizationId: tenant.organizationId,
          }),
          input: ruleInput(tenant.organizationId, tenant.target.projectId),
          expectedVersion: 0,
        });
        expect(await ruleEvents(tx, tenant.organizationId)).toEqual([
          {
            actor: { type: "user", id: tenant.owner.userId },
            aggregateId: rule.id,
            data: {
              changeType: "created",
              ruleId: rule.id,
              version: 1,
              decision: "deny",
              sourceKind: "human_direct",
              sourceProjectId: null,
              targetProjectId: tenant.target.projectId,
              enabled: true,
            },
          },
        ]);
        expect(await rulesOf(tx, tenant.organizationId)).toEqual([
          expect.objectContaining({ createdBy: `user:${tenant.owner.userId}` }),
        ]);
      });
    });
  });

  /*
    The receipt decision (`manifest-f2.md` §2.4, F.2.1): the rule commands
    were already on the bus, and the routing repository keeps no receipt of
    its own, so each call has exactly one, the bus's. Nothing moves across
    the deploy.
  */
  describe("receipts", () => {
    test("each rule command leaves exactly one receipt, the bus's, keyed with the bus's secret", async () => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const context = humanContext({
          ...tenant.owner,
          organizationId: tenant.organizationId,
        });
        const createKey = key();
        const created = await run(tx, {
          name: "create_routing_rule",
          context,
          input: ruleInput(tenant.organizationId, tenant.target.projectId),
          expectedVersion: 0,
          idempotencyKey: createKey,
        });
        const updateKey = key();
        const updated = await run(tx, {
          name: "update_routing_rule",
          context,
          input: {
            ...ruleInput(tenant.organizationId, tenant.target.projectId),
            ruleId: created.id,
          },
          expectedVersion: 1,
          idempotencyKey: updateKey,
        });
        const disableKey = key();
        const disabled = await run(tx, {
          name: "disable_routing_rule",
          context,
          input: { organizationId: tenant.organizationId, ruleId: created.id },
          expectedVersion: 2,
          idempotencyKey: disableKey,
        });
        for (const [name, idempotencyKey, result] of [
          ["create_routing_rule", createKey, created],
          ["update_routing_rule", updateKey, updated],
          ["disable_routing_rule", disableKey, disabled],
        ] as const) {
          expect(
            await receiptsFor(tx, name, tenant.owner.userId),
            name,
          ).toEqual([
            {
              idempotencyFingerprint: keyedFingerprint(
                busSecret,
                idempotencyKey,
              ),
              resultJson: result,
            },
          ]);
        }
        // And none under another name: three calls, three receipts in all.
        expect(
          (await allReceiptsOf(tx, tenant.owner.userId))
            .map((row) => row.commandName)
            .sort(),
        ).toEqual([
          "create_routing_rule",
          "disable_routing_rule",
          "update_routing_rule",
        ]);
      });
    });
  });
});

/*
  Plan 13, F.2.1's registry half: an operator credential runs the three rule
  commands through the same bus, the same `routing` port and the same
  `assertCurrent` a person's form does, with operator credentials switched on.
  The route writes the credential's organisation into the input; here the
  input names it directly, as the route leaves it.
*/
describe.sequential("an operator credential", () => {
  type Changed = {
    organizationId: string;
    userId: string;
    credentialId: string;
    apiKeyId: string;
  };

  async function operatorRules(tx: Tx, credential: { lineageId: string }) {
    return tx
      .select({ id: routingRules.id, createdBy: routingRules.createdBy })
      .from(routingRules)
      .where(
        eq(routingRules.createdBy, `service:operator:${credential.lineageId}`),
      );
  }

  test("an owner's organisation-wide operator creates, updates and disables a rule, recorded as the service it is", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner.userId,
      });
      const context = operatorContext(credential);
      const created = await run(tx, {
        name: "create_routing_rule",
        context,
        input: ruleInput(tenant.organizationId, tenant.target.projectId),
        expectedVersion: 0,
      });
      const updated = await run(tx, {
        name: "update_routing_rule",
        context,
        input: {
          ...ruleInput(tenant.organizationId, tenant.target.projectId, {
            decision: "allow",
          }),
          ruleId: created.id,
        },
        expectedVersion: 1,
      });
      const disabled = await run(tx, {
        name: "disable_routing_rule",
        context,
        input: { organizationId: tenant.organizationId, ruleId: created.id },
        expectedVersion: 2,
      });
      expect([created, updated, disabled]).toMatchObject([
        { id: created.id, version: 1, decision: "deny", enabled: true },
        { id: created.id, version: 2, decision: "allow", enabled: true },
        { id: created.id, version: 3, decision: "allow", enabled: false },
      ]);
      const operator = {
        type: "service",
        id: `operator:${credential.lineageId}`,
        originatingActor: { type: "user", id: tenant.owner.userId },
      };
      expect(
        (await ruleEvents(tx, tenant.organizationId)).map(
          (event) => event.actor,
        ),
      ).toEqual([operator, operator, operator]);
      expect(await rulesOf(tx, tenant.organizationId)).toEqual([
        expect.objectContaining({
          id: created.id,
          createdBy: `service:operator:${credential.lineageId}`,
        }),
      ]);
    });
  });

  test("its receipt is its own, never its member's, and its replay answers the first result", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner.userId,
      });
      const idempotencyKey = key();
      const first = await run(tx, {
        name: "create_routing_rule",
        context: operatorContext(credential),
        input: ruleInput(tenant.organizationId, tenant.target.projectId),
        expectedVersion: 0,
        idempotencyKey,
      });
      const replay = await run(tx, {
        name: "create_routing_rule",
        context: operatorContext(credential),
        input: ruleInput(tenant.organizationId, tenant.target.projectId),
        expectedVersion: 0,
        idempotencyKey,
      });
      expect(replay).toEqual(first);
      expect(await operatorRules(tx, credential)).toHaveLength(1);
      expect(await allReceiptsOf(tx, tenant.owner.userId)).toEqual([]);
      const receipts = await tx
        .select({ commandName: commandReceipts.commandName })
        .from(commandReceipts)
        .where(
          eq(
            commandReceipts.actorFingerprint,
            actorFingerprint(operatorContext(credential).actor),
          ),
        );
      expect(receipts).toEqual([{ commandName: "create_routing_rule" }]);
      // The member's own call with the operator's key is not answered from
      // the operator's receipt: it runs, and writes a second rule.
      await run(tx, {
        name: "create_routing_rule",
        context: humanContext({
          ...tenant.owner,
          organizationId: tenant.organizationId,
        }),
        input: ruleInput(tenant.organizationId, tenant.target.projectId),
        expectedVersion: 0,
        idempotencyKey,
      });
      expect(await rulesOf(tx, tenant.organizationId)).toHaveLength(2);
    });
  });

  test("an operator bound to a project is refused every rule command, and nothing is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const ruleId = await ownerRule(tx, tenant);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner.userId,
        projectId: tenant.target.projectId,
      });
      for (const [name, input, expectedVersion] of [
        [
          "create_routing_rule",
          ruleInput(tenant.organizationId, tenant.target.projectId),
          0,
        ],
        [
          "update_routing_rule",
          {
            ...ruleInput(tenant.organizationId, tenant.target.projectId),
            ruleId,
          },
          1,
        ],
        [
          "disable_routing_rule",
          { organizationId: tenant.organizationId, ruleId },
          1,
        ],
      ] as const) {
        const error = await refusal(
          run(tx, {
            name,
            context: operatorContext(credential),
            input,
            expectedVersion,
          }),
        );
        expect((error as DomainError).code, name).toBe("forbidden");
        expect((error as DomainError).message, name).toBe(
          "Operator project access is denied",
        );
      }
      expect(await rulesOf(tx, tenant.organizationId)).toEqual([
        expect.objectContaining({ id: ruleId, version: 1, enabled: true }),
      ]);
      expect(await ruleEvents(tx, tenant.organizationId)).toHaveLength(1);
    });
  });

  test("an operator for one organisation finds no rule of another, and may not name it, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const other = await seedTenant(tx);
      await seedMembership(
        tx,
        other.organizationId,
        home.owner.userId,
        "owner",
      );
      const foreignRule = await ownerRule(tx, other);
      const credential = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.owner.userId,
      });
      for (const [name, input] of [
        [
          "update_routing_rule",
          {
            ...ruleInput(home.organizationId, home.target.projectId),
            ruleId: foreignRule,
          },
        ],
        [
          "disable_routing_rule",
          { organizationId: home.organizationId, ruleId: foreignRule },
        ],
      ] as const) {
        const error = await refusal(
          run(tx, {
            name,
            context: operatorContext(credential),
            input,
            expectedVersion: 1,
          }),
        );
        expect((error as DomainError).code, name).toBe("not_found");
      }
      // A rule naming the other organisation's project is invalid.
      const project = await refusal(
        run(tx, {
          name: "create_routing_rule",
          context: operatorContext(credential),
          input: ruleInput(home.organizationId, other.target.projectId),
          expectedVersion: 0,
        }),
      );
      expect((project as DomainError).code).toBe("validation_failed");
      // Naming the other organisation itself is refused before anything runs.
      const named = await refusal(
        run(tx, {
          name: "disable_routing_rule",
          context: operatorContext(credential),
          input: { organizationId: other.organizationId, ruleId: foreignRule },
          expectedVersion: 1,
        }),
      );
      expect((named as DomainError).code).toBe("forbidden");
      expect(await rulesOf(tx, other.organizationId)).toEqual([
        expect.objectContaining({ id: foreignRule, version: 1, enabled: true }),
      ]);
      expect(await rulesOf(tx, home.organizationId)).toEqual([]);
    });
  });

  test("an operator without routing:manage is refused naming the scope", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner.userId,
        scopes: ["request:create"],
      });
      const error = await refusal(
        run(tx, {
          name: "create_routing_rule",
          context: operatorContext(credential),
          input: ruleInput(tenant.organizationId, tenant.target.projectId),
          expectedVersion: 0,
        }),
      );
      expect((error as DomainError).code).toBe("forbidden");
      expect((error as DomainError).details).toMatchObject({
        scope: "routing:manage",
      });
      expect(await rulesOf(tx, tenant.organizationId)).toEqual([]);
    });
  });

  test("the deployment's switch unset or disabled refuses, and nothing is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.owner.userId,
      });
      for (const operatorCredentials of [undefined, "disabled"] as const) {
        const error = await refusal(
          run(
            tx,
            {
              name: "create_routing_rule",
              context: operatorContext(credential),
              input: ruleInput(tenant.organizationId, tenant.target.projectId),
              expectedVersion: 0,
            },
            { operatorCredentials },
          ),
        );
        expect(error, String(operatorCredentials)).toBeInstanceOf(DomainError);
      }
      expect(await rulesOf(tx, tenant.organizationId)).toEqual([]);
    });
  });

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
  test.each(changes)(
    "is refused once %s, having succeeded before, and writes nothing",
    async (_, change) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const credential = await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.owner.userId,
        });
        const created = await run(tx, {
          name: "create_routing_rule",
          context: operatorContext(credential),
          input: ruleInput(tenant.organizationId, tenant.target.projectId),
          expectedVersion: 0,
        });
        await change(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.owner.userId,
          credentialId: credential.id,
          apiKeyId: credential.apiKeyId,
        });
        const error = await refusal(
          run(tx, {
            name: "disable_routing_rule",
            context: operatorContext(credential),
            input: {
              organizationId: tenant.organizationId,
              ruleId: created.id,
            },
            expectedVersion: 1,
          }),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("forbidden");
        expect(await rulesOf(tx, tenant.organizationId)).toEqual([
          expect.objectContaining({
            id: created.id,
            version: 1,
            enabled: true,
          }),
        ]);
        expect(await ruleEvents(tx, tenant.organizationId)).toHaveLength(1);
      });
    },
  );
});

describe.sequential("route evaluation, as the tester and the preview reach it", () => {
  test("a member is evaluated against the organisation's rules, with the role it records", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const ruleId = await ownerRule(tx, tenant, { humanRoles: ["member"] });
      const member = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, member.userId, "member");
      const route = {
        organizationId: tenant.organizationId,
        targetProjectId: tenant.target.projectId,
        requestType: "feature",
        priority: "normal",
      };
      for (const purpose of ["test", "preview"]) {
        expect(
          await evaluate(
            tx,
            humanContext({ ...member, organizationId: tenant.organizationId }),
            { ...route, purpose },
          ),
          purpose,
        ).toEqual({
          allowed: false,
          reason: "matched_deny",
          matchedRuleId: ruleId,
          policyVersion: 1,
          evaluatedConstraints: ["human_role"],
        });
        expect(
          await evaluate(
            tx,
            humanContext({
              ...tenant.owner,
              organizationId: tenant.organizationId,
            }),
            { ...route, purpose },
          ),
          purpose,
        ).toMatchObject({ allowed: true, reason: "default_same_org" });
      }
    });
  });

  test("the preview answers a source project the member cannot represent as it always has", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const archived = await seedProject(tx, tenant.organizationId, "archived");
      const member = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, member.userId, "member");
      const preview = (userId: string, sessionId: string, source: string) =>
        evaluate(
          tx,
          humanContext({
            userId,
            sessionId,
            organizationId: tenant.organizationId,
          }),
          {
            purpose: "preview",
            organizationId: tenant.organizationId,
            sourceProjectId: source,
            targetProjectId: tenant.target.projectId,
            requestType: "bug",
            priority: "high",
          },
        );
      const denied = {
        allowed: false,
        reason: "no_matching_permission",
        policyVersion: 0,
        evaluatedConstraints: ["source_project"],
      };
      // Not a member of the source project, and not an owner or admin.
      expect(
        await preview(member.userId, member.sessionId, tenant.source.projectId),
      ).toEqual(denied);
      // An archived project is represented by no one, the owner included.
      expect(
        await preview(
          tenant.owner.userId,
          tenant.owner.sessionId,
          archived.projectId,
        ),
      ).toEqual(denied);
      // The owner represents every active project; an active project member
      // represents theirs.
      expect(
        await preview(
          tenant.owner.userId,
          tenant.owner.sessionId,
          tenant.source.projectId,
        ),
      ).toMatchObject({ allowed: true, reason: "default_same_org" });
      await tx.insert(projectMembers).values({
        organizationId: tenant.organizationId,
        projectId: tenant.source.projectId,
        userId: member.userId,
        role: "contributor",
        status: "active",
      });
      expect(
        await preview(member.userId, member.sessionId, tenant.source.projectId),
      ).toMatchObject({ allowed: true, reason: "default_same_org" });
    });
  });

  test("the tester evaluates a named agent principal and lane, for any source", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const agentPrincipalId = await seedAgentPrincipal(
        tx,
        tenant.organizationId,
        tenant.owner.userId,
      );
      const ruleId = await ownerRule(tx, tenant, {
        sourceKind: "project",
        sourceProjectId: tenant.source.projectId,
        decision: "allow",
        agentPrincipalIds: [agentPrincipalId],
        laneIds: [tenant.target.laneId],
      });
      const member = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, member.userId, "member");
      expect(
        await evaluate(
          tx,
          humanContext({ ...member, organizationId: tenant.organizationId }),
          {
            purpose: "test",
            organizationId: tenant.organizationId,
            sourceProjectId: tenant.source.projectId,
            targetProjectId: tenant.target.projectId,
            laneId: tenant.target.laneId,
            agentPrincipalId,
            requestType: "feature",
            priority: "normal",
          },
        ),
      ).toMatchObject({
        allowed: true,
        reason: "matched_allow",
        matchedRuleId: ruleId,
      });
    });
  });

  test("another organisation's rules never decide a route, even for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const other = await seedTenant(tx);
      await seedMembership(
        tx,
        other.organizationId,
        home.owner.userId,
        "owner",
      );
      const foreignRuleId = await ownerRule(tx, other);
      const context = humanContext({
        ...home.owner,
        organizationId: home.organizationId,
      });
      for (const targetProjectId of [
        home.target.projectId,
        other.target.projectId,
      ]) {
        const decision = await evaluate(tx, context, {
          purpose: "test",
          organizationId: home.organizationId,
          targetProjectId,
          requestType: "feature",
          priority: "normal",
        });
        expect(decision).toMatchObject({
          allowed: true,
          reason: "default_same_org",
          policyVersion: 0,
        });
        expect(decision.matchedRuleId).not.toBe(foreignRuleId);
      }
    });
  });

  test("a revoked member, a suspended organisation and an ended session are refused", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const route = {
        purpose: "preview",
        organizationId: tenant.organizationId,
        targetProjectId: tenant.target.projectId,
        requestType: "feature",
        priority: "normal",
      };
      const revoked = await seedUser(tx);
      await seedMembership(
        tx,
        tenant.organizationId,
        revoked.userId,
        "owner",
        "revoked",
      );
      const ended = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, ended.userId, "owner");
      await tx.execute(sql`
        update "session" set "expires_at" = now() - interval '1 minute'
        where "id" = ${ended.sessionId}
      `);
      for (const actor of [revoked, ended]) {
        const error = await refusal(
          evaluate(
            tx,
            humanContext({ ...actor, organizationId: tenant.organizationId }),
            route,
          ),
        );
        expect((error as DomainError).code).toBe("forbidden");
      }
      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${tenant.organizationId}
      `);
      const suspended = await refusal(
        evaluate(
          tx,
          humanContext({
            ...tenant.owner,
            organizationId: tenant.organizationId,
          }),
          route,
        ),
      );
      expect((suspended as DomainError).code).toBe("forbidden");
    });
  });

  test("the entry itself refuses a non-member, and a machine actor, without assertCurrent", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const stranger = await seedUser(tx);
      const sources = {
        rules: createRoutingRepository(tx),
        members: createFoundationQueryRepository(tx),
      };
      const route = {
        purpose: "test",
        organizationId: tenant.organizationId,
        targetProjectId: tenant.target.projectId,
        requestType: "feature",
        priority: "normal",
      };
      const outsider = await refusal(
        evaluateRouteForMember(
          sources,
          humanContext({ ...stranger, organizationId: tenant.organizationId }),
          route,
        ),
      );
      expect((outsider as DomainError).message).toBe(
        "Active organization membership is required",
      );
      for (const actor of [
        { type: "agent", id: crypto.randomUUID() },
        {
          type: "service",
          id: "operator:probe",
          originatingActor: { type: "user", id: tenant.owner.userId },
        },
      ] as const) {
        const error = await refusal(
          evaluateRouteForMember(
            sources,
            {
              actor,
              organizationId: tenant.organizationId,
              scopes: new Set(["routing:manage", "request:create"]),
              credentialId: "not-a-person",
              correlationId: crypto.randomUUID(),
            },
            route,
          ),
        );
        expect((error as DomainError).message).toBe(
          "Routing requires a person or an operator credential",
        );
      }
      // Nothing raised in PostgreSQL: the transaction is still usable.
      expect(await rulesOf(tx, tenant.organizationId)).toEqual([]);
    });
  });
});
