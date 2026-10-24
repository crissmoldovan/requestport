import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  bundleProblems,
  published,
  publishedSubpaths,
} from "../apps/requestport/bundle.mjs";
import {
  ContainedModulesWebpackPlugin,
  SELF_HOST_CONTAINED_VARIABLE,
  writeContainedModules,
} from "../apps/requestport/src/web/contained-modules.ts";
import {
  seamMarkersIn,
  TEST_SEAMS,
} from "../apps/requestport/src/web/test-seams.ts";
import {
  privateDocComments,
  publicVariants,
} from "../packages/core/bundle.mjs";
import * as sharedDatabases from "../packages/db/src/shared-databases.ts";
import {
  checkRun,
  checkTarball,
  esbuildHelpersIn,
  noticesNameEsbuild,
  PACKAGES,
  privateDigests,
  repositoryRoot,
} from "./pack-packages.mjs";
import {
  buildWeb,
  bundledPackages,
  bundledSource,
  bundlerPackages,
  CLIENT,
  checkClientTarball,
  checkRequestportTarball,
  checkWebTarball,
  clientDependencies,
  clientEntries,
  confinementProblems,
  containedClosure,
  containedPackages,
  doneWhen12cProblems,
  E2E_OWNER_STORAGE,
  emitProblems,
  emittedPackages,
  importedPackages,
  inlinedWorkspaces,
  inputProblems,
  LOCKSTEP,
  layoutProblems,
  licenceComments,
  listedVendoredPackages,
  machinePathProblems,
  machinePaths,
  main,
  moduleCommentProblems,
  NEUTRAL_ROOT,
  NOTICES,
  nestedPackages,
  neutralRootProblems,
  noticesEntries,
  noticesProblems,
  outputGraph,
  ownLicenceCommentProblems,
  PLACEHOLDER_DATABASE_URL,
  pathForms,
  privateModuleBuildProblems,
  productionClosure,
  REQUESTPORT,
  readContained,
  readManifests,
  requestportDependencies,
  requestportManifest,
  runConfinementProblems,
  runtimeResolves,
  sourceMapOf,
  stageRequestport,
  stageWeb,
  staticExternals,
  TEST_ROUTES,
  testOnlyInput,
  thirdPartyNotices,
  tracedProblems,
  unaccountedLoads,
  VENDORED_COPIES,
  VERBATIM,
  verbatimPackages,
  WEB,
  WORKSPACE_SPECIFIER,
  webBuildEnvironment,
  webManifest,
} from "./pack-requestport.mjs";

/*
 * `scripts/pack-requestport.mjs` (Plan 13, H.7, slices a to d, and round 4's
 * slices c and d). The command, `main`, runs once, in this file's `before`,
 * into a temporary directory outside the repository: it is handed a clean
 * tree status, and a fixture tree of the self-host build's shape in place of
 * `next build` (the real build is the hand-run pack's, not this suite's).
 * That run stages `requestport`: its bundle, built by `stageBundle` with
 * every package it depends on left external, its dependency list, its
 * licence, its README and its packed manifest, and no third-party notices,
 * since it inlines no third-party code (ruling 197 item 4). It then stages
 * and packs G.7's eleven with G.7's own `stagePackage` and `checkTarball`;
 * `@requestport/web`, staged by `stageWeb` from the fixture, with its
 * licence, its third-party notices, for the packages the fixture's record
 * says the build contains (`next`; the React `next` keeps in its
 * `dist/compiled`, entered as vendored in it; `react-dom`; the serverless
 * PostgreSQL driver `db` depends on, with the licence comment of the code
 * it bundles; and `process`, which `WEB.beyondClosure` names; as this tree
 * installs them) and the two its
 * emitted files name (`geist`, whose font it copies, and `tailwindcss`,
 * whose banner its stylesheet carries), and its packed manifest;
 * `@requestport/client`, from `tsc`'s
 * emit; and `requestport`; then G.7's `checkRun` and
 * `runConfinementProblems` read the fourteen together. The suites read what
 * it staged and packed, and then each check the script's header lists, on
 * planted input or planted in the real tarballs' entries. Nothing here is
 * sent anywhere, and nothing builds Next: `buildWeb` is handed a runner that
 * writes a build's files.
 */

const scratch = mkdtempSync(join(tmpdir(), "pack-requestport-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const VERSION = "0.0.0-pack-requestport-test";

/**
 * The packed `repository` of the package built from `workspace`: the public
 * repository J question 5 names (ruling 175), in ruling 207 item 3's shape.
 * Written out here, not read from the scripts, so that a changed URL fails.
 */
function publicRepository(workspace) {
  return {
    type: "git",
    url: "git+https://github.com/crissmoldovan/requestport.git",
    directory: workspace,
  };
}

/** `main`'s run, and how many times it read the tree's status. */
let run;
let treeReads = 0;

/** The real tree's status, read before `main` and after it. */
const realStatus = {};

/**
 * `requestport`'s stage directory, the bundle `stageBundle` staged in it,
 * and `@requestport/web`'s stage directory.
 */
let STAGE;
let staged;
let WEB_STAGE;

function gitStatus() {
  return spawnSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).stdout;
}

function readJson(path) {
  return JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"));
}

before(async () => {
  realStatus.before = gitStatus();
  run = await main(["--version", VERSION, "--out", join(scratch, "out")], {
    treeStatus: () => {
      treeReads += 1;
      return "";
    },
    log: () => {},
    build: async () => standaloneFixture(join(scratch, "standalone-packed")),
  });
  realStatus.after = gitStatus();
  STAGE = run.packs.requestport.staged.directory;
  staged = run.packs.requestport.staged.bundle;
  WEB_STAGE = run.packs.web.staged.directory;
});

/**
 * `requestport`'s packed `dist/` in `<scratch>/<name>/node_modules`, beside
 * this run's `@requestport/domain` and `@requestport/client` and this
 * tree's `zod` and `uuid`, which `start`'s chunks link as they load, and no
 * `@requestport/web`: an install the web UI's package is missing from.
 * Answers the directory and the program.
 */
function packedWithoutWeb(name) {
  const root = join(scratch, name);
  const modules = join(root, "node_modules");
  const unpack = ({ entries: read }, into) => {
    for (const [path, body] of read) {
      const file = join(into, path.replace(/^package\//u, ""));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
  };
  unpack(run.packs.requestport, join(modules, "requestport"));
  unpack(run.packs.domain, join(modules, "@requestport", "domain"));
  unpack(run.packs.client, join(modules, "@requestport", "client"));
  for (const package_ of ["zod", "uuid"]) {
    symlinkSync(
      realpathSync(
        join(repositoryRoot, "packages/domain/node_modules", package_),
      ),
      join(modules, package_),
    );
  }
  const program = join(modules, "requestport", "dist", "requestport.js");
  assert.throws(
    () => createRequire(program).resolve("@requestport/web/package.json"),
    { code: "MODULE_NOT_FOUND" },
  );
  return { root, program };
}

/** The output, from the repository's root as the metafile keys it, that holds `input`. */
function outputHolding(input) {
  const found = Object.entries(staged.metafile.outputs).filter(([, output]) =>
    Object.hasOwn(output.inputs, input),
  );
  assert.equal(found.length, 1, `${input} is in exactly one output`);
  return found[0][0];
}

describe("requestport's bundle, staged outside the repository", () => {
  test("is split: the program is dist/requestport.js, whose first line is its hashbang, the operator child dist/operator.js, and every chunk is directly in dist/", () => {
    assert.ok(staged.javascript.includes("dist/requestport.js"));
    assert.ok(staged.javascript.includes("dist/operator.js"));
    const chunks = staged.javascript.filter((file) =>
      /^dist\/chunk-[^/]+\.js$/u.test(file),
    );
    assert.ok(chunks.length > 0, "the build is split into chunks");
    assert.deepEqual(
      staged.javascript.filter(
        (file) =>
          !chunks.includes(file) &&
          file !== "dist/requestport.js" &&
          file !== "dist/operator.js",
      ),
      [],
    );
    assert.match(
      readFileSync(join(STAGE, "dist/requestport.js"), "utf8"),
      /^#!\/usr\/bin\/env node\n/u,
    );
  });

  test("--version and --help run from the staged dist/ with nothing installed: the program links no package, RequestPort's or a third party's, before a command loads, and --version prints the version the pack stamped in the packed manifest beside dist/ (ruling 158, 19)", () => {
    assert.deepEqual(
      staticExternals(
        staged.metafile,
        outputHolding("apps/requestport/src/main.ts"),
      ),
      [],
    );
    // Nothing installed: no node_modules beside the stage or above it.
    for (
      let directory = realpathSync(STAGE);
      directory !== dirname(directory);
      directory = dirname(directory)
    ) {
      assert.equal(
        existsSync(join(directory, "node_modules")),
        false,
        `${directory} holds a node_modules`,
      );
    }
    assert.equal(
      JSON.parse(readFileSync(join(STAGE, "package.json"), "utf8")).version,
      VERSION,
    );
    const program = (argument) =>
      spawnSync(
        process.execPath,
        [join(STAGE, "dist/requestport.js"), argument],
        {
          cwd: STAGE,
          encoding: "utf8",
          env: { PATH: process.env.PATH },
        },
      );
    const version = program("--version");
    assert.equal(version.stderr, "");
    assert.equal(version.status, 0);
    assert.equal(version.stdout, `requestport ${VERSION}\n`);
    const help = program("--help");
    assert.equal(help.stderr, "");
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: requestport <command> \[options\]\n/u);
  });

  test("start --help prints start's usage and exits 0 where @requestport/web does not resolve: requestport's packed dist/, beside this run's @requestport/domain and @requestport/client and this tree's zod and uuid, which start's chunks link as they load, and no @requestport/web; start looks it up when it starts, not as its chunk loads (ruling 197; finding 2)", () => {
    const { root, program } = packedWithoutWeb("start-help");
    const help = spawnSync(process.execPath, [program, "start", "--help"], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(help.stderr, "");
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: requestport start \[options\]\n/u);
  });

  test("a first start refuses through its own path where @requestport/web does not resolve, before it makes the data directory or writes anything: exit 1, SelfHostWebError's one line naming where it looked, no stack trace, nothing on standard output, where a first start prints the one-time credential, and no data directory (H.7 round 5's review)", () => {
    const { root, program } = packedWithoutWeb("start-refused");
    const dataDirectory = join(root, "data");
    const refused = spawnSync(
      process.execPath,
      [
        program,
        "start",
        "--storage",
        "pglite",
        "--data-dir",
        dataDirectory,
        "--email",
        "owner@example.com",
        "--organization",
        "acme",
        "--organization-name",
        "Acme",
      ],
      { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    assert.equal(
      refused.stderr,
      `requestport start: SelfHostWebError: requestport start serves the web UI from @requestport/web, and ${realpathSync(dirname(program))} cannot resolve it (Cannot find module '@requestport/web/package.json'). requestport depends on @requestport/web, which carries it; install requestport again.\n`,
    );
    assert.equal(refused.stdout, "");
    assert.equal(refused.status, 1);
    assert.equal(existsSync(dataDirectory), false);
  });

  test("holds no migrations/: the operator applies the ones @requestport/db carries, from db's own dist/ (packagedMigrationsFolder), which the bundle does not inline; cli.ts reaches ../package.json and operator/command.ts the operator entry as ./operator.js", () => {
    assert.equal(existsSync(join(STAGE, "migrations")), false);
    assert.equal(Object.hasOwn(staged, "migrations"), false);
    assert.equal(Object.hasOwn(REQUESTPORT, "migrations"), false);
    for (const input of [
      "packages/db/src/migrate.ts",
      "packages/db/src/operator-session.ts",
    ]) {
      assert.equal(staged.inputs.includes(input), false, input);
    }
    const from = (input, target) =>
      resolve(dirname(resolve(repositoryRoot, outputHolding(input))), target);
    assert.equal(
      realpathSync(
        dirname(from("apps/requestport/src/cli.ts", "../package.json")),
      ),
      realpathSync(STAGE),
    );
    const command = "apps/requestport/src/operator/command.ts";
    assert.equal(
      realpathSync(from(command, "./operator.js")),
      realpathSync(join(STAGE, "dist/operator.js")),
    );
    assert.match(
      readFileSync(resolve(repositoryRoot, outputHolding(command)), "utf8"),
      /"\.\/operator\.js"/u,
    );
  });

  test("inlines apps/requestport's modules alone (ruling 190: the 286 of 325 module comments of other workspaces that H.7's round 4 survey counted are gone), none only a test reaches, and imports each package it depends on by a subpath that package publishes", () => {
    assert.ok(staged.inputs.length > 20, `${staged.inputs.length} inputs`);
    assert.deepEqual(
      staged.inputs.filter((input) => !input.startsWith("apps/requestport/")),
      [],
    );
    assert.deepEqual(staged.inputs.filter(testOnlyInput), []);
    assert.deepEqual(inputProblems(staged.inputs), []);
    assert.deepEqual(bundleProblems(staged.metafile), []);
    for (const file of staged.javascript) {
      assert.deepEqual(
        moduleCommentProblems(file, readFileSync(join(STAGE, file), "utf8")),
        [],
        file,
      );
    }
    const subpaths = publishedSubpaths();
    const imported = [
      ...new Set(
        Object.values(staged.metafile.outputs).flatMap(({ imports }) =>
          imports
            .filter(
              ({ external, path }) =>
                external && path.startsWith("@requestport/"),
            )
            .map(({ path }) => path),
        ),
      ),
    ].sort();
    assert.ok(imported.length > 10, imported.join(", "));
    for (const specifier of imported) {
      const name = specifier.split("/").slice(0, 2).join("/");
      const subpath =
        specifier === name ? "." : `.${specifier.slice(name.length)}`;
      assert.ok(published.includes(name), specifier);
      assert.ok(subpaths.get(name).includes(subpath), specifier);
    }
  });

  test("carries no E2E owner storage: no file of dist/ holds G.7's pattern (ruling 170); db's module of it is db's, whose tarball G.7's check refuses it in", () => {
    assert.ok(staged.javascript.length > 2, "the bundle has chunks to read");
    for (const file of staged.javascript) {
      assert.equal(
        E2E_OWNER_STORAGE.test(readFileSync(join(STAGE, file), "utf8")),
        false,
        `${file} holds the E2E owner storage`,
      );
    }
    assert.equal(
      staged.inputs.includes("packages/db/src/e2e-owner-storage.ts"),
      false,
    );
  });

  test("carries none of the three test seams (ruling 174): no file of dist/ holds a marker of auth's E2E outbox, apps/web's fault register or the CSP's E2E fence, and no seam's module, real or inert, is an input: the real ones are other workspaces', and server's tarball carries the fence's inert module", () => {
    assert.ok(staged.javascript.length > 2, "the bundle has chunks to read");
    for (const file of staged.javascript) {
      assert.deepEqual(
        seamMarkersIn(readFileSync(join(STAGE, file), "utf8")).map(
          ({ seam, marker }) => `${seam.name} (${marker})`,
        ),
        [],
        `${file} holds a test seam`,
      );
    }
    for (const { real, inert } of TEST_SEAMS) {
      assert.equal(real.startsWith("apps/requestport/"), false, real);
      assert.equal(staged.inputs.includes(real), false, `${real} is inlined`);
      assert.equal(staged.inputs.includes(inert), false, `${inert} is inlined`);
    }
  });

  test("reaches neither the self-host build's module nor the seams' module: serve/web.ts takes SELF_HOST_DIST_DIR from self-host-dist-dir.ts, which imports nothing, so no input of the bundle is self-host-build.ts or test-seams.ts (ruling 190, minor 3)", () => {
    const outside = [
      "apps/requestport/src/web/self-host-build.ts",
      "apps/requestport/src/web/test-seams.ts",
    ];
    assert.deepEqual(
      staged.inputs.filter((input) => outside.includes(input)),
      [],
    );
    assert.ok(
      staged.inputs.includes("apps/requestport/src/web/self-host-dist-dir.ts"),
      "self-host-dist-dir.ts is an input",
    );
  });

  test("its run-time list is next and @requestport/web, which only a run-time require or .resolve() reaches: next through serve/web.ts's bound requireFromBuild, and @requestport/web through serve/web.ts's .resolve() of its package.json, packed (ruling 193 item 4); pg and PGlite, which db's client.ts loads so, are db's, which the bundle does not inline", () => {
    assert.deepEqual(REQUESTPORT.runtime, ["next", "@requestport/web"]);
    assert.deepEqual(REQUESTPORT.fromWeb, ["next"]);
    for (const name of REQUESTPORT.runtime) {
      assert.equal(
        staged.external.includes(name),
        false,
        `${name} is not in the metafile`,
      );
    }
    const loads = { requires: staged.requires, resolves: staged.resolves };
    assert.deepEqual(
      [...new Set(staged.requires.map(({ module }) => module))],
      ["apps/requestport/src/serve/web.ts"],
    );
    assert.ok(
      staged.requires.some(({ specifier }) => specifier === "next"),
      "serve/web.ts requires next",
    );
    assert.deepEqual(staged.resolves, [
      {
        module: "apps/requestport/src/serve/web.ts",
        specifier: "@requestport/web/package.json",
      },
    ]);
    assert.deepEqual(
      unaccountedLoads(loads, {
        external: staged.external,
        runtime: REQUESTPORT.runtime,
      }),
      [],
    );
    assert.deepEqual(
      unaccountedLoads(loads, {
        external: staged.external,
        runtime: ["pg", ...REQUESTPORT.runtime],
      }),
      [
        "the run-time list names pg, which no module of the bundle requires or resolves at run time",
      ],
    );
    assert.deepEqual(
      unaccountedLoads(loads, {
        external: staged.external,
        runtime: ["next"],
      }),
      [
        "apps/requestport/src/serve/web.ts resolves @requestport/web/package.json at run time, and @requestport/web is neither one of the bundle's externals nor on the run-time list",
      ],
    );
    assert.deepEqual(
      unaccountedLoads(loads, {
        external: staged.external,
        runtime: ["@requestport/web"],
      }),
      [
        "apps/requestport/src/serve/web.ts requires next at run time, and next is neither one of the bundle's externals nor on the run-time list",
        "apps/requestport/src/serve/web.ts requires next/dist/server/config.js at run time, and next is neither one of the bundle's externals nor on the run-time list",
        "apps/requestport/src/serve/web.ts requires next/dist/shared/lib/constants.js at run time, and next is neither one of the bundle's externals nor on the run-time list",
      ],
    );
  });

  test("@requestport/jobs, whose index registers the worker root as it loads, is imported by the worker command's output alone, which cli.ts's output alone imports, dynamically", () => {
    assert.deepEqual(
      confinementProblems(staged.metafile, REQUESTPORT.confined),
      [],
    );
    const graph = outputGraph(staged.metafile);
    const worker = resolve(
      repositoryRoot,
      outputHolding(REQUESTPORT.confined.command),
    );
    const importers = [...graph]
      .filter(([, { imports }]) => imports.some(({ path }) => path === worker))
      .map(([path, { imports }]) => [
        path,
        imports.filter(({ path: imported }) => imported === worker),
      ]);
    assert.deepEqual(importers, [
      [
        resolve(repositoryRoot, outputHolding(REQUESTPORT.confined.importer)),
        [{ path: worker, dynamic: true }],
      ],
    ]);
    assert.deepEqual(
      [...graph]
        .filter(([, { externals }]) =>
          externals.some(
            ({ specifier }) => specifier === REQUESTPORT.confined.specifier,
          ),
        )
        .map(([path]) => path),
      [worker],
    );
  });
  test("serve/web.ts's output finds the web UI as @requestport/web's directory, where its package.json resolves from dist/, not as ../web: requestport's stage holds no web/ (ruling 193 item 4)", () => {
    const web = "apps/requestport/src/serve/web.ts";
    const output = resolve(repositoryRoot, outputHolding(web));
    const text = readFileSync(output, "utf8");
    assert.match(text, /\.resolve\("@requestport\/web\/package\.json"\)/u);
    assert.doesNotMatch(text, /"\.\.\/web"/u);
    assert.equal(existsSync(join(STAGE, "web")), false);
    assert.ok(existsSync(join(WEB_STAGE, "server.js")));
  });

  test("its dependency list is its three third-party externals and PGlite, each at the version apps/requestport declares, zod among them whatever auth declares; the eight packages of RequestPort's it imports are of LOCKSTEP, which the manifest names; not next, which it loads from @requestport/web's directory (ruling 193 item 4)", () => {
    const { dependencies, problems } = requestportDependencies({
      inputs: staged.inputs,
      external: staged.external,
    });
    assert.deepEqual(problems, []);
    const own = staged.external.filter((name) =>
      name.startsWith("@requestport/"),
    );
    const thirdParty = staged.external.filter(
      (name) => !name.startsWith("@requestport/"),
    );
    assert.deepEqual(thirdParty, [
      "@modelcontextprotocol/client",
      "@modelcontextprotocol/server",
      "zod",
    ]);
    assert.deepEqual(own, [
      "@requestport/auth",
      "@requestport/client",
      "@requestport/config",
      "@requestport/core",
      "@requestport/db",
      "@requestport/domain",
      "@requestport/jobs",
      "@requestport/server",
    ]);
    for (const name of own) assert.ok(LOCKSTEP.includes(name), name);
    assert.deepEqual(
      Object.keys(dependencies),
      [...thirdParty, ...REQUESTPORT.declared].sort(),
    );
    const declared = readJson("apps/requestport/package.json").dependencies;
    for (const [name, version] of Object.entries(dependencies)) {
      assert.equal(version, declared[name], name);
      assert.doesNotMatch(version, /^workspace:/u, name);
    }
    assert.deepEqual(REQUESTPORT.declared, ["@electric-sql/pglite"]);
    for (const name of ["next", "react", "react-dom", "pg", WEB.published]) {
      assert.equal(Object.hasOwn(dependencies, name), false, name);
    }
  });
});

describe("the checks, on planted input", () => {
  test("runtimeResolves reads .resolve() on a createRequire binding, imported under another name or through a namespace, or getBuiltinModule's, and on a factory called in place; not a call through the binding, nor another object's resolve", async () => {
    const module = join(scratch, "resolves.ts");
    writeFileSync(
      module,
      [
        'import { resolve as resolvePath } from "node:path";',
        'import { createRequire as make } from "node:module";',
        'import * as nodeModule from "node:module";',
        "const one = make(import.meta.url);",
        'export const a = one.resolve("alpha/sub");',
        'export const b = nodeModule.createRequire(import.meta.url).resolve("beta") as string;',
        'export const c = process.getBuiltinModule("node:module").createRequire(import.meta.url).resolve("gamma");',
        'export const d = make(import.meta.url).resolve("tsx/esm");',
        'export const e = one.resolve("./local.js");',
        'const name = "delta";',
        "export const f = one.resolve(name);",
        'export const g = one("epsilon");',
        'export const h = Promise.resolve("zeta");',
        'export const i = resolvePath("eta");',
        "",
      ].join("\n"),
    );
    const resolves = await runtimeResolves([module]);
    assert.deepEqual(resolves, [
      { module, specifier: "./local.js" },
      { module, specifier: "alpha/sub" },
      { module, specifier: "beta" },
      { module, specifier: "gamma" },
      { module, specifier: "tsx/esm" },
      { module, specifier: undefined },
    ]);
    assert.deepEqual(
      unaccountedLoads(
        { requires: [], resolves },
        { external: ["alpha", "beta"], runtime: ["gamma"] },
      ),
      [
        `${module} resolves the path ./local.js at run time, which the package does not carry`,
        `${module} resolves tsx/esm at run time, and tsx is neither one of the bundle's externals nor on the run-time list`,
        `${module} resolves something that is not a string literal`,
      ],
    );
  });

  test("unaccountedLoads refuses a run-time list entry that nothing requires or resolves, and a required path or unreadable call", () => {
    const module = "packages/x/src/a.ts";
    assert.deepEqual(
      unaccountedLoads(
        {
          requires: [
            { module, specifier: "pg" },
            { module, specifier: "../b.js" },
            { module, specifier: undefined },
            { module, specifier: "node:fs" },
          ],
          resolves: [],
        },
        { external: [], runtime: ["pg", "next"] },
      ),
      [
        `${module} requires the path ../b.js at run time, which the package does not carry`,
        `${module} requires something that is not a string literal`,
        "the run-time list names next, which no module of the bundle requires or resolves at run time",
      ],
    );
  });

  test("inputProblems refuses a test, test support, a test's entry, a global setup, db's test pool module, the sweep's ledger, and a module that is not apps/requestport's: another workspace's, the roots' among them, or one outside the repository", () => {
    const refused = [
      "apps/requestport/src/cli.test.ts",
      "apps/requestport/src/login.integration.test.ts",
      "packages/db/src/test-support/fixtures.ts",
      "apps/requestport/src/start/start.test-entry.ts",
      "apps/requestport/src/web/self-host-build.global-setup.ts",
      "packages/db/src/testing.ts",
      "packages/db/src/tenant-scope-sweep.ts",
    ];
    const outside = [
      "packages/db/src/wiring.ts",
      "packages/jobs/src/index.ts",
      "packages/config/src/server.ts",
      "packages/db/src/shared-databases.ts",
      "apps/web/src/lib/server-request-port.ts",
      "spikes/h0-probe/k8-requestport.mts",
      "../../outside/entry.mjs",
      "/opt/build/entry.ts",
      "apps/requestport/node_modules/zod/index.js",
    ];
    const allowed = [
      "apps/requestport/src/cli.ts",
      "apps/requestport/src/worker.ts",
      "apps/requestport/src/serve/serve.ts",
    ];
    assert.deepEqual(inputProblems([...refused, ...outside, ...allowed]), [
      ...refused.map(
        (input) => `the bundle inlines ${input}, which only a test reaches`,
      ),
      ...outside.map(
        (input) =>
          `the bundle inlines ${input}, which is not one of apps/requestport's modules`,
      ),
    ]);
  });

  test("the bundle refuses, on a planted metafile, an input of another workspace, an @requestport/* import of a package that no tarball of the run is, and one of a subpath its package does not publish; each package it leaves external is published, the client's subpaths its source manifest's", () => {
    const metafile = {
      inputs: {
        "apps/requestport/src/cli.ts": {},
        "packages/db/src/client.ts": {},
        "apps/web/src/lib/x.ts": {},
      },
      outputs: {
        "dist/requestport.js": {
          imports: [
            {
              path: "@requestport/db",
              kind: "import-statement",
              external: true,
            },
            {
              path: "@requestport/db/testing",
              kind: "import-statement",
              external: true,
            },
            {
              path: "@requestport/config/redaction",
              kind: "dynamic-import",
              external: true,
            },
            {
              path: "@requestport/theme",
              kind: "import-statement",
              external: true,
            },
            {
              path: "@requestport/client/oauth",
              kind: "import-statement",
              external: true,
            },
            { path: "zod", kind: "import-statement", external: true },
            { path: "dist/chunk-A.js", kind: "import-statement" },
          ],
        },
      },
    };
    assert.deepEqual(bundleProblems(metafile), [
      "inlines apps/web/src/lib/x.ts, a module of @requestport/web",
      "inlines packages/db/src/client.ts, a module of @requestport/db",
      "imports @requestport/config/redaction, which @requestport/config does not publish",
      "imports @requestport/db/testing, which @requestport/db does not publish",
      "imports @requestport/theme, and no tarball of the run is @requestport/theme",
    ]);
    assert.deepEqual(
      [...published].sort(),
      [
        ...Object.values(PACKAGES).map(({ bundle }) => bundle.package),
        "@requestport/client",
      ].sort(),
    );
    assert.deepEqual(
      publishedSubpaths().get("@requestport/client"),
      Object.keys(readJson("packages/client/package.json").exports),
    );
    for (const { bundle } of Object.values(PACKAGES)) {
      assert.deepEqual(
        publishedSubpaths().get(bundle.package),
        bundle.entries.map(({ subpath }) => subpath),
      );
    }
  });

  test("confinementProblems refuses an output importing @requestport/jobs, statically or dynamically, that an entry reaches but through cli.ts's dynamic import of worker.ts's output, and a metafile in which the check could not fire", () => {
    const out = (name) => `planted/dist/${name}.js`;
    const jobs = (kind = "import-statement") => ({
      path: "@requestport/jobs",
      kind,
      external: true,
    });
    const metafile = ({
      startImportsWorker = false,
      startImportsJobs = undefined,
    } = {}) => ({
      outputs: {
        [out("requestport")]: {
          entryPoint: "apps/requestport/src/main.ts",
          inputs: { "apps/requestport/src/main.ts": {} },
          imports: [{ path: out("chunk-cli"), kind: "import-statement" }],
        },
        [out("chunk-cli")]: {
          inputs: { "apps/requestport/src/cli.ts": {} },
          imports: [
            { path: out("chunk-start"), kind: "dynamic-import" },
            { path: out("chunk-worker"), kind: "dynamic-import" },
          ],
        },
        [out("chunk-start")]: {
          inputs: { "apps/requestport/src/start/start.ts": {} },
          imports: [
            ...(startImportsWorker
              ? [{ path: out("chunk-worker"), kind: "import-statement" }]
              : []),
            ...(startImportsJobs === undefined ? [] : [jobs(startImportsJobs)]),
            {
              path: "@requestport/jobs/worker",
              kind: "import-statement",
              external: true,
            },
          ],
        },
        [out("chunk-worker")]: {
          inputs: { "apps/requestport/src/worker.ts": {} },
          imports: [
            jobs(),
            { path: "zod", kind: "import-statement", external: true },
          ],
        },
        [out("operator")]: {
          entryPoint: "apps/requestport/src/operator/entry.ts",
          inputs: { "apps/requestport/src/operator/entry.ts": {} },
          imports: [],
        },
      },
    });
    const reachable = (output) =>
      `dist/${output}.js imports @requestport/jobs and is reachable from apps/requestport/src/main.ts other than through apps/requestport/src/cli.ts's dynamic import of apps/requestport/src/worker.ts`;
    assert.deepEqual(confinementProblems(metafile(), REQUESTPORT.confined), []);
    assert.deepEqual(
      confinementProblems(
        metafile({ startImportsWorker: true }),
        REQUESTPORT.confined,
      ),
      [reachable("chunk-worker")],
    );
    assert.deepEqual(
      confinementProblems(
        metafile({ startImportsJobs: "import-statement" }),
        REQUESTPORT.confined,
      ),
      [reachable("chunk-start")],
    );
    assert.deepEqual(
      confinementProblems(
        metafile({ startImportsJobs: "dynamic-import" }),
        REQUESTPORT.confined,
      ),
      [reachable("chunk-start")],
    );
    const statically = metafile();
    statically.outputs[out("chunk-cli")].imports[1].kind = "import-statement";
    assert.deepEqual(confinementProblems(statically, REQUESTPORT.confined), [
      "apps/requestport/src/cli.ts's output does not import apps/requestport/src/worker.ts's dynamically",
      reachable("chunk-worker"),
    ]);
    const unimported = metafile();
    unimported.outputs[out("chunk-worker")].imports = [];
    assert.deepEqual(confinementProblems(unimported, REQUESTPORT.confined), [
      "apps/requestport/src/worker.ts's output does not import @requestport/jobs, so the worker's check cannot fire",
    ]);
    const missing = metafile();
    delete missing.outputs[out("chunk-worker")];
    assert.deepEqual(confinementProblems(missing, REQUESTPORT.confined), [
      "apps/requestport/src/worker.ts is in no output, so the worker's check cannot fire",
    ]);
  });

  test("layoutProblems refuses an output that is not directly in dist/, and an entry written under another name", () => {
    const directory = join(scratch, "layout");
    for (const file of [
      "dist/requestport.js",
      "dist/program.js",
      "dist/sub/chunk-A.js",
    ]) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), "");
    }
    const key = (file) => relative(repositoryRoot, join(directory, file));
    const metafile = {
      outputs: {
        [key("dist/requestport.js")]: {
          entryPoint: "apps/requestport/src/main.ts",
          inputs: {},
          imports: [],
        },
        [key("dist/program.js")]: {
          entryPoint: "apps/requestport/src/operator/entry.ts",
          inputs: {},
          imports: [],
        },
        [key("dist/sub/chunk-A.js")]: { inputs: {}, imports: [] },
      },
    };
    assert.deepEqual(layoutProblems(metafile, directory), [
      `${join(directory, "dist/sub/chunk-A.js")} is not directly in ${realpathSync(join(directory, "dist"))}`,
      "the entry apps/requestport/src/operator/entry.ts is not dist/operator.js",
    ]);
  });

  test("moduleCommentProblems refuses a module comment naming an absolute path, one that climbs out of the repository, a module only a test reaches, or a module of another workspace than apps/requestport; machinePathProblems this machine's paths", () => {
    const text = [
      "// apps/requestport/src/cli.ts",
      "// packages/db/src/client.ts",
      "// packages/db/src/shared-databases.ts",
      "// packages/jobs/src/worker-root.ts",
      "// /opt/build/requestport/entry.ts",
      "// ../../../private/tmp/scratch/entry.mjs",
      "// apps/requestport/src/start/start.test-entry.ts",
      "// packages/db/src/test-support/fixtures.ts",
      "",
    ].join("\n");
    assert.deepEqual(moduleCommentProblems("dist/chunk-A.js", text), [
      "dist/chunk-A.js inlines packages/db/src/client.ts, which is not one of apps/requestport's modules",
      "dist/chunk-A.js inlines packages/db/src/shared-databases.ts, which is not one of apps/requestport's modules",
      "dist/chunk-A.js inlines packages/jobs/src/worker-root.ts, which is not one of apps/requestport's modules",
      "dist/chunk-A.js names a module outside the repository: /opt/build/requestport/entry.ts",
      "dist/chunk-A.js names a module outside the repository: ../../../private/tmp/scratch/entry.mjs",
      "dist/chunk-A.js inlines apps/requestport/src/start/start.test-entry.ts, which only a test reaches",
      "dist/chunk-A.js inlines packages/db/src/test-support/fixtures.ts, which only a test reaches",
    ]);
    const directory = mkdtempSync(join(scratch, "machine-"));
    const paths = machinePaths(directory);
    for (const path of [repositoryRoot, realpathSync(tmpdir()), directory]) {
      assert.ok(
        paths.includes(path.replace(/\/+$/u, "")),
        `${path} is a machine path`,
      );
    }
    const inlined = machinePathProblems(
      "dist/chunk-B.js",
      `const here = "${pathToUrl(join(repositoryRoot, "packages/db/src/migrate.ts"))}";`,
      paths,
    );
    assert.ok(
      inlined.includes(`dist/chunk-B.js holds ${repositoryRoot}`),
      inlined.join("; "),
    );
    const staging = machinePathProblems(
      "dist/chunk-C.js",
      `const there = "${join(realpathSync(directory), "dist")}";`,
      paths,
    );
    assert.ok(
      staging.includes(`dist/chunk-C.js holds ${realpathSync(directory)}`),
      staging.join("; "),
    );
    assert.deepEqual(
      machinePathProblems("dist/chunk-D.js", "const x = 1;", paths),
      [],
    );
  });
});

/** A file URL, as an inlined `import.meta.url` would carry it. */
function pathToUrl(path) {
  return `file://${path}`;
}

/** Writes `files`, by path from `root`, each a string or a `Buffer`. */
function writeTree(root, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

/**
 * A font `geist` ships, `dist/fonts/geist-sans/Geist-Variable.woff2`, as
 * `next/font/local` copies it into `static/media` byte for byte: a binary
 * file, with NUL bytes, that `emittedPackages` attributes to `geist`, a
 * package of `apps/web`'s production closure (H.7 round 5's packs).
 */
const FONT = readFileSync(
  join(installedForWeb("geist"), "dist/fonts/geist-sans/Geist-Variable.woff2"),
);

/**
 * A stylesheet of `static/css` under the licence banner Tailwind writes, for
 * the `tailwindcss` this tree installs for `apps/web`, as the real build's
 * carries it: `emittedPackages` attributes it to `tailwindcss`.
 */
const STYLESHEET = `/*! tailwindcss v${
  JSON.parse(
    readFileSync(join(installedForWeb("tailwindcss"), "package.json"), "utf8"),
  ).version
} | MIT License | https://tailwindcss.com */\n.menu{display:flex}\n`;

/** The module id of a client component, as webpack writes it: the checkout's path. */
const CLIENT_MODULE = `${repositoryRoot}/apps/web/src/components/menu.tsx`;

const NEXT_ENTRY = "node_modules/.pnpm/next@16.3.8_react@19.2.8/node_modules";

/**
 * The files the reviewed list (`VERBATIM`) names, as the real build copies
 * them, by their paths from the fixture build's `apps/web`: each the bytes of
 * its holder's file as this tree installs it, at the name the build gives it
 * (`polyfills-<hash>.js`, `static/<build id>/_ssgManifest.js`).
 */
const VERBATIM_COPIES = Object.freeze(
  Object.fromEntries(
    VERBATIM.files.map(({ holder, path, emitted }) => [
      join(
        ".next-self-host",
        emitted
          .replace("<hash>", "0123456789abcdef")
          .replace("<build id>", "fixture-build"),
      ),
      readFileSync(join(installedForWeb(holder), path)),
    ]),
  ),
);

/**
 * A self-host build's standalone tree in `root`, of the shape H.5's build
 * leaves (H.7's survey): Next's trace under `node_modules`, the repository's
 * root manifest and a traced source, and `apps/web` with `apps/web`'s
 * manifest, `server.js`, `.next-self-host` and a traced JSON file. The
 * checkout's path is where the real build has it: `server.js`'s and
 * `required-server-files.json`'s configuration, a client component's module
 * id in a page and its client-reference manifest, and a chunk's inlined
 * `import.meta.url`, once as a `file://` URL and once with JSON's `\/`.
 * What it emits outside its chunks is there too: a font `geist` ships in
 * `static/media` (`FONT`), a stylesheet under Tailwind's banner in
 * `static/css` (`STYLESHEET`), and the two files of `next`'s the reviewed
 * list names, which the build copies as they are (`VERBATIM_COPIES`). `planted` adds or replaces files, and
 * `omitted` leaves files out. Answers it as `buildWeb` would, with
 * `contained` as what the build says it contains (`FIXTURE_CONTAINED`,
 * unless a case hands another).
 */
function standaloneFixture(
  root,
  { planted = {}, omitted = [], contained = FIXTURE_CONTAINED } = {},
) {
  const files = {
    "package.json": '{"name":"requestport","private":true}\n',
    "packages/db/src/migrate.ts": "export {};\n",
    [`${NEXT_ENTRY}/next/package.json`]: '{"name":"next"}\n',
    [`${NEXT_ENTRY}/@swc/helpers/package.json`]: '{"name":"@swc/helpers"}\n',
    "node_modules/.pnpm/react@19.2.8/node_modules/react/package.json":
      '{"name":"react"}\n',
    "node_modules/.pnpm/react-dom@19.2.8_react@19.2.8/node_modules/react-dom/package.json":
      '{"name":"react-dom"}\n',
    "node_modules/.pnpm/sharp@0.35.3/node_modules/@img/sharp-linux-x64/package.json":
      '{"name":"@img/sharp-linux-x64"}\n',
    "apps/web/package.json": `${JSON.stringify({
      name: "@requestport/web",
      private: true,
      type: "module",
      scripts: { build: "next build" },
      dependencies: { "@requestport/core": "workspace:*", next: "16.3.8" },
    })}\n`,
    "apps/web/server.js": `const nextConfig = ${JSON.stringify({ distDir: ".next-self-host", outputFileTracingRoot: repositoryRoot })};\n`,
    "apps/web/.next-self-host/package.json": '{"type": "commonjs"}',
    "apps/web/.next-self-host/required-server-files.json": JSON.stringify({
      config: {
        output: "standalone",
        distDir: ".next-self-host",
        outputFileTracingRoot: repositoryRoot,
      },
      appDir: `${repositoryRoot}/apps/web`,
      relativeAppDir: "apps/web",
    }),
    "apps/web/.next-self-host/server/app/page.js": `registerClientReference(function () {}, ${JSON.stringify(CLIENT_MODULE)}, "Menu");\n`,
    "apps/web/.next-self-host/server/app/page_client-reference-manifest.js": `globalThis.__RSC_MANIFEST["/page"] = ${JSON.stringify({ clientModules: { [CLIENT_MODULE]: { id: 17, name: "*", chunks: [] } } })};\n`,
    "apps/web/.next-self-host/server/chunks/42.js": [
      `const migrations = new URL("../migrations", ${JSON.stringify(pathToFileURL(join(repositoryRoot, "packages/db/src/migrate.ts")).href)});`,
      `const escaped = "${repositoryRoot.replaceAll("/", "\\/")}\\/apps\\/web";`,
      "",
    ].join("\n"),
    "apps/web/.next-self-host/static/media/font.woff2": FONT,
    "apps/web/.next-self-host/static/css/app.css": STYLESHEET,
    "apps/web/src/app/docs/api/generated/openapi.json": '{"openapi":"3.1.0"}\n',
    ...Object.fromEntries(
      Object.entries(VERBATIM_COPIES).map(([path, body]) => [
        `apps/web/${path}`,
        body,
      ]),
    ),
    ...planted,
  };
  for (const path of omitted) delete files[path];
  writeTree(root, files);
  mkdirSync(join(root, "apps/web/node_modules"), { recursive: true });
  symlinkSync(
    `../../../${NEXT_ENTRY}/next`,
    join(root, "apps/web/node_modules/next"),
  );
  return {
    standaloneDirectory: root,
    serverDirectory: join(root, "apps/web"),
    contained,
  };
}

/**
 * What G.7's `checkTarball` must report of `file` once `text` is planted in
 * it: each path of this machine its check reads (`machinePaths(directory)`,
 * for `directory` the stage's), which `text` holds in any form a build
 * writes, named by the first form it holds in this order: as written, with
 * JSON's `\/`, as a `file://` URL's path, and percent-encoded whole. Which
 * paths those are depends on where the checkout is, so a case planting the
 * checkout's or the home directory's path expects them from here, not by
 * name: the home directory when the checkout is under it, and the temporary
 * directory, as given and as resolved, when it is under that (ruling 152).
 * A path of one segment, as `/tmp` is, is held as written by the
 * JSON-escaped text of a path under it: `\/private\/tmp` holds `/tmp`.
 */
function heldMachinePaths(file, text, directory) {
  const forms = [
    (path) => path,
    (path) => path.replaceAll("/", "\\/"),
    (path) => pathToFileURL(path).pathname,
    (path) => encodeURIComponent(path),
  ];
  return machinePaths(directory).flatMap((path) => {
    const held = forms
      .map((form) => form(path))
      .find((form) => text.includes(form));
    if (held === undefined) return [];
    return [
      held === path
        ? `${file} holds ${path}`
        : `${file} holds ${path}, as ${held}`,
    ];
  });
}

/** A package of `apps/web`'s, by the real directory this tree installs it in. */
function installedForWeb(name) {
  return realpathSync(join(repositoryRoot, "apps/web/node_modules", name));
}

/**
 * The packages of `@requestport/db`'s dependencies whose `index.mjs` bundles
 * other packages' code and names them in a bundler's licence comment, as
 * this tree installs them: packages of `apps/web`'s production closure.
 * Found by what they carry, not by name: the public tree's denylist keeps
 * the driver's name out of `scripts/` (`release/denylist.json`).
 *
 * What is expected is read from the manifest the tree holds (ruling 208
 * item 2): the dependencies `packages/db/package.json` declares beyond
 * `packages/db/package.public.json`. In the private tree that is one, the
 * serverless PostgreSQL driver the hosted deployment runs on, which bundles
 * `buffer` and `ieee754`. In the public seed `package.json` is
 * `package.public.json`'s bytes (J.5's substitution), so none is expected
 * there. In either tree, any other finding fails the assertion as this
 * module is evaluated.
 */
function installedBundlers() {
  const declared = (path) => Object.keys(readJson(path).dependencies);
  const held = declared("packages/db/package.json");
  const shared = declared("packages/db/package.public.json");
  const installed = (name) =>
    realpathSync(join(repositoryRoot, "packages/db/node_modules", name));
  const found = held.filter((name) => {
    const file = join(installed(name), "index.mjs");
    return (
      existsSync(file) &&
      readFileSync(file, "utf8").includes("/*! Bundled license information:")
    );
  });
  assert.deepEqual(
    found,
    held.filter((name) => !shared.includes(name)),
  );
  return found.map(installed);
}

/**
 * `@modelcontextprotocol/server`, as this tree installs it for `packages/mcp`
 * (a package of `apps/web`'s production closure), and the two files of its
 * `dist` whose source maps name the packages they bundle, which no
 * bundler's licence comment names: `src-*.mjs` (`content-type`, whose own
 * `/*!` copyright banner it keeps, a licence comment the notices carry under
 * the server's entry) and `ajvProvider-*.mjs` (`ajv`, `ajv-formats`,
 * `fast-deep-equal`, `fast-uri`, `json-schema-traverse`), which keeps no
 * copyright or licence comment of the five.
 */
function installedMcpServer() {
  const directory = realpathSync(
    join(
      repositoryRoot,
      "packages/mcp/node_modules/@modelcontextprotocol/server",
    ),
  );
  const dist = readdirSync(join(directory, "dist"));
  const files = ["src-", "ajvProvider-"].map((prefix) => {
    const [file] = dist.filter(
      (name) => name.startsWith(prefix) && name.endsWith(".mjs"),
    );
    return join(directory, "dist", file);
  });
  return { directory, files };
}

/**
 * `@trigger.dev/core`, as `@trigger.dev/sdk` (a dependency of `apps/web`'s)
 * resolves it in this tree, a package of `apps/web`'s production closure,
 * and its ESM build's superjson bundle, `dist/esm/v3/vendor/superjson.mjs`,
 * which bundles `superjson`, `copy-anything` and `is-what` with no
 * `package.json`, licence comment or source map that names them: the
 * reviewed list of vendored copies names it (`VENDORED_COPIES`).
 */
function installedTriggerCore() {
  const directory = realpathSync(
    join(
      realpathSync(
        join(repositoryRoot, "apps/web/node_modules/@trigger.dev/sdk"),
      ),
      "../core",
    ),
  );
  return { directory, superjson: join(directory, SUPERJSON) };
}

/** The path of `@trigger.dev/core`'s ESM superjson bundle in that package. */
const SUPERJSON = "dist/esm/v3/vendor/superjson.mjs";

/**
 * Each package.json anywhere below `directory` (a directory that is a
 * symbolic link not entered, a package.json that is one read through it,
 * and a directory that cannot be read thrown on) that names a package other than the one whose directory encloses it,
 * `holder` (by name) or one named below it, nor a subpath of that one's
 * name, as `<name>[@<version>] (vendored in <key> at <path>)`: this suite's
 * own reading of ruling 199 item 1's nested scan, which the notices case
 * expects `stageWeb` to enter.
 */
function vendoredBelow(directory, holder, key) {
  const found = [];
  const walk = (at, owner) => {
    let here = owner;
    const manifest = join(at, "package.json");
    if (at !== directory && existsSync(manifest)) {
      let named;
      try {
        named = JSON.parse(readFileSync(manifest, "utf8"));
      } catch {
        named = undefined;
      }
      if (
        typeof named?.name === "string" &&
        named.name !== "" &&
        named.name !== owner &&
        !named.name.startsWith(`${owner}/`)
      ) {
        found.push(
          `${named.name}${typeof named.version === "string" ? `@${named.version}` : ""} (vendored in ${key} at ${relative(directory, at)})`,
        );
        here = named.name;
      }
    }
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name), here);
    }
  };
  walk(directory, holder);
  return found;
}

/**
 * `process`, as Next's webpack configuration resolves it from Next's own
 * directory (`WEB.beyondClosure`): the copy pnpm's store hoists.
 */
function installedProcess() {
  return realpathSync(
    join(repositoryRoot, "node_modules/.pnpm/node_modules/process"),
  );
}

/**
 * What the fixture's build says it contains (`buildWeb`'s `contained`): a
 * sealed compilation of each of Next's three compilers (`WEB.compilers`); a
 * module of `next`'s own, and its `dist/shared/lib/mitt.js`, a copy of
 * developit's mitt under Jason Miller's MIT licence comment, which the
 * notices carry under `next`'s entry; two of the React Next keeps in its
 * own `dist/compiled/react`, which are that package's (`react-builtin`,
 * vendored in `next`): its `index.js`, and its `cjs/react.production.js`,
 * which opens with React's licence comment, so that the notices case shows
 * that this entry, and not the nested scan's of the same key, which holds
 * no file, is the one the notices write; one of `react-dom`'s; in the
 * private tree, the `index.mjs` of the serverless PostgreSQL driver `db`
 * depends on (`installedBundlers`; the public seed's `db` declares none),
 * which bundles `buffer` and `ieee754` and names them in a bundler's
 * licence comment;
 * `process/browser.js`,
 * which Next's webpack configuration provides to the client's code from
 * outside `apps/web`'s production closure, as the real build does; two
 * files of `@modelcontextprotocol/server`'s `dist`, which bundle other
 * packages' code that their source maps name and no bundler's licence
 * comment does (`installedMcpServer`);
 * `@trigger.dev/core`'s superjson bundle, which the real build compiles in
 * (H.7 round 6's check) and whose bundled packages the reviewed list of
 * vendored copies names (`installedTriggerCore`);
 * and a module of `apps/web`'s own, which is not third-party code.
 */
const FIXTURE_CONTAINED = Object.freeze({
  compilers: Object.freeze(["client", "edge-server", "server"]),
  files: Object.freeze([
    join(installedForWeb("next"), "dist/client/app-index.js"),
    join(installedForWeb("next"), "dist/shared/lib/mitt.js"),
    join(installedForWeb("next"), "dist/compiled/react/index.js"),
    join(
      installedForWeb("next"),
      "dist/compiled/react/cjs/react.production.js",
    ),
    join(installedForWeb("react-dom"), "cjs/react-dom-client.production.js"),
    ...installedBundlers().map((directory) => join(directory, "index.mjs")),
    join(installedProcess(), "browser.js"),
    ...installedMcpServer().files,
    installedTriggerCore().superjson,
    join(repositoryRoot, "apps/web/src/app/page.tsx"),
  ]),
});

describe("@requestport/web, staged from a self-host build (a fixture tree of the real build's shape)", () => {
  const directory = join(scratch, "web-stage");
  let web;

  before(async () => {
    web = await stageWeb({
      version: VERSION,
      directory,
      build: async () => standaloneFixture(join(scratch, "standalone")),
    });
  });

  test("copies the build's apps/web to the package's root without its node_modules, and nothing else of the standalone tree; its allow-list adds LICENSE and THIRD-PARTY-NOTICES", () => {
    assert.deepEqual(web.files, [
      ".next-self-host/package.json",
      ".next-self-host/required-server-files.json",
      ".next-self-host/server/app/page.js",
      ".next-self-host/server/app/page_client-reference-manifest.js",
      ".next-self-host/server/chunks/42.js",
      ".next-self-host/static/chunks/polyfills-0123456789abcdef.js",
      ".next-self-host/static/css/app.css",
      ".next-self-host/static/fixture-build/_ssgManifest.js",
      ".next-self-host/static/media/font.woff2",
      "package.json",
      "server.js",
      "src/app/docs/api/generated/openapi.json",
    ]);
    assert.deepEqual(
      web.allowList,
      [...web.files, "LICENSE", "THIRD-PARTY-NOTICES"].sort(),
    );
    assert.equal(existsSync(join(directory, "node_modules")), false);
    assert.equal(existsSync(join(directory, "web")), false);
    assert.deepEqual(
      readFileSync(join(directory, ".next-self-host/package.json"), "utf8"),
      '{"type": "commonjs"}',
    );
    assert.deepEqual(
      readFileSync(join(directory, "LICENSE")),
      readFileSync(join(repositoryRoot, WEB.licenseText)),
    );
  });

  test("replaces package.json, apps/web's manifest with its workspace: specifiers, with its packed manifest: the workspace's name, the stamped version, private false (option (B)), type module, the mapping's licence, the public repository with apps/web as directory, files naming each top-level entry, LICENSE and THIRD-PARTY-NOTICES, engines as the root declares, and next, react and react-dom at apps/web's versions; no @requestport dependency, exports, scripts or bin (ruling 193 item 4)", () => {
    const text = readFileSync(join(directory, "package.json"), "utf8");
    const apps = readJson("apps/web/package.json");
    const expected = {
      name: "@requestport/web",
      version: VERSION,
      private: false,
      type: "module",
      license: "Apache-2.0",
      repository: publicRepository("apps/web"),
      files: [
        ".next-self-host",
        "LICENSE",
        "THIRD-PARTY-NOTICES",
        "server.js",
        "src",
      ],
      engines: { node: readJson("package.json").engines.node },
      dependencies: {
        next: apps.dependencies.next,
        react: apps.dependencies.react,
        "react-dom": apps.dependencies["react-dom"],
      },
    };
    assert.equal(apps.name, WEB.published);
    assert.deepEqual(JSON.parse(text), expected);
    assert.deepEqual(web.manifest, expected);
    assert.doesNotMatch(text, /workspace:/u);
    assert.deepEqual(
      Object.keys(expected.dependencies).filter((name) =>
        name.startsWith("@requestport/"),
      ),
      [],
    );
    assert.deepEqual(
      webManifest(
        { name: "x", dependencies: {} },
        {
          version: "1.0.0",
          entries: ["package.json", "b", "a"],
          dependencies: { next: "1.0.0" },
        },
      ),
      {
        name: "@requestport/web",
        version: "1.0.0",
        private: false,
        license: "Apache-2.0",
        repository: publicRepository("apps/web"),
        files: ["LICENSE", "THIRD-PARTY-NOTICES", "a", "b"],
        engines: { node: readJson("package.json").engines.node },
        dependencies: { next: "1.0.0" },
      },
    );
  });

  test("rewrites the checkout's path to NEUTRAL_ROOT, the same in every file and form: a client component's id in the page and its manifest still match, the inlined file:// URL and the escaped form name the neutral root, and no file holds the checkout", () => {
    const read = (file) => readFileSync(join(directory, file), "utf8");
    const id = `${NEUTRAL_ROOT}/apps/web/src/components/menu.tsx`;
    assert.ok(read(".next-self-host/server/app/page.js").includes(`"${id}"`));
    const manifest = read(
      ".next-self-host/server/app/page_client-reference-manifest.js",
    );
    assert.deepEqual(
      Object.keys(
        JSON.parse(
          manifest.slice(manifest.indexOf("{"), manifest.lastIndexOf("}") + 1),
        ).clientModules,
      ),
      [id],
    );
    assert.equal(
      read(".next-self-host/server/chunks/42.js"),
      [
        `const migrations = new URL("../migrations", "file://${NEUTRAL_ROOT}/packages/db/src/migrate.ts");`,
        `const escaped = "${NEUTRAL_ROOT.replaceAll("/", "\\/")}\\/apps\\/web";`,
        "",
      ].join("\n"),
    );
    const files = JSON.parse(
      read(".next-self-host/required-server-files.json"),
    );
    assert.equal(files.config.outputFileTracingRoot, NEUTRAL_ROOT);
    assert.equal(files.appDir, `${NEUTRAL_ROOT}/apps/web`);
    assert.match(
      read("server.js"),
      /"outputFileTracingRoot":"\/requestport-build"/u,
    );
    assert.deepEqual(web.rewritten, { files: 5, occurrences: 7 });
    for (const file of web.allowList) {
      const body = readFileSync(join(directory, file));
      for (const form of pathForms(repositoryRoot)) {
        assert.equal(body.includes(form), false, `${file} holds ${form}`);
      }
    }
  });

  test("leaves a binary file as it was", () => {
    assert.deepEqual(
      readFileSync(join(directory, ".next-self-host/static/media/font.woff2")),
      FONT,
    );
  });

  test("answers what Next's trace holds: next, react, react-dom and the packages that come with them, sharp's platform packages for any platform", () => {
    assert.deepEqual(web.traced, [
      "@img/sharp-linux-x64",
      "@swc/helpers",
      "next",
      "react",
      "react-dom",
    ]);
    assert.deepEqual(tracedProblems(web.traced), []);
  });

  /** `stageWeb` on a fixture build with `options` into a new directory: its refusal's lines, and whether it built and copied anything. */
  const refusal = async (name, options = {}, stageOptions = {}) => {
    const stage = mkdtempSync(join(scratch, `refused-${name}-`));
    const target = join(stage, "package");
    let built = 0;
    let message;
    try {
      await stageWeb({
        version: VERSION,
        directory: target,
        build: async () => {
          built += 1;
          return standaloneFixture(join(stage, "standalone"), options);
        },
        ...stageOptions,
      });
    } catch (error) {
      message = error.message;
    }
    return {
      message,
      lines: message?.split("\n- ").slice(1),
      built,
      copied: existsSync(target),
    };
  };

  test("refuses a trace that holds another package, or lacks any of next, react and react-dom, before it copies anything", async () => {
    const pg = await refusal("pg", {
      planted: {
        "node_modules/.pnpm/pg@8.23.0/node_modules/pg/package.json":
          '{"name":"pg"}\n',
      },
    });
    assert.ok(
      pg.message?.startsWith("pack-requestport refuses the self-host build:\n"),
      pg.message,
    );
    assert.deepEqual(pg.lines, [
      "the self-host build's trace holds pg, which is not next, react or react-dom nor one of the packages that come with them (WEB.traced)",
    ]);
    assert.equal(pg.copied, false, "nothing is copied");
    const reactDom = await refusal("react-dom", {
      omitted: [
        "node_modules/.pnpm/react-dom@19.2.8_react@19.2.8/node_modules/react-dom/package.json",
      ],
    });
    assert.deepEqual(reactDom.lines, [
      "the self-host build's trace holds no react-dom",
    ]);
    assert.equal(reactDom.copied, false, "nothing is copied");
  });

  test("refuses its notices, before it copies anything, when a stylesheet of static/css carries a licence banner for a package outside apps/web's production closure, which no entry could cover (emittedPackages; ruling 197 item 4)", async () => {
    const banner = await refusal("banner", {
      planted: {
        "apps/web/.next-self-host/static/css/vendor.css":
          "/*! ghost-package v9.9.9 | MIT License */\n.ghost{}\n",
      },
    });
    assert.ok(
      banner.message?.startsWith(
        "pack-requestport refuses @requestport/web's THIRD-PARTY-NOTICES:\n",
      ),
      banner.message,
    );
    assert.deepEqual(banner.lines, [
      ".next-self-host/static/css/vendor.css carries a licence banner for ghost-package v9.9.9, which is not a package of the production closure of @requestport/web",
    ]);
    assert.equal(banner.copied, false, "nothing is copied");
  });

  test("refuses its notices, before it copies anything, when a file of static/media is neither a file a package of apps/web's production closure ships nor one of apps/web's own sources; stages one that is, byte for byte, apps/web's own, which needs no entry (emittedPackages; ruling 197 item 4)", async () => {
    const stray = await refusal("media", {
      planted: {
        "apps/web/.next-self-host/static/media/stray.woff2": Buffer.from([
          0x77, 0x4f, 0x46, 0x32, 0x00, 0x05, 0x05, 0x05,
        ]),
      },
    });
    assert.ok(
      stray.message?.startsWith(
        "pack-requestport refuses @requestport/web's THIRD-PARTY-NOTICES:\n",
      ),
      stray.message,
    );
    assert.deepEqual(stray.lines, [
      ".next-self-host/static/media/stray.woff2 is, byte for byte, no file a package of the production closure of @requestport/web ships, nor one of apps/web's own sources (apps/web/src, apps/web/public), so no entry could cover it",
    ]);
    assert.equal(stray.copied, false, "nothing is copied");
    const icon = readFileSync(
      join(repositoryRoot, "apps/web/src/app/icon.svg"),
    );
    const stage = mkdtempSync(join(scratch, "own-media-"));
    const owned = await stageWeb({
      version: VERSION,
      directory: join(stage, "package"),
      build: async () =>
        standaloneFixture(join(stage, "standalone"), {
          planted: {
            "apps/web/.next-self-host/static/media/icon.0123.svg": icon,
          },
        }),
    });
    assert.deepEqual(owned.emitted.own, [
      ".next-self-host/static/media/icon.0123.svg",
    ]);
    assert.deepEqual(
      noticesEntries(owned.notices).map(({ key }) => key),
      noticesEntries(run.packs.web.staged.notices).map(({ key }) => key),
    );
  });

  test("refuses the build, before it copies anything, when its record says it put one of db's private modules in a chunk and did not build it from its public variant (privateModuleBuildProblems; ruling 193 item 5; ruling 198 item 4); stages it when the record says it did", async () => {
    const driver = join(repositoryRoot, "packages/db/src/hosted-driver.ts");
    const contained = {
      ...FIXTURE_CONTAINED,
      files: [...FIXTURE_CONTAINED.files, driver],
    };
    const asIs = await refusal("private", {
      contained: { ...contained, replaced: [] },
    });
    assert.ok(
      asIs.message?.startsWith(
        "pack-requestport refuses the self-host build:\n",
      ),
      asIs.message,
    );
    assert.deepEqual(asIs.lines, [
      "the self-host build compiled the private module packages/db/src/hosted-driver.ts as it is, and not its public variant packages/db/src/hosted-driver.public.ts in its place",
    ]);
    assert.equal(asIs.copied, false, "nothing is copied");
    const stage = mkdtempSync(join(scratch, "replaced-private-"));
    const replaced = await stageWeb({
      version: VERSION,
      directory: join(stage, "package"),
      build: async () =>
        standaloneFixture(join(stage, "standalone"), {
          contained: { ...contained, replaced: [driver] },
        }),
    });
    assert.equal(replaced.notices, run.packs.web.staged.notices);
  });

  test("refuses its notices, before it copies anything, when the build copies, byte for byte, a file of a package of the closure that the reviewed list does not name at its SHA-256, and when a file the list names is not copied as it is, its bytes changed: either is reviewed before it ships (verbatimPackages; ruling 198 item 2)", async () => {
    const body = readFileSync(
      join(installedForWeb("next"), "dist/client/app-index.js"),
    );
    const sha256 = createHash("sha256").update(body).digest("hex");
    const [polyfills] = Object.keys(VERBATIM_COPIES).filter((path) =>
      path.includes("polyfills-"),
    );
    const [listed] = VERBATIM.files.filter(({ emitted }) =>
      emitted.includes("polyfills-"),
    );
    const changed = Buffer.concat([
      VERBATIM_COPIES[polyfills],
      Buffer.from("\n"),
    ]);
    const copied = await refusal("unlisted", {
      planted: {
        "apps/web/.next-self-host/static/chunks/copied-0123456789abcdef.js":
          body,
        [`apps/web/${polyfills}`]: changed,
      },
    });
    assert.ok(
      copied.message?.startsWith(
        "pack-requestport refuses @requestport/web's THIRD-PARTY-NOTICES:\n",
      ),
      copied.message,
    );
    assert.deepEqual(copied.lines, [
      `.next-self-host/static/chunks/copied-0123456789abcdef.js is, byte for byte, next@16.4.2's dist/client/app-index.js, which the build copies as it is, and ${VERBATIM.file} names no file of SHA-256 ${sha256}: review what it bundles, and list it`,
      `${VERBATIM.file} lists next's ${listed.path} (SHA-256 ${listed.sha256}), and the build copies no file of it: review the list`,
    ]);
    assert.equal(copied.copied, false, "nothing is copied");
  });

  test("refuses its notices, before it copies anything, when a contained file's source map names a package this tree installs no copy of, whose licence no entry could give (bundledPackages; ruling 198 item 2)", async () => {
    const holder = join(scratch, "unmapped", "node_modules", "holder");
    const map = {
      version: 3,
      sources: [
        "../node_modules/.pnpm/ghost-package@1.0.0/node_modules/ghost-package/index.js",
      ],
      mappings: "",
    };
    writeTree(holder, {
      "package.json": '{"name":"holder","version":"1.0.0","license":"MIT"}\n',
      LICENSE: "MIT License\n",
      "dist/index.js": `export {};\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`,
    });
    const closure = productionClosure({ members: WEB.notices.members });
    const unmapped = await refusal(
      "unmapped",
      {
        contained: {
          ...FIXTURE_CONTAINED,
          files: [...FIXTURE_CONTAINED.files, join(holder, "dist/index.js")],
        },
      },
      {
        closure: {
          ...closure,
          packages: new Map([
            ...closure.packages,
            [
              "holder@1.0.0",
              {
                key: "holder@1.0.0",
                directory: holder,
                manifest: { name: "holder", version: "1.0.0", license: "MIT" },
              },
            ],
          ]),
        },
      },
    );
    assert.ok(
      unmapped.message?.startsWith(
        "pack-requestport refuses @requestport/web's THIRD-PARTY-NOTICES:\n",
      ),
      unmapped.message,
    );
    assert.deepEqual(unmapped.lines, [
      "dist/index.js of holder@1.0.0 bundles ghost-package@1.0.0, as its source map names it, and this tree installs no ghost-package whose licence an entry could give",
    ]);
    assert.equal(unmapped.copied, false, "nothing is copied");
  });

  /**
   * A package planted outside the tree and added to the production closure,
   * whose four files bind esbuild's runtime helpers as esbuild writes them,
   * unminified (X27): two `.cjs` files in CommonJS, the form ruling 209's
   * scan found in the `drizzle-orm` `.cjs` files the real build compiles in,
   * an `.mjs` file in ESM, the form of `@electric-sql/client`'s
   * `dist/index.mjs`, and a `.js` file in CommonJS, the form of the
   * `@edge-runtime/cookies` `index.js` `next` compiles in (ruling 232 item
   * 3). The `.mjs` and the `.js` files bind names the `.cjs` ones do not.
   * `sha256(path)` is the SHA-256 of the holder's file at `path`.
   */
  const helperHolder = () => {
    const holder = join(scratch, "helper-holder", "node_modules", "holder");
    const source = [
      '"use strict";',
      "var __defProp = Object.defineProperty;",
      "var __export = (target, all) => {",
      "  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });",
      "};",
      "module.exports = {};",
      "",
    ].join("\n");
    writeTree(holder, {
      "package.json": '{"name":"holder","version":"1.0.0","license":"MIT"}\n',
      LICENSE: "MIT License\n",
      "dist/index.cjs": source,
      "dist/other.cjs": source,
      "dist/index.mjs": [
        "var __defProp = Object.defineProperty;",
        "var __spreadValues = (a, b) => {",
        "  for (var prop in b) __defProp(a, prop, { value: b[prop] });",
        "  return a;",
        "};",
        "export const spread = __spreadValues;",
        "",
      ].join("\n"),
      "dist/index.js": [
        '"use strict";',
        "var __create = Object.create;",
        "var __toESM = (mod) => __create(mod);",
        "module.exports = { toESM: __toESM };",
        "",
      ].join("\n"),
    });
    const closure = productionClosure({ members: WEB.notices.members });
    return {
      holder,
      sha256: (path) =>
        createHash("sha256")
          .update(readFileSync(join(holder, path)))
          .digest("hex"),
      contained: {
        ...FIXTURE_CONTAINED,
        files: [
          ...FIXTURE_CONTAINED.files,
          join(holder, "dist/index.cjs"),
          join(holder, "dist/other.cjs"),
          join(holder, "dist/index.mjs"),
          join(holder, "dist/index.js"),
        ],
      },
      closure: {
        ...closure,
        packages: new Map([
          ...closure.packages,
          [
            "holder@1.0.0",
            {
              key: "holder@1.0.0",
              directory: holder,
              manifest: { name: "holder", version: "1.0.0", license: "MIT" },
            },
          ],
        ]),
      },
    };
  };

  /** The reviewed list's bundles for `bundler` (`esbuild` or `rolldown`), as its first entry for that bundler gives them. */
  const bundlesOf = (bundler) =>
    VENDORED_COPIES.copies.find(({ bundles }) =>
      bundles.some(({ name }) => name === bundler),
    ).bundles;

  /** `stageWeb` on a fixture build that contains `contained`, over `closure`, with the reviewed list and `entries` beside it: what it answers. */
  const stagedWith = async (name, { contained, closure }, entries) => {
    const stage = mkdtempSync(join(scratch, `${name}-`));
    return stageWeb({
      version: VERSION,
      directory: join(stage, "package"),
      build: async () =>
        standaloneFixture(join(stage, "standalone"), { contained }),
      closure,
      vendored: [...VENDORED_COPIES.copies, ...entries],
    });
  };

  test("refuses its notices, before it copies anything, when files the build contains of a package bind esbuild's runtime helpers as esbuild writes them and no entry enters esbuild or rolldown as vendored in that package, so that a new holder fails the pack; its .cjs, .mjs and .js files are each read and counted (helperHolderProblems; X27, ruling 231; ruling 232 item 3)", async () => {
    const { contained, closure } = helperHolder();
    const planted = await refusal("helper-holder", { contained }, { closure });
    assert.ok(
      planted.message?.startsWith(
        "pack-requestport refuses @requestport/web's THIRD-PARTY-NOTICES:\n",
      ),
      planted.message,
    );
    assert.deepEqual(planted.lines, [
      `dist/index.cjs of holder@1.0.0, and 3 other files of it the build contains, bind esbuild's runtime helpers as esbuild writes them (__create, __defProp, __export, __spreadValues, __toESM), and THIRD-PARTY-NOTICES enters neither esbuild nor rolldown as vendored in holder@1.0.0: review whose runtime it is, and enter that bundler as vendored in holder in ${VENDORED_COPIES.file}`,
    ]);
    assert.equal(planted.copied, false, "nothing is copied");
  });

  test("stages that package once the reviewed list of vendored copies enters esbuild as vendored in it, and its notices name esbuild for it (helperHolderProblems; X27, ruling 231)", async () => {
    const planted = helperHolder();
    const staged = await stagedWith("helper-holder-listed", planted, [
      {
        holder: "holder",
        version: "1.0.0",
        path: "dist/index.cjs",
        sha256: planted.sha256("dist/index.cjs"),
        reviewed: "This case's planted holder.",
        bundles: bundlesOf("esbuild"),
      },
    ]);
    assert.ok(
      noticesEntries(staged.notices).some(
        ({ key }) => key === "esbuild@0.28.2 (vendored in holder@1.0.0)",
      ),
    );
  });

  test("stages that package when the reviewed list enters rolldown, not esbuild, as vendored in it, as it enters rolldown for a holder whose file is rolldown's runtime (helperHolderProblems; X27, ruling 231; ruling 232 item 3)", async () => {
    const planted = helperHolder();
    const staged = await stagedWith("helper-holder-rolldown", planted, [
      {
        holder: "holder",
        version: "1.0.0",
        path: "dist/index.mjs",
        sha256: planted.sha256("dist/index.mjs"),
        reviewed: "This case's planted holder, entered for rolldown.",
        bundles: bundlesOf("rolldown"),
      },
    ]);
    const keys = noticesEntries(staged.notices).map(({ key }) => key);
    assert.ok(keys.includes("rolldown@1.2.4 (vendored in holder@1.0.0)"), keys);
    assert.ok(
      !keys.some((key) =>
        /^esbuild@\S+ \(vendored in holder@1\.0\.0\)$/u.test(key),
      ),
      keys,
    );
  });

  /**
   * An installed package planted outside the tree and added to the
   * production closure, which vendors a package with a manifest of its own
   * in its `dist/compiled`, as `next` does: the vendored package's `index.js`
   * binds esbuild's runtime helpers in CommonJS, and the build contains it
   * and the installed package's own `dist/index.js`, which binds none.
   */
  const vendoringHolder = () => {
    const holder = join(scratch, "helper-vendoring", "node_modules", "holder");
    writeTree(holder, {
      "package.json": '{"name":"holder","version":"1.0.0","license":"MIT"}\n',
      LICENSE: "MIT License\n",
      "dist/index.js": "export {};\n",
      "dist/compiled/inner/package.json":
        '{"name":"inner","version":"2.0.0","license":"MIT"}\n',
      "dist/compiled/inner/LICENSE": "MIT License\n",
      "dist/compiled/inner/index.js": [
        '"use strict";',
        "var __defProp = Object.defineProperty;",
        "var __export = (target, all) => {",
        "  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });",
        "};",
        "module.exports = {};",
        "",
      ].join("\n"),
    });
    const closure = productionClosure({ members: WEB.notices.members });
    return {
      sha256: createHash("sha256")
        .update(readFileSync(join(holder, "dist/compiled/inner/index.js")))
        .digest("hex"),
      contained: {
        ...FIXTURE_CONTAINED,
        files: [
          ...FIXTURE_CONTAINED.files,
          join(holder, "dist/index.js"),
          join(holder, "dist/compiled/inner/index.js"),
        ],
      },
      closure: {
        ...closure,
        packages: new Map([
          ...closure.packages,
          [
            "holder@1.0.0",
            {
              key: "holder@1.0.0",
              directory: holder,
              manifest: { name: "holder", version: "1.0.0", license: "MIT" },
            },
          ],
        ]),
      },
    };
  };

  test("judges a package vendored inside an installed one under the installed package's key, as the reviewed list keys its entries: it refuses naming the installed package and the file's path from it, and stages once the list enters esbuild as vendored in the installed package (helperHolderProblems; X27, ruling 231; ruling 232 item 3)", async () => {
    const planted = vendoringHolder();
    const refused = await refusal(
      "helper-vendoring",
      { contained: planted.contained },
      { closure: planted.closure },
    );
    assert.deepEqual(refused.lines, [
      `dist/compiled/inner/index.js of holder@1.0.0 binds esbuild's runtime helpers as esbuild writes them (__defProp, __export), and THIRD-PARTY-NOTICES enters neither esbuild nor rolldown as vendored in holder@1.0.0: review whose runtime it is, and enter that bundler as vendored in holder in ${VENDORED_COPIES.file}`,
    ]);
    assert.equal(refused.copied, false, "nothing is copied");
    const staged = await stagedWith("helper-vendoring-listed", planted, [
      {
        holder: "holder",
        version: "1.0.0",
        path: "dist/compiled/inner/index.js",
        sha256: planted.sha256,
        reviewed: "This case's planted holder, by its vendored copy.",
        bundles: bundlesOf("esbuild"),
      },
    ]);
    const keys = noticesEntries(staged.notices).map(({ key }) => key);
    assert.ok(keys.includes("esbuild@0.28.2 (vendored in holder@1.0.0)"), keys);
    assert.ok(
      keys.includes(
        "inner@2.0.0 (vendored in holder@1.0.0 at dist/compiled/inner)",
      ),
      keys,
    );
  });

  test("refuses its notices, before it copies anything, when a module of RequestPort's own that the build contains carries a licence comment, which no entry could carry (ownLicenceCommentProblems; H.7 round 6's review)", async () => {
    const copied = join(scratch, "own-module", "src", "copied.ts");
    writeTree(dirname(copied), {
      "copied.ts":
        "/*\nMIT License\n\nCopyright (c) Jason Miller (https://jasonformat.com/)\n*/\nexport {};\n",
    });
    const own = await refusal("own-licence", {
      contained: {
        ...FIXTURE_CONTAINED,
        files: [...FIXTURE_CONTAINED.files, copied],
      },
    });
    assert.ok(
      own.message?.startsWith(
        "pack-requestport refuses @requestport/web's THIRD-PARTY-NOTICES:\n",
      ),
      own.message,
    );
    assert.deepEqual(own.lines, [
      `${relative(repositoryRoot, copied)}, RequestPort's own module, which the self-host build contains, carries a licence comment, and no entry of THIRD-PARTY-NOTICES could carry it: "MIT License"`,
    ]);
    assert.equal(own.copied, false, "nothing is copied");
  });

  test("refuses its notices, before it copies anything, when the file WEB.bundler names is not there, so that no entry says whose runtime the chunks hold (bundlerPackages; ruling 199 item 3): stageWeb reads WEB.bundler unless a test hands another", async () => {
    const missing = await refusal(
      "bundler",
      {},
      {
        bundler: {
          holder: WEB.bundler.holder,
          path: "dist/compiled/webpack/absent.js",
        },
      },
    );
    assert.ok(
      missing.message?.startsWith(
        "pack-requestport refuses @requestport/web's THIRD-PARTY-NOTICES:\n",
      ),
      missing.message,
    );
    assert.deepEqual(missing.lines, [
      "next ships no dist/compiled/webpack/absent.js, the bundler whose runtime the self-host build's runtime chunks hold (WEB.bundler), or is not in the production closure of @requestport/web: review WEB.bundler",
    ]);
    assert.equal(missing.built, 1, "the build ran");
    assert.equal(missing.copied, false, "nothing is copied");
  });

  test("refuses its notices, before it copies anything, when a copy the reviewed list of vendored copies names, in a package the build contains, is not at the list's SHA-256 or not there, so that a changed copy is reviewed before it ships (listedVendoredPackages; ruling 199 item 1)", async () => {
    const core = join(
      scratch,
      "changed-copy",
      "node_modules/@trigger.dev/core",
    );
    const { directory: installed } = installedTriggerCore();
    const manifest = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8"),
    );
    writeTree(core, {
      "package.json": `${JSON.stringify({ name: manifest.name, version: manifest.version, license: manifest.license })}\n`,
      [SUPERJSON]: "export {};\n",
    });
    const key = `${manifest.name}@${manifest.version}`;
    const closure = productionClosure({ members: WEB.notices.members });
    const changed = await refusal(
      "vendored-copy",
      {
        contained: {
          ...FIXTURE_CONTAINED,
          files: [...FIXTURE_CONTAINED.files, join(core, SUPERJSON)],
        },
      },
      {
        closure: {
          ...closure,
          packages: new Map([
            ...closure.packages,
            [key, { ...closure.packages.get(key), directory: core }],
          ]),
        },
      },
    );
    assert.ok(
      changed.message?.startsWith(
        "pack-requestport refuses @requestport/web's THIRD-PARTY-NOTICES:\n",
      ),
      changed.message,
    );
    const [esm, cjs] = VENDORED_COPIES.copies;
    assert.deepEqual(changed.lines, [
      `${VENDORED_COPIES.file} lists ${key}'s ${esm.path} at SHA-256 ${esm.sha256}, and it is at ${createHash("sha256").update("export {};\n").digest("hex")}: review what it bundles, and the list`,
      `${VENDORED_COPIES.file} lists ${key}'s ${cjs.path}, which it does not ship: review the list`,
    ]);
    assert.equal(changed.copied, false, "nothing is copied");
  });

  /** The production closure with `holder@1.0.0`, MIT, at `directory`. */
  const withHolder = (directory) => {
    const closure = productionClosure({ members: WEB.notices.members });
    return {
      ...closure,
      packages: new Map([
        ...closure.packages,
        [
          "holder@1.0.0",
          {
            key: "holder@1.0.0",
            directory,
            manifest: { name: "holder", version: "1.0.0", license: "MIT" },
          },
        ],
      ]),
    };
  };

  /** The fixture's record with `holder`'s `dist/index.js` beside its files. */
  const holding = (holder) => ({
    contained: {
      ...FIXTURE_CONTAINED,
      files: [...FIXTURE_CONTAINED.files, join(holder, "dist/index.js")],
    },
  });

  test("refuses its notices, before it copies anything, when a package.json inside an installed package the build contains cannot be read (a symbolic link to nothing), so that nothing says whether it names a package vendored there (nestedPackages; H.7 round 7's review)", async () => {
    const holder = join(scratch, "dangling", "node_modules", "holder");
    writeTree(holder, {
      "package.json": '{"name":"holder","version":"1.0.0","license":"MIT"}\n',
      LICENSE: "MIT License\n",
      "dist/index.js": "export {};\n",
      "dist/compiled/dangling/index.js": "export {};\n",
    });
    symlinkSync(
      "absent.json",
      join(holder, "dist/compiled/dangling/package.json"),
    );
    const dangling = await refusal("dangling", holding(holder), {
      closure: withHolder(holder),
    });
    assert.ok(
      dangling.message?.startsWith(
        "pack-requestport refuses @requestport/web's THIRD-PARTY-NOTICES:\n",
      ),
      dangling.message,
    );
    assert.deepEqual(dangling.lines, [
      "holder@1.0.0's dist/compiled/dangling/package.json cannot be read (ENOENT), so nothing says whether it names a package holder@1.0.0 vendors there (nestedPackages)",
    ]);
    assert.equal(dangling.copied, false, "nothing is copied");
  });

  test("stops, before it copies anything, when a directory inside a package of the production closure cannot be read: emittedPackages, which reads every file of those packages where the build emits media, as verbatimPackages does after it, throws the reader's error before the nested scan would refuse it (H.7 round 7's review)", {
    skip:
      process.getuid?.() === 0
        ? "root reads a directory of mode 000, which this case needs refused"
        : false,
  }, async () => {
    const holder = join(scratch, "unread", "node_modules", "holder");
    writeTree(holder, {
      "package.json": '{"name":"holder","version":"1.0.0","license":"MIT"}\n',
      LICENSE: "MIT License\n",
      "dist/index.js": "export {};\n",
      "dist/compiled/locked/package.json":
        '{"name":"locked","version":"1.0.0"}\n',
    });
    const locked = join(holder, "dist/compiled/locked");
    chmodSync(locked, 0o000);
    let unread;
    try {
      unread = await refusal("unread", holding(holder), {
        closure: withHolder(holder),
      });
    } finally {
      chmodSync(locked, 0o755);
    }
    assert.equal(
      unread.message,
      `EACCES: permission denied, scandir '${locked}'`,
    );
    assert.equal(unread.built, 1, "the build ran");
    assert.equal(unread.copied, false, "nothing is copied");
  });

  test("refuses its notices, before it copies anything, when an entry of the reviewed list of vendored copies names as its holder a package the notices cover only as vendored in another, as the nested scan found it, so that a mis-keyed entry closes nothing silently (listedVendoredPackages; H.7 round 7's review): stageWeb reads VENDORED_COPIES unless a test hands another list", async () => {
    const next = `next@${JSON.parse(readFileSync(join(installedForWeb("next"), "package.json"), "utf8")).version}`;
    const misKeyed = await refusal(
      "mis-keyed",
      {},
      {
        vendored: [
          ...VENDORED_COPIES.copies,
          {
            holder: "ua-parser-js",
            version: "1.0.0",
            path: "ua-parser.js",
            sha256: "0".repeat(64),
            reviewed: "a planted entry, keyed by the vendored package",
            bundles: [],
          },
        ],
      },
    );
    assert.ok(
      misKeyed.message?.startsWith(
        "pack-requestport refuses @requestport/web's THIRD-PARTY-NOTICES:\n",
      ),
      misKeyed.message,
    );
    assert.deepEqual(misKeyed.lines, [
      `${VENDORED_COPIES.file} lists ua-parser-js 1.0.0's ua-parser.js, and the notices cover ua-parser-js only as vendored or bundled in another package (ua-parser-js (vendored in ${next} at dist/compiled/ua-parser-js)): key the entry by the installed package that holds the copy, with the copy's path from that package's directory`,
    ]);
    assert.equal(misKeyed.copied, false, "nothing is copied");
  });

  test("refuses where NEUTRAL_ROOT exists, before it copies anything: stageWeb asks its exists, existsSync unless a test hands another", async () => {
    const asked = [];
    const { message, copied } = await refusal(
      "neutral-root",
      {},
      {
        exists: (path) => {
          asked.push(path);
          return true;
        },
      },
    );
    assert.equal(
      message,
      `pack-requestport refuses the self-host build:\n- ${NEUTRAL_ROOT}, the root @requestport/web is rewritten to, exists on this machine`,
    );
    assert.deepEqual(asked, [NEUTRAL_ROOT]);
    assert.equal(copied, false, "nothing is copied");
  });

  test("refuses, before it builds anything, a version it would not stamp, a directory that is not empty, a version of next, react or react-dom apps/web does not declare, and a production closure of apps/web holding a dependency the tree does not hold, which no notices could cover", async () => {
    const version = await refusal("version", {}, { version: "1.0" });
    assert.match(version.message, /^pack-requestport/u);
    assert.equal(version.built, 0);
    const full = mkdtempSync(join(scratch, "refused-full-"));
    writeFileSync(join(full, "x"), "");
    await assert.rejects(
      stageWeb({
        version: VERSION,
        directory: full,
        build: async () => assert.fail("it builds"),
      }),
      { message: `pack-requestport: ${full} is not empty.` },
    );
    const manifests = structuredClone(readManifests());
    delete manifests.get("apps/web").dependencies["react-dom"];
    const undeclared = await refusal("undeclared", {}, { manifests });
    assert.equal(
      undeclared.message,
      "pack-requestport refuses @requestport/web's dependencies:\n- react-dom: no workspace the bundle inlines declares it (dependencies)",
    );
    assert.equal(undeclared.built, 0);
    const closure = productionClosure({ members: WEB.notices.members });
    const unnoticed = await refusal(
      "notices",
      {},
      {
        closure: {
          ...closure,
          unresolved: [
            { dependent: "@requestport/web", name: "left-out", range: "1.0.0" },
          ],
        },
      },
    );
    assert.equal(
      unnoticed.message,
      "pack-requestport refuses @requestport/web's THIRD-PARTY-NOTICES:\n- @requestport/web depends on left-out@1.0.0, which this tree does not hold, so THIRD-PARTY-NOTICES cannot cover it",
    );
    assert.equal(unnoticed.built, 0);
  });

  test("refuses a machine path that the rewrite leaves, in any file and any form: the home directory in a chunk, the temporary directory escaped in a client-reference manifest, the staging directory as a percent-encoded file:// URL, the checkout in a binary file; and a symbolic link", async () => {
    const stage = mkdtempSync(join(scratch, "stage with space-"));
    const realTemporary = realpathSync(tmpdir());
    const escapedTemporary = realTemporary.replaceAll("/", "\\/");
    const url = pathToFileURL(join(stage, "x.js")).href;
    const build = standaloneFixture(join(scratch, "standalone-planted"), {
      planted: {
        "apps/web/.next-self-host/server/chunks/7.js": `const home = ${JSON.stringify(join(homedir(), "elsewhere/a.js"))};\n`,
        "apps/web/.next-self-host/server/app/other_client-reference-manifest.js": `globalThis.__RSC_MANIFEST["/other"] = {"clientModules":{"${escapedTemporary}\\/x.tsx":{}}};\n`,
        "apps/web/.next-self-host/server/chunks/9.js": `const here = ${JSON.stringify(url)};\n`,
        "apps/web/.next-self-host/server/planted.bin": Buffer.concat([
          Buffer.from([0]),
          Buffer.from(repositoryRoot),
        ]),
      },
    });
    symlinkSync(
      "./page.js",
      join(build.serverDirectory, ".next-self-host/server/app/linked.js"),
    );
    let message;
    try {
      await stageWeb({
        version: VERSION,
        directory: stage,
        build: async () => build,
      });
    } catch (error) {
      message = error.message;
    }
    assert.ok(
      message?.startsWith("pack-requestport refuses the self-host build:\n"),
      message,
    );
    for (const line of [
      `.next-self-host/server/chunks/7.js holds ${homedir()}`,
      `.next-self-host/server/app/other_client-reference-manifest.js holds ${realTemporary}, as ${escapedTemporary}`,
      `.next-self-host/server/chunks/9.js holds ${stage}, as ${pathToFileURL(stage).pathname}`,
      `.next-self-host/server/planted.bin holds ${repositoryRoot}`,
      ".next-self-host/server/app/linked.js is a symbolic link",
    ]) {
      assert.ok(
        message.split("\n- ").includes(line),
        `${line}\nin\n${message}`,
      );
    }
    assert.equal(
      existsSync(join(stage, ".next-self-host/server/app/linked.js")),
      false,
    );
  });
});

describe("the dependency list and the self-host build, on planted input", () => {
  const inputs = [
    "apps/requestport/src/cli.ts",
    "apps/requestport/src/worker.ts",
  ];
  const external = [
    "@modelcontextprotocol/client",
    "@requestport/db",
    "@requestport/jobs",
    "zod",
  ];
  const planted = (change) => {
    const manifests = structuredClone(readManifests());
    change(manifests);
    return requestportDependencies({ inputs, external, manifests });
  };
  const version = (workspace, name) =>
    readManifests().get(workspace).dependencies[name];

  test("reads the workspaces the bundle inlines from its inputs", () => {
    assert.deepEqual(inlinedWorkspaces(inputs), ["apps/requestport"]);
    assert.deepEqual(
      inlinedWorkspaces([
        ...inputs,
        "packages/db/src/client.ts",
        "apps/web/src/x.ts",
      ]),
      ["apps/requestport", "packages/db"],
    );
  });

  test("declares the third-party externals and REQUESTPORT.declared, each once, at apps/requestport's versions, but next, which it loads from @requestport/web's directory; its @requestport/* externals and @requestport/web are LOCKSTEP's, which the manifest names", () => {
    const { dependencies, problems } = planted(() => {});
    assert.deepEqual(problems, []);
    assert.deepEqual(dependencies, {
      "@electric-sql/pglite": version(
        "apps/requestport",
        "@electric-sql/pglite",
      ),
      "@modelcontextprotocol/client": version(
        "apps/requestport",
        "@modelcontextprotocol/client",
      ),
      zod: version("apps/requestport", "zod"),
    });
  });

  test("refuses a name apps/requestport does not declare, and an @requestport/* package the bundle imports that LOCKSTEP does not name; takes zod at apps/requestport's version whatever auth declares, and next is @requestport/web's alone", () => {
    assert.deepEqual(
      planted((manifests) => {
        delete manifests.get("apps/requestport").dependencies[
          "@modelcontextprotocol/client"
        ];
      }).problems,
      [
        "@modelcontextprotocol/client: no workspace the bundle inlines declares it (dependencies)",
      ],
    );
    assert.deepEqual(
      requestportDependencies({
        inputs,
        external: [...external, "@requestport/theme"],
      }).problems,
      [
        "@requestport/theme: the bundle imports it, and this run packs no @requestport/theme",
      ],
    );
    const auth = planted((manifests) => {
      manifests.get("packages/auth").dependencies.zod = "4.9.9";
      manifests.get("apps/web").dependencies.next = "16.3.9";
    });
    assert.deepEqual(auth.problems, []);
    assert.equal(auth.dependencies.zod, version("apps/requestport", "zod"));
  });

  test("refuses PGlite, which requestport declares for start --storage pglite and db names only as an optional peer, without apps/requestport's declaration", () => {
    assert.deepEqual(
      planted((manifests) => {
        delete manifests.get("apps/requestport").dependencies[
          "@electric-sql/pglite"
        ];
      }).problems,
      [
        "@electric-sql/pglite: no workspace the bundle inlines declares it (dependencies)",
      ],
    );
  });

  test("the self-host build gets the placeholder DATABASE_URL, a closed port on loopback with no password, Next's telemetry off, PATH, HOME and TMPDIR, and nothing else of this environment but SELF_HOST_CONTAINED_VARIABLE, a new directory into which its recorder writes; buildWeb answers what was written there, and removes it", async () => {
    const url = new URL(PLACEHOLDER_DATABASE_URL);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "9");
    assert.equal(url.password, "");
    assert.deepEqual(
      webBuildEnvironment({
        PATH: "/bin",
        HOME: "/planted/home",
        DATABASE_URL: "postgres://someone@db.example/production",
        RESEND_API_KEY: "re_secret",
      }),
      {
        PATH: "/bin",
        HOME: "/planted/home",
        NEXT_TELEMETRY_DISABLED: "1",
        DATABASE_URL: PLACEHOLDER_DATABASE_URL,
      },
    );
    assert.deepEqual(
      webBuildEnvironment({
        PATH: "/bin",
        HOME: "/planted/home",
        TMPDIR: "/planted/tmp",
        BETTER_AUTH_SECRET: "a real secret",
      }),
      {
        PATH: "/bin",
        HOME: "/planted/home",
        TMPDIR: "/planted/tmp",
        NEXT_TELEMETRY_DISABLED: "1",
        DATABASE_URL: PLACEHOLDER_DATABASE_URL,
      },
    );
    // buildWeb's own default: this process's environment, through
    // webBuildEnvironment. TMPDIR is there only when this process has one
    // (above), so the names are compared without it.
    const webDirectory = join(scratch, "web-build", "apps", "web");
    mkdirSync(webDirectory, { recursive: true });
    const invocations = [];
    const built = await buildWeb({
      webDirectory,
      runNextBuild: async (invocation) => {
        invocations.push(invocation);
        const records = invocation.env[SELF_HOST_CONTAINED_VARIABLE];
        assert.ok(existsSync(records), records);
        writeFileSync(
          join(records, "101.json"),
          JSON.stringify({
            compilers: ["server", "client"],
            files: ["/r/b.js", "/r/a.js"],
            replaced: ["/r/b.js"],
          }),
        );
        writeFileSync(
          join(records, "102.json"),
          JSON.stringify({
            compilers: ["edge-server"],
            files: ["/r/a.js", "/r/c.js"],
          }),
        );
        writeTree(join(webDirectory, ".next-self-host"), {
          "required-server-files.json": JSON.stringify({
            config: { output: "standalone", distDir: ".next-self-host" },
            relativeAppDir: "apps/web",
          }),
          // The routes buildSelfHostWeb reads back: none, as this apps/web
          // has no src/app (ruling 170).
          "server/app-paths-manifest.json": "{}",
          "standalone/apps/web/server.js": "",
          "static/chunks/a.js": "",
        });
        return 0;
      },
    });
    assert.equal(invocations.length, 1);
    const { env } = invocations[0];
    assert.deepEqual(
      Object.keys(env)
        .filter((name) => name !== "TMPDIR")
        .sort(),
      [
        "BETTER_AUTH_SECRET",
        "BETTER_AUTH_URL",
        "DATABASE_URL",
        "HOME",
        "NEXT_PUBLIC_APP_URL",
        "NEXT_TELEMETRY_DISABLED",
        "NODE_ENV",
        "PATH",
        "REQUESTPORT_SELF_HOST_BUILD",
        SELF_HOST_CONTAINED_VARIABLE,
      ],
    );
    assert.deepEqual(built.contained, {
      compilers: ["client", "edge-server", "server"],
      files: ["/r/a.js", "/r/b.js", "/r/c.js"],
      replaced: ["/r/b.js"],
    });
    assert.equal(existsSync(env[SELF_HOST_CONTAINED_VARIABLE]), false);
    assert.equal(env.DATABASE_URL, PLACEHOLDER_DATABASE_URL);
    assert.equal(env.NEXT_TELEMETRY_DISABLED, "1");
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(
      built.serverDirectory,
      join(webDirectory, ".next-self-host/standalone/apps/web"),
    );
    assert.equal(
      built.standaloneDirectory,
      join(webDirectory, ".next-self-host/standalone"),
    );
  });

  test("containedPackages counts each file under a node_modules by the package directly under the last one in its path, by its manifest's name and version; a file inside a package that package vendors (a package.json below its own naming another package, as Next keeps them under dist/compiled) by the vendored package, keyed by where it is, so that no installed package's name@version can be it; a package.json below a package's own that names nothing, that package or a subpath of it is its own; leaves out a workspace's own module; and refuses a package directory with no manifest that names it", () => {
    const root = join(scratch, "contained");
    const store = join(root, "node_modules/.pnpm");
    const next = `${store}/next@16.3.8/node_modules/next`;
    const a = `${store}/@scope+a@1.0.0/node_modules/@scope/a`;
    writeTree(root, {
      "node_modules/.pnpm/next@16.3.8/node_modules/next/package.json":
        '{"name":"next","version":"16.3.8"}\n',
      "node_modules/.pnpm/next@16.3.8/node_modules/next/dist/esm/package.json":
        '{"type":"module"}\n',
      "node_modules/.pnpm/next@16.3.8/node_modules/next/dist/compiled/react/package.json":
        '{"name":"react-builtin"}\n',
      "node_modules/.pnpm/next@16.3.8/node_modules/next/dist/compiled/cookie/package.json":
        '{"name":"cookie","license":"MIT"}\n',
      "node_modules/.pnpm/next@16.3.8/node_modules/next/dist/compiled/hash.js/package.json":
        '{"name":"hash.js","version":"1.1.7"}\n',
      "node_modules/.pnpm/next@16.3.8/node_modules/next/dist/compiled/hash.js/sha256/package.json":
        '{"name":"hash.js"}\n',
      "node_modules/.pnpm/@scope+a@1.0.0/node_modules/@scope/a/package.json":
        '{"name":"@scope/a","version":"1.0.0"}\n',
      "node_modules/.pnpm/@scope+a@1.0.0/node_modules/@scope/a/build/esm/package.json":
        '{"name":"@scope/a"}\n',
      "node_modules/.pnpm/@scope+a@1.0.0/node_modules/@scope/a/sub/package.json":
        '{"name":"@scope/a/sub"}\n',
      "node_modules/.pnpm/b@2.0.0/node_modules/b/package.json":
        '{"name":"not-b","version":"2.0.0"}\n',
    });
    const found = containedPackages([
      `${next}/dist/compiled/react/index.js`,
      `${next}/dist/compiled/react/cjs/react.production.js`,
      `${next}/dist/compiled/cookie/index.js`,
      `${next}/dist/compiled/hash.js/sha256/index.js`,
      `${next}/dist/esm/client/app-index.js`,
      `${next}/dist/client/app-index.js`,
      `${a}/lib/x.js`,
      `${a}/build/esm/y.js`,
      `${a}/sub/z.js`,
      `${store}/b@2.0.0/node_modules/b/index.js`,
      `${store}/b@2.0.0/node_modules/b/other.js`,
      `${store}/c@3.0.0/node_modules/c/index.js`,
      join(root, "apps/web/src/app/page.tsx"),
    ]);
    assert.deepEqual(
      [...found.packages.keys()],
      [
        "@scope/a@1.0.0",
        "cookie (vendored in next@16.3.8 at dist/compiled/cookie)",
        "hash.js@1.1.7 (vendored in next@16.3.8 at dist/compiled/hash.js)",
        "next@16.3.8",
        "react-builtin (vendored in next@16.3.8 at dist/compiled/react)",
      ],
    );
    assert.equal(found.packages.get("next@16.3.8").directory, next);
    assert.equal(found.packages.get("next@16.3.8").vendoredIn, undefined);
    assert.deepEqual(
      found.packages.get(
        "cookie (vendored in next@16.3.8 at dist/compiled/cookie)",
      ),
      {
        key: "cookie (vendored in next@16.3.8 at dist/compiled/cookie)",
        directory: `${next}/dist/compiled/cookie`,
        manifest: { name: "cookie", license: "MIT" },
        vendoredIn: { key: "next@16.3.8", name: "next" },
        files: [`${next}/dist/compiled/cookie/index.js`],
      },
    );
    assert.deepEqual(found.packages.get("next@16.3.8").files, [
      `${next}/dist/client/app-index.js`,
      `${next}/dist/esm/client/app-index.js`,
    ]);
    assert.deepEqual(found.problems, [
      `${store}/b@2.0.0/node_modules/b holds a module the build contains, and no package.json that names b with a version`,
      `${store}/c@3.0.0/node_modules/c holds a module the build contains, and no package.json that names c with a version`,
    ]);
  });

  test("containedClosure keeps, of a production closure, the packages the build holds a module of, those outside it that its beyond list names, and those either vendors; names them by its scope; and refuses a build that sealed no compilation, or none of one of Next's three compilers (WEB.compilers), holds a package outside the closure the list does not name or vendored in one, or holds no installed package of a name the list gives", () => {
    const root = join(scratch, "contained-closure");
    writeTree(root, {
      "node_modules/a/package.json": '{"name":"a","version":"1.0.0"}\n',
      "node_modules/b/package.json": '{"name":"b","version":"2.0.0"}\n',
      "node_modules/b/vendor/v/package.json": '{"name":"v","license":"MIT"}\n',
      "node_modules/b/vendor/y/package.json": '{"name":"y"}\n',
      "node_modules/z/package.json": '{"name":"z","version":"9.0.0"}\n',
      "node_modules/z/vendor/w/package.json": '{"name":"w"}\n',
      "node_modules/q/package.json": '{"name":"q","version":"3.0.0"}\n',
      "node_modules/q/vendor/u/package.json": '{"name":"u"}\n',
    });
    const entry = (name, version) => [
      `${name}@${version}`,
      {
        key: `${name}@${version}`,
        directory: join(root, "node_modules", name),
        manifest: { name, version },
      },
    ];
    const production = {
      members: ["@requestport/web"],
      workspaces: ["@requestport/web"],
      packages: new Map([entry("a", "1.0.0"), entry("b", "2.0.0")]),
      unresolved: [],
    };
    assert.deepEqual(WEB.compilers, ["client", "edge-server", "server"]);
    const sealed = ["client", "edge-server", "server"];
    const kept = containedClosure(
      production,
      { compilers: sealed, files: [join(root, "node_modules/b/index.js")] },
      [],
    );
    assert.deepEqual(kept.problems, []);
    assert.deepEqual([...kept.closure.packages.keys()], ["b@2.0.0"]);
    assert.equal(
      kept.closure.scope,
      "the third-party code @requestport/web's self-host build contains",
    );
    assert.deepEqual(
      noticesProblems(kept.closure, "").map((problem) => problem),
      [
        "THIRD-PARTY-NOTICES has no entry for b@2.0.0, which is in the third-party code @requestport/web's self-host build contains",
      ],
    );
    assert.deepEqual(
      containedClosure(
        production,
        { compilers: [], files: [join(root, "node_modules/z/index.js")] },
        [],
      ).problems,
      [
        "the self-host build recorded no sealed compilation, so nothing says what code it contains",
        "the self-host build contains z@9.0.0, which is not in the production closure of @requestport/web",
      ],
    );
    // A record lost with the process that held it: the edge-server
    // compilation's, here.
    assert.deepEqual(
      containedClosure(
        production,
        {
          compilers: ["client", "server", "server"],
          files: [join(root, "node_modules/b/index.js")],
        },
        [],
      ).problems,
      [
        "the self-host build recorded no sealed compilation of Next's edge-server compiler, so nothing says what code that compilation contains",
      ],
    );
    assert.deepEqual(containedClosure(production, undefined, []).problems, [
      "the self-host build recorded no sealed compilation, so nothing says what code it contains",
    ]);
    const beyond = containedClosure(
      production,
      {
        compilers: sealed,
        files: [
          join(root, "node_modules/b/index.js"),
          join(root, "node_modules/b/vendor/v/index.js"),
          join(root, "node_modules/b/vendor/y/index.js"),
          join(root, "node_modules/z/index.js"),
          join(root, "node_modules/z/vendor/w/index.js"),
          join(root, "node_modules/q/vendor/u/index.js"),
        ],
      },
      ["z", "y"],
    );
    assert.deepEqual(
      [...beyond.closure.packages.keys()],
      [
        "b@2.0.0",
        "v (vendored in b@2.0.0 at vendor/v)",
        "w (vendored in z@9.0.0 at vendor/w)",
        "y (vendored in b@2.0.0 at vendor/y)",
        "z@9.0.0",
      ],
    );
    assert.equal(
      beyond.closure.packages.get("z@9.0.0").directory,
      join(root, "node_modules/z"),
    );
    assert.equal(
      beyond.closure.packages.get("v (vendored in b@2.0.0 at vendor/v)")
        .directory,
      join(root, "node_modules/b/vendor/v"),
    );
    assert.deepEqual(beyond.problems, [
      "the self-host build contains u (vendored in q@3.0.0 at vendor/u), and q@3.0.0, which holds it, is not in the production closure of @requestport/web",
      "WEB.beyondClosure names y, and the self-host build contains no module of it",
    ]);
  });

  test("emittedPackages attributes what the build emits outside its chunks: each static/media file byte for byte a file a package of the closure ships (a font next/font copies), and each licence banner a static/css stylesheet carries for a package of the closure (Tailwind's); a media file byte for byte one of apps/web's own sources it lists as its own; and it refuses a media file that is neither, and a banner for no package of the closure (ruling 197 item 4)", () => {
    const root = join(scratch, "emitted");
    const font = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03]);
    writeTree(root, {
      "node_modules/fonts/package.json": '{"name":"fonts","version":"1.0.0"}\n',
      "node_modules/fonts/dist/a.woff2": font,
      "node_modules/fonts/dist/b.woff2": Buffer.from([
        0x77, 0x4f, 0x46, 0x32, 0x09, 0x09, 0x09, 0x09,
      ]),
      "node_modules/sheets/package.json":
        '{"name":"sheets","version":"2.0.0"}\n',
      "web/src/app/logo.svg": "<svg/>\n",
      "build/.next-self-host/static/media/abc.p.woff2": font,
      "build/.next-self-host/static/media/logo.0123.svg": "<svg/>\n",
      "build/.next-self-host/static/media/stray.woff2": Buffer.from([
        0x77, 0x4f, 0x46, 0x32, 0x07, 0x07, 0x07, 0x07,
      ]),
      "build/.next-self-host/static/css/x.css":
        "/*! sheets v2.0.0 | MIT License | https://sheets.example */\n.a{}\n/*! ghost v9.9.9 | MIT */\n",
    });
    const entry = (name, version) => [
      `${name}@${version}`,
      {
        key: `${name}@${version}`,
        directory: join(root, "node_modules", name),
        manifest: { name, version },
      },
    ];
    const closure = {
      members: ["@requestport/web"],
      workspaces: ["@requestport/web"],
      packages: new Map([entry("fonts", "1.0.0"), entry("sheets", "2.0.0")]),
      unresolved: [],
    };
    const own = [join(root, "web/src"), join(root, "web/public")];
    assert.deepEqual(WEB.ownSources, ["apps/web/src", "apps/web/public"]);
    assert.deepEqual(emittedPackages(join(root, "build"), closure, own), {
      files: [
        join(root, "node_modules/fonts/dist/a.woff2"),
        join(root, "node_modules/sheets/package.json"),
      ],
      own: [".next-self-host/static/media/logo.0123.svg"],
      problems: [
        ".next-self-host/static/media/stray.woff2 is, byte for byte, no file a package of the production closure of @requestport/web ships, nor one of apps/web's own sources (apps/web/src, apps/web/public), so no entry could cover it",
        ".next-self-host/static/css/x.css carries a licence banner for ghost v9.9.9, which is not a package of the production closure of @requestport/web",
      ],
    });
    assert.deepEqual(emittedPackages(join(root, "no-build"), closure, own), {
      files: [],
      own: [],
      problems: [],
    });
  });

  test("the neutral root is refused where it exists, and does not exist here", () => {
    const asked = [];
    assert.deepEqual(
      neutralRootProblems((path) => {
        asked.push(path);
        return true;
      }),
      [
        `${NEUTRAL_ROOT}, the root @requestport/web is rewritten to, exists on this machine`,
      ],
    );
    assert.deepEqual(asked, [NEUTRAL_ROOT]);
    assert.deepEqual(neutralRootProblems(), []);
  });

  test("machinePaths holds each path as given and as resolved; machinePathProblems finds a path in any of its forms", () => {
    const paths = machinePaths(scratch);
    for (const path of [
      repositoryRoot,
      tmpdir().replace(/\/+$/u, ""),
      realpathSync(tmpdir()),
      homedir(),
      scratch,
      realpathSync(scratch),
    ]) {
      assert.ok(paths.includes(path), `${path} is a machine path`);
    }
    const spaced = "/opt/a b+c";
    assert.deepEqual(pathForms(spaced), [
      "/opt/a b+c",
      "\\/opt\\/a b+c",
      "/opt/a%20b+c",
      "%2Fopt%2Fa%20b%2Bc",
    ]);
    assert.deepEqual(
      [
        `"${spaced}/x"`,
        `"\\/opt\\/a b+c\\/x"`,
        "file:///opt/a%20b+c/x",
        "?path=%2Fopt%2Fa%20b%2Bc%2Fx",
        "/opt/a_b+c",
      ].map((text) => machinePathProblems("f.js", Buffer.from(text), [spaced])),
      [
        ["f.js holds /opt/a b+c"],
        ["f.js holds /opt/a b+c, as \\/opt\\/a b+c"],
        ["f.js holds /opt/a b+c, as /opt/a%20b+c"],
        ["f.js holds /opt/a b+c, as %2Fopt%2Fa%20b%2Bc"],
        [],
      ],
    );
  });
});

/** `entries` with `changes`: a string or a `Buffer` sets an entry, `undefined` removes it. */
function planted(entries, changes) {
  const copy = new Map(entries);
  for (const [path, body] of Object.entries(changes)) {
    if (body === undefined) copy.delete(path);
    else copy.set(path, Buffer.isBuffer(body) ? body : Buffer.from(body));
  }
  return copy;
}

/** `entries` with their `package.json` changed by `change`. */
function withManifest(entries, change) {
  const manifest = JSON.parse(
    entries.get("package/package.json").toString("utf8"),
  );
  change(manifest);
  return planted(entries, {
    "package/package.json": JSON.stringify(manifest),
  });
}

/**
 * Two of the other ways, besides `private: true`, that a packed manifest can
 * fail to say `private: false`: `private` left out, and `private` as the
 * string "false".
 */
const PRIVATE_NOT_FALSE = [
  (manifest) => {
    delete manifest.private;
  },
  (manifest) => {
    manifest.private = "false";
  },
];

/**
 * `check`'s problems for each of `PRIVATE_NOT_FALSE` planted in the
 * tarball's manifest, with the manifest the pack wrote (`packed.manifest`)
 * holding the same plant, so that no written field differs.
 */
function privateNotFalseProblems(check, entries, packed) {
  return PRIVATE_NOT_FALSE.map((change) => {
    const release = withManifest(entries, change);
    return check(release, {
      ...packed,
      manifest: JSON.parse(
        release.get("package/package.json").toString("utf8"),
      ),
    });
  });
}

/** Asserts that `problems` holds each of `lines`. */
function assertHolds(problems, lines) {
  for (const line of lines) {
    assert.ok(problems.includes(line), `${line}\nin\n${problems.join("\n")}`);
  }
}

/** A source export's module name: `./src/<name>.ts`'s `<name>`. */
function moduleOf(target) {
  return basename(target, ".ts");
}

describe("the packed manifests", () => {
  test("requestport's: the published name requestport, which the pack writes while the workspace keeps @requestport/requestport (ruling 86); the stamped version; private false (option (B)); type module; the mapping's licence; the public repository with apps/requestport as directory; bin requestport on dist/requestport.js; files LICENSE and dist: no migrations, no web and no THIRD-PARTY-NOTICES (ruling 197 item 4); engines as the repository's root declares; the third-party dependency list, and each of the thirteen packages of LOCKSTEP at the stamped version, G.7's eleven, @requestport/web and @requestport/client (ruling 190; ruling 193 item 6); no next, which it loads from @requestport/web's directory; no scripts", () => {
    const { staged: packed, entries } = run.packs.requestport;
    assert.equal(
      readJson("apps/requestport/package.json").name,
      "@requestport/requestport",
    );
    const thirdParty = requestportDependencies({
      inputs: staged.inputs,
      external: staged.external,
    }).dependencies;
    const expected = {
      name: "requestport",
      version: VERSION,
      private: false,
      type: "module",
      license: "Apache-2.0",
      repository: publicRepository("apps/requestport"),
      bin: { requestport: "dist/requestport.js" },
      files: ["LICENSE", "dist"],
      engines: { node: readJson("package.json").engines.node },
      dependencies: Object.fromEntries(
        Object.entries({
          ...thirdParty,
          ...Object.fromEntries(LOCKSTEP.map((name) => [name, VERSION])),
        }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    };
    assert.equal(expected.engines.node, ">=22 <23");
    assert.deepEqual(packed.manifest, expected);
    assert.deepEqual(LOCKSTEP, [
      ...Object.values(PACKAGES).map(({ bundle }) => bundle.package),
      "@requestport/web",
      "@requestport/client",
    ]);
    assert.equal(LOCKSTEP.length, 13);
    assert.deepEqual(
      Object.entries(expected.dependencies).filter(([name]) =>
        name.startsWith("@requestport/"),
      ),
      [...LOCKSTEP].sort().map((name) => [name, VERSION]),
    );
    assert.equal(Object.hasOwn(expected.dependencies, "next"), false);
    assert.deepEqual(
      requestportManifest({ version: VERSION, dependencies: thirdParty }),
      expected,
    );
    assert.deepEqual(
      JSON.parse(entries.get("package/package.json").toString("utf8")),
      expected,
    );
  });

  test("@requestport/client's (§2.8.5; ruling 100): the source's name, the stamped version, private false (option (B)), type module, the mapping's licence, the public repository with packages/client as directory, each source export as { types, import } on dist/, files LICENSE and dist, engines as the root declares, zod alone at the version the source declares, and empty peer fields; the source manifest still names src/", () => {
    const { staged: packed, entries } = run.packs.client;
    const source = readJson("packages/client/package.json");
    const expected = {
      name: "@requestport/client",
      version: VERSION,
      private: false,
      type: "module",
      license: "Apache-2.0",
      repository: publicRepository("packages/client"),
      exports: Object.fromEntries(
        Object.entries(source.exports).map(([subpath, target]) => [
          subpath,
          {
            types: `./dist/${moduleOf(target)}.d.ts`,
            import: `./dist/${moduleOf(target)}.js`,
          },
        ]),
      ),
      files: ["LICENSE", "dist"],
      engines: { node: readJson("package.json").engines.node },
      dependencies: { zod: source.dependencies.zod },
      peerDependencies: {},
      peerDependenciesMeta: {},
    };
    assert.deepEqual(packed.manifest, expected);
    assert.deepEqual(
      JSON.parse(entries.get("package/package.json").toString("utf8")),
      expected,
    );
    assert.equal(Object.keys(source.exports).length, 10);
    for (const target of Object.values(source.exports)) {
      assert.match(target, /^\.\/src\/[\w-]+\.ts$/u);
    }
  });

  test("H's three licence mapping entries are Apache-2.0 and licenses/Apache-2.0.txt, D3's answer, as G.7's are (ruling 175)", () => {
    for (const pack of [REQUESTPORT, WEB, CLIENT]) {
      assert.equal(pack.license, "Apache-2.0");
      assert.equal(pack.licenseText, "licenses/Apache-2.0.txt");
    }
  });
});

describe("@requestport/client's tarball (Done when 12c; ruling 100)", () => {
  test("holds exactly package.json, LICENSE and tsc's emit: each export's module as .js and .d.ts, and lock's, which the token source and the file store import and no subpath exports", () => {
    const { entries } = run.packs.client;
    const modules = [
      ...Object.values(readJson("packages/client/package.json").exports).map(
        moduleOf,
      ),
      "lock",
    ];
    assert.deepEqual(CLIENT.internal, ["lock"]);
    assert.deepEqual(
      [...entries.keys()].sort(),
      [
        "package/LICENSE",
        "package/package.json",
        ...modules.flatMap((name) => [
          `package/dist/${name}.d.ts`,
          `package/dist/${name}.js`,
        ]),
      ].sort(),
    );
    assert.ok(
      readFileSync(
        join(repositoryRoot, "packages/client/src/token-source.ts"),
        "utf8",
      ).includes('from "./lock.js"'),
    );
  });

  test("G.7's checkTarball accepts it, and Done when 12c by name finds nothing: every export's .js and .d.ts, no test, nothing under src/, no onboard-live, no .env file and no workspace: in any file", () => {
    const { staged: packed, entries } = run.packs.client;
    assert.deepEqual(checkTarball(entries, packed), []);
    assert.deepEqual(doneWhen12cProblems(entries, packed), []);
    assert.deepEqual(checkClientTarball(entries, packed), []);
  });

  test("@requestport/client: the check refuses, planted in the real tarball's manifest, a manifest that does not say private: false, a repository with another directory than packages/client, and files that do not name LICENSE, each also as a written field changed, by G.7's checkTarball (option (B), ruling 175; ruling 207 item 3)", () => {
    const { staged: packed, entries } = run.packs.client;
    const repository = {
      ...publicRepository("packages/client"),
      directory: "packages/planted",
    };
    const files = packed.manifest.files.filter((file) => file !== "LICENSE");
    assert.deepEqual(
      checkClientTarball(
        withManifest(entries, (manifest) => {
          manifest.private = true;
          manifest.repository = repository;
          manifest.files = files;
        }),
        packed,
      ).sort(),
      [
        "package.json's private is true, not false",
        `package.json's repository is ${JSON.stringify(repository)}, not ${JSON.stringify(publicRepository("packages/client"))}`,
        `package.json's files is ${JSON.stringify(files)}, not ${JSON.stringify(packed.manifest.files)}`,
        "package.json does not say private: false",
        `package.json's repository is ${JSON.stringify(repository)}, not the public repository's ${JSON.stringify(publicRepository("packages/client"))}`,
        "package.json's files does not name LICENSE",
      ].sort(),
    );
    // Not only `true`: `private` left out, or the string "false", is refused
    // the same way, from the tarball's manifest alone.
    assert.deepEqual(
      privateNotFalseProblems(checkClientTarball, entries, packed),
      [
        ["package.json does not say private: false"],
        ["package.json does not say private: false"],
      ],
    );
  });

  test("Done when 12c refuses, planted in the real tarball: an export without its .d.ts, a test, a file under src/, onboard-live, an .env file and workspace: in a file; checkClientTarball reports them with G.7's lines", () => {
    const { staged: packed, entries } = run.packs.client;
    const tarball = planted(entries, {
      "package/dist/ci.d.ts": undefined,
      "package/dist/ci.test.js": "",
      "package/src/index.ts": "",
      "package/dist/onboard-live.js": "",
      "package/.env.local": "",
      "package/dist/http.js": Buffer.concat([
        entries.get("package/dist/http.js"),
        Buffer.from('\n// "@requestport/core": "workspace:*"\n'),
      ]),
    });
    const lines = [
      "Done when 12c: ./ci has no dist/ci.d.ts",
      "Done when 12c: dist/ci.test.js is a test",
      "Done when 12c: src/index.ts is under src/",
      "Done when 12c: dist/onboard-live.js is onboard-live",
      "Done when 12c: .env.local is an environment file",
      "Done when 12c: dist/http.js holds workspace:",
    ];
    assert.deepEqual(doneWhen12cProblems(tarball, packed).sort(), lines.sort());
    const all = checkClientTarball(tarball, packed);
    assertHolds(all, [
      ...lines,
      "dist/ci.d.ts is on the allow-list but not in the tarball",
      "dist/ci.test.js is not on the allow-list",
      "dist/ci.test.js is a test",
      ".env.local is an environment file",
    ]);
  });

  test("checkClientTarball refuses this machine's paths in every form, planted in the real tarball: the home directory JSON-escaped in a declaration and the repository percent-encoded whole in a module, each once, by G.7's checkTarball, which reads every form (ruling 197 item 3)", () => {
    const { staged: packed, entries } = run.packs.client;
    const escaped = homedir().replaceAll("/", "\\/");
    const encoded = encodeURIComponent(repositoryRoot);
    const tarball = planted(entries, {
      "package/dist/http.d.ts": Buffer.concat([
        entries.get("package/dist/http.d.ts"),
        Buffer.from(`\n// "${escaped}"\n`),
      ]),
      "package/dist/ci.js": Buffer.concat([
        entries.get("package/dist/ci.js"),
        Buffer.from(`\nconst at = "${encoded}";\n`),
      ]),
    });
    // Each path of this machine the two plants hold, the home directory and
    // the checkout's among them, wherever the checkout is.
    const expected = [
      ...heldMachinePaths("dist/ci.js", encoded, packed.directory),
      ...heldMachinePaths("dist/http.d.ts", escaped, packed.directory),
    ].sort();
    assert.ok(
      expected.includes(`dist/ci.js holds ${repositoryRoot}, as ${encoded}`),
    );
    assert.ok(
      expected.includes(`dist/http.d.ts holds ${homedir()}, as ${escaped}`),
    );
    assert.deepEqual(checkTarball(tarball, packed).sort(), expected);
    assert.deepEqual(checkClientTarball(tarball, packed).sort(), expected);
  });

  test("the stage refuses an emitted module that is neither an export's nor on CLIENT.internal, an export's or an internal module that is not emitted, and an export that is not a module directly in src/", () => {
    const exported = [
      { subpath: ".", name: "index" },
      { subpath: "./ci", name: "ci" },
    ];
    assert.deepEqual(
      emitProblems(
        [
          "dist/ci.js",
          "dist/extra.d.ts",
          "dist/extra.js",
          "dist/index.d.ts",
          "dist/index.js",
          "dist/lock.d.ts",
        ],
        { entries: exported, internal: ["lock"] },
      ),
      [
        "dist/extra.d.ts is emitted, and is neither an export's module nor on CLIENT.internal",
        "dist/extra.js is emitted, and is neither an export's module nor on CLIENT.internal",
        "dist/ci.d.ts is not emitted",
        "dist/lock.js is not emitted",
      ],
    );
    assert.deepEqual(
      clientEntries({
        exports: {
          ".": "./src/index.ts",
          "./deep": "./src/sub/deep.ts",
          "./built": "./dist/built.js",
          "./conditions": { import: "./src/x.ts" },
        },
      }),
      {
        entries: [{ subpath: ".", name: "index" }],
        problems: [
          'packages/client exports ./deep as "./src/sub/deep.ts", which is not a module directly in src/',
          'packages/client exports ./built as "./dist/built.js", which is not a module directly in src/',
          'packages/client exports ./conditions as {"import":"./src/x.ts"}, which is not a module directly in src/',
        ],
      },
    );
    assert.deepEqual(clientEntries({}), {
      entries: [],
      problems: ["packages/client exports nothing"],
    });
  });

  test("its dependencies are what the emit imports, at the versions the source declares: import and export declarations, import() and import types, in .js and .d.ts, builtins and paths aside; a package the source does not declare, or declares as a workspace package, is refused", async () => {
    const directory = join(scratch, "client-imports");
    writeTree(directory, {
      "dist/a.js": [
        'import { z } from "zod";',
        'import process from "node:process";',
        'import { lock } from "./lock.js";',
        'export { b } from "@scope/named/sub";',
        'export * from "fs";',
        'const later = await import("lazy-package");',
        "const unknown = await import(process.argv[2]);",
        "",
      ].join("\n"),
      "dist/a.d.ts": [
        'import type { ZodType } from "zod";',
        'export declare const t: import("typed-only").T;',
        'export type { U } from "./u.js";',
        "",
      ].join("\n"),
    });
    const found = await importedPackages(directory, [
      "dist/a.d.ts",
      "dist/a.js",
    ]);
    assert.deepEqual(found, {
      names: ["@scope/named", "lazy-package", "typed-only", "zod"],
      problems: ["dist/a.js imports something that is not a string literal"],
    });
    assert.deepEqual(
      clientDependencies(["zod", "@requestport/core", "left-pad"], {
        dependencies: { zod: "4.4.3", "@requestport/core": "workspace:*" },
      }),
      {
        dependencies: { zod: "4.4.3" },
        problems: [
          "the emit imports @requestport/core, which packages/client declares as a workspace package (workspace:*)",
          "the emit imports left-pad, which packages/client does not declare in dependencies",
        ],
      },
    );
  });
});

describe("requestport's tarball", () => {
  test("holds exactly the allow-list derived from the stage: package.json, LICENSE, README.md and dist/'s JavaScript, and no migrations/, web/ or THIRD-PARTY-NOTICES; H's check accepts it, and refuses a THIRD-PARTY-NOTICES planted in it (ruling 197 item 4)", () => {
    const { staged: packed, entries } = run.packs.requestport;
    assert.deepEqual(
      packed.allowList,
      ["LICENSE", "README.md", "package.json", ...staged.javascript].sort(),
    );
    assert.deepEqual(
      [...entries.keys()].map((path) => path.replace(/^package\//u, "")).sort(),
      packed.allowList,
    );
    assert.deepEqual(
      [...entries.keys()].filter((path) =>
        /^package\/(?:migrations|web)\//u.test(path),
      ),
      [],
    );
    assert.deepEqual(readdirSync(packed.directory).sort(), [
      "LICENSE",
      "README.md",
      "dist",
      "package.json",
    ]);
    assert.deepEqual(checkRequestportTarball(entries, packed), []);
    assert.deepEqual(
      checkRequestportTarball(
        planted(entries, {
          "package/THIRD-PARTY-NOTICES": "Third-party notices\n",
        }),
        packed,
      ),
      ["THIRD-PARTY-NOTICES is not on the allow-list"],
    );
  });

  test("its LICENSE is licenses/Apache-2.0.txt, byte for byte, and its license field Apache-2.0: H's mapping entry", () => {
    const { entries } = run.packs.requestport;
    assert.ok(
      entries
        .get("package/LICENSE")
        .equals(readFileSync(join(repositoryRoot, "licenses/Apache-2.0.txt"))),
    );
    assert.equal(
      JSON.parse(entries.get("package/package.json").toString("utf8")).license,
      "Apache-2.0",
    );
  });

  test("its bin is requestport alone, on dist/requestport.js, which starts with the hashbang; unpacked outside the repository with nothing installed, it prints the version the pack stamped", () => {
    const { entries } = run.packs.requestport;
    const unpacked = join(scratch, "unpacked");
    writeTree(unpacked, Object.fromEntries(entries));
    const manifest = JSON.parse(
      readFileSync(join(unpacked, "package/package.json"), "utf8"),
    );
    assert.deepEqual(manifest.bin, { requestport: "dist/requestport.js" });
    const bin = join(unpacked, "package", manifest.bin.requestport);
    assert.ok(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"));
    const version = spawnSync(process.execPath, [bin, "--version"], {
      cwd: unpacked,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(version.stderr, "");
    assert.equal(version.status, 0);
    assert.equal(version.stdout, `requestport ${VERSION}\n`);
  });

  test("the check refuses, planted in the real tarball: a file off the allow-list, one missing, one outside package/, a test, an .env file, a source map, test support, the sweep's ledger, a machine path, a workspace: specifier and a module comment naming a test-only module in a chunk, a module comment naming another workspace's module, a migration and a file of web/, which db and @requestport/web carry, and a LICENSE with other words", () => {
    const { staged: packed, entries } = run.packs.requestport;
    const [chunk, other] = packed.allowList.filter((path) =>
      /^dist\/chunk-[^/]+\.js$/u.test(path),
    );
    const problems = checkRequestportTarball(
      planted(entries, {
        [`package/${other}`]: undefined,
        "outside/x.js": "",
        "package/dist/cli.test.js": "",
        "package/.env": "",
        "package/dist/requestport.js.map": "{}",
        "package/dist/test-support/fixture.js": "",
        "package/dist/tenant-scope-sweep.json": "{}",
        [`package/${chunk}`]: Buffer.concat([
          entries.get(`package/${chunk}`),
          Buffer.from(
            `\n// apps/requestport/src/start/start.test-entry.ts\n// packages/db/src/client.ts\nconst at = "${homedir()}/x";\nconst spec = "workspace:^1.0.0";\n`,
          ),
        ]),
        "package/migrations/0000_init.sql": `-- ${repositoryRoot}\n`,
        "package/web/server.js": "export {};\n",
        "package/LICENSE": "Other words.\n",
      }),
      packed,
    );
    assertHolds(problems, [
      `${other} is on the allow-list but not in the tarball`,
      "outside/x.js is outside package/",
      "dist/cli.test.js is not on the allow-list",
      "dist/cli.test.js is a test",
      ".env is an environment file",
      "dist/requestport.js.map is a source map",
      "dist/test-support/fixture.js is test support",
      "dist/tenant-scope-sweep.json is the sweep's ledger",
      `${chunk} holds ${homedir()}`,
      `${chunk} holds a workspace: specifier`,
      `${chunk} inlines apps/requestport/src/start/start.test-entry.ts, which only a test reaches`,
      `${chunk} inlines packages/db/src/client.ts, which is not one of apps/requestport's modules`,
      "migrations/0000_init.sql is not on the allow-list",
      `migrations/0000_init.sql holds ${repositoryRoot}`,
      "web/server.js is not on the allow-list",
      "LICENSE is not licenses/Apache-2.0.txt, byte for byte",
    ]);
    assertHolds(
      checkRequestportTarball(
        planted(entries, { "package/LICENSE": undefined }),
        packed,
      ),
      [
        "LICENSE is on the allow-list but not in the tarball",
        "LICENSE is missing: the mapping names licenses/Apache-2.0.txt",
      ],
    );
  });

  test("the check refuses db's private modules, planted in the real tarball (ruling 183 item 9; ruling 193 item 5; ruling 194 item 3): each digest packages/db/src/shared-databases.ts names, the kind = \"private\" marker, and each doc comment of shared-databases.ts, hosted-driver.ts and hosted-migrator.ts that its public variant lacks, by G.7's privateModuleProblems; and a module comment naming one, as another workspace's module", () => {
    const { staged: packed, entries } = run.packs.requestport;
    const chunk = packed.allowList.find((path) =>
      /^dist\/chunk-[^/]+\.js$/u.test(path),
    );
    const check = (text) =>
      checkRequestportTarball(
        planted(entries, {
          [`package/${chunk}`]: Buffer.concat([
            entries.get(`package/${chunk}`),
            Buffer.from(text),
          ]),
        }),
        packed,
      );
    const digests = privateDigests();
    const comments = privateDocComments();
    // The private module names production's host, and staging's host and
    // database name. The public seed carries its public variant at that
    // path, which names none, and there each private module's path holds
    // its variant, so no doc comment is one its variant lacks (as
    // pack-packages.test.mjs's sibling case reads them).
    const isPrivate = sharedDatabases.kind === "private";
    assert.equal(digests.length, isPrivate ? 3 : 0);
    assert.equal(comments.length > 0, isPrivate);
    for (const { label, digest } of digests) {
      assert.deepEqual(
        check(`\nconst h = "${digest}";\n`),
        [`${chunk} holds ${label} from packages/db/src/shared-databases.ts`],
        label,
      );
    }
    assert.deepEqual(check('\nvar kind = "private";\n'), [
      `${chunk} holds a private module's kind = "private" marker`,
    ]);
    assert.deepEqual(
      [...new Set(comments.map(({ module }) => module))].sort(),
      isPrivate ? Object.keys(publicVariants).sort() : [],
    );
    // A doc comment two private modules share (each module's `kind`'s) is
    // refused once for each module that holds it.
    const holders = (comment) => [
      ...new Map(
        comments
          .filter((other) => other.comment === comment)
          .map(({ module, variant }) => [module, variant]),
      ),
    ];
    for (const { comment } of comments) {
      // One of the hosted driver's names the E2E owner storage, which the
      // check refuses by its words too.
      assert.deepEqual(check(`\n${comment}\n`), [
        ...(E2E_OWNER_STORAGE.test(comment)
          ? [`${chunk} holds the E2E owner storage`]
          : []),
        ...holders(comment).map(
          ([module, variant]) =>
            `${chunk} holds a doc comment of the private module ${module} that its public variant ${variant} lacks`,
        ),
      ]);
    }
    assert.deepEqual(check("\n// packages/db/src/shared-databases.ts\n"), [
      `${chunk} inlines packages/db/src/shared-databases.ts, which is not one of apps/requestport's modules`,
    ]);
  });

  test("the check refuses the E2E owner storage and the test routes, planted in the real tarball (ruling 170): G.7's E2E owner storage, by each of its three forms, in dist/ chunks; and the test routes /api/test/scenarios and /api/test/email-outbox, by name in a chunk", () => {
    const { staged: packed, entries } = run.packs.requestport;
    const [first, second, third] = packed.allowList.filter((path) =>
      /^dist\/chunk-[^/]+\.js$/u.test(path),
    );
    const appended = (path, text) =>
      Buffer.concat([entries.get(`package/${path}`), Buffer.from(text)]);
    const problems = checkRequestportTarball(
      planted(entries, {
        [`package/${first}`]: appended(
          first,
          "\nfunction createE2EOwnerStorage(env) { return env; }\n",
        ),
        [`package/${second}`]: appended(
          second,
          '\nthrow Error("The E2E owner storage is never built on Vercel.");\nfetch("/api/test/scenarios");\n',
        ),
        [`package/${third}`]: appended(
          third,
          '\nexport const E2E_OWNER_STORAGE_REFUSED_ON_VERCEL = 1;\nfetch("/api/test/email-outbox");\n',
        ),
      }),
      packed,
    );
    assertHolds(problems, [
      `${first} holds the E2E owner storage`,
      `${second} holds the E2E owner storage`,
      `${third} holds the E2E owner storage`,
      `${second} names the test route /api/test/scenarios`,
      `${third} names the test route /api/test/email-outbox`,
    ]);
  });

  test("the check refuses every marker of the three test seams, planted in the real tarball (ruling 174): each of auth's E2E outbox's, apps/web's fault register's and the CSP's E2E fence's, in a dist/ chunk and the program in turn, naming the file, the seam and the marker", () => {
    const { staged: packed, entries } = run.packs.requestport;
    const chunk = packed.allowList.find((path) =>
      /^dist\/chunk-[^/]+\.js$/u.test(path),
    );
    const places = [chunk, "dist/requestport.js"];
    let plants = 0;
    for (const seam of TEST_SEAMS) {
      for (const marker of seam.markers) {
        const path = places[plants % places.length];
        plants += 1;
        const problems = checkRequestportTarball(
          planted(entries, {
            [`package/${path}`]: Buffer.concat([
              entries.get(`package/${path}`),
              Buffer.from(`\nconst planted = ${JSON.stringify(marker)};\n`),
            ]),
          }),
          packed,
        );
        assert.deepEqual(
          problems,
          [`${path} holds ${seam.name} (${marker})`],
          `${marker} planted in ${path}`,
        );
      }
    }
    assert.equal(plants, 10);
  });

  test("E2E_OWNER_STORAGE is G.7's pattern, as scripts/pack-packages.mjs writes it, and TEST_ROUTES the two routes apps/web serves under src/app/api/test", () => {
    const g = /const E2E_OWNER_STORAGE =\s*(\/.+\/u);/u.exec(
      readFileSync(join(repositoryRoot, "scripts/pack-packages.mjs"), "utf8"),
    );
    assert.ok(g, "pack-packages.mjs declares E2E_OWNER_STORAGE");
    assert.equal(`${E2E_OWNER_STORAGE}`, g[1]);
    assert.deepEqual(
      [...TEST_ROUTES].sort(),
      readdirSync(join(repositoryRoot, "apps/web/src/app/api/test"))
        .map((name) => `/api/test/${name}`)
        .sort(),
    );
  });

  test("the check refuses, planted in the real tarball's manifest: a field the pack did not write, a written field changed, a license other than the mapping's, a manifest that does not say private: false, a repository other than the public repository with apps/requestport as directory, files that do not name LICENSE, each of the three also when the manifest the pack wrote holds the same plant, scripts, a second bin, the bin under another name, a bin target the tarball does not hold or one without the hashbang, an @trigger.dev/* package in any dependency field, an @requestport/* package but LOCKSTEP's in dependencies at the manifest's version, and one of LOCKSTEP missing or at another version", () => {
    const { staged: packed, entries } = run.packs.requestport;
    const check = (change, extra = {}) =>
      checkRequestportTarball(
        planted(withManifest(entries, change), extra),
        packed,
      );
    assertHolds(
      check((manifest) => {
        manifest.version = "9.9.9";
        manifest.license = "MIT";
        manifest.private = true;
        manifest.repository = {
          type: "git",
          url: "git+https://example.com/planted.git",
          directory: "apps/requestport",
        };
        manifest.files = ["dist"];
        manifest.scripts = { postinstall: "node x.js" };
      }),
      [
        `package.json's version is "9.9.9", not "${VERSION}"`,
        "package.json's license is MIT, not the mapping's Apache-2.0",
        'package.json\'s license is "MIT", not "Apache-2.0"',
        "package.json's private is true, not false",
        "package.json does not say private: false",
        `package.json's repository is {"type":"git","url":"git+https://example.com/planted.git","directory":"apps/requestport"}, not ${JSON.stringify(publicRepository("apps/requestport"))}`,
        `package.json's repository is {"type":"git","url":"git+https://example.com/planted.git","directory":"apps/requestport"}, not the public repository's ${JSON.stringify(publicRepository("apps/requestport"))}`,
        'package.json\'s files is ["dist"], not ["LICENSE","dist"]',
        "package.json's files does not name LICENSE",
        'package.json\'s scripts is {"postinstall":"node x.js"}, not undefined',
        "package.json has scripts",
        // At another version than the manifest's own, each package of
        // LOCKSTEP is refused too.
        "package.json's dependencies names @requestport/web",
        "package.json's dependencies names @requestport/core",
        'package.json\'s dependencies does not name @requestport/core at its own version, "9.9.9"',
      ],
    );
    // The three are refused from the tarball's manifest alone: with the
    // manifest the pack wrote holding the same plant, no written field
    // differs, and each is still reported.
    const release = withManifest(entries, (manifest) => {
      manifest.private = true;
      manifest.repository = {
        type: "git",
        url: "git+https://example.com/planted.git",
        directory: "apps/requestport",
      };
      manifest.files = ["dist"];
    });
    assert.deepEqual(
      checkRequestportTarball(release, {
        ...packed,
        manifest: JSON.parse(
          release.get("package/package.json").toString("utf8"),
        ),
      }).sort(),
      [
        "package.json does not say private: false",
        `package.json's repository is {"type":"git","url":"git+https://example.com/planted.git","directory":"apps/requestport"}, not the public repository's ${JSON.stringify(publicRepository("apps/requestport"))}`,
        "package.json's files does not name LICENSE",
      ].sort(),
    );
    // Not only `true`: `private` left out, or the string "false", is refused
    // the same way, from the tarball's manifest alone.
    assert.deepEqual(
      privateNotFalseProblems(checkRequestportTarball, entries, packed),
      [
        ["package.json does not say private: false"],
        ["package.json does not say private: false"],
      ],
    );
    assertHolds(
      check((manifest) => {
        manifest.bin = {
          requestport: "dist/requestport.js",
          "requestport-operator": "dist/operator.js",
        };
      }),
      [
        'package.json\'s bin is {"requestport":"dist/requestport.js","requestport-operator":"dist/operator.js"}, not exactly ["requestport"]',
        "dist/operator.js, the bin requestport-operator, does not start with #!/usr/bin/env node",
      ],
    );
    assertHolds(
      check((manifest) => {
        manifest.bin = { rp: "./dist/missing.js" };
      }),
      [
        'package.json\'s bin is {"rp":"./dist/missing.js"}, not exactly ["requestport"]',
        'package.json\'s bin rp is "./dist/missing.js", which the tarball does not hold',
      ],
    );
    assertHolds(
      check(() => {}, {
        "package/dist/requestport.js": "process.exit(0);\n",
      }),
      [
        "dist/requestport.js, the bin requestport, does not start with #!/usr/bin/env node",
      ],
    );
    const fields = check((manifest) => {
      manifest.dependencies = {
        ...manifest.dependencies,
        "@requestport/core": "0.0.0",
        "@requestport/theme": VERSION,
      };
      delete manifest.dependencies["@requestport/mcp"];
      manifest.optionalDependencies = { "@trigger.dev/sdk": "4.0.0" };
      manifest.peerDependencies = { "@requestport/web": VERSION };
      manifest.bundleDependencies = ["@requestport/db"];
    });
    assertHolds(fields, [
      "package.json's dependencies names @requestport/core",
      "package.json's dependencies does not name @requestport/core at its own version, \"" +
        VERSION +
        '"',
      "package.json's dependencies names @requestport/theme",
      "package.json's dependencies does not name @requestport/mcp at its own version, \"" +
        VERSION +
        '"',
      "package.json's optionalDependencies names @trigger.dev/sdk",
      "package.json's peerDependencies names @requestport/web",
      "package.json's bundleDependencies names @requestport/db",
    ]);
    for (const name of LOCKSTEP.filter(
      (name) => !["@requestport/core", "@requestport/mcp"].includes(name),
    )) {
      assert.equal(
        fields.some(
          (problem) =>
            problem === `package.json's dependencies names ${name}` ||
            problem.startsWith(
              `package.json's dependencies does not name ${name} `,
            ),
        ),
        false,
        `${name} in dependencies at the manifest's version is required and allowed`,
      );
    }
  });

  test("a workspace: specifier is pnpm's workspace protocol, its alias form workspace:<name>@<range> included, not the word: RequestPort's scope workspace:telemetry:reveal, a web:workspace:reveal: key and an address after workspace: pass", () => {
    for (const specifier of [
      '"workspace:*"',
      '"workspace:^"',
      '"workspace:~1.2.0"',
      '"workspace:1.2.3"',
      '"workspace:../packages/core"',
      '"workspace:core@*"',
      '"workspace:@requestport/core@^"',
      '"workspace:@requestport/core@~1.2.0"',
      '"workspace:core@1.2.3"',
    ]) {
      assert.ok(WORKSPACE_SPECIFIER.test(specifier), specifier);
    }
    for (const word of [
      '"workspace:telemetry:reveal"',
      "idempotencyKey:`web:workspace:reveal:0c1d`",
      "slack_workspace:{limit:300}",
      '"workspace:owner@example.com"',
    ]) {
      assert.equal(WORKSPACE_SPECIFIER.test(word), false, word);
    }
  });

  test("the stage refuses a dependency problem, an external apps/requestport does not declare, after the bundle and before it writes the manifest; it builds no web UI and copies no migrations", async () => {
    const manifests = structuredClone(readManifests());
    delete manifests.get("apps/requestport").dependencies[
      "@modelcontextprotocol/client"
    ];
    await assert.rejects(
      stageRequestport({
        version: VERSION,
        directory: join(scratch, "dependency-refused"),
        manifests,
      }),
      {
        message:
          "pack-requestport refuses apps/requestport's dependencies:\n- @modelcontextprotocol/client: no workspace the bundle inlines declares it (dependencies)",
      },
    );
    assert.deepEqual(readdirSync(join(scratch, "dependency-refused")).sort(), [
      "dist",
    ]);
  });
});

describe("@requestport/web's tarball (ruling 193 item 4)", () => {
  test("holds exactly the allow-list derived from the stage: the build's apps/web without its node_modules, LICENSE and THIRD-PARTY-NOTICES; G.7's checkTarball and the web check accept it", () => {
    const { staged: packed, entries } = run.packs.web;
    assert.deepEqual(
      [...entries.keys()].map((path) => path.replace(/^package\//u, "")).sort(),
      packed.allowList,
    );
    assert.deepEqual(
      packed.allowList.filter((path) => !packed.files.includes(path)),
      ["LICENSE", "THIRD-PARTY-NOTICES"],
    );
    assert.equal(
      packed.allowList.some((path) => path.split("/").includes("node_modules")),
      false,
    );
    assert.deepEqual(checkTarball(entries, packed), []);
    assert.deepEqual(checkWebTarball(entries, packed), []);
    assert.deepEqual(
      JSON.parse(entries.get("package/package.json").toString("utf8")),
      packed.manifest,
    );
    assert.equal(packed.manifest.exports, undefined);
  });

  /** The web tarball with `changes` planted (`planted`), and what the web check says of it. */
  const webCheck = (changes) => {
    const { staged: packed, entries } = run.packs.web;
    return checkWebTarball(planted(entries, changes), packed);
  };
  const appended = (path, text) =>
    Buffer.concat([
      run.packs.web.entries.get(`package/${path}`),
      Buffer.from(text),
    ]);
  const chunk = ".next-self-host/server/chunks/42.js";

  test("@requestport/web: the check refuses, planted in the real tarball's manifest, a manifest that does not say private: false, a repository with another directory than apps/web, and files that do not name LICENSE, each also as a written field changed, by G.7's checkTarball (option (B), ruling 175; ruling 207 item 3)", () => {
    const { staged: packed, entries } = run.packs.web;
    const repository = {
      ...publicRepository("apps/web"),
      directory: "apps/planted",
    };
    const files = packed.manifest.files.filter((file) => file !== "LICENSE");
    assert.deepEqual(
      checkWebTarball(
        withManifest(entries, (manifest) => {
          manifest.private = true;
          manifest.repository = repository;
          manifest.files = files;
        }),
        packed,
      ).sort(),
      [
        "package.json's private is true, not false",
        `package.json's repository is ${JSON.stringify(repository)}, not ${JSON.stringify(publicRepository("apps/web"))}`,
        `package.json's files is ${JSON.stringify(files)}, not ${JSON.stringify(packed.manifest.files)}`,
        "package.json does not say private: false",
        `package.json's repository is ${JSON.stringify(repository)}, not the public repository's ${JSON.stringify(publicRepository("apps/web"))}`,
        "package.json's files does not name LICENSE",
      ].sort(),
    );
    // Not only `true`: `private` left out, or the string "false", is refused
    // the same way, from the tarball's manifest alone.
    assert.deepEqual(
      privateNotFalseProblems(checkWebTarball, entries, packed),
      [
        ["package.json does not say private: false"],
        ["package.json does not say private: false"],
      ],
    );
  });

  test("the check refuses, planted: a traced node_modules, a machine path in any form (as written in a chunk, JSON-escaped in a manifest, in a binary file), a workspace: specifier in pnpm's alias form and workspace: in package.json, a test, an .env file, a source map, test support, a file off the allow-list and one missing", () => {
    const realTemporary = realpathSync(tmpdir());
    const font = ".next-self-host/static/media/font.woff2";
    const manifest =
      ".next-self-host/server/app/page_client-reference-manifest.js";
    const problems = webCheck({
      "package/node_modules/next/package.json": '{"name":"next"}\n',
      "package/.next-self-host/server/node_modules/sharp/index.js": "",
      [`package/${chunk}`]: appended(chunk, `\nconst at = "${homedir()}/x";\n`),
      [`package/${manifest}`]: appended(
        manifest,
        `\nconst t = "${realTemporary.replaceAll("/", "\\/")}";\n`,
      ),
      [`package/${font}`]: appended(font, repositoryRoot),
      "package/server.js": appended(
        "server.js",
        '\nconst alias = "workspace:@requestport/core@*";\n',
      ),
      "package/.next-self-host/package.json":
        '{"dependencies":{"@requestport/core":"workspace:*"}}',
      "package/.next-self-host/server/x.test.js": "",
      "package/.env.local": "",
      "package/.next-self-host/server/app/page.js.map": "{}",
      "package/test-support/fixture.js": "",
      "package/src/app/docs/api/generated/openapi.json": undefined,
    });
    assertHolds(problems, [
      "node_modules/next/package.json is under node_modules, which Next traced and @requestport/web does not ship",
      "node_modules/next/package.json is not on the allow-list",
      ".next-self-host/server/node_modules/sharp/index.js is under node_modules, which Next traced and @requestport/web does not ship",
      `${chunk} holds ${homedir()}`,
      `${manifest} holds ${realTemporary}, as ${realTemporary.replaceAll("/", "\\/")}`,
      `${font} holds ${repositoryRoot}`,
      "server.js holds a workspace: specifier",
      ".next-self-host/package.json holds a workspace: specifier",
      ".next-self-host/server/x.test.js is a test",
      ".env.local is an environment file",
      ".next-self-host/server/app/page.js.map is a source map",
      "test-support/fixture.js is test support",
      "src/app/docs/api/generated/openapi.json is on the allow-list but not in the tarball",
    ]);
    assert.equal(problems.length, new Set(problems).size, "each once");
  });

  test("the check refuses a test route, as a route's file and by name, and the E2E owner storage (ruling 170), and every marker of the three test seams, naming the file, the seam and the marker (ruling 174)", () => {
    const scenarios = ".next-self-host/server/app/api/test/scenarios/route.js";
    const outbox =
      ".next-self-host/static/chunks/app/api/test/email-outbox/route-0.js";
    assertHolds(
      webCheck({
        [`package/${scenarios}`]: "export {};\n",
        [`package/${outbox}`]: "export {};\n",
        [`package/${chunk}`]: appended(
          chunk,
          '\nfetch("/api/test/email-outbox");\nthrow Error("The E2E owner storage is never built on Vercel.");\n',
        ),
      }),
      [
        `${scenarios} belongs to the test route /api/test/scenarios`,
        `${outbox} belongs to the test route /api/test/email-outbox`,
        `${chunk} names the test route /api/test/email-outbox`,
        `${chunk} holds the E2E owner storage`,
      ],
    );
    let plants = 0;
    for (const seam of TEST_SEAMS) {
      for (const marker of seam.markers) {
        const path = plants % 2 === 0 ? chunk : "server.js";
        plants += 1;
        assert.deepEqual(
          webCheck({
            [`package/${path}`]: appended(
              path,
              `\nconst planted = ${JSON.stringify(marker)};\n`,
            ),
          }),
          [`${path} holds ${seam.name} (${marker})`],
          `${marker} planted in ${path}`,
        );
      }
    }
    assert.equal(plants, 10);
  });

  test("the check refuses db's private modules (ruling 183 item 9; ruling 193 item 5; ruling 194 item 3): each digest packages/db/src/shared-databases.ts names, the kind = \"private\" marker, and each doc comment of shared-databases.ts, hosted-driver.ts and hosted-migrator.ts that its public variant lacks, as G.7's checkTarball finds them", () => {
    const digests = privateDigests();
    const comments = privateDocComments();
    // The private module names production's host, and staging's host and
    // database name. The public seed carries its public variant at that
    // path, which names none, and there each private module's path holds
    // its variant, so no doc comment is one its variant lacks (as
    // pack-packages.test.mjs's sibling case reads them).
    const isPrivate = sharedDatabases.kind === "private";
    assert.equal(digests.length, isPrivate ? 3 : 0);
    assert.equal(comments.length > 0, isPrivate);
    for (const { label, digest } of digests) {
      assert.deepEqual(
        webCheck({
          [`package/${chunk}`]: appended(chunk, `\nconst h = "${digest}";\n`),
        }),
        [`${chunk} holds ${label} from packages/db/src/shared-databases.ts`],
        label,
      );
    }
    assert.deepEqual(
      webCheck({
        "package/server.js": appended("server.js", '\nvar kind = "private";\n'),
      }),
      ['server.js holds a private module\'s kind = "private" marker'],
    );
    assert.deepEqual(
      [...new Set(comments.map(({ module }) => module))].sort(),
      isPrivate ? Object.keys(publicVariants).sort() : [],
    );
    // A doc comment two private modules share is refused once for each.
    const holders = (comment) => [
      ...new Map(
        comments
          .filter((other) => other.comment === comment)
          .map(({ module, variant }) => [module, variant]),
      ),
    ];
    for (const { comment } of comments) {
      assert.deepEqual(
        webCheck({
          [`package/${chunk}`]: appended(chunk, `\n${comment}\n`),
        }),
        [
          // One of the hosted driver's names the E2E owner storage, which
          // the check refuses by its words too.
          ...(E2E_OWNER_STORAGE.test(comment)
            ? [`${chunk} holds the E2E owner storage`]
            : []),
          ...holders(comment).map(
            ([module, variant]) =>
              `${chunk} holds a doc comment of the private module ${module} that its public variant ${variant} lacks`,
          ),
        ],
      );
    }
  });

  test("the check refuses, planted in its manifest: another version, a field the pack did not write, scripts, a bin, an @requestport/* dependency and exports; and LICENSE and THIRD-PARTY-NOTICES with other bytes", () => {
    const { staged: packed, entries } = run.packs.web;
    const problems = checkWebTarball(
      planted(
        withManifest(entries, (manifest) => {
          manifest.version = "9.9.9";
          manifest.scripts = { postinstall: "node x.js" };
          manifest.bin = { web: "server.js" };
          manifest.dependencies = {
            ...manifest.dependencies,
            "@requestport/core": VERSION,
          };
          manifest.exports = { ".": "./server.js" };
        }),
        {
          "package/LICENSE": "Other words.\n",
          "package/THIRD-PARTY-NOTICES": "Other notices.\n",
        },
      ),
      packed,
    );
    assertHolds(problems, [
      `package.json's version is "9.9.9", not "${VERSION}"`,
      "package.json has scripts",
      "package.json has bin",
      "package.json's dependencies names @requestport/core",
      'package.json exports ["."], not the bundle\'s entries []',
      "LICENSE is not licenses/Apache-2.0.txt, byte for byte",
      "THIRD-PARTY-NOTICES is not the notices the stage wrote, byte for byte",
    ]);
  });
});

describe("the run's fourteen tarballs together", () => {
  /** The run's packs, in the order `main` packed them, each named by its packed manifest. */
  const ordered = () => Object.values(run.packs);
  const name = ({ staged: packed }) => packed.manifest.name;
  /** `pack` with its entries changed by `changes` (`planted`). */
  const withEntries = (pack, changes) => ({
    ...pack,
    entries: planted(pack.entries, changes),
  });

  test("checkRun accepts them in the order main packs them, G.7's eleven, @requestport/web, @requestport/client and requestport; it refuses requestport packed before any package it depends on, or without one", async () => {
    assert.deepEqual(ordered().map(name), [...LOCKSTEP, "requestport"]);
    assert.deepEqual(await checkRun(ordered()), []);
    const { requestport, core, web } = run.packs;
    const others = ordered().filter((pack) => pack !== requestport);
    const beforeCore = [
      ...others.slice(0, others.indexOf(core)),
      requestport,
      ...others.slice(others.indexOf(core)),
    ];
    assert.deepEqual(
      await checkRun(beforeCore),
      ["auth", "client", "core", "mcp", "server", "web"].map(
        (packed) =>
          `requestport is packed before @requestport/${packed}, which it depends on (dependencies)`,
      ),
    );
    assert.deepEqual(await checkRun(ordered().filter((pack) => pack !== web)), [
      "requestport depends on @requestport/web, which this run does not pack (dependencies)",
    ]);
  });

  test("runConfinementProblems accepts them: no file holding jobs' index or worker root is reachable from requestport's entries but through the worker command's dynamic import, across every tarball's chunks", async () => {
    assert.deepEqual(await runConfinementProblems(ordered()), []);
  });

  test("runConfinementProblems refuses a planted static import of @requestport/jobs outside the worker command's chunk, in requestport's program and in one of its chunks; and a chunk of jobs' own that a reached subpath of jobs imports and that holds its index", async () => {
    const { requestport, jobs } = run.packs;
    const reached = (entry) =>
      ["index", "worker-root"].map(
        (module) =>
          `@requestport/jobs's dist/index.js, which holds packages/jobs/src/${module}.ts, is reachable from requestport's dist/${entry}.js other than through apps/requestport/src/cli.ts's dynamic import of apps/requestport/src/worker.ts`,
      );
    /** `pack` with `text` put first in `path`, after its hashbang if it has one. */
    const prepended = (pack, path, text) => {
      const body = pack.entries.get(`package/${path}`).toString("utf8");
      const at = body.startsWith("#!") ? body.indexOf("\n") + 1 : 0;
      return withEntries(pack, {
        [`package/${path}`]: `${body.slice(0, at)}${text}${body.slice(at)}`,
      });
    };
    const swap = (pack, by) =>
      ordered().map((other) => (other === pack ? by : other));
    const program = prepended(
      requestport,
      "dist/requestport.js",
      'import "@requestport/jobs";\n',
    );
    assert.deepEqual(
      await runConfinementProblems(swap(requestport, program)),
      reached("requestport"),
    );
    const operator = prepended(
      requestport,
      "dist/operator.js",
      'import "@requestport/jobs";\n',
    );
    assert.deepEqual(
      await runConfinementProblems(swap(requestport, operator)),
      reached("operator"),
    );
    const worker = prepended(jobs, "dist/worker.js", 'import "./index.js";\n');
    assert.deepEqual(
      await runConfinementProblems(swap(jobs, worker)),
      reached("requestport"),
    );
  });

  test("runConfinementProblems refuses a run in which it could not fire: jobs' tarball missing, the worker command's chunk not importing @requestport/jobs, and cli.ts's chunk importing it statically", async () => {
    const { requestport, jobs } = run.packs;
    assert.deepEqual(
      await runConfinementProblems(ordered().filter((pack) => pack !== jobs)),
      [
        "packages/jobs/src/index.ts is in no file of the run, so the worker's check cannot fire",
        "packages/jobs/src/worker-root.ts is in no file of the run, so the worker's check cannot fire",
      ],
    );
    const files = [...requestport.entries].filter(([path]) =>
      /^package\/dist\/.+\.js$/u.test(path),
    );
    const holding = (module) =>
      files.find(([, body]) =>
        body.toString("utf8").split("\n").includes(`// ${module}`),
      );
    const [commandPath, commandBody] = holding(
      "apps/requestport/src/worker.ts",
    );
    const [cliPath, cliBody] = holding("apps/requestport/src/cli.ts");
    const swap = (by) =>
      ordered().map((other) => (other === requestport ? by : other));
    const unimported = withEntries(requestport, {
      [commandPath]: commandBody
        .toString("utf8")
        .replace(/^import .*"@requestport\/jobs";$/mu, ""),
    });
    assert.deepEqual(await runConfinementProblems(swap(unimported)), [
      `requestport's ${commandPath.slice("package/".length)}, which holds apps/requestport/src/worker.ts, reaches none of packages/jobs/src/index.ts and packages/jobs/src/worker-root.ts, so the worker's check cannot fire`,
    ]);
    const commandFile = basename(commandPath);
    const statically = withEntries(requestport, {
      [cliPath]: `${cliBody
        .toString("utf8")
        .replaceAll(
          `import("./${commandFile}")`,
          "Promise.resolve(worker)",
        )}\nimport * as worker from "./${commandFile}";\n`,
    });
    assert.deepEqual(await runConfinementProblems(swap(statically)), [
      `requestport's ${cliPath.slice("package/".length)}, which holds apps/requestport/src/cli.ts, does not import requestport's ${commandPath.slice("package/".length)}, which holds apps/requestport/src/worker.ts, dynamically`,
      ...["index", "worker-root"].map(
        (module) =>
          `@requestport/jobs's dist/index.js, which holds packages/jobs/src/${module}.ts, is reachable from requestport's dist/requestport.js other than through apps/requestport/src/cli.ts's dynamic import of apps/requestport/src/worker.ts`,
      ),
    ]);
  });
});

/** `notices` without the entry of `key`, cut from its rule to the next. */
function withoutEntry(notices, key) {
  const rule = `\n${"=".repeat(80)}\n`;
  const start = notices.indexOf(`${rule}Package: ${key}\n`);
  assert.notEqual(start, -1, key);
  const end = notices.indexOf(rule, start + 1);
  return `${notices.slice(0, start)}${end === -1 ? "" : notices.slice(end)}`;
}

describe("README.md and THIRD-PARTY-NOTICES", () => {
  test("README.md is apps/requestport/README.md, byte for byte, in the stage and the tarball, which packs it although files does not name it", () => {
    const { staged: packed, entries } = run.packs.requestport;
    assert.equal(REQUESTPORT.readme, "apps/requestport/README.md");
    const source = readFileSync(join(repositoryRoot, REQUESTPORT.readme));
    assert.ok(readFileSync(join(packed.directory, "README.md")).equals(source));
    assert.ok(entries.get("package/README.md").equals(source));
    assert.equal(packed.manifest.files.includes("README.md"), false);
  });

  test("THIRD-PARTY-NOTICES covers every third-party package whose code a tarball contains, and may cover more (ruling 198 item 1): requestport's, the client's and ten of G.7's eleven carry none, and @requestport/db's is G.7's, for the esbuild runtime helpers its chunk binds (ruling 209); @requestport/web's is what thirdPartyNotices writes for the packages the stage finds its build holds (next, with the licence comment its mitt.js carries for Jason Miller's mitt; the React next keeps in its dist/compiled, entered by itself as vendored in next, with its own licence file and the licence comment its react.production.js opens with, the record's entry and not the nested scan's of the same key; react-dom; in the private tree, the serverless PostgreSQL driver db depends on (the public seed's db declares none), with the bundler's licence comment its index.mjs carries for the buffer and ieee754 it bundles; process, which WEB.beyondClosure names; and two files of @modelcontextprotocol/server's dist; by the fixture's record; geist, whose font it copies into static/media, and tailwindcss, whose banner its stylesheet carries, by emittedPackages; the core-js, object-assign and whatwg-fetch next's polyfills bundle, by the reviewed list; the six packages the server's two files bundle, by their source maps; webpack, the bundler whose runtime the build's runtime chunks hold, vendored in next, by WEB.bundler; @trigger.dev/core, whose superjson bundle the fixture's record holds, and the superjson, copy-anything and is-what that bundle bundles, each vendored in it, by the reviewed list of vendored copies; esbuild, vendored in next, and rolldown, vendored in @modelcontextprotocol/server, by that list's entries for the runtime a file of each holds (ruling 210 item 2); and every package an installed one of those keeps inside its own directory with a package.json of its own, vendored in it, by the nested scan (ruling 199 item 1)) and for no other package of apps/web's production closure, with its own header; its tarball's is its stage's, byte for byte", () => {
    assert.equal(NOTICES.file, "THIRD-PARTY-NOTICES");
    assert.deepEqual(WEB.notices.members, ["@requestport/web"]);
    assert.deepEqual(WEB.beyondClosure, ["process"]);
    const { staged: packed, entries } = run.packs.web;
    const version = (directory) =>
      JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
    const geist = `geist@${version(installedForWeb("geist"))}`;
    const tailwind = `tailwindcss@${version(installedForWeb("tailwindcss"))}`;
    const next = `next@${version(installedForWeb("next"))}`;
    const vendoredReact = `react-builtin (vendored in ${next} at dist/compiled/react)`;
    const webpack = `webpack (vendored in ${next} at dist/compiled/webpack)`;
    const bundlers = installedBundlers().map(
      (directory) =>
        `${
          JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name
        }@${version(directory)}`,
    );
    // What the polyfills chunk bundles, by the reviewed list: each package
    // by itself, as bundled in next, which ships the file.
    const polyfilled = [
      "core-js@3.38.1",
      "object-assign@4.1.1",
      "whatwg-fetch@3.0.0",
    ].map((id) => `${id} (bundled in ${next})`);
    // What the two files of @modelcontextprotocol/server's dist bundle, by
    // their source maps: each package by itself, as bundled in it, at the
    // version the map records.
    const server = `@modelcontextprotocol/server@${version(installedMcpServer().directory)}`;
    const mapped = [
      "ajv-formats@3.0.1",
      "ajv@8.18.0",
      "content-type@1.0.5",
      "fast-deep-equal@3.1.3",
      "fast-uri@3.1.0",
      "json-schema-traverse@1.0.0",
    ].map((id) => `${id} (bundled in ${server})`);
    // What @trigger.dev/core's superjson bundle bundles, by the reviewed
    // list of vendored copies: each package by itself, as vendored in it;
    // and, by the same list, the bundler whose runtime a file of next's and
    // one of the server's carry: esbuild, as vendored in next, and rolldown,
    // as vendored in the server (ruling 210 item 2). The list's entries for
    // the other three holders add nothing: the fixture's record holds no
    // package of theirs.
    const core = `@trigger.dev/core@${version(installedTriggerCore().directory)}`;
    const listed = [
      ...["copy-anything@3.0.5", "is-what@4.1.16", "superjson@2.2.1"].map(
        (id) => `${id} (vendored in ${core})`,
      ),
      `esbuild@0.28.2 (vendored in ${next})`,
      `rolldown@1.2.4 (vendored in ${server})`,
    ];
    const production = productionClosure({ members: WEB.notices.members });
    const processKey = `process@${version(installedProcess())}`;
    const reactDom = `react-dom@${version(installedForWeb("react-dom"))}`;
    const installed = [
      ...bundlers,
      core,
      geist,
      next,
      processKey,
      reactDom,
      tailwind,
      server,
    ];
    const seen = [
      ...installed,
      ...polyfilled,
      vendoredReact,
      ...mapped,
      webpack,
    ];
    // What every installed package of those keeps inside its own directory
    // with a package.json of its own, by this suite's own reading
    // (vendoredBelow), but those already entered: the React and the webpack
    // next vendors (ruling 199 item 1).
    const nested = installed
      .flatMap((key) =>
        vendoredBelow(
          key === processKey
            ? installedProcess()
            : production.packages.get(key).directory,
          key.replace(/@[^@]+$/u, ""),
          key,
        ),
      )
      .filter((key) => !seen.includes(key));
    assert.ok(nested.length > 0);
    assert.ok(
      nested.includes(
        `ua-parser-js (vendored in ${next} at dist/compiled/ua-parser-js)`,
      ),
      nested.join("\n"),
    );
    const keys = [...seen, ...listed, ...nested].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    assert.deepEqual(
      noticesEntries(packed.notices).map(({ key }) => key),
      keys,
    );
    assert.deepEqual([...packed.closure.packages.keys()], keys);
    assert.deepEqual(packed.closure.members, WEB.notices.members);
    // What the fixture's build emits outside its chunks: geist's font, the
    // file of geist's it is byte for byte, and Tailwind's banner, read as
    // tailwindcss's manifest.
    assert.deepEqual(packed.emitted, {
      files: [
        join(
          production.packages.get(geist).directory,
          "dist/fonts/geist-sans/Geist-Variable.woff2",
        ),
        join(production.packages.get(tailwind).directory, "package.json"),
      ],
      own: [],
      problems: [],
    });
    // What it copies as it is: next's two files the list names, each
    // joining next's contained files.
    assert.deepEqual(packed.verbatim.copied, [
      {
        path: ".next-self-host/static/chunks/polyfills-0123456789abcdef.js",
        package: next,
        file: "dist/build/polyfills/polyfill-nomodule.js",
      },
      {
        path: ".next-self-host/static/fixture-build/_ssgManifest.js",
        package: next,
        file: VERBATIM.files[1].path,
      },
    ]);
    assert.deepEqual(packed.verbatim.problems, []);
    assert.ok(production.packages.size > installed.length);
    assert.deepEqual(
      keys.filter((key) => !production.packages.has(key)),
      keys.filter(
        (key) =>
          polyfilled.includes(key) ||
          mapped.includes(key) ||
          listed.includes(key) ||
          nested.includes(key) ||
          key === processKey ||
          key === vendoredReact ||
          key === webpack,
      ),
    );
    // Each package the superjson bundle bundles carries the licence and the
    // text of its licence file the list gives: superjson's, Simon Knott's
    // MIT text; and no package of it is listed twice for its two copies.
    const superjson = packed.notices.slice(
      packed.notices.indexOf(`Package: ${listed[2]}\n`),
    );
    assert.ok(
      superjson.startsWith(
        `Package: ${listed[2]}\nLicense: MIT\n\n--- LICENSE ---\n\nMIT License\n\nCopyright (c) 2020 Simon Knott and superjson contributors\n`,
      ),
      superjson.slice(0, 300),
    );
    // next's entry carries the licence comment mitt.js opens with, which the
    // build's minifier drops: Jason Miller's MIT licence for mitt.
    const nextEntry = packed.notices.slice(
      packed.notices.indexOf(`Package: ${next}\n`),
      packed.notices.indexOf(`Package: process@`),
    );
    assert.ok(
      nextEntry.includes(
        "\n--- dist/shared/lib/mitt.js: licence comment ---\n\n/*\nMIT License\n\nCopyright (c) Jason Miller (https://jasonformat.com/)\n",
      ),
      nextEntry.slice(0, 2000),
    );
    // webpack, as next vendors it, with its own package.json (no version)
    // and LICENSE, and no file of it as contained.
    const vendoredWebpack = packed.closure.packages.get(webpack);
    assert.equal(
      vendoredWebpack.directory,
      join(production.packages.get(next).directory, "dist/compiled/webpack"),
    );
    assert.deepEqual(vendoredWebpack.files, []);
    assert.ok(
      packed.notices.includes(
        `Package: ${webpack}\nLicense: MIT\n\n--- LICENSE ---\n\nCopyright JS Foundation and other contributors\n`,
      ),
    );
    // A bundled package's text is the store's for that version, or, where
    // this tree installs it at other versions only, the highest one's, which
    // the entry names: ajv 8.18.0, which the map records, is not installed.
    const store = join(repositoryRoot, "node_modules/.pnpm");
    const ajvs = readdirSync(store)
      .filter((entry) => /^ajv@\d/u.test(entry))
      .map((entry) => entry.slice("ajv@".length));
    const ajv = packed.notices.slice(
      packed.notices.indexOf(`Package: ${mapped[1]}\n`),
      packed.notices.indexOf(`Package: ${mapped[2]}\n`),
    );
    assert.ok(
      ajv.startsWith(
        ajvs.includes("8.18.0")
          ? `Package: ${mapped[1]}\nLicense: MIT\n\n--- LICENSE ---\n`
          : `Package: ${mapped[1]}\nLicense: MIT\n\n--- LICENSE, from ajv@${ajvs.sort().at(-1)}, the version of it this tree installs ---\n`,
      ),
      ajv,
    );
    const contentType = packed.notices.slice(
      packed.notices.indexOf(`Package: ${mapped[2]}\n`),
    );
    assert.ok(
      contentType.startsWith(
        `Package: ${mapped[2]}\nLicense: MIT\n\n--- LICENSE ---\n`,
      ),
      contentType.slice(0, 200),
    );
    // Each carries the licence and the text of its licence file the list
    // gives: core-js's, Denis Pushkarev's MIT text.
    const coreJs = packed.notices.slice(
      packed.notices.indexOf(`Package: ${polyfilled[0]}\n`),
      packed.notices.indexOf(`Package: ${geist}\n`),
    );
    assert.ok(
      coreJs.startsWith(
        `Package: ${polyfilled[0]}\nLicense: MIT\n\n--- LICENSE ---\n\nCopyright (c) 2014-2024 Denis Pushkarev\n`,
      ),
      coreJs,
    );
    // The driver bundles buffer and ieee754 into its index.mjs, which names
    // them in a bundler's licence comment that the build's minifier drops:
    // the entry carries it, with buffer's author. Only the private tree's
    // db declares it (installedBundlers); in the public seed there is no
    // such entry, as the keys compared above say.
    for (const bundler of bundlers) {
      const bundled = packed.notices.slice(
        packed.notices.indexOf(`Package: ${bundler}\n`),
        packed.notices.indexOf(`Package: ${geist}\n`),
      );
      assert.ok(bundled.includes("--- LICENSE ---"));
      assert.ok(
        bundled.includes(
          "--- index.mjs: bundled license information ---\n\n/*! Bundled license information:\n\nieee754/index.js:\n",
        ),
        bundled,
      );
      assert.ok(bundled.includes("@author   Feross Aboukhadijeh"));
    }
    // The React next vendors is entered by itself, with what its own
    // package.json declares (no licence field) and its own LICENSE.
    const vendored = packed.closure.packages.get(vendoredReact);
    assert.equal(
      vendored.directory,
      join(production.packages.get(next).directory, "dist/compiled/react"),
    );
    assert.deepEqual(vendored.vendoredIn, { key: next, name: "next" });
    const licence = readFileSync(join(vendored.directory, "LICENSE"), "utf8")
      .replaceAll("\r\n", "\n")
      .trimEnd();
    assert.ok(
      packed.notices.includes(
        `Package: ${vendoredReact}\nLicense: (no licence field)\n\n--- LICENSE ---\n\n${licence}`,
      ),
    );
    // The entry the build's record gave wins over the nested scan's of the
    // same key, which holds no file (withAdded keeps the entry a key has
    // already; ruling 199 item 1's "unless it is already covered"): its
    // files are the record's two, and it carries the licence comment
    // react.production.js opens with, which the nested scan's would drop.
    assert.deepEqual(vendored.files, [
      join(vendored.directory, "cjs/react.production.js"),
      join(vendored.directory, "index.js"),
    ]);
    const reactEntry = packed.notices.slice(
      packed.notices.indexOf(`Package: ${vendoredReact}\n`),
      packed.notices.indexOf(
        `\n${"=".repeat(80)}\n`,
        packed.notices.indexOf(`Package: ${vendoredReact}\n`),
      ),
    );
    assert.ok(
      reactEntry.includes(
        "\n--- cjs/react.production.js: licence comment ---\n\n/**\n * @license React\n * react.production.js\n",
      ),
      reactEntry.slice(-1500),
    );
    assert.equal(
      packed.notices,
      thirdPartyNotices(packed.closure, WEB.notices),
    );
    assert.ok(
      packed.notices.startsWith("Third-party notices for @requestport/web\n\n"),
    );
    assert.deepEqual(noticesProblems(packed.closure, packed.notices), []);
    assert.equal(
      readFileSync(join(packed.directory, NOTICES.file), "utf8"),
      packed.notices,
    );
    assert.equal(
      entries.get(`package/${NOTICES.file}`).toString("utf8"),
      packed.notices,
    );

    // Of the thirteen others, @requestport/db's alone carries one, which
    // G.7's pack writes for the esbuild runtime helpers its chunk binds
    // (ruling 209).
    for (const [name, pack] of Object.entries(run.packs)) {
      if (name === "web") continue;
      assert.equal(
        pack.entries.has(`package/${NOTICES.file}`),
        name === "db",
        name,
      );
    }
  });

  test("thirdPartyNotices writes, for a planted closure: its header, then below a rule each package's Package: and License: lines and each licence or notice file under its name, CRLF as LF and trailing white space dropped, a directory so named left out; a package with none says so; noticesEntries reads the entries back, and no path is written", () => {
    const root = join(scratch, "notices-fixture");
    writeTree(root, {
      "a/LICENSE": "MIT License\r\n\r\nCopyright (c) A\r\n\r\n",
      "a/NOTICE.md": "A notice.\n",
      "a/LICENSE-docs/index.md": "Not read.\n",
      "a/index.js": "",
      "b/index.js": "",
    });
    const closure = {
      members: ["@requestport/requestport"],
      workspaces: [],
      unresolved: [],
      packages: new Map([
        [
          "@scope/a@1.0.0",
          {
            key: "@scope/a@1.0.0",
            directory: join(root, "a"),
            manifest: { name: "@scope/a", version: "1.0.0", license: "MIT" },
          },
        ],
        [
          "b@2.0.0",
          {
            key: "b@2.0.0",
            directory: join(root, "b"),
            manifest: {
              name: "b",
              version: "2.0.0",
              licenses: [{ type: "ISC" }],
            },
          },
        ],
      ]),
    };
    const rule = "=".repeat(80);
    const text = thirdPartyNotices(closure);
    assert.ok(text.startsWith("Third-party notices for @requestport/web\n\n"));
    assert.ok(
      text.includes(
        [
          "",
          rule,
          "Package: @scope/a@1.0.0",
          "License: MIT",
          "",
          "--- LICENSE ---",
          "",
          "MIT License",
          "",
          "Copyright (c) A",
          "",
          "--- NOTICE.md ---",
          "",
          "A notice.",
          "",
          rule,
          "",
        ].join("\n"),
      ),
    );
    assert.ok(
      text.endsWith(
        [
          "",
          rule,
          "Package: b@2.0.0",
          "License: licenses array: ISC",
          "",
          "(This package ships no licence or notice file.)",
          "",
        ].join("\n"),
      ),
    );
    assert.equal(text.includes("Not read."), false);
    assert.equal(text.includes(root), false);
    assert.ok(text.startsWith(WEB.notices.header));
    const other = thirdPartyNotices(closure, {
      header: "Third-party notices for a test\n",
    });
    assert.equal(
      other.slice("Third-party notices for a test\n".length),
      text.slice(WEB.notices.header.length),
    );
    assert.deepEqual(noticesEntries(text), [
      { key: "@scope/a@1.0.0", license: "MIT" },
      { key: "b@2.0.0", license: "licenses array: ISC" },
    ]);
    assert.deepEqual(noticesProblems(closure, text), []);
  });

  test("thirdPartyNotices adds under a package each bundler's licence comment (esbuild's Bundled license information) that a file of it the build contains carries, under that file's path in the package, and none from a file the build does not contain", () => {
    const root = join(scratch, "bundled-fixture");
    const comment = [
      "/*! Bundled license information:",
      "",
      "buffer/index.js:",
      "  (*!",
      "   * The buffer module from node.js, for the browser.",
      "   *",
      "   * @author   Feross Aboukhadijeh <https://feross.org>",
      "   * @license  MIT",
      "   *)",
      "*/",
    ].join("\n");
    writeTree(root, {
      "d/LICENSE": "MIT License\n\nCopyright (c) D\n",
      "d/index.mjs": `export const d = 1;\n${comment}\n`,
      "d/index.cjs": `exports.d = 1;\n${comment.replace("buffer", "other")}\n`,
    });
    const entry = {
      key: "d@1.0.0",
      directory: join(root, "d"),
      manifest: { name: "d", version: "1.0.0", license: "MIT" },
      files: [join(root, "d/index.mjs")],
    };
    const text = thirdPartyNotices({
      members: ["@requestport/web"],
      workspaces: [],
      unresolved: [],
      packages: new Map([[entry.key, entry]]),
    });
    assert.ok(
      text.endsWith(
        [
          "Package: d@1.0.0",
          "License: MIT",
          "",
          "--- LICENSE ---",
          "",
          "MIT License",
          "",
          "Copyright (c) D",
          "",
          "--- index.mjs: bundled license information ---",
          "",
          comment,
          "",
        ].join("\n"),
      ),
      text,
    );
    assert.equal(text.includes("other/index.js"), false);
  });

  test("licenceComments reads a file's licence comments: a block comment or a run of // lines that holds a copyright line or a licence grant, each once; not a comment without those words, one whose /* is just after a quote or a backslash (a string or a regular expression that opens with it), nor esbuild's Bundled license information, which has its own heading", () => {
    const mit = [
      "/*",
      "MIT License",
      "",
      "Copyright (c) Jason Miller (https://jasonformat.com/)",
      "*/",
    ].join("\n");
    const node = [
      "// Format function modified from nodejs",
      "// Copyright Joyent, Inc. and other Node contributors.",
      "//",
      "// Permission is hereby granted, free of charge, to any person",
    ].join("\n");
    const banner = "/*! tiny v1.0.0 | (c) 2020 Someone */";
    const tag = "/** @license Small v2.0.0 */";
    const text = [
      mit,
      '"use strict";',
      "/* A plain comment about the licence field. */",
      "// a plain line",
      "const x = 1;",
      node,
      `const glob = "/* Copyright in a string */";`,
      "const re = /\\/* Copyright (c) Nobody *\\//u;",
      `exports.a = 1;${banner}${tag}`,
      "/*! Bundled license information:\n\nx/index.js:\n  (*! @license MIT *)\n*/",
      mit,
      "  // (c) the third case, and Copyright 2024 Someone Else",
    ].join("\n");
    assert.deepEqual(licenceComments(text), [
      mit,
      banner,
      tag,
      node,
      "// (c) the third case, and Copyright 2024 Someone Else",
    ]);
    assert.deepEqual(licenceComments("/* (c) the third case */\n"), []);
    assert.deepEqual(licenceComments("/* SPDX-License-Identifier: MIT */\n"), [
      "/* SPDX-License-Identifier: MIT */",
    ]);
  });

  test("thirdPartyNotices adds under a package each licence comment the files of it the build contains carry, once, under the first file's path in the package and how many others carry it, after its licence and any bundler's comment; none from a file the build does not contain", () => {
    const root = join(scratch, "licence-comments-fixture");
    const mitt =
      "/*\nMIT License\n\nCopyright (c) Jason Miller (https://jasonformat.com/)\n*/";
    const own =
      "/*\n * Copyright The Authors\n * SPDX-License-Identifier: Apache-2.0\n */";
    writeTree(root, {
      "e/LICENSE": "MIT License\n\nCopyright (c) E\n",
      "e/dist/a.js": `${own}\nexports.a = 1;\n`,
      "e/dist/b.js": `${own}\nexports.b = 1;\n`,
      "e/dist/c.js": `${own}\nexports.c = 1;\n`,
      "e/dist/mitt.js": `${mitt} // based on mitt\nexports.m = 1;\n`,
      "e/dist/unused.js": "/* Copyright (c) Unused */\n",
      "e/dist/style.css": "/*! Copyright (c) Styled */\n.x{}\n",
    });
    const entry = {
      key: "e@1.0.0",
      directory: join(root, "e"),
      manifest: { name: "e", version: "1.0.0", license: "MIT" },
      files: ["mitt.js", "a.js", "c.js", "b.js", "style.css"].map((file) =>
        join(root, "e/dist", file),
      ),
    };
    const text = thirdPartyNotices({
      members: ["@requestport/web"],
      workspaces: [],
      unresolved: [],
      packages: new Map([[entry.key, entry]]),
    });
    assert.ok(
      text.endsWith(
        [
          "Package: e@1.0.0",
          "License: MIT",
          "",
          "--- LICENSE ---",
          "",
          "MIT License",
          "",
          "Copyright (c) E",
          "",
          "--- dist/a.js, and 2 other files of it: licence comment ---",
          "",
          own,
          "",
          "--- dist/mitt.js: licence comment ---",
          "",
          mitt,
          "",
          "--- dist/style.css: licence comment ---",
          "",
          "/*! Copyright (c) Styled */",
          "",
        ].join("\n"),
      ),
      text,
    );
    assert.equal(text.includes("Unused"), false);
    assert.equal(text.includes(root), false);
  });

  test("ownLicenceCommentProblems refuses each licence comment a module of RequestPort's own (under no node_modules) that the build contains carries, which no entry could carry; not one a package's file carries, nor a module of its own without one", () => {
    const root = join(scratch, "own-licence");
    writeTree(root, {
      "apps/web/src/copied.ts":
        "// Adapted from mitt.\n// Copyright (c) Jason Miller\nexport {};\n",
      "apps/web/src/plain.tsx": "/** A component. */\nexport {};\n",
      "node_modules/m/index.js": "/* Copyright (c) M */\n",
    });
    assert.deepEqual(
      ownLicenceCommentProblems(
        [
          join(root, "apps/web/src/copied.ts"),
          join(root, "apps/web/src/plain.tsx"),
          join(root, "node_modules/m/index.js"),
        ],
        root,
      ),
      [
        'apps/web/src/copied.ts, RequestPort\'s own module, which the self-host build contains, carries a licence comment, and no entry of THIRD-PARTY-NOTICES could carry it: "// Copyright (c) Jason Miller"',
      ],
    );
  });

  test("bundlerPackages enters the bundler WEB.bundler names, webpack, as vendored in next at the directory of its file, with no file of it as contained; refuses a holder the closure lacks, a file that is not there, and one with no package.json of its own; the real one is next 16.4.2's dist/compiled/webpack", () => {
    const root = join(scratch, "bundler-fixture");
    writeTree(root, {
      "node_modules/host/package.json": '{"name":"host","version":"1.0.0"}\n',
      "node_modules/host/dist/compiled/packer/package.json":
        '{"name":"packer","main":"bundle.js","license":"MIT"}\n',
      "node_modules/host/dist/compiled/packer/bundle.js":
        "module.exports = 1;\n",
      "node_modules/host/dist/loose.js": "module.exports = 2;\n",
    });
    const host = join(root, "node_modules/host");
    const closure = {
      scope: "the planted closure",
      packages: new Map([
        [
          "host@1.0.0",
          {
            key: "host@1.0.0",
            directory: host,
            manifest: { name: "host", version: "1.0.0" },
          },
        ],
      ]),
    };
    const found = bundlerPackages(closure, {
      holder: "host",
      path: "dist/compiled/packer/bundle.js",
    });
    assert.deepEqual(found.problems, []);
    const key = "packer (vendored in host@1.0.0 at dist/compiled/packer)";
    assert.deepEqual([...found.packages.keys()], [key]);
    assert.equal(
      found.packages.get(key).directory,
      join(host, "dist/compiled/packer"),
    );
    assert.deepEqual(found.packages.get(key).files, []);
    assert.deepEqual(
      bundlerPackages(closure, { holder: "host", path: "dist/missing.js" })
        .problems,
      [
        "host ships no dist/missing.js, the bundler whose runtime the self-host build's runtime chunks hold (WEB.bundler), or is not in the planted closure: review WEB.bundler",
      ],
    );
    assert.deepEqual(
      bundlerPackages(closure, { holder: "absent", path: "x.js" }).problems,
      [
        "absent ships no x.js, the bundler whose runtime the self-host build's runtime chunks hold (WEB.bundler), or is not in the planted closure: review WEB.bundler",
      ],
    );
    assert.deepEqual(
      bundlerPackages(closure, { holder: "host", path: "dist/loose.js" })
        .problems,
      [
        "no package.json between dist/loose.js and host@1.0.0's directory names the bundler as a package of its own: review WEB.bundler",
      ],
    );
    assert.deepEqual(WEB.bundler, {
      holder: "next",
      path: "dist/compiled/webpack/bundle5.js",
    });
    const real = bundlerPackages(
      productionClosure({ members: WEB.notices.members }),
    );
    assert.deepEqual(real.problems, []);
    assert.deepEqual(
      [...real.packages.values()].map(({ key: found, manifest }) => [
        found,
        manifest,
      ]),
      [
        [
          `webpack (vendored in next@16.4.2 at dist/compiled/webpack)`,
          {
            name: "webpack",
            main: "bundle5.js",
            author: "Tobias Koppers @sokra",
            license: "MIT",
          },
        ],
      ],
    );
  });

  test("noticesProblems refuses: a dependency the tree does not hold, an entry with no Package: line, a licence other than the manifest's, a package of the closure with no entry, a second entry for one package, and an entry for a package outside the closure", () => {
    const manifest = (name, license) => ({ name, version: "1.0.0", license });
    const closure = {
      members: ["@requestport/requestport"],
      workspaces: [],
      unresolved: [
        {
          dependent: "x@1.0.0",
          name: "y",
          range: "^2.0.0",
          kind: "dependency",
        },
      ],
      packages: new Map(
        [
          ["a", "MIT"],
          ["b", "ISC"],
          ["c", "MIT"],
        ].map(([name, license]) => [
          `${name}@1.0.0`,
          {
            key: `${name}@1.0.0`,
            directory: scratch,
            manifest: manifest(name, license),
          },
        ]),
      ),
    };
    const rule = "=".repeat(80);
    const text = [
      "Header",
      rule,
      "Package: a@1.0.0",
      "License: Apache-2.0",
      "",
      rule,
      "Package: d@1.0.0",
      "License: MIT",
      "",
      rule,
      "Package: c@1.0.0",
      "License: MIT",
      "",
      rule,
      "Package: c@1.0.0",
      "License: MIT",
      "",
      rule,
      "No package line.",
      "",
    ].join("\n");
    assert.deepEqual(noticesProblems(closure, text), [
      "x@1.0.0 depends on y@^2.0.0, which this tree does not hold, so THIRD-PARTY-NOTICES cannot cover it",
      "THIRD-PARTY-NOTICES has an entry with no Package: line",
      "THIRD-PARTY-NOTICES gives a@1.0.0's licence as Apache-2.0, where its package.json declares MIT",
      "THIRD-PARTY-NOTICES has no entry for b@1.0.0, which is in the production closure of @requestport/requestport",
      "THIRD-PARTY-NOTICES has 2 entries for c@1.0.0",
      "THIRD-PARTY-NOTICES has an entry for d@1.0.0, which is outside the production closure of @requestport/requestport",
    ]);
  });

  test("the check refuses, planted in requestport's real tarball, README.md with other words, or missing; and in @requestport/web's, THIRD-PARTY-NOTICES missing, without one package's entry, or with other bytes", () => {
    const { staged: packed, entries } = run.packs.requestport;
    assertHolds(
      checkRequestportTarball(
        planted(entries, { "package/README.md": "Other words.\n" }),
        packed,
      ),
      ["README.md is not apps/requestport/README.md, byte for byte"],
    );
    assertHolds(
      checkRequestportTarball(
        planted(entries, { "package/README.md": undefined }),
        packed,
      ),
      [
        "README.md is on the allow-list but not in the tarball",
        "README.md is missing: the stage copies apps/requestport/README.md",
      ],
    );
    const web = run.packs.web;
    assertHolds(
      checkWebTarball(
        planted(web.entries, { "package/THIRD-PARTY-NOTICES": undefined }),
        web.staged,
      ),
      [
        "THIRD-PARTY-NOTICES is on the allow-list but not in the tarball",
        "THIRD-PARTY-NOTICES is missing",
      ],
    );
    const [, dropped] = [...web.staged.closure.packages.keys()];
    assertHolds(
      checkWebTarball(
        planted(web.entries, {
          "package/THIRD-PARTY-NOTICES": withoutEntry(
            web.staged.notices,
            dropped,
          ),
        }),
        web.staged,
      ),
      [
        `THIRD-PARTY-NOTICES has no entry for ${dropped}, which is in the third-party code @requestport/web's self-host build contains`,
        "THIRD-PARTY-NOTICES is not the notices the stage wrote, byte for byte",
      ],
    );
    assert.deepEqual(
      checkWebTarball(
        planted(web.entries, {
          "package/THIRD-PARTY-NOTICES": `${web.staged.notices}\n`,
        }),
        web.staged,
      ),
      ["THIRD-PARTY-NOTICES is not the notices the stage wrote, byte for byte"],
    );
  });

  test("productionClosure walks, in a planted workspace, a member's production dependencies and those of the workspace packages it reaches, not its development dependencies, and answers a dependency the tree does not hold", () => {
    const root = join(scratch, "closure-fixture");
    writeTree(root, {
      "package.json": '{"name":"root","private":true}\n',
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/m/package.json": JSON.stringify({
        name: "@requestport/m",
        dependencies: {
          "@requestport/n": "workspace:*",
          gone: "1.0.0",
          left: "1.0.0",
        },
        devDependencies: { devonly: "1.0.0" },
      }),
      "packages/n/package.json": JSON.stringify({
        name: "@requestport/n",
        dependencies: { right: "1.0.0" },
      }),
      "node_modules/left/package.json":
        '{"name":"left","version":"1.0.0","license":"MIT"}',
      "node_modules/right/package.json":
        '{"name":"right","version":"1.0.0","license":"ISC"}',
      "node_modules/devonly/package.json":
        '{"name":"devonly","version":"1.0.0","license":"MIT"}',
    });
    mkdirSync(join(root, "node_modules/@requestport"), { recursive: true });
    symlinkSync("../../packages/n", join(root, "node_modules/@requestport/n"));
    const closure = productionClosure({
      root,
      members: ["@requestport/m"],
    });
    assert.deepEqual(closure.workspaces, ["@requestport/m", "@requestport/n"]);
    assert.deepEqual(
      [...closure.packages.keys()],
      ["left@1.0.0", "right@1.0.0"],
    );
    assert.deepEqual(closure.unresolved, [
      {
        dependent: "@requestport/m",
        name: "gone",
        range: "1.0.0",
        kind: "dependency",
      },
    ]);
  });

  test("productionClosure refuses a member that is not a workspace package of the tree", () => {
    assert.throws(
      () => productionClosure({ members: ["@requestport/absent"] }),
      {
        message:
          /^pack-requestport: @requestport\/absent is not a workspace package of /u,
      },
    );
  });
});

describe("the command", () => {
  test("stages requestport, G.7's eleven, @requestport/web and the client, each in its own directory under --out, outside the repository, and packs G.7's eleven, @requestport/web, the client and requestport, in that order, into --out; reads the tree's status before it builds and again after it packs; leaves the tree as it found it", () => {
    assert.ok(relative(repositoryRoot, run.out).startsWith(".."));
    const keys = [...Object.keys(PACKAGES), "web", "client", "requestport"];
    assert.deepEqual(Object.keys(run.packs), keys);
    for (const name of keys) {
      const { staged: packed, tarball } = run.packs[name];
      assert.equal(packed.directory, join(run.out, "stage", name));
      assert.equal(dirname(tarball), run.out);
    }
    assert.deepEqual(
      readdirSync(run.out).sort(),
      [
        "build-record.json",
        `requestport-${VERSION}.tgz`,
        ...[...Object.keys(PACKAGES), "web", "client"].map(
          (name) => `requestport-${name}-${VERSION}.tgz`,
        ),
        "stage",
      ].sort(),
    );
    assert.equal(treeReads, 2);
    assert.equal(realStatus.after, realStatus.before);
  });

  test("refuses, under this script's name and before it builds anything, a version it would not stamp, a dirty tree, an --out inside the repository and an --out that is not empty", async () => {
    const clean = {
      treeStatus: () => "",
      log: () => {},
      build: () => {
        throw new Error("the web UI was built");
      },
    };
    await assert.rejects(main(["--out", join(scratch, "no-version")], clean), {
      message: /^pack-requestport: --version must be major\.minor\.patch/u,
    });
    await assert.rejects(
      main(["--version", "1.0", "--out", join(scratch, "bad-version")], clean),
      { message: /^pack-requestport: --version must be major\.minor\.patch/u },
    );
    const dirty = join(scratch, "dirty");
    await assert.rejects(
      main(["--version", VERSION, "--out", dirty], {
        ...clean,
        treeStatus: () => " M packages/client/src/index.ts\n",
      }),
      { message: /^pack-requestport refuses a dirty tree/u },
    );
    const inside = join(repositoryRoot, "scripts/pack-requestport-test-out");
    await assert.rejects(main(["--version", VERSION, "--out", inside], clean), {
      message: /^pack-requestport: .* is inside the repository/u,
    });
    const occupied = join(scratch, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "stray"), "");
    await assert.rejects(
      main(["--version", VERSION, "--out", occupied], clean),
      { message: /^pack-requestport: .* is not empty\./u },
    );
    for (const directory of [
      join(scratch, "no-version"),
      join(scratch, "bad-version"),
      dirty,
      inside,
    ]) {
      assert.equal(existsSync(directory), false, directory);
    }
    assert.deepEqual(readdirSync(occupied), ["stray"]);
  });

  test("refuses a tree whose status changed while it built and packed, and writes no build record", async () => {
    const out = join(scratch, "changed");
    const statuses = ["", " M apps/web/next-env.d.ts\n"];
    await assert.rejects(
      main(["--version", VERSION, "--out", out], {
        treeStatus: () => statuses.shift(),
        log: () => {},
        build: async () =>
          standaloneFixture(join(scratch, "standalone-changed")),
      }),
      { message: /^pack-requestport: the tree changed while it packed/u },
    );
    assert.deepEqual(statuses, []);
    assert.equal(existsSync(join(out, "build-record.json")), false);
  });

  test("writes the build record: the commit, the tree's status, Node's and pnpm's versions, and each tarball's name, version, sha512 integrity, size and file count, in the order they were packed: G.7's eleven, @requestport/web, the client, requestport", () => {
    const facts = (name, file) => {
      const { tarball, entries, staged: packed } = run.packs[name];
      const bytes = readFileSync(tarball);
      return {
        file,
        name: packed.manifest.name,
        version: VERSION,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        size: bytes.length,
        files: entries.size,
      };
    };
    assert.deepEqual(run.record, {
      commit: spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).stdout.trim(),
      treeStatus: "",
      node: process.version,
      pnpm: readJson("package.json").packageManager.replace(/^pnpm@/u, ""),
      tarballs: [
        ...[...Object.keys(PACKAGES), "web", "client"].map((name) =>
          facts(name, `requestport-${name}-${VERSION}.tgz`),
        ),
        facts("requestport", `requestport-${VERSION}.tgz`),
      ],
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(run.out, "build-record.json"), "utf8")),
      run.record,
    );
  });
});

describe("verbatimPackages: the files the build copies as they are, by the reviewed list (ruling 198 item 2)", () => {
  const root = join(scratch, "verbatim-fixture");
  const holder = join(root, "node_modules/holder");
  const server = join(root, "build");
  const sha256 = (body) => createHash("sha256").update(body).digest("hex");
  const POLY = "!function(){/* a polyfill bundle */}();\n";
  writeTree(root, {
    "node_modules/holder/package.json": '{"name":"holder","version":"1.0.0"}\n',
    "node_modules/holder/dist/poly.js": POLY,
    "node_modules/holder/dist/other.js": "module.exports = 2;\n",
    "build/.next-self-host/static/chunks/polyfills-abc.js": POLY,
    "build/.next-self-host/static/chunks/main-abc.js":
      "self.webpackChunk=[];\n",
    "build/.next-self-host/static/media/same.js": POLY,
    "build/server.js": "require('next');\n",
  });
  const closure = {
    members: ["@requestport/web"],
    packages: new Map([
      [
        "holder@1.0.0",
        {
          key: "holder@1.0.0",
          directory: holder,
          manifest: { name: "holder", version: "1.0.0" },
        },
      ],
    ]),
  };
  const listed = {
    sha256: sha256(POLY),
    holder: "holder",
    path: "dist/poly.js",
    emitted: "static/chunks/polyfills-<hash>.js",
    reviewed: "a planted entry",
    bundles: [
      {
        name: "inner",
        version: "2.0.0",
        license: "MIT",
        file: "LICENSE",
        text: "The inner licence.\n",
      },
    ],
  };

  test("a file the build emits that is, byte for byte, a file a package of the closure ships, and that the list names by its SHA-256 with that package and path: the package's file joins the build's, and each package the entry bundles is entered by itself as bundled in it, with the licence and text the entry gives; a file of static/media is emittedPackages', not this", () => {
    assert.deepEqual(verbatimPackages(server, closure, [listed]), {
      packages: new Map([
        [
          "inner@2.0.0 (bundled in holder@1.0.0)",
          {
            key: "inner@2.0.0 (bundled in holder@1.0.0)",
            manifest: { name: "inner", version: "2.0.0", license: "MIT" },
            bundledIn: "holder@1.0.0",
            texts: [{ file: "LICENSE", text: "The inner licence.\n" }],
          },
        ],
      ]),
      files: [join(holder, "dist/poly.js")],
      copied: [
        {
          path: ".next-self-host/static/chunks/polyfills-abc.js",
          package: "holder@1.0.0",
          file: "dist/poly.js",
        },
      ],
      problems: [],
    });
  });

  test("refuses, so that it is reviewed before it ships: a copied file whose SHA-256 the list does not name (a changed file), one whose entry names another package or path, and an entry no file of the build is", () => {
    const unlisted = verbatimPackages(server, closure, []);
    assert.deepEqual(unlisted.packages, new Map());
    assert.deepEqual(unlisted.problems, [
      `.next-self-host/static/chunks/polyfills-abc.js is, byte for byte, holder@1.0.0's dist/poly.js, which the build copies as it is, and scripts/pack-requestport-verbatim.json names no file of SHA-256 ${sha256(POLY)}: review what it bundles, and list it`,
    ]);
    assert.deepEqual(
      verbatimPackages(server, closure, [{ ...listed, path: "dist/old.js" }])
        .problems,
      [
        `.next-self-host/static/chunks/polyfills-abc.js is, byte for byte, holder@1.0.0's dist/poly.js, and scripts/pack-requestport-verbatim.json gives its SHA-256 ${sha256(POLY)} to holder's dist/old.js`,
      ],
    );
    const stale = { ...listed, sha256: "0".repeat(64), path: "dist/gone.js" };
    assert.deepEqual(
      verbatimPackages(server, closure, [listed, stale]).problems,
      [
        `scripts/pack-requestport-verbatim.json lists holder's dist/gone.js (SHA-256 ${"0".repeat(64)}), and the build copies no file of it: review the list`,
      ],
    );
  });

  test("the reviewed list is this tree's: each entry's file is, byte for byte, its holder's file as apps/web installs it, at the SHA-256 it gives; each package it bundles has a version, a licence and its licence file's text, at the SHA-256 this case pins for it (its npm tarball's file, its trailing white space dropped), and the store's, byte for byte, where this tree installs that version (object-assign 4.1.1); the polyfills Next 16.4.2 copies bundle core-js, object-assign and whatwg-fetch", () => {
    // Each bundled text, by the SHA-256 of the text the list holds: the
    // licence file of that version's npm tarball, which the entry's from
    // names by its sha512, its trailing white space dropped; measured after
    // H.7 round 6's review against the tarballs fetched in that round. A
    // text this names otherwise, or a package it does not name, fails here
    // until the list is reviewed and this pin with it.
    const texts = {
      "core-js@3.38.1":
        "0d9fbad18557ac87fb8874e4632422e5ece2058318c7ad824f69217aab8dd82b",
      "object-assign@4.1.1":
        "2bc4beb49d4852de32aecc72c9db954596cfcfcdc980fd7693adc89d5aa5d31f",
      "whatwg-fetch@3.0.0":
        "1d04d176fe11747498e4d94431dbf66a920209b84a5c4938d8535c4b5be711ab",
    };
    assert.equal(VERBATIM.file, "scripts/pack-requestport-verbatim.json");
    assert.deepEqual(
      JSON.parse(readFileSync(join(repositoryRoot, VERBATIM.file), "utf8"))
        .files,
      VERBATIM.files,
    );
    for (const {
      sha256: digest,
      holder: name,
      path,
      bundles,
    } of VERBATIM.files) {
      const body = readFileSync(join(installedForWeb(name), path));
      assert.equal(sha256(body), digest, path);
      for (const bundle of bundles) {
        assert.match(bundle.version, /^\d+\.\d+\.\d+$/u);
        assert.equal(bundle.license, "MIT", bundle.name);
        assert.ok(bundle.text.length > 0, bundle.name);
        assert.equal(
          sha256(bundle.text),
          texts[`${bundle.name}@${bundle.version}`],
          `${bundle.name}@${bundle.version}'s text`,
        );
        const store = join(
          repositoryRoot,
          "node_modules/.pnpm",
          `${bundle.name}@${bundle.version}`,
          "node_modules",
          bundle.name,
          bundle.file,
        );
        if (existsSync(store)) {
          assert.equal(
            bundle.text,
            readFileSync(store, "utf8").replaceAll("\r\n", "\n").trimEnd(),
            bundle.name,
          );
        }
      }
    }
    assert.deepEqual(
      VERBATIM.files.map(({ path, bundles }) => [
        path,
        bundles.map(({ name, version }) => `${name}@${version}`),
      ]),
      [
        [
          "dist/build/polyfills/polyfill-nomodule.js",
          ["core-js@3.38.1", "object-assign@4.1.1", "whatwg-fetch@3.0.0"],
        ],
        [VERBATIM.files[1].path, []],
      ],
    );
  });
});

describe("nestedPackages: the packages vendored inside an installed package, by their own package.json (ruling 199 item 1)", () => {
  const root = join(scratch, "nested-fixture");
  const holder = join(root, "node_modules/holder");
  writeTree(root, {
    "node_modules/holder/package.json": '{"name":"holder","version":"1.0.0"}\n',
    "node_modules/holder/dist/compiled/inner/package.json":
      '{"name":"inner","version":"2.0.0","license":"MIT"}\n',
    "node_modules/holder/dist/compiled/inner/LICENSE": "The inner licence.\n",
    "node_modules/holder/dist/compiled/inner/deep/package.json":
      '{"name":"deeper"}\n',
    "node_modules/holder/dist/compiled/inner/sub/package.json":
      '{"name":"inner/sub"}\n',
    "node_modules/holder/dist/compiled/inner/again/package.json":
      '{"name":"inner","version":"9.9.9"}\n',
    "node_modules/holder/dist/esm/package.json": '{"type":"module"}\n',
    "node_modules/holder/dist/self/package.json": '{"name":"holder"}\n',
    "node_modules/holder/dist/selfsub/package.json": '{"name":"holder/sub"}\n',
    "node_modules/holder/dist/broken/package.json": "{ not json\n",
    "node_modules/holder/node_modules/bundled-dep/package.json":
      '{"name":"bundled-dep","version":"3.0.0"}\n',
    "outside/package.json": '{"name":"outside","version":"1.0.0"}\n',
    "skipped/vendor/package.json": '{"name":"not-walked","version":"1.0.0"}\n',
  });
  symlinkSync("../../../outside", join(holder, "dist/linked"));
  const entry = (key, directory, extra = {}) => [
    key,
    {
      key,
      directory,
      manifest: {
        name: key.replace(/@[^@]*$/u, ""),
        version: key.slice(key.lastIndexOf("@") + 1),
      },
      ...extra,
    },
  ];
  const closure = {
    members: ["@requestport/web"],
    packages: new Map([
      entry("holder@1.0.0", holder),
      // A vendored and a bundled entry are not walked, and an entry with
      // no directory (one a reviewed list gives) has nothing to walk.
      entry("x@1.0.0", join(root, "skipped"), {
        vendoredIn: { key: "holder@1.0.0", name: "holder" },
      }),
      entry("y@1.0.0", join(root, "skipped"), { bundledIn: "holder@1.0.0" }),
      ["z@1.0.0", { key: "z@1.0.0", manifest: { name: "z" } }],
    ]),
  };

  test("enters every package.json below an installed package's own directory that names a package other than the one whose directory encloses it, nor a subpath of its name, by itself as vendored in the installed package at that directory, with its manifest and no file as contained; one naming nothing, the enclosing package, or a subpath of it, and one that is not JSON, is that package's own; a directory that is a symbolic link is not entered, and vendored and bundled entries are not walked", () => {
    const vendoredIn = { key: "holder@1.0.0", name: "holder" };
    assert.deepEqual(
      nestedPackages(closure).packages,
      new Map([
        [
          "bundled-dep@3.0.0 (vendored in holder@1.0.0 at node_modules/bundled-dep)",
          {
            key: "bundled-dep@3.0.0 (vendored in holder@1.0.0 at node_modules/bundled-dep)",
            directory: join(holder, "node_modules/bundled-dep"),
            manifest: { name: "bundled-dep", version: "3.0.0" },
            vendoredIn,
            files: [],
          },
        ],
        [
          "deeper (vendored in holder@1.0.0 at dist/compiled/inner/deep)",
          {
            key: "deeper (vendored in holder@1.0.0 at dist/compiled/inner/deep)",
            directory: join(holder, "dist/compiled/inner/deep"),
            manifest: { name: "deeper" },
            vendoredIn,
            files: [],
          },
        ],
        [
          "inner@2.0.0 (vendored in holder@1.0.0 at dist/compiled/inner)",
          {
            key: "inner@2.0.0 (vendored in holder@1.0.0 at dist/compiled/inner)",
            directory: join(holder, "dist/compiled/inner"),
            manifest: { name: "inner", version: "2.0.0", license: "MIT" },
            vendoredIn,
            files: [],
          },
        ],
      ]),
    );
    // Its entries are written as any vendored package's: its licence and
    // its own licence files.
    const notices = thirdPartyNotices(
      { packages: nestedPackages(closure).packages },
      WEB.notices,
    );
    assert.ok(
      notices.includes(
        "Package: inner@2.0.0 (vendored in holder@1.0.0 at dist/compiled/inner)\nLicense: MIT\n\n--- LICENSE ---\n\nThe inner licence.\n",
      ),
      notices,
    );
  });

  test("does not fail open (H.7 round 7's review): it reads a package.json that is a symbolic link through the link, and answers a problem, by the installed package and the path in it, for each directory below that package's own, and each package.json there, that it cannot read, so that the stage refuses its notices rather than leave unread what a package vendors there", {
    skip:
      process.getuid?.() === 0
        ? "root reads a directory of mode 000, which this case needs refused"
        : false,
  }, () => {
    const at = join(scratch, "nested-unread");
    const unread = join(at, "node_modules/holder");
    writeTree(at, {
      "node_modules/holder/package.json":
        '{"name":"holder","version":"1.0.0"}\n',
      "node_modules/holder/dist/compiled/locked/package.json":
        '{"name":"locked","version":"1.0.0"}\n',
      "node_modules/holder/dist/compiled/linked/index.js": "",
      "node_modules/holder/dist/compiled/dangling/index.js": "",
      "manifests/linked.json": '{"name":"linked-manifest","version":"1.0.0"}\n',
    });
    symlinkSync(
      "../../../../../manifests/linked.json",
      join(unread, "dist/compiled/linked/package.json"),
    );
    symlinkSync(
      "absent.json",
      join(unread, "dist/compiled/dangling/package.json"),
    );
    const locked = join(unread, "dist/compiled/locked");
    chmodSync(locked, 0o000);
    let found;
    try {
      found = nestedPackages({
        members: ["@requestport/web"],
        packages: new Map([entry("holder@1.0.0", unread)]),
      });
    } finally {
      chmodSync(locked, 0o755);
    }
    assert.deepEqual(
      [...found.packages.keys()],
      [
        "linked-manifest@1.0.0 (vendored in holder@1.0.0 at dist/compiled/linked)",
      ],
    );
    assert.deepEqual(found.problems, [
      "holder@1.0.0's dist/compiled/dangling/package.json cannot be read (ENOENT), so nothing says whether it names a package holder@1.0.0 vendors there (nestedPackages)",
      "holder@1.0.0's dist/compiled/locked cannot be read (EACCES), so nothing says which packages holder@1.0.0 vendors there (nestedPackages)",
    ]);
    // The fixture above, which it reads whole, gives none.
    assert.deepEqual(nestedPackages(closure).problems, []);
  });

  test("on the real tree: the packages next keeps under its dist/compiled are keyed as containedPackages and bundlerPackages key them (webpack's, ua-parser-js's and the React next vendors), so withAdded keeps the entry those gave; the React next vendors, and webpack, among them", () => {
    const next = installedForWeb("next");
    const nextKey = `next@${JSON.parse(readFileSync(join(next, "package.json"), "utf8")).version}`;
    const real = {
      members: ["@requestport/web"],
      packages: new Map([
        [
          nextKey,
          {
            key: nextKey,
            directory: next,
            manifest: JSON.parse(
              readFileSync(join(next, "package.json"), "utf8"),
            ),
          },
        ],
      ]),
    };
    const scanned = nestedPackages(real);
    assert.deepEqual(scanned.problems, []);
    const nested = scanned.packages;
    const contained = containedPackages([
      join(next, "dist/compiled/ua-parser-js/ua-parser.js"),
      join(next, "dist/compiled/react/index.js"),
    ]).packages;
    for (const key of contained.keys()) {
      if (key === nextKey) continue;
      assert.ok(nested.has(key), key);
      assert.equal(nested.get(key).directory, contained.get(key).directory);
    }
    for (const key of bundlerPackages(real).packages.keys()) {
      assert.ok(nested.has(key), key);
    }
    assert.ok(
      nested.has(`webpack (vendored in ${nextKey} at dist/compiled/webpack)`),
    );
    assert.ok(nested.size > 100, String(nested.size));
    assert.ok(
      [...nested.values()].every(
        ({ vendoredIn }) => vendoredIn.key === nextKey,
      ),
    );
  });
});

describe("listedVendoredPackages: the packages a vendored copy with no package.json bundles, by the reviewed list (ruling 199 item 1)", () => {
  const root = join(scratch, "listed-fixture");
  const holder = join(root, "node_modules/holder");
  const sha256 = (body) => createHash("sha256").update(body).digest("hex");
  const BUNDLE = "var copied = 1; // a bundle of other packages\n";
  writeTree(root, {
    "node_modules/holder/package.json": '{"name":"holder","version":"1.0.0"}\n',
    "node_modules/holder/dist/vendor/bundle.mjs": BUNDLE,
    "node_modules/holder/dist/vendor/bundle.cjs": BUNDLE,
  });
  const closure = {
    members: ["@requestport/web"],
    packages: new Map([
      [
        "holder@1.0.0",
        {
          key: "holder@1.0.0",
          directory: holder,
          manifest: { name: "holder", version: "1.0.0" },
        },
      ],
    ]),
  };
  const bundles = [
    {
      name: "inner",
      version: "2.0.0",
      license: "MIT",
      file: "LICENSE",
      text: "The inner licence.",
    },
    {
      name: "other",
      version: "1.0.0",
      license: "ISC",
      file: "license",
      text: "The other licence.",
    },
  ];
  const copy = (path, extra = {}) => ({
    holder: "holder",
    version: "1.0.0",
    path,
    sha256: sha256(BUNDLE),
    reviewed: "a planted entry",
    bundles,
    ...extra,
  });

  test("enters each package a listed copy bundles, by itself as vendored in the installed package that holds it, with the licence and text the entry gives, once whichever of its copies names it", () => {
    const vendoredIn = { key: "holder@1.0.0", name: "holder" };
    assert.deepEqual(
      listedVendoredPackages(closure, [
        copy("dist/vendor/bundle.mjs"),
        copy("dist/vendor/bundle.cjs"),
      ]),
      {
        packages: new Map([
          [
            "inner@2.0.0 (vendored in holder@1.0.0)",
            {
              key: "inner@2.0.0 (vendored in holder@1.0.0)",
              manifest: { name: "inner", version: "2.0.0", license: "MIT" },
              vendoredIn,
              texts: [{ file: "LICENSE", text: "The inner licence." }],
            },
          ],
          [
            "other@1.0.0 (vendored in holder@1.0.0)",
            {
              key: "other@1.0.0 (vendored in holder@1.0.0)",
              manifest: { name: "other", version: "1.0.0", license: "ISC" },
              vendoredIn,
              texts: [{ file: "license", text: "The other licence." }],
            },
          ],
        ]),
        problems: [],
      },
    );
  });

  test("refuses, so that a changed copy is reviewed before it ships: an entry whose holder the closure holds at another version, one whose file is at another SHA-256, and one whose file the holder does not ship", () => {
    const found = listedVendoredPackages(closure, [
      copy("dist/vendor/bundle.mjs", { version: "0.9.0" }),
      copy("dist/vendor/bundle.cjs", { sha256: "0".repeat(64) }),
      copy("dist/vendor/gone.js"),
    ]);
    assert.deepEqual(found.packages, new Map());
    assert.deepEqual(found.problems, [
      "scripts/pack-requestport-vendored.json lists holder 0.9.0's dist/vendor/bundle.mjs, and the notices cover holder@1.0.0: review what its copy bundles, and the list",
      `scripts/pack-requestport-vendored.json lists holder@1.0.0's dist/vendor/bundle.cjs at SHA-256 ${"0".repeat(64)}, and it is at ${sha256(BUNDLE)}: review what it bundles, and the list`,
      "scripts/pack-requestport-vendored.json lists holder@1.0.0's dist/vendor/gone.js, which it does not ship: review the list",
    ]);
  });

  test("refuses an entry whose holder is no installed package of the closure, so that a mis-keyed entry closes nothing silently (H.7 round 7's review): one whose holder the closure holds only as vendored in, or bundled in, another package, even with a file there at another SHA-256, and one whose holder neither the closure nor the production closure it is handed (the closure itself, unless a caller hands another) holds a package of; an entry whose holder the production closure installs and the closure does not hold adds nothing: the notices cover no code of it", () => {
    const inner =
      "inner@2.0.0 (vendored in holder@1.0.0 at dist/compiled/inner)";
    const other = "other@1.0.0 (bundled in holder@1.0.0)";
    const keyed = {
      ...closure,
      packages: new Map([
        ...closure.packages,
        [
          inner,
          {
            key: inner,
            directory: join(holder, "dist/compiled/inner"),
            manifest: { name: "inner", version: "2.0.0" },
            vendoredIn: { key: "holder@1.0.0", name: "holder" },
            files: [],
          },
        ],
        [
          other,
          {
            key: other,
            manifest: { name: "other", version: "1.0.0", license: "ISC" },
            bundledIn: "holder@1.0.0",
          },
        ],
      ]),
    };
    writeTree(join(holder, "dist/compiled/inner"), {
      "package.json": '{"name":"inner","version":"2.0.0"}\n',
      "vendor/bundle.mjs": "changed\n",
    });
    const entries = [
      copy("vendor/bundle.mjs", {
        holder: "inner",
        version: "2.0.0",
        sha256: "0".repeat(64),
      }),
      copy("index.js", { holder: "other" }),
      copy("dist/vendor/bundle.mjs", { holder: "absent" }),
      copy("dist/vendor/bundle.mjs", { holder: "spare" }),
    ];
    const misKeyed = [
      `scripts/pack-requestport-vendored.json lists inner 2.0.0's vendor/bundle.mjs, and the notices cover inner only as vendored or bundled in another package (${inner}): key the entry by the installed package that holds the copy, with the copy's path from that package's directory`,
      `scripts/pack-requestport-vendored.json lists other 1.0.0's index.js, and the notices cover other only as vendored or bundled in another package (${other}): key the entry by the installed package that holds the copy, with the copy's path from that package's directory`,
      "scripts/pack-requestport-vendored.json lists absent 1.0.0's dist/vendor/bundle.mjs, and neither the notices nor the production closure they are bounded by hold a package of that name: the entry is stale or mis-keyed: review the list",
    ];
    const production = {
      ...closure,
      packages: new Map([
        ...closure.packages,
        [
          "spare@1.0.0",
          {
            key: "spare@1.0.0",
            directory: join(root, "node_modules/spare"),
            manifest: { name: "spare", version: "1.0.0" },
          },
        ],
      ]),
    };
    const found = listedVendoredPackages(keyed, entries, production);
    assert.deepEqual(found.packages, new Map());
    assert.deepEqual(found.problems, misKeyed);
    // With no production closure handed, the closure is its own: spare,
    // which it holds no package of, is refused too.
    assert.deepEqual(listedVendoredPackages(keyed, entries).problems, [
      ...misKeyed,
      "scripts/pack-requestport-vendored.json lists spare 1.0.0's dist/vendor/bundle.mjs, and neither the notices nor the production closure they are bounded by hold a package of that name: the entry is stale or mis-keyed: review the list",
    ]);
  });

  test("the reviewed list is this tree's: each entry's file is, byte for byte, at the SHA-256 it gives, in each copy of its holder apps/web's production closure holds, at the version it gives; each package it bundles has a version, MIT and its licence file's text, at the SHA-256 this case pins for it (its npm tarball's file, its trailing white space dropped); @trigger.dev/core 4.6.4's two superjson bundles bundle copy-anything 3.0.5, is-what 4.1.16 and superjson 2.2.1, and one file each of drizzle-orm 0.45.2, @electric-sql/client 1.0.14 and next 16.4.2 carries esbuild's runtime helpers and one each of @modelcontextprotocol/server 2.3.0 and @better-auth/oauth-provider 1.7.6 rolldown's runtime, entered as esbuild 0.28.2 and rolldown 1.2.4 (ruling 210 item 2), which listedVendoredPackages enters over apps/web's production closure", () => {
    // Each bundled text, by the SHA-256 of the text the list holds: the
    // licence file of that version's npm tarball, which the entry's from
    // names by its sha512, its trailing white space dropped; measured at
    // H.7 round 7 against the tarballs fetched in that round, and, for
    // esbuild and rolldown, at J.8, ruling 210's round, on the copies
    // packages/core installs.
    const texts = {
      "copy-anything@3.0.5":
        "c1c7c66a0baef8fd308e2665face6a688acf492654c0a636f97381dd905e2919",
      "esbuild@0.28.2":
        "f2b90afb27a6bc02915e506d60b5271f69a4dcc643b674c83584077c547d71dc",
      "is-what@4.1.16":
        "c1c7c66a0baef8fd308e2665face6a688acf492654c0a636f97381dd905e2919",
      "rolldown@1.2.4":
        "93a675c915fd5846a0d9956bfc10cea9b2deeacf59074abf398f0fdcce10a19b",
      "superjson@2.2.1":
        "a6369815f9f06d43aeee08426a6e656446a281174a67dcd7fdc57b9285419259",
    };
    assert.equal(
      VENDORED_COPIES.file,
      "scripts/pack-requestport-vendored.json",
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(repositoryRoot, VENDORED_COPIES.file), "utf8"),
      ).copies,
      VENDORED_COPIES.copies,
    );
    const production = productionClosure({ members: WEB.notices.members });
    // Each copy of a holder the closure holds as installed, not as vendored
    // or bundled in another, as listedVendoredPackages reads a holder.
    const holders = (name) =>
      [...production.packages.values()].filter(
        ({ manifest, directory, vendoredIn, bundledIn }) =>
          manifest?.name === name &&
          directory !== undefined &&
          vendoredIn === undefined &&
          bundledIn === undefined,
      );
    for (const {
      holder: name,
      version: at,
      path,
      sha256: digest,
      bundles: listed,
    } of VENDORED_COPIES.copies) {
      const held = holders(name);
      assert.ok(held.length > 0, name);
      for (const { manifest, directory } of held) {
        assert.equal(manifest.version, at, name);
        assert.equal(
          sha256(readFileSync(join(directory, path))),
          digest,
          `${name}'s ${path}`,
        );
      }
      for (const bundle of listed) {
        assert.match(bundle.version, /^\d+\.\d+\.\d+$/u);
        assert.equal(bundle.license, "MIT", bundle.name);
        assert.equal(
          sha256(bundle.text),
          texts[`${bundle.name}@${bundle.version}`],
          `${bundle.name}@${bundle.version}'s text`,
        );
      }
    }
    assert.deepEqual(
      VENDORED_COPIES.copies.map(({ path, bundles: listed }) => [
        path,
        listed.map(({ name, version: at }) => `${name}@${at}`),
      ]),
      [
        [
          SUPERJSON,
          ["copy-anything@3.0.5", "is-what@4.1.16", "superjson@2.2.1"],
        ],
        [
          "dist/commonjs/v3/vendor/superjson.cjs",
          ["copy-anything@3.0.5", "is-what@4.1.16", "superjson@2.2.1"],
        ],
        ["alias.cjs", ["esbuild@0.28.2"]],
        ["dist/index.mjs", ["esbuild@0.28.2"]],
        ["dist/compiled/@edge-runtime/cookies/index.js", ["esbuild@0.28.2"]],
        ["dist/chunk-Br0eD_fh.mjs", ["rolldown@1.2.4"]],
        ["dist/rolldown-runtime-wcPFST8Q.mjs", ["rolldown@1.2.4"]],
      ],
    );
    const key = (name) => holders(name)[0].key;
    const found = listedVendoredPackages(production);
    assert.deepEqual(found.problems, []);
    assert.deepEqual(
      [...found.packages.keys()],
      [
        ...["copy-anything@3.0.5", "is-what@4.1.16", "superjson@2.2.1"].map(
          (id) => `${id} (vendored in ${key("@trigger.dev/core")})`,
        ),
        ...["drizzle-orm", "@electric-sql/client", "next"].map(
          (name) => `esbuild@0.28.2 (vendored in ${key(name)})`,
        ),
        ...["@modelcontextprotocol/server", "@better-auth/oauth-provider"].map(
          (name) => `rolldown@1.2.4 (vendored in ${key(name)})`,
        ),
      ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });

  test("ruling 210 item 2: the reviewed list enters, over apps/web's production closure, esbuild 0.28.2, with the MIT text of the LICENSE.md of the esbuild packages/core installs, as vendored in drizzle-orm, @electric-sql/client and next (its compiled @edge-runtime/cookies), each listed file of which binds esbuild's runtime helpers at the start of a line; and rolldown 1.2.4, with the MIT text of the LICENSE of the rolldown packages/core installs, as vendored in @modelcontextprotocol/server and @better-auth/oauth-provider, each listed file of which is rolldown's runtime and binds some of the same names; the notices thirdPartyNotices writes for those entries have an entry for esbuild, as checkRun reads one", () => {
    const production = productionClosure({ members: WEB.notices.members });
    const fromCore = createRequire(
      join(repositoryRoot, "packages/core/package.json"),
    );
    const installed = (name, file) => {
      const directory = dirname(fromCore.resolve(`${name}/package.json`));
      return {
        version: JSON.parse(
          readFileSync(join(directory, "package.json"), "utf8"),
        ).version,
        file,
        text: readFileSync(join(directory, file), "utf8").trimEnd(),
      };
    };
    const bundlers = {
      esbuild: installed("esbuild", "LICENSE.md"),
      rolldown: installed("rolldown", "LICENSE"),
    };
    assert.equal(bundlers.esbuild.version, "0.28.2");
    assert.match(
      bundlers.esbuild.text,
      /^MIT License\n\nCopyright \(c\) 2020 Evan Wallace\n/u,
    );
    assert.equal(bundlers.rolldown.version, "1.2.4");
    assert.match(
      bundlers.rolldown.text,
      /^MIT License\n\nCopyright \(c\) 2024-present VoidZero Inc\. & Contributors\n/u,
    );
    const found = listedVendoredPackages(production);
    assert.deepEqual(found.problems, []);
    // The list's own entries for a bundler's runtime, each holder's file read
    // at the path its entry gives, so that a changed path is read here as
    // listedVendoredPackages reads it (ruling 211 item 2).
    const runtimes = VENDORED_COPIES.copies
      .filter(({ bundles }) =>
        bundles.some(({ name }) => Object.hasOwn(bundlers, name)),
      )
      .map(({ holder, path, bundles }) => [
        holder,
        path,
        bundles.map(({ name }) => name),
      ]);
    assert.deepEqual(
      runtimes.map(([name, , names]) => [name, names]),
      [
        ["drizzle-orm", ["esbuild"]],
        ["@electric-sql/client", ["esbuild"]],
        ["next", ["esbuild"]],
        ["@modelcontextprotocol/server", ["rolldown"]],
        ["@better-auth/oauth-provider", ["rolldown"]],
      ],
    );
    const keys = [];
    for (const [name, path, [bundler]] of runtimes) {
      const [holder] = [...production.packages.values()].filter(
        ({ manifest, vendoredIn, bundledIn }) =>
          manifest?.name === name &&
          vendoredIn === undefined &&
          bundledIn === undefined,
      );
      assert.ok(holder, `${name} is in apps/web's production closure`);
      const text = readFileSync(join(holder.directory, path), "utf8");
      assert.notDeepEqual(esbuildHelpersIn(text), [], `${name}'s ${path}`);
      if (bundler === "rolldown") {
        assert.match(
          text,
          /^\/\/#region (?:rolldown:runtime|\\0rolldown\/runtime\.js)$/mu,
          `${name}'s ${path} is rolldown's runtime`,
        );
      }
      const { version, file, text: licence } = bundlers[bundler];
      const key = `${bundler}@${version} (vendored in ${holder.key})`;
      const entry = found.packages.get(key);
      assert.ok(entry, `${key} is entered`);
      assert.deepEqual(entry.manifest, {
        name: bundler,
        version,
        license: "MIT",
      });
      assert.deepEqual(entry.texts, [{ file, text: licence }]);
      assert.deepEqual(entry.vendoredIn, {
        key: holder.key,
        name: holder.manifest.name,
      });
      keys.push(key);
    }
    const notices = thirdPartyNotices(
      {
        ...production,
        packages: new Map(keys.map((key) => [key, found.packages.get(key)])),
      },
      WEB.notices,
    );
    assert.deepEqual(
      noticesEntries(notices).map(({ key }) => key),
      keys,
    );
    assert.equal(noticesNameEsbuild(notices), true);
  });

  test("ruling 211 item 2: the header of @requestport/web's notices says that an entry for a bundler's runtime a package's own files carry names the bundler at the version this repository's packages/core installs, which the list's checks hold it to (the case above), not the version that wrote those files, which the package's build does not record, as each such entry of the reviewed list does; it does not say the version installed where the package was packed (ruling 232 item 4)", () => {
    const header = WEB.notices.header.replace(/\s+/gu, " ");
    assert.ok(
      header.includes(
        "Where that copy is a bundler's runtime that the package's own files carry, the bundler is listed at the version this repository's packages/core installs, which the list's checks hold it to, with that version's licence text, and not at the version that wrote those files, which the package's build does not record.",
      ),
      header,
    );
    assert.ok(
      !header.includes("the bundler is listed at the version installed where"),
      header,
    );
  });
});

describe("bundledPackages: the packages a contained file bundles, by its source map (ruling 198 item 2)", () => {
  const root = join(scratch, "bundled-fixture");
  const holder = join(root, "node_modules/holder");
  const store = join(root, "store");
  writeTree(root, {
    "node_modules/holder/package.json": '{"name":"holder","version":"1.0.0"}\n',
    "node_modules/holder/dist/index.mjs":
      "export const a = 1;\n//# sourceMappingURL=index.mjs.map\n",
    "node_modules/holder/dist/index.mjs.map": JSON.stringify({
      version: 3,
      sources: [
        "../src/index.ts",
        "../../../node_modules/.pnpm/exact@1.2.3/node_modules/exact/lib/a.js",
        "../../../node_modules/.pnpm/older@2.0.0_peer@1.0.0/node_modules/older/index.js",
        "../../../node_modules/.pnpm/@scope+typed@3.0.0/node_modules/@scope/typed/index.d.ts",
        "../node_modules/plain/index.js",
        "../../../node_modules/.pnpm/holder@1.0.0/node_modules/holder/src/self.ts",
        "../../../node_modules/.pnpm/absent@9.9.9/node_modules/absent/index.js",
      ],
    }),
    "node_modules/holder/dist/inline.js": `module.exports = 2;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: ["../node_modules/.pnpm/exact@1.2.3/node_modules/exact/lib/b.js"] })).toString("base64")}\n`,
    "node_modules/holder/dist/unshipped.js":
      "module.exports = 3;\n//# sourceMappingURL=unshipped.js.map\n",
    "node_modules/holder/dist/broken.js": "module.exports = 4;\n",
    "node_modules/holder/dist/broken.js.map": "{ not json",
    "store/exact@1.2.3/node_modules/exact/package.json":
      '{"name":"exact","version":"1.2.3","license":"MIT"}\n',
    "store/exact@1.2.3/node_modules/exact/LICENSE": "Exact's licence.\n",
    "store/older@1.0.0/node_modules/older/package.json":
      '{"name":"older","version":"1.0.0","license":"ISC"}\n',
    "store/older@1.0.0/node_modules/older/LICENSE": "Older 1.0.0's licence.\n",
    "store/older@1.9.0_x@1.0.0/node_modules/older/package.json":
      '{"name":"older","version":"1.9.0","license":"ISC"}\n',
    "store/older@1.9.0_x@1.0.0/node_modules/older/LICENSE":
      "Older 1.9.0's licence.\n",
    "store/plain@4.0.0/node_modules/plain/package.json":
      '{"name":"plain","version":"4.0.0","license":"MIT"}\n',
  });
  const entry = (files) =>
    new Map([
      [
        "holder@1.0.0",
        {
          key: "holder@1.0.0",
          directory: holder,
          manifest: { name: "holder", version: "1.0.0" },
          files: files.map((file) => join(holder, file)),
        },
      ],
    ]);

  test("bundledSource reads a source under node_modules as its package, and its version from the pnpm store directory just above it; none for a source under no node_modules, nor for a declaration", () => {
    assert.deepEqual(
      bundledSource(
        "../../node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.18.0/node_modules/ajv-formats/dist/index.js",
      ),
      { name: "ajv-formats", version: "3.0.1" },
    );
    assert.deepEqual(
      bundledSource(
        "../node_modules/.pnpm/@cfworker+json-schema@4.1.1/node_modules/@cfworker/json-schema/dist/esm/index.js",
      ),
      { name: "@cfworker/json-schema", version: "4.1.1" },
    );
    assert.deepEqual(bundledSource("webpack://x/./node_modules/plain/a.js"), {
      name: "plain",
      version: undefined,
    });
    assert.equal(bundledSource("../src/index.ts"), undefined);
    assert.equal(
      bundledSource("../node_modules/.pnpm/t@1.0.0/node_modules/t/index.d.ts"),
      undefined,
    );
    assert.equal(bundledSource("../node_modules/.pnpm/"), undefined);
  });

  test("sourceMapOf reads the map a file's sourceMappingURL names, a data: URL's or a file's, or <file>.map; none for a named map the package does not ship; a problem for a map that is not JSON", () => {
    assert.equal(sourceMapOf(join(holder, "dist/index.mjs")).sources.length, 7);
    assert.deepEqual(sourceMapOf(join(holder, "dist/inline.js")), {
      sources: [
        "../node_modules/.pnpm/exact@1.2.3/node_modules/exact/lib/b.js",
      ],
    });
    assert.deepEqual(sourceMapOf(join(holder, "dist/unshipped.js")), {});
    assert.match(
      sourceMapOf(join(holder, "dist/broken.js")).problem,
      /broken\.js's source map cannot be read: /u,
    );
  });

  test("enters each package a contained file's map names, but the holder's own, by itself as bundled in the holder: at the store's copy of that version, or the highest other version the store holds, named as textFrom; a problem for a package the store does not hold, and for a map that cannot be read", () => {
    const found = bundledPackages(
      entry(["dist/index.mjs", "dist/inline.js", "dist/unshipped.js"]),
      store,
    );
    assert.deepEqual(
      [...found.packages].map(([key, value]) => [
        key,
        value.manifest.version,
        value.bundledIn,
        value.textFrom,
        relative(store, value.directory),
      ]),
      [
        [
          "exact@1.2.3 (bundled in holder@1.0.0)",
          "1.2.3",
          "holder@1.0.0",
          undefined,
          "exact@1.2.3/node_modules/exact",
        ],
        [
          "older@2.0.0 (bundled in holder@1.0.0)",
          "1.9.0",
          "holder@1.0.0",
          "older@1.9.0",
          "older@1.9.0_x@1.0.0/node_modules/older",
        ],
        [
          "plain (bundled in holder@1.0.0)",
          "4.0.0",
          "holder@1.0.0",
          "plain@4.0.0",
          "plain@4.0.0/node_modules/plain",
        ],
      ],
    );
    assert.deepEqual(found.problems, [
      "dist/index.mjs of holder@1.0.0 bundles absent@9.9.9, as its source map names it, and this tree installs no absent whose licence an entry could give",
    ]);
    assert.match(
      bundledPackages(entry(["dist/broken.js"]), store).problems[0],
      /broken\.js's source map cannot be read: /u,
    );
    // thirdPartyNotices names the version whose text it gives.
    const notices = thirdPartyNotices(
      { packages: found.packages },
      { header: "H\n" },
    );
    assert.ok(
      notices.includes(
        "Package: older@2.0.0 (bundled in holder@1.0.0)\nLicense: ISC\n\n--- LICENSE, from older@1.9.0, the version of it this tree installs ---\n\nOlder 1.9.0's licence.\n",
      ),
      notices,
    );
    assert.ok(
      notices.includes(
        "Package: exact@1.2.3 (bundled in holder@1.0.0)\nLicense: MIT\n\n--- LICENSE ---\n\nExact's licence.\n",
      ),
      notices,
    );
  });
});

describe("privateModuleBuildProblems: a private module the self-host build compiled as it is (ruling 193 item 5; ruling 198 item 4)", () => {
  const root = join(scratch, "private-build");
  writeTree(root, {
    "packages/db/src/hidden.ts": 'export const kind = "private";\n',
    "packages/db/src/hidden.public.ts": 'export const kind = "public";\n',
    "packages/db/src/other.ts": "export {};\n",
    "packages/db/src/other.public.ts": "export {};\n",
  });
  const variants = {
    "packages/db/src/hidden.ts": "packages/db/src/hidden.public.ts",
    "packages/db/src/other.ts": "packages/db/src/other.public.ts",
  };
  const hidden = join(root, "packages/db/src/hidden.ts");
  // The checkout under a symbolic link, as a checkout under macOS's default
  // TMPDIR is (/var is a link to /private/var; ruling 152), whatever TMPDIR
  // this run has; and apps/web's link to db's workspace, as pnpm makes it.
  const linked = join(scratch, "private-build-linked");
  symlinkSync(root, linked);
  mkdirSync(join(root, "apps/web/node_modules/@requestport"), {
    recursive: true,
  });
  symlinkSync(
    "../../../../packages/db",
    join(root, "apps/web/node_modules/@requestport/db"),
  );
  const refused =
    "the self-host build compiled the private module packages/db/src/hidden.ts as it is, and not its public variant packages/db/src/hidden.public.ts in its place";

  test("refuses a private module the build put in a chunk and did not replace, by its path; accepts one it replaced, and one it never compiled", () => {
    assert.deepEqual(
      privateModuleBuildProblems(
        { compilers: WEB.compilers, files: [hidden], replaced: [] },
        root,
        variants,
      ),
      [
        "the self-host build compiled the private module packages/db/src/hidden.ts as it is, and not its public variant packages/db/src/hidden.public.ts in its place",
      ],
    );
    assert.deepEqual(
      privateModuleBuildProblems(
        { compilers: WEB.compilers, files: [hidden], replaced: [hidden] },
        root,
        variants,
      ),
      [],
    );
    assert.deepEqual(
      privateModuleBuildProblems(
        { compilers: WEB.compilers, files: [], replaced: [] },
        root,
        variants,
      ),
      [],
    );
  });

  test("the real map: db's three private modules, each refused when the build compiled it as it is", () => {
    const real = Object.keys(publicVariants).map((module) =>
      join(repositoryRoot, module),
    );
    assert.deepEqual(
      privateModuleBuildProblems({ files: real, replaced: [] }).map(
        (problem) => problem.split(" ")[7],
      ),
      Object.keys(publicVariants),
    );
    assert.deepEqual(
      privateModuleBuildProblems({ files: real, replaced: real }),
      [],
    );
  });

  test("reads each process's record on its own (readContained): a module that one record replaced and another put in a chunk as it is, its own replaced empty or naming nothing, is not replaced, and is refused; a module every record that holds it replaced is", () => {
    const records = join(scratch, "contained-records");
    writeTree(records, {
      "1.json": JSON.stringify({
        compilers: ["server"],
        files: [hidden],
        replaced: [hidden],
      }),
      "2.json": JSON.stringify({
        compilers: ["client", "edge-server"],
        files: [hidden],
        replaced: [],
      }),
      "3.json": JSON.stringify({ compilers: ["client"], files: [hidden] }),
    });
    const read = readContained(records);
    assert.deepEqual(read, {
      compilers: ["client", "client", "edge-server", "server"],
      files: [hidden],
      replaced: [],
    });
    assert.deepEqual(privateModuleBuildProblems(read, root, variants), [
      refused,
    ]);
    const each = join(scratch, "contained-records-each");
    writeTree(each, {
      "1.json": JSON.stringify({
        compilers: ["server"],
        files: [hidden],
        replaced: [hidden],
      }),
      "2.json": JSON.stringify({
        compilers: ["client"],
        files: [hidden],
        replaced: [hidden],
      }),
      "3.json": JSON.stringify({
        compilers: ["edge-server"],
        files: [],
        replaced: [],
      }),
    });
    assert.deepEqual(readContained(each).replaced, [hidden]);
    assert.deepEqual(
      privateModuleBuildProblems(readContained(each), root, variants),
      [],
    );
  });

  test("resolves each recorded path, and the module's, before it compares them: a private module recorded by its resolved path, through a symbolic link to its workspace (as webpack records it with resolve.symlinks off) or under a linked checkout, and not replaced, is refused; replaced under another of its paths, it is not", () => {
    const paths = [
      realpathSync(hidden),
      join(root, "apps/web/node_modules/@requestport/db/src/hidden.ts"),
      join(linked, "packages/db/src/hidden.ts"),
    ];
    for (const file of paths) {
      for (const at of [root, linked]) {
        assert.deepEqual(
          privateModuleBuildProblems(
            { files: [file], replaced: [] },
            at,
            variants,
          ),
          [refused],
          `${file}, root ${at}`,
        );
        for (const as of paths) {
          assert.deepEqual(
            privateModuleBuildProblems(
              { files: [file], replaced: [as] },
              at,
              variants,
            ),
            [],
            `${file} replaced as ${as}, root ${at}`,
          );
        }
      }
    }
    const records = join(scratch, "contained-records-aliased");
    writeTree(records, {
      "1.json": JSON.stringify({
        compilers: ["server"],
        files: [paths[1]],
        replaced: [paths[0]],
      }),
      "2.json": JSON.stringify({
        compilers: ["client"],
        files: [paths[2]],
        replaced: [],
      }),
    });
    const read = readContained(records);
    assert.deepEqual(read.replaced, []);
    assert.deepEqual(privateModuleBuildProblems(read, root, variants), [
      refused,
    ]);
  });

  test("refuses a private module one process put in chunks under two of its paths, one built as it is and one from its public variant (ruling 199 item 2): the recorder keys both by the real path, so its record does not name the module as replaced, whichever two of its paths (through apps/web's link to db, under a linked checkout, as resolved) and whichever was built as it is; it accepts the module built from its variant under both", () => {
    const paths = [
      join(root, "apps/web/node_modules/@requestport/db/src/hidden.ts"),
      join(linked, "packages/db/src/hidden.ts"),
      hidden,
      realpathSync(hidden),
    ];
    /** The record one process writes for `hidden` put in a chunk of one compilation under `asIs` and `replaced`, by the real recorder, read back. */
    const recorded = (asIs, replaced) => {
      const modules = [...asIs, ...replaced].map((resource) => ({ resource }));
      const plugin = new ContainedModulesWebpackPlugin((module) =>
        replaced.includes(module.resource),
      );
      const sealed = [];
      plugin.apply({
        hooks: {
          compilation: {
            tap: (_name, compilation) =>
              compilation({
                compiler: { name: "server" },
                modules,
                chunkGraph: { getNumberOfModuleChunks: () => 1 },
                hooks: {
                  afterSeal: { tap: (_name, sealing) => sealed.push(sealing) },
                },
              }),
          },
        },
      });
      for (const sealing of sealed) sealing();
      const records = mkdtempSync(join(scratch, "contained-records-paths-"));
      writeContainedModules(records, plugin, 1);
      return readContained(records);
    };
    for (const asIs of paths) {
      for (const replaced of paths) {
        if (asIs === replaced) continue;
        assert.deepEqual(
          privateModuleBuildProblems(
            recorded([asIs], [replaced]),
            root,
            variants,
          ),
          [refused],
          `${asIs} as it is, ${replaced} from its variant`,
        );
      }
    }
    assert.deepEqual(
      privateModuleBuildProblems(recorded([], paths), root, variants),
      [],
    );
  });
});
