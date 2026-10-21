import { randomUUID } from "node:crypto";
import {
  AtomicCommandBus,
  type AuthenticatedUserCommandContext,
  type AuthorizedCommandContext,
  actorFingerprint,
  type CommandActorContext,
  CommandRegistry,
  DomainError,
  type JsonObject,
  keyedFingerprint,
} from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import {
  applicationStorageOptionsFromEnv,
  createStorage,
  type Storage,
} from "./client.js";
import { applicationDatabaseUrlSelected } from "./database-url.js";
import { createAgentAuthRepository } from "./repositories/agent-auth-repository.js";
import { createCommandTransactionManager } from "./repositories/command-repository.js";
import { tenantWrappingEnabled } from "./tenant-context.js";
import { createTestStorage, openSession, rawQuery } from "./testing.js";

/*
 * The receipts contract as the application's login (manifest-i2.md §2.9,
 * §3 step 8; r9-rulings.md 220 item 2). It runs wherever the application
 * variable is set: in the application-role lane
 * (vitest.application-role.config.ts), which sets it to a login of its own,
 * and in a track whose `.env.local` names the track's application login
 * (`scripts/create-track-worktree.mjs`). There this suite's storage, built
 * from the application's options as the application root builds its own,
 * connects as that login: a member of requestport_application alone,
 * neither a superuser nor BYPASSRLS. Skipped in every other run.
 *
 * The tenant bus, the user bus and an agent credential issuance run on that
 * storage, each in a transaction of its own, as production's do: what one
 * saves is committed, and one refused rolls back. Rows are seeded, read and
 * removed through the owner's own storage, over DATABASE_URL, which names
 * the owner in both.
 */

// Built from the application's options: the login the application variable
// names, wherever this suite runs.
const suiteStorage = createStorage({
  ...applicationStorageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

let ownerStorage: Storage | undefined;

function owner() {
  ownerStorage ??= createTestStorage({ driver: "pg" });
  return ownerStorage;
}

afterAll(async () => {
  await suiteStorage.close();
  await ownerStorage?.close();
});

const SECRET = "lane-step8-receipt-fingerprint-secret-000001";
const PROBE_COMMAND = "lane.receipt_probe";
const tag = randomUUID().slice(0, 8);
const userId = `lane-s8-${tag}`;
const actor = { type: "user", id: userId } as const;

/** A command that answers its input and counts its executions. */
function probeRegistry<TContext extends CommandActorContext>(executions: {
  count: number;
}) {
  return new CommandRegistry<TContext>().register<
    { value: string },
    JsonObject
  >({
    name: PROBE_COMMAND,
    parse: (input) => input as { value: string },
    async authorize() {},
    async execute(_uow, _context, input) {
      executions.count += 1;
      return {
        result: { value: input.value, execution: executions.count },
        events: [],
      };
    },
  });
}

function probeKey(idempotencyKey: string) {
  return {
    actorFingerprint: actorFingerprint(actor),
    commandName: PROBE_COMMAND,
    idempotencyFingerprint: keyedFingerprint(SECRET, idempotencyKey),
  };
}

/** `find`, on this suite's storage, in a command transaction bound as given. */
function findOnSuiteStorage(
  key: ReturnType<typeof probeKey>,
  binding: { organizationId?: string; userId?: string },
) {
  return createCommandTransactionManager(suiteStorage.db).run(
    (uow) => uow.commandReceipts.find(key),
    binding,
  );
}

/** The organisation of each receipt saved under `key`, read as the owner. */
async function receiptOrganizations(key: {
  actorFingerprint: string;
  commandName: string;
  idempotencyFingerprint: string;
}) {
  const { rows } = await rawQuery<{ organization_id: string | null }>(
    owner(),
    `select organization_id from public.command_receipts
      where actor_fingerprint = $1 and command_name = $2 and idempotency_fingerprint = $3`,
    [key.actorFingerprint, key.commandName, key.idempotencyFingerprint],
  );
  return rows.map((row) => row.organization_id);
}

/** The DomainError code `promise` rejects with, or what else it did. */
function outcome(promise: Promise<unknown>) {
  return promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof DomainError
        ? error.code
        : `not a DomainError: ${String(error)}`,
  );
}

/** Runs `statements` as the owner, with triggers off, in one transaction. */
async function asOwnerInReplica(statements: [string, unknown[]][]) {
  const session = await openSession(owner());
  try {
    await session.query("BEGIN");
    await session.query("SET LOCAL session_replication_role = replica");
    for (const [text, values] of statements) {
      await session.query(text, values);
    }
    await session.query("COMMIT");
  } catch (error) {
    await session.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    session.release();
  }
}

describe.runIf(applicationDatabaseUrlSelected(process.env))(
  "the receipts contract as the application's login, as in the application-role lane (§3 step 8, ruling 220)",
  () => {
    afterAll(async () => {
      await rawQuery(
        owner(),
        "delete from public.command_receipts where actor_fingerprint = $1",
        [actorFingerprint(actor)],
      );
    });

    test("this suite's storage is the lane's login, and the receipts policy applies to it", async () => {
      const { rows } = await suiteStorage.db.execute(
        sql`select current_user::text as role, r.rolsuper, r.rolbypassrls,
                   row_security_active('public.command_receipts') as active
              from pg_catalog.pg_roles r where r.rolname = current_user`,
      );

      expect(rows).toEqual([
        {
          role: expect.stringMatching(/_app_lane$/u),
          rolsuper: false,
          rolbypassrls: false,
          active: true,
        },
      ]);
    });

    test("the tenant bus saves its receipt under its organisation and replays it; under another organisation the receipt is invisible, and reusing its key answers idempotency_conflict", async () => {
      const a = randomUUID();
      const b = randomUUID();
      const executions = { count: 0 };
      const bus = new AtomicCommandBus<AuthorizedCommandContext>({
        registry: probeRegistry<AuthorizedCommandContext>(executions),
        transactions: createCommandTransactionManager(suiteStorage.db),
        fingerprintSecret: SECRET,
      });
      const idempotencyKey = `lane-s8-tenant-${tag}`;
      const key = probeKey(idempotencyKey);
      const run = (organizationId: string) =>
        bus.execute({
          name: PROBE_COMMAND,
          input: { value: "tenant" },
          context: {
            actor,
            organizationId,
            scopes: new Set<string>(),
            credentialId: `lane-s8-${tag}`,
            correlationId: randomUUID(),
          },
          meta: { idempotencyKey, expectedVersion: 0 },
        });

      expect(await run(a)).toEqual({ value: "tenant", execution: 1 });
      expect(await receiptOrganizations(key)).toEqual([a]);
      expect(await run(a)).toEqual({ value: "tenant", execution: 1 });
      expect(executions.count).toBe(1);

      expect(await findOnSuiteStorage(key, { organizationId: b, userId })).toBe(
        null,
      );
      expect(await outcome(run(b))).toBe("idempotency_conflict");
      // The command ran under B, and its transaction rolled back.
      expect(executions.count).toBe(2);
      expect(await receiptOrganizations(key)).toEqual([a]);
    });

    test("the user bus, with no organisation bound, saves a receipt with none and replays it; bound to an organisation, the receipt is invisible", async () => {
      const executions = { count: 0 };
      const bus = new AtomicCommandBus<AuthenticatedUserCommandContext>({
        registry: probeRegistry<AuthenticatedUserCommandContext>(executions),
        transactions: createCommandTransactionManager(suiteStorage.db),
        fingerprintSecret: SECRET,
      });
      const idempotencyKey = `lane-s8-user-${tag}`;
      const key = probeKey(idempotencyKey);
      const run = () =>
        bus.execute({
          name: PROBE_COMMAND,
          input: { value: "user" },
          context: {
            actor,
            credentialId: `lane-s8-session-${tag}`,
            correlationId: randomUUID(),
          },
          meta: { idempotencyKey, expectedVersion: 0 },
        });

      expect(await run()).toEqual({ value: "user", execution: 1 });
      expect(await receiptOrganizations(key)).toEqual([null]);
      expect(await run()).toEqual({ value: "user", execution: 1 });
      expect(executions.count).toBe(1);
      expect(await findOnSuiteStorage(key, { userId })).toMatchObject({
        result: { value: "user", execution: 1 },
      });
      expect(
        await findOnSuiteStorage(key, { organizationId: randomUUID(), userId }),
      ).toBeNull();
    });

    test("an agent credential issuance reserves its receipt under its organisation; the same key in another organisation answers idempotency_conflict; its cancel, called with nothing bound, binds the reservation's organisation and removes the receipt, and the key reserves again", async () => {
      const a = randomUUID();
      const b = randomUUID();
      const projectA = randomUUID();
      const projectB = randomUUID();
      const seed: [string, unknown[]][] = [
        [
          `insert into public."user" (id, name, email) values ($1, 'Lane', $1 || '@example.test')`,
          [userId],
        ],
      ];
      for (const [organizationId, projectId, letter] of [
        [a, projectA, "a"],
        [b, projectB, "b"],
      ] as const) {
        seed.push(
          [
            `insert into public.organizations (id, name, slug, status) values ($1, 'Lane', $2, 'active')`,
            [organizationId, `lane-s8${letter}-${tag}`],
          ],
          [
            `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'admin', 'active')`,
            [organizationId, userId],
          ],
          [
            `insert into public.projects (id, organization_id, name, slug, key_prefix, status) values ($1, $2, 'Lane', 'lane', 'LAN', 'active')`,
            [projectId, organizationId],
          ],
        );
      }
      await asOwnerInReplica(seed);
      try {
        const auth = createAgentAuthRepository(suiteStorage.db);
        const reserve = (organizationId: string, projectId: string) =>
          auth.reserveCredentialIssuance({
            actorUserId: userId,
            organizationId,
            projectId,
            idempotencyKey: `lane-s8-issuance-${tag}`,
            expectedVersion: 0,
            fingerprintSecret: SECRET,
            normalizedInput: { name: "Lane" },
          });

        const receipt = await reserve(a, projectA);
        expect(receipt).toMatchObject({
          reserved: true,
          organizationId: a,
          result: { status: "pending" },
        });
        expect(await receiptOrganizations(receipt.key)).toEqual([a]);

        expect(await outcome(reserve(b, projectB))).toBe(
          "idempotency_conflict",
        );
        expect(await receiptOrganizations(receipt.key)).toEqual([a]);

        await auth.cancelCredentialIssuance(receipt);
        expect(await receiptOrganizations(receipt.key)).toEqual([]);

        const again = await reserve(a, projectA);
        expect(again).toMatchObject({ reserved: true, organizationId: a });
        await auth.cancelCredentialIssuance(again);
        expect(await receiptOrganizations(again.key)).toEqual([]);
      } finally {
        await asOwnerInReplica([
          [
            "delete from public.projects where id = any($1::uuid[])",
            [[projectA, projectB]],
          ],
          [
            "delete from public.organization_members where organization_id = any($1::uuid[])",
            [[a, b]],
          ],
          [
            "delete from public.organizations where id = any($1::uuid[])",
            [[a, b]],
          ],
          [`delete from public."user" where id = $1`, [userId]],
        ]);
      }
    });
  },
);
