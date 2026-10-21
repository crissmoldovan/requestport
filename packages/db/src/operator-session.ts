import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BootstrapOwnerRepository } from "@requestport/domain";
import type * as Pg from "pg";

import { createStorage, driverPoolOf, type Storage } from "./client.js";
import { refuseUnapprovedSharedPgDatabase } from "./database-url.js";
import type { MigrationReport, migrate as migrateStorage } from "./migrate.js";
import { createFoundationRepository } from "./repositories/foundation-repository.js";
import {
  createDatabaseRoleGuard,
  DatabaseRoleGuardError,
  DatabaseSurfaceError,
  declaredDatabaseSurface,
  REQUESTPORT_GROUP_ROLES,
} from "./role-guard.js";
import { WORKER_GROUP_ROLES } from "./tenant-context.js";

/*
 * The operator's database work for `requestport start` on pg (Plan 13, H.4;
 * manifest-h.md §2.3.1 Rules 2 and 3, §2.4; ruling 158, item 1): the
 * preflight, the claim with its session lock, the journal read, migrate and
 * provisioning, over the owner's connection, in that order; and the
 * check-only step that `requestport owner rotate-credential` runs in their
 * place (ruling 163, item 3), which reads the catalogue, the journal and the
 * migrations folder's own journal file, and creates, changes and migrates
 * nothing. It lives here, reached through `./wiring`, so that the queries are
 * this package's and the tenant-scope sweep reads them
 * (`tenant-scope-sweep.exceptions.ts`).
 *
 * `openOperatorSession` builds the owner's storage from the owner URL it is
 * handed. The session answers results, and hands the storage to one thing
 * outside this module: the migrator its caller passes to `migrate`, which
 * is `@requestport/db/migrate`'s `migrate` (`requestport start`'s operator
 * step). For the bootstrap it answers a foundation repository over the
 * storage. The migrator is passed in, not imported, so that this module, in
 * `./wiring`'s graph and so in the web's and the Trigger.dev worker's,
 * brings no migrator into either. It opens only in a
 * process that has declared `operator` (or a Vitest process, `test`), as
 * the private CLI's root does (`wiring.ts`, `assertDeclaredDatabaseSurface`).
 *
 * The four login passwords never appear in a statement: each `CREATE ROLE`
 * and `ALTER ROLE … PASSWORD` carries a SCRAM-SHA-256 verifier computed here
 * (`scramSha256Verifier`), so a server's statement log holds no password.
 */

/** The instance's four logins, keyed as `WORKER_DATABASE_URL_VARIABLES` keys the worker's three. */
export type InstanceLoginKind =
  | "application"
  | "dispatcher"
  | "processor"
  | "maintenance";

export const INSTANCE_LOGIN_KINDS: readonly InstanceLoginKind[] = Object.freeze(
  ["application", "dispatcher", "processor", "maintenance"],
);

/** The one group each login is a member of after provisioning, and of no other. */
export const INSTANCE_LOGIN_GROUPS: Readonly<
  Record<InstanceLoginKind, string>
> = Object.freeze({
  application: "requestport_application",
  ...WORKER_GROUP_ROLES,
});

const LOGIN_SUFFIXES: Readonly<Record<InstanceLoginKind, string>> =
  Object.freeze({
    application: "application",
    dispatcher: "dispatcher",
    processor: "tenant_processor",
    maintenance: "maintenance",
  });

/**
 * An instance id: 8 to 32 of `a-z` and `0-9`. So each login's name,
 * `rp_<id>_<kind>`, is at most 52 bytes (PostgreSQL's limit is 63), needs no
 * quoting, and can never be one of the groups' `requestport_…` names.
 */
export const INSTANCE_ID_PATTERN = /^[a-z0-9]{8,32}$/u;

/** A login password: URL-safe, so a login's URL needs no escaping, and long enough to be a secret. */
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{32,}$/u;

/**
 * The session-level advisory lock a start holds for the whole of its
 * database work: the bytes of "RPCLAIMS" as a bigint. `migrate()`'s own is
 * "RPMIGRAT" (`MIGRATION_LOCK_KEY`), a different key, taken on another
 * connection.
 */
export const INSTANCE_CLAIM_LOCK_KEY = "5931314704038841683";

/** A refusal the session raises before it changes anything, or that rolls its transaction back. */
export type OperatorRefusalReason =
  | "owner_attributes"
  | "owner_admin_option"
  | "claimed_by_another_instance"
  | "instance_logins_exist"
  | "journal_without_claim"
  | "provisioned_attributes"
  | "provisioned_groups"
  | "not_claimed"
  | "migrations_pending";

export class OperatorRefusalError extends Error {
  readonly reason: OperatorRefusalReason;

  constructor(reason: OperatorRefusalReason, message: string) {
    super(message);
    this.name = "OperatorRefusalError";
    this.reason = reason;
  }
}

/**
 * The `owner_attributes` refusal's text: what the owner URL's role lacks,
 * why it needs it, and what to run (`alter`, the attributes for `ALTER
 * ROLE`).
 */
function ownerAttributesMessage(
  role: string,
  missing: readonly string[],
  alter: string,
): string {
  return (
    `The owner URL's role, ${role}, is not a superuser and lacks ${missing.join(" and ")}. ` +
    "RequestPort's migrations create a role that bypasses row-level security, and a start creates " +
    "this instance's four logins, so the owner must be a superuser, or have both BYPASSRLS and CREATEROLE. " +
    `As a superuser, run ALTER ROLE ${role} ${alter}; or give an owner URL whose role has them.`
  );
}

/**
 * The `owner_attributes` refusal for an owner URL whose role the session's
 * role guard refused, judging `operator`, as `cannot_bypass_row_security`
 * alone: a role that is neither a superuser nor `BYPASSRLS`, logged in as
 * itself. Since I.2 step 5 the operator surface's role check enforces, so
 * such a role is refused when the session first connects, before `preflight`
 * can read its attributes. This says what `preflight` says, with what to run.
 * Whether the role has `CREATEROLE` is not known, since nothing could be
 * read, so the remedy names it conditionally. Anything else is not this
 * refusal (`undefined`), and is thrown as it is.
 */
export function ownerRefusedByRoleGuard(
  error: unknown,
): OperatorRefusalError | undefined {
  if (!(error instanceof DatabaseRoleGuardError)) return undefined;
  const { check, surface, role, sessionRole, objections } = error.finding;
  if (
    check !== "role" ||
    surface !== "operator" ||
    role === undefined ||
    sessionRole !== undefined ||
    objections.length !== 1 ||
    objections[0] !== "cannot_bypass_row_security"
  ) {
    return undefined;
  }
  return new OperatorRefusalError(
    "owner_attributes",
    ownerAttributesMessage(
      role,
      ["BYPASSRLS"],
      "BYPASSRLS, with CREATEROLE too if it lacks that",
    ),
  );
}

function refuseInstanceId(instanceId: string): void {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error(
      "An instance id is 8 to 32 of a-z and 0-9 (INSTANCE_ID_PATTERN).",
    );
  }
}

/** The four logins' names for `instanceId`: `rp_<id>_application`, `_dispatcher`, `_tenant_processor`, `_maintenance`. */
export function instanceLoginNames(
  instanceId: string,
): Readonly<Record<InstanceLoginKind, string>> {
  refuseInstanceId(instanceId);
  return Object.freeze(
    Object.fromEntries(
      INSTANCE_LOGIN_KINDS.map((kind) => [
        kind,
        `rp_${instanceId}_${LOGIN_SUFFIXES[kind]}`,
      ]),
    ) as Record<InstanceLoginKind, string>,
  );
}

/**
 * The migrations this package carries: `packages/db/migrations` in the
 * repository, the folder `migrate()` reads when it is given none, resolved
 * the same way, from this module's directory, which is `migrate.ts`'s.
 * `requestport start` names it to `OperatorSession.migrate` and checks that
 * it exists first (ruling 155), so the path a refusal names is the path the
 * migrator would have read.
 */
export function packagedMigrationsFolder(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
}

/*
 * The owner URL's query parameters a login's URL keeps: how the server is
 * reached and verified. Everything else (`options`, `application_name`, a
 * client certificate) is the owner's own and is not passed on.
 */
const LOGIN_URL_PARAMETERS = ["sslmode", "sslrootcert"] as const;

/**
 * Each login's URL: the owner URL's scheme, host, port and database, and
 * its `sslmode` and `sslrootcert`, with the login's name and password in
 * place of the owner's. The passwords are URL-safe, so none is escaped.
 */
export function instanceLoginUrls(
  ownerUrl: string,
  instanceId: string,
  passwords: Readonly<Record<InstanceLoginKind, string>>,
): Readonly<Record<InstanceLoginKind, string>> {
  const names = instanceLoginNames(instanceId);
  checkedPasswords(passwords);
  let owner: URL;
  try {
    owner = new URL(ownerUrl);
  } catch {
    throw new Error("The owner URL is not a URL.");
  }
  return Object.freeze(
    Object.fromEntries(
      INSTANCE_LOGIN_KINDS.map((kind) => {
        const url = new URL(
          `${owner.protocol}//${owner.host}${owner.pathname}`,
        );
        url.username = names[kind];
        url.password = passwords[kind];
        for (const parameter of LOGIN_URL_PARAMETERS) {
          const value = owner.searchParams.get(parameter);
          if (value !== null) url.searchParams.set(parameter, value);
        }
        return [kind, url.toString()];
      }),
    ) as Record<InstanceLoginKind, string>,
  );
}

/** The comment that makes a login part of an instance's claim on a database (§2.3.1, Rule 3). */
export function instanceClaimComment(
  instanceId: string,
  database: string,
): string {
  refuseInstanceId(instanceId);
  return `requestport instance ${instanceId} database ${database}`;
}

const CLAIM_COMMENT = /^requestport instance (\S+) database (.+)$/su;

/** The instance and database a role's comment claims, or `undefined` when it is not a claim. */
export function parseInstanceClaim(
  comment: string | null | undefined,
): { instanceId: string; database: string } | undefined {
  const match =
    comment === null || comment === undefined
      ? null
      : CLAIM_COMMENT.exec(comment);
  return match
    ? { instanceId: match[1] as string, database: match[2] as string }
    : undefined;
}

/**
 * A SCRAM-SHA-256 verifier for `password`, in the form PostgreSQL stores and
 * accepts in place of a password (`SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`,
 * RFC 5802 and RFC 7677). Only URL-safe ASCII passwords are taken, which
 * SASLprep leaves as they are.
 */
export function scramSha256Verifier(
  password: string,
  {
    salt = randomBytes(16),
    iterations = 4096,
  }: { salt?: Buffer; iterations?: number } = {},
): string {
  if (!PASSWORD_PATTERN.test(password)) {
    throw new Error(
      "A login password is 32 or more of A-Z, a-z, 0-9, _ and -.",
    );
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** An identifier this module wrote itself, held to `a-z`, `0-9` and `_`, double-quoted. */
function quoteIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(name) || name.length > 63) {
    throw new Error("Not an identifier this module writes.");
  }
  return `"${name}"`;
}

/** A string literal, as `pg`'s `escapeLiteral` writes one: quotes doubled, and `E'…'` with backslashes doubled when it holds one. */
function quoteLiteral(value: string): string {
  const quoted = value.replaceAll("'", "''");
  return value.includes("\\")
    ? ` E'${quoted.replaceAll("\\", "\\\\")}'`
    : `'${quoted}'`;
}

/** The claim's statements for one login: created `LOGIN` with its password, in no group (§2.3.1, Rule 3). */
/**
 * Clears `createrole_self_grant` until the end of the transaction it runs
 * in, on PostgreSQL 16 and later, where the setting exists (the claim's).
 */
export const CLEAR_CREATEROLE_SELF_GRANT_STATEMENT =
  "do $$ begin if pg_catalog.current_setting('server_version_num')::int >= 160000 then " +
  "set local createrole_self_grant = ''; end if; end $$";

export function createLoginStatement(login: string, verifier: string): string {
  return `create role ${quoteIdentifier(login)} login password ${quoteLiteral(verifier)}`;
}

export function commentLoginStatement(login: string, comment: string): string {
  return `comment on role ${quoteIdentifier(login)} is ${quoteLiteral(comment)}`;
}

/**
 * Provisioning's statement for one login: its password again, and only the
 * three attributes every owner the preflight admits may name (ruling 107).
 */
export function alterLoginStatement(login: string, verifier: string): string {
  return `alter role ${quoteIdentifier(login)} with login nobypassrls nocreaterole password ${quoteLiteral(verifier)}`;
}

export function grantGroupStatement(group: string, login: string): string {
  return `grant ${quoteIdentifier(group)} to ${quoteIdentifier(login)}`;
}

export function revokeGroupStatement(group: string, login: string): string {
  return `revoke ${quoteIdentifier(group)} from ${quoteIdentifier(login)}`;
}

const OWNER_ATTRIBUTES_SQL = `select current_user::text as role,
       pg_catalog.current_database()::text as database,
       r.rolsuper as superuser, r.rolbypassrls as bypassrls, r.rolcreaterole as createrole
  from pg_catalog.pg_roles r
 where r.rolname = current_user`;

/*
 * `pg_has_role` raises on a role that does not exist, and on a fresh cluster
 * the groups do not exist until `0019` and `0020` create them, so each is
 * looked up with `to_regrole` first.
 */
const GROUP_ADMIN_SQL = `select g.name as group_role,
       pg_catalog.to_regrole(g.name) is not null as present,
       case when pg_catalog.to_regrole(g.name) is null then null
            else pg_catalog.pg_has_role(current_user, pg_catalog.to_regrole(g.name)::oid, 'MEMBER WITH ADMIN OPTION')
       end as admin
  from unnest($1::text[]) with ordinality as g(name, position)
 order by g.position`;

/** This instance's four names, and every role whose comment has a claim's form. */
const INSTANCE_ROLES_SQL = `select r.rolname::text as login,
       pg_catalog.shobj_description(r.oid, 'pg_authid') as comment
  from pg_catalog.pg_roles r
 where r.rolname = any($1::text[])
    or pg_catalog.shobj_description(r.oid, 'pg_authid') like 'requestport instance %'
 order by r.rolname`;

const JOURNAL_PRESENT_SQL = `select pg_catalog.to_regclass('drizzle.__drizzle_migrations') is not null as present`;
const JOURNAL_ENTRIES_SQL = `select count(*)::int as entries from drizzle.__drizzle_migrations`;
/** Each journal row's `created_at`: the `when` Drizzle's migrator writes for each migration it applies. The migrator itself compares only the newest row's; the check-only step matches every row by it, so it also refuses a hole below the newest. */
const JOURNAL_TIMESTAMPS_SQL = `select created_at::text as created_at from drizzle.__drizzle_migrations`;

/** Every `pg_auth_members` row whose member is one of the logins, one row each. */
const LOGIN_MEMBERSHIPS_SQL = `select m.rolname::text as login, g.rolname::text as group_role
  from pg_catalog.pg_auth_members am
  join pg_catalog.pg_roles m on m.oid = am.member
  join pg_catalog.pg_roles g on g.oid = am.roleid
 where m.rolname = any($1::text[])
 order by 1, 2`;

const LOGIN_ATTRIBUTES_SQL = `select r.rolname::text as login, r.rolcanlogin as canlogin,
       r.rolsuper as superuser, r.rolcreatedb as createdb, r.rolreplication as replication,
       r.rolbypassrls as bypassrls, r.rolcreaterole as createrole
  from pg_catalog.pg_roles r
 where r.rolname = any($1::text[])
 order by 1`;

const LOCK_SQL = "select pg_catalog.pg_advisory_lock($1::bigint)";
const UNLOCK_SQL = "select pg_catalog.pg_advisory_unlock($1::bigint)";

export interface OperatorSessionOptions {
  /** The owner's connection string, from the data directory's `owner.json`; never from an environment variable. */
  ownerUrl: string;
  /** Read for the shared-database opt-ins and by the role guard; the owner URL is never in it. */
  env: NodeJS.ProcessEnv;
}

export interface OwnerPreflight {
  /** `current_user` on the owner's connection. */
  role: string;
  /** `current_database()`: the database this start claims. */
  database: string;
  superuser: boolean;
  /** The groups that do not exist yet, which this owner's migrations will create. */
  absentGroups: string[];
}

export interface InstanceLogins {
  instanceId: string;
  /** Each login's password, from `secrets.json`. */
  passwords: Readonly<Record<InstanceLoginKind, string>>;
  /**
   * Called inside the transaction, after its last statement and before its
   * `COMMIT`. For the first start's crash tests (§2.3.1, B5 and B8); the CLI
   * passes none.
   */
  beforeCommit?: () => void | Promise<void>;
}

export type ClaimOutcome = "claimed" | "already-claimed";

/** What the check-only step found: the preflight's answer, and how many migrations the folder carries, each of which the journal holds. */
export interface InstanceCheck {
  preflight: OwnerPreflight;
  migrations: number;
}

export interface ProvisionedLogin {
  kind: InstanceLoginKind;
  login: string;
  group: string;
}

/**
 * The owner's connection for one start, holding the claim's lock from
 * `openOperatorSession` until `close()`. Each step refuses until the one
 * before it has run: preflight, claim, migrate, provision, and then the
 * bootstrap's repository. Every step is idempotent, and a resumed start runs
 * them all again (§2.3.1, Rule 2). A credential rotation runs the check-only
 * step in place of the first four (`check`), and then the bootstrap's
 * repository.
 */
export interface OperatorSession {
  /**
   * The owner's attributes (a superuser, or `BYPASSRLS` and `CREATEROLE`),
   * and `ADMIN OPTION` on each group that already exists (§2.3, §2.4).
   * Refuses with `OperatorRefusalError` before anything is created.
   */
  preflight(): Promise<OwnerPreflight>;
  /**
   * The claim (§2.3.1, Rule 3): refuses when this database holds another
   * instance's claim, or holds applied migrations and no claim of this
   * instance; answers `already-claimed` when this instance's four logins
   * already claim it; otherwise, in one transaction, creates the four logins
   * in no group, each commented with this instance and this database.
   */
  claim(logins: InstanceLogins): Promise<ClaimOutcome>;
  /**
   * `migrator` on the owner's storage, from `migrationsFolder`:
   * `@requestport/db/migrate`'s `migrate`, which takes a connection of its
   * own and its own lock.
   */
  migrate(options: {
    migrationsFolder: string;
    migrator: typeof migrateStorage;
  }): Promise<MigrationReport>;
  /**
   * Provisioning, in one transaction: each login's password again, `LOGIN
   * NOBYPASSRLS NOCREATEROLE`, its one group granted and any other revoked;
   * then each login's five attributes and its memberships read back, and a
   * refusal that rolls it all back when any attribute is true or a login is
   * in anything but its one group (ruling 107).
   */
  provision(logins: InstanceLogins): Promise<ProvisionedLogin[]>;
  /**
   * The check-only step (ruling 163, item 3), for `requestport owner
   * rotate-credential`, which rotates the credential and creates, changes and
   * migrates nothing else. It reads `migrationsFolder`'s journal file, runs the preflight,
   * then finds this instance's claim as `claim` does, refusing as `claim`
   * refuses, and with `not_claimed` where `claim` would create it; then it
   * refuses with `migrations_pending`, saying to run requestport start, when
   * the database's journal holds no row for a migration the folder carries
   * (matched by its `when`, which is the row's `created_at`). It creates,
   * changes and migrates nothing, and the session then refuses `claim`,
   * `migrate` and `provision`.
   */
  check(options: {
    instanceId: string;
    migrationsFolder: string;
  }): Promise<InstanceCheck>;
  /**
   * A foundation repository over the owner's storage, for `bootstrapOwner`,
   * as the private CLI composes one: after provisioning, or after the
   * check-only step.
   */
  bootstrapRepository(): BootstrapOwnerRepository;
  /** Releases the claim's lock and closes the owner's storage. Idempotent. */
  close(): Promise<void>;
}

type Step = "opened" | "preflighted" | "claimed" | "migrated" | "provisioned";
const STEPS: readonly Step[] = [
  "opened",
  "preflighted",
  "claimed",
  "migrated",
  "provisioned",
];

async function lockClaims(client: Pg.PoolClient): Promise<void> {
  await client.query(LOCK_SQL, [INSTANCE_CLAIM_LOCK_KEY]);
}

async function unlockClaims(client: Pg.PoolClient): Promise<void> {
  await client.query(UNLOCK_SQL, [INSTANCE_CLAIM_LOCK_KEY]);
}

async function inTransaction<T>(
  client: Pg.PoolClient,
  work: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

interface OwnerAttributes {
  role: string;
  database: string;
  superuser: boolean;
  bypassrls: boolean;
  createrole: boolean;
}

async function readOwnerAttributes(
  client: Pg.PoolClient,
): Promise<OwnerAttributes> {
  const { rows } = await client.query<OwnerAttributes>(OWNER_ATTRIBUTES_SQL);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("The owner's role is not in pg_roles.");
  }
  return row;
}

async function readGroupAdmin(
  client: Pg.PoolClient,
): Promise<{ group_role: string; present: boolean; admin: boolean | null }[]> {
  const { rows } = await client.query<{
    group_role: string;
    present: boolean;
    admin: boolean | null;
  }>(GROUP_ADMIN_SQL, [[...REQUESTPORT_GROUP_ROLES]]);
  return rows;
}

async function readInstanceRoles(
  client: Pg.PoolClient,
  names: readonly string[],
): Promise<{ login: string; comment: string | null }[]> {
  const { rows } = await client.query<{
    login: string;
    comment: string | null;
  }>(INSTANCE_ROLES_SQL, [[...names]]);
  return rows;
}

/** The migration journal's entries: 0 when `drizzle.__drizzle_migrations` does not exist. */
async function readJournalEntries(client: Pg.PoolClient): Promise<number> {
  const present = await client.query<{ present: boolean }>(JOURNAL_PRESENT_SQL);
  if (!present.rows[0]?.present) return 0;
  const { rows } = await client.query<{ entries: number }>(JOURNAL_ENTRIES_SQL);
  return rows[0]?.entries ?? 0;
}

/** The journal's `created_at` values, as text: none when `drizzle.__drizzle_migrations` does not exist. */
async function readJournalTimestamps(
  client: Pg.PoolClient,
): Promise<Set<string>> {
  const present = await client.query<{ present: boolean }>(JOURNAL_PRESENT_SQL);
  if (!present.rows[0]?.present) return new Set();
  const { rows } = await client.query<{ created_at: string }>(
    JOURNAL_TIMESTAMPS_SQL,
  );
  return new Set(rows.map((row) => row.created_at));
}

/**
 * The migrations `folder` carries, from its `meta/_journal.json`: each one's
 * tag and `when`, the value the journal's `created_at` records for it once
 * applied (`migrate.ts` reads the same file the same way).
 */
function carriedMigrations(folder: string): { tag: string; when: number }[] {
  const journal = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string; when: number }[] };
  return journal.entries.map(({ tag, when }) => ({ tag, when }));
}

async function readLoginMemberships(
  client: Pg.PoolClient,
  names: readonly string[],
): Promise<{ login: string; group_role: string }[]> {
  const { rows } = await client.query<{ login: string; group_role: string }>(
    LOGIN_MEMBERSHIPS_SQL,
    [[...names]],
  );
  return rows;
}

interface LoginAttributes {
  login: string;
  canlogin: boolean;
  superuser: boolean;
  createdb: boolean;
  replication: boolean;
  bypassrls: boolean;
  createrole: boolean;
}

async function readLoginAttributes(
  client: Pg.PoolClient,
  names: readonly string[],
): Promise<LoginAttributes[]> {
  const { rows } = await client.query<LoginAttributes>(LOGIN_ATTRIBUTES_SQL, [
    [...names],
  ]);
  return rows;
}

/** Runs statements this module built (`createLoginStatement` and the rest), one at a time. */
async function runStatements(
  client: Pg.PoolClient,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await client.query(statement);
  }
}

function checkedPasswords(
  passwords: Readonly<Record<InstanceLoginKind, string>>,
): Readonly<Record<InstanceLoginKind, string>> {
  for (const kind of INSTANCE_LOGIN_KINDS) {
    if (!PASSWORD_PATTERN.test(passwords[kind] ?? "")) {
      throw new Error(
        `The ${kind} login's password is not 32 or more of A-Z, a-z, 0-9, _ and -.`,
      );
    }
  }
  return passwords;
}

/** Whether two lists hold the same names, each once. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return (
    a.length === left.length &&
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}

/**
 * This instance's claim on `owner.database`, as the roles' comments state it
 * (§2.3.1, Rule 3): `"claimed"` when its four logins exist and each claims
 * this database for it; `"unclaimed"` when none of them exists and no role
 * claims this database for it. Refuses when another instance claims the
 * database, or when this instance's logins are there but are not its whole
 * claim on it. Reads the catalogue only.
 */
async function findClaim(
  client: Pg.PoolClient,
  instanceId: string,
  { database, role }: OwnerAttributes,
): Promise<"claimed" | "unclaimed"> {
  const ownNames = Object.values(instanceLoginNames(instanceId));
  const roles = await readInstanceRoles(client, ownNames);
  const claimsHere = roles.flatMap((row) => {
    const claim = parseInstanceClaim(row.comment);
    return claim?.database === database
      ? [{ login: row.login, instanceId: claim.instanceId }]
      : [];
  });
  const others = claimsHere.filter((claim) => claim.instanceId !== instanceId);
  if (others.length > 0) {
    const ids = [...new Set(others.map((claim) => claim.instanceId))];
    throw new OperatorRefusalError(
      "claimed_by_another_instance",
      `Database ${database} is claimed by another RequestPort instance (${ids.join(", ")}): ` +
        `the comments on ${others.map((claim) => claim.login).join(", ")} say so. One instance serves one database. ` +
        "Start from the data directory that initialised it, or give an owner URL that names another database.",
    );
  }
  const claimedByThis = claimsHere.map((claim) => claim.login);
  const existing = roles
    .map((row) => row.login)
    .filter((login) => ownNames.includes(login));
  if (sameNames(claimedByThis, ownNames) && sameNames(existing, ownNames)) {
    return "claimed";
  }
  if (existing.length > 0 || claimedByThis.length > 0) {
    const elsewhere = [
      ...new Set(
        roles.flatMap((row) => {
          const claim = parseInstanceClaim(row.comment);
          return claim?.instanceId === instanceId && claim.database !== database
            ? [claim.database]
            : [];
        }),
      ),
    ];
    throw new OperatorRefusalError(
      "instance_logins_exist",
      `This instance's logins (${[...new Set([...existing, ...claimedByThis])].join(", ")}) exist, ` +
        `but are not this instance's whole claim on database ${database}.` +
        (elsewhere.length > 0
          ? ` Their comments claim database ${elsewhere.join(", ")}: if this database was renamed from ` +
            "that one, rename it back, or re-comment the four logins for this name " +
            `(COMMENT ON ROLE … IS '${instanceClaimComment(instanceId, database)}').`
          : " A start never leaves them so, since its claim is one transaction. If nothing uses them, " +
            `drop them (as ${role} or a superuser: DROP ROLE …), then start again.`),
    );
  }
  return "unclaimed";
}

/**
 * Opens the owner's connection for one start and takes the claim's lock on
 * it, waiting while another start holds it. Refuses at once, before it
 * builds anything, unless this process has declared `operator` (or `test`).
 * Builds the owner's storage from `ownerUrl` alone, on pg, with a role guard
 * of its own judging the declared surface, and refuses production's or
 * staging's database first on every connection
 * (`refuseUnapprovedSharedPgDatabase`, over `env`). An owner whose role that
 * guard refuses as `operator` for being neither a superuser nor `BYPASSRLS`
 * is refused with `preflight`'s `owner_attributes` refusal
 * (`ownerRefusedByRoleGuard`).
 */
export async function openOperatorSession({
  ownerUrl,
  env,
}: OperatorSessionOptions): Promise<OperatorSession> {
  const declared = declaredDatabaseSurface();
  if (declared !== "operator" && declared !== "test") {
    throw new DatabaseSurfaceError(
      declared === undefined
        ? "RequestPort database surface not declared: the operator session " +
            'opens nothing until its entry point has called declareDatabaseSurface("operator").'
        : `RequestPort database surface is declared as ${declared}; the ` +
            "operator session opens nothing in a process declared as anything but operator.",
    );
  }
  const storage: Storage = createStorage({
    driver: "pg",
    connectionString: () => {
      refuseUnapprovedSharedPgDatabase(ownerUrl, env);
      return ownerUrl;
    },
    guard: createDatabaseRoleGuard({ env }),
    tenantBinding: "off",
  });
  let client: Pg.PoolClient;
  try {
    client = await (driverPoolOf(storage) as Pg.Pool).connect();
  } catch (error) {
    await storage.close();
    throw ownerRefusedByRoleGuard(error) ?? error;
  }
  try {
    await lockClaims(client);
  } catch (error) {
    client.release(true);
    await storage.close();
    throw error;
  }

  let step: Step = "opened";
  /** Set once the check-only step has run, whatever its outcome: no step after it may create, change or migrate. */
  let checkOnly = false;
  /** Set once the check-only step has passed: only then may the rotation read the repository. */
  let checked = false;
  let owner: OwnerAttributes | undefined;
  let closing: Promise<void> | undefined;

  const requireStep = (needed: Step, operation: string) => {
    if (closing !== undefined) {
      throw new Error(`${operation}: the operator session is closed.`);
    }
    if (checkOnly) {
      throw new Error(
        `${operation}: this session ran the check-only step, which creates, changes and migrates nothing.`,
      );
    }
    if (STEPS.indexOf(step) < STEPS.indexOf(needed)) {
      throw new Error(
        `${operation} needs a session that is ${needed}; this one is ${step}.`,
      );
    }
  };
  const ownerOf = () => owner as OwnerAttributes;

  /** The check-only step's body (`check`); the session's step flags are set by its caller. */
  const runCheck = async (
    instanceId: string,
    migrationsFolder: string,
  ): Promise<InstanceCheck> => {
    // The folder first: one it cannot read refuses before any statement.
    const carried = carriedMigrations(migrationsFolder);
    const preflight = await session.preflight();
    if ((await findClaim(client, instanceId, ownerOf())) === "unclaimed") {
      throw new OperatorRefusalError(
        "not_claimed",
        `Database ${preflight.database} holds no claim of this instance (${instanceId}), and this check creates ` +
          "none: this instance did not initialise this database, or its logins were dropped. Run requestport start.",
      );
    }
    const recorded = await readJournalTimestamps(client);
    const lacking = carried.filter(
      (migration) => !recorded.has(String(migration.when)),
    );
    if (lacking.length > 0) {
      throw new OperatorRefusalError(
        "migrations_pending",
        `Database ${preflight.database}'s migration journal lacks ${lacking.length} migration${lacking.length === 1 ? "" : "s"} ` +
          `this requestport carries (${lacking.map((migration) => migration.tag).join(", ")}). A credential rotation ` +
          "never migrates: run requestport start first, which migrates.",
      );
    }
    checked = true;
    return { preflight, migrations: carried.length };
  };

  const session: OperatorSession = {
    async preflight() {
      requireStep("opened", "preflight");
      const attributes = await readOwnerAttributes(client);
      if (!attributes.superuser) {
        const missing = [
          ...(attributes.bypassrls ? [] : ["BYPASSRLS"]),
          ...(attributes.createrole ? [] : ["CREATEROLE"]),
        ];
        if (missing.length > 0) {
          throw new OperatorRefusalError(
            "owner_attributes",
            ownerAttributesMessage(attributes.role, missing, missing.join(" ")),
          );
        }
      }
      const groups = await readGroupAdmin(client);
      const withoutAdmin = attributes.superuser
        ? []
        : groups
            .filter((group) => group.present && group.admin !== true)
            .map((group) => group.group_role);
      if (withoutAdmin.length > 0) {
        throw new OperatorRefusalError(
          "owner_admin_option",
          `The groups ${withoutAdmin.join(", ")} already exist on this cluster, and the owner URL's role, ` +
            `${attributes.role}, holds no ADMIN OPTION on them, so it can neither run the migrations that grant ` +
            "them nor grant this instance's logins their groups (PostgreSQL 16 and later need it). " +
            "Run start with an owner URL naming the role that created them, or a superuser; or have that role run " +
            `GRANT ${withoutAdmin.join(", ")} TO ${attributes.role} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;`,
        );
      }
      owner = attributes;
      step = "preflighted";
      return {
        role: attributes.role,
        database: attributes.database,
        superuser: attributes.superuser,
        absentGroups: groups
          .filter((group) => !group.present)
          .map((group) => group.group_role),
      };
    },

    async claim({ instanceId, passwords, beforeCommit }) {
      requireStep("preflighted", "claim");
      const { database } = ownerOf();
      const names = instanceLoginNames(instanceId);
      checkedPasswords(passwords);

      if ((await findClaim(client, instanceId, ownerOf())) === "claimed") {
        step = "claimed";
        return "already-claimed";
      }
      const entries = await readJournalEntries(client);
      if (entries > 0) {
        throw new OperatorRefusalError(
          "journal_without_claim",
          `Database ${database} already holds ${entries} applied migration${entries === 1 ? "" : "s"} and no claim ` +
            "of this instance: another instance, or a migration run by hand, initialised it. Start from the data " +
            "directory that initialised it, or give an owner URL that names an empty database.",
        );
      }

      const comment = instanceClaimComment(instanceId, database);
      await inTransaction(client, async () => {
        await runStatements(client, [
          // On PostgreSQL 16 and later, a server whose createrole_self_grant
          // includes inherit or set would make the owner an inheriting member
          // of each login it creates, and so, once provisioning grants each
          // login its group, of every group: able to execute the worker's
          // functions 0023 takes from it (ruling 215). Cleared for this
          // transaction only; older servers have no such setting.
          CLEAR_CREATEROLE_SELF_GRANT_STATEMENT,
          ...INSTANCE_LOGIN_KINDS.map((kind) =>
            createLoginStatement(
              names[kind],
              scramSha256Verifier(passwords[kind]),
            ),
          ),
          ...INSTANCE_LOGIN_KINDS.map((kind) =>
            commentLoginStatement(names[kind], comment),
          ),
        ]);
        await beforeCommit?.();
      });
      step = "claimed";
      return "claimed";
    },

    async migrate({ migrationsFolder, migrator }) {
      requireStep("claimed", "migrate");
      const report = await migrator(storage, { migrationsFolder });
      step = "migrated";
      return report;
    },

    async provision({ instanceId, passwords, beforeCommit }) {
      requireStep("migrated", "provision");
      const { role } = ownerOf();
      const names = instanceLoginNames(instanceId);
      const ownNames = Object.values(names);
      checkedPasswords(passwords);
      const kindOf = new Map(
        INSTANCE_LOGIN_KINDS.map((kind) => [names[kind], kind] as const),
      );

      const provisioned = await inTransaction(client, async () => {
        await runStatements(
          client,
          INSTANCE_LOGIN_KINDS.flatMap((kind) => [
            alterLoginStatement(
              names[kind],
              scramSha256Verifier(passwords[kind]),
            ),
            grantGroupStatement(INSTANCE_LOGIN_GROUPS[kind], names[kind]),
          ]),
        );
        const before = await readLoginMemberships(client, ownNames);
        await runStatements(
          client,
          before
            .filter(
              (row) =>
                row.group_role !==
                INSTANCE_LOGIN_GROUPS[
                  kindOf.get(row.login) as InstanceLoginKind
                ],
            )
            .map((row) => revokeGroupStatement(row.group_role, row.login)),
        );

        const attributes = await readLoginAttributes(client, ownNames);
        const held = attributes.flatMap((row) => {
          const named = [
            ...(row.canlogin ? [] : ["NOLOGIN"]),
            ...(row.superuser ? ["SUPERUSER"] : []),
            ...(row.createdb ? ["CREATEDB"] : []),
            ...(row.replication ? ["REPLICATION"] : []),
            ...(row.bypassrls ? ["BYPASSRLS"] : []),
            ...(row.createrole ? ["CREATEROLE"] : []),
          ];
          return named.length > 0 ? [`${row.login} (${named.join(", ")})`] : [];
        });
        if (held.length > 0 || attributes.length !== ownNames.length) {
          throw new OperatorRefusalError(
            "provisioned_attributes",
            `After provisioning, ${held.join("; ") || "a login is missing"}: a login of this instance must ` +
              `be LOGIN and none of SUPERUSER, CREATEDB, REPLICATION, BYPASSRLS or CREATEROLE, and ${role} ` +
              "may not remove those. As a superuser, ALTER ROLE each login named to remove them; then start again.",
          );
        }

        const after = await readLoginMemberships(client, ownNames);
        const wrong = INSTANCE_LOGIN_KINDS.flatMap((kind) => {
          const groups = after
            .filter((row) => row.login === names[kind])
            .map((row) => row.group_role);
          return groups.length === 1 &&
            groups[0] === INSTANCE_LOGIN_GROUPS[kind]
            ? []
            : [
                `${names[kind]} is in ${groups.join(", ") || "no group"}, not ${INSTANCE_LOGIN_GROUPS[kind]} alone`,
              ];
        });
        if (wrong.length > 0) {
          throw new OperatorRefusalError(
            "provisioned_groups",
            `After provisioning, ${wrong.join("; ")}. ${role} could not revoke the other memberships ` +
              "(PostgreSQL revokes only the grants their grantor made). Have each grantor revoke them, then start again.",
          );
        }
        await beforeCommit?.();
        return INSTANCE_LOGIN_KINDS.map((kind) => ({
          kind,
          login: names[kind],
          group: INSTANCE_LOGIN_GROUPS[kind],
        }));
      });
      step = "provisioned";
      return provisioned;
    },

    async check({ instanceId, migrationsFolder }) {
      requireStep("opened", "check");
      try {
        return await runCheck(instanceId, migrationsFolder);
      } finally {
        // A refused check leaves a check-only session too: claim, migrate and
        // provision are refused after it, whatever its outcome.
        checkOnly = true;
      }
    },

    bootstrapRepository() {
      if (!checked) requireStep("provisioned", "bootstrapRepository");
      else if (closing !== undefined) {
        throw new Error("bootstrapRepository: the operator session is closed.");
      }
      return createFoundationRepository(storage.db);
    },

    close() {
      closing ??= (async () => {
        try {
          await unlockClaims(client);
          client.release();
        } catch (error) {
          client.release(error instanceof Error ? error : true);
        }
        await storage.close();
      })();
      return closing;
    },
  };
  return session;
}
