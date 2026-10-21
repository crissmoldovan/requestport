import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/*
 * Starts and commands as processes of their own, for the integration tests
 * beside this module and nothing else: the shipped executable, the start's
 * test entry (`start/start.test-entry.ts`), the crashing one
 * (`crashing-start.test-entry.ts`), the web UI's counting one
 * (`web-ui.test-entry.ts`) or the server-action key's probing one
 * (`action-key.test-entry.ts`), and the owner's sign-in through the host.
 * Nothing here opens a database.
 */

const workspace = resolve(import.meta.dirname, "../..");
export const bin = join(workspace, "bin", "requestport.mjs");
const entries = {
  entry: join(workspace, "src", "start", "start.test-entry.ts"),
  crashing: join(
    workspace,
    "src",
    "test-support",
    "crashing-start.test-entry.ts",
  ),
  "web-ui": join(workspace, "src", "test-support", "web-ui.test-entry.ts"),
  "action-key": join(
    workspace,
    "src",
    "test-support",
    "action-key.test-entry.ts",
  ),
};
const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx/esm"),
).href;

export interface Finished {
  pid: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  served: boolean;
}

/** What `requestport start` says once it serves (`serve/run.ts`). */
const SERVING = "requestport start: serving ";

/** How long a start may run before it is killed, so a hung one ends with its test. */
const DEADLINE_MS = 150_000;

/**
 * Runs a start to its end. Once it says it serves, `whileServing` runs, and
 * then SIGTERM stops it, as a self-hoster stops it; a failure inside
 * `whileServing` rejects once the process has closed. A start still running
 * after `DEADLINE_MS` is killed with SIGKILL, and answers that signal.
 */
export function runStart(
  command: "bin" | "entry" | "crashing" | "web-ui" | "action-key",
  args: readonly string[],
  {
    env = process.env,
    whileServing,
  }: {
    env?: NodeJS.ProcessEnv;
    whileServing?: (output: { stdout(): string }) => Promise<void>;
  } = {},
): Promise<Finished> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      command === "bin"
        ? [bin, "start", ...args]
        : ["--import", tsxLoader, entries[command], ...args],
      { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let served = false;
    let checked: Promise<unknown> = Promise.resolve();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (!served && stderr.includes(SERVING)) {
        served = true;
        checked = (async () => {
          try {
            await whileServing?.({ stdout: () => stdout });
          } finally {
            child.kill("SIGTERM");
          }
        })().then(
          () => undefined,
          (error: unknown) => error,
        );
      }
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), DEADLINE_MS);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      void checked.then((failure) => {
        if (failure !== undefined) reject(failure);
        else
          resolvePromise({
            pid: child.pid as number,
            code,
            signal,
            stdout,
            stderr,
            served,
          });
      });
    });
    child.stdin.end("");
  });
}

/** `requestport <args>` through the executable, its standard input closed, killed after `DEADLINE_MS`. */
export function runCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), DEADLINE_MS);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(deadline);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/** A port nothing listens on now, which the system chose: never 3100. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolvePort(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

/** The local credentials a run printed: the lines of its standard output that are one. */
export const credentialsIn = (stdout: string) =>
  stdout
    .replaceAll("\r", "")
    .split("\n")
    .filter((line) => /^[A-Za-z0-9_-]{43}$/u.test(line));

/**
 * Signs `email` in with a local credential through the host at `serverUrl`,
 * from `origin` (the public URL; `serverUrl` unless a proxy would stand in
 * front): the status, and the cookies it set.
 */
export async function signIn(
  serverUrl: string,
  email: string,
  credential: string,
  origin = serverUrl,
) {
  const response = await fetch(`${serverUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password: credential }),
  });
  await response.arrayBuffer();
  return {
    status: response.status,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; "),
  };
}

/** Whether `cookie` still names a session, as the host at `serverUrl` answers `get-session`. */
export async function sessionLives(serverUrl: string, cookie: string) {
  const response = await fetch(`${serverUrl}/api/auth/get-session`, {
    headers: { cookie },
  });
  if (response.status !== 200) {
    throw new Error(`get-session answered ${response.status}`);
  }
  return (await response.json()) !== null;
}
