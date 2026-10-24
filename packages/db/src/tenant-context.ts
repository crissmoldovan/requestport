import { is, type SQL, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";

import {
  createStorage,
  type Database,
  hostConstructionTokenOf,
  PG_POOL_LIMITS,
  recordedTenantBinding,
  refuseUnlessHostAdmits,
  type Storage,
  selectDriver,
  type TenantBinding,
  withHostConstructionToken,
} from "./client.js";
import {
  applicationDatabaseUrlSelected,
  refuseUnapprovedSharedPgDatabase,
  validDatabaseUrl,
} from "./database-url.js";
import { isHostedSession } from "./hosted-driver.js";
import { isConnectionFailure } from "./read-retry.js";
import {
  createDatabaseRoleGuard,
  declaredDatabaseSurface,
  type RoleGuardOptions,
  type RoleGuardReport,
  refuseModesOtherThanEnforce,
} from "./role-guard.js";
import type { Tx } from "./transaction.js";

/*
 * The per-transaction tenant binding (Plan 13, Track I.2; manifest-i2.md
 * §2.3; track-i2.md D1, D6, D10, D11).
 *
 * Every tenant policy (`requestport_tenant`) reads the rows of the
 * organisation bound to the transaction, through
 * `requestport_private.bound_organization_id()`, which raises 42501 when
 * nothing is bound. One write arm differs: `security_audit_records`' `WITH
 * CHECK` also admits, when no organisation is bound, a row with no
 * organisation whose actor is the bound user (user mode). The one user
 * policy (`requestport_user`, on `user_appearance_preferences`) reads the
 * bound user instead. The binding is two
 * transaction-local settings, `requestport.organization_id` and
 * `requestport.user_id`. This file is the only non-test source that sets
 * them, or calls `set_config` at all, and §2.3 (ruling 44) says it must stay
 * so; the sweep in `tenant-context.test.ts` ("the trusted boundary") fails
 * on any other.
 *
 * The binding is not an authentication. Any role may set a placeholder, so
 * what the database then enforces is one organisation per transaction — the
 * one bound after authorisation. Binding the wrong one is authorisation's
 * failure, and is tested where authorisation is enforced.
 *
 * A connection as the owner, which production uses until the switch
 * (§3 step 3), bypasses every policy, so a binding changes nothing there.
 */

export type TenantDatabase = Database | Tx;

/** A binding this transaction cannot take, or a value that is not an id. */
export class TenantBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantBindingError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function organizationIdOf(value: string) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TenantBindingError(
      "RequestPort can bind a transaction only to an organisation id.",
    );
  }
  return value.toLowerCase();
}

function userIdOf(value: string) {
  if (typeof value !== "string" || value === "") {
    throw new TenantBindingError(
      "RequestPort can bind a transaction only to a user id.",
    );
  }
  return value;
}

/**
 * Whether `database` is a transaction rather than a pool.
 *
 * Drizzle's `is`, not `instanceof`: `client.ts` loads the pg and PGlite
 * drivers through `require`, which gives them Drizzle's CommonJS build, so
 * their transactions are not instances of the ES module's `PgTransaction`
 * that this file imports. `is` compares Drizzle's entity kinds, which both
 * builds share.
 */
export function isTransaction(database: TenantDatabase): database is Tx {
  return is(database, PgTransaction);
}

/**
 * Whether pool reads are to be wrapped in bound transactions, for a
 * composition root other than the application's: only when the application
 * variable is selected (`applicationDatabaseUrlSelected`; ruling 17, open
 * question 8). Such a root reads it once, when it builds its storage, and
 * builds it `"wrapped"` or `"off"` accordingly (`wiring.ts`), so one built
 * where the variable is set is wrapped over the owner's URL (I.2 step 5,
 * slice 1). Unset, its pool reads run on the pool, unbound.
 *
 * The application root's storage is `"wrapped"` whatever this answers: since
 * I.2 step 5 it connects only through the application variable, or a
 * preview's own (`readApplicationDatabaseUrl`), and refuses without it.
 */
export function tenantWrappingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return applicationDatabaseUrlSelected(env);
}

/**
 * Whether a pool read on `database` is wrapped (manifest-g.md §2.2): the
 * `tenantBinding` recorded against it (`recordedTenantBinding`) — its
 * storage's, which is `"wrapped"` unless the storage was built `"off"` — and
 * for a handle with none recorded, the same default, `"wrapped"`. It reads no
 * environment: a composition root decides once, when it builds
 * (`wiring.ts`).
 */
export function tenantBindingFor(database: Database): TenantBinding {
  return recordedTenantBinding(database) ?? "wrapped";
}

/*
 * The transitions (D10), each decided and applied by one statement.
 *
 * The WHERE reads the transaction's settings as they are, and the select
 * list sets them only when it passes: with no FROM, PostgreSQL evaluates the
 * WHERE before it projects anything, so a refused transition changes
 * nothing and returns no row. An unset placeholder reads as NULL, and one
 * set by an earlier transaction on the same connection as '' (P1); both are
 * unbound.
 *
 *   unbound           -> organisation (and a user)  allowed, once
 *   unbound           -> user mode                  allowed
 *   organisation A    -> A                          allowed; a user is kept,
 *                                                   or added if none was bound
 *   organisation A    -> B, another user, user mode refused
 *   user mode         -> an organisation            refused
 */
const currentOrganization = sql`coalesce(pg_catalog.current_setting('requestport.organization_id', true), '')`;
const currentUser = sql`coalesce(pg_catalog.current_setting('requestport.user_id', true), '')`;

async function applyBinding(tx: Tx, statement: SQL, refusal: string) {
  const { rows } = await tx.execute(statement);

  if (rows.length !== 1) throw new TenantBindingError(refusal);
}

/**
 * Bind `tx` to an organisation, and to a human when `userId` is given.
 * Idempotent for the same organisation; refuses another one, another user,
 * or a transaction already in user mode.
 */
export async function bindTenant(
  tx: Tx,
  organizationId: string,
  options: { userId?: string } = {},
): Promise<void> {
  const organization = organizationIdOf(organizationId);
  const user = options.userId === undefined ? null : userIdOf(options.userId);

  await applyBinding(
    tx,
    sql`select pg_catalog.set_config('requestport.organization_id', ${organization}::text, true) as organization_id,
               pg_catalog.set_config('requestport.user_id', coalesce(${user}::text, ${currentUser}), true) as user_id
        where (${currentOrganization} = '' and ${currentUser} = '')
           or (${currentOrganization} = ${organization}::text
               and (${user}::text is null or ${currentUser} in ('', ${user}::text)))`,
    "RequestPort refuses to bind this transaction: it already serves another " +
      "organisation or user, or is in user mode. A transaction serves one " +
      "organisation (manifest-i2.md §2.3).",
  );
}

/**
 * Bind `tx` to a user alone: user mode, which admits no tenant row except
 * through the membership definer function and the user-mode arms (§2.3).
 * Refused inside an organisation-bound transaction, or for another user.
 */
export async function bindUser(tx: Tx, userId: string): Promise<void> {
  const user = userIdOf(userId);

  await applyBinding(
    tx,
    sql`select pg_catalog.set_config('requestport.user_id', ${user}::text, true) as user_id
        where ${currentOrganization} = ''
          and ${currentUser} in ('', ${user}::text)`,
    "RequestPort refuses to put this transaction in user mode: it already " +
      "serves an organisation or another user (manifest-i2.md §2.3).",
  );
}

/**
 * The bound organisation as a SQL value, or NULL when none is bound: what a
 * command receipt records (manifest-i2.md §2.1).
 */
export const boundOrganizationIdSql: SQL<string | null> = sql<
  string | null
>`nullif(pg_catalog.current_setting('requestport.organization_id', true), '')::uuid`;

function connectionFailure(error: unknown) {
  return (
    isConnectionFailure(error) ||
    (typeof error === "object" &&
      error !== null &&
      isConnectionFailure((error as { cause?: unknown }).cause))
  );
}

/**
 * D6: run `run`, and once more if it failed on a dropped connection and
 * `retry` is true. Only read-only transactions are handed `retry: true`: one
 * leaves nothing durable to duplicate, so a commit whose acknowledgement the
 * dead connection lost is harmless to run again. Exported for its test.
 */
export async function retryReadOnce<T>(
  run: () => Promise<T>,
  retry: boolean,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!retry || !connectionFailure(error)) throw error;
    return run();
  }
}

/**
 * Whether a read-only transaction this file opens on `database` is retried
 * (D6): on the hosted driver only, where the pool's read retry is on
 * (`hosted-driver.ts`), so a read moved off the pool into a transaction keeps
 * a retry exactly where it had one. Read from Drizzle's session, by entity
 * kind, as `isTransaction` is (`isHostedSession`).
 */
export function retriesReadOnlyTransactions(database: Database) {
  return isHostedSession(database._.session);
}

function openTransaction<T>(
  database: Database,
  readOnly: boolean,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return retryReadOnce(
    () =>
      database.transaction(
        work,
        readOnly ? { accessMode: "read only" } : undefined,
      ),
    readOnly && retriesReadOnlyTransactions(database),
  );
}

export interface WithTenantOptions {
  /** The repository's handle: a pool, or a transaction. */
  database: TenantDatabase;
  /**
   * The read takes no row lock and writes nothing. A transaction this opens
   * is then `READ ONLY`, which PostgreSQL enforces, and on the hosted driver
   * is retried once after a dropped connection (D6). Ignored when handed a
   * transaction, which is its opener's to configure.
   */
  readOnly?: boolean;
  /** Bind this human with the organisation. */
  userId?: string;
}

/**
 * Run `work` for one organisation (§2.3 items 3 and 5).
 *
 * - Handed a transaction, it binds that transaction — idempotently for the
 *   same organisation, refused for another — and runs `work` in it. The
 *   import and Slack methods the web's own transactions call first bind this
 *   way (§2.3 item 5), whatever the switch says: on the owner it is harmless.
 * - Handed the pool of a storage whose binding is `"wrapped"`
 *   (`tenantBindingFor`), it opens a transaction, binds it, and runs `work`
 *   in it.
 * - Handed one whose binding is `"off"`, it runs `work` on the pool exactly
 *   as before, in no transaction.
 */
export async function withTenant<T>(
  organizationId: string,
  work: (database: TenantDatabase) => Promise<T>,
  options: WithTenantOptions,
): Promise<T> {
  const database = options.database;
  const bindingOptions =
    options.userId === undefined ? {} : { userId: options.userId };

  if (isTransaction(database)) {
    await bindTenant(database, organizationId, bindingOptions);
    return work(database);
  }

  // Refuse a malformed id whichever way the switch is set.
  organizationIdOf(organizationId);

  if (tenantBindingFor(database) === "off") return work(database);

  return openTransaction(database, options.readOnly === true, async (tx) => {
    await bindTenant(tx, organizationId, bindingOptions);
    return work(tx);
  });
}

/**
 * A pool read's wrapping (§2.3 item 3): handed the pool, exactly as
 * `withTenant`; handed a transaction, `work` runs in it as it is, because
 * whoever opened it binds it — the command transaction manager for a port,
 * a repository's own transaction, a test. The methods that bind a
 * transaction they are handed are §2.3 item 5's, through `withTenant`.
 */
export async function withTenantRead<T>(
  organizationId: string,
  work: (database: TenantDatabase) => Promise<T>,
  options: WithTenantOptions,
): Promise<T> {
  const database = options.database;

  if (isTransaction(database)) return work(database);
  return withTenant(organizationId, work, { ...options, database });
}

/**
 * A method's own transaction, bound at its start (§2.3 item 2), whatever the
 * switch says. Handed a transaction, it is a savepoint, and the binding
 * outlives it: the enclosing transaction then serves that organisation.
 */
export function inTenantTransaction<T>(
  database: TenantDatabase,
  organizationId: string,
  work: (tx: Tx) => Promise<T>,
  options: { userId?: string } = {},
): Promise<T> {
  return database.transaction(async (tx) => {
    await bindTenant(tx, organizationId, options);
    return work(tx);
  });
}

/**
 * The one transaction an administration read runs in (manifest-f2.md §4.1
 * rules 4 and 9; manifest-i2.md §4 Owns, ruling 50), bound to the
 * credential's organisation whatever the switch says: F.2's reads each take
 * a `Tx`, and F.3's credential re-check runs first in the same transaction.
 * The web's administration dispatch opens it
 * (`apps/web/src/lib/server-administration-reads.ts`). Not read-only: the
 * reads lock rows `FOR SHARE`, as the writes they serve do.
 */
export function withAdministrationReadTransaction<T>(
  organizationId: string,
  work: (tx: Tx) => Promise<T>,
  options: { database: Database },
): Promise<T> {
  return inTenantTransaction(options.database, organizationId, work);
}

class IsolatedReadEnd extends Error {}

/**
 * A read whose binding must not outlive it. On the pool, its own
 * transaction. Handed a transaction, a savepoint that is rolled back once
 * `work` has returned, which undoes the binding and releases any lock the
 * read took; so `work` must not write.
 */
async function isolatedRead<T>(
  database: TenantDatabase,
  readOnly: boolean,
  bind: (tx: Tx) => Promise<void>,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!isTransaction(database)) {
    return openTransaction(database, readOnly, async (tx) => {
      await bind(tx);
      return work(tx);
    });
  }

  let result: T | undefined;

  try {
    await database.transaction(async (savepoint) => {
      await bind(savepoint);
      result = await work(savepoint);
      throw new IsolatedReadEnd();
    });
  } catch (error) {
    if (!(error instanceof IsolatedReadEnd)) throw error;
  }
  return result as T;
}

/**
 * User mode, for a read (§2.5.1): the membership listing, which
 * `requestport_private.active_memberships()` answers from this binding
 * alone. Always a read-only transaction, whatever the switch says, because
 * the function refuses to answer without a bound user.
 */
export function withUserBinding<T>(
  userId: string,
  work: (tx: Tx) => Promise<T>,
  options: { database: TenantDatabase },
): Promise<T> {
  return isolatedRead(
    options.database,
    true,
    (tx) => bindUser(tx, userId),
    work,
  );
}

/**
 * One organisation's read among several in one call (§2.5.1: consent's
 * per-organisation reads), each in a binding of its own, whatever the switch
 * says. `readOnly` as in `withTenant`; a read that locks rows passes false.
 */
export function withIsolatedTenantBinding<T>(
  organizationId: string,
  work: (tx: Tx) => Promise<T>,
  options: { database: TenantDatabase; readOnly?: boolean },
): Promise<T> {
  return isolatedRead(
    options.database,
    options.readOnly !== false,
    (tx) => bindTenant(tx, organizationId),
    work,
  );
}

/*
 * The worker's three storages (Plan 13, Track I.2b, step b2; manifest-i2.md
 * §5.1 "Why three roles, not one" and "Processing"; track-i2.md, "I.2b
 * design (2026-09-30)", §3, §5 and §6).
 *
 * A worker process holds up to three storages, one per group role, each
 * from its own variable: the dispatcher's claims, accepts, releases and
 * discovers (functions 1-13), maintenance's runs the three fixed bodies
 * (15-17), and the tenant processor's is reached only through `withTenant`
 * and the resolver (14). A processing unit is handed the processor's
 * transaction and nothing else, so code inside one cannot call a claim,
 * discovery or maintenance function: as the processor it gets 42501.
 *
 * All three set, `withTenant` opens a transaction on the processor's storage
 * and binds it first. A partial set is refused: some steps as the owner and
 * others as a worker role would be neither mode.
 *
 * None set is refused too, naming the three (I.2b's b5; ruling 214 item 1),
 * unless the caller asks for one of two exceptions by name. Each is read
 * only when none of the three is set, and admitted only in the process it
 * names:
 * - `unbound: "embedded"`, over a PGlite `storage`, in a process that has
 *   declared `embedded`: `requestport start` on PGlite, whose one storage
 *   has no logins (ruling 74; `apps/requestport/src/serve/serve.ts`);
 * - `unbound: "test"`, over the `storage` it is given, in a process that has
 *   declared `test`, which only a Vitest setup file can (`role-guard.ts`):
 *   the suites that run job bodies on the local owner.
 * No other option or caller opens the unbound path, and no variable is read
 * for it. On it, every storage is the handle of the storage the caller gave,
 * whose guard is that storage's own, `withTenant` hands `work` that handle
 * in no transaction, and the claims, discoveries and maintenance still go
 * through their functions.
 *
 * Set, each storage has a role guard of its own (§5.2 b2's last item),
 * which judges `worker` in any process that has declared a surface, whatever
 * that surface is: the worker's own, `requestport start`'s serving process,
 * which declares `application` (ruling 72), and a Vitest process, which
 * declares `test` and is role-checked here as the worker is. Before any
 * declaration it judges none, so its declaration check refuses the use. No
 * caller can hand it another surface (ruling 215 item 4; `workerSurface`).
 * Besides that guard's role check, it objects unless the storage's role is a
 * member of exactly its own group (`WORKER_GROUP_ROLES`), and it writes one
 * line naming the role when the check passes, with `console.info` unless its
 * caller hands it `write`. Since I.2b's b5 each runs in the worker's modes
 * (`WORKER_ROLE_GUARD_MODES`, `role-guard.ts`; ruling 214 item 2), whatever
 * surface it judges: its declaration and role checks enforce, so a storage
 * used before any declaration, or whose role the role check objects to, is
 * refused on every use, and a mode its caller hands it can name only
 * enforce, which every check runs in (X30). Since b6 its environment check
 * enforces too (ruling 217):
 * a storage whose `env`, the one handed here, names an owner-capable
 * variable is refused at its first use.
 */

/** The three variables, one per worker group (track-i2.md, "I.2b design" §6). */
export const WORKER_DATABASE_URL_VARIABLES = Object.freeze({
  dispatcher: "REQUESTPORT_DISPATCHER_DATABASE_URL",
  processor: "REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL",
  maintenance: "REQUESTPORT_MAINTENANCE_DATABASE_URL",
} as const);

export type WorkerStorageRole = keyof typeof WORKER_DATABASE_URL_VARIABLES;

/** The group each storage's role must be a member of, and of no other. */
export const WORKER_GROUP_ROLES: Readonly<Record<WorkerStorageRole, string>> =
  Object.freeze({
    dispatcher: "requestport_dispatcher",
    processor: "requestport_tenant_processor",
    maintenance: "requestport_maintenance",
  });

/**
 * Each pool's `max` on the pg driver, the design's figures for a Trigger.dev
 * run (one body per process): the dispatcher and maintenance one connection
 * each, the processor pg-pool's default of 10 (track-i2.md, "I.2b design" §5).
 * C's Postgres worker passes its own. The hosted driver refuses pool limits
 * (`hosted-driver.ts`), so there each pool keeps its own options; a pool
 * opens a connection only when none is idle, so a storage used one statement
 * at a time holds one.
 */
export const WORKER_POOL_SIZES: Readonly<Record<WorkerStorageRole, number>> =
  Object.freeze({ dispatcher: 1, processor: 10, maintenance: 1 });

/** The kinds the resolver (function 14) answers for; any other is NULL there. */
export type JobKind =
  | "outbox"
  | "webhook_delivery"
  | "notification_intent"
  | "slack_delivery_operation"
  | "import_task_dispatch";

export interface WorkerStorages {
  /** Whether the three variables are set, and processing therefore bound. */
  readonly bound: boolean;
  /** Claims, acceptance and release by lease, discovery: functions 1-13. */
  readonly dispatcher: Database;
  /** The three fixed bodies: functions 15-17. */
  readonly maintenance: Database;
  /**
   * One processing unit for `organizationId`: bound, `work` runs in a
   * transaction on the processor's storage whose first statement binds the
   * organisation; unbound (an exception, above), `work` receives the handle
   * of the storage the caller gave. A malformed id is refused either way.
   */
  withTenant<T>(
    organizationId: string,
    work: (database: TenantDatabase) => Promise<T>,
  ): Promise<T>;
  /**
   * Function 14 on the processor's storage, unbound: the organisation whose
   * in-flight job `id` is, or null for an absent, finished, or mismatched one.
   */
  resolveJobOrganization(kind: JobKind, id: string): Promise<string | null>;
  /**
   * Each storage's role guard report, after a `select 1` on each has run its
   * role check: the role each acts as, and what the guard objected to.
   * Unbound, null: the storages are the handle of the storage the caller
   * gave, whose guard, if it has one, is not these storages' to report.
   */
  roleReports(): Promise<Record<WorkerStorageRole, RoleGuardReport> | null>;
  /** Ends the three pools; unbound, nothing (the caller's storage is not its). */
  close(): Promise<void>;
}

/**
 * The three URLs, or null when none is set. Blank counts as unset. Each is
 * held to the rules every connection string here meets (`validDatabaseUrl`:
 * the scheme, a host and a database name), whose message never echoes the
 * value; nor does the refusal of a partial set, which names only the
 * variables.
 */
function workerDatabaseUrls(
  env: NodeJS.ProcessEnv,
): Record<WorkerStorageRole, string> | null {
  const roles = Object.keys(
    WORKER_DATABASE_URL_VARIABLES,
  ) as WorkerStorageRole[];
  const values = new Map<WorkerStorageRole, string>();

  for (const role of roles) {
    const value = env[WORKER_DATABASE_URL_VARIABLES[role]];

    if (typeof value === "string" && value.trim() !== "") {
      values.set(role, value);
    }
  }
  if (values.size === 0) return null;
  if (values.size !== roles.length) {
    const missing = roles
      .filter((role) => !values.has(role))
      .map((role) => WORKER_DATABASE_URL_VARIABLES[role]);

    throw new Error(
      "RequestPort's worker connects as its three roles: " +
        `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} ` +
        "unset while the other worker variables are set. Set all three, " +
        "each to a login in its worker group.",
    );
  }

  const urls = {} as Record<WorkerStorageRole, string>;

  for (const role of roles) {
    urls[role] = validDatabaseUrl(values.get(role));
  }
  return urls;
}

/**
 * The surface each bound storage's guard judges: `worker`, once this process
 * has declared any surface, and none before, so that the guard's
 * declaration check refuses a use in a process that has declared nothing
 * (ruling 215 item 4).
 */
function workerSurface(): "worker" | undefined {
  return declaredDatabaseSurface() === undefined ? undefined : "worker";
}

/** The three variables' names, as a refusal gives them: "A, B and C". */
function workerVariableNames(): string {
  const names = Object.values(WORKER_DATABASE_URL_VARIABLES);

  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The storage the unbound path runs on, when none of the three variables is
 * set: refused, naming the three, unless `options.unbound` asks for an
 * exception this process admits (above). It reads `options.unbound` first,
 * and `options.storage` only once the declaration admits the exception, so
 * a caller that asked for none, or for one its process does not admit, is
 * refused before its storage is read. A refusal names the variables, the
 * declared surface and the storage's driver, never a value.
 */
function unboundStorage(options: {
  unbound?: unknown;
  storage?: Storage;
}): Storage {
  const exception = options.unbound;
  const names = workerVariableNames();
  const set = `Set ${names}, each to a login in its worker group.`;

  if (exception === undefined) {
    throw new Error(
      `RequestPort's worker connects as its three roles, and ${names} are ` +
        "unset. Set all three, each to a login in its worker group.",
    );
  }
  if (exception !== "embedded" && exception !== "test") {
    throw new Error(
      "RequestPort's worker runs unbound only on the embedded or the test " +
        `exception, and its caller asked for another. ${set}`,
    );
  }

  const declared = declaredDatabaseSurface();

  if (declared !== exception) {
    throw new Error(
      `RequestPort's worker runs unbound on the ${exception} exception only ` +
        `in a process that has declared the ${exception} surface, ` +
        (exception === "embedded"
          ? "as requestport start on PGlite does"
          : "which only a Vitest setup file can") +
        `; this process has declared ${declared ?? "no surface"}. ${set}`,
    );
  }

  const storage = options.storage;

  if (exception === "embedded" && storage?.driver !== "pglite") {
    throw new Error(
      "RequestPort's worker runs unbound on the embedded exception only over " +
        "a PGlite storage, and it was given " +
        `${storage === undefined ? "none" : `one on ${storage.driver}`}. ${set}`,
    );
  }
  if (storage === undefined) {
    throw new Error(
      "RequestPort's worker runs unbound on the test exception only over the " +
        `storage its caller gives, and it was given none. ${set}`,
    );
  }
  return storage;
}

async function resolveJobOrganizationOn(
  database: Database,
  kind: JobKind,
  id: string,
): Promise<string | null> {
  // The function takes a uuid; a string that is not one is no job's id.
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const { rows } = await database.execute<{ organization_id: string | null }>(
    sql`select requestport_private.resolve_job_organization(${kind}, ${id}::uuid) as organization_id`,
  );
  return rows[0]?.organization_id ?? null;
}

/**
 * The worker's storages from `env` (§5.1). Set, three storages on this
 * process's driver, which open nothing until first used; `options.unbound`
 * and `options.storage` are not read. None set, refused, naming the three,
 * unless `options.unbound` asks for an exception this process admits; then
 * all three are `options.storage`'s handle, and nothing is opened (above). A
 * partial set is refused. `withTenant` is built on the processor storage's
 * `transaction` (E.2's storage contract).
 *
 * While the host's handoff is set (`client.ts`), it answers only a caller
 * whose options carry a construction token the handoff admits, bound or not,
 * and refuses any other before it reads `env`; each storage it builds is
 * handed the same token (manifest-h.md §2.7.1).
 */
export function createWorkerStorages(
  env: NodeJS.ProcessEnv,
  options: {
    poolSizes?: Partial<Record<WorkerStorageRole, number>>;
    /**
     * The guards' output, and the modes `apps/requestport/src/serve/serve.ts`'s
     * `workerGuardModes` hands them (Done when 5). The guards run in the
     * worker's modes, every check enforcing; `modes` can name only enforce,
     * and anything else it hands, a leftover warn among them, is refused
     * once the host's handoff has admitted the call (which reads only its
     * construction token) and before `env` or `storage` is read, so before
     * any storage is built, on the bound path and the unbound path alike,
     * though the unbound path builds no guard (`role-guard.ts`'s
     * `refuseModesOtherThanEnforce`, X30). Their surface is not the
     * caller's to give: each judges `worker` (`workerSurface`, above;
     * ruling 215 item 4), and only `modes` and `write` are read from this.
     */
    guard?: Pick<RoleGuardOptions, "modes" | "write">;
    /**
     * An exception to the refusal of the unbound path, read only when none
     * of the three variables is set (above): `"embedded"`, admitted in a
     * process declared `embedded` over a PGlite `storage`; `"test"`,
     * admitted in a process declared `test`.
     */
    unbound?: "embedded" | "test";
    /**
     * The storage the unbound path runs on, read only once the process
     * admits `unbound`: all three storages are its handle.
     */
    storage?: Storage;
  } = {},
): WorkerStorages {
  refuseUnlessHostAdmits("createWorkerStorages", options);
  refuseModesOtherThanEnforce(options.guard?.modes);
  const token = hostConstructionTokenOf(options);
  const urls = workerDatabaseUrls(env);

  if (urls === null) {
    const database = unboundStorage(options).db;

    return {
      bound: false,
      dispatcher: database,
      maintenance: database,
      withTenant: async (organizationId, work) => {
        organizationIdOf(organizationId);
        return work(database);
      },
      resolveJobOrganization: (kind, id) =>
        resolveJobOrganizationOn(database, kind, id),
      roleReports: async () => null,
      close: async () => {},
    };
  }

  const driver = selectDriver(env);

  if (driver === "pglite") {
    throw new Error(
      "The worker's three roles log in to a PostgreSQL server, and a " +
        "PGlite database has no logins: a worker on PGlite runs only inside " +
        "requestport start, which asks for the embedded exception. Run this " +
        "worker on PostgreSQL, with its three logins.",
    );
  }

  const sizes = { ...WORKER_POOL_SIZES, ...options.poolSizes };
  const guards = {} as Record<
    WorkerStorageRole,
    ReturnType<typeof createDatabaseRoleGuard>
  >;
  const storageFor = (role: WorkerStorageRole): Storage => {
    guards[role] = createDatabaseRoleGuard({
      env,
      ...(options.guard?.modes === undefined
        ? {}
        : { modes: options.guard.modes }),
      ...(options.guard?.write === undefined
        ? {}
        : { write: options.guard.write }),
      surface: workerSurface,
      expectedGroup: WORKER_GROUP_ROLES[role],
      storage: role,
      announcePassed: true,
    });
    return createStorage({
      driver,
      connectionString: () => {
        if (driver === "pg") refuseUnapprovedSharedPgDatabase(urls[role], env);
        return urls[role];
      },
      ...(driver === "pg"
        ? { pool: { ...PG_POOL_LIMITS, max: sizes[role] } }
        : {}),
      guard: guards[role],
      // A unit binds its tenant on the processor's transaction (`withTenant`
      // below), never through a pool read. "off" keeps a pool read handed to
      // tenant-context's `withTenant` on one of these handles on the pool, as
      // it ran before G.5 while the application variable was unset, rather
      // than in a bound transaction as this login (manifest-g.md §2.2).
      tenantBinding: "off",
      // The construction token this was handed, if any, which createStorage
      // asks for while the host's handoff is set (`client.ts`).
      ...withHostConstructionToken({}, token),
    });
  };
  const dispatcher = storageFor("dispatcher");
  const processor = storageFor("processor");
  const maintenance = storageFor("maintenance");

  return {
    bound: true,
    dispatcher: dispatcher.db,
    maintenance: maintenance.db,
    withTenant: async (organizationId, work) => {
      const organization = organizationIdOf(organizationId);

      return processor.transaction(async (tx) => {
        await bindTenant(tx, organization);
        return work(tx);
      });
    },
    resolveJobOrganization: (kind, id) =>
      resolveJobOrganizationOn(processor.db, kind, id),
    roleReports: async () => {
      await Promise.all([
        dispatcher.ready(),
        processor.ready(),
        maintenance.ready(),
      ]);
      return {
        dispatcher: guards.dispatcher.report(),
        processor: guards.processor.report(),
        maintenance: guards.maintenance.report(),
      };
    },
    close: async () => {
      await Promise.all([
        dispatcher.close(),
        processor.close(),
        maintenance.close(),
      ]);
    },
  };
}
