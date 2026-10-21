import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as hostedDeployment from "./hosted-deployment.mjs";
import * as publicVariant from "./hosted-deployment.public.mjs";
import { LAST_IN_TRANSACTION_MARKER } from "./migration-support.mjs";

/*
 * `scripts/hosted-deployment.mjs` and `packages/db/src/shared-databases.ts`
 * (ruling 91, option (d); manifest-j.md §2.4 item 2): what happens without
 * them, and how their readers reach them. Kept in the public seed, where the
 * public variants stand at those paths, so no case here depends on either
 * module's contents: the private tree's own facts are `private-paths.test.mjs`'s.
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The scripts each direct run below needs, and the journal reader they reach. */
const COPIED = [
  "scripts/production-database-guard.mjs",
  "scripts/with-root-env.mjs",
  "scripts/owner-capable-variables.mjs",
  "scripts/run-production-migrations.mjs",
  "scripts/migration-state.mjs",
  "scripts/migration-support.mjs",
  "packages/db/scripts/read-preview-migration-journal.mjs",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** The state file the planted modules name: a path no real deployment uses. */
const PLANTED_STATE_PATH = "docs/example/migration-state.json";

/** The committed public variant's text, which the seed carries at the module's path. */
const PUBLIC_VARIANT = readFileSync(
  join(repositoryRoot, "scripts/hosted-deployment.public.mjs"),
  "utf8",
);

/** `text` with each [from, to] replaced, failing if any `from` is not in it exactly once. */
function replacedOnce(text, ...pairs) {
  return pairs.reduce((result, [from, to]) => {
    assert.equal(result.split(from).length, 2, from);
    return result.replace(from, to);
  }, text);
}

/**
 * A private module naming one synthetic database and a state file, as the
 * planted control: the public variant's text with those three changed, so it
 * exports every name the scripts import from the module, and no hosted
 * driver.
 */
const PLANTED = replacedOnce(
  PUBLIC_VARIANT,
  ['export const kind = "public";', 'export const kind = "private";'],
  [
    "export const sharedDatabases = Object.freeze([]);",
    `export const sharedDatabases = [${JSON.stringify({
      name: "production",
      hostSha256: sha256("db-production.region-1.example.test"),
      databaseNameSha256: null,
      optIn: "REQUESTPORT_PRODUCTION_DATABASE",
    })}];`,
  ],
  [
    "export const migrationState = null;",
    `export const migrationState = ${JSON.stringify(PLANTED_STATE_PATH)};`,
  ],
);

/**
 * A malformed one: public, yet naming a database. Its state file is null, as
 * a public module's is, so the list is its one fault.
 */
const MALFORMED = replacedOnce(
  PLANTED,
  ['"private"', '"public"'],
  [JSON.stringify(PLANTED_STATE_PATH), "null"],
);

/**
 * A temporary checkout holding `COPIED` and, given its text, a
 * `scripts/hosted-deployment.mjs`, with no `node_modules`: none of `COPIED`
 * imports an installed package (the journal reader takes its pool from the
 * module's `createHostedPool`, which requires the hosted driver only when
 * called, and no case here calls it), so the one module a run can miss is the
 * one under test. The directory is resolved through any symbolic link, because
 * macOS's default temporary directory is reached through one, and the launcher
 * and `with-root-env.mjs` compare their own path with `process.argv[1]` to
 * decide whether they were run.
 */
function scratchCheckout(t, deployment) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "requestport-hosted-deployment-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of COPIED) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repositoryRoot, path), join(root, path));
  }
  if (deployment !== undefined) {
    writeFileSync(join(root, "scripts/hosted-deployment.mjs"), deployment);
  }
  return root;
}

/** `node <root>/<script> …args` with nothing in its environment but PATH and HOME. */
function runIn(root, script, args = []) {
  return spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

/** `with-root-env.mjs` wrapping a child that writes `sentinel` if it ever runs. */
function wrapSentinel(root, sentinel) {
  return runIn(root, "scripts/with-root-env.mjs", [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`,
  ]);
}

const LAUNCHER_REFUSED = "RequestPort production migration failed.";

describe("without scripts/hosted-deployment.mjs, nothing that reads it runs", () => {
  test("the guard, with-root-env.mjs and the production launcher, each run directly, stop at import naming the module, and the wrapped child never starts", (t) => {
    const root = scratchCheckout(t);
    const sentinel = join(root, "child-ran");
    for (const run of [
      runIn(root, "scripts/production-database-guard.mjs"),
      wrapSentinel(root, sentinel),
      runIn(root, "scripts/run-production-migrations.mjs"),
    ]) {
      assert.notEqual(run.status, 0, run.stderr);
      assert.match(run.stderr, /ERR_MODULE_NOT_FOUND/u);
      assert.match(run.stderr, /scripts\/hosted-deployment\.mjs/u);
      assert.equal(run.stdout, "");
      assert.doesNotMatch(run.stderr, new RegExp(LAUNCHER_REFUSED, "u"));
    }
    assert.equal(existsSync(sentinel), false, "the wrapped child ran");
  });

  test("the same checkout with a well-formed module planted runs each one, so the stop above is the module's absence", (t) => {
    const root = scratchCheckout(t, PLANTED);
    const sentinel = join(root, "child-ran");

    const guard = runIn(root, "scripts/production-database-guard.mjs");
    assert.equal(guard.status, 0, guard.stderr);

    const wrapped = wrapSentinel(root, sentinel);
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.equal(readFileSync(sentinel, "utf8"), "ran");

    // With no commit named, the launcher refuses before it reads anything
    // else: its own refusal, printed after it was imported.
    const launcher = runIn(root, "scripts/run-production-migrations.mjs");
    assert.equal(launcher.status, 1, launcher.stderr);
    assert.match(launcher.stderr, new RegExp(LAUNCHER_REFUSED, "u"));
  });

  test("a malformed module refuses with-root-env.mjs before its child starts, and stops the launcher at import", (t) => {
    const root = scratchCheckout(t, MALFORMED);
    const sentinel = join(root, "child-ran");

    const wrapped = wrapSentinel(root, sentinel);
    assert.equal(wrapped.status, 1, wrapped.stderr);
    assert.match(wrapped.stderr, /the shared-database list is malformed/u);
    assert.equal(existsSync(sentinel), false, "the wrapped child ran");

    const launcher = runIn(root, "scripts/run-production-migrations.mjs");
    assert.notEqual(launcher.status, 0, launcher.stderr);
    assert.match(launcher.stderr, /the shared-database list is malformed/u);
    assert.doesNotMatch(launcher.stderr, new RegExp(LAUNCHER_REFUSED, "u"));
  });

  test("the migration-state step reaches the module by static import, and, run directly without it, stops at import naming it", (t) => {
    assert.ok(
      staticallyReached("scripts/migration-state.mjs").has(
        "scripts/hosted-deployment.mjs",
      ),
    );
    const root = scratchCheckout(t);
    const step = runIn(root, "scripts/migration-state.mjs");
    assert.notEqual(step.status, 0, step.stderr);
    assert.match(step.stderr, /ERR_MODULE_NOT_FOUND/u);
    assert.match(step.stderr, /scripts\/hosted-deployment\.mjs/u);
    assert.equal(step.stdout, "");
  });
});

/** git in `directory`, with no `GIT_` variable of this process, no hooks and no signing. */
function gitIn(directory, args) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...inherited,
        GIT_AUTHOR_NAME: "Synthetic",
        GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
        GIT_COMMITTER_NAME: "Synthetic",
        GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
      },
    },
  );
}

/*
  The migration-state step run directly, as `pnpm migrations:status` and the
  gate run it (manifest-j.md §2.4 item 5), in a temporary tree with its own
  journal and its own repository: no case here reads the real module or the
  real state file, so each holds in both trees.
*/
describe("the migration-state step, run directly, under the module its tree holds", () => {
  const UNMARKED = [
    ["0000_synthetic", "-- A synthetic migration.\nSELECT 1;\n"],
  ];
  const MARKED = [
    ["0000_synthetic", `${LAST_IN_TRANSACTION_MARKER}\nSELECT 1;\n`],
    ["0001_synthetic_after", "-- The one after it.\nSELECT 2;\n"],
  ];

  /**
   * `scratchCheckout` holding `deployment`, a journal of `migrations` (each
   * [tag, sql]) and a repository on `main` with one commit; no state file.
   */
  function stepCheckout(t, deployment, migrations) {
    const root = scratchCheckout(t, deployment);
    const directory = join(root, "packages/db/migrations");
    mkdirSync(join(directory, "meta"), { recursive: true });
    writeFileSync(
      join(directory, "meta/_journal.json"),
      JSON.stringify({
        entries: migrations.map(([tag], idx) => ({ idx, tag, when: idx + 1 })),
      }),
    );
    for (const [tag, sql] of migrations) {
      writeFileSync(join(directory, `${tag}.sql`), sql);
    }
    gitIn(root, ["init", "-q", "-b", "main"]);
    gitIn(root, [
      "commit",
      "-q",
      "--no-verify",
      "--allow-empty",
      "-m",
      "A synthetic tree",
    ]);
    return root;
  }

  test("a synthetic private module and no state file: on main the step exits 1, the alarm as it was, naming the module's state file, and on a feature branch 0", (t) => {
    const root = stepCheckout(t, PLANTED, UNMARKED);

    const onMain = runIn(root, "scripts/migration-state.mjs");
    assert.equal(onMain.status, 1, onMain.stderr);
    assert.match(onMain.stdout, /no production migration state is recorded/u);
    assert.ok(onMain.stdout.includes(PLANTED_STATE_PATH), onMain.stdout);

    gitIn(root, ["checkout", "-q", "-b", "track/anything"]);
    const onFeature = runIn(root, "scripts/migration-state.mjs");
    assert.equal(onFeature.status, 0, onFeature.stderr);
    assert.match(
      onFeature.stdout,
      /no production migration state is recorded/u,
    );
  });

  test("the public variant: on main the step exits 0, says the tree records no hosted deployment and prints the ordering constraint, and the launcher refuses", (t) => {
    const root = stepCheckout(t, PUBLIC_VARIANT, MARKED);

    const step = runIn(root, "scripts/migration-state.mjs");
    assert.equal(step.status, 0, step.stderr);
    assert.match(step.stdout, /this tree records no hosted deployment/u);
    assert.match(
      step.stdout,
      / {2}must be last : 0000_synthetic\n {2}after it {5}: 0001_synthetic_after\n/u,
    );
    assert.doesNotMatch(step.stdout, /\.json/u);

    const launcher = runIn(root, "scripts/run-production-migrations.mjs");
    assert.equal(launcher.status, 1, launcher.stderr);
    assert.match(launcher.stderr, new RegExp(LAUNCHER_REFUSED, "u"));
    assert.match(launcher.stderr, /this tree records no hosted deployment/u);
  });

  test("a module whose migration state is malformed, public yet naming a file, stops the step and the launcher at import, saying so, on a feature branch too", (t) => {
    const publicNamingAFile = PUBLIC_VARIANT.replace(
      "export const migrationState = null;",
      `export const migrationState = ${JSON.stringify(PLANTED_STATE_PATH)};`,
    );
    assert.notEqual(publicNamingAFile, PUBLIC_VARIANT);
    const root = stepCheckout(t, publicNamingAFile, UNMARKED);
    gitIn(root, ["checkout", "-q", "-b", "track/anything"]);

    for (const script of [
      "scripts/migration-state.mjs",
      "scripts/run-production-migrations.mjs",
    ]) {
      const run = runIn(root, script);
      assert.equal(run.status, 1, `${script}: ${run.stderr}`);
      assert.match(
        run.stderr,
        /the hosted deployment's migration state is malformed/u,
        script,
      );
      assert.equal(run.stdout, "", script);
      assert.doesNotMatch(
        run.stderr,
        new RegExp(LAUNCHER_REFUSED, "u"),
        script,
      );
    }
  });
});

/*
 * How the readers reach the modules: by static imports, followed from each
 * entry point through the relative specifiers of every `import … from` and
 * `export … from` but a type-only one, which no runtime reads; a TypeScript
 * source stands for its `.js` specifier, as TypeScript and the bundlers read
 * it. A static import cannot be caught, so a reader that reaches a module
 * this way cannot run without it.
 */
const STATIC_SPECIFIER =
  /^\s*(?:import|export)(?!\s+type\s)\s[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gmu;

function staticallyReached(entry) {
  const reached = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop();
    if (reached.has(path)) continue;
    reached.add(path);
    const text = readFileSync(join(repositoryRoot, path), "utf8");
    for (const match of text.matchAll(STATIC_SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith(".")) continue;
      const target = posix.normalize(
        posix.join(posix.dirname(path), specifier),
      );
      const typed = target.replace(/\.js$/u, ".ts");
      if (existsSync(join(repositoryRoot, target))) pending.push(target);
      else if (existsSync(join(repositoryRoot, typed))) pending.push(typed);
    }
  }
  return reached;
}

describe("the readers reach the modules by static import, and nothing imports them any other way", () => {
  test("every vitest file that imports the guard, the entry points that wrap or gate a command, and the production launcher reach scripts/hosted-deployment.mjs", () => {
    // Derived, not listed, so a vitest file added later that runs the guard
    // is covered without anyone remembering to name it here. Five on
    // 2026-10-09: packages/db's two configs, packages/jobs' database setup
    // and worker-role config, and apps/requestport's config (H.4).
    const guardReaders = execFileSync("git", ["ls-files", "-z"], {
      cwd: repositoryRoot,
      maxBuffer: 1 << 28,
    })
      .toString()
      .split("\0")
      .filter((path) => /(?:^|\/)vitest[^/]*\.ts$/u.test(path))
      .filter((path) =>
        readFileSync(join(repositoryRoot, path), "utf8").includes(
          "production-database-guard",
        ),
      );
    assert.ok(guardReaders.length >= 5, guardReaders.join(", "));
    assert.ok(
      guardReaders.includes("apps/requestport/vitest.config.ts"),
      guardReaders.join(", "),
    );
    for (const entry of [
      ...guardReaders,
      "scripts/with-root-env.mjs",
      "scripts/verify-locally.mjs",
      "scripts/run-production-migrations.mjs",
    ]) {
      assert.ok(
        staticallyReached(entry).has("scripts/hosted-deployment.mjs"),
        entry,
      );
    }
  });

  test("drizzle.config.ts, the pg path's refusal and the package's entry reach packages/db/src/shared-databases.ts", () => {
    for (const entry of [
      "packages/db/drizzle.config.ts",
      "packages/db/src/database-url.ts",
      "packages/db/src/index.ts",
    ]) {
      assert.ok(
        staticallyReached(entry).has("packages/db/src/shared-databases.ts"),
        entry,
      );
    }
  });

  test("no tracked file imports or requires either module by a call, which a caller could catch", () => {
    const code = execFileSync("git", ["ls-files", "-z"], {
      cwd: repositoryRoot,
      maxBuffer: 1 << 28,
    })
      .toString()
      .split("\0")
      .filter((path) => /\.(?:[cm]?[jt]s|tsx)$/u.test(path));
    assert.ok(code.length > 100, `${code.length} code files listed`);
    const called =
      /\b(?:import|require)\s*\(\s*["'`][^"'`]*(?:hosted-deployment|shared-databases)/u;
    const offenders = code.filter((path) =>
      called.test(readFileSync(join(repositoryRoot, path), "utf8")),
    );
    assert.deepEqual(offenders, []);
  });
});

/*
 * The declaration `apps/web`'s tests read the marker through (manifest-j.md
 * §2.4 item 6): one file for both trees, so it must fit both variants and
 * hold nothing of either.
 */
describe("scripts/hosted-deployment.d.mts", () => {
  test("declares exactly the names both variants export, each a typed constant with no value, kind as either variant's", () => {
    const declaration = readFileSync(
      join(repositoryRoot, "scripts/hosted-deployment.d.mts"),
      "utf8",
    );
    const exports = [...declaration.matchAll(/^export\b.*$/gmu)].map(
      ([line]) => line,
    );
    const names = exports.map(
      (line) => /^export declare const (\w+): [^=]+$/u.exec(line)?.[1],
    );
    assert.ok(
      names.every(Boolean),
      `every export is a declared constant with a type and no value: ${exports.join(" | ")}`,
    );
    for (const [label, variant] of [
      ["scripts/hosted-deployment.mjs", hostedDeployment],
      ["scripts/hosted-deployment.public.mjs", publicVariant],
    ]) {
      assert.deepEqual(
        names.toSorted(),
        Object.keys(variant).toSorted(),
        label,
      );
    }
    assert.match(
      declaration,
      /^export declare const kind: "private" \| "public";$/mu,
    );
    assert.match(
      declaration,
      /^export declare const migrationState: string \| null;$/mu,
    );
  });
});
