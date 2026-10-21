import { readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";

import type { Tx } from "../transaction.js";

const migrationUrl = new URL(
  "../../migrations/0014_requestport_appearance.sql",
  import.meta.url,
);

export async function migrationStatements() {
  return (await readFile(migrationUrl, "utf8"))
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * The statement with its leading `--` comment lines removed. `0014` documents
 * several statements with a comment block, so classifying the raw chunk would
 * make the filter below comment-sensitive rather than statement-sensitive: an
 * explanation added above a `CREATE TABLE` would silently drop that table from
 * the isolated schema, and the fixture would resolve it back to `public`
 * through the trailing `search_path` entry instead of failing.
 */
function statementBody(statement: string) {
  const lines = statement.split(/\r?\n/u);
  let index = 0;
  while (index < lines.length && /^\s*(?:--.*)?$/u.test(lines[index] ?? "")) {
    index += 1;
  }
  return lines.slice(index).join("\n").trim();
}

/**
 * Whether one `0014` statement builds an appearance table rather than
 * something the shared schema owns. The membership trigger, its function, and
 * the backfill are deliberately excluded: `0014` qualifies all three to
 * `public`, and a concurrency fixture must never install a trigger on the
 * shared membership table or write shared rows.
 */
export function isIsolatedAppearanceTableStatement(statement: string) {
  const body = statementBody(statement);
  return (
    /^(?:CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX)/iu.test(
      body,
    ) &&
    /"(?:organization_appearance_defaults|user_appearance_preferences)"/u.test(
      body,
    )
  );
}

/**
 * `0014` is immutable and hash-locked, so the statements that build the two
 * appearance tables are a fixed, ordered set. Naming every one of them turns a
 * silently dropped statement into a loud failure instead of a fixture that
 * quietly degrades into a partial copy of the checked-in schema.
 */
export const isolatedAppearanceStatementNames = [
  'CREATE TABLE "organization_appearance_defaults"',
  'CREATE TABLE "user_appearance_preferences"',
  '"organization_appearance_defaults_organization_id_organizations_id_fk"',
  '"organization_appearance_defaults_updater_fk"',
  '"user_appearance_preferences_user_id_user_id_fk"',
  '"organization_appearance_defaults_aggregate_id_unique"',
  '"organization_appearance_defaults_updater_idx"',
  '"user_appearance_preferences_aggregate_id_unique"',
] as const;

/**
 * The `0014` statements that create the two appearance tables, their
 * constraints, and their indexes — and nothing else. Every one of them names
 * the appearance tables unqualified, so running them under a private
 * `search_path` reproduces the exact checked-in schema inside an isolated
 * PostgreSQL schema.
 */
export async function isolatedAppearanceTableStatements() {
  const statements = (await migrationStatements()).filter(
    isIsolatedAppearanceTableStatement,
  );
  if (statements.length !== isolatedAppearanceStatementNames.length) {
    throw new Error(
      `Isolated appearance schema expects ${isolatedAppearanceStatementNames.length} statements, found ${statements.length}`,
    );
  }
  for (const [index, name] of isolatedAppearanceStatementNames.entries()) {
    if (!statements[index]?.includes(name)) {
      throw new Error(`Isolated appearance schema is missing ${name}`);
    }
  }
  return statements;
}

/** Whether the connected database already carries migration `0014`. */
export async function appearanceCutoverInstalled(tx: Tx) {
  const result = await tx.execute(sql`
    select to_regclass('public.organization_appearance_defaults') is not null
      as "installed"
  `);

  return (result.rows[0] as { installed: boolean }).installed === true;
}

/**
 * SQLSTATE `lock_not_available`: what a `NOWAIT` lock request raises when
 * another session holds a conflicting lock. `lock_timeout` raises it too.
 */
export const lockNotAvailable = "55P03";

/** The table lock modes these helpers take on shared tables. */
export type SharedLockMode =
  | "ROW EXCLUSIVE"
  | "SHARE ROW EXCLUSIVE"
  | "ACCESS EXCLUSIVE";

/** One table outside the fixture's own schema, and the lock to take on it. */
export interface SharedLock {
  schema: string;
  table: string;
  mode: SharedLockMode;
}

/**
 * The `LOCK TABLE … NOWAIT` statements that take `locks`: one per mode, in the
 * order the modes first appear. A refused table fails the statement with
 * {@link lockNotAvailable} at once instead of queueing for it.
 */
export function sharedLockStatements(locks: readonly SharedLock[]) {
  const byMode = new Map<SharedLockMode, string[]>();
  for (const lock of locks) {
    const tables = byMode.get(lock.mode) ?? [];
    tables.push(`"${lock.schema}"."${lock.table}"`);
    byMode.set(lock.mode, tables);
  }
  return [...byMode].map(
    ([mode, tables]) =>
      `lock table ${tables.join(", ")} in ${mode} mode nowait`,
  );
}

export interface SharedLockRetryOptions {
  /**
   * How long refused attempts go on being retried, in milliseconds. Defaults
   * to 20 seconds, inside the 30-second hook and case timeouts of the suites
   * that call these helpers, so running out fails with this module's own
   * message rather than a timeout.
   */
  budgetMs?: number;
  /** Called once for every refused attempt, before the pause that follows it. */
  onRefused?: (error: unknown) => void;
}

const defaultSharedLockBudgetMs = 20_000;

function sqlStateOf(error: unknown): string | undefined {
  for (let current = error; current instanceof Object; ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Runs `attempt` until it does not fail with {@link lockNotAvailable}. The
 * caller's attempt must have released every lock it took before it rejects —
 * by rolling back its transaction or savepoint — so that nothing is held
 * during the pause. The pause is random, between half and all of 10ms
 * doubled per refusal, capped at 250ms, so two refused sessions do not
 * return in step. Once `budgetMs` would be passed, the last refusal is
 * thrown, wrapped.
 */
async function retryWhileLocksRefused<T>(
  what: string,
  attempt: () => Promise<T>,
  options: SharedLockRetryOptions,
): Promise<T> {
  const budgetMs = options.budgetMs ?? defaultSharedLockBudgetMs;
  const deadline = Date.now() + budgetMs;
  for (let refusals = 1; ; refusals += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (sqlStateOf(error) !== lockNotAvailable) throw error;
      options.onRefused?.(error);
      const ceiling = Math.min(250, 10 * 2 ** Math.min(refusals, 5));
      const pauseMs = Math.round(ceiling * (0.5 + Math.random() / 2));
      if (Date.now() + pauseMs > deadline) {
        throw new Error(
          `${what}: the shared-table locks it needs were refused ${refusals} ` +
            `times in ${budgetMs}ms; another session kept holding a conflicting lock.`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
}

/**
 * The shared tables the `0014` replay touches, each with the one lock that
 * covers every lock the replay takes on it. Measured on 2026-09-29 by
 * replaying `0014` in a transaction on a database migrated to `0013` that
 * held one active owner to backfill, then reading `pg_locks`:
 * SHARE ROW EXCLUSIVE (with ROW SHARE and ACCESS SHARE) on "organizations",
 * "organization_members" and "user" — the foreign keys, the trigger, and
 * `0014`'s own LOCK — and ROW EXCLUSIVE (with ROW SHARE) on "domain_events"
 * and ROW EXCLUSIVE on "outbox" — the backfill's inserts. While a mode is
 * held, a later request in the same transaction for a mode whose conflicts
 * are a subset of the held one's is granted without waiting: any lock another
 * session holds that it conflicts with, the held mode conflicts with too, and
 * PostgreSQL queues a request from a holder ahead of the waiters its held lock
 * already conflicts with.
 */
const appearanceCutoverSharedLockModes: Readonly<
  Record<string, SharedLockMode>
> = {
  domain_events: "ROW EXCLUSIVE",
  organization_members: "SHARE ROW EXCLUSIVE",
  organizations: "SHARE ROW EXCLUSIVE",
  outbox: "ROW EXCLUSIVE",
  user: "SHARE ROW EXCLUSIVE",
};

/**
 * The `public` tables `statements` name that they do not create themselves,
 * sorted: every `"public"."…"` in them except a function's name (after
 * `FUNCTION`) and a table one of them creates.
 */
export function sharedTablesNamedBy(statements: readonly string[]) {
  const created = new Set<string>();
  const named = new Set<string>();
  for (const statement of statements) {
    const body = statementBody(statement);
    for (const match of body.matchAll(/CREATE\s+TABLE\s+"([^"]+)"/giu)) {
      created.add(match[1] as string);
    }
    for (const match of body.matchAll(
      /(?<!FUNCTION\s+)"public"\."([^"]+)"/giu,
    )) {
      named.add(match[1] as string);
    }
  }
  return [...named].filter((table) => !created.has(table)).sort();
}

/**
 * The locks the `0014` replay takes up front: every shared table its
 * statements name, in the mode `appearanceCutoverSharedLockModes` declares.
 * A table named without a declared mode, or a declared mode for a table no
 * statement names, is thrown rather than guessed: the declaration is a
 * measurement, and a changed statement set needs a new one.
 */
export function appearanceCutoverSharedLocks(
  statements: readonly string[],
): SharedLock[] {
  const named = sharedTablesNamedBy(statements);
  const declared = Object.keys(appearanceCutoverSharedLockModes).sort();
  if (named.join() !== declared.join()) {
    throw new Error(
      `0014 names the shared tables [${named.join(", ")}], but the replay ` +
        `declares locks for [${declared.join(", ")}]`,
    );
  }
  return named.map((table) => ({
    schema: "public",
    table,
    mode: appearanceCutoverSharedLockModes[table] as SharedLockMode,
  }));
}

/**
 * Brings one rollback-isolated transaction to a post-`0014` schema, replaying
 * the checked-in migration only when the connected database has not applied it
 * yet. Replaying against a migrated database would raise 42P07, and the gate
 * runs these suites against exactly such a database — so every case establishes its
 * precondition instead of assuming one.
 *
 * The replay needs locks on five shared tables, and the suites calling this
 * share one database with suites that write those tables in other orders — a
 * signup writes "user" and then a membership; `0014` locks
 * "organization_members" before it reaches "user". Queueing for one of them
 * while holding another is what closes a cycle. So before any statement of
 * `0014` runs, every one of those locks is taken in a savepoint with `NOWAIT`,
 * together with `FOR KEY SHARE` on every active owner membership and its
 * organization — a superset of the rows the backfill's foreign-key checks
 * lock, so a writer holding one of them `FOR UPDATE` refuses the attempt
 * rather than leaving the backfill queued behind it. A refusal
 * rolls back to the savepoint, which releases what that attempt took, and the
 * attempt is repeated after a short random pause (`retryWhileLocksRefused`).
 * Once all are held, the replay asks for nothing on a shared table that a
 * lock it holds does not already cover.
 *
 * This assumes the caller's transaction holds no shared lock yet — every
 * caller calls this first — since a refusal cannot release what the caller
 * took before it.
 */
export async function ensureAppearanceCutover(
  tx: Tx,
  options: SharedLockRetryOptions = {},
) {
  if (await appearanceCutoverInstalled(tx)) return;

  const statements = await migrationStatements();
  const locks = sharedLockStatements(appearanceCutoverSharedLocks(statements));
  await retryWhileLocksRefused(
    "Replaying 0014",
    () =>
      tx.transaction(async (savepoint) => {
        for (const statement of locks) {
          await savepoint.execute(sql.raw(statement));
        }
        await savepoint.execute(sql`
          select 1
          from "public"."organization_members" "m"
          join "public"."organizations" "o" on "o"."id" = "m"."organization_id"
          where "m"."role" = 'owner' and "m"."status" = 'active'
          for key share of "m", "o" nowait
        `);
      }),
    options,
  );
  for (const statement of statements) {
    await tx.execute(sql.raw(statement));
  }
}

/**
 * Options for the isolated schema's setup and teardown: the retry, plus a
 * probe that sees the transaction just before it commits.
 */
export interface IsolatedSchemaOptions extends SharedLockRetryOptions {
  /**
   * Runs inside the transaction after its DDL and before COMMIT, on the same
   * session, with the shared-table locks the transaction took up front — so a
   * test can read `pg_locks` for what the DDL itself asked for. An error it
   * throws rolls the transaction back and is rethrown (retried only if it is
   * {@link lockNotAvailable}).
   */
  beforeCommit?: (locks: readonly SharedLock[]) => Promise<void>;
}

/** The part of a dedicated test session (`openSession()`) these helpers use. */
export interface SchemaSession {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Runs `body` in a transaction on `session` that first takes `locks()` —
 * every shared-table lock the body will need — with `NOWAIT`, then runs
 * `beforeCommit` with those locks, and commits.
 * A refusal rolls the whole transaction back, releasing everything, and
 * `retryWhileLocksRefused` tries again; so the transaction never queues for
 * a shared table, least of all while holding another.
 */
async function inTransactionHoldingSharedLocks(
  what: string,
  session: SchemaSession,
  locks: () => Promise<readonly SharedLock[]>,
  body: () => Promise<void>,
  options: IsolatedSchemaOptions,
) {
  await retryWhileLocksRefused(
    what,
    async () => {
      await session.query("BEGIN");
      try {
        const held = await locks();
        for (const statement of sharedLockStatements(held)) {
          await session.query(statement);
        }
        await body();
        await options.beforeCommit?.(held);
        await session.query("COMMIT");
      } catch (error) {
        await session.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
    options,
  );
}

/**
 * The shared tables the isolated statements reach, each in SHARE ROW
 * EXCLUSIVE — what `ADD CONSTRAINT … FOREIGN KEY` takes on the table it
 * references (measured 2026-09-29, with ROW SHARE and ACCESS SHARE, which
 * SHARE ROW EXCLUSIVE covers). A foreign-key target is the only way these
 * statements may name a table outside the fixture's schema, because any other
 * would not have its lock taken up front. Two shapes are thrown: a
 * double-quoted `"schema"."table"` anywhere but after `REFERENCES`, and a
 * `REFERENCES` not followed by a double-quoted `"schema"."table"` — quoted or
 * not, an unqualified target would resolve through the trailing `public` on
 * the `search_path` to a shared table. An unquoted schema-qualified name
 * outside a `REFERENCES` is not recognised; drizzle-kit quotes every
 * identifier it emits, and `0014` is hash-locked.
 */
export function isolatedAppearanceSharedLocks(
  statements: readonly string[],
): SharedLock[] {
  const created = new Set(
    statements.flatMap((statement) =>
      [
        ...statementBody(statement).matchAll(/CREATE\s+TABLE\s+"([^"]+)"/giu),
      ].map((match) => match[1] as string),
    ),
  );
  const locks = new Map<string, SharedLock>();
  for (const statement of statements) {
    const body = statementBody(statement);
    // `"table"."column"` in a CHECK names a fixture table, not a schema.
    const qualified = [...body.matchAll(/"([^"]+)"\."([^"]+)"/gu)].filter(
      (match) => !created.has(match[1] as string),
    );
    const targets = [...body.matchAll(/REFERENCES\s+"([^"]+)"\."([^"]+)"/giu)];
    if (
      qualified.length !== targets.length ||
      /\bREFERENCES\b(?!\s*"[^"]+"\."[^"]+")/iu.test(body)
    ) {
      throw new Error(
        "An isolated appearance statement reaches outside the fixture's " +
          `schema other than through a qualified foreign-key target: ${body}`,
      );
    }
    for (const [, schema, table] of targets) {
      locks.set(`${schema}.${table}`, {
        schema: schema as string,
        table: table as string,
        mode: "SHARE ROW EXCLUSIVE",
      });
    }
  }
  return [...locks.values()];
}

/**
 * Builds the two appearance tables inside `schema`, a new PostgreSQL schema,
 * in one transaction on `session`, and commits. The transaction takes every
 * shared-table lock its foreign keys need first, with `NOWAIT`
 * (`inTransactionHoldingSharedLocks`).
 */
export async function createIsolatedAppearanceSchema(
  session: SchemaSession,
  schema: string,
  options: IsolatedSchemaOptions = {},
) {
  const statements = await isolatedAppearanceTableStatements();
  const locks = isolatedAppearanceSharedLocks(statements);
  await inTransactionHoldingSharedLocks(
    "Creating the isolated appearance schema",
    session,
    async () => locks,
    async () => {
      await session.query(`create schema "${schema}"`);
      await session.query(`set local search_path to "${schema}", public`);
      for (const statement of statements) {
        await session.query(statement);
      }
    },
    options,
  );
}

/**
 * The tables outside `schema` that its foreign keys reference, read from the
 * catalog, each in ACCESS EXCLUSIVE: dropping a table drops the foreign-key
 * triggers on every table it references, and takes ACCESS EXCLUSIVE on each
 * (measured 2026-09-29). Read from the catalog rather than from the
 * statements, so a schema whose setup stopped part-way is covered by what it
 * actually holds.
 */
export async function isolatedSchemaSharedLocks(
  session: SchemaSession,
  schema: string,
): Promise<SharedLock[]> {
  const result = await session.query(
    `select distinct tn.nspname as "schema", t.relname as "table"
       from pg_constraint con
       join pg_namespace cn on cn.oid = con.connamespace
       join pg_class t on t.oid = con.confrelid
       join pg_namespace tn on tn.oid = t.relnamespace
      where con.contype = 'f' and cn.nspname = $1 and tn.nspname <> $1
      order by 1, 2`,
    [schema],
  );
  return result.rows.map((row) => ({
    schema: String(row.schema),
    table: String(row.table),
    mode: "ACCESS EXCLUSIVE" as const,
  }));
}

/**
 * Drops `schema` and everything in it, in a transaction that first takes
 * ACCESS EXCLUSIVE, with `NOWAIT`, on every table outside it that its foreign
 * keys reference (`inTransactionHoldingSharedLocks`).
 */
export async function dropIsolatedAppearanceSchema(
  session: SchemaSession,
  schema: string,
  options: IsolatedSchemaOptions = {},
) {
  await inTransactionHoldingSharedLocks(
    "Dropping the isolated appearance schema",
    session,
    () => isolatedSchemaSharedLocks(session, schema),
    async () => {
      await session.query(`drop schema if exists "${schema}" cascade`);
    },
    options,
  );
}
