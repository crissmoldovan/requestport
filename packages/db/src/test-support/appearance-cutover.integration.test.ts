import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import { openSession, type TestSession } from "../testing.js";
import {
  createIsolatedAppearanceSchema,
  dropIsolatedAppearanceSchema,
  type SharedLock,
} from "./appearance-cutover.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
 * The isolated appearance schema's setup and teardown against a competing
 * writer on the shared tables, on a PostgreSQL server: the two race cases
 * hold three sessions at once, which is why vitest.config.ts leaves this file
 * out of the PGlite lane. The two coverage cases at the end read `pg_locks`
 * from inside the helpers' own transactions.
 *
 * The writer writes one shared table and then another, with `LOCK TABLE … IN
 * ROW EXCLUSIVE MODE` — the table lock an INSERT takes — so it writes no rows.
 * Each case picks the order that closes a cycle with the operation as it stood
 * before 2026-09-29 (measured then): the setup's foreign keys lock
 * "organizations", "organization_members", then "user", so its writer holds
 * "user" first, as a signup does; the schema drop locks "user",
 * "organization_members", then "organizations", so its writer holds
 * "organizations" first. The writer's second step is issued only once the
 * operation has either queued behind its first lock or been refused it. The
 * failure in F.2.1's gate on 2026-09-29 was the first of those: the setup
 * queued while holding "organizations", and PostgreSQL broke the cycle with
 * `deadlock detected`.
 */

const caseTimeoutMs = 30_000;
const deadlockDetected = "40P01";

afterAll(async () => {
  await suiteStorage.close();
});

type Outcome = { ok: true } | { ok: false; code: string | undefined };

function settle(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, code: sqlStateOf(error) }) as const,
  );
}

function sqlStateOf(error: unknown): string | undefined {
  for (let current = error; current instanceof Object; ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function backendPid(session: TestSession) {
  const result = await session.query<{ pid: number }>(
    "select pg_backend_pid() as pid",
  );
  return Number(result.rows[0]?.pid);
}

/** Whether `pid` is queued for a lock on any table in `public`. */
async function waitingOnSharedTable(observer: TestSession, pid: number) {
  const result = await observer.query<{ waiting: boolean }>(
    `select exists (
       select 1 from pg_locks l
       join pg_class c on c.oid = l.relation
       join pg_namespace n on n.oid = c.relnamespace
       where l.pid = $1 and not l.granted and n.nspname = 'public'
     ) as "waiting"`,
    [pid],
  );
  return result.rows[0]?.waiting === true;
}

async function until(condition: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function schemaName(purpose: string) {
  return `requestport_appearance_${purpose}_${crypto
    .randomUUID()
    .replaceAll("-", "")}`;
}

async function foreignKeysOf(session: TestSession, schema: string) {
  const result = await session.query<{ target: string }>(
    `select t.relname as "target"
       from pg_constraint con
       join pg_namespace n on n.oid = con.connamespace
       join pg_class t on t.oid = con.confrelid
      where con.contype = 'f' and n.nspname = $1
      order by 1`,
    [schema],
  );
  return result.rows.map((row) => row.target);
}

/**
 * The writer's two steps around `operation`, which runs on its own session:
 * write `first`, wait until `operation` has queued or been refused, then write
 * each of `then`. Returns how both ended.
 */
async function raceAgainstWriter(
  first: string,
  then: readonly string[],
  operation: (session: TestSession, onRefused: () => void) => Promise<unknown>,
) {
  const subject = await openSession(suiteStorage);
  const writer = await openSession(suiteStorage);
  const observer = await openSession(suiteStorage);
  try {
    const subjectPid = await backendPid(subject);
    await writer.query("BEGIN");
    await writer.query(`lock table "public"."${first}" in row exclusive mode`);

    let refusals = 0;
    const subjectOutcome = settle(
      operation(subject, () => {
        refusals += 1;
      }),
    );
    const engaged = await until(
      async () =>
        refusals > 0 || (await waitingOnSharedTable(observer, subjectPid)),
      10_000,
    );

    const writerOutcome = await settle(
      (async () => {
        for (const table of then) {
          await writer.query(
            `lock table "public"."${table}" in row exclusive mode`,
          );
        }
        // Held a moment longer, as a signup's transaction would be, so a
        // refused subject has to come back for the locks at least once more.
        await new Promise((resolve) => setTimeout(resolve, 200));
      })(),
    );
    await writer.query(writerOutcome.ok ? "COMMIT" : "ROLLBACK");

    return {
      engaged,
      refusals,
      subject: await subjectOutcome,
      writer: writerOutcome,
    };
  } finally {
    await writer.query("ROLLBACK").catch(() => undefined);
    writer.release();
    observer.release();
    subject.release();
  }
}

describe.sequential("isolated appearance schema against a competing writer", () => {
  test('setup does not deadlock with a writer that holds "user" and then writes an organization', {
    timeout: caseTimeoutMs,
  }, async () => {
    const schema = schemaName("setup_race");
    const cleanup = await openSession(suiteStorage);
    try {
      const result = await raceAgainstWriter(
        "user",
        ["organizations", "organization_members"],
        (session, onRefused) =>
          createIsolatedAppearanceSchema(session, schema, { onRefused }),
      );

      expect(result.engaged).toBe(true);
      expect([result.subject, result.writer]).not.toContainEqual({
        ok: false,
        code: deadlockDetected,
      });
      // Refused rather than queued: it came back for the locks.
      expect(result.refusals).toBeGreaterThan(0);
      expect(result.writer).toEqual({ ok: true });
      expect(result.subject).toEqual({ ok: true });
      expect(await foreignKeysOf(cleanup, schema)).toEqual([
        "organization_members",
        "organizations",
        "user",
      ]);
    } finally {
      await dropIsolatedAppearanceSchema(cleanup, schema);
      cleanup.release();
    }
  });

  test('teardown does not deadlock with a writer that holds "organizations" and then writes "user"', {
    timeout: caseTimeoutMs,
  }, async () => {
    const schema = schemaName("teardown_race");
    const setup = await openSession(suiteStorage);
    try {
      await createIsolatedAppearanceSchema(setup, schema);
      const result = await raceAgainstWriter(
        "organizations",
        ["user"],
        (session, onRefused) =>
          dropIsolatedAppearanceSchema(session, schema, { onRefused }),
      );

      expect(result.engaged).toBe(true);
      expect([result.subject, result.writer]).not.toContainEqual({
        ok: false,
        code: deadlockDetected,
      });
      // Refused rather than queued: it came back for the locks.
      expect(result.refusals).toBeGreaterThan(0);
      expect(result.writer).toEqual({ ok: true });
      expect(result.subject).toEqual({ ok: true });
      const remaining = await setup.query<{ present: boolean }>(
        `select exists (select 1 from pg_namespace where nspname = $1) as "present"`,
        [schema],
      );
      expect(remaining.rows[0]?.present).toBe(false);
    } finally {
      await dropIsolatedAppearanceSchema(setup, schema);
      setup.release();
    }
  });
});

/**
 * PostgreSQL's table-lock conflict matrix ("Conflicting Lock Modes" in the
 * manual's explicit-locking chapter): the modes each mode conflicts with.
 */
const conflictsWith: Record<string, readonly string[]> = {
  AccessShareLock: ["AccessExclusiveLock"],
  RowShareLock: ["ExclusiveLock", "AccessExclusiveLock"],
  RowExclusiveLock: [
    "ShareLock",
    "ShareRowExclusiveLock",
    "ExclusiveLock",
    "AccessExclusiveLock",
  ],
  ShareUpdateExclusiveLock: [
    "ShareUpdateExclusiveLock",
    "ShareLock",
    "ShareRowExclusiveLock",
    "ExclusiveLock",
    "AccessExclusiveLock",
  ],
  ShareLock: [
    "RowExclusiveLock",
    "ShareUpdateExclusiveLock",
    "ShareRowExclusiveLock",
    "ExclusiveLock",
    "AccessExclusiveLock",
  ],
  ShareRowExclusiveLock: [
    "RowExclusiveLock",
    "ShareUpdateExclusiveLock",
    "ShareLock",
    "ShareRowExclusiveLock",
    "ExclusiveLock",
    "AccessExclusiveLock",
  ],
  ExclusiveLock: [
    "RowShareLock",
    "RowExclusiveLock",
    "ShareUpdateExclusiveLock",
    "ShareLock",
    "ShareRowExclusiveLock",
    "ExclusiveLock",
    "AccessExclusiveLock",
  ],
  AccessExclusiveLock: [
    "AccessShareLock",
    "RowShareLock",
    "RowExclusiveLock",
    "ShareUpdateExclusiveLock",
    "ShareLock",
    "ShareRowExclusiveLock",
    "ExclusiveLock",
    "AccessExclusiveLock",
  ],
};

/** `pg_locks`' name for a `LOCK TABLE` mode. */
function lockName(mode: SharedLock["mode"]) {
  return `${mode
    .toLowerCase()
    .split(" ")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join("")}Lock`;
}

/** The locks this session holds on tables outside `schema`, as `table mode`. */
async function sharedLocksHeld(session: TestSession, schema: string) {
  const result = await session.query<{ table: string; mode: string }>(
    `select n.nspname || '.' || c.relname as "table", l.mode
       from pg_locks l
       join pg_class c on c.oid = l.relation
       join pg_namespace n on n.oid = c.relnamespace
      where l.pid = pg_backend_pid() and c.relkind in ('r', 'p')
        and n.nspname not in ('pg_catalog', 'information_schema', $1)
      order by 1, 2`,
    [schema],
  );
  return result.rows;
}

/**
 * What the transaction on `session` holds on a shared table that `locks` —
 * the ones it took up front — do not cover: a mode on a table none of them
 * names, or one that conflicts with something the held mode does not. Either
 * could have queued. Read through the helpers' `beforeCommit` probe, so the
 * up-front locks are taken, and retried, exactly as the helpers take them.
 */
async function uncoveredBy(
  session: TestSession,
  schema: string,
  locks: readonly SharedLock[],
) {
  const held = new Map(
    locks.map((lock) => [`${lock.schema}.${lock.table}`, lockName(lock.mode)]),
  );
  return (await sharedLocksHeld(session, schema)).filter(({ table, mode }) => {
    const covering = held.get(table);
    if (covering === undefined) return true;
    const cover = new Set(conflictsWith[covering]);
    return !(conflictsWith[mode] ?? ["?"]).every((other) => cover.has(other));
  });
}

type Probe = {
  locks: readonly SharedLock[];
  uncovered: Awaited<ReturnType<typeof uncoveredBy>>;
};

describe.sequential("the isolated appearance schema's up-front locks", () => {
  test("cover every shared-table lock the setup's statements take", {
    timeout: caseTimeoutMs,
  }, async () => {
    const schema = schemaName("setup_cover");
    const session = await openSession(suiteStorage);
    try {
      let probe: Probe | undefined;
      await createIsolatedAppearanceSchema(session, schema, {
        beforeCommit: async (locks) => {
          probe = {
            locks,
            uncovered: await uncoveredBy(session, schema, locks),
          };
        },
      });

      expect(probe?.locks.map((lock) => lock.table).sort()).toEqual([
        "organization_members",
        "organizations",
        "user",
      ]);
      expect(probe?.uncovered).toEqual([]);
    } finally {
      await dropIsolatedAppearanceSchema(session, schema);
      session.release();
    }
  });

  test("cover every shared-table lock the teardown's drop takes", {
    timeout: caseTimeoutMs,
  }, async () => {
    const schema = schemaName("teardown_cover");
    const session = await openSession(suiteStorage);
    try {
      await createIsolatedAppearanceSchema(session, schema);
      let probe: Probe | undefined;
      await dropIsolatedAppearanceSchema(session, schema, {
        beforeCommit: async (locks) => {
          probe = {
            locks,
            uncovered: await uncoveredBy(session, schema, locks),
          };
        },
      });

      expect(probe?.locks.map((lock) => lock.table).sort()).toEqual([
        "organization_members",
        "organizations",
        "user",
      ]);
      expect(probe?.uncovered).toEqual([]);
    } finally {
      await dropIsolatedAppearanceSchema(session, schema);
      session.release();
    }
  });
});
