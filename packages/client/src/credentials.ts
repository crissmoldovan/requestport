import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { z } from "zod";

import {
  acquireLockSync,
  type HeldLock,
  LockTimeoutError,
  releaseLock,
} from "./lock.js";

/**
 * Where a developer's credentials live, namespaced to RequestPort.
 *
 * The directory shares a name with the one `project.ts` looks for, and that is
 * deliberate rather than shared: one sits in a checkout and answers "which
 * project", this one sits in `$HOME` and answers "may I". Naming them alike
 * makes the pair legible; wiring them to the same constant would let a change
 * to either move the other, which is how a secret ends up somewhere it can be
 * committed.
 */
export const CREDENTIAL_DIRECTORY = ".requestport";
export const CREDENTIAL_FILE = "credentials.json";

const KEYCHAIN_COMMAND = "security";
const KEYCHAIN_SERVICE_PREFIX = "requestport";

/**
 * How long one `security` call may run before it is killed.
 *
 * `security` can block for as long as a keychain prompt goes unanswered,
 * and a token source holds its lock across one read and one write of the
 * keychain store: three calls, because a write first removes the earlier
 * client's item. Three calls of 10 s and the refresh's 20 s come to 50 s,
 * under the 60 s after which another process may take that lock over
 * (`token-source.ts`). A call cut off here fails like any other failed
 * call, and its message says it did not answer in time. The bound is on
 * every call the store makes, not only those under the token lock, so a
 * keychain prompt left unanswered for 10 s fails the call that raised it,
 * the write `authorize` makes after the consent included.
 */
export const KEYCHAIN_COMMAND_TIMEOUT_MS = 10_000;

/**
 * What `security` returns for an item that is not there.
 *
 * Every other non-zero exit is a failure to *look*, not an answer, and the two
 * must not be confused: reading a locked keychain as "no credential" sends a
 * caller through an authorization it does not need and, in an ssh session,
 * cannot finish.
 */
const KEYCHAIN_NOT_FOUND = 44;

/**
 * The two endpoints an agent credential can be for, each with its own
 * resource on the server: `mcp` for the bridge, `api` for the HTTP client.
 *
 * A server accepts a token only at the endpoint its audience names, and one
 * registered client holds one grant (manifest-h.md §1.6), so each audience is
 * its own credential, from its own registration and consent.
 */
export const AUDIENCES = ["mcp", "api"] as const;

export type Audience = (typeof AUDIENCES)[number];

/**
 * The path each audience's resource has on its server: the agent resources
 * `packages/auth` publishes, the issuer plus `/mcp` and plus `/api/v1`.
 */
const AUDIENCE_PATHS: Readonly<Record<Audience, string>> = {
  api: "/api/v1",
  mcp: "/mcp",
};

export function isAudience(value: unknown): value is Audience {
  return value === "mcp" || value === "api";
}

/*
  `z.iso.datetime()` with seconds optional: what zod 4.4.3 answered for the
  client at 0.2.0, kept on zod 4.6.7. `@requestport/domain`'s
  `shared/zod-compat.ts` holds the same helper and says what moved; this
  package depends on no other workspace, so it keeps a copy here, beside
  its two uses.
*/
const isoDatetimePattern =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/;

/**
 * `z.iso.datetime()` with 4.4.3's pattern. zod's types leave `pattern` out
 * of a datetime's parameters, but its constructor keeps one it is given.
 */
function isoDatetime() {
  const params: Record<string, unknown> = { pattern: isoDatetimePattern };
  return z.iso.datetime(params as z.core.$ZodISODateTimeParams);
}

/**
 * A stored credential, version 2: what a refresh needs, and nothing else.
 *
 * `clientId` is the dynamic registration's. A refresh token is bound to the
 * client it was issued to, and the provider answers `invalid_grant` to a
 * refresh that names another, so a record without it can never be refreshed.
 * `resource` is the audience's resource on this server, sent with every
 * refresh so that each new token is minted for that endpoint. `obtained` is
 * when the authorization happened; a refresh does not change it.
 */
const CredentialSchema = z
  .object({
    audience: z.enum(AUDIENCES),
    clientId: z.string().min(1),
    obtained: isoDatetime(),
    refreshToken: z.string().min(1),
    resource: z.string().min(1),
    version: z.literal(2),
  })
  .strict();

export type StoredCredential = z.infer<typeof CredentialSchema>;

/**
 * What the client before version 2 stored: no client id, so it can never be
 * refreshed. Recognised only so that it can be refused, reported and removed.
 */
const LegacyCredentialSchema = z
  .object({
    obtained: isoDatetime(),
    refreshToken: z.string().min(1),
  })
  .strict();

/**
 * The field names, written out where a message can reach them.
 *
 * An error may say which field was wrong, and this literal is the only place a
 * field name may come from. A zod issue's path can carry a key the caller
 * supplied, and the rule this file is built around is that nothing derived
 * from the caller's data is ever formatted into a message.
 */
const CREDENTIAL_FIELDS = [
  "version",
  "audience",
  "clientId",
  "resource",
  "refreshToken",
  "obtained",
] as const;

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /**
   * True when the command was killed at `KEYCHAIN_COMMAND_TIMEOUT_MS`
   * instead of exiting.
   */
  timedOut?: boolean;
}

/**
 * How this module runs a command, so that a test never has to run a real one.
 *
 * It reports failure as a status rather than an exception on purpose. The
 * argument list handed to `security` contains the refresh token, so anything
 * that throws with argv attached — which is what the convenient helpers in
 * `node:child_process` do — turns a failed write into a disclosed credential.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
) => CommandResult;

/**
 * Credentials keyed by server, project and audience (manifest-h.md §2.8.2).
 *
 * `hasLegacyRecord` answers whether a record the client before version 2
 * stored is there for that server and project. `read` never returns one; it
 * is reported so that `requestport login` can say why it authorizes again.
 */
export interface CredentialStore {
  read(
    server: string,
    projectId: string,
    audience: Audience,
  ): StoredCredential | undefined;
  write(
    server: string,
    projectId: string,
    audience: Audience,
    credential: StoredCredential,
  ): void;
  clear(server: string, projectId: string, audience: Audience): void;
  hasLegacyRecord(server: string, projectId: string): boolean;
}

export interface KeychainStoreOptions {
  run?: CommandRunner;
}

export interface FileStoreOptions {
  home?: string;
}

export interface KeychainAvailabilityOptions {
  platform?: string;
  run?: CommandRunner;
}

export interface CredentialStoreOptions
  extends KeychainStoreOptions,
    FileStoreOptions,
    KeychainAvailabilityOptions {
  prefer?: "auto" | "file" | "keychain";
}

const runCommand: CommandRunner = (command, args) => {
  // Killed with SIGKILL, not the timeout's default SIGTERM: a command may
  // ignore SIGTERM, and `spawnSync` then waits for it to exit on its own,
  // past the timeout, however long that takes.
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: KEYCHAIN_COMMAND_TIMEOUT_MS,
  });

  // A command that cannot be launched at all comes back as a null status with
  // an `error` rather than as a throw, which is exactly the shape this module
  // wants: one code path for "it failed", none of them carrying argv. One
  // killed at the timeout comes back the same way, with ETIMEDOUT as the
  // error's code.
  const timedOut =
    (result.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT";

  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
    ...(timedOut ? { timedOut } : {}),
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduce a server to the key both stores agree on.
 *
 * The whole origin, not the bare host: a production server and a local one can
 * share a host and differ only in scheme or port, and a store that merged them
 * would hand an agent a production token for a development server.
 *
 * Which is why the scheme is checked rather than the origin. This used to
 * refuse only an origin of `null`, while claiming to refuse anything that is
 * not http or https — and those are not the same set. `ws:`, `wss:` and `ftp:`
 * all carry origins of their own and were stored under distinct keys; worse,
 * `blob:https://host/…` has the origin `https://host`, so a `blob:` server
 * would have been handed the https server's refresh token. That is exactly the
 * collision this function exists to prevent, reachable through the one check
 * that was meant to prevent it.
 *
 * What stops a `blob:` server is the scheme check below, which runs before
 * `origin` is read: whatever origin a `blob:` URL wraps, its own protocol is
 * `blob:`. The binding refuses one too (`isBindableServer` in `project.ts`
 * admits https, and http only on a loopback host), but this function does
 * not lean on that, because a server can reach it without a binding: a
 * caller may take one from argv.
 */
function serverOrigin(server: string): string {
  let url: URL;

  try {
    url = new URL(server);
  } catch {
    throw new CredentialStoreError(
      `${server} is not a server URL, so no credential can be stored against it.`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CredentialStoreError(
      `${server} has no origin to key a credential by; an http or https server is required.`,
    );
  }

  return url.origin;
}

function assertAudience(audience: unknown): Audience {
  if (isAudience(audience)) return audience;

  throw new CredentialStoreError(
    "A credential is stored for the mcp or the api audience, and no other.",
  );
}

/**
 * The resource a credential for this audience names: the server's origin
 * plus the audience's path. The one place it is composed, so that what
 * `authorize` asks for and what the stores require cannot differ.
 */
export function resourceFor(server: string, audience: Audience): string {
  return `${serverOrigin(server)}${AUDIENCE_PATHS[assertAudience(audience)]}`;
}

function parseCredential(
  value: unknown,
  origin: string,
  projectId: string,
  audience: Audience,
): StoredCredential {
  const which = `The ${audience} credential for project ${projectId} on ${origin}`;
  const result = CredentialSchema.safeParse(value);

  if (!result.success) {
    const invalid = CREDENTIAL_FIELDS.filter((field) =>
      result.error.issues.some((issue) => issue.path[0] === field),
    );

    throw new CredentialStoreError(
      `${which} is not usable — ${
        invalid.length > 0
          ? `check ${invalid.join(" and ")}`
          : "it is not an object holding exactly version 2's fields"
      }.`,
    );
  }

  if (result.data.audience !== audience) {
    throw new CredentialStoreError(
      `${which} does not name the ${audience} audience it is kept under.`,
    );
  }

  // Compared with the expected value, which is the one the message names:
  // the record's own resource is the caller's text.
  const expected = `${origin}${AUDIENCE_PATHS[audience]}`;
  if (result.data.resource !== expected) {
    throw new CredentialStoreError(
      `${which} is not usable — its resource is not ${expected}, the ${audience} resource of this server.`,
    );
  }

  return result.data;
}

/**
 * Say what went wrong with the least that is provably safe to say.
 *
 * An errno symbol is a fixed word from a fixed set, so it can be repeated. The
 * error's own message cannot: `node:fs` puts the path in it and a JSON parser
 * puts a slice of its input in it, and here that input is the token.
 */
function errorCode(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined;

  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/u.test(code)
    ? ` (${code})`
    : "";
}

/**
 * How a `security` call that failed ended, for a message: its exit status,
 * or that it was killed at the timeout. Nothing it printed is repeated.
 */
function ended(result: CommandResult): string {
  return result.timedOut === true
    ? `${KEYCHAIN_COMMAND} did not answer within ${KEYCHAIN_COMMAND_TIMEOUT_MS / 1000}s`
    : `${KEYCHAIN_COMMAND} exited ${result.status}`;
}

/**
 * The item's service name. With an audience it is version 2's; without one
 * it is the name the client before version 2 stored under, which is only
 * ever looked for, to be reported or removed.
 */
function keychainService(
  origin: string,
  projectId: string,
  audience?: Audience,
): string {
  const service = `${KEYCHAIN_SERVICE_PREFIX}:${origin}:${projectId}`;
  return audience === undefined ? service : `${service}:${audience}`;
}

/**
 * The OS keychain, reached through the `security` binary macOS already ships.
 *
 * A credential kept here is protected by the keychain rather than by this
 * code, which is the reason to prefer it: it survives a careless `chmod`, it
 * is revoked where a developer expects to revoke it, and no amount of tooling
 * around it can accidentally read it into a log.
 *
 * The token does travel in argv, where the process table can see it for the
 * lifetime of the spawn. `security` offers no way to pass a password on stdin
 * non-interactively, so the choice is that exposure or no keychain at all; it
 * is a smaller window than a file that sits at rest, and the file store is the
 * documented alternative for anyone who disagrees.
 */
export function createKeychainStore(
  options: KeychainStoreOptions = {},
): CredentialStore {
  const { run = runCommand } = options;

  function invoke(args: readonly string[], about: string): CommandResult {
    try {
      return run(KEYCHAIN_COMMAND, args);
    } catch {
      throw new CredentialStoreError(
        `Could not run ${KEYCHAIN_COMMAND} for ${about}.`,
      );
    }
  }

  /**
   * Remove one item. Removing what is already gone is the state the caller
   * asked for, and a sign-out that fails because it half-succeeded earlier
   * helps nobody.
   */
  function remove(
    origin: string,
    projectId: string,
    audience: Audience | undefined,
    about: string,
  ): void {
    const result = invoke(
      [
        "delete-generic-password",
        "-a",
        projectId,
        "-s",
        keychainService(origin, projectId, audience),
      ],
      about,
    );
    if (result.status === 0 || result.status === KEYCHAIN_NOT_FOUND) return;

    throw new CredentialStoreError(
      `Could not remove the keychain credential for ${about} (${ended(result)}).`,
    );
  }

  return {
    clear(server, projectId, audience) {
      const origin = serverOrigin(server);
      const which = assertAudience(audience);
      const about = `the ${which} audience of project ${projectId} on ${origin}`;

      remove(origin, projectId, which, about);
      remove(origin, projectId, undefined, `project ${projectId} on ${origin}`);
    },

    hasLegacyRecord(server, projectId) {
      const origin = serverOrigin(server);
      const about = `project ${projectId} on ${origin}`;
      // Without `-w`, `security` answers whether the item exists and prints
      // its attributes, never its secret.
      const result = invoke(
        [
          "find-generic-password",
          "-a",
          projectId,
          "-s",
          keychainService(origin, projectId),
        ],
        about,
      );

      if (result.status === 0) return true;
      if (result.status === KEYCHAIN_NOT_FOUND) return false;
      throw new CredentialStoreError(
        `Could not look for an earlier keychain credential for ${about} (${ended(result)}).`,
      );
    },

    read(server, projectId, audience) {
      const origin = serverOrigin(server);
      const which = assertAudience(audience);
      const about = `the ${which} audience of project ${projectId} on ${origin}`;
      const result = invoke(
        [
          "find-generic-password",
          "-a",
          projectId,
          "-s",
          keychainService(origin, projectId, which),
          "-w",
        ],
        about,
      );

      if (result.status === KEYCHAIN_NOT_FOUND) return undefined;
      if (result.status !== 0) {
        throw new CredentialStoreError(
          `Could not read the keychain credential for ${about} (${ended(result)}).`,
        );
      }

      // `security -w` terminates the secret with a newline of its own. Strip
      // exactly that and nothing else: trimming would silently alter a token
      // rather than fail, and a store that returns a nearly-right credential
      // is worse than one that returns none.
      const payload = result.stdout.replace(/\n$/u, "");

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new CredentialStoreError(
          `The keychain item for ${about} does not hold a usable credential.`,
        );
      }

      return parseCredential(parsed, origin, projectId, which);
    },

    write(server, projectId, audience, credential) {
      const origin = serverOrigin(server);
      const which = assertAudience(audience);
      const valid = parseCredential(credential, origin, projectId, which);
      const about = `the ${which} audience of project ${projectId} on ${origin}`;

      // The earlier client's item goes first. If it cannot be removed the
      // write stops here, and nothing new is stored beside a record that can
      // never work.
      remove(origin, projectId, undefined, `project ${projectId} on ${origin}`);

      const result = invoke(
        [
          "add-generic-password",
          "-a",
          projectId,
          "-s",
          keychainService(origin, projectId, which),
          // `-U` updates an item that is already there. Without it a second
          // authorization fails as a duplicate and the developer keeps using
          // the credential they were trying to replace.
          "-U",
          "-w",
          JSON.stringify(valid),
        ],
        about,
      );

      if (result.status === 0) return;

      // `security` writes its own diagnostics to stderr, and its diagnostics
      // quote the arguments it was given — the token among them. Nothing it
      // said is repeated here; how it ended is the whole of what is safe.
      throw new CredentialStoreError(
        `Could not store the keychain credential for ${about} (${ended(result)}).`,
      );
    },
  };
}

/**
 * How long a writer of the credential file waits for another, and when it
 * takes over a lock left behind. A write is one read, one write and one
 * rename of a small file, so a holder of ten seconds has died or been
 * suspended.
 */
const FILE_LOCK = { staleAfterMs: 10_000, waitMs: 15_000 } as const;

/** What a project's entry in the file is. */
type Entry =
  | { readonly kind: "absent" }
  | { readonly kind: "audiences"; readonly records: Record<string, unknown> }
  | { readonly kind: "legacy" }
  | { readonly kind: "unknown" };

/**
 * Version 2 keeps an object of audiences under the project id; the client
 * before it kept the record itself there. Anything else is neither, and may
 * be a later client's, so it is refused rather than read or replaced.
 */
function classify(entry: unknown): Entry {
  if (entry === undefined) return { kind: "absent" };
  if (!isRecord(entry)) return { kind: "unknown" };
  if (Object.keys(entry).every(isAudience)) {
    return { kind: "audiences", records: entry };
  }
  if (LegacyCredentialSchema.safeParse(entry).success) {
    return { kind: "legacy" };
  }
  return { kind: "unknown" };
}

/**
 * The file store, for every machine that has no keychain worth using.
 *
 * A container, a CI runner and a remote shell all have `$HOME` and none of
 * them have a keychain a person is present to unlock. Here the mode *is* the
 * protection, which is why it is set twice — see `persist`.
 *
 * Every credential on the machine is in this one file, and processes write
 * it: each refresh rewrites it. A writer reads the file, changes its own
 * entry and writes the whole file back, so two writers interleaved would
 * lose one of the two changes, and a lost rotation leaves the rotated token
 * on disk. So each write holds a lock beside the file (`lock.ts`) from the
 * read to the write, and the new file replaces the old by a rename, so a
 * reader sees the whole old file or the whole new one, never part of either.
 */
export function createFileStore(
  options: FileStoreOptions = {},
): CredentialStore {
  const { home = homedir() } = options;
  const directory = join(home, CREDENTIAL_DIRECTORY);
  const path = join(directory, CREDENTIAL_FILE);
  const lockPath = join(directory, `${CREDENTIAL_FILE}.lock`);

  /**
   * Read the whole file, or refuse.
   *
   * A file that will not parse is never treated as an empty one. The
   * difference matters most on the write path, where "assume it was empty"
   * means overwriting credentials for every other server on the machine
   * because one byte went wrong.
   */
  function readAll(): Record<string, unknown> {
    if (!existsSync(path)) return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Not one character of the file is echoed. It holds refresh tokens, and
      // a malformed file is exactly where a parser would want to quote one.
      throw new CredentialStoreError(
        `${path} is not valid JSON. Refusing to read or replace it rather than risk what it holds.`,
      );
    }

    if (!isRecord(parsed)) {
      throw new CredentialStoreError(
        `${path} is not a credential file. Refusing to replace it.`,
      );
    }

    return parsed;
  }

  function entryOf(
    contents: Record<string, unknown>,
    origin: string,
    projectId: string,
  ): Entry {
    const forServer = contents[origin];
    const entry = classify(
      isRecord(forServer) ? forServer[projectId] : undefined,
    );

    if (entry.kind === "unknown") {
      throw new CredentialStoreError(
        `${path} holds an entry for project ${projectId} on ${origin} that is neither a version 2 credential nor an earlier one. Refusing to read or replace it.`,
      );
    }
    return entry;
  }

  function persist(
    contents: Record<string, unknown>,
    origin: string,
    projectId: string,
  ): void {
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;

    try {
      mkdirSync(directory, { mode: 0o700, recursive: true });
      writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });

      // Both modes are applied again, because both `mode` options above are
      // requests rather than guarantees: the directory's applies only when it
      // is created, so one left at 0755 by an older version keeps that mode,
      // and the process umask can clear bits of either on creation. The file
      // is new each time, so the one renamed into place carries this mode.
      chmodSync(directory, 0o700);
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw new CredentialStoreError(
        `Could not store the credential for project ${projectId} on ${origin} in ${path}${errorCode(error)}.`,
      );
    }
  }

  /** Read, change and write the file under the writers' lock. */
  function update(
    origin: string,
    projectId: string,
    change: (
      contents: Record<string, unknown>,
    ) => Record<string, unknown> | undefined,
  ): void {
    let lock: HeldLock;
    try {
      mkdirSync(directory, { mode: 0o700, recursive: true });
      lock = acquireLockSync(lockPath, FILE_LOCK);
    } catch (error) {
      // The lock's own message names the lock and its holder, and no secret.
      throw new CredentialStoreError(
        error instanceof LockTimeoutError
          ? error.message
          : `Could not lock ${path} to store the credential for project ${projectId} on ${origin}${errorCode(error)}.`,
      );
    }

    try {
      const next = change(readAll());
      if (next !== undefined) persist(next, origin, projectId);
    } finally {
      releaseLock(lock);
    }
  }

  return {
    clear(server, projectId, audience) {
      const origin = serverOrigin(server);
      const which = assertAudience(audience);
      // No file holds nothing to clear, and a sign-out creates nothing.
      if (!existsSync(path)) return;

      update(origin, projectId, (contents) => {
        const entry = entryOf(contents, origin, projectId);
        if (entry.kind === "absent") return undefined;
        if (entry.kind === "audiences" && !(which in entry.records)) {
          return undefined;
        }

        // An earlier client's record goes whole; of version 2's, only this
        // audience's.
        const remaining =
          entry.kind === "audiences"
            ? Object.fromEntries(
                Object.entries(entry.records).filter(([key]) => key !== which),
              )
            : {};
        const forServer = contents[origin] as Record<string, unknown>;
        const projects = Object.fromEntries(
          Object.entries(forServer).filter(([key]) => key !== projectId),
        );
        if (Object.keys(remaining).length > 0) projects[projectId] = remaining;

        // A project, then a server, with no credentials left is removed rather
        // than kept as an empty husk, so the file reads as the list of servers
        // a developer is actually signed in to.
        const next = Object.fromEntries(
          Object.entries(contents).filter(([key]) => key !== origin),
        );
        if (Object.keys(projects).length > 0) next[origin] = projects;

        return next;
      });
    },

    hasLegacyRecord(server, projectId) {
      const origin = serverOrigin(server);
      return entryOf(readAll(), origin, projectId).kind === "legacy";
    },

    read(server, projectId, audience) {
      const origin = serverOrigin(server);
      const which = assertAudience(audience);
      const entry = entryOf(readAll(), origin, projectId);
      if (entry.kind !== "audiences") return undefined;

      const record = entry.records[which];
      if (record === undefined) return undefined;

      return parseCredential(record, origin, projectId, which);
    },

    write(server, projectId, audience, credential) {
      const origin = serverOrigin(server);
      const which = assertAudience(audience);
      const valid = parseCredential(credential, origin, projectId, which);

      update(origin, projectId, (contents) => {
        const entry = entryOf(contents, origin, projectId);
        const forServer = contents[origin];

        // An earlier client's record is replaced, not carried over: it has no
        // client id to carry.
        return {
          ...contents,
          [origin]: {
            ...(isRecord(forServer) ? forServer : {}),
            [projectId]: {
              ...(entry.kind === "audiences" ? entry.records : {}),
              [which]: valid,
            },
          },
        };
      });
    },
  };
}

/**
 * Whether this machine has a keychain worth reaching for.
 *
 * Asked by running the read-only command, not by trusting the platform alone:
 * `security` exists on every mac and works on rather fewer of them — a build
 * agent has no login keychain, and a remote shell may not be able to reach
 * one. The platform check comes first only so that no subprocess is spawned
 * where the answer is already known.
 */
export function isKeychainAvailable(
  options: KeychainAvailabilityOptions = {},
): boolean {
  const { platform = process.platform, run = runCommand } = options;
  if (platform !== "darwin") return false;

  try {
    return run(KEYCHAIN_COMMAND, ["list-keychains", "-d", "user"]).status === 0;
  } catch {
    return false;
  }
}

/**
 * Pick a store, and tell the caller nothing about which one it got.
 *
 * The trade genuinely differs by machine — a laptop has a keychain worth using
 * and a container does not — so it is decided per machine and overridable by
 * the person running the thing, who knows more than the probe does. What the
 * caller gets back is four methods and no way to ask: a resolver that could
 * branch on the answer would grow a path that only ever runs on one kind of
 * machine, and that path is the one nobody tests.
 */
export function createCredentialStore(
  options: CredentialStoreOptions = {},
): CredentialStore {
  const { prefer = "auto" } = options;
  const keychain =
    prefer === "keychain" ||
    (prefer === "auto" && isKeychainAvailable(options));

  return keychain ? createKeychainStore(options) : createFileStore(options);
}
