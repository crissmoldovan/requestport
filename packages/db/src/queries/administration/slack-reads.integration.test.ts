import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  createCoreCommandRegistry,
  DomainError,
  type JsonObject,
  operatorActor,
  type UnitOfWork,
} from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../../client.js";
import { createStorage, storageOptionsFromEnv } from "../../client.js";
import { createCommandAuthorizationRepository } from "../../repositories/command-authorization.js";
import { createCommandTransactionManager } from "../../repositories/command-repository.js";
import { createOperatorCredentialRepository } from "../../repositories/operator-credential-repository.js";
import { createSlackAdministrationCommandRepository } from "../../repositories/slack-repository.js";
import { projects, slackInstallations } from "../../schema/index.js";
import { tenantWrappingEnabled } from "../../tenant-context.js";
import {
  endingEachCommandBinding,
  endingEachMethodBinding,
} from "../../test-support/tenant-binding.js";
import type { Tx } from "../../transaction.js";
import {
  getAdministrationSlackConfiguration,
  readSlackConfigurationForOperator,
} from "./slack-reads.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  `get_administration_slack_configuration` against a real database (Plan 13,
  F.2.5; `manifest-f2.md` §4.1). The first describe runs the projection
  alone, handed a member. The second runs `readSlackConfigurationForOperator`,
  which is what the REST dispatch
  (`packages/core/src/administration-reads.ts`) calls inside its one
  transaction: the bus's `assertCurrent` on the operator's context — so
  `lockActiveOperatorAuthorization` — then the projection, for the member
  `memberAuthority` names, bound as the credential is.

  Each case runs inside a transaction that is rolled back at the end.
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

async function seedUser(tx: Tx, name = "Slack reader") {
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
  const sessionId = `session_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "session" ("id", "expires_at", "token", "updated_at", "user_id")
    values (${sessionId}, now() + interval '1 hour',
      ${`token_${crypto.randomUUID()}`}, now(), ${userId})
  `);
  return { userId, sessionId, email };
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Slack read tenant',
      ${`slack-read-${organizationId}`}, 'active')
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

const botToken = "xoxb-slack-read-never-returned";
const workspaceName = "Slack Read Workspace Name";
const mappedName = "Mapped Person Name";

/**
 * An organisation's Slack configuration: an installation, a mapped member,
 * an organisation route replaced once (so one disabled and one active row),
 * and a project route.
 */
async function seedConfiguration(tx: Tx, organizationId: string) {
  const mapped = await seedUser(tx, mappedName);
  await seedMembership(tx, organizationId, mapped.userId, "member");
  const [installation] = await tx
    .insert(slackInstallations)
    .values({
      organizationId,
      workspaceId: `T${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      workspaceName,
      botTokenCiphertext: { sealed: botToken },
      botUserId: "U0BOTREAD",
      scopes: ["chat:write"],
      installedByUserId: mapped.userId,
    })
    .returning({ id: slackInstallations.id });
  if (!installation) throw new Error("no installation");
  const [project] = await tx
    .insert(projects)
    .values({
      organizationId,
      name: "Slack read project",
      slug: `slack-read-${crypto.randomUUID().slice(0, 8)}`,
      keyPrefix: "SLRD",
      status: "active",
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  const mapping = crypto.randomUUID();
  await tx.execute(sql`
    insert into "slack_user_mappings"
      ("id", "organization_id", "installation_id", "slack_user_id", "user_id",
       "status", "version", "verified_at")
    values (${mapping}, ${organizationId}, ${installation.id}, 'U0MAPPED1',
      ${mapped.userId}, 'active', 2, now())
  `);
  const disabledRoute = crypto.randomUUID();
  const organizationRoute = crypto.randomUUID();
  const projectRoute = crypto.randomUUID();
  await tx.execute(sql`
    insert into "slack_routes"
      ("id", "organization_id", "project_id", "mode", "channel_id",
       "fallback", "status", "version")
    values
      (${disabledRoute}, ${organizationId}, null, 'channel', 'C0OLDROUT',
       'none', 'disabled', 2),
      (${organizationRoute}, ${organizationId}, null, 'both', 'C0ORGROUT',
       'email', 'active', 2),
      (${projectRoute}, ${organizationId}, ${project.id}, 'dm', null,
       'organization_channel', 'active', 1)
  `);
  return {
    installationId: installation.id,
    mappingId: mapping,
    mappedUserId: mapped.userId,
    mappedEmail: mapped.email,
    projectId: project.id,
    disabledRouteId: disabledRoute,
    organizationRouteId: organizationRoute,
    projectRouteId: projectRoute,
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

/** The transaction still answers: nothing the read did raised in PostgreSQL. */
async function stillUsable(tx: Tx) {
  const result = await tx.execute(sql`select 1 as "one"`);
  expect(result.rows).toEqual([{ one: 1 }]);
}

afterAll(async () => {
  await suiteStorage.close();
});

describe("get_administration_slack_configuration, at the repository", () => {
  test("answers an owner with exactly the identifiers, versions, states and route fields", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const seeded = await seedConfiguration(tx, organizationId);

      const read = await getAdministrationSlackConfiguration(tx, {
        memberUserId: owner.userId,
        organizationId,
        credentialProjectId: null,
      });

      expect(Object.keys(read)).toEqual([
        "installations",
        "mappings",
        "routes",
      ]);
      expect(read.installations).toEqual([
        { id: seeded.installationId, status: "active", version: 1 },
      ]);
      expect(read.mappings).toEqual([
        {
          id: seeded.mappingId,
          installationId: seeded.installationId,
          userId: seeded.mappedUserId,
          slackUserId: "U0MAPPED1",
          status: "active",
          version: 2,
        },
      ]);
      expect(read.routes).toEqual(
        [
          {
            id: seeded.disabledRouteId,
            projectId: null,
            status: "disabled",
            version: 2,
            mode: "channel",
            channelId: "C0OLDROUT",
            fallback: "none",
          },
          {
            id: seeded.organizationRouteId,
            projectId: null,
            status: "active",
            version: 2,
            mode: "both",
            channelId: "C0ORGROUT",
            fallback: "email",
          },
          {
            id: seeded.projectRouteId,
            projectId: seeded.projectId,
            status: "active",
            version: 1,
            mode: "dm",
            channelId: null,
            fallback: "organization_channel",
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      const text = JSON.stringify(read);
      for (const secretOrName of [
        botToken,
        workspaceName,
        "U0BOTREAD",
        "chat:write",
        mappedName,
        seeded.mappedEmail,
        "Slack read project",
      ])
        expect(text).not.toContain(secretOrName);
    });
  });

  test("answers an admin", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const admin = await seedUser(tx);
      await seedMembership(tx, organizationId, admin.userId, "admin");
      const seeded = await seedConfiguration(tx, organizationId);
      const read = await getAdministrationSlackConfiguration(tx, {
        memberUserId: admin.userId,
        organizationId,
        credentialProjectId: null,
      });
      expect(read.installations.map((row) => row.id)).toEqual([
        seeded.installationId,
      ]);
    });
  });

  test("refuses a member, a project maintainer, a revoked owner and a suspended organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const seeded = await seedConfiguration(tx, organizationId);
      const member = await seedUser(tx);
      await seedMembership(tx, organizationId, member.userId, "member");
      const maintainer = await seedUser(tx);
      await seedMembership(tx, organizationId, maintainer.userId, "member");
      await tx.execute(sql`
        insert into "project_members"
          ("organization_id", "project_id", "user_id", "role", "status")
        values (${organizationId}, ${seeded.projectId}, ${maintainer.userId},
          'maintainer', 'active')
      `);
      const revoked = await seedUser(tx);
      await seedMembership(
        tx,
        organizationId,
        revoked.userId,
        "owner",
        "revoked",
      );
      for (const reader of [member, maintainer, revoked]) {
        const error = await refusal(
          getAdministrationSlackConfiguration(tx, {
            memberUserId: reader.userId,
            organizationId,
            credentialProjectId: null,
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
        getAdministrationSlackConfiguration(tx, {
          memberUserId: owner.userId,
          organizationId,
          credentialProjectId: null,
        }),
      );
      expect((suspended as DomainError).code).toBe("forbidden");
      await stillUsable(tx);
    });
  });

  test("refuses a credential bound to a project, even an owner's", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const seeded = await seedConfiguration(tx, organizationId);
      const error = await refusal(
        getAdministrationSlackConfiguration(tx, {
          memberUserId: owner.userId,
          organizationId,
          credentialProjectId: seeded.projectId,
        }),
      );
      expect((error as DomainError).code).toBe("forbidden");
    });
  });

  test("an owner of two organisations reads only the one the credential names", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedOrganization(tx);
      const other = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, home, owner.userId, "owner");
      await seedMembership(tx, other, owner.userId, "owner");
      const own = await seedConfiguration(tx, home);
      const foreign = await seedConfiguration(tx, other);

      const read = await getAdministrationSlackConfiguration(tx, {
        memberUserId: owner.userId,
        organizationId: home,
        credentialProjectId: null,
      });

      expect(read.installations.map((row) => row.id)).toEqual([
        own.installationId,
      ]);
      const text = JSON.stringify(read);
      for (const id of [
        foreign.installationId,
        foreign.mappingId,
        foreign.mappedUserId,
        foreign.projectId,
        foreign.disabledRouteId,
        foreign.organizationRouteId,
        foreign.projectRouteId,
      ])
        expect(text).not.toContain(id);
    });
  });

  test("an operator's actor id given as the member is refused, and raises nothing in PostgreSQL", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      await seedConfiguration(tx, organizationId);
      const error = await refusal(
        getAdministrationSlackConfiguration(tx, {
          memberUserId: "operator:lineage",
          organizationId,
          credentialProjectId: null,
        }),
      );
      expect((error as DomainError).code).toBe("forbidden");
      await stillUsable(tx);
    });
  });

  test("a mapping and the active route, read and written back with their versions, succeed", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const seeded = await seedConfiguration(tx, organizationId);
      const read = await getAdministrationSlackConfiguration(tx, {
        memberUserId: owner.userId,
        organizationId,
        credentialProjectId: null,
      });
      const mapping = read.mappings[0];
      const route = read.routes.find(
        (row) => row.projectId === null && row.status === "active",
      );
      if (!mapping || !route) throw new Error("nothing to write back");

      const bus = new AtomicCommandBus({
        registry: createCoreCommandRegistry(),
        transactions: createCommandTransactionManager(
          tx as unknown as Database,
          (name, database) =>
            name === "slackAdministrationCommands"
              ? createSlackAdministrationCommandRepository(database)
              : name === "commandAuthorization"
                ? createCommandAuthorizationRepository(database)
                : undefined,
        ),
        fingerprintSecret: "slack-read-bus-fingerprint-secret-00000000000",
        authorizeContext: (
          context: AuthorizedCommandContext,
          uow: UnitOfWork,
        ) =>
          uow
            .port<ReturnType<typeof createCommandAuthorizationRepository>>(
              "commandAuthorization",
            )
            .assertCurrent(context),
      });
      const context: AuthorizedCommandContext = {
        actor: { type: "user", id: owner.userId },
        organizationId,
        scopes: new Set(["slack:manage"]),
        credentialId: owner.sessionId,
        correlationId: crypto.randomUUID(),
      };
      const mapped = await bus.execute<unknown, JsonObject>({
        name: "set_slack_user_mapping",
        context,
        input: {
          organizationId,
          installationId: mapping.installationId,
          userId: mapping.userId,
          slackUserId: "U0REMAPPD",
        },
        meta: {
          idempotencyKey: `slack-read-${crypto.randomUUID()}`,
          expectedVersion: mapping.version,
        },
      });
      expect(mapped).toEqual({ id: seeded.mappingId, version: 3 });
      const routed = await bus.execute<unknown, JsonObject>({
        name: "set_slack_route",
        context,
        input: {
          organizationId,
          projectId: route.projectId,
          mode: route.mode,
          channelId: route.channelId,
          fallback: route.fallback,
        },
        meta: {
          idempotencyKey: `slack-read-${crypto.randomUUID()}`,
          expectedVersion: route.version,
        },
      });
      expect(routed).toMatchObject({ version: route.version + 1 });
    });
  });
});

/** A live operator credential holding `slack:manage`, as F.3 issues one. */
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
    name: "Slack reader",
    prefix: "rpo_f25",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["slack:manage"],
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
  ...switchValue: ["enabled" | "disabled" | undefined] | []
) {
  return readSlackConfigurationForOperator(tx, {
    context,
    operatorCredentials: switchValue.length === 0 ? "enabled" : switchValue[0],
  });
}

type Changed = {
  organizationId: string;
  userId: string;
  credentialId: string;
  apiKeyId: string;
};

describe.sequential("readSlackConfigurationForOperator, as REST dispatches it", () => {
  test("answers an owner's operator with the projection its member would get", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      await seedConfiguration(tx, organizationId);
      const { context } = await issueOperator(tx, {
        organizationId,
        userId: owner.userId,
      });
      const read = await readAsOperator(tx, context);
      expect(read).toEqual(
        await getAdministrationSlackConfiguration(tx, {
          memberUserId: owner.userId,
          organizationId,
          credentialProjectId: null,
        }),
      );
      expect(read.installations).toHaveLength(1);
      expect(read.routes).toHaveLength(3);
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
        const seeded = await seedConfiguration(tx, organizationId);
        const { credential, context, apiKeyId } = await issueOperator(tx, {
          organizationId,
          userId: owner.userId,
        });
        expect(
          (await readAsOperator(tx, context)).installations.map(
            (row) => row.id,
          ),
        ).toEqual([seeded.installationId]);
        await change(tx, {
          organizationId,
          userId: owner.userId,
          credentialId: credential.id,
          apiKeyId,
        });
        const error = await refusal(readAsOperator(tx, context));
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
      await seedConfiguration(tx, organizationId);
      const { context } = await issueOperator(tx, {
        organizationId,
        userId: owner.userId,
      });
      expect(
        (await readAsOperator(tx, context, "enabled")).installations,
      ).toHaveLength(1);
      for (const setting of ["disabled", undefined] as const) {
        const error = await refusal(readAsOperator(tx, context, setting));
        expect((error as DomainError).code, String(setting)).toBe("forbidden");
      }
    });
  });

  test("refuses an operator bound to a project, even an owner's", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const seeded = await seedConfiguration(tx, organizationId);
      const { context } = await issueOperator(tx, {
        organizationId,
        userId: owner.userId,
        projectId: seeded.projectId,
      });
      const error = await refusal(readAsOperator(tx, context));
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("forbidden");
    });
  });

  test("an operator issued for one organisation reads none of another's rows, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedOrganization(tx);
      const other = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, home, owner.userId, "owner");
      await seedMembership(tx, other, owner.userId, "owner");
      const own = await seedConfiguration(tx, home);
      const foreign = await seedConfiguration(tx, other);
      const { context } = await issueOperator(tx, {
        organizationId: home,
        userId: owner.userId,
      });
      const read = await readAsOperator(tx, context);
      expect(read.installations.map((row) => row.id)).toEqual([
        own.installationId,
      ]);
      const text = JSON.stringify(read);
      for (const id of [
        foreign.installationId,
        foreign.mappingId,
        foreign.mappedUserId,
        foreign.projectId,
        foreign.disabledRouteId,
        foreign.organizationRouteId,
        foreign.projectRouteId,
      ])
        expect(text).not.toContain(id);
    });
  });

  test("a context that is not an operator's is refused before anything is read", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      await seedConfiguration(tx, organizationId);
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
        const error = await refusal(readAsOperator(tx, stranger));
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("forbidden");
      }
      await stillUsable(tx);
    });
  });

  test("a mapping and the active route, read and written back by the operator with their versions, succeed", async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const owner = await seedUser(tx);
      await seedMembership(tx, organizationId, owner.userId, "owner");
      const seeded = await seedConfiguration(tx, organizationId);
      const { context } = await issueOperator(tx, {
        organizationId,
        userId: owner.userId,
      });
      const read = await readAsOperator(tx, context);
      const mapping = read.mappings[0];
      const route = read.routes.find(
        (row) => row.projectId === null && row.status === "active",
      );
      if (!mapping || !route) throw new Error("nothing to write back");
      // Two commands on one transaction: each command's binding ends with
      // it, as its own transaction ends it in production.
      const bus = new AtomicCommandBus({
        registry: createCoreCommandRegistry(),
        transactions: endingEachCommandBinding(
          createCommandTransactionManager(
            tx as unknown as Database,
            (name, database) =>
              name === "slackAdministrationCommands"
                ? createSlackAdministrationCommandRepository(database)
                : name === "commandAuthorization"
                  ? createCommandAuthorizationRepository(database, {
                      operatorCredentials: "enabled",
                    })
                  : undefined,
          ),
          tx,
        ),
        fingerprintSecret: "slack-read-bus-fingerprint-secret-00000000000",
        authorizeContext: (
          authorized: AuthorizedCommandContext,
          uow: UnitOfWork,
        ) =>
          uow
            .port<ReturnType<typeof createCommandAuthorizationRepository>>(
              "commandAuthorization",
            )
            .assertCurrent(authorized),
      });
      expect(
        await bus.execute<unknown, JsonObject>({
          name: "set_slack_user_mapping",
          context,
          input: {
            organizationId,
            installationId: mapping.installationId,
            userId: mapping.userId,
            slackUserId: "U0REMAPPD",
          },
          meta: {
            idempotencyKey: `slack-read-${crypto.randomUUID()}`,
            expectedVersion: mapping.version,
          },
        }),
      ).toEqual({ id: seeded.mappingId, version: mapping.version + 1 });
      expect(
        await bus.execute<unknown, JsonObject>({
          name: "set_slack_route",
          context,
          input: {
            organizationId,
            projectId: route.projectId,
            mode: route.mode,
            channelId: route.channelId,
            fallback: route.fallback,
          },
          meta: {
            idempotencyKey: `slack-read-${crypto.randomUUID()}`,
            expectedVersion: route.version,
          },
        }),
      ).toMatchObject({ version: route.version + 1 });
    });
  });
});
