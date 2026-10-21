import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  actorFingerprint,
  createCoreCommandRegistry,
  DomainError,
  type JsonObject,
  keyedFingerprint,
  normalizedInputHash,
  operatorActor,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import { createCommandAuthorizationRepository } from "../repositories/command-authorization.js";
import { createCommandTransactionManager } from "../repositories/command-repository.js";
import { createOperatorCredentialRepository } from "../repositories/operator-credential-repository.js";
import {
  commandReceipts,
  domainEvents,
  lanes,
  projectAliases,
  projectMembers,
  projectRepositories,
  projects,
  securityAuditRecords,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { createProjectSettingsCommandRepository } from "./project-settings-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  The first real-database suite for the project settings repository (Plan 13,
  F.2.3; `manifest-f2.md` §2.7). Every write goes through the command bus the
  UI and REST share, with the real unit of work, the real port and the real
  `assertCurrent`, so what is proved here is the handler both reach.

  Each case runs inside a transaction that is rolled back at the end. The bus
  opens its own transaction per command, which Drizzle turns into a savepoint
  inside the outer one.
*/

const busSecret = "project-settings-live-bus-fingerprint-secret-000";
const formSecret = "project-settings-live-form-fingerprint-secret-00";

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
 * deployment with `REQUESTPORT_OPERATOR_CREDENTIALS=enabled` has them; with
 * the switch off `assertCurrent` refuses every operator before these
 * commands run (F.3's own suite holds that).
 */
function portFactory(name: string, database: Database | Tx) {
  if (name === "projectSettingsCommands")
    return createProjectSettingsCommandRepository(database);
  if (name === "commandAuthorization")
    return createCommandAuthorizationRepository(database, {
      operatorCredentials: "enabled",
    });
  return undefined;
}

function bus(tx: Tx) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions: createCommandTransactionManager(
      tx as unknown as Database,
      portFactory,
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

async function seedUser(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Project settings user', ${email}, now())
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
    values (${organizationId}, 'Project settings tenant',
      ${`project-settings-live-${organizationId}`}, 'active')
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
) {
  await tx.insert(projectMembers).values({
    organizationId,
    projectId,
    userId,
    role,
    status: "active",
  });
}

/**
 * A project with what every one of the eleven commands needs to succeed: two
 * active lanes (the first its default), two active repositories (the first its
 * default), and an active organisation member who is not yet on the project.
 */
async function seedProject(tx: Tx, organizationId: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [project] = await tx
    .insert(projects)
    .values({
      organizationId,
      name: `Settings ${suffix}`,
      slug: `settings-${suffix}`,
      // All eight hex characters: with four, two projects seeded in one
      // organisation drew the same prefix often enough to fail a gate
      // (`projects_organization_key_prefix_ci_unique`, 2026-09-29).
      keyPrefix: `S${suffix.toUpperCase()}`,
      status: "active",
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  const [defaultLane, otherLane] = await tx
    .insert(lanes)
    .values([
      { organizationId, projectId: project.id, name: "Main", slug: "main" },
      { organizationId, projectId: project.id, name: "Side", slug: "side" },
    ])
    .returning({ id: lanes.id });
  await tx
    .update(projects)
    .set({ defaultLaneId: defaultLane?.id })
    .where(eq(projects.id, project.id));
  const [defaultRepository, otherRepository] = await tx
    .insert(projectRepositories)
    .values([
      {
        organizationId,
        projectId: project.id,
        provider: "github",
        browseUrl: `https://github.com/settings-live/${suffix}-a`,
        cloneUrl: `https://github.com/settings-live/${suffix}-a.git`,
        repositorySlug: `settings-live/${suffix}-a`,
        isDefault: true,
        status: "active",
      },
      {
        organizationId,
        projectId: project.id,
        provider: "github",
        browseUrl: `https://github.com/settings-live/${suffix}-b`,
        cloneUrl: `https://github.com/settings-live/${suffix}-b.git`,
        repositorySlug: `settings-live/${suffix}-b`,
        isDefault: false,
        status: "active",
      },
    ])
    .returning({ id: projectRepositories.id });
  const target = await seedUser(tx);
  await seedMembership(tx, organizationId, target.userId, "member");
  if (!defaultLane || !otherLane || !defaultRepository || !otherRepository)
    throw new Error("no lanes or repositories");
  return {
    projectId: project.id,
    suffix,
    defaultLaneId: defaultLane.id,
    otherLaneId: otherLane.id,
    defaultRepositoryId: defaultRepository.id,
    otherRepositoryId: otherRepository.id,
    targetUserId: target.userId,
  };
}

type Seeded = Awaited<ReturnType<typeof seedProject>>;

/** A valid input for each command, against a project `seedProject` made. */
const commands: Record<string, (seeded: Seeded) => Record<string, unknown>> = {
  add_project_alias: (seeded) => ({ alias: `alias-${seeded.suffix}` }),
  add_project_repository: (seeded) => ({
    repositoryUrl: `https://github.com/settings-live/${seeded.suffix}-c`,
  }),
  set_default_project_repository: (seeded) => ({
    repositoryId: seeded.otherRepositoryId,
  }),
  set_project_repository_status: (seeded) => ({
    repositoryId: seeded.otherRepositoryId,
    status: "archived",
  }),
  add_project_lane: (seeded) => ({
    name: "Hotfix",
    slug: `hotfix-${seeded.suffix}`,
  }),
  set_default_project_lane: (seeded) => ({ laneId: seeded.otherLaneId }),
  set_project_lane_status: (seeded) => ({
    laneId: seeded.otherLaneId,
    status: "archived",
  }),
  set_project_member: (seeded) => ({
    userId: seeded.targetUserId,
    role: "contributor",
    status: "active",
  }),
  set_project_work_policy: () => ({
    heartbeatIntervalSeconds: 60,
    leaseMultiplier: 4,
    graceSeconds: 1_200,
    requiredWorkspaceFields: [],
  }),
  update_project_metadata: () => ({
    name: "Renamed project",
    description: "A new description",
  }),
  set_project_status: () => ({ status: "archived" }),
};
const commandNames = Object.keys(commands);

function humanContext(input: {
  userId: string;
  sessionId: string;
  organizationId: string;
  scopes?: readonly string[];
}): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: input.userId },
    organizationId: input.organizationId,
    scopes: new Set(input.scopes ?? ["project:manage"]),
    credentialId: input.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

/**
 * Issues an operator credential for `userId` in `organizationId`, holding
 * `project:manage`, as F.3's repository writes one, with the Better Auth key
 * row it is bound to.
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
  const credential = await createOperatorCredentialRepository(
    tx,
  ).createCredential({
    organizationId: input.organizationId,
    memberUserId: input.userId,
    projectId: input.projectId ?? null,
    betterAuthApiKeyId: apiKeyId,
    name: "Project settings operator",
    prefix: "rpo_f23",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: input.scopes ?? ["project:manage"],
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

function key() {
  return `project-settings-live-${crypto.randomUUID()}`;
}

async function run(
  tx: Tx,
  input: {
    name: string;
    context: AuthorizedCommandContext;
    projectId: string;
    fields: Record<string, unknown>;
    expectedVersion?: number;
    idempotencyKey?: string;
  },
) {
  return bus(tx).execute<unknown, JsonObject>({
    name: input.name,
    context: input.context,
    input: {
      organizationId: input.context.organizationId,
      projectId: input.projectId,
      ...input.fields,
    },
    meta: {
      idempotencyKey: input.idempotencyKey ?? key(),
      expectedVersion: input.expectedVersion ?? 1,
    },
  });
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the command was not refused");
}

async function projectVersion(tx: Tx, projectId: string) {
  const [row] = await tx
    .select({ version: projects.version })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row?.version;
}

async function auditRows(tx: Tx, organizationId: string) {
  return tx
    .select({
      actorType: securityAuditRecords.actorType,
      actorId: securityAuditRecords.actorId,
      action: securityAuditRecords.action,
    })
    .from(securityAuditRecords)
    .where(
      and(
        eq(securityAuditRecords.organizationId, organizationId),
        sql`${securityAuditRecords.action} like 'project.%'`,
      ),
    );
}

async function projectEvents(tx: Tx, projectId: string) {
  return tx
    .select({ actor: domainEvents.actor, data: domainEvents.data })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.aggregateId, projectId),
        eq(domainEvents.type, "project.updated.v1"),
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

type Changed = {
  organizationId: string;
  userId: string;
  credentialId: string;
  apiKeyId: string;
};

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("project settings through the command bus", () => {
  describe("the role matrix, for each of the eleven commands", () => {
    const allowed: Array<[string, "owner" | "admin" | "maintainer"]> = [
      ["an organisation owner", "owner"],
      ["an organisation admin", "admin"],
      ["a maintainer of the project", "maintainer"],
    ];
    test.each(allowed)("%s may run every command", async (_, role) => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const actor = await seedUser(tx);
        await seedMembership(
          tx,
          organizationId,
          actor.userId,
          role === "maintainer" ? "member" : role,
        );
        for (const name of commandNames) {
          const seeded = await seedProject(tx, organizationId);
          if (role === "maintainer")
            await seedProjectRole(
              tx,
              organizationId,
              seeded.projectId,
              actor.userId,
              "maintainer",
            );
          const fields = commands[name]?.(seeded) ?? {};
          const result = await run(tx, {
            name,
            context: humanContext({ ...actor, organizationId }),
            projectId: seeded.projectId,
            fields,
          });
          expect(result, name).toMatchObject({
            projectId: seeded.projectId,
            version: 2,
          });
          expect(await projectVersion(tx, seeded.projectId), name).toBe(2);
        }
      });
    });

    const refused: Array<
      [string, "member", "maintainer" | "contributor" | "viewer" | null, string]
    > = [
      ["a maintainer of another project", "member", "maintainer", "other"],
      ["a contributor", "member", "contributor", "this"],
      ["a viewer", "member", "viewer", "this"],
      ["an organisation member with no project role", "member", null, "this"],
    ];
    test.each(refused)(
      "%s is refused every command, and nothing is written",
      async (_, organizationRole, projectRole, where) => {
        await inRollbackTransaction(async (tx) => {
          const organizationId = await seedOrganization(tx);
          const actor = await seedUser(tx);
          await seedMembership(
            tx,
            organizationId,
            actor.userId,
            organizationRole,
          );
          const elsewhere = await seedProject(tx, organizationId);
          if (projectRole && where === "other")
            await seedProjectRole(
              tx,
              organizationId,
              elsewhere.projectId,
              actor.userId,
              projectRole,
            );
          for (const name of commandNames) {
            const seeded = await seedProject(tx, organizationId);
            if (projectRole && where === "this")
              await seedProjectRole(
                tx,
                organizationId,
                seeded.projectId,
                actor.userId,
                projectRole,
              );
            const error = await refusal(
              run(tx, {
                name,
                context: humanContext({ ...actor, organizationId }),
                projectId: seeded.projectId,
                fields: commands[name]?.(seeded) ?? {},
              }),
            );
            expect(error, name).toBeInstanceOf(DomainError);
            expect((error as DomainError).code, name).toBe("forbidden");
            expect(await projectVersion(tx, seeded.projectId), name).toBe(1);
            expect(await receiptsFor(tx, name, actor.userId), name).toEqual([]);
          }
          expect(await auditRows(tx, organizationId)).toEqual([]);
        });
      },
    );

    test("a revoked membership, and a suspended organisation, are refused", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const revoked = await seedUser(tx);
        await seedMembership(
          tx,
          organizationId,
          revoked.userId,
          "owner",
          "revoked",
        );
        const seeded = await seedProject(tx, organizationId);
        const first = await refusal(
          run(tx, {
            name: "add_project_alias",
            context: humanContext({ ...revoked, organizationId }),
            projectId: seeded.projectId,
            fields: commands.add_project_alias?.(seeded) ?? {},
          }),
        );
        expect((first as DomainError).code).toBe("forbidden");

        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        await tx.execute(sql`
          update "organizations" set "status" = 'suspended'
          where "id" = ${organizationId}
        `);
        const second = await refusal(
          run(tx, {
            name: "add_project_alias",
            context: humanContext({ ...owner, organizationId }),
            projectId: seeded.projectId,
            fields: commands.add_project_alias?.(seeded) ?? {},
          }),
        );
        expect((second as DomainError).code).toBe("forbidden");
        expect(await projectVersion(tx, seeded.projectId)).toBe(1);
      });
    });

    test("a project of another organisation is not found, even for an owner of both", async () => {
      await inRollbackTransaction(async (tx) => {
        const home = await seedOrganization(tx);
        const other = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, home, owner.userId, "owner");
        await seedMembership(tx, other, owner.userId, "owner");
        const foreign = await seedProject(tx, other);
        const error = await refusal(
          run(tx, {
            name: "add_project_alias",
            context: humanContext({ ...owner, organizationId: home }),
            projectId: foreign.projectId,
            fields: commands.add_project_alias?.(foreign) ?? {},
          }),
        );
        expect((error as DomainError).code).toBe("not_found");
        // Not the bus's own not_found for a command it does not hold.
        expect((error as DomainError).message).toBe("Project was not found");
        expect(await projectVersion(tx, foreign.projectId)).toBe(1);
      });
    });
  });

  describe("what the bus checks before the repository runs", () => {
    test("a context without project:manage is refused naming that scope", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedProject(tx, organizationId);
        for (const name of commandNames) {
          const error = await refusal(
            run(tx, {
              name,
              context: humanContext({
                ...owner,
                organizationId,
                scopes: ["project:read", "routing:manage"],
              }),
              projectId: seeded.projectId,
              fields: commands[name]?.(seeded) ?? {},
            }),
          );
          expect(error, name).toBeInstanceOf(DomainError);
          expect((error as DomainError).details, name).toEqual({
            scope: "project:manage",
          });
        }
        expect(await projectVersion(tx, seeded.projectId)).toBe(1);
      });
    });

    test("an input naming another organisation than the context's is refused", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedProject(tx, organizationId);
        const error = await refusal(
          bus(tx).execute({
            name: "add_project_alias",
            context: humanContext({ ...owner, organizationId }),
            input: {
              organizationId: crypto.randomUUID(),
              projectId: seeded.projectId,
              alias: "elsewhere",
            },
            meta: { idempotencyKey: key(), expectedVersion: 1 },
          }),
        );
        expect((error as DomainError).code).toBe("forbidden");
        expect(await projectVersion(tx, seeded.projectId)).toBe(1);
      });
    });

    test.each([
      ["an agent", { type: "agent", id: crypto.randomUUID() }],
      [
        "a service actor shaped as an operator, in a context that does not say operator",
        {
          type: "service",
          id: "operator:probe",
          originatingActor: { type: "user", id: "someone" },
        },
      ],
    ] as const)(
      "%s holding project:manage is refused before any repository runs",
      async (_, actor) => {
        await inRollbackTransaction(async (tx) => {
          const organizationId = await seedOrganization(tx);
          const seeded = await seedProject(tx, organizationId);
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
          for (const name of commandNames) {
            const error = await refusal(
              bare.execute({
                name,
                context: {
                  actor,
                  organizationId,
                  projectId: seeded.projectId,
                  scopes: new Set(["project:manage"]),
                  credentialId: "not-a-person",
                  correlationId: crypto.randomUUID(),
                },
                input: {
                  organizationId,
                  projectId: seeded.projectId,
                  ...commands[name]?.(seeded),
                },
                meta: { idempotencyKey: key(), expectedVersion: 1 },
              }),
            );
            expect(error, name).toBeInstanceOf(DomainError);
            expect((error as DomainError).code, name).toBe("forbidden");
            expect((error as DomainError).message, name).toBe(
              "Project settings require a person or an operator credential",
            );
          }
          expect(await projectVersion(tx, seeded.projectId)).toBe(1);
        });
      },
    );
  });

  describe("versions, replays and conflicts", () => {
    test("a stale expected version answers version_conflict and writes nothing", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        for (const name of commandNames) {
          const seeded = await seedProject(tx, organizationId);
          const error = await refusal(
            run(tx, {
              name,
              context: humanContext({ ...owner, organizationId }),
              projectId: seeded.projectId,
              fields: commands[name]?.(seeded) ?? {},
              expectedVersion: 2,
            }),
          );
          expect((error as DomainError).code, name).toBe("version_conflict");
          expect(await projectVersion(tx, seeded.projectId), name).toBe(1);
          expect(await receiptsFor(tx, name, owner.userId), name).toEqual([]);
        }
      });
    });

    test("a replay with the same key and input answers the first result, writing nothing more", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedProject(tx, organizationId);
        const context = humanContext({ ...owner, organizationId });
        const idempotencyKey = key();
        const first = await run(tx, {
          name: "add_project_alias",
          context,
          projectId: seeded.projectId,
          fields: { alias: "Legacy Platform" },
          idempotencyKey,
        });
        const again = await run(tx, {
          name: "add_project_alias",
          context: { ...context, correlationId: crypto.randomUUID() },
          projectId: seeded.projectId,
          fields: { alias: "Legacy Platform" },
          idempotencyKey,
        });
        expect(again).toEqual(first);
        expect(first).toMatchObject({
          projectId: seeded.projectId,
          version: 2,
          id: expect.any(String),
        });
        expect(await projectVersion(tx, seeded.projectId)).toBe(2);
        expect(
          await tx
            .select({ alias: projectAliases.alias })
            .from(projectAliases)
            .where(eq(projectAliases.projectId, seeded.projectId)),
        ).toEqual([{ alias: "Legacy Platform" }]);
        expect(await auditRows(tx, organizationId)).toHaveLength(1);
        expect(await projectEvents(tx, seeded.projectId)).toHaveLength(1);

        const conflicting = await refusal(
          run(tx, {
            name: "add_project_alias",
            context,
            projectId: seeded.projectId,
            fields: { alias: "Another Alias" },
            idempotencyKey,
          }),
        );
        expect((conflicting as DomainError).code).toBe("idempotency_conflict");
        expect(await projectVersion(tx, seeded.projectId)).toBe(2);
      });
    });

    test("a replay by a member who has since lost the role is refused, not answered", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const admin = await seedUser(tx);
        await seedMembership(tx, organizationId, admin.userId, "admin");
        const seeded = await seedProject(tx, organizationId);
        const context = humanContext({ ...admin, organizationId });
        const idempotencyKey = key();
        await run(tx, {
          name: "set_project_work_policy",
          context,
          projectId: seeded.projectId,
          fields: commands.set_project_work_policy?.(seeded) ?? {},
          idempotencyKey,
        });
        await tx.execute(sql`
          update "organization_members" set "role" = 'member'
          where "organization_id" = ${organizationId}
            and "user_id" = ${admin.userId}
        `);
        const error = await refusal(
          run(tx, {
            name: "set_project_work_policy",
            context,
            projectId: seeded.projectId,
            fields: commands.set_project_work_policy?.(seeded) ?? {},
            idempotencyKey,
          }),
        );
        expect((error as DomainError).code).toBe("forbidden");
      });
    });

    test("an alias or a repository already registered answers conflict, as today", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const first = await seedProject(tx, organizationId);
        const second = await seedProject(tx, organizationId);
        const context = humanContext({ ...owner, organizationId });
        await run(tx, {
          name: "add_project_alias",
          context,
          projectId: first.projectId,
          fields: { alias: "shared-name" },
        });
        // Aliases are unique in the organisation, case-insensitively.
        const alias = await refusal(
          run(tx, {
            name: "add_project_alias",
            context,
            projectId: second.projectId,
            fields: { alias: "Shared-Name" },
          }),
        );
        expect((alias as DomainError).code).toBe("conflict");
        const repository = await refusal(
          run(tx, {
            name: "add_project_repository",
            context,
            projectId: second.projectId,
            fields: {
              repositoryUrl: `https://github.com/settings-live/${first.suffix}-a`,
            },
          }),
        );
        expect((repository as DomainError).code).toBe("conflict");
        expect(await projectVersion(tx, second.projectId)).toBe(1);
      });
    });

    test("archiving the default repository or the default lane answers conflict", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedProject(tx, organizationId);
        const context = humanContext({ ...owner, organizationId });
        const repository = await refusal(
          run(tx, {
            name: "set_project_repository_status",
            context,
            projectId: seeded.projectId,
            fields: {
              repositoryId: seeded.defaultRepositoryId,
              status: "archived",
            },
          }),
        );
        expect((repository as DomainError).code).toBe("conflict");
        const lane = await refusal(
          run(tx, {
            name: "set_project_lane_status",
            context,
            projectId: seeded.projectId,
            fields: { laneId: seeded.defaultLaneId, status: "archived" },
          }),
        );
        expect((lane as DomainError).code).toBe("conflict");
        expect(await projectVersion(tx, seeded.projectId)).toBe(1);
      });
    });
  });

  describe("records", () => {
    test("the human path audits and publishes as the user, as before", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedProject(tx, organizationId);
        await run(tx, {
          name: "update_project_metadata",
          context: humanContext({ ...owner, organizationId }),
          projectId: seeded.projectId,
          fields: { name: "Renamed", description: "" },
        });
        expect(await auditRows(tx, organizationId)).toEqual([
          {
            actorType: "user",
            actorId: owner.userId,
            action: "project.metadata_updated",
          },
        ]);
        const events = await projectEvents(tx, seeded.projectId);
        expect(events).toEqual([
          {
            actor: { type: "user", id: owner.userId },
            data: {
              projectId: seeded.projectId,
              changeType: "metadata_changed",
              fieldNames: ["name", "description"],
            },
          },
        ]);
        const [row] = await tx
          .select({ name: projects.name, description: projects.description })
          .from(projects)
          .where(eq(projects.id, seeded.projectId));
        expect(row).toEqual({ name: "Renamed", description: null });
      });
    });

    test("the work policy's required fields are stored once each", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedProject(tx, organizationId);
        await run(tx, {
          name: "set_project_work_policy",
          context: humanContext({ ...owner, organizationId }),
          projectId: seeded.projectId,
          fields: {
            heartbeatIntervalSeconds: 45,
            leaseMultiplier: 3,
            graceSeconds: 600,
            requiredWorkspaceFields: ["hostname", "hostname"],
          },
        });
        const [row] = await tx
          .select({ fields: projects.requiredWorkspaceFields })
          .from(projects)
          .where(eq(projects.id, seeded.projectId));
        expect(row?.fields).toEqual(["hostname"]);
      });
    });
  });

  /*
    The receipt decision (`manifest-f2.md` §2.4, F.2.3): the command's one
    receipt is the bus's. The repository keeps none of its own, so no secret
    is wired into it at all, and the bus's is never handed to it.
  */
  describe("receipts", () => {
    test("a command leaves exactly one receipt, the bus's, keyed with the bus's secret", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const context = humanContext({ ...owner, organizationId });
        for (const name of commandNames) {
          const seeded = await seedProject(tx, organizationId);
          const idempotencyKey = key();
          const result = await run(tx, {
            name,
            context,
            projectId: seeded.projectId,
            fields: commands[name]?.(seeded) ?? {},
            idempotencyKey,
          });
          expect(await receiptsFor(tx, name, owner.userId), name).toEqual([
            {
              idempotencyFingerprint: keyedFingerprint(
                busSecret,
                idempotencyKey,
              ),
              resultJson: result,
            },
          ]);
        }
      });
    });

    test("a receipt the repository stored before the port does not answer the bus: the retry meets the version check", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedProject(tx, organizationId);
        const idempotencyKey = key();
        // What the form's first submission left before the deploy: the
        // alias, the version it bumped, and the repository's own receipt,
        // keyed with the form's secret under the same command name.
        await tx.insert(projectAliases).values({
          organizationId,
          projectId: seeded.projectId,
          alias: "before-the-deploy",
          source: "manual",
        });
        await tx
          .update(projects)
          .set({ version: 2 })
          .where(eq(projects.id, seeded.projectId));
        await tx.insert(commandReceipts).values({
          actorFingerprint: actorFingerprint({
            type: "user",
            id: owner.userId,
          }),
          commandName: "add_project_alias",
          idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
          normalizedInputHash: normalizedInputHash({
            alias: "before-the-deploy",
          }),
          resultJson: { id: crypto.randomUUID() },
          expiresAt: new Date(Date.now() + 60_000),
        });

        const error = await refusal(
          run(tx, {
            name: "add_project_alias",
            context: humanContext({ ...owner, organizationId }),
            projectId: seeded.projectId,
            fields: { alias: "before-the-deploy" },
            idempotencyKey,
            expectedVersion: 1,
          }),
        );
        expect((error as DomainError).code).toBe("version_conflict");
        expect(await projectVersion(tx, seeded.projectId)).toBe(2);
        expect(
          await tx
            .select({ alias: projectAliases.alias })
            .from(projectAliases)
            .where(eq(projectAliases.projectId, seeded.projectId)),
        ).toEqual([{ alias: "before-the-deploy" }]);
      });
    });
  });

  /*
    Plan 13, F.2.3's registry half: an operator credential runs the eleven
    commands with its issuing member's authority, through the same bus, port
    and `assertCurrent` a person's form does, with operator credentials
    switched on. Each refusal below is shown able to pass first: the same
    credential succeeds before the change that makes it fail.
  */
  describe("an operator credential", () => {
    test("an owner's organisation-wide operator runs every command, recorded as the service it is", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const credential = await issueOperator(tx, {
          organizationId,
          userId: owner.userId,
        });
        const context = operatorContext(credential);
        for (const name of commandNames) {
          const seeded = await seedProject(tx, organizationId);
          const result = await run(tx, {
            name,
            context,
            projectId: seeded.projectId,
            fields: commands[name]?.(seeded) ?? {},
          });
          expect(result, name).toMatchObject({
            projectId: seeded.projectId,
            version: 2,
          });
          const events = await projectEvents(tx, seeded.projectId);
          expect(
            events.map((event) => event.actor),
            name,
          ).toEqual([context.actor]);
        }
        const audits = await auditRows(tx, organizationId);
        expect(audits).toHaveLength(commandNames.length);
        for (const row of audits)
          expect(row).toMatchObject({
            actorType: "service",
            actorId: `operator:${credential.lineageId}`,
          });
        // The member is recorded nowhere as the actor: the credential row
        // names them.
        expect(JSON.stringify(audits)).not.toContain(owner.userId);
      });
    });

    test("its receipt is its own, never its member's", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const credential = await issueOperator(tx, {
          organizationId,
          userId: owner.userId,
        });
        const context = operatorContext(credential);
        const seeded = await seedProject(tx, organizationId);
        const idempotencyKey = key();
        const fields = commands.add_project_alias?.(seeded) ?? {};
        const first = await run(tx, {
          name: "add_project_alias",
          context,
          projectId: seeded.projectId,
          fields,
          idempotencyKey,
        });
        // The member's own retry with the operator's key is not answered from
        // the operator's receipt: it runs, and meets the version check.
        const member = await refusal(
          run(tx, {
            name: "add_project_alias",
            context: humanContext({ ...owner, organizationId }),
            projectId: seeded.projectId,
            fields,
            idempotencyKey,
          }),
        );
        expect((member as DomainError).code).toBe("version_conflict");
        // The operator's replay is answered from its receipt.
        expect(
          await run(tx, {
            name: "add_project_alias",
            context: operatorContext(credential),
            projectId: seeded.projectId,
            fields,
            idempotencyKey,
          }),
        ).toEqual(first);
        const receipts = await tx
          .select({ actorFingerprint: commandReceipts.actorFingerprint })
          .from(commandReceipts)
          .where(eq(commandReceipts.commandName, "add_project_alias"));
        expect(receipts.map((row) => row.actorFingerprint)).toContain(
          actorFingerprint(context.actor),
        );
        expect(
          await receiptsFor(tx, "add_project_alias", owner.userId),
        ).toEqual([]);
      });
    });

    test("an operator bound to a project runs it, and is refused another project of its organisation", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const bound = await seedProject(tx, organizationId);
        const credential = await issueOperator(tx, {
          organizationId,
          userId: owner.userId,
          projectId: bound.projectId,
        });
        for (const name of commandNames) {
          const other = await seedProject(tx, organizationId);
          const error = await refusal(
            run(tx, {
              name,
              context: operatorContext(credential),
              projectId: other.projectId,
              fields: commands[name]?.(other) ?? {},
            }),
          );
          expect((error as DomainError).code, name).toBe("forbidden");
          expect(await projectVersion(tx, other.projectId), name).toBe(1);
        }
        const result = await run(tx, {
          name: "add_project_alias",
          context: operatorContext(credential),
          projectId: bound.projectId,
          fields: commands.add_project_alias?.(bound) ?? {},
        });
        expect(result).toMatchObject({
          projectId: bound.projectId,
          version: 2,
        });
        expect(
          (await auditRows(tx, organizationId)).map((row) => row.action),
        ).toEqual(["project.alias_added"]);
      });
    });

    test("an operator issued for one organisation finds no project of another, though its member owns both", async () => {
      await inRollbackTransaction(async (tx) => {
        const home = await seedOrganization(tx);
        const other = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, home, owner.userId, "owner");
        await seedMembership(tx, other, owner.userId, "owner");
        const credential = await issueOperator(tx, {
          organizationId: home,
          userId: owner.userId,
        });
        const foreign = await seedProject(tx, other);
        for (const name of commandNames) {
          const error = await refusal(
            run(tx, {
              name,
              context: operatorContext(credential),
              projectId: foreign.projectId,
              fields: commands[name]?.(foreign) ?? {},
            }),
          );
          expect((error as DomainError).code, name).toBe("not_found");
          expect((error as DomainError).message, name).toBe(
            "Project was not found",
          );
        }
        // Naming the other organisation in the input is refused outright; the
        // route overwrites that field with the credential's anyway.
        const named = await refusal(
          bus(tx).execute({
            name: "add_project_alias",
            context: operatorContext(credential),
            input: {
              organizationId: other,
              projectId: foreign.projectId,
              ...commands.add_project_alias?.(foreign),
            },
            meta: { idempotencyKey: key(), expectedVersion: 1 },
          }),
        );
        expect((named as DomainError).code).toBe("forbidden");
        expect(await projectVersion(tx, foreign.projectId)).toBe(1);
        expect(await auditRows(tx, other)).toEqual([]);
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
          const organizationId = await seedOrganization(tx);
          const owner = await seedUser(tx);
          await seedMembership(tx, organizationId, owner.userId, "owner");
          const credential = await issueOperator(tx, {
            organizationId,
            userId: owner.userId,
          });
          const seeded = await seedProject(tx, organizationId);
          await run(tx, {
            name: "add_project_alias",
            context: operatorContext(credential),
            projectId: seeded.projectId,
            fields: commands.add_project_alias?.(seeded) ?? {},
          });
          expect(await projectVersion(tx, seeded.projectId)).toBe(2);
          await change(tx, {
            organizationId,
            userId: owner.userId,
            credentialId: credential.id,
            apiKeyId: credential.apiKeyId,
          });
          const error = await refusal(
            run(tx, {
              name: "update_project_metadata",
              context: operatorContext(credential),
              projectId: seeded.projectId,
              fields: { name: "Renamed", description: "" },
              expectedVersion: 2,
            }),
          );
          expect(error).toBeInstanceOf(DomainError);
          expect((error as DomainError).code).toBe("forbidden");
          expect(await projectVersion(tx, seeded.projectId)).toBe(2);
          expect(
            (await auditRows(tx, organizationId)).map((row) => row.action),
          ).toEqual(["project.alias_added"]);
        });
      },
    );

    test("a maintainer's operator bound to the maintained project runs it", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const maintainer = await seedUser(tx);
        await seedMembership(tx, organizationId, maintainer.userId, "member");
        const seeded = await seedProject(tx, organizationId);
        await seedProjectRole(
          tx,
          organizationId,
          seeded.projectId,
          maintainer.userId,
          "maintainer",
        );
        const credential = await issueOperator(tx, {
          organizationId,
          userId: maintainer.userId,
          projectId: seeded.projectId,
        });
        expect(
          await run(tx, {
            name: "set_project_work_policy",
            context: operatorContext(credential),
            projectId: seeded.projectId,
            fields: commands.set_project_work_policy?.(seeded) ?? {},
          }),
        ).toMatchObject({ projectId: seeded.projectId, version: 2 });
      });
    });
  });
});
