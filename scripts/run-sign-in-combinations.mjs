import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { acceptanceProviderSettings } from "../apps/web/tests/fixtures/acceptance-provider-settings.ts";
import {
  createE2ERunDirectory,
  E2E_RUN_DIRECTORY_VARIABLE,
} from "../apps/web/tests/fixtures/e2e-run-directory.ts";
import {
  acceptanceLoginExists,
  acceptanceLoginOwnerUrl,
  repositoryRoot,
} from "./start-e2e-server.mjs";

/*
 * D's deferred browser acceptance (Plan 13, H.9; manifest-h.md Done when 16).
 *
 * One server per sign-in provider combination, one after another, each on
 * port 3100, and `apps/web/tests/sign-in-combinations/sign-in-methods.spec.ts`
 * run against each. It is not part of `--e2e`: `playwright.config.ts` selects
 * that spec only when `REQUESTPORT_SIGN_IN_COMBINATION` is set, which this
 * runner does for the runs it starts (and its test, to list cases and load
 * the configuration), and which neither `--e2e` nor `pnpm test:e2e` sets.
 *
 * It takes no lock. Port 3100 is one per machine (R3), so the run belongs
 * inside one turn of the gate lock, and it refuses to start a server while
 * anything answers there.
 */

/** The one port the acceptance server listens on (`start-e2e-server.mjs`). */
export const SIGN_IN_PORT = 3100;
export const SIGN_IN_HOST = "127.0.0.1";
export const SIGN_IN_BASE_URL = `http://${SIGN_IN_HOST}:${SIGN_IN_PORT}`;

/**
 * Names the combination a server was started with. `playwright.config.ts`
 * reads it to run the sign-in project alone, and the spec reads it to refuse
 * a combination's cases against another combination's server.
 */
export const SIGN_IN_COMBINATION_VARIABLE = "REQUESTPORT_SIGN_IN_COMBINATION";

/** The project `playwright.config.ts` declares while that variable is set. */
export const SIGN_IN_PROJECT = "sign-in-methods";

/*
 * Placeholders, not credentials: no GitHub application has this client, and
 * no Resend account this key. The spec never follows GitHub's authorization
 * address, and a server in E2E mode hands a magic link to the e2e outbox
 * (`packages/auth/src/server-magic-link.ts`), never to Resend.
 */
const githubPair = Object.freeze({
  GITHUB_CLIENT_ID: "e2e-sign-in-not-a-github-client",
  GITHUB_CLIENT_SECRET: "e2e-sign-in-not-a-github-secret",
});
const magicLinkPair = Object.freeze({
  RESEND_API_KEY: "e2e-sign-in-not-a-resend-key",
  RESEND_FROM_EMAIL: "sign-in-combinations@example.invalid",
});

/** The four combinations, in the order they run. */
export const SIGN_IN_COMBINATIONS = Object.freeze([
  Object.freeze({ name: "none", environment: Object.freeze({}) }),
  Object.freeze({ name: "github", environment: githubPair }),
  Object.freeze({ name: "magic-link", environment: magicLinkPair }),
  Object.freeze({
    name: "both",
    environment: Object.freeze({ ...githubPair, ...magicLinkPair }),
  }),
]);

/**
 * The names removed from the inherited environment before a combination's
 * own are set: the two pairs `readSignInMethods` reads
 * (`packages/config/src/sign-in-methods.ts`), the local credential's switch,
 * and `VERCEL_ENV`, which turns the local credential off wherever it is set.
 * Left in, a value from `.env.local` would decide the combination instead.
 */
export const SIGN_IN_DECIDED_VARIABLES = Object.freeze([
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "REQUESTPORT_LOCAL_CREDENTIAL",
  "VERCEL_ENV",
]);

/** The tag that selects one combination's cases in the spec. */
export function signInCombinationTag(name) {
  return `@sign-in-${name}`;
}

/**
 * The environment one combination's server and spec both run with.
 *
 * The default lanes' web server environment (`playwright.config.ts`,
 * `webServer.env`), with the names above removed and the combination's set.
 * The token is new for each combination; the server's outbox route admits
 * only the token its process was given, and the spec presents the same one.
 */
export function signInCombinationEnvironment(
  combination,
  { baseEnvironment = process.env, runDirectory, token },
) {
  if (typeof token !== "string" || token.length < 32) {
    throw new Error(
      "A sign-in combination needs an E2E token of 32 characters or more.",
    );
  }
  const environment = { ...baseEnvironment, ...acceptanceProviderSettings };
  for (const name of SIGN_IN_DECIDED_VARIABLES) delete environment[name];

  return {
    ...environment,
    BETTER_AUTH_URL: SIGN_IN_BASE_URL,
    NEXT_PUBLIC_APP_URL: SIGN_IN_BASE_URL,
    NODE_ENV: "test",
    REQUESTPORT_E2E_MODE: "1",
    REQUESTPORT_E2E_TOKEN: token,
    ...(runDirectory === undefined
      ? {}
      : { [E2E_RUN_DIRECTORY_VARIABLE]: runDirectory }),
    ...combination.environment,
    [SIGN_IN_COMBINATION_VARIABLE]: combination.name,
  };
}

/**
 * The server, started from `start-e2e-server.mjs` directly. Not through
 * `with-root-env.mjs`: it fills every unset name from `.env.local`, so it
 * would put back the names this runner removed.
 */
export function serverCommand() {
  return {
    args: [resolve(repositoryRoot, "scripts/start-e2e-server.mjs")],
    command: process.execPath,
  };
}

/** The spec, through the web package's own `test:e2e` entry point. */
export function specCommand(combination) {
  return {
    args: [
      "--filter",
      "@requestport/web",
      "run",
      "test:e2e",
      "--project",
      SIGN_IN_PROJECT,
      "--grep",
      signInCombinationTag(combination.name),
    ],
    command: "pnpm",
  };
}

/**
 * Whether anything accepts a connection on the port. Only a refused
 * connection answers "no"; anything else, a timeout included, is not known
 * to be free and is treated as taken.
 */
export function answersOnPort(port = SIGN_IN_PORT, host = SIGN_IN_HOST) {
  return new Promise((settle) => {
    const socket = connect({ host, port });
    const finish = (answers) => {
      socket.destroy();
      settle(answers);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(error.code !== "ECONNREFUSED"));
    socket.setTimeout(2_000, () => finish(true));
  });
}

/**
 * How long a server may take to answer: the start budget
 * `playwright.config.ts` gives its web server (`webServerStartBudgetMs`),
 * because the first start may build, as it may there.
 */
export const SERVER_START_BUDGET_MS = 900_000;

/**
 * How long a stopped server's port and acceptance login may take to go: the
 * login is dropped by a watcher process `start-e2e-server.mjs` leaves behind,
 * after the server has gone.
 */
export const RELEASE_ATTEMPTS = 120;
export const RELEASE_INTERVAL_MS = 500;

/**
 * How long a stopped server's group has to go after `SIGTERM` before the
 * group is sent `SIGKILL`.
 */
export const STOP_GRACE_MS = 10_000;

/** Servers this process started and has not seen exit. */
const liveServers = new Set();

/**
 * Starts a server, `serverCommand()` unless another command is given (the
 * test gives one), in a process group of its own.
 */
export function spawnServer(environment, { args, command } = serverCommand()) {
  // Its own process group, so a stop reaches `next start` and the build
  // under it as well as this child.
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    detached: true,
    env: environment,
    stdio: "inherit",
  });
  const server = { child, exit: undefined };
  liveServers.add(server);
  server.exited = new Promise((settle) => {
    const finish = (exit) => {
      if (server.exit !== undefined) return;
      server.exit = exit;
      liveServers.delete(server);
      settle(exit);
    };
    child.once("error", () => finish("failed to start"));
    child.once("exit", (code, signal) => finish(signal ?? code));
  });
  return server;
}

/**
 * Playwright's own rule for a web server that is up: `statusCode >= 200 &&
 * statusCode < 404` (`isURLAvailable`, `playwright-core@1.62.1`'s
 * `lib/coreBundle.js`).
 */
export function serving(status) {
  return status >= 200 && status < 404;
}

async function waitUntilServing(server) {
  const deadline = Date.now() + SERVER_START_BUDGET_MS;
  while (Date.now() < deadline) {
    if (server.exit !== undefined) {
      return { ready: false, reason: `the server exited (${server.exit})` };
    }
    try {
      const response = await fetch(SIGN_IN_BASE_URL, { redirect: "manual" });
      if (serving(response.status)) return { ready: true };
    } catch {
      // Not listening yet.
    }
    await delay(1_000);
  }
  return {
    ready: false,
    reason: `nothing answered on ${SIGN_IN_BASE_URL} within ${SERVER_START_BUDGET_MS} ms`,
  };
}

function signalGroup(server, signal) {
  try {
    process.kill(-server.child.pid, signal);
  } catch {
    // The group has already gone.
  }
}

/**
 * Stops a server `spawnServer` started, and everything in its process group:
 * `SIGTERM` to the group; then, once the server has exited or the grace
 * period has passed, whichever comes first, `SIGKILL` to whatever of the
 * group is left. Answers once the server itself has exited.
 */
export async function stopServerGroup(
  server,
  { graceMs = STOP_GRACE_MS } = {},
) {
  if (server.child.pid === undefined) return;
  signalGroup(server, "SIGTERM");
  // Unreferenced: a server that has exited leaves no timer holding this
  // process open; one that has not is held open by its own child handle.
  await Promise.race([
    server.exited,
    delay(graceMs, undefined, { ref: false }),
  ]);
  // Whatever of the group is left, the server too if it outlived the grace.
  signalGroup(server, "SIGKILL");
  await server.exited;
}

function spawnSpec(combination, environment) {
  const { args, command } = specCommand(combination);
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  return new Promise((settle) => {
    child.once("error", () => settle(1));
    child.once("close", (code, signal) => settle(code ?? (signal ? 1 : 0)));
  });
}

async function waitForRelease({ loginExists, ownerUrl, portAnswers, sleep }) {
  let reason;
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
    if (await portAnswers(SIGN_IN_PORT)) {
      reason = `port ${SIGN_IN_PORT} still answers`;
    } else if (await loginExists(ownerUrl)) {
      reason = "its acceptance login has not been dropped";
    } else {
      return { released: true };
    }
    await sleep(RELEASE_INTERVAL_MS);
  }
  return { released: false, reason };
}

async function runCombination(combination, environment, deps) {
  const server = deps.startServer(environment);
  try {
    const answer = await deps.waitForServer(server);
    if (!answer.ready) {
      return { outcome: "server did not start", detail: answer.reason };
    }
    const exitCode = await deps.runSpec(combination, environment);
    return exitCode === 0
      ? { outcome: "passed", exitCode }
      : { outcome: "failed", exitCode, detail: `the spec exited ${exitCode}` };
  } finally {
    await deps.stopServer(server);
  }
}

function headRevision() {
  const answered = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return answered.status === 0 ? answered.stdout.trim() : "unknown";
}

function workingTreeIsDirty() {
  const answered = spawnSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return answered.status === 0 ? answered.stdout.trim() !== "" : null;
}

/** The run's record, beside the four Playwright reports. */
export function recordSignInRun(runDirectory, summary) {
  if (!runDirectory) return;
  writeFileSync(
    resolve(runDirectory, "sign-in-combinations.json"),
    `${JSON.stringify(
      { ...summary, head: headRevision(), dirty: workingTreeIsDirty() },
      null,
      2,
    )}\n`,
  );
}

/**
 * Runs every combination in turn and answers with an exit code: `0` only
 * when each combination's spec passed and its server let go of the port and
 * of its acceptance login.
 *
 * In order, for each: a server started with that combination's environment;
 * the spec, once the server answers; the server stopped, whatever happened;
 * and a wait until port 3100 refuses connections and the server's acceptance
 * login is gone, before anything else starts. A spec that fails is reported
 * and the next combination still runs. Two things stop the run instead:
 * - a server that does not let go, because the next server would share its
 *   port, or have its login dropped from under it by the last one's watcher;
 * - a server that does not start, once it is stopped and released. What kept
 *   it from answering can be shared, the build above all: it is one for all
 *   four, and each start that finds no current build builds again, within
 *   its own budget and the same hold of the gate lock.
 * Each combination a stop leaves unrun is reported "not run", naming the
 * server the run stopped after.
 */
export async function runSignInCombinations({
  baseEnvironment = process.env,
  combinations = SIGN_IN_COMBINATIONS,
  createToken = () => randomBytes(32).toString("base64url"),
  log = console.log,
  loginExists = acceptanceLoginExists,
  portAnswers = answersOnPort,
  record = recordSignInRun,
  runDirectory,
  runSpec = spawnSpec,
  sleep = delay,
  startServer = spawnServer,
  stopServer = stopServerGroup,
  waitForServer = waitUntilServing,
} = {}) {
  const ownerUrl = acceptanceLoginOwnerUrl(baseEnvironment);
  const startedAt = new Date().toISOString();
  const results = combinations.map(({ name }) => ({
    name,
    outcome: "not run",
  }));
  let refusal;

  try {
    if (await portAnswers(SIGN_IN_PORT)) {
      refusal = `Refusing to start: something already answers on port ${SIGN_IN_PORT}, the one port these servers use (R3).`;
      return 1;
    }

    for (const [index, combination] of combinations.entries()) {
      const environment = signInCombinationEnvironment(combination, {
        baseEnvironment,
        runDirectory,
        token: createToken(),
      });
      log(
        `Sign-in combination ${combination.name}: starting its server on ${SIGN_IN_BASE_URL}.`,
      );
      Object.assign(
        results[index],
        await runCombination(combination, environment, {
          runSpec,
          startServer,
          stopServer,
          waitForServer,
        }),
      );
      const release = await waitForRelease({
        loginExists,
        ownerUrl,
        portAnswers,
        sleep,
      });
      if (!release.released) {
        refusal = `The ${combination.name} server was stopped, but ${release.reason}; no further server was started.`;
      } else if (results[index].outcome === "server did not start") {
        refusal = `The ${combination.name} server did not start (${results[index].detail}); no further server was started.`;
      }
      if (refusal !== undefined) {
        for (const left of results.slice(index + 1)) {
          left.detail = `the run stopped after the ${combination.name} server`;
        }
        return 1;
      }
    }

    return results.every((result) => result.outcome === "passed") ? 0 : 1;
  } finally {
    log(`Sign-in combinations, one server at a time on ${SIGN_IN_BASE_URL}:`);
    for (const { detail, name, outcome } of results) {
      log(`  ${name}: ${outcome}${detail ? ` (${detail})` : ""}`);
    }
    if (refusal) log(refusal);
    record(runDirectory, {
      baseUrl: SIGN_IN_BASE_URL,
      combinations: results,
      finishedAt: new Date().toISOString(),
      refusal: refusal ?? null,
      startedAt,
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error(
      "run-sign-in-combinations.mjs takes no arguments: it runs all four combinations.",
    );
    process.exitCode = 1;
  } else {
    // Each server has a process group of its own, which a signal to this
    // process does not reach, so an interrupted run takes them down itself.
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        for (const server of liveServers) signalGroup(server, "SIGKILL");
        process.exit(1);
      });
    }
    runSignInCombinations({ runDirectory: createE2ERunDirectory() })
      .then((exitCode) => {
        process.exitCode = exitCode;
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
