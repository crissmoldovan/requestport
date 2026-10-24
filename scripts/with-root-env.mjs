import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeOwnerCapableVariables } from "./owner-capable-variables.mjs";
import { refuseUnapprovedProductionDatabase } from "./production-database-guard.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_START_FAILURE = "RequestPort child command failed to start.";

function parseEnvFile(contents) {
  const values = {};

  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u,
    );

    if (!match || line.trimStart().startsWith("#")) {
      continue;
    }

    const [, key, rawValue] = match;
    const quote = rawValue.at(0);
    const value =
      (quote === '"' || quote === "'") && rawValue.endsWith(quote)
        ? rawValue.slice(1, -1)
        : rawValue.replace(/\s+#.*$/u, "");

    values[key] = value;
  }

  return values;
}

export function loadRootEnv({
  env = process.env,
  rootDirectory = repositoryRoot,
} = {}) {
  const envPath = resolve(rootDirectory, ".env.local");

  if (!existsSync(envPath)) {
    return env;
  }

  for (const [key, value] of Object.entries(
    parseEnvFile(readFileSync(envPath, "utf8")),
  )) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * The flag two scripts pass, each wrapping a process that is refused beside
 * an owner-capable name: `DATABASE_URL`, any `DATABASE_URL_*`, `PG*` or
 * `POSTGRES_*`.
 * - `pnpm dev` (Plan 13, I.2 step 7; ruling 224 item 3) starts the web
 *   application, an application process, whose storage the role guard has
 *   refused at its first query beside one since step 7.
 * - `pnpm --filter @requestport/jobs worker` (ruling 225 item 3) starts
 *   `requestport-jobs`, which exits 2 before starting beside one (I.2b's b6,
 *   ruling 218).
 *
 * With it, every such name is removed after `.env.local` has filled the
 * environment, one line each on standard error naming the variable and never
 * its value. Migrations and the suites run without it and keep
 * `DATABASE_URL`, the owner.
 */
export const WITHOUT_OWNER_VARIABLES_FLAG = "--without-owner-variables";

/**
 * The status this process exits with once its command has closed: the
 * command's exit code, or, when a signal ended the command, 128 plus that
 * signal's number (130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP), as a
 * shell reports it and as `seed-scripts-check.mjs` exits when stopped. A
 * signal this platform gives no number exits 1.
 */
export function exitStatusOf(code, signal) {
  if (code !== null && code !== undefined) return code;
  if (!signal) return 0;
  const number = constants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}

/**
 * The signals passed on to the command (ruling 246), the three
 * `seed-scripts-check.mjs` stops on. pnpm passes SIGTERM and SIGINT on to its
 * script's command, which is this process when the script's whole command
 * is this process, and a supervisor or `kill <pid>` sends any of the three
 * to a pid.
 */
export const PASSED_ON_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

/**
 * Passes SIGINT, SIGTERM and SIGHUP, as `signals` (this process, by default)
 * receives them, on to `child` with `child.kill(signal)`: the first arrival
 * of each, and no later arrival of the same signal. While the handlers are
 * set, none of the three ends this process. Answers a function that removes
 * them.
 *
 * When `kill` fails, as it does with EPERM once the command runs as another
 * user, Node's `ChildProcess#kill` emits `error` on `child` from inside the
 * call. The handler then writes one line naming the signal and the error's
 * code, and the signal counts as passed on: a later arrival of it is not
 * tried again. `run` goes on waiting for the command to close.
 *
 * Without the handlers, a signal sent to this process's pid alone ended it
 * at once and left its command running (`gotchas.md`, 2026-10-22). pnpm
 * sends one so when a script's whole command is this process: `sh` then
 * executes this process in its own place, and pnpm passes SIGTERM and SIGINT
 * on to it. A compound script (`… && …`) keeps `sh` between pnpm and this
 * process, and `sh` passes neither on, so there pnpm's copy stops at `sh`.
 *
 * A signal sent to the whole process group, as a terminal's Ctrl-C is, is
 * sent to the command twice: once to the group, and once from here. The
 * command's handler then runs twice, unless the second copy arrives while
 * the first is still pending, when the kernel delivers the two as one.
 * pnpm and npm do the same to a command they run directly, and the jobs
 * worker takes a second stop signal within 1 s of the first as the same
 * stop (`packages/jobs/src/cli.ts`). A repeated Ctrl-C reaches the command
 * again through the group, and not from here.
 */
export function passSignalsOn(child, signals = process) {
  const handlers = PASSED_ON_SIGNALS.map((signal) => {
    let passed = false;
    const handler = () => {
      if (passed) return;
      passed = true;
      const failed = (error) => {
        console.error(
          `with-root-env: could not pass ${signal} on to its command (${error?.code ?? "no error code"}); waiting for it to close.`,
        );
      };
      child.on("error", failed);
      try {
        child.kill(signal);
      } finally {
        child.off("error", failed);
      }
    };
    signals.on(signal, handler);
    return [signal, handler];
  });

  return () => {
    for (const [signal, handler] of handlers) signals.off(signal, handler);
  };
}

/**
 * Runs `command` with `args` in this checkout's environment, and answers the
 * status this process exits with: `exitStatusOf` the command's close, or 1,
 * saying `CHILD_START_FAILURE`, when the command fails to start. It throws,
 * starting nothing, when that environment names a shared database without
 * its opt-in. From the moment the spawn returns until the command closes or
 * fails to start, `passSignalsOn` passes the stop signals on to it, so none
 * of the three ends this process in that time. A signal that arrives before
 * the spawn returns ends this process as Node's default does. Before the
 * spawn there is nothing to stop; while the spawn is still returning, the
 * command may already be running, and it runs on (`track-j.md`, ruling 246's
 * record, open question 1).
 *
 * Node emits `error` on a child process that fails to spawn, that it fails to
 * kill or to send a message to, or that is aborted. Nothing here sends the
 * command a message or aborts it. A command that failed to spawn has no pid,
 * so `error` with no pid is a start failure. With a pid, the command has
 * started, and `error` is a failed `kill`: `passSignalsOn` has said so, and
 * this goes on waiting for the command to close.
 *
 * `dependencies` are the environment (this process's, filled from
 * `.env.local`), `spawn`, and the process whose signals are passed on (this
 * one), unless a test hands its own (`with-root-env.test.mjs`).
 */
export async function run(
  command,
  args,
  { withoutOwnerVariables = false } = {},
  dependencies = {},
) {
  const {
    environment = loadRootEnv(),
    spawnChild = spawn,
    signals = process,
  } = dependencies;
  /**
   * Checked here because here is where it went wrong: this function fills unset
   * variables from `.env.local`, so a checkout whose `.env.local` named
   * production silently pointed every command it wrapped at production.
   */
  refuseUnapprovedProductionDatabase(environment);
  if (withoutOwnerVariables) {
    removeOwnerCapableVariables(environment, (name) => {
      console.error(
        `with-root-env: removed ${name} from this command's environment (${WITHOUT_OWNER_VARIABLES_FLAG}): the process it starts connects through a login of its own, and is refused beside a variable that can reach the database as its owner.`,
      );
    });
  }
  const child = spawnChild(command, args, {
    env: environment,
    stdio: "inherit",
  });
  const stopPassing = passSignalsOn(child, signals);

  return await new Promise((resolveStatus) => {
    let settled = false;

    const finish = (status, message) => {
      if (settled) return;
      settled = true;
      stopPassing();
      if (message) console.error(message);
      resolveStatus(status);
    };

    child.on("error", () => {
      if (child.pid === undefined) finish(1, CHILD_START_FAILURE);
    });
    child.once("close", (code, signal) => {
      finish(exitStatusOf(code, signal));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const given = process.argv.slice(2);
  const withoutOwnerVariables = given[0] === WITHOUT_OWNER_VARIABLES_FLAG;
  const [command, ...args] = withoutOwnerVariables ? given.slice(1) : given;

  if (!command) {
    console.error(
      "Usage: node scripts/with-root-env.mjs [--without-owner-variables] <command> [...args]",
    );
    process.exitCode = 1;
  } else {
    run(command, args, { withoutOwnerVariables }).then(
      (status) => {
        process.exitCode = status;
      },
      (error) => {
        /**
         * The refusal's own words, not the generic one.
         *
         * This handler existed to turn a spawn failure into one fixed line,
         * and it swallowed the production-database refusal into "child
         * command failed to start" — a message that tells a person nothing
         * about what actually stopped them or how to proceed deliberately.
         */
        console.error(
          error instanceof Error && error.message
            ? error.message
            : CHILD_START_FAILURE,
        );
        process.exitCode = 1;
      },
    );
  }
}
