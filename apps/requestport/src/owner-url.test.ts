import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, describe, expect, test, vi } from "vitest";

import {
  OWNER_FILE,
  OWNER_URL_FORMS,
  OwnerUrlError,
  parseOwnerUrl,
  promptOwnerUrl,
  readOwnerFile,
  readOwnerUrlFile,
  readOwnerUrlStdin,
  refuseOwnerUrlInArgv,
  writeOwnerFile,
} from "./owner-url.js";

const SENTINEL = "S3NT1NEL_0wner_secret";
const ownerUrl = `postgres://owner:${SENTINEL}@127.0.0.1:5432/requestport`;

const scratch = mkdtempSync(join(tmpdir(), "requestport-owner-url-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;
const fileWith = (contents: string, mode = 0o600) => {
  made += 1;
  const path = join(scratch, `owner-${made}.url`);
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
};

/** The refusal's message, which must never carry the sentinel. */
function refusal(run: () => unknown): OwnerUrlError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerUrlError);
    expect((error as Error).message).not.toContain(SENTINEL);
    return error as OwnerUrlError;
  }
  throw new Error("not refused");
}

describe("the owner URL on the command line (manifest-h.md §2.4)", () => {
  test.each([
    [["--owner-url", ownerUrl]],
    [[`--owner-url=${ownerUrl}`]],
    [["--data-dir", "/x", "--owner-url", ownerUrl, "--email", "a@b.c"]],
    [["--owner-url"]],
  ])(
    "refuses %j with exit 2, naming the three forms and not the value",
    (argv) => {
      const error = refusal(() => refuseOwnerUrlInArgv(argv));

      expect(error.exitCode).toBe(2);
      expect(error.message).toContain(OWNER_URL_FORMS);
      expect(error.message).toMatch(/--owner-url-file <path>/u);
      expect(error.message).toMatch(/--owner-url-stdin/u);
      expect(error.message).toMatch(/at a prompt/u);
    },
  );

  test("lets the two forms that carry no value through", () => {
    expect(() =>
      refuseOwnerUrlInArgv([
        "--owner-url-file",
        "/path/to/file",
        "--owner-url-stdin",
      ]),
    ).not.toThrow();
  });
});

describe("the owner URL's shape", () => {
  test("accepts a postgres URL with a user, a password, a host and a database, trimmed", () => {
    expect(parseOwnerUrl(`  ${ownerUrl}\n`, "a test")).toBe(ownerUrl);
    expect(
      parseOwnerUrl(ownerUrl.replace("postgres:", "postgresql:"), "a test"),
    ).toBe(ownerUrl.replace("postgres:", "postgresql:"));
  });

  test.each([
    ["", /is empty/u],
    [`${ownerUrl}\n${ownerUrl}`, /more than one line/u],
    [`not a url ${SENTINEL}`, /is not a URL/u],
    [
      `http://owner:${SENTINEL}@127.0.0.1/requestport`,
      /postgres: or postgresql:/u,
    ],
    [`postgres://:${SENTINEL}@127.0.0.1/requestport`, /names no user/u],
    ["postgres://owner@127.0.0.1/requestport", /carries no password/u],
    [`postgres://owner:${SENTINEL}@127.0.0.1/`, /names no database/u],
  ])("refuses %j without repeating it", (text, why) => {
    const error = refusal(() => parseOwnerUrl(text, "a test"));

    expect(error.message).toMatch(why);
    expect(error.exitCode).toBe(1);
  });
});

describe("--owner-url-file", () => {
  test("reads a regular file that is this user's and closed to group and others", () => {
    expect(readOwnerUrlFile(fileWith(`${ownerUrl}\n`))).toBe(ownerUrl);
  });

  test.each([0o640, 0o604, 0o660, 0o620, 0o644])(
    "refuses a file of mode %o, with the remedy",
    (mode) => {
      const path = fileWith(ownerUrl, mode);
      const error = refusal(() => readOwnerUrlFile(path));

      expect(error.message).toContain("is open to group or others");
      expect(error.message).toContain(`chmod 600 ${path}`);
    },
  );

  test("refuses a symbolic link, even to a closed file", () => {
    const target = fileWith(ownerUrl);
    const link = join(scratch, "owner-link.url");
    symlinkSync(target, link);

    expect(refusal(() => readOwnerUrlFile(link)).message).toContain(
      "is a symbolic link",
    );
  });

  test("refuses another user's file, a directory and a missing path", () => {
    const path = fileWith(ownerUrl);
    const owner = statSync(path).uid;
    const directory = join(scratch, "a-directory");
    mkdirSync(directory, { mode: 0o700 });

    expect(
      refusal(() => readOwnerUrlFile(path, { uid: owner + 1 })).message,
    ).toContain("belongs to another user");
    expect(refusal(() => readOwnerUrlFile(directory)).message).toContain(
      "is not a regular file",
    );
    expect(
      refusal(() => readOwnerUrlFile(join(scratch, "absent"))).message,
    ).toContain("no such file");
  });

  test("refuses a file whose contents are not an owner URL, without repeating them", () => {
    expect(
      refusal(() => readOwnerUrlFile(fileWith(`nonsense ${SENTINEL}`))).message,
    ).toContain("is not a URL");
  });
});

describe("--owner-url-stdin", () => {
  test("reads the first line of a pipe", async () => {
    const input = new PassThrough();
    const read = readOwnerUrlStdin(input);
    input.write(`${ownerUrl}\nanything after it`);

    await expect(read).resolves.toBe(ownerUrl);
  });

  test("reads a line that ends with the input", async () => {
    const input = new PassThrough();
    const read = readOwnerUrlStdin(input);
    input.end(ownerUrl);

    await expect(read).resolves.toBe(ownerUrl);
  });

  test("refuses a terminal with exit 2, and an empty input", async () => {
    const terminal = Object.assign(new PassThrough(), { isTTY: true });
    const atTerminal = await readOwnerUrlStdin(terminal).catch((e) => e);
    expect(atTerminal).toBeInstanceOf(OwnerUrlError);
    expect((atTerminal as OwnerUrlError).exitCode).toBe(2);

    const empty = new PassThrough();
    const read = readOwnerUrlStdin(empty);
    empty.end();
    await expect(read).rejects.toThrow(/is empty/u);
  });
});

/** A terminal's standard input, as much of it as the prompt uses. */
function fakeTerminal() {
  const emitter = new EventEmitter();
  const modes: boolean[] = [];
  return Object.assign(emitter, {
    isTTY: true,
    modes,
    setRawMode: vi.fn((mode: boolean) => {
      modes.push(mode);
    }),
    setEncoding: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    type(text: string) {
      emitter.emit("data", text);
    },
  });
}

describe("the prompt", () => {
  test("turns echo off before it asks, writes nothing of what is typed, and turns it back on", async () => {
    const terminal = fakeTerminal();
    const written: string[] = [];
    const output = {
      write: (text: string) => {
        written.push(text);
        // The prompt is shown only once echo is off.
        if (text.startsWith("Owner URL")) {
          expect(terminal.modes).toEqual([true]);
        }
      },
    };

    const answer = promptOwnerUrl(terminal, output);
    terminal.type(`${ownerUrl.slice(0, 10)}X\u007f`);
    terminal.type(`${ownerUrl.slice(10)}\r`);

    await expect(answer).resolves.toBe(ownerUrl);
    expect(terminal.modes).toEqual([true, false]);
    expect(written).toEqual(["Owner URL (not echoed): ", "\n"]);
    expect(terminal.listenerCount("data")).toBe(0);
  });

  test("stops at Ctrl-C, with echo back on", async () => {
    const terminal = fakeTerminal();
    const answer = promptOwnerUrl(terminal, { write: () => undefined });
    terminal.type(`${SENTINEL}\u0003`);

    const error = await answer.catch((e) => e);
    expect(error).toBeInstanceOf(OwnerUrlError);
    expect((error as Error).message).not.toContain(SENTINEL);
    expect(terminal.modes).toEqual([true, false]);
  });

  test("is refused, with exit 2 and the forms, when standard input is not a terminal", async () => {
    const error = await promptOwnerUrl(new PassThrough(), {
      write: () => undefined,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(OwnerUrlError);
    expect((error as OwnerUrlError).exitCode).toBe(2);
    expect((error as Error).message).toContain(OWNER_URL_FORMS);
  });
});

describe("owner.json", () => {
  test("is written mode 0600 and read back", () => {
    const directory = mkdtempSync(join(scratch, "data-"));
    writeOwnerFile(directory, ownerUrl);

    expect(statSync(join(directory, OWNER_FILE)).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(readFileSync(join(directory, OWNER_FILE), "utf8")),
    ).toEqual({ version: 1, ownerUrl });
    expect(readOwnerFile(directory)).toBe(ownerUrl);
  });

  test("is absent before a start writes it, and a malformed one is refused without its contents", () => {
    const directory = mkdtempSync(join(scratch, "data-"));
    expect(readOwnerFile(directory)).toBeUndefined();

    writeFileSync(
      join(directory, OWNER_FILE),
      JSON.stringify({ version: 1, ownerUrl, extra: SENTINEL }),
    );
    expect(refusal(() => readOwnerFile(directory)).message).toContain(
      "is not an owner file",
    );
  });
});
