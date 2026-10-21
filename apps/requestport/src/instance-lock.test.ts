import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  acquireInstanceLock,
  InstanceLockedError,
  LOCK_NAME,
  takeOverStaleLock,
} from "./instance-lock.js";

const directories: string[] = [];
const held: { release(): boolean }[] = [];

function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "requestport-lock-"));
  directories.push(directory);
  return directory;
}

function take(directory: string, log?: (line: string) => void) {
  const lock = acquireInstanceLock(directory, {
    holder: "requestport start",
    log,
  });
  held.push(lock);
  return lock;
}

/** A lock as another process would have left it. */
function plant(
  directory: string,
  { pid, holder = "requestport start" }: { pid?: number; holder?: string },
) {
  const lockPath = join(directory, LOCK_NAME);
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(join(lockPath, "holder"), `${holder}\n`);
  if (pid !== undefined) writeFileSync(join(lockPath, "pid"), `${pid}\n`);
  return lockPath;
}

/** A process that is alive until it is killed, and its pid. */
function sleeper() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  return {
    pid: child.pid as number,
    stop: () => {
      child.kill("SIGKILL");
      return exited;
    },
  };
}

afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the data directory's lock", () => {
  test("is a directory, mode 0700, naming its holder and pid", () => {
    const directory = dataDirectory();

    const lock = take(directory);

    const lockPath = join(directory, LOCK_NAME);
    expect(lock).toMatchObject({
      dataDirectory: directory,
      path: lockPath,
      pid: process.pid,
      held: true,
    });
    expect(statSync(lockPath).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(lockPath, "pid"), "utf8")).toBe(
      `${process.pid}\n`,
    );
    expect(readFileSync(join(lockPath, "holder"), "utf8")).toBe(
      "requestport start\n",
    );
    for (const file of ["pid", "holder", "since"]) {
      expect(statSync(join(lockPath, file)).mode & 0o777).toBe(0o600);
    }
  });

  test("refuses a second start while the first holds it, naming the holder", () => {
    const directory = dataDirectory();
    take(directory);

    let refusal: unknown;
    try {
      take(directory);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(InstanceLockedError);
    expect((refusal as Error).message).toBe(
      `${directory} is in use by requestport start (pid ${process.pid}). One requestport runs per data directory: stop that one, or name another directory with --data-dir <path>. If pid ${process.pid} is not a requestport, its lock is stale: remove ${join(directory, LOCK_NAME)}.`,
    );
  });

  test("refuses while another live process holds it, and takes it over once that process is gone", async () => {
    const directory = dataDirectory();
    const other = sleeper();
    plant(directory, { pid: other.pid });

    expect(() => take(directory)).toThrowError(InstanceLockedError);

    await other.stop();
    const lines: string[] = [];
    const lock = take(directory, (line) => lines.push(line));

    expect(lock.held).toBe(true);
    expect(readFileSync(join(directory, LOCK_NAME, "pid"), "utf8")).toBe(
      `${process.pid}\n`,
    );
    expect(lines).toEqual([
      `requestport: taking over a stale lock on ${directory}, left by requestport start (pid ${other.pid} is gone)`,
    ]);
  });

  test("takes over a lock naming this process's pid that this process did not take: a pid reused", () => {
    const directory = dataDirectory();
    plant(directory, { pid: process.pid, holder: "an earlier start" });
    const lines: string[] = [];

    const lock = take(directory, (line) => lines.push(line));

    expect(lock.held).toBe(true);
    expect(lines).toEqual([
      `requestport: taking over a stale lock on ${directory}, left by an earlier start (pid ${process.pid} is this process, which did not take it)`,
    ]);
  });

  test("takes over a lock with no pid once it is older than a minute, and refuses a younger one", () => {
    const directory = dataDirectory();
    const lockPath = plant(directory, {});

    expect(() => take(directory)).toThrowError(
      `${directory} is in use by requestport start (no pid yet).`,
    );

    const twoMinutesAgo = new Date(Date.now() - 120_000);
    utimesSync(lockPath, twoMinutesAgo, twoMinutesAgo);
    expect(take(directory).held).toBe(true);
  });

  test("is released by its holder only once, and a lock another took is left", () => {
    const directory = dataDirectory();
    const lock = take(directory);

    expect(lock.release()).toBe(true);
    expect(lock.held).toBe(false);
    expect(existsSync(join(directory, LOCK_NAME))).toBe(false);
    expect(lock.release()).toBe(false);

    const again = take(directory);
    writeFileSync(join(directory, LOCK_NAME, "pid"), "1\n");
    expect(again.release()).toBe(false);
    expect(existsSync(join(directory, LOCK_NAME))).toBe(true);
  });

  test("a takeover puts back a lock that changed hands after it was judged", () => {
    const directory = dataDirectory();
    const lockPath = plant(directory, { pid: 424242 });

    expect(
      takeOverStaleLock({ lockPath, observedPid: 1, pid: process.pid }),
    ).toBe(false);
    expect(readFileSync(join(lockPath, "pid"), "utf8")).toBe("424242\n");
  });
});
