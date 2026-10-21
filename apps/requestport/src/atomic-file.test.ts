import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  readDataFile,
  removeTemporaryFiles,
  temporaryName,
  writeFileAtomic,
} from "./atomic-file.js";
import { acquireInstanceLock } from "./instance-lock.js";

const directories: string[] = [];
const locks: { release(): boolean }[] = [];

function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "requestport-files-"));
  directories.push(directory);
  return directory;
}

function lockOf(directory: string) {
  const lock = acquireInstanceLock(directory, { holder: "requestport start" });
  locks.push(lock);
  return lock;
}

afterEach(() => {
  for (const lock of locks.splice(0)) lock.release();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const workspace = resolve(import.meta.dirname, "..");
const atomicFileModule = pathToFileURL(
  resolve(import.meta.dirname, "atomic-file.ts"),
).href;

describe("writeFileAtomic", () => {
  test("writes the file, mode 0600, and leaves no temporary file", () => {
    const directory = dataDirectory();

    writeFileAtomic(directory, "config.json", "{}\n");

    expect(readFileSync(join(directory, "config.json"), "utf8")).toBe("{}\n");
    expect(statSync(join(directory, "config.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(["config.json"]);
  });

  test("replaces a file by renaming over it, so the new one is 0600 whatever the old one was", () => {
    const directory = dataDirectory();
    writeFileSync(join(directory, "config.json"), "old\n", { mode: 0o644 });
    const before = statSync(join(directory, "config.json")).ino;

    writeFileAtomic(directory, "config.json", "new\n");

    const after = statSync(join(directory, "config.json"));
    expect(readFileSync(join(directory, "config.json"), "utf8")).toBe("new\n");
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.ino).not.toBe(before);
  });

  test("a writer killed after the sync and before the rename leaves the old file whole, and its temporary file for the next start to remove", () => {
    const directory = dataDirectory();
    writeFileSync(join(directory, "config.json"), "old\n");
    const script = `
      import { writeFileAtomic } from ${JSON.stringify(atomicFileModule)};
      writeFileAtomic(${JSON.stringify(directory)}, "config.json", "new\\n", {
        beforeRename: () => process.kill(process.pid, "SIGKILL"),
      });
    `;

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: workspace, encoding: "utf8" },
    );

    expect(child.signal).toBe("SIGKILL");
    const temporary = temporaryName("config.json", child.pid as number);
    expect(readFileSync(join(directory, "config.json"), "utf8")).toBe("old\n");
    expect(readFileSync(join(directory, temporary), "utf8")).toBe("new\n");
    expect(statSync(join(directory, temporary)).mode & 0o777).toBe(0o600);

    expect(removeTemporaryFiles(lockOf(directory))).toEqual([temporary]);
    expect(existsSync(join(directory, temporary))).toBe(false);
    expect(readFileSync(join(directory, "config.json"), "utf8")).toBe("old\n");
  });

  test("a write that fails before the rename leaves the old file and removes its temporary file", () => {
    const directory = dataDirectory();
    writeFileSync(join(directory, "secrets.json"), "old\n");

    expect(() =>
      writeFileAtomic(directory, "secrets.json", "new\n", {
        beforeRename: () => {
          throw new Error("stopped");
        },
      }),
    ).toThrowError("stopped");

    expect(readFileSync(join(directory, "secrets.json"), "utf8")).toBe("old\n");
    expect(readdirSync(directory)).toEqual(["secrets.json"]);
  });

  test("never writes through a file or a symbolic link already at the temporary name", () => {
    const directory = dataDirectory();
    const outside = join(dataDirectory(), "target");
    writeFileSync(outside, "untouched\n");
    symlinkSync(outside, join(directory, temporaryName("secrets.json", 4242)));

    expect(() =>
      writeFileAtomic(directory, "secrets.json", "secret\n", { pid: 4242 }),
    ).toThrowError(/EEXIST/u);

    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
    expect(existsSync(join(directory, "secrets.json"))).toBe(false);
  });
});

describe("readDataFile", () => {
  test("answers a file's contents, or undefined when there is none", () => {
    const directory = dataDirectory();
    writeFileAtomic(directory, "init.json", "{}\n");

    expect(readDataFile(directory, "init.json")).toBe("{}\n");
    expect(readDataFile(directory, "config.json")).toBeUndefined();
  });
});

describe("removeTemporaryFiles", () => {
  test("removes the top level's *.tmp-* files only, and answers their names", () => {
    const directory = dataDirectory();
    writeFileSync(join(directory, "config.json"), "{}\n");
    writeFileSync(join(directory, "config.json.tmp-12"), "");
    writeFileSync(join(directory, "secrets.json.tmp-7"), "");
    mkdirSync(join(directory, "pglite"));
    writeFileSync(join(directory, "pglite", "base.tmp-3"), "");
    mkdirSync(join(directory, "held.tmp-9"));

    expect(removeTemporaryFiles(lockOf(directory))).toEqual([
      "config.json.tmp-12",
      "secrets.json.tmp-7",
    ]);
    expect(readdirSync(directory).sort()).toEqual([
      "config.json",
      "held.tmp-9",
      "lock",
      "pglite",
    ]);
    expect(readdirSync(join(directory, "pglite"))).toEqual(["base.tmp-3"]);
  });

  test("refuses once the lock is released: before the lock, such a file may be a live start's", () => {
    const directory = dataDirectory();
    writeFileSync(join(directory, "config.json.tmp-12"), "");
    const lock = lockOf(directory);
    lock.release();

    expect(() => removeTemporaryFiles(lock)).toThrowError(
      `removeTemporaryFiles: the lock on ${directory} has been released.`,
    );
    expect(existsSync(join(directory, "config.json.tmp-12"))).toBe(true);
  });
});
