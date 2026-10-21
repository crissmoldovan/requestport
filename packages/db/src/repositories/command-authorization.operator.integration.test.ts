import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  createCoreCommandRegistry,
  operatorActor,
  revokeOperatorCredentialCommandName,
} from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import {
  endingEachCommandBinding,
  endingEachMethodBinding,
} from "../test-support/tenant-binding.js";
import type { Tx } from "../transaction.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";
import { createCommandTransactionManager } from "./command-repository.js";
import { createOperatorCredentialRepository } from "./operator-credential-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  Plan 13, F.3, Done when 1 at command time: a context authenticated before a
  change, run through the real bus and `assertCurrent` after it, gets 403. Each
  case runs the identical call first, inside a savepoint that is rolled back,
  and sees it succeed — a detector that cannot fire proves nothing — then makes
  the change and runs it again. Native PostgreSQL (R1); every case is rolled
  back.
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

type Switch = "enabled" | "disabled" | undefined;

/** `switchValue` defaults to `enabled`; pass `{}` for a deployment that leaves it unset. */
function bus(
  tx: Tx,
  switchValue: { operatorCredentials?: Switch } = {
    operatorCredentials: "enabled",
  },
) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    // A case here runs commands for several organisations on one
    // transaction; each command's binding ends with it, as its own
    // transaction ends it in production (test-support/tenant-binding.ts).
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(
        tx as unknown as Database,
        (name, database) => {
          if (name === "commandAuthorization") {
            return createCommandAuthorizationRepository(database, switchValue);
          }
          if (name === "operatorCredentials") {
            return createOperatorCredentialRepository(database);
          }
          return undefined;
        },
      ),
      tx,
    ),
    fingerprintSecret: "operator-authorization-test-fingerprint-0001",
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
    values (${userId}, 'Operator issuer', ${email}, now())
  `);
  return userId;
}

async function seedOrganization(tx: Tx, userId: string, role = "owner") {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Operator tenant',
      ${`operator-auth-${organizationId}`}, 'active')
  `);
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, 'active')
  `);
  return organizationId;
}

async function seedProject(tx: Tx, organizationId: string) {
  const projectId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "projects"
      ("id", "organization_id", "name", "slug", "key_prefix", "status")
    values (${projectId}, ${organizationId}, 'Operator project',
      ${`project-${projectId}`}, ${`OA${projectId.slice(0, 6)}`}, 'active')
  `);
  return projectId;
}

async function issue(
  tx: Tx,
  input: {
    organizationId: string;
    userId: string;
    projectId?: string | null;
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
    name: "Operator",
    prefix: "rpo_tst",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["operator:revoke"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
  return { ...credential, apiKeyId };
}

/** The context `authenticateApiBearer` builds for a credential. */
function contextFor(
  credential: Awaited<ReturnType<typeof issue>>,
  overrides: Partial<AuthorizedCommandContext> = {},
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
    ...overrides,
  };
}

/** A person's own organisation-wide credential and a target it may revoke. */
async function seedPair(tx: Tx, options: { role?: string } = {}) {
  const userId = await seedUser(tx);
  const organizationId = await seedOrganization(tx, userId, options.role);
  const self = await issue(tx, { organizationId, userId });
  const target = await issue(tx, { organizationId, userId });
  return { userId, organizationId, self, target };
}

function revoke(
  context: AuthorizedCommandContext,
  target: { organizationId: string; id: string },
  idempotencyKey = `idempotency-${crypto.randomUUID()}`,
) {
  return {
    name: revokeOperatorCredentialCommandName,
    input: { organizationId: target.organizationId, credentialId: target.id },
    context,
    meta: { idempotencyKey, expectedVersion: 1 },
  };
}

/** Runs `run` and undoes whatever it wrote, keeping only its answer. */
async function probe<T>(tx: Tx, run: () => Promise<T>) {
  await tx.execute(sql`savepoint operator_probe`);
  try {
    return await run();
  } finally {
    await tx.execute(sql`rollback to savepoint operator_probe`);
  }
}

async function expectPairedRefusal(
  tx: Tx,
  call: () => Promise<unknown>,
  change: () => Promise<unknown>,
) {
  await expect(probe(tx, call)).resolves.toMatchObject({ revoked: true });
  await change();
  await expect(call()).rejects.toMatchObject({ code: "forbidden" });
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("an operator context at command time (F3-12)", () => {
  test("a live credential revokes through the real bus, and is recorded as the service it is", async () => {
    await inRollbackTransaction(async (tx) => {
      const { self, target } = await seedPair(tx);
      await expect(
        bus(tx).execute(revoke(contextFor(self), target)),
      ).resolves.toEqual({ id: target.id, revoked: true, version: 2 });
      const audit = await tx.execute(sql`
        select "actor_type", "actor_id" from "security_audit_records"
        where "target_id" = ${target.id}
          and "action" = 'operator.credential_revoked'
      `);
      expect(audit.rows).toEqual([
        { actor_type: "service", actor_id: `operator:${self.lineageId}` },
      ]);
    });
  });

  const changes: Array<
    [
      string,
      (
        tx: Tx,
        seeded: Awaited<ReturnType<typeof seedPair>>,
      ) => Promise<unknown>,
    ]
  > = [
    [
      "the issuer's membership revoked",
      (tx, { organizationId, userId }) =>
        tx.execute(sql`
          update "organization_members" set "status" = 'revoked'
          where "organization_id" = ${organizationId} and "user_id" = ${userId}
        `),
    ],
    [
      "the organisation suspended",
      (tx, { organizationId }) =>
        tx.execute(sql`
          update "organizations" set "status" = 'suspended'
          where "id" = ${organizationId}
        `),
    ],
    [
      "the organisation archived",
      (tx, { organizationId }) =>
        tx.execute(sql`
          update "organizations" set "status" = 'archived'
          where "id" = ${organizationId}
        `),
    ],
    [
      "the owner demoted to member, for an organisation-wide credential",
      (tx, { organizationId, userId }) =>
        tx.execute(sql`
          update "organization_members" set "role" = 'member'
          where "organization_id" = ${organizationId} and "user_id" = ${userId}
        `),
    ],
    [
      "the credential's key deleted (its reference becomes null)",
      (tx, { self }) =>
        tx.execute(sql`delete from "apikey" where "id" = ${self.apiKeyId}`),
    ],
    [
      "the binding revoked",
      (tx, { self }) =>
        tx.execute(sql`
          update "operator_credentials" set "revoked_at" = now()
          where "id" = ${self.id}
        `),
    ],
    [
      "the binding expired",
      (tx, { self }) =>
        tx.execute(sql`
          update "operator_credentials"
          set "created_at" = now() - interval '2 days',
              "expires_at" = now() - interval '1 second'
          where "id" = ${self.id}
        `),
    ],
    [
      "the plugin key expired",
      (tx, { self }) =>
        tx.execute(sql`
          update "apikey" set "expires_at" = now() - interval '1 second'
          where "id" = ${self.apiKeyId}
        `),
    ],
    [
      "the plugin key's expiry cleared",
      (tx, { self }) =>
        tx.execute(sql`
          update "apikey" set "expires_at" = null where "id" = ${self.apiKeyId}
        `),
    ],
    [
      // A binding row naming an agent-configuration key: the plugin would
      // verify it as an agent key, so it must not stand as an operator's.
      "the credential's key moved to the agent configuration",
      (tx, { self }) =>
        tx.execute(sql`
          update "apikey" set "config_id" = 'requestport-agent'
          where "id" = ${self.apiKeyId}
        `),
    ],
    [
      "the binding revoked and its plugin key re-enabled with a later expiry",
      async (tx, { self }) => {
        await tx.execute(sql`
          update "operator_credentials" set "revoked_at" = now()
          where "id" = ${self.id}
        `);
        await tx.execute(sql`
          update "apikey"
          set "enabled" = true, "expires_at" = now() + interval '300 days'
          where "id" = ${self.apiKeyId}
        `);
      },
    ],
  ];

  test.each(changes)("refuses after %s", async (_label, change) => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seedPair(tx);
      const call = () =>
        bus(tx).execute(revoke(contextFor(seeded.self), seeded.target));
      await expectPairedRefusal(tx, call, () => change(tx, seeded));
    });
  });

  test("refuses a project-bound credential once its maintainer is removed, once demoted, and once its project is archived", async () => {
    for (const change of ["maintainer", "demoted", "project"] as const) {
      await inRollbackTransaction(async (tx) => {
        const userId = await seedUser(tx);
        const organizationId = await seedOrganization(tx, userId, "member");
        const projectId = await seedProject(tx, organizationId);
        await tx.execute(sql`
          insert into "project_members"
            ("organization_id", "project_id", "user_id", "role", "status")
          values (${organizationId}, ${projectId}, ${userId}, 'maintainer',
            'active')
        `);
        const self = await issue(tx, { organizationId, userId, projectId });
        const target = await issue(tx, { organizationId, userId, projectId });
        const call = () => bus(tx).execute(revoke(contextFor(self), target));
        await expectPairedRefusal(tx, call, () => {
          if (change === "maintainer") {
            return tx.execute(sql`
              update "project_members" set "status" = 'revoked'
              where "project_id" = ${projectId} and "user_id" = ${userId}
            `);
          }
          // Still an active member of the project, no longer one who may
          // manage it: only the lock's maintainer-role condition refuses.
          if (change === "demoted") {
            return tx.execute(sql`
              update "project_members" set "role" = 'contributor'
              where "project_id" = ${projectId} and "user_id" = ${userId}
            `);
          }
          return tx.execute(sql`
            update "projects" set "status" = 'archived'
            where "id" = ${projectId}
          `);
        });
      });
    }
  });

  test("refuses a context authenticated before its plugin key was disabled", async () => {
    await inRollbackTransaction(async (tx) => {
      const { self, target } = await seedPair(tx);
      const call = () => bus(tx).execute(revoke(contextFor(self), target));
      // What a member can do to their own key through
      // /api/auth/api-key/update with `enabled: false`. The binding is
      // untouched, so only the lock's plugin-enabled condition refuses.
      await expectPairedRefusal(tx, call, () =>
        tx.execute(sql`
          update "apikey" set "enabled" = false where "id" = ${self.apiKeyId}
        `),
      );
    });
  });

  test("refuses a context naming another organisation, or another project, than its binding", async () => {
    await inRollbackTransaction(async (tx) => {
      const { userId, self, target } = await seedPair(tx);
      // The same person owns a second organisation, B.
      const otherOrganization = await seedOrganization(tx, userId);
      const otherTarget = await issue(tx, {
        organizationId: otherOrganization,
        userId,
      });
      await expect(
        probe(tx, () => bus(tx).execute(revoke(contextFor(self), target))),
      ).resolves.toMatchObject({ revoked: true });
      await expect(
        bus(tx).execute(
          revoke(
            contextFor(self, { organizationId: otherOrganization }),
            otherTarget,
          ),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });

      const projectQ = await seedProject(tx, self.organizationId);
      await expect(
        bus(tx).execute(
          revoke(contextFor(self, { projectId: projectQ }), target),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      /*
        The two cases above the command would refuse on its own, so these are
        ones only assertCurrent can refuse: the command lets a credential
        revoke itself, and lets a credential claiming project Q revoke one
        bound to Q. Each is paired with the same call, naming the binding's own
        project, succeeding first.
      */
      await expect(
        probe(tx, () => bus(tx).execute(revoke(contextFor(self), self))),
      ).resolves.toMatchObject({ revoked: true });
      await expect(
        bus(tx).execute(
          revoke(contextFor(self, { projectId: projectQ }), self),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      const projectP = await seedProject(tx, self.organizationId);
      const boundToP = await issue(tx, {
        organizationId: self.organizationId,
        userId,
        projectId: projectP,
      });
      const boundToQ = await issue(tx, {
        organizationId: self.organizationId,
        userId,
        projectId: projectQ,
      });
      const alsoBoundToP = await issue(tx, {
        organizationId: self.organizationId,
        userId,
        projectId: projectP,
      });
      await expect(
        probe(tx, () =>
          bus(tx).execute(revoke(contextFor(boundToP), alsoBoundToP)),
        ),
      ).resolves.toMatchObject({ revoked: true });
      await expect(
        bus(tx).execute(
          revoke(contextFor(boundToP, { projectId: projectQ }), boundToQ),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      // B's credential is unchanged.
      const row = await tx.execute(sql`
        select "revoked_at" is null as "live" from "operator_credentials"
        where "id" = ${otherTarget.id}
      `);
      expect(row.rows).toEqual([{ live: true }]);
    });
  });

  /*
    Done when 1, "wrong organisation" (a) and (c), and "project-bound
    credential used on another project", as REST presents them: the route
    injects the credential's own organisation into the input, so a caller
    naming B's credential reaches the command as (A, B's id). The lookup is
    confined to A and answers 404, never another tenant's row; a P-bound
    credential aimed at a Q-bound one in its own organisation is refused by
    the command. Each is paired with the same credential revoking a target it
    may, and the untouched credential still authenticates afterwards.
  */
  test("aimed at another organisation's credential, or another project's, finds nothing or is refused, and the target still authenticates", async () => {
    await inRollbackTransaction(async (tx) => {
      const { userId, self, target } = await seedPair(tx);
      // The same person is an owner of B, with a live credential there.
      const organizationB = await seedOrganization(tx, userId);
      const credentialB = await issue(tx, {
        organizationId: organizationB,
        userId,
      });
      await expect(
        probe(tx, () => bus(tx).execute(revoke(contextFor(self), target))),
      ).resolves.toMatchObject({ revoked: true });
      await expect(
        bus(tx).execute(
          revoke(contextFor(self), {
            organizationId: self.organizationId,
            id: credentialB.id,
          }),
        ),
      ).rejects.toMatchObject({ code: "not_found" });

      const projectP = await seedProject(tx, self.organizationId);
      const projectQ = await seedProject(tx, self.organizationId);
      const boundToP = await issue(tx, {
        organizationId: self.organizationId,
        userId,
        projectId: projectP,
      });
      const alsoBoundToP = await issue(tx, {
        organizationId: self.organizationId,
        userId,
        projectId: projectP,
      });
      const boundToQ = await issue(tx, {
        organizationId: self.organizationId,
        userId,
        projectId: projectQ,
      });
      await expect(
        probe(tx, () =>
          bus(tx).execute(revoke(contextFor(boundToP), alsoBoundToP)),
        ),
      ).resolves.toMatchObject({ revoked: true });
      await expect(
        bus(tx).execute(revoke(contextFor(boundToP), boundToQ)),
      ).rejects.toMatchObject({ code: "forbidden" });

      const repository = createOperatorCredentialRepository(tx);
      for (const untouched of [credentialB, boundToQ]) {
        await expect(
          repository.resolveApiKeyCredential({ apiKeyId: untouched.apiKeyId }),
        ).resolves.toMatchObject({ credentialId: untouched.id });
      }
    });
  });

  test("refuses a context carrying a scope the binding does not, and one carrying lanes", async () => {
    await inRollbackTransaction(async (tx) => {
      const { self, target } = await seedPair(tx);
      await expect(
        probe(tx, () => bus(tx).execute(revoke(contextFor(self), target))),
      ).resolves.toMatchObject({ revoked: true });
      await expect(
        bus(tx).execute(
          revoke(
            contextFor(self, {
              scopes: new Set(["operator:revoke", "request:read"]),
            }),
            target,
          ),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        bus(tx).execute(
          revoke(
            contextFor(self, { laneIds: new Set([crypto.randomUUID()]) }),
            target,
          ),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  test("refuses a malformed claim, never as a failed query", async () => {
    await inRollbackTransaction(async (tx) => {
      const { self, target } = await seedPair(tx);
      const other = await issue(tx, {
        organizationId: self.organizationId,
        userId: self.memberUserId,
      });
      const malformed: Array<Partial<AuthorizedCommandContext>> = [
        { credentialKind: undefined },
        { actor: { type: "service", id: `operator:${self.lineageId}` } },
        {
          actor: {
            type: "service",
            id: "operator:not-a-uuid",
            originatingActor: { type: "user", id: self.memberUserId },
          },
        },
        { credentialId: "not-a-uuid" },
        { actor: { type: "user", id: self.memberUserId } },
        {
          actor: operatorActor({
            lineageId: self.lineageId,
            memberUserId: `user_${crypto.randomUUID()}`,
          }),
        },
        // Its own id with another credential's lineage, in the same
        // organisation and for the same member: the command would admit it
        // (it holds operator:revoke) and record the other lineage as the
        // actor, so only assertCurrent's lineage check refuses it.
        {
          actor: operatorActor({
            lineageId: other.lineageId,
            memberUserId: self.memberUserId,
          }),
        },
      ];
      await expect(
        probe(tx, () => bus(tx).execute(revoke(contextFor(self), target))),
      ).resolves.toMatchObject({ revoked: true });
      for (const overrides of malformed) {
        await expect(
          bus(tx).execute(revoke(contextFor(self, overrides), target)),
        ).rejects.toMatchObject({ code: "forbidden" });
      }
    });
  });

  test("refuses a replay, after revocation, of an idempotency key used before it", async () => {
    await inRollbackTransaction(async (tx) => {
      const { self, target } = await seedPair(tx);
      const idempotencyKey = `idempotency-${crypto.randomUUID()}`;
      const context = contextFor(self);
      await expect(
        bus(tx).execute(revoke(context, target, idempotencyKey)),
      ).resolves.toMatchObject({ revoked: true });
      // The same call again answers from its receipt while the credential lives.
      await expect(
        bus(tx).execute(revoke(context, target, idempotencyKey)),
      ).resolves.toMatchObject({ revoked: true });

      await tx.execute(sql`
        update "operator_credentials" set "revoked_at" = now()
        where "id" = ${self.id}
      `);
      await expect(
        bus(tx).execute(revoke(context, target, idempotencyKey)),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });
});

describe.sequential("the switch and the table at command time (F3-14)", () => {
  test.each([
    ["unset", {}],
    ["disabled", { operatorCredentials: "disabled" }],
  ] as const)(
    "refuses a live credential with the switch %s",
    async (_label, value) => {
      await inRollbackTransaction(async (tx) => {
        const { self, target } = await seedPair(tx);
        await expect(
          probe(tx, () => bus(tx).execute(revoke(contextFor(self), target))),
        ).resolves.toMatchObject({ revoked: true });
        await expect(
          bus(tx, value).execute(revoke(contextFor(self), target)),
        ).rejects.toMatchObject({
          code: "forbidden",
          message: "Operator credentials are not enabled",
        });
      });
    },
  );

  test("refuses with 403, not a failed query, while the table does not exist", async () => {
    await inRollbackTransaction(async (tx) => {
      const { self, target } = await seedPair(tx);
      const repository = createCommandAuthorizationRepository(tx, {
        operatorCredentials: "enabled",
      });
      await expect(
        repository.assertCurrent(contextFor(self)),
      ).resolves.toBeUndefined();
      // Renamed rather than dropped: a drop also takes ACCESS EXCLUSIVE on
      // apikey, organizations, projects and user, which deadlocked suites the
      // gate runs beside this one on the same database. `to_regclass` finds
      // no `operator_credentials` either way, and the rollback restores it.
      await tx.execute(
        sql`alter table "operator_credentials" rename to "operator_credentials_absent"`,
      );
      await expect(
        repository.assertCurrent(contextFor(self)),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "Current operator authorization is no longer active",
      });
      expect(target.id).toBeTruthy();
    });
  });

  test("leaves a person's and an agent's path exactly as they were", async () => {
    await inRollbackTransaction(async (tx) => {
      const userId = await seedUser(tx);
      const organizationId = await seedOrganization(tx, userId);
      const repository = createCommandAuthorizationRepository(tx);
      // No session: the human branch refuses as it always has.
      await expect(
        repository.assertCurrent({
          actor: { type: "user", id: userId },
          organizationId,
          scopes: new Set(),
          credentialId: `session_${crypto.randomUUID()}`,
          correlationId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({
        message: "Current human authorization is no longer active",
      });
      // The worker's own service actor is refused as before.
      await expect(
        repository.assertCurrent({
          actor: { type: "service", id: "trigger:work-session-sweep" },
          organizationId,
          scopes: new Set(["work:sweep"]),
          credentialId: "trigger:work-session-sweep",
          correlationId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({
        message: "Current command authorization is unavailable",
      });
    });
  });
});
