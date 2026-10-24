import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

// `forbiddenModule`: a module no bundle may inline (Done when 9), from the
// forbidden-module list's one copy (ruling 151), scoped by ruling 193 item 1.
// `publicVariants`: each private module, with the public variant the bundles
// build in its place. `privateDocComments`: each doc comment of a private
// module that its variant lacks, and `holdsDocComment`, which finds one in a
// file. `testSeams`: the test seams' one list, each real module, its inert
// module and its markers (ruling 193 item 2), and `inertSeams`, the map from
// each real module to its inert module.
import {
  forbiddenModule,
  holdsDocComment,
  inertSeams,
  privateDocComments,
  publicVariants,
  testSeams,
} from "../packages/core/bundle.mjs";
// The private module no tarball may carry (ruling 183 item 9); in the public
// seed its path holds the public variant.
import * as sharedDatabases from "../packages/db/src/shared-databases.ts";
// `reusePack`: `core-tarball-smoke.mjs`'s `--from`, which re-reads a pack
// directory, each stage with no `bundledNotices`.
import { reusePack } from "./core-tarball-smoke.mjs";
import * as hostedDeployment from "./hosted-deployment.mjs";
import {
  bundledNotices,
  checkRun,
  checkTarball,
  copyMigrations,
  declarationPackages,
  dependencyVersions,
  ESBUILD_RUNTIME_HELPERS,
  esbuildHelpersIn,
  machinePaths,
  main,
  NOTICES_FILE,
  noticesNameEsbuild,
  PACKAGES,
  PRIVATE_MODULE,
  packStaged,
  pinnedPeerVersions,
  privateDigests,
  REPOSITORY_NOTICES,
  readTarball,
  readWorkspaceManifests,
  refuseChangedTree,
  repositoryRoot,
  runtimeRequires,
  stagePackage,
  unaccountedRequires,
} from "./pack-packages.mjs";

/*
 * `scripts/pack-packages.mjs` (Plan 13, G: the S8 package set and
 * Apache-2.0, ruling 175; `config`'s option (a), ruling 176; and `auth`,
 * `mcp` and `server`, ruling 190), run once through `main` into a temporary
 * directory, with the tree's status handed in as clean: the command line
 * refuses a dirty tree, and this suite must pass in one too. Nothing here
 * sends a tarball anywhere.
 *
 * The run: eleven tarballs, the eight packages of D3's set in S8's build
 * order (manifest-g.md §3.1; `bundle.mjs`'s `buildOrder`), then `auth`,
 * `mcp` and `server`, all at the one stamped version (J question 10's
 * lockstep), each `@requestport/*` dependency at it.
 *
 * Done when 9, for each tarball (`ORDER`): its `license` field and its
 * `LICENSE` file are §3.7's mapping's, the SPDX expression and the text, byte
 * for byte; its files are the allow-list derived from the build; none is a
 * test, an `.env*` file, test support or the sweep's ledger; no file inlines
 * a root's module or an env-parsing `config` module but one of its own
 * package's published modules (ruling 193 item 1), or a module of another
 * package; no file holds a test seam's marker (ruling 174; ruling 193 item
 * 2); its manifest exports its row's entries and no unpublished subpath
 * (`config`: `./logger`, `./server`, `./server-deferred` and
 * `./sign-in-methods`, never `.` or `./client`; `db`: neither `./testing`
 * nor `./e2e`; `auth`: neither `.` nor `./server`), and names no
 * `workspace:` specifier, no `@requestport/*` package its bundle does not
 * leave external, and no Better Auth (but `auth`'s, by name) or Trigger.dev
 * package; `private` stays `true` in every source manifest, and no script G
 * adds calls publish. Its packed manifest says `private: false`, names the
 * public repository with its workspace as `directory`, and names `LICENSE`
 * in `files` (J question 14's option (B), ruling 175; ruling 207 item 3),
 * and the check refuses one that does not, each planted in every tarball.
 * Every refusal G.7 planted in core's tarball is
 * planted in each of the eleven here, and reported there by name. The check
 * is shown rejecting a tarball of each package's `tsc -p tsconfig.json`
 * output that writes one, which ships its tests (Done when 9's
 * demonstration; `server`'s project sets `noEmit`).
 *
 * The run read together (`checkRun`): each package packed after every
 * `@requestport/*` package its packed manifest names, and each
 * `@requestport/*` specifier in a tarball's JavaScript or declarations a
 * subpath some packed manifest exports, `auth`'s import of `config`'s
 * `./sign-in-methods` among them; each shown refusing a plant.
 *
 * The test seams (ruling 174; ruling 193 item 2): every row builds each
 * seam's real module as its inert module, `server`'s tarball holds the CSP
 * fence's inert module and none holds a seam's marker; the check refuses
 * each marker planted in every tarball, and a pack of `server` built
 * without the replacement is refused.
 *
 * The private modules (ruling 183 item 9): no tarball of the run inlines
 * `packages/db/src/shared-databases.ts` or holds a digest it names, its
 * `kind = "private"` marker or a doc comment of it that its public variant
 * lacks, and `db`'s inlines its public variant in its place. No tarball
 * inlines `db`'s `hosted-driver.ts` or `hosted-migrator.ts`, or names the
 * hosted driver's npm packages in its manifest or any file, and `db`'s
 * JavaScript inlines their public variants (ruling 194 item 3). The check
 * refuses each private module's module comment, marker and doc comments
 * planted in every tarball, and refuses a pack of `db` built without the
 * substitution.
 *
 * esbuild's runtime helpers and the notices (ruling 209): `db`'s tarball
 * carries a `THIRD-PARTY-NOTICES`, the stage's byte for byte, which holds
 * the entries the repository's notices list as bundled in
 * `@requestport/db`, as that file holds them: esbuild's, for the runtime
 * helpers its chunk binds. No other of the eleven carries one or binds a
 * helper. The helper list is the names the runtime source in the installed
 * esbuild binary declares. The check refuses `db`'s notices missing or
 * changed, also where the stage is re-read from the pack directory as
 * `core-tarball-smoke.mjs`'s `--from` reads it, and a `THIRD-PARTY-NOTICES`
 * planted in another tarball; `checkRun` refuses each `.js`, `.cjs` or
 * `.mjs` file of a tarball that binds a helper while its notices have no
 * entry for esbuild, each planted; and `bundledNotices` refuses a tree that
 * holds the repository's notices at both of their paths or at neither.
 */

const scratch = mkdtempSync(join(tmpdir(), "pack-packages-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const VERSION = "0.0.0-pack-test.1";

/**
 * The packed `repository` of the package built from `workspace`: the public
 * repository J question 5 names (ruling 175), in ruling 207 item 3's shape.
 * Written out here, not read from the script, so that a changed URL fails.
 */
function publicRepository(workspace) {
  return {
    type: "git",
    url: "git+https://github.com/crissmoldovan/requestport.git",
    directory: workspace,
  };
}

/** The public variant the bundles build in place of `PRIVATE_MODULE`. */
const PUBLIC_VARIANT = publicVariants[PRIVATE_MODULE];

/** `db`'s hosted driver and its migrator, private modules (ruling 194 item 3). */
const HOSTED_DRIVER = "packages/db/src/hosted-driver.ts";
const HOSTED_MIGRATOR = "packages/db/src/hosted-migrator.ts";

/** Each private module, by path from the repository's root. */
const PRIVATE_MODULES = [PRIVATE_MODULE, HOSTED_DRIVER, HOSTED_MIGRATOR];

/** A private module's public variant: its `.public.ts` sibling. */
const publicOf = (module) => module.replace(/\.ts$/u, ".public.ts");

/**
 * The pack's order, by row: S8's build order (manifest-g.md §3.1, with
 * `config` among the second tier as the manifest spells it), then `auth`,
 * `mcp` and `server` (ruling 190), each after the packages it depends on.
 */
const ORDER = [
  "domain",
  "notifications",
  "webhooks",
  "importer",
  "config",
  "db",
  "jobs",
  "core",
  "auth",
  "mcp",
  "server",
];

/** `auth`, `mcp` and `server`, which ruling 190 packs beside the set, by row. */
const HOST = ["auth", "mcp", "server"];

/** The eight packages of D3's set (ruling 175), by row. */
const SET = ORDER.filter((key) => !HOST.includes(key));

/** `db`'s source scan: what `client.ts` and `migrate.ts` load at run time. */
const DB_REQUIRES = [
  { module: "packages/db/src/client.ts", specifier: "@electric-sql/pglite" },
  {
    module: "packages/db/src/client.ts",
    specifier: "@electric-sql/pglite/contrib/citext",
  },
  {
    module: "packages/db/src/client.ts",
    specifier: "drizzle-orm/node-postgres",
  },
  { module: "packages/db/src/client.ts", specifier: "drizzle-orm/pglite" },
  { module: "packages/db/src/client.ts", specifier: "pg" },
  {
    module: "packages/db/src/migrate.ts",
    specifier: "drizzle-orm/node-postgres/migrator",
  },
  {
    module: "packages/db/src/migrate.ts",
    specifier: "drizzle-orm/pglite/migrator",
  },
];

/**
 * Each row's tarball, pinned: its packed `exports` (subpath → file name in
 * `dist/`); its `dependencies`, from its JavaScript's and its declarations'
 * imports and its run-time list; its optional `peers`; the packages its
 * declarations import (`typed`); its run-time list; the workspaces whose
 * modules it inlines; and its source scan's finds. The dependencies and
 * `typed` agree, by package name, with the import lists
 * `packages/core/src/bundle.test.ts` pins for the same bundles.
 */
const PINNED = {
  domain: {
    exports: { ".": "index" },
    dependencies: ["uuid", "zod"],
    peers: [],
    typed: ["zod"],
    runtime: [],
    workspaces: ["packages/domain"],
    requires: [],
  },
  notifications: {
    exports: { ".": "index", "./view-model": "view-model", "./slack": "slack" },
    dependencies: [
      "@react-email/components",
      "@react-email/render",
      "@requestport/domain",
      "@slack/web-api",
      "react",
      "react-dom",
      "resend",
      "zod",
    ],
    peers: [],
    // React DOM, the peer through which @react-email/render renders, at the
    // version this tree installs for it (ruling 197 item 2).
    pinnedPeers: { "react-dom": "@react-email/render" },
    typed: ["@slack/web-api", "react", "resend", "zod"],
    runtime: [],
    workspaces: ["packages/notifications"],
    requires: [],
  },
  webhooks: {
    exports: { ".": "index" },
    dependencies: ["@requestport/domain", "uuid", "zod"],
    peers: [],
    typed: ["@requestport/domain"],
    runtime: [],
    workspaces: ["packages/webhooks"],
    requires: [],
  },
  importer: {
    exports: { ".": "index" },
    dependencies: [
      "@requestport/domain",
      "mdast-util-to-string",
      "remark-gfm",
      "remark-parse",
      "unified",
      "unist-util-visit",
    ],
    peers: [],
    typed: [],
    runtime: [],
    workspaces: ["packages/importer"],
    requires: [],
  },
  // Ruling 176's option (a): `./logger`; `./sign-in-methods`, which `auth`
  // imports (ruling 183 item 3); and `./server` and `./server-deferred`,
  // which `requestport` and `jobs`' `.` import (ruling 193 item 1).
  config: {
    exports: {
      "./logger": "logger",
      "./server": "server",
      "./server-deferred": "server-deferred",
      "./sign-in-methods": "sign-in-methods",
    },
    dependencies: ["zod"],
    peers: [],
    typed: ["zod"],
    runtime: [],
    workspaces: ["packages/config"],
    requires: [],
  },
  // None of `hostedDeployment.hostedDriverPackages`, which `db`'s source
  // manifest declares in this tree: its row builds `hosted-driver.ts` and
  // `hosted-migrator.ts` as their public variants (ruling 194 item 3).
  db: {
    exports: { ".": "index", "./migrate": "migrate", "./wiring": "wiring" },
    dependencies: [
      "@requestport/domain",
      "@requestport/notifications",
      "@requestport/webhooks",
      "drizzle-orm",
      "pg",
      "uuid",
    ].sort(),
    peers: ["@electric-sql/pglite"],
    typed: ["@requestport/domain", "@requestport/webhooks", "drizzle-orm"],
    runtime: ["pg"],
    workspaces: ["packages/db"],
    requires: DB_REQUIRES,
  },
  jobs: {
    exports: {
      ".": "index",
      "./catalogue": "catalogue",
      "./dispatch": "dispatch",
      "./worker": "worker",
      "./worker-storages": "worker-storages",
    },
    dependencies: [
      "@requestport/config",
      "@requestport/db",
      "@requestport/domain",
      "@requestport/importer",
      "@requestport/notifications",
      "@requestport/webhooks",
      "@slack/web-api",
      "zod",
    ],
    peers: [],
    typed: ["@requestport/config", "@requestport/db", "@slack/web-api"],
    runtime: [],
    workspaces: ["packages/jobs"],
    requires: [],
  },
  core: {
    exports: {
      ".": "index",
      "./adapters": "adapters",
      "./agent-services": "agent-services",
      "./migrate": "migrate",
    },
    dependencies: [
      "@requestport/db",
      "@requestport/domain",
      "@requestport/importer",
      "@requestport/jobs",
      "@requestport/webhooks",
      "zod",
    ],
    peers: [],
    typed: [
      "@requestport/db",
      "@requestport/domain",
      "@requestport/jobs",
      "@requestport/webhooks",
    ],
    runtime: [],
    workspaces: ["packages/core"],
    requires: [],
  },
  // `@better-auth/core` is named by the declarations alone: the third source
  // of a packed manifest's dependencies (ruling 150). Its `zod` is its own
  // manifest's, 4.5.4 (ruling 193 item 7).
  auth: {
    exports: {
      "./auth-handler": "auth-handler",
      "./create-auth": "create-auth",
    },
    dependencies: [
      "@better-auth/api-key",
      "@better-auth/cimd",
      "@better-auth/core",
      "@better-auth/oauth-provider",
      "@requestport/config",
      "@requestport/core",
      "@requestport/db",
      "@requestport/domain",
      "better-auth",
      "jose",
      "zod",
    ],
    peers: [],
    typed: [
      "@better-auth/api-key",
      "@better-auth/core",
      "@better-auth/oauth-provider",
      "@requestport/config",
      "@requestport/db",
      "@requestport/domain",
      "better-auth",
      "zod",
    ],
    runtime: [],
    workspaces: ["packages/auth"],
    requires: [],
  },
  mcp: {
    exports: { ".": "index" },
    dependencies: [
      "@modelcontextprotocol/server",
      "@requestport/auth",
      "@requestport/domain",
      "zod",
    ],
    peers: [],
    typed: [
      "@modelcontextprotocol/server",
      "@requestport/auth",
      "@requestport/domain",
    ],
    runtime: [],
    workspaces: ["packages/mcp"],
    requires: [],
  },
  server: {
    exports: { ".": "index" },
    dependencies: [
      "@requestport/auth",
      "@requestport/core",
      "@requestport/db",
      "@requestport/domain",
      "@requestport/importer",
      "@requestport/mcp",
      "zod",
    ],
    peers: [],
    typed: [
      "@requestport/auth",
      "@requestport/core",
      "@requestport/db",
      "@requestport/domain",
    ],
    runtime: [],
    workspaces: ["packages/server"],
    requires: [],
  },
};

let run;
let treeReads = 0;
const realStatus = {};

function gitStatus() {
  return spawnSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).stdout;
}

before(async () => {
  realStatus.before = gitStatus();
  run = await main(["--version", VERSION, "--out", join(scratch, "out")], {
    treeStatus: () => {
      treeReads += 1;
      return "";
    },
    log: () => {},
  });
  realStatus.after = gitStatus();
});

function readJson(path) {
  return JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"));
}

/** A source manifest's `exports`, as a map of subpaths, a string being `.`'s. */
function sourceExports(key) {
  const { exports } = readJson(`packages/${key}/package.json`);
  return typeof exports === "string" ? { ".": exports } : exports;
}

/** The one version `workspaces`' manifests declare `name` at, in `fields`. */
function declaredVersion(name, workspaces, fields = ["dependencies"]) {
  const versions = new Set(
    workspaces.flatMap((workspace) => {
      const manifest = readJson(`${workspace}/package.json`);
      return fields
        .map((field) => manifest[field]?.[name])
        .filter((version) => version !== undefined);
    }),
  );
  assert.equal(versions.size, 1, `${name}: ${[...versions]}`);
  return [...versions][0];
}

/** The run's pack of the package named `name`. */
function packOf(name) {
  const found = run.packs.filter(({ staged }) => staged.manifest.name === name);
  assert.equal(found.length, 1, name);
  return found[0];
}

/** The run's pack of the row `key`. */
function packed(key) {
  return packOf(`@requestport/${key}`);
}

/** A tarball's `package.json`, as packed. */
function packedManifest(pack) {
  return JSON.parse(pack.entries.get("package/package.json").toString("utf8"));
}

/** The tarball's entries, with its `package.json` replaced by `manifest`. */
function withManifest(entries, manifest) {
  return new Map([
    ...entries,
    ["package/package.json", Buffer.from(JSON.stringify(manifest))],
  ]);
}

/**
 * The versions `pnpm-lock.yaml` resolves `name` at: each key of its
 * `packages` section that names it.
 */
function lockfileVersions(name) {
  const lockfile = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  const packages = lockfile.slice(lockfile.indexOf("\npackages:\n"));
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  return [
    ...new Set(
      [
        ...packages.matchAll(
          new RegExp(`^  '?${escaped}@([^(:'\\s]+)['(:]?`, "gmu"),
        ),
      ].map(([, version]) => version),
    ),
  ].sort();
}

/**
 * The version a row's packed manifest names `name` at: the stamped version
 * for a package of the run, the one version the lockfile resolves for a
 * peer the row pins, and otherwise the version its workspace declares.
 */
function packedVersion(key, name, fields = ["dependencies"]) {
  if (name.startsWith("@requestport/")) return VERSION;
  if (Object.hasOwn(PINNED[key].pinnedPeers ?? {}, name)) {
    const versions = lockfileVersions(name);
    assert.equal(versions.length, 1, `${name}: ${versions}`);
    return versions[0];
  }
  return declaredVersion(name, PINNED[key].workspaces, fields);
}

/** `auth`'s own declared version of `zod`, which its packed manifest names. */
function authZod() {
  return readJson("packages/auth/package.json").dependencies.zod;
}

/** The module comments in a tarball's files: esbuild's and rolldown's. */
function moduleComments(entries) {
  const javascript = new Set();
  const declarations = new Set();
  for (const [path, body] of entries) {
    const text = body.toString("utf8");
    if (path.endsWith(".js")) {
      for (const [, module] of text.matchAll(
        /^\/\/ (\S+\.(?:ts|tsx|js|mjs))$/gmu,
      )) {
        javascript.add(module);
      }
    } else if (path.endsWith(".d.ts")) {
      for (const [, module] of text.matchAll(/^\/\/#region (\S+)$/gmu)) {
        declarations.add(module);
      }
    }
  }
  return {
    javascript: [...javascript].sort(),
    declarations: [...declarations].sort(),
  };
}

/** The first entry's JavaScript and declaration file of a row. */
function firstEntryFiles(key) {
  const { name } = PACKAGES[key].bundle.entries[0];
  return { js: `dist/${name}.js`, dts: `dist/${name}.d.ts` };
}

/**
 * What `checkTarball` must report of `file` once `text` is planted in it:
 * each path of this machine its check reads (`machinePaths(directory)`, for
 * `directory` the stage's), which `text` holds in any form a build writes,
 * named by the first form it holds in this order: as written, with JSON's
 * `\/`, as a `file://` URL's path, and percent-encoded whole. Which paths
 * those are depends on where the checkout is, so a case planting the
 * checkout's path expects them from here, not by name: the home directory
 * when the checkout is under it, and the temporary directory, as given and
 * as resolved, when it is under that (ruling 152). A path of one segment,
 * as `/tmp` is, is held as written by the JSON-escaped text of a path under
 * it: `\/private\/tmp` holds `/tmp`.
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

/**
 * The modules of `forbiddenModules` a package's own tarball holds, which no
 * other may (ruling 193 item 1), by row.
 */
const OWN_FORBIDDEN = {
  config: [
    "packages/config/src/server-deferred.ts",
    "packages/config/src/server-schema.ts",
    "packages/config/src/server.ts",
  ],
  db: ["packages/db/src/wiring.ts"],
  jobs: [
    "packages/jobs/src/cli.ts",
    "packages/jobs/src/index.ts",
    "packages/jobs/src/worker-root.ts",
  ],
};

/**
 * A root's module of another package than `key`'s, which `key`'s tarball may
 * not hold: `jobs`' worker root for `db`, and `db`'s wiring for every other
 * row.
 */
function anotherPackagesRoot(key) {
  return key === "db"
    ? "packages/jobs/src/worker-root.ts"
    : "packages/db/src/wiring.ts";
}

/**
 * A module of another package than `key`'s, which no row inlines: `domain`'s
 * barrel for `db`, and `db`'s `client.ts` for every other row.
 */
function anotherPackagesModule(key) {
  return key === "db"
    ? { module: "packages/domain/src/index", owner: "@requestport/domain" }
    : { module: "packages/db/src/client", owner: "@requestport/db" };
}

describe("the command", () => {
  test("packs eleven tarballs, the eight of D3's set in S8's build order and then auth, mcp and server, each staged in its own directory and packed outside the repository; reads the tree's status before it builds and again after it packs, and leaves the tree as it found it", () => {
    assert.deepEqual(Object.keys(PACKAGES), ORDER);
    assert.ok(relative(repositoryRoot, run.out).startsWith(".."));
    assert.deepEqual(
      run.packs.map(({ staged }) => staged.manifest.name),
      ORDER.map((key) => `@requestport/${key}`),
    );
    for (const key of ORDER) {
      const { staged, tarball } = packed(key);
      assert.equal(staged.directory, join(run.out, "stage", key), key);
      assert.equal(dirname(tarball), run.out, key);
      assert.equal(PACKAGES[key].source, `packages/${key}`, key);
      assert.equal(
        readJson(`packages/${key}/package.json`).name,
        PACKAGES[key].bundle.package,
        key,
      );
    }
    assert.equal(treeReads, 2);
    assert.equal(realStatus.after, realStatus.before);
    assert.throws(
      () => refuseChangedTree("", " M packages/core/src/index.ts\n"),
      /the tree changed while it packed/u,
    );
  });

  test("the order: each package is packed after every package its source manifest depends on through workspace:, and after every @requestport/* package its packed manifest names", () => {
    const position = new Map(ORDER.map((key, index) => [key, index]));
    for (const key of ORDER) {
      const { dependencies = {} } = readJson(`packages/${key}/package.json`);
      for (const [name, version] of Object.entries(dependencies)) {
        if (!version.startsWith("workspace:")) continue;
        const needed = name.replace(/^@requestport\//u, "");
        assert.ok(
          position.get(needed) < position.get(key),
          `${key} after ${needed}`,
        );
      }
      const manifest = packedManifest(packed(key));
      for (const name of Object.keys(manifest.dependencies)) {
        if (!name.startsWith("@requestport/")) continue;
        const needed = name.replace(/^@requestport\//u, "");
        assert.ok(
          position.get(needed) < position.get(key),
          `${key} names ${needed}`,
        );
      }
    }
  });

  test("stages each package through bundle.mjs's buildPackage, which refuses a row that inlines a module of another package", async () => {
    const webhooks = PACKAGES.webhooks;
    const row = {
      ...webhooks,
      bundle: {
        ...webhooks.bundle,
        external: webhooks.bundle.external.filter(
          (name) => name !== "@requestport/domain",
        ),
      },
    };

    await assert.rejects(
      stagePackage(row, {
        version: VERSION,
        directory: join(scratch, "inlined-sibling"),
      }),
      /@requestport\/webhooks: inlines packages\/domain\/src\/\S+, a module of @requestport\/domain/u,
    );
  });

  test("refuses a dirty tree before it builds, a version it would not stamp, an --out inside the repository, and an --out that is not empty", async () => {
    const clean = { treeStatus: () => "", log: () => {} };
    const dirty = join(scratch, "dirty");
    await assert.rejects(
      main(["--version", VERSION, "--out", dirty], {
        ...clean,
        treeStatus: () => " M packages/core/src/index.ts\n",
      }),
      /refuses a dirty tree/u,
    );
    assert.equal(existsSync(dirty), false);

    await assert.rejects(
      main(["--version", "1.0", "--out", join(scratch, "bad-version")], clean),
      /--version must be major\.minor\.patch/u,
    );

    const inside = join(repositoryRoot, "packages/core/pack-packages-test");
    await assert.rejects(
      main(["--version", VERSION, "--out", inside], clean),
      /is inside the repository/u,
    );
    assert.equal(existsSync(inside), false);

    const occupied = join(scratch, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "stray"), "");
    await assert.rejects(
      main(["--version", VERSION, "--out", occupied], clean),
      /is not empty/u,
    );
  });

  test("writes the build record: the commit, the tree's status, Node's and pnpm's versions, and each tarball's name, version, sha512 integrity, size and file count, in the order they were packed (§3.5)", () => {
    const facts = (key) => {
      const { tarball, entries } = packed(key);
      const bytes = readFileSync(tarball);
      return {
        file: `requestport-${key}-${VERSION}.tgz`,
        name: `@requestport/${key}`,
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
      tarballs: ORDER.map(facts),
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(run.out, "build-record.json"), "utf8")),
      run.record,
    );
  });
});

for (const key of ORDER) {
  describe(`${key}'s tarball (Done when 9)`, () => {
    test("holds exactly the allow-list derived from the build: package.json, LICENSE, the bundle's JavaScript and declarations directly in dist/, a .js and a .d.ts per entry, and for db each journal entry's SQL file with the journal, and THIRD-PARTY-NOTICES (ruling 209)", () => {
      const { staged, entries } = packed(key);
      const paths = [...entries.keys()]
        .map((path) => path.replace(/^package\//u, ""))
        .sort();

      assert.deepEqual(checkTarball(entries, staged), []);
      assert.deepEqual(paths, staged.allowList);
      assert.deepEqual(
        [...entries.keys()].filter((path) => !path.startsWith("package/")),
        [],
      );
      assert.ok(paths.includes("LICENSE"));
      assert.deepEqual(
        paths.filter(
          (path) =>
            path !== "package.json" &&
            path !== "LICENSE" &&
            !path.startsWith("migrations/") &&
            !/^dist\/[\w-]+\.(?:js|d\.ts)$/u.test(path),
        ),
        key === "db" ? ["THIRD-PARTY-NOTICES"] : [],
      );
      for (const name of Object.values(PINNED[key].exports)) {
        assert.ok(paths.includes(`dist/${name}.js`), name);
        assert.ok(paths.includes(`dist/${name}.d.ts`), name);
      }
      const journal = readJson("packages/db/migrations/meta/_journal.json");
      assert.deepEqual(
        paths.filter((path) => path.startsWith("migrations/")),
        key === "db"
          ? [
              ...journal.entries.map(({ tag }) => `migrations/${tag}.sql`),
              "migrations/meta/_journal.json",
            ].sort()
          : [],
      );
    });

    test("its manifest: private false (option (B)), the stamped version, the public repository with its workspace as directory, its row's entries as { types, import } and no other subpath of its source manifest, files, LICENSE among them and for db THIRD-PARTY-NOTICES (ruling 209), engines, the licence, its dependencies at the versions its workspace declares and each @requestport/* one at the stamped version, and its optional peers", () => {
      const manifest = packedManifest(packed(key));
      const pinned = PINNED[key];
      const entry = (name) => ({
        types: `./dist/${name}.d.ts`,
        import: `./dist/${name}.js`,
      });
      const peers = ["dependencies", "devDependencies", "peerDependencies"];

      assert.deepEqual(manifest, {
        name: `@requestport/${key}`,
        version: VERSION,
        private: false,
        type: "module",
        license: "Apache-2.0",
        repository: publicRepository(`packages/${key}`),
        exports: Object.fromEntries(
          Object.entries(pinned.exports).map(([subpath, name]) => [
            subpath,
            entry(name),
          ]),
        ),
        files:
          key === "db"
            ? ["LICENSE", "THIRD-PARTY-NOTICES", "dist", "migrations"]
            : ["LICENSE", "dist"],
        engines: { node: readJson("package.json").engines.node },
        dependencies: Object.fromEntries(
          pinned.dependencies.map((name) => [name, packedVersion(key, name)]),
        ),
        peerDependencies: Object.fromEntries(
          pinned.peers.map((name) => [name, packedVersion(key, name, peers)]),
        ),
        peerDependenciesMeta: Object.fromEntries(
          pinned.peers.map((name) => [name, { optional: true }]),
        ),
      });
      // Of the source manifest's subpaths, the packed one drops exactly its
      // row's `unpublished`, and keeps every entry at the source it names.
      const source = sourceExports(key);
      assert.deepEqual(
        Object.keys(source)
          .filter((subpath) => !(subpath in manifest.exports))
          .sort(),
        [...PACKAGES[key].unpublished].sort(),
      );
      for (const { subpath, source: module } of PACKAGES[key].bundle.entries) {
        assert.equal(join(`packages/${key}`, source[subpath]), module, subpath);
        assert.equal(PACKAGES[key].unpublished.includes(subpath), false);
      }
      assert.equal("bin" in manifest, false);
    });

    test("its dependencies come from four sources: the bundle's externals, the run-time list, the declarations' bare imports, which name none of pg's, PGlite's or the hosted driver's types, and the peers its row pins (ruling 197 item 2)", async () => {
      const { staged } = packed(key);
      const manifest = packedManifest(packed(key));
      const typed = await declarationPackages(
        join(staged.directory, "dist"),
        staged.allowList
          .filter((file) => file.endsWith(".d.ts"))
          .map((file) => file.replace(/^dist\//u, "")),
      );

      assert.deepEqual(typed, PINNED[key].typed);
      assert.deepEqual(PACKAGES[key].runtime, PINNED[key].runtime);
      assert.deepEqual(
        PACKAGES[key].pinnedPeers,
        PINNED[key].pinnedPeers ?? {},
      );
      assert.deepEqual(
        [
          ...new Set([
            ...staged.external,
            ...PACKAGES[key].runtime,
            ...typed,
            ...Object.keys(PACKAGES[key].pinnedPeers),
          ]),
        ].sort(),
        Object.keys(manifest.dependencies),
      );
      assert.deepEqual(
        typed.filter((name) =>
          [
            "pg",
            "@types/pg",
            "@electric-sql/pglite",
            ...hostedDeployment.hostedDriverPackages,
          ].includes(name),
        ),
        [],
      );
    });

    test("its module comments name only its own modules, or those its row inlines, by repository paths, and none on the forbidden-module list but its own package's published modules, which its JavaScript holds (ruling 193 item 1); its source scan finds what its run-time list and optional peers provide", () => {
      const { staged, entries } = packed(key);
      const { javascript, declarations } = moduleComments(entries);
      const own = (module) =>
        module.startsWith(`packages/${key}/src/`) ||
        PACKAGES[key].bundle.inlines.some(
          (inlined) =>
            inlined.replace(/\.tsx?$/u, "") ===
            module.replace(/(?:\.d)?\.tsx?$/u, ""),
        );

      // The detector has something to read: esbuild names each module.
      assert.ok(javascript.length > 0, `${javascript.length} module comments`);
      assert.ok(declarations.length > 0, `${declarations.length} regions`);
      assert.deepEqual(
        javascript.filter((module) => !own(module)),
        [],
      );
      assert.deepEqual(
        declarations.filter((module) => !own(module)),
        [],
      );
      const packedName = `@requestport/${key}`;
      assert.deepEqual(
        javascript.filter((module) => forbiddenModule(module, packedName)),
        [],
      );
      assert.deepEqual(
        declarations.filter((module) =>
          forbiddenModule(module.replace(/\.d\.ts$/u, ".ts"), packedName),
        ),
        [],
      );
      assert.deepEqual(
        javascript.filter((module) => forbiddenModule(module)),
        OWN_FORBIDDEN[key] ?? [],
      );
      assert.deepEqual(
        [
          ...new Set(
            staged.inputs.map((input) => input.split("/", 2).join("/")),
          ),
        ].sort(),
        PINNED[key].workspaces,
      );
      assert.deepEqual(staged.requires, PINNED[key].requires);
      assert.deepEqual(
        unaccountedRequires(staged.requires, {
          external: staged.external,
          runtime: PACKAGES[key].runtime,
          optionalPeers: PACKAGES[key].optionalPeers,
        }),
        [],
      );
    });

    test("the check refuses, planted in its real tarball, a file off the allow-list or missing from it, a file outside package/, a test, an .env file, a source map, test support, the sweep's ledger, the E2E owner storage, a path of this machine, and a module comment naming another package's root module, db's test support module, test support, a path outside the repository or a module of another package", () => {
      const { staged, entries } = packed(key);
      const { js, dts } = firstEntryFiles(key);
      const other = anotherPackagesModule(key);
      const root = anotherPackagesRoot(key);
      const planted = new Map(entries);
      const empty = Buffer.from("");
      for (const path of [
        "other/file",
        "package/dist/extra.js",
        "package/dist/index.test.js",
        "package/.env.local",
        "package/dist/index.js.map",
        "package/dist/test-support/fixture.js",
        "package/dist/tenant-scope-sweep.exceptions.js",
      ]) {
        planted.set(path, empty);
      }
      planted.delete("package/LICENSE");
      if (key === "db") planted.delete("package/migrations/meta/_journal.json");
      const append = (path, text) =>
        planted.set(
          `package/${path}`,
          Buffer.concat([entries.get(`package/${path}`), Buffer.from(text)]),
        );
      const plantedJs = [
        "",
        `// ${root}`,
        "// packages/db/src/testing.ts",
        "// ../../outside.ts",
        `// ${other.module}.ts`,
        `const at = "${repositoryRoot}";`,
        'throw new Error("The E2E owner storage is never built on Vercel");',
        "",
      ].join("\n");
      append(js, plantedJs);
      // The checkout's path as written, and each other path of this machine
      // it holds, wherever the checkout is (heldMachinePaths).
      const held = heldMachinePaths(js, plantedJs, staged.directory);
      assert.ok(held.includes(`${js} holds ${repositoryRoot}`));
      append(
        dts,
        [
          "",
          "//#region /absolute/path.d.ts",
          "//#region packages/db/src/test-support/fixture.d.ts",
          `//#region ${other.module}.d.ts`,
          "",
        ].join("\n"),
      );

      assert.deepEqual(
        checkTarball(planted, staged).sort(),
        [
          ".env.local is an environment file",
          ".env.local is not on the allow-list",
          "LICENSE is missing: the mapping names licenses/Apache-2.0.txt",
          "LICENSE is on the allow-list but not in the tarball",
          "dist/extra.js is not on the allow-list",
          `${dts} inlines packages/db/src/test-support/fixture.d.ts`,
          `${dts} inlines ${other.module}.d.ts, a module of ${other.owner}`,
          `${dts} names a module outside the repository: /absolute/path.d.ts`,
          `${js} holds the E2E owner storage`,
          ...held,
          `${js} inlines ${other.module}.ts, a module of ${other.owner}`,
          `${js} inlines ${root}`,
          `${js} inlines packages/db/src/testing.ts`,
          `${js} names a module outside the repository: ../../outside.ts`,
          "dist/index.js.map is a source map",
          "dist/index.js.map is not on the allow-list",
          "dist/index.test.js is a test",
          "dist/index.test.js is not on the allow-list",
          "dist/tenant-scope-sweep.exceptions.js is not on the allow-list",
          "dist/tenant-scope-sweep.exceptions.js is the sweep's ledger",
          "dist/test-support/fixture.js is not on the allow-list",
          "dist/test-support/fixture.js is test support",
          ...(key === "db"
            ? [
                "migrations/meta/_journal.json is on the allow-list but not in the tarball",
              ]
            : []),
          "other/file is outside package/",
        ].sort(),
      );
    });

    test("the check refuses, planted in its real tarball, this machine's paths in each form a build writes but as written (JSON-escaped in the JavaScript, percent-encoded whole in the declarations), and a workspace: specifier in a file other than package.json, as pnpm writes one and in its alias form (rulings 110, 145, 170 and 197 item 3)", () => {
      const { staged, entries } = packed(key);
      const { js, dts } = firstEntryFiles(key);
      const json = (path) => path.replaceAll("/", "\\/");
      const percent = (path) => encodeURIComponent(path);
      const planted = new Map(entries);
      const append = (path, text) =>
        planted.set(
          `package/${path}`,
          Buffer.concat([entries.get(`package/${path}`), Buffer.from(text)]),
        );
      append(
        js,
        `\nconst at = "${json(repositoryRoot)}";\nconst spec = "workspace:^";\n`,
      );
      append(
        dts,
        `\n// ${percent(repositoryRoot)}\n// "workspace:@requestport/core@*"\n`,
      );
      // Each path of this machine a plant holds, the checkout's among them,
      // wherever the checkout is (heldMachinePaths).
      const held = [
        ...heldMachinePaths(js, json(repositoryRoot), staged.directory),
        ...heldMachinePaths(dts, percent(repositoryRoot), staged.directory),
      ];
      assert.ok(
        held.includes(
          `${js} holds ${repositoryRoot}, as ${json(repositoryRoot)}`,
        ),
      );
      assert.ok(
        held.includes(
          `${dts} holds ${repositoryRoot}, as ${percent(repositoryRoot)}`,
        ),
      );

      assert.deepEqual(
        checkTarball(planted, staged).sort(),
        [
          ...held,
          `${js} holds a workspace: specifier`,
          `${dts} holds a workspace: specifier`,
        ].sort(),
      );
    });

    test("the check refuses, planted in its real tarball, a module comment naming each private module of publicVariants, db's shared-databases.ts, hosted-driver.ts and hosted-migrator.ts, in the JavaScript and the declarations, the kind marker each assigns, each digest shared-databases.ts names, in either, and each module's doc comments that its public variant lacks, re-indented in the declarations (ruling 183 item 9; ruling 194 item 3)", () => {
      const { staged, entries } = packed(key);
      const { js, dts } = firstEntryFiles(key);
      const digests = privateDigests();
      const modules = PRIVATE_MODULES;
      const declaration = (module) => module.replace(/\.ts$/u, ".d.ts");
      // This tree's private module names production's host, and staging's
      // host and database name; the public variant the seed carries at its
      // path names none.
      assert.equal(digests.length, sharedDatabases.kind === "private" ? 3 : 0);
      // Each module's doc comments that its variant does not hold; none in
      // the seed, where each module's path holds its variant.
      const docComments = privateDocComments();
      const counts = {};
      for (const { module } of docComments) {
        counts[module] = (counts[module] ?? 0) + 1;
      }
      assert.deepEqual(
        counts,
        sharedDatabases.kind === "private"
          ? {
              "packages/db/src/shared-databases.ts": 2,
              "packages/db/src/hosted-driver.ts": 17,
              "packages/db/src/hosted-migrator.ts": 3,
            }
          : {},
      );
      const planted = new Map(entries);
      const append = (path, lines) =>
        planted.set(
          `package/${path}`,
          Buffer.concat([
            entries.get(`package/${path}`),
            Buffer.from(["", ...lines, ""].join("\n")),
          ]),
        );
      append(js, [
        ...modules.map((module) => `// ${module}`),
        'var kind = "private";',
        ...digests.map(({ digest }, at) => `var planted${at} = "${digest}";`),
      ]);
      append(dts, [
        ...modules.map((module) => `//#region ${declaration(module)}`),
        ...digests.map(
          ({ digest }, at) => `declare const planted${at}: "${digest}";`,
        ),
        // As a bundle would hold them inside a namespace.
        ...docComments.flatMap(({ comment }) =>
          comment.split("\n").map((line) => `  ${line}`),
        ),
      ]);

      assert.deepEqual(
        checkTarball(planted, staged).sort(),
        [
          ...modules.flatMap((module) => [
            `${js} inlines the private module ${module}, not its public variant ${publicOf(module)}`,
            `${dts} inlines the private module ${declaration(module)}, not its public variant ${publicOf(module)}`,
          ]),
          `${js} holds a private module's kind = "private" marker`,
          ...digests.flatMap(({ label }) => [
            `${js} holds ${label} from ${PRIVATE_MODULE}`,
            `${dts} holds ${label} from ${PRIVATE_MODULE}`,
          ]),
          ...Object.keys(counts).map(
            (module) =>
              `${dts} holds a doc comment of the private module ${module} that its public variant ${publicOf(module)} lacks`,
          ),
          // In this tree `hosted-driver.ts`'s doc comment of `applyLocalProxy`
          // names the E2E owner storage, which the check refuses in any file.
          ...(docComments.some(({ comment }) =>
            comment.includes("E2E owner storage"),
          )
            ? [`${dts} holds the E2E owner storage`]
            : []),
        ].sort(),
      );
      // The real tarball, as packed, holds none of them.
      assert.deepEqual(checkTarball(entries, staged), []);
    });

    test("the check refuses, planted in its real tarball, each test seam's every marker, in the JavaScript and the declarations, naming the seam and the marker, and a module comment or //#region naming a seam's real module, naming its inert module (ruling 174; ruling 193 item 2)", () => {
      const { staged, entries } = packed(key);
      const { js, dts } = firstEntryFiles(key);
      const markers = testSeams.flatMap((seam) =>
        seam.markers.map((marker) => ({ seam, marker })),
      );
      // Each seam has at least its real module's path.
      assert.equal(testSeams.length, 3);
      for (const seam of testSeams) assert.ok(seam.markers.includes(seam.real));
      const planted = new Map(entries);
      for (const path of [js, dts]) {
        planted.set(
          `package/${path}`,
          Buffer.concat([
            entries.get(`package/${path}`),
            Buffer.from(
              [
                "",
                ...markers.map(({ marker }) => `// ${marker}`),
                ...(path === dts
                  ? testSeams.map(
                      ({ real }) =>
                        `//#region ${real.replace(/\.ts$/u, ".d.ts")}`,
                    )
                  : []),
                "",
              ].join("\n"),
            ),
          ]),
        );
      }

      const problems = checkTarball(planted, staged);
      // Each seam's real module's path is its first marker, so the
      // JavaScript's `// <path>` line is a module comment too.
      assert.deepEqual(
        problems.filter((problem) => problem.includes(" test seam's ")).sort(),
        [
          ...testSeams.map(
            ({ real, inert }) =>
              `${js} inlines the test seam's real module ${real}, not its inert module ${inert}`,
          ),
          ...testSeams.map(
            ({ real, inert }) =>
              `${dts} inlines the test seam's real module ${real.replace(/\.ts$/u, ".d.ts")}, not its inert module ${inert}`,
          ),
        ].sort(),
      );
      assert.deepEqual(
        problems.filter((problem) => / holds .+ \(.+\)$/u.test(problem)).sort(),
        [js, dts]
          .flatMap((path) =>
            markers.map(
              ({ seam, marker }) => `${path} holds ${seam.name} (${marker})`,
            ),
          )
          .sort(),
      );
      assert.deepEqual(checkTarball(entries, staged), []);
    });

    test("the check refuses, planted in its real tarball's manifest, a manifest that does not say private: false, a repository other than the public repository with its workspace as directory, files that do not name LICENSE, each of the three also when the manifest the script wrote holds the same plant, a workspace: specifier, a @requestport/* package its bundle does not leave external (@requestport/auth, but in mcp's and server's, which leave it external), Better Auth (but in auth's, by name) and Trigger.dev, scripts and bin, and an unpublished or unbuilt subpath", () => {
      const { staged, entries } = packed(key);
      const manifest = packedManifest(packed(key));
      const subpath = PACKAGES[key].unpublished[0] ?? "./planted";
      const planted = {
        ...manifest,
        private: true,
        repository: {
          type: "git",
          url: "git+https://example.com/planted.git",
          directory: `packages/${key}`,
        },
        files: manifest.files.filter((file) => file !== "LICENSE"),
        scripts: { postinstall: "node dist/index.js" },
        bin: { requestport: "./dist/index.js" },
        exports: {
          ...manifest.exports,
          [subpath]: {
            types: "./dist/planted.d.ts",
            import: "./dist/planted.js",
          },
        },
        dependencies: {
          ...manifest.dependencies,
          "@requestport/auth": "workspace:*",
          "@trigger.dev/sdk": "4.0.0",
          "better-auth": "1.7.6",
        },
      };
      const subpaths = PACKAGES[key].bundle.entries
        .map((entry) => entry.subpath)
        .sort();

      assert.deepEqual(
        checkTarball(withManifest(entries, planted), staged).sort(),
        [
          "package.json holds a workspace: specifier",
          "package.json's private is true, not false",
          `package.json's repository is ${JSON.stringify(planted.repository)}, not ${JSON.stringify(staged.manifest.repository)}`,
          `package.json's files is ${JSON.stringify(planted.files)}, not ${JSON.stringify(staged.manifest.files)}`,
          `package.json's dependencies is ${JSON.stringify(planted.dependencies)}, not ${JSON.stringify(staged.manifest.dependencies)}`,
          "package.json does not say private: false",
          `package.json's repository is ${JSON.stringify(planted.repository)}, not the public repository's ${JSON.stringify(publicRepository(`packages/${key}`))}`,
          "package.json's files does not name LICENSE",
          "package.json has scripts",
          "package.json has bin",
          ...(PACKAGES[key].bundle.external.includes("@requestport/auth")
            ? []
            : ["package.json's dependencies names @requestport/auth"]),
          "package.json's dependencies names @trigger.dev/sdk",
          ...(key === "auth"
            ? []
            : ["package.json's dependencies names better-auth"]),
          `package.json exports ${JSON.stringify([...subpaths, subpath].sort())}, not the bundle's entries ${JSON.stringify(subpaths)}`,
          ...(PACKAGES[key].unpublished.length > 0
            ? [`package.json exports ${subpath}, which is not published`]
            : []),
          `package.json's ${subpath} has no types target in the tarball ("./dist/planted.d.ts")`,
          `package.json's ${subpath} has no import target in the tarball ("./dist/planted.js")`,
        ].sort(),
      );
      // The three are refused from the tarball's manifest alone: with the
      // manifest the script wrote holding the same plant, no written field
      // differs, and each is still reported.
      const release = {
        ...manifest,
        private: planted.private,
        repository: planted.repository,
        files: planted.files,
      };
      assert.deepEqual(
        checkTarball(withManifest(entries, release), {
          ...staged,
          manifest: release,
        }).sort(),
        [
          "package.json does not say private: false",
          `package.json's repository is ${JSON.stringify(planted.repository)}, not the public repository's ${JSON.stringify(publicRepository(`packages/${key}`))}`,
          "package.json's files does not name LICENSE",
        ].sort(),
      );
      // Not only `true`: a manifest that leaves `private` out, or gives it
      // as the string "false", does not say private: false either, and is
      // refused the same way, from the tarball's manifest alone.
      const leftOut = { ...manifest };
      delete leftOut.private;
      for (const unsaid of [leftOut, { ...manifest, private: "false" }]) {
        assert.deepEqual(
          checkTarball(withManifest(entries, unsaid), {
            ...staged,
            manifest: unsaid,
          }),
          ["package.json does not say private: false"],
          `private ${JSON.stringify(unsaid.private)}`,
        );
      }
    });

    test("the check compares every field of the manifest the script wrote with the tarball's: a plant in each of the eleven is reported by name", () => {
      const { staged, entries } = packed(key);
      const manifest = packedManifest(packed(key));
      const changed = {
        name: "@requestport/planted",
        version: "9.9.9-planted",
        private: !manifest.private,
        type: manifest.type === "module" ? "commonjs" : "module",
        license: "MIT",
        repository: { ...manifest.repository, directory: "planted" },
        files: [...manifest.files, "src"],
        engines: { node: ">=1" },
        dependencies: { ...manifest.dependencies, planted: "1.0.0" },
        peerDependencies: { ...manifest.peerDependencies, planted: "1.0.0" },
        peerDependenciesMeta: {
          ...manifest.peerDependenciesMeta,
          planted: { optional: true },
        },
      };

      for (const [field, value] of Object.entries(changed)) {
        assert.notDeepEqual(value, staged.manifest[field], field);
        const problems = checkTarball(
          withManifest(entries, { ...manifest, [field]: value }),
          staged,
        );
        assert.ok(
          problems.includes(
            `package.json's ${field} is ${JSON.stringify(value)}, not ${JSON.stringify(staged.manifest[field])}`,
          ),
          `a planted ${field} is reported: ${JSON.stringify(problems)}`,
        );
      }
    });

    test("its LICENSE is the mapping's text, byte for byte, and its license field the mapping's SPDX expression, Apache-2.0; the check refuses a tarball with no LICENSE, one with other words, and a license field other than the mapping's", () => {
      const { staged, entries } = packed(key);
      const { license, licenseText } = PACKAGES[key];
      const without = new Map(entries);
      without.delete("package/LICENSE");
      const reworded = new Map(entries).set(
        "package/LICENSE",
        Buffer.from("MIT License\n"),
      );
      const relicensed = withManifest(entries, {
        ...packedManifest(packed(key)),
        license: "MIT",
      });

      assert.deepEqual(
        { license, licenseText },
        { license: "Apache-2.0", licenseText: "licenses/Apache-2.0.txt" },
      );
      assert.ok(staged.allowList.includes("LICENSE"));
      assert.deepEqual(
        entries.get("package/LICENSE"),
        readFileSync(join(repositoryRoot, licenseText)),
      );
      assert.equal(packedManifest(packed(key)).license, license);
      assert.deepEqual(checkTarball(without, staged), [
        "LICENSE is on the allow-list but not in the tarball",
        "LICENSE is missing: the mapping names licenses/Apache-2.0.txt",
      ]);
      assert.deepEqual(checkTarball(reworded, staged), [
        "LICENSE is not licenses/Apache-2.0.txt, byte for byte",
      ]);
      assert.deepEqual(checkTarball(relicensed, staged), [
        "package.json's license is MIT, not the mapping's Apache-2.0",
        'package.json\'s license is "MIT", not "Apache-2.0"',
      ]);
    });
  });
}

describe("React (ruling 197 item 2)", () => {
  test("the lockfile resolves one react and one react-dom, and each packed manifest that names either names that version: notifications declares react and pins react-dom, the peer through which @react-email/render renders, which this tree installs at that version, so that npm installs one copy of each beside it", () => {
    const [react, ...otherReacts] = lockfileVersions("react");
    const [reactDom, ...otherReactDoms] = lockfileVersions("react-dom");
    assert.deepEqual([otherReacts, otherReactDoms], [[], []]);
    assert.ok(react !== undefined && reactDom !== undefined);
    assert.equal(reactDom, react);
    const naming = run.packs
      .map((pack) => packedManifest(pack))
      .filter(({ dependencies = {} }) =>
        ["react", "react-dom"].some((name) =>
          Object.hasOwn(dependencies, name),
        ),
      );
    assert.deepEqual(
      naming.map(({ name, dependencies }) => [
        name,
        dependencies.react,
        dependencies["react-dom"],
      ]),
      [["@requestport/notifications", react, reactDom]],
    );
    const render = JSON.parse(
      readFileSync(
        join(
          repositoryRoot,
          "packages/notifications/node_modules/@react-email/render/package.json",
        ),
        "utf8",
      ),
    );
    assert.ok(Object.hasOwn(render.peerDependencies, "react-dom"));
    assert.equal(
      JSON.parse(
        readFileSync(
          join(
            realpathSync(
              join(
                repositoryRoot,
                "packages/notifications/node_modules/@react-email/render",
              ),
            ),
            "../../react-dom/package.json",
          ),
          "utf8",
        ),
      ).version,
      reactDom,
    );
  });

  test("the stage refuses a pinned peer whose dependency the packed manifest does not name, that names no such peer, or that the tree does not install", () => {
    const pack = { ...PACKAGES.notifications };
    assert.deepEqual(
      pinnedPeerVersions(
        { ...pack, pinnedPeers: { "react-dom": "@react-email/render" } },
        { "@react-email/render": "2.1.0" },
      ),
      {
        dependencies: { "react-dom": lockfileVersions("react-dom")[0] },
        problems: [],
      },
    );
    assert.deepEqual(
      pinnedPeerVersions(
        { ...pack, pinnedPeers: { "react-dom": "@react-email/render" } },
        {},
      ).problems,
      [
        "react-dom is pinned as @react-email/render's peer, and packages/notifications's packed manifest does not depend on @react-email/render",
      ],
    );
    assert.match(
      pinnedPeerVersions(
        { ...pack, pinnedPeers: { zod: "@react-email/render" } },
        { "@react-email/render": "2.1.0" },
      ).problems.join("\n"),
      /^zod is pinned as @react-email\/render's peer, and @react-email\/render@\S+ names no such peer$/u,
    );
    assert.deepEqual(
      pinnedPeerVersions(
        { ...pack, pinnedPeers: { "react-dom": "left-pad" } },
        { "left-pad": "1.3.0" },
      ).problems,
      ["left-pad is not installed for packages/notifications"],
    );
  });
});

/**
 * `config`'s subpaths: option (a) (ruling 176; manifest-g.md §3.1) published
 * its import-safe subpaths only, `./logger`, and `./redaction` and
 * `./sign-in-methods` only if a published package needs them. `auth`'s
 * `./create-auth` imports `./sign-in-methods` (ruling 183 item 3), and no
 * published entry imports `./redaction`. Ruling 193 item 1 publishes
 * `./server`, which `requestport` imports and which parses `process.env` as
 * it is imported, and `./server-deferred`, which `jobs`' `.` imports. Never
 * `.` or `./client`, which parse `process.env` at import (§1.6) and which no
 * published entry imports. The subpaths are written out here rather than
 * read from `PACKAGES`, so a row that came to publish one of them fails this
 * case whatever the row says.
 */
describe("config's subpaths (rulings 176, 183 and 193)", () => {
  test("config's packed manifest exports ./logger, ./server, ./server-deferred and ./sign-in-methods: not . or ./client, which parse process.env at import, nor ./redaction, which no published entry imports; and the check refuses each planted in config's real tarball, by name", () => {
    const { staged, entries } = packed("config");
    const manifest = packedManifest(packed("config"));
    const published = [
      "./logger",
      "./server",
      "./server-deferred",
      "./sign-in-methods",
    ];
    const refused = [".", "./client", "./redaction"];

    assert.deepEqual(Object.keys(manifest.exports), published);
    // Each is a subpath of config's source manifest, so each plant is one a
    // build of a row naming it would write.
    assert.deepEqual(
      Object.keys(sourceExports("config"))
        .filter((subpath) => !published.includes(subpath))
        .sort(),
      [...refused].sort(),
    );
    for (const subpath of refused) {
      const exported = [...published, subpath].sort();
      // The planted subpath points at `./logger`'s files, which the tarball
      // holds, so only the subpath itself can be refused.
      const planted = {
        ...manifest,
        exports: {
          ...manifest.exports,
          [subpath]: manifest.exports["./logger"],
        },
      };
      assert.deepEqual(
        checkTarball(withManifest(entries, planted), staged),
        [
          `package.json exports ${JSON.stringify(exported)}, not the bundle's entries ${JSON.stringify(published)}`,
          `package.json exports ${subpath}, which is not published`,
        ],
        subpath,
      );
    }
  });
});

/*
 * The private modules, each of which every row of `bundle.mjs`'s `bundles`
 * builds as its public variant, in its JavaScript and its declarations:
 * - `packages/db/src/shared-databases.ts` (ruling 183 item 9; J.2's option
 *   (d)), which `db`'s `database-url.ts` imports. In this tree it names
 *   production's and staging's databases by digest; the seed carries the
 *   public variant, which names none, at its path;
 * - `packages/db/src/hosted-driver.ts`, the hosted driver, which
 *   `client.ts`, `migrate.ts` and other modules of `db` import, and
 *   `packages/db/src/hosted-migrator.ts`, its migrator, which `migrate.ts`
 *   imports (J.2b; ruling 194 item 3). Their variants have no hosted driver,
 *   so no tarball reaches the driver's npm packages.
 * The check refuses a tarball whose JavaScript names one in a module
 * comment, or whose declarations name one in a `//#region`, or that holds,
 * in any file, a digest `shared-databases.ts` names, a `kind = "private"`
 * marker, or a doc comment of one that its variant lacks: rolldown gives a
 * module that a declaration imports as a namespace no region of its own
 * (core's `bundle.test.ts`), so its doc comments are what a declaration that
 * inlines it shows. The second and third cases read the run's tarballs on
 * their own, not through `checkTarball`; the fourth shows `checkTarball`
 * refusing a pack of `db` built without the substitution, whose JavaScript
 * inlines all three modules and whose declarations inline `hosted-driver.ts`
 * (no declaration of `db`'s entries imports the other two).
 */
describe("the private modules (ruling 183 item 9; ruling 194 item 3)", () => {
  test("are the three bundle.mjs's publicVariants names, each with its .public.ts variant: db's shared-databases.ts, the path the pack reads its digests from, hosted-driver.ts and hosted-migrator.ts; every row the pack builds names that map", () => {
    assert.deepEqual(publicVariants, {
      [PRIVATE_MODULE]: "packages/db/src/shared-databases.public.ts",
      [HOSTED_DRIVER]: "packages/db/src/hosted-driver.public.ts",
      [HOSTED_MIGRATOR]: "packages/db/src/hosted-migrator.public.ts",
    });
    assert.deepEqual(
      Object.fromEntries(
        PRIVATE_MODULES.map((module) => [module, publicOf(module)]),
      ),
      publicVariants,
    );
    assert.equal(PRIVATE_MODULE, "packages/db/src/shared-databases.ts");
    assert.equal(PUBLIC_VARIANT, "packages/db/src/shared-databases.public.ts");
    for (const key of ORDER) {
      assert.equal(PACKAGES[key].bundle.publicVariants, publicVariants, key);
    }
  });

  test("no tarball of the run inlines shared-databases.ts or holds a digest it names, and none holds a kind marker or a doc comment of a private module that its public variant lacks; db's inlines shared-databases.public.ts in its place", () => {
    for (const key of ORDER) {
      const { entries } = packed(key);
      const { javascript, declarations } = moduleComments(entries);
      assert.deepEqual(
        [...javascript, ...declarations].filter((module) =>
          module.includes("shared-databases"),
        ),
        key === "db" ? [PUBLIC_VARIANT] : [],
        key,
      );
      for (const [path, body] of entries) {
        const text = body.toString("utf8");
        for (const { label, digest } of privateDigests()) {
          assert.equal(
            text.includes(digest),
            false,
            `${key} ${path}: ${label}`,
          );
        }
        assert.doesNotMatch(text, /\bkind\w*\s*=\s*["'`]private["'`]/u, path);
        for (const { comment } of privateDocComments()) {
          assert.equal(holdsDocComment(text, comment), false, path);
        }
      }
    }
  });

  test("no tarball of the run names the hosted driver's npm packages, in its manifest or in any file, or inlines hosted-driver.ts or hosted-migrator.ts: db's JavaScript inlines both public variants in their place, and its declarations hosted-driver.public.ts's (ruling 194 item 3)", () => {
    const fields = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
    ];
    const hosted = (module) =>
      /^packages\/db\/src\/hosted-(?:driver|migrator)\b/u.test(module);
    const found = {};
    for (const key of ORDER) {
      const { entries } = packed(key);
      const manifest = packedManifest(packed(key));
      const { javascript, declarations } = moduleComments(entries);
      found[key] = {
        manifest: fields.flatMap((field) =>
          Object.keys(manifest[field] ?? {})
            .filter((name) =>
              hostedDeployment.hostedDriverPackages.includes(name),
            )
            .map((name) => `${field}: ${name}`),
        ),
        files: [...entries].flatMap(([path, body]) =>
          hostedDeployment.hostedDriverPackages
            .filter((name) => body.toString("utf8").includes(name))
            .map((name) => `${path}: ${name}`),
        ),
        javascript: javascript.filter(hosted),
        declarations: declarations.filter(hosted),
      };
    }

    assert.deepEqual(
      found,
      Object.fromEntries(
        ORDER.map((key) => [
          key,
          {
            manifest: [],
            files: [],
            javascript:
              key === "db"
                ? [publicOf(HOSTED_DRIVER), publicOf(HOSTED_MIGRATOR)]
                : [],
            declarations:
              key === "db"
                ? [publicOf(HOSTED_DRIVER).replace(/\.ts$/u, ".d.ts")]
                : [],
          },
        ]),
      ),
    );
  });

  test("a pack of db built without the substitution is refused: its JavaScript inlines each private module, its declarations hosted-driver.ts, and in this tree it holds a kind marker, each digest shared-databases.ts names and hosted-driver.ts's doc comments", async () => {
    const db = PACKAGES.db;
    const row = { ...db, bundle: { ...db.bundle, publicVariants: {} } };
    const out = join(scratch, "without-public-variants");
    const staged = await stagePackage(row, {
      version: VERSION,
      directory: join(out, "stage", "db"),
    });
    const entries = readTarball(packStaged(staged.directory, out));
    const holding = (line) =>
      [...entries]
        .filter(([, body]) => body.toString("utf8").includes(`\n${line}\n`))
        .map(([path]) => path.slice("package/".length));
    const declaration = (module) => module.replace(/\.ts$/u, ".d.ts");
    const holders = Object.fromEntries(
      PRIVATE_MODULES.map((module) => [
        module,
        {
          javascript: holding(`// ${module}`),
          declarations: holding(`//#region ${declaration(module)}`),
        },
      ]),
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(holders).map(
          ([module, { javascript, declarations }]) => [
            module,
            {
              javascript: javascript.length,
              declarations: declarations.length,
            },
          ],
        ),
      ),
      {
        [PRIVATE_MODULE]: { javascript: 1, declarations: 0 },
        [HOSTED_DRIVER]: { javascript: 1, declarations: 1 },
        [HOSTED_MIGRATOR]: { javascript: 1, declarations: 0 },
      },
      JSON.stringify(holders),
    );
    const [chunk] = holders[PRIVATE_MODULE].javascript;
    const [driverChunk] = holders[HOSTED_DRIVER].javascript;
    const [driverDeclarations] = holders[HOSTED_DRIVER].declarations;
    const [migrator] = holders[HOSTED_MIGRATOR].javascript;
    // In the public seed each module's path holds its variant: no marker, no
    // digest and no doc comment the variant lacks.
    const privateTree = sharedDatabases.kind === "private";
    assert.deepEqual(
      checkTarball(entries, staged).sort(),
      [
        `${chunk} inlines the private module ${PRIVATE_MODULE}, not its public variant ${PUBLIC_VARIANT}`,
        `${driverChunk} inlines the private module ${HOSTED_DRIVER}, not its public variant ${publicOf(HOSTED_DRIVER)}`,
        `${driverDeclarations} inlines the private module ${declaration(HOSTED_DRIVER)}, not its public variant ${publicOf(HOSTED_DRIVER)}`,
        `${migrator} inlines the private module ${HOSTED_MIGRATOR}, not its public variant ${publicOf(HOSTED_MIGRATOR)}`,
        ...(privateTree
          ? [
              `${chunk} holds a private module's kind = "private" marker`,
              `${driverDeclarations} holds a doc comment of the private module ${HOSTED_DRIVER} that its public variant ${publicOf(HOSTED_DRIVER)} lacks`,
            ]
          : []),
        ...privateDigests().map(
          ({ label }) => `${chunk} holds ${label} from ${PRIVATE_MODULE}`,
        ),
      ].sort(),
    );
  });
});

/*
 * The test seams (ruling 174; ruling 193 item 2): `bundle.mjs`'s
 * `testSeams`, the one list, which every row of its `bundles` names as
 * `inertSeams`. `server`'s host imports the CSP's E2E fence, so its bundle
 * holds the fence's inert module; no other row reaches a seam's real module.
 * Built without the replacement, `server`'s real fence imports `auth`'s
 * `./e2e`, so the build is refused before it is staged; the check refuses
 * the JavaScript that build wrote.
 */
describe("the test seams (ruling 174; ruling 193 item 2)", () => {
  test("every row the pack builds names inertSeams, which is testSeams' map from each real module to its inert module; server's JavaScript inlines the CSP fence's inert module, and no tarball names a seam's real module or holds its marker", () => {
    assert.deepEqual(
      inertSeams,
      Object.fromEntries(testSeams.map(({ real, inert }) => [real, inert])),
    );
    for (const key of ORDER) {
      assert.deepEqual(PACKAGES[key].bundle.inertSeams, inertSeams, key);
      const { javascript, declarations } = moduleComments(packed(key).entries);
      assert.deepEqual(
        [...javascript, ...declarations].filter(
          (module) =>
            Object.hasOwn(inertSeams, module) ||
            Object.values(inertSeams).includes(module),
        ),
        key === "server" ? ["packages/server/src/inert/e2e-csp-fence.ts"] : [],
        key,
      );
    }
  });

  test("a pack of server built without the replacement is refused: buildPackage refuses its real CSP fence's import of @requestport/auth/e2e, which auth does not publish, and the check refuses the JavaScript that build wrote, which holds the fence's marker", async () => {
    const server = PACKAGES.server;
    const row = {
      ...server,
      bundle: { ...server.bundle, inertSeams: {}, declarations: undefined },
    };
    const directory = join(scratch, "without-inert-seams", "stage", "server");

    await assert.rejects(stagePackage(row, { version: VERSION, directory }), {
      message:
        "@requestport/server: imports @requestport/auth/e2e, which @requestport/auth does not publish",
    });
    const { staged, entries } = packed("server");
    const written = readdirSync(join(directory, "dist")).filter((file) =>
      file.endsWith(".js"),
    );
    const planted = new Map(entries);
    for (const file of written) {
      planted.set(
        `package/dist/${file}`,
        readFileSync(join(directory, "dist", file)),
      );
    }
    const fence = testSeams.find(
      ({ real }) => real === "packages/server/src/e2e-csp-fence.ts",
    );
    const holding = written.filter((file) =>
      readFileSync(join(directory, "dist", file), "utf8").includes(
        `\n// ${fence.real}\n`,
      ),
    );
    assert.equal(holding.length, 1, holding.join(", "));
    assert.deepEqual(
      checkTarball(planted, staged)
        .filter(
          (problem) =>
            problem.includes(fence.name) || problem.includes(" test seam's "),
        )
        .sort(),
      [
        `dist/${holding[0]} holds ${fence.name} (${fence.real})`,
        `dist/${holding[0]} inlines the test seam's real module ${fence.real}, not its inert module ${fence.inert}`,
      ].sort(),
    );
  });
});

describe("the run read together (checkRun)", () => {
  test("accepts the run as packed: every @requestport/* package a packed manifest names is packed before it, and every @requestport/* specifier in the tarballs is a subpath a packed manifest exports", async () => {
    assert.deepEqual(await checkRun(run.packs), []);
  });

  test("accepts the subpaths a published entry reaches that G's set left out, each imported by a tarball of the run and exported by its package's packed manifest: auth's import of config's ./sign-in-methods (ruling 183 item 3), jobs' of config's ./server-deferred and db's ./wiring, and server's of core's ./adapters (ruling 193 item 1); and refuses each in a run whose exporting manifest drops it, as G's set packed it", async () => {
    const reached = [
      ["auth", "config", "./sign-in-methods"],
      ["jobs", "config", "./server-deferred"],
      ["jobs", "db", "./wiring"],
      ["server", "core", "./adapters"],
    ];
    assert.deepEqual(await checkRun(run.packs), []);
    for (const [importer, exporter, subpath] of reached) {
      const specifier = `@requestport/${exporter}${subpath.slice(1)}`;
      const importing = [...packed(importer).entries]
        .filter(
          ([path, body]) =>
            /\.(?:js|d\.ts)$/u.test(path) &&
            body.toString("utf8").includes(`"${specifier}"`),
        )
        .map(([path]) => path.slice("package/".length))
        .sort();
      assert.ok(importing.length > 0, `${importer} imports ${specifier}`);
      const pack = packed(exporter);
      const manifest = packedManifest(pack);
      const name = PINNED[exporter].exports[subpath];
      assert.deepEqual(manifest.exports[subpath], {
        types: `./dist/${name}.d.ts`,
        import: `./dist/${name}.js`,
      });
      const { [subpath]: _dropped, ...kept } = manifest.exports;
      const dropped = {
        ...pack,
        entries: withManifest(pack.entries, { ...manifest, exports: kept }),
      };
      assert.deepEqual(
        await checkRun(
          run.packs.map((other) => (other === pack ? dropped : other)),
        ),
        importing.map(
          (file) =>
            `@requestport/${importer}: ${file} imports ${specifier}, which @requestport/${exporter}'s packed manifest does not export`,
        ),
        specifier,
      );
    }
  });

  test("refuses a package packed before one it depends on, and one it depends on that the run does not pack", async () => {
    const core = packed("core");
    const reordered = [core, ...run.packs.filter((pack) => pack !== core)];
    const withoutDb = run.packs.filter((pack) => pack !== packed("db"));

    assert.deepEqual(
      await checkRun(reordered),
      PINNED.core.dependencies
        .filter((name) => name.startsWith("@requestport/"))
        .map(
          (name) =>
            `@requestport/core is packed before ${name}, which it depends on (dependencies)`,
        ),
    );
    const problems = await checkRun(withoutDb);
    const needingDb = ORDER.filter((key) =>
      PINNED[key].dependencies.includes("@requestport/db"),
    );
    assert.ok(needingDb.includes("core"), needingDb.join(", "));
    for (const key of needingDb) {
      assert.ok(
        problems.includes(
          `@requestport/${key} depends on @requestport/db, which this run does not pack (dependencies)`,
        ),
        `${key}: ${JSON.stringify(problems)}`,
      );
    }
    assert.deepEqual(
      problems.filter((problem) => !problem.includes("@requestport/db")),
      [],
    );
  });

  test("refuses, planted in the real tarballs, config/redaction imported by jobs', db/testing by core's declarations, and a package the run does not pack, by import() in core's JavaScript", async () => {
    const append = (pack, path, text) => {
      const entries = new Map(pack.entries);
      entries.set(
        `package/${path}`,
        Buffer.concat([pack.entries.get(`package/${path}`), Buffer.from(text)]),
      );
      return { ...pack, entries };
    };
    const jobs = firstEntryFiles("jobs");
    const core = firstEntryFiles("core");
    let plantedCore = append(
      packed("core"),
      core.dts,
      '\nimport type { TestStorage } from "@requestport/db/testing";\nexport type Planted = TestStorage;\n',
    );
    plantedCore = append(
      plantedCore,
      core.js,
      '\nexport const plantedTheme = () => import("@requestport/theme");\n',
    );
    const plantedJobs = append(
      packed("jobs"),
      jobs.js,
      '\nexport * from "@requestport/config/redaction";\n',
    );
    const packs = run.packs.map((pack) =>
      pack === packed("core")
        ? plantedCore
        : pack === packed("jobs")
          ? plantedJobs
          : pack,
    );

    assert.deepEqual(await checkRun(packs), [
      `@requestport/jobs: ${jobs.js} imports @requestport/config/redaction, which @requestport/config's packed manifest does not export`,
      `@requestport/core: ${core.dts} imports @requestport/db/testing, which @requestport/db's packed manifest does not export`,
      `@requestport/core: ${core.js} imports @requestport/theme, and this run packs no @requestport/theme`,
    ]);
  });

  test("the check refuses a module of db inlined in core's tarball, in its JavaScript and its declarations, and in server's a module of core, whose ./adapters it imports (ruling 193 item 1)", () => {
    const core = packed("core");
    const { js, dts } = firstEntryFiles("core");
    const planted = new Map(core.entries);
    for (const [path, comment] of [
      [js, "// packages/db/src/index.ts"],
      [dts, "//#region packages/db/src/index.d.ts"],
    ]) {
      planted.set(
        `package/${path}`,
        Buffer.concat([
          core.entries.get(`package/${path}`),
          Buffer.from(`\n${comment}\n`),
        ]),
      );
    }
    const server = packed("server");
    const serverJs = firstEntryFiles("server").js;
    const plantedServer = new Map(server.entries).set(
      `package/${serverJs}`,
      Buffer.concat([
        server.entries.get(`package/${serverJs}`),
        Buffer.from("\n// packages/core/src/adapters.ts\n"),
      ]),
    );

    assert.deepEqual(
      checkTarball(planted, core.staged).sort(),
      [
        `${dts} inlines packages/db/src/index.d.ts, a module of @requestport/db`,
        `${js} inlines packages/db/src/index.ts, a module of @requestport/db`,
      ].sort(),
    );
    assert.deepEqual(checkTarball(plantedServer, server.staged), [
      `${serverJs} inlines packages/core/src/adapters.ts, a module of @requestport/core`,
    ]);
    assert.deepEqual(
      moduleComments(server.entries).javascript.filter(
        (module) => !module.startsWith("packages/server/"),
      ),
      [],
    );
    assert.deepEqual(PACKAGES.server.bundle.inlines, []);
  });
});

describe("esbuild's runtime helpers and THIRD-PARTY-NOTICES (ruling 209)", () => {
  /** The line above each entry of the repository's notices. */
  const RULE = "-".repeat(72);

  /**
   * The repository's notices as this tree holds them: under `release/public`
   * in the private tree, and at the root in the public seed, which carries
   * no `release/`. Written out here, not read from the script, so that a
   * moved file fails.
   */
  function repositoryNotices() {
    const held = [
      "release/public/THIRD_PARTY_NOTICES",
      "THIRD_PARTY_NOTICES",
    ].filter((path) => existsSync(join(repositoryRoot, path)));
    assert.equal(held.length, 1, held.join(", "));
    return readFileSync(join(repositoryRoot, held[0]), "utf8");
  }

  /** esbuild as `packages/core` installs it, G's bundler: its version and its LICENSE.md. */
  function installedEsbuild() {
    const manifest = createRequire(
      join(repositoryRoot, "packages/core/package.json"),
    ).resolve("esbuild/package.json");
    return {
      version: JSON.parse(readFileSync(manifest, "utf8")).version,
      licence: readFileSync(join(dirname(manifest), "LICENSE.md"), "utf8"),
    };
  }

  /**
   * The helper names esbuild's runtime declares, read from the esbuild
   * `packages/core` installs: its platform package's binary
   * (`@esbuild/<platform>-<arch>/bin/esbuild`) embeds the runtime's source,
   * each declaration on a line of its own, indented by tabs. Each name a
   * `var __<name> =` or `export var __<name> =` there declares, sorted,
   * each once.
   */
  function runtimeHelpersOfBinary() {
    const esbuild = createRequire(
      join(repositoryRoot, "packages/core/package.json"),
    ).resolve("esbuild/package.json");
    const binary = createRequire(esbuild).resolve(
      `@esbuild/${process.platform}-${process.arch}/bin/esbuild`,
    );
    const text = readFileSync(binary).toString("latin1");
    return [
      ...new Set(
        [...text.matchAll(/\n\t+(?:export )?var (__[A-Za-z]+) =/gu)].map(
          ([, name]) => name,
        ),
      ),
    ].sort();
  }

  /** Each JavaScript file of a tarball that binds an esbuild runtime helper, with the helpers it binds. */
  function helperBindings(entries) {
    return [...entries]
      .filter(([path]) => /\.(?:c|m)?js$/u.test(path))
      .map(([path, body]) => ({
        file: path.slice("package/".length),
        helpers: esbuildHelpersIn(body.toString("utf8")),
      }))
      .filter(({ helpers }) => helpers.length > 0)
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }

  /** `pack` with the file at `path` replaced by `body`, or removed where `body` is undefined. */
  function replacing(pack, path, body) {
    const entries = new Map(pack.entries);
    if (body === undefined) entries.delete(`package/${path}`);
    else entries.set(`package/${path}`, Buffer.from(body));
    return { ...pack, entries };
  }

  /** The run's packs, with each of `planted` in place of the pack of its stage. */
  function runWith(...planted) {
    return run.packs.map(
      (pack) => planted.find(({ staged }) => staged === pack.staged) ?? pack,
    );
  }

  test("ESBUILD_RUNTIME_HELPERS is, sorted and each once, the 64 names the runtime source in the binary of esbuild 0.28.2, the esbuild packages/core installs, declares with var or export var; esbuildHelpersIn finds each `var __<name> = ` binding of a listed name at a line's start, in order, and nothing else", () => {
    assert.equal(installedEsbuild().version, "0.28.2");
    assert.equal(ESBUILD_RUNTIME_HELPERS.length, 64);
    assert.equal(new Set(ESBUILD_RUNTIME_HELPERS).size, 64);
    assert.deepEqual([...ESBUILD_RUNTIME_HELPERS].sort(), [
      ...ESBUILD_RUNTIME_HELPERS,
    ]);
    for (const name of ESBUILD_RUNTIME_HELPERS) {
      assert.match(name, /^__[A-Za-z]+$/u);
    }
    assert.deepEqual(runtimeHelpersOfBinary(), [...ESBUILD_RUNTIME_HELPERS]);
    assert.deepEqual(
      esbuildHelpersIn(
        [
          "var __defProp = Object.defineProperty;",
          "var __export = (target, all) => {};",
          "  var __toESM = 1;",
          "var __planted = 1;",
          "const __require = 1;",
          "call(__name);",
          "var __name = (target, value) => target;",
          "",
        ].join("\n"),
      ),
      ["__defProp", "__export", "__name"],
    );
  });

  test("db's tarball carries a THIRD-PARTY-NOTICES, the stage's byte for byte, which its manifest's files names: a header naming @requestport/db, then the entries the repository's notices list as bundled in @requestport/db, byte for byte as they hold them, esbuild's at the version packages/core installs, with esbuild's LICENSE.md; db's chunk binds __defProp and __export, and no other of the eleven binds a helper or carries a THIRD-PARTY-NOTICES", () => {
    assert.equal(NOTICES_FILE, "THIRD-PARTY-NOTICES");
    assert.deepEqual(REPOSITORY_NOTICES, [
      "release/public/THIRD_PARTY_NOTICES",
      "THIRD_PARTY_NOTICES",
    ]);
    const db = packed("db");
    const notices = db.entries.get("package/THIRD-PARTY-NOTICES");
    assert.ok(
      notices !== undefined,
      "db's tarball carries no THIRD-PARTY-NOTICES",
    );
    const text = notices.toString("utf8");
    assert.ok(
      notices.equals(
        readFileSync(join(db.staged.directory, "THIRD-PARTY-NOTICES")),
      ),
    );
    assert.equal(db.staged.bundledNotices, text);
    assert.ok(packedManifest(db).files.includes("THIRD-PARTY-NOTICES"));

    const esbuild = installedEsbuild();
    const [header, ...entries] = text.split(`\n${RULE}\n`);
    assert.ok(
      header.startsWith("Third-party notices for @requestport/db\n\n"),
      header,
    );
    const listed = repositoryNotices()
      .split(`\n${RULE}\n`)
      .slice(1)
      .filter((entry) =>
        entry.split("\n", 1)[0].endsWith(" (bundled in @requestport/db)"),
      );
    assert.deepEqual(entries, listed);
    assert.deepEqual(
      entries.map((entry) => entry.split("\n", 1)[0]),
      [`esbuild@${esbuild.version} (bundled in @requestport/db)`],
    );
    const printed = esbuild.licence
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
    assert.ok(entries[0].endsWith(`\n\n${printed}\n`), "esbuild's LICENSE.md");
    assert.equal(noticesNameEsbuild(text), true);

    for (const key of ORDER) {
      const { entries: files } = packed(key);
      assert.deepEqual(
        helperBindings(files).flatMap(({ helpers }) => helpers),
        key === "db" ? ["__defProp", "__export"] : [],
        key,
      );
      assert.equal(files.has("package/THIRD-PARTY-NOTICES"), key === "db", key);
    }
  });

  test("the check admits db's THIRD-PARTY-NOTICES and compares it with the stage's: planted in db's real tarball, it refuses the file missing and the file one byte longer; planted in core's, a THIRD-PARTY-NOTICES is off its allow-list", () => {
    const db = packed("db");
    const core = packed("core");
    const notices = db.entries.get("package/THIRD-PARTY-NOTICES") ?? "";

    assert.deepEqual(checkTarball(db.entries, db.staged), []);
    assert.deepEqual(
      checkTarball(
        replacing(db, "THIRD-PARTY-NOTICES", undefined).entries,
        db.staged,
      ),
      ["THIRD-PARTY-NOTICES is on the allow-list but not in the tarball"],
    );
    assert.deepEqual(
      checkTarball(
        replacing(db, "THIRD-PARTY-NOTICES", `${notices}\n`).entries,
        db.staged,
      ),
      ["THIRD-PARTY-NOTICES is not the notices the stage wrote, byte for byte"],
    );
    assert.deepEqual(
      checkTarball(
        replacing(core, "THIRD-PARTY-NOTICES", "Third-party notices\n").entries,
        core.staged,
      ),
      ["THIRD-PARTY-NOTICES is not on the allow-list"],
    );
  });

  test("where a stage sets no bundledNotices, as core-tarball-smoke.mjs's reusePack (--from) stages each package when it re-reads the run's pack directory, the check compares a THIRD-PARTY-NOTICES on the allow-list with the stage directory's: planted in db's real tarball, it refuses the file one byte longer, and accepts the tarball as packed", () => {
    const db = packed("db");
    const notices = db.entries.get("package/THIRD-PARTY-NOTICES") ?? "";
    const reread = reusePack(run.out).packs.find(
      ({ staged }) => staged.manifest.name === "@requestport/db",
    ).staged;
    assert.equal(reread.bundledNotices, undefined);
    assert.ok(reread.allowList.includes("THIRD-PARTY-NOTICES"));

    assert.deepEqual(checkTarball(db.entries, reread), []);
    assert.deepEqual(
      checkTarball(
        replacing(db, "THIRD-PARTY-NOTICES", `${notices}\n`).entries,
        reread,
      ),
      ["THIRD-PARTY-NOTICES is not the notices the stage wrote, byte for byte"],
    );
  });

  test("checkRun refuses a tarball whose JavaScript binds esbuild's runtime helpers while it carries no THIRD-PARTY-NOTICES, or one with no entry for esbuild, naming the package and the file: db's real tarball without its notices, with notices that list another package, and with notices that name esbuild on a line that heads no entry; core's with __defProp and __export bound at the head of its entry's JavaScript and __defProp in a planted .cjs and a planted .mjs file, each of the three files refused by name. It accepts the run as packed, an entry for esbuild in @requestport/web's form, and helper names that no line's start binds", async () => {
    const db = packed("db");
    const core = packed("core");
    const bound = helperBindings(db.entries);
    assert.equal(bound.length, 1, JSON.stringify(bound));
    const [{ file: chunk }] = bound;
    const { js } = firstEntryFiles("core");
    const coreJs = core.entries.get(`package/${js}`).toString("utf8");
    const webRule = "=".repeat(80);

    assert.deepEqual(await checkRun(run.packs), []);
    assert.deepEqual(
      await checkRun(runWith(replacing(db, "THIRD-PARTY-NOTICES", undefined))),
      [
        `@requestport/db: ${chunk} binds esbuild's runtime helpers __defProp, __export, and the tarball carries no THIRD-PARTY-NOTICES`,
      ],
    );
    assert.deepEqual(
      await checkRun(
        runWith(
          replacing(
            db,
            "THIRD-PARTY-NOTICES",
            `Third-party notices\n\n${webRule}\nPackage: other@1.0.0\nLicense: MIT\n`,
          ),
        ),
      ),
      [
        `@requestport/db: ${chunk} binds esbuild's runtime helpers __defProp, __export, and its THIRD-PARTY-NOTICES has no entry for esbuild`,
      ],
    );
    assert.deepEqual(
      await checkRun(
        runWith(
          replacing(
            db,
            "THIRD-PARTY-NOTICES",
            `Third-party notices\n\n${webRule}\nPackage: other@1.0.0\nLicense: MIT\n\n--- LICENSE ---\n\nesbuild@0.28.2 named on a line of its own, in another entry\n`,
          ),
        ),
      ),
      [
        `@requestport/db: ${chunk} binds esbuild's runtime helpers __defProp, __export, and its THIRD-PARTY-NOTICES has no entry for esbuild`,
      ],
    );
    assert.deepEqual(
      await checkRun(
        runWith(
          replacing(
            replacing(
              replacing(
                core,
                js,
                `var __defProp = Object.defineProperty;\nvar __export = (target, all) => {};\n${coreJs}`,
              ),
              "dist/planted.cjs",
              "var __defProp = Object.defineProperty;\n",
            ),
            "dist/planted.mjs",
            "var __defProp = Object.defineProperty;\n",
          ),
        ),
      ),
      [
        `@requestport/core: ${js} binds esbuild's runtime helpers __defProp, __export, and the tarball carries no THIRD-PARTY-NOTICES`,
        "@requestport/core: dist/planted.cjs binds esbuild's runtime helpers __defProp, and the tarball carries no THIRD-PARTY-NOTICES",
        "@requestport/core: dist/planted.mjs binds esbuild's runtime helpers __defProp, and the tarball carries no THIRD-PARTY-NOTICES",
      ],
    );
    assert.deepEqual(
      await checkRun(
        runWith(
          replacing(
            db,
            "THIRD-PARTY-NOTICES",
            `Third-party notices\n\n${webRule}\nPackage: esbuild@0.28.2 (bundled in @requestport/db)\nLicense: MIT\n`,
          ),
        ),
      ),
      [],
    );
    assert.deepEqual(
      await checkRun(
        runWith(
          replacing(
            core,
            js,
            `${coreJs}\nexport const planted = () => __defProp;\n  var __export = 1;\nvar __planted = 1;\n`,
          ),
        ),
      ),
      [],
    );
  });

  test("bundledNotices reads the repository's notices at whichever of their two paths the tree holds, and writes none for a package they list nothing bundled in; it refuses a tree that holds them at both paths or at neither, and an entry that says another workspace builds the package", () => {
    const text = repositoryNotices();
    const tree = (files) => {
      const root = mkdtempSync(join(scratch, "notices-"));
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), body);
      }
      return root;
    };
    const written = packed("db").staged.bundledNotices;
    const where =
      "pack-packages: the repository's notices must be at exactly one of release/public/THIRD_PARTY_NOTICES and THIRD_PARTY_NOTICES; this tree holds";

    assert.ok(written !== undefined);
    assert.equal(
      bundledNotices(
        PACKAGES.db,
        tree({ "release/public/THIRD_PARTY_NOTICES": text }),
      ),
      written,
    );
    assert.equal(
      bundledNotices(PACKAGES.db, tree({ THIRD_PARTY_NOTICES: text })),
      written,
    );
    assert.equal(
      bundledNotices(PACKAGES.core, tree({ THIRD_PARTY_NOTICES: text })),
      undefined,
    );
    assert.throws(
      () =>
        bundledNotices(
          PACKAGES.db,
          tree({
            "release/public/THIRD_PARTY_NOTICES": text,
            THIRD_PARTY_NOTICES: text,
          }),
        ),
      { message: `${where} both.` },
    );
    assert.throws(() => bundledNotices(PACKAGES.db, tree({})), {
      message: `${where} neither.`,
    });
    const from = "the npm tarball of @requestport/db, built from packages/db";
    assert.ok(text.includes(from));
    assert.throws(
      () =>
        bundledNotices(
          PACKAGES.db,
          tree({
            THIRD_PARTY_NOTICES: text.replace(from, `${from}-elsewhere`),
          }),
        ),
      {
        message: `pack-packages: THIRD_PARTY_NOTICES's entry esbuild@${installedEsbuild().version} (bundled in @requestport/db) does not say it is carried in the npm tarball of @requestport/db, built from packages/db.`,
      },
    );
  });
});

/*
 * `auth`'s tarball (ruling 190; Done when 9's named exemption): the package
 * `requestport` and `server` import, built by `bundle.mjs`'s row as every
 * other package is. It leaves every other package `bundles` builds external
 * and inlines none of their modules, so it imports `config`'s
 * `./sign-in-methods` rather than carrying a copy, and it names Better Auth,
 * which it composes, by its exemption alone. Its `zod` is its own
 * manifest's (ruling 144; ruling 193 item 7): the version rule reads its
 * workspace alone, and no exemption is needed.
 */
describe("auth's tarball (ruling 190; Done when 9's named exemption)", () => {
  test("leaves every other package bundles builds external and inlines none of their modules: it imports config's ./sign-in-methods, and its JavaScript names only auth's own modules", () => {
    const { staged, entries } = packed("auth");
    assert.deepEqual(
      [...PACKAGES.auth.bundle.external].sort(),
      ORDER.filter((key) => key !== "auth")
        .map((key) => `@requestport/${key}`)
        .sort(),
    );
    assert.deepEqual(PACKAGES.auth.bundle.inlines, []);
    assert.deepEqual(
      staged.inputs.filter((input) => !input.startsWith("packages/auth/")),
      [],
    );
    assert.deepEqual(
      moduleComments(entries).javascript.filter(
        (module) => !module.startsWith("packages/auth/src/"),
      ),
      [],
    );
    assert.ok(staged.external.includes("@requestport/config"));
  });

  test("the check refuses, planted in its manifest, a ./server export, and a dependency on itself, on a package the run does not pack or on Trigger.dev; Better Auth it accepts by the package's name only, so core's tarball refuses it", () => {
    const { staged, entries } = packed("auth");
    const manifest = packedManifest(packed("auth"));
    const planted = {
      ...manifest,
      exports: {
        ...manifest.exports,
        "./server": {
          types: "./dist/server.d.ts",
          import: "./dist/server.js",
        },
      },
      dependencies: {
        ...manifest.dependencies,
        "@requestport/auth": VERSION,
        "@requestport/theme": VERSION,
        "@trigger.dev/sdk": "4.0.0",
      },
    };
    const problems = checkTarball(withManifest(entries, planted), staged);

    for (const problem of [
      "package.json exports ./server, which is not published",
      "package.json's dependencies names @requestport/auth",
      "package.json's dependencies names @requestport/theme",
      "package.json's dependencies names @trigger.dev/sdk",
    ]) {
      assert.ok(problems.includes(problem), problem);
    }
    assert.deepEqual(
      problems.filter((problem) =>
        /names (?:better-auth|@better-auth\/|@requestport\/(?:config|core|db|domain))/u.test(
          problem,
        ),
      ),
      [],
    );

    const core = packed("core");
    const coreManifest = packedManifest(core);
    const withBetterAuth = {
      ...coreManifest,
      dependencies: {
        ...coreManifest.dependencies,
        "@better-auth/core": "1.7.6",
        "@requestport/core": VERSION,
      },
    };
    const refused = checkTarball(
      withManifest(core.entries, withBetterAuth),
      core.staged,
    );
    assert.ok(
      refused.includes("package.json's dependencies names @better-auth/core"),
    );
    assert.ok(
      refused.includes("package.json's dependencies names @requestport/core"),
    );
  });

  test("its zod is its own manifest's, which no other workspace it inlines declares, so no exemption is needed and none is named; read over auth's manifest and config's with another zod planted, as a bundle inlining both would be, the one-version rule refuses zod until an exemption takes auth's, and refuses an exemption no disagreement needs or whose workspace declares nothing; it names a workspace package at the stamped version only when the run packs it", () => {
    const manifests = readWorkspaceManifests();
    // The disagreement the rule refuses is planted, so the case holds
    // whatever zod the workspaces declare: config at 0.2.0's 4.4.3.
    const configZod = "4.4.3";
    const disagreeing = new Map(manifests).set("packages/config", {
      ...manifests.get("packages/config"),
      dependencies: {
        ...manifests.get("packages/config").dependencies,
        zod: configZod,
      },
    });
    const exemption = { zod: "packages/auth" };

    assert.deepEqual(PINNED.auth.workspaces, ["packages/auth"]);
    assert.equal(packedManifest(packed("auth")).dependencies.zod, authZod());
    for (const key of ORDER)
      assert.deepEqual(PACKAGES[key].exemptions, {}, key);

    const input = {
      names: PINNED.auth.dependencies,
      peers: PACKAGES.auth.optionalPeers,
      workspaces: ["packages/auth", "packages/config"],
      manifests: disagreeing,
      packed: Object.fromEntries(
        ORDER.map((key) => [`@requestport/${key}`, VERSION]),
      ),
    };

    assert.notEqual(authZod(), configZod);
    assert.deepEqual(dependencyVersions(input).problems, [
      `zod is declared at more than one version: ${authZod()} by packages/auth; ${configZod} by packages/config`,
    ]);

    const exempt = dependencyVersions({ ...input, exemptions: exemption });
    assert.deepEqual(exempt.problems, []);
    assert.equal(exempt.dependencies.zod, authZod());
    assert.equal(exempt.dependencies["@requestport/core"], VERSION);

    const aligned = new Map(manifests).set("packages/config", {
      ...manifests.get("packages/config"),
      dependencies: { zod: authZod() },
    });
    assert.deepEqual(
      dependencyVersions({
        ...input,
        manifests: aligned,
        exemptions: exemption,
      }).problems,
      [
        `zod's exemption is not needed: every workspace the bundle inlines declares ${authZod()}`,
      ],
    );
    assert.deepEqual(
      dependencyVersions({
        ...input,
        exemptions: { ...exemption, jose: "packages/db" },
      }).problems,
      [
        "jose is exempted to packages/db's version, and packages/db is not a workspace the bundle inlines that declares it",
      ],
    );
    assert.deepEqual(
      dependencyVersions({
        ...input,
        packed: {},
        exemptions: exemption,
      }).problems,
      PINNED.auth.dependencies
        .filter((name) => name.startsWith("@requestport/"))
        .map((name) => `${name} is a workspace package (workspace:*)`),
    );
  });
});

describe("the source scan and the version rule (G.0b; rulings 146 and 150)", () => {
  test("finds pg, drizzle-orm's run-time drivers and PGlite in db's client.ts and migrate.ts, each provided by db's row, and reports pg when the run-time list lacks it, and a list entry nothing requires; no other package's bundle requires anything at run time", () => {
    const { staged } = packed("db");
    const lists = {
      external: staged.external,
      runtime: PACKAGES.db.runtime,
      optionalPeers: PACKAGES.db.optionalPeers,
    };

    assert.deepEqual(PACKAGES.db.runtime, ["pg"]);
    assert.deepEqual(PACKAGES.db.optionalPeers, ["@electric-sql/pglite"]);
    assert.equal(PACKAGES.db.migrations, "packages/db/migrations");
    for (const key of ORDER.filter((key) => key !== "db")) {
      assert.deepEqual(packed(key).staged.requires, [], key);
      assert.deepEqual(PACKAGES[key].runtime, [], key);
      assert.deepEqual(PACKAGES[key].optionalPeers, [], key);
      assert.equal(PACKAGES[key].migrations, undefined, key);
    }
    assert.deepEqual(unaccountedRequires(staged.requires, lists), []);
    assert.deepEqual(
      unaccountedRequires(staged.requires, { ...lists, runtime: [] }),
      [
        "packages/db/src/client.ts requires pg at run time, and pg is none of the bundle's externals, the run-time list and the optional peers",
      ],
    );
    assert.deepEqual(
      unaccountedRequires(staged.requires, {
        ...lists,
        runtime: ["pg", "left-pad"],
      }),
      [
        "the run-time list names left-pad, which no module of the bundle requires at run time",
      ],
    );
    assert.deepEqual(
      unaccountedRequires(packed("core").staged.requires, {
        external: packed("core").staged.external,
        runtime: ["pg"],
        optionalPeers: [],
      }),
      [
        "the run-time list names pg, which no module of the bundle requires at run time",
      ],
    );
  });

  test("reads a createRequire imported under another name or through a namespace, getBuiltinModule's, and a call in place, and reports a path and a call it cannot read", async () => {
    const module = join(scratch, "requires.ts");
    writeFileSync(
      module,
      [
        'import { createRequire as make } from "node:module";',
        'import * as nodeModule from "node:module";',
        "const one = make(import.meta.url);",
        'export const a = one("alpha") as unknown;',
        "const two = nodeModule.createRequire(import.meta.url);",
        'export const b = two("beta/sub");',
        'export const c = process.getBuiltinModule("node:module").createRequire(import.meta.url)("gamma");',
        'const name = "delta";',
        "export const d = one(name);",
        'export const e = one("./local.js");',
        "",
      ].join("\n"),
    );

    const requires = await runtimeRequires([module]);
    assert.deepEqual(requires, [
      { module, specifier: "./local.js" },
      { module, specifier: "alpha" },
      { module, specifier: "beta/sub" },
      { module, specifier: "gamma" },
      { module, specifier: undefined },
    ]);
    assert.deepEqual(
      unaccountedRequires(requires, {
        external: ["alpha", "beta", "gamma"],
        runtime: [],
        optionalPeers: [],
      }),
      [
        `${module} requires the path ./local.js at run time, which the tarball does not carry`,
        `${module} requires something that is not a string literal`,
      ],
    );
  });

  test("refuses a dependency the workspaces it inlines declare at two versions, one none declares, and a workspace package; the eight packages of the set declare each of their third-party dependencies at one, but a peer a row pins, which takes the version this tree installs (ruling 197 item 2)", () => {
    const manifests = readWorkspaceManifests();
    const workspaces = SET.map((key) => `packages/${key}`).sort();
    const names = [
      ...new Set(
        SET.flatMap((key) =>
          PINNED[key].dependencies.filter(
            (name) =>
              !name.startsWith("@requestport/") &&
              !Object.hasOwn(PINNED[key].pinnedPeers ?? {}, name),
          ),
        ),
      ),
    ].sort();
    const peers = PACKAGES.db.optionalPeers;
    const webhooks = manifests.get("packages/webhooks");
    const planted = new Map(manifests).set("packages/webhooks", {
      ...webhooks,
      dependencies: { ...webhooks.dependencies, uuid: "13.0.0" },
    });

    // None of the hosted driver's packages since db's row builds its
    // hosted-driver modules as their public variants (ruling 194 item 3).
    assert.equal(names.length, 14, `${names.length} names`);
    assert.deepEqual(
      dependencyVersions({ names, peers, workspaces, manifests }).problems,
      [],
    );
    assert.deepEqual(
      dependencyVersions({ names, peers, workspaces, manifests: planted })
        .problems,
      [
        `uuid is declared at more than one version: ${declaredVersion("uuid", workspaces)} by packages/db, packages/domain; 13.0.0 by packages/webhooks`,
      ],
    );
    assert.deepEqual(
      dependencyVersions({
        names: [...names, "left-pad", "@requestport/domain"],
        peers,
        workspaces,
        manifests,
      }).problems,
      [
        "@requestport/domain is a workspace package (workspace:*)",
        "left-pad: no workspace the bundle inlines declares it (dependencies)",
      ],
    );
  });

  test("copyMigrations refuses a folder holding an SQL file its journal does not name, and copies nothing; the same folder without that file it copies, each journal entry's SQL file and the journal", () => {
    const source = join(repositoryRoot, "packages/db/migrations");
    const folder = join(scratch, "planted-migrations");
    mkdirSync(join(folder, "meta"), { recursive: true });
    for (const file of readdirSync(source).filter((name) =>
      name.endsWith(".sql"),
    )) {
      cpSync(join(source, file), join(folder, file));
    }
    cpSync(
      join(source, "meta/_journal.json"),
      join(folder, "meta/_journal.json"),
    );
    writeFileSync(join(folder, "9999_planted.sql"), "select 1;\n");
    const from = relative(repositoryRoot, folder);
    const refused = join(scratch, "planted-migrations-refused");
    const copied = join(scratch, "planted-migrations-copied");
    mkdirSync(refused);
    mkdirSync(copied);
    const journal = readJson("packages/db/migrations/meta/_journal.json");

    assert.throws(() => copyMigrations(from, refused), {
      message: `pack-packages: ${from} and its journal disagree: not in the journal ["9999_planted.sql"], missing []`,
    });
    assert.deepEqual(readdirSync(refused), []);

    rmSync(join(folder, "9999_planted.sql"));
    assert.deepEqual(
      copyMigrations(from, copied),
      [
        ...journal.entries.map(({ tag }) => `migrations/${tag}.sql`),
        "migrations/meta/_journal.json",
      ].sort(),
    );
  });
});

describe("Done when 9's demonstration: the check rejects a tarball of each package's tsc -p tsconfig.json output, which ships its tests", () => {
  const tsc = join(
    dirname(
      createRequire(join(repositoryRoot, "package.json")).resolve(
        "typescript/package.json",
      ),
    ),
    "bin",
    "tsc",
  );
  // `server`'s project sets `noEmit`, so it writes nothing to pack.
  for (const key of ORDER.filter((key) => key !== "server")) {
    test(key, () => {
      const { staged } = packed(key);
      const stage = join(scratch, "tsc-stage", key);
      mkdirSync(stage, { recursive: true });
      cpSync(
        join(staged.directory, "package.json"),
        join(stage, "package.json"),
      );
      cpSync(join(staged.directory, "LICENSE"), join(stage, "LICENSE"));
      if (key === "db") {
        cpSync(
          join(staged.directory, "migrations"),
          join(stage, "migrations"),
          {
            recursive: true,
          },
        );
      }
      const build = spawnSync(
        process.execPath,
        [
          tsc,
          "-p",
          `packages/${key}/tsconfig.json`,
          "--outDir",
          join(stage, "dist"),
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
      const tests = readdirSync(join(stage, "dist"), { recursive: true })
        .filter((file) => /\.test\.js$/u.test(file))
        .sort();
      assert.ok(tests.length > 0, `${key}: ${tests.length} tests emitted`);

      const tarball = packStaged(stage, join(scratch, "tsc-tarball", key));
      const problems = checkTarball(readTarball(tarball), {
        ...staged,
        directory: stage,
      });

      for (const file of tests) {
        assert.ok(problems.includes(`dist/${file} is a test`), file);
        assert.ok(
          problems.includes(`dist/${file} is not on the allow-list`),
          file,
        );
      }
    });
  }
});

describe("the tarball reader", () => {
  /** One ustar entry: a 512-byte header, then the body padded to 512. */
  function tarEntry(path, body, type = "0") {
    const header = Buffer.alloc(512);
    const slash = path.length > 100 ? path.lastIndexOf("/", 155) : -1;
    header.write(slash === -1 ? path : path.slice(slash + 1), 0);
    if (slash !== -1) header.write(path.slice(0, slash), 345);
    header.write(body.length.toString(8).padStart(11, "0"), 124);
    header.write(type, 156);
    header.write("ustar\u000000", 257);
    return Buffer.concat([
      header,
      body,
      Buffer.alloc((512 - (body.length % 512)) % 512),
    ]);
  }

  test("reads files by path, a long one through its prefix, and refuses a link rather than read past it", () => {
    const long = `package/${"d".repeat(60)}/${"f".repeat(60)}.js`;
    const archive = (...entries) => {
      const file = join(scratch, `reader-${entries.length}.tgz`);
      writeFileSync(
        file,
        gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])),
      );
      return file;
    };
    const files = [
      tarEntry("package/", Buffer.alloc(0), "5"),
      tarEntry("package/a.txt", Buffer.from("a")),
      tarEntry(long, Buffer.from("x".repeat(600))),
    ];

    assert.deepEqual(
      Object.fromEntries(
        [...readTarball(archive(...files))].map(([path, body]) => [
          path,
          body.length,
        ]),
      ),
      { "package/a.txt": 1, [long]: 600 },
    );
    assert.throws(
      () =>
        readTarball(
          archive(...files, tarEntry("package/link", Buffer.alloc(0), "2")),
        ),
      /package\/link is a tar entry of type 2/u,
    );
  });
});

/**
 * The skip option of a case that reads a path the public seed does not carry
 * (manifest-j.md §2.4 item 6, Appendix A.3; ruling 92): a reason naming
 * `paths` when `scripts/hosted-deployment.mjs` declares the tree public, as
 * the seed's substitution makes it, and `false` otherwise. So in this private
 * tree the case never skips, a missing path still fails it, and
 * `private-paths.test.mjs` fails if a path named here is gone.
 */
function skipInPublicTree(...paths) {
  return hostedDeployment.kind === "public"
    ? `the public tree does not carry ${paths.join(", ")} (scripts/hosted-deployment.mjs declares kind "public")`
    : false;
}

describe("built, not published (§3.6)", () => {
  test("every source manifest stays private, and no script G adds calls publish", {
    skip: skipInPublicTree("spikes"),
  }, () => {
    const manifests = [
      "package.json",
      ...["apps", "packages", "spikes"].flatMap((directory) =>
        readdirSync(join(repositoryRoot, directory))
          .map((entry) => `${directory}/${entry}/package.json`)
          .filter((path) => existsSync(join(repositoryRoot, path))),
      ),
      "trigger/package.json",
    ];
    assert.ok(manifests.length > 15, `${manifests.length} manifests`);
    assert.deepEqual(
      manifests.filter((path) => readJson(path).private !== true),
      [],
    );

    for (const script of [
      "scripts/pack-packages.mjs",
      "scripts/licence-inventory.mjs",
      "packages/core/bundle.mjs",
    ]) {
      const text = readFileSync(join(repositoryRoot, script), "utf8");
      assert.doesNotMatch(text, /(["'`])publish\1/u, script);
      assert.doesNotMatch(
        text,
        /\b(?:npm|pnpm|yarn|bun)\b[\s"',[\]]*publish\b/u,
        script,
      );
    }
  });
});
