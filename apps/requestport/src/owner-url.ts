import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";

import { readDataFile, writeFileAtomic } from "./atomic-file.js";

/**
 * The owner URL: the PostgreSQL connection string, with the owner's
 * credentials in it, that the operator step migrates and provisions through
 * (manifest-h.md §2.4). It is received in three forms only, and never as a
 * value on the command line, where it would sit in `process.argv`, the
 * process table and the shell's history. It is stored in the data
 * directory's `owner.json`, mode 0600 (owner question 7's proposal, ruling
 * 156), which only the operator step reads.
 *
 * Nothing here repeats the URL, or any part of it, in a message.
 */

export const OWNER_FILE = "owner.json";

export const OWNER_URL_FORMS = `The owner URL is never accepted as a value on the command line. Give it in one of three forms:
  at a prompt, which does not echo it, when standard input is a terminal;
  --owner-url-file <path>  a file holding it, owned by you and readable by no one else (chmod 600 <path>);
  --owner-url-stdin        one line read from standard input, when standard input is not a terminal.`;

/** How a start was told to receive the owner URL. */
export type OwnerUrlForm =
  | { kind: "prompt" }
  | { kind: "file"; path: string }
  | { kind: "stdin" };

export class OwnerUrlError extends Error {
  /** 2 for a usage error, 1 for anything else. */
  readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = "OwnerUrlError";
    this.exitCode = exitCode;
  }
}

/**
 * Refuses `--owner-url <value>` and `--owner-url=<value>` anywhere in
 * `argv`, before anything else reads it: exit 2, with a message that names
 * `program`, the three forms and not the value.
 */
export function refuseOwnerUrlInArgv(
  argv: readonly string[],
  program = "requestport start",
): void {
  for (const argument of argv) {
    if (argument === "--owner-url" || argument.startsWith("--owner-url=")) {
      throw new OwnerUrlError(
        `${program}: --owner-url takes no value on the command line. ${OWNER_URL_FORMS}`,
        2,
      );
    }
  }
}

/**
 * Checks an owner URL's shape and answers it trimmed: `postgres:` or
 * `postgresql:`, with a user, a password, a host and a database. The driver
 * checks the rest when the operator step connects.
 */
export function parseOwnerUrl(text: string, source: string): string {
  const value = text.trim();
  const refuse = (why: string) =>
    new OwnerUrlError(
      `requestport start: the owner URL from ${source} ${why}. It is a PostgreSQL URL, postgres://<user>:<password>@<host>[:<port>]/<database>.`,
    );
  if (value === "") throw refuse("is empty");
  if (/[\r\n]/u.test(value)) throw refuse("holds more than one line");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refuse("is not a URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw refuse("is not a postgres: or postgresql: URL");
  }
  if (url.username === "") throw refuse("names no user");
  if (url.password === "") throw refuse("carries no password");
  if (url.hostname === "") throw refuse("names no host");
  if (url.pathname.length <= 1) throw refuse("names no database");
  return value;
}

/**
 * `--owner-url-file <path>`: a regular file, not a symbolic link, owned by
 * this user and open to neither group nor others, read through a descriptor
 * opened with `O_NOFOLLOW` and checked again, so the file judged is the file
 * read. On win32, which has no such modes, it is only read.
 */
export function readOwnerUrlFile(
  path: string,
  { uid = process.getuid?.() }: { uid?: number } = {},
): string {
  const source = `--owner-url-file ${path}`;
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OwnerUrlError(`requestport start: ${source}: no such file.`);
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new OwnerUrlError(
      `requestport start: ${source} is a symbolic link. Name the file itself.`,
    );
  }
  if (!stats.isFile()) {
    throw new OwnerUrlError(
      `requestport start: ${source} is not a regular file.`,
    );
  }
  if (process.platform !== "win32") {
    if (uid !== undefined && stats.uid !== uid) {
      throw new OwnerUrlError(
        `requestport start: ${source} belongs to another user (uid ${stats.uid}). It holds the owner's credentials: keep it in a file of your own.`,
      );
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new OwnerUrlError(
        `requestport start: ${source} is open to group or others (mode ${(stats.mode & 0o777).toString(8)}), and it holds the owner's credentials. Run \`chmod 600 ${path}\`, then start again.`,
      );
    }
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (opened.ino !== stats.ino || opened.dev !== stats.dev) {
      throw new OwnerUrlError(
        `requestport start: ${source} changed while it was read. Start again.`,
      );
    }
    return parseOwnerUrl(readFileSync(descriptor, "utf8"), source);
  } finally {
    closeSync(descriptor);
  }
}

/** What reading standard input needs of it. */
export interface InputStream extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface OutputStream {
  write(text: string): unknown;
}

/** The longest line read for the owner URL. */
const MAX_LINE = 4096;

/**
 * `--owner-url-stdin`: the first line of standard input, which must not be a
 * terminal (at a terminal, a start prompts instead).
 */
export function readOwnerUrlStdin(input: InputStream): Promise<string> {
  const source = "--owner-url-stdin";
  if (input.isTTY === true) {
    return Promise.reject(
      new OwnerUrlError(
        "requestport start: --owner-url-stdin reads a pipe or a file, and standard input is a terminal. At a terminal, leave it out: start asks for the owner URL without echoing it.",
        2,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    let text = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
      if (error !== undefined) {
        reject(error);
        return;
      }
      try {
        resolve(parseOwnerUrl(text.split(/\r?\n/u)[0] ?? "", source));
      } catch (refused) {
        reject(refused);
      }
    };
    const onData = (chunk: Buffer | string) => {
      text += chunk.toString();
      if (text.includes("\n")) finish();
      else if (text.length > MAX_LINE) {
        finish(
          new OwnerUrlError(
            `requestport start: the line from ${source} is longer than ${MAX_LINE} characters.`,
          ),
        );
      }
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

/**
 * The prompt: asks on `output` and reads one line from the terminal `input`
 * with echo off (raw mode, which echoes nothing; this writes nothing for a
 * keystroke). Backspace removes a character; Ctrl-C and Ctrl-D stop the
 * start.
 */
export function promptOwnerUrl(
  input: InputStream,
  output: OutputStream,
): Promise<string> {
  if (input.isTTY !== true || input.setRawMode === undefined) {
    return Promise.reject(
      new OwnerUrlError(
        `requestport start: this data directory has no owner URL yet, and standard input is not a terminal to ask at. ${OWNER_URL_FORMS}`,
        2,
      ),
    );
  }
  const setRawMode = input.setRawMode.bind(input);
  // Echo goes off before the prompt is shown, so nothing typed in answer to
  // it can be echoed.
  setRawMode(true);
  output.write("Owner URL (not echoed): ");
  return new Promise((resolve, reject) => {
    let text = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      setRawMode(false);
      input.pause();
      output.write("\n");
      if (error !== undefined) {
        reject(error);
        return;
      }
      try {
        resolve(parseOwnerUrl(text, "the prompt"));
      } catch (refused) {
        reject(refused);
      }
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003" || character === "\u0004") {
          finish(
            new OwnerUrlError("requestport start: stopped at the prompt."),
          );
          return;
        }
        if (character === "\u007f" || character === "\b") {
          text = text.slice(0, -1);
          continue;
        }
        text += character;
        if (text.length > MAX_LINE) {
          finish(
            new OwnerUrlError(
              `requestport start: the owner URL is longer than ${MAX_LINE} characters.`,
            ),
          );
          return;
        }
      }
    };
    input.setEncoding?.("utf8");
    input.on("data", onData);
    input.resume();
  });
}

/** Receives the owner URL in the form the start was given. */
export function receiveOwnerUrl(
  form: OwnerUrlForm,
  {
    input,
    output,
    uid,
  }: { input: InputStream; output: OutputStream; uid?: number },
): Promise<string> {
  switch (form.kind) {
    case "file":
      return Promise.resolve().then(() =>
        readOwnerUrlFile(form.path, uid === undefined ? {} : { uid }),
      );
    case "stdin":
      return readOwnerUrlStdin(input);
    case "prompt":
      return promptOwnerUrl(input, output);
  }
}

/** Writes `owner.json`, mode 0600, through `writeFileAtomic`. */
export function writeOwnerFile(directory: string, ownerUrl: string): void {
  writeFileAtomic(
    directory,
    OWNER_FILE,
    `${JSON.stringify({ version: 1, ownerUrl }, null, 2)}\n`,
  );
}

/**
 * The owner URL `owner.json` holds, or `undefined` when there is no such
 * file. `read` is how the file is read; the operator step passes its own.
 */
export function readOwnerFile(
  directory: string,
  read: (directory: string, name: string) => string | undefined = readDataFile,
): string | undefined {
  const text = read(directory, OWNER_FILE);
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OwnerUrlError(`${OWNER_FILE} in ${directory} is not valid JSON.`);
  }
  const record = value as { version?: unknown; ownerUrl?: unknown };
  if (
    typeof value !== "object" ||
    value === null ||
    record.version !== 1 ||
    typeof record.ownerUrl !== "string" ||
    Object.keys(value).length !== 2
  ) {
    throw new OwnerUrlError(
      `${OWNER_FILE} in ${directory} is not an owner file: it holds { "version": 1, "ownerUrl": "…" }.`,
    );
  }
  return parseOwnerUrl(record.ownerUrl, OWNER_FILE);
}
