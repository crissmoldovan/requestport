import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DataDirectoryError,
  defaultDataDirectory,
  prepareDataDirectory,
  realPathOf,
  refusedDataDirectory,
  resolveDataDirectory,
} from "./data-directory.js";

const CREDENTIAL_STORE = "the agent credential store (~/.requestport)";
const BINDING = "a checkout's binding (.requestport)";

/*
 * H.0b's cases (`spikes/h0-probe/datadir-rule.mjs`): each default, and
 * whether the default itself is refused.
 */
const DEFAULTS = [
  {
    name: "macOS",
    input: { platform: "darwin", env: {}, home: "/Users/ada" },
    expect: "/Users/ada/Library/Application Support/RequestPort",
  },
  {
    name: "macOS ignores XDG_DATA_HOME",
    input: {
      platform: "darwin",
      env: { XDG_DATA_HOME: "/x" },
      home: "/Users/ada",
    },
    expect: "/Users/ada/Library/Application Support/RequestPort",
  },
  {
    name: "Linux, no XDG_DATA_HOME",
    input: { platform: "linux", env: {}, home: "/home/ada" },
    expect: "/home/ada/.local/share/requestport",
  },
  {
    name: "Linux, XDG_DATA_HOME absolute",
    input: {
      platform: "linux",
      env: { XDG_DATA_HOME: "/data/ada" },
      home: "/home/ada",
    },
    expect: "/data/ada/requestport",
  },
  {
    name: "Linux, XDG_DATA_HOME relative (ignored)",
    input: {
      platform: "linux",
      env: { XDG_DATA_HOME: "data" },
      home: "/home/ada",
    },
    expect: "/home/ada/.local/share/requestport",
  },
  {
    name: "Linux, XDG_DATA_HOME empty (ignored)",
    input: { platform: "linux", env: { XDG_DATA_HOME: "" }, home: "/home/ada" },
    expect: "/home/ada/.local/share/requestport",
  },
  {
    name: "Linux container, HOME=/root",
    input: { platform: "linux", env: {}, home: "/root" },
    expect: "/root/.local/share/requestport",
  },
  {
    name: "FreeBSD (XDG)",
    input: { platform: "freebsd", env: {}, home: "/home/ada" },
    expect: "/home/ada/.local/share/requestport",
  },
  {
    name: "Windows, LOCALAPPDATA",
    input: {
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" },
      home: "C:\\Users\\ada",
    },
    expect: "C:\\Users\\ada\\AppData\\Local\\RequestPort",
  },
  {
    name: "Windows, LOCALAPPDATA unset",
    input: { platform: "win32", env: {}, home: "C:\\Users\\ada" },
    expect: "C:\\Users\\ada\\AppData\\Local\\RequestPort",
  },
  {
    name: "Windows, LOCALAPPDATA relative (ignored)",
    input: {
      platform: "win32",
      env: { LOCALAPPDATA: "Local" },
      home: "C:\\Users\\ada",
    },
    expect: "C:\\Users\\ada\\AppData\\Local\\RequestPort",
  },
  {
    name: "Linux, XDG_DATA_HOME inside ~/.requestport (default refused)",
    input: {
      platform: "linux",
      env: { XDG_DATA_HOME: "/home/ada/.requestport" },
      home: "/home/ada",
    },
    expect: "/home/ada/.requestport/requestport",
    refused: CREDENTIAL_STORE,
  },
  {
    name: "Windows, LOCALAPPDATA inside ~/.requestport (default refused)",
    input: {
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\ada\\.requestport" },
      home: "C:\\Users\\ada",
    },
    expect: "C:\\Users\\ada\\.requestport\\RequestPort",
    refused: CREDENTIAL_STORE,
  },
] as const;

const REFUSALS = [
  {
    candidate: "/home/ada/.requestport",
    platform: "linux",
    home: "/home/ada",
    expect: CREDENTIAL_STORE,
  },
  {
    candidate: "/home/ada/.requestport/server",
    platform: "linux",
    home: "/home/ada",
    expect: CREDENTIAL_STORE,
  },
  {
    candidate: "/work/app/.requestport",
    platform: "linux",
    home: "/home/ada",
    expect: BINDING,
  },
  {
    candidate: "/work/app/.requestport/data",
    platform: "linux",
    home: "/home/ada",
    expect: BINDING,
  },
  {
    candidate: "/home/ada/.local/share/requestport",
    platform: "linux",
    home: "/home/ada",
    expect: null,
  },
  {
    candidate: "/home/ada/.requestport-data",
    platform: "linux",
    home: "/home/ada",
    expect: null,
  },
  {
    candidate: "C:\\Users\\ada\\.requestport",
    platform: "win32",
    home: "C:\\Users\\ada",
    expect: CREDENTIAL_STORE,
  },
  // Windows' file names ignore case, so the name does here too.
  {
    candidate: "D:\\work\\app\\.RequestPort",
    platform: "win32",
    home: "C:\\Users\\ada",
    expect: BINDING,
  },
  // Elsewhere they do not: this is a directory of another name.
  {
    candidate: "/work/app/.RequestPort",
    platform: "linux",
    home: "/home/ada",
    expect: null,
  },
] as const;

describe("the default data directory (H.0b's rule)", () => {
  test.each(DEFAULTS)("$name", (row) => {
    const answer = defaultDataDirectory(row.input);

    expect(answer).toBe(row.expect);
    expect(
      refusedDataDirectory(answer, {
        platform: row.input.platform,
        home: row.input.home,
      }),
    ).toBe("refused" in row ? row.refused : null);
  });
});

describe("refusedDataDirectory", () => {
  test.each(REFUSALS)("$candidate on $platform", (row) => {
    expect(
      refusedDataDirectory(row.candidate, {
        platform: row.platform,
        home: row.home,
      }),
    ).toBe(row.expect);
  });
});

const directories: string[] = [];

/** A scratch home under the default temporary directory, named as given (on macOS, a `/var` path, which is `/private/var`). */
function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "requestport-home-"));
  directories.push(home);
  return home;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveDataDirectory compares real paths", () => {
  test("a --data-dir reached through a symbolic link into ~/.requestport is refused", () => {
    const home = scratchHome();
    mkdirSync(join(home, ".requestport"));
    symlinkSync(join(home, ".requestport"), join(home, "elsewhere"));

    expect(() =>
      resolveDataDirectory(join(home, "elsewhere", "server"), {
        platform: "linux",
        home,
      }),
    ).toThrowError(
      new DataDirectoryError(
        `--data-dir ${realpathSync(home)}/.requestport/server is inside ${CREDENTIAL_STORE}, which belongs to RequestPort's client. Name another directory with --data-dir <path>.`,
      ),
    );
  });

  test("the default is held to the same refusal, through a symbolic link too", () => {
    const home = scratchHome();
    mkdirSync(join(home, "Library"));
    mkdirSync(join(home, ".requestport"));
    symlinkSync(
      join(home, ".requestport"),
      join(home, "Library", "Application Support"),
    );

    expect(() =>
      resolveDataDirectory(undefined, { platform: "darwin", env: {}, home }),
    ).toThrowError(
      /^The default data directory, .*\/\.requestport\/RequestPort, is inside the agent credential store/u,
    );
  });

  test("a default inside ~/.requestport by XDG_DATA_HOME is refused", () => {
    const home = scratchHome();

    expect(() =>
      resolveDataDirectory(undefined, {
        platform: "linux",
        env: { XDG_DATA_HOME: join(home, ".requestport") },
        home,
      }),
    ).toThrowError(
      /^The default data directory, .* is inside the agent credential store/u,
    );
  });

  test("answers the real path, the macOS default's space kept", () => {
    const home = scratchHome();

    const resolved = resolveDataDirectory(undefined, {
      platform: "darwin",
      env: {},
      home,
    });

    expect(resolved).toEqual({
      path: join(
        realpathSync(home),
        "Library",
        "Application Support",
        "RequestPort",
      ),
      source: "default",
    });
    expect(resolved.path).toContain(" ");
  });

  test("resolves a relative --data-dir against the working directory", () => {
    const home = scratchHome();

    expect(
      resolveDataDirectory("instance", { platform: "linux", home, cwd: home }),
    ).toEqual({
      path: join(realpathSync(home), "instance"),
      source: "--data-dir",
    });
  });

  test("refuses an empty --data-dir", () => {
    expect(() => resolveDataDirectory("  ")).toThrowError(
      new DataDirectoryError("--data-dir needs a path."),
    );
  });

  test("realPathOf resolves the part that exists and keeps the rest", () => {
    const home = scratchHome();

    expect(realPathOf(join(home, "a", "b"))).toBe(
      join(realpathSync(home), "a", "b"),
    );
  });
});

describe("prepareDataDirectory", () => {
  test("creates the directory, and any missing parent, mode 0700, in a path with a space", () => {
    const home = scratchHome();
    const directory = join(
      realpathSync(home),
      "Application Support",
      "RequestPort",
    );

    prepareDataDirectory(directory);

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "..")).mode & 0o777).toBe(0o700);
  });

  test("accepts an existing directory of this user's, closed to others", () => {
    const home = scratchHome();
    const directory = join(home, "instance");
    mkdirSync(directory, { mode: 0o700 });

    expect(() => prepareDataDirectory(directory)).not.toThrow();
  });

  test("refuses an existing directory open to group or others, with the remedy, and leaves its mode", () => {
    const home = scratchHome();
    const directory = join(home, "instance");
    mkdirSync(directory);
    chmodSync(directory, 0o755);

    expect(() => prepareDataDirectory(directory)).toThrowError(
      new DataDirectoryError(
        `${directory} is open to group or others (mode 755), and it holds this instance's secrets. Run \`chmod 700 ${directory}\`, or name another directory with --data-dir <path>.`,
      ),
    );
    expect(statSync(directory).mode & 0o777).toBe(0o755);
  });

  test("refuses a directory that belongs to another user", () => {
    const home = scratchHome();
    const directory = join(home, "instance");
    mkdirSync(directory, { mode: 0o700 });
    const owner = statSync(directory).uid;

    expect(() =>
      prepareDataDirectory(directory, { uid: owner + 1 }),
    ).toThrowError(/belongs to another user/u);
  });

  test("refuses a path that is a file", () => {
    const home = scratchHome();
    const file = join(home, "instance");
    writeFileSync(file, "");

    expect(() => prepareDataDirectory(file)).toThrowError(
      new DataDirectoryError(
        `${file} is not a directory, or a part of its path is a file. Name a directory with --data-dir <path>.`,
      ),
    );
    expect(() => prepareDataDirectory(join(file, "below"))).toThrowError(
      /is not a directory, or a part of its path is a file/u,
    );
  });
});
