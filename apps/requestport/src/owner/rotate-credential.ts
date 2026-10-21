import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  createFoundationRepository,
  declareDatabaseSurface,
  type Storage,
} from "@requestport/db";
import {
  OperatorRefusalError,
  openOperatorSession,
  packagedMigrationsFolder,
  refuseUnapprovedSharedPgDatabase,
  rootStorageFromEnv,
} from "@requestport/db/wiring";
import {
  BOOTSTRAP_OWNER_ACTOR,
  type BootstrapOwnerRepository,
  bootstrapOwner,
  DomainError,
  normalizeEmail,
  normalizeName,
  normalizeSlug,
} from "@requestport/domain";

import {
  ConfigurationError,
  LOGIN_URL_VARIABLES,
  PGLITE_DATABASE_DIRECTORY,
  readConfiguration,
} from "../configuration.js";
import { DataDirectoryError, resolveDataDirectory } from "../data-directory.js";
import { acquireInstanceLock, InstanceLockedError } from "../instance-lock.js";
import {
  type BootstrapDetails,
  INIT_FILE,
  readInstanceMarker,
} from "../instance-marker.js";
import {
  checkMigrationsFolder,
  OperatorStepError,
} from "../operator/operator-step.js";
import {
  OWNER_FILE,
  OwnerUrlError,
  readOwnerFile,
  refuseOwnerUrlInArgv,
} from "../owner-url.js";

/**
 * `requestport owner rotate-credential` (manifest-h.md §2.4; owner question
 * 6, built on the proposal by ruling 156; ruling 158, item 13): the public
 * form of the lost-credential recovery. It rotates the owner's local
 * credential through the domain's `bootstrapOwner` with
 * `localCredential: "rotate"`, as the database's owner, in a process that
 * declares `operator`: a new credential is set and printed once, the one
 * before it stops signing in, and the person's sessions and operator
 * credentials are revoked (`organization-service.ts`).
 *
 * - **pg.** As the owner, from the data directory's `owner.json`, after the
 *   refusal of production's and staging's databases: it runs the session's
 *   check-only step (`OperatorSession.check`; ruling 163, item 3), which runs
 *   the preflight, finds this instance's claim and holds the journal to the
 *   migrations in `migrationsFolder` (the packaged ones), and creates,
 *   changes and migrates nothing; so it rotates only in a database that
 *   holds this instance's claim and every one of those migrations, and
 *   changes nothing beyond the rotation. A journal that lacks one is
 *   refused, saying to run requestport start. It takes no data directory lock, so it runs beside a
 *   serving start; its session holds the claim's lock while it runs, as a
 *   start's operator step does. It is refused while `init.json` is not
 *   complete: a first start that has not finished rotates and prints the
 *   credential itself (§2.3.1, B10 and B11).
 * - **PGlite.** It takes the data directory's lock first, because PGlite's
 *   database is opened by one process at a time (§2.6 item 1): it is refused
 *   while a start holds it. Then it opens the database as the operator
 *   root's storage, PGlite's superuser, rotates, and closes it.
 *
 * The person is the one the first start bootstrapped, as `init.json`
 * records them, unless `--email`, `--organization` or
 * `--organization-name` names another.
 *
 * This module, its tests and its one entry in `cli.ts`'s commands are the
 * whole of the command, so that a "no" to owner question 6 removes them and
 * nothing else needs to change (ruling 156).
 */

export const OWNER_USAGE = `Usage: requestport owner rotate-credential [options]

Rotates the local credential of the owner a first start bootstrapped: it sets
a new one and prints it once on standard output. The one before it no longer
signs in, and the owner's sessions and operator credentials are revoked.

On PostgreSQL it connects as the owner, through the data directory's
owner.json, and checks the owner, this instance's claim and the migration
journal. Beyond the rotation it changes nothing: it never migrates, and is
refused, saying to run requestport start, while the database lacks a
migration this requestport carries. It runs beside a serving start. On
PGlite it needs the data directory to itself: stop requestport start first.
It is refused until the first start has completed.

Options:
  --data-dir <path>            The data directory (default: this user's
                               application data directory).
  --email <address>            The owner's email address (default: the one
                               the first start recorded in init.json).
  --organization <slug>        The organisation's slug (default: recorded).
  --organization-name <name>   The organisation's name (default: recorded).
  --help                       Prints this text.`;

const PROGRAM = "requestport owner rotate-credential";

class OwnerUsageError extends Error {}

/** A refusal this command says in its own words, with no stack. */
class OwnerCommandError extends Error {}

interface OwnerArguments {
  help: boolean;
  dataDirectory?: string;
  email?: string;
  organizationSlug?: string;
  organizationName?: string;
}

const VALUE_OPTIONS = {
  "--data-dir": "dataDirectory",
  "--email": "email",
  "--organization": "organizationSlug",
  "--organization-name": "organizationName",
} as const;

type ValueOption = keyof typeof VALUE_OPTIONS;

const isValueOption = (name: string): name is ValueOption =>
  Object.hasOwn(VALUE_OPTIONS, name);

/**
 * `owner`'s arguments: `rotate-credential` and its options, or `--help`.
 * `--owner-url` with a value is refused first, as `start` refuses it; no
 * refusal repeats a value or an argument it does not know.
 */
function parseOwnerArguments(argv: readonly string[]): OwnerArguments {
  refuseOwnerUrlInArgv(argv, PROGRAM);
  const [subcommand, ...rest] = argv;
  if (subcommand === "--help" || subcommand === "-h") return { help: true };
  if (subcommand === undefined) {
    throw new OwnerUsageError("requestport owner: a subcommand is required.");
  }
  if (subcommand !== "rotate-credential") {
    throw new OwnerUsageError("requestport owner: unknown subcommand.");
  }
  const parsed: OwnerArguments = { help: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] as string;
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (!isValueOption(name)) {
      throw new OwnerUsageError(
        `${PROGRAM}: ${argument.startsWith("-") ? "an option it does not take" : "an argument it does not take: it takes options only"}.`,
      );
    }
    const key = VALUE_OPTIONS[name];
    if (parsed[key] !== undefined) {
      throw new OwnerUsageError(`${PROGRAM}: ${name} is given twice.`);
    }
    let value: string | undefined;
    if (equals === -1) {
      index += 1;
      value = rest[index];
    } else {
      value = argument.slice(equals + 1);
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new OwnerUsageError(`${PROGRAM}: ${name} takes a value.`);
    }
    parsed[key] = value;
  }
  return parsed;
}

/** The person to rotate: the flags given, held to the domain's rules, else what `init.json` recorded. */
function personFrom(
  args: OwnerArguments,
  recorded: BootstrapDetails | undefined,
): BootstrapDetails {
  const fields = [
    ["--email", "email", normalizeEmail],
    ["--organization", "organizationSlug", normalizeSlug],
    ["--organization-name", "organizationName", normalizeName],
  ] as const;
  const person: Partial<BootstrapDetails> = {};
  for (const [option, key, normalize] of fields) {
    const value = args[key] ?? recorded?.[key];
    if (value === undefined) {
      throw new OwnerUsageError(
        `${PROGRAM}: ${INIT_FILE} records no ${option.slice(2)}; give ${option}.`,
      );
    }
    try {
      person[key] = normalize(value);
    } catch (error) {
      throw new OwnerUsageError(
        `${PROGRAM}: ${option}: ${error instanceof Error ? error.message : "invalid"}.`,
      );
    }
  }
  return person as BootstrapDetails;
}

export interface OwnerCommandIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

export interface OwnerCommandOptions {
  io?: OwnerCommandIo;
  /** The `operator` declaration this process makes before it connects: `declareDatabaseSurface`, unless a test watches it. */
  declareSurface?: (surface: "operator") => void;
  /** On pg: the owner's session (`openOperatorSession`), unless a test stands in. */
  openSession?: typeof openOperatorSession;
  /** On pg: the refusal of production's and staging's databases; a test's spy. */
  refuseSharedDatabase?: (
    connectionString: string,
    env: NodeJS.ProcessEnv,
  ) => void;
  /** On pg: the migrations the database's journal must hold, which a start applies and this never does. */
  migrationsFolder?: string;
}

const processIo: OwnerCommandIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

/** Rotates through `repository`, and prints the new credential once. */
async function rotate(
  repository: BootstrapOwnerRepository,
  person: BootstrapDetails,
  io: OwnerCommandIo,
  say: (line: string) => void,
): Promise<void> {
  const result = await bootstrapOwner(
    repository,
    {
      actor: BOOTSTRAP_OWNER_ACTOR,
      correlationId: `requestport_owner_${randomUUID()}`,
    },
    { ...person, localCredential: "rotate" },
  );
  if (
    result.status !== "owner_active" ||
    result.localCredential !== "rotated" ||
    !result.credential
  ) {
    throw new OwnerCommandError("the rotation issued no local credential.");
  }
  say(
    `rotated the local credential of ${person.email}, owner of ${person.organizationSlug}: the one before it no longer signs in, and their sessions and operator credentials are revoked. The new one follows on standard output, shown once.`,
  );
  io.stdout.write(`${result.credential}\n`);
  say(
    "the local credential above is shown once. Store it now: only its hash is kept.",
  );
}

/**
 * The rotation on PGlite, once this process holds the data directory's lock
 * and has declared `operator`. `buildOperatorStorage` is the operator root's
 * storage, `rootStorageFromEnv`, which reads `process.env`: the executable
 * passes `process.env` as `env`, where this writes the PGlite names before
 * it builds, having removed the login URLs, which name a server.
 */
async function rotateOnPglite(
  {
    dataDirectory,
    env,
    person,
    io,
    say,
  }: {
    dataDirectory: string;
    env: NodeJS.ProcessEnv;
    person: BootstrapDetails;
    io: OwnerCommandIo;
    say: (line: string) => void;
  },
  buildOperatorStorage: (surface: "operator") => Storage = rootStorageFromEnv,
): Promise<void> {
  for (const name of Object.values(LOGIN_URL_VARIABLES)) {
    if (env[name] === undefined) continue;
    delete env[name];
    say(
      `removed ${name} from this process's environment: on PGlite it connects to no server.`,
    );
  }
  env.REQUESTPORT_DATABASE_DRIVER = "pglite";
  env.REQUESTPORT_PGLITE_DATA_DIR = join(
    dataDirectory,
    PGLITE_DATABASE_DIRECTORY,
  );
  const storage = buildOperatorStorage("operator");
  try {
    await rotate(createFoundationRepository(storage.db), person, io, say);
  } finally {
    await storage.close();
  }
}

/** Runs `requestport owner …`, and answers the process's exit code. */
export async function runOwnerCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  {
    io = processIo,
    declareSurface = declareDatabaseSurface,
    openSession = openOperatorSession,
    refuseSharedDatabase = refuseUnapprovedSharedPgDatabase,
    migrationsFolder = packagedMigrationsFolder(),
  }: OwnerCommandOptions = {},
): Promise<number> {
  const say = (line: string) => io.stderr.write(`${PROGRAM}: ${line}\n`);
  let args: OwnerArguments;
  try {
    args = parseOwnerArguments(argv);
  } catch (error) {
    if (error instanceof OwnerUsageError) {
      io.stderr.write(`${error.message}\n\n${OWNER_USAGE}\n`);
      return 2;
    }
    if (error instanceof OwnerUrlError) {
      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
  if (args.help) {
    io.stdout.write(`${OWNER_USAGE}\n`);
    return 0;
  }

  let lock: ReturnType<typeof acquireInstanceLock> | undefined;
  try {
    const { path: dataDirectory } = resolveDataDirectory(args.dataDirectory, {
      env,
    });
    const marker = readInstanceMarker(dataDirectory);
    if (marker === undefined) {
      throw new OwnerCommandError(
        `${dataDirectory} holds no ${INIT_FILE}, so no instance: requestport start initialises one.`,
      );
    }
    const configuration = readConfiguration(dataDirectory);
    if (configuration === undefined) {
      throw new OwnerCommandError(`${dataDirectory} holds no config.json.`);
    }
    if (marker.complete !== true) {
      throw new OwnerCommandError(
        `${dataDirectory}'s first start has not completed (${INIT_FILE} is not complete). Run requestport start: it finishes the first start, and if an earlier one stopped after the owner's bootstrap, it rotates the credential and prints it itself.`,
      );
    }
    const person = personFrom(args, marker.bootstrap);

    if (configuration.storage === "pglite") {
      // One engine per data directory (§2.6 item 1; ruling 158, item 13).
      lock = acquireInstanceLock(dataDirectory, {
        holder: PROGRAM,
        log: (line) => io.stderr.write(`${line}\n`),
      });
      declareSurface("operator");
      await rotateOnPglite({ dataDirectory, env, person, io, say });
      return 0;
    }

    const ownerUrl = readOwnerFile(dataDirectory);
    if (ownerUrl === undefined) {
      throw new OwnerCommandError(`${dataDirectory} holds no ${OWNER_FILE}.`);
    }
    checkMigrationsFolder(migrationsFolder);
    declareSurface("operator");
    // Before the first statement, as a start's operator step does (§2.4).
    refuseSharedDatabase(ownerUrl, env);
    const session = await openSession({ ownerUrl, env });
    try {
      const checked = await session.check({
        instanceId: marker.instanceId,
        migrationsFolder,
      });
      say(
        `database ${checked.preflight.database} holds this instance's claim, and its journal holds each of the ${checked.migrations} migrations this requestport carries; the check created and migrated nothing.`,
      );
      await rotate(session.bootstrapRepository(), person, io, say);
    } finally {
      await session.close();
    }
    return 0;
  } catch (error) {
    if (error instanceof OwnerUsageError) {
      io.stderr.write(`${error.message}\n\n${OWNER_USAGE}\n`);
      return 2;
    }
    if (error instanceof DomainError) {
      say(
        `refused: ${error.code}${typeof error.details.field === "string" ? ` (${error.details.field})` : ""}: ${error.message}.`,
      );
      return 1;
    }
    if (
      error instanceof OwnerCommandError ||
      error instanceof OperatorStepError ||
      error instanceof OperatorRefusalError ||
      error instanceof DataDirectoryError ||
      error instanceof InstanceLockedError ||
      error instanceof ConfigurationError ||
      error instanceof OwnerUrlError
    ) {
      say(error.message);
      return 1;
    }
    say(`failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    lock?.release();
  }
}
