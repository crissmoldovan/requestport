/*
  G.8's consumer of the S8 package set (Plan 13, manifest-g.md §4; ruling
  175), written as a project that installed `@requestport/core` and
  `@requestport/db` from their tarballs would write it. The smoke
  (`scripts/core-tarball-smoke.mjs`) copies this file and the tsconfig.json
  beside it into the consumer it installs. Step 5 type-checks it there with
  that consumer's `tsc`, against the declarations the tarballs installed, and
  step 6 runs it there:

    node consumer.ts <server URL> <database> <report path>

  The run (§4 step 6, under the principal ruling 63 fixes, as ruling 153
  amends it) is `runSmoke` below. It runs on `pg`. Before it creates
  anything, it compares core's re-exports with `db`'s own values
  (`identityCase`), then asks `db` once for an in-memory PGlite storage and
  records how `db` answers (`pgliteCase`): the smoke installs `db` without
  its optional peer `@electric-sql/pglite`, and expects a refusal. Its URL
  and names come in as arguments, never from the environment, and once the
  database's name is accepted it writes what it measured to the report
  path, as JSON, whatever happened; the smoke judges that report. Step 6's
  `zod` battery imports this file too, to load what the consumer loads, and
  importing it starts no run (`import.meta.main`).

  Beside `node:` builtins, it imports only what the tarballs export: core's
  `.` and `./migrate`, `db`'s `.` and `./migrate`, from which manifest-g.md
  §4 step 6 takes `createStorage` and `migrate` under S8, and `auth`'s
  `./create-auth` (rulings 183 item 5 and 190). The owner's SQL, which creates
  and drops the run's database and login, goes through the `pg` `db`'s
  tarball installed, loaded from `db`'s own resolution; the consumer
  declares no dependency of its own for it.

  Its syntax is erasable and every type-only import is marked, which the
  tsconfig's `erasableSyntaxOnly` and `verbatimModuleSyntax` make step 5
  check, so that Node can run the file as it is by stripping its types: Node
  22.22.3, the version the pack records, does that by default
  (`process.features.typescript` is `"strip"`).
*/
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createAuth } from "@requestport/auth/create-auth";
import {
  createRequestPort,
  type LocalCredentialSignIn,
  type NetworkCapabilityCall,
  type PersonCapabilityCall,
  type PersonSession,
  type QueryCall,
  type RequestPort,
  type RequestPortSecrets,
} from "@requestport/core";
import { createStorage, type Storage } from "@requestport/db";
import { migrate } from "@requestport/db/migrate";

/** The address Better Auth and RequestPort write their links against. */
export const PUBLIC_URL = "http://127.0.0.1:3999";

/**
 * The scopes a signed-in person carries. Core's `.` exports no list of them
 * and no builder of a person's context (ruling 153, question 5), so they are
 * written out here: the 22 of `humanScopes` in
 * `packages/core/src/command-bus.ts`, in its order.
 */
export const HUMAN_SCOPES: readonly string[] = [
  "org:read",
  "project:read",
  "project:manage",
  "request:create",
  "request:read",
  "request:write",
  "request:triage",
  "request:complete",
  "request:verify",
  "routing:manage",
  "work:claim",
  "work:update",
  "question:answer",
  "agent:manage",
  "agent:register",
  "workspace:telemetry:reveal",
  "webhook:manage",
  "import:write",
  "operator:manage",
  "operations:manage",
  "slack:manage",
  "members:manage",
];

/**
 * A command context. Core's `.` exports no name for its type, so it is read
 * here from `NetworkCapabilityCall`'s `context`.
 */
export type CommandContext = NetworkCapabilityCall["context"];

/** A command's idempotency key and expected version. */
export type CommandMeta = PersonCapabilityCall["meta"];

/** The two logins the consumer is handed: the owner's, and one in `requestport_application`. */
export interface ConsumerLogins {
  ownerUrl: string;
  applicationUrl: string;
}

/** What the consumer composes over those logins. */
export interface Consumer {
  /** The owner's storage, which `migrate` and `bootstrapOwner` run on. */
  ownerStorage: Storage;
  /** The application login's storage, with `tenantBinding` left at its default. */
  storage: Storage;
  /** The application login's storage again, with `tenantBinding: "off"`. */
  unboundStorage: Storage;
  /** `auth`'s composition, `createAuth`'s, over `storage`. */
  auth: ReturnType<typeof createAuth>;
  /** RequestPort over `storage`. */
  port: RequestPort;
  /** RequestPort over `unboundStorage`. */
  unboundPort: RequestPort;
}

/**
 * Builds the three storages, Better Auth over the application storage, and a
 * RequestPort over each application storage.
 */
export function composeConsumer({
  ownerUrl,
  applicationUrl,
}: ConsumerLogins): Consumer {
  const ownerStorage = createStorage({
    driver: "pg",
    connectionString: ownerUrl,
  });
  const storage = createStorage({
    driver: "pg",
    connectionString: applicationUrl,
  });
  const unboundStorage = createStorage({
    driver: "pg",
    connectionString: applicationUrl,
    tenantBinding: "off",
  });
  const auth = createAuth({
    database: () => storage.db,
    env: {
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
      BETTER_AUTH_URL: PUBLIC_URL,
      REQUESTPORT_OPERATOR_CREDENTIALS: "enabled",
    },
  });

  // Core takes the sign-in as a function and implements none (ruling 63):
  // Better Auth's email sign-in, then the session its cookie names.
  async function signInWithLocalCredential({
    email,
    credential,
  }: LocalCredentialSignIn): Promise<PersonSession> {
    const { headers } = await auth.auth.api.signInEmail({
      body: { email, password: credential },
      returnHeaders: true,
    });
    const cookie = headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
    const session = await auth.auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    if (session === null) {
      throw new Error("consumer: Better Auth found no session for its cookie.");
    }
    return { id: session.session.id, userId: session.user.id };
  }

  const secrets: RequestPortSecrets = {
    commandFingerprintKey: randomBytes(32).toString("base64"),
    operatorCredentials: "enabled",
    webhookKeys: {
      current: { version: "local-v1", key: randomBytes(32).toString("base64") },
    },
  };
  const options = {
    secrets,
    publicUrl: PUBLIC_URL,
    ownerStorage,
    betterAuth: {
      signInWithLocalCredential,
      createAgentApiKey: auth.createAgentApiKey,
    },
  };
  return {
    ownerStorage,
    storage,
    unboundStorage,
    auth,
    port: createRequestPort({ ...options, storage }),
    unboundPort: createRequestPort({ ...options, storage: unboundStorage }),
  };
}

/**
 * A signed-in person's context in `organizationId`, built by hand (ruling
 * 153, question 5): a `user` actor, the human scopes, and the session's id as
 * the credential.
 */
export function personContext(
  person: PersonSession,
  organizationId: string,
): CommandContext {
  return {
    actor: { type: "user", id: person.userId },
    organizationId,
    scopes: new Set(HUMAN_SCOPES),
    credentialId: person.id,
    correlationId: randomUUID(),
  };
}

/** The organisation and the person `registerAndSignIn` registers. */
export interface Owner {
  email: string;
  organizationSlug: string;
  organizationName: string;
}

/** What `registerAndSignIn` answers. */
export interface RegisteredPerson {
  status: string;
  localCredential: string | undefined;
  organizationId: string;
  person: PersonSession;
}

/**
 * Registers `owner` with a local credential issued (`bootstrapOwner`, on the
 * owner's storage), and signs that person in with the credential (`signIn`,
 * through Better Auth on the application storage).
 */
export async function registerAndSignIn(
  consumer: Consumer,
  owner: Owner,
): Promise<RegisteredPerson> {
  const registered = await consumer.port.bootstrapOwner({
    ...owner,
    localCredential: "issue",
  });
  if (
    registered.status !== "owner_active" ||
    registered.credential === undefined
  ) {
    throw new Error(
      `consumer: bootstrapOwner answered ${registered.status} and issued no credential.`,
    );
  }
  const person = await consumer.port.signIn({
    email: owner.email,
    credential: registered.credential,
  });
  return {
    status: registered.status,
    localCredential: registered.localCredential,
    organizationId: registered.organizationId,
    person,
  };
}

/** Closes both RequestPorts, then the three storages, which core never closes. */
export async function closeConsumer(consumer: Consumer): Promise<void> {
  await consumer.port.close();
  await consumer.unboundPort.close();
  for (const storage of [
    consumer.storage,
    consumer.unboundStorage,
    consumer.ownerStorage,
  ]) {
    await storage.close();
  }
}

/**
 * The F.0 modules of manifest-g.md §2.6, the human-only OAuth consent left
 * out: step 6 runs a capability of each and reads its effect back.
 */
export const MODULES: readonly string[] = [
  "(app)/actions.ts",
  "settings/appearance",
  "settings/projects",
  "settings/projects/[projectId]",
  "settings/operations",
  "settings/members",
  "settings/routing",
  "agents",
  "imports",
  "webhooks",
  "requests",
  "slack",
  "settings/operators",
];

/** Who acted: the person (ruling 63), or a key issued as that person. */
export type Principal = "person" | "operator" | "agent";

/** One capability's result and the read of its effect. */
export interface CapabilityResult {
  module: string;
  capability: string;
  principal: Principal;
  through: string;
  result: unknown;
  readBack: {
    through: string;
    principal: Principal;
    /** Whether the read answered the effect the capability wrote. */
    found: boolean;
    /** What the read answered for it. */
    row: unknown;
  };
}

/** An error, as the report records it: its class name, code, message and causes. */
export interface ErrorRecord {
  name: string;
  code: string | null;
  message: string;
  causes: { name: string; code: string | null; message: string }[];
}

/** What a run measured: the report step 6 judges. */
export interface RunReport {
  /** The names in this process's environment; never their values. */
  environment: string[];
  database: string;
  login: string;
  migrate: { applied: number } | null;
  owner: { status: string; localCredential: string | undefined } | null;
  signIn: { session: boolean; userId: string } | null;
  /** The captured snapshot seeded on the owner's storage for the imports row. */
  fixture: Record<string, unknown> | null;
  capabilities: CapabilityResult[];
  /** The `tenantBinding: "off"` storage's pool read, which must fail. */
  negative: {
    through: string;
    outcome: "answered" | "failed";
    answered: unknown;
    error: ErrorRecord | null;
    /** An administration read on the same storage, which binds its own transaction. */
    administrationRead: { outcome: "answered" | "failed"; detail: unknown };
  } | null;
  /** The three refusals' `DomainError`s, and their classes compared. */
  domainErrors: {
    core: ErrorRecord;
    agentServices: ErrorRecord;
    auth: ErrorRecord;
    coreSameClassAsAgentServices: boolean;
    coreSameClassAsAuth: boolean;
    authInstanceOfCoreClass: boolean;
    coreInstanceOfAuthClass: boolean;
  } | null;
  /** The database's sessions in `pg_stat_activity` after `closeConsumer`, each reading. */
  close: { readings: number[]; sessions: number } | null;
  dropped: { database: boolean; login: boolean; forced: boolean } | null;
  /** What `db` answered when asked for a PGlite storage (`pgliteCase`). */
  pglite: PgliteCase | null;
  /** Core's re-exports against `db`'s own values (`identityCase`). */
  identity: IdentityCase | null;
  error: ErrorRecord | null;
}

/** What `identityCase` measured, by subpath (`.` and `./migrate`). */
export interface IdentityCase {
  /** The names whose values core's entry and `db`'s both export. */
  shared: Record<string, string[]>;
  /** Of those, the names whose two values are not one. */
  differing: Record<string, string[]>;
}

/** A module namespace, read by name. */
function values(namespace: object): Record<string, unknown> {
  return namespace as Record<string, unknown>;
}

/**
 * Step 6's identity case: every value core's `.` and `./migrate` export
 * under a name that `db`'s `.` and `./migrate` export too, and those of them
 * whose two values are not one. Core's sources re-export `createStorage`,
 * the role guard and `createWorkerStorages` from `db`'s `.`, and `migrate`
 * from its `./migrate`; the smoke requires each of them shared, and none
 * differing, which holds only when the consumer loads one `@requestport/db`.
 */
export async function identityCase(): Promise<IdentityCase> {
  const pairs: [string, Record<string, unknown>, Record<string, unknown>][] = [
    [
      ".",
      values(await import("@requestport/core")),
      values(await import("@requestport/db")),
    ],
    [
      "./migrate",
      values(await import("@requestport/core/migrate")),
      values(await import("@requestport/db/migrate")),
    ],
  ];
  const shared: Record<string, string[]> = {};
  const differing: Record<string, string[]> = {};
  for (const [subpath, core, db] of pairs) {
    const names = Object.keys(db)
      .filter((name) => Object.hasOwn(core, name))
      .sort();
    shared[subpath] = names;
    differing[subpath] = names.filter((name) => core[name] !== db[name]);
  }
  return { shared, differing };
}

/**
 * The PGlite storage's `dataDir`: `memory://` names no directory, so a
 * PGlite that did start would write no file.
 */
export const PGLITE_DATA_DIR = "memory://";

/** What `pgliteCase` measured. */
export interface PgliteCase {
  dataDir: string;
  /** Whether `createStorage` threw or answered a storage. */
  outcome: "threw" | "returned";
  error: ErrorRecord | null;
  /**
   * The thrown error's `requireStack`, which Node gives the error for a
   * module it cannot find, and `db`'s refusal keeps from it: the file that
   * asked for the module, then the files that loaded that one. `null` when
   * the error carries none.
   */
  requireStack: string[] | null;
  /** When a storage was answered: what closing it threw, or `null`. */
  closeError: ErrorRecord | null;
}

/**
 * Step 6's PGlite case (ruling 153): asks `db` once for a PGlite storage,
 * and records how it answers. With `@electric-sql/pglite` absent, `db`'s
 * loader fails in Node's own lookup of the peer, before any PGlite starts,
 * and refuses in its own words, with Node's error as its cause (rulings 151
 * and 154). A storage answered instead is closed; the smoke fails the run.
 */
export async function pgliteCase(): Promise<PgliteCase> {
  let storage: Storage;
  try {
    storage = createStorage({
      driver: "pglite",
      dataDir: PGLITE_DATA_DIR,
    });
  } catch (error) {
    const stack = (error as { requireStack?: unknown } | null)?.requireStack;
    return {
      dataDir: PGLITE_DATA_DIR,
      outcome: "threw",
      error: errorRecord(error),
      requireStack: Array.isArray(stack) ? stack.map(String) : null,
      closeError: null,
    };
  }
  let closeError: ErrorRecord | null = null;
  try {
    await storage.close();
  } catch (error) {
    closeError = errorRecord(error);
  }
  return {
    dataDir: PGLITE_DATA_DIR,
    outcome: "returned",
    error: null,
    requireStack: null,
    closeError,
  };
}

/** The error, its class name, its `code`, and up to five causes below it. */
export function errorRecord(error: unknown): ErrorRecord {
  const one = (value: unknown) => {
    const object = (value ?? {}) as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      name: typeof object.name === "string" ? object.name : typeof value,
      code: typeof object.code === "string" ? object.code : null,
      message:
        typeof object.message === "string" ? object.message : String(value),
    };
  };
  const causes = [];
  let current = (error as { cause?: unknown } | null)?.cause;
  while (current !== undefined && current !== null && causes.length < 5) {
    causes.push(one(current));
    current = (current as { cause?: unknown }).cause;
  }
  return { ...one(error), causes };
}

/** The first object under `value` whose `id` is `id`, or `null`. */
export function findById(value: unknown, id: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findById(item, id);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    if ((value as { id?: unknown }).id === id) return value;
    for (const item of Object.values(value)) {
      const found = findById(item, id);
      if (found !== null) return found;
    }
  }
  return null;
}

/** `value[key]`, which must be a string. */
function text(value: unknown, key: string): string {
  const field = (value as Record<string, unknown> | null)?.[key];
  if (typeof field !== "string") {
    throw new Error(`consumer: no string ${key} in ${JSON.stringify(value)}`);
  }
  return field;
}

/** `value[key]`, which must be a number. */
function number(value: unknown, key: string): number {
  const field = (value as Record<string, unknown> | null)?.[key];
  if (typeof field !== "number") {
    throw new Error(`consumer: no number ${key} in ${JSON.stringify(value)}`);
  }
  return field;
}

/** A value fit to interpolate into the fixture's SQL: a UUID, or refused. */
function uuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value,
    )
  ) {
    throw new Error(`consumer: ${JSON.stringify(value)} is not a UUID.`);
  }
  return value;
}

/**
 * A database name fit to interpolate into the owner's SQL, quoted: lowercase
 * letters, digits and underscores, starting with a letter, and short enough
 * that the login's name (`<database>_app`) fits PostgreSQL's 63 bytes; or
 * refused.
 */
export function databaseName(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,58}$/u.test(value)) {
    throw new Error(
      `consumer: ${JSON.stringify(value)} is not a database name this run creates.`,
    );
  }
  return value;
}

/** The part of `pg` the owner's SQL uses. */
interface PgClient {
  connect(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
interface Pg {
  Client: new (options: { connectionString: string }) => PgClient;
}

/** The `pg` `db`'s tarball installed, from `db`'s own resolution. */
function dbPg(): Pg {
  return createRequire(import.meta.resolve("@requestport/db"))("pg") as Pg;
}

/** Runs `statements` in order on one connection to `url`, and answers the last one's rows. */
async function sql(
  url: string,
  statements: [string, unknown[]?][],
): Promise<Record<string, unknown>[]> {
  const client = new (dbPg().Client)({ connectionString: url });
  await client.connect();
  try {
    let rows: Record<string, unknown>[] = [];
    for (const [statement, values] of statements) {
      rows = (await client.query(statement, values)).rows;
    }
    return rows;
  } finally {
    await client.end();
  }
}

/** `url`, naming `database`, and `login` in place of its user when given. */
export function databaseUrl(
  url: string,
  database: string,
  login?: { user: string; password: string },
): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  if (login !== undefined) {
    next.username = login.user;
    next.password = login.password;
  }
  return next.toString();
}

/** A fresh idempotency key and the version a command expects. */
function meta(expectedVersion = 0): CommandMeta {
  return { idempotencyKey: randomUUID(), expectedVersion };
}

/** What `auth`'s `authenticateApiBearer` answers: an agent's context or an operator's. */
type ApiContext = Awaited<
  ReturnType<ReturnType<typeof createAuth>["authenticateApiBearer"]>
>;

/** The context, when it is an agent's (it carries an `audience`), or refused. */
function agentOf(
  context: ApiContext,
): Extract<ApiContext, { audience: unknown }> {
  if (!("audience" in context) || context.actor.type !== "agent") {
    throw new Error("consumer: the agent key authenticated as no agent.");
  }
  return context;
}

/** A request to `/api/v1` bearing `key`, which `authenticateApiBearer` reads. */
function bearer(key: string): Request {
  return new Request(`${PUBLIC_URL}/api/v1/whoami`, {
    headers: { authorization: `Bearer ${key}` },
  });
}

/**
 * The operator credential's scopes: the one each administration read this
 * run makes requires (the registry's `administrationRead` entries,
 * `packages/domain/src/transport-metadata.ts`), and no other.
 */
export const OPERATOR_READ_SCOPES: readonly string[] = [
  "agent:revoke",
  "import:write",
  "members:manage",
  "operations:manage",
  "project:manage",
  "project:read",
  "routing:manage",
  "slack:manage",
];

/**
 * The agent key's scopes. The import repository refuses an agent whose key
 * lacks `import:write`. Each of `agentQueries` refuses a context lacking the
 * scope the registry gives the query it serves, as REST and MCP do
 * (`packages/core/src/query.ts`, ruling 230): `project:read` for the
 * alias's read-back (`getProject`, `get_project`) and `request:read` for the
 * draft's (`getRequest`, `get_request`).
 */
export const AGENT_SCOPES: readonly string[] = [
  "import:write",
  "project:read",
  "request:read",
];

/**
 * A public IP literal for the webhook's endpoint: the service refuses
 * loopback and private addresses, and a literal needs no DNS lookup. With no
 * background (`kind: "none"`, the default), nothing is delivered to it.
 */
export const WEBHOOK_ENDPOINT = "http://1.1.1.1/requestport-g8-smoke";

/**
 * Step 6 (manifest-g.md §4): runs the identity case (`identityCase`) and
 * the PGlite case (`pgliteCase`); then, on `server`, creates `database` and
 * a login in `requestport_application`, composes the consumer over them,
 * migrates, registers the owner and signs that person in, runs a capability
 * of each of `MODULES` and reads its effect back through the application
 * storage, runs the negative case, closes, counts the database's sessions,
 * and drops the database and the login. Once `database` is accepted (`databaseName`), it
 * writes the report to `reportPath` whatever happens, and answers it.
 */
export async function runSmoke(
  server: string,
  database: string,
  reportPath: string,
): Promise<RunReport> {
  databaseName(database);
  const login = `${database}_app`;
  const password = randomBytes(16).toString("hex");
  const ownerUrl = databaseUrl(server, database);
  const applicationUrl = databaseUrl(server, database, {
    user: login,
    password,
  });
  const report: RunReport = {
    environment: Object.keys(process.env).sort(),
    database,
    login,
    migrate: null,
    owner: null,
    signIn: null,
    fixture: null,
    capabilities: [],
    negative: null,
    domainErrors: null,
    close: null,
    dropped: null,
    pglite: null,
    identity: null,
    error: null,
  };
  let consumer: Consumer | undefined;
  let created = false;
  try {
    report.identity = await identityCase();
    report.pglite = await pgliteCase();
    await sql(server, [[`create database "${database}"`]]);
    created = true;
    consumer = composeConsumer({ ownerUrl, applicationUrl });
    const migrated = await migrate(consumer.ownerStorage);
    report.migrate = { applied: migrated.applied.length };
    // The application login, as the application-role lane makes its own
    // (`packages/db/vitest.application-role.config.ts`), after the migration
    // that makes `requestport_application` on a server that has none.
    await sql(ownerUrl, [
      ["set scram_iterations = 1"],
      [
        `create role "${login}" login password '${password}' nosuperuser nobypassrls nocreatedb nocreaterole noreplication in role requestport_application`,
      ],
    ]);
    const registered = await registerAndSignIn(consumer, {
      email: "owner@g8-smoke.example.com",
      organizationSlug: "g8-smoke",
      organizationName: "G.8 smoke",
    });
    report.owner = {
      status: registered.status,
      localCredential: registered.localCredential,
    };
    report.signIn = {
      session: typeof registered.person.id === "string",
      userId: registered.person.userId,
    };
    await runCapabilities(consumer, registered, report);
  } catch (error) {
    report.error = errorRecord(error);
  } finally {
    if (consumer !== undefined) {
      try {
        await closeConsumer(consumer);
        const readings: number[] = [];
        // A backend leaves pg_stat_activity a moment after its client ends;
        // a pool left open keeps its idle connections for its 10 s
        // `idleTimeoutMillis`, well past the last of these readings.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const [row] = await sql(server, [
            [
              "select count(*)::int as sessions from pg_stat_activity where datname = $1",
              [database],
            ],
          ]);
          readings.push(Number(row?.sessions));
          if (readings.at(-1) === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        report.close = { readings, sessions: readings.at(-1) ?? -1 };
      } catch (error) {
        report.error ??= errorRecord(error);
      }
    }
    try {
      const forced = (report.close?.sessions ?? 0) !== 0;
      if (created) {
        await sql(server, [
          [
            `drop database if exists "${database}"${forced ? " with (force)" : ""}`,
          ],
        ]);
      }
      await sql(server, [[`drop role if exists "${login}"`]]);
      const [left] = await sql(server, [
        [
          "select (select count(*)::int from pg_database where datname = $1) as databases, (select count(*)::int from pg_roles where rolname = $2) as logins",
          [database, login],
        ],
      ]);
      report.dropped = {
        database: left?.databases === 0,
        login: left?.logins === 0,
        forced,
      };
    } catch (error) {
      report.error ??= errorRecord(error);
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

/**
 * §2.6's thirteen modules, as ruled (rulings 63 and 153), each effect read
 * back through the application storage: the person's commands through
 * `execute`, the project through `mcpOnly.createProject` and the webhook
 * through `mcpOnly.webhooks` with the person's context; the administration
 * read-backs and Slack's read as an operator credential, and the imports
 * row and the alias's and the draft's read-backs as an agent key, each
 * issued as the person through `auth`. The agent's reads come
 * before its suspension, and `revoke_operator_credential` comes last.
 */
async function runCapabilities(
  consumer: Consumer,
  registered: RegisteredPerson,
  report: RunReport,
): Promise<void> {
  const { port, unboundPort, auth } = consumer;
  const { organizationId, person } = registered;
  const context = personContext(person, organizationId);
  const asPerson = (expectedVersion = 0): PersonCapabilityCall => ({
    person,
    organizationId,
    meta: meta(expectedVersion),
  });
  const record = (result: CapabilityResult) => {
    report.capabilities.push(result);
  };

  // The operator credential the read-backs run as, issued as the person: the
  // settings/operators row's credential, revoked at the end.
  const operatorIssued = await auth.operatorCredentialService.issue(
    context,
    {
      organizationId,
      projectId: null,
      name: "G.8 smoke operator",
      scopes: [...OPERATOR_READ_SCOPES],
      expiresInDays: 1,
    },
    meta(),
  );
  const operator: QueryCall = {
    context: await auth.authenticateApiBearer(
      bearer(operatorIssued.plaintextKey),
    ),
    credentialKind: "operator",
  };
  const read = (name: string, pathParameters?: Record<string, string>) =>
    port.query(name, pathParameters ? { pathParameters } : {}, operator);

  // settings/projects: the project, registered as the person.
  const project = await port.mcpOnly.createProject({
    correlationId: randomUUID(),
    delegatedByUserId: person.userId,
    // The person's session: core re-checks it in the transaction the
    // project is created in, as the bus re-checks a person (ruling 230).
    credentialId: person.id,
    organizationId,
    project: { name: "G.8 smoke", slug: "g8-smoke", keyPrefix: "GS" },
  });
  const projectId = text(
    (project as { project?: unknown }).project ?? project,
    "id",
  );
  {
    const projects = await read("list_administration_projects");
    const row = findById(projects, projectId);
    record({
      module: "settings/projects",
      capability: "register the project",
      principal: "person",
      through:
        "mcpOnly.createProject (delegatedByUserId: the person; credentialId: the person's session)",
      result: project,
      readBack: {
        through: 'query("list_administration_projects")',
        principal: "operator",
        found: row !== null,
        row,
      },
    });
  }

  // agents: a principal, and later its suspension.
  const principal = await port.execute(
    "create_agent_principal",
    {
      organizationId,
      projectId,
      displayName: "G.8 smoke agent",
      slug: "g8-smoke-agent",
    },
    asPerson(),
  );
  const agentPrincipalId = text(
    (principal as { principal?: unknown }).principal ?? principal,
    "id",
  );
  const principalRow = findById(
    await read("list_administration_agent_principals"),
    agentPrincipalId,
  );

  // The agent's key, issued as the person (ruling 153, question 4).
  const agentIssued = await auth.agentApiKeyService.issue(
    context,
    {
      organizationId,
      agentPrincipalId,
      projectId,
      name: "G.8 smoke agent key",
      audience: "api",
      scopes: [...AGENT_SCOPES],
      expiresInDays: 1,
    },
    meta(),
  );
  const agentContext = agentOf(
    await auth.authenticateApiBearer(bearer(agentIssued.plaintextKey)),
  );
  const agent: NetworkCapabilityCall = {
    context: agentContext,
    credentialKind: "agent",
    meta: meta(),
  };

  // settings/projects/[projectId]: an alias, at the project's version. The
  // administration read names no alias, so it shows the version the command
  // answered; the agent's project read lists the aliases.
  {
    const before = await read("get_administration_project_settings", {
      projectId,
    });
    const version = number(findById(before, projectId), "version");
    const result = await port.execute(
      "add_project_alias",
      { organizationId, projectId, alias: "g8-smoke-alias" },
      asPerson(version),
    );
    const settings = findById(
      await read("get_administration_project_settings", { projectId }),
      projectId,
    );
    const agentProject = await port.agentQueries.getProject(
      agentContext,
      projectId,
    );
    const aliases = (agentProject as { aliases?: unknown } | null)?.aliases;
    record({
      module: "settings/projects/[projectId]",
      capability: "add_project_alias",
      principal: "person",
      through: 'execute("add_project_alias")',
      result,
      readBack: {
        through:
          'query("get_administration_project_settings") as the operator, and agentQueries.getProject as the agent',
        principal: "operator",
        found:
          number(settings, "version") === number(result, "version") &&
          Array.isArray(aliases) &&
          aliases.includes("g8-smoke-alias"),
        row: { settings, aliases: aliases ?? null },
      },
    });
  }

  // (app)/actions.ts: an invitation; settings/members: its revocation.
  const invited = await port.execute(
    "invite_organization_member",
    { organizationId, email: "invitee@g8-smoke.example.com", role: "member" },
    asPerson(),
  );
  const invitationId = text(invited, "id");
  {
    const invitations = await read("list_administration_invitations");
    const row = findById(invitations, invitationId);
    record({
      module: "(app)/actions.ts",
      capability: "invite_organization_member",
      principal: "person",
      through: 'execute("invite_organization_member")',
      result: invited,
      readBack: {
        through: 'query("list_administration_invitations")',
        principal: "operator",
        found: row !== null,
        row,
      },
    });
    const revoked = await port.execute(
      "revoke_organization_invitation",
      { organizationId, invitationId },
      asPerson(number(row, "version")),
    );
    // The read lists pending invitations only, so a revoked one leaves it.
    const after = findById(
      await read("list_administration_invitations"),
      invitationId,
    );
    record({
      module: "settings/members",
      capability: "revoke_organization_invitation",
      principal: "person",
      through: 'execute("revoke_organization_invitation")',
      result: revoked,
      readBack: {
        through: 'query("list_administration_invitations"), before and after',
        principal: "operator",
        found: row !== null && after === null,
        row: { before: row, after },
      },
    });
  }

  // settings/appearance: the organisation's defaults, at their version.
  {
    const before = await read("get_administration_organization_appearance");
    const version = number(before, "version");
    const result = await port.execute(
      "appearance.update_organization_defaults.v1",
      { organizationId, theme: "terminal", density: "normal", mode: "dark" },
      asPerson(version),
    );
    const after = await read("get_administration_organization_appearance");
    record({
      module: "settings/appearance",
      capability: "appearance.update_organization_defaults.v1",
      principal: "person",
      through: 'execute("appearance.update_organization_defaults.v1")',
      result,
      readBack: {
        through: 'query("get_administration_organization_appearance")',
        principal: "operator",
        found:
          JSON.stringify(after).includes('"terminal"') &&
          number(after, "version") === version + 1,
        row: after,
      },
    });
  }

  // settings/operations: a retention hold.
  {
    const result = await port.execute(
      "create_retention_hold",
      { organizationId, category: "all", reason: "G.8 smoke retention hold" },
      asPerson(),
    );
    const row = findById(
      await read("list_administration_retention_holds"),
      text(result, "id"),
    );
    record({
      module: "settings/operations",
      capability: "create_retention_hold",
      principal: "person",
      through: 'execute("create_retention_hold")',
      result,
      readBack: {
        through: 'query("list_administration_retention_holds")',
        principal: "operator",
        found: row !== null,
        row,
      },
    });
  }

  // settings/routing: a rule admitting the person's direct requests.
  {
    const result = await port.execute(
      "create_routing_rule",
      {
        organizationId,
        sourceKind: "human_direct",
        targetProjectId: projectId,
        decision: "allow",
      },
      asPerson(),
    );
    const row = findById(
      await read("list_administration_routing_rules"),
      text(result, "id"),
    );
    record({
      module: "settings/routing",
      capability: "create_routing_rule",
      principal: "person",
      through: 'execute("create_routing_rule")',
      result,
      readBack: {
        through: 'query("list_administration_routing_rules")',
        principal: "operator",
        found: row !== null,
        row,
      },
    });
  }

  // webhooks: a subscription, with the person's context; read back by the
  // service's own list, a pool read through `withTenantRead`.
  const webhooks = port.mcpOnly.webhooks;
  const unboundWebhooks = unboundPort.mcpOnly.webhooks;
  if (webhooks === null || unboundWebhooks === null) {
    throw new Error("consumer: mcpOnly.webhooks is null with webhookKeys set.");
  }
  {
    const result = await webhooks.create(
      context,
      {
        organizationId,
        name: "G.8 smoke subscription",
        endpointUrl: WEBHOOK_ENDPOINT,
      },
      meta(),
    );
    const subscriptionId = text(
      (result as { subscription?: unknown }).subscription ?? result,
      "id",
    );
    const row = findById(
      await webhooks.list(context, organizationId),
      subscriptionId,
    );
    record({
      module: "webhooks",
      capability: "create_event_subscription",
      principal: "person",
      through: "mcpOnly.webhooks.create (the person's context)",
      result: withoutSecrets(result),
      readBack: {
        through: "mcpOnly.webhooks.list (the person's context)",
        principal: "person",
        found: row !== null,
        row: withoutSecrets(row),
      },
    });
  }

  // imports: the captured snapshot, seeded on the owner's storage as a
  // fixture (ruling 153), analysed by the agent.
  const manifestSha256 = createHash("sha256")
    .update("G.8 smoke: the captured snapshot fixture")
    .digest("hex");
  const [source] = (
    await consumer.ownerStorage.db.execute<{ id: string }>(
      `insert into import_sources (organization_id, project_id, kind, created_by) values ('${uuid(organizationId)}', '${uuid(projectId)}', 'git', 'g8-smoke-fixture') returning id`,
    )
  ).rows;
  const sourceId = text(source, "id");
  const [snapshot] = (
    await consumer.ownerStorage.db.execute<{ id: string }>(
      `insert into source_snapshots (organization_id, import_source_id, status, manifest_sha256) values ('${uuid(organizationId)}', '${uuid(sourceId)}', 'captured', '${manifestSha256}') returning id`,
    )
  ).rows;
  const snapshotId = text(snapshot, "id");
  report.fixture = {
    name: "G.8's captured snapshot",
    storage: "ownerStorage",
    importSource: { id: sourceId, kind: "git", createdBy: "g8-smoke-fixture" },
    sourceSnapshot: { id: snapshotId, status: "captured", manifestSha256 },
  };
  {
    const result = await port.mcpOnly.imports.analyze(
      { sourceId, snapshotId },
      agent,
    );
    const runId = text(result, "runId");
    const row = findById(await read("list_administration_import_runs"), runId);
    const listed = findById(await port.mcpOnly.imports.list(agent), runId);
    record({
      module: "imports",
      capability: "analyze_legacy_import",
      principal: "agent",
      through: "mcpOnly.imports.analyze (the agent key)",
      result,
      readBack: {
        through:
          'query("list_administration_import_runs"), and mcpOnly.imports.list as the agent',
        principal: "operator",
        found: row !== null && listed !== null,
        row: { administration: row, agent: listed },
      },
    });
  }

  // requests: a draft the person creates, read back by the agent.
  {
    const result = await port.execute(
      "create_request_draft",
      {
        organizationId,
        sourceKind: "human_direct",
        targetProjectId: projectId,
        type: "feature",
        title: "G.8 smoke draft",
        descriptionMd: "A draft the tarball smoke writes and reads back.",
      },
      asPerson(),
    );
    const requestId = text(
      (result as { request?: unknown }).request ?? result,
      "id",
    );
    const row = await port.agentQueries.getRequest(agentContext, requestId);
    record({
      module: "requests",
      capability: "create_request_draft",
      principal: "person",
      through: 'execute("create_request_draft")',
      result,
      readBack: {
        through: "agentQueries.getRequest (the agent key)",
        principal: "agent",
        found: findById(row, requestId) !== null,
        row: findById(row, requestId),
      },
    });
  }

  // slack: the configuration's read, which admits network credentials only,
  // so as the operator (ruling 153, question 4). The read is the capability.
  {
    const result = await read("get_administration_slack_configuration");
    const shape = result as {
      installations?: unknown;
      mappings?: unknown;
      routes?: unknown;
    } | null;
    record({
      module: "slack",
      capability: "get_administration_slack_configuration",
      principal: "operator",
      through: 'query("get_administration_slack_configuration")',
      result,
      readBack: {
        through: "the read itself",
        principal: "operator",
        found:
          Array.isArray(shape?.installations) &&
          Array.isArray(shape?.mappings) &&
          Array.isArray(shape?.routes),
        row: result,
      },
    });
  }

  // Three refusals, one from each place this consumer meets a DomainError:
  // core's `.` (`execute`); core's `./agent-services`, whose key service
  // `auth` composes (`auth.agentApiKeyService`); and `auth`'s own code
  // (`authenticateApiBearer`). Each takes `DomainError` from
  // `@requestport/domain`, which the consumer installs once, so the smoke
  // expects one class. Core's `.` exports no `DomainError`, and the consumer
  // does not depend on `@requestport/domain`, so the classes are compared
  // through the errors' constructors.
  const refusal = async (attempt: () => Promise<unknown>) => {
    try {
      await attempt();
    } catch (error) {
      return error;
    }
    throw new Error("consumer: a refusal the probe expected was answered.");
  };
  const coreError = await refusal(() =>
    port.execute("g8_smoke_not_a_command", {}, asPerson()),
  );
  const agentServicesError = await refusal(() =>
    auth.agentApiKeyService.issue(
      context,
      {
        organizationId,
        agentPrincipalId,
        projectId,
        name: "G.8 smoke refused key",
        audience: "api",
        scopes: ["operator:manage"],
        expiresInDays: 1,
      },
      meta(),
    ),
  );
  const authError = await refusal(() =>
    auth.authenticateApiBearer(bearer("rpo_g8_smoke_not_a_key")),
  );
  const classOf = (error: unknown) =>
    (error as { constructor?: unknown } | null)?.constructor;
  report.domainErrors = {
    core: errorRecord(coreError),
    agentServices: errorRecord(agentServicesError),
    auth: errorRecord(authError),
    coreSameClassAsAgentServices:
      classOf(coreError) === classOf(agentServicesError),
    coreSameClassAsAuth: classOf(coreError) === classOf(authError),
    authInstanceOfCoreClass:
      typeof classOf(coreError) === "function" &&
      authError instanceof (classOf(coreError) as new () => unknown),
    coreInstanceOfAuthClass:
      typeof classOf(authError) === "function" &&
      coreError instanceof (classOf(authError) as new () => unknown),
  };

  // agents: the suspension, after the agent's reads.
  {
    const result = await port.execute(
      "set_agent_principal_status",
      {
        organizationId,
        agentPrincipalId,
        status: "suspended",
        reason: "G.8 smoke: suspended after its reads",
      },
      asPerson(number(principalRow, "version")),
    );
    const row = findById(
      await read("list_administration_agent_principals"),
      agentPrincipalId,
    );
    record({
      module: "agents",
      capability:
        "create_agent_principal, then set_agent_principal_status (suspend)",
      principal: "person",
      through:
        'execute("create_agent_principal"), execute("set_agent_principal_status")',
      result: { created: principal, suspended: result },
      readBack: {
        through: 'query("list_administration_agent_principals")',
        principal: "operator",
        found:
          principalRow !== null &&
          (row as { status?: unknown } | null)?.status === "suspended",
        row: { created: principalRow, suspended: row },
      },
    });
  }

  // The negative case: the same pool read, through the storage built with
  // `tenantBinding: "off"`, must fail. An administration read on it answers,
  // because it binds its own transaction.
  {
    let outcome: "answered" | "failed" = "answered";
    let answered: unknown = null;
    let error: ErrorRecord | null = null;
    try {
      answered = withoutSecrets(
        await unboundWebhooks.list(context, organizationId),
      );
    } catch (caught) {
      outcome = "failed";
      error = errorRecord(caught);
    }
    let administrationRead: {
      outcome: "answered" | "failed";
      detail: unknown;
    };
    try {
      administrationRead = {
        outcome: "answered",
        detail: await unboundPort.query(
          "list_administration_retention_holds",
          {},
          operator,
        ),
      };
    } catch (caught) {
      administrationRead = { outcome: "failed", detail: errorRecord(caught) };
    }
    report.negative = {
      through: 'mcpOnly.webhooks.list over the tenantBinding "off" storage',
      outcome,
      answered,
      error,
      administrationRead,
    };
  }

  // settings/operators, last: the person revokes the operator credential
  // issued above (ruling 63; §2.6's self-revocation is not run), and its key
  // then authenticates no more.
  {
    const credentialId = text(operatorIssued.credential, "id");
    const version = number(operatorIssued.credential, "version");
    const result = await port.execute(
      "revoke_operator_credential",
      { organizationId, credentialId },
      asPerson(version),
    );
    let refused: ErrorRecord | null = null;
    try {
      await auth.authenticateApiBearer(bearer(operatorIssued.plaintextKey));
    } catch (error) {
      refused = errorRecord(error);
    }
    record({
      module: "settings/operators",
      capability: "revoke_operator_credential",
      principal: "person",
      through:
        'auth.operatorCredentialService.issue as the person, then execute("revoke_operator_credential")',
      result: { issued: operatorIssued.credential, revoked: result },
      readBack: {
        through: "authenticateApiBearer with the revoked key",
        principal: "operator",
        found: refused !== null,
        row: refused,
      },
    });
  }
}

/** `value` without the fields that carry a secret: a key's plaintext or a webhook's secret. */
function withoutSecrets(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null, (key, field) =>
      /secret|plaintext/iu.test(key) ? "[omitted]" : field,
    ),
  );
}

if (import.meta.main) {
  const [server, database, reportPath] = process.argv.slice(2);
  if (
    server === undefined ||
    database === undefined ||
    reportPath === undefined
  ) {
    process.stderr.write(
      "usage: node consumer.ts <server URL> <database> <report path>\n",
    );
    process.exitCode = 2;
  } else {
    const report = await runSmoke(server, database, reportPath);
    process.stdout.write(
      `consumer: ${report.capabilities.length} capabilities; PGlite ${report.pglite?.outcome ?? "not run"}; ${report.error === null ? "no error" : `error: ${report.error.message}`}\n`,
    );
    if (report.error !== null) process.exitCode = 1;
  }
}
