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
  type UnitOfWork,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  commandReceipts,
  domainEvents,
  projects,
  securityAuditRecords,
  slackInstallations,
  slackRoutes,
  slackUserMappings,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import {
  endingEachCommandBinding,
  endingEachMethodBinding,
} from "../test-support/tenant-binding.js";
import type { Tx } from "../transaction.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";
import { createCommandTransactionManager } from "./command-repository.js";
import { createOperatorCredentialRepository } from "./operator-credential-repository.js";
import {
  createSlackAdministrationCommandRepository,
  createSlackRepository,
} from "./slack-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  The Slack repository against a real database (Plan 13, F.2.5;
  `manifest-f2.md` §2.7). The three administrative writes go through the
  command bus the UI and REST share, with the real unit of work, the real port
  and the real `assertCurrent`, so what is proved here is the handler both
  reach.

  Each case runs inside a transaction that is rolled back at the end. The bus
  opens its own transaction per command, which Drizzle turns into a savepoint
  inside the outer one, and so does the repository inside the bus's.

  The fourth Slack capability, the connection test, stays off the bus. Its
  repository write, `queueConnectionTest`, is proved on PostgreSQL through its
  handler, for a person as the form calls it and for an operator through
  `/api/v1`, in `apps/web/src/app/(app)/slack/
  actions.connection-test.database.test.ts`.
*/

const busSecret = "slack-live-bus-fingerprint-secret-000000000000";
const formSecret = "slack-live-form-fingerprint-secret-0000000000";

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
 * commands run (F.3's own suite holds that). A person's context is checked
 * the same either way.
 */
function portFactory(name: string, database: Database | Tx) {
  if (name === "slackAdministrationCommands")
    return createSlackAdministrationCommandRepository(database);
  if (name === "commandAuthorization")
    return createCommandAuthorizationRepository(database, {
      operatorCredentials: "enabled",
    });
  return undefined;
}

function bus(tx: Tx, options: { assertCurrent?: boolean } = {}) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    // A case runs commands for several people or organisations on one
    // transaction; each command's binding ends with it, as its own
    // transaction ends it in production (test-support/tenant-binding.ts).
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(tx as unknown as Database, portFactory),
      tx,
    ),
    fingerprintSecret: busSecret,
    ...(options.assertCurrent === false
      ? {}
      : {
          authorizeContext: (
            context: AuthorizedCommandContext,
            uow: UnitOfWork,
          ) =>
            uow
              .port<ReturnType<typeof createCommandAuthorizationRepository>>(
                "commandAuthorization",
              )
              .assertCurrent(context),
        }),
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
    values (${userId}, 'Slack user', ${email}, now())
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
    values (${organizationId}, 'Slack tenant',
      ${`slack-live-${organizationId}`}, 'active')
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
      name: `Slack ${suffix}`,
      slug: `slack-${suffix}`,
      keyPrefix: `K${suffix.slice(0, 4).toUpperCase()}`,
      status: "active",
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  return project.id;
}

/**
 * What every one of the three commands needs to succeed in an organisation:
 * an active installation at version 1, and an active member with no Slack
 * mapping yet.
 */
async function seedSlack(tx: Tx, organizationId: string) {
  const target = await seedUser(tx);
  await seedMembership(tx, organizationId, target.userId, "member");
  const [installation] = await tx
    .insert(slackInstallations)
    .values({
      organizationId,
      workspaceId: `T${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      workspaceName: "Slack live workspace",
      botTokenCiphertext: { sealed: "not-a-real-token" },
      botUserId: "U0BOTUSER",
      installedByUserId: target.userId,
    })
    .returning({ id: slackInstallations.id });
  if (!installation) throw new Error("no installation");
  return { installationId: installation.id, targetUserId: target.userId };
}

type Seeded = Awaited<ReturnType<typeof seedSlack>>;

/** A valid input for each command, with the version it expects and leaves. */
const commands: Record<
  string,
  {
    fields: (seeded: Seeded) => Record<string, unknown>;
    expectedVersion: number;
    writtenVersion: number;
  }
> = {
  set_slack_user_mapping: {
    fields: (seeded) => ({
      installationId: seeded.installationId,
      userId: seeded.targetUserId,
      slackUserId: "U0TARGET1",
    }),
    expectedVersion: 0,
    writtenVersion: 1,
  },
  set_slack_route: {
    fields: () => ({
      projectId: null,
      mode: "channel",
      channelId: "C0ROUTE01",
      fallback: "none",
    }),
    expectedVersion: 0,
    writtenVersion: 1,
  },
  set_slack_installation_status: {
    fields: (seeded) => ({
      installationId: seeded.installationId,
      status: "disabled",
    }),
    expectedVersion: 1,
    writtenVersion: 2,
  },
};
const commandNames = Object.keys(commands);

/** For each command, a change to its valid input that makes it other input. */
const otherInput: Record<string, Record<string, unknown>> = {
  set_slack_user_mapping: { slackUserId: "U0OTHER01" },
  set_slack_route: { channelId: "C0OTHER01" },
  set_slack_installation_status: { status: "active" },
};

function humanContext(input: {
  userId: string;
  sessionId: string;
  organizationId: string;
  scopes?: readonly string[];
}): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: input.userId },
    organizationId: input.organizationId,
    scopes: new Set(input.scopes ?? ["slack:manage"]),
    credentialId: input.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

/**
 * Issues an operator credential for `userId` in `organizationId`, holding
 * `slack:manage`, as F.3's repository writes one, with the Better Auth key
 * row it is bound to.
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
    name: "Slack operator",
    prefix: "rpo_f25",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["slack:manage"],
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
  return `slack-live-${crypto.randomUUID()}`;
}

async function run(
  tx: Tx,
  input: {
    name: string;
    context: AuthorizedCommandContext;
    fields: Record<string, unknown>;
    expectedVersion?: number;
    idempotencyKey?: string;
  },
) {
  return bus(tx).execute<unknown, JsonObject>({
    name: input.name,
    context: input.context,
    input: { organizationId: input.context.organizationId, ...input.fields },
    meta: {
      idempotencyKey: input.idempotencyKey ?? key(),
      expectedVersion:
        input.expectedVersion ?? commands[input.name]?.expectedVersion ?? 0,
    },
  });
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the write was not refused");
}

/**
 * Everything the three writes can leave in an organisation: its mappings,
 * routes and installations with their versions, and its Slack audit rows and
 * events. Two snapshots equal means nothing was written between them.
 */
async function slackState(tx: Tx, organizationId: string) {
  // One query at a time: they share the transaction's one client.
  const mappings = await tx
    .select({ id: slackUserMappings.id, version: slackUserMappings.version })
    .from(slackUserMappings)
    .where(eq(slackUserMappings.organizationId, organizationId));
  const routes = await tx
    .select({
      id: slackRoutes.id,
      status: slackRoutes.status,
      version: slackRoutes.version,
    })
    .from(slackRoutes)
    .where(eq(slackRoutes.organizationId, organizationId));
  const installations = await tx
    .select({
      id: slackInstallations.id,
      status: slackInstallations.status,
      version: slackInstallations.version,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.organizationId, organizationId));
  const audits = await auditRows(tx, organizationId);
  const events = await slackEvents(tx, organizationId);
  return { mappings, routes, installations, audits, events };
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
        sql`${securityAuditRecords.action} like 'slack.%'`,
      ),
    );
}

async function slackEvents(tx: Tx, organizationId: string) {
  return tx
    .select({ actor: domainEvents.actor, data: domainEvents.data })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.organizationId, organizationId),
        eq(domainEvents.type, "integration.slack_changed.v1"),
      ),
    );
}

/** Every receipt the user holds, whatever command wrote it. */
async function receiptsOf(tx: Tx, userId: string) {
  return tx
    .select({
      commandName: commandReceipts.commandName,
      idempotencyFingerprint: commandReceipts.idempotencyFingerprint,
      resultJson: commandReceipts.resultJson,
    })
    .from(commandReceipts)
    .where(
      eq(
        commandReceipts.actorFingerprint,
        actorFingerprint({ type: "user", id: userId }),
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

describe.sequential("Slack administration through the command bus", () => {
  describe("the role matrix, for each of the three commands", () => {
    test.each([
      ["an organisation owner", "owner"],
      ["an organisation admin", "admin"],
    ] as const)("%s may run every command", async (_, role) => {
      await inRollbackTransaction(async (tx) => {
        for (const name of commandNames) {
          const organizationId = await seedOrganization(tx);
          const actor = await seedUser(tx);
          await seedMembership(tx, organizationId, actor.userId, role);
          const seeded = await seedSlack(tx, organizationId);
          const result = await run(tx, {
            name,
            context: humanContext({ ...actor, organizationId }),
            fields: commands[name]?.fields(seeded) ?? {},
          });
          expect(result, name).toMatchObject({
            id: expect.any(String),
            version: commands[name]?.writtenVersion,
          });
        }
      });
    });

    test.each([
      ["an organisation member", "member", false],
      ["an organisation member who maintains a project", "member", true],
    ] as const)(
      "%s is refused every command, and nothing is written",
      async (_, role, maintainer) => {
        await inRollbackTransaction(async (tx) => {
          const organizationId = await seedOrganization(tx);
          const actor = await seedUser(tx);
          await seedMembership(tx, organizationId, actor.userId, role);
          if (maintainer) {
            const projectId = await seedProject(tx, organizationId);
            await tx.execute(sql`
              insert into "project_members"
                ("organization_id", "project_id", "user_id", "role", "status")
              values (${organizationId}, ${projectId}, ${actor.userId},
                'maintainer', 'active')
            `);
          }
          const seeded = await seedSlack(tx, organizationId);
          const before = await slackState(tx, organizationId);
          for (const name of commandNames) {
            const error = await refusal(
              run(tx, {
                name,
                context: humanContext({ ...actor, organizationId }),
                fields: commands[name]?.fields(seeded) ?? {},
              }),
            );
            expect(error, name).toBeInstanceOf(DomainError);
            expect((error as DomainError).code, name).toBe("forbidden");
          }
          expect(await slackState(tx, organizationId)).toEqual(before);
          expect(await receiptsOf(tx, actor.userId)).toEqual([]);
        });
      },
    );

    test("a revoked owner, an ended session and a suspended organisation are refused", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const seeded = await seedSlack(tx, organizationId);
        const revoked = await seedUser(tx);
        await seedMembership(
          tx,
          organizationId,
          revoked.userId,
          "owner",
          "revoked",
        );
        const ended = await seedUser(tx);
        await seedMembership(tx, organizationId, ended.userId, "owner");
        await tx.execute(sql`
          update "session" set "expires_at" = now() - interval '1 minute'
          where "id" = ${ended.sessionId}
        `);
        const before = await slackState(tx, organizationId);
        for (const name of commandNames) {
          for (const actor of [revoked, ended]) {
            const error = await refusal(
              run(tx, {
                name,
                context: humanContext({ ...actor, organizationId }),
                fields: commands[name]?.fields(seeded) ?? {},
              }),
            );
            expect((error as DomainError).code, name).toBe("forbidden");
          }
        }

        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        await tx.execute(sql`
          update "organizations" set "status" = 'suspended'
          where "id" = ${organizationId}
        `);
        for (const name of commandNames) {
          const error = await refusal(
            run(tx, {
              name,
              context: humanContext({ ...owner, organizationId }),
              fields: commands[name]?.fields(seeded) ?? {},
            }),
          );
          expect((error as DomainError).code, name).toBe("forbidden");
        }
        expect(await slackState(tx, organizationId)).toEqual(before);
      });
    });

    test("another organisation's installation and project are refused, even for an owner of both", async () => {
      await inRollbackTransaction(async (tx) => {
        const home = await seedOrganization(tx);
        const other = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, home, owner.userId, "owner");
        await seedMembership(tx, other, owner.userId, "owner");
        const foreign = await seedSlack(tx, other);
        const foreignProjectId = await seedProject(tx, other);
        await seedMembership(tx, home, foreign.targetUserId, "member");
        const context = humanContext({ ...owner, organizationId: home });
        const before = await slackState(tx, other);

        const mapping = await refusal(
          run(tx, {
            name: "set_slack_user_mapping",
            context,
            fields: commands.set_slack_user_mapping?.fields(foreign) ?? {},
          }),
        );
        expect((mapping as DomainError).code).toBe("validation_failed");
        const status = await refusal(
          run(tx, {
            name: "set_slack_installation_status",
            context,
            fields:
              commands.set_slack_installation_status?.fields(foreign) ?? {},
          }),
        );
        expect((status as DomainError).code).toBe("not_found");
        expect((status as DomainError).message).toBe(
          "Slack installation was not found",
        );
        const route = await refusal(
          run(tx, {
            name: "set_slack_route",
            context,
            fields: {
              ...commands.set_slack_route?.fields(foreign),
              projectId: foreignProjectId,
            },
          }),
        );
        expect((route as DomainError).code).toBe("validation_failed");
        expect(await slackState(tx, other)).toEqual(before);
        expect(await slackState(tx, home)).toMatchObject({
          routes: [],
          audits: [],
          events: [],
        });
      });
    });
  });

  describe("what the bus checks before the repository runs", () => {
    test("an input naming another organisation than the context's is refused", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedSlack(tx, organizationId);
        const before = await slackState(tx, organizationId);
        for (const name of commandNames) {
          const error = await refusal(
            bus(tx).execute({
              name,
              context: humanContext({ ...owner, organizationId }),
              input: {
                ...commands[name]?.fields(seeded),
                organizationId: crypto.randomUUID(),
              },
              meta: {
                idempotencyKey: key(),
                expectedVersion: commands[name]?.expectedVersion ?? 0,
              },
            }),
          );
          expect((error as DomainError).code, name).toBe("forbidden");
        }
        expect(await slackState(tx, organizationId)).toEqual(before);
      });
    });

    test("a context without slack:manage is refused naming that scope, and nothing is written", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedSlack(tx, organizationId);
        const before = await slackState(tx, organizationId);
        for (const name of commandNames) {
          const error = await refusal(
            run(tx, {
              name,
              context: humanContext({
                ...owner,
                organizationId,
                scopes: ["org:read", "project:manage", "routing:manage"],
              }),
              fields: commands[name]?.fields(seeded) ?? {},
            }),
          );
          expect(error, name).toBeInstanceOf(DomainError);
          expect((error as DomainError).code, name).toBe("forbidden");
          expect((error as DomainError).details, name).toEqual({
            scope: "slack:manage",
          });
        }
        expect(await slackState(tx, organizationId)).toEqual(before);
        expect(await receiptsOf(tx, owner.userId)).toEqual([]);
      });
    });

    test("a replay by a context that has since lost slack:manage is refused, not answered", async () => {
      await inRollbackTransaction(async (tx) => {
        for (const name of commandNames) {
          const organizationId = await seedOrganization(tx);
          const owner = await seedUser(tx);
          await seedMembership(tx, organizationId, owner.userId, "owner");
          const seeded = await seedSlack(tx, organizationId);
          const idempotencyKey = key();
          const fields = commands[name]?.fields(seeded) ?? {};
          await run(tx, {
            name,
            context: humanContext({ ...owner, organizationId }),
            fields,
            idempotencyKey,
          });
          const error = await refusal(
            run(tx, {
              name,
              context: humanContext({
                ...owner,
                organizationId,
                scopes: ["org:read"],
              }),
              fields,
              idempotencyKey,
            }),
          );
          expect((error as DomainError).code, name).toBe("forbidden");
          expect((error as DomainError).details, name).toEqual({
            scope: "slack:manage",
          });
        }
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
      "%s holding slack:manage is refused before any repository runs",
      async (_, actor) => {
        await inRollbackTransaction(async (tx) => {
          const organizationId = await seedOrganization(tx);
          const seeded = await seedSlack(tx, organizationId);
          const before = await slackState(tx, organizationId);
          // The bus's own `assertCurrent` is left out here: it would refuse
          // these contexts for having no credential row, which would hide
          // whether the command refuses them itself.
          for (const name of commandNames) {
            const error = await refusal(
              bus(tx, { assertCurrent: false }).execute({
                name,
                context: {
                  actor,
                  organizationId,
                  scopes: new Set(["slack:manage"]),
                  credentialId: "not-a-person",
                  correlationId: crypto.randomUUID(),
                },
                input: { organizationId, ...commands[name]?.fields(seeded) },
                meta: {
                  idempotencyKey: key(),
                  expectedVersion: commands[name]?.expectedVersion ?? 0,
                },
              }),
            );
            expect(error, name).toBeInstanceOf(DomainError);
            expect((error as DomainError).code, name).toBe("forbidden");
            expect((error as DomainError).message, name).toBe(
              "Slack administration requires a person or an operator credential",
            );
          }
          expect(await slackState(tx, organizationId)).toEqual(before);
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
        const seeded = await seedSlack(tx, organizationId);
        const before = await slackState(tx, organizationId);
        for (const name of commandNames) {
          const error = await refusal(
            run(tx, {
              name,
              context: humanContext({ ...owner, organizationId }),
              fields: commands[name]?.fields(seeded) ?? {},
              expectedVersion: (commands[name]?.expectedVersion ?? 0) + 1,
            }),
          );
          expect((error as DomainError).code, name).toBe("version_conflict");
        }
        expect(await slackState(tx, organizationId)).toEqual(before);
        expect(await receiptsOf(tx, owner.userId)).toEqual([]);
      });
    });

    test("a replay with the same key and input answers the first result, writing nothing more", async () => {
      await inRollbackTransaction(async (tx) => {
        for (const name of commandNames) {
          const organizationId = await seedOrganization(tx);
          const owner = await seedUser(tx);
          await seedMembership(tx, organizationId, owner.userId, "owner");
          const seeded = await seedSlack(tx, organizationId);
          const context = humanContext({ ...owner, organizationId });
          const idempotencyKey = key();
          const fields = commands[name]?.fields(seeded) ?? {};
          const first = await run(tx, {
            name,
            context,
            fields,
            idempotencyKey,
          });
          const after = await slackState(tx, organizationId);
          const again = await run(tx, {
            name,
            context: { ...context, correlationId: crypto.randomUUID() },
            fields,
            idempotencyKey,
          });
          expect(again, name).toEqual(first);
          expect(await slackState(tx, organizationId), name).toEqual(after);
          expect(after.audits, name).toHaveLength(1);

          const conflicting = await refusal(
            run(tx, {
              name,
              context,
              fields: { ...fields, ...otherInput[name] },
              idempotencyKey,
            }),
          );
          expect((conflicting as DomainError).code, name).toBe(
            "idempotency_conflict",
          );
          expect(await slackState(tx, organizationId), name).toEqual(after);
        }
      });
    });

    test("a replay by a member who has since lost the role is refused, not answered", async () => {
      await inRollbackTransaction(async (tx) => {
        for (const name of commandNames) {
          const organizationId = await seedOrganization(tx);
          const admin = await seedUser(tx);
          await seedMembership(tx, organizationId, admin.userId, "admin");
          const seeded = await seedSlack(tx, organizationId);
          const context = humanContext({ ...admin, organizationId });
          const idempotencyKey = key();
          const fields = commands[name]?.fields(seeded) ?? {};
          await run(tx, { name, context, fields, idempotencyKey });
          await tx.execute(sql`
            update "organization_members" set "role" = 'member'
            where "organization_id" = ${organizationId}
              and "user_id" = ${admin.userId}
          `);
          const error = await refusal(
            run(tx, { name, context, fields, idempotencyKey }),
          );
          expect((error as DomainError).code, name).toBe("forbidden");
        }
      });
    });

    test("the refusals the forms already answered are unchanged", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedSlack(tx, organizationId);
        const context = humanContext({ ...owner, organizationId });

        // A Slack user already mapped to another member.
        await run(tx, {
          name: "set_slack_user_mapping",
          context,
          fields: commands.set_slack_user_mapping?.fields(seeded) ?? {},
        });
        const other = await seedUser(tx);
        await seedMembership(tx, organizationId, other.userId, "member");
        const taken = await refusal(
          run(tx, {
            name: "set_slack_user_mapping",
            context,
            fields: {
              installationId: seeded.installationId,
              userId: other.userId,
              slackUserId: "U0TARGET1",
            },
          }),
        );
        expect((taken as DomainError).code).toBe("validation_failed");
        expect((taken as DomainError).message).toBe(
          "That Slack user is already mapped to another organization member",
        );

        // A channel route with no channel.
        const channelless = await refusal(
          run(tx, {
            name: "set_slack_route",
            context,
            fields: {
              projectId: null,
              mode: "both",
              channelId: null,
              fallback: "none",
            },
          }),
        );
        expect((channelless as DomainError).code).toBe("validation_failed");

        // A revoked installation is reinstalled through OAuth, never re-enabled.
        const revoked = await run(tx, {
          name: "set_slack_installation_status",
          context,
          fields: { installationId: seeded.installationId, status: "revoked" },
          expectedVersion: 1,
        });
        const reenabled = await refusal(
          run(tx, {
            name: "set_slack_installation_status",
            context,
            fields: {
              installationId: seeded.installationId,
              status: "active",
            },
            expectedVersion: revoked.version as number,
          }),
        );
        expect((reenabled as DomainError).code).toBe("conflict");
      });
    });
  });

  describe("a Slack route's version", () => {
    function setRoute(
      tx: Tx,
      context: AuthorizedCommandContext,
      channelId: string,
      expectedVersion: number,
    ) {
      return run(tx, {
        name: "set_slack_route",
        context,
        fields: {
          projectId: null,
          mode: "channel",
          channelId,
          fallback: "none",
        },
        expectedVersion,
      });
    }

    test("each replacement's successor carries the next version", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const context = humanContext({ ...owner, organizationId });

        const first = await setRoute(tx, context, "C0FIRST01", 0);
        const second = await setRoute(
          tx,
          context,
          "C0SECOND1",
          first.version as number,
        );
        const third = await setRoute(
          tx,
          context,
          "C0THIRD01",
          second.version as number,
        );

        expect([first.version, second.version, third.version]).toEqual([
          1, 2, 3,
        ]);
        const [active] = await tx
          .select({ id: slackRoutes.id, version: slackRoutes.version })
          .from(slackRoutes)
          .where(
            and(
              eq(slackRoutes.organizationId, organizationId),
              eq(slackRoutes.status, "active"),
            ),
          );
        expect(active).toEqual({ id: third.id, version: 3 });
      });
    });

    test("a writer holding the version another writer already replaced is refused", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        const admin = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        await seedMembership(tx, organizationId, admin.userId, "admin");
        const ownerContext = humanContext({ ...owner, organizationId });
        const existing = await setRoute(tx, ownerContext, "C0EXIST01", 0);

        // Both read the route at the same version; the owner writes first.
        await setRoute(
          tx,
          ownerContext,
          "C0OWNER01",
          existing.version as number,
        );
        const error = await refusal(
          setRoute(
            tx,
            humanContext({ ...admin, organizationId }),
            "C0ADMIN01",
            existing.version as number,
          ),
        );

        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("version_conflict");
        const active = await tx
          .select({ channelId: slackRoutes.channelId })
          .from(slackRoutes)
          .where(
            and(
              eq(slackRoutes.organizationId, organizationId),
              eq(slackRoutes.status, "active"),
            ),
          );
        expect(active).toEqual([{ channelId: "C0OWNER01" }]);
      });
    });
  });

  describe("records", () => {
    test("the human path audits and publishes as the user, as before", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedSlack(tx, organizationId);
        const context = humanContext({ ...owner, organizationId });
        for (const name of commandNames)
          await run(tx, {
            name,
            context,
            fields: commands[name]?.fields(seeded) ?? {},
          });
        expect(await auditRows(tx, organizationId)).toEqual(
          expect.arrayContaining([
            {
              actorType: "user",
              actorId: owner.userId,
              action: "slack.user_mapping_updated",
            },
            {
              actorType: "user",
              actorId: owner.userId,
              action: "slack.route_changed",
            },
            {
              actorType: "user",
              actorId: owner.userId,
              action: "slack.installation_disabled",
            },
          ]),
        );
        const events = await slackEvents(tx, organizationId);
        expect(events.map((event) => event.data.changeType).sort()).toEqual([
          "route_changed",
          "status_changed",
          "user_mapping_changed",
        ]);
        for (const event of events)
          expect(event.actor).toEqual({ type: "user", id: owner.userId });
      });
    });
  });

  /*
    Plan 13, F.2.5's registry half: an operator credential runs the three
    commands with its issuing member's authority, through the same bus, port
    and `assertCurrent` a person's form does, with operator credentials
    switched on. Each refusal of a change below is shown able to pass first:
    the same credential succeeds before the change that makes it fail.
  */
  describe("an operator credential", () => {
    test("an owner's organisation-wide operator runs every command, recorded as the service it is", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedSlack(tx, organizationId);
        const credential = await issueOperator(tx, {
          organizationId,
          userId: owner.userId,
        });
        const context = operatorContext(credential);
        for (const name of commandNames) {
          const result = await run(tx, {
            name,
            context,
            fields: commands[name]?.fields(seeded) ?? {},
          });
          expect(result, name).toMatchObject({
            id: expect.any(String),
            version: commands[name]?.writtenVersion,
          });
        }
        const audits = await auditRows(tx, organizationId);
        expect(audits.map((row) => row.action).sort()).toEqual([
          "slack.installation_disabled",
          "slack.route_changed",
          "slack.user_mapping_updated",
        ]);
        for (const row of audits)
          expect(row).toMatchObject({
            actorType: "service",
            actorId: `operator:${credential.lineageId}`,
          });
        // The member is recorded nowhere as the audit actor: the credential
        // row names them.
        expect(JSON.stringify(audits)).not.toContain(owner.userId);
        const events = await slackEvents(tx, organizationId);
        expect(events.map((event) => event.data.changeType).sort()).toEqual([
          "route_changed",
          "status_changed",
          "user_mapping_changed",
        ]);
        for (const event of events) expect(event.actor).toEqual(context.actor);
      });
    });

    test("its receipt is its own, never its member's", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedSlack(tx, organizationId);
        const credential = await issueOperator(tx, {
          organizationId,
          userId: owner.userId,
        });
        const context = operatorContext(credential);
        const idempotencyKey = key();
        const fields = commands.set_slack_route?.fields(seeded) ?? {};
        const first = await run(tx, {
          name: "set_slack_route",
          context,
          fields,
          idempotencyKey,
        });
        // The member's own retry with the operator's key is not answered from
        // the operator's receipt: it runs, and meets the version check.
        const member = await refusal(
          run(tx, {
            name: "set_slack_route",
            context: humanContext({ ...owner, organizationId }),
            fields,
            idempotencyKey,
          }),
        );
        expect((member as DomainError).code).toBe("version_conflict");
        // The operator's replay is answered from its receipt.
        expect(
          await run(tx, {
            name: "set_slack_route",
            context: operatorContext(credential),
            fields,
            idempotencyKey,
          }),
        ).toEqual(first);
        const receipts = await tx
          .select({ actorFingerprint: commandReceipts.actorFingerprint })
          .from(commandReceipts)
          .where(eq(commandReceipts.commandName, "set_slack_route"));
        expect(receipts.map((row) => row.actorFingerprint)).toContain(
          actorFingerprint(context.actor),
        );
        expect(await receiptsOf(tx, owner.userId)).toEqual([]);
      });
    });

    test("an operator bound to a project is refused every command, even an owner's, and nothing is written", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedSlack(tx, organizationId);
        const projectId = await seedProject(tx, organizationId);
        const credential = await issueOperator(tx, {
          organizationId,
          userId: owner.userId,
          projectId,
        });
        const before = await slackState(tx, organizationId);
        for (const name of commandNames) {
          const error = await refusal(
            run(tx, {
              name,
              context: operatorContext(credential),
              fields: {
                ...commands[name]?.fields(seeded),
                ...(name === "set_slack_route" ? { projectId } : {}),
              },
            }),
          );
          expect(error, name).toBeInstanceOf(DomainError);
          expect((error as DomainError).code, name).toBe("forbidden");
        }
        expect(await slackState(tx, organizationId)).toEqual(before);
      });
    });

    test("an operator issued for one organisation reaches nothing of another, though its member owns both", async () => {
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
        const foreign = await seedSlack(tx, other);
        const foreignProjectId = await seedProject(tx, other);
        await seedMembership(tx, home, foreign.targetUserId, "member");
        const before = await slackState(tx, other);

        const mapping = await refusal(
          run(tx, {
            name: "set_slack_user_mapping",
            context: operatorContext(credential),
            fields: commands.set_slack_user_mapping?.fields(foreign) ?? {},
          }),
        );
        expect((mapping as DomainError).code).toBe("validation_failed");
        const status = await refusal(
          run(tx, {
            name: "set_slack_installation_status",
            context: operatorContext(credential),
            fields:
              commands.set_slack_installation_status?.fields(foreign) ?? {},
          }),
        );
        expect((status as DomainError).code).toBe("not_found");
        const route = await refusal(
          run(tx, {
            name: "set_slack_route",
            context: operatorContext(credential),
            fields: {
              ...commands.set_slack_route?.fields(foreign),
              projectId: foreignProjectId,
            },
          }),
        );
        expect((route as DomainError).code).toBe("validation_failed");
        // Naming the other organisation in the input is refused outright; the
        // route overwrites that field with the credential's anyway.
        for (const name of commandNames) {
          const named = await refusal(
            bus(tx).execute({
              name,
              context: operatorContext(credential),
              input: {
                ...commands[name]?.fields(foreign),
                organizationId: other,
              },
              meta: {
                idempotencyKey: key(),
                expectedVersion: commands[name]?.expectedVersion ?? 0,
              },
            }),
          );
          expect((named as DomainError).code, name).toBe("forbidden");
        }
        expect(await slackState(tx, other)).toEqual(before);
        expect(await slackState(tx, home)).toMatchObject({
          routes: [],
          audits: [],
          events: [],
        });
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
          await seedSlack(tx, organizationId);
          const credential = await issueOperator(tx, {
            organizationId,
            userId: owner.userId,
          });
          expect(
            await run(tx, {
              name: "set_slack_route",
              context: operatorContext(credential),
              fields: commands.set_slack_route?.fields({} as Seeded) ?? {},
            }),
          ).toMatchObject({ version: 1 });
          await change(tx, {
            organizationId,
            userId: owner.userId,
            credentialId: credential.id,
            apiKeyId: credential.apiKeyId,
          });
          const before = await slackState(tx, organizationId);
          const error = await refusal(
            run(tx, {
              name: "set_slack_route",
              context: operatorContext(credential),
              fields: {
                ...commands.set_slack_route?.fields({} as Seeded),
                channelId: "C0CHANGED",
              },
              expectedVersion: 1,
            }),
          );
          expect(error).toBeInstanceOf(DomainError);
          expect((error as DomainError).code).toBe("forbidden");
          expect(await slackState(tx, organizationId)).toEqual(before);
          expect(
            (await auditRows(tx, organizationId)).map((row) => row.action),
          ).toEqual(["slack.route_changed"]);
        });
      },
    );
  });

  /*
    The receipt decision (`manifest-f2.md` §2.4, F.2.5): each command's one
    receipt is the bus's. The repository keeps none of its own for these three
    writes, so no secret is wired into it, and the bus's is never handed to it.
  */
  describe("receipts", () => {
    test("the three commands leave three receipts in all, the bus's, keyed with the bus's secret", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const seeded = await seedSlack(tx, organizationId);
        const context = humanContext({ ...owner, organizationId });
        const expected = [];
        for (const name of commandNames) {
          const idempotencyKey = key();
          const result = await run(tx, {
            name,
            context,
            fields: commands[name]?.fields(seeded) ?? {},
            idempotencyKey,
          });
          expected.push({
            commandName: name,
            idempotencyFingerprint: keyedFingerprint(busSecret, idempotencyKey),
            resultJson: result,
          });
        }
        const receipts = await receiptsOf(tx, owner.userId);
        expect(receipts).toHaveLength(3);
        expect(receipts).toEqual(expect.arrayContaining(expected));
      });
    });

    test("a receipt under the form's secret does not answer the bus: a retry of a new mapping, a scope's first route or a status change meets the version check", async () => {
      await inRollbackTransaction(async (tx) => {
        for (const name of commandNames) {
          const organizationId = await seedOrganization(tx);
          const owner = await seedUser(tx);
          await seedMembership(tx, organizationId, owner.userId, "owner");
          const seeded = await seedSlack(tx, organizationId);
          const context = humanContext({ ...owner, organizationId });
          const fields = commands[name]?.fields(seeded) ?? {};
          const idempotencyKey = key();
          // The form's first submission. The write runs through the bus, and
          // its own receipt is swapped for one under the same command name,
          // keyed with the form's secret, as the repository keyed its
          // receipts before the port. For these three inputs the rows this
          // leaves are the ones the repository left before the port, with or
          // without the route-version fix: a new mapping at 1,
          // a scope's first route at 1, an installation's status at 2. A
          // route that replaced another is not among them; the next case
          // seeds that shape by hand.
          const written = await run(tx, { name, context, fields });
          await tx
            .delete(commandReceipts)
            .where(
              eq(
                commandReceipts.actorFingerprint,
                actorFingerprint({ type: "user", id: owner.userId }),
              ),
            );
          await tx.insert(commandReceipts).values({
            actorFingerprint: actorFingerprint({
              type: "user",
              id: owner.userId,
            }),
            commandName: name,
            idempotencyFingerprint: keyedFingerprint(
              formSecret,
              idempotencyKey,
            ),
            normalizedInputHash: normalizedInputHash(fields),
            resultJson: { id: written.id, version: written.version },
            expiresAt: new Date(Date.now() + 60_000),
          });
          const before = await slackState(tx, organizationId);

          const error = await refusal(
            run(tx, { name, context, fields, idempotencyKey }),
          );
          expect((error as DomainError).code, name).toBe("version_conflict");
          expect(await slackState(tx, organizationId), name).toEqual(before);
        }
      });
    });
    /*
      The one retry across the deploy that is not refused. Before the
      repository fix that ships first on `track/x12` (`b3e01ca`, a replaced
      route's successor carries the next version), a route change that
      replaced an existing route disabled it at version 2 and inserted its
      successor at the default 1, so the active row stayed at 1. A form
      submitted to that repository, and retried after the port half's deploy
      with the same key and the same expected version 1, finds its receipt
      gone and the active row still at 1, so it runs again: it replaces the
      route with an identical one at 2, and records it once more. The rows
      are seeded here as that repository wrote them, not through the bus. A
      route change made after the fix leaves its successor at 2, and its
      retry is refused (the next case), so the duplicate needs the first
      submission before the fix's deploy and the retry after the port half's.
    */
    test("a route change that replaced a route before the deploy, retried after it, runs again and writes an identical successor", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const context = humanContext({ ...owner, organizationId });
        const fields = {
          projectId: null,
          mode: "channel",
          channelId: "C0RETRY01",
          fallback: "none",
        };
        const idempotencyKey = key();
        // The replacement as the repository before the fix wrote it: the
        // route it replaced, disabled at 2, and the successor it inserted at
        // the column's default version, 1.
        await tx.insert(slackRoutes).values({
          organizationId,
          projectId: null,
          mode: "channel",
          channelId: "C0BEFORE1",
          fallback: "none",
          status: "disabled",
          version: 2,
        });
        const [successor] = await tx
          .insert(slackRoutes)
          .values({ organizationId, ...fields })
          .returning({ id: slackRoutes.id, version: slackRoutes.version });
        if (!successor) throw new Error("no successor");
        expect(successor.version).toBe(1);
        // And its receipt, under the form's secret.
        await tx.insert(commandReceipts).values({
          actorFingerprint: actorFingerprint({
            type: "user",
            id: owner.userId,
          }),
          commandName: "set_slack_route",
          idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
          normalizedInputHash: normalizedInputHash(fields),
          resultJson: { id: successor.id, version: successor.version },
          expiresAt: new Date(Date.now() + 60_000),
        });

        const retried = await run(tx, {
          name: "set_slack_route",
          context,
          fields,
          expectedVersion: 1,
          idempotencyKey,
        });

        expect(retried.version).toBe(2);
        expect(retried.id).not.toBe(successor.id);
        const routes = await tx
          .select({
            channelId: slackRoutes.channelId,
            status: slackRoutes.status,
            version: slackRoutes.version,
          })
          .from(slackRoutes)
          .where(eq(slackRoutes.organizationId, organizationId));
        expect(routes).toEqual(
          expect.arrayContaining([
            { channelId: "C0BEFORE1", status: "disabled", version: 2 },
            { channelId: "C0RETRY01", status: "disabled", version: 2 },
            { channelId: "C0RETRY01", status: "active", version: 2 },
          ]),
        );
        expect(routes).toHaveLength(3);
        expect(await auditRows(tx, organizationId)).toEqual([
          {
            actorType: "user",
            actorId: owner.userId,
            action: "slack.route_changed",
          },
        ]);
        const events = await slackEvents(tx, organizationId);
        expect(events.map((event) => event.data.changeType).sort()).toEqual([
          "route_changed",
          "route_disabled",
        ]);
      });
    });

    // The same retry, of a route change made once the successor carries the
    // next version: the replacement leaves the active route at 2, so the
    // retry's expected version 1 meets the version check and writes nothing.
    test("a route change that replaced a route after the version fix, retried after the deploy, is refused", async () => {
      await inRollbackTransaction(async (tx) => {
        const organizationId = await seedOrganization(tx);
        const owner = await seedUser(tx);
        await seedMembership(tx, organizationId, owner.userId, "owner");
        const context = humanContext({ ...owner, organizationId });
        const fields = {
          projectId: null,
          mode: "channel",
          channelId: "C0RETRY01",
          fallback: "none",
        };
        const idempotencyKey = key();
        await run(tx, {
          name: "set_slack_route",
          context,
          fields: { ...fields, channelId: "C0BEFORE1" },
          expectedVersion: 0,
        });
        // The form's replacement, then its receipt swapped for one under the
        // form's secret, as the repository keyed its receipts before the port.
        const replaced = await run(tx, {
          name: "set_slack_route",
          context,
          fields,
          expectedVersion: 1,
        });
        expect(replaced.version).toBe(2);
        await tx
          .delete(commandReceipts)
          .where(
            eq(
              commandReceipts.actorFingerprint,
              actorFingerprint({ type: "user", id: owner.userId }),
            ),
          );
        await tx.insert(commandReceipts).values({
          actorFingerprint: actorFingerprint({
            type: "user",
            id: owner.userId,
          }),
          commandName: "set_slack_route",
          idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
          normalizedInputHash: normalizedInputHash(fields),
          resultJson: { id: replaced.id, version: replaced.version },
          expiresAt: new Date(Date.now() + 60_000),
        });
        const before = await slackState(tx, organizationId);

        const error = await refusal(
          run(tx, {
            name: "set_slack_route",
            context,
            fields,
            expectedVersion: 1,
            idempotencyKey,
          }),
        );

        expect((error as DomainError).code).toBe("version_conflict");
        expect(await slackState(tx, organizationId)).toEqual(before);
      });
    });
  });
});

describe("a route edit as the form sends it", () => {
  /**
   * The version the route form sends for a scope: that of the scope's active
   * route in the list the page renders, or 0 when it has none
   * (`SlackRouteForm` in `apps/web/src/components/slack-management.tsx`,
   * whose own test pins the component). The list holds the disabled rows each
   * change leaves behind, in no stated order.
   */
  function formVersion(
    routes: ReadonlyArray<{
      projectId: string | null;
      status: string;
      version: number;
    }>,
  ) {
    return (
      routes.find((route) => route.status === "active" && !route.projectId)
        ?.version ?? 0
    );
  }

  async function listed(tx: Tx, organizationId: string, userId: string) {
    // The page's read binds its own transaction; ended with it here.
    const configuration = await endingEachMethodBinding(
      createSlackRepository(tx),
      tx,
    ).list(organizationId, userId);
    if (!configuration) throw new Error("the list was refused");
    return configuration.routes;
  }

  /** "applied", or the refusal's code: never thrown, so it can be compared. */
  async function outcome(promise: Promise<unknown>) {
    try {
      await promise;
      return "applied";
    } catch (error) {
      if (error instanceof DomainError) return error.code;
      throw error;
    }
  }

  /** The route form's write, through the bus as the form now sends it. */
  function setOrganizationRoute(
    tx: Tx,
    input: {
      organizationId: string;
      user: { userId: string; sessionId: string };
      channelId: string;
      expectedVersion: number;
    },
  ) {
    return run(tx, {
      name: "set_slack_route",
      context: humanContext({
        ...input.user,
        organizationId: input.organizationId,
      }),
      fields: {
        projectId: null,
        mode: "channel",
        channelId: input.channelId,
        fallback: "none",
      },
      expectedVersion: input.expectedVersion,
    });
  }

  async function routeState(tx: Tx, organizationId: string) {
    const active = await tx
      .select({ channelId: slackRoutes.channelId })
      .from(slackRoutes)
      .where(
        and(
          eq(slackRoutes.organizationId, organizationId),
          eq(slackRoutes.status, "active"),
        ),
      );
    const [rows] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(slackRoutes)
      .where(eq(slackRoutes.organizationId, organizationId));
    return { active, rows: rows?.count };
  }

  // Before the successor carried the next version, the admin's write passed
  // the version check and replaced the owner's route without a word: the
  // active route became the admin's channel, over a third row.
  test("a stale edit is refused, and the other editor's route stays", async () => {
    let observed: unknown;
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      const admin = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      await seedMembership(tx, organizationId, admin.userId, "admin");
      await setOrganizationRoute(tx, {
        organizationId,
        user: owner,
        channelId: "C0EXIST01",
        expectedVersion: 0,
      });

      // Both open the page, and each form takes its version from the list.
      const ownerVersion = formVersion(
        await listed(tx, organizationId, owner.userId),
      );
      const adminVersion = formVersion(
        await listed(tx, organizationId, admin.userId),
      );
      const ownerSave = await outcome(
        setOrganizationRoute(tx, {
          organizationId,
          user: owner,
          channelId: "C0OWNER01",
          expectedVersion: ownerVersion,
        }),
      );
      const adminSave = await outcome(
        setOrganizationRoute(tx, {
          organizationId,
          user: admin,
          channelId: "C0ADMIN01",
          expectedVersion: adminVersion,
        }),
      );
      observed = {
        ownerSave,
        adminSave,
        ...(await routeState(tx, organizationId)),
      };
    });

    expect(observed).toEqual({
      ownerSave: "applied",
      adminSave: "version_conflict",
      active: [{ channelId: "C0OWNER01" }],
      rows: 2,
    });
  });

  // The pair: after several changes the list holds disabled rows, one of
  // them at a version below the active route's. The active route's version is
  // accepted; a disabled row's, which the form could send while it took the
  // first row of the scope in whatever order the list came, is refused.
  test("after several changes, the active route's version is accepted and a disabled row's refused", async () => {
    let observed: unknown;
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      for (const channelId of ["C0AAAAA01", "C0BBBBB02", "C0CCCCC03"]) {
        await setOrganizationRoute(tx, {
          organizationId,
          user: owner,
          channelId,
          expectedVersion: formVersion(
            await listed(tx, organizationId, owner.userId),
          ),
        });
      }

      const routes = await listed(tx, organizationId, owner.userId);
      const disabled = routes
        .filter((route) => route.status === "disabled")
        .map((route) => route.version)
        .sort((left, right) => left - right);
      const staleSave = await outcome(
        setOrganizationRoute(tx, {
          organizationId,
          user: owner,
          channelId: "C0STALE01",
          expectedVersion: disabled[0] ?? -1,
        }),
      );
      const formSave = await outcome(
        setOrganizationRoute(tx, {
          organizationId,
          user: owner,
          channelId: "C0DDDDD04",
          expectedVersion: formVersion(routes),
        }),
      );
      observed = {
        disabled,
        active: formVersion(routes),
        staleSave,
        formSave,
        after: formVersion(await listed(tx, organizationId, owner.userId)),
      };
    });

    expect(observed).toEqual({
      disabled: [2, 3],
      active: 3,
      staleSave: "version_conflict",
      formSave: "applied",
      after: 4,
    });
  });
});
