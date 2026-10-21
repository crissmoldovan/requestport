import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { HeldInstanceLock } from "./instance-lock.js";

/**
 * The data directory's files, each written so that a crash leaves either the
 * old file or the new one, never a part (manifest-h.md §2.3.1, Rule 1): to
 * `<name>.tmp-<pid>`, mode 0600, `fsync`ed, renamed over `<name>`, and the
 * directory `fsync`ed. A crash before the rename leaves the temporary file,
 * which `removeTemporaryFiles` removes, and only for the holder of the data
 * directory's lock (ruling 158, 12).
 */

/** What a temporary file's name carries between its target's name and the writer's pid. */
export const TEMPORARY_MARK = ".tmp-";

export function temporaryName(name: string, pid: number): string {
  return `${name}${TEMPORARY_MARK}${pid}`;
}

export interface AtomicWriteOptions {
  pid?: number;
  /**
   * Called after the temporary file is written and synced, before the
   * rename. For tests that stop a writer there; the CLI passes none.
   */
  beforeRename?: () => void;
}

/** `O_NOFOLLOW` where the platform has it, so a planted symbolic link is not written through. */
const noFollow = constants.O_NOFOLLOW ?? 0;

/**
 * Writes `contents` to `<directory>/<name>` atomically, mode 0600. The
 * temporary file is created exclusively, so one left at that name, or a
 * symbolic link planted there, is an error rather than a file written
 * through; a failed write removes the temporary file it made.
 */
export function writeFileAtomic(
  directory: string,
  name: string,
  contents: string,
  { pid = process.pid, beforeRename }: AtomicWriteOptions = {},
): void {
  const target = join(directory, name);
  const temporary = join(directory, temporaryName(name, pid));
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  let renamed = false;
  try {
    try {
      // The mode `open` was given is narrowed by the umask; this sets it.
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, contents, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    beforeRename?.();
    renameSync(temporary, target);
    renamed = true;
  } finally {
    if (!renamed) rmSync(temporary, { force: true });
  }
  syncDirectory(directory);
}

/** Makes a rename in `directory` durable. Windows cannot open a directory to sync it. */
function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** `<directory>/<name>`'s contents, or `undefined` when there is no such file. */
export function readDataFile(
  directory: string,
  name: string,
): string | undefined {
  try {
    return readFileSync(join(directory, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Removes every `*.tmp-*` file at the top of the locked data directory and
 * answers their names. It takes the held lock, not a path, because before the
 * lock is taken such a file may be a live start's, half written.
 */
export function removeTemporaryFiles(lock: HeldInstanceLock): string[] {
  if (!lock.held) {
    throw new Error(
      `removeTemporaryFiles: the lock on ${lock.dataDirectory} has been released.`,
    );
  }
  const removed: string[] = [];
  for (const entry of readdirSync(lock.dataDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.includes(TEMPORARY_MARK)) continue;
    rmSync(join(lock.dataDirectory, entry.name), { force: true });
    removed.push(entry.name);
  }
  return removed.sort();
}
