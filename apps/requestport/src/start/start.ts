import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  normalizeEmail,
  normalizeName,
  normalizeSlug,
} from "@requestport/domain";

import { removeTemporaryFiles } from "../atomic-file.js";
import {
  ConfigurationError,
  generateSecrets,
  type InstanceConfiguration,
  type InstanceConfigurationInput,
  isLoopbackBindHost,
  isRecordablePublicUrl,
  PUBLIC_URL_RULE,
  readConfiguration,
  readSecrets,
  type StorageKind,
  writeConfiguration,
  writeSecrets,
} from "../configuration.js";
import {
  DataDirectoryError,
  prepareDataDirectory,
  resolveDataDirectory,
} from "../data-directory.js";
import { acquireInstanceLock, InstanceLockedError } from "../instance-lock.js";
import {
  type BootstrapDetails,
  type InstanceMarker,
  newInstanceId,
  readInstanceMarker,
  writeInstanceMarker,
} from "../instance-marker.js";
import {
  operatorChildCommand,
  operatorExit,
  type SpawnOperator,
} from "../operator/command.js";
import {
  type InputStream,
  type OutputStream,
  OWNER_FILE,
  OWNER_URL_FORMS,
  OwnerUrlError,
  receiveOwnerUrl,
  writeOwnerFile,
} from "../owner-url.js";
import { serveFromDataDirectory } from "../serve/run.js";
import {
  locateSelfHostWeb,
  type SelfHostWeb,
  SelfHostWebError,
} from "../serve/web.js";
import {
  refuseInheritedServerActionKey,
  ServerActionKeyError,
} from "../server-action-key.js";
import {
  parseStartArguments,
  START_USAGE,
  type StartArguments,
  StartUsageError,
} from "./arguments.js";

/**
 * `requestport start`'s process (manifest-h.md §2.3, §2.3.1, §2.4, §2.5,
 * §2.6): it takes the data directory's lock, removes what a stopped write
 * left (ruling 158, 12), writes each file a first start needs that is not
 * there yet, in order (B1 `init.json`, B2 `config.json`, B3 `secrets.json`,
 * and on pg B4 `owner.json`), records the bootstrap's email and organisation
 * in `init.json`, holds a later start's flags to what `config.json` records
 * (`reconcileConfiguration`: the public URL is pinned, and only
 * `--public-url` changes it; the storage never changes), and runs the
 * operator step as a child process whose one argument after its entry is the
 * data directory. It never puts the owner URL in an environment or an
 * argument, and once `owner.json` is written it keeps no reference to it.
 * PGlite has no owner URL, and binds a loopback address only (§2.6 item 5).
 * Before it makes the data directory or writes anything, it finds the web
 * UI's self-host build it will serve (`serve/web.ts`), and refuses a start
 * that has none: a first start would otherwise migrate, make the owner and
 * print the one-time credential, then refuse (H.7 round 5's review). For the
 * same reason, it refuses then an environment that already sets
 * `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, which the serving step refuses too:
 * the web UI's server-action key is the data directory's
 * (`../server-action-key.ts`; ruling 201 item 4).
 * Once the child has exited 0, this process serves the instance
 * (`serve/run.ts`) until a signal stops it, holding the lock throughout: on
 * PGlite, the child has closed the database before this process opens it
 * (§2.6 item 1).
 */

/** The first start's boundaries the parent crosses (§2.3.1's table). */
export type StartBoundary = "B1" | "B2" | "B3" | "B4";

export const DEFAULT_PORT = 3200;
export const DEFAULT_HOST = "127.0.0.1";

export interface StartIo {
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
}

export interface StartOptions {
  io?: StartIo;
  /** How the operator child is started: `spawn`, unless a test records it. */
  spawnOperator?: SpawnOperator;
  /** The operator child's entry: the shipped one, unless a test names its own. */
  operatorEntry?: string;
  /**
   * Called as the parent crosses each of its boundaries. For the first
   * start's crash tests (§2.3.1's proof); the CLI passes none.
   */
  afterBoundary?: (boundary: StartBoundary) => void | Promise<void>;
  uid?: number;
  /**
   * Finds the web UI's self-host build, before anything is written:
   * `locateSelfHostWeb` (`serve/web.ts`) at its default directory, which is
   * `@requestport/web`'s, packed, unless a test stands in for it. A
   * `SelfHostWebError` is this start's refusal.
   */
  locateWeb?: () => SelfHostWeb;
  /**
   * Serves the instance once the operator step has exited 0, while this
   * process holds the data directory's lock, from the web UI's directory
   * `locateWeb` found, and answers the exit code: `serveFromDataDirectory`
   * (`serve/run.ts`), which looks it up again as it serves, unless a test
   * stands in for it or hands it its own hooks.
   */
  serve?: (context: {
    dataDirectory: string;
    env: NodeJS.ProcessEnv;
    io: StartIo;
    webDirectory: string;
  }) => Promise<number>;
}

const processIo: StartIo = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
};

/** One line of `input`, as the terminal's line discipline delivers it (echoed, with its own editing). */
function readLine(input: InputStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
      if (error) reject(error);
      else resolve(text.split(/\r?\n/u)[0] ?? "");
    };
    const onData = (chunk: Buffer | string) => {
      text += chunk.toString();
      if (text.includes("\n")) finish();
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

function normalized(
  option: string,
  normalize: (value: string) => string,
  value: string,
): string {
  try {
    return normalize(value);
  } catch (error) {
    throw new StartUsageError(
      `${option}: ${error instanceof Error ? error.message : "invalid"}.`,
    );
  }
}

/** The public URL a start derives when `--public-url` is not given: `http://<host>:<port>`. */
function defaultPublicUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** The configuration a first start records, from the flags and the defaults. */
function configurationFrom(args: StartArguments, storage: StorageKind) {
  const port = args.port ?? DEFAULT_PORT;
  const host = args.host ?? DEFAULT_HOST;
  return {
    version: 1 as const,
    storage,
    publicUrl: args.publicUrl ?? defaultPublicUrl(host, port),
    port,
    host,
    ...(args.trustedProxy === undefined
      ? {}
      : { trustedProxy: args.trustedProxy }),
  };
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * What a later start's configuration flags do to what `config.json` records
 * (manifest-h.md §2.3: the public URL is pinned by the first start; agent
 * grants are bound to it):
 * - without `--public-url`, every flag given must equal what is recorded, or
 *   the start is refused before anything runs. A `--port` or `--host` that
 *   differs, where the recorded public URL is the one a first start derives
 *   from them, would also move the public URL, and the refusal names the URL
 *   it would move to and `--public-url`;
 * - with `--public-url`, the flags given are what `config.json` records from
 *   then on, written before the operator step runs. The answer carries the
 *   public URL it replaces when that URL changes.
 */
function reconcileConfiguration(
  args: StartArguments,
  recorded: InstanceConfiguration,
):
  | { change: "none" }
  | {
      change: "recorded";
      configuration: InstanceConfigurationInput;
      replacedPublicUrl?: string;
    } {
  if (args.publicUrl !== undefined) {
    const configuration: InstanceConfigurationInput = {
      ...recorded,
      publicUrl: args.publicUrl,
      port: args.port ?? recorded.port,
      host: args.host ?? recorded.host,
      ...(args.trustedProxy === undefined
        ? {}
        : { trustedProxy: args.trustedProxy }),
    };
    const unchanged =
      safeOrigin(args.publicUrl) === recorded.publicUrl &&
      configuration.port === recorded.port &&
      configuration.host === recorded.host &&
      configuration.trustedProxy === recorded.trustedProxy;
    if (unchanged) return { change: "none" };
    return {
      change: "recorded",
      configuration,
      ...(safeOrigin(args.publicUrl) === recorded.publicUrl
        ? {}
        : { replacedPublicUrl: recorded.publicUrl }),
    };
  }

  const given: [string, unknown, unknown][] = [
    ["--port", args.port, recorded.port],
    ["--host", args.host, recorded.host],
    ["--trusted-proxy", args.trustedProxy, recorded.trustedProxy],
  ];
  for (const [option, value, current] of given) {
    if (value === undefined || value === current) continue;
    const derived =
      recorded.publicUrl ===
      safeOrigin(defaultPublicUrl(recorded.host, recorded.port));
    const moved =
      option === "--trusted-proxy" || !derived
        ? undefined
        : safeOrigin(
            defaultPublicUrl(
              args.host ?? recorded.host,
              args.port ?? recorded.port,
            ),
          );
    throw new StartUsageError(
      moved === undefined || moved === recorded.publicUrl
        ? `${option} differs from what this data directory's config.json records. A later start changes config.json only when --public-url names the public URL beside it.`
        : `${option} differs from what this data directory's config.json records, and would move the public URL its first start pinned, ${recorded.publicUrl}, to ${moved}. ${publicUrlChangeConsequences(recorded.publicUrl)} To change it, name the new URL with --public-url ${moved}.`,
    );
  }
  return { change: "none" };
}

/** What a public URL change does, as a refusal and a change both say it (§2.3; ruling 158, item 18). */
function publicUrlChangeConsequences(from: string): string {
  return `Agent grants are bound to the public URL: those bound to ${from} stop working once it changes. The OAuth resource rows for ${from} stay in the database, since Better Auth inserts a row for each resource it does not hold and removes none.`;
}

const BOOTSTRAP_FIELDS = [
  ["--email", "email", "Owner's email address: ", normalizeEmail],
  [
    "--organization",
    "organizationSlug",
    "Organisation's slug: ",
    normalizeSlug,
  ],
  [
    "--organization-name",
    "organizationName",
    "Organisation's name: ",
    normalizeName,
  ],
] as const;

/** The bootstrap flags given, each held to the domain's own rule, which the bootstrap applies again. */
function bootstrapDetailsGiven(
  args: StartArguments,
): Partial<BootstrapDetails> {
  const values = {
    email: args.email,
    organizationSlug: args.organizationSlug,
    organizationName: args.organizationName,
  };
  const given: Partial<BootstrapDetails> = {};
  for (const [option, key, , normalize] of BOOTSTRAP_FIELDS) {
    const value = values[key];
    if (value !== undefined) given[key] = normalized(option, normalize, value);
  }
  return given;
}

/** The bootstrap's details: the flags given, and at a terminal the rest asked for. */
async function bootstrapDetails(
  given: Partial<BootstrapDetails>,
  io: StartIo,
): Promise<BootstrapDetails> {
  const details: Partial<BootstrapDetails> = { ...given };
  for (const [option, key, question, normalize] of BOOTSTRAP_FIELDS) {
    if (details[key] !== undefined) continue;
    io.stderr.write(question);
    details[key] = normalized(option, normalize, await readLine(io.stdin));
  }
  return details as BootstrapDetails;
}

/** Runs `requestport start`, and answers the process's exit code. */
export async function runStart(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  {
    io = processIo,
    spawnOperator = spawn,
    operatorEntry,
    afterBoundary = () => undefined,
    uid = process.getuid?.(),
    locateWeb = () => locateSelfHostWeb(),
    serve = serveFromDataDirectory,
  }: StartOptions = {},
): Promise<number> {
  const say = (line: string) => io.stderr.write(`requestport start: ${line}\n`);
  let args: StartArguments;
  try {
    args = parseStartArguments(argv);
  } catch (error) {
    if (error instanceof StartUsageError) {
      io.stderr.write(
        `requestport start: ${error.message}\n\n${START_USAGE}\n`,
      );
      return 2;
    }
    if (error instanceof OwnerUrlError) {
      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
  if (args.help) {
    io.stdout.write(`${START_USAGE}\n`);
    return 0;
  }

  let lock: ReturnType<typeof acquireInstanceLock> | undefined;
  try {
    // Before anything is written or compared, on a first start and a later
    // one alike (Done when 4): a later start compares only the value's
    // origin with what config.json records, so a value whose origin is the
    // recorded one would otherwise be ignored rather than refused. The value
    // is never repeated: a user name or password in it may be secret.
    if (
      args.publicUrl !== undefined &&
      !isRecordablePublicUrl(args.publicUrl)
    ) {
      throw new StartUsageError(`--public-url ${PUBLIC_URL_RULE}.`);
    }
    // Before the data directory is made or anything written: on an install
    // that cannot serve the web UI, or in an environment that already sets
    // the server-action key's variable, which the serving step refuses, a
    // first start would otherwise run its whole first start, the one-time
    // credential printed, and then refuse.
    const web = locateWeb();
    refuseInheritedServerActionKey(env);
    const { path: dataDirectory } = resolveDataDirectory(args.dataDirectory, {
      env,
    });
    prepareDataDirectory(dataDirectory, uid === undefined ? {} : { uid });
    lock = acquireInstanceLock(dataDirectory, {
      holder: "requestport start",
      log: (line) => io.stderr.write(`${line}\n`),
    });
    const removed = removeTemporaryFiles(lock);
    if (removed.length > 0) {
      say(
        `removed ${removed.join(", ")}, left by a start that stopped while writing.`,
      );
    }

    let marker: InstanceMarker | undefined = readInstanceMarker(dataDirectory);
    const recordedStorage = readConfiguration(dataDirectory)?.storage;
    if (
      recordedStorage !== undefined &&
      args.storage !== undefined &&
      args.storage !== recordedStorage
    ) {
      throw new StartUsageError(
        `--storage differs from what this data directory's config.json records, ${recordedStorage}. A data directory's storage never changes.`,
      );
    }
    const storage: StorageKind = recordedStorage ?? args.storage ?? "pg";
    if (storage === "pglite") {
      // Refused before anything is written (§2.6 item 5).
      if (args.ownerUrlForm !== undefined) {
        throw new StartUsageError(
          "PGlite takes no owner URL: its database is inside the data directory. --owner-url-file and --owner-url-stdin are for PostgreSQL.",
        );
      }
      if (args.host !== undefined && !isLoopbackBindHost(args.host)) {
        throw new StartUsageError(
          "--host: PGlite serves one user on this machine, and row-level security does not apply to it, so it binds a loopback address only (localhost, 127.0.0.0/8 or ::1).",
        );
      }
    }
    // Its presence only: the parent writes owner.json and never opens it to
    // read (§2.4).
    const ownerFilePresent =
      storage === "pg" && existsSync(join(dataDirectory, OWNER_FILE));
    const givenBootstrap = bootstrapDetailsGiven(args);
    // What a first start will ask for, refused before anything is written
    // when there is no terminal to ask at.
    if (
      storage === "pg" &&
      !ownerFilePresent &&
      args.ownerUrlForm === undefined &&
      io.stdin.isTTY !== true
    ) {
      throw new OwnerUrlError(
        `requestport start: this data directory has no owner URL yet, and standard input is not a terminal to ask at. ${OWNER_URL_FORMS}`,
        2,
      );
    }
    const needsBootstrap =
      marker?.complete !== true && marker?.bootstrap === undefined;
    if (needsBootstrap && io.stdin.isTTY !== true) {
      const missing = BOOTSTRAP_FIELDS.filter(
        ([, key]) => givenBootstrap[key] === undefined,
      ).map(([option]) => option);
      if (missing.length > 0) {
        throw new StartUsageError(
          `a first start needs ${missing.join(", ")}, and standard input is not a terminal to ask at.`,
        );
      }
    }
    if (ownerFilePresent && args.ownerUrlForm !== undefined) {
      say(
        `${dataDirectory}'s owner.json already holds the owner URL; the ${args.ownerUrlForm.kind === "file" ? "--owner-url-file" : "--owner-url-stdin"} given was not read.`,
      );
    }

    if (marker === undefined) {
      marker = writeInstanceMarker(dataDirectory, {
        version: 1,
        instanceId: newInstanceId(),
      });
      await afterBoundary("B1");
    }

    const recorded = readConfiguration(dataDirectory);
    if (recorded === undefined) {
      writeConfiguration(dataDirectory, configurationFrom(args, storage));
      await afterBoundary("B2");
    } else {
      const reconciled = reconcileConfiguration(args, recorded);
      if (reconciled.change === "recorded") {
        const written = writeConfiguration(
          dataDirectory,
          reconciled.configuration,
        );
        say(
          reconciled.replacedPublicUrl === undefined
            ? `config.json records the configuration given, at the public URL ${written.publicUrl}.`
            : `the public URL changes from ${reconciled.replacedPublicUrl} to ${written.publicUrl}, as --public-url names, and config.json records it. ${publicUrlChangeConsequences(reconciled.replacedPublicUrl)}`,
        );
      }
    }

    if (readSecrets(dataDirectory, storage) === undefined) {
      writeSecrets(dataDirectory, generateSecrets(storage), storage);
      await afterBoundary("B3");
    }

    if (storage === "pg" && !ownerFilePresent) {
      writeOwnerFile(
        dataDirectory,
        await receiveOwnerUrl(args.ownerUrlForm ?? { kind: "prompt" }, {
          input: io.stdin,
          output: io.stderr,
          ...(uid === undefined ? {} : { uid }),
        }),
      );
      await afterBoundary("B4");
    }

    if (marker.complete !== true && marker.bootstrap === undefined) {
      marker = writeInstanceMarker(dataDirectory, {
        ...marker,
        bootstrap: await bootstrapDetails(givenBootstrap, io),
      });
    } else if (marker.complete !== true && marker.bootstrap !== undefined) {
      for (const [option, key] of BOOTSTRAP_FIELDS) {
        const given = givenBootstrap[key];
        if (given !== undefined && given !== marker.bootstrap[key]) {
          throw new StartUsageError(
            `${option} differs from what init.json recorded for this first start's bootstrap.`,
          );
        }
      }
    }

    const { command, args: childArgs } = operatorChildCommand(
      dataDirectory,
      operatorEntry,
    );
    const child = spawnOperator(command, childArgs, {
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const exit = await operatorExit(child);
    if (exit.code === 0) {
      return await serve({
        dataDirectory,
        env,
        io,
        webDirectory: web.directory,
      });
    }
    say(
      exit.signal === null
        ? `the operator step exited with code ${exit.code}.`
        : `the operator step was stopped by ${exit.signal}.`,
    );
    return 1;
  } catch (error) {
    if (error instanceof StartUsageError) {
      io.stderr.write(
        `requestport start: ${error.message}\n\n${START_USAGE}\n`,
      );
      return 2;
    }
    if (error instanceof OwnerUrlError) {
      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof SelfHostWebError) {
      say(`${error.name}: ${error.message}`);
      return 1;
    }
    if (
      error instanceof DataDirectoryError ||
      error instanceof InstanceLockedError ||
      error instanceof ConfigurationError ||
      error instanceof ServerActionKeyError
    ) {
      say(error.message);
      return 1;
    }
    throw error;
  } finally {
    lock?.release();
  }
}
