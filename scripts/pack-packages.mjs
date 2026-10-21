#!/usr/bin/env node
/*
  Packs eleven packages into eleven tarballs and checks each, and the run
  together. Plan 13, G: the owner's answer to D3 is Apache-2.0 on
  everything and eight packages, `@requestport/domain`, `notifications`,
  `webhooks`, `importer`, `config`, `db`, `jobs` and `core` (ruling 175),
  with `config` published with its import-safe subpaths only (ruling 176).
  The other three are `@requestport/auth`, `mcp` and `server`, which
  `requestport` depends on, and which ruling 190 has this machinery build,
  pack and check beside the eight (H question 8, the manifest's
  alternative). The tarballs are built and checked here. Nothing here sends
  them anywhere. Each packed manifest says `"private": false`, and every
  source manifest keeps `"private": true`: J question 14's answer, option
  (B), under which the owner publishes the checked tarball itself (rulings
  157, 175 and 207). Publishing is the owner's, from J.9's runbook, and
  nothing of it is here (manifest-g.md §3.6, ruling 117; J question 11,
  ruling 175).

  Usage: node scripts/pack-packages.mjs --version <version> [--out <directory>]

  1. It refuses a dirty tree: `git status --porcelain` must print nothing
     (§3.5), and must print the same after the pack.
  2. It packs the packages of `PACKAGES` in its order, which is
     `packages/core/bundle.mjs`'s `buildOrder()`: each after every package
     its source manifest depends on through `workspace:`. It
     builds each with `bundle.mjs`'s `buildPackage`, the one bundler
     configuration, which refuses a build that inlines another package's
     module or imports a subpath no row of `bundles` publishes, into its own
     staged directory outside the repository, `<out>/stage/<workspace>`.
     `publishConfig` cannot write these manifests: pnpm 11.22.0 copies no
     `dependencies`, `files`, `version` or `license` from it (G.0b; ruling
     139). So the script writes each packed manifest there, and writes
     nothing into the repository, which step 1's second reading of the
     tree's status checks.
  3. Before it writes a manifest, it refuses:
     - a package that a module of the bundle loads through a `createRequire`
       binding, or through `process.getBuiltinModule("node:module")`, and
       that is none of the bundle's externals, the package's run-time list
       or its optional peers, or a path the tarball does not carry (the
       source scan; G.0b). esbuild does not follow those calls (G.7's
       survey), so without the list `db`'s packed manifest would omit `pg`,
       which `db`'s `client.ts` loads that way, and PGlite, its optional peer;
     - a name on the run-time list that no such call loads;
     - a dependency that the workspaces the bundle inlines declare at two
       versions, or that none of them declares, but a name the package
       exempts by name, which takes the version of the workspace it names.
       An exemption that no disagreement needs is refused too, and no row
       names one: each package inlines only its own workspace's modules, so
       its versions are its own manifest's. Core's `package.test.ts` holds
       one version of each name across the eight (ruling 146); `auth`
       declares `zod` 4.5.4, which its packed manifest names beside the
       others' 4.4.3 (ruling 144; ruling 193 item 7).
  4. The packed manifest: `private: false` (option (B), above); the
     version, stamped from `--version` (§3.4), one version for every
     package of the run, which is J question 10's lockstep; `exports` as `{ types, import }` on `dist/`
     for the bundle's entries only, so no subpath of `unpublished` is among
     them: `config` exports `./logger`, `./server`, `./server-deferred`
     and `./sign-in-methods`, never `.` or `./client` (rulings 176 and
     193), `db` neither `./testing` nor `./e2e`, and `auth` neither `.` nor
     `./server`, which install Better Auth from the environment as they are
     imported (ruling 193 item 3); `files`, `LICENSE` (`LICENCE_FILE`),
     `THIRD-PARTY-NOTICES` (`NOTICES_FILE`) where step 5 writes one, `dist`
     and, for `db`, `migrations`; `engines`, as the repository's root
     declares; `license`; `repository`, the public repository with the
     package's workspace as `directory` (`packedRepository`; J question 5,
     ruling 175; ruling 207 item 3); `dependencies` from four sources, the
     bundle's external imports, the run-time list and the bare imports of
     the bundled
     declarations (ruling 150), each `@requestport/*` package among them at
     the stamped version, because this run packs it, which replaces the
     source's `workspace:*` (§3.3), and the peers its row pins
     (`pinnedPeers`, at the version this tree installs; ruling 197 item 2:
     `notifications`' `react-dom`); and the optional peers.
  5. It copies the licence text its mapping names into the staged directory
     as `LICENSE` (§3.7; ruling 139), and `migrations/`, for `db`: the SQL
     file of each journal entry, and `meta/_journal.json`, and nothing else
     (ruling 150). Where the repository's notices list third-party code as
     bundled in the package, it writes those entries, as the notices hold
     them, as `THIRD-PARTY-NOTICES` (`bundledNotices`; ruling 209 item 1):
     for `db`, esbuild's runtime helpers, which its chunk binds. It reads
     the notices before the build, from `release/public/THIRD_PARTY_NOTICES`
     in this tree or `THIRD_PARTY_NOTICES` in the public seed
     (`REPOSITORY_NOTICES`), and refuses a tree that holds both or neither.
  6. It runs `pnpm pack` on each staged directory, from the repository's
     root, where corepack runs the pnpm the root's `packageManager` pins.
  7. It reads each tarball back, and refuses it unless:
     - its files are exactly the allow-list derived from the build:
       `package.json`, `LICENSE`, the JavaScript esbuild wrote, the
       declarations rolldown wrote, the migrations copied (manifest-g.md
       §3.2), and the `THIRD-PARTY-NOTICES` step 5 wrote;
     - its `LICENSE` is the mapping's text, byte for byte, and its manifest's
       `license` the mapping's SPDX expression (Done when 9's first bullet);
     - its `THIRD-PARTY-NOTICES`, where step 5 wrote one, is those bytes;
     - no file is a test, an `.env*` file, a source map, under
       `test-support/`, or the sweep's ledger;
     - no file holds the E2E owner storage's name or refusal text, or a path
       of this machine (`machinePaths`) in any form a build writes it
       (`pathForms`: as written, JSON-escaped, as a `file://` URL's path, or
       percent-encoded whole), binary files included (rulings 110, 145 and
       170, which H.7's pack read first; ruling 197 item 3);
     - no file but `package.json` holds a `workspace:` specifier
       (`WORKSPACE_SPECIFIER`), and the manifest no `workspace:` at all
       (below);
     - every module comment esbuild or rolldown wrote names a path inside the
       repository, never an absolute one or one that climbs (ruling 150);
       none in the JavaScript names a test, test support, the sweep's ledger,
       a root's module or an env-parsing `config` module that is not one of
       the packed package's own published modules, and none in the
       declarations a test, test support or the ledger: the forbidden-module
       list, which `bundle.mjs` holds (`forbiddenModule` and
       `testOnlyModule`; ruling 151; scoped by ruling 193 item 1); and none
       names a module of another package than the one packed, but one its
       row inlines (no row inlines one);
     - no file holds a test seam (ruling 174; rulings 190 and 193 item 2):
       no module comment in its JavaScript and no `//#region` in its
       declarations names a seam's real module, and no file holds a seam's
       marker, text that shows the real module, both as `bundle.mjs`'s
       `testSeams` lists them, the one list, which
       `pack-requestport.mjs` also reads (through
       `apps/requestport/src/web/test-seams.ts`). `bundle.mjs`'s JavaScript
       step builds each seam's inert module in place of its real one
       (`inertSeams`); this refuses a bundle that did not, and declarations
       that reach a seam;
     - no file inlines a private module (ruling 183 item 9; `db`'s
       `shared-databases.ts`, `hosted-driver.ts` and `hosted-migrator.ts`,
       ruling 194 item 3): no module comment in its JavaScript names one, no
       `//#region` in its declarations names one, and it holds no doc
       comment of one that the module's public variant lacks, no digest the
       private module `packages/db/src/shared-databases.ts` names, and no
       `kind = "private"` marker, which each private module assigns and
       each variant does not. rolldown gives a module that a declaration
       imports as a namespace no `//#region` of its own, so in the
       declarations such a module shows by its doc comments, not by a
       region. `bundle.mjs` builds each private module's public variant in
       its place, in the JavaScript and the declarations (`publicVariants`);
       this refuses a bundle that did not;
     - its manifest's fields are the ones written; whatever the written
       manifest says, it says `private: false`, its `repository` is the
       public repository with its workspace as `directory`, and its `files`
       names `LICENSE` (`releaseFieldProblems`); it holds no
       `workspace:` specifier; no `@requestport/*` dependency but a package
       the bundle leaves external; no Better Auth dependency, but in `auth`,
       which composes Better Auth, exempt by name; no Trigger.dev
       dependency; no `scripts` or `bin`, so `jobs`' `requestport-jobs` bin
       is not packed (owner question 6, answered by ruling 185); and no
       unpublished subpath; every `exports` target is present.
  8. It reads the run's tarballs together, and refuses the run unless every
     `@requestport/*` package a packed manifest depends on is packed before
     it, every `@requestport/*` specifier a tarball's JavaScript or
     declarations import names a package of the run and a subpath its packed
     manifest exports, and every tarball whose JavaScript binds one of
     esbuild's runtime helpers as `var __<name> = ` at the start of a line,
     as esbuild writes them unminified, carries a `THIRD-PARTY-NOTICES` with
     an entry for esbuild (ruling 209 item 2) (`checkRun`; minified output
     hides them from it).
  9. It writes `<out>/build-record.json` (§3.5): the commit, the tree's
     status, the Node and pnpm versions, and each tarball's name, version,
     sha512 integrity, size and file count, in the order they were packed.

  `scripts/pack-packages.test.mjs` holds each of these, and
  `scripts/package-contract.test.mjs` the licence mapping against the texts
  in the tree and D3's set against the packed packages (§3.7).
*/
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

// `forbiddenModule` and `testOnlyModule`: the forbidden-module list, whose
// one copy is in `bundle.mjs` (ruling 151). `publicVariants`: the private
// modules, each with the public variant the bundles build in its place.
// `privateDocComments`: each doc comment of a private module that its
// variant lacks, and `holdsDocComment`, which finds one in a file.
// `inertSeams`: each test seam's real module, with the inert module the
// bundles build in its place, and `seamMarkersIn`, each seam's marker a
// text holds, both from the seams' one list, `testSeams` (ruling 193 item 2).
import {
  buildOrder,
  buildPackage,
  bundles,
  forbiddenModule,
  holdsDocComment,
  inertSeams,
  packageName,
  privateDocComments,
  publicVariants,
  seamMarkersIn,
  testOnlyModule,
} from "../packages/core/bundle.mjs";
// The private module whose digests no tarball may hold (ruling 183 item 9).
// In the public seed its path holds the public variant, which names no digest
// and whose `kind` is "public".
import * as sharedDatabases from "../packages/db/src/shared-databases.ts";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * What differs between the rows of `PACKAGES`, by the key of each row of
 * `bundle.mjs`'s `bundles`: the eight packages of the S8 set (ruling 175),
 * and `auth`, `mcp` and `server` (ruling 190).
 *
 * - `runtime`: the run-time list, the packages only a run-time `require`
 *   loads, which no bundler lists (G.0b): `db`'s `client.ts` loads `pg`
 *   through `createRequire`, and only `db`'s bundle inlines it;
 * - `optionalPeers`: packages loaded the same way that the consumer installs
 *   only if it wants them: PGlite, which `db`'s `client.ts` loads
 *   (manifest-g.md §3.2);
 * - `unpublished`: the subpaths of the source manifest that are not the
 *   row's entries, which the packed manifest must not carry, each named, so
 *   that a new subpath fails the pack's test until it is classified (ruling
 *   151). `bundle.mjs`'s `bundles` says why each row publishes what it does
 *   (rulings 176, 183 and 193):
 *   - `domain`'s `./browser` and `jobs`' `./selection`, which only the
 *     repository's web imports (G's S8 survey, open question 4);
 *   - `config`'s `.` and `./client`, which parse `process.env` at import,
 *     and `./redaction`, which no published entry imports (ruling 176);
 *   - `db`'s `./testing`, test support (owner question 6, answered by
 *     ruling 185), and `./e2e`, the E2E owner storage;
 *   - core's `./person-context`, which only the repository's web imports,
 *     and which ruling 230 item 3 does not publish;
 *   - `auth`'s `.` and `./server`, which install Better Auth from the
 *     process's environment as they are imported (ruling 193 item 3),
 *     `./client`, the browser's, and `./e2e`, the magic-link outbox, a test
 *     seam;
 *   - `server`'s every subpath but `.`: only the repository's web imports
 *     them;
 * - `migrations`: the migrations folder its `dist/` resolves as
 *   `../migrations` (G.0b): `db`'s, whose bundle inlines the migrator;
 * - `exemptions`: names exempt from the one-version rule, each taking the
 *   version of the workspace it names (`dependencyVersions`). No row names
 *   one;
 * - `pinnedPeers`: a peer of one of the package's dependencies that its
 *   packed manifest names too, by the dependency it is a peer of, at the
 *   version this tree installs for that dependency, which the lockfile fixes
 *   (`pinnedPeerVersions`; ruling 197 item 2). Unnamed, npm installs a peer
 *   at the newest version its range admits: measured at H.7's fourth round,
 *   `@react-email/render`'s `react-dom` peer took 19.3.0 and its own peer
 *   `react` 19.3.0 to the top of the install, and the 19.2.8 that
 *   `notifications` and `@requestport/web` name was nested under each, three
 *   copies of React in all. `notifications` pins `react-dom`, the peer
 *   through which `@react-email/render` renders, and the install holds one.
 */
const ROWS = Object.freeze({
  domain: { unpublished: ["./browser"] },
  notifications: {
    unpublished: [],
    pinnedPeers: { "react-dom": "@react-email/render" },
  },
  webhooks: { unpublished: [] },
  importer: { unpublished: [] },
  config: { unpublished: [".", "./client", "./redaction"] },
  db: {
    runtime: ["pg"],
    optionalPeers: ["@electric-sql/pglite"],
    unpublished: ["./e2e", "./testing"],
    migrations: "packages/db/migrations",
  },
  jobs: { unpublished: ["./selection"] },
  core: { unpublished: ["./person-context"] },
  auth: { unpublished: [".", "./client", "./e2e", "./server"] },
  mcp: { unpublished: [] },
  server: {
    unpublished: [
      "./artifact-import",
      "./auth",
      "./bearer-challenge",
      "./better-auth-errors",
      "./discovery",
      "./e2e-csp-fence",
      "./health",
      "./input-limits",
      "./mcp",
      "./project-scope",
      "./rate-limit",
      "./rest",
      "./security-headers",
      "./unauthorized",
    ],
  },
});

/**
 * The packages this script packs, by the key of their row in `bundle.mjs`'s
 * `bundles`, in the order it packs them, which is `buildOrder()`'s: each
 * after every package its source manifest depends on through `workspace:`.
 * Each row holds `ROWS`' fields, and:
 *
 * - `source`: its workspace, `packages/<key>`, whose manifest names it;
 * - `bundle`: its row in `bundles`;
 * - `license` and `licenseText`: §3.7's mapping, the SPDX expression of its
 *   packed `license` field and the text the script copies into its staged
 *   directory as `LICENSE`: Apache-2.0 for every package (ruling 175). The
 *   text is kept under `licenses/`; a `LICENSE` at the repository's root is
 *   the owner's (ruling 150), and none is in the tree.
 *   `package-contract.test.mjs` holds the mapping against the texts.
 */
export const PACKAGES = Object.freeze(
  Object.fromEntries(
    buildOrder().map((key) => {
      const row = ROWS[key];
      if (row === undefined) {
        throw new Error(
          `pack-packages: bundle.mjs builds ${key}, and no row of PACKAGES packs it.`,
        );
      }
      return [
        key,
        Object.freeze({
          source: `packages/${key}`,
          bundle: bundles[key],
          license: "Apache-2.0",
          licenseText: "licenses/Apache-2.0.txt",
          runtime: Object.freeze([...(row.runtime ?? [])]),
          optionalPeers: Object.freeze([...(row.optionalPeers ?? [])]),
          unpublished: Object.freeze([...row.unpublished]),
          migrations: row.migrations,
          exemptions: Object.freeze({ ...(row.exemptions ?? {}) }),
          pinnedPeers: Object.freeze({ ...(row.pinnedPeers ?? {}) }),
        }),
      ];
    }),
  ),
);

/**
 * The public repository (J question 5, ruling 175), which every packed
 * manifest's `repository` names in the shape ruling 207 item 3 gives: git,
 * the clone URL, and the package's workspace as `directory`
 * (`packedRepository`), with no `homepage` or `bugs`.
 */
export const PUBLIC_REPOSITORY = Object.freeze({
  type: "git",
  url: "git+https://github.com/crissmoldovan/requestport.git",
});

/**
 * The packed `repository` of the package built from `workspace`, its path
 * from the repository's root. The seed keeps every path it carries as it is
 * (manifest-j.md §2.1), so the path names the same directory there.
 */
export function packedRepository(workspace) {
  return { ...PUBLIC_REPOSITORY, directory: workspace };
}

/**
 * The name `copyLicence` gives the licence text in each staged directory,
 * which every packed manifest's `files` names (manifest-j.md §2.10). The
 * tarballs held it before any `files` named it, since pnpm packs a root
 * `LICENSE` whatever `files` says (manifest-g.md §3.7), so naming it adds
 * no file to a tarball.
 */
export const LICENCE_FILE = "LICENSE";

/**
 * What keeps `packed`, a tarball's `package.json`, from being option (B)'s
 * release candidate (J question 14, ruling 175; manifest-j.md §2.10), read
 * from the tarball alone, whatever the manifest the pack wrote says: a
 * `private` other than `false`, a `repository` other than
 * `packedRepository(workspace)`, and a `files` that does not name
 * `LICENCE_FILE`. `checkTarball` reports these, and so does
 * `pack-requestport.mjs`'s `checkRequestportTarball`.
 */
export function releaseFieldProblems(packed, workspace) {
  const problems = [];
  if (packed.private !== false) {
    problems.push("package.json does not say private: false");
  }
  const repository = packedRepository(workspace);
  if (!isDeepStrictEqual(packed.repository, repository)) {
    problems.push(
      `package.json's repository is ${JSON.stringify(packed.repository)}, not the public repository's ${JSON.stringify(repository)}`,
    );
  }
  if (!Array.isArray(packed.files) || !packed.files.includes(LICENCE_FILE)) {
    problems.push(`package.json's files does not name ${LICENCE_FILE}`);
  }
  return problems;
}

/** What every file of a packed tarball must not hold: the E2E owner storage. */
const E2E_OWNER_STORAGE =
  /createE2EOwnerStorage|E2E_OWNER_STORAGE_REFUSED|E2E owner storage/u;

/** The private module the pack reads digests from, by its path from the root. */
export const PRIVATE_MODULE = "packages/db/src/shared-databases.ts";

/**
 * Each digest `module`'s entries name, with the entry and field that name it;
 * by default `PRIVATE_MODULE`'s, which in this tree are production's host,
 * and staging's host and database name, and in the public seed, whose
 * variant names no entry, none. No file of a tarball may hold one (ruling 183
 * item 9); a problem names the entry and field, never the digest.
 */
export function privateDigests(module = sharedDatabases) {
  return module.entries.flatMap((entry) =>
    ["hostSha256", "databaseNameSha256"]
      .filter((field) => typeof entry[field] === "string")
      .map((field) => ({
        label: `${entry.name}'s ${field}`,
        digest: entry[field],
      })),
  );
}

const PRIVATE_DIGESTS = privateDigests();

/**
 * A private module's `kind` marker as esbuild writes it into a bundle,
 * `var kind = "private";`, under any name esbuild gives the binding. Each
 * module of `publicVariants` assigns it, each public variant assigns
 * `"public"`, and a declaration types `kind` without assigning it. The
 * marker does not say which module wrote it, so its refusal names none.
 */
const PRIVATE_KIND = /\bkind\w*\s*=\s*["'`]private["'`]/u;

/**
 * Each doc comment of a private module that its public variant lacks
 * (`bundle.mjs`'s `privateDocComments`): what a declaration that inlines
 * the module holds of it, whether or not rolldown gives the module a
 * `//#region`. In the public seed, none.
 */
const PRIVATE_DOC_COMMENTS = privateDocComments();

/**
 * What `text`, the body of a tarball's file at `path`, holds of a private
 * module (ruling 183 item 9): each digest `PRIVATE_MODULE` names, a private
 * module's `kind = "private"` marker (`PRIVATE_KIND`, which names no module),
 * and each private module of which it holds a doc comment that the module's
 * public variant lacks. `checkTarball` reads it for
 * every file, and `scripts/pack-requestport.mjs` for every file of
 * `requestport`'s and `@requestport/web`'s tarballs. A module comment or
 * `//#region` that names a private module is `checkTarball`'s own check.
 */
export function privateModuleProblems(path, text) {
  const problems = [];
  for (const { label, digest } of PRIVATE_DIGESTS) {
    if (text.includes(digest)) {
      problems.push(`${path} holds ${label} from ${PRIVATE_MODULE}`);
    }
  }
  if (PRIVATE_KIND.test(text)) {
    problems.push(`${path} holds a private module's kind = "private" marker`);
  }
  const heldDocComments = new Set();
  for (const { module, comment } of PRIVATE_DOC_COMMENTS) {
    if (holdsDocComment(text, comment)) {
      heldDocComments.add(module);
    }
  }
  for (const module of heldDocComments) {
    problems.push(
      `${path} holds a doc comment of the private module ${module} that its public variant ${publicVariants[module]} lacks`,
    );
  }
  return problems;
}

/** A version the script stamps: `major.minor.patch`, and a prerelease. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

/**
 * The packed packages exempt, by name, from Done when 9's "no Better Auth
 * among the dependencies": `auth`, which composes Better Auth (manifest-g.md
 * §2.7 (a) keeps it out of the set's packages; ruling 190 packs `auth` with
 * them).
 */
export const BETTER_AUTH_EXEMPT = Object.freeze(["@requestport/auth"]);

/**
 * A dependency the package named `packed` may not name: a workspace package
 * its bundle inlines rather than leaves external, Better Auth unless
 * `packed` is exempt by name, or Trigger.dev (manifest-g.md §2.5.1, §2.4,
 * Done when 9).
 */
export function forbiddenDependency(bundle, name, packed) {
  return (
    (name.startsWith("@requestport/") && !bundle.external.includes(name)) ||
    ((name === "better-auth" || name.startsWith("@better-auth/")) &&
      !BETTER_AUTH_EXEMPT.includes(packed)) ||
    name.startsWith("@trigger.dev/")
  );
}

/** Refuses a version this script would not stamp. */
export function refuseVersion(version) {
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error(
      `pack-packages: --version must be major.minor.patch, with an optional prerelease; got ${JSON.stringify(version)}.`,
    );
  }
}

/** Refuses a directory inside the repository: the script stages outside it. */
export function refuseInsideRepository(directory) {
  const path = relative(repositoryRoot, resolve(directory));
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) {
    throw new Error(
      `pack-packages: ${directory} is inside the repository; it stages outside it.`,
    );
  }
}

/** `git status --porcelain` at the repository's root. */
export function readTreeStatus() {
  return git(["status", "--porcelain"]);
}

function git(args) {
  const run = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (run.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${run.status}: ${run.stderr}`,
    );
  }
  return run.stdout;
}

/** Each `packages/*` workspace's manifest, by its directory from the root. */
export function readWorkspaceManifests() {
  const manifests = new Map();
  for (const entry of readdirSync(join(repositoryRoot, "packages"))) {
    const path = join(repositoryRoot, "packages", entry, "package.json");
    if (existsSync(path)) {
      manifests.set(
        `packages/${entry}`,
        JSON.parse(readFileSync(path, "utf8")),
      );
    }
  }
  return manifests;
}

let parse;
/** rolldown's parser, from core's own devDependencies, as `bundle.mjs` uses. */
async function parser() {
  if (parse === undefined) {
    const fromCore = createRequire(
      join(repositoryRoot, "packages/core/package.json"),
    );
    ({ parseAst: parse } = await import(
      pathToFileURL(fromCore.resolve("rolldown/parseAst")).href
    ));
  }
  return parse;
}

/* A loose view of the ESTree that rolldown's parser returns. */
function isNode(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.type === "string"
  );
}

function* descendants(node) {
  yield node;
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child)) yield* descendants(child);
    }
  }
}

function stringLiteral(node) {
  return isNode(node) &&
    node.type === "Literal" &&
    typeof node.value === "string"
    ? node.value
    : undefined;
}

/** An expression without the type assertions TypeScript wraps around it. */
function unwrap(node) {
  let current = node;
  while (
    isNode(current) &&
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TSTypeAssertion",
    ].includes(current.type)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * The source scan (G.0b): every package a module loads at run time through a
 * `require` it makes itself, which esbuild does not follow. In each module it finds
 * the `createRequire` that `node:module` exports, imported by name or through
 * a namespace, and `process.getBuiltinModule("node:module").createRequire`;
 * then every binding of what one of them returns; then every call through
 * such a binding, or through a factory called in place. A call whose first
 * argument is not a string literal is returned with `specifier: undefined`.
 *
 * `modules` are paths from the repository's root, or absolute.
 */
export async function runtimeRequires(modules) {
  const parseAst = await parser();
  const found = new Map();
  for (const module of modules) {
    const program = parseAst(
      readFileSync(resolve(repositoryRoot, module), "utf8"),
      { lang: module.endsWith(".tsx") ? "tsx" : "ts" },
    );
    const factories = new Set();
    const namespaces = new Set();
    for (const node of program.body) {
      if (
        node.type !== "ImportDeclaration" ||
        !["node:module", "module"].includes(stringLiteral(node.source))
      ) {
        continue;
      }
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier") {
          const imported = specifier.imported.name ?? specifier.imported.value;
          if (imported === "createRequire") factories.add(specifier.local.name);
        } else {
          namespaces.add(specifier.local.name);
        }
      }
    }
    const isFactory = (expression) => {
      const callee = unwrap(expression);
      if (callee?.type === "Identifier") return factories.has(callee.name);
      if (
        callee?.type !== "MemberExpression" ||
        callee.computed ||
        callee.property.name !== "createRequire"
      ) {
        return false;
      }
      const object = unwrap(callee.object);
      if (object?.type === "Identifier") return namespaces.has(object.name);
      if (object?.type !== "CallExpression") return false;
      const getter = unwrap(object.callee);
      return (
        getter?.type === "MemberExpression" &&
        !getter.computed &&
        unwrap(getter.object)?.type === "Identifier" &&
        unwrap(getter.object).name === "process" &&
        getter.property.name === "getBuiltinModule" &&
        ["node:module", "module"].includes(
          stringLiteral(unwrap(object.arguments[0])),
        )
      );
    };
    const isFactoryCall = (node) =>
      unwrap(node)?.type === "CallExpression" && isFactory(unwrap(node).callee);

    const requires = new Set();
    for (const node of descendants(program)) {
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        isFactoryCall(node.init)
      ) {
        requires.add(node.id.name);
      }
    }
    for (const node of descendants(program)) {
      if (node.type !== "CallExpression") continue;
      const callee = unwrap(node.callee);
      if (
        (callee?.type === "Identifier" && requires.has(callee.name)) ||
        isFactoryCall(callee)
      ) {
        const specifier = stringLiteral(unwrap(node.arguments[0]));
        found.set(`${module}\0${specifier}`, { module, specifier });
      }
    }
  }
  const key = ({ module, specifier }) => `${module}\0${specifier}`;
  return [...found.values()].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
}

/**
 * What the source scan found that the tarball would not provide: a package in
 * none of the bundle's externals, the run-time list and the optional peers; a
 * path, which resolves from `dist/` to nothing the tarball carries; a call it
 * cannot read; and a run-time list entry that no call loads.
 */
export function unaccountedRequires(
  requires,
  { external, runtime, optionalPeers },
) {
  const accepted = new Set([...external, ...runtime, ...optionalPeers]);
  const problems = [];
  for (const { module, specifier } of requires) {
    if (specifier === undefined) {
      problems.push(
        `${module} requires something that is not a string literal`,
      );
    } else if (specifier.startsWith(".") || isAbsolute(specifier)) {
      problems.push(
        `${module} requires the path ${specifier} at run time, which the tarball does not carry`,
      );
    } else if (!isBuiltin(specifier) && !accepted.has(packageName(specifier))) {
      problems.push(
        `${module} requires ${specifier} at run time, and ${packageName(specifier)} is none of the bundle's externals, the run-time list and the optional peers`,
      );
    }
  }
  const loaded = new Set(
    requires
      .filter(({ specifier }) => specifier !== undefined)
      .map(({ specifier }) => packageName(specifier)),
  );
  for (const name of runtime) {
    if (!loaded.has(name)) {
      problems.push(
        `the run-time list names ${name}, which no module of the bundle requires at run time`,
      );
    }
  }
  return problems;
}

/** The third-party packages a build's JavaScript imports, `node:` builtins aside. */
export function externalPackages(metafile) {
  return [
    ...new Set(
      Object.values(metafile.outputs).flatMap(({ imports }) =>
        imports
          .filter(({ external, path }) => external && !isBuiltin(path))
          .map(({ path }) => packageName(path)),
      ),
    ),
  ].sort();
}

/** The packages the bundled declarations import by a bare specifier. */
export async function declarationPackages(dist, files) {
  const parseAst = await parser();
  const names = new Set();
  for (const file of files) {
    const program = parseAst(readFileSync(join(dist, file), "utf8"), {
      lang: "dts",
    });
    for (const node of descendants(program)) {
      if (
        ![
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
          "TSImportType",
        ].includes(node.type)
      ) {
        continue;
      }
      const specifier = stringLiteral(node.source);
      if (
        specifier !== undefined &&
        !specifier.startsWith(".") &&
        !specifier.startsWith("/") &&
        !isBuiltin(specifier)
      ) {
        names.add(packageName(specifier));
      }
    }
  }
  return [...names].sort();
}

/**
 * The version of each name, as the workspaces whose modules the bundle
 * inlines declare it: `dependencies` for a dependency; `dependencies`,
 * `devDependencies` or `peerDependencies` for an optional peer, which a
 * workspace may declare only to test with. A name that none of them
 * declares, that one declares as a workspace package, or that they declare
 * at two versions, is a problem, but for two cases:
 *
 * - a workspace package this run packs, in `packed`, which the workspaces
 *   declare as `workspace:` and which is named at the version `packed`
 *   gives it, the stamped one (§3.4);
 * - a name in `exemptions`, which takes the version the workspace it names
 *   declares, whatever the others declare. An exemption that no disagreement
 *   needs, or whose workspace is not one of `workspaces` declaring the name,
 *   is a problem too.
 */
export function dependencyVersions({
  names,
  peers,
  workspaces,
  manifests,
  packed = {},
  exemptions = {},
}) {
  const problems = [];
  const pick = (name, fields) => {
    const declared = new Map();
    for (const workspace of workspaces) {
      const manifest = manifests.get(workspace);
      for (const field of fields) {
        const version = manifest?.[field]?.[name];
        if (version === undefined) continue;
        declared.set(version, [...(declared.get(version) ?? []), workspace]);
      }
    }
    if (declared.size === 0) {
      problems.push(
        `${name}: no workspace the bundle inlines declares it (${fields.join(", ")})`,
      );
      return undefined;
    }
    if (Object.hasOwn(packed, name)) {
      const linked = [...declared.keys()].every((version) =>
        version.startsWith("workspace:"),
      );
      if (!linked) {
        problems.push(
          `${name} is packed in this run, and a workspace declares it at ${[...declared.keys()].join(", ")}`,
        );
        return undefined;
      }
      return packed[name];
    }
    if (Object.hasOwn(exemptions, name)) {
      const workspace = exemptions[name];
      const [version] =
        [...declared].find(([, by]) => by.includes(workspace)) ?? [];
      if (version === undefined) {
        problems.push(
          `${name} is exempted to ${workspace}'s version, and ${workspace} is not a workspace the bundle inlines that declares it`,
        );
        return undefined;
      }
      if (declared.size === 1) {
        problems.push(
          `${name}'s exemption is not needed: every workspace the bundle inlines declares ${version}`,
        );
        return undefined;
      }
      return version;
    }
    if (declared.size > 1) {
      problems.push(
        `${name} is declared at more than one version: ${[...declared]
          .map(([version, by]) => `${version} by ${by.join(", ")}`)
          .join("; ")}`,
      );
      return undefined;
    }
    const [version] = declared.keys();
    if (version.startsWith("workspace:")) {
      problems.push(`${name} is a workspace package (${version})`);
      return undefined;
    }
    return version;
  };
  const dependencies = {};
  for (const name of [...names].sort()) {
    const version = pick(name, ["dependencies"]);
    if (version !== undefined) dependencies[name] = version;
  }
  const peerDependencies = {};
  for (const name of [...peers].sort()) {
    const version = pick(name, [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]);
    if (version !== undefined) peerDependencies[name] = version;
  }
  return { dependencies, peerDependencies, problems };
}

/** The workspaces whose modules are among a build's inputs. */
function workspacesOf(inputs) {
  return [
    ...new Set(
      inputs
        .map((input) => /^packages\/[^/]+(?=\/)/u.exec(input)?.[0])
        .filter((workspace) => workspace !== undefined),
    ),
  ].sort();
}

/** The packed manifest (step 4 of this module's header). */
export function packedManifest(
  pack,
  { version, dependencies, peerDependencies, notices = false },
) {
  const source = JSON.parse(
    readFileSync(join(repositoryRoot, pack.source, "package.json"), "utf8"),
  );
  const root = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  return {
    name: source.name,
    version,
    private: false,
    type: "module",
    license: pack.license,
    repository: packedRepository(pack.source),
    exports: Object.fromEntries(
      pack.bundle.entries.map(({ subpath, name }) => [
        subpath,
        { types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` },
      ]),
    ),
    files: [
      LICENCE_FILE,
      ...(notices ? [NOTICES_FILE] : []),
      "dist",
      ...(pack.migrations === undefined ? [] : ["migrations"]),
    ],
    engines: { node: root.engines.node },
    dependencies,
    peerDependencies,
    peerDependenciesMeta: Object.fromEntries(
      Object.keys(peerDependencies).map((name) => [name, { optional: true }]),
    ),
  };
}

/**
 * Node's lookup of the package `name` from `directory`: each ancestor's
 * `node_modules`, the nearest first, from `directory`'s real path, as pnpm's
 * install lays them out, up to the repository's root and no further. Answers
 * the package's real directory and its manifest, or `undefined`.
 */
function installedPackage(directory, name) {
  const root = realpathSync(repositoryRoot);
  for (let at = realpathSync(directory); ; at = dirname(at)) {
    if (basename(at) !== "node_modules") {
      const candidate = join(at, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) {
        const real = realpathSync(candidate);
        return {
          directory: real,
          manifest: JSON.parse(
            readFileSync(join(real, "package.json"), "utf8"),
          ),
        };
      }
    }
    if (at === root || at === dirname(at)) return undefined;
  }
}

/**
 * The peers `pack` pins (`ROWS`' `pinnedPeers`; ruling 197 item 2), against
 * the `dependencies` its packed manifest names: for each peer and the
 * dependency it is a peer of, the version of the peer this tree installs
 * for that dependency, as `pack`'s workspace resolves the dependency. A
 * problem where the packed manifest does not name the dependency, the
 * dependency names no such peer, or either is not installed.
 */
export function pinnedPeerVersions(pack, dependencies) {
  const pinned = {};
  const problems = [];
  for (const [peer, via] of Object.entries(pack.pinnedPeers ?? {})) {
    if (!Object.hasOwn(dependencies, via)) {
      problems.push(
        `${peer} is pinned as ${via}'s peer, and ${pack.source}'s packed manifest does not depend on ${via}`,
      );
      continue;
    }
    const dependency = installedPackage(join(repositoryRoot, pack.source), via);
    if (dependency === undefined) {
      problems.push(`${via} is not installed for ${pack.source}`);
      continue;
    }
    if (!Object.hasOwn(dependency.manifest.peerDependencies ?? {}, peer)) {
      problems.push(
        `${peer} is pinned as ${via}'s peer, and ${via}@${dependency.manifest.version} names no such peer`,
      );
      continue;
    }
    const installed = installedPackage(dependency.directory, peer);
    if (installed === undefined) {
      problems.push(
        `${peer}, ${via}'s peer, is not installed for ${pack.source}`,
      );
      continue;
    }
    pinned[peer] = installed.manifest.version;
  }
  return { dependencies: pinned, problems };
}

/**
 * Copies the licence text `pack`'s mapping names into `directory` as
 * `LICENSE` (`LICENCE_FILE`; §3.7; ruling 139), and returns that name, from
 * `directory`.
 */
export function copyLicence(pack, directory) {
  copyFileSync(
    join(repositoryRoot, pack.licenseText),
    join(directory, LICENCE_FILE),
  );
  return LICENCE_FILE;
}

/**
 * The name of the notices file a tarball carries for the third-party code
 * it holds: `@requestport/web`'s (`pack-requestport.mjs`'s `NOTICES.file`),
 * and, written here, that of each of the eleven in which the repository's
 * notices list third-party code as bundled (`bundledNotices`; ruling 209
 * item 1).
 */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES";

/**
 * Where a tree holds the repository's notices, which J.3's licence audit
 * writes from `release/licence-policy.json` and fails on when they differ
 * from its regeneration: `release/public/THIRD_PARTY_NOTICES` in this tree,
 * and `THIRD_PARTY_NOTICES` in the public seed, which the export adds there
 * from that file (`release/public-tree.json`'s `add`) and which carries no
 * `release/`. The pack reads whichever of the two the tree holds, and
 * refuses a tree that holds both or neither.
 */
export const REPOSITORY_NOTICES = Object.freeze([
  "release/public/THIRD_PARTY_NOTICES",
  "THIRD_PARTY_NOTICES",
]);

/** The line above each entry of the repository's notices (`licence-audit.mjs`'s). */
const REPOSITORY_NOTICES_RULE = "-".repeat(72);

/**
 * An entry's heading in the repository's notices, for third-party code a
 * package bundles: `<name>@<version> (bundled in <package>)`, as
 * `licence-audit.mjs` keys an entry with `bundledIn`.
 */
const BUNDLED_HEADING = /^(\S+@\S+) \(bundled in (\S+)\)$/u;

/**
 * Each entry the repository's notices (`REPOSITORY_NOTICES`, under `root`)
 * list as bundled in `name`, as that file holds it: from its heading to the
 * end of its last line, with that line's newline. Throws when the tree
 * holds both of the notices' paths or neither, or when such an entry says
 * the package is built from another workspace than `source`.
 */
export function bundledEntries(name, source, root = repositoryRoot) {
  const held = REPOSITORY_NOTICES.filter((path) =>
    existsSync(join(root, path)),
  );
  if (held.length !== 1) {
    throw new Error(
      `pack-packages: the repository's notices must be at exactly one of ${REPOSITORY_NOTICES.join(" and ")}; this tree holds ${held.length === 0 ? "neither" : "both"}.`,
    );
  }
  const [path] = held;
  const text = readFileSync(join(root, path), "utf8");
  const entries = [];
  for (const entry of text.split(`\n${REPOSITORY_NOTICES_RULE}\n`).slice(1)) {
    const [heading] = entry.split("\n", 1);
    const bundled = BUNDLED_HEADING.exec(heading);
    if (bundled === null || bundled[2] !== name) continue;
    const carried = `Carried in:\n  the npm tarball of ${name}, built from ${source}\n`;
    if (!entry.includes(carried)) {
      throw new Error(
        `pack-packages: ${path}'s entry ${heading} does not say it is carried in the npm tarball of ${name}, built from ${source}.`,
      );
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * The `THIRD-PARTY-NOTICES` (`NOTICES_FILE`) the stage writes for `pack`
 * (ruling 209 item 1): `undefined` where the repository's notices list
 * nothing bundled in its package (`bundledEntries`), and otherwise a header
 * that names the package, then each entry they list as bundled in it, below
 * their rule, byte for byte as they hold it. Of the eleven, `db` alone has
 * one today: esbuild's runtime helpers, which its bundle writes into
 * `dist/` (`release/licence-policy.json`'s one `bundledIn` entry; ruling 207
 * item 9).
 */
export function bundledNotices(pack, root = repositoryRoot) {
  const name = pack.bundle.package;
  const entries = bundledEntries(name, pack.source, root);
  if (entries.length === 0) return undefined;
  const header = [
    `Third-party notices for ${name}`,
    "",
    "This package's dist/ holds third-party code. Each entry below names",
    "that code, the licence it is under and that licence's text. The",
    "entries are the ones the RequestPort repository's THIRD_PARTY_NOTICES",
    "lists as bundled in this package, copied from that file as they are.",
  ].join("\n");
  return `${header}\n${entries
    .map((entry) => `\n${REPOSITORY_NOTICES_RULE}\n${entry}`)
    .join("")}`;
}

/**
 * esbuild's runtime helpers (ruling 209 item 2): the 64 names esbuild
 * 0.28.2's runtime binds at its top level, read with `strings` from the
 * runtime source its darwin-arm64 binary embeds (`var __defProp =
 * Object.defineProperty`, `export var __export = (target, all) => …`, and
 * the rest); `pack-packages.test.mjs` holds the list equal to the names
 * that source declares in the binary `packages/core`'s esbuild installs.
 * In unminified ESM or CommonJS output, esbuild writes each helper a
 * bundle needs as a `var __<name> = ` binding at the start of a line,
 * above the modules that call it, and both bundlers here write unminified
 * ESM (`packages/core/bundle.mjs` and
 * `apps/requestport/bundle.mjs`: `format: "esm"`, no `minify`):
 * `@requestport/db`'s chunk opens with `__defProp` and `__export`, which
 * build the namespace objects of its modules' `import * as` bindings
 * (`client.ts`'s `schema`, `database-url.ts`'s `sharedDatabases`). A
 * binding of RequestPort's own with one of these names is counted too; a
 * helper a later esbuild adds is not, until it is listed here. Output
 * written any other way hides the helpers from `esbuildHelpersIn`: a
 * minifier that renames the bindings, as Next's build does in
 * `@requestport/web`'s chunks; one that only drops whitespace, which
 * writes `var __defProp=…;var __export=…` on one line; and an IIFE, which
 * indents them.
 */
export const ESBUILD_RUNTIME_HELPERS = Object.freeze([
  "__accessCheck",
  "__async",
  "__asyncGenerator",
  "__await",
  "__callDispose",
  "__commonJS",
  "__commonJSMin",
  "__copyProps",
  "__create",
  "__decorateClass",
  "__decorateElement",
  "__decorateParam",
  "__decoratorContext",
  "__decoratorMetadata",
  "__decoratorStart",
  "__decoratorStrings",
  "__defNormalProp",
  "__defProp",
  "__defProps",
  "__earlyAccess",
  "__esm",
  "__esmMin",
  "__expectFn",
  "__export",
  "__forAwait",
  "__freeze",
  "__getOwnPropDesc",
  "__getOwnPropDescs",
  "__getOwnPropNames",
  "__getOwnPropSymbols",
  "__getProtoOf",
  "__glob",
  "__hasOwnProp",
  "__knownSymbol",
  "__name",
  "__objRest",
  "__pow",
  "__privateAdd",
  "__privateGet",
  "__privateIn",
  "__privateMethod",
  "__privateSet",
  "__privateWrapper",
  "__propIsEnum",
  "__publicField",
  "__reExport",
  "__reflectGet",
  "__reflectSet",
  "__require",
  "__restKey",
  "__runInitializers",
  "__spreadProps",
  "__spreadValues",
  "__superGet",
  "__superSet",
  "__superWrapper",
  "__template",
  "__toBinary",
  "__toBinaryNode",
  "__toCommonJS",
  "__toESM",
  "__typeError",
  "__using",
  "__yieldStar",
]);

/** `ESBUILD_RUNTIME_HELPERS`, to look a name up in. */
const ESBUILD_HELPER_NAMES = new Set(ESBUILD_RUNTIME_HELPERS);

/** The esbuild runtime helpers `text` binds at the start of a line, in order. */
export function esbuildHelpersIn(text) {
  return [...text.matchAll(/^var (__[A-Za-z]+) = /gmu)]
    .map((match) => match[1])
    .filter((name) => ESBUILD_HELPER_NAMES.has(name));
}

/**
 * Whether a notices text has an entry for esbuild: a heading, just below
 * an entry's rule, that names `esbuild@<version>`, in either form a
 * tarball's notices take: the repository's (`esbuild@0.28.2 (bundled in
 * @requestport/db)`, below 72 `-`), which `bundledNotices` copies, or
 * `@requestport/web`'s (`Package: esbuild@…`, below 80 `=`).
 */
export function noticesNameEsbuild(text) {
  return /^(?:-{72}|={80})\n(?:Package: )?esbuild@\S/mu.test(text);
}

/**
 * Copies the SQL file of each journal entry and the journal into
 * `<directory>/migrations`, and returns what it copied, from `directory`. An
 * SQL file that the journal does not name is refused, not dropped.
 */
export function copyMigrations(folder, directory) {
  const from = join(repositoryRoot, folder);
  const journal = JSON.parse(
    readFileSync(join(from, "meta/_journal.json"), "utf8"),
  );
  const named = journal.entries.map(({ tag }) => `${tag}.sql`);
  const present = readdirSync(from).filter((file) => file.endsWith(".sql"));
  const unnamed = present.filter((file) => !named.includes(file));
  const absent = named.filter((file) => !present.includes(file));
  if (unnamed.length > 0 || absent.length > 0) {
    throw new Error(
      `pack-packages: ${folder} and its journal disagree: not in the journal ${JSON.stringify(unnamed)}, missing ${JSON.stringify(absent)}`,
    );
  }
  mkdirSync(join(directory, "migrations/meta"), { recursive: true });
  const copied = [...named, "meta/_journal.json"];
  for (const file of copied) {
    copyFileSync(join(from, file), join(directory, "migrations", file));
  }
  return copied.map((file) => `migrations/${file}`).sort();
}

/**
 * Builds `pack`'s bundle into `directory`, which must be outside the
 * repository and empty or absent, with `bundle.mjs`'s `buildPackage`, which
 * refuses a build that inlines another package's module or imports a subpath
 * no row of `bundles` publishes; runs the source scan and the version rule,
 * copies the licence text and the migrations, and writes the packed manifest.
 * Returns what the tarball check needs.
 */
export async function stagePackage(pack, { version, directory }) {
  refuseVersion(version);
  refuseInsideRepository(directory);
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    throw new Error(`pack-packages: ${directory} is not empty.`);
  }
  // Read before the build, so that a tree holding the repository's notices
  // at both of their paths, or at neither, is refused before anything is
  // built (ruling 209 item 1).
  const notices = bundledNotices(pack);
  const { metafile, declarations } = await buildPackage(pack.bundle, directory);
  const dist = join(directory, "dist");
  const inputs = Object.keys(metafile.inputs).sort();
  const external = externalPackages(metafile);
  const requires = await runtimeRequires(inputs);
  const typed = await declarationPackages(dist, declarations);
  const manifests = readWorkspaceManifests();
  const versions = dependencyVersions({
    names: new Set([...external, ...pack.runtime, ...typed]),
    peers: pack.optionalPeers,
    workspaces: workspacesOf(inputs),
    manifests,
    // Every package of the run is packed at the one stamped version.
    packed: Object.fromEntries(
      Object.values(PACKAGES).map(({ source }) => [
        manifests.get(source).name,
        version,
      ]),
    ),
    exemptions: pack.exemptions,
  });
  const pinned = pinnedPeerVersions(pack, versions.dependencies);
  const problems = [
    ...unaccountedRequires(requires, {
      external,
      runtime: pack.runtime,
      optionalPeers: pack.optionalPeers,
    }),
    ...versions.problems,
    ...pinned.problems,
  ];
  if (problems.length > 0) {
    throw new Error(
      `pack-packages refuses ${pack.source}:\n- ${problems.join("\n- ")}`,
    );
  }
  const licence = copyLicence(pack, directory);
  if (notices !== undefined) {
    writeFileSync(join(directory, NOTICES_FILE), notices);
  }
  const migrations =
    pack.migrations === undefined
      ? []
      : copyMigrations(pack.migrations, directory);
  const manifest = packedManifest(pack, {
    version,
    notices: notices !== undefined,
    ...versions,
    dependencies: Object.fromEntries(
      Object.entries({ ...versions.dependencies, ...pinned.dependencies }).sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
      ),
    ),
  });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const javascript = Object.keys(metafile.outputs).map((output) =>
    relative(directory, resolve(repositoryRoot, output)),
  );
  return {
    pack,
    directory,
    manifest,
    inputs,
    external,
    requires,
    bundledNotices: notices,
    allowList: [
      "package.json",
      licence,
      ...(notices === undefined ? [] : [NOTICES_FILE]),
      ...javascript,
      ...declarations.map((file) => `dist/${file}`),
      ...migrations,
    ].sort(),
  };
}

/**
 * `pnpm pack` on a staged directory, run from the repository's root so that
 * corepack picks the pnpm its `packageManager` pins. Returns the tarball's
 * path, in `destination`.
 */
export function packStaged(directory, destination) {
  mkdirSync(destination, { recursive: true });
  const run = spawnSync(
    "pnpm",
    ["--dir", directory, "pack", "--pack-destination", destination, "--json"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (run.status !== 0) {
    throw new Error(
      `pnpm pack exited ${run.status}: ${run.stdout}${run.stderr}`,
    );
  }
  const { filename } = JSON.parse(run.stdout);
  return isAbsolute(filename) ? filename : join(destination, filename);
}

/** The pnpm that packs: `pnpm --version` from the repository's root. */
export function pnpmVersion() {
  const run = spawnSync("pnpm", ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`pnpm --version: ${run.stderr}`);
  return run.stdout.trim();
}

/**
 * A gzipped tar's regular files, by path, read without a `tar` program. Any
 * entry but a file or a directory, a link or a pax header among them, is
 * refused rather than read past.
 */
export function readTarball(file) {
  const bytes = gunzipSync(readFileSync(file));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0[\s\S]*$/u, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    const name = prefix === "" ? field(0, 100) : `${prefix}/${field(0, 100)}`;
    const body = Buffer.from(bytes.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "0") {
      entries.set(name, body);
    } else if (type !== "5") {
      throw new Error(`${file}: ${name} is a tar entry of type ${type}`);
    }
  }
  return entries;
}

/**
 * This machine's paths, which no packed file may hold in any of their forms
 * (`machinePathProblems`): the repository, the temporary directory, the home
 * directory and the staging directory, each as given and as resolved.
 */
export function machinePaths(directory) {
  const resolved = (path) => (existsSync(path) ? realpathSync(path) : path);
  return [
    ...new Set(
      [repositoryRoot, tmpdir(), homedir(), directory]
        .flatMap((path) => [path, resolved(path)])
        .map((path) => path.replace(/\/+$/u, "")),
    ),
  ].filter((path) => path.length > 1);
}

/**
 * The forms a path takes in what a build writes, each a function of it: as
 * written; with every `/` escaped as JSON may write it (`\/`); as a `file://`
 * URL's path, which `pathToFileURL` percent-encodes; and percent-encoded
 * whole, as `encodeURIComponent` writes it (rulings 110, 145 and 170, which
 * H.7's pack read first; ruling 197 item 3 holds every tarball to them).
 */
export const PATH_FORMS = Object.freeze([
  (path) => path,
  (path) => path.replaceAll("/", "\\/"),
  (path) => pathToFileURL(path).pathname,
  (path) => encodeURIComponent(path),
]);

/** Each form of `path` (`PATH_FORMS`), once. */
export function pathForms(path) {
  return [...new Set(PATH_FORMS.map((form) => form(path)))];
}

/**
 * Each of `paths` that `body` holds in any of its forms (`pathForms`), as a
 * problem of `file`. `body` is a string or a `Buffer`, which is searched for
 * each form's UTF-8 bytes, so a binary file is read too.
 */
export function machinePathProblems(file, body, paths) {
  const problems = [];
  for (const path of paths) {
    const form = pathForms(path).find((candidate) => body.includes(candidate));
    if (form !== undefined) {
      problems.push(
        form === path
          ? `${file} holds ${path}`
          : `${file} holds ${path}, as ${form}`,
      );
    }
  }
  return problems;
}

/**
 * A `workspace:` specifier, as pnpm's workspace protocol writes one:
 * `workspace:` and then `*`, `^`, `~`, a version, or a relative path, or,
 * in pnpm's alias form, a package name and `@` before the range
 * (`workspace:<name>@<range>`; ruling 170). Not the word alone: RequestPort's
 * own strings hold it (the scope `workspace:telemetry:reveal`, a
 * `web:workspace:reveal:` key, `slack_workspace:`), in `domain`'s, `db`'s,
 * core's and `server`'s tarballs and `@requestport/web`'s chunks; and not a
 * name and `@` before anything but a range (`workspace:owner@example.com`).
 * A packed `package.json` may not hold the word at all (`checkTarball`).
 */
export const WORKSPACE_SPECIFIER =
  /workspace:(?:(?:@[\w.-]+\/)?[\w.-]+@)?(?:[*^~]|\d|\.{1,2}\/)/u;

/** A module path a comment names: from the repository's root, inside it. */
function insideRepository(path) {
  return !isAbsolute(path) && !path.split("/").includes("..");
}

/** A module's path without its extension: `.ts`, `.tsx`, `.d.ts`, `.js` or `.mjs`. */
function stem(path) {
  return path.replace(/(?:\.d)?\.(?:ts|tsx|js|mjs)$/u, "");
}

/**
 * Whether a module a comment names, by its path from the repository's root,
 * is `pack`'s: in its own workspace, or one its row inlines, compared without
 * the extension, because a declaration region names `x.d.ts` for `x.ts`.
 */
function ownModule(pack, module) {
  return (
    module.startsWith(`${pack.source}/`) ||
    pack.bundle.inlines.some((inlined) => stem(inlined) === stem(module))
  );
}

let workspaceNames;
/** The package whose workspace holds `module`, by its manifest's name. */
function ownerOf(module) {
  workspaceNames ??= readWorkspaceManifests();
  for (const [directory, manifest] of workspaceNames) {
    if (module.startsWith(`${directory}/`)) return manifest.name;
  }
  return "no workspace";
}

/**
 * Every problem with a tarball, against what `stagePackage` staged: an empty
 * list is a tarball this script accepts (step 7 of this module's header).
 */
export function checkTarball(entries, staged) {
  const { pack, manifest: written, allowList, directory } = staged;
  const problems = [];
  const files = new Map();
  for (const [path, body] of entries) {
    if (path.startsWith("package/"))
      files.set(path.slice("package/".length), body);
    else problems.push(`${path} is outside package/`);
  }

  for (const path of files.keys()) {
    if (!allowList.includes(path))
      problems.push(`${path} is not on the allow-list`);
  }
  for (const path of allowList) {
    if (!files.has(path))
      problems.push(`${path} is on the allow-list but not in the tarball`);
  }

  const machine = machinePaths(directory);
  for (const [path, body] of files) {
    const name = basename(path);
    if (/\.test\./u.test(name)) problems.push(`${path} is a test`);
    if (name.startsWith(".env"))
      problems.push(`${path} is an environment file`);
    if (name.endsWith(".map")) problems.push(`${path} is a source map`);
    if (path.includes("test-support/"))
      problems.push(`${path} is test support`);
    if (path.includes("tenant-scope-sweep"))
      problems.push(`${path} is the sweep's ledger`);
    const text = body.toString("utf8");
    if (E2E_OWNER_STORAGE.test(text)) {
      problems.push(`${path} holds the E2E owner storage`);
    }
    for (const { seam, marker } of seamMarkersIn(text)) {
      problems.push(`${path} holds ${seam.name} (${marker})`);
    }
    problems.push(...privateModuleProblems(path, text));
    problems.push(...machinePathProblems(path, body, machine));
    if (
      path !== "package.json" &&
      WORKSPACE_SPECIFIER.test(body.toString("latin1"))
    ) {
      problems.push(`${path} holds a workspace: specifier`);
    }
    // esbuild writes `// <path>` above each module it inlines, and rolldown
    // `//#region <path>` around the declaration modules it gives a region:
    // not a module that a declaration imports as a namespace, which gets no
    // region of its own, so these checks cannot see that one.
    // A declaration names types only, so of the forbidden modules only the
    // test-only ones are refused there; JavaScript runs, so all of them are
    // refused in it, but a module the list names as one of the packed
    // package's own published modules (ruling 193 item 1). In either, a
    // module of another package than the one
    // packed is refused, but one the row inlines: each package of the set
    // ships its own modules and imports its siblings', so a second copy of a
    // sibling's is refused. In either, a comment naming a private module is
    // refused, because its public variant is built in its place; a private
    // module without a region of its own is refused by its doc comments,
    // above. So is a comment naming a test seam's real module, whose inert
    // module the JavaScript step builds in its place; a seam's declaration
    // without a region of its own shows only by its markers, above.
    const declaration = path.endsWith(".d.ts");
    const comments = declaration
      ? [...text.matchAll(/^\/\/#region (\S+)$/gmu)].map(([, module]) => module)
      : path.endsWith(".js")
        ? [...text.matchAll(/^\/\/ (\S+\.(?:ts|tsx|js|mjs))$/gmu)].map(
            ([, module]) => module,
          )
        : [];
    for (const module of comments) {
      const source = declaration ? module.replace(/\.d\.ts$/u, ".ts") : module;
      if (!insideRepository(module)) {
        problems.push(
          `${path} names a module outside the repository: ${module}`,
        );
      } else if (Object.hasOwn(publicVariants, source)) {
        problems.push(
          `${path} inlines the private module ${module}, not its public variant ${publicVariants[source]}`,
        );
      } else if (Object.hasOwn(inertSeams, source)) {
        problems.push(
          `${path} inlines the test seam's real module ${module}, not its inert module ${inertSeams[source]}`,
        );
      } else if (
        declaration
          ? testOnlyModule(source)
          : forbiddenModule(module, pack.bundle.package)
      ) {
        problems.push(`${path} inlines ${module}`);
      } else if (!ownModule(pack, module)) {
        problems.push(
          `${path} inlines ${module}, a module of ${ownerOf(module)}`,
        );
      }
    }
  }

  // Done when 9's first bullet: the `LICENSE` file, here, and the `license`
  // field, below, against §3.7's mapping.
  const licence = files.get("LICENSE");
  if (licence === undefined) {
    problems.push(`LICENSE is missing: the mapping names ${pack.licenseText}`);
  } else if (
    !licence.equals(readFileSync(join(repositoryRoot, pack.licenseText)))
  ) {
    problems.push(`LICENSE is not ${pack.licenseText}, byte for byte`);
  }

  // The notices the stage wrote (ruling 209 item 1), byte for byte,
  // wherever the allow-list holds them: `staged.bundledNotices` where
  // `stagePackage` set it, and otherwise the stage directory's file. Two
  // stages whose allow-list holds one set none: `core-tarball-smoke.mjs`'s
  // `reusePack` (`--from`), which re-reads a pack directory and takes the
  // stage directory's files as the allow-list, and `pack-requestport.mjs`'s
  // `stageWeb`, whose own check compares `@requestport/web`'s notices too,
  // in the same words. Where the stage set no `bundledNotices` and its
  // directory lacks the file, the read throws. One missing from the
  // tarball, or one in a tarball whose allow-list does not hold it, is
  // refused above.
  const notices = files.get(NOTICES_FILE);
  if (notices !== undefined && allowList.includes(NOTICES_FILE)) {
    const wrote =
      staged.bundledNotices ?? readFileSync(join(directory, NOTICES_FILE));
    if (!notices.equals(Buffer.from(wrote))) {
      problems.push(
        `${NOTICES_FILE} is not the notices the stage wrote, byte for byte`,
      );
    }
  }

  const text = files.get("package.json")?.toString("utf8");
  if (text === undefined) return [...problems, "package.json is missing"];
  const packed = JSON.parse(text);
  if (text.includes("workspace:"))
    problems.push("package.json holds a workspace: specifier");
  if (packed.license !== pack.license) {
    problems.push(
      `package.json's license is ${packed.license}, not the mapping's ${pack.license}`,
    );
  }
  for (const field of [
    "name",
    "version",
    "private",
    "type",
    "license",
    "repository",
    "files",
    "engines",
    "dependencies",
    "peerDependencies",
    "peerDependenciesMeta",
  ]) {
    if (!isDeepStrictEqual(packed[field], written[field])) {
      problems.push(
        `package.json's ${field} is ${JSON.stringify(packed[field])}, not ${JSON.stringify(written[field])}`,
      );
    }
  }
  problems.push(...releaseFieldProblems(packed, pack.source));
  for (const field of ["scripts", "bin"]) {
    if (packed[field] !== undefined) problems.push(`package.json has ${field}`);
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    const value = packed[field] ?? {};
    for (const name of Array.isArray(value) ? value : Object.keys(value)) {
      if (forbiddenDependency(pack.bundle, name, written.name)) {
        problems.push(`package.json's ${field} names ${name}`);
      }
    }
  }
  const subpaths = pack.bundle.entries.map(({ subpath }) => subpath).sort();
  const exported = Object.keys(packed.exports ?? {}).sort();
  if (!isDeepStrictEqual(exported, subpaths)) {
    problems.push(
      `package.json exports ${JSON.stringify(exported)}, not the bundle's entries ${JSON.stringify(subpaths)}`,
    );
  }
  for (const subpath of exported) {
    if (pack.unpublished.includes(subpath)) {
      problems.push(`package.json exports ${subpath}, which is not published`);
    }
    const target = packed.exports[subpath];
    for (const condition of ["types", "import"]) {
      const file = target?.[condition];
      if (typeof file !== "string" || !files.has(file.replace(/^\.\//u, ""))) {
        problems.push(
          `package.json's ${subpath} has no ${condition} target in the tarball (${JSON.stringify(file)})`,
        );
      }
    }
  }
  return problems;
}

/**
 * Every problem with a run's tarballs read together, `packs` in the order
 * they were packed, each with its `entries` as `readTarball` returns them:
 * an empty list is a run this script accepts (step 8 of this module's
 * header).
 *
 * - **The order.** Each `@requestport/*` package a packed manifest names in
 *   `dependencies`, `peerDependencies` or `optionalDependencies` must be
 *   packed before it: J publishes in this order, so that no package names a
 *   version not yet published (manifest-g.md §5). One packed after it, or
 *   not at all, is refused.
 * - **The specifiers.** Each `@requestport/*` specifier a tarball's
 *   JavaScript imports (statically or through `import(…)`) or re-exports, or
 *   its declarations import, re-export or name in `import("…")`, must name a
 *   package of the run and a subpath that package's packed manifest exports.
 * - **esbuild's runtime helpers** (ruling 209 item 2). A tarball whose
 *   JavaScript (`.js`, `.cjs` or `.mjs`) binds one of
 *   `ESBUILD_RUNTIME_HELPERS` at the start of a line (`esbuildHelpersIn`)
 *   must carry a `THIRD-PARTY-NOTICES` with an entry for esbuild
 *   (`noticesNameEsbuild`); each file that binds one is refused otherwise,
 *   by name. This is the run's check, not `checkTarball`'s, because
 *   `pack-requestport.mjs` hands it every tarball of its run, `requestport`'s
 *   among them, which `checkTarball` does not check. It matches one
 *   layout, `var __<name> = ` at the start of a line, which is how esbuild
 *   writes the helpers in unminified ESM or CommonJS output; any other
 *   layout hides them from it: a minifier, whether it renames the bindings,
 *   as Next's build does in `@requestport/web`'s chunks, or only drops
 *   whitespace, and an IIFE, which indents them.
 */
export async function checkRun(packs) {
  const parseAst = await parser();
  const problems = [];
  const manifests = packs.map(({ entries }) => {
    const text = entries.get("package/package.json")?.toString("utf8");
    return text === undefined ? undefined : JSON.parse(text);
  });
  const exported = new Map(
    manifests
      .filter((manifest) => manifest !== undefined)
      .map(({ name, exports }) => [name, Object.keys(exports ?? {})]),
  );

  manifests.forEach((manifest, index) => {
    if (manifest === undefined) {
      problems.push(`the run's tarball ${index + 1} has no package.json`);
      return;
    }
    const before = new Set(
      manifests.slice(0, index).map((earlier) => earlier?.name),
    );
    const after = new Set(
      manifests.slice(index + 1).map((later) => later?.name),
    );
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const name of Object.keys(manifest[field] ?? {}).sort()) {
        if (!name.startsWith("@requestport/") || before.has(name)) continue;
        if (name === manifest.name) {
          problems.push(`${manifest.name} depends on itself (${field})`);
        } else if (after.has(name)) {
          problems.push(
            `${manifest.name} is packed before ${name}, which it depends on (${field})`,
          );
        } else {
          problems.push(
            `${manifest.name} depends on ${name}, which this run does not pack (${field})`,
          );
        }
      }
    }
  });

  packs.forEach(({ entries }, index) => {
    const packed = manifests[index]?.name ?? `tarball ${index + 1}`;
    for (const [path, body] of [...entries].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const lang = path.endsWith(".d.ts")
        ? "dts"
        : path.endsWith(".js")
          ? "js"
          : undefined;
      if (lang === undefined) continue;
      const file = path.replace(/^package\//u, "");
      const specifiers = new Set();
      for (const node of descendants(
        parseAst(body.toString("utf8"), { lang }),
      )) {
        if (
          [
            "ImportDeclaration",
            "ExportNamedDeclaration",
            "ExportAllDeclaration",
            "ImportExpression",
            "TSImportType",
          ].includes(node.type)
        ) {
          const specifier = stringLiteral(unwrap(node.source));
          if (specifier?.startsWith("@requestport/")) specifiers.add(specifier);
        }
      }
      for (const specifier of [...specifiers].sort()) {
        const name = packageName(specifier);
        const subpath =
          specifier === name ? "." : `.${specifier.slice(name.length)}`;
        if (!exported.has(name)) {
          problems.push(
            `${packed}: ${file} imports ${specifier}, and this run packs no ${name}`,
          );
        } else if (!exported.get(name).includes(subpath)) {
          problems.push(
            `${packed}: ${file} imports ${specifier}, which ${name}'s packed manifest does not export`,
          );
        }
      }
    }
  });

  packs.forEach(({ entries }, index) => {
    const packed = manifests[index]?.name ?? `tarball ${index + 1}`;
    const notices = entries.get(`package/${NOTICES_FILE}`)?.toString("utf8");
    if (notices !== undefined && noticesNameEsbuild(notices)) return;
    for (const [path, body] of [...entries].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (!/\.(?:c|m)?js$/u.test(path)) continue;
      const helpers = [...new Set(esbuildHelpersIn(body.toString("utf8")))];
      if (helpers.length === 0) continue;
      problems.push(
        `${packed}: ${path.replace(/^package\//u, "")} binds esbuild's runtime helpers ${helpers.join(", ")}, and ${
          notices === undefined
            ? `the tarball carries no ${NOTICES_FILE}`
            : `its ${NOTICES_FILE} has no entry for esbuild`
        }`,
      );
    }
  });
  return problems;
}

/** One tarball's line of the build record (§3.5). */
export function tarballFacts(tarball, entries, manifest) {
  const bytes = readFileSync(tarball);
  return {
    file: basename(tarball),
    name: manifest.name,
    version: manifest.version,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    size: bytes.length,
    files: entries.size,
  };
}

/** The build record (§3.5), for the tarballs of one run. */
export function buildRecord(tarballs, { treeStatus }) {
  return {
    commit: git(["rev-parse", "HEAD"]).trim(),
    treeStatus,
    node: process.version,
    pnpm: pnpmVersion(),
    tarballs,
  };
}

/** Refuses a tree with anything to report in `git status --porcelain` (§3.5). */
export function refuseDirtyTree(status) {
  if (status !== "") {
    throw new Error(
      `pack-packages refuses a dirty tree. git status --porcelain:\n${status}`,
    );
  }
}

/** Refuses a tree whose status changed while the script built and packed. */
export function refuseChangedTree(before, after) {
  if (after !== before) {
    throw new Error(
      `pack-packages: the tree changed while it packed. git status --porcelain:\n${after}`,
    );
  }
}

/**
 * The command. `treeStatus` and `log` are its inputs and output, for its
 * test; the command line has no way to pass either.
 */
export async function main(
  argv = process.argv.slice(2),
  {
    treeStatus = readTreeStatus,
    log = (line) => process.stdout.write(`${line}\n`),
  } = {},
) {
  const { values } = parseArgs({
    args: argv,
    options: { version: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  refuseVersion(values.version);
  const before = treeStatus();
  refuseDirtyTree(before);
  const out = resolve(
    values.out ?? mkdtempSync(join(tmpdir(), "requestport-pack-")),
  );
  refuseInsideRepository(out);
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`pack-packages: ${out} is not empty.`);
  }
  mkdirSync(out, { recursive: true });

  const packs = [];
  for (const pack of Object.values(PACKAGES)) {
    const staged = await stagePackage(pack, {
      version: values.version,
      directory: join(out, "stage", basename(pack.source)),
    });
    const tarball = packStaged(staged.directory, out);
    const entries = readTarball(tarball);
    const problems = checkTarball(entries, staged);
    if (problems.length > 0) {
      throw new Error(
        `pack-packages refuses ${basename(tarball)}:\n- ${problems.join("\n- ")}`,
      );
    }
    packs.push({ staged, tarball, entries });
  }
  const runProblems = await checkRun(packs);
  if (runProblems.length > 0) {
    throw new Error(
      `pack-packages refuses the run:\n- ${runProblems.join("\n- ")}`,
    );
  }

  refuseChangedTree(before, treeStatus());
  const record = buildRecord(
    packs.map(({ staged, tarball, entries }) =>
      tarballFacts(tarball, entries, staged.manifest),
    ),
    { treeStatus: before },
  );
  writeFileSync(
    join(out, "build-record.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  log(JSON.stringify(record, null, 2));
  log(`pack-packages: tarballs and build-record.json are in ${out}`);
  return { out, record, packs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
