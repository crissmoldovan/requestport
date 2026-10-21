import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  actorFingerprint,
  createCoreCommandRegistry,
  DomainError,
  type JsonObject,
  keyedFingerprint,
  operatorActor,
  requireScope,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  agentCredentials,
  agentOauthGrants,
  agentPrincipals,
  apiKeys,
  commandReceipts,
  domainEvents,
  projectMembers,
  projects,
  securityAuditRecords,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import {
  endingEachCommandBinding,
  endingEachMethodBinding,
} from "../test-support/tenant-binding.js";
import type { Tx } from "../transaction.js";
import { createAgentAuthRepository } from "./agent-auth-repository.js";
import { createAgentRepository } from "./agent-repository.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";
import { createCommandTransactionManager } from "./command-repository.js";
import { createOperatorCredentialRepository } from "./operator-credential-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

// Seeding a user and an organization is several database round trips before
// anything is asserted, which is more than Vitest's local-Postgres default.
const seedingTimeoutMs = 30_000;

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
  throw new Error("Expected the agent principal transaction to roll back");
}

async function seedOrganization(tx: Tx) {
  const suffix = crypto.randomUUID();
  const userId = `user_${suffix}`;
  const email = `${userId}@example.invalid`;
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Agent owner', ${email}, now())
  `);
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Agent tenant', ${`agents-${suffix}`}, 'active')
  `);
  return { organizationId, userId };
}

describe("agent principal slug collisions", () => {
  /**
   * The unit suite proves the mapping given a constraint name; only PostgreSQL
   * can say which name it actually reports. Both sides spell
   * `agent_principals_organization_slug_ci_unique` by hand, so without this the
   * index could be renamed and the mapping would go on agreeing with itself
   * while every collision fell back to an unexplained failure again.
   */
  test(
    "answers a taken organization-wide name with a conflict on the slug",
    async () => {
      await inRollbackTransaction(async (tx) => {
        const { organizationId, userId } = await seedOrganization(tx);
        const repository = createAgentRepository(tx);
        const principal = {
          organizationId,
          projectId: null,
          displayName: "deploy-bot",
          softwareName: null,
          createdByUserId: userId,
        };
        await repository.createPrincipal({
          ...principal,
          id: crypto.randomUUID(),
          slug: "deploy-bot",
        });

        // A savepoint, because the failed insert aborts the transaction it runs
        // in and the surrounding rollback transaction still has to end cleanly.
        const collision = tx.transaction((savepoint) =>
          createAgentRepository(savepoint).createPrincipal({
            ...principal,
            id: crypto.randomUUID(),
            // Upper case on purpose: the index is on `lower(slug)`, so this is
            // the same name as far as the organization is concerned.
            slug: "DEPLOY-BOT",
          }),
        );

        await expect(collision).rejects.toBeInstanceOf(DomainError);
        await expect(collision).rejects.toMatchObject({
          code: "conflict",
          details: { field: "slug" },
        });
      });
    },
    seedingTimeoutMs,
  );
});

/*
  Plan 13, F.2.2: the three agent administration capabilities a machine may
  be given (ruling 3) — suspending a principal, revoking a key and revoking a
  grant — against PostgreSQL, as the one handler each shares between its form
  and its REST transport runs them.

  Suspension is the bus command `set_agent_principal_status`, run here
  through a real `AtomicCommandBus` with the real unit of work, the real
  `agents` port and the real `assertCurrent`. The two revocations stay off the
  bus. Their handlers are core's (`packages/core/src/agent-administration.ts`),
  which the web's RequestPort composes and `apps/web/src/lib/server-agent-actions.ts`
  hands the forms: each opens one transaction, runs `assertCurrent` there
  first, then the key or grant service's checks, then the repository's write.
  These cases spell out the same steps in the same order in a transaction of
  their own, because the services live in `@requestport/core`
  (`agent-services/`), which this package does not depend on: for the key,
  the credential looked up among the principal's, the scope, a person,
  `canManage` on the credential's project and then `revokeCredential`; for
  the grant, the scope, a person and then `revokeOAuthGrant`. Those are the
  steps for a person. That the handler calls those services in that order is
  held by `packages/core/src/agent-administration.test.ts`, against mocks; the
  operator's path through the real services, on PostgreSQL, is
  `packages/auth`'s `agent-revocation.integration.test.ts`. No suite runs the
  handler itself against PostgreSQL.

  Every case runs in a transaction that is rolled back at the end, and each
  command or handler transaction is a savepoint inside it.
*/

const busSecret = "agent-administration-live-bus-secret-0000000";
const formSecret = "agent-administration-live-form-secret-000000";

function portFactory(name: string, database: Database | Tx) {
  if (name === "agents") return createAgentRepository(database);
  if (name === "commandAuthorization")
    return createCommandAuthorizationRepository(database);
  return undefined;
}

function bus(tx: Tx) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    // A case runs commands for more than one actor on one transaction; each
    // command's binding ends with it, as its own transaction ends it in
    // production (test-support/tenant-binding.ts).
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(tx as unknown as Database, portFactory),
      tx,
    ),
    fingerprintSecret: busSecret,
    authorizeContext: (context, uow) =>
      uow
        .port<ReturnType<typeof createCommandAuthorizationRepository>>(
          "commandAuthorization",
        )
        .assertCurrent(context),
  });
}

/** The off-bus handlers' composition: one transaction, the re-check first. */
function inHandlerTransaction<T>(
  tx: Tx,
  context: AuthorizedCommandContext,
  work: (handlerTx: Tx) => Promise<T>,
) {
  return tx.transaction(async (handlerTx) => {
    await createCommandAuthorizationRepository(handlerTx).assertCurrent(
      context,
    );
    return work(handlerTx);
  });
}

async function seedPerson(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Agent administrator', ${email}, now())
  `);
  const sessionId = `session_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "session" ("id", "expires_at", "token", "updated_at", "user_id")
    values (${sessionId}, now() + interval '1 hour',
      ${`token_${crypto.randomUUID()}`}, now(), ${userId})
  `);
  return { userId, sessionId };
}

type Person = Awaited<ReturnType<typeof seedPerson>>;

async function seedTenant(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Agent administration tenant',
      ${`agent-administration-${organizationId}`}, 'active')
  `);
  return organizationId;
}

async function seedMember(
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
) {
  await tx
    .insert(projectMembers)
    .values({ organizationId, projectId, userId, role, status: "active" });
}

async function seedAgentProject(tx: Tx, organizationId: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [project] = await tx
    .insert(projects)
    .values({
      organizationId,
      name: `Agent project ${suffix}`,
      slug: `agent-project-${suffix}`,
      // All eight hex characters: with four, two projects seeded in one
      // organisation drew the same prefix often enough to fail a gate
      // (`projects_organization_key_prefix_ci_unique`, 2026-09-29).
      keyPrefix: `G${suffix.toUpperCase()}`,
      status: "active",
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  return project.id;
}

async function seedAgent(
  tx: Tx,
  organizationId: string,
  projectId: string | null,
  createdByUserId: string,
) {
  const id = crypto.randomUUID();
  await tx.insert(agentPrincipals).values({
    id,
    organizationId,
    projectId,
    displayName: `Administered agent ${id.slice(0, 8)}`,
    slug: `administered-${id}`,
    status: "active",
    createdByUserId,
  });
  return id;
}

async function seedAgentCredential(
  tx: Tx,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    projectId: string;
    userId: string;
  },
) {
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, ${input.userId}, ${`secret_${apiKeyId}`},
      true, now() + interval '1 hour', now(), now())
  `);
  const id = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_credentials"
      ("id", "organization_id", "agent_principal_id",
       "better_auth_api_key_id", "name", "prefix", "fingerprint", "audience",
       "project_id", "lane_ids", "scopes", "expires_at", "created_by_user_id")
    values (${id}, ${input.organizationId}, ${input.agentPrincipalId},
      ${apiKeyId}, 'Administered credential', 'rp_live',
      ${`fingerprint_${id}`}, 'mcp', ${input.projectId},
      '[]'::jsonb, '["request:read"]'::jsonb, now() + interval '30 days',
      ${input.userId})
  `);
  return { id, apiKeyId };
}

async function seedAgentGrant(
  tx: Tx,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    projectId: string;
    delegatedByUserId: string;
  },
) {
  const clientId = `client_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_client"
      ("id", "client_id", "redirect_uris", "disabled",
       "token_endpoint_auth_method", "require_pkce")
    values (${clientId}, ${clientId},
      ${sql`array['https://example.invalid/callback']`}, false,
      'none', true)
  `);
  const consentId = `consent_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "oauth_consent" ("id", "client_id", "user_id", "scopes")
    values (${consentId}, ${clientId}, ${input.delegatedByUserId},
      ${sql`array['request:read']`})
  `);
  const id = crypto.randomUUID();
  await tx.execute(sql`
    insert into "agent_oauth_grants"
      ("id", "organization_id", "agent_principal_id", "user_id",
       "oauth_client_id", "provider_grant_id", "refresh_family_id",
       "audience", "project_id", "lane_ids", "scopes", "status",
       "expires_at")
    values (${id}, ${input.organizationId}, ${input.agentPrincipalId},
      ${input.delegatedByUserId}, ${clientId}, ${consentId},
      ${crypto.randomUUID()}, 'mcp', ${input.projectId}, '[]'::jsonb,
      '["request:read"]'::jsonb, 'active', now() + interval '30 days')
  `);
  return id;
}

/** An organisation with an owner, a project and an agent principal in it. */
async function seedAdministeredAgent(tx: Tx) {
  const organizationId = await seedTenant(tx);
  const owner = await seedPerson(tx);
  await seedMember(tx, organizationId, owner.userId, "owner");
  const projectId = await seedAgentProject(tx, organizationId);
  const agentPrincipalId = await seedAgent(
    tx,
    organizationId,
    projectId,
    owner.userId,
  );
  return { organizationId, owner, projectId, agentPrincipalId };
}

function personContext(
  person: Person,
  organizationId: string,
  scopes: readonly string[] = ["agent:manage"],
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: person.userId },
    organizationId,
    scopes: new Set(scopes),
    credentialId: person.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

function idempotencyKey() {
  return `agent-administration-${crypto.randomUUID()}`;
}

function suspend(
  tx: Tx,
  context: AuthorizedCommandContext,
  agentPrincipalId: string,
  options: {
    expectedVersion?: number;
    idempotencyKey?: string;
    status?: "active" | "suspended" | "revoked";
    reason?: string;
  } = {},
) {
  return bus(tx).execute<unknown, JsonObject>({
    name: "set_agent_principal_status",
    context,
    input: {
      organizationId: context.organizationId,
      agentPrincipalId,
      status: options.status ?? "suspended",
      reason: options.reason ?? "Suspended while its key is rotated",
    },
    meta: {
      idempotencyKey: options.idempotencyKey ?? idempotencyKey(),
      expectedVersion: options.expectedVersion ?? 1,
    },
  });
}

async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error("it was not refused");
}

async function principalRow(tx: Tx, agentPrincipalId: string) {
  const [row] = await tx
    .select({
      status: agentPrincipals.status,
      version: agentPrincipals.version,
    })
    .from(agentPrincipals)
    .where(eq(agentPrincipals.id, agentPrincipalId));
  return row;
}

async function auditFor(tx: Tx, targetId: string) {
  return tx
    .select({
      actorType: securityAuditRecords.actorType,
      actorId: securityAuditRecords.actorId,
      action: securityAuditRecords.action,
    })
    .from(securityAuditRecords)
    .where(eq(securityAuditRecords.targetId, targetId));
}

async function receiptsOf(tx: Tx, userId: string) {
  return tx
    .select({
      commandName: commandReceipts.commandName,
      idempotencyFingerprint: commandReceipts.idempotencyFingerprint,
    })
    .from(commandReceipts)
    .where(
      eq(
        commandReceipts.actorFingerprint,
        actorFingerprint({ type: "user", id: userId }),
      ),
    );
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("suspending an agent principal through the command bus", () => {
  test.each([
    ["an organisation owner", "owner"],
    ["an organisation admin", "admin"],
    ["a maintainer of the principal's project", "maintainer"],
  ] as const)(
    "%s may suspend it, audited and published as a user",
    async (_, role) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedAdministeredAgent(tx);
        const actor = await seedPerson(tx);
        await seedMember(
          tx,
          seeded.organizationId,
          actor.userId,
          role === "maintainer" ? "member" : role,
        );
        if (role === "maintainer")
          await seedProjectRole(
            tx,
            seeded.organizationId,
            seeded.projectId,
            actor.userId,
            "maintainer",
          );

        const result = await suspend(
          tx,
          personContext(actor, seeded.organizationId),
          seeded.agentPrincipalId,
        );

        expect(result).toEqual({
          id: seeded.agentPrincipalId,
          status: "suspended",
          version: 2,
        });
        expect(await principalRow(tx, seeded.agentPrincipalId)).toEqual({
          status: "suspended",
          version: 2,
        });
        expect(await auditFor(tx, seeded.agentPrincipalId)).toEqual([
          {
            actorType: "user",
            actorId: actor.userId,
            action: "agent.suspended",
          },
        ]);
        const events = await tx
          .select({ actor: domainEvents.actor })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.aggregateId, seeded.agentPrincipalId),
              eq(domainEvents.type, "agent.status_changed.v1"),
            ),
          );
        expect(events).toEqual([{ actor: { type: "user", id: actor.userId } }]);
      });
    },
  );

  test.each([
    ["a maintainer of another project", "maintainer", "other"],
    ["a contributor", "contributor", "this"],
    ["a viewer", "viewer", "this"],
    ["a member with no project role", null, "this"],
  ] as const)(
    "%s is refused, and nothing is written",
    async (_, projectRole, where) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedAdministeredAgent(tx);
        const otherProjectId = await seedAgentProject(
          tx,
          seeded.organizationId,
        );
        const actor = await seedPerson(tx);
        await seedMember(tx, seeded.organizationId, actor.userId, "member");
        if (projectRole)
          await seedProjectRole(
            tx,
            seeded.organizationId,
            where === "this" ? seeded.projectId : otherProjectId,
            actor.userId,
            projectRole,
          );

        const error = await refused(
          suspend(
            tx,
            personContext(actor, seeded.organizationId),
            seeded.agentPrincipalId,
          ),
        );

        expect(error.code).toBe("forbidden");
        expect(await principalRow(tx, seeded.agentPrincipalId)).toEqual({
          status: "active",
          version: 1,
        });
        expect(await auditFor(tx, seeded.agentPrincipalId)).toEqual([]);
        expect(await receiptsOf(tx, actor.userId)).toEqual([]);
      });
    },
  );

  test("an organisation-wide principal is an owner's or admin's alone", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const organizationWide = await seedAgent(
        tx,
        seeded.organizationId,
        null,
        seeded.owner.userId,
      );
      const maintainer = await seedPerson(tx);
      await seedMember(tx, seeded.organizationId, maintainer.userId, "member");
      await seedProjectRole(
        tx,
        seeded.organizationId,
        seeded.projectId,
        maintainer.userId,
        "maintainer",
      );
      expect(
        (
          await refused(
            suspend(
              tx,
              personContext(maintainer, seeded.organizationId),
              organizationWide,
            ),
          )
        ).code,
      ).toBe("forbidden");

      const admin = await seedPerson(tx);
      await seedMember(tx, seeded.organizationId, admin.userId, "admin");
      expect(
        await suspend(
          tx,
          personContext(admin, seeded.organizationId),
          organizationWide,
        ),
      ).toMatchObject({ status: "suspended", version: 2 });
    });
  });

  test("a revoked member, an ended session and a suspended organisation are refused by the re-check", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const revoked = await seedPerson(tx);
      await seedMember(
        tx,
        seeded.organizationId,
        revoked.userId,
        "owner",
        "revoked",
      );
      expect(
        (
          await refused(
            suspend(
              tx,
              personContext(revoked, seeded.organizationId),
              seeded.agentPrincipalId,
            ),
          )
        ).message,
      ).toBe("Current human authorization is no longer active");

      await tx.execute(sql`
        update "session" set "expires_at" = now() - interval '1 minute'
        where "id" = ${seeded.owner.sessionId}
      `);
      expect(
        (
          await refused(
            suspend(
              tx,
              personContext(seeded.owner, seeded.organizationId),
              seeded.agentPrincipalId,
            ),
          )
        ).code,
      ).toBe("forbidden");

      const admin = await seedPerson(tx);
      await seedMember(tx, seeded.organizationId, admin.userId, "admin");
      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${seeded.organizationId}
      `);
      expect(
        (
          await refused(
            suspend(
              tx,
              personContext(admin, seeded.organizationId),
              seeded.agentPrincipalId,
            ),
          )
        ).code,
      ).toBe("forbidden");
      expect(await principalRow(tx, seeded.agentPrincipalId)).toEqual({
        status: "active",
        version: 1,
      });
    });
  });

  test("another organisation's principal is refused, for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedAdministeredAgent(tx);
      const foreign = await seedAdministeredAgent(tx);
      await seedMember(tx, foreign.organizationId, home.owner.userId, "owner");

      const error = await refused(
        suspend(
          tx,
          personContext(home.owner, home.organizationId),
          foreign.agentPrincipalId,
        ),
      );

      expect(error.code).toBe("forbidden");
      expect(await principalRow(tx, foreign.agentPrincipalId)).toEqual({
        status: "active",
        version: 1,
      });
    });
  });

  test("without agent:manage the refusal names the scope; an agent and a service holding it are refused", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const unscoped = await refused(
        suspend(
          tx,
          personContext(seeded.owner, seeded.organizationId, ["project:read"]),
          seeded.agentPrincipalId,
        ),
      );
      expect(unscoped.code).toBe("forbidden");
      expect(unscoped.details).toEqual({ scope: "agent:manage" });

      for (const actor of [
        { type: "agent" as const, id: seeded.agentPrincipalId },
        {
          type: "service" as const,
          id: "operator:lineage",
          originatingActor: { type: "user" as const, id: seeded.owner.userId },
        },
      ]) {
        // The bus's own `assertCurrent` is left out here: it would refuse
        // these contexts for having no credential row, which would hide
        // whether the command refuses them itself.
        const bare = new AtomicCommandBus({
          registry: createCoreCommandRegistry(),
          transactions: createCommandTransactionManager(
            tx as unknown as Database,
            portFactory,
          ),
          fingerprintSecret: busSecret,
        });
        const error = await refused(
          bare.execute({
            name: "set_agent_principal_status",
            context: {
              ...personContext(seeded.owner, seeded.organizationId),
              actor,
              credentialId: crypto.randomUUID(),
              projectId: seeded.projectId,
            },
            input: {
              organizationId: seeded.organizationId,
              agentPrincipalId: seeded.agentPrincipalId,
              status: "suspended",
              reason: "Suspended while its key is rotated",
            },
            meta: { idempotencyKey: idempotencyKey(), expectedVersion: 1 },
          }),
        );
        expect(error.code, actor.type).toBe("forbidden");
        expect(error.message, actor.type).toBe(
          "Agent administration requires a person or an operator credential",
        );
      }
      expect(await principalRow(tx, seeded.agentPrincipalId)).toEqual({
        status: "active",
        version: 1,
      });
    });
  });

  test("a stale version, the status it already has and reactivating a revoked principal write nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const context = personContext(seeded.owner, seeded.organizationId);
      expect(
        (
          await refused(
            suspend(tx, context, seeded.agentPrincipalId, {
              expectedVersion: 7,
            }),
          )
        ).code,
      ).toBe("version_conflict");
      expect(
        (
          await refused(
            suspend(tx, context, seeded.agentPrincipalId, { status: "active" }),
          )
        ).code,
      ).toBe("conflict");

      await suspend(tx, context, seeded.agentPrincipalId, {
        status: "revoked",
      });
      expect(
        (
          await refused(
            suspend(tx, context, seeded.agentPrincipalId, {
              status: "active",
              expectedVersion: 2,
            }),
          )
        ).message,
      ).toBe("A revoked agent cannot be reactivated");
      expect(await principalRow(tx, seeded.agentPrincipalId)).toEqual({
        status: "revoked",
        version: 2,
      });
    });
  });

  test("a replay answers the first result from the bus's one receipt; other input under the key is a conflict; a replay after demotion is refused", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const context = personContext(seeded.owner, seeded.organizationId);
      const key = idempotencyKey();

      const first = await suspend(tx, context, seeded.agentPrincipalId, {
        idempotencyKey: key,
      });
      const replay = await suspend(tx, context, seeded.agentPrincipalId, {
        idempotencyKey: key,
      });
      expect(replay).toEqual(first);
      expect(await auditFor(tx, seeded.agentPrincipalId)).toHaveLength(1);
      expect(await receiptsOf(tx, seeded.owner.userId)).toEqual([
        {
          commandName: "set_agent_principal_status",
          idempotencyFingerprint: keyedFingerprint(busSecret, key),
        },
      ]);

      expect(
        (
          await refused(
            suspend(tx, context, seeded.agentPrincipalId, {
              idempotencyKey: key,
              reason: "A different reason for the same key",
            }),
          )
        ).code,
      ).toBe("idempotency_conflict");

      await tx.execute(sql`
        update "organization_members" set "role" = 'member'
        where "organization_id" = ${seeded.organizationId}
          and "user_id" = ${seeded.owner.userId}
      `);
      expect(
        (
          await refused(
            suspend(tx, context, seeded.agentPrincipalId, {
              idempotencyKey: key,
            }),
          )
        ).code,
      ).toBe("forbidden");
    });
  });
});

describe.sequential("canManage, as the consent path asks it", () => {
  /**
   * `agentGrantService.bindConsent` asks `canManage` with no project for a
   * provisioning grant (`agent-grant-service.ts`), and that consent is human
   * only by design. Whatever F.3 changes for its operator must leave these
   * answers as they are.
   */
  test("with no project it admits an active owner or admin only, and never a non-person", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const admin = await seedPerson(tx);
      await seedMember(tx, seeded.organizationId, admin.userId, "admin");
      const maintainer = await seedPerson(tx);
      await seedMember(tx, seeded.organizationId, maintainer.userId, "member");
      await seedProjectRole(
        tx,
        seeded.organizationId,
        seeded.projectId,
        maintainer.userId,
        "maintainer",
      );
      const revoked = await seedPerson(tx);
      await seedMember(
        tx,
        seeded.organizationId,
        revoked.userId,
        "owner",
        "revoked",
      );
      const agents = createAgentRepository(tx);
      const ask = (actor: Parameters<typeof agents.canManage>[0]["actor"]) =>
        agents.canManage({
          organizationId: seeded.organizationId,
          projectId: null,
          actor,
        });

      expect(await ask({ type: "user", id: seeded.owner.userId })).toBe(true);
      expect(await ask({ type: "user", id: admin.userId })).toBe(true);
      expect(await ask({ type: "user", id: maintainer.userId })).toBe(false);
      expect(await ask({ type: "user", id: revoked.userId })).toBe(false);
      expect(await ask({ type: "agent", id: seeded.agentPrincipalId })).toBe(
        false,
      );
      expect(
        await ask({
          type: "service",
          id: "operator:lineage",
          originatingActor: { type: "user", id: seeded.owner.userId },
        }),
      ).toBe(false);
    });
  });
});

describe.sequential("revoking an agent's key and grant, as the off-bus handlers run them", () => {
  /**
   * The key, as `revokeAgentCredential` and `agentApiKeyService.revoke` run
   * it inside the handler's transaction: the credential looked up among the
   * principal's (`not_found` when it is not one of them), then the service's
   * `assertManager` — the scope, a person, and `canManage` on the
   * *credential's* project — then the repository's write, whose own
   * `lockCredentialManager` checks the role again. The service lives in
   * `@requestport/core` (`agent-services/`), which this package does not
   * depend on, so its steps are spelled out here; that the handler calls that
   * service, in this order, is held by
   * `packages/core/src/agent-administration.test.ts`.
   */
  async function revokeCredential(
    tx: Tx,
    context: AuthorizedCommandContext,
    target: { agentPrincipalId: string; credentialId: string },
    options: { idempotencyKey?: string; expectedVersion?: number } = {},
  ) {
    return inHandlerTransaction(tx, context, async (handlerTx) => {
      const authRepository = createAgentAuthRepository(handlerTx);
      const credential = (
        await authRepository.listCredentials(
          context.organizationId,
          target.agentPrincipalId,
        )
      ).find((candidate) => candidate.id === target.credentialId);
      if (!credential) {
        throw new DomainError("not_found", "Credential was not found");
      }
      requireScope(context, "agent:manage");
      if (context.actor.type !== "user") {
        throw new DomainError("forbidden", "A human maintainer is required");
      }
      if (
        !(await createAgentRepository(handlerTx).canManage({
          organizationId: context.organizationId,
          projectId: credential.projectId,
          actor: context.actor,
        }))
      ) {
        throw new DomainError("forbidden", "Agent management access is denied");
      }
      const revoked = await authRepository.revokeCredential({
        organizationId: context.organizationId,
        credentialId: credential.id,
        actorUserId: context.actor.id,
        correlationId: context.correlationId,
        expectedVersion: options.expectedVersion ?? 1,
        idempotencyKey: options.idempotencyKey ?? idempotencyKey(),
        fingerprintSecret: formSecret,
      });
      if (!revoked) {
        throw new DomainError("not_found", "Credential was not found");
      }
      return revoked;
    });
  }

  /**
   * The grant, as `revokeAgentOauthGrant` and `agentGrantService.revokeGrant`
   * run it: the scope and a person, then the repository's write, which holds
   * the whole role rule (an organisation manager, the delegating human, or a
   * maintainer of the grant's project).
   */
  function revokeGrant(
    tx: Tx,
    context: AuthorizedCommandContext,
    target: { agentPrincipalId: string; grantId: string },
    options: {
      idempotencyKey?: string;
      expectedVersion?: number;
      reason?: string;
    } = {},
  ) {
    return inHandlerTransaction(tx, context, (handlerTx) => {
      requireScope(context, "agent:manage");
      if (context.actor.type !== "user") {
        throw new DomainError("forbidden", "A human user is required");
      }
      return createAgentAuthRepository(handlerTx).revokeOAuthGrant({
        organizationId: context.organizationId,
        ...target,
        actorUserId: context.actor.id,
        correlationId: context.correlationId,
        reason: options.reason ?? "The laptop holding it was lost",
        expectedVersion: options.expectedVersion ?? 1,
        idempotencyKey: options.idempotencyKey ?? idempotencyKey(),
        fingerprintSecret: formSecret,
      });
    });
  }

  async function credentialRow(tx: Tx, credentialId: string) {
    const [row] = await tx
      .select({
        revokedAt: agentCredentials.revokedAt,
        version: agentCredentials.version,
        enabled: apiKeys.enabled,
      })
      .from(agentCredentials)
      .innerJoin(apiKeys, eq(apiKeys.id, agentCredentials.betterAuthApiKeyId))
      .where(eq(agentCredentials.id, credentialId));
    return row;
  }

  async function grantRow(tx: Tx, grantId: string) {
    const [row] = await tx
      .select({
        status: agentOauthGrants.status,
        version: agentOauthGrants.version,
      })
      .from(agentOauthGrants)
      .where(eq(agentOauthGrants.id, grantId));
    return row;
  }

  type ActorRole =
    | "owner"
    | "admin"
    | "maintainer"
    | "another project's maintainer"
    | "contributor"
    | "viewer"
    | "no project role";

  /** A person with `role` in the seeded organisation, relative to its project. */
  async function seedActor(
    tx: Tx,
    seeded: { organizationId: string; projectId: string },
    role: ActorRole,
  ) {
    const actor = await seedPerson(tx);
    await seedMember(
      tx,
      seeded.organizationId,
      actor.userId,
      role === "owner" || role === "admin" ? role : "member",
    );
    if (role === "maintainer" || role === "contributor" || role === "viewer") {
      await seedProjectRole(
        tx,
        seeded.organizationId,
        seeded.projectId,
        actor.userId,
        role,
      );
    }
    if (role === "another project's maintainer") {
      await seedProjectRole(
        tx,
        seeded.organizationId,
        await seedAgentProject(tx, seeded.organizationId),
        actor.userId,
        "maintainer",
      );
    }
    return actor;
  }

  /** An administered agent holding one key in its project, issued by the owner. */
  async function seedKey(tx: Tx) {
    const seeded = await seedAdministeredAgent(tx);
    const credential = await seedAgentCredential(tx, {
      organizationId: seeded.organizationId,
      agentPrincipalId: seeded.agentPrincipalId,
      projectId: seeded.projectId,
      userId: seeded.owner.userId,
    });
    return {
      ...seeded,
      credentialId: credential.id,
      target: {
        agentPrincipalId: seeded.agentPrincipalId,
        credentialId: credential.id,
      },
    };
  }

  /**
   * An administered agent holding one grant in its project, delegated by a
   * plain member with no project role — so only the delegation admits them.
   */
  async function seedGrant(tx: Tx) {
    const seeded = await seedAdministeredAgent(tx);
    const delegator = await seedPerson(tx);
    await seedMember(tx, seeded.organizationId, delegator.userId, "member");
    const grantId = await seedAgentGrant(tx, {
      organizationId: seeded.organizationId,
      agentPrincipalId: seeded.agentPrincipalId,
      projectId: seeded.projectId,
      delegatedByUserId: delegator.userId,
    });
    return {
      ...seeded,
      delegator,
      grantId,
      target: { agentPrincipalId: seeded.agentPrincipalId, grantId },
    };
  }

  const admitted = [
    ["an organisation owner", "owner"],
    ["an organisation admin", "admin"],
    ["a maintainer of its project", "maintainer"],
  ] as const;

  const refusedRoles = [
    ["a maintainer of another project", "another project's maintainer"],
    ["a contributor", "contributor"],
    ["a viewer", "viewer"],
    ["a member with no project role", "no project role"],
  ] as const;

  test.each(admitted)(
    "a key: %s may revoke it, audited as a user, with the repository's one receipt",
    async (_, role) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedKey(tx);
        const actor = await seedActor(tx, seeded, role);
        const key = idempotencyKey();

        expect(
          await revokeCredential(
            tx,
            personContext(actor, seeded.organizationId),
            seeded.target,
            { idempotencyKey: key },
          ),
        ).toEqual({ id: seeded.credentialId, revoked: true, version: 2 });
        expect(await credentialRow(tx, seeded.credentialId)).toEqual({
          revokedAt: expect.any(Date),
          version: 2,
          enabled: false,
        });
        expect(await auditFor(tx, seeded.credentialId)).toEqual([
          {
            actorType: "user",
            actorId: actor.userId,
            action: "agent.credential_revoked",
          },
        ]);
        expect(await receiptsOf(tx, actor.userId)).toEqual([
          {
            commandName: "revoke_agent_credential",
            idempotencyFingerprint: keyedFingerprint(formSecret, key),
          },
        ]);
      });
    },
  );

  test.each(refusedRoles)(
    "a key: %s is refused, and nothing is written",
    async (_, role) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedKey(tx);
        const actor = await seedActor(tx, seeded, role);

        const error = await refused(
          revokeCredential(
            tx,
            personContext(actor, seeded.organizationId),
            seeded.target,
          ),
        );

        expect(error.code).toBe("forbidden");
        expect(await credentialRow(tx, seeded.credentialId)).toEqual({
          revokedAt: null,
          version: 1,
          enabled: true,
        });
        expect(await auditFor(tx, seeded.credentialId)).toEqual([]);
        expect(await receiptsOf(tx, actor.userId)).toEqual([]);
      });
    },
  );

  test("a key: a maintainer of its project may revoke one an organisation-wide principal holds there", async () => {
    // Wider than suspension, which refuses this maintainer the principal:
    // the key's rule is `canManage` on the key's project, not the principal's.
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const organizationWide = await seedAgent(
        tx,
        seeded.organizationId,
        null,
        seeded.owner.userId,
      );
      const credential = await seedAgentCredential(tx, {
        organizationId: seeded.organizationId,
        agentPrincipalId: organizationWide,
        projectId: seeded.projectId,
        userId: seeded.owner.userId,
      });
      const maintainer = await seedActor(tx, seeded, "maintainer");

      expect(
        await revokeCredential(
          tx,
          personContext(maintainer, seeded.organizationId),
          { agentPrincipalId: organizationWide, credentialId: credential.id },
        ),
      ).toEqual({ id: credential.id, revoked: true, version: 2 });
    });
  });

  test("a key: the repository's own lock refuses those roles too, without the service's check", async () => {
    // Defence in depth: `lockCredentialManager` re-reads the role on the
    // credential's project inside the write, so a caller that skipped
    // `canManage` would still be refused.
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedKey(tx);
      for (const [, role] of refusedRoles) {
        const actor = await seedActor(tx, seeded, role);
        const context = personContext(actor, seeded.organizationId);
        const error = await refused(
          inHandlerTransaction(tx, context, (handlerTx) =>
            createAgentAuthRepository(handlerTx).revokeCredential({
              organizationId: seeded.organizationId,
              credentialId: seeded.credentialId,
              actorUserId: actor.userId,
              correlationId: context.correlationId,
              expectedVersion: 1,
              idempotencyKey: idempotencyKey(),
              fingerprintSecret: formSecret,
            }),
          ),
        );
        expect(error.message, role).toBe(
          "Agent credential management is denied",
        );
      }
      expect(await credentialRow(tx, seeded.credentialId)).toEqual({
        revokedAt: null,
        version: 1,
        enabled: true,
      });
    });
  });

  test("a key: a replay answers the first result; other input under the key is a conflict; a stale version is a version_conflict", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedKey(tx);
      const context = personContext(seeded.owner, seeded.organizationId);
      const key = idempotencyKey();

      const first = await revokeCredential(tx, context, seeded.target, {
        idempotencyKey: key,
      });
      expect(first).toEqual({
        id: seeded.credentialId,
        revoked: true,
        version: 2,
      });
      expect(
        await revokeCredential(tx, context, seeded.target, {
          idempotencyKey: key,
        }),
      ).toEqual(first);
      expect(await auditFor(tx, seeded.credentialId)).toHaveLength(1);
      // The receipt F.2.2 kept (§2.4): the repository's own, keyed with the
      // secret the form hands it. Nothing is written under a bus name.
      expect(await receiptsOf(tx, seeded.owner.userId)).toEqual([
        {
          commandName: "revoke_agent_credential",
          idempotencyFingerprint: keyedFingerprint(formSecret, key),
        },
      ]);

      const other = await seedAgentCredential(tx, {
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.agentPrincipalId,
        projectId: seeded.projectId,
        userId: seeded.owner.userId,
      });
      const otherTarget = {
        agentPrincipalId: seeded.agentPrincipalId,
        credentialId: other.id,
      };
      expect(
        (
          await refused(
            revokeCredential(tx, context, otherTarget, { idempotencyKey: key }),
          )
        ).code,
      ).toBe("idempotency_conflict");
      expect(
        (
          await refused(
            revokeCredential(tx, context, otherTarget, { expectedVersion: 5 }),
          )
        ).code,
      ).toBe("version_conflict");
      expect(await credentialRow(tx, other.id)).toEqual({
        revokedAt: null,
        version: 1,
        enabled: true,
      });
    });
  });

  test("a key: a replay after the member is demoted is refused", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedKey(tx);
      const context = personContext(seeded.owner, seeded.organizationId);
      const key = idempotencyKey();
      await revokeCredential(tx, context, seeded.target, {
        idempotencyKey: key,
      });

      await tx.execute(sql`
        update "organization_members" set "role" = 'member'
        where "organization_id" = ${seeded.organizationId}
          and "user_id" = ${seeded.owner.userId}
      `);
      expect(
        (
          await refused(
            revokeCredential(tx, context, seeded.target, {
              idempotencyKey: key,
            }),
          )
        ).code,
      ).toBe("forbidden");
      expect(await auditFor(tx, seeded.credentialId)).toHaveLength(1);
    });
  });

  test("a key: the re-check refuses an ended session before anything is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedKey(tx);
      await tx.execute(sql`
        update "session" set "expires_at" = now() - interval '1 minute'
        where "id" = ${seeded.owner.sessionId}
      `);
      expect(
        (
          await refused(
            revokeCredential(
              tx,
              personContext(seeded.owner, seeded.organizationId),
              seeded.target,
            ),
          )
        ).message,
      ).toBe("Current human authorization is no longer active");
      expect(await credentialRow(tx, seeded.credentialId)).toEqual({
        revokedAt: null,
        version: 1,
        enabled: true,
      });
      expect(await auditFor(tx, seeded.credentialId)).toEqual([]);
    });
  });

  test("a key: another organisation's is not found, for an owner of both, and nothing is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedKey(tx);
      const foreign = await seedKey(tx);
      await seedMember(tx, foreign.organizationId, home.owner.userId, "owner");
      const context = personContext(home.owner, home.organizationId);

      for (const target of [
        foreign.target,
        // The home principal's id with the foreign key's.
        {
          agentPrincipalId: home.agentPrincipalId,
          credentialId: foreign.credentialId,
        },
      ]) {
        expect(
          (await refused(revokeCredential(tx, context, target))).code,
        ).toBe("not_found");
      }
      expect(await credentialRow(tx, foreign.credentialId)).toEqual({
        revokedAt: null,
        version: 1,
        enabled: true,
      });
      expect(await auditFor(tx, foreign.credentialId)).toEqual([]);
      expect(await receiptsOf(tx, home.owner.userId)).toEqual([]);
    });
  });

  test.each([
    ...admitted,
    ["the member who delegated it, with no project role", "delegator"],
  ] as const)(
    "a grant: %s may revoke it, audited as a user, with the repository's one receipt",
    async (_, role) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedGrant(tx);
        const actor =
          role === "delegator"
            ? seeded.delegator
            : await seedActor(tx, seeded, role);
        const key = idempotencyKey();

        expect(
          await revokeGrant(
            tx,
            personContext(actor, seeded.organizationId),
            seeded.target,
            { idempotencyKey: key },
          ),
        ).toEqual({ id: seeded.grantId, revoked: true, version: 2 });
        expect(await grantRow(tx, seeded.grantId)).toEqual({
          status: "revoked",
          version: 2,
        });
        expect(await auditFor(tx, seeded.grantId)).toEqual([
          {
            actorType: "user",
            actorId: actor.userId,
            action: "agent.oauth_grant_revoked",
          },
        ]);
        expect(await receiptsOf(tx, actor.userId)).toEqual([
          {
            commandName: "revoke_agent_oauth_grant",
            idempotencyFingerprint: keyedFingerprint(formSecret, key),
          },
        ]);
      });
    },
  );

  test.each(refusedRoles)(
    "a grant: %s is refused, and nothing is written",
    async (_, role) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedGrant(tx);
        const actor = await seedActor(tx, seeded, role);

        const error = await refused(
          revokeGrant(
            tx,
            personContext(actor, seeded.organizationId),
            seeded.target,
          ),
        );

        expect(error.code).toBe("forbidden");
        expect(await grantRow(tx, seeded.grantId)).toEqual({
          status: "active",
          version: 1,
        });
        expect(await auditFor(tx, seeded.grantId)).toEqual([]);
        expect(await receiptsOf(tx, actor.userId)).toEqual([]);
      });
    },
  );

  test("a grant: a replay answers the first result; other input under the key is a conflict; a stale version is a version_conflict; the re-check refuses a suspended organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedGrant(tx);
      const context = personContext(seeded.owner, seeded.organizationId);
      const key = idempotencyKey();

      const first = await revokeGrant(tx, context, seeded.target, {
        idempotencyKey: key,
      });
      expect(
        await revokeGrant(tx, context, seeded.target, { idempotencyKey: key }),
      ).toEqual(first);
      expect(await auditFor(tx, seeded.grantId)).toHaveLength(1);
      expect(await receiptsOf(tx, seeded.owner.userId)).toEqual([
        {
          commandName: "revoke_agent_oauth_grant",
          idempotencyFingerprint: keyedFingerprint(formSecret, key),
        },
      ]);
      expect(
        (
          await refused(
            revokeGrant(tx, context, seeded.target, {
              idempotencyKey: key,
              reason: "A different reason for the same key",
            }),
          )
        ).code,
      ).toBe("idempotency_conflict");

      const second = await seedAgentGrant(tx, {
        organizationId: seeded.organizationId,
        agentPrincipalId: seeded.agentPrincipalId,
        projectId: seeded.projectId,
        delegatedByUserId: seeded.delegator.userId,
      });
      const secondTarget = {
        agentPrincipalId: seeded.agentPrincipalId,
        grantId: second,
      };
      expect(
        (
          await refused(
            revokeGrant(tx, context, secondTarget, { expectedVersion: 5 }),
          )
        ).code,
      ).toBe("version_conflict");

      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${seeded.organizationId}
      `);
      expect(
        (await refused(revokeGrant(tx, context, secondTarget))).message,
      ).toBe("Current human authorization is no longer active");
      expect(await grantRow(tx, second)).toEqual({
        status: "active",
        version: 1,
      });
      expect(await auditFor(tx, second)).toEqual([]);
    });
  });

  test("a grant: a replay after the member is demoted is refused", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedGrant(tx);
      const context = personContext(seeded.owner, seeded.organizationId);
      const key = idempotencyKey();
      await revokeGrant(tx, context, seeded.target, { idempotencyKey: key });

      await tx.execute(sql`
        update "organization_members" set "role" = 'member'
        where "organization_id" = ${seeded.organizationId}
          and "user_id" = ${seeded.owner.userId}
      `);
      expect(
        (
          await refused(
            revokeGrant(tx, context, seeded.target, { idempotencyKey: key }),
          )
        ).code,
      ).toBe("forbidden");
      expect(await auditFor(tx, seeded.grantId)).toHaveLength(1);
    });
  });

  test("a grant: another organisation's is not found, for an owner of both, and nothing is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedGrant(tx);
      const foreign = await seedGrant(tx);
      await seedMember(tx, foreign.organizationId, home.owner.userId, "owner");
      const context = personContext(home.owner, home.organizationId);

      for (const target of [
        foreign.target,
        { agentPrincipalId: home.agentPrincipalId, grantId: foreign.grantId },
      ]) {
        expect((await refused(revokeGrant(tx, context, target))).code).toBe(
          "not_found",
        );
      }
      expect(await grantRow(tx, foreign.grantId)).toEqual({
        status: "active",
        version: 1,
      });
      expect(await auditFor(tx, foreign.grantId)).toEqual([]);
      expect(await receiptsOf(tx, home.owner.userId)).toEqual([]);
    });
  });
});

/*
  Plan 13, F.2.2's registry half: suspension for an operator credential, as
  `/api/v1` runs it — the same bus, with the deployment's operator switch on
  (with it off `assertCurrent` refuses every operator before any command
  runs; F.3's own suite holds that). The operator acts with its issuing
  member's live authority, may only suspend, is held to its project when
  bound to one, and is recorded as the `service` actor it is. The credentials
  are issued through F.3's repository.
*/

function operatorPortFactory(name: string, database: Database | Tx) {
  if (name === "agents") return createAgentRepository(database);
  if (name === "commandAuthorization")
    return createCommandAuthorizationRepository(database, {
      operatorCredentials: "enabled",
    });
  return undefined;
}

function operatorBus(tx: Tx) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    // As `bus` above: each command's binding ends with it.
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(
        tx as unknown as Database,
        operatorPortFactory,
      ),
      tx,
    ),
    fingerprintSecret: busSecret,
    authorizeContext: (context, uow) =>
      uow
        .port<ReturnType<typeof createCommandAuthorizationRepository>>(
          "commandAuthorization",
        )
        .assertCurrent(context),
  });
}

/**
 * Issues an operator credential for `userId` in `organizationId`, holding
 * `agent:revoke` unless `scopes` says otherwise, as F.3's repository writes
 * one, with the Better Auth key row it is bound to, and the context
 * `authenticateApiBearer` builds for it.
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
    name: "Agent administration operator",
    prefix: "rpo_f22",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: input.scopes ?? ["agent:revoke"],
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

function suspendAsOperator(
  tx: Tx,
  context: AuthorizedCommandContext,
  agentPrincipalId: string,
  options: {
    expectedVersion?: number;
    idempotencyKey?: string;
    reason?: string;
    status?: "active" | "suspended" | "revoked";
  } = {},
) {
  return operatorBus(tx).execute<unknown, JsonObject>({
    name: "set_agent_principal_status",
    context,
    input: {
      organizationId: context.organizationId,
      agentPrincipalId,
      status: options.status ?? "suspended",
      reason: options.reason ?? "Suspended by the on-call script",
    },
    meta: {
      idempotencyKey: options.idempotencyKey ?? idempotencyKey(),
      expectedVersion: options.expectedVersion ?? 1,
    },
  });
}

async function receiptsUnder(tx: Tx, actor: AuthorizedCommandContext["actor"]) {
  return tx
    .select({ commandName: commandReceipts.commandName })
    .from(commandReceipts)
    .where(eq(commandReceipts.actorFingerprint, actorFingerprint(actor)));
}

describe.sequential("suspending an agent principal with an operator credential", () => {
  test("an owner's organisation-wide operator suspends, recorded as the service it is, under its own receipt", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const { context, credential } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });

      expect(
        await suspendAsOperator(tx, context, seeded.agentPrincipalId),
      ).toEqual({
        id: seeded.agentPrincipalId,
        status: "suspended",
        version: 2,
      });
      expect(await auditFor(tx, seeded.agentPrincipalId)).toEqual([
        {
          actorType: "service",
          actorId: `operator:${credential.lineageId}`,
          action: "agent.suspended",
        },
      ]);
      const events = await tx
        .select({ actor: domainEvents.actor })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.aggregateId, seeded.agentPrincipalId),
            eq(domainEvents.type, "agent.status_changed.v1"),
          ),
        );
      expect(events).toEqual([{ actor: context.actor }]);
      expect(await receiptsUnder(tx, context.actor)).toEqual([
        { commandName: "set_agent_principal_status" },
      ]);
      expect(await receiptsOf(tx, seeded.owner.userId)).toEqual([]);
    });
  });

  test("its replay answers the first result; its member's retry under the same key is its own, and meets the version check", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      const key = idempotencyKey();
      const first = await suspendAsOperator(
        tx,
        context,
        seeded.agentPrincipalId,
        { idempotencyKey: key },
      );
      expect(
        await suspendAsOperator(tx, context, seeded.agentPrincipalId, {
          idempotencyKey: key,
        }),
      ).toEqual(first);
      expect(
        (
          await refused(
            suspend(
              tx,
              personContext(seeded.owner, seeded.organizationId),
              seeded.agentPrincipalId,
              { idempotencyKey: key },
            ),
          )
        ).code,
      ).toBe("version_conflict");
      expect(await auditFor(tx, seeded.agentPrincipalId)).toHaveLength(1);
    });
  });

  test("its key reused with other input is an idempotency_conflict, and nothing more is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const other = await seedAgent(
        tx,
        seeded.organizationId,
        seeded.projectId,
        seeded.owner.userId,
      );
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
      });
      const key = idempotencyKey();
      await suspendAsOperator(tx, context, seeded.agentPrincipalId, {
        idempotencyKey: key,
      });
      for (const [agentPrincipalId, reason] of [
        [seeded.agentPrincipalId, "A different reason for the same key"],
        [other, undefined],
      ] as const) {
        const error = await refused(
          suspendAsOperator(tx, context, agentPrincipalId, {
            idempotencyKey: key,
            reason,
          }),
        );
        expect(error.code).toBe("idempotency_conflict");
      }
      expect(await principalRow(tx, other)).toEqual({
        status: "active",
        version: 1,
      });
      expect(await auditFor(tx, seeded.agentPrincipalId)).toHaveLength(1);
      expect(await auditFor(tx, other)).toEqual([]);
      expect(await receiptsUnder(tx, context.actor)).toEqual([
        { commandName: "set_agent_principal_status" },
      ]);
    });
  });

  test.each(["active", "revoked"] as const)(
    "may not set %s, and nothing is written",
    async (status) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedAdministeredAgent(tx);
        const { context } = await issueOperator(tx, {
          organizationId: seeded.organizationId,
          userId: seeded.owner.userId,
        });
        await tx
          .update(agentPrincipals)
          .set({ status: "suspended" })
          .where(eq(agentPrincipals.id, seeded.agentPrincipalId));
        const error = await refused(
          suspendAsOperator(tx, context, seeded.agentPrincipalId, { status }),
        );
        expect(error.code).toBe("forbidden");
        expect(error.message).toBe(
          "An operator credential may only suspend an agent",
        );
        expect(await principalRow(tx, seeded.agentPrincipalId)).toEqual({
          status: "suspended",
          version: 1,
        });
        expect(await auditFor(tx, seeded.agentPrincipalId)).toEqual([]);
      });
    },
  );

  test("without agent:revoke it is refused naming that scope", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
        scopes: ["project:read"],
      });
      const error = await refused(
        suspendAsOperator(tx, context, seeded.agentPrincipalId),
      );
      expect(error.code).toBe("forbidden");
      expect(error.details).toEqual({ scope: "agent:revoke" });
      expect(await principalRow(tx, seeded.agentPrincipalId)).toEqual({
        status: "active",
        version: 1,
      });
    });
  });

  test("an operator bound to a project suspends that project's principal, and is refused another project's and an organisation-wide one", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const otherProjectId = await seedAgentProject(tx, seeded.organizationId);
      const inOther = await seedAgent(
        tx,
        seeded.organizationId,
        otherProjectId,
        seeded.owner.userId,
      );
      const organizationWide = await seedAgent(
        tx,
        seeded.organizationId,
        null,
        seeded.owner.userId,
      );
      const { context } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: seeded.owner.userId,
        projectId: seeded.projectId,
      });
      for (const agentPrincipalId of [inOther, organizationWide]) {
        const error = await refused(
          suspendAsOperator(tx, context, agentPrincipalId),
        );
        expect(error.code, agentPrincipalId).toBe("forbidden");
        expect(error.message, agentPrincipalId).toBe(
          "Operator project access is denied",
        );
        expect(await principalRow(tx, agentPrincipalId)).toEqual({
          status: "active",
          version: 1,
        });
        expect(await auditFor(tx, agentPrincipalId)).toEqual([]);
      }
      expect(
        (await suspendAsOperator(tx, context, seeded.agentPrincipalId)).status,
      ).toBe("suspended");
    });
  });

  test("a maintainer's operator bound to the maintained project suspends its principal", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      const maintainer = await seedPerson(tx);
      await seedMember(tx, seeded.organizationId, maintainer.userId, "member");
      await seedProjectRole(
        tx,
        seeded.organizationId,
        seeded.projectId,
        maintainer.userId,
        "maintainer",
      );
      const { context, credential } = await issueOperator(tx, {
        organizationId: seeded.organizationId,
        userId: maintainer.userId,
        projectId: seeded.projectId,
      });
      expect(
        (await suspendAsOperator(tx, context, seeded.agentPrincipalId)).status,
      ).toBe("suspended");
      expect(await auditFor(tx, seeded.agentPrincipalId)).toEqual([
        {
          actorType: "service",
          actorId: `operator:${credential.lineageId}`,
          action: "agent.suspended",
        },
      ]);
    });
  });

  test("an operator issued for one organisation cannot suspend another's principal, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedAdministeredAgent(tx);
      const foreign = await seedAdministeredAgent(tx);
      await seedMember(tx, foreign.organizationId, home.owner.userId, "owner");
      const { context } = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.owner.userId,
      });
      expect(
        (
          await refused(
            suspendAsOperator(tx, context, foreign.agentPrincipalId),
          )
        ).code,
      ).toBe("forbidden");
      // Naming the other organisation in the input is refused by the
      // organisation check (REST writes the credential's over it anyway).
      expect(
        (
          await refused(
            operatorBus(tx).execute({
              name: "set_agent_principal_status",
              context,
              input: {
                organizationId: foreign.organizationId,
                agentPrincipalId: foreign.agentPrincipalId,
                status: "suspended",
                reason: "Suspended by the on-call script",
              },
              meta: { idempotencyKey: idempotencyKey(), expectedVersion: 1 },
            }),
          )
        ).code,
      ).toBe("forbidden");
      expect(await principalRow(tx, foreign.agentPrincipalId)).toEqual({
        status: "active",
        version: 1,
      });
      expect(await auditFor(tx, foreign.agentPrincipalId)).toEqual([]);
    });
  });

  const changes: Array<
    [
      string,
      (
        tx: Tx,
        at: {
          organizationId: string;
          userId: string;
          credentialId: string;
          apiKeyId: string;
        },
      ) => Promise<void>,
    ]
  > = [
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
    "is refused once %s, having succeeded before, and writes nothing",
    async (_, change) => {
      await inRollbackTransaction(async (tx) => {
        const seeded = await seedAdministeredAgent(tx);
        const second = await seedAgent(
          tx,
          seeded.organizationId,
          seeded.projectId,
          seeded.owner.userId,
        );
        const { context, credential, apiKeyId } = await issueOperator(tx, {
          organizationId: seeded.organizationId,
          userId: seeded.owner.userId,
        });
        await suspendAsOperator(tx, context, seeded.agentPrincipalId);
        await change(tx, {
          organizationId: seeded.organizationId,
          userId: seeded.owner.userId,
          credentialId: credential.id,
          apiKeyId,
        });
        expect(
          (await refused(suspendAsOperator(tx, context, second))).code,
        ).toBe("forbidden");
        expect(await principalRow(tx, second)).toEqual({
          status: "active",
          version: 1,
        });
        expect(await auditFor(tx, second)).toEqual([]);
      });
    },
  );

  test("the person's path still records the person, as user", async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedAdministeredAgent(tx);
      await suspend(
        tx,
        personContext(seeded.owner, seeded.organizationId),
        seeded.agentPrincipalId,
      );
      expect(await auditFor(tx, seeded.agentPrincipalId)).toEqual([
        {
          actorType: "user",
          actorId: seeded.owner.userId,
          action: "agent.suspended",
        },
      ]);
      expect(await receiptsOf(tx, seeded.owner.userId)).toHaveLength(1);
    });
  });
});
