import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic-file.js";

/**
 * The web UI's server-action key (Plan 13, ruling 201 item 4): the AES-GCM
 * key Next encrypts and decrypts server actions' bound arguments with
 * (`next@16.4.2` `dist/server/app-render/encryption.js:44-73`, through
 * `getActionEncryptionKey`, `encryption-utils.js:73-87` beside it).
 * Next's build generates one and writes it into
 * `server/server-reference-manifest.json`, which `@requestport/web`'s tarball
 * carries, so every install would share a key anyone can read from the
 * package; Next uses `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` in its place when
 * the variable is set and not empty (`encryption-utils.js:78`). So
 * `requestport start` makes a key of its own once per data directory,
 * keeps it there in a file of its own, and hands it to Next as that
 * variable before Next loads (`serve/web.ts`'s `prepareWebUi`;
 * `serve/run.ts`).
 *
 * The file, `server-action-key`, holds the key and a line break: 32 random
 * bytes from `node:crypto`, as base64, the form Next decodes (`atob`). It is
 * written as the data directory's other files are (`writeFileAtomic`, mode
 * 0600), and read as `--owner-url-file` is: a regular file, not a symbolic
 * link, this user's and open to neither group nor others, read through a
 * descriptor opened with `O_NOFOLLOW` and checked to be the file judged. On
 * win32, which has no such modes, its owner and mode are not checked. A
 * refusal names the file and the rule, never what it holds.
 *
 * `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` already in `requestport start`'s
 * environment is refused (`refuseInheritedServerActionKey`), not used: the
 * key in use is always the data directory's, so a variable exported for
 * another Next application in the same shell is never shared with this
 * one, and a restart from another shell cannot change it. An operator who
 * wants a key of their own writes it to the file.
 */

/** The key's file, in the data directory. */
export const SERVER_ACTION_KEY_FILE = "server-action-key";

/** The variable Next reads the key from in place of its manifest's. */
export const SERVER_ACTION_KEY_VARIABLE = "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY";

/** An AES-256-GCM key: 32 bytes. */
const KEY_BYTES = 32;

/** Base64 of exactly 32 bytes: 43 characters and one `=`. */
const KEY_FORM = /^[A-Za-z0-9+/]{43}=$/u;

/** A key file `requestport start` will not read, or a variable it will not inherit. */
export class ServerActionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerActionKeyError";
  }
}

/**
 * Refuses an environment that already sets
 * `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, to any value, naming the variable
 * and never its value (above).
 */
export function refuseInheritedServerActionKey(env: NodeJS.ProcessEnv): void {
  if (env[SERVER_ACTION_KEY_VARIABLE] === undefined) return;
  throw new ServerActionKeyError(
    `${SERVER_ACTION_KEY_VARIABLE} is set in requestport start's environment. ` +
      `requestport start makes the web UI's server-action key itself, once per data directory, ` +
      `and keeps it in the data directory's ${SERVER_ACTION_KEY_FILE} file: unset the variable. ` +
      `To use a key of your own, write it to that file instead (base64 of 32 bytes, mode 0600).`,
  );
}

export interface ServerActionKey {
  /** The key, base64 of 32 bytes. */
  readonly key: string;
  /** Its file. */
  readonly path: string;
  /** Whether this call made it. */
  readonly made: boolean;
}

/**
 * The data directory's server-action key: read from its file, or, when there
 * is none, made and written there (above). `directory` is a data directory
 * this process holds the lock of. `uid` and `random` are others only in
 * tests.
 */
export function serverActionKey(
  directory: string,
  {
    uid = process.getuid?.(),
    random = randomBytes,
  }: { uid?: number; random?: (size: number) => Buffer } = {},
): ServerActionKey {
  const path = join(directory, SERVER_ACTION_KEY_FILE);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = random(KEY_BYTES).toString("base64");
    writeFileAtomic(directory, SERVER_ACTION_KEY_FILE, `${key}\n`);
    return { key, path, made: true };
  }
  if (stats.isSymbolicLink()) {
    throw new ServerActionKeyError(
      `${path} is a symbolic link. requestport start keeps the web UI's server-action key in a file of its own there; remove the link, and a start makes a new key.`,
    );
  }
  if (!stats.isFile()) {
    throw new ServerActionKeyError(
      `${path} is not a regular file. requestport start keeps the web UI's server-action key in a file of its own there.`,
    );
  }
  if (process.platform !== "win32") {
    if (uid !== undefined && stats.uid !== uid) {
      throw new ServerActionKeyError(
        `${path} belongs to another user (uid ${stats.uid}). It holds the web UI's server-action key: keep the data directory your own.`,
      );
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new ServerActionKeyError(
        `${path} is open to group or others (mode ${(stats.mode & 0o777).toString(8)}), and it holds the web UI's server-action key. Run \`chmod 600 ${path}\`, then start again.`,
      );
    }
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let contents: string;
  try {
    const opened = fstatSync(descriptor);
    if (opened.ino !== stats.ino || opened.dev !== stats.dev) {
      throw new ServerActionKeyError(
        `${path} changed while it was read. Start again.`,
      );
    }
    contents = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  const key = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  if (!KEY_FORM.test(key)) {
    throw new ServerActionKeyError(
      `${path} does not hold a server-action key: one line, base64 of 32 bytes. Remove the file, and a start makes a new key.`,
    );
  }
  return { key, path, made: false };
}
