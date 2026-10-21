import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  createCoreCommandRegistry,
  type JsonObject,
} from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import { invitations } from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import { openSession, rawQuery, type TestSession } from "../testing.js";
import type { Tx } from "../transaction.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";
import { createCommandTransactionManager } from "./command-repository.js";
import { createFoundationRepository } from "./foundation-repository.js";
import { createOrganizationManagementRepository } from "./organization-management-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  Organisation access changes that overlap, each on its own connection (Plan
  13, F.2.7, review round 1).

  The bus runs `assertCurrent` before a command's own `authorize`, and
  `assertCurrent` holds the organisation row and the actor's membership row
  `FOR SHARE` until the command's transaction ends. Two commands that each
  then ask `FOR UPDATE` for a row the other holds that way wait for each
  other, and PostgreSQL aborts one with `40P01 deadlock detected`. These cases
  hold a real transaction per command, the way two requests do, and let a
  third session hold the rows the commands are about to lock until both have
  passed `assertCurrent`, so the overlap is forced rather than hoped for.

  Nothing a command writes is committed: each command runs in a savepoint
  inside a transaction that is rolled back as soon as the command settles —
  or, in the one case that watches a command wait, when that case says — and
  that rollback is what lets a command waiting behind it go on. Only the
  fixture is committed — the organisation, its people, their sessions and any
  invitation — and it is released afterwards, as `releaseFixture` describes.
  PGlite has one connection, so this file is left out of its lane
  (`PGLITE_LANE_LEFT_OUT`).
*/

const acrossSessionsTimeoutMs = 30_000;
const busSecret = "organization-management-sessions-bus-secret-000";

function portFactory(name: string, database: Database | Tx) {
  if (name === "organizationManagement")
    return createOrganizationManagementRepository(database);
  if (name === "foundation") return createFoundationRepository(database);
  if (name === "commandAuthorization")
    return createCommandAuthorizationRepository(database);
  return undefined;
}

/** The bus as the web builds it, `assertCurrent` included. */
function bus(tx: Tx) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions: createCommandTransactionManager(
      tx as unknown as Database,
      portFactory,
    ),
    fingerprintSecret: busSecret,
    authorizeContext: (context: AuthorizedCommandContext, uow) =>
      uow
        .port<ReturnType<typeof createCommandAuthorizationRepository>>(
          "commandAuthorization",
        )
        .assertCurrent(context),
  });
}

type Person = { userId: string; sessionId: string };
type Role = "owner" | "admin" | "member";

async function seedMember(tx: Tx, organizationId: string, role: Role) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Organization access sessions user', ${email}, now())
  `);
  const sessionId = `session_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "session" ("id", "expires_at", "token", "updated_at", "user_id")
    values (${sessionId}, now() + interval '1 hour',
      ${`token_${crypto.randomUUID()}`}, now(), ${userId})
  `);
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, 'active')
  `);
  return { userId, sessionId } satisfies Person;
}

async function seedInvitation(
  tx: Tx,
  organizationId: string,
  createdBy: string,
) {
  const [row] = await tx
    .insert(invitations)
    .values({
      organizationId,
      normalizedEmail: `invited-${crypto.randomUUID()}@example.invalid`,
      role: "member",
      tokenHash: `test-token-hash-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdByUserId: createdBy,
    })
    .returning({ id: invitations.id });
  if (!row) throw new Error("no invitation");
  return row.id;
}

/**
 * A committed organisation with two owners, an admin, two members and two
 * pending invitations: enough for any two of the cases below to act on
 * different rows.
 */
async function seedFixture() {
  return suiteStorage.transaction(async (tx) => {
    const organizationId = crypto.randomUUID();
    await tx.execute(sql`
      insert into "organizations" ("id", "name", "slug", "status")
      values (${organizationId}, 'Organization access sessions tenant',
        ${`organization-access-sessions-${organizationId}`}, 'active')
    `);
    const owner = await seedMember(tx, organizationId, "owner");
    const secondOwner = await seedMember(tx, organizationId, "owner");
    const admin = await seedMember(tx, organizationId, "admin");
    const firstTarget = await seedMember(tx, organizationId, "member");
    const secondTarget = await seedMember(tx, organizationId, "member");
    return {
      organizationId,
      owner,
      secondOwner,
      admin,
      firstTarget,
      secondTarget,
      firstInvitation: await seedInvitation(tx, organizationId, owner.userId),
      secondInvitation: await seedInvitation(tx, organizationId, owner.userId),
    };
  });
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

function textArray(values: readonly string[]) {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/**
 * Releases the committed fixture. The organisation is archived rather than
 * deleted: seeding an active owner fires `0014`'s trigger, which writes the
 * organisation's appearance row, its version-1 event and that event's outbox
 * row, and `domain_events` is append-only, so the organisation row (which
 * cascades into it) stays, and with it those three rows — measured: per case,
 * one archived organisation, one appearance row, one event, one outbox row,
 * and nothing else. Everything that owns no append-only history is removed:
 * invitations, memberships, the people (their sessions cascade) and their
 * allowlist rows.
 */
async function releaseFixture(fixture: Fixture) {
  const userIds = [
    fixture.owner,
    fixture.secondOwner,
    fixture.admin,
    fixture.firstTarget,
    fixture.secondTarget,
  ].map((person) => person.userId);
  await suiteStorage.transaction(async (tx) => {
    await tx.execute(sql`
      delete from "invitations" where "organization_id" = ${fixture.organizationId}
    `);
    await tx.execute(sql`
      update "organizations" set "status" = 'archived'
      where "id" = ${fixture.organizationId}
    `);
    await tx.execute(sql`
      delete from "organization_members"
      where "organization_id" = ${fixture.organizationId}
    `);
    await tx.execute(sql`
      delete from "user" where "id" = any(array[${textArray(userIds)}]::text[])
    `);
    await tx.execute(sql`
      delete from "signup_allowlist"
      where "normalized_email" = any(array[${textArray(
        userIds.map((userId) => `${userId}@example.invalid`),
      )}]::citext[])
    `);
  });
}

class TestRollback extends Error {}

/**
 * One real transaction on a dedicated connection, always rolled back. The
 * command transaction manager nests a savepoint inside it, so every lock a
 * dispatch takes is held until `end` is called.
 */
async function beginHeld(client: TestSession) {
  let decide!: () => void;
  const decided = new Promise<void>((resolve) => {
    decide = resolve;
  });
  let opened!: (tx: Tx) => void;
  let openFailed!: (error: unknown) => void;
  const ready = new Promise<Tx>((resolve, reject) => {
    opened = resolve;
    openFailed = reject;
  });
  const finished = client.db
    .transaction(async (inner) => {
      opened(inner as unknown as Tx);
      await decided;
      throw new TestRollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof TestRollback)) openFailed(error);
    });
  const tx = await ready;
  const [row] = (await tx.execute(sql`select pg_backend_pid() as "pid"`))
    .rows as { pid: number }[];
  return {
    tx,
    pid: Number(row?.pid),
    /** Idempotent, so `finally` can end a handle a case already ended. */
    async end() {
      decide();
      await finished;
    },
  };
}

type Held = Awaited<ReturnType<typeof beginHeld>>;

/** The SQLSTATE a driver error carries, on itself or on its `cause`. */
function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

type Command = {
  label: string;
  actor: (fixture: Fixture) => Person;
  name: string;
  fields: (fixture: Fixture) => Record<string, unknown>;
  /** The row the command will lock for writing, for the holding session. */
  holds: (fixture: Fixture) => { table: "members" | "invitations"; id: string };
};

/**
 * Dispatches `command` on `held` with `idempotencyKey`, and — unless
 * `endOnSettle` is false — ends `held` the moment it settles, which is what
 * releases a command waiting behind it. Answers "ok", the domain code, or the
 * SQLSTATE.
 */
async function dispatch(
  held: Held,
  fixture: Fixture,
  command: Command,
  idempotencyKey: string,
  endOnSettle = true,
): Promise<string> {
  const actor = command.actor(fixture);
  try {
    await bus(held.tx).execute<unknown, JsonObject>({
      name: command.name,
      context: {
        actor: { type: "user", id: actor.userId },
        organizationId: fixture.organizationId,
        scopes: new Set(["members:manage"]),
        credentialId: actor.sessionId,
        correlationId: crypto.randomUUID(),
      },
      input: {
        organizationId: fixture.organizationId,
        ...command.fields(fixture),
      },
      meta: { idempotencyKey, expectedVersion: 1 },
    });
    return "ok";
  } catch (error) {
    const state = sqlState(error);
    if (state) return state;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : String(error);
  } finally {
    if (endOnSettle) await held.end();
  }
}

/**
 * Holds the organisation row and each row the commands will write `FOR
 * SHARE` on a third connection, the way `assertCurrent` holds them for a
 * request already in flight. Every command passes `assertCurrent` (a share
 * lock does not conflict with a share lock) and then waits here, so both are
 * inside their transactions, holding what `assertCurrent` took, before either
 * may write.
 */
async function holdRows(
  held: Held,
  fixture: Fixture,
  rows: readonly { table: "members" | "invitations"; id: string }[],
) {
  await held.tx.execute(sql`
    select 1 from "organizations" where "id" = ${fixture.organizationId}
    for share
  `);
  for (const row of rows) {
    if (row.table === "members") {
      await held.tx.execute(sql`
        select 1 from "organization_members"
        where "organization_id" = ${fixture.organizationId}
          and "user_id" = ${row.id}
        for share
      `);
    } else {
      await held.tx.execute(sql`
        select 1 from "invitations" where "id" = ${row.id} for share
      `);
    }
  }
}

/**
 * Resolves once every one of `pids` is waiting on a lock or has settled. A
 * deadlock can be detected before the hold is released, so a settled command
 * counts as having arrived.
 */
async function untilArrived(pids: readonly number[], settled: () => number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { rows } = await rawQuery<{ waiting: number }>(
      suiteStorage,
      `select count(distinct "pid")::int as "waiting" from pg_locks
       where not "granted" and "pid" = any($1::int[])`,
      [pids],
    );
    if ((rows[0]?.waiting ?? 0) + settled() >= pids.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the commands never reached the rows they write");
}

/**
 * Runs `first` and `second` at once, each on its own connection, behind a
 * third connection that holds the rows they write until both have arrived.
 * Answers each command's outcome, in the order given.
 *
 * With `whileOpen`, neither command's transaction ends when it settles:
 * `whileOpen` is handed both, once the hold is released, and decides when
 * each ends; any it leaves open end after both commands have settled.
 */
async function overlap(
  fixture: Fixture,
  first: Command,
  second: Command,
  options: {
    keys?: readonly [string, string];
    whileOpen?: (
      running: readonly { held: Held; outcome: Promise<string> }[],
    ) => Promise<void>;
  } = {},
) {
  const keys = options.keys ?? [key(), key()];
  const endOnSettle = options.whileOpen === undefined;
  const clients = [
    await openSession(suiteStorage),
    await openSession(suiteStorage),
    await openSession(suiteStorage),
  ];
  const [holderClient, firstClient, secondClient] = clients as [
    TestSession,
    TestSession,
    TestSession,
  ];
  const holder = await beginHeld(holderClient);
  const firstHeld = await beginHeld(firstClient);
  const secondHeld = await beginHeld(secondClient);
  let running: { held: Held; outcome: Promise<string> }[] = [];
  try {
    await holdRows(holder, fixture, [
      first.holds(fixture),
      second.holds(fixture),
    ]);
    let settled = 0;
    running = [
      {
        held: firstHeld,
        outcome: dispatch(firstHeld, fixture, first, keys[0], endOnSettle),
      },
      {
        held: secondHeld,
        outcome: dispatch(secondHeld, fixture, second, keys[1], endOnSettle),
      },
    ].map((entry) => ({
      held: entry.held,
      outcome: entry.outcome.finally(() => {
        settled += 1;
      }),
    }));
    await untilArrived([firstHeld.pid, secondHeld.pid], () => settled);
    await holder.end();
    await options.whileOpen?.(running);
    return await Promise.all(running.map((entry) => entry.outcome));
  } finally {
    await holder.end();
    // A command's transaction is ended only once its command has settled
    // (`dispatch` never rejects). Ending it mid-command would put the
    // rollback ahead of the command's remaining statements on the same
    // connection, and they would then run, and commit, outside any
    // transaction. Measured: a case failing here committed a member change.
    // Ending each as it settles lets go of anything the other still waits on.
    await Promise.all(
      running.map(async (entry) => {
        await entry.outcome;
        await entry.held.end();
      }),
    );
    await firstHeld.end();
    await secondHeld.end();
    for (const client of clients) client.release();
  }
}

function key() {
  return `organization-access-sessions-${crypto.randomUUID()}`;
}

const setMember = "set_organization_member";
const revokeInvitation = "revoke_organization_invitation";

function changeOf(
  label: string,
  actor: (fixture: Fixture) => Person,
  target: (fixture: Fixture) => Person,
  role: Role = "admin",
): Command {
  return {
    label,
    actor,
    name: setMember,
    fields: (fixture) => ({
      userId: target(fixture).userId,
      role,
      status: "active",
    }),
    holds: (fixture) => ({ table: "members", id: target(fixture).userId }),
  };
}

function revocationOf(
  label: string,
  actor: (fixture: Fixture) => Person,
  invitation: (fixture: Fixture) => string,
): Command {
  return {
    label,
    actor,
    name: revokeInvitation,
    fields: (fixture) => ({ invitationId: invitation(fixture) }),
    holds: (fixture) => ({ table: "invitations", id: invitation(fixture) }),
  };
}

const ownerChangesFirstTarget = changeOf(
  "the owner changes one member",
  (fixture) => fixture.owner,
  (fixture) => fixture.firstTarget,
);
const adminChangesSecondTarget = changeOf(
  "the admin changes another member",
  (fixture) => fixture.admin,
  (fixture) => fixture.secondTarget,
);
const ownerRevokesFirstInvitation = revocationOf(
  "the owner revokes one invitation",
  (fixture) => fixture.owner,
  (fixture) => fixture.firstInvitation,
);
const adminRevokesSecondInvitation = revocationOf(
  "the admin revokes another invitation",
  (fixture) => fixture.admin,
  (fixture) => fixture.secondInvitation,
);

afterAll(async () => {
  await suiteStorage.close();
});

describe("organisation access changes that overlap, across sessions", () => {
  test.each(
    (
      [
        [ownerChangesFirstTarget, adminChangesSecondTarget],
        [ownerChangesFirstTarget, adminRevokesSecondInvitation],
        [ownerRevokesFirstInvitation, adminRevokesSecondInvitation],
      ] as const
    ).map(
      ([first, second]) => [first.label, second.label, first, second] as const,
    ),
  )(
    "%s while %s: both land, neither is a deadlock",
    { timeout: acrossSessionsTimeoutMs },
    async (_first, _second, first, second) => {
      const fixture = await seedFixture();
      try {
        expect(await overlap(fixture, first, second)).toEqual(["ok", "ok"]);
      } finally {
        await releaseFixture(fixture);
      }
    },
  );

  /*
    What `lockOrganizationAccessChanges` is for. With exactly two owners, each
    demoting themselves, each change's last-owner check reads the other owner
    as the one who remains. Serialised, the second waits — on the advisory
    lock, not on a row — until the first's transaction ends, and then reads
    what the first left. Unserialised, each locks its own row and then asks for
    the other's, and one is ended as a deadlock victim instead.
  */
  test("two owners each demoting themselves at once: the second waits on the organisation's access lock until the first's transaction ends", {
    timeout: acrossSessionsTimeoutMs,
  }, async () => {
    const fixture = await seedFixture();
    try {
      const ownerStepsDown = changeOf(
        "the owner steps down",
        (current) => current.owner,
        (current) => current.owner,
      );
      const secondStepsDown = changeOf(
        "the second owner steps down",
        (current) => current.secondOwner,
        (current) => current.secondOwner,
      );
      const outcomes = await overlap(fixture, ownerStepsDown, secondStepsDown, {
        whileOpen: async (running) => {
          const [first, firstOutcome] = await Promise.race(
            running.map((entry, index) =>
              entry.outcome.then((outcome) => [index, outcome] as const),
            ),
          );
          expect(firstOutcome).toBe("ok");
          const waiting = running[1 - first] as (typeof running)[number];
          const { rows } = await rawQuery<{ locktype: string }>(
            suiteStorage,
            `select "locktype" from pg_locks
                 where not "granted" and "pid" = $1`,
            [waiting.held.pid],
          );
          expect(rows).toEqual([{ locktype: "advisory" }]);
          await (running[first] as (typeof running)[number]).held.end();
        },
      });
      // The first was rolled back, so the second met both owners again.
      expect(outcomes).toEqual(["ok", "ok"]);
    } finally {
      await releaseFixture(fixture);
    }
  });

  /*
    The residue the repository cannot remove. Each owner's in-flight command
    holds that owner's own membership `FOR SHARE` from `assertCurrent`, and
    each asks for the other's `FOR UPDATE`, so no order of the command's own
    locks avoids the cycle: PostgreSQL ends one of the two. Its savepoint is
    rolled back whole — no write, no receipt — so the same key, sent again
    once the other command has ended, is answered by the rules rather than by
    a receipt or an idempotency conflict. That second dispatch is what the
    members form does on a 40P01 (`settings/members/actions.ts`).
  */
  test("two owners changing each other at once: one is ended as a deadlock victim, writes nothing, and its key is answered afresh", {
    timeout: acrossSessionsTimeoutMs,
  }, async () => {
    const fixture = await seedFixture();
    try {
      const ownerDemotesSecond = changeOf(
        "the owner demotes the second owner",
        (current) => current.owner,
        (current) => current.secondOwner,
      );
      const secondDemotesOwner = changeOf(
        "the second owner demotes the owner",
        (current) => current.secondOwner,
        (current) => current.owner,
      );
      const keys = [key(), key()] as const;
      const outcomes = await overlap(
        fixture,
        ownerDemotesSecond,
        secondDemotesOwner,
        { keys },
      );
      expect([...outcomes].sort()).toEqual(["40P01", "ok"]);

      const victim = outcomes[0] === "40P01" ? 0 : 1;
      const client = await openSession(suiteStorage);
      try {
        const retried = await dispatch(
          await beginHeld(client),
          fixture,
          [ownerDemotesSecond, secondDemotesOwner][victim] as Command,
          keys[victim],
        );
        expect(retried).toBe("ok");
      } finally {
        client.release();
      }
    } finally {
      await releaseFixture(fixture);
    }
  });
});
