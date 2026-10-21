import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  acquireLock,
  acquireLockSync,
  type HeldLock,
  LockTimeoutError,
  releaseLock,
} from "./lock.js";

/**
 * Something to do once, just before the next rename: the moment between a
 * taker's judgement of a lock and its move of that lock aside. `lock.ts`
 * renames nothing else. Every other call reaches `node:fs` unchanged.
 */
const beforeRename = vi.hoisted(() => ({
  once: undefined as ((from: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      const hook = beforeRename.once;
      beforeRename.once = undefined;
      hook?.(String(args[0]));
      actual.renameSync(...args);
    },
  };
});

const directories: string[] = [];

function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), "requestport-lock-"));
  directories.push(root);
  return join(root, "locks", "credential.lock");
}

afterEach(() => {
  vi.useRealTimers();
  beforeRename.once = undefined;
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { force: true, recursive: true });
  }
});

/**
 * A pid that belonged to a process and no longer does: one this test started
 * and waited out. Not an impossible number, so that the liveness check is
 * asked about the kind of pid a crashed holder actually leaves behind.
 */
function deadPid(): number {
  const finished = spawnSync(process.execPath, ["-e", ""]);
  expect(finished.status).toBe(0);
  return finished.pid as number;
}

function writeHolder(
  path: string,
  holder: { acquiredAt: string; nonce: string; pid: number },
): void {
  writeFileSync(path, `${JSON.stringify(holder)}\n`, { mode: 0o600 });
}

const SHORT = { staleAfterMs: 60_000, waitMs: 30_000 } as const;

describe("taking a free lock", () => {
  test("creates the lock file 0600, holding the pid, the time and a nonce", async () => {
    const path = lockPath();
    const lock = await acquireLock(path, SHORT);

    const held = JSON.parse(readFileSync(path, "utf8"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Object.keys(held).sort()).toEqual(["acquiredAt", "nonce", "pid"]);
    expect(held.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(held.acquiredAt))).toBe(false);
    expect(held.nonce).toBe(lock.nonce);
  });

  test("gives it up on release, and only once", async () => {
    const path = lockPath();
    const lock = await acquireLock(path, SHORT);

    expect(releaseLock(lock)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(releaseLock(lock)).toBe(false);
  });

  test("the synchronous form takes and gives it up the same way", () => {
    const path = lockPath();
    const lock = acquireLockSync(path, SHORT);

    expect(JSON.parse(readFileSync(path, "utf8")).nonce).toBe(lock.nonce);
    expect(releaseLock(lock)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});

describe("waiting for a lock someone else holds", () => {
  test("waits while the holder lives, and takes the lock once it is released", async () => {
    vi.useFakeTimers();
    const path = lockPath();
    const first = await acquireLock(path, SHORT);
    let second: HeldLock | undefined;
    const waiting = acquireLock(path, SHORT).then((lock) => {
      second = lock;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(second).toBeUndefined();

    releaseLock(first);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;

    expect(second?.nonce).not.toBe(first.nonce);
    expect(JSON.parse(readFileSync(path, "utf8")).nonce).toBe(second?.nonce);
  });

  test("times out waiting for a live holder, naming the lock and the holder", async () => {
    vi.useFakeTimers();
    const path = lockPath();
    await acquireLock(path, SHORT);
    const waiting = acquireLock(path, SHORT);
    const outcome = waiting.then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;

    expect(error).toBeInstanceOf(LockTimeoutError);
    expect(String(error)).toContain(path);
    expect(String(error)).toContain(String(process.pid));
  });

  test("the synchronous form times out the same way", () => {
    const path = lockPath();
    acquireLockSync(path, SHORT);

    expect(() =>
      acquireLockSync(path, { staleAfterMs: 60_000, waitMs: 50 }),
    ).toThrow(LockTimeoutError);
  });
});

/**
 * A holder that died, or that has held the lock for longer than any holder
 * legitimately could, would otherwise stop every later process for good. A
 * dead holder's lock is stale by the rule `scripts/gate-queue.mjs` applies to
 * the gate lock. A running holder's is stale only past its age, which is
 * manifest-h.md §2.8.2's rule: gate-queue never takes a lock from a live
 * holder. Either is taken over as gate-queue takes one: moved aside, judged
 * again, and put back if it changed hands.
 */
describe("taking over a stale lock", () => {
  test("takes over a lock whose holder is no longer running", async () => {
    const path = lockPath();
    const first = await acquireLock(path, SHORT);
    writeHolder(path, {
      acquiredAt: new Date().toISOString(),
      nonce: first.nonce,
      pid: deadPid(),
    });

    const second = await acquireLock(path, { ...SHORT, waitMs: 0 });

    expect(JSON.parse(readFileSync(path, "utf8")).nonce).toBe(second.nonce);
  });

  test("takes over a lock older than its stale age, even from a live holder", async () => {
    const path = lockPath();
    const first = await acquireLock(path, SHORT);
    writeHolder(path, {
      acquiredAt: new Date(Date.now() - 60_001).toISOString(),
      nonce: first.nonce,
      pid: process.pid,
    });

    const second = await acquireLock(path, { ...SHORT, waitMs: 0 });

    expect(second.nonce).not.toBe(first.nonce);
  });

  test("does not take over a live holder's lock before its stale age", async () => {
    const path = lockPath();
    const first = await acquireLock(path, SHORT);
    writeHolder(path, {
      acquiredAt: new Date(Date.now() - 59_000).toISOString(),
      nonce: first.nonce,
      pid: process.pid,
    });

    await expect(acquireLock(path, { ...SHORT, waitMs: 0 })).rejects.toThrow(
      LockTimeoutError,
    );
    expect(JSON.parse(readFileSync(path, "utf8")).nonce).toBe(first.nonce);
  });

  test("the synchronous form takes over a dead holder's lock too", () => {
    const path = lockPath();
    const first = acquireLockSync(path, SHORT);
    writeHolder(path, {
      acquiredAt: new Date().toISOString(),
      nonce: first.nonce,
      pid: deadPid(),
    });

    const second = acquireLockSync(path, { ...SHORT, waitMs: 0 });

    expect(second.nonce).not.toBe(first.nonce);
  });

  /**
   * A holder that died between creating the file and writing to it leaves one
   * that names nobody. Its pid cannot be asked about, so only its age can
   * make it stale, read from the file itself.
   */
  test("takes over an unreadable lock only once it is older than its stale age", async () => {
    const path = lockPath();
    const first = await acquireLock(path, SHORT);
    writeFileSync(path, "");

    await expect(acquireLock(path, { ...SHORT, waitMs: 0 })).rejects.toThrow(
      LockTimeoutError,
    );

    const old = (Date.now() - 61_000) / 1000;
    utimesSync(path, old, old);
    const second = await acquireLock(path, { ...SHORT, waitMs: 0 });

    expect(second.nonce).not.toBe(first.nonce);
  });

  /**
   * After a takeover the old holder may still be running — a suspended
   * process, woken. Its release must not remove the lock the new holder took.
   */
  test("a holder whose lock was taken over does not release the new one", async () => {
    const path = lockPath();
    const first = await acquireLock(path, SHORT);
    writeHolder(path, {
      acquiredAt: new Date(Date.now() - 61_000).toISOString(),
      nonce: first.nonce,
      pid: process.pid,
    });
    const second = await acquireLock(path, { ...SHORT, waitMs: 0 });

    expect(releaseLock(first)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).nonce).toBe(second.nonce);
  });
});

/**
 * Two takers can judge one stale lock at once. The first moves it aside and
 * takes the lock; the second's rename then moves the first's fresh lock, not
 * the stale one it judged. Judging again what was moved is what puts that
 * lock back. Without it the second taker would remove the first's lock and
 * take its own, and two holders of the token lock could each present the
 * same refresh token, which the provider answers by revoking the whole
 * authorization. Here a fresh lock replaces the judged one just before the
 * taker's rename, every time, rather than when two processes happen to race.
 */
describe("a lock that changes hands between its judgement and its move aside", () => {
  const FRESH_NONCE = "the-fresh-holder";

  function runningHolderPastItsAge(path: string): void {
    writeHolder(path, {
      acquiredAt: new Date(Date.now() - 61_000).toISOString(),
      nonce: "the-stale-holder",
      pid: process.pid,
    });
  }

  function emptyAndOld(path: string): void {
    writeFileSync(path, "");
    const old = (Date.now() - 61_000) / 1000;
    utimesSync(path, old, old);
  }

  function freshHolder(path: string): void {
    writeHolder(path, {
      acquiredAt: new Date().toISOString(),
      nonce: FRESH_NONCE,
      pid: process.pid,
    });
  }

  /** A lock just created, whose taker has not yet written its pid. */
  function freshAndEmpty(path: string): void {
    writeFileSync(path, "");
  }

  /**
   * A taker that finds the lock at `path` made stale by `stale`, with
   * `fresh` replacing it just before the taker moves it aside, given ten
   * seconds of its backoff. Only the timers are faked; the clock is real,
   * so the fresh lock stays young.
   */
  async function contend(
    stale: (path: string) => void,
    fresh: (path: string) => void,
  ) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const path = lockPath();
    mkdirSync(dirname(path), { recursive: true });
    stale(path);
    let moved = 0;
    beforeRename.once = (from) => {
      if (from !== path) return;
      moved += 1;
      fresh(path);
    };

    let acquired: HeldLock | undefined;
    const waiting = acquireLock(path, SHORT).then((lock) => {
      acquired = lock;
    });
    await vi.advanceTimersByTimeAsync(10_000);

    return { acquired: () => acquired, moved: () => moved, path, waiting };
  }

  /** The fresh lock gives the lock up, and the taker gets it at last. */
  async function release(path: string, waiting: Promise<void>) {
    unlinkSync(path);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
  }

  test.each([
    ["named a running holder past its stale age", runningHolderPastItsAge],
    ["named no holder and was older than its stale age", emptyAndOld],
  ])(
    "when the lock judged stale %s, a fresh holder's lock moved in its place is put back, naming its nonce, and the taker waits",
    async (_judged, stale) => {
      const run = await contend(stale, freshHolder);

      expect(run.moved()).toBe(1);
      expect(run.acquired()).toBeUndefined();
      expect(JSON.parse(readFileSync(run.path, "utf8")).nonce).toBe(
        FRESH_NONCE,
      );
      expect(readdirSync(dirname(run.path))).toEqual([basename(run.path)]);

      await release(run.path, run.waiting);
      expect(run.acquired()?.nonce).not.toBe(FRESH_NONCE);
      expect(JSON.parse(readFileSync(run.path, "utf8")).nonce).toBe(
        run.acquired()?.nonce,
      );
    },
  );

  /**
   * A lock that names no holder can only be told apart by its age, and a
   * rename keeps the mtime: a fresh one moved aside still reads young, so it
   * is not mistaken for the old one that was judged.
   */
  test("when the lock judged stale named no holder, a fresh lock that names none yet is put back too, and the taker waits", async () => {
    const run = await contend(emptyAndOld, freshAndEmpty);

    expect(run.moved()).toBe(1);
    expect(run.acquired()).toBeUndefined();
    expect(readFileSync(run.path, "utf8")).toBe("");
    expect(Date.now() - statSync(run.path).mtimeMs).toBeLessThan(60_000);
    expect(readdirSync(dirname(run.path))).toEqual([basename(run.path)]);

    await release(run.path, run.waiting);
    expect(JSON.parse(readFileSync(run.path, "utf8")).nonce).toBe(
      run.acquired()?.nonce,
    );
  });
});
