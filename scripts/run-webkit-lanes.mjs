#!/usr/bin/env node

/**
 * Run the WebKit acceptance lanes, on a machine that cannot run WebKit.
 *
 * Playwright installs WebKit 2251 for `mac14-arm64` while its driver speaks
 * mainline 2336, so every page fails at `browserContext.newPage` and the lanes
 * skip themselves wholesale — correctly, because a skipped engine is honest and
 * a broken one is not. Linux gets a current build, so this hands the tree to the
 * matching Playwright image and runs the two WebKit lanes there.
 *
 * With CI deleted this is the only way WebKit is exercised at all. It is
 * deliberately not part of `verify-locally --e2e`: it needs Docker, it builds
 * the application inside the container, and it takes about ten minutes. It is a
 * thing you run before a release, not before a push.
 *
 * The tree arrives as a `git archive` on stdin rather than a mounted volume,
 * because `node_modules` built on macOS holds native binaries for the wrong
 * platform. The container installs for itself, from the public registry — a
 * thousand-odd packages, whose lifecycle scripts then run — which is why it is
 * given an environment built from a list rather than this machine's.
 *
 * `git archive` reads the commit, not the working tree, so this refuses to run
 * with uncommitted changes. A green WebKit run for code the container never saw
 * is the same false evidence a warm turbo cache gives, and harder to notice.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  localDatabaseTarget,
  stackDatabaseName,
  stackPsqlArguments,
} from "./clean-locally.mjs";
import {
  FOUNDATION_E2E_LANES,
  lanesFrom,
  repeatFrom,
} from "./run-foundation-e2e.mjs";
import {
  LOCAL_DATABASE_DRIVER,
  LOCAL_STACK_ABSENT,
  localDatabaseFor,
  localDatabaseListening,
} from "./verify-locally.mjs";
import { loadRootEnv } from "./with-root-env.mjs";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The image, pinned to the Playwright this repository installs.
 *
 * A mismatch here is the whole bug this script exists to route around, in the
 * other direction: an image whose browsers were built for a different driver
 * fails exactly as `mac14-arm64` does.
 */
export const PLAYWRIGHT_IMAGE = "mcr.microsoft.com/playwright:v1.62.1-noble";

/**
 * Every WebKit lane the acceptance suite declares — derived, not listed.
 *
 * Listing them by hand meant a lane added later would run nowhere, and nothing
 * would say so: the runner would keep passing, over a smaller set.
 */
export const WEBKIT_LANES = Object.freeze(
  FOUNDATION_E2E_LANES.filter((lane) => lane.endsWith("-webkit")),
);

/** Where the acceptance server listens; `playwright.config.ts` names the same. */
export const ACCEPTANCE_BASE_URL = "http://127.0.0.1:3100";

/**
 * A connection URL, as reached from inside a container.
 *
 * Parsed rather than pattern-replaced, which is not a stylistic preference: a
 * prefix replacement once rewrote `127.0.0.1.evil.example` — somebody else's
 * machine, containing the right characters in the right order — into
 * `host.docker.internal.evil.example` and ran against it. And the host of a
 * URL is not at the start of the string, so a substitution loose enough to
 * find it there would also match a password that happened to contain the
 * digits. The caller hands this only a URL `localDatabaseTarget` has already
 * judged loopback, with no query parameter that could name another host: this
 * rewrites the authority only, and pg prefers a query's `host` to it.
 */
function urlFromInsideTheContainer(url) {
  const parsed = new URL(url);

  parsed.hostname = "host.docker.internal";

  return parsed.toString();
}

/**
 * The values the lanes need that are not secrets, taken from the host as they
 * are. Everything outside this list and the minted values below is absent from
 * the container — including PATH, HOME and TMPDIR, which name places that exist
 * here and not in the image (`mkdtemp` inside it fails ENOENT on this TMPDIR),
 * and CI, which changes what Playwright forbids.
 */
const CARRIED_FROM_THE_HOST = Object.freeze(["LOG_LEVEL"]);

/**
 * What `packages/config/src/server-schema.ts` requires before the server will
 * start, minted here rather than taken from the checkout.
 *
 * Nothing the lanes drive authenticates against GitHub or Resend: the magic
 * link is read from `/api/test/email-outbox`, which is why the acceptance run
 * works at all without a mail provider. So these names need values, not *those*
 * values — and the real ones stay on this machine, out of a container that
 * installs a thousand packages from the public registry and runs their
 * lifecycle scripts.
 */
function mintedCredentials() {
  return {
    // The schema asks for at least 32 characters. A fixed string would satisfy
    // it and would also be a shared secret in a public repository.
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    BETTER_AUTH_URL: ACCEPTANCE_BASE_URL,
    NEXT_PUBLIC_APP_URL: ACCEPTANCE_BASE_URL,
    GITHUB_CLIENT_ID: "webkit-lanes-not-a-real-client",
    GITHUB_CLIENT_SECRET: randomBytes(24).toString("base64url"),
    RESEND_API_KEY: `re_${randomBytes(16).toString("hex")}`,
    RESEND_FROM_EMAIL: "webkit-lanes@example.invalid",
  };
}

/**
 * The environment the container runs with, built rather than inherited.
 *
 * The earlier version copied the host's environment and deleted two names from
 * it. That put every secret `.env.local` holds — auth signing material, the
 * GitHub client secret, the Resend key, a Vercel OIDC token — and staging's
 * connection string under all nine of the names libpq and the Postgres tooling
 * read by default, into a container that installs a thousand packages from the
 * public registry and runs their lifecycle scripts. None of it was needed.
 *
 * So this builds the environment from a list instead: the local database's
 * address, the driver, `LOG_LEVEL`, and credentials minted here to satisfy
 * the server schema. Anything not named is absent, which makes the safe thing
 * the default for every variable somebody adds to `.env.local` later — the
 * hosted driver's proxy variable included (`localProxyVariable` in
 * `hosted-deployment.mjs`), which a track's `.env.local` generated by an older
 * `create-track-worktree.mjs` still carries.
 *
 * The application runs on pg, as the gate's steps do: the WebSocket proxy the
 * hosted driver needed left the local stack on 2026-09-28. pg dials the
 * connection string's own host, so that string is the one checked against
 * loopback, query included (`localDatabaseTarget`), and then rewritten to
 * `host.docker.internal`, because inside a container `127.0.0.1` is the
 * container.
 */
export function containerEnvironment(env) {
  const container = {
    ...mintedCredentials(),
    REQUESTPORT_DATABASE_DRIVER: LOCAL_DATABASE_DRIVER,
    DATABASE_URL: urlFromInsideTheContainer(localDatabaseTarget(env)),
  };

  for (const name of CARRIED_FROM_THE_HOST) {
    if (typeof env[name] === "string") container[name] = env[name];
  }

  return container;
}

/**
 * The host environment, with the local stack resolved, ready for the container.
 *
 * This exists because the obvious alternative is wrong in a way that looks
 * right. Running this script through `scripts/with-root-env.mjs` — as every
 * other entry point does — puts `refuseUnapprovedProductionDatabase` in front
 * of a `DATABASE_URL` that a checkout pulled from Vercel fills with staging, so
 * the run dies before this file executes, asking the operator to approve
 * staging. The answer to that prompt is never yes; the answer is to name the
 * local database, which is what this does, with the gate's own checks: the
 * database named, on this machine, with the user and password pg needs
 * (`localDatabaseFor`), and something listening where pg will dial it.
 */
export function prepareHostEnvironment(
  env,
  listening = localDatabaseListening,
) {
  const local = localDatabaseFor(env);

  if (!local.ok) throw new Error(local.reason);
  if (!listening(local.url)) throw new Error(LOCAL_STACK_ABSENT);

  return containerEnvironment(env);
}

/**
 * The one statement this runs against the local database.
 *
 * Better Auth encrypts its JWKS private key with `BETTER_AUTH_SECRET` and keeps
 * it in the database. The container's secret is minted per run and the local
 * database outlives the run, so the stored key is unreadable to the next one —
 * "Failed to decrypt private key", and the case that issues an authorization
 * code fails on a `SyntaxError` parsing the empty body that comes back. The
 * server mints a fresh key when it finds none.
 *
 * Deleting signing material deserves the sentence: this is a disposable local
 * database, the keys sign nothing that outlives it, and the alternative is
 * handing a container of third-party install scripts the real secret so it can
 * read a key it has no reason to read. Scoped to one table for the same reason
 * `--database` is a separate flag of `pnpm run clean` — the lanes' rows are
 * evidence.
 */
export const JWKS_RESET_STATEMENT = 'delete from "jwks";';

/**
 * Clear it, through the database container, the way `clean-locally.mjs` does,
 * in the database `databaseUrl` names: the one the container's lanes are
 * handed, which in a track worktree is the track's own. Until Plan 13's X20
 * this named `requestport_local` whatever the URL said.
 *
 * `docker exec` rather than a driver: this script has no database dependency,
 * and adding one to delete a row would mean the runner needs the connection to
 * work before it can fix the reason the connection's consumer fails.
 */
export function clearStaleJwks(databaseUrl, spawn = spawnSync) {
  const psql = spawn(
    "docker",
    stackPsqlArguments(stackDatabaseName(databaseUrl), JWKS_RESET_STATEMENT),
    { encoding: "utf8" },
  );

  return psql.status === 0;
}

/** Where the one mount lands inside the container. */
export const CONTAINER_OUTPUT = "/out";

/**
 * The directories a run is worth keeping, relative to the checkout.
 *
 * The per-lane JSON report, and Playwright's own output — the trace, screenshot
 * and error context a failing case writes. Both died with the container before
 * this: the log named artefacts at paths that existed nowhere, so a WebKit
 * failure could be seen and not investigated. (Nothing assembles a run-evidence
 * document any more; `scripts/write-run-evidence.mjs` was deleted on
 * 2026-09-18. These are read by people.)
 */
export const COLLECTED = Object.freeze([
  {
    container: "apps/web/acceptance-report",
    host: "apps/web/acceptance-report",
  },
  { container: "apps/web/test-results", host: "apps/web/test-results" },
]);

/**
 * The half of the container's work whose exit status must be the lanes'.
 *
 * Separated so a test can run it, which is the only way to know. The previous
 * version was pinned by matching strings in it, and that matching was satisfied
 * by an ordering under which a failing lane exited zero — a test runner
 * reporting a pass for a failed run, which is the one answer it may never give.
 *
 * Two guards, and they cover different halves.
 *
 * `set +e` is what keeps the artefacts of a failing run: with `set -e` restored
 * after the lanes, a failing lane aborted the script before anything was
 * copied, and the run whose trace somebody wanted produced none. The test
 * `a failing lane must still yield its artefacts` pins that.
 *
 * The `|| true` on each command is what keeps the status honest if `set -e`
 * ever comes back. Measured against a read-only mount: with `set -e` restored
 * and `mkdir` unguarded, a **passing** lane exits 1 — the run reported as
 * failed for a directory it could not create. With the guards, the status is
 * the lane's in every combination tried. While `set +e` holds these guards
 * change nothing observable, so no test pins them; that is said here rather
 * than implied to be checked.
 */
export function runAndCollectScript(
  lanes,
  output = CONTAINER_OUTPUT,
  repeatEach,
) {
  return [
    "set +e",
    // The repeat is appended rather than always present: an ordinary run's
    // command is the command it has always been, and a hunt's is visibly a
    // hunt in the container's own output.
    `node scripts/run-foundation-e2e.mjs ${lanes.join(" ")}${
      repeatEach === undefined ? "" : ` --repeat-each=${repeatEach}`
    }`,
    // Taken immediately, before anything else can overwrite `$?`.
    "code=$?",
    ...COLLECTED.flatMap(({ container }) => [
      `mkdir -p ${output}/${container} || true`,
      // `.` so the directory's contents land inside, and guarded because a run
      // that never reached the lanes has nothing to copy — not a second
      // failure, and never this script's answer.
      `cp -R ${container}/. ${output}/${container}/ 2>/dev/null || true`,
    ]),
    // The container is root; the host is not. Without this the collected files
    // are root-owned and the host cannot remove its own temporary directory.
    `chmod -R a+rwX ${output} || true`,
    "exit $code",
  ].join("\n");
}

/** Everything docker is told, as one array, so a test can read it. */
export function dockerArguments({
  envFile,
  image = PLAYWRIGHT_IMAGE,
  lanes,
  outputDirectory,
  repeatEach,
}) {
  const script = [
    "set -e",
    "mkdir -p /app && cd /app",
    "tar -x",
    // The image ships a Node newer than this repository's engines range, and
    // the install refuses on that alone. Nothing here depends on the engine
    // being what the range says; the browsers are the point.
    "export npm_config_engine_strict=false",
    "corepack enable",
    "pnpm install --frozen-lockfile",
    runAndCollectScript(lanes, CONTAINER_OUTPUT, repeatEach),
  ].join("\n");

  return [
    "run",
    "--rm",
    "-i",
    "--env-file",
    envFile,
    // The only mount, and it starts empty. Mounting the checkout is what this
    // script exists to avoid: `node_modules` built on macOS holds native
    // binaries the container cannot run.
    "-v",
    `${outputDirectory}:${CONTAINER_OUTPUT}`,
    // Linux docker does not provide this name; macOS does. Declaring it keeps
    // the same command working on both.
    "--add-host",
    "host.docker.internal:host-gateway",
    image,
    "bash",
    "-c",
    script,
  ];
}

/**
 * Every regular file under a directory, as absolute paths.
 *
 * `lstat`, not `stat`: a symlink in the mount is a file the container chose to
 * point somewhere, and following it made this enumerate host paths and throw
 * `ENOENT` on a dangling one. This decides what is *listed*; `copyFile` below
 * is what refuses to copy anything else.
 */
function filesUnder(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { recursive: true })
    .map((entry) => resolve(directory, String(entry)))
    .filter((path) => {
      try {
        return lstatSync(path).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * Whether a `test-results` entry belongs to this lane.
 *
 * Playwright names a failing case's directory `<case>-<project>` and then
 * appends `-retry<n>` and `-repeat<n>`. Matching only the plain suffix left
 * those behind to be read as the next run's — latent while the container denies
 * `CI` and runs with no retries, and waiting for the one change the gotchas
 * entry says somebody will eventually make.
 *
 * The case title is truncated before the project id is appended, so a long
 * title can never push the lane name off the end and the suffix match is safe.
 */
export function belongsToLane(entry, lane) {
  return (
    entry === lane ||
    entry.endsWith(`-${lane}`) ||
    new RegExp(`-${lane}(-retry\\d+)?(-repeat\\d+)?$`, "u").test(entry)
  );
}

/**
 * Remove what a previous run of these lanes left, and nothing else.
 *
 * Two runs of one lane otherwise leave both failures side by side, and a lane
 * this run did not run keeps its results from the run before — so nothing says
 * which run a file came from. It cannot simply empty the directories: a host
 * `--e2e` run writes chromium results into the same ones, and this must not
 * delete another lane's evidence.
 */
export function clearArtefactsFor(lanes, root = repositoryRoot) {
  const removed = [];

  for (const lane of lanes) {
    const report = resolve(root, "apps/web/acceptance-report", `${lane}.json`);

    if (existsSync(report)) {
      rmSync(report, { force: true });
      removed.push(report);
    }

    const results = resolve(root, "apps/web/test-results");

    if (!existsSync(results)) continue;

    for (const entry of readdirSync(results)) {
      if (!belongsToLane(entry, lane)) continue;

      const path = resolve(results, entry);

      rmSync(path, { force: true, recursive: true });
      removed.push(path);
    }
  }

  return removed;
}

/**
 * Replace these lanes' evidence with what the container just produced.
 *
 * Clearing is part of collecting rather than a separate call before the run, so
 * there is no call to forget: deleting the clearing is deleting the collection.
 *
 * And it clears nothing when the container produced nothing. A run that reached
 * docker and died there — an unpullable image, a denied mount, a status of 125 —
 * otherwise deleted the previous run's reports and traces and put nothing in
 * their place, which is the exact moment somebody is re-running in order to read
 * them again. Only `docker version` failing stops this script before here.
 *
 * Files are copied one at a time, never as a tree: `cpSync` recreated the
 * container's symlinks in the checkout and, on the next run, wrote *through*
 * one that was already there — an overwrite of any file this user can write,
 * demonstrated against a file outside the repository.
 *
 * Into the same directories a local run writes, because that is where the
 * lanes write to and `pnpm clean` removes. The report files are named per lane,
 * so nothing a chromium run wrote is overwritten.
 */
function copyFile(from, into) {
  mkdirSync(dirname(into), { recursive: true });
  rmSync(into, { force: true });
  copyFileSync(from, into);
}

export function collectArtefacts(
  outputDirectory,
  lanes,
  root = repositoryRoot,
) {
  const produced = COLLECTED.map(({ container, host }) => ({
    files: filesUnder(resolve(outputDirectory, container)),
    from: resolve(outputDirectory, container),
    into: resolve(root, host),
  }));

  // Nothing produced means nothing to put in the previous run's place, so the
  // previous run keeps its evidence.
  if (produced.every(({ files }) => files.length === 0)) return [];

  clearArtefactsFor(lanes, root);

  const collected = [];

  for (const { files, from, into } of produced) {
    for (const file of files) {
      const destination = resolve(into, relative(from, file));

      copyFile(file, destination);
      // Recorded from the destination, so this is what landed rather than what
      // was offered: a copy that throws part way through leaves an accurate
      // list of the part that arrived.
      if (existsSync(destination)) collected.push(destination);
    }
  }

  return collected;
}

/**
 * An env file docker will read correctly.
 *
 * `--env-file` does not strip quotes, and every value in `.env.local` is
 * quoted — a build inside the container died on `LOG_LEVEL`'s enum for exactly
 * that reason, which was the lucky version: every secret was wrong in the same
 * way and would have failed less visibly. Writing the parsed values avoids it.
 *
 * It is written beside the mount rather than inside it, so the container cannot
 * read it back through `/out`.
 */
export function writeEnvFile(env, directory) {
  const path = resolve(directory, "webkit-lanes.env");
  const body = Object.entries(env)
    .filter(([, value]) => typeof value === "string" && !value.includes("\n"))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");

  writeFileSync(path, `${body}\n`, { mode: 0o600 });

  return path;
}

export const TREE_IS_DIRTY = [
  "This has uncommitted changes, and the container is given `git archive HEAD` —",
  "the commit, not the working tree. It would report a WebKit pass for code it",
  "never saw.",
  "",
  "Commit first, then run it.",
].join("\n");

/** What `git status` says, as a list of paths, so a caller can name them. */
export function uncommittedPaths(spawn = spawnSync, root = repositoryRoot) {
  const status = spawn("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });

  return (status.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function invokedDirectly(argv1, moduleUrl) {
  return typeof argv1 === "string" && argv1 === fileURLToPath(moduleUrl);
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  // Parsed before anything destructive runs: clearing the local jwks and then
  // refusing a mistyped lane name spends somebody else's next run for nothing.
  let lanes;
  let repeatEach;
  try {
    lanes = lanesFrom(process.argv.slice(2), WEBKIT_LANES);
    repeatEach = repeatFrom(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const docker = spawnSync(
    "docker",
    ["version", "--format", "{{.Server.Os}}"],
    {
      encoding: "utf8",
    },
  );

  if (docker.status !== 0) {
    console.error(
      "Docker is not available, and these lanes exist because this host cannot run WebKit itself.",
    );
    process.exit(1);
  }

  const dirty = uncommittedPaths();

  if (dirty.length > 0) {
    console.error(TREE_IS_DIRTY);
    console.error("");
    for (const path of dirty) console.error(`  ${path}`);
    process.exit(1);
  }

  let env;
  let databaseUrl;
  try {
    const root = loadRootEnv();
    env = prepareHostEnvironment(root);
    databaseUrl = localDatabaseTarget(root);
    // Refused here, before the clear below deletes anything.
    stackDatabaseName(databaseUrl);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!clearStaleJwks(databaseUrl)) {
    console.error(
      "Could not clear the local jwks table, and the container's minted auth secret cannot read a key written under a different one. Is `requestport-local-db` running?",
    );
    process.exit(1);
  }

  const directory = mkdtempSync(resolve(tmpdir(), "requestport-webkit-"));
  const output = resolve(directory, "out");

  mkdirSync(output, { recursive: true });

  /**
   * Removing what this run leaves, by every exit there is.
   *
   * A `finally` alone does not run for a signal, and a ten-minute run is the
   * archetypal thing somebody interrupts. The jwks is cleared *first* and
   * outside the removal's reach: the mount can be root-owned when a container
   * dies before its `chmod`, `rmSync` throws `EACCES` on it, and clearing the
   * key after that line would be skipped — leaving a key this run minted for
   * the *host* lanes to fail on, which is the failure this clears to prevent.
   */
  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;

    clearStaleJwks(databaseUrl);

    try {
      rmSync(directory, { force: true, recursive: true });
    } catch (error) {
      console.error(
        `Could not remove ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  process.on("exit", clear);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      /*
       * The container first, and this is not tidiness. `process.exit` skips the
       * `finally` that would have killed it, so a signal this process handles
       * but the container does not left a ten-minute job running against the
       * local database with nobody waiting on it — and `clear()` then removed
       * the directory it was still writing into, which the orphan recreated
       * afterwards and left in the temporary directory for good.
       */
      if (container !== undefined && container.exitCode === null) {
        container.kill("SIGTERM");
      }
      if (archive !== undefined && archive.exitCode === null) archive.kill();

      clear();
      process.exit(130);
    });
  }

  let archive;
  let container;
  let collected = [];
  let collectionFailed = false;
  try {
    const envFile = writeEnvFile(env, directory);

    archive = spawn("git", ["archive", "HEAD"], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });

    container = spawn(
      "docker",
      dockerArguments({ envFile, lanes, outputDirectory: output, repeatEach }),
      { stdio: ["pipe", "inherit", "inherit"] },
    );

    archive.stdout.pipe(container.stdin);
    // A container that dies early leaves `git archive` writing into a pipe
    // nobody reads, and this process waiting on a child that never ends.
    archive.stdout.on("error", () => {});

    const code = await new Promise((settle) => {
      container.on("close", settle);
      container.on("error", () => settle(1));
    });

    process.exitCode = code ?? 1;

    /*
     * Collection may not change the verdict. A container can put anything in
     * the mount — a dangling symlink, a name that already exists here as a
     * directory — and an exception thrown here would end the process with
     * Node's own status, discarding both the lanes' answer and the summary
     * below.
     */
    try {
      collected = collectArtefacts(output, lanes);
    } catch (error) {
      collectionFailed = true;
      console.error(
        `The lanes answered; collecting their artefacts did not: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    if (archive !== undefined && archive.exitCode === null) archive.kill();
    clear();
  }

  const wrote = COLLECTED.filter(({ host }) =>
    collected.some((path) => path.includes(`/${host}/`)),
  );
  // Why the list is empty matters: a green run writes no `test-results`, a
  // failed collection wrote nothing it could record, and a container that never
  // reached the lanes produced nothing at all. Saying "a green run" for the
  // second is a false explanation printed beside a true exit status.
  const nothing = collectionFailed
    ? "Nothing was collected, because collecting failed above. The previous run's evidence is untouched."
    : "The container left nothing to collect: a green run writes no test-results, and `preserveOutput` keeps failures only.";

  console.log(
    [
      "",
      collected.length > 0
        ? `Collected ${collected.length} file(s) from the container:`
        : nothing,
      ...wrote.map(({ host }) => `  ${host}/`),
      "",
      "The container itself is gone with its build and its node_modules, and",
      "the jwks this run minted is cleared, so the host lanes mint their own.",
      "",
      `The image stays cached: \`docker image rm ${PLAYWRIGHT_IMAGE}\` for the disk.`,
      "The tenants and rows the lanes wrote are still in the local database —",
      "they are what a failure is read from. `pnpm run clean --database` drops them,",
      "and `pnpm clean` removes the artefacts above.",
    ].join("\n"),
  );
}
