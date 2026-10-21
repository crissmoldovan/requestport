import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createFoundationRepository, type Storage } from "@requestport/db";
import { migrate } from "@requestport/db/migrate";
import {
  type InstanceLogins,
  instanceLoginUrls,
  OperatorRefusalError,
  type OperatorSession,
  openOperatorSession,
  packagedMigrationsFolder,
  refuseUnapprovedSharedPgDatabase,
  rootStorageFromEnv,
} from "@requestport/db/wiring";
import {
  BOOTSTRAP_OWNER_ACTOR,
  type BootstrapOwnerRepository,
  bootstrapOwner,
} from "@requestport/domain";

import { readDataFile } from "../atomic-file.js";
import {
  ConfigurationError,
  LOGIN_KINDS,
  LOGIN_URL_VARIABLES,
  PGLITE_DATABASE_DIRECTORY,
  readConfiguration,
  readSecrets,
  writeSecrets,
} from "../configuration.js";
import {
  type BootstrapDetails,
  INIT_FILE,
  type InstanceMarker,
  readInstanceMarker,
  writeInstanceMarker,
} from "../instance-marker.js";
import { OWNER_FILE, OwnerUrlError, readOwnerFile } from "../owner-url.js";

/**
 * The operator step (manifest-h.md §2.3.1, §2.4, §2.6): the child process
 * `requestport start` runs after it has written the data directory's files.
 *
 * On pg:
 * As the owner, from `owner.json`, it refuses production's and staging's
 * databases, then, holding the claim's lock for all of it, runs the
 * preflight, the claim, `migrate`, provisioning, and the first start's
 * bootstrap, which prints the owner's local credential once. Each database
 * step is idempotent and runs again on every start (§2.3.1, Rule 2); the
 * bootstrap runs until `init.json` is complete, as `init.json` reads once
 * the claim's lock is held. A bootstrap that finds the owner already holding
 * a local credential, left by a start that stopped between the bootstrap's
 * commit and `init.json`'s completion (§2.3.1, B10 and B11), rotates it and
 * prints the new one. Its own SQL is
 * `@requestport/db`'s operator session (ruling 158, item 1); the migrator is
 * `@requestport/db/migrate`'s, and the bootstrap is the domain's
 * `bootstrapOwner` over the session's foundation repository, as the private
 * CLI runs it.
 *
 * On PGlite (§2.6), which has no owner URL, claim or login: it opens the
 * database inside the data directory as the operator root's storage, PGlite's
 * superuser, migrates it (B7), runs the same bootstrap while `init.json` is
 * not complete (B10, B11), and closes it before it exits, so that the
 * serving process opens it alone (§2.6 item 1). The parent's data directory
 * lock is what keeps a second start from opening it meanwhile.
 */

/** The first start's boundaries this step crosses (§2.3.1's table). */
export type OperatorBoundary = "B5" | "B6" | "B7" | "B8" | "B9" | "B10" | "B11";

export interface OperatorOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface OperatorStepOptions {
  dataDirectory: string;
  /** Read for the shared-database opt-ins; the owner URL is never in it. */
  env: NodeJS.ProcessEnv;
  output: OperatorOutput;
  /**
   * Called as the step crosses each boundary, B5 and B8 inside their
   * transactions, before `COMMIT`. For the first start's crash tests
   * (§2.3.1's proof), whose test entry kills the process there; the CLI's
   * entry passes none.
   */
  afterBoundary?: (boundary: OperatorBoundary) => void | Promise<void>;
  /** How `init.json` and `owner.json` are read: `readDataFile`, unless a test watches it. */
  readFile?: (directory: string, name: string) => string | undefined;
  /** The refusal of production's and staging's databases; a test's spy. */
  refuseSharedDatabase?: (
    connectionString: string,
    env: NodeJS.ProcessEnv,
  ) => void;
  /** Opens the owner's session; a test's spy. */
  openSession?: typeof openOperatorSession;
  /** The migrations to apply: the folder `@requestport/db` carries, unless a test names another. */
  migrationsFolder?: string;
}

/** A refusal this step says in its own words, with no stack. */
export class OperatorStepError extends Error {}

/**
 * Ruling 155: Drizzle's refusal of a missing migrations folder names no
 * path, so the step checks the folder it will hand `migrate()` first, before
 * it connects, and names it.
 */
export function checkMigrationsFolder(folder: string): void {
  const journal = join(folder, "meta", "_journal.json");
  const isDirectory = (() => {
    try {
      return statSync(folder).isDirectory();
    } catch {
      return false;
    }
  })();
  if (!isDirectory || !existsSync(journal)) {
    throw new OperatorStepError(
      `the migrations folder ${folder} ${isDirectory ? `holds no ${join("meta", "_journal.json")}` : "does not exist"}. It is part of this installation: reinstall requestport.`,
    );
  }
}

function required<T>(value: T | undefined, file: string, directory: string): T {
  if (value === undefined) {
    throw new OperatorStepError(
      `${directory} holds no ${file}. The operator step runs after requestport start has written the data directory's files.`,
    );
  }
  return value;
}

/**
 * The first start's bootstrap (§2.3.1, B10 and B11), on either storage: the
 * domain's `bootstrapOwner` with `localCredential: "issue"` over `repository`
 * on the owner's storage, the credential alone on standard output, start's
 * notice on standard error, then `init.json` complete. An `issue` that finds
 * the person already holding a credential, which only a start that stopped
 * between the bootstrap's commit and `init.json`'s completion leaves, changes
 * nothing and prints nothing, and only that credential's hash is kept; so it
 * is followed by a `rotate`, which sets a new one, revokes the person's
 * sessions and operator credentials, and is printed.
 */
async function bootstrapAndPrint({
  repository,
  bootstrap,
  dataDirectory,
  marker,
  output,
  say,
  afterBoundary,
}: {
  repository: BootstrapOwnerRepository;
  bootstrap: BootstrapDetails;
  dataDirectory: string;
  marker: InstanceMarker;
  output: OperatorOutput;
  say: (line: string) => void;
  afterBoundary: (boundary: OperatorBoundary) => void | Promise<void>;
}): Promise<void> {
  const bootstrapWith = (localCredential: "issue" | "rotate") =>
    bootstrapOwner(
      repository,
      {
        actor: BOOTSTRAP_OWNER_ACTOR,
        correlationId: `requestport_start_${randomUUID()}`,
      },
      { ...bootstrap, localCredential },
    );
  let result = await bootstrapWith("issue");
  if (
    result.status === "owner_active" &&
    result.localCredential === "unchanged"
  ) {
    say(
      `${bootstrap.email} already holds a local credential: an earlier start bootstrapped them and stopped before ${INIT_FILE} was complete, so it may never have been shown. This start rotates it: a credential an earlier start printed no longer signs in, and their sessions end.`,
    );
    result = await bootstrapWith("rotate");
  }
  await afterBoundary("B10");
  if (result.status !== "owner_active") {
    throw new OperatorStepError(
      "the owner's bootstrap did not make them an active owner.",
    );
  }
  if (
    (result.localCredential !== "issued" &&
      result.localCredential !== "rotated") ||
    !result.credential
  ) {
    throw new OperatorStepError(
      "the owner's bootstrap issued no local credential.",
    );
  }
  say(
    `${bootstrap.email} is the owner of ${bootstrap.organizationSlug}. Their local credential follows on standard output, shown once.`,
  );
  output.stdout(`${result.credential}\n`);
  say(
    "the local credential above is shown once. Store it now: only its hash is kept.",
  );
  await afterBoundary("B11");
  writeInstanceMarker(dataDirectory, { ...marker, complete: true });
}

/**
 * The names of a server's connections that the operator step on PGlite
 * removes from its own environment: the instance logins' four URL
 * variables, which name a PostgreSQL server PGlite never connects to, and
 * one of which would turn the operator root's tenant binding on
 * (`tenantWrappingEnabled`).
 */
const SERVER_LOGIN_VARIABLES = Object.values(LOGIN_URL_VARIABLES);

/**
 * The operator step on PGlite (above). `buildOperatorStorage` is the
 * operator root's storage, `rootStorageFromEnv`, which reads `process.env`:
 * the entry passes `process.env` as `env`, where this step writes the PGlite
 * names before it builds.
 */
async function runPgliteOperatorStep(
  {
    dataDirectory,
    env,
    marker,
    output,
    say,
    afterBoundary,
    migrationsFolder,
  }: {
    dataDirectory: string;
    env: NodeJS.ProcessEnv;
    marker: InstanceMarker;
    output: OperatorOutput;
    say: (line: string) => void;
    afterBoundary: (boundary: OperatorBoundary) => void | Promise<void>;
    migrationsFolder: string;
  },
  buildOperatorStorage: (surface: "operator") => Storage = rootStorageFromEnv,
): Promise<void> {
  if (marker.complete !== true && marker.bootstrap === undefined) {
    throw new OperatorStepError(
      `${INIT_FILE} holds no email or organisation for the owner's bootstrap. Run requestport start again, with --email, --organization and --organization-name.`,
    );
  }
  checkMigrationsFolder(migrationsFolder);

  for (const name of SERVER_LOGIN_VARIABLES) {
    if (env[name] === undefined) continue;
    delete env[name];
    say(
      `removed ${name} from the operator step's environment: on PGlite it connects to no server.`,
    );
  }
  const database = join(dataDirectory, PGLITE_DATABASE_DIRECTORY);
  env.REQUESTPORT_DATABASE_DRIVER = "pglite";
  env.REQUESTPORT_PGLITE_DATA_DIR = database;
  const storage = buildOperatorStorage("operator");
  try {
    const report = await migrate(storage, { migrationsFolder });
    for (const migration of report.applied) {
      say(`applied migration ${migration.tag}.`);
    }
    say(
      report.applied.length === 0
        ? `no migration to apply to the PGlite database in ${database}.`
        : `applied ${report.applied.length} migrations from ${migrationsFolder} to the PGlite database in ${database}.`,
    );
    await afterBoundary("B7");

    const bootstrap = marker.complete === true ? undefined : marker.bootstrap;
    if (bootstrap !== undefined) {
      await bootstrapAndPrint({
        repository: createFoundationRepository(storage.db),
        bootstrap,
        dataDirectory,
        marker,
        output,
        say,
        afterBoundary,
      });
    }
  } finally {
    // Closed before this process exits, so that the serving process opens
    // the database alone (§2.6 item 1).
    await storage.close();
  }
}

/**
 * The message of the innermost cause in `error`'s chain, on one line.
 * Drizzle wraps a driver's error in its own, "Failed query: <the
 * statement>\nparams: …", with the driver's as its `cause`; the driver's is
 * the one PostgreSQL words. A migration's refusal is said in those words
 * (0023's names `createrole_self_grant`; ruling 215 item 10), not as the
 * statement that raised it.
 */
function innermostMessage(error: unknown): string {
  let found = error;
  while (found instanceof Error && found.cause instanceof Error) {
    found = found.cause;
  }
  return (found instanceof Error ? found.message : String(found))
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * A start's database steps on pg, in the owner's session, which holds the
 * claim's lock (§2.3.1, Rules 2 and 3): the preflight, the claim (B5 inside
 * its transaction, B6 after), `migrate` (B7), and provisioning (B8 inside,
 * B9 after). Each is idempotent, so a resumed or a later start runs them all
 * again, and each says what it found.
 */
export async function prepareInstanceDatabase(
  session: OperatorSession,
  {
    instanceId,
    passwords,
    migrationsFolder,
    say,
    afterBoundary = () => undefined,
  }: {
    instanceId: string;
    passwords: InstanceLogins["passwords"];
    migrationsFolder: string;
    say: (line: string) => void;
    afterBoundary?: (boundary: OperatorBoundary) => void | Promise<void>;
  },
): Promise<void> {
  const preflight = await session.preflight();
  say(
    `the owner, ${preflight.role}, may initialise database ${preflight.database} (${preflight.superuser ? "a superuser" : "BYPASSRLS and CREATEROLE, with ADMIN OPTION on the groups that exist"}).`,
  );
  const logins = {
    instanceId: instanceId,
    passwords,
    beforeCommit: () => afterBoundary("B5"),
  };
  const claimed = await session.claim(logins);
  say(
    claimed === "claimed"
      ? `claimed database ${preflight.database} for instance ${instanceId}.`
      : `database ${preflight.database} holds this instance's claim.`,
  );
  await afterBoundary("B6");

  let report: Awaited<ReturnType<OperatorSession["migrate"]>>;
  try {
    report = await session.migrate({
      migrationsFolder,
      migrator: migrate,
    });
  } catch (error) {
    throw new OperatorStepError(
      `the migrations could not be applied: ${innermostMessage(error)}`,
      { cause: error },
    );
  }
  for (const migration of report.applied) {
    say(`applied migration ${migration.tag}.`);
  }
  say(
    report.applied.length === 0
      ? "no migration to apply."
      : `applied ${report.applied.length} migrations from ${migrationsFolder}.`,
  );
  await afterBoundary("B7");

  const provisioned = await session.provision({
    ...logins,
    beforeCommit: () => afterBoundary("B8"),
  });
  say(
    `provisioned the instance's logins: ${provisioned.map((login) => `${login.login} in ${login.group}`).join(", ")}.`,
  );
  await afterBoundary("B9");
}

/** Runs the operator step, and answers the process's exit code. */
export async function runOperatorStep({
  dataDirectory,
  env,
  output,
  afterBoundary = () => undefined,
  readFile = readDataFile,
  refuseSharedDatabase = refuseUnapprovedSharedPgDatabase,
  openSession = openOperatorSession,
  migrationsFolder = packagedMigrationsFolder(),
}: OperatorStepOptions): Promise<number> {
  const say = (line: string) => output.stderr(`requestport start: ${line}\n`);
  try {
    const marker = required(
      readInstanceMarker(dataDirectory, readFile),
      INIT_FILE,
      dataDirectory,
    );
    const configuration = required(
      readConfiguration(dataDirectory),
      "config.json",
      dataDirectory,
    );
    if (configuration.storage === "pglite") {
      await runPgliteOperatorStep({
        dataDirectory,
        env,
        marker,
        output,
        say,
        afterBoundary,
        migrationsFolder,
      });
      return 0;
    }
    const secrets = required(
      readSecrets(dataDirectory, "pg"),
      "secrets.json",
      dataDirectory,
    );
    const passwords = required(
      secrets.loginPasswords,
      "login passwords in secrets.json",
      dataDirectory,
    );
    const ownerUrl = required(
      readOwnerFile(dataDirectory, readFile),
      OWNER_FILE,
      dataDirectory,
    );
    if (marker.complete !== true && marker.bootstrap === undefined) {
      throw new OperatorStepError(
        `${INIT_FILE} holds no email or organisation for the owner's bootstrap. Run requestport start again, with --email, --organization and --organization-name.`,
      );
    }
    checkMigrationsFolder(migrationsFolder);

    // Before the first statement (manifest-h.md §2.4; Done when 6).
    refuseSharedDatabase(ownerUrl, env);
    const session = await openSession({ ownerUrl, env });
    try {
      // The session holds the claim's lock from here. init.json is read
      // again under it: an operator step on this data directory that held
      // the lock first may have completed the bootstrap since the read above
      // (Done when 8's two children), and the bootstrap runs only while it
      // is not complete.
      const locked = required(
        readInstanceMarker(dataDirectory, readFile),
        INIT_FILE,
        dataDirectory,
      );
      const bootstrap = locked.complete === true ? undefined : locked.bootstrap;
      await prepareInstanceDatabase(session, {
        instanceId: marker.instanceId,
        passwords,
        migrationsFolder,
        say,
        afterBoundary,
      });

      const loginUrls = instanceLoginUrls(
        ownerUrl,
        marker.instanceId,
        passwords,
      );
      if (
        LOGIN_KINDS.some(
          (kind) => secrets.loginUrls?.[kind] !== loginUrls[kind],
        )
      ) {
        writeSecrets(dataDirectory, { ...secrets, loginUrls }, "pg");
      }

      if (bootstrap !== undefined) {
        await bootstrapAndPrint({
          repository: session.bootstrapRepository(),
          bootstrap,
          dataDirectory,
          marker: locked,
          output,
          say,
          afterBoundary,
        });
      }
    } finally {
      await session.close();
    }
    return 0;
  } catch (error) {
    if (
      error instanceof OperatorRefusalError ||
      error instanceof OperatorStepError ||
      error instanceof ConfigurationError ||
      error instanceof OwnerUrlError
    ) {
      say(error.message);
      return 1;
    }
    say(
      `the operator step failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
