import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as sharedDatabasesPublic from "../packages/db/src/shared-databases.public.ts";
import * as sharedDatabases from "../packages/db/src/shared-databases.ts";
import {
  LOCAL_DATABASE_CONTAINER,
  LOCAL_DATABASE_PORT,
} from "./create-track-worktree.mjs";
import * as hostedDeployment from "./hosted-deployment.mjs";
import * as hostedDeploymentPublic from "./hosted-deployment.public.mjs";
import { STEPS } from "./verify-locally.mjs";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(resolve(rootDirectory, relativePath), "utf8"),
  );
}

async function readText(relativePath) {
  return readFile(resolve(rootDirectory, relativePath), "utf8");
}

/**
 * The skip option of a case that reads a path the public seed does not carry
 * (manifest-j.md §2.4 item 6, Appendix A.3; ruling 92): a reason naming
 * `paths` when `scripts/hosted-deployment.mjs` declares the tree public, as
 * the seed's substitution makes it, and `false` otherwise. So in this private
 * tree none of these cases skips, a missing path still fails its case, and
 * `private-paths.test.mjs` fails if a path named here is gone.
 */
function skipInPublicTree(...paths) {
  return hostedDeployment.kind === "public"
    ? `the public tree does not carry ${paths.join(", ")} (scripts/hosted-deployment.mjs declares kind "public")`
    : false;
}

/**
 * Every dot directory under one workspace's source root, named the way that
 * workspace's `tsconfig.json` would have to name it.
 *
 * These are the directories a `**` include pattern silently skips, so each one
 * whose modules the program needs has to be named by a pattern of its own.
 */
async function sourceDotDirectories(workspaceDirectory, sourceRelative) {
  const found = [];
  const walk = async (relative) => {
    const entries = await readdir(
      resolve(rootDirectory, workspaceDirectory, relative),
      { withFileTypes: true },
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const next = `${relative}/${entry.name}`;
      if (entry.name.startsWith(".")) found.push(next);
      else await walk(next);
    }
  };
  await walk(sourceRelative);

  return found.sort();
}

function packageBoundarySection(inventory) {
  const section =
    /^### GitHub Packages: the immutable CUE\+\+ dependency boundary$([\s\S]*?)^## /mu.exec(
      inventory,
    );

  assert.ok(section, "the inventory must carry the package boundary section");

  return section[1];
}

function vitestListEnvironment() {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    VERCEL_ENV: "",
    BETTER_AUTH_SECRET: "requestport-test-secret-32-characters",
    BETTER_AUTH_URL: "http://localhost:3000",
    DATABASE_URL: "postgres://requestport:requestport@localhost/requestport",
    GITHUB_CLIENT_ID: "requestport-test-client",
    GITHUB_CLIENT_SECRET: "requestport-test-secret",
    RESEND_API_KEY: "requestport-test-key",
    RESEND_FROM_EMAIL: "test@example.invalid",
  };
  for (const key of [
    "REQUESTPORT_PREVIEW_DATABASE_URL",
    // A Preview's database project, where the hosted deployment names one.
    ...(hostedDeployment.databaseProjectVariables === null
      ? []
      : [hostedDeployment.databaseProjectVariables.preview]),
    "REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID",
    "REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET",
    "REQUESTPORT_PREVIEW_RESEND_API_KEY",
    "REQUESTPORT_PREVIEW_RESEND_FROM_EMAIL",
    "REQUESTPORT_WORKSPACE_KEK",
    "REQUESTPORT_WORKSPACE_KEK_VERSION",
    "REQUESTPORT_WORKSPACE_KEK_PREVIOUS",
    "REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION",
    "REQUESTPORT_WEBHOOK_KEK",
    "REQUESTPORT_WEBHOOK_KEK_VERSION",
    "REQUESTPORT_WEBHOOK_KEK_PREVIOUS",
    "REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION",
    "REQUESTPORT_WEBHOOK_SIGNING_KEY",
    "REQUESTPORT_SLACK_SIGNING_SECRET",
    "REQUESTPORT_SLACK_CLIENT_ID",
    "REQUESTPORT_SLACK_CLIENT_SECRET",
    "REQUESTPORT_SLACK_STATE_SECRET",
    "RESEND_WEBHOOK_SECRET",
    "TRIGGER_SECRET_KEY",
    "TRIGGER_PROJECT_REF",
  ]) {
    delete env[key];
  }
  return env;
}

/**
 * How long a workspace test listing may take before it is a failure rather than
 * a wait.
 *
 * A cold `vitest list` transforms the whole workspace, and on a machine already
 * running the suites it lists that has taken tens of minutes. The bound is not
 * a performance budget — it is the line past which waiting has stopped being
 * informative, so the run reports what it was doing instead of hanging.
 */
const testListingTimeoutMs = 300_000;

/**
 * How long the bound waits for a killed group to close its pipes before it
 * stops waiting and reports.
 *
 * A `close` normally follows a `SIGKILL` within milliseconds, and while it does
 * the result carries the real exit signal. This is only the ceiling on how long
 * a group that will never close can hold the run.
 */
const killGraceMs = 2_000;

/**
 * Run one test-listing subprocess under an explicit bound.
 *
 * The child is its own process group and the bound kills the *group*: killing
 * `pnpm` alone leaves `vitest` holding the pipes this promise waits to close,
 * so a launcher-only kill turns a timeout into exactly the hang it was meant to
 * end.
 *
 * The kill is a request, though, not a guarantee — it reaches the group and
 * nothing else, so a descendant that has left the group keeps whatever stdio it
 * inherited and `close` never fires. The bound therefore settles the promise
 * itself once the grace has passed, and lets go of the streams it is no longer
 * reading, because a bound that only asks is a bound with a case where it
 * changes nothing.
 *
 * Nothing here throws — the result carries what happened, and the callers turn
 * it into an assertion that names the command.
 */
function runBoundedListing({
  argv,
  command,
  timeoutMs = testListingTimeoutMs,
}) {
  const spelled = `${command} ${argv.join(" ")}`;

  return new Promise((settle) => {
    const started = Date.now();
    const child = spawn(command, argv, {
      cwd: rootDirectory,
      detached: true,
      env: vitestListEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    let abandonment;
    const bound = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      // Whatever survived the kill is holding pipes this run has no further use
      // for. Let go of them, and of the child, so the report happens now and
      // the event loop is not held open by a descendant nobody can reach.
      abandonment = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null, "SIGKILL", null);
      }, killGraceMs);
      abandonment.unref?.();
    }, timeoutMs);

    const finish = (code, signal, spawnError) => {
      if (done) return;
      done = true;
      clearTimeout(bound);
      clearTimeout(abandonment);
      const elapsedMs = Date.now() - started;
      settle({
        code,
        describe: () =>
          [
            `\`${spelled}\` after ${Math.round(elapsedMs / 1000)}s`,
            stderr.trim()
              ? stderr.trim().split("\n").slice(-5).join("\n")
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        elapsedMs,
        signal,
        spawnError,
        stderr,
        stdout,
        timedOut,
      });
    };

    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal, null));
  });
}

/**
 * The listed tests of one workspace, or a failure that says what happened.
 *
 * Every `vitest list` in this file comes through here, so no listing can outlive
 * the bound and no listing can fail on a bare truthiness assertion again.
 *
 * With `json`, the listing is `vitest list --json=<file>` and the result
 * carries `entries`: one `{ name, file }` per collected test, where `file` is
 * the path Vitest collected it from — every test, including any whose file name
 * has no `.test.` in it. The JSON goes to a file in a fresh temporary directory,
 * not to stdout, because pnpm can print its own lines on stdout before the
 * command it runs (a scratch copy of this repository printed `Scope: all …`
 * there once); the directory is removed afterwards. Without `json`, `listed`
 * holds only the text lines naming a `.test.` file, relative to the
 * workspace's Vitest root.
 */
async function listWorkspaceTests(packageName, { json = false } = {}) {
  const jsonDirectory = json
    ? await mkdtemp(join(tmpdir(), "requestport-vitest-list-"))
    : null;
  const jsonFile = jsonDirectory && join(jsonDirectory, "list.json");
  try {
    return await listWorkspaceTestsInto(packageName, jsonFile);
  } finally {
    if (jsonDirectory)
      await rm(jsonDirectory, { force: true, recursive: true });
  }
}

async function listWorkspaceTestsInto(packageName, jsonFile) {
  const run = await runBoundedListing({
    argv: [
      "--filter",
      packageName,
      "exec",
      "vitest",
      "list",
      ...(jsonFile ? [`--json=${jsonFile}`] : []),
    ],
    command: "pnpm",
  });

  assert.ok(
    !run.timedOut,
    `${run.describe()}\nwas killed at its ${testListingTimeoutMs}ms bound instead of listing ${packageName}`,
  );
  assert.equal(
    run.spawnError,
    null,
    `${run.describe()}\ncould not be started: ${run.spawnError?.message}`,
  );
  assert.equal(
    run.code,
    0,
    `${run.describe()}\nexited with ${run.code}${run.signal ? ` on ${run.signal}` : ""}`,
  );

  if (jsonFile) {
    let entries;
    try {
      entries = JSON.parse(await readFile(jsonFile, "utf8"));
    } catch (error) {
      assert.fail(
        `${run.describe()}\ndid not leave a JSON listing in ${jsonFile}: ${error.message}`,
      );
    }
    assert.ok(
      Array.isArray(entries) &&
        entries.every(
          (entry) =>
            typeof entry?.file === "string" && typeof entry?.name === "string",
        ),
      `${run.describe()}\ndid not write an array of { name, file } tests`,
    );
    assert.ok(
      entries.length > 0,
      `${run.describe()}\nnamed no test, so nothing about ${packageName}'s lanes was observed`,
    );

    return { entries, stdout: run.stdout };
  }

  const listed = run.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(".test."));

  assert.ok(
    listed.length > 0,
    `${run.describe()}\nnamed no test file, so nothing about ${packageName}'s lanes was observed`,
  );

  return { listed, stdout: run.stdout };
}

/**
 * Node's `node_modules` lookup order for a module living in `fromDirectory`,
 * reimplemented so peer resolution never depends on a package exposing
 * `./package.json` through its `exports` map.
 */
function nodeModulesPaths(fromDirectory) {
  const paths = [];
  let current = fromDirectory;

  while (true) {
    if (basename(current) !== "node_modules") {
      paths.push(resolve(current, "node_modules"));
    }

    const parent = dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
}

async function resolvePeerManifest(fromDirectory, peer) {
  for (const modulesPath of nodeModulesPaths(fromDirectory)) {
    const candidate = resolve(modulesPath, peer, "package.json");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {}
  }

  return null;
}

function assertRootEnvironmentFiles(rootEntries, trackedEnvironmentFiles) {
  assert.deepEqual(trackedEnvironmentFiles.toSorted(), [".env.example"]);
  const rootEnvironmentFiles = rootEntries
    .filter((entry) => entry.startsWith(".env"))
    .toSorted();
  const permittedRootEnvironmentFiles = [".env.example"];

  if (rootEnvironmentFiles.includes(".env.local")) {
    permittedRootEnvironmentFiles.push(".env.local");
  }

  /**
   * Production credentials live in their own file, and are reached by naming it.
   *
   * `.env.local` fills every unset variable for every command in this
   * repository, so a `.env.local` naming production points the whole workspace
   * at production — which is what happened on 2026-09-07, filling it with test
   * organizations and applying one half of a migration pair. Production is
   * a separate file now, unread by default, and `production-database-guard.mjs`
   * refuses the connection even if one leaks back into `.env.local`.
   *
   * Both remain untracked: the `git ls-files` assertion above is what proves
   * that, and it is deliberately not relaxed here.
   */
  if (rootEnvironmentFiles.includes(".env.prod")) {
    permittedRootEnvironmentFiles.push(".env.prod");
  }

  assert.deepEqual(
    rootEnvironmentFiles,
    permittedRootEnvironmentFiles.toSorted(),
  );
}

test("keeps the foundation workspace command contracts exact", {
  skip: skipInPublicTree("apps/cli/package.json"),
}, async () => {
  const [rootPackage, turbo, webPackage, ...internalPackages] =
    await Promise.all([
      readJson("package.json"),
      readJson("turbo.json"),
      readJson("apps/web/package.json"),
      ...[
        "apps/cli/package.json",
        "packages/auth/package.json",
        "packages/config/package.json",
        "packages/db/package.json",
        "packages/domain/package.json",
      ].map(readJson),
    ]);

  assert.equal(
    rootPackage.scripts.test,
    "node scripts/with-root-env.mjs node --test scripts/*.test.mjs packages/db/scripts/*.test.mjs && node scripts/with-root-env.mjs turbo run test",
  );
  assert.equal(
    rootPackage.scripts["test:e2e"],
    "node scripts/with-root-env.mjs node scripts/run-foundation-e2e.mjs",
  );
  assert.doesNotMatch(rootPackage.scripts["test:e2e"], /\benv\s+-u\b/u);
  /*
   * The WebKit runner is the one entry point that must NOT go through
   * `with-root-env.mjs`: that wrapper runs the production guard over an
   * environment whose DATABASE_URL, in a checkout pulled from Vercel, names
   * staging — so the run dies before the script can resolve the local stack,
   * asking the operator to approve staging instead. It resolves the stack
   * itself. Pinned here because the natural "fix" is to wrap it like the rest.
   */
  assert.equal(
    rootPackage.scripts["test:webkit"],
    "node scripts/run-webkit-lanes.mjs",
  );
  /*
   * `scripts/` belongs to no workspace, so `turbo run lint` never reaches it —
   * the gate did not cover the directory the gate lives in. The gate runs this
   * package script rather than spelling the command again, so the two cannot
   * drift apart and the script is not dead weight beside the step.
   */
  assert.equal(rootPackage.scripts["lint:scripts"], "biome check scripts");
  assert.deepEqual(STEPS.find((step) => step.id === "lint-scripts")?.argv, [
    "pnpm",
    "run",
    "lint:scripts",
  ]);
  assert.deepEqual(turbo.tasks.test.outputs, ["coverage/**"]);
  assert.equal(webPackage.scripts.dev, "next dev --webpack");
  assert.equal(webPackage.scripts.build, "next build --webpack");
  assert.equal(webPackage.scripts["test:e2e"], "playwright test");

  for (const internalPackage of internalPackages) {
    assert.equal(internalPackage.scripts.test, "vitest run");
  }
});

/**
 * Every browser engine `apps/web/playwright.config.ts` builds a project for.
 *
 * Read out of the loaded configuration rather than out of its text: the
 * projects are what Playwright will actually try to launch, so an engine that
 * reaches the matrix by any route — a literal list, a computed one, a project
 * added by hand — reaches this answer too. The config refuses to load outside
 * the guarded entry, so it is handed exactly the environment `test:e2e` hands
 * it.
 */
async function declaredPlaywrightEngines() {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `const { default: config } = await import("./playwright.config.ts");
       process.stdout.write(JSON.stringify((config.projects ?? []).map((project) => project.use?.browserName ?? null)));`,
    ],
    {
      cwd: resolve(rootDirectory, "apps/web"),
      env: {
        ...process.env,
        NODE_ENV: "test",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN:
          "contract-test-token-that-is-at-least-thirty-two-chars",
      },
    },
  );

  const named = JSON.parse(stdout);

  assert.ok(named.length > 0, "the acceptance matrix must declare an engine");
  assert.deepEqual(
    named.filter((engine) => typeof engine !== "string" || engine === ""),
    [],
    "every Playwright project must name the engine it runs on",
  );

  return [...new Set(named)].toSorted();
}
test("discovers the Preview migration journal executable and source test", async () => {
  const [
    rootPackage,
    dbPackage,
    dbScriptEntries,
    executableIgnored,
    testIgnored,
  ] = await Promise.all([
    readJson("package.json"),
    readJson("packages/db/package.json"),
    readdir(resolve(rootDirectory, "packages/db/scripts")),
    execFileAsync(
      "git",
      [
        "check-ignore",
        "--quiet",
        "--",
        "packages/db/scripts/read-preview-migration-journal.mjs",
      ],
      { cwd: rootDirectory },
    ).then(
      () => true,
      () => false,
    ),
    execFileAsync(
      "git",
      [
        "check-ignore",
        "--quiet",
        "--",
        "packages/db/scripts/read-preview-migration-journal.test.mjs",
      ],
      { cwd: rootDirectory },
    ).then(
      () => true,
      () => false,
    ),
  ]);

  assert.equal(
    rootPackage.scripts.test,
    "node scripts/with-root-env.mjs node --test scripts/*.test.mjs packages/db/scripts/*.test.mjs && node scripts/with-root-env.mjs turbo run test",
  );
  assert.equal(dbPackage.scripts.lint, "biome check src scripts");
  assert.ok(dbScriptEntries.includes("read-preview-migration-journal.mjs"));
  assert.ok(
    dbScriptEntries.includes("read-preview-migration-journal.test.mjs"),
  );
  assert.equal(executableIgnored, false);
  assert.equal(testIgnored, false);
});

test("passes the database driver choice through Turbo and documents it", async () => {
  // Turbo's strict environment mode hands a task only the variables named in
  // globalEnv, so a driver chosen in the shell would silently not reach the
  // suites it was chosen for (Plan 13, Track E.2).
  const [turbo, envExample] = await Promise.all([
    readJson("turbo.json"),
    readText(".env.example"),
  ]);

  assert.ok(turbo.globalEnv.includes("REQUESTPORT_DATABASE_DRIVER"));
  assert.match(envExample, /^REQUESTPORT_DATABASE_DRIVER=$/mu);
});

test("the PGlite lane has its own variable, declared and documented, and a script the gate does not run", async () => {
  // Plan 13, Track E.2 step 3. The lane selects PGlite through the same rule
  // (REQUESTPORT_DATABASE_DRIVER=pglite) and names its database in a variable
  // of its own. It is not part of the gate: verify-locally refuses any driver
  // but pg, and no Turbo task runs the script.
  const [turbo, envExample, dbPackage, gate] = await Promise.all([
    readJson("turbo.json"),
    readText(".env.example"),
    readJson("packages/db/package.json"),
    readText("scripts/verify-locally.mjs"),
  ]);

  assert.ok(turbo.globalEnv.includes("REQUESTPORT_PGLITE_DATA_DIR"));
  assert.match(envExample, /^REQUESTPORT_PGLITE_DATA_DIR=$/mu);
  assert.match(
    dbPackage.scripts["test:pglite"] ?? "",
    /^REQUESTPORT_DATABASE_DRIVER=pglite vitest run\b/u,
  );
  assert.equal(turbo.tasks["test:pglite"], undefined);
  assert.doesNotMatch(gate, /test:pglite/u);
});

/**
 * Import packages/db/vitest.config.ts in a clean child and print what `probe`
 * returns, given `lane` (its exports). Outside the lane, as here, importing
 * it migrates nothing.
 */
async function probeDbTestConfig(probe, env = {}) {
  const config = resolve(rootDirectory, "packages/db/vitest.config.ts");
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const lane = await import(${JSON.stringify(config)}); console.log(JSON.stringify(await (${probe})(lane)));`,
    ],
    {
      cwd: resolve(rootDirectory, "packages/db"),
      // Every variable the config reads is set, so `.env.local` fills none.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL: "postgres://u:p@db.invalid:5432/rp_unrelated",
        REQUESTPORT_PRODUCTION_DATABASE: "",
        REQUESTPORT_STAGING_DATABASE: "",
        REQUESTPORT_DATABASE_DRIVER: "",
        REQUESTPORT_PGLITE_DATA_DIR: "",
        ...env,
      },
    },
  );

  return JSON.parse(stdout.trim().split("\n").at(-1));
}

test("the PGlite lane excludes its multi-session cases by name, and fails loudly when one is gone", async () => {
  // PGlite has one connection, and 18 of the runtime integration cases hold
  // two or three sessions at once (plan §3 R1 counted 15, before Track C's
  // advisory-lock suite and X15's invitation renewal race; `result.count`
  // below binds the 18); the lane names
  // each one, and a name that no longer matches a collected case, or a named
  // case that ran, is a failure of the run rather than a silent change of
  // scope.
  const result = await probeDbTestConfig(`async (lane) => {
    const { existsSync } = await import("node:fs");
    const excluded = lane.PGLITE_LANE_EXCLUDED;
    const full = (entry) => entry.names.join(" > ");
    const collected = excluded.map((entry) => ({
      file: entry.file,
      fullName: full(entry),
      state: "skipped",
    }));
    const pattern = lane.pgliteLaneNamePattern();
    const spaced = (entry) => entry.names.join(" ");
    return {
      count: excluded.length,
      files: [...new Set(excluded.map((entry) => entry.file))].sort(),
      inTheLane: excluded.every((entry) => lane.PGLITE_LANE_FILES.includes(entry.file)),
      laneFilesExist: lane.PGLITE_LANE_FILES.every((file) => existsSync(file)),
      clean: lane.pgliteLaneExclusionProblems(collected),
      gone: lane.pgliteLaneExclusionProblems(collected.slice(1)),
      ran: lane.pgliteLaneExclusionProblems([
        { ...collected[0], state: "passed" },
        ...collected.slice(1),
      ]),
      // A run filtered to other files never collects these cases, and is
      // not failed for it; a collected file's missing case still is.
      otherFilesOnly: lane.pgliteLaneExclusionProblems(
        [{ file: "src/testing.test.ts", fullName: "x", state: "passed" }],
      ),
      collectedButEmpty: lane.pgliteLaneExclusionProblems([], excluded, [
        excluded[0].file,
      ]),
      inCollectedFile: excluded.filter((entry) => entry.file === excluded[0].file)
        .length,
      firstName: full(excluded[0]),
      skipsEach: excluded.every(
        (entry) =>
          !pattern.test(spaced(entry)) &&
          !pattern.test(entry.file + " " + spaced(entry)),
      ),
      keepsTheRest: [
        "live foundation repository creates an organization",
        spaced(excluded[0]) + " again",
        "x " + spaced(excluded[0]).slice(2),
      ].every((name) => pattern.test(name)),
    };
  }`);

  assert.equal(result.count, 18);
  assert.deepEqual(result.files, [
    "src/advisory-lock.integration.test.ts",
    "src/repositories/appearance-repository.integration.test.ts",
    "src/repositories/foundation-repository.integration.test.ts",
    "src/signup-eligibility-guard.integration.test.ts",
  ]);
  assert.equal(result.inTheLane, true);
  assert.equal(result.laneFilesExist, true);
  assert.deepEqual(result.clean, []);
  assert.equal(result.gone.length, 1);
  assert.ok(result.gone[0].includes(result.firstName), result.gone[0]);
  assert.match(result.gone[0], /no longer/u);
  assert.equal(result.ran.length, 1);
  assert.match(result.ran[0], /ran/u);
  assert.equal(result.skipsEach, true);
  assert.equal(result.keepsTheRest, true);
  assert.deepEqual(result.otherFilesOnly, []);
  assert.equal(result.collectedButEmpty.length, result.inCollectedFile);
  assert.ok(result.inCollectedFile > 0);
});

test("every integration suite in packages/db is in the PGlite lane or named as left out of it", async () => {
  // A suite added to packages/db is not in the lane until someone lists it,
  // and nothing else would notice: the lane runs the files it names. So each
  // one is either in PGLITE_LANE_FILES or in PGLITE_LANE_LEFT_OUT with a
  // reason, never neither and never both (review of Track E.2, after Track C
  // added three suites the lane did not know about).
  const source = resolve(rootDirectory, "packages/db/src");
  const suites = (await readdir(source, { recursive: true }))
    .filter((file) => file.endsWith(".integration.test.ts"))
    .map((file) => `src/${file.split("\\").join("/")}`)
    .sort();
  const lane = await probeDbTestConfig(`async (lane) => ({
    files: lane.PGLITE_LANE_FILES,
    leftOut: lane.PGLITE_LANE_LEFT_OUT ?? null,
  })`);

  assert.ok(Array.isArray(lane.leftOut), "PGLITE_LANE_LEFT_OUT is exported");
  const leftOut = lane.leftOut.map((entry) => entry.file);
  const neither = suites.filter(
    (file) => !lane.files.includes(file) && !leftOut.includes(file),
  );
  const both = leftOut.filter((file) => lane.files.includes(file));
  const gone = leftOut.filter((file) => !suites.includes(file));
  const unexplained = lane.leftOut.filter(
    (entry) => typeof entry.why !== "string" || entry.why.trim() === "",
  );

  assert.deepEqual(neither, [], "in neither the lane nor its left-out list");
  assert.deepEqual(both, [], "both in the lane and left out of it");
  assert.deepEqual(gone, [], "left out, but no such suite");
  assert.deepEqual(unexplained, [], "left out without a reason");
});

test("the PGlite lane's reporter fails the run on a stale exclusion, and the lane's configuration registers it", async () => {
  // The check is only worth having if it can fail a run. The plugin adds the
  // reporter to whatever reporters the run has; the reporter sets a failing
  // exit code when a named case in a collected file is gone.
  const result = await probeDbTestConfig(`async (lane) => {
    const stale = [{ file: "src/testing.test.ts", names: ["no such case"] }];
    const config = { reporters: [] };
    lane.pgliteLanePlugin(stale).configureVitest({ vitest: { config } });
    const modules = (tests) => [
      {
        relativeModuleId: "src/testing.test.ts",
        children: {
          allTests: () =>
            tests.map((fullName) => ({
              fullName,
              result: () => ({ state: "passed" }),
            })),
        },
      },
    ];
    const exitCodeAfter = (tests) => {
      process.exitCode = undefined;
      config.reporters[0].onTestRunEnd(modules(tests));
      const code = process.exitCode;
      process.exitCode = undefined;
      return code ?? 0;
    };
    return {
      registered: config.reporters.length,
      stale: exitCodeAfter(["something else"]),
      ranInstead: exitCodeAfter(["no such case"]),
      outsideTheLane: lane.default.plugins.length,
    };
  }`);

  assert.equal(result.registered, 1);
  assert.equal(result.stale, 1);
  // The named case was collected, but it passed: the other failure.
  assert.equal(result.ranInstead, 1);
  assert.equal(result.outsideTheLane, 0);
});

test("a real PGlite lane run fails when a case it excludes runs, and judges only the files it collected", async () => {
  // End to end, through the lane's own configuration: `-t` replaces the
  // lane's name pattern, so the one multi-session case it names runs, is
  // refused its second session, and the check reports it. The exclusions
  // that name another file live in files this run did not collect, and are
  // not judged.
  const dbDirectory = resolve(rootDirectory, "packages/db");
  const child = spawn(
    resolve(rootDirectory, "node_modules/.bin/vitest"),
    [
      "run",
      "src/repositories/appearance-repository.integration.test.ts",
      "-t",
      "blocks a second owner until the first update commits",
      "--reporter=dot",
      "--coverage.enabled=false",
    ],
    {
      cwd: dbDirectory,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Where the lane makes, and removes, its temporary database.
        TMPDIR: tmpdir(),
        DATABASE_URL: "postgres://u:p@db.invalid:5432/rp_unrelated",
        REQUESTPORT_PRODUCTION_DATABASE: "",
        REQUESTPORT_STAGING_DATABASE: "",
        REQUESTPORT_DATABASE_DRIVER: "pglite",
        REQUESTPORT_PGLITE_DATA_DIR: "",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";

  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolvePromise) =>
    child.on("close", resolvePromise),
  );

  assert.notEqual(code, 0, output);
  assert.match(
    output,
    /blocks a second owner until the first update commits: excluded by name, but it ran \(failed\)/u,
  );
  assert.doesNotMatch(output, /no longer collected/u);
  assert.match(output, /4 of the 18 multi-session cases/u);
});

test("the PGlite lane refuses memory://, which would give every file an empty database", async () => {
  const config = resolve(rootDirectory, "packages/db/vitest.config.ts");
  const child = spawn(process.execPath, [config], {
    cwd: resolve(rootDirectory, "packages/db"),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL: "postgres://u:p@db.invalid:5432/rp_unrelated",
      REQUESTPORT_PRODUCTION_DATABASE: "",
      REQUESTPORT_STAGING_DATABASE: "",
      REQUESTPORT_DATABASE_DRIVER: "pglite",
      REQUESTPORT_PGLITE_DATA_DIR: "memory://",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolvePromise) =>
    child.on("close", resolvePromise),
  );

  assert.notEqual(code, 0);
  assert.match(stderr, /REQUESTPORT_PGLITE_DATA_DIR/u);
  assert.match(stderr, /memory:\/\//u);
});

test("the local stack is a tool-neutral compose.yaml declaring PostgreSQL and nothing in front of it, under the project, container, port and volume it had", async () => {
  // Plan 13, Track E.2: local development and the gate reach 55432 on pg, so
  // the hosted driver's WebSocket proxy left the stack (its container was removed on
  // 2026-09-30, plan R7). Ruling 175 (owner question 2d) made the stack a
  // compose.yaml, the file `docker compose` reads by default, in place of
  // supbuddy.addons.yml. The scripts reach the database by the container's
  // name and port, and every checkout's `docker compose` reaches the same
  // stack by the project's name, so those, and the volume holding the data,
  // stay what they were.
  const stack = await readText("compose.yaml");
  const services = stack
    .slice(stack.indexOf("\nservices:\n"), stack.indexOf("\nvolumes:\n"))
    .split("\n")
    .flatMap((line) => /^ {2}([a-z][a-z0-9_-]*):\s*$/u.exec(line)?.[1] ?? []);

  assert.deepEqual(services, ["db"]);
  assert.match(stack, /^name: requestport-local$/mu);
  assert.match(
    stack,
    new RegExp(`^ {4}container_name: ${LOCAL_DATABASE_CONTAINER}$`, "mu"),
  );
  assert.match(
    stack,
    new RegExp(`"127\\.0\\.0\\.1:${LOCAL_DATABASE_PORT}:5432"`, "u"),
  );
  assert.match(
    stack,
    /^ {6}- requestport-local-pgdata:\/var\/lib\/postgresql\/data$/mu,
  );
  assert.doesNotMatch(stack, /wsproxy|55433|APPEND_PORT/u);
  assert.doesNotMatch(stack, /supbuddy/iu);
  await assert.rejects(readText("supbuddy.addons.yml"), { code: "ENOENT" });
});

test("the worker's tests run the driver the deployed worker runs, whatever the gate chose", async () => {
  // The gate sets REQUESTPORT_DATABASE_DRIVER=pg for every workspace, and a
  // developer's `.env.local` may too. The deployed Trigger.dev worker sets
  // none (read 2026-09-27: absent in prod, staging, preview and dev), so it
  // runs the driver packages/db selects when the variable is unset (the
  // hosted driver, in the private tree), and its tests import every worker
  // module to prove that works. Its setup file puts the variable back to what
  // the worker has: absent.
  const setup = resolve(rootDirectory, "trigger/src/test-setup.ts");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(setup)}); console.log(JSON.stringify({ driver: process.env.REQUESTPORT_DATABASE_DRIVER ?? null }));`,
    ],
    {
      cwd: rootDirectory,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        REQUESTPORT_DATABASE_DRIVER: "pg",
      },
    },
  );

  assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)), {
    driver: null,
  });
});

test("the pg path names the shared databases exactly as the entry-point guard does", () => {
  // packages/db cannot import a script from this repository, so the pg path's
  // refusal (contract §3.4) reads its own module, shared-databases.ts, beside
  // the guard's scripts/hosted-deployment.mjs (ruling 91, option (d)). A list
  // that drifted would refuse nothing, silently, and a kind that drifted would
  // let packages/db's tests and the scripts' disagree about which tree they
  // are in. release/public-tree.json substitutes both public variants
  // together, so this holds in the public seed too.
  assert.equal(sharedDatabases.kind, hostedDeployment.kind);
  assert.deepEqual(sharedDatabases.entries, hostedDeployment.sharedDatabases);
});

test("each public variant declares a public tree: kind public, no shared database, no migration state, no hosted driver and no database project", () => {
  assert.equal(hostedDeploymentPublic.kind, "public");
  assert.deepEqual(hostedDeploymentPublic.sharedDatabases, []);
  assert.equal(hostedDeploymentPublic.migrationState, null);
  assert.deepEqual(hostedDeploymentPublic.hostedDriverPackages, []);
  assert.equal(hostedDeploymentPublic.localProxyVariable, null);
  assert.equal(hostedDeploymentPublic.databaseProjectVariables, null);
  assert.deepEqual(hostedDeploymentPublic.providerVariablePrefixes, []);
  assert.throws(
    () =>
      hostedDeploymentPublic.createHostedPool({
        connectionString: "postgres://u:p@127.0.0.1:55432/appdb",
      }),
    /no hosted database driver/u,
  );
  assert.equal(sharedDatabasesPublic.kind, "public");
  assert.deepEqual(sharedDatabasesPublic.entries, []);
});

/**
 * A constant's value as `packages/db/src/hosted-driver.ts` or its public
 * variant writes it: a string, `undefined` (read as `null`), or a frozen
 * array of strings. Read from the text, because the module reaches its
 * siblings by `.js` specifiers that Node does not map to their TypeScript
 * sources, so no script can import it.
 */
async function hostedDriverConstant(path, name) {
  const text = await readText(path);
  const match = new RegExp(
    `^export const ${name}: [^=]+=\\s*([^;]+);$`,
    "mu",
  ).exec(text);
  assert.ok(match, `${path} declares ${name}`);
  const value = match[1].trim();
  if (value === "undefined") return null;
  const frozen = /^Object\.freeze\(\[([^\]]*)\]\)$/u.exec(value);
  return JSON.parse(frozen ? `[${frozen[1].replace(/,\s*$/u, "")}]` : value);
}

test("the scripts name the hosted driver's packages and proxy variable exactly as its module does, in both trees", async () => {
  // packages/db/src/hosted-driver.ts is the driver's own module, and
  // scripts/hosted-deployment.mjs repeats the two facts about it the scripts
  // need (J.2b; ruling 175, owner question 3). A package list that drifted
  // would leave the packed manifests' checks judging another driver, and a
  // variable that drifted would leave the gate emptying a name the driver no
  // longer reads. release/public-tree.json substitutes both modules' public
  // variants together, so the public pair is compared too.
  for (const [driver, deployment] of [
    ["packages/db/src/hosted-driver.ts", hostedDeployment],
    ["packages/db/src/hosted-driver.public.ts", hostedDeploymentPublic],
  ]) {
    assert.deepEqual(
      await hostedDriverConstant(driver, "HOSTED_DRIVER_PACKAGES"),
      [...deployment.hostedDriverPackages],
      driver,
    );
    assert.equal(
      await hostedDriverConstant(driver, "LOCAL_PROXY_VARIABLE"),
      deployment.localProxyVariable,
      driver,
    );
  }
});

test("packages/db's own test config refuses a shared database before any suite runs", async (t) => {
  // A bare `pnpm --filter @requestport/db test` goes through vitest.config.ts,
  // not scripts/with-root-env.mjs, so the entry-point guard has to run there:
  // several suites build pg storages from DATABASE_URL directly, and pg dials
  // the URL's host whatever the hosted driver's proxy variable says.
  //
  // The config runs from a temporary copy, beside the guard, with-root-env.mjs
  // and a scripts/hosted-deployment.mjs naming one synthetic database in place
  // of the private module (ruling 91, option (d)), so this file names no
  // shared database's host. Its directory is resolved through any symbolic
  // link, and its node_modules and packages/db/node_modules link to this
  // checkout's, where the config's own imports resolve.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "requestport-db-config-guard-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    "packages/db/vitest.config.ts",
    "scripts/production-database-guard.mjs",
    "scripts/with-root-env.mjs",
    "scripts/owner-capable-variables.mjs",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(resolve(rootDirectory, path), join(root, path));
  }
  for (const modules of ["node_modules", "packages/db/node_modules"]) {
    await symlink(resolve(rootDirectory, modules), join(root, modules), "dir");
  }
  const syntheticHost = "db-production-pooler.region-1.example.test";
  await writeFile(
    join(root, "scripts/hosted-deployment.mjs"),
    [
      'export const kind = "private";',
      `export const sharedDatabases = [${JSON.stringify({
        name: "production",
        hostSha256: createHash("sha256")
          .update("db-production.region-1.example.test")
          .digest("hex"),
        databaseNameSha256: null,
        optIn: "REQUESTPORT_PRODUCTION_DATABASE",
      })}];`,
      "export const migrationState = null;",
      "",
    ].join("\n"),
  );
  const production = `postgres://u:p@${syntheticHost}/appdb`;
  const unrelated =
    "postgres://u:p@db-unrelated-pooler.region-1.example.test/appdb";
  const loadConfig = (overrides) =>
    new Promise((resolvePromise) => {
      const child = spawn(
        process.execPath,
        [join(root, "packages/db/vitest.config.ts")],
        {
          cwd: join(root, "packages/db"),
          // Every variable the guard reads is set, so `.env.local` fills none.
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            REQUESTPORT_PRODUCTION_DATABASE: "",
            REQUESTPORT_STAGING_DATABASE: "",
            ...overrides,
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolvePromise({ code, stderr }));
    });

  const refused = await loadConfig({ DATABASE_URL: production });
  assert.notEqual(refused.code, 0, "production is refused");
  assert.match(refused.stderr, /would run against the production database/u);
  assert.doesNotMatch(refused.stderr, /db-production/u);

  const approved = await loadConfig({
    DATABASE_URL: production,
    REQUESTPORT_PRODUCTION_DATABASE: "approved",
  });
  assert.equal(approved.code, 0, approved.stderr);

  const other = await loadConfig({ DATABASE_URL: unrelated });
  assert.equal(other.code, 0, other.stderr);
});

test("keeps Preview provider isolation in the workspace environment contract", async () => {
  const [turbo, envExample, rootEntries, trackedEnvironmentFiles] =
    await Promise.all([
      readJson("turbo.json"),
      readText(".env.example"),
      readdir(rootDirectory),
      execFileAsync("git", ["ls-files", "--", ".env*"], {
        cwd: rootDirectory,
      }).then(({ stdout }) => stdout.trim().split("\n").filter(Boolean)),
    ]);
  const previewKeys = [
    "REQUESTPORT_PREVIEW_DATABASE_URL",
    "REQUESTPORT_PREVIEW_GITHUB_CLIENT_ID",
    "REQUESTPORT_PREVIEW_GITHUB_CLIENT_SECRET",
    "REQUESTPORT_PREVIEW_RESEND_API_KEY",
    "REQUESTPORT_PREVIEW_RESEND_FROM_EMAIL",
  ];
  // A Preview's database project, where the hosted deployment names one
  // (hosted-deployment.mjs): turbo hands it to every task. The template does
  // not document it, because the seed carries the template and the variable
  // is the hosted deployment's.
  const previewProject =
    hostedDeployment.databaseProjectVariables?.preview ?? null;
  if (previewProject !== null) {
    assert.ok(turbo.globalEnv.includes(previewProject));
  }

  assert.ok(turbo.globalEnv.includes("VERCEL_ENV"));
  for (const key of previewKeys) {
    assert.ok(turbo.globalEnv.includes(key));
    assert.match(envExample, new RegExp(`^${key}=`, "mu"));
  }
  assert.match(
    envExample,
    /Preview deployments use only REQUESTPORT_PREVIEW_.*provider values/u,
  );
  assertRootEnvironmentFiles(rootEntries, trackedEnvironmentFiles);
});

test("permits a clean checkout with only the tracked root environment example", () => {
  assertRootEnvironmentFiles(
    ["package.json", ".env.example"],
    [".env.example"],
  );
});

test("sorts the optional ignored root environment file before verifying it", () => {
  assertRootEnvironmentFiles([".env.local", ".env.example"], [".env.example"]);
});

test("rejects additional root environment files", () => {
  assert.throws(() =>
    assertRootEnvironmentFiles(
      [".env.example", ".env.staging"],
      [".env.example"],
    ),
  );
});

test("keeps the NodeNext source alias narrow and on the Webpack fallback", async () => {
  const nextConfig = await readText("apps/web/next.config.ts");

  assert.match(
    nextConfig,
    /extensionAlias:\s*\{\s*"\.js": \["\.ts", "\.tsx", "\.js"\]/u,
  );
  assert.doesNotMatch(nextConfig, /turbopack\s*:/u);
  assert.doesNotMatch(nextConfig, /allowImportingTsExtensions/u);
});

test("allows callers to provide an explicit immutable migration name", async () => {
  const [authPackage, dbPackage] = await Promise.all([
    readJson("packages/auth/package.json"),
    readJson("packages/db/package.json"),
  ]);

  assert.equal(
    dbPackage.scripts["db:generate"],
    "NODE_ENV=development node ../../scripts/with-root-env.mjs drizzle-kit generate --config drizzle.config.ts",
  );
  assert.doesNotMatch(dbPackage.scripts["db:generate"], /foundation/u);
  assert.equal(
    dbPackage.scripts["db:migrate"],
    "NODE_ENV=development node ../../scripts/with-root-env.mjs drizzle-kit migrate --config drizzle.config.ts",
  );
  assert.equal(
    authPackage.scripts["auth:schema"],
    "NODE_ENV=development node ../../scripts/with-root-env.mjs better-auth generate --config src/auth-schema.config.ts --adapter drizzle --dialect pg --output ../../.superpowers/sdd/better-auth-schema.generated.ts --yes",
  );
});

test("declares the Better Auth route-handler dependency at the web boundary", async () => {
  const [webPackage, authPackage] = await Promise.all([
    readJson("apps/web/package.json"),
    readJson("packages/auth/package.json"),
  ]);

  assert.equal(webPackage.dependencies["better-auth"], "1.7.6");
  // Resend dynamically imports this optional peer when a React payload is sent.
  assert.equal(authPackage.dependencies["@react-email/render"], "2.1.0");
  assert.equal(authPackage.devDependencies["@react-email/render"], undefined);
});

test("lists only source Better Auth tests", async () => {
  const config = await readText("packages/auth/vitest.config.ts");
  assert.match(config, /include:\s*\["src\/\*\*\/\*\.test\.\{ts,tsx\}"\]/u);

  // No count is written down. This subtest used to assert one (117 tests in
  // 18 files at its last edit), so every change that added an auth test had to
  // edit it too — two tracks adding auth tests in parallel would each have
  // conflicted on the same line, and the number was wrong again the next time
  // anyone added a test. The count only ever stood in for the property below.
  // Why each test file exists is said in the file and its commit, not here.
  //
  // What is asserted instead. `vitest list --json` names the file of every
  // test it collects, including a test in a file whose name has no `.test.`
  // (an in-source test collected through `includeSource`). Each of those files
  // is resolved with `realpath`, and the set of real paths must equal the set
  // of real paths of the regular `*.test.ts` / `*.test.tsx` files found by
  // walking `packages/auth/src` at run time. The walk does not follow a
  // symbolic link and does not count one as a test file. So this fails when:
  //   - a test file under `src/` is no longer collected;
  //   - Vitest collects any other file: an in-source test file (through
  //     `includeSource`) under `src/` or anywhere else, a file under `dist`,
  //     `node_modules` or `coverage`, or the target of a symbolic link placed
  //     in `src/` that points outside it;
  //   - Vitest reads another tree because `test.root` points at a copy whose
  //     root-relative names match `src/` exactly, since real paths are
  //     compared, not names relative to whatever root Vitest used.
  // Before that comparison, each listed real path must sit under the
  // package's `src/` with no `dist`, `node_modules` or `coverage` segment
  // below the package, so a file from outside `src/` fails with a message
  // naming it relative to the package.
  //
  // Not caught, each measured on a scratch copy:
  //   - a symbolic link in `src/` pointing at another test file in `src/`:
  //     Vitest collects that file a second time under the link's name, and
  //     both resolve to a real path already in the set;
  //   - a test registered by code outside `src/` that a collected file runs —
  //     a module a `src/` test imports, or a `setupFiles` entry. Vitest
  //     attributes such a test to the collected file, so the listing names
  //     only `src/` files;
  //   - a config that collects one set under `vitest list` and another under
  //     `vitest run` (by branching on its arguments). This reads the listing.
  // It guards the property the old count stood in for against drift, not
  // against a configuration written to get past it.
  const packageDirectory = await realpath(
    resolve(rootDirectory, "packages/auth"),
  );
  const sourceTestFiles = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const next = join(directory, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile() && /\.test\.tsx?$/u.test(entry.name)) {
        sourceTestFiles.push(await realpath(next));
      }
    }
  };
  await walk(join(packageDirectory, "src"));

  assert.ok(
    sourceTestFiles.length > 0,
    "packages/auth/src holds no test file, so the comparison would be vacuous",
  );

  const { entries } = await listWorkspaceTests("@requestport/auth", {
    json: true,
  });
  const listedFiles = new Set();
  for (const entry of entries) {
    assert.ok(
      isAbsolute(entry.file),
      `Vitest named a test file by a relative path: ${entry.file}`,
    );
    listedFiles.add(await realpath(entry.file));
  }
  const relativeToPackage = [...listedFiles].map((file) =>
    relative(packageDirectory, file),
  );

  const outsideSource = relativeToPackage.filter(
    (file) =>
      !file.startsWith("src/") ||
      /(^|\/)(dist|node_modules|coverage)\//u.test(file),
  );
  assert.deepEqual(outsideSource, [], "Vitest listed tests from outside src/");
  assert.deepEqual([...listedFiles].sort(), sourceTestFiles.sort());
  assert.ok(relativeToPackage.every((file) => file.startsWith("src/")));
  for (const file of relativeToPackage) {
    assert.doesNotMatch(file, /(^|\/)dist\//u);
  }
});

test("lists only source Vitest tests for the foundation workspaces", {
  skip: skipInPublicTree("apps/cli/vitest.config.ts"),
}, async () => {
  for (const workspace of [
    ["@requestport/domain", "packages/domain/vitest.config.ts"],
    ["@requestport/db", "packages/db/vitest.config.ts"],
    ["@requestport/cli", "apps/cli/vitest.config.ts"],
  ]) {
    const [packageName, configPath] = workspace;
    const config = await readText(configPath);
    assert.match(config, /include:\s*\["src\/\*\*\/\*\.test\.\{ts,tsx\}"\]/u);
    const { listed: listedTests, stdout } =
      await listWorkspaceTests(packageName);
    assert.ok(listedTests.every((line) => line.startsWith("src/")));
    assert.doesNotMatch(stdout, /\/dist\//u);
  }
});

test("runs the database workspace one suite at a time against its one database", async () => {
  const config = await readText("packages/db/vitest.config.ts");

  // Every @requestport/db suite shares a single PostgreSQL database, and the
  // 0014 cutover replay holds SHARE ROW EXCLUSIVE on organizations,
  // organization_members and "user" for the life of a long transaction — from
  // its explicit LOCK TABLE and from three ALTER TABLE ... ADD FOREIGN KEY.
  // With Vitest's default file parallelism that produced real
  // `deadlock detected` failures in unrelated suites
  // (request-query-repository, signup-eligibility-guard,
  // foundation-repository) on roughly three runs in five. Serialising this one
  // workspace is what makes the shared target safe; nothing else may be live
  // while a migration replay holds tenant-table locks.
  assert.match(config, /fileParallelism:\s*false/u);
  assert.match(config, /singleThread:\s*true/u);
});

test("splits the web workspace into node and DOM lanes over one source tree", async () => {
  const config = await readText("apps/web/vitest.config.ts");

  assert.match(config, /name:\s*"node"/u);
  assert.match(config, /name:\s*"dom"/u);
  assert.match(config, /environment:\s*"node"/u);
  assert.match(config, /environment:\s*"jsdom"/u);
  // Lanes are routed by declared intent — the `.dom.test.` infix — never by
  // file extension. A `.tsx` suite that asserts server markup is a node test.
  assert.match(config, /include:\s*\["src\/\*\*\/\*\.test\.\{ts,tsx\}"\]/u);
  assert.match(
    config,
    /exclude:\s*\["src\/\*\*\/\*\.dom\.test\.\{ts,tsx\}"\]/u,
  );
  assert.match(
    config,
    /include:\s*\["src\/\*\*\/\*\.dom\.test\.\{ts,tsx\}"\]/u,
  );
  assert.match(config, /setupFiles:\s*\["\.\/src\/test\/setup-dom\.ts"\]/u);

  const { listed: listedTests, stdout } =
    await listWorkspaceTests("@requestport/web");
  const laneByFile = new Map();
  for (const line of listedTests) {
    const listed = /^\[(node|dom)\] (src\/\S+)/u.exec(line);
    assert.ok(listed, `test must belong to a named lane over src/: ${line}`);
    laneByFile.set(listed[2], listed[1]);
  }

  // These SSR suites predate the DOM lane. They render through
  // `renderToStaticMarkup` and must keep running without DOM globals, so a
  // component that reaches for `window`/`document` at module or render scope
  // fails `pnpm test` instead of surfacing as a server-render 500 in Preview.
  for (const serverRenderedSuite of [
    "src/app/auth-pages.test.tsx",
    "src/components/administration-views.test.tsx",
    "src/components/app-shell.test.tsx",
    "src/components/page-layout.test.tsx",
    "src/components/primary-navigation.test.tsx",
  ]) {
    assert.equal(
      laneByFile.get(serverRenderedSuite),
      "node",
      `${serverRenderedSuite} must remain a node test`,
    );
  }

  assert.equal(
    laneByFile.get("src/test/cue-interaction-contract.dom.test.tsx"),
    "dom",
  );
  assert.doesNotMatch(stdout, /\/dist\//u);
});

test("provides deterministic DOM-lane environment stubs and cleanup", async () => {
  const setup = await readText("apps/web/src/test/setup-dom.ts");

  assert.match(setup, /matchMedia/u);
  assert.match(setup, /ResizeObserver/u);
  assert.match(setup, /hasPointerCapture/u);
  assert.match(setup, /setPointerCapture/u);
  assert.match(setup, /releasePointerCapture/u);
  assert.match(setup, /scrollIntoView/u);
  assert.match(setup, /getAnimations/u);
  assert.match(setup, /data-cue-portal/u);
  assert.match(setup, /cleanup\(\)/u);
  assert.match(setup, /@testing-library\/jest-dom\/vitest/u);
});

test("pins the immutable CUE++ dependency boundary in the web workspace", async () => {
  const webPackage = await readJson("apps/web/package.json");

  // From public npm since 2026-09-16. They were vendored while GitHub Packages
  // refused every download, and the registry that replaced it is what restores
  // an attestation nobody here can forge. The theme is not among them — this
  // product owns its palette, in packages/theme.
  //
  // `0.14.1` carries `cue-ui#152`, which makes `ThemeProvider` render Base UI's
  // `CSPProvider` itself when it is given a nonce. This application therefore
  // renders **no** `CSPProvider` of its own: cue-ui's contract is the prop
  // **or** your own provider, never both, because `CSPProvider` carries
  // `disableStyleElements` beside `nonce` and the package exports no hook, so a
  // provider rendered inside another *replaces* it rather than extending it.
  // The one we used to render was deleted in the same change that raised this
  // pin. If a future upgrade ever removes that behaviour, the provider has to
  // come back — `appearance-root.tsx` is where it lived.
  assert.equal(webPackage.dependencies["@cueplusplus/ui"], "0.14.1");
  assert.equal(webPackage.dependencies["@cueplusplus/tokens"], "0.14.1");
  assert.equal(webPackage.dependencies["@requestport/theme"], "workspace:*");
  assert.equal(
    webPackage.dependencies["@cueplusplus/theme-requestport"],
    undefined,
  );
  assert.equal(webPackage.dependencies["@base-ui/react"], "1.7.0");
  assert.equal(webPackage.dependencies["lucide-react"], "1.33.0");
  assert.equal(webPackage.dependencies["react-resizable-panels"], "4.12.3");
  assert.equal(webPackage.devDependencies.jsdom, "30.0.1");
  assert.equal(webPackage.devDependencies["@testing-library/react"], "16.3.2");
  assert.equal(
    webPackage.devDependencies["@testing-library/user-event"],
    "14.6.5",
  );
  assert.equal(
    webPackage.devDependencies["@testing-library/jest-dom"],
    "7.0.1",
  );

  const declared = {
    ...webPackage.dependencies,
    ...webPackage.devDependencies,
  };

  for (const [name, range] of Object.entries(declared)) {
    if (range.startsWith("workspace:")) continue;

    assert.match(
      range,
      /^\d+\.\d+\.\d+$/u,
      `${name} must be pinned to an exact version`,
    );
  }

  // TanStack Table arrives only with an implemented `useCueTable` use-case.
  assert.equal(declared["@tanstack/react-table"], undefined);
});

test("discovers the route inventory and the unconditional native audit", async () => {
  const checkedIn = [
    "apps/web/src/test/route-state-inventory.ts",
    "apps/web/src/test/route-state-inventory.test.ts",
    "apps/web/src/test/native-cue-audit.ts",
    "apps/web/src/test/native-cue-audit.test.ts",
    "apps/web/src/test/ui-style-allowlist.ts",
    "apps/web/test-fixtures/native-cue-audit/tsconfig.json",
    "apps/web/test-fixtures/native-cue-audit/good-native-surface.tsx",
    "apps/web/test-fixtures/native-cue-audit/good-local-barrel.ts",
    "apps/web/test-fixtures/native-cue-audit/good-stylesheet.css",
    "apps/web/test-fixtures/native-cue-audit/good-partial.css",
    "apps/web/test-fixtures/native-cue-audit/bad-legacy-surface.tsx",
    "apps/web/test-fixtures/native-cue-audit/bad-stylesheet.css",
  ];

  for (const relativePath of checkedIn) {
    await readFile(resolve(rootDirectory, relativePath), "utf8");
    const ignored = await execFileAsync(
      "git",
      ["check-ignore", "--quiet", "--", relativePath],
      { cwd: rootDirectory },
    ).then(
      () => true,
      () => false,
    );

    assert.equal(ignored, false, `${relativePath} must be committable`);
  }

  const [webPackage, webTsconfig, vitestConfig] = await Promise.all([
    readJson("apps/web/package.json"),
    readJson("apps/web/tsconfig.json"),
    readText("apps/web/vitest.config.ts"),
  ]);

  // The bad fixtures deliberately carry legacy imports, retired recipe
  // classes, raw controls and a raw stylesheet. They live outside `src`
  // because everything that reads `src` — the typechecker, Biome, the
  // document-wide inline-style contract, and the production scan itself —
  // would otherwise treat the falsifying inputs as application code.
  assert.deepEqual(webTsconfig.include, [
    "src/**/*.ts",
    "src/**/*.tsx",
    "src/app/.well-known/**/*.ts",
    ".next/types/**/*.ts",
  ]);

  // A TypeScript wildcard include never descends into a dot directory, so every
  // such directory under `src` has to be named on its own. Without that the
  // route handlers under `src/app/.well-known` reach the program only through
  // the generated `.next/types` shims — and `.next` is gitignored, so on a
  // fresh checkout `tsc` skips them and the production scan aborts as
  // not-fully-typed rather than reporting what it found.
  const dotDirectories = await sourceDotDirectories("apps/web", "src");

  assert.ok(
    dotDirectories.length > 0,
    "apps/web/src must still hold the .well-known routes this guard is about",
  );
  for (const relative of dotDirectories) {
    assert.ok(
      webTsconfig.include.some((pattern) => pattern.startsWith(`${relative}/`)),
      `apps/web/tsconfig.json must name ${relative}: a wildcard include cannot reach a dot directory`,
    );
  }
  assert.equal(
    webPackage.scripts.lint,
    "biome check src tests playwright.config.ts",
  );
  assert.match(
    vitestConfig,
    /include:\s*\["src\/\*\*\/\*\.test\.\{ts,tsx\}"\]/u,
  );

  // Task 11 retired the environment gate along with the partitioned baseline it
  // selected: the scan runs in the ordinary `pnpm test` lane now, at 0, so
  // the only way past it is to have no violation. A surviving flag reference
  // would be a way back to an opt-in scan nobody runs.
  assert.equal(webPackage.scripts.test, "vitest run");
  assert.doesNotMatch(
    JSON.stringify(webPackage.scripts),
    /REQUESTPORT_CUE_AUDIT_PRODUCTION/u,
  );

  const auditSources = await Promise.all([
    readText("apps/web/src/test/native-cue-audit.ts"),
    readText("apps/web/src/test/native-cue-audit.test.ts"),
  ]);

  for (const source of auditSources) {
    assert.doesNotMatch(source, /REQUESTPORT_CUE_AUDIT_PRODUCTION/u);
  }
  assert.match(
    auditSources[1],
    /describe\("unconditional production scan"/u,
    "the audit suite must run its production scan unconditionally",
  );

  for (const retired of [
    "apps/web/src/test/native-cue-production-baseline.json",
    "packages/ui/package.json",
    "packages/ui/src/index.ts",
  ]) {
    await assert.rejects(
      readFile(resolve(rootDirectory, retired), "utf8"),
      /ENOENT/u,
      `${retired} must not come back`,
    );
  }
});

/**
 * Four tests in this file learn the lane split by running `vitest list` in a
 * workspace, and every one of them used to shell out with no bound at all.
 *
 * Standalone that listing takes minutes; run straight after the full web suite
 * on a loaded machine the driver watched one take 1,581s and then return no
 * lines, so the run failed on a bare `assert.ok(listedTests.length > 0)` that
 * named neither the command nor why it had nothing to read. On a constrained
 * runner that is a flake with no diagnosis, and nothing in the file stopped it
 * waiting forever.
 *
 * So the bound is part of the contract: one helper, declared by name, that
 * kills the whole process group rather than only the launcher — a `pnpm` killed
 * on its own leaves `vitest` holding the pipes the promise is waiting to close,
 * which is the hang the bound exists to remove.
 */
test("kills a workspace test listing that outlives its bound", {
  timeout: 30_000,
}, async () => {
  const started = Date.now();
  // A launcher that hands its stdio to a grandchild and then waits: killing
  // the launcher alone leaves the pipe open, so this only settles if the
  // whole group goes.
  const run = await runBoundedListing({
    argv: ["-c", 'node -e "setTimeout(() => {}, 600000)" & wait'],
    command: "sh",
    timeoutMs: 1_000,
  });

  assert.equal(run.timedOut, true, "an overrunning listing must be killed");
  assert.ok(
    Date.now() - started < 20_000,
    "a killed listing must settle promptly rather than wait on an orphan",
  );
  assert.match(run.describe(), /sh -c/u, "the failure must name the command");
});

/**
 * The bound has to settle the promise, not merely ask the group to die.
 *
 * `SIGKILL` to the process group reaches the group, and nothing else. A
 * descendant that left the group before the signal arrived — anything that
 * calls `setsid`, and every `detached` spawn — keeps whatever stdio it
 * inherited, so the parent's read ends never see EOF and `close` never fires.
 * A bound whose only act is `process.kill` therefore has a case where it
 * changes nothing at all: the promise stays pending and the run hangs exactly
 * as it did before the bound existed.
 *
 * So the bound settles on its own after a short grace, and the test that says
 * so builds precisely that case — a grandchild in its own process group,
 * holding the pipes, outliving the kill. Its own `timeout` is what makes a
 * regression fail with a name instead of hanging the run.
 */
test("settles a listing whose descendant outlives the group kill", {
  timeout: 20_000,
}, async () => {
  const started = Date.now();
  const survivor = [
    "require('node:child_process')",
    ".spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'],",
    " { detached: true, stdio: 'inherit' }).unref();",
    "setTimeout(() => {}, 30000);",
  ].join("");
  const run = await runBoundedListing({
    argv: ["-e", survivor],
    command: process.execPath,
    timeoutMs: 1_000,
  });

  assert.equal(run.timedOut, true, "an overrunning listing must be killed");
  assert.ok(
    Date.now() - started < 10_000,
    `${run.describe()}\nwaited on a descendant the group kill could not reach`,
  );
});

test("bounds every workspace test listing with an explicit timeout", async () => {
  const source = await readText("scripts/workspace-contract.test.mjs");
  const declaration = /const testListingTimeoutMs = ([\d_]+);/u.exec(source);

  assert.ok(declaration, "the listing bound must be declared by name");
  assert.ok(
    Number(declaration[1].replaceAll("_", "")) >= 60_000,
    "the bound must allow a cold listing on a loaded machine",
  );

  const grace = /const killGraceMs = ([\d_]+);/u.exec(source);

  assert.ok(grace, "the bound must settle on its own after a named grace");
  assert.ok(
    Number(grace[1].replaceAll("_", "")) <
      Number(declaration[1].replaceAll("_", "")),
    "the grace is what a killed group gets, not a second listing bound",
  );

  // A guard about hanging that can itself hang reports the regression as a
  // stalled run with no name on it, which is the diagnosis this file exists to
  // stop losing. `node --test` applies no default, so each says its own.
  for (const guard of [
    "kills a workspace test listing that outlives its bound",
    "settles a listing whose descendant outlives the group kill",
  ]) {
    const declared = source.indexOf(`test("${guard}"`);

    assert.ok(declared >= 0, `${guard} must still be the test's name`);
    assert.match(
      source.slice(declared, declared + 200),
      /timeout:\s*[\d_]+/u,
      `${guard} must carry its own timeout rather than hang the run`,
    );
  }

  // Built rather than written out, so this assertion does not count itself,
  // and tolerant of the line break the formatter puts between array elements.
  const listing = new RegExp(['"vitest"', '"list"'].join(",\\s*"), "gu");
  assert.equal(
    source.match(listing)?.length ?? 0,
    1,
    "every workspace test listing must go through the one bounded helper",
  );
});

test("keeps the retired legacy UI package out of the workspace", async () => {
  // The specification's retirement clause, mechanically: no manifest may
  // declare the package, no lockfile importer may resolve it, and no tracked
  // file outside the audit's own falsifying fixture may name it. The fixture is
  // the exception on purpose — it is what proves the `legacy-import` rule can
  // still fail once the package it names no longer exists to be resolved.
  const tracked = await execFileAsync(
    "git",
    ["grep", "-l", "--", "@requestport/ui"],
    { cwd: rootDirectory },
  ).then(
    ({ stdout }) => stdout.trim().split("\n").filter(Boolean),
    () => [],
  );

  assert.deepEqual(
    tracked.filter((path) => !path.startsWith("docs/")).toSorted(),
    [
      "apps/web/src/test/native-cue-audit.test.ts",
      "apps/web/src/test/native-cue-audit.ts",
      "apps/web/test-fixtures/native-cue-audit/README.md",
      "apps/web/test-fixtures/native-cue-audit/bad-legacy-surface.tsx",
      "scripts/workspace-contract.test.mjs",
    ],
  );

  const webPackage = await readJson("apps/web/package.json");

  assert.equal(webPackage.dependencies["@requestport/ui"], undefined);
  assert.equal(webPackage.devDependencies?.["@requestport/ui"], undefined);
  assert.doesNotMatch(await readText("pnpm-lock.yaml"), /packages\/ui/u);
});

test("resolves every non-optional peer of the root and web dependencies", async () => {
  // `autoInstallPeers: false` installs a peer only where a manifest declares
  // it, and a frozen install prints nothing when one disappears. The dependent
  // then fails at run time — dropping `puppeteer`, the non-optional peer of
  // `@mermaid-js/mermaid-cli`, killed `pnpm docs:diagrams` with
  // ERR_MODULE_NOT_FOUND while every checked-in gate stayed green.
  const importers = [
    ["package.json", ["node_modules"]],
    ["apps/web/package.json", ["apps/web/node_modules", "node_modules"]],
  ];
  const unresolved = [];

  for (const [manifestPath, moduleRoots] of importers) {
    const manifest = await readJson(manifestPath);
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };

    for (const [name, range] of Object.entries(declared)) {
      if (range.startsWith("workspace:")) continue;

      let installedDirectory = null;
      for (const moduleRoot of moduleRoots) {
        try {
          installedDirectory = await realpath(
            resolve(rootDirectory, moduleRoot, name),
          );
          break;
        } catch {}
      }

      assert.ok(
        installedDirectory,
        `${manifestPath} declares ${name}, which is not installed`,
      );

      const installed = JSON.parse(
        await readFile(resolve(installedDirectory, "package.json"), "utf8"),
      );
      const peerMeta = installed.peerDependenciesMeta ?? {};

      for (const peer of Object.keys(installed.peerDependencies ?? {})) {
        if (peerMeta[peer]?.optional === true) continue;

        const peerManifest = await resolvePeerManifest(
          installedDirectory,
          peer,
        );

        if (peerManifest === null) {
          unresolved.push(`${manifestPath}: ${name} requires peer ${peer}`);
        }
      }
    }
  }

  assert.deepEqual(unresolved, []);
});

test("routes only the CUE++ scope to public npm and stores no credential", async () => {
  const npmrc = await readText(".npmrc");

  assert.equal(npmrc, "@cueplusplus:registry=https://registry.npmjs.org/\n");
  assert.doesNotMatch(npmrc, /_auth/u);
  assert.doesNotMatch(npmrc, /_password/u);
  assert.doesNotMatch(npmrc, /token/iu);
});
test("bounds every live lock-choreography suite with an explicit timeout", async () => {
  // These suites drive several independent database connections through explicit
  // lock barriers, and every barrier is a network round trip. Vitest's 5s
  // default is a local-Postgres budget: against a remote branch these were the
  // only suites that timed out in CI while passing locally. The ephemeral
  // per-run database removes the contention; an explicit bound removes the
  // latency cliff, and keeping it named makes the choice reviewable.
  for (const path of [
    "packages/db/src/repositories/foundation-repository.integration.test.ts",
    "packages/db/src/queries/request-query-repository.integration.test.ts",
  ]) {
    const suite = await readText(path);
    const declaration = /const lockChoreographyTimeoutMs = ([\d_]+);/u.exec(
      suite,
    );

    assert.ok(declaration, `${path} must declare its timeout by name`);
    assert.ok(
      Number(declaration[1].replaceAll("_", "")) >= 20_000,
      `${path} must allow for remote round trips`,
    );

    const declared =
      suite.split("timeout: lockChoreographyTimeoutMs").length - 1;
    const cases = suite.split(/(?<=\n)\s*test\(/u).length - 1;

    assert.ok(cases > 0, `${path} must contain live cases`);
    assert.equal(
      declared,
      cases,
      `${path} must bound every live case, not only the ones that failed`,
    );
  }
});
test("owns the non-production Vercel install through a checked-in launcher", async () => {
  const [vercelConfig, launcher, scriptEntries, launcherIgnored, testIgnored] =
    await Promise.all([
      readJson("apps/web/vercel.json"),
      readText("scripts/install-vercel-dependencies.mjs"),
      readdir(resolve(rootDirectory, "scripts")),
      execFileAsync(
        "git",
        [
          "check-ignore",
          "--quiet",
          "--",
          "scripts/install-vercel-dependencies.mjs",
        ],
        { cwd: rootDirectory },
      ).then(
        () => true,
        () => false,
      ),
      execFileAsync(
        "git",
        [
          "check-ignore",
          "--quiet",
          "--",
          "scripts/install-vercel-dependencies.test.mjs",
        ],
        { cwd: rootDirectory },
      ).then(
        () => true,
        () => false,
      ),
    ]);

  assert.equal(
    vercelConfig.installCommand,
    "node ../../scripts/install-vercel-dependencies.mjs",
  );
  assert.ok(scriptEntries.includes("install-vercel-dependencies.mjs"));
  assert.ok(scriptEntries.includes("install-vercel-dependencies.test.mjs"));
  assert.equal(launcherIgnored, false);
  assert.equal(testIgnored, false);

  // The launcher resolves the repository root from its own checked-in
  // location, never from the Vercel Root Directory or process.cwd().
  assert.match(
    launcher,
    /resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\."\)/u,
  );
  assert.doesNotMatch(launcher, /process\.cwd\(\)/u);
  assert.match(launcher, /"install", "--frozen-lockfile"/u);
});

test("documents the Vercel root, launcher path, and package-access grants", {
  skip: skipInPublicTree(
    "docs/implementation/runbooks/vercel-environments-and-domains.md",
    "docs/implementation/environment-inventory.md",
    "docs/implementation/gotchas.md",
  ),
}, async () => {
  const [environments, inventory, gotchas] = await Promise.all([
    readText("docs/implementation/runbooks/vercel-environments-and-domains.md"),
    readText("docs/implementation/environment-inventory.md"),
    readText("docs/implementation/gotchas.md"),
  ]);

  assert.match(environments, /Root Directory.*`apps\/web`/su);
  assert.match(environments, /`apps\/web\/vercel\.json`/u);
  assert.match(
    environments,
    /node \.\.\/\.\.\/scripts\/install-vercel-dependencies\.mjs/u,
  );
  assert.match(environments, /REQUESTPORT_PACKAGE_READ_TOKEN/u);
  assert.match(environments, /Production install/u);

  for (const packageName of [
    "@cueplusplus/ui",
    "@cueplusplus/tokens",
    "@cueplusplus/brand-tokens",
  ]) {
    assert.ok(
      inventory.includes(packageName),
      `environment inventory must record ${packageName}`,
    );
  }

  assert.match(inventory, /Manage Actions access/u);
  assert.match(inventory, /cueplusplus\/requestport/u);
  assert.match(gotchas, /packages: read/u);
  assert.doesNotMatch(inventory, /ghp_|github_pat_|_authToken/u);
});

test("checks each recorded CUE++ digest against what this workspace installs", {
  skip: skipInPublicTree("docs/implementation/environment-inventory.md"),
}, async () => {
  // The inventory's integrity table is the kind of document that rots
  // silently: a transcribed digit is indistinguishable from a verified one.
  // Every row a consumer can check is checked against the lockfile here, and
  // every row it cannot check must say so in the table itself rather than
  // borrowing the credibility of the rows beside it.
  const [inventory, lockfile] = await Promise.all([
    readText("docs/implementation/environment-inventory.md"),
    readText("pnpm-lock.yaml"),
  ]);

  const rows = [
    ...inventory.matchAll(
      /^\| `(@cueplusplus\/[a-z-]+)` \| `([\d.]+)` \| `(sha512-[^`]+)` \| ([^|]+) \|$/gmu,
    ),
  ].map(([, name, version, integrity, provenance]) => ({
    name,
    version,
    integrity,
    provenance: provenance.trim(),
  }));

  assert.deepEqual(
    rows.map((row) => row.name),
    ["@cueplusplus/ui", "@cueplusplus/tokens", "@cueplusplus/brand-tokens"],
  );

  for (const row of rows) {
    const resolution = new RegExp(
      `^  '${row.name}@${row.version.replaceAll(".", "\\.")}':\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)[,}]`,
      "mu",
    ).exec(lockfile);

    if (resolution === null) {
      assert.match(
        row.provenance,
        /^Not installed here/u,
        `${row.name} is absent from pnpm-lock.yaml, so its row must say so`,
      );
      assert.match(row.provenance, /transcribed from Plan 10/u, row.name);
      continue;
    }

    assert.match(
      row.provenance,
      /^Verified against `pnpm-lock\.yaml`/u,
      `${row.name} is installed, so its row must claim local verification`,
    );
    assert.equal(resolution[1], row.integrity, row.name);
  }
});

test("resolves one @cueplusplus/theme-base, because an augmentation follows the file", async () => {
  /*
   * `packages/theme/index.d.ts` augments `ThemeRegistry` inside
   * `@cueplusplus/theme-base`, and a TypeScript augmentation applies to the
   * instance it resolves. While the packages were vendored, a `pnpm-workspace`
   * override pinned one copy; switching to the registry removed that override
   * and split the graph — `packages/theme` held an exact pin while
   * `@cueplusplus/ui` and `theme-tools` each depend on a `^1` range, so `ui`
   * resolved a different copy and `ThemeName` stopped closing over
   * `"requestport"`. It failed typecheck, which is the lucky version.
   *
   * Ranges everywhere is what makes them converge, and this is what notices if
   * an exact pin comes back or a second major appears.
   */
  const lockfile = await readText("pnpm-lock.yaml");
  const resolutions = [
    ...new Set(
      [...lockfile.matchAll(/@cueplusplus\/theme-base@(\d+\.\d+\.\d+)/gu)].map(
        ([, version]) => version,
      ),
    ),
  ];

  assert.deepEqual(
    resolutions.length,
    1,
    `one theme-base must be resolved, found: ${resolutions.join(", ")}`,
  );
});

test("installs every CUE++ package from public npm, pinned exactly", async () => {
  // The property that replaced vendoring on 2026-09-16. Checked three ways,
  // because each can regress alone: a manifest can drift back to a file: path,
  // the lockfile can name the billing-locked host again, and the scope can be
  // routed somewhere other than npm.
  const [webPackage, lockfile, npmrc] = await Promise.all([
    readJson("apps/web/package.json"),
    readText("pnpm-lock.yaml"),
    readText(".npmrc"),
  ]);

  const cuePackages = Object.entries(webPackage.dependencies).filter(([name]) =>
    name.startsWith("@cueplusplus/"),
  );

  assert.equal(cuePackages.length, 10);

  for (const [name, range] of cuePackages) {
    assert.match(range, /^\d+\.\d+\.\d+$/u, `${name} is declared as ${range}`);
  }

  assert.doesNotMatch(
    lockfile,
    /npm\.pkg\.github\.com/u,
    "pnpm-lock.yaml still resolves something from GitHub Packages",
  );
  assert.doesNotMatch(
    lockfile,
    /file:vendor\//u,
    "pnpm-lock.yaml still resolves a vendored tarball",
  );
  assert.match(npmrc, /registry\.npmjs\.org/u);
});
test("prescribes package probes a read:packages credential can actually run", {
  skip: skipInPublicTree("docs/implementation/environment-inventory.md"),
}, async () => {
  // A checked-in verification command that nobody can execute is worse than no
  // command: it looks like a closed loop. `/orgs/{org}/packages/npm/{name}` and
  // its `/versions` child both answer 200 for a read:packages credential, while
  // the `/repositories` child answers 404 — that route does not exist, so it can
  // never produce grant evidence and must not be prescribed as if it could.
  const inventory = await readText(
    "docs/implementation/environment-inventory.md",
  );
  const section = packageBoundarySection(inventory);

  assert.doesNotMatch(section, /packages\/npm\/[a-z-]+\/repositories/u);

  for (const name of ["ui", "tokens", "brand-tokens"]) {
    assert.match(
      section,
      new RegExp(`^gh api /orgs/cueplusplus/packages/npm/${name}$`, "mu"),
      `the inventory must prescribe the runnable probe for ${name}`,
    );
  }

  // The runnable probe answers a different, still decisive question: all three
  // packages are published from another repository, which is precisely why the
  // per-package Actions grant is mandatory rather than incidental.
  assert.match(section, /cueplusplus\/product-design-system/u);
  assert.match(section, /read:packages/u);

  // No REST route exposes the Manage Actions access list, so the probe proves
  // identity and cross-repository publication and never the grant itself.
  assert.match(section, /no REST/iu);

  // That limit has to be stated where the probes are prescribed. A reader who
  // runs three commands under an imperative to "record the result below" fills
  // the grant table from them; a disclaimer parked further down the page is
  // read after the damage. Assert the introducing sentence itself disclaims.
  const [beforeProbes] = section.split("```bash");
  const introduction = beforeProbes
    .trimEnd()
    .split(/\n\s*\n/u)
    .at(-1);

  assert.match(
    introduction,
    /do not prove|does not prove|never prove/u,
    "the sentence introducing the probes must disclaim the grant",
  );
  assert.match(introduction, /Manage Actions access/u);

  // And the grant table needs its own guard rail immediately above it, naming
  // the only two things that may ever fill those columns.
  const beforeGrantLog = section.slice(
    0,
    section.indexOf("| Package | Actions read for"),
  );
  const guardRail = beforeGrantLog
    .trimEnd()
    .split(/\n\s*\n/u)
    .at(-1);

  assert.ok(
    !guardRail.startsWith("```"),
    "the grant table must be introduced by a warning, not by the probe block",
  );
  assert.match(guardRail, /Manage Actions access/u);
  assert.match(guardRail, /verify-reusable\.yml/u);

  // The earlier reading — that a 404 meant the local credential lacked package
  // scope — was falsified by re-running the probe with read:packages.
  assert.doesNotMatch(section, /evidence of a missing scope/u);
});

test("lists only source Vitest tests for the backlog workspaces", {
  skip: skipInPublicTree("spikes/evaluator/vitest.config.ts"),
}, async () => {
  for (const workspace of [
    ["@requestport/importer", "packages/importer/vitest.config.ts"],
    ["@requestport/mcp", "packages/mcp/vitest.config.ts"],
    ["@requestport/notifications", "packages/notifications/vitest.config.ts"],
    ["@requestport/webhooks", "packages/webhooks/vitest.config.ts"],
    ["@requestport/trigger", "trigger/vitest.config.ts"],
    ["@requestport/evaluator-spike", "spikes/evaluator/vitest.config.ts"],
  ]) {
    const [packageName, configPath] = workspace;
    const config = await readText(configPath);
    assert.match(config, /include:\s*\["src\/\*\*\/\*\.test\.\{ts,tsx\}"\]/u);
    const { listed: listedTests, stdout } =
      await listWorkspaceTests(packageName);
    assert.ok(listedTests.every((line) => line.startsWith("src/")));
    assert.doesNotMatch(stdout, /\/dist\//u);
  }
});

test("declares only the exact foundation service workspace dependencies", {
  skip: skipInPublicTree("apps/cli/package.json"),
}, async () => {
  const [domainPackage, dbPackage, cliPackage] = await Promise.all([
    readJson("packages/domain/package.json"),
    readJson("packages/db/package.json"),
    readJson("apps/cli/package.json"),
  ]);

  assert.deepEqual(domainPackage.dependencies ?? {}, {
    uuid: "14.0.1",
    zod: "4.6.7",
  });
  assert.equal(dbPackage.dependencies["@requestport/domain"], "workspace:*");
  assert.equal(cliPackage.dependencies["@requestport/db"], "workspace:*");
  assert.equal(cliPackage.dependencies["@requestport/domain"], "workspace:*");
  assert.deepEqual(Object.keys(cliPackage.dependencies).sort(), [
    "@requestport/config",
    "@requestport/db",
    "@requestport/domain",
    "@requestport/importer",
  ]);
  assert.equal(
    cliPackage.scripts["bootstrap-owner"],
    "node ../../scripts/with-root-env.mjs tsx src/index.ts bootstrap-owner",
  );
  assert.equal(
    cliPackage.scripts["invite-user"],
    "node ../../scripts/with-root-env.mjs tsx src/index.ts invite-user",
  );
});

/**
 * The CLI, the SDK and the build extension, pinned to one version because the
 * CLI refuses to run against a different one.
 *
 * This used to be justified by `scripts/deploy-staging-trigger.mjs`, which ran
 * `pnpm --dir trigger exec trigger …`. That file went with staging on
 * 2026-09-20, and nothing in this repository shells out to the CLI any more —
 * the only mention left was the sentence that used to be here. The pin is not
 * stale, though; its reason is better than the old one and was measured rather
 * than argued.
 *
 * On 2026-09-25 a deploy invoked as `npx trigger.dev@latest` aborted before it
 * reached the build server: **"Version mismatch detected while running in CI.
 * This won't end well. Aborting."** — CLI `4.6.4` against `@trigger.dev/sdk`
 * and `@trigger.dev/build` at `4.5.11`. The three ship as one release train and
 * the CLI enforces it, so an unpinned declaration does not degrade, it refuses.
 * Pinning all three to one exact version is what makes a deploy reproducible.
 * The invocation that uses the pin is `pnpm --dir trigger exec trigger deploy`
 * — the package is `trigger.dev` but the binary it installs is `trigger`, and
 * `pnpm exec trigger.dev` fails with "Command not found". `npx
 * trigger.dev@latest` resolves a *different* CLI and is what produced the
 * mismatch abort above.
 */
test("pins the Trigger.dev CLI, SDK and build extension to one version", async () => {
  const [triggerPackage, lockfile] = await Promise.all([
    readJson("trigger/package.json"),
    readText("pnpm-lock.yaml"),
  ]);

  const pinned = "4.6.4";
  assert.equal(triggerPackage.devDependencies["trigger.dev"], pinned);
  assert.equal(triggerPackage.dependencies["@trigger.dev/sdk"], pinned);
  assert.equal(triggerPackage.devDependencies["@trigger.dev/build"], pinned);

  // A range is not a pin. `4.5.11` is the only accepted spelling: `^4.5.11`
  // would let a minor bump change the deploy argv contract this task proves.
  for (const specifier of [
    triggerPackage.devDependencies["trigger.dev"],
    triggerPackage.dependencies["@trigger.dev/sdk"],
    triggerPackage.devDependencies["@trigger.dev/build"],
  ]) {
    assert.match(specifier, /^\d+\.\d+\.\d+$/u);
  }

  const importer = /^ {2}trigger:\n((?: {4}[^\n]*\n|\n)*)/mu.exec(lockfile);
  assert.ok(importer, "pnpm-lock.yaml must record the trigger workspace");
  assert.match(
    importer[1],
    /^ {6}trigger\.dev:\n {8}specifier: 4\.6\.4\n {8}version: 4\.6\.4/mu,
    "the lockfile must resolve the CLI to the same exact version",
  );
});

/**
 * The CLI arrives with `@depot/cli`, whose install script downloads a platform
 * binary from a second network origin. Nothing in this repository builds a
 * deployment image locally — `trigger deploy` builds remotely — so that binary
 * is never executed here, and letting an install script fetch and run one is a
 * supply-chain surface bought for nothing. Every other build script in this
 * workspace is already denied; this one joins them rather than sitting on
 * pnpm's unanswered placeholder, which is neither an allow nor a deny.
 */
test("denies the install scripts the Trigger.dev CLI brings with it", async () => {
  const workspace = await readText("pnpm-workspace.yaml");
  const allowBuilds = /^allowBuilds:\n((?: {2}[^\n]*\n)*)/mu.exec(workspace);

  assert.ok(allowBuilds, "the workspace must declare a build-script policy");
  assert.match(allowBuilds[1], /^ {2}'@depot\/cli': false$/mu);
  assert.deepEqual(
    allowBuilds[1]
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !/:\s*false$/u.test(line)),
    [],
    "no dependency in this workspace may run an install script",
  );
});

/**
 * One workflow's jobs, as text blocks.
 *
 * There is no YAML parser in this workspace, and adding one to assert on three
 * files would be a dependency bought for a test. Slicing on the two-space job
 * headers is enough to ask each job the questions that matter — what it needs,
 * what it rechecks, and in which order — without pretending to understand the
 * whole document.
 */
function workflowJobs(workflow) {
  const marker = "\njobs:\n";
  const body = workflow.slice(workflow.indexOf(marker) + marker.length);
  const jobs = new Map();
  let current;

  for (const line of body.split("\n")) {
    const header = /^ {2}([a-z][a-z0-9-]*):\s*$/u.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current) jobs.get(current).push(line);
  }

  return new Map([...jobs].map(([name, lines]) => [name, lines.join("\n")]));
}

/** Every step in a job block, whole, in the order the job runs them. */
function jobSteps(job) {
  const steps = [];
  for (const line of job.split("\n")) {
    if (/^ {6}- /u.test(line)) steps.push([line]);
    else if (steps.length > 0 && /^ {8}/u.test(line)) steps.at(-1).push(line);
  }
  return steps.map((lines) => lines.join("\n"));
}
/**
 * The Playwright budgets the reusable job has to be able to host.
 *
 * Read out of the configuration rather than restated, for the same reason the
 * engine list is: there is one source of truth for how long a run may take, and
 * a literal copy here would be a second one that drifts.
 */
async function declaredBudgets() {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `const { default: config } = await import("./playwright.config.ts");
       const budget = await import("./playwright.config.ts");
       process.stdout.write(JSON.stringify({
         globalTimeout: config.globalTimeout,
         jobBudgetMs: budget.jobBudgetMs ?? null,
         lanes: (config.projects ?? []).length,
         shardBudgetsMs: Object.fromEntries(budget.shardBudgetsMs ?? []),
       }));`,
    ],
    {
      cwd: resolve(rootDirectory, "apps/web"),
      env: {
        ...process.env,
        NODE_ENV: "test",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN:
          "contract-test-token-that-is-at-least-thirty-two-chars",
      },
    },
  );

  const parsed = JSON.parse(stdout);
  assert.ok(
    Number.isFinite(parsed.globalTimeout) && parsed.globalTimeout > 0,
    "the shard must be bounded",
  );
  assert.ok(parsed.lanes > 0, "the acceptance matrix must declare a lane");

  return parsed;
}
/**
 * Everything one launcher can reach: its own imports, and the launchers it
 * spawns by path.
 *
 * A command's environment is not decided by the file whose name an operator
 * types. `verify-staging-appearance-outbox.mjs` reads no digest of its own —
 * it imports the credential reader, and reaches the database gate through a
 * module that spawns `database-target-preflight.mjs` — so the only honest way
 * to say what a command needs is to follow both edges.
 */
async function launcherReach(entry) {
  const reached = new Set();
  const visit = async (relative) => {
    if (reached.has(relative)) return;
    reached.add(relative);
    const source = await readText(relative);
    const next = new Set();
    for (const [, specifier] of source.matchAll(
      /from "\.\/([A-Za-z0-9._-]+\.mjs)"/gu,
    )) {
      next.add(`scripts/${specifier}`);
    }
    // Spawned by path rather than imported, and not always inside quotes: the
    // migration launcher runs the database gate from a shell heredoc. The
    // lookbehind keeps `packages/db/scripts/...` from being read as one of
    // these.
    for (const [specifier] of source.matchAll(
      /(?<![\w/.])scripts\/[a-z0-9-]+\.mjs\b/gu,
    )) {
      next.add(specifier);
    }
    for (const child of next) await visit(child);
  };

  await visit(entry);
  const sources = await Promise.all([...reached].map(readText));

  return {
    files: reached,
    // The declaration is not a use. Without dropping it, importing the module
    // that defines the credential reader would look like needing it.
    source: sources
      .join("\n")
      .replaceAll("function readStagingTriggerCredentials(", ""),
  };
}

/** One heading and everything under it, up to the next heading of its level. */
function documentSection(document, heading) {
  const level = /^#+/u.exec(heading)[0].length;
  const start = document.indexOf(`\n${heading}\n`);
  if (start < 0) return undefined;
  const rest = document.slice(start + heading.length + 2);
  const end = new RegExp(`^#{1,${level}} `, "mu").exec(rest);

  return end ? rest.slice(0, end.index) : rest;
}

/**
 * Every launcher a workflow executes, following the launchers each step spawns.
 *
 * A step names a program; that program may spawn others, and one of those may
 * spawn more. Reading only the `node scripts/...` lines in the workflow file is
 * how `verify-staging-owner-state.mjs` came to be documented as a command no
 * workflow runs: `run-preview-migrations.mjs`, which a step does run, spawns it
 * inside the environment wrapper it opens. Imports are followed too, because
 * the module that spawns a launcher is very often not the one a step names.
 */
async function workflowExecutedLaunchers(workflowRelativePath) {
  const workflow = await readText(workflowRelativePath);
  const executed = new Set(
    [...workflow.matchAll(/node (scripts\/[a-z0-9-]+\.mjs)/gu)].map(
      ([, launcher]) => launcher,
    ),
  );

  let counted = 0;
  while (counted !== executed.size) {
    counted = executed.size;
    for (const launcher of [...executed]) {
      const reach = await launcherReach(launcher);
      for (const [spawned] of reach.source.matchAll(
        /(?<![\w/.])scripts\/[a-z0-9-]+\.mjs\b/gu,
      )) {
        executed.add(spawned);
      }
    }
  }

  return executed;
}

function literalTuple(source, name) {
  const declaration = new RegExp(
    `export const ${name} = \\[([\\s\\S]*?)\\] as const;`,
    "u",
  ).exec(source);

  assert.ok(declaration, `${name} must be declared as a literal tuple`);

  return [...declaration[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

/* ------------------------------------------------------------------ *
 * The staging acceptance documents.
 * ------------------------------------------------------------------ */

const acceptanceRunbookPath =
  "docs/implementation/runbooks/requestport-cue-reskin-acceptance.md";

test("records the staging Trigger provisioning surface by name only", {
  skip: skipInPublicTree(
    "docs/implementation/environment-inventory.md",
    "docs/implementation/runbooks/requestport-cue-reskin-acceptance.md",
  ),
}, async () => {
  const [inventory, runbook] = await Promise.all([
    readText("docs/implementation/environment-inventory.md"),
    readText(acceptanceRunbookPath),
  ]);

  // Without these an owner cannot run staging acceptance at all, and the
  // workflow's refusal names the group rather than the missing member.
  for (const name of [
    "TRIGGER_ACCESS_TOKEN",
    "TRIGGER_STAGING_SECRET_KEY",
    "TRIGGER_PROJECT_REF",
    "TRIGGER_SECRET_KEY",
  ]) {
    assert.match(
      inventory,
      new RegExp(name, "u"),
      `inventory must name ${name}`,
    );
  }
  for (const reason of ["credentials_missing", "credentials_partial"]) {
    assert.match(
      runbook,
      new RegExp(reason, "u"),
      `the runbook must name the ${reason} refusal`,
    );
  }

  // Names, scopes and owners — never a value. These are the shapes the
  // verifier itself checks for, so a pasted value would match one of them.
  for (const [name, document] of [
    ["environment-inventory.md", inventory],
    ["requestport-cue-reskin-acceptance.md", runbook],
  ]) {
    assert.doesNotMatch(document, /tr_pat_[A-Za-z0-9]/u, name);
    assert.doesNotMatch(document, /tr_stg_[A-Za-z0-9]/u, name);
    assert.doesNotMatch(document, /tr_prod_[A-Za-z0-9]/u, name);
    assert.doesNotMatch(document, /\bproj_[a-z0-9]{8,64}\b/u, name);
  }
});

test("checks the recorded staging origin digest instead of transcribing it", {
  skip: skipInPublicTree("docs/implementation/environment-inventory.md"),
}, async () => {
  // This also held the workflow's copy of the digest to the inventory's, so the
  // gate could not check a number nobody had documented. The workflow is gone
  // and the inventory is now the only copy — which makes deriving it here more
  // load-bearing, not less: a hand-run staging verification reads this number
  // out of the inventory, and a transcribed digest nobody recomputes is exactly
  // how it would go stale unnoticed.
  const inventory = await readText(
    "docs/implementation/environment-inventory.md",
  );

  const origin = "https://staging.requestport.com";
  const digest = createHash("sha256").update(origin).digest("hex");
  const recorded =
    /EXPECTED_APPLICATION_ORIGIN_SHA256[^\n]*?([0-9a-f]{64})/u.exec(inventory);

  assert.ok(
    recorded,
    "the inventory must record the application origin digest",
  );
  assert.equal(recorded[1], digest);
});

test("maps every catalogued local scenario into the acceptance runbook", {
  skip: skipInPublicTree(
    "docs/implementation/runbooks/requestport-cue-reskin-acceptance.md",
  ),
}, async () => {
  const [catalogue, runbook] = await Promise.all([
    readText("apps/web/src/test/e2e-scenarios.ts"),
    readText(acceptanceRunbookPath),
  ]);

  // Step 7 forbids claiming a synthetic framework or error state on staging,
  // because deterministic local Playwright proves those. A reader can only act
  // on that if the runbook says which is which, for every catalogued case.
  for (const id of literalTuple(catalogue, "e2eScenarioIds")) {
    assert.match(
      runbook,
      new RegExp(`\`${id}\``, "u"),
      `the runbook must map the ${id} scenario`,
    );
  }
  assert.match(runbook, /not claim|never claim|does not claim/u);
});

test("says where the competing-deployer gate can refuse a first run", {
  skip: skipInPublicTree(
    "docs/implementation/runbooks/requestport-cue-reskin-acceptance.md",
    "docs/implementation/runbooks/deployment.md",
  ),
}, async () => {
  const [runbook, deployment] = await Promise.all([
    readText(acceptanceRunbookPath),
    readText("docs/implementation/runbooks/deployment.md"),
  ]);

  for (const [name, text] of [
    ["requestport-cue-reskin-acceptance.md", runbook],
    ["deployment.md", deployment],
  ]) {
    assert.match(text, /competing_auto_deployer/u, name);
    assert.match(text, /github_actions/u, name);
  }
  // The remedy has to be beside the refusal, not in a footnote: the first live
  // run may legitimately refuse because nobody has observed what source string
  // the provider records for this wrapper's own deploys.
  assert.match(runbook, /first (?:live )?run/iu);
});

test("counts the case table by what the case table counts", {
  skip: skipInPublicTree(
    "docs/implementation/runbooks/requestport-cue-reskin-acceptance.md",
  ),
}, async () => {
  const [runbook, matrix] = await Promise.all([
    readText(acceptanceRunbookPath),
    readJson(
      "docs/implementation/acceptance/requestport-cue-reskin-matrix.json",
    ),
  ]);

  // The defect this closes. The document stated the size of the table, its
  // split across the two lanes and its split across the two engines — five
  // figures, correct on the day they were written and bound by nothing. A
  // count in prose is a copy of a derivation, and a copy drifts the moment a
  // row is added.
  const stated = [...runbook.matchAll(/(\d[\d,]*) cases\b/gu)].map(
    ([, count]) => Number(count.replaceAll(",", "")),
  );

  assert.ok(stated.length > 0, "the runbook must say how large the table is");
  for (const total of stated) {
    assert.equal(total, matrix.cases.length, "a case count is the table's own");
  }

  // Each breakdown is keyed on the value the table itself uses rather than on
  // an English spelling of it, so a count and the thing it counts cannot drift
  // apart in different vocabularies — and every value the table declares has to
  // be counted, or a lane could disappear from the document unnoticed.
  for (const key of ["lane", "engine"]) {
    const counted = new Map();
    for (const entry of matrix.cases) {
      counted.set(entry[key], (counted.get(entry[key]) ?? 0) + 1);
    }
    const claimed = new Map(
      [...runbook.matchAll(/(\d+) `([a-z-]+)`/gu)]
        .filter(([, , name]) => counted.has(name))
        .map(([, count, name]) => [name, Number(count)]),
    );

    assert.deepEqual(
      [...claimed].toSorted(),
      [...counted].toSorted(),
      `the runbook must count every ${key} the table declares, as the table names it`,
    );
  }
});

test("describes the case table by every axis the schema requires of it", {
  skip: skipInPublicTree(
    "docs/implementation/runbooks/requestport-cue-reskin-acceptance.md",
  ),
}, async () => {
  const [runbook, matrixSchema] = await Promise.all([
    readText(acceptanceRunbookPath),
    readJson(
      "docs/implementation/acceptance/requestport-cue-reskin-matrix.schema.json",
    ),
  ]);

  // The defect this closes. The document listed what a case carries, the list
  // was written once by hand, and an axis added to the table afterwards was
  // described by nothing — so a reader deciding whether the table verifies
  // mobile composition read a sentence that predated the axis which decides it.
  // The list is read out of the schema, so it is whatever the schema requires.
  const missing = matrixSchema.$defs.case.required.filter(
    (name) => !runbook.includes(`\`${name}\``),
  );

  assert.deepEqual(
    missing,
    [],
    "the runbook must name every attribute a case is required to declare",
  );
});

test("keeps the run evidence and the case table documented as opposites", {
  skip: skipInPublicTree(
    "docs/implementation/runbooks/requestport-cue-reskin-acceptance.md",
  ),
}, async () => {
  const [runbook, evidenceSchema, matrixSchema] = await Promise.all([
    readText(acceptanceRunbookPath),
    readJson(
      "docs/implementation/acceptance/requestport-cue-reskin-run-evidence.schema.json",
    ),
    readJson(
      "docs/implementation/acceptance/requestport-cue-reskin-matrix.schema.json",
    ),
  ]);

  assert.equal(evidenceSchema.properties.kind.const, "run-evidence");
  assert.ok(
    !("kind" in matrixSchema.properties),
    "the case table must not declare the evidence discriminator",
  );
  assert.match(runbook, /requestport-cue-reskin-run-evidence\.json/u);
  assert.match(runbook, /requestport-cue-reskin-matrix\.json/u);
  assert.match(runbook, /retention/iu);
  assert.match(runbook, /checksum|digest|sha256/iu);
});

test("indexes the acceptance runbook where runbooks are listed", {
  skip: skipInPublicTree("docs/implementation/README.md"),
}, async () => {
  const readme = await readText("docs/implementation/README.md");

  assert.match(readme, /\.\/runbooks\/requestport-cue-reskin-acceptance\.md/u);
});

test("records what this engagement learned where an engineer meets it again", {
  skip: skipInPublicTree("docs/implementation/gotchas.md"),
}, async () => {
  const gotchas = await readText("docs/implementation/gotchas.md");

  // The dev-only stylesheet signature is why the deployed policy split has to
  // be proven on staging rather than locally; without it a reader treats a
  // local refusal as a product defect.
  assert.match(gotchas, /next dev --webpack/u);
  assert.match(gotchas, /style-src-elem/u);
  assert.match(gotchas, /competing_auto_deployer/u);
});

test("derives the post-0014 journal snapshot instead of transcribing it", {
  skip: skipInPublicTree(
    "docs/implementation/environment-inventory.md",
    "docs/implementation/runbooks/deployment.md",
    "docs/implementation/runbooks/requestport-cue-reskin-acceptance.md",
  ),
}, async () => {
  const { checkedInMigrationJournal } = await import("./migration-support.mjs");
  const snapshot = checkedInMigrationJournal();
  const parsed = /^count=([1-9][0-9]*) hash=([0-9a-f]{64})$/u.exec(snapshot);

  assert.ok(
    parsed,
    "the checked-in journal snapshot must have the fixed shape",
  );

  const [, count, hash] = parsed;
  const documents = await Promise.all(
    [
      "docs/implementation/environment-inventory.md",
      "docs/implementation/runbooks/deployment.md",
      acceptanceRunbookPath,
    ].map(async (path) => [path, await readText(path)]),
  );

  // A transcribed digest is indistinguishable from a verified one until the
  // day it is wrong, and a gate documented with the wrong expected value sends
  // a reader hunting a database fault that does not exist. So every snapshot
  // any document claims for the current migration tree is compared with the
  // one the tree actually produces.
  let claimed = 0;
  for (const [path, document] of documents) {
    for (const match of document.matchAll(
      new RegExp(`count=${count}(?![0-9])`, "gu"),
    )) {
      const following = document.slice(
        match.index + match[0].length,
        match.index + match[0].length + 140,
      );
      const digest = /[0-9a-f]{64}/u.exec(following);
      if (!digest) continue;
      claimed += 1;
      assert.equal(digest[0], hash, `${path} records the wrong journal hash`);
    }
  }

  assert.ok(
    claimed > 0,
    `some document must record the count=${count} journal snapshot`,
  );
});

test("declares the webhook private receivers switch turbo would otherwise strip, and documents it commented out", async () => {
  // Plan 13, H.10 (rulings 175 and 176). `globalEnv` is an allowlist (the
  // next test), so undeclared, an operator's
  // REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS=enabled would not reach a task
  // turbo runs. `.env.example` carries the line commented out, because an
  // empty value refuses to boot.
  const [turbo, envExample] = await Promise.all([
    readJson("turbo.json"),
    readText(".env.example"),
  ]);

  assert.ok(turbo.globalEnv.includes("REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS"));
  assert.match(
    envExample,
    /^# REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS=enabled$/mu,
  );
  assert.doesNotMatch(envExample, /^REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS=/mu);
});

test("declares the local proxy variable turbo would otherwise strip", async () => {
  // `globalEnv` is an allowlist, and turbo runs tasks with everything else
  // removed. Since 2026-09-28 the gate *empties* the hosted driver's proxy
  // variable (`localProxyVariable` in hosted-deployment.mjs) for its steps
  // rather than setting it: the local stack runs no proxy, and a generated
  // `.env.local` still names one. Undeclared, the empty value would be
  // stripped, the vitest configs of packages/db, packages/auth, packages/jobs
  // and trigger would refill the variable from `.env.local` through
  // loadRootEnv, and the hosted driver's cases in packages/db would dial a
  // proxy that is gone instead of skipping. Measured with Turbo 2.10.10: a
  // declared empty variable reaches the task as "", an undeclared one not at
  // all. Declaring it also keeps it in the cache key. The public tree has no
  // hosted driver, and so no such variable.
  const turbo = await readJson("turbo.json");

  if (hostedDeployment.localProxyVariable !== null) {
    assert.ok(turbo.globalEnv.includes(hostedDeployment.localProxyVariable));
  }
  assert.ok(turbo.globalEnv.includes("DATABASE_URL"));
});

test("turbo.public.json, which the public seed carries at turbo.json's path, is turbo.json less the hosted deployment's local proxy and Preview project variables, and nothing else (ruling 175, owner question 3; J.2b)", async () => {
  // release/public-tree.json substitutes it for turbo.json in the seed, which
  // has no hosted driver. Here the private module names both variables and
  // turbo.json declares them. In the seed the module's public variant names
  // neither, and turbo.json is this file, so the two are equal.
  const [turbo, publicTurbo] = await Promise.all([
    readJson("turbo.json"),
    readJson("turbo.public.json"),
  ]);
  const hostedVariables = [
    hostedDeployment.localProxyVariable,
    hostedDeployment.databaseProjectVariables?.preview ?? null,
  ].filter((name) => name !== null);

  for (const name of hostedVariables) {
    assert.ok(turbo.globalEnv.includes(name), name);
  }
  assert.deepEqual(publicTurbo, {
    ...turbo,
    globalEnv: turbo.globalEnv.filter(
      (name) => !hostedVariables.includes(name),
    ),
  });
});

test("packages/db/package.public.json, which the public seed carries at packages/db/package.json's path, is that manifest less the hosted driver's packages in every dependency field, and nothing else (ruling 194 item 1)", async () => {
  // release/public-tree.json substitutes it for packages/db/package.json in
  // the seed, which has no hosted driver, and the export regenerates the
  // seed's lockfile from it. Here the private manifest declares each of the
  // hosted deployment's hostedDriverPackages. In the seed that list is empty
  // and packages/db/package.json is this file, so the two are equal.
  const [manifest, publicManifest] = await Promise.all([
    readJson("packages/db/package.json"),
    readJson("packages/db/package.public.json"),
  ]);
  const { hostedDriverPackages } = hostedDeployment;
  for (const name of hostedDriverPackages) {
    assert.ok(Object.hasOwn(manifest.dependencies ?? {}, name), name);
  }
  const expected = { ...manifest };
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    if (manifest[field] === undefined) continue;
    expected[field] = Object.fromEntries(
      Object.entries(manifest[field]).filter(
        ([name]) => !hostedDriverPackages.includes(name),
      ),
    );
  }
  assert.deepEqual(publicManifest, expected);
});
