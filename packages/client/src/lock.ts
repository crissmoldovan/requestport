import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

/**
 * An exclusive lock between processes on one machine, held as a file.
 *
 * The file is created with `wx`, which exactly one caller can do, and holds
 * the holder's pid, the time it took the lock and a nonce. The nonce is what
 * a release compares, not the pid: two holders in one process share a pid,
 * and a holder whose lock was taken over must not remove its successor's.
 *
 * A lock is stale, and is taken over, when its holder's pid is not running,
 * or when it is older than `staleAfterMs` even though its holder runs. The
 * second is manifest-h.md §2.8.2's rule (step 2), not `scripts/gate-queue.mjs`'s:
 * gate-queue never takes the gate lock from a live holder, and judges by age
 * only a lock that records no pid. A file here that names no holder (one
 * whose holder died between creating it and writing it) is likewise judged
 * by its age alone, read from its mtime. The takeover itself follows
 * gate-queue's: judged, moved aside by an atomic rename, judged again, and
 * only then removed. A lock that changed hands in between is put back, by a
 * link here where gate-queue renames it back (`takeOver`, below).
 *
 * Nothing here signals a process. A pid is asked about with signal 0, which
 * delivers nothing, and only a positive pid is ever asked about.
 */
export type LockOptions = {
  /** Older than this, a lock is taken over even from a running holder. */
  readonly staleAfterMs: number;
  /** How long to wait for a holder that is running and not stale. */
  readonly waitMs: number;
};

export type HeldLock = {
  readonly nonce: string;
  readonly path: string;
};

export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockTimeoutError";
  }
}

type Holder = {
  readonly acquiredAt: string;
  readonly nonce: string;
  readonly pid: number;
};

type Observed =
  | { readonly kind: "vanished" }
  | { readonly ageMs: number; readonly holder: Holder; readonly kind: "held" }
  | { readonly ageMs: number; readonly kind: "unreadable" };

type Attempt =
  | { readonly lock: HeldLock }
  | { readonly waitingFor: Observed | undefined };

/** The first pause between attempts, doubled after each up to the cap. */
const FIRST_DELAY_MS = 25;
const MAX_DELAY_MS = 500;

/**
 * Attempts made without pausing: one after a lock vanished between our
 * failed create and our read, and one after each successful takeover. Past
 * this many the caller pauses as for a running holder, so contention between
 * several takers never spins.
 */
const IMMEDIATE_ATTEMPTS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function parseHolder(text: string): Holder | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const { acquiredAt, nonce, pid } = parsed;
  if (
    typeof acquiredAt !== "string" ||
    Number.isNaN(Date.parse(acquiredAt)) ||
    typeof nonce !== "string" ||
    nonce === "" ||
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return undefined;
  }

  return { acquiredAt, nonce, pid };
}

/**
 * Whether a process with this pid is running. Signal 0 delivers nothing; it
 * only asks. EPERM means it runs as another user, so it is running.
 *
 * A pid the kernel has since given to an unrelated process reads as
 * running, so such a lock waits out its stale age instead.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function observe(path: string): Observed {
  let mtimeMs: number;
  let text: string;
  try {
    mtimeMs = statSync(path).mtimeMs;
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "vanished" };
    throw error;
  }

  const holder = parseHolder(text);
  if (holder === undefined) {
    return { ageMs: Date.now() - mtimeMs, kind: "unreadable" };
  }

  return {
    ageMs: Date.now() - Date.parse(holder.acquiredAt),
    holder,
    kind: "held",
  };
}

function isStale(observed: Observed, staleAfterMs: number): boolean {
  switch (observed.kind) {
    case "vanished":
      return false;
    case "unreadable":
      return observed.ageMs > staleAfterMs;
    case "held":
      return !isRunning(observed.holder.pid) || observed.ageMs > staleAfterMs;
  }
}

/**
 * Remove a stale lock, but only the one that was judged stale.
 *
 * Between the judgement and the removal another taker may have removed it
 * and taken a fresh lock at the same path. Renaming it aside is atomic, and
 * what was moved is judged again: the same nonce for a lock that named a
 * holder, and still unreadable and still old for one that named none (a
 * rename keeps the mtime). If it no longer passes it is linked back, which
 * fails rather than overwrites if yet another lock now stands at the path;
 * then the moved lock is lost to its holder, and two holders each believe
 * they hold the lock. That case needs three takers inside one rename, as
 * `gate-queue.mjs` says of its own.
 */
function takeOver(
  path: string,
  judged: Observed,
  staleAfterMs: number,
): boolean {
  const aside = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }

  const moved = observe(aside);
  const stillJudged =
    judged.kind === "held"
      ? moved.kind === "held" && moved.holder.nonce === judged.holder.nonce
      : moved.kind === "unreadable" && moved.ageMs > staleAfterMs;

  if (!stillJudged) {
    try {
      linkSync(aside, path);
    } catch {
      // A lock already stands at the path again; it is its taker's.
    }
  }
  try {
    unlinkSync(aside);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  return stillJudged;
}

function tryCreate(path: string): HeldLock | undefined {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });

  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return undefined;
    throw error;
  }

  const holder: Holder = {
    acquiredAt: new Date().toISOString(),
    nonce: randomUUID(),
    pid: process.pid,
  };
  try {
    // The mode given to `openSync` is filtered by the umask; this is not.
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, `${JSON.stringify(holder)}\n`);
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(path);
    throw error;
  }
  closeSync(descriptor);

  return { nonce: holder.nonce, path };
}

function attempt(path: string, staleAfterMs: number): Attempt {
  let observed: Observed | undefined;

  for (let tries = 0; tries < IMMEDIATE_ATTEMPTS; tries += 1) {
    const lock = tryCreate(path);
    if (lock !== undefined) return { lock };

    observed = observe(path);
    if (observed.kind === "vanished") continue;
    if (!isStale(observed, staleAfterMs)) return { waitingFor: observed };
    if (!takeOver(path, observed, staleAfterMs)) {
      return { waitingFor: observed };
    }
  }

  return { waitingFor: observed };
}

function timedOut(
  path: string,
  options: LockOptions,
  observed: Observed | undefined,
): LockTimeoutError {
  const holder =
    observed?.kind === "held"
      ? `held by pid ${observed.holder.pid} since ${observed.holder.acquiredAt}, which is still running`
      : "held by a process that has not written its pid";

  return new LockTimeoutError(
    `Waited ${options.waitMs / 1000}s for the lock ${path}, ${holder}. It is taken over only once its holder has exited or it is older than ${options.staleAfterMs / 1000}s.`,
  );
}

/**
 * Take the lock, waiting for a running holder with backoff for at most
 * `waitMs`, and taking over a stale one at once.
 */
export async function acquireLock(
  path: string,
  options: LockOptions,
): Promise<HeldLock> {
  const deadline = Date.now() + options.waitMs;
  let delay = FIRST_DELAY_MS;

  for (;;) {
    const outcome = attempt(path, options.staleAfterMs);
    if ("lock" in outcome) return outcome.lock;

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut(path, options, outcome.waitingFor);

    await new Promise((resume) =>
      setTimeout(resume, Math.min(delay, remaining)),
    );
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

/**
 * The same, blocking the thread while it waits. For a critical section that
 * is itself synchronous, such as the file store's read and rewrite.
 *
 * The wait is bounded by the time it has slept as well as by the clock, so
 * a clock that does not move cannot hold it forever.
 */
export function acquireLockSync(path: string, options: LockOptions): HeldLock {
  const deadline = Date.now() + options.waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let delay = FIRST_DELAY_MS;
  let slept = 0;

  for (;;) {
    const outcome = attempt(path, options.staleAfterMs);
    if ("lock" in outcome) return outcome.lock;

    const remaining = Math.min(deadline - Date.now(), options.waitMs - slept);
    if (remaining <= 0) throw timedOut(path, options, outcome.waitingFor);

    const interval = Math.min(delay, remaining);
    Atomics.wait(pause, 0, 0, interval);
    slept += interval;
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

/**
 * Give the lock up, if it is still this holder's. A lock that was taken over
 * names another nonce and is left alone. Answers whether it removed one.
 */
export function releaseLock(lock: HeldLock): boolean {
  let text: string;
  try {
    text = readFileSync(lock.path, "utf8");
  } catch {
    return false;
  }
  if (parseHolder(text)?.nonce !== lock.nonce) return false;

  try {
    unlinkSync(lock.path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}
