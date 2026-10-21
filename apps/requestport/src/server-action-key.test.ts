import {
  chmodSync,
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
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import {
  refuseInheritedServerActionKey,
  SERVER_ACTION_KEY_FILE,
  SERVER_ACTION_KEY_VARIABLE,
  ServerActionKeyError,
  serverActionKey,
} from "./server-action-key.js";

/*
 * The web UI's server-action key (ruling 201 item 4): one per data
 * directory, made once by `requestport start` and handed to Next as
 * `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, so that the key Next's build wrote
 * into `@requestport/web`'s tarball is never the one in use. Each data
 * directory here is in this run's default temporary directory (ruling 152).
 * That Next encrypts with it is `server-action-key.integration.test.ts`'s.
 */

const scratch = mkdtempSync(join(tmpdir(), "requestport-action-key-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;
/** A new data directory, mode 0700, as `prepareDataDirectory` makes one. */
const dataDirectory = () => {
  made += 1;
  const directory = join(scratch, `data ${made}`);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
};
/** A data directory whose key file holds `contents`, at `mode`. */
const withKeyFile = (contents: string, mode = 0o600) => {
  const directory = dataDirectory();
  const path = join(directory, SERVER_ACTION_KEY_FILE);
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return { directory, path };
};
/** A well-formed key: base64 of 32 bytes, which no test below may see repeated. */
const KEY = Buffer.alloc(32, 7).toString("base64");

/** The refusal, which must never carry what the key file or the variable holds. */
function refusal(run: () => unknown, ...withheld: string[]) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ServerActionKeyError);
    for (const value of withheld) {
      expect((error as Error).message).not.toContain(value);
    }
    return error as ServerActionKeyError;
  }
  throw new Error("not refused");
}

describe("the data directory's server-action key", () => {
  test("is made once, 32 random bytes as base64, in a file of its own at mode 0600, and the same key is answered on every later read", () => {
    const directory = dataDirectory();
    const sizes: number[] = [];
    const random = (size: number) => {
      sizes.push(size);
      return Buffer.alloc(size, 9);
    };

    const first = serverActionKey(directory, { random });
    const second = serverActionKey(directory, { random });
    const path = join(directory, SERVER_ACTION_KEY_FILE);

    expect(sizes).toEqual([32]);
    expect(first).toEqual({
      key: Buffer.alloc(32, 9).toString("base64"),
      path,
      made: true,
    });
    expect(second).toEqual({ ...first, made: false });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(`${first.key}\n`);
    expect(readdirSync(directory)).toEqual([SERVER_ACTION_KEY_FILE]);
  });

  test("by default draws its bytes from node:crypto: two data directories get two keys, each of 32 bytes", () => {
    const one = serverActionKey(dataDirectory()).key;
    const two = serverActionKey(dataDirectory()).key;

    expect(Buffer.from(one, "base64")).toHaveLength(32);
    expect(Buffer.from(two, "base64")).toHaveLength(32);
    expect(one).not.toBe(two);
  });

  test("reads a key file the operator wrote, base64 of 32 bytes, with or without a final line break", () => {
    expect(serverActionKey(withKeyFile(KEY).directory)).toMatchObject({
      key: KEY,
      made: false,
    });
    expect(serverActionKey(withKeyFile(`${KEY}\n`).directory).key).toBe(KEY);
  });

  test.each(
    [0o640, 0o604, 0o660, 0o620, 0o602, 0o644].map(
      (mode) => [mode.toString(8), mode] as const,
    ),
  )(
    "refuses a key file of mode %s, open to group or others, naming it and the remedy, and leaves it as it was",
    (_octal, mode) => {
      const { directory, path } = withKeyFile(`${KEY}\n`, mode);

      const error = refusal(() => serverActionKey(directory), KEY);

      expect(error.message).toContain(`${path} is open to group or others`);
      expect(error.message).toContain(`chmod 600 ${path}`);
      expect(readFileSync(path, "utf8")).toBe(`${KEY}\n`);
      expect(statSync(path).mode & 0o777).toBe(mode);
    },
  );

  test("refuses a key file that is a symbolic link (here to a file at mode 0600), a directory, or another user's file", () => {
    const target = withKeyFile(`${KEY}\n`).path;
    const linked = dataDirectory();
    symlinkSync(target, join(linked, SERVER_ACTION_KEY_FILE));
    const directoryInstead = dataDirectory();
    mkdirSync(join(directoryInstead, SERVER_ACTION_KEY_FILE), { mode: 0o700 });
    const { directory: owned, path } = withKeyFile(`${KEY}\n`);

    expect(refusal(() => serverActionKey(linked), KEY).message).toContain(
      "is a symbolic link",
    );
    expect(refusal(() => serverActionKey(directoryInstead)).message).toContain(
      "is not a regular file",
    );
    expect(
      refusal(() => serverActionKey(owned, { uid: statSync(path).uid + 1 }))
        .message,
    ).toContain("belongs to another user");
  });

  test.each([
    ["empty", ""],
    ["not base64", "not a key at all, and certainly not this one"],
    [
      "base64url, which Next's atob does not read",
      Buffer.alloc(32, 251).toString("base64url"),
    ],
    ["16 bytes", Buffer.alloc(16, 7).toString("base64")],
    ["two keys", `${KEY}\n${KEY}\n`],
  ])(
    "refuses a key file that holds no key Next can use (%s), without repeating what it holds",
    (_name, contents) => {
      const { directory, path } = withKeyFile(contents);

      const error = refusal(
        () => serverActionKey(directory),
        ...(contents === "" ? [] : [contents.trim(), KEY]),
      );

      expect(error.message).toContain(
        `${path} does not hold a server-action key`,
      );
      expect(readFileSync(path, "utf8")).toBe(contents);
    },
  );
});

describe(`${SERVER_ACTION_KEY_VARIABLE} in requestport start's environment`, () => {
  test("is refused, set to any value or to none, naming the variable and the data directory's file, never the value", () => {
    for (const value of [KEY, "", "an operator's own"]) {
      const error = refusal(
        () =>
          refuseInheritedServerActionKey({
            PATH: "/bin",
            [SERVER_ACTION_KEY_VARIABLE]: value,
          }),
        ...(value === "" ? [] : [value]),
      );

      expect(error.message).toContain(
        `${SERVER_ACTION_KEY_VARIABLE} is set in requestport start's environment`,
      );
      expect(error.message).toContain(SERVER_ACTION_KEY_FILE);
    }
  });

  test("is not refused when it is not set", () => {
    expect(() =>
      refuseInheritedServerActionKey({ PATH: "/bin" }),
    ).not.toThrow();
  });
});
