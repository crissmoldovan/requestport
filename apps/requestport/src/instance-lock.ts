import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * One running instance per data directory (manifest-h.md §2.3), held by a
 * lock with stale-holder takeover, in the shape `scripts/gate-queue.mjs` gives
 * the gate's: a directory that one `mkdir` wins, holding the holder's name and
 * pid; stale when that pid is gone, or, with no pid written, when it is older
 * than a minute; taken over by renaming it aside and checking it again. A
 * script cannot be imported by a package H.7 bundles, so the shape is written
 * again here.
 *
 * Unlike the gate's, `acquireInstanceLock` never waits: a live holder is a
 * refusal, because a second `requestport start` on one directory is a
 * mistake, not a queue.
 *
 * One limit is the gate's too: a pid the system has since given to another
 * process reads as alive, and the refusal names the lock to remove by hand.
 * The one reuse that is certain is caught: a lock that names this process's
 * own pid, which this process did not take, was left by an earlier process
 * that had the same pid (a container's pids repeat from one start to the
 * next), so it is stale.
 */

/** The lock's directory, inside the data directory. */
export const LOCK_NAME = "lock";

/** How old a lock with no pid must be before it is judged an orphan. */
export const ORPHAN_AFTER_MS = 60_000;

const TAKEOVER_ATTEMPTS = 5;

export interface LockHolder {
  holder: string;
  pid: number | null;
  ageMs: number;
}

export interface HeldInstanceLock {
  /** The data directory this lock holds. */
  readonly dataDirectory: string;
  /** The lock's own directory. */
  readonly path: string;
  readonly pid: number;
  /** True until `release()`. */
  readonly held: boolean;
  /** Removes the lock if it is still this holder's; answers whether it did. */
  release(): boolean;
}

export class InstanceLockedError extends Error {
  readonly dataDirectory: string;
  readonly holder: LockHolder;

  constructor(dataDirectory: string, lockPath: string, holder: LockHolder) {
    const pid = holder.pid === null ? "no pid yet" : `pid ${holder.pid}`;
    super(
      `${dataDirectory} is in use by ${holder.holder} (${pid}). One requestport runs per data directory: stop that one, or name another directory with --data-dir <path>.` +
        (holder.pid === null
          ? ""
          : ` If pid ${holder.pid} is not a requestport, its lock is stale: remove ${lockPath}.`),
    );
    this.name = "InstanceLockedError";
    this.dataDirectory = dataDirectory;
    this.holder = holder;
  }
}

export interface AcquireInstanceLockOptions {
  /** Who is asking, as a refusal will name it: `requestport start`. */
  holder: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  orphanAfterMs?: number;
  /** Where the takeover of a stale lock is reported. */
  log?: (line: string) => void;
}

/** The lock paths this process holds, so that its own pid is told apart from a reused one. */
const heldHere = new Set<string>();

/**
 * Whether a process exists. `kill(pid, 0)` delivers nothing; it only asks.
 * EPERM means the process exists and belongs to another user.
 */
export function processAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = process.kill.bind(process),
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type Attempt = { acquired: true } | ({ acquired: false } & ReadHolder);
type ReadHolder = { vanished: true } | ({ vanished: false } & LockHolder);

function readHolder(lockPath: string, now: () => number): ReadHolder {
  let ageMs: number;
  try {
    ageMs = now() - statSync(lockPath).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { vanished: true };
    }
    throw error;
  }
  const read = (name: string) => {
    try {
      return readFileSync(join(lockPath, name), "utf8").trim();
    } catch {
      return "";
    }
  };
  const pid = Number(read("pid"));
  return {
    vanished: false,
    holder: read("holder") || "an unknown holder",
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    ageMs,
  };
}

function tryAcquire(
  lockPath: string,
  holder: string,
  pid: number,
  now: () => number,
): Attempt {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { acquired: false, ...readHolder(lockPath, now) };
  }
  const write = (name: string, value: string) =>
    writeFileSync(join(lockPath, name), `${value}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  write("holder", holder);
  write("pid", String(pid));
  write("since", new Date(now()).toISOString());
  return { acquired: true };
}

/**
 * Removes a lock judged stale, but only the one that was judged: it is renamed
 * aside, read again, and put back if its pid changed, or, for a lock judged an
 * orphan for having no pid, if it now reads young (a rename keeps the
 * directory's mtime). Answers whether it removed it.
 */
export function takeOverStaleLock({
  lockPath,
  observedPid,
  pid,
  now = Date.now,
  orphanAfterMs = ORPHAN_AFTER_MS,
}: {
  lockPath: string;
  observedPid: number | null;
  pid: number;
  now?: () => number;
  orphanAfterMs?: number;
}): boolean {
  const aside = `${lockPath}.stale-${pid}-${now()}`;
  try {
    renameSync(lockPath, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const moved = readHolder(aside, now);
  const stillTheOneJudged =
    !moved.vanished &&
    moved.pid === observedPid &&
    (observedPid !== null || moved.ageMs >= orphanAfterMs);
  if (!stillTheOneJudged) {
    renameSync(aside, lockPath);
    return false;
  }
  rmSync(aside, { recursive: true, force: true });
  return true;
}

/**
 * Takes the data directory's lock, or throws `InstanceLockedError` naming
 * its live holder. Never waits. A stale lock is taken over, and `log` says so.
 */
export function acquireInstanceLock(
  dataDirectory: string,
  {
    holder,
    pid = process.pid,
    isAlive = processAlive,
    now = Date.now,
    orphanAfterMs = ORPHAN_AFTER_MS,
    log = () => undefined,
  }: AcquireInstanceLockOptions,
): HeldInstanceLock {
  const lockPath = join(dataDirectory, LOCK_NAME);
  for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt += 1) {
    const result = tryAcquire(lockPath, holder, pid, now);
    if (result.acquired) return heldLock(dataDirectory, lockPath, pid);
    if (result.vanished) continue;

    let why: string | undefined;
    if (result.pid === null) {
      if (result.ageMs >= orphanAfterMs) {
        why = "no pid recorded, and older than a minute";
      }
    } else if (result.pid === pid) {
      if (!heldHere.has(lockPath)) {
        why = `pid ${pid} is this process, which did not take it`;
      }
    } else if (!isAlive(result.pid)) {
      why = `pid ${result.pid} is gone`;
    }
    if (why === undefined) {
      throw new InstanceLockedError(dataDirectory, lockPath, result);
    }
    log(
      `requestport: taking over a stale lock on ${dataDirectory}, left by ${result.holder} (${why})`,
    );
    takeOverStaleLock({
      lockPath,
      observedPid: result.pid,
      pid,
      now,
      orphanAfterMs,
    });
  }
  throw new Error(
    `requestport: could not take the lock on ${dataDirectory} in ${TAKEOVER_ATTEMPTS} attempts; another start may be taking it at the same moment.`,
  );
}

function heldLock(
  dataDirectory: string,
  lockPath: string,
  pid: number,
): HeldInstanceLock {
  heldHere.add(lockPath);
  let held = true;
  return {
    dataDirectory,
    path: lockPath,
    pid,
    get held() {
      return held;
    },
    release() {
      if (!held) return false;
      held = false;
      heldHere.delete(lockPath);
      const current = readHolder(lockPath, Date.now);
      if (current.vanished || current.pid !== pid) return false;
      rmSync(lockPath, { recursive: true, force: true });
      return true;
    },
  };
}
