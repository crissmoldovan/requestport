import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import * as startE2EServer from "./start-e2e-server.mjs";
import {
  ACCEPTANCE_LOGIN_NAME_QUERY,
  ACCEPTANCE_LOGIN_OWNER_NOT_LOCAL,
  ACCEPTANCE_LOGIN_OWNER_UNNAMED,
  APPLICATION_DATABASE_URL_VARIABLE,
  acceptanceLoginOwnerUrl,
  acceptanceLoginUrl,
  buildIdPath,
  isBuilt,
  newestSourceMs,
  plannedCommands,
  repositoryRoot,
  requiredServerFilesPath,
  sourceFiles,
  sourceRoots,
  unservableBuildReason,
} from "./start-e2e-server.mjs";

/**
 * The recorded configuration of a build for `.next` with no `output`, as a
 * production build of `apps/web` records it, handed to `isBuilt` in place of
 * the checkout's own file, so these cases do not depend on what
 * `apps/web/.next` holds.
 */
const aNextBuild = () =>
  JSON.stringify({ version: 1, config: { distDir: ".next" } });

/**
 * A build that is older than the code is not a build of that code.
 *
 * `isBuilt` asked only whether `.next/BUILD_ID` existed, so a local
 * `pnpm test:e2e` reused whatever was built last — and passed against it. That
 * is what happened on 2026-09-05: the organization switcher gained an entry,
 * the browser lanes were run locally, they passed, and CI then failed the
 * assertion that counts those entries. The lanes had been driving a bundle from
 * before the change, and the local pass meant nothing.
 *
 * CI was never affected. It runs `pnpm build` immediately before
 * `pnpm test:e2e`, so its build is always newer than its checkout — which is
 * why the shortcut existed, and why it could only ever mislead locally.
 */
test("rebuilds when a source file is newer than the build", () => {
  assert.equal(
    isBuilt(() => true, { buildMs: 2_000, sourceMs: 1_000 }, aNextBuild),
    true,
  );
  assert.equal(
    isBuilt(() => true, { buildMs: 1_000, sourceMs: 2_000 }, aNextBuild),
    false,
  );
});

test("treats a build and a source of the same age as current", () => {
  assert.equal(
    isBuilt(() => true, { buildMs: 1_000, sourceMs: 1_000 }, aNextBuild),
    true,
  );
});

test("is not built at all when there is no build", () => {
  assert.equal(
    isBuilt(() => false, { buildMs: 9_000, sourceMs: 0 }, aNextBuild),
    false,
  );
});

/*
 * Plan 13, H.5 (manifest-h.md §2.7.1; Revision 3, check finding 7): the
 * self-host build is a production build with standalone output in its own
 * `distDir`, `apps/web/.next-self-host`. Were a standalone build, or one made
 * for another `distDir`, ever left in `apps/web/.next`, the age check alone
 * would reuse it, and the lanes would be served the wrong artefact. So
 * `isBuilt` reads the configuration the build recorded beside `BUILD_ID`.
 */
const current = { buildMs: 2_000, sourceMs: 1_000 };
const stale = { buildMs: 1_000, sourceMs: 2_000 };
const recorded = (config) => () => JSON.stringify({ version: 1, config });

function judged(times, read) {
  const logged = [];
  const built = isBuilt(
    () => true,
    times,
    read,
    (line) => logged.push(line),
  );
  return { built, logged };
}

test("reads the configuration the build recorded beside BUILD_ID", () => {
  assert.equal(
    requiredServerFilesPath,
    resolve(repositoryRoot, "apps/web/.next/required-server-files.json"),
  );
  assert.equal(dirname(requiredServerFilesPath), dirname(buildIdPath));
});

test("is not built when apps/web/.next holds a standalone build, however new, and says why", () => {
  for (const config of [
    { output: "standalone", distDir: ".next" },
    // The self-host build's own configuration, as its build step checks it.
    { output: "standalone", distDir: ".next-self-host" },
  ]) {
    const { built, logged } = judged(current, recorded(config));

    assert.equal(built, false, JSON.stringify(config));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^Not reusing apps\/web\/\.next: /u);
    assert.match(logged[0], /output: "standalone"/u);
  }
  assert.deepEqual(
    plannedCommands(
      isBuilt(
        () => true,
        current,
        recorded({ output: "standalone", distDir: ".next" }),
        () => undefined,
      ),
    ).map((step) => step.args.slice(0, 2).join(" ")),
    ["run build", "--filter @requestport/web"],
  );
});

test("is not built when apps/web/.next holds a build for another distDir, and names it", () => {
  const { built, logged } = judged(
    current,
    recorded({ distDir: ".next-self-host" }),
  );

  assert.equal(built, false);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /names distDir ".next-self-host", not ".next"/u);
});

test("is not built when the recorded configuration names no distDir", () => {
  for (const read of [recorded(undefined), () => "{}", () => "null"]) {
    const { built, logged } = judged(current, read);

    assert.equal(built, false, read());
    assert.match(logged[0], /names distDir null, not ".next"/u);
  }
});

test("leaves a build for .next with no output to the age check, and says nothing", () => {
  assert.deepEqual(judged(current, aNextBuild), { built: true, logged: [] });
  assert.deepEqual(judged(stale, aNextBuild), { built: false, logged: [] });
  assert.equal(unservableBuildReason(aNextBuild), undefined);
});

test("leaves the answer to the age check, as before, when the file is absent, cannot be read or does not parse", () => {
  const failing = (code) => () => {
    throw Object.assign(new Error(`${code}: ${requiredServerFilesPath}`), {
      code,
    });
  };

  for (const read of [
    failing("ENOENT"),
    failing("EACCES"),
    () => "",
    () => "{ not json",
  ]) {
    assert.deepEqual(judged(current, read), { built: true, logged: [] });
    assert.deepEqual(judged(stale, read), { built: false, logged: [] });
  }
});

test("reads no configuration when there is no build", () => {
  let reads = 0;
  const logged = [];

  assert.equal(
    isBuilt(
      () => false,
      current,
      () => {
        reads += 1;
        return aNextBuild();
      },
      (line) => logged.push(line),
    ),
    false,
  );
  assert.equal(reads, 0);
  assert.deepEqual(logged, []);
});

test("plans a build first whenever the build is stale", () => {
  const planned = plannedCommands(false);

  assert.deepEqual(
    planned.map((step) => step.args.slice(0, 2).join(" ")),
    ["run build", "--filter @requestport/web"],
  );
});

test("plans only the server when the build is current", () => {
  assert.deepEqual(
    plannedCommands(true).map((step) => step.args[0]),
    ["--filter"],
  );
});

/*
 * D20 (Plan 13, Track I.2): the acceptance server connects as a local
 * application-role login, handed to it as the application's own variable.
 */

const loginUrl =
  "postgresql://rp_track_x_e2e_app:login-secret@127.0.0.1:55432/rp_track_x";

test("hands the acceptance login to the server, and to nothing else", () => {
  const [build, start] = plannedCommands(false, loginUrl);

  assert.equal(start.env[APPLICATION_DATABASE_URL_VARIABLE], loginUrl);
  assert.equal(start.env.NODE_ENV, "test");
  assert.deepEqual(build.env, { NODE_ENV: "test" });
});

/*
 * I.2 step 7 (ruling 224 item 3): the acceptance server is an application
 * process, so it carries no owner-capable name, and the scenario hook's owner
 * storage reads the owner's URL under a name of its own, which this module
 * hands the server and nothing else.
 */

const ownerUrl = `postgresql://requestport:${"owner-secret"}@127.0.0.1:55432/rp_track_x`;
const OWNER_CAPABLE = /^(DATABASE_URL(_.*)?|PG[A-Z0-9_]*|POSTGRES_.*)$/u;

test("hands the server the owner's URL as REQUESTPORT_E2E_OWNER_DATABASE_URL beside the acceptance login, and the build neither", () => {
  const [build, start] = plannedCommands(false, loginUrl, ownerUrl);

  assert.equal(start.env.REQUESTPORT_E2E_OWNER_DATABASE_URL, ownerUrl);
  assert.equal(start.env[APPLICATION_DATABASE_URL_VARIABLE], loginUrl);
  assert.deepEqual(build.env, { NODE_ENV: "test" });
});

test("hands the server no owner-capable name, whatever the starter's environment holds, and the build the starter's environment as before", () => {
  const base = {
    DATABASE_URL: ownerUrl,
    DATABASE_URL_UNPOOLED: ownerUrl,
    PGHOST: "127.0.0.1",
    PGPASSWORD: "placeholder",
    POSTGRES_URL: ownerUrl,
    REQUESTPORT_E2E_MODE: "1",
    NODE_ENV: "production",
    PATH: "/usr/bin",
  };
  const [build, start] = plannedCommands(false, loginUrl, ownerUrl);
  const server = startE2EServer.stepEnvironment(start, base);

  assert.deepEqual(
    Object.keys(server).filter((name) => OWNER_CAPABLE.test(name)),
    [],
  );
  assert.equal(server.REQUESTPORT_E2E_OWNER_DATABASE_URL, ownerUrl);
  assert.equal(server[APPLICATION_DATABASE_URL_VARIABLE], loginUrl);
  assert.equal(server.NODE_ENV, "test");
  assert.equal(server.REQUESTPORT_E2E_MODE, "1");
  assert.equal(server.PATH, "/usr/bin");

  const built = startE2EServer.stepEnvironment(build, base);

  assert.equal(built.DATABASE_URL, ownerUrl);
  assert.equal(built.PGHOST, "127.0.0.1");
  assert.equal(built.NODE_ENV, "test");
  // The starter's own environment is left as it was.
  assert.equal(base.DATABASE_URL, ownerUrl);
});

/*
 * What the server is actually spawned with (review of I.2 step 7, finding
 * 13): the cases above call `plannedCommands` and `stepEnvironment` by hand,
 * so `runStep` spawning something else, or `main` not handing the owner's URL
 * to `plannedCommands`, left them green. These run both with a `spawn` that
 * records what it was asked and closes with 0.
 */

function recordingSpawn() {
  const spawned = [];
  const spawnChild = (command, args, options) => {
    const child = new EventEmitter();
    spawned.push({ args, command, options });
    setImmediate(() => child.emit("close", 0, null));
    return child;
  };
  return { spawnChild, spawned };
}

const starterEnvironment = () => ({
  DATABASE_URL: ownerUrl,
  DATABASE_URL_UNPOOLED: ownerUrl,
  PGHOST: "127.0.0.1",
  POSTGRES_URL: ownerUrl,
  REQUESTPORT_E2E_MODE: "1",
  PATH: "/usr/bin",
});

test("runStep spawns the server in the repository root with no owner-capable name, the acceptance login and REQUESTPORT_E2E_OWNER_DATABASE_URL", async () => {
  const { spawnChild, spawned } = recordingSpawn();
  const base = starterEnvironment();
  const [start] = plannedCommands(true, loginUrl, ownerUrl);

  assert.equal(await startE2EServer.runStep(start, { base, spawnChild }), 0);
  assert.equal(spawned.length, 1);
  const [{ args, command, options }] = spawned;

  assert.equal(command, "pnpm");
  assert.deepEqual(args.slice(0, 5), [
    "--filter",
    "@requestport/web",
    "exec",
    "next",
    "start",
  ]);
  assert.equal(options.cwd, repositoryRoot);
  assert.deepEqual(
    Object.keys(options.env).filter((name) => OWNER_CAPABLE.test(name)),
    [],
  );
  assert.equal(options.env.REQUESTPORT_E2E_OWNER_DATABASE_URL, ownerUrl);
  assert.equal(options.env[APPLICATION_DATABASE_URL_VARIABLE], loginUrl);
  assert.equal(options.env.REQUESTPORT_E2E_MODE, "1");
  assert.equal(base.DATABASE_URL, ownerUrl);
});

test("main builds with the starter's environment, then starts the server with the login it created and DATABASE_URL's value as REQUESTPORT_E2E_OWNER_DATABASE_URL, and no owner-capable name", async () => {
  const { spawnChild, spawned } = recordingSpawn();
  const env = starterEnvironment();
  const created = [];
  const watched = [];
  const exitCodeBefore = process.exitCode;

  await startE2EServer.main({
    built: false,
    createLogin: async (owner) => {
      created.push(owner);
      return { role: "rp_track_x_e2e_app", url: loginUrl };
    },
    env,
    log: () => undefined,
    spawnChild,
    startWatcher: (role, watcherEnv) => {
      watched.push({ hasOwner: watcherEnv.DATABASE_URL === ownerUrl, role });
    },
  });

  assert.deepEqual(created, [ownerUrl]);
  // The watcher drops the login as the owner, so it keeps DATABASE_URL.
  assert.deepEqual(watched, [{ hasOwner: true, role: "rp_track_x_e2e_app" }]);
  assert.deepEqual(
    spawned.map(({ args }) => args.slice(0, 2).join(" ")),
    ["run build", "--filter @requestport/web"],
  );

  const [build, server] = spawned.map(({ options }) => options.env);

  assert.equal(build.DATABASE_URL, ownerUrl);
  assert.equal(build.NODE_ENV, "test");
  assert.deepEqual(
    Object.keys(server).filter((name) => OWNER_CAPABLE.test(name)),
    [],
  );
  assert.equal(server.REQUESTPORT_E2E_OWNER_DATABASE_URL, ownerUrl);
  assert.equal(server[APPLICATION_DATABASE_URL_VARIABLE], loginUrl);
  assert.equal(server.NODE_ENV, "test");
  // Both steps closed with 0, so main set no exit code.
  assert.equal(process.exitCode, exitCodeBefore);
});

test("keeps the owner storage's variable the one packages/db reads", () => {
  const source = readFileSync(
    resolve(repositoryRoot, "packages/db/src/e2e-owner-storage.ts"),
    "utf8",
  );

  assert.equal(
    startE2EServer.E2E_OWNER_DATABASE_URL_VARIABLE,
    "REQUESTPORT_E2E_OWNER_DATABASE_URL",
  );
  assert.match(
    source,
    /E2E_OWNER_DATABASE_URL_VARIABLE =\s*"REQUESTPORT_E2E_OWNER_DATABASE_URL"/u,
  );
});

test("keeps the application variable the variable production's application reads", () => {
  const source = readFileSync(
    resolve(repositoryRoot, "packages/db/src/database-url.ts"),
    "utf8",
  );

  assert.match(
    source,
    new RegExp(
      `APPLICATION_DATABASE_URL_VARIABLE =\\s*"${APPLICATION_DATABASE_URL_VARIABLE}"`,
      "u",
    ),
  );
});

test("plans the server exactly as before when no login is given", () => {
  const [start] = plannedCommands(true);

  assert.deepEqual(start.env, { NODE_ENV: "test" });
});

test("names the login from the database, apart from the application-role lane's", () => {
  const lane = readFileSync(
    resolve(repositoryRoot, "packages/db/vitest.application-role.config.ts"),
    "utf8",
  );

  assert.match(
    ACCEPTANCE_LOGIN_NAME_QUERY,
    /left\(current_database\(\), 40\)/u,
  );
  assert.match(ACCEPTANCE_LOGIN_NAME_QUERY, /'_e2e_app'/u);
  assert.match(lane, /'_app_lane'/u);
});

test("puts the login in the owner's URL, keeping where it connects", () => {
  const owner =
    "postgresql://requestport:owner-secret@127.0.0.1:55432/rp_track_x";
  const url = new URL(acceptanceLoginUrl(owner, "rp_track_x_e2e_app", "pw"));

  assert.equal(url.username, "rp_track_x_e2e_app");
  assert.equal(url.password, "pw");
  assert.equal(url.host, "127.0.0.1:55432");
  assert.equal(url.pathname, "/rp_track_x");
});

test("creates the login only through a local owner", () => {
  const owner = (value) => acceptanceLoginOwnerUrl({ DATABASE_URL: value });

  for (const local of [
    "postgresql://requestport:pw@127.0.0.1:55432/rp_track_x",
    "postgresql://requestport:pw@localhost:55432/rp_track_x",
    "postgresql://requestport:pw@[::1]:55432/rp_track_x",
    "postgresql://requestport:pw@host.docker.internal:55432/rp_track_x?sslmode=disable",
  ]) {
    assert.equal(owner(local), local);
  }

  assert.throws(() => acceptanceLoginOwnerUrl({}), {
    message: ACCEPTANCE_LOGIN_OWNER_UNNAMED,
  });
  for (const remote of [
    "postgresql://owner:pw@ep-example.eu-central-1.aws.example.test/appdb",
    "postgresql://owner:pw@127.0.0.1.evil.example/appdb",
    "postgresql://owner:pw@127.0.0.1:55432/rp?host=elsewhere.example",
    "not a url",
  ]) {
    assert.throws(() => owner(remote), {
      message: ACCEPTANCE_LOGIN_OWNER_NOT_LOCAL,
    });
  }
});

/**
 * One file under each watched tree, standing for everything under it.
 *
 * A tree is watched by walking it, so a fixture needs a file inside it to have
 * anything to say. `.well-known` is here because a dot-named directory is the
 * case the walk used to get wrong, and the four discovery routes that live in
 * it are real Next routes that ship in the bundle.
 */
const dotNamedRoute =
  "apps/web/src/app/.well-known/oauth-authorization-server/route.ts";

const sourceRootSamples = {
  "apps/web/src": ["apps/web/src/app/page.tsx", dotNamedRoute],
  packages: ["packages/db/src/schema.ts"],
  trigger: ["trigger/src/index.ts"],
};

/**
 * The build inputs this file builds a checkout out of, taken from the module.
 *
 * Read from the exports rather than restated here, so the fixture cannot drift
 * away from the list it is meant to exercise: a build input added to the
 * module arrives in these tests with it, and one added without a sample under
 * its tree fails the assertion below.
 */
const watchedInputs = [
  ...Object.values(sourceRootSamples).flat(),
  ...sourceFiles,
];

/**
 * The directories a walk must refuse to enter, one decoy file in each.
 *
 * Both sit under `packages`, because that is where the walk can reach them:
 * the roots are `apps/web/src` and `packages`, so the repository-root and
 * `apps/web` copies of `node_modules` are never offered to it in the first
 * place and a decoy there would prove nothing. `packages/db/node_modules` is
 * the copy pnpm makes inside a workspace package, and the walk does reach it.
 */
const unwalkedFiles = [
  "packages/db/node_modules/drizzle-orm/dist/index.js",
  "packages/db/.turbo/turbo-test.log",
];

const checkoutFiles = [...watchedInputs, ...unwalkedFiles];

const checkoutMs = 1_700_000_000_000;
const buildMs = checkoutMs + 1_000;
const touchedMs = checkoutMs + 2_000;
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    if (
      dirname(directory) === resolve(tmpdir()) &&
      directory.startsWith(resolve(tmpdir(), "requestport-e2e-build-inputs-"))
    ) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

function checkout(files = checkoutFiles) {
  const root = mkdtempSync(join(tmpdir(), "requestport-e2e-build-inputs-"));
  fixtures.push(root);

  for (const file of files) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    utimesSync(path, new Date(checkoutMs), new Date(checkoutMs));
  }

  return root;
}

function touch(root, file) {
  utimesSync(join(root, file), new Date(touchedMs), new Date(touchedMs));
}

function builtAgainst(root) {
  return isBuilt(
    () => true,
    { buildMs, sourceMs: newestSourceMs(root) },
    aNextBuild,
  );
}

/**
 * A watched path that is not in the checkout watches nothing.
 *
 * Every miss here is silent by construction: a tree that is not there is
 * skipped by the walk, a file that is not there is skipped by the stat, and
 * either way the answer is "nothing changed" — the answer that lets a stale
 * build through. Next accepts `next.config.ts`, `next.config.mjs` and
 * `next.config.js`, so a rename is an ordinary thing to do, and this is what
 * would notice it.
 */
test("watches nothing this checkout does not have", () => {
  for (const path of [...sourceRoots, ...sourceFiles]) {
    assert.ok(
      existsSync(resolve(repositoryRoot, path)),
      `${path} is watched as a build input but is not in this checkout`,
    );
  }
});

/**
 * The reason the walk enters dot-named directories, kept honest.
 *
 * The skip rule in the module is argued from the routes under `.well-known`.
 * If they move, that argument is what needs rewriting — the rule itself still
 * holds, since a dot-named source directory can appear anywhere.
 */
test("still keeps a real route in a dot-named directory", () => {
  assert.ok(
    existsSync(resolve(repositoryRoot, dotNamedRoute)),
    `the skip rule in start-e2e-server.mjs is argued from ${dotNamedRoute}`,
  );
});

test("has a fixture file under every watched tree", () => {
  assert.deepEqual(
    Object.keys(sourceRootSamples).sort(),
    [...sourceRoots].sort(),
  );

  for (const [root, samples] of Object.entries(sourceRootSamples)) {
    assert.ok(samples.length > 0, `${root} is watched with nothing under it`);
    assert.ok(
      samples.every((sample) => sample.startsWith(`${root}/`)),
      `a fixture file for ${root} is not under ${root}`,
    );
  }
});

/**
 * The watched list itself, pinned.
 *
 * Everything else here derives from `sourceRoots` and `sourceFiles`, which is
 * what stops the fixture drifting away from the module — and it also means
 * deleting an entry deletes the test that covered it, with nothing left to
 * complain. This is the one assertion that does not derive. Narrowing what is
 * watched has to be an edit in two files, and a deliberate one.
 */
test("watches the build inputs it is meant to", () => {
  assert.deepEqual(sourceRoots, ["apps/web/src", "packages", "trigger"]);
  assert.deepEqual(sourceFiles, [
    "apps/web/next.config.ts",
    "apps/web/postcss.config.mjs",
    "apps/web/package.json",
    "apps/web/tsconfig.json",
    "tsconfig.base.json",
    "pnpm-lock.yaml",
  ]);
});

/**
 * Everything a change to which invalidates the bundle the lanes drive.
 *
 * The two source trees were the whole list, and a build is made from more
 * than them. `pnpm update @cueplusplus/ui` — the design system the appearance
 * lanes assert against — leaves `apps/web/src` and `packages` untouched, so a
 * build judged from those two alone would stay "current", and the lanes would
 * drive the bundle from before the upgrade. The lockfile stands in
 * for `node_modules` here: every install that changes a version rewrites it,
 * and one stat is cheaper than walking the tree it describes.
 * `postcss.config.mjs` decides the CSS those same lanes read back, and
 * `tsconfig.base.json` carries settings `apps/web/tsconfig.json` only
 * inherits.
 */
for (const input of watchedInputs) {
  test(`rebuilds when ${input} is newer than the build`, () => {
    const root = checkout();

    assert.equal(builtAgainst(root), true);

    touch(root, input);

    assert.equal(builtAgainst(root), false);
  });
}

/**
 * `node_modules` is the one tree the answer must not come from directly. It is
 * enormous, a walk of it would be paid for on every lane start, and the
 * lockfile already reports every change to it that a build would notice.
 */
test("leaves node_modules unwalked, the lockfile having already spoken for it", () => {
  const root = checkout();

  touch(root, "packages/db/node_modules/drizzle-orm/dist/index.js");

  assert.equal(builtAgainst(root), true);
});

/**
 * `.turbo` is where turbo writes a log per task per package, `test` among
 * them. Counted as a build input, running the unit tests after a build would
 * be enough to condemn that build, and every lane after it would pay for a
 * rebuild of code nobody had touched.
 */
test("leaves the caches build tooling writes unwalked", () => {
  const root = checkout();

  touch(root, "packages/db/.turbo/turbo-test.log");

  assert.equal(builtAgainst(root), true);
});

/**
 * A build input that is absent is absent, not infinitely new. A checkout
 * without a lockfile, or one whose web app has no PostCSS config, must not
 * force a rebuild on every single lane forever.
 */
test("treats a build input that is not there as absent rather than new", () => {
  const sparse = checkout(["apps/web/src/app/page.tsx"]);
  const empty = checkout([]);

  assert.equal(builtAgainst(sparse), true);
  assert.equal(newestSourceMs(empty), 0);
  assert.equal(builtAgainst(empty), true);
});

/**
 * Absence is forgiven one input at a time, not for the whole list.
 *
 * The stat of each single-file input is guarded on its own. Guard the loop
 * instead and the first input a checkout lacks ends it, leaving every input
 * after it unread — and a checkout missing an early input would then never
 * rebuild for a late one, however new. This is the case that tells the two
 * apart: the first input gone, the last one newer than the build.
 */
test("lets an absent input pass without hiding the inputs after it", () => {
  const [absent] = sourceFiles;
  const newer = sourceFiles.at(-1);
  const root = checkout(checkoutFiles.filter((file) => file !== absent));

  assert.equal(builtAgainst(root), true);

  touch(root, newer);

  assert.equal(builtAgainst(root), false);
});

/**
 * An input that cannot be read is not an input that is not there.
 *
 * `ENOENT` is absence, and absence is forgiven: there is nothing at the path
 * to be newer than the build. Every other error is not that answer — the path
 * could not be read, which is not the same as nothing being there — and
 * forgiving those too would read a checkout that is broken as a checkout that
 * has not changed, which serves a stale bundle and says nothing. A symbolic
 * link pointing at itself raises `ELOOP` on the stat, which is the cheapest of
 * those to arrange and needs no privileges to do it. Both halves of the scan
 * are put to it: the tree walk, and the single files listed after it.
 */
test("refuses to read an unreadable input as an unchanged one", () => {
  const [listedInput] = sourceFiles;
  const walked = checkout();
  const listed = checkout(checkoutFiles.filter((file) => file !== listedInput));

  symlinkSync("loop.ts", join(walked, dirname(watchedInputs[0]), "loop.ts"));
  symlinkSync(basename(listedInput), join(listed, listedInput));

  assert.throws(() => newestSourceMs(walked), { code: "ELOOP" });
  assert.throws(() => newestSourceMs(listed), { code: "ELOOP" });
});
