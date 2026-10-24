import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { removeOwnerCapableVariables } from "./owner-capable-variables.mjs";

/**
 * The checkout this serves, and the root every watched path is relative to.
 *
 * Derived from this file's own location rather than the working directory, so
 * a lane started from anywhere reads the same tree it will build.
 */
export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The file `next build` leaves behind, and the first thing `isBuilt` asks
 * about.
 *
 * A built application is what the lanes drive, and the presence of this file is
 * how a run tells "already built" from "not built yet" without re-deriving what
 * the build system already knows.
 */
export const buildIdPath = resolve(repositoryRoot, "apps/web/.next/BUILD_ID");

/**
 * The trees this repository's own first-party code lives in, walked whole.
 *
 * All three, not two: `trigger` is a workspace package like any under
 * `packages`, it is named in `pnpm-workspace.yaml`, `apps/web` depends on it
 * as `@requestport/trigger`, and the `pnpm run build` this module shells out
 * to is a `turbo run build` that compiles it. Leaving it out was the same
 * omission as the dot rule below, one directory further up.
 *
 * Whole means more than a bundle contains: the unit tests and fixtures beside
 * the code are counted too. That is deliberate, and it is the cheap mistake to
 * make. Counting a file no bundle reads costs a rebuild nobody needed; missing
 * one a bundle does read costs a lane passing against code it never loaded,
 * which is the thing this module exists to prevent.
 */
export const sourceRoots = ["apps/web/src", "packages", "trigger"];

/**
 * The directories the walk refuses to enter, by name.
 *
 * A name list rather than "skip anything starting with a dot", because a dot
 * rule is wrong here: `apps/web/src/app/.well-known` holds five `route.ts`
 * files that ship in the bundle — the four OAuth and OpenID discovery
 * documents and `security.txt` — and a dot rule skips every one of them. It
 * skipped the four, so editing them left the build looking current. What is
 * named here instead is version-control metadata and
 * tool-written caches. `.turbo` is the one of those that turns up under the
 * roots above: a package collects one as soon as turbo runs a task there, and
 * turbo rewrites a log inside it on every task after that, `test` included, so
 * counting them would let a `pnpm test` on an unchanged tree condemn a build
 * that is still good. `node_modules` is the other tree deliberately left
 * unwalked; the lockfile below stands for it.
 *
 * This is a deny list, not a census of everything a tool might generate. It
 * cannot be one. A directory not named here is walked, and the worst that
 * costs is a rebuild that was not needed; a directory wrongly named here hides
 * a change. So a name earns its place only by never holding source, and
 * anything unrecognised is walked.
 */
const unwalkedDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "node_modules",
]);

/**
 * The build inputs that are single files, none of them inside those trees.
 *
 * The trees alone miss most of what a build is made from. `pnpm update
 * @cueplusplus/ui` — the design system the appearance lanes assert against —
 * touches neither of them, so staleness judged from the trees alone would
 * call the build current, and those lanes would drive the bundle from before
 * the upgrade. `pnpm-lock.yaml` is what stands here for `node_modules`: every
 * install that changes a version rewrites the lockfile, so one stat answers
 * for a tree whose size is measured in hundreds of thousands of files.
 * `apps/web/tsconfig.json` and the `tsconfig.base.json` it extends are both
 * listed, because a setting the deriving file inherits is as much a build
 * input as one it declares.
 */
export const sourceFiles = [
  "apps/web/next.config.ts",
  "apps/web/postcss.config.mjs",
  "apps/web/package.json",
  "apps/web/tsconfig.json",
  "tsconfig.base.json",
  "pnpm-lock.yaml",
];

/**
 * Whether a filesystem error means there is nothing at that path.
 *
 * `ENOENT` is the only error read as absence — a path the checkout does not
 * have, or a symbolic link whose target is gone, neither of which can be newer
 * than a build. `EACCES`, `EIO`, `ELOOP` and the rest are not that answer: the
 * path could not be read, which is not the same as nothing being there.
 * Reading them as absence too would leave a build input uncounted and the
 * build looking current, the one direction this must never fail in, so they
 * are rethrown and the run stops on them.
 */
function isAbsent(error) {
  return error.code === "ENOENT";
}

/**
 * The newest moment any file this build is made from was touched.
 *
 * A deliberate over-approximation rather than an account of what `next build`
 * reads: the first-party source trees entire, plus the configuration and
 * dependency manifests outside them. Where it errs it errs wide, which is the
 * safe direction — a needless rebuild rather than a lane driving a stale
 * bundle. The two places it deliberately errs narrow are `node_modules`, which
 * the lockfile stands in for, and the generated directories named above; both
 * are argued for where they are declared. This is not a proof that nothing
 * else can matter, and it should not be read as one.
 */
export function newestSourceMs(root = repositoryRoot) {
  let newest = 0;

  const walk = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (error) {
      if (!isAbsent(error)) throw error;
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!unwalkedDirectories.has(entry.name)) walk(child);
        continue;
      }
      try {
        newest = Math.max(newest, statSync(child).mtimeMs);
      } catch (error) {
        // A file that vanished between the listing and the stat is not newer
        // than a build; it is not there at all.
        if (!isAbsent(error)) throw error;
      }
    }
  };

  for (const directory of sourceRoots) walk(resolve(root, directory));

  for (const file of sourceFiles) {
    try {
      newest = Math.max(newest, statSync(resolve(root, file)).mtimeMs);
    } catch (error) {
      // A build input a checkout does not have cannot have changed since the
      // build. Reading its absence as "newer than anything" would rebuild on
      // every lane forever. The catch sits inside the loop on purpose: one
      // input a checkout lacks must not stop the inputs after it being read.
      if (!isAbsent(error)) throw error;
    }
  }

  return newest;
}

/**
 * The configuration `next build` records beside its output: `config` is the
 * configuration the build ran with, `output` and `distDir` among it (read in
 * `next@16.3.1`, `dist/build/index.js:1077-1100`). A production build of
 * `apps/web` (H.5's survey, 2026-10-06) recorded `distDir: ".next"` and no
 * `output`.
 */
export const requiredServerFilesPath = resolve(
  repositoryRoot,
  "apps/web/.next/required-server-files.json",
);

function readRequiredServerFiles() {
  return readFileSync(requiredServerFilesPath, "utf8");
}

/**
 * Why the build in `apps/web/.next` is not one the lanes may be served, or
 * `undefined` when its recorded configuration does not say so (Plan 13, H.5;
 * manifest-h.md §2.7.1).
 *
 * The self-host build (`REQUESTPORT_SELF_HOST_BUILD=1`) is a production
 * build with standalone output, written to its own `distDir`,
 * `.next-self-host`, so it does not land here. A standalone build, or one
 * made for another `distDir`, that did land here would still pass the age
 * check below, and the lanes would drive it instead of the `NODE_ENV=test`
 * build `plannedCommands` makes: a run against the wrong artefact. So either
 * is refused, and `plannedCommands` plans the build again.
 *
 * A file that is absent, cannot be read or does not parse leaves the answer
 * to the age check, as before: it does not say the build is standalone. One
 * that parses but names no `distDir` is refused, because it does not say
 * `.next`; a rebuild is the cheap mistake here, as it is in `newestSourceMs`.
 */
export function unservableBuildReason(read = readRequiredServerFiles) {
  let config;
  try {
    config = JSON.parse(read())?.config;
  } catch {
    return undefined;
  }
  if (config?.output === "standalone") {
    return 'Not reusing apps/web/.next: its required-server-files.json says output: "standalone", a build the acceptance lanes are not served (the self-host build belongs in apps/web/.next-self-host).';
  }
  if (config?.distDir !== ".next") {
    return `Not reusing apps/web/.next: its required-server-files.json names distDir ${JSON.stringify(config?.distDir ?? null)}, not ".next".`;
  }
  return undefined;
}

/**
 * Whether the build on disk is a build of the code on disk, and one the
 * lanes may be served.
 *
 * Existence was the whole of this, so a local run reused whatever was built
 * last and reported a pass for code it had never loaded. CI builds immediately
 * before it runs the lanes, so this changes nothing there and everything
 * locally. A build `unservableBuildReason` refuses is not built either, and
 * the reason is logged.
 */
export function isBuilt(
  exists = existsSync,
  times,
  readServerFiles = readRequiredServerFiles,
  log = console.log,
) {
  if (!exists(buildIdPath)) return false;

  const refused = unservableBuildReason(readServerFiles);
  if (refused !== undefined) {
    log(refused);
    return false;
  }

  const { buildMs, sourceMs } = times ?? {
    buildMs: statSync(buildIdPath).mtimeMs,
    sourceMs: newestSourceMs(),
  };

  return buildMs >= sourceMs;
}

/**
 * The commands one lane runs to get a server, in order.
 *
 * `next start` rather than `next dev`, which is the whole point of this module.
 * The development server serves a hot-reload client, and that client reloads
 * the document out from under a case when a hot-update chunk it asks for has
 * already been swept: CI run 33471854976 recorded eight of those, each one a
 * `pageerror` on `/_next/static/webpack/<hash>.hot-update.json` followed one
 * second later by a reload, and one of them landed on the magic link and left
 * the case at `/auth-error?error=INVALID_TOKEN`. A built application has no
 * such client, so none of it can happen.
 *
 * Both halves are `test`, and the build half has to be. `NODE_ENV` reaches this
 * application two different ways and only one of them is a runtime value.
 * `isE2EEmailMode` reads `env.NODE_ENV` off an object it was handed, so it
 * answers to the server's environment; `proxy.ts` writes
 * `process.env.NODE_ENV === "production"` inline, which the bundler folds to a
 * constant while building. Built as `production` that constant is `true`, and
 * the security headers then carry `upgrade-insecure-requests` — which WebKit
 * honours on loopback where Chromium exempts it. CI run 33487078113 is what
 * that costs: 112 console lines reading `Error performing TLS handshake`, no
 * script loaded, and seventeen of eighteen WebKit cases failing on a page whose
 * form never answered, while Chromium passed everything.
 *
 * So a loopback acceptance run cannot be served by a `production` build, and
 * the fences hold under `test` regardless: `isE2EEmailMode` admits
 * `development` and `test` and refuses `production`, so the fake outbox stays
 * unreachable in a production runtime, and `useSecureCookies` is true only for
 * `production`, so a `test` runtime can hold a session over plain loopback.
 * Both are checked against the built server rather than assumed — with the
 * token and a malformed body the outbox answers `400`, without the token it
 * answers `404`, and the built middleware carries `production:!1`.
 *
 * `applicationDatabaseUrl`, when given, is the acceptance login's URL
 * (`createAcceptanceLogin`), and `ownerDatabaseUrl` the owner's, which the
 * scenario hook's owner storage reads as `REQUESTPORT_E2E_OWNER_DATABASE_URL`
 * (`E2E_OWNER_DATABASE_URL_VARIABLE`). Only the server is handed them: the
 * build keeps the environment it always had. The server is an application
 * process, so it is also handed no owner-capable name
 * (`withoutOwnerCapableVariables`, which `stepEnvironment` applies; I.2 step
 * 7, ruling 224 item 3), whatever the starter's own environment holds.
 */
export function plannedCommands(
  built = isBuilt(),
  applicationDatabaseUrl,
  ownerDatabaseUrl,
) {
  const build = {
    args: ["run", "build"],
    command: "pnpm",
    env: { NODE_ENV: "test" },
  };
  const start = {
    args: [
      "--filter",
      "@requestport/web",
      "exec",
      "next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3100",
    ],
    command: "pnpm",
    env: {
      NODE_ENV: "test",
      ...(applicationDatabaseUrl === undefined
        ? {}
        : { [APPLICATION_DATABASE_URL_VARIABLE]: applicationDatabaseUrl }),
      ...(ownerDatabaseUrl === undefined
        ? {}
        : { [E2E_OWNER_DATABASE_URL_VARIABLE]: ownerDatabaseUrl }),
    },
    withoutOwnerCapableVariables: true,
  };

  return built ? [start] : [build, start];
}

/**
 * The environment a planned step runs in: `base` (the starter's own) with
 * the step's `env` over it, and, for a step planned
 * `withoutOwnerCapableVariables` (the server), every owner-capable name
 * removed (`scripts/owner-capable-variables.mjs`: `DATABASE_URL`, any
 * `DATABASE_URL_*`, `PG*` and `POSTGRES_*`). `base` itself is not changed.
 */
export function stepEnvironment(step, base = process.env) {
  const environment = { ...base, ...step.env };

  if (step.withoutOwnerCapableVariables === true) {
    removeOwnerCapableVariables(environment);
  }
  return environment;
}

/**
 * Runs one planned step in the repository root, in the environment
 * `stepEnvironment` builds from `base`, and answers its exit code. `spawnChild`
 * and `base` are this process's `spawn` and environment unless a test hands
 * its own (`start-e2e-server.test.mjs`).
 */
export function runStep(step, { base = process.env, spawnChild = spawn } = {}) {
  const { args, command } = step;

  return new Promise((settle) => {
    const child = spawnChild(command, args, {
      cwd: repositoryRoot,
      env: stepEnvironment(step, base),
      stdio: "inherit",
    });

    child.once("error", () => settle(1));
    child.once("close", (code, signal) => settle(code ?? (signal ? 1 : 0)));
  });
}

/*
 * The acceptance login (Plan 13, Track I.2, D20 option (a); manifest-i2.md
 * §2.9, "The browser lane, before step 5").
 *
 * The server this module starts connects as the application will once the
 * owner has switched it (§3 step 3): as a login that is a member of
 * `requestport_application` (migration 0019) and nothing else — not a
 * superuser, not `BYPASSRLS`, owning nothing — handed to it as
 * `REQUESTPORT_APPLICATION_DATABASE_URL`, the variable production's
 * application reads. So every policy applies to the browser lanes, and a
 * path that reads or writes a tenant table unbound fails there. Setting that
 * variable also turns on the wrapping of pool reads in bound transactions
 * (ruling 17), as it will in production.
 *
 * It follows the application-role lane's pattern
 * (`packages/db/vitest.application-role.config.ts`): created by the owner
 * (`DATABASE_URL`) on the run's own PostgreSQL, named from the database so
 * tracks sharing the server never collide, stored with one SCRAM iteration,
 * with a password made for this run and never written down, and replacing a
 * login a stopped run left. It is dropped when the server stops — by a
 * watcher, because Playwright stops a web server by `SIGKILL` to its process
 * group, which runs no handler here (see `startLoginWatcher`).
 *
 * This process keeps `DATABASE_URL`, the owner, to create and drop the
 * login. The server it starts is handed none of the owner-capable names
 * (I.2 step 7, ruling 224 item 3: since then the role guard's environment
 * check would refuse its web root's storage beside one). Its scenario hook
 * seeds through a second storage over the owner's URL
 * (`apps/web/src/lib/e2e-owner-storage.ts`), built only in E2E mode and
 * refused where `VERCEL_ENV` is set, which reads that URL from
 * `REQUESTPORT_E2E_OWNER_DATABASE_URL`, a name of its own that this module
 * hands the server.
 */

/** The variable production's application reads (`packages/db/src/database-url.ts`). */
export const APPLICATION_DATABASE_URL_VARIABLE =
  "REQUESTPORT_APPLICATION_DATABASE_URL";

/** The variable the scenario hook's owner storage reads (`packages/db/src/e2e-owner-storage.ts`). */
export const E2E_OWNER_DATABASE_URL_VARIABLE =
  "REQUESTPORT_E2E_OWNER_DATABASE_URL";

/** The login's name, from the database's: `<first 40 characters>_e2e_app`. */
export const ACCEPTANCE_LOGIN_NAME_QUERY =
  "select left(current_database(), 40) || '_e2e_app' as role";

/**
 * The hosts the owner's URL may name for this module to create a role there.
 * Loopback, and `host.docker.internal`, which is how `pnpm test:webkit`'s
 * container names this machine's PostgreSQL (`scripts/run-webkit-lanes.mjs`).
 */
export const ACCEPTANCE_LOGIN_HOSTS = Object.freeze([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "host.docker.internal",
]);

export const ACCEPTANCE_LOGIN_OWNER_UNNAMED =
  "The acceptance server needs DATABASE_URL: the local owner that creates " +
  "its application-role login.";

export const ACCEPTANCE_LOGIN_OWNER_NOT_LOCAL =
  "Refusing to create the acceptance server's application-role login on a " +
  "database that is not on this machine: DATABASE_URL must name a loopback " +
  "host (or host.docker.internal from the WebKit container).";

/**
 * The owner's URL, refused unless it names a local PostgreSQL. Never echoes
 * the URL: it carries the owner's password.
 */
export function acceptanceLoginOwnerUrl(env) {
  const value = env.DATABASE_URL;

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(ACCEPTANCE_LOGIN_OWNER_UNNAMED);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(ACCEPTANCE_LOGIN_OWNER_NOT_LOCAL);
  }
  if (!ACCEPTANCE_LOGIN_HOSTS.includes(url.hostname)) {
    throw new Error(ACCEPTANCE_LOGIN_OWNER_NOT_LOCAL);
  }
  // pg takes host, port, user and password from the query over the authority,
  // so a loopback authority says nothing about where a query-carrying string
  // connects (the rule `scripts/clean-locally.mjs` applies to its own string).
  for (const name of url.searchParams.keys()) {
    if (name !== "sslmode" && name !== "application_name") {
      throw new Error(ACCEPTANCE_LOGIN_OWNER_NOT_LOCAL);
    }
  }
  return value;
}

/** The owner's URL with the login's name and password in its place. */
export function acceptanceLoginUrl(ownerUrl, role, password) {
  const url = new URL(ownerUrl);

  url.username = encodeURIComponent(role);
  url.password = encodeURIComponent(password);
  return url.toString();
}

/** `pg`, from the database package that depends on it; the root does not. */
function loadPg() {
  return createRequire(resolve(repositoryRoot, "packages/db/package.json"))(
    "pg",
  );
}

async function withOwner(ownerUrl, work) {
  const { Client } = loadPg();
  const client = new Client({ connectionString: ownerUrl, ssl: false });

  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates the login, replacing one a stopped run left, and answers its name
 * and URL.
 */
export async function createAcceptanceLogin(ownerUrl) {
  const password = randomBytes(24).toString("hex");
  const role = await withOwner(ownerUrl, async (client) => {
    const { rows } = await client.query(ACCEPTANCE_LOGIN_NAME_QUERY);
    const name = rows[0].role;
    const login = client.escapeIdentifier(name);

    await client.query("SET scram_iterations = 1");
    await client.query(`drop role if exists ${login}`);
    await client.query(
      `create role ${login} login password ${client.escapeLiteral(password)} ` +
        "nosuperuser nobypassrls nocreatedb nocreaterole noreplication " +
        "in role requestport_application",
    );
    return name;
  });

  return { role, url: acceptanceLoginUrl(ownerUrl, role, password) };
}

export async function dropAcceptanceLogin(ownerUrl, role) {
  await withOwner(ownerUrl, async (client) => {
    await client.query(`drop role if exists ${client.escapeIdentifier(role)}`);
  });
}

/** Whether a role of the login's name is present, the name read as above. */
export const ACCEPTANCE_LOGIN_PRESENT_QUERY =
  "select exists (select 1 from pg_roles where rolname = " +
  `(${ACCEPTANCE_LOGIN_NAME_QUERY})) as present`;

/**
 * Whether this database's acceptance login is present.
 *
 * `scripts/run-sign-in-combinations.mjs` starts servers one after another on
 * this database, and each creates a login of the same name. A stopped
 * server's watcher drops that name once the server has gone, so the next
 * server starts only after this answers `false`: a drop that came later
 * would take the next server's login.
 *
 * `withClient` connects as the owner; the test passes a fake in its place.
 */
export async function acceptanceLoginExists(
  ownerUrl,
  { withClient = withOwner } = {},
) {
  return await withClient(ownerUrl, async (client) => {
    const { rows } = await client.query(ACCEPTANCE_LOGIN_PRESENT_QUERY);
    return rows[0].present === true;
  });
}

/** The argument that runs this module as the login's watcher. */
export const LOGIN_WATCHER_FLAG = "--drop-acceptance-login-after-parent";

/**
 * Drops the login once this process has gone, however it went.
 *
 * Playwright stops its web server with `SIGKILL` to the server's process
 * group unless a graceful shutdown is configured, and none is: no handler in
 * this process would run. So the drop is a separate process, in a process
 * group of its own (`detached`), which the group kill does not reach. It
 * holds the read end of a pipe whose write end only this process holds; the
 * kernel closes that when this process ends, and the watcher then drops the
 * login and exits. The owner's URL reaches it through its environment, not
 * its arguments, which `ps` shows.
 *
 * Its output is discarded, so a drop that fails says nothing, and nothing
 * records which logins are left; the next run's `createAcceptanceLogin`
 * replaces a login of the same name that is left.
 */
export function startLoginWatcher(role, env = process.env) {
  const watcher = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), LOGIN_WATCHER_FLAG, role],
    { detached: true, env, stdio: ["pipe", "ignore", "ignore"] },
  );

  watcher.unref();
  watcher.stdin.on("error", () => undefined);
  watcher.stdin.unref?.();
  return watcher;
}

async function watchAndDrop(role) {
  process.stdin.resume();
  await new Promise((settle) => {
    process.stdin.once("end", settle);
    process.stdin.once("close", settle);
    process.stdin.once("error", settle);
  });
  await dropAcceptanceLogin(acceptanceLoginOwnerUrl(process.env), role);
}

/**
 * Builds when the build is stale, creates the acceptance login from the
 * owner's URL, starts the login's watcher, then starts the server with the
 * login and the owner's URL (`plannedCommands`), and sets the exit code of
 * the step that failed. What it reaches outside this module is a parameter,
 * the real one unless a test hands its own (`start-e2e-server.test.mjs`): the
 * starter's environment, whether the build is current (`isBuilt` when
 * `built` is not given), the login's creation, its watcher, `spawn` and the
 * log.
 */
export async function main({
  env = process.env,
  built,
  createLogin = createAcceptanceLogin,
  startWatcher = startLoginWatcher,
  spawnChild = spawn,
  log = console.log,
} = {}) {
  const steps = plannedCommands(built);
  const build = steps.length > 1 ? steps[0] : undefined;

  if (build !== undefined) {
    const code = await runStep(build, { base: env, spawnChild });
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }

  const ownerUrl = acceptanceLoginOwnerUrl(env);
  const login = await createLogin(ownerUrl);

  startWatcher(login.role, env);
  log(
    `Acceptance server connects as ${login.role}, a member of requestport_application.`,
  );

  const [start] = plannedCommands(true, login.url, ownerUrl);
  const code = await runStep(start, { base: env, spawnChild });
  if (code !== 0) process.exitCode = code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === LOGIN_WATCHER_FLAG) {
    await watchAndDrop(process.argv[3]);
  } else {
    await main();
  }
}
