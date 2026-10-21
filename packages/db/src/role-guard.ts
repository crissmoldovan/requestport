/*
 * The database role guard (Plan 13, Track I.2; manifest-i2.md §2.2, rulings
 * 37 and 45; track-i2.md D9, D21).
 *
 * Three checks about a guarded storage — each composition root's
 * (`wiring.ts`), which gives every storage it builds a guard of its own — and
 * none about a storage built without one, as a test or `migrate()` builds one
 * for itself; the worker's three bound storages have guards of their own,
 * with a fourth check (the group, below):
 *
 * - **The declaration.** Every process that can open a connection declares
 *   which surface it is, once, at its entry point: `application` (the web
 *   server), `worker` (the Trigger.dev worker and `requestport-jobs`),
 *   `operator` (the CLI), `embedded` (`requestport start`'s serving process
 *   on PGlite, below) or `test` (a Vitest setup file). Nothing infers it:
 *   a surface keyed on `VERCEL_ENV` would let a process without the variable
 *   skip the check (ruling 37). The check runs where a guarded storage
 *   reads its connection string, and first inside PGlite's lazy constructor
 *   (D9), so it runs before anything is dialled.
 * - **The role.** On the storage's first use, before that use runs, it reads
 *   the role the connection resolved to — `current_user` — and the login it
 *   connected as — `session_user` — from the catalogue, not the variable the
 *   string came from. For `application` and `worker` it objects to a
 *   superuser, a `BYPASSRLS` role, a role that owns a table in `public`
 *   (itself or through a role it is a member of), and a member of a
 *   superuser or `BYPASSRLS` role, which could `SET ROLE` to it; and it
 *   objects to the same of the login, when that differs, because a session
 *   can `RESET ROLE` to its login (a connection string's `options=-c role=…`
 *   sets `current_user` and leaves the login what it was). For `operator` it
 *   objects to the reverse: a `current_user` that is neither a superuser nor
 *   `BYPASSRLS`, whose integrity check would read an empty view under the
 *   policies and report it clean (§1). `test` is not checked, and neither
 *   is `embedded`.
 * - **`embedded`** (Plan 13, H.4; manifest-h.md §2.6 item 4, ruling 73) is
 *   PGlite's surface: one process, one user, its database inside its data
 *   directory. PGlite's one session is the superuser `postgres` and it has no
 *   other role, so there is no role to judge; row-level security does not
 *   apply to it, which `requestport start` says when it serves on PGlite.
 *   Only a PGlite storage takes it: a guarded storage on any other driver
 *   refuses it, whatever the modes (`client.ts`, which knows the driver).
 * - **The environment.** For `application` (since I.2 step 7, ruling 224
 *   item 2) and `worker` (since I.2b's b6, ruling 217 item 1), it objects to
 *   any owner-capable variable name in the environment the guard was given,
 *   the process's own unless its builder hands it another
 *   (`createWorkerStorages` hands each worker storage's guard the
 *   environment it reads the three from): `DATABASE_URL`, any
 *   `DATABASE_URL_*`, `POSTGRES_*` or `PG*` (`ownerCapableVariableNames`).
 *   Names only, never values. It judges no other surface: `operator` is the
 *   owner's, whose URL it may carry (manifest-i2.md §2.2 names `application`
 *   and `worker`). Renaming an owner URL defeats it, so it is a second line;
 *   the role check is the authority in code, and the owner's names-only
 *   audit of every deployment secret is the authority outside it.
 *
 * - **The group, for a worker storage** (Plan 13, I.2b step b2;
 *   manifest-i2.md §5.2 b2's last item). A guard built with `expectedGroup`
 *   — one of the worker's three storages (`tenant-context.ts`,
 *   `createWorkerStorages`) — also reads which of RequestPort's five group
 *   roles `current_user` is a member of (`GROUP_MEMBERSHIP_SQL`), and
 *   objects unless that is exactly its own group: the dispatcher's storage
 *   in `requestport_dispatcher` and no other, and so on. It is part of the
 *   role check, and runs only when the role check runs (`application` and
 *   `worker`). A composition root's storage has no expected group.
 *
 * **The modes are code, chosen for each check when it runs**, from the
 * surface the guard judges then; nothing in the environment is read for
 * them. A check in warn mode — which no check runs in since I.2 step 7,
 * because every surface's modes enforce every check and a guard's `modes`
 * option can only raise one (below); each check landed in it first
 * (manifest-i2.md §2.2, "Modes") — writes one structured line to the console per storage and check whenever that
 * check's status becomes `warned` or `failed`, records what it found in the
 * guard's report (`report()`, which the worker's `roleReports()` returns
 * for each of its storages), and lets the storage serve. A check in enforce
 * mode that objects throws instead, on every use, and writes no line,
 * though its finding is recorded; a role check that could not run writes
 * its `failed` line and then, in enforce mode, throws the connection's
 * error (in warn mode it would answer `failed`, let the use go ahead, and
 * write again once it ran and objected). In either mode a worker storage's
 * role check writes one `info` line when it passes (`announcePassed`),
 * naming the mode it ran in. Unless the guard is handed `write`, a `passed`
 * line goes to `console.info` and a `warned` or `failed` one to
 * `console.warn` (ruling 215 item 7: Trigger.dev records each
 * `console.warn` as a warning, and b4 found every worker run marked so by
 * its `passed` lines).
 *
 * - **The worker's** (`WORKER_ROLE_GUARD_MODES`; Plan 13, I.2b's b5,
 *   ruling 214 item 2, and b6, ruling 217 item 1): every check enforces —
 *   the declaration, the role, with the group check beside it, and, since
 *   b6, the environment. They are a guard's whenever it judges
 *   `worker` — the storages of a process declared `worker` (the Trigger.dev
 *   worker, `requestport-jobs`, `requestport worker`), and the worker's
 *   three storages wherever `createWorkerStorages` builds them, whose guards
 *   it builds to judge `worker` in any process that has declared a surface
 *   (ruling 215 item 4), `requestport start`'s serving process, which
 *   declares `application`, among them (ruling 72) — and a worker storage's
 *   guard's (`expectedGroup`) whatever it judges, so one used before any
 *   declaration is refused, as a guard with no group is since I.2 step 5
 *   (below).
 * - **Every other guard's** (`ROLE_GUARD_MODES`; I.2 step 5, ruling 221
 *   item 4): the declaration and role checks enforce, for `application` and
 *   `operator`, and for a guard with no group that finds nothing declared,
 *   which is refused: a connection opened before any declaration fails
 *   (manifest-i2.md §2.2); and, since §3 step 7 (ruling 224 item 2), the
 *   environment check, so an `application` storage in a process naming an
 *   owner-capable variable is refused at its first use. Since then the two
 *   sets of modes are the same, every check enforcing; they stay two
 *   because a worker storage's guard takes the worker's whatever surface it
 *   judges.
 * - **A guard's `modes` option raises a check to enforce and relaxes
 *   none:** the stricter of it and the surface's mode is the one used.
 *
 * Nothing here writes: the role check is one `select` over `pg_catalog`,
 * which needs no privilege beyond what every role has.
 */

export type DatabaseSurface =
  | "application"
  | "worker"
  | "operator"
  | "embedded"
  | "test";

export const DATABASE_SURFACES: readonly DatabaseSurface[] = Object.freeze([
  "application",
  "worker",
  "operator",
  "embedded",
  "test",
]);

/*
 * The declaration lives on `globalThis`, under a registered symbol, not in a
 * module variable. A bundler can give one process two copies of this module
 * — Next compiles `instrumentation.ts` apart from the routes, and `client.ts`
 * already meets two builds of one package (its `require`d pg driver) — and a
 * declaration only one copy could see would leave the other undeclared.
 */
const DECLARATION = Symbol.for("requestport.database-surface");

type DeclarationHolder = { [DECLARATION]?: DatabaseSurface };

function holder(): DeclarationHolder {
  return globalThis as DeclarationHolder;
}

/** A declaration this process cannot take. */
export class DatabaseSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseSurfaceError";
  }
}

export const UNDECLARED_SURFACE_MESSAGE =
  "RequestPort database surface not declared: this process opened a " +
  "database connection before its entry point called " +
  "declareDatabaseSurface (manifest-i2.md §2.2).";

export const ROLE_NOT_PERMITTED_MESSAGE =
  "RequestPort database role is not permitted";

export const ENVIRONMENT_NOT_PERMITTED_MESSAGE =
  "RequestPort database environment is not permitted";

/**
 * Declare which surface this process is, before anything can query.
 *
 * Declaring the same surface again is idempotent; declaring a different one
 * is refused (D21), because a process that is two surfaces would be judged
 * as whichever it said last. `test` is refused outside Vitest, which sets
 * `VITEST` in its workers: it is the one surface the role check skips, and
 * only a Vitest setup file declares it (a sweep test pins that).
 */
export function declareDatabaseSurface(surface: DatabaseSurface): void {
  if (!DATABASE_SURFACES.includes(surface)) {
    throw new DatabaseSurfaceError(
      "RequestPort database surface must be one of " +
        `${DATABASE_SURFACES.join(", ")}.`,
    );
  }
  if (surface === "test" && process.env.VITEST === undefined) {
    throw new DatabaseSurfaceError(
      "RequestPort database surface `test` is declared only by a Vitest " +
        "setup file, inside Vitest.",
    );
  }

  const current = holder()[DECLARATION];

  if (current === surface) return;
  if (current !== undefined) {
    throw new DatabaseSurfaceError(
      `RequestPort database surface is already declared as ${current}; ` +
        `this process cannot also declare ${surface}.`,
    );
  }
  holder()[DECLARATION] = surface;
}

/** The surface this process declared, or undefined before any declaration. */
export function declaredDatabaseSurface(): DatabaseSurface | undefined {
  return holder()[DECLARATION];
}

/**
 * For this package's own tests of the declaration, which must start from
 * none: clears it, or replaces it with `surface`, whatever it was. Not
 * exported from the package barrel; a sweep test pins that only test files
 * call it.
 */
export function resetDatabaseSurfaceDeclaration(
  surface?: DatabaseSurface,
): void {
  if (surface === undefined) delete holder()[DECLARATION];
  else holder()[DECLARATION] = surface;
}

export type RoleGuardCheck = "declaration" | "role" | "environment";
export type RoleGuardMode = "warn" | "enforce";
export type RoleGuardModes = Readonly<Record<RoleGuardCheck, RoleGuardMode>>;

const ROLE_GUARD_CHECKS: readonly RoleGuardCheck[] = Object.freeze([
  "declaration",
  "role",
  "environment",
]);

/**
 * Every guard's modes but the worker's (below): since I.2 step 5
 * (manifest-i2.md §2.2, §3; ruling 221 item 4) `declaration` and `role`
 * enforce, so a guard that finds nothing declared is refused, and an
 * `application` storage whose role or login can bypass the policies, and an
 * `operator` storage whose role cannot, are refused on every use (the role
 * check's refusal is kept, `installRoleCheck`); and since step 7 (ruling
 * 224 item 2) `environment` enforces too, so an `application` storage in a
 * process naming an owner-capable variable is refused at its first use,
 * naming the variables and never a value. The same modes as
 * `WORKER_ROLE_GUARD_MODES` since then. A code change, not a variable:
 * nothing in a process's environment can relax a check.
 */
export const ROLE_GUARD_MODES: RoleGuardModes = Object.freeze({
  declaration: "enforce",
  role: "enforce",
  environment: "enforce",
});

/**
 * The worker's modes (Plan 13, I.2b's b5 and b6; manifest-i2.md §2.2, §5.2;
 * ruling 214 item 2, ruling 217 item 1): every check enforces, the group
 * check with `role`, and `environment` since b6. A guard's whenever it
 * judges `worker`, and a worker storage's guard's (`expectedGroup`)
 * whatever it judges. A code change, not a variable, as `ROLE_GUARD_MODES`
 * is.
 */
export const WORKER_ROLE_GUARD_MODES: RoleGuardModes = Object.freeze({
  declaration: "enforce",
  role: "enforce",
  environment: "enforce",
});

/**
 * The role the connection resolved to (`which = 'current'`) and the login it
 * connected as (`which = 'session'`), one row each, the current role first,
 * and what the role check judges each by. One `select` over `pg_catalog`,
 * qualified so that nothing on the connection's `search_path` can stand in
 * for a catalogue object:
 *
 * - `owns_public_table`: a table or partitioned table in `public` whose owner
 *   is this role or a role it is a member of — `pg_has_role(…, 'MEMBER')` is
 *   true for the role itself and follows memberships recursively;
 * - `member_of_bypassing_role`: another role, superuser or `BYPASSRLS`, that
 *   this role is a member of, directly or not. A member can `SET ROLE` to it.
 */
export const ROLE_CHECK_SQL = `select k.which,
       r.rolname::text as role,
       r.rolsuper as superuser,
       r.rolbypassrls as bypass_rls,
       exists (
         select 1
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind in ('r', 'p')
           and pg_catalog.pg_has_role(r.oid, c.relowner, 'MEMBER')
       ) as owns_public_table,
       exists (
         select 1
         from pg_catalog.pg_roles m
         where m.oid <> r.oid
           and (m.rolsuper or m.rolbypassrls)
           and pg_catalog.pg_has_role(r.oid, m.oid, 'MEMBER')
       ) as member_of_bypassing_role
from (values ('current', current_user), ('session', session_user))
       as k(which, name)
join pg_catalog.pg_roles r on r.rolname = k.name
order by k.which`;

/**
 * RequestPort's group roles: the application's, the definer's, and the
 * worker's three (manifest-i2.md §2.2, §5.1). A worker storage's role must
 * be a member of exactly one of them, its own.
 */
export const REQUESTPORT_GROUP_ROLES: readonly string[] = Object.freeze([
  "requestport_application",
  "requestport_definer",
  "requestport_dispatcher",
  "requestport_maintenance",
  "requestport_tenant_processor",
]);

/**
 * Which of `REQUESTPORT_GROUP_ROLES` `current_user` is a member of, directly
 * or not, one row each, sorted. One `select` over `pg_catalog`, as
 * `ROLE_CHECK_SQL` is; the names are this file's constants, not input.
 */
export const GROUP_MEMBERSHIP_SQL = `select g.rolname::text as group_role
from pg_catalog.pg_roles g
where g.rolname in (${REQUESTPORT_GROUP_ROLES.map((name) => `'${name}'`).join(", ")})
  and pg_catalog.pg_has_role(current_user, g.oid, 'MEMBER')
order by 1`;

/**
 * What the group check objects to, for a storage whose role must be a member
 * of `expected` and of no other RequestPort group: `not_member_of_<group>`
 * when it is not in its own, and `member_of_<group>` for each other one.
 */
export function groupObjections(
  expected: string,
  memberships: readonly string[],
): string[] {
  const objections: string[] = [];

  if (!memberships.includes(expected)) {
    objections.push(`not_member_of_${expected}`);
  }
  for (const group of [...memberships].sort()) {
    if (group !== expected) objections.push(`member_of_${group}`);
  }
  return objections;
}

export interface ResolvedRole {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  ownsPublicTable: boolean;
  memberOfBypassingRole: boolean;
}

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

/** A row of `ROLE_CHECK_SQL`, read. */
export function resolvedRoleFrom(row: Record<string, unknown>): ResolvedRole {
  return {
    role: String(row.role),
    superuser: flag(row.superuser),
    bypassRls: flag(row.bypass_rls),
    ownsPublicTable: flag(row.owns_public_table),
    memberOfBypassingRole: flag(row.member_of_bypassing_role),
  };
}

/** The two rows of `ROLE_CHECK_SQL`, read: the current role and the login. */
export function resolvedRolesFrom(rows: Record<string, unknown>[]): {
  current: ResolvedRole;
  session: ResolvedRole;
} {
  const current = rows.find((row) => row.which === "current");
  const session = rows.find((row) => row.which === "session");

  if (current === undefined || session === undefined) {
    throw new Error("The role check found no current role or no login.");
  }
  return {
    current: resolvedRoleFrom(current),
    session: resolvedRoleFrom(session),
  };
}

/**
 * What the role check objects to in `role` for `surface`; empty when it
 * passes. `test` and `embedded` are never judged.
 */
export function roleObjections(
  surface: DatabaseSurface,
  role: ResolvedRole,
): string[] {
  if (surface === "test" || surface === "embedded") return [];
  if (surface === "operator") {
    return role.superuser || role.bypassRls
      ? []
      : ["cannot_bypass_row_security"];
  }

  const objections: string[] = [];

  if (role.superuser) objections.push("superuser");
  if (role.bypassRls) objections.push("bypassrls");
  if (role.ownsPublicTable) objections.push("owns_public_table");
  if (role.memberOfBypassingRole) objections.push("member_of_bypassing_role");
  return objections;
}

/**
 * What the role check objects to in the login a session connected as, when
 * it is not the role the session acts as: for `application` and `worker`,
 * the same objections as the current role's, each prefixed `session_user_`,
 * because the session can `RESET ROLE` to it. `operator` is judged by the
 * role it acts as only, and `test` and `embedded` not at all.
 */
export function sessionRoleObjections(
  surface: DatabaseSurface,
  current: ResolvedRole,
  session: ResolvedRole,
): string[] {
  if (surface !== "application" && surface !== "worker") return [];
  if (session.role === current.role) return [];
  return roleObjections(surface, session).map(
    (objection) => `session_user_${objection}`,
  );
}

/**
 * The owner-capable variable names in `env`: `DATABASE_URL`; every
 * `DATABASE_URL_*` name, the direct owner URL `DATABASE_URL_UNPOOLED`
 * among them, which the names-only audit of 2026-10-17 found in Trigger.dev
 * `prod` after the rest were gone (ruling 217 item 2); and every `POSTGRES_*`
 * and `PG*` name, which is what a database service's Vercel connection
 * injects (manifest-i2.md §1). RequestPort's own variables, whose names end
 * in `DATABASE_URL` (`REQUESTPORT_APPLICATION_DATABASE_URL` and the worker's
 * three), are not among them. Names only, sorted; an empty value still
 * counts, because the name is what the audit looks for.
 * `apps/requestport/src/serve/environment.ts` writes the same rule out,
 * and its tests hold the two lists equal, name by name; so does
 * `scripts/owner-capable-variables.mjs` (I.2 step 7), which
 * `owner-capable-copies.test.ts` holds equal.
 */
export function ownerCapableVariableNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter(
      (name) =>
        name === "DATABASE_URL" ||
        name.startsWith("DATABASE_URL_") ||
        name.startsWith("POSTGRES_") ||
        /^PG[A-Z0-9_]*$/u.test(name),
    )
    .sort();
}

/** Whether the environment check judges `surface`: `application` and `worker`. */
function judgesEnvironment(surface: DatabaseSurface | undefined): boolean {
  return surface === "application" || surface === "worker";
}

/**
 * What the environment check objects to for `surface`: every owner-capable
 * name in `env` for `application` and for `worker` (the worker's since I.2b's
 * b6, ruling 217 item 1), and nothing for any other surface.
 */
export function environmentObjections(
  surface: DatabaseSurface | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  return judgesEnvironment(surface) ? ownerCapableVariableNames(env) : [];
}

export type RoleGuardStatus =
  | "passed"
  | "warned"
  | "refused"
  | "skipped"
  | "failed";

export interface RoleGuardFinding {
  check: RoleGuardCheck;
  status: RoleGuardStatus;
  surface: DatabaseSurface | undefined;
  /** The role the connection resolved to, for the role check. */
  role?: string;
  /** The login the session connected as, when it is not `role`. */
  sessionRole?: string;
  /** What the check objected to: reasons, or variable names. */
  objections: string[];
}

/** What the guard has found for its storage so far, one finding per check. */
export interface RoleGuardReport {
  surface: DatabaseSurface | undefined;
  /** The worker storage this guard watches, when it watches one. */
  storage?: string;
  findings: RoleGuardFinding[];
}

export type RoleCheckQuery = (
  text: string,
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface DatabaseRoleGuard {
  /** The declaration and environment checks; before a connection is made. */
  beforeConnect(): void;
  /**
   * The role check, through `query`; before the storage's first use runs.
   * Answers the status it recorded: `failed` means the check could not run,
   * and the caller asks again on the next use.
   */
  checkRole(query: RoleCheckQuery): Promise<RoleGuardStatus>;
  report(): RoleGuardReport;
  /**
   * The modes its checks would run in now, for the surface it reads when
   * asked: `WORKER_ROLE_GUARD_MODES` for `worker` or a worker storage's
   * guard, otherwise `ROLE_GUARD_MODES`, each check raised to enforce where
   * its `modes` option asks.
   */
  readonly modes: RoleGuardModes;
}

/** Thrown in enforce mode, by the check that refused. */
export class DatabaseRoleGuardError extends Error {
  constructor(
    message: string,
    readonly finding: RoleGuardFinding,
  ) {
    super(message);
    this.name = "DatabaseRoleGuardError";
  }
}

export interface RoleGuardOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Checks to raise to `enforce`, read once, as the guard is built. A `warn`
   * here relaxes nothing: each check runs in the stricter of this and its
   * surface's mode (above).
   */
  modes?: Partial<Record<RoleGuardCheck, RoleGuardMode>>;
  /**
   * Where every line goes. By default a `passed` line goes to
   * `console.info`, and every `warned` or `failed` line to `console.warn`
   * (ruling 215 item 7: Trigger.dev records a `console.warn` as a warning).
   */
  write?: (line: string) => void;
  /** The declared surface; this process's declaration by default. */
  surface?: () => DatabaseSurface | undefined;
  /**
   * For a worker storage: the one RequestPort group its role must be a
   * member of (the group check, above); set, the guard runs in the worker's
   * modes whatever surface it judges. Unset for a composition root's
   * storage.
   */
  expectedGroup?: string;
  /** For a worker storage: its name, carried on each line and the report. */
  storage?: string;
  /**
   * Also write the role check's line when it passes, at `info`, once per
   * change of status: what a worker storage does, so a run's log names the
   * login each storage acts as (manifest-i2.md §5.3 Done when 15).
   */
  announcePassed?: boolean;
}

const EVENTS: Record<RoleGuardCheck, string> = {
  declaration: "database.role_guard.declaration",
  role: "database.role_guard.role",
  environment: "database.role_guard.environment",
};

/**
 * A guard for one storage. Each check records one finding and, in warn
 * mode, writes one line whenever its status becomes `warned` or `failed`
 * — not on every connection. In enforce mode a check that objects throws every time it
 * runs, so the storage fails closed. Each check's mode is chosen when it
 * runs, from the surface the guard reads then (`modesFor`, the header).
 */
export function createDatabaseRoleGuard(
  options: RoleGuardOptions = {},
): DatabaseRoleGuard {
  const env = options.env ?? process.env;
  const expectedGroup = options.expectedGroup;
  const raised: Partial<Record<RoleGuardCheck, RoleGuardMode>> = {
    ...options.modes,
  };
  const write = (line: string, status: RoleGuardStatus) => {
    if (options.write !== undefined) options.write(line);
    else if (status === "passed") console.info(line);
    else console.warn(line);
  };
  const surfaceOf = options.surface ?? declaredDatabaseSurface;
  const findings = new Map<RoleGuardCheck, RoleGuardFinding>();

  /**
   * The modes for `surface`: the worker's when it is `worker` or this guard
   * watches a worker storage, otherwise `ROLE_GUARD_MODES`; a check the
   * options raise is `enforce`, and nothing lowers one.
   */
  function modesFor(surface: DatabaseSurface | undefined): RoleGuardModes {
    const base =
      surface === "worker" || expectedGroup !== undefined
        ? WORKER_ROLE_GUARD_MODES
        : ROLE_GUARD_MODES;

    return Object.freeze(
      Object.fromEntries(
        ROLE_GUARD_CHECKS.map((check) => [
          check,
          raised[check] === "enforce" ? "enforce" : base[check],
        ]),
      ) as Record<RoleGuardCheck, RoleGuardMode>,
    );
  }

  function record(finding: RoleGuardFinding, message: string) {
    const previous = findings.get(finding.check);

    findings.set(finding.check, finding);
    if (finding.status === "skipped") return;
    if (
      finding.status === "passed" &&
      !(options.announcePassed === true && finding.check === "role")
    ) {
      return;
    }
    if (finding.status === "refused") {
      throw new DatabaseRoleGuardError(message, finding);
    }
    if (previous?.status === finding.status) return;
    write(
      JSON.stringify({
        level: finding.status === "passed" ? "info" : "warn",
        event: EVENTS[finding.check],
        timestamp: new Date().toISOString(),
        status: finding.status,
        mode: modesFor(finding.surface)[finding.check],
        surface: finding.surface ?? null,
        ...(options.storage === undefined ? {} : { storage: options.storage }),
        ...(finding.role === undefined ? {} : { role: finding.role }),
        ...(finding.sessionRole === undefined
          ? {}
          : { session_role: finding.sessionRole }),
        objections: finding.objections,
      }),
      finding.status,
    );
  }

  function judged(
    check: RoleGuardCheck,
    surface: DatabaseSurface | undefined,
    objections: string[],
  ) {
    if (objections.length === 0) return "passed" as const;
    return modesFor(surface)[check] === "enforce"
      ? ("refused" as const)
      : ("warned" as const);
  }

  return {
    get modes() {
      return modesFor(surfaceOf());
    },

    beforeConnect() {
      const surface = surfaceOf();

      record(
        {
          check: "declaration",
          status: judged(
            "declaration",
            surface,
            surface === undefined ? ["undeclared"] : [],
          ),
          surface,
          objections: surface === undefined ? ["undeclared"] : [],
        },
        UNDECLARED_SURFACE_MESSAGE,
      );

      const names = environmentObjections(surface, env);

      record(
        {
          check: "environment",
          status: judgesEnvironment(surface)
            ? judged("environment", surface, names)
            : "skipped",
          surface,
          objections: names,
        },
        `${ENVIRONMENT_NOT_PERMITTED_MESSAGE}: it names ${names.join(", ")}.`,
      );
    },

    async checkRole(query) {
      const surface = surfaceOf();

      if (
        surface === undefined ||
        surface === "test" ||
        surface === "embedded"
      ) {
        record(
          { check: "role", status: "skipped", surface, objections: [] },
          "",
        );
        return "skipped";
      }

      let resolved: ReturnType<typeof resolvedRolesFrom>;
      let memberships: string[] = [];

      try {
        const { rows } = await query(ROLE_CHECK_SQL);

        resolved = resolvedRolesFrom(rows);
        if (expectedGroup !== undefined) {
          const groups = await query(GROUP_MEMBERSHIP_SQL);

          memberships = groups.rows.map((row) => String(row.group_role));
        }
      } catch (error) {
        // The check could not run — most likely the connection failed, and
        // the use that triggered it will fail on its own. Warn mode lets
        // the use go ahead; enforce mode, which every role check that runs
        // is in since I.2 step 5, refuses it. Either way this answers
        // `failed` or throws something other than a refusal, and the caller
        // (`installRoleCheck`) asks again on the next use.
        record(
          { check: "role", status: "failed", surface, objections: [] },
          "",
        );
        if (modesFor(surface).role === "enforce") throw error;
        return "failed";
      }

      const { current, session } = resolved;
      const objections = [
        ...roleObjections(surface, current),
        ...sessionRoleObjections(surface, current, session),
        ...(expectedGroup === undefined ||
        (surface !== "application" && surface !== "worker")
          ? []
          : groupObjections(expectedGroup, memberships)),
      ];
      const status = judged("role", surface, objections);
      const loggedInAs =
        session.role === current.role ? "" : `, logged in as ${session.role}`;

      record(
        {
          check: "role",
          status,
          surface,
          role: current.role,
          ...(session.role === current.role
            ? {}
            : { sessionRole: session.role }),
          objections,
        },
        `${ROLE_NOT_PERMITTED_MESSAGE} for the ${surface} surface: ` +
          `${current.role}${loggedInAs} (${objections.join(", ")}).`,
      );
      return status;
    },

    report() {
      return {
        surface: surfaceOf(),
        ...(options.storage === undefined ? {} : { storage: options.storage }),
        findings: [...findings.values()].map((finding) => ({
          ...finding,
          objections: [...finding.objections],
        })),
      };
    },
  };
}
