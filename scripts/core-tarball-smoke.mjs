#!/usr/bin/env node
/*
  The done-when test of Plan 13's G (manifest-g.md §4), under S8: the eight
  packages of the set (`S8`; ruling 175), each its own tarball, and the
  three ruling 190 has G's machinery pack beside them (`HOST`):
  `@requestport/auth`, whose `./create-auth` the consumer's fixture imports,
  `mcp` and `server`. It is run by hand and recorded (`track-g.md`; since
  ruling 190, `track-h.md`); no gate runs it. Nothing here publishes, logs
  in to a registry or writes a registry setting.

  Usage:
    node scripts/core-tarball-smoke.mjs --version <version> --database <server URL> [--out <directory>]
    node scripts/core-tarball-smoke.mjs --from <pack directory> --database <server URL> [--out <directory>]
  Either takes `--pnpm <path to pnpm.cjs>`.

  `--database` names the local PostgreSQL server step 6 runs on, as a
  `postgres:` URL with a user, a password if the server asks one, a database
  to connect to and no query: its host must be this machine's loopback, and
  its user must be able to create a database and a role in
  `requestport_application`. Anything else is refused before step 1. Without
  it, step 6 fails. The record holds it with its password hidden.

  `<out>` must be outside the repository, under the path as given and its
  real path, and empty or absent; without `--out` it is a new directory under
  the temporary directory. It receives `pack/` (step 1, without `--from`),
  `consumer/`, `home/` and `store/` (steps 3 to 6), `install.log`, the four
  `tsc-*.log` reports (step 5), `run.log`, `run-report.json`, the
  battery's runner `zod-battery.mjs` and its `zod-battery-*.json` (step 6),
  `licence-inventory.json` and `.log`, and `linux/` and `linux-install.log`
  (step 7), and
  `smoke-record.json`, which a run writes once its arguments and `<out>` are
  accepted, a failed run included. The command exits 0 only when every step
  passes, and a step runs only when every step before it passed.

  1. **The pack.** With `--version`, it runs G.7's `main` from
     `scripts/pack-packages.mjs` into `<out>/pack`. That refuses a dirty tree
     and checks each tarball, and the run, itself. With `--from`, it reuses a
     directory such a pack wrote: it reads `build-record.json`, and refuses a
     tarball whose sha512 integrity or size differs from the record's, or a
     staged directory that is missing. Either way the run's packages must be
     `S8` and `HOST`, each once, and no other (`packSetProblems`).
  2. **Each tarball, read again** with G.7's `readTarball`, and checked:
     - by G.7's `checkTarball`, against its staged directory. With `--from`,
       the allow-list is the staged directory's files;
     - by G.7's `checkRun`, over every tarball together: the pack order,
       each `@requestport/*` specifier against the packed `exports`, and
       esbuild's runtime helpers bound at a line's start against an entry
       for esbuild in the tarball's `THIRD-PARTY-NOTICES` (ruling 209);
     - by G.8's own reading of the module comments esbuild (`// <path>`) and
       rolldown (`//#region <path>`) wrote, whose criterion does not read
       `bundle.mjs`'s forbidden-module list (ruling 152). It refuses, in the
       JavaScript and the declarations alike, a module that is not under a
       package's `src/`, a test, test support, the sweep's ledger, a root's
       module (`db`'s `wiring.ts` and `testing.ts`; `jobs`' `worker-root.ts`,
       `index.ts` and `cli.ts`), any `config` module but the three that
       G.0b's env-parsing list leaves out (`logger.ts`, `redaction.ts`,
       `sign-in-methods.ts`), and a module of another package than the one
       packed. Of those roots' and `config` modules, the ones ruling 193 item
       1 publishes are accepted in their own package's tarball alone
       (`OWN_PUBLISHED_MODULES`). A tarball with no module comment in its
       JavaScript, or none in its declarations, is refused: the check would
       see nothing;
     - by G.8's own reading of the `@requestport/*` specifiers its
       JavaScript and declarations import (`from "…"`, `import "…"`,
       `import("…")`, `require("…")`), which does not read `checkRun`'s:
       each must name a package of the run and a subpath that package's
       packed manifest exports, and a package of `S8` must import nothing of
       `HOST` (`auth` depends on core: manifest-g.md §2.5.1);
     - and the checks must fire: each of `MODULE_PLANTS` but the package's
       own published modules (`modulePlants`), and each of `tarballPlants`'
       plants for that package (two modules of other packages, each in the
       JavaScript and in the declarations, three specifiers, and for a
       package of `S8` a fourth, of `auth`), written into a copy of the
       tarball's files, must be refused.
  3. **The consumer**, in `<out>/consumer`. It refuses a `node_modules` or an
     `.npmrc` in that directory or above it, under the path as given and its
     real path. Its `package.json` depends on `CONSUMER_DEPENDENCIES`, the
     packages its fixture imports (`@requestport/core`, `@requestport/db`
     and `@requestport/auth`) and `@requestport/server`, through which the
     install holds `mcp` too, each as `file:<absolute path>` to its tarball,
     and on `typescript` and `@types/node` for step 5 as `devDependencies`,
     at the exact versions the root's `package.json` pins. Its
     `pnpm-workspace.yaml` overrides each of the eleven packages of the pack
     (`PACKED`) to its tarball (manifest-g.md §4 step 3), so that every
     `@requestport/*` the tarballs name at the stamped version comes from
     the pack. Before it installs, every
     `@requestport/*` a packed manifest names must be one the overrides map
     (`unoverriddenNames`): an install that would ask a registry for one is
     not started.
  4. **The cold install.** The pnpm the root's `packageManager` pins, by its
     path in corepack's cache (`--pnpm` names another file), run by this
     Node with an environment of `PATH` (this Node's directory, `/usr/bin`,
     `/bin`), `HOME` at the empty `<out>/home`, pnpm's update notice off, and
     `TMPDIR` only when this process has one; `pnpm install --store-dir
     <out>/store`, into an empty store. Before it, pnpm must report that
     version, and the public registry as its registry. After it, pnpm must
     have exited 0, reported reusing nothing from the store, and printed no
     update notice; pnpm's store in the consumer must hold one copy of each
     package of the pack, at the build record's version, and the consumer's
     own `node_modules` must link each of `CONSUMER_DEPENDENCIES` to that
     copy (`installedCopies`); and the lockfile assertion must find nothing:
     - in `importers`, `packages` and `snapshots`, and in `overrides`, every
       `@requestport/*` resolves to a `file:` tarball of the pack;
     - the consumer's importer depends on `CONSUMER_DEPENDENCIES` and on no
       other `@requestport/*`;
     - each tarball's `packages` entry is there once, at the build record's
       version, and its `resolution` names that tarball, with the build
       record's integrity;
     - `overrides` holds the eleven of `PACKED`, and no other
       `@requestport/*`;
     - a key or value naming `@requestport/` anywhere else is refused.
     The assertion must fire too: each of `LOCKFILE_PLANTS`, written into a
     copy of the lockfile, must be reported.
  5. **The types** (Done when 8; ruling 150). The fixture,
     `scripts/core-tarball-smoke/consumer.ts` and its `tsconfig.json`, is
     copied into the consumer, whose `typescript` and `@types/node` must be
     the versions it declared. The consumer's `tsc`, run by this Node in
     step 4's environment, checks it twice (`tsc -p tsconfig.json --noEmit
     --pretty false --skipLibCheck <true|false>`):
     - with `skipLibCheck` true, it must exit 0 and report nothing;
     - with it false, every error must be in a third-party package's
       declaration file under the consumer's `node_modules/.pnpm`, none in
       an `@requestport/*` package; the record counts them by package and
       code.
     A line of its report the check cannot read is a failure in both runs.
     The check must fire: the fixture with an import of `PLANTED_IMPORT`,
     a name core's `.` does not export, written into `<consumer>/plant`, must
     be reported by both runs' rule as TS2305 naming it.
  6. **The run** (Done when 8; on `pg` only, ruling 153). This Node runs the
     fixture in the consumer, `node consumer.ts <server> <database> <report>`,
     with an environment of `PATH` and `HOME` as step 4's, and `TMPDIR` only
     when this process has one: no `PG*`, no `REQUESTPORT_*`, no
     `DATABASE_URL`. The fixture first compares the values core's `.` and
     `./migrate` share by name with `db`'s `.` and `./migrate`
     (`IDENTITY_REQUIRED` among them: `createStorage` and `migrate`), which
     must be `db`'s own; then asks `db` once for a PGlite storage,
     `createStorage({ driver: "pglite", dataDir: "memory://" })`, with the
     optional peer `@electric-sql/pglite` absent: the run is on `pg`, and a
     run with PGlite present is H.8's (ruling 153). Then it creates the
     database, a fresh name this script draws, and a login in
     `requestport_application`; migrates (`migrate` from
     `@requestport/db/migrate`); registers the owner and signs that person
     in; runs a capability of each of §2.6's thirteen F.0 modules, under the
     principals ruling 153 rules, and reads each effect back through the
     application storage; runs the `tenantBinding: "off"` case; closes;
     counts the database's sessions; and drops the database and the login.
     It writes what it measured to `run-report.json`, and `runProblems`
     judges it: the shared values `db`'s own; every module once, under its
     ruled principal, with its effect read back; the `"off"` read failed
     with 42501 and the unbound-transaction message; a `DomainError` from
     each of the fixture's three refusals, all of one class, since the
     consumer installs one `@requestport/domain`; no session left; both
     dropped; no environment name outside `RUN_ENVIRONMENT_NAMES`; no error;
     and the PGlite storage refused in its own words, with Node's code,
     `MODULE_NOT_FOUND`, and Node's error for the peer as its cause (rulings
     151 and 154), from a lookup that starts in `db`'s installed package.
     Before the run, `installedPglite` must find the peer neither in the
     consumer's lockfile nor in its `node_modules` as a direct dependency,
     hoisted in pnpm's store, or in that store under its own name, where
     pnpm's isolated layout puts every package it installs; and it must find
     the peer in a copy of the lockfile `plantPglite` enters it in. The
     check must fire: each of `RUN_PLANTS`, written into a copy of the
     report, must be reported. Then the `zod` copies the consumer installed
     (ruling 151): for each installed package of the pack that declares
     `zod`, and Better Auth, which `auth` resolves, the version its
     code resolves, each against the version its manifest declares, and
     which of its files import `zod`; and G.7a's battery (`zodBattery`) run
     by this Node on each copy alone, on both in one process in each order,
     and on both after the fixture's own imports, with the results that
     differ recorded beside ruling 144's four.
  7. **The licences** (manifest-g.md §4 step 7; rulings 139, 151 and 153).
     - G.A's script, `scripts/licence-inventory.mjs`, run by this Node in
       step 4's environment as `--root <consumer> --package
       @requestport/core --package @requestport/db --no-pnpm --json
       <out>/licence-inventory.json`: the closure of the published packages
       the consumer depends on, in the consumer read as a plain installed
       tree, view (b). G.A finds a `--package` only at the consumer's root,
       where pnpm links the consumer's own dependencies alone, and follows
       each first-party dependency it reaches, so its members must be the
       eight of `S8`. It must exit 0. Each member's own closure is read by
       G.A's own walk and classifier (`consumerLicences`), and their union
       must agree with G.A's document. `licenceProblems` judges the union,
       and each package's closure on its own, against the S8 row's view (b)
       of `track-g-licence-reference.json`, by name: a name the reference
       does not hold that G.A's classifier flags fails, and so does a known
       name whose licence changed class; a new unflagged name is recorded as
       an accepted addition, and a version the reference does not hold is
       recorded with its licence. The set's closure must hold no platform
       package, skip no linux-x64 build, leave no dependency unresolved, and
       reach no first-party package outside `S8`. The judgement must fire:
       each of `INVENTORY_PLANTS`, written into a copy, must be reported.
     - The build's Linux platform bindings, which the consumer does not
       install: in `<out>/linux/project`, core's devDependencies at the
       versions `packages/core` pins (the build of every package of the set
       runs from there), with pnpm's `supportedArchitectures` asking for
       Linux on arm64 and x64, glibc and musl, installed cold by step 4's
       pnpm and environment (`HOME` at the empty `<out>/linux/home`, the
       empty store `<out>/linux/store`) with `--ignore-scripts`. Each
       package in its store whose `os` names `linux` is read: none may be
       flagged by G.A's classifier or declare an install script, at least one
       must be for arm64 and one for x64, and the consumer's lockfile must
       name none of them nor any of those devDependencies. Each of
       `LINUX_PLANTS`, written into a copy, must be reported.

  `scripts/core-tarball-smoke.test.mjs` holds these checks on planted input,
  offline, in the scripts corpus (ruling 153): step 1's set and `--from`'s
  refusals; the module-comment and specifier refusals and their plants;
  step 3's search above the consumer, its files and the names an override
  must map; step 4's environment and pnpm path, the lockfile assertion and
  its plants, and the installed copies; step 5's installed versions, its
  reading of `tsc`'s report, its pass rule, its plant, and the fixture's
  tsconfig, imports and human scopes; step 6's server URL, environment,
  judgement of the report and its plants, the identity case, the fixture's
  module list, principals and credential scopes, the PGlite case's
  judgement, `installedPglite` and its plant, and the fixture's one PGlite
  call, and the `zod` copies and the battery's comparison; and step 7's
  arguments and reference, its walk against G.A's document, its comparison
  by name, of the union and of each package, and its plants, and the Linux
  bindings' project, their reading from a pnpm store, their judgement and
  its plants.
*/
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  classifyLicence,
  openContext,
  parseSpdxExpression,
  walkFirstParty,
} from "./licence-inventory.mjs";
import {
  checkRun,
  checkTarball,
  PACKAGES,
  main as pack,
  readTarball,
  readTreeStatus,
  refuseInsideRepository,
  repositoryRoot,
} from "./pack-packages.mjs";

/**
 * The S8 package set (ruling 175), G.8's own list, in the order G.7 packs
 * it: the eight packages a consumer of core installs, each from its own
 * tarball, which step 3's overrides map.
 */
export const S8 = Object.freeze([
  "@requestport/domain",
  "@requestport/notifications",
  "@requestport/webhooks",
  "@requestport/importer",
  "@requestport/config",
  "@requestport/db",
  "@requestport/jobs",
  "@requestport/core",
]);

/**
 * The three packages ruling 190 has G's machinery build, pack and check
 * beside `S8` (H question 8, the manifest's alternative), G.8's own list, in
 * the order G.7 packs them: `@requestport/auth`, which composes Better Auth
 * and whose `./create-auth` the fixture imports (ruling 183 item 5: the
 * consumer installs the published `auth`, not a test-only bundle), `mcp`
 * and `server`.
 */
export const HOST = Object.freeze([
  "@requestport/auth",
  "@requestport/mcp",
  "@requestport/server",
]);

/** Every package of the pack, `S8` then `HOST`: what step 3's overrides map. */
export const PACKED = Object.freeze([...S8, ...HOST]);

/**
 * What the consumer depends on: the packages its fixture imports, core's
 * `.` and `./migrate`, `db`'s `.` and `./migrate`, from which manifest-g.md
 * §4 step 6 takes `createStorage` and `migrate` under S8, and `auth`'s
 * `./create-auth`; and `server`, which nothing else here depends on, so that
 * the install holds every package of the pack: `mcp` reaches it as
 * `server`'s dependency, and the rest of `S8` as these packages', through
 * the overrides.
 */
export const CONSUMER_DEPENDENCIES = Object.freeze([
  "@requestport/core",
  "@requestport/db",
  "@requestport/auth",
  "@requestport/server",
]);

/**
 * Step 1's set: each problem with the names of a run's tarballs, which
 * must be the eleven of `PACKED`, each once.
 */
export function packSetProblems(names) {
  const problems = [];
  const expected = PACKED;
  for (const name of expected) {
    const count = names.filter((packed) => packed === name).length;
    if (count !== 1) {
      problems.push(`the pack holds ${count} tarballs of ${name}, not one`);
    }
  }
  for (const name of [...new Set(names)].sort()) {
    if (!expected.includes(name)) {
      problems.push(
        `the pack holds ${name}, which is neither of S8 nor of HOST`,
      );
    }
  }
  return problems;
}

/** The registry a cold install must use: the public one, anonymously. */
export const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

/** A file's sha512 integrity, as pnpm and the build record write it. */
function integrityOf(file) {
  return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
}

/** Every file under `directory`, by its path from there, `/`-separated. */
function filesUnder(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(directory, path).split(sep).join("/"));
    }
  };
  walk(directory);
  return found.sort();
}

/**
 * Step 1 with `--from`: a pack directory `pack-packages.mjs` wrote, re-read.
 * Each tarball must match the build record's integrity and size, and its
 * staged directory must hold a `package.json`. Returns the record and, per
 * package, the tarball's path and what `checkTarball` needs.
 */
export function reusePack(from) {
  const directory = resolve(from);
  const record = JSON.parse(
    readFileSync(join(directory, "build-record.json"), "utf8"),
  );
  const packs = [];
  for (const packed of Object.values(PACKAGES)) {
    const stage = join(directory, "stage", basename(packed.source));
    if (!existsSync(join(stage, "package.json"))) {
      throw new Error(`core-tarball-smoke: ${stage} holds no package.json.`);
    }
    const manifest = JSON.parse(
      readFileSync(join(stage, "package.json"), "utf8"),
    );
    const facts = record.tarballs.find(({ name }) => name === manifest.name);
    if (facts === undefined) {
      throw new Error(
        `core-tarball-smoke: build-record.json names no tarball of ${manifest.name}.`,
      );
    }
    const tarball = join(directory, facts.file);
    const integrity = integrityOf(tarball);
    if (integrity !== facts.integrity) {
      throw new Error(
        `core-tarball-smoke: ${facts.file}'s integrity is ${integrity}, not the build record's ${facts.integrity}.`,
      );
    }
    if (statSync(tarball).size !== facts.size) {
      throw new Error(
        `core-tarball-smoke: ${facts.file} is ${statSync(tarball).size} bytes, not the build record's ${facts.size}.`,
      );
    }
    packs.push({
      staged: {
        pack: packed,
        directory: stage,
        manifest,
        allowList: filesUnder(stage),
      },
      tarball,
    });
  }
  return { record, packs };
}

/**
 * The package whose module a module comment names, `@requestport/<x>` for a
 * path under `packages/<x>/`, by G.8's own reading.
 */
export function moduleOwner(module) {
  return `@requestport/${module.split("/")[1]}`;
}

/** `config`'s modules, its tests aside, that G.0b's env-parsing list leaves out. */
const CONFIG_MODULES_WITHOUT_ENVIRONMENT = Object.freeze([
  "logger.ts",
  "redaction.ts",
  "sign-in-methods.ts",
]);

/** The roots' modules: `db`'s wiring and testing modules; `jobs`' worker root, its `index.ts` and its CLI. */
const ROOT_MODULES = Object.freeze([
  "packages/db/src/wiring.ts",
  "packages/db/src/testing.ts",
  "packages/jobs/src/worker-root.ts",
  "packages/jobs/src/index.ts",
  "packages/jobs/src/cli.ts",
]);

/**
 * The roots' and `config`'s modules above that ruling 193 item 1 publishes,
 * by the package whose own tarball holds them, G.8's own list: `config`'s
 * `./server` and `./server-deferred` with the schema both parse with,
 * `db`'s `./wiring`, and `jobs`' `.` with the worker root it registers and
 * the CLI it exports. Each is accepted in that package's tarball alone.
 */
export const OWN_PUBLISHED_MODULES = Object.freeze({
  "@requestport/config": Object.freeze([
    "packages/config/src/server-deferred.ts",
    "packages/config/src/server-schema.ts",
    "packages/config/src/server.ts",
  ]),
  "@requestport/db": Object.freeze(["packages/db/src/wiring.ts"]),
  "@requestport/jobs": Object.freeze([
    "packages/jobs/src/cli.ts",
    "packages/jobs/src/index.ts",
    "packages/jobs/src/worker-root.ts",
  ]),
});

/**
 * Why G.8 refuses a module a bundle's comment names in a tarball of `name`,
 * or `undefined`. Its own criterion, which does not read `bundle.mjs`'s list
 * (ruling 152). A declaration's region names `<module>.d.ts`, read as
 * `<module>.ts`. Without `name`, no module is the packed package's own
 * published one.
 */
export function smokeModuleRefusal(module, name) {
  const path = module.replace(/\.d\.ts$/u, ".ts");
  const parts = path.split("/");
  if (isAbsolute(path) || parts.includes("..")) {
    return "names a module outside the repository";
  }
  if (parts.length < 4 || parts[0] !== "packages" || parts[2] !== "src") {
    return "is not a module of a package's src/";
  }
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) return "is a test";
  if (parts.includes("test-support")) return "is test support";
  if (path.includes("tenant-scope-sweep")) return "is the sweep's ledger";
  if (OWN_PUBLISHED_MODULES[name]?.includes(path)) return undefined;
  if (ROOT_MODULES.includes(path)) return "is a root's module";
  if (
    parts[1] === "config" &&
    !(
      parts.length === 4 &&
      CONFIG_MODULES_WITHOUT_ENVIRONMENT.includes(parts[3])
    )
  ) {
    return "is a config module that parses the environment, or one G.8 does not know";
  }
  return undefined;
}

/**
 * The module comments in a tarball's files: `// <path>` lines in its
 * JavaScript, which esbuild writes above each module it inlines, and
 * `//#region <path>` lines in its declarations, which rolldown writes.
 */
export function moduleComments(entries) {
  const comments = [];
  for (const [file, body] of entries) {
    const text = body.toString("utf8");
    const pattern = file.endsWith(".d.ts")
      ? /^\/\/#region (\S+)$/gmu
      : file.endsWith(".js")
        ? /^\/\/ (\S+\.(?:[cm]?[jt]sx?|json))$/gmu
        : undefined;
    if (pattern === undefined) continue;
    for (const [, module] of text.matchAll(pattern)) {
      comments.push({ file, module, declaration: file.endsWith(".d.ts") });
    }
  }
  return comments;
}

/**
 * G.8's refusals of the module comments of a tarball of `name`, and what it
 * counted: `smokeModuleRefusal`'s, and a module of another package than
 * `name` (a declaration's region read as its `.ts` module).
 */
export function moduleCommentProblems(entries, name) {
  const comments = moduleComments(entries);
  const counted = {
    javascript: comments.filter(({ declaration }) => !declaration).length,
    declarations: comments.filter(({ declaration }) => declaration).length,
  };
  const problems = [];
  for (const { file, module } of comments) {
    const refusal = smokeModuleRefusal(module, name);
    if (refusal !== undefined) {
      problems.push(`${file} inlines ${module}, which ${refusal}`);
      continue;
    }
    const owner = moduleOwner(module);
    if (owner !== name) {
      problems.push(
        `${file} inlines ${module}, a module of ${owner}, not of ${name}`,
      );
    }
  }
  if (counted.javascript === 0) {
    problems.push(
      "no module comment in its JavaScript: the check would see nothing",
    );
  }
  if (counted.declarations === 0) {
    problems.push(
      "no module comment in its declarations: the check would see nothing",
    );
  }
  return { problems, counted };
}

/**
 * The shapes in which G.8 reads a tarball's `@requestport/*` specifiers, by
 * its own patterns rather than `checkRun`'s parser: `from "…"` (an import, a
 * type import or a re-export), `import "…"` at the start of a line,
 * `import("…")` (in the JavaScript, or a declaration's type), and
 * `require("…")`. A comment that mentions a package in prose is none of
 * them.
 */
const SPECIFIER_PATTERNS = Object.freeze([
  /\bfrom\s*(["'])(@requestport\/[^"'\s]*)\1/gu,
  /^\s*import\s*(["'])(@requestport\/[^"'\s]*)\1/gmu,
  /\bimport\s*\(\s*(["'])(@requestport\/[^"'\s]*)\1\s*\)/gu,
  /\brequire\s*\(\s*(["'])(@requestport\/[^"'\s]*)\1\s*\)/gu,
]);

/** The `@requestport/*` specifiers each of a tarball's `.js` and `.d.ts` files imports, once per file. */
export function importedSpecifiers(entries) {
  const found = [];
  for (const [file, body] of [...entries].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
    const text = body.toString("utf8");
    const specifiers = new Set();
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const [, , specifier] of text.matchAll(pattern)) {
        specifiers.add(specifier);
      }
    }
    for (const specifier of [...specifiers].sort()) {
      found.push({ file, specifier });
    }
  }
  return found;
}

/**
 * G.8's refusals of the specifiers a tarball of `name` imports, by
 * `importedSpecifiers`: each must name a package of the run and a subpath
 * that package's packed manifest exports (`exported`, each package's
 * `exports` keys by its name), and a package of `S8` must import nothing of
 * `HOST`.
 */
export function specifierProblems(entries, name, exported) {
  const problems = [];
  for (const { file, specifier } of importedSpecifiers(entries)) {
    const target = specifier.split("/").slice(0, 2).join("/");
    const subpath =
      specifier === target ? "." : `.${specifier.slice(target.length)}`;
    if (!exported.has(target)) {
      problems.push(
        `${file} imports ${specifier}, and the run packs no ${target}`,
      );
    } else if (S8.includes(name) && HOST.includes(target)) {
      problems.push(
        `${file} imports ${specifier}, of ${target}, which no package of S8 may import`,
      );
    } else if (!exported.get(target).includes(subpath)) {
      problems.push(
        `${file} imports ${specifier}, which ${target}'s packed manifest does not export`,
      );
    }
  }
  return problems;
}

/** Each package's packed `exports` keys, by its name, from a run's tarballs' `package.json`. */
export function exportedSubpaths(tarballEntries) {
  const exported = new Map();
  for (const entries of tarballEntries) {
    const text = entries.get("package/package.json")?.toString("utf8");
    if (text === undefined) continue;
    const manifest = JSON.parse(text);
    exported.set(manifest.name, Object.keys(manifest.exports ?? {}));
  }
  return exported;
}

/**
 * G.8's own refusals of one tarball of `name`, the module comments' and the
 * specifiers', and what it counted.
 */
export function tarballProblems(entries, name, exported) {
  const comments = moduleCommentProblems(entries, name);
  return {
    problems: [
      ...comments.problems,
      ...specifierProblems(entries, name, exported),
    ],
    counted: {
      ...comments.counted,
      specifiers: importedSpecifiers(entries).length,
    },
  };
}

/**
 * Modules G.8 must refuse, one or more per clause of its criterion but the
 * ownership one, which `tarballPlants` plants per package, each planted in
 * turn into a copy of a tarball's files, but a package's own published
 * modules in its own tarball (`modulePlants`). `declaration` plants it as a region
 * at the end of the first, by name, of the tarball's `dist/*.d.ts`;
 * otherwise it is a module comment at the end of the first of its
 * `dist/*.js`.
 */
export const MODULE_PLANTS = Object.freeze([
  { module: "packages/db/src/client.test.ts" },
  { module: "packages/domain/src/test-support/fixtures.ts" },
  { module: "packages/db/src/tenant-scope-sweep.exceptions.ts" },
  { module: "packages/db/src/wiring.ts" },
  { module: "packages/db/src/testing.ts" },
  { module: "packages/jobs/src/worker-root.ts" },
  { module: "packages/jobs/src/index.ts" },
  { module: "packages/jobs/src/cli.ts" },
  { module: "packages/config/src/index.ts" },
  { module: "packages/config/src/server.ts" },
  { module: "packages/config/src/client.ts" },
  { module: "packages/config/src/server-deferred.ts" },
  { module: "packages/config/src/server-schema.ts" },
  { module: "packages/config/src/environment.ts" },
  { module: "packages/jobs/bin/requestport-jobs.mjs" },
  { module: "apps/web/src/lib/server-request-port.ts" },
  { module: "packages/db/src/test-support/storage.d.ts", declaration: true },
  { module: "packages/db/src/wiring.d.ts", declaration: true },
]);

/**
 * The plants of `MODULE_PLANTS` G.8's checks must refuse in a tarball of
 * `name`: all of them but those naming one of `name`'s own published modules
 * (`OWN_PUBLISHED_MODULES`), which its tarball holds.
 */
export function modulePlants(name) {
  const own = OWN_PUBLISHED_MODULES[name] ?? [];
  return MODULE_PLANTS.filter(
    ({ module }) => !own.includes(module.replace(/\.d\.ts$/u, ".ts")),
  );
}

/**
 * The plants of a tarball of `name` that G.8's own checks must refuse, with
 * the words its problem must hold: the ownership clause's, a module of
 * another package of the set, twice, each in the JavaScript and in the
 * declarations; and the specifiers', an unpublished subpath of `db`
 * (`./testing`), an env-parsing subpath of `config` no tarball exports
 * (`./client`) in a declaration's `import()`, a package the run does not
 * pack, and, for a package of `S8`, `auth`, of `HOST`.
 * `text` is written in place of a module comment.
 */
export function tarballPlants(name) {
  const own = name.split("/")[1];
  const other = (modules) =>
    modules.find((module) => module.split("/")[1] !== own);
  const plants = [];
  for (const module of [
    other(["packages/db/src/client.ts", "packages/domain/src/index.ts"]),
    other(["packages/config/src/logger.ts", "packages/webhooks/src/index.ts"]),
  ]) {
    for (const declaration of [false, true]) {
      const planted = declaration ? module.replace(/\.ts$/u, ".d.ts") : module;
      plants.push({
        plant: `${planted}, a module of ${moduleOwner(module)}, in its ${declaration ? "declarations" : "JavaScript"}`,
        module: planted,
        declaration,
        expect: `inlines ${planted}, a module of ${moduleOwner(module)}, not of ${name}`,
      });
    }
  }
  plants.push(
    {
      plant: "an unpublished subpath of db imported",
      text: 'import "@requestport/db/testing";',
      expect:
        "imports @requestport/db/testing, which @requestport/db's packed manifest does not export",
    },
    {
      plant: "an env-parsing subpath of config in a declaration's import()",
      declaration: true,
      text: 'type Planted = import("@requestport/config/client").Planted;',
      expect:
        "imports @requestport/config/client, which @requestport/config's packed manifest does not export",
    },
    {
      plant: "a package the run does not pack",
      text: 'export { planted } from "@requestport/theme";',
      expect:
        "imports @requestport/theme, and the run packs no @requestport/theme",
    },
  );
  if (S8.includes(name)) {
    plants.push({
      plant: "auth, of HOST, required",
      text: 'const planted = require("@requestport/auth/create-auth");',
      expect:
        "imports @requestport/auth/create-auth, of @requestport/auth, which no package of S8 may import",
    });
  }
  return plants;
}

/**
 * A copy of `entries` with `plant` written at the end of one of its files:
 * its `text`, or a module comment naming its `module`.
 */
export function plantModule(entries, plant) {
  const suffix = plant.declaration ? ".d.ts" : ".js";
  const file = [...entries.keys()]
    .filter((path) => path.startsWith("package/dist/"))
    .filter((path) =>
      plant.declaration ? path.endsWith(".d.ts") : path.endsWith(".js"),
    )
    .sort()[0];
  if (file === undefined) {
    throw new Error(`core-tarball-smoke: no dist/*${suffix} to plant into.`);
  }
  const line =
    plant.text ??
    (plant.declaration
      ? `//#region ${plant.module}\n//#endregion`
      : `// ${plant.module}`);
  const planted = new Map(entries);
  planted.set(
    file,
    Buffer.from(`${entries.get(file).toString("utf8")}\n${line}\n`),
  );
  return planted;
}

/**
 * Each plant, of `modulePlants(name)` (by its module) and of
 * `tarballPlants(name)` (by its name), that G.8's checks do not refuse in a
 * copy of a tarball of `name`.
 */
export function unrefusedModulePlants(entries, name, exported) {
  const unrefused = [];
  for (const plant of [
    ...modulePlants(name).map((plant) => ({
      ...plant,
      plant: plant.module,
      expect: plant.module,
    })),
    ...tarballPlants(name),
  ]) {
    const { problems } = tarballProblems(
      plantModule(entries, plant),
      name,
      exported,
    );
    if (!problems.some((problem) => problem.includes(plant.expect))) {
      unrefused.push(plant.plant);
    }
  }
  return unrefused;
}

/** Each of `names` found in `directory` or above it, under both spellings of its path. */
export function ancestorsHolding(directory, names) {
  const found = new Set();
  for (const start of new Set([resolve(directory), realpathSync(directory)])) {
    for (let current = start; ; current = dirname(current)) {
      for (const name of names) {
        if (existsSync(join(current, name))) found.add(join(current, name));
      }
      if (dirname(current) === current) break;
    }
  }
  return [...found].sort();
}

/** The packages step 5 type-checks the fixture with, at the root's own versions. */
export const TYPE_CHECK_PACKAGES = Object.freeze(["typescript", "@types/node"]);

/**
 * The consumer's devDependencies: each of `TYPE_CHECK_PACKAGES` at the exact
 * version the root's `package.json` pins it, which must be one.
 */
export function consumerDevDependencies(
  rootManifest = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  ),
) {
  const pinned = {};
  for (const name of TYPE_CHECK_PACKAGES) {
    const version = rootManifest.devDependencies?.[name];
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
      throw new Error(
        `core-tarball-smoke: the root pins ${name} at ${JSON.stringify(version)}, not an exact version.`,
      );
    }
    pinned[name] = version;
  }
  return pinned;
}

/**
 * Step 3's two files: the consumer's manifest, which depends on each of
 * `CONSUMER_DEPENDENCIES` as its tarball, with `devDependencies` for step 5;
 * and its overrides, each package of `PACKED` to its tarball, in that order.
 * A package of either list the pack does not hold is refused.
 */
export function consumerFiles(tarballs, devDependencies) {
  const tarballOf = (name) => {
    const tarball = tarballs.find((packed) => packed.name === name);
    if (tarball === undefined) {
      throw new Error(`core-tarball-smoke: the pack holds no ${name}.`);
    }
    return tarball;
  };
  const manifest = {
    name: "requestport-core-smoke-consumer",
    private: true,
    type: "module",
    dependencies: Object.fromEntries(
      CONSUMER_DEPENDENCIES.map((name) => [
        name,
        `file:${tarballOf(name).path}`,
      ]),
    ),
    devDependencies,
  };
  const overrides = PACKED.map(
    // JSON's strings are YAML's double-quoted scalars.
    (name) =>
      `  ${JSON.stringify(name)}: ${JSON.stringify(`file:${tarballOf(name).path}`)}\n`,
  );
  return {
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "pnpm-workspace.yaml": `overrides:\n${overrides.join("")}`,
  };
}

/**
 * The `@requestport/*` names the packed manifests (`manifests`) name in
 * `dependencies`, `peerDependencies` or `optionalDependencies` that the
 * overrides (`PACKED`) do not map to a tarball, each with the packages that
 * name it: a name pnpm could ask a registry for, at the stamped version. The
 * consumer's own `file:` dependencies are not counted as mapping one. Step 3
 * installs nothing while one is left.
 */
export function unoverriddenNames(manifests) {
  const mapped = new Set(PACKED);
  const found = new Map();
  for (const manifest of manifests) {
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (!name.startsWith("@requestport/") || mapped.has(name)) continue;
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(manifest.name);
      }
    }
  }
  return [...found.keys()]
    .sort()
    .map(
      (name) => `${name} (named by ${[...found.get(name)].sort().join(", ")})`,
    );
}

/**
 * The pnpm the root's `packageManager` pins, by its path in corepack's cache
 * (`COREPACK_HOME`, or `node/corepack` under `XDG_CACHE_HOME` or `~/.cache`).
 */
export function pinnedPnpm(path, env = process.env) {
  const { packageManager } = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  const pinned = /^pnpm@(\d+\.\d+\.\d+)(?:\+\S+)?$/u.exec(packageManager ?? "");
  if (pinned === null) {
    throw new Error(
      `core-tarball-smoke: the root's packageManager is ${JSON.stringify(packageManager)}, not pnpm@<version>.`,
    );
  }
  const cache =
    env.COREPACK_HOME ??
    join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "node", "corepack");
  return {
    version: pinned[1],
    path: resolve(
      path ?? join(cache, "v1", "pnpm", pinned[1], "bin", "pnpm.cjs"),
    ),
  };
}

/**
 * The cold install's whole environment. pnpm 11.22.0 reads its update-notice
 * setting from `pnpm_config_update_notifier`, and not from
 * `npm_config_update_notifier` (measured with `pnpm config get
 * updateNotifier`).
 */
export function installEnvironment(home, env = process.env) {
  return {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    HOME: home,
    pnpm_config_update_notifier: "false",
    ...(env.TMPDIR === undefined ? {} : { TMPDIR: env.TMPDIR }),
  };
}

/** Runs `script` with this Node; its status, signal, output and seconds. */
function runNode(script, args, { cwd, env }) {
  const started = performance.now();
  const run = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  return {
    status: run.status,
    signal: run.signal ?? run.error?.message ?? null,
    output: `${run.stdout ?? ""}${run.stderr ?? ""}`,
    seconds: Math.round((performance.now() - started) / 100) / 10,
  };
}

function runPnpm(pnpm, args, options) {
  return runNode(pnpm.path, args, options);
}

/** A scalar as pnpm's lockfile writes it: plain, single- or double-quoted. */
function scalar(text, where) {
  const value = text.trim();
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/u.test(value)) {
      throw new Error(`${where}: an unterminated quoted scalar: ${value}`);
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) return JSON.parse(value);
  return value;
}

/**
 * pnpm's lockfile (version 9), read as the block YAML pnpm writes: mappings
 * nested by indentation, plain or quoted scalars, sequences of scalars, and
 * flow collections (`{…}`, `[…]`) kept as their text. Any other line, a line
 * indented unlike its siblings, or a key written twice, is refused rather
 * than read past.
 */
export function parseLockfile(text) {
  const root = {};
  const frames = [{ indent: -1, node: root }];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const where = `pnpm-lock.yaml:${index + 1}`;
    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent);
    while (frames.at(-1).indent >= indent) frames.pop();
    const frame = frames.at(-1);
    frame.childIndent ??= indent;
    if (indent !== frame.childIndent) {
      throw new Error(
        `${where}: indented ${indent}, where its siblings are ${frame.childIndent}`,
      );
    }
    if (body.startsWith("- ")) {
      if (!Array.isArray(frame.node)) {
        if (frame.holder === undefined || Object.keys(frame.node).length > 0) {
          throw new Error(`${where}: a sequence item where a mapping is`);
        }
        frame.node = [];
        frame.holder[frame.key] = frame.node;
      }
      frame.node.push(scalar(body.slice(2), where));
      continue;
    }
    if (Array.isArray(frame.node)) {
      throw new Error(`${where}: a mapping entry inside a sequence`);
    }
    const entry =
      /^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s'"#-][^\s]*?):(?: +(.*))?$/u.exec(
        body,
      );
    if (entry === null) {
      throw new Error(`${where}: not a line pnpm's lockfile writes: ${body}`);
    }
    const key = scalar(entry[1], where);
    if (Object.hasOwn(frame.node, key)) {
      throw new Error(`${where}: ${key} is written twice`);
    }
    if (entry[2] === undefined) {
      const child = {};
      frame.node[key] = child;
      frames.push({ indent, node: child, holder: frame.node, key });
    } else {
      frame.node[key] = scalar(entry[2], where);
    }
  }
  return root;
}

/** A one-level flow mapping's entries: `{integrity: …, tarball: …}`. */
export function flowMapping(text) {
  const inner = /^\{(.*)\}$/u.exec(text?.trim() ?? "");
  if (inner === null) return undefined;
  const fields = {};
  for (const part of inner[1].split(", ")) {
    const at = part.indexOf(": ");
    if (at < 0) return undefined;
    fields[part.slice(0, at)] = scalar(part.slice(at + 2), "flow mapping");
  }
  return fields;
}

/** `@scope/name@ref(peers…)` → its name, and its reference without the peers. */
export function splitKey(key) {
  const at = key.indexOf("@", 1);
  if (at < 0) return { name: key, reference: "" };
  const reference = key.slice(at + 1);
  const peers = reference.indexOf("(");
  return {
    name: key.slice(0, at),
    reference: peers < 0 ? reference : reference.slice(0, peers),
  };
}

/**
 * Every problem with the consumer's lockfile, by step 4's assertion: an empty
 * list is a lockfile in which every `@requestport/*` resolves to the pack's
 * tarballs. `tarballs`: each `{ name, version, path, integrity }`;
 * `consumer`: the directory holding the lockfile; `direct`: the names the
 * consumer depends on (`CONSUMER_DEPENDENCIES`); `overridden`: the names its
 * overrides map (`S8`). A relative `file:` path is read from its real path,
 * or from its path as given.
 */
export function lockfileProblems(
  lock,
  { consumer, tarballs, direct, overridden },
) {
  const problems = [];
  const byName = new Map(tarballs.map((tarball) => [tarball.name, tarball]));
  const bases = [...new Set([realpathSync(consumer), resolve(consumer)])];
  const named = (text) =>
    typeof text === "string" && text.includes("@requestport/");
  const mapping = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value
      : {};
  const examined = new Set();
  const mark = (...path) => examined.add(JSON.stringify(path));

  // A reference names the tarball when it is `file:<path>`, its peers
  // stripped, and the path, absolute or relative to the consumer, is the
  // tarball's file.
  const namesTarball = (reference, tarball) => {
    if (typeof reference !== "string") return false;
    const path = reference.split("(")[0];
    if (!path.startsWith("file:")) return false;
    const file = path.slice("file:".length);
    const real = realpathSync(tarball.path);
    return (
      isAbsolute(file) ? [file] : bases.map((base) => resolve(base, file))
    ).some(
      (candidate) => existsSync(candidate) && realpathSync(candidate) === real,
    );
  };
  const check = (where, name, reference) => {
    const tarball = byName.get(name);
    if (tarball === undefined) {
      problems.push(`${where}: ${name} is not a tarball of the pack`);
    } else if (!namesTarball(reference, tarball)) {
      problems.push(
        `${where}: ${name} resolves to ${JSON.stringify(reference)}, not a file: tarball of the pack`,
      );
    }
  };

  if (lock.lockfileVersion !== "9.0") {
    problems.push(
      `lockfileVersion is ${JSON.stringify(lock.lockfileVersion)}; the assertion reads version 9.0`,
    );
  }

  const overrides = mapping(lock.overrides);
  for (const [name, reference] of Object.entries(overrides)) {
    if (!named(name)) continue;
    mark("overrides", name);
    if (!overridden.includes(name)) {
      problems.push(
        `overrides: ${name} is overridden, where the consumer overrides ${overridden.join(", ")} and no other`,
      );
    }
    check("overrides", name, reference);
  }
  for (const name of overridden) {
    if (!Object.hasOwn(overrides, name)) {
      problems.push(`overrides: no override for ${name}`);
    }
  }

  const depended = new Set();
  for (const [importer, groups] of Object.entries(mapping(lock.importers))) {
    for (const [group, dependencies] of Object.entries(mapping(groups))) {
      for (const [name, dependency] of Object.entries(mapping(dependencies))) {
        if (!named(name)) continue;
        mark("importers", importer, group, name);
        mark("importers", importer, group, name, "specifier");
        mark("importers", importer, group, name, "version");
        const where = `importers: ${importer}, ${group}`;
        check(`${where}, specifier`, name, mapping(dependency).specifier);
        check(`${where}, version`, name, mapping(dependency).version);
        if (importer === ".") depended.add(name);
        if (importer === "." && !direct.includes(name)) {
          problems.push(
            `${where}: the consumer depends on ${name}, which it does not import`,
          );
        }
      }
    }
  }
  for (const name of direct) {
    if (!depended.has(name)) {
      problems.push(`importers: the consumer does not depend on ${name}`);
    }
  }

  const packaged = new Map();
  for (const [key, entry] of Object.entries(mapping(lock.packages))) {
    const { name, reference } = splitKey(key);
    if (!name.startsWith("@requestport/")) continue;
    mark("packages", key);
    packaged.set(name, (packaged.get(name) ?? 0) + 1);
    const where = `packages: ${key}`;
    check(where, name, reference);
    const tarball = byName.get(name);
    const resolution = flowMapping(mapping(entry).resolution);
    if (resolution === undefined) {
      problems.push(
        `${where}: its resolution is ${JSON.stringify(mapping(entry).resolution)}, not {integrity, tarball}`,
      );
    } else if (tarball !== undefined) {
      if (resolution.tarball === undefined) {
        problems.push(`${where}: its resolution names no tarball`);
      } else {
        check(`${where}, resolution`, name, resolution.tarball);
      }
      if (resolution.integrity !== tarball.integrity) {
        problems.push(
          `${where}: its integrity ${resolution.integrity} is not the build record's ${tarball.integrity}`,
        );
      }
    }
    if (
      tarball !== undefined &&
      reference.startsWith("file:") &&
      mapping(entry).version !== tarball.version
    ) {
      problems.push(
        `${where}: its version is ${JSON.stringify(mapping(entry).version)}, not the build record's ${tarball.version}`,
      );
    }
  }
  for (const name of byName.keys()) {
    if (packaged.get(name) !== 1) {
      problems.push(
        `packages: ${name} is there ${packaged.get(name) ?? 0} times, not once`,
      );
    }
  }

  const snapshotted = new Set();
  for (const [key, entry] of Object.entries(mapping(lock.snapshots))) {
    const { name, reference } = splitKey(key);
    if (name.startsWith("@requestport/")) {
      mark("snapshots", key);
      snapshotted.add(name);
      check(`snapshots: ${key}`, name, reference);
    }
    for (const group of ["dependencies", "optionalDependencies"]) {
      const dependencies = mapping(mapping(entry)[group]);
      for (const [dependency, value] of Object.entries(dependencies)) {
        if (!named(dependency)) continue;
        mark("snapshots", key, group, dependency);
        check(`snapshots: ${key}, ${group}`, dependency, value);
      }
    }
  }
  for (const name of byName.keys()) {
    if (!snapshotted.has(name))
      problems.push(`snapshots: no snapshot of ${name}`);
  }

  // Every key and value that names `@requestport/` must be one of the above.
  const walk = (node, path) => {
    const children = Array.isArray(node)
      ? node.map((value, index) => [index, value])
      : Object.entries(mapping(node));
    for (const [key, value] of children) {
      const at = [...path, key];
      const seen = examined.has(JSON.stringify(at));
      if ((named(key) || named(value)) && !seen) {
        problems.push(
          `${at.join(" > ")} names @requestport/ where the assertion does not look`,
        );
      }
      if (typeof value === "object" && value !== null) walk(value, at);
    }
  };
  walk(lock, []);
  return problems;
}

/**
 * Lockfiles the assertion must report, each made from a copy of the real
 * one, with the texts its report must hold. `version` is the stamped
 * version, one for every package of the pack (J question 10), the one a
 * registry would be asked for. The first and the last are the
 * dependency-confusion path (manifest-g.md §4 step 3): `auth`'s dependency on
 * core, and the first package's dependency on `domain`, which the consumer
 * reaches only through the overrides, served by a registry instead of the
 * tarball, beside it.
 */
export const LOCKFILE_PLANTS = Object.freeze([
  {
    name: "auth's dependency on core resolved from the registry",
    expect: [
      "dependencies: @requestport/core resolves to",
      "its resolution names no tarball",
      "packages: @requestport/core is there 2 times",
    ],
    plant(text, { version }) {
      return replaceOnce(
        replaceOnce(
          text,
          /^( {6}'@requestport\/core': )file:\S+$/mu,
          `$1${version}`,
        ),
        /^packages:\n\n/mu,
        `packages:\n\n  '@requestport/core@${version}':\n    resolution: {integrity: sha512-${"A".repeat(86)}==}\n\n`,
      );
    },
  },
  {
    name: "core's tarball with another integrity",
    expect: ["is not the build record's sha512-"],
    plant(text) {
      return replaceOnce(
        text,
        /^( {4}resolution: \{integrity: sha512-)(.)(\S*, tarball: file:\S*requestport-core-)/mu,
        (_, head, first, tail) => `${head}${first === "A" ? "B" : "A"}${tail}`,
      );
    },
  },
  {
    name: "the consumer's dependency on core at the registry's version",
    expect: [
      "importers: ., dependencies, version: @requestport/core resolves to",
    ],
    plant(text, { version }) {
      return replaceOnce(
        text,
        /^( {6}'@requestport\/core':\n {8}specifier: \S+\n {8}version: )\S+$/mu,
        `$1${version}`,
      );
    },
  },
  {
    name: "no override for core",
    expect: ["overrides: no override for @requestport/core"],
    plant(text) {
      return replaceOnce(text, /^ {2}'@requestport\/core': file:\S+\n/mu, "");
    },
  },
  {
    name: "core named where the assertion does not look",
    expect: ["names @requestport/ where the assertion does not look"],
    plant(text) {
      return replaceOnce(
        text,
        /^( {4}transitivePeerDependencies:\n)/mu,
        "$1      - '@requestport/core'\n",
      );
    },
  },
  {
    name: "no override for domain, which the consumer reaches only through the overrides",
    expect: ["overrides: no override for @requestport/domain"],
    plant(text) {
      return replaceOnce(text, /^ {2}'@requestport\/domain': file:\S+\n/mu, "");
    },
  },
  {
    name: "a second copy of domain, a package's dependency on it resolved from the registry",
    expect: [
      "dependencies: @requestport/domain resolves to",
      "packages: @requestport/domain is there 2 times",
    ],
    plant(text, { version }) {
      return replaceOnce(
        replaceOnce(
          text,
          /^( {6}'@requestport\/domain': )file:\S+$/mu,
          `$1${version}`,
        ),
        /^packages:\n\n/mu,
        `packages:\n\n  '@requestport/domain@${version}':\n    resolution: {integrity: sha512-${"A".repeat(86)}==}\n\n`,
      );
    },
  },
]);

function replaceOnce(text, pattern, replacement) {
  if (!pattern.test(text)) {
    throw new Error(
      `core-tarball-smoke: a plant cannot be applied: the lockfile has no match for ${pattern}.`,
    );
  }
  return text.replace(pattern, replacement);
}

/** Each lockfile plant the assertion does not report, with what it reported. */
export function unreportedLockfilePlants(text, context) {
  const unreported = [];
  for (const plant of LOCKFILE_PLANTS) {
    const problems = lockfileProblems(
      parseLockfile(plant.plant(text, context)),
      context,
    );
    if (
      !plant.expect.every((expected) =>
        problems.some((problem) => problem.includes(expected)),
      )
    ) {
      unreported.push({ plant: plant.name, problems });
    }
  }
  return unreported;
}

/** The lockfile's lines that name `@requestport/` or a tarball of the pack. */
function requestPortLines(text, tarballs) {
  const files = tarballs.map(({ path }) => basename(path));
  return text
    .split("\n")
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter(
      ({ text: line }) =>
        line.includes("@requestport/") ||
        files.some((file) => line.includes(file)),
    );
}

/**
 * Each of `names` as pnpm installed it in `consumer`: the directories of
 * pnpm's store that hold it (`node_modules/.pnpm/<name, its / as +>@…/
 * node_modules/<name>`), each by its real path, with the version its
 * manifest names.
 */
export function installedCopies(consumer, names) {
  const store = join(consumer, "node_modules", ".pnpm");
  const entries = existsSync(store) ? readdirSync(store).sort() : [];
  return Object.fromEntries(
    names.map((name) => {
      const prefix = `${name.replace("/", "+")}@`;
      const copies = entries
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => join(store, entry, "node_modules", name))
        .filter((directory) => existsSync(join(directory, "package.json")))
        .map((directory) => ({
          directory: realpathSync(directory),
          version: JSON.parse(
            readFileSync(join(directory, "package.json"), "utf8"),
          ).version,
        }));
      return [name, copies];
    }),
  );
}

/**
 * Step 4's reading of what pnpm installed (`copies`, `installedCopies`'):
 * each tarball's package once in pnpm's store, at the build record's
 * version, so that no package's code is there twice; and each of `direct`
 * linked from the consumer's `node_modules` to that one copy.
 */
export function installedProblems(copies, { consumer, tarballs, direct }) {
  const problems = [];
  for (const { name, version } of tarballs) {
    const found = copies[name] ?? [];
    if (found.length !== 1) {
      problems.push(
        `node_modules/.pnpm holds ${found.length} copies of ${name}, not one`,
      );
    }
    for (const copy of found) {
      if (copy.version !== version) {
        problems.push(
          `${name} is installed at ${copy.version}, not the build record's ${version}`,
        );
      }
    }
  }
  for (const name of direct) {
    const link = join(consumer, "node_modules", name);
    const found = copies[name] ?? [];
    if (!existsSync(join(link, "package.json"))) {
      problems.push(`node_modules/${name} is not there`);
    } else if (
      found.length === 1 &&
      realpathSync(link) !== found[0].directory
    ) {
      problems.push(
        `node_modules/${name} is ${realpathSync(link)}, not pnpm's one copy, ${found[0].directory}`,
      );
    }
  }
  return problems;
}

/** Step 5's fixture: its directory, and the files copied from it into the consumer. */
export const FIXTURE = Object.freeze({
  directory: join(repositoryRoot, "scripts", "core-tarball-smoke"),
  files: Object.freeze(["consumer.ts", "tsconfig.json"]),
});

/** The consumer's installed `tsc`: `typescript`'s `bin.tsc`, and its version. */
export function consumerTsc(consumer) {
  const directory = join(consumer, "node_modules", "typescript");
  const manifest = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  const bin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.tsc;
  if (typeof bin !== "string") {
    throw new Error(`core-tarball-smoke: ${directory} names no tsc bin.`);
  }
  return { version: manifest.version, path: join(directory, bin) };
}

/**
 * Step 5's tools in the consumer: its `tsc` (`consumerTsc`) and its
 * `@types/node`'s version. Each must be the version the consumer declared in
 * `devDependencies`, or it is a problem.
 */
export function consumerTypeCheckTools(consumer, devDependencies) {
  const tsc = consumerTsc(consumer);
  const typesNode = JSON.parse(
    readFileSync(
      join(consumer, "node_modules", "@types", "node", "package.json"),
      "utf8",
    ),
  ).version;
  const problems = [];
  if (tsc.version !== devDependencies.typescript) {
    problems.push(
      `the consumer's typescript is ${tsc.version}, not ${devDependencies.typescript}`,
    );
  }
  if (typesNode !== devDependencies["@types/node"]) {
    problems.push(
      `the consumer's @types/node is ${typesNode}, not ${devDependencies["@types/node"]}`,
    );
  }
  return { tsc, typesNode, problems };
}

/** The arguments of a step-5 `tsc` run, in the directory of its tsconfig. */
export function tscArguments(skipLibCheck) {
  return [
    "-p",
    "tsconfig.json",
    "--noEmit",
    "--pretty",
    "false",
    "--skipLibCheck",
    String(skipLibCheck),
  ];
}

const TSC_LOCATED = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/u;
const TSC_UNLOCATED = /^error (TS\d+): (.*)$/u;

/**
 * `tsc --pretty false`'s report, read: each `<file>(<line>,<column>): error
 * TS<code>: <message>`, or `error TS<code>: <message>` with no file, with the
 * indented lines below it as the rest of its message. Every other line, an
 * indented one below such a line included, is returned in `unread`.
 */
export function parseTscReport(output) {
  const diagnostics = [];
  const unread = [];
  let current;
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    if (/^\s/u.test(line)) {
      if (current === undefined) unread.push(line);
      else current.message += `\n${line}`;
      continue;
    }
    const located = TSC_LOCATED.exec(line);
    const unlocated = located === null ? TSC_UNLOCATED.exec(line) : null;
    if (located !== null) {
      current = {
        file: located[1],
        line: Number(located[2]),
        column: Number(located[3]),
        code: located[4],
        message: located[5],
      };
    } else if (unlocated !== null) {
      current = {
        file: null,
        line: null,
        column: null,
        code: unlocated[1],
        message: unlocated[2],
      };
    } else {
      current = undefined;
      unread.push(line);
      continue;
    }
    diagnostics.push(current);
  }
  return { diagnostics, unread };
}

/**
 * The third-party package a file belongs to, by its path from the consumer's
 * real path (`/`-separated): a `.d.ts`, `.d.mts` or `.d.cts` file of a package
 * in the consumer's `node_modules/.pnpm/<directory>/node_modules/<name>/`, no
 * part of whose path names `@requestport`. Returns `{ name, version }`, the
 * version read from pnpm's directory name where that begins with the name, or
 * `{ refusal }`.
 */
export function thirdPartyDeclaration(path) {
  if (path.includes("@requestport/") || path.includes("@requestport+")) {
    return { refusal: "is in an @requestport/* package" };
  }
  const match =
    /^node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/u.exec(
      path,
    );
  if (match === null) {
    return {
      refusal: "is not in a package under the consumer's node_modules/.pnpm",
    };
  }
  const [, directory, name, file] = match;
  if (!/\.d\.[cm]?ts$/u.test(file)) {
    return { refusal: "is not a declaration file" };
  }
  const prefix = `${name.replace("/", "+")}@`;
  return {
    name,
    version: directory.startsWith(prefix)
      ? directory.slice(prefix.length).split("_")[0]
      : undefined,
  };
}

/**
 * Step 5's pass rule for one `tsc` run (ruling 150). With `skipLibCheck`
 * true, every error is a problem. With it false, every error must be in a
 * third-party declaration (`thirdPartyDeclaration`), and is counted by
 * package and code. `cwd` is where tsc ran: a path it reports is read from
 * there, under its real path or its path as given, and judged from the
 * consumer's real path. A line of the report the reader cannot read, an exit
 * that is not one, and an exit other than 0 with no error read, are problems
 * too.
 */
export function typeCheckProblems(run, { cwd, consumer, skipLibCheck }) {
  const { diagnostics, unread } = parseTscReport(run.output);
  const problems = unread.map(
    (line) => `tsc wrote a line the check cannot read: ${line}`,
  );
  const byPackage = {};
  const root = realpathSync(consumer);
  const bases = [...new Set([realpathSync(cwd), resolve(cwd)])];
  for (const diagnostic of diagnostics) {
    const head = `error ${diagnostic.code}: ${diagnostic.message.split("\n")[0]}`;
    if (diagnostic.file === null) {
      problems.push(`an error in no file: ${head}`);
      continue;
    }
    const text = `${diagnostic.file}(${diagnostic.line},${diagnostic.column}): ${head}`;
    if (skipLibCheck) {
      problems.push(`with skipLibCheck true: ${text}`);
      continue;
    }
    const found = bases
      .map((base) => resolve(base, diagnostic.file))
      .find((candidate) => existsSync(candidate));
    if (found === undefined) {
      problems.push(`an error in a file that is not there: ${text}`);
      continue;
    }
    const path = relative(root, realpathSync(found)).split(sep).join("/");
    const owner = thirdPartyDeclaration(path);
    if (owner.refusal !== undefined) {
      problems.push(`${path} ${owner.refusal}: ${text}`);
      continue;
    }
    const key =
      owner.version === undefined
        ? owner.name
        : `${owner.name}@${owner.version}`;
    byPackage[key] ??= { errors: 0, codes: {} };
    byPackage[key].errors += 1;
    byPackage[key].codes[diagnostic.code] =
      (byPackage[key].codes[diagnostic.code] ?? 0) + 1;
  }
  if (!Number.isInteger(run.status)) {
    problems.push(`tsc did not exit: ${run.signal}`);
  } else if (run.status !== 0 && diagnostics.length === 0) {
    problems.push(
      `tsc exited ${run.status} and reported no error the check can read`,
    );
  }
  return { problems, errors: diagnostics.length, byPackage };
}

/** A name core's `.` does not export, which step 5's plant imports. */
export const PLANTED_IMPORT = "plantedNameCoreDoesNotExport";

/** The fixture's script with an import of `PLANTED_IMPORT` from core's `.` above it. */
export function plantImport(source) {
  return `import { ${PLANTED_IMPORT} } from "@requestport/core";\n${source}`;
}

/** Whether a run's problems report the planted import: TS2305, naming it. */
export function plantReported(problems) {
  return problems.some(
    (problem) =>
      problem.includes("error TS2305: ") &&
      problem.includes(`'${PLANTED_IMPORT}'`),
  );
}

/** The hosts `--database` may name: this machine's loopback. */
export const LOOPBACK_HOSTS = Object.freeze([
  "127.0.0.1",
  "localhost",
  "[::1]",
]);

/**
 * `--database`, checked: a `postgres:` or `postgresql:` URL of a loopback
 * host, with a user and a database to connect to, and no query or fragment.
 * Anything else is refused, because step 6 creates and drops a database and
 * a login there. Returns the URL and its spelling with the password hidden.
 */
export function localServer(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("core-tarball-smoke: --database is not a URL.");
  }
  const refuse = (why) => {
    throw new Error(`core-tarball-smoke: --database ${why}.`);
  };
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    refuse(`is a ${url.protocol} URL, not a postgres: one`);
  }
  if (!LOOPBACK_HOSTS.includes(url.hostname)) {
    refuse(`names ${url.hostname}, not this machine's loopback`);
  }
  if (url.username === "") refuse("names no user");
  if (url.pathname.length <= 1) refuse("names no database to connect to");
  if (url.search !== "" || url.hash !== "") refuse("carries a query");
  const redacted = new URL(url);
  if (redacted.password !== "") redacted.password = "***";
  return { url: url.toString(), redacted: redacted.toString() };
}

/**
 * Step 6's whole environment for the consumer: `PATH` as step 4's, `HOME` at
 * the consumer's empty home, and `TMPDIR` only when this process has one.
 */
export function runEnvironment(home, env = process.env) {
  return {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    HOME: home,
    ...(env.TMPDIR === undefined ? {} : { TMPDIR: env.TMPDIR }),
  };
}

/**
 * The names the consumer's environment may hold: `runEnvironment`'s, and the
 * one macOS adds to every process it starts (`__CF_USER_TEXT_ENCODING`).
 */
export const RUN_ENVIRONMENT_NAMES = Object.freeze([
  "HOME",
  "PATH",
  "TMPDIR",
  "__CF_USER_TEXT_ENCODING",
]);

/**
 * §2.6's thirteen F.0 modules (the human-only OAuth consent left out), each
 * with the principal ruling 153 rules for its capability: the person
 * (ruling 63), but Slack's read, which admits network credentials only, as
 * the operator, and the legacy import's analysis as an agent key issued as
 * the person. settings/projects' person acts by delegation: core's
 * `mcpOnly.createProject` takes the person's user id as `delegatedByUserId`
 * (ruling 154) and the person's session id as `credentialId`, which it
 * re-checks as the bus re-checks a person (ruling 230 item 2). The fixture's
 * `MODULES` lists the same names.
 */
export const RULED_PRINCIPALS = Object.freeze({
  "(app)/actions.ts": "person",
  "settings/appearance": "person",
  "settings/projects": "person",
  "settings/projects/[projectId]": "person",
  "settings/operations": "person",
  "settings/members": "person",
  "settings/routing": "person",
  agents: "person",
  imports: "agent",
  webhooks: "person",
  requests: "person",
  slack: "operator",
  "settings/operators": "person",
});

/**
 * What `requestport_private.bound_organization_id()`, which every tenant
 * policy reads, raises with code 42501 when no organisation is bound to the
 * transaction (`packages/db/migrations/0019_row_security_expand.sql`).
 */
export const UNBOUND_MESSAGE =
  "requestport: no organisation is bound to this transaction";

/**
 * The optional peer `db` declares for its PGlite driver
 * (`PACKAGES.db.optionalPeers`). G.8's consumer installs `db` without it:
 * G.8 runs on `pg`, and a run with PGlite present is H.8's (ruling 153).
 */
export const PGLITE = "@electric-sql/pglite";

/**
 * What `db`'s `createStorage({ driver: "pglite" })` throws with `PGLITE`
 * absent: the refusal H.4 words in `@requestport/db`'s `loadPgliteDriver`
 * (rulings 138, 151 and 154), whose message starts with `message`. It keeps
 * Node's `code`, and holds Node's own error for the module it cannot find as
 * its first cause, whose message's first line is `cause`. It also keeps that
 * error's `requireStack`, which names the file that asked for the module,
 * then the files that loaded that one.
 */
export const PGLITE_ABSENT = Object.freeze({
  code: "MODULE_NOT_FOUND",
  message: `A PGlite storage needs ${PGLITE}, and it is not installed`,
  cause: `Cannot find module '${PGLITE}'`,
});

/**
 * Where the consumer holds `PGLITE`, which step 6's PGlite case needs absent:
 * an empty list when it is nowhere. In the parsed lockfile `lock`, a key
 * naming it or a version of it, except directly under `peerDependencies` or
 * `peerDependenciesMeta`, which only declare it; and a key or a value
 * carrying it as a resolved peer (`(@electric-sql/pglite@…)`). In
 * `consumer`, its directory in `node_modules`, hoisted in pnpm's store
 * (`node_modules/.pnpm/node_modules`), or in that store under its own name.
 * Each is named by its lockfile path, or its path from `consumer`.
 */
export function installedPglite(lock, consumer) {
  const found = [];
  const resolvedPeer = `(${PGLITE}@`;
  const walk = (node, path) => {
    if (typeof node !== "object" || node === null) return;
    const declares = ["peerDependencies", "peerDependenciesMeta"].includes(
      path.at(-1),
    );
    for (const [key, value] of Object.entries(node)) {
      const at = [...path, key].join(" > ");
      if (
        (splitKey(key).name === PGLITE && !declares) ||
        key.includes(resolvedPeer)
      ) {
        found.push(`pnpm-lock.yaml: ${at}`);
      } else if (typeof value === "string" && value.includes(resolvedPeer)) {
        found.push(`pnpm-lock.yaml: ${at}: ${value}`);
      }
      walk(value, [...path, key]);
    }
  };
  walk(lock, []);
  for (const directory of [
    `node_modules/${PGLITE}`,
    `node_modules/.pnpm/node_modules/${PGLITE}`,
  ]) {
    if (existsSync(join(consumer, directory))) found.push(directory);
  }
  const store = join(consumer, "node_modules", ".pnpm");
  if (existsSync(store)) {
    for (const entry of readdirSync(store).sort()) {
      if (entry.startsWith(`${PGLITE.replace("/", "+")}@`)) {
        found.push(`node_modules/.pnpm/${entry}`);
      }
    }
  }
  return found;
}

/**
 * A copy of the parsed lockfile `lock` with `PGLITE` at 0.5.8, the version
 * `db` declares, entered in `packages` and in `snapshots`: what
 * `installedPglite` must find. `lock` is left as it was.
 */
export function plantPglite(lock) {
  const copy = structuredClone(lock);
  const key = `${PGLITE}@0.5.8`;
  copy.packages = {
    ...copy.packages,
    [key]: { resolution: "{integrity: sha512-planted}" },
  };
  copy.snapshots = { ...copy.snapshots, [key]: "{}" };
  return copy;
}

/**
 * The values core's entries re-export from `db`'s, by subpath, which the
 * fixture's identity case must find to be `db`'s own: on `.`, Done when
 * 12's `createStorage`, the role guard's `createDatabaseRoleGuard` and
 * `DatabaseSurfaceError` (ruling 150), and `createWorkerStorages` (ruling
 * 151); on `./migrate`, `migrate`. The fixture compares every value the two
 * entries share by name, these among them.
 */
export const IDENTITY_REQUIRED = Object.freeze({
  ".": Object.freeze([
    "DatabaseSurfaceError",
    "createDatabaseRoleGuard",
    "createStorage",
    "createWorkerStorages",
  ]),
  "./migrate": Object.freeze(["migrate"]),
});

/**
 * Step 6's judgement of the report the consumer wrote (`RunReport`,
 * `scripts/core-tarball-smoke/consumer.ts`): every problem, in words.
 * `database`: the database the run was handed. `db`: `db`'s installed
 * package, by its real path, as Node names the files of an error's
 * `requireStack`; the PGlite case's lookup must start in it, since `db`'s
 * `createStorage` loads the peer.
 */
export function runProblems(report, { database, db }) {
  if (report === null || typeof report !== "object") {
    return ["the consumer wrote no report"];
  }
  const problems = [];
  if (report.error !== null) {
    problems.push(`the run stopped: ${report.error?.message ?? report.error}`);
  }
  if (report.database !== database) {
    problems.push(
      `the report names the database ${report.database}, not ${database}`,
    );
  }
  if (!Array.isArray(report.environment)) {
    problems.push("the report names no environment");
  } else {
    for (const name of report.environment) {
      if (!RUN_ENVIRONMENT_NAMES.includes(name)) {
        problems.push(`the consumer's environment holds ${name}`);
      }
    }
  }
  if (!(report.migrate?.applied > 0)) {
    problems.push("migrate applied no migration to the fresh database");
  }
  if (
    report.owner?.status !== "owner_active" ||
    report.owner?.localCredential !== "issued"
  ) {
    problems.push(
      `bootstrapOwner answered ${JSON.stringify(report.owner)}, not owner_active with a credential issued`,
    );
  }
  if (report.signIn?.session !== true) {
    problems.push("the person was not signed in");
  }
  const results = Array.isArray(report.capabilities) ? report.capabilities : [];
  for (const [module, principal] of Object.entries(RULED_PRINCIPALS)) {
    const found = results.filter((result) => result.module === module);
    if (found.length !== 1) {
      problems.push(`${module}: ${found.length} results, not 1`);
      continue;
    }
    const [result] = found;
    if (result.principal !== principal) {
      problems.push(
        `${module}: run as ${result.principal}, not ${principal} (ruling 153)`,
      );
    }
    if (result.readBack?.found !== true) {
      problems.push(
        `${module}: the effect of ${result.capability} was not read back through ${result.readBack?.through}`,
      );
    }
  }
  for (const result of results) {
    if (!Object.hasOwn(RULED_PRINCIPALS, result.module)) {
      problems.push(
        `a result for ${result.module}, which is not a module of the list`,
      );
    }
  }
  const negative = report.negative;
  if (negative === null || typeof negative !== "object") {
    problems.push('the tenantBinding "off" case did not run');
  } else if (negative.outcome !== "failed") {
    problems.push(
      `the tenantBinding "off" read answered: ${JSON.stringify(negative.answered)}`,
    );
  } else {
    const errors = [negative.error, ...(negative.error?.causes ?? [])];
    if (
      !errors.some(
        (error) =>
          error?.code === "42501" &&
          String(error.message).includes(UNBOUND_MESSAGE),
      )
    ) {
      problems.push(
        `the tenantBinding "off" read failed, but not with 42501 "${UNBOUND_MESSAGE}": ${JSON.stringify(negative.error)}`,
      );
    }
  }
  for (const copy of ["core", "agentServices", "auth"]) {
    if (report.domainErrors?.[copy]?.name !== "DomainError") {
      problems.push(`the ${copy} refusal was no DomainError`);
    }
  }
  const classes = [
    "coreSameClassAsAgentServices",
    "coreSameClassAsAuth",
    "authInstanceOfCoreClass",
    "coreInstanceOfAuthClass",
  ].filter((comparison) => report.domainErrors?.[comparison] !== true);
  if (classes.length > 0) {
    problems.push(
      `the refusals' DomainError classes are not one, so @requestport/domain's code is loaded more than once: ${classes.join(", ")} not true`,
    );
  }
  const identity = report.identity;
  if (identity === null || typeof identity !== "object") {
    problems.push("the identity case did not run");
  } else {
    for (const [subpath, names] of Object.entries(IDENTITY_REQUIRED)) {
      const shared = identity.shared?.[subpath] ?? [];
      for (const name of names) {
        if (!shared.includes(name)) {
          problems.push(
            `core's ${subpath} and db's ${subpath} share no ${name}, which core re-exports`,
          );
        }
      }
      for (const name of identity.differing?.[subpath] ?? []) {
        problems.push(
          `core's ${subpath} exports ${name}, and it is not db's own: @requestport/db's code is loaded more than once`,
        );
      }
    }
  }
  if (report.close?.sessions !== 0) {
    problems.push(
      `pg_stat_activity holds ${report.close?.sessions} sessions of the database after close()`,
    );
  }
  if (report.dropped?.database !== true) {
    problems.push(`the database ${report.database} was not dropped`);
  }
  if (report.dropped?.login !== true) {
    problems.push(`the login ${report.login} was not dropped`);
  }
  const pglite = report.pglite;
  if (pglite === null || typeof pglite !== "object") {
    problems.push("the PGlite case did not run");
  } else if (pglite.outcome !== "threw") {
    problems.push(
      pglite.outcome === "returned"
        ? `createStorage({ driver: "pglite" }) answered a storage with ${PGLITE} absent`
        : `the PGlite case's outcome is ${JSON.stringify(pglite.outcome)}, not "threw"`,
    );
  } else {
    const cause = Array.isArray(pglite.error?.causes)
      ? pglite.error.causes[0]
      : undefined;
    if (
      pglite.error?.code !== PGLITE_ABSENT.code ||
      !String(pglite.error?.message).startsWith(PGLITE_ABSENT.message) ||
      cause?.code !== PGLITE_ABSENT.code ||
      String(cause?.message).split("\n", 1)[0] !== PGLITE_ABSENT.cause
    ) {
      problems.push(
        `createStorage({ driver: "pglite" }) failed, but not with H.4's refusal, ${PGLITE_ABSENT.code} "${PGLITE_ABSENT.message}…" whose first cause is ${PGLITE_ABSENT.code} "${PGLITE_ABSENT.cause}" (rulings 151 and 154): ${JSON.stringify(pglite.error)}`,
      );
    }
    const first = Array.isArray(pglite.requireStack)
      ? pglite.requireStack[0]
      : undefined;
    if (typeof first !== "string" || !first.startsWith(`${db}${sep}`)) {
      problems.push(
        `the lookup of ${PGLITE} did not start in db's installed package (${db}): ${JSON.stringify(pglite.requireStack ?? null)}`,
      );
    }
  }
  return problems;
}

/** Each module's one result in `report`, changed by `change`. */
function changeResult(report, module, change) {
  return {
    ...report,
    capabilities: report.capabilities.map((result) =>
      result.module === module ? change(result) : result,
    ),
  };
}

/**
 * Plants in a copy of step 6's report, each with words its problem must
 * hold. `unreportedRunPlants` writes each into the real report, so the
 * judgement must fire on the real object.
 */
export const RUN_PLANTS = Object.freeze([
  {
    plant: "a module with no result",
    change: (report) => ({
      ...report,
      capabilities: report.capabilities.filter(
        ({ module }) => module !== "settings/routing",
      ),
    }),
    expect: "settings/routing: 0 results",
  },
  {
    plant: "an effect not read back",
    change: (report) =>
      changeResult(report, "requests", (result) => ({
        ...result,
        readBack: { ...result.readBack, found: false },
      })),
    expect: "requests: the effect of",
  },
  {
    plant: "a person's row run as the operator",
    change: (report) =>
      changeResult(report, "settings/operations", (result) => ({
        ...result,
        principal: "operator",
      })),
    expect: "settings/operations: run as operator, not person",
  },
  {
    plant: 'the tenantBinding "off" read answered',
    change: (report) => ({
      ...report,
      negative: { ...report.negative, outcome: "answered", error: null },
    }),
    expect: 'the tenantBinding "off" read answered',
  },
  {
    plant:
      'the tenantBinding "off" read failed with the message under another code',
    change: (report) => ({
      ...report,
      negative: {
        ...report.negative,
        outcome: "failed",
        answered: null,
        error: {
          name: "Error",
          code: null,
          message: "Failed query: planted",
          causes: [{ name: "error", code: "XX000", message: UNBOUND_MESSAGE }],
        },
      },
    }),
    expect: "failed, but not with 42501",
  },
  {
    plant: "a PG variable in the consumer's environment",
    change: (report) => ({
      ...report,
      environment: [...report.environment, "PGHOST"],
    }),
    expect: "the consumer's environment holds PGHOST",
  },
  {
    plant: "REQUESTPORT_APPLICATION_DATABASE_URL in the consumer's environment",
    change: (report) => ({
      ...report,
      environment: [
        ...report.environment,
        "REQUESTPORT_APPLICATION_DATABASE_URL",
      ],
    }),
    expect: "holds REQUESTPORT_APPLICATION_DATABASE_URL",
  },
  {
    plant: "a session left after close()",
    change: (report) => ({
      ...report,
      close: { ...report.close, sessions: 1 },
    }),
    expect: "pg_stat_activity holds 1 sessions",
  },
  {
    plant: "the database left",
    change: (report) => ({
      ...report,
      dropped: { ...report.dropped, database: false },
    }),
    expect: "the database <database> was not dropped",
  },
  {
    plant: "the login left",
    change: (report) => ({
      ...report,
      dropped: { ...report.dropped, login: false },
    }),
    expect: "the login <login> was not dropped",
  },
  {
    plant: "a run that stopped",
    change: (report) => ({
      ...report,
      error: { name: "Error", code: null, message: "planted", causes: [] },
    }),
    expect: "the run stopped: planted",
  },
  {
    plant: "the PGlite case not run",
    change: (report) => ({ ...report, pglite: null }),
    expect: "the PGlite case did not run",
  },
  {
    plant: "a PGlite storage answered with the peer absent",
    change: (report) => ({
      ...report,
      pglite: {
        ...report.pglite,
        outcome: "returned",
        error: null,
        requireStack: null,
      },
    }),
    expect: 'createStorage({ driver: "pglite" }) answered a storage',
  },
  {
    plant: "the PGlite case refused with another error",
    change: (report) => ({
      ...report,
      pglite: {
        ...report.pglite,
        outcome: "threw",
        error: {
          name: "Error",
          code: null,
          message:
            "A PGlite storage needs a dataDir: a directory, or memory://.",
          causes: [],
        },
      },
    }),
    expect:
      'createStorage({ driver: "pglite" }) failed, but not with H.4\'s refusal',
  },
  {
    plant: "Node's generic error in place of H.4's refusal",
    change: (report) => ({
      ...report,
      pglite: {
        ...report.pglite,
        outcome: "threw",
        error: {
          name: "Error",
          code: "MODULE_NOT_FOUND",
          message: `Cannot find module '${PGLITE}'`,
          causes: [],
        },
      },
    }),
    expect:
      'createStorage({ driver: "pglite" }) failed, but not with H.4\'s refusal',
  },
  {
    plant: "the peer looked up outside db's installed package",
    change: (report) => ({
      ...report,
      pglite: {
        ...report.pglite,
        outcome: "threw",
        requireStack: ["/planted/elsewhere/index.js"],
      },
    }),
    expect: `the lookup of ${PGLITE} did not start in db's installed package`,
  },
  {
    plant: "the identity case not run",
    change: (report) => ({ ...report, identity: null }),
    expect: "the identity case did not run",
  },
  {
    plant: "core's createStorage another copy of db's",
    change: (report) => ({
      ...report,
      identity: {
        ...report.identity,
        differing: { ...report.identity?.differing, ".": ["createStorage"] },
      },
    }),
    expect:
      "core's . exports createStorage, and it is not db's own: @requestport/db's code is loaded more than once",
  },
  {
    plant: "core's ./migrate sharing no migrate with db's",
    change: (report) => ({
      ...report,
      identity: {
        ...report.identity,
        shared: { ...report.identity?.shared, "./migrate": [] },
      },
    }),
    expect: "core's ./migrate and db's ./migrate share no migrate",
  },
  {
    plant: "auth's DomainError another class than core's",
    change: (report) => ({
      ...report,
      domainErrors: {
        ...report.domainErrors,
        coreSameClassAsAuth: false,
        authInstanceOfCoreClass: false,
        coreInstanceOfAuthClass: false,
      },
    }),
    expect:
      "the refusals' DomainError classes are not one, so @requestport/domain's code is loaded more than once: coreSameClassAsAuth, authInstanceOfCoreClass, coreInstanceOfAuthClass not true",
  },
]);

/** The plants of `RUN_PLANTS` that `runProblems` does not report in a copy of `report`. */
export function unreportedRunPlants(report, context) {
  const unreported = [];
  for (const { plant, change, expect } of RUN_PLANTS) {
    const words = expect
      .replace("<database>", report.database)
      .replace("<login>", report.login);
    let problems;
    try {
      problems = runProblems(change(structuredClone(report)), context);
    } catch (error) {
      problems = [`the plant could not be written: ${error.message}`];
    }
    if (!problems.some((problem) => problem.includes(words))) {
      unreported.push(plant);
    }
  }
  return unreported;
}

/**
 * G.7a's parse battery (ruling 144), its forty cases as G.7a's survey wrote
 * them, run on the `zod` handed: each case's result, `["ok", data]` or
 * `["no", [code, path, message] per issue]`.
 */
export function zodBattery(z) {
  const r = (schema, value) => {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? ["ok", parsed.data]
      : [
          "no",
          parsed.error.issues.map((issue) => [
            issue.code,
            issue.path.join("."),
            issue.message,
          ]),
        ];
  };
  return {
    objStrip: r(z.object({ a: z.string() }), { a: "x", b: 1 }),
    objStrict: r(z.object({ a: z.string() }).strict(), { a: "x", b: 1 }),
    defaultUndef: r(z.object({ a: z.boolean().default(false) }), {}),
    optionalNull: r(z.object({ a: z.string().optional() }), { a: null }),
    nullableOpt: r(z.object({ a: z.string().nullable().optional() }), {}),
    recordEnum: r(z.record(z.enum(["x", "y"]), z.number()), { x: 1 }),
    recordString: r(z.record(z.string(), z.unknown()), { a: 1, b: undefined }),
    partialRecord: r(z.partialRecord(z.enum(["x", "y"]), z.number()), { x: 1 }),
    enumBad: r(z.enum(["a", "b"]), "c"),
    intFloat: r(z.number().int(), 1.5),
    intBig: r(z.number().int(), 2 ** 60),
    numInf: r(z.number(), Number.POSITIVE_INFINITY),
    numNaN: r(z.number(), Number.NaN),
    strTrimMax: r(z.string().trim().max(3), "  abcd "),
    strTrimMin: r(z.string().trim().min(1), "   "),
    lengthExact: r(z.string().length(3), "ab"),
    arrayMax: r(z.array(z.string()).max(1), ["a", "b"]),
    unionBad: r(z.union([z.string(), z.number()]), true),
    discUnion: r(
      z.discriminatedUnion("k", [
        z.object({ k: z.literal("a"), v: z.string() }),
        z.object({ k: z.literal("b") }),
      ]),
      { k: "c" },
    ),
    json: r(z.json(), { a: [1, "x", null, { b: true }] }),
    jsonBad: r(z.json(), { a: () => 1 }),
    uuid: r(z.uuid(), "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1"),
    uuidBad: r(z.uuid(), "6f2f6cf6-6c4a-0b1e-9d0d-2f43b5c1b0a1"),
    email: r(z.email(), "a.b+c@example.co.uk"),
    emailBad: r(z.email(), "a@b"),
    regex: r(z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/u), "Abc"),
    coerceNum: r(z.coerce.number(), "12"),
    transform: r(
      z.string().transform((value) => value.length),
      "abc",
    ),
    pipe: r(z.string().pipe(z.coerce.number()), "5"),
    catchy: r(z.number().catch(7), "x"),
    literal: r(z.literal(["a", "b"]), "b"),
    tuple: r(z.tuple([z.string(), z.number()]), ["a", 1, 2]),
    intersection: r(
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
      { a: "x", b: 1 },
    ),
    readonly: r(z.object({ a: z.array(z.string()) }).readonly(), { a: ["x"] }),
    datetimeOffset: r(
      z.iso.datetime({ offset: true }),
      "2026-10-05T12:30+01:00",
    ),
    datetimeLocal: r(z.iso.datetime({ local: true }), "2026-10-05T12:30"),
    extendRefine: r(
      z
        .object({ a: z.number() })
        .refine((value) => value.a > 1, { message: "a>1", path: ["a"] }),
      { a: 0 },
    ),
    superRefine: r(
      z.string().superRefine((value, context) => {
        if (value === "x")
          context.addIssue({ code: "custom", message: "no x" });
      }),
      "x",
    ),
    exactOptional: r(z.object({ a: z.string().exactOptional() }), {
      a: undefined,
    }),
    url: r(z.url(), "https://exa\tmple.com/"),
  };
}

/** The four results ruling 144 measured moving from 4.4.3 to 4.5.4. */
export const RULING_144_MOVED = Object.freeze([
  "numInf",
  "lengthExact",
  "datetimeOffset",
  "url",
]);

/** The cases whose results differ between two runs of the battery, a case one run lacks included. */
export function zodBatteryDifferences(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((name) => JSON.stringify(a[name]) !== JSON.stringify(b[name]))
    .sort();
}

/** The directory of the package named `name` that holds `file`, walking up from it. */
function packageDirectoryOf(file, name) {
  for (let current = dirname(file); ; current = dirname(current)) {
    const manifest = join(current, "package.json");
    if (
      existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, "utf8")).name === name
    ) {
      return current;
    }
    if (dirname(current) === current) {
      throw new Error(`core-tarball-smoke: no ${name} above ${file}.`);
    }
  }
}

/**
 * The `zod` copies the consumer installed (ruling 151): for each package of
 * `packages` (each installed package's directory, by its name) whose
 * manifest declares `zod`, the version it declares, the copy its code
 * resolves, and its bundled files that import `zod`; and the copy Better
 * Auth, which `auth` resolves, resolves in turn (its files are not
 * listed). Then G.7a's battery, run by this Node in `out` with the
 * environment `env`, each run its own process: on each version alone; on
 * both in one process, in each order; and on both after the fixture's own
 * imports (`<consumer>/consumer.ts`, which the run does not start when it is
 * imported), so in the order the consumer loads them. A package that
 * resolves another version than it declares, and a battery that does not
 * run, are problems; the results that differ are recorded, not judged.
 */
export function zodBehaviour(consumer, out, env, packages) {
  const problems = [];
  const resolveFrom = (directory, name) =>
    createRequire(join(directory, "package.json")).resolve(name);
  const describe = (name, directory, declared, listFiles) => {
    const zod = packageDirectoryOf(resolveFrom(directory, "zod"), "zod");
    const version = JSON.parse(
      readFileSync(join(zod, "package.json"), "utf8"),
    ).version;
    if (declared !== null && version !== declared) {
      problems.push(`${name} declares zod ${declared} and resolves ${version}`);
    }
    const dist = join(directory, "dist");
    return {
      declared,
      resolved: version,
      directory: zod,
      filesImportingZod: !listFiles
        ? null
        : existsSync(dist)
          ? readdirSync(dist)
              .filter((file) => file.endsWith(".js"))
              .filter((file) =>
                /\bfrom\s*["']zod["']/u.test(
                  readFileSync(join(dist, file), "utf8"),
                ),
              )
              .sort()
          : [],
    };
  };
  const copies = {};
  for (const [name, directory] of Object.entries(packages)) {
    const declared =
      JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
        .dependencies?.zod ?? null;
    if (declared !== null) {
      copies[name] = describe(name, directory, declared, true);
    }
  }
  const auth = packages["@requestport/auth"];
  if (auth === undefined) {
    throw new Error(
      "core-tarball-smoke: zodBehaviour has no @requestport/auth.",
    );
  }
  const betterAuth = packageDirectoryOf(
    resolveFrom(auth, "better-auth"),
    "better-auth",
  );
  copies["better-auth"] = describe("better-auth", betterAuth, null, false);

  // Two copies in one process share zod's global configuration, its locale
  // among it (`globalThis.__zod_globalConfig`), so each copy is measured
  // alone, as G.7a measured it, then both together in each order, then as
  // the consumer loads them.
  const entries = {};
  for (const { resolved, directory } of Object.values(copies)) {
    const entry = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ).exports?.["."]?.import;
    entries[resolved] ??= pathToFileURL(
      join(directory, typeof entry === "string" ? entry : entry?.default),
    ).href;
  }
  const versions = Object.keys(entries).sort();
  const runner = join(out, "zod-battery.mjs");
  writeFileSync(runner, zodBatteryRunner());
  const fixture = pathToFileURL(join(consumer, FIXTURE.files[0])).href;
  const runBattery = (label, order, preload) => {
    const results = join(out, `zod-battery-${label}.json`);
    const run = runNode(
      runner,
      [results, preload ?? "-", ...order.map((version) => entries[version])],
      { cwd: out, env },
    );
    if (run.status !== 0 || !existsSync(results)) {
      problems.push(`the battery did not run (${label}): ${run.output.trim()}`);
      return null;
    }
    return Object.fromEntries(
      JSON.parse(readFileSync(results, "utf8")).map((answers, at) => [
        order[at],
        answers,
      ]),
    );
  };
  const alone = {};
  for (const version of versions) {
    alone[version] =
      runBattery(`alone-${version}`, [version])?.[version] ?? null;
  }
  const together = {};
  if (versions.length === 2) {
    for (const order of [versions, [...versions].reverse()]) {
      together[`${order[0]} first`] = runBattery(
        `together-${order[0]}-first`,
        order,
      );
    }
  }
  const asTheConsumerLoads = runBattery("consumer", versions, fixture);
  const differences = (a, b) =>
    a === null || b === null || a === undefined || b === undefined
      ? null
      : zodBatteryDifferences(a, b);
  const between = (results) =>
    versions.length === 2
      ? differences(results?.[versions[0]], results?.[versions[1]])
      : [];
  const differing = between(alone);
  return {
    copies,
    versions,
    alone,
    together,
    asTheConsumerLoads,
    differing,
    differingTogether: Object.fromEntries(
      Object.entries(together).map(([order, results]) => [
        order,
        between(results),
      ]),
    ),
    differingAsTheConsumerLoads: between(asTheConsumerLoads),
    ruling144: [...RULING_144_MOVED],
    sameAsRuling144:
      JSON.stringify(differing) ===
      JSON.stringify([...RULING_144_MOVED].sort()),
    problems,
  };
}

/**
 * The battery's runner, written into `<out>`. Its arguments: the file it
 * writes its results to, a module to import first or `-`, and the `zod`
 * entries to run on. It imports that module, then each entry in order, then
 * runs `zodBattery` (its source, written in) on each, and writes the results
 * as one JSON array, in the entries' order.
 */
export function zodBatteryRunner() {
  return `import { writeFileSync } from "node:fs";
const zodBattery = ${zodBattery.toString()};
const [results, preload, ...entries] = process.argv.slice(2);
if (preload !== "-") await import(preload);
const loaded = [];
for (const entry of entries) loaded.push((await import(entry)).z);
writeFileSync(results, JSON.stringify(loaded.map((z) => zodBattery(z))));
`;
}

/** G.A's script (manifest-g.md §0.4), which step 7 runs over the consumer. */
export const LICENCE_INVENTORY = join(
  repositoryRoot,
  "scripts",
  "licence-inventory.mjs",
);

/**
 * The packages of `S8` the consumer depends on, whose closure step 7 asks
 * G.A's script for: core and `db`, of `CONSUMER_DEPENDENCIES`.
 */
export const INVENTORY_PACKAGES = Object.freeze(
  CONSUMER_DEPENDENCIES.filter((name) => S8.includes(name)),
);

/**
 * Its arguments: the closure of `packages` (`INVENTORY_PACKAGES`), in the
 * consumer read as a plain installed tree, without pnpm's report: view (b),
 * what a consumer installs. G.A finds a `--package` only at the consumer's
 * root, where pnpm links the consumer's own dependencies, and adds each
 * first-party package a member's walk reaches to the members, so the
 * members are the set. Its JSON document goes to `json`.
 */
export function licenceInventoryArguments(
  consumer,
  json,
  packages = INVENTORY_PACKAGES,
) {
  return [
    "--root",
    consumer,
    ...packages.flatMap((name) => ["--package", name]),
    "--no-pnpm",
    "--json",
    json,
  ];
}

/**
 * What step 7 compares with: G.A's report as G.7 re-recorded it
 * (`e3067690`) and J.2b re-recorded it over the public seed's workspace,
 * naming the hosted driver's npm package nowhere (ruling 194 item 3 asked
 * for the re-record; ruling 195 rules its method), the S8 row's view (b) in
 * `track-g-licence-reference.json` (rulings 104, 153 and 175), which holds
 * the same `name@version` list as the S1 row's. That file holds
 * `name@version` lists alone, so the licence class of each name in it comes
 * from G.A's report: its table counts no flagged entry in S1's view (b), and
 * the two re-records only took entries out: `uuid@13.0.0` at G.7's, and the
 * hosted driver's npm package at J.2b's. `flagged` maps a reference name to
 * the flags G.A gave it, and so is empty.
 */
export const LICENCE_REFERENCE = Object.freeze({
  file: join(
    repositoryRoot,
    "docs",
    "implementation",
    "plans",
    "2026-09-27-13",
    "track-g-licence-reference.json",
  ),
  row: "S8",
  flagged: Object.freeze({}),
});

/**
 * The reference row's view (b): its `name@version` entries, each name's
 * versions, and the flags of each name that has any (`flagged`).
 */
export function readLicenceReference(
  document = JSON.parse(readFileSync(LICENCE_REFERENCE.file, "utf8")),
  { row = LICENCE_REFERENCE.row, flagged = LICENCE_REFERENCE.flagged } = {},
) {
  const packages = document?.rows?.[row]?.viewB;
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error(
      `core-tarball-smoke: the licence reference has no ${row} row with a view (b).`,
    );
  }
  const names = new Map();
  for (const key of packages) {
    const { name, reference: version } = splitKey(key);
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(version);
  }
  return { row, packages: new Set(packages), names, flagged: { ...flagged } };
}

const byKey = (left, right) =>
  left.key < right.key ? -1 : left.key > right.key ? 1 : 0;

const byName = ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The set's closure in the consumer, package by package, with the licence
 * G.A's classifier (`classifyLicence`) reads from each manifest: G.A's own
 * walk of view (b) (`walkFirstParty`, optional peers not followed) from
 * each of `starts`, found as G.A's script finds a `--package`, and from each
 * first-party package a walk reaches, where that walk found it, as G.A adds
 * it to the members. G.A's document counts licences and lists the flagged
 * entries only; this is where step 7 reads each entry's.
 *
 * - `members`: the names walked, sorted; `missing`: those of `starts` not
 *   found;
 * - `packages`: by member, the keys of its own closure, which passes through
 *   no other first-party package, and the first-party packages it reaches;
 * - `entries`: their union, which G.A's view (b) must equal.
 */
export function consumerLicences(consumer, starts = INVENTORY_PACKAGES) {
  const context = openContext(consumer);
  const directories = new Map();
  const missing = [];
  const queue = [];
  const enqueue = (name, directory) => {
    if (directories.has(name)) return;
    directories.set(name, directory);
    queue.push(name);
  };
  for (const name of starts) {
    const directory = context.locate(name);
    if (directory === undefined) missing.push(name);
    else enqueue(name, directory);
  }
  const packages = {};
  const union = new Map();
  while (queue.length > 0) {
    const name = queue.shift();
    const walk = walkFirstParty(
      context.tree,
      { directory: directories.get(name), name },
      {
        development: false,
        followOptionalPeers: false,
        isFirstParty: context.isFirstParty,
      },
    );
    for (const { key, manifest } of walk.packages.values()) {
      if (union.has(key)) continue;
      const { field, flags } = classifyLicence(manifest);
      union.set(key, {
        key,
        name: manifest.name,
        version: manifest.version,
        field,
        flags,
      });
    }
    for (const [dependency, { directory }] of walk.firstParty) {
      enqueue(dependency, directory);
    }
    packages[name] = {
      keys: [...walk.packages.keys()].sort(),
      firstParty: [...walk.firstParty.keys()].sort(),
    };
  }
  return {
    members: [...directories.keys()].sort(),
    missing,
    packages: Object.fromEntries(Object.entries(packages).sort(byName)),
    entries: [...union.values()].sort(byKey),
  };
}

const flagText = (flags) =>
  flags.length === 0 ? "unflagged" : `flagged ${flags.join(", ")}`;

/** Counts by licence field, as G.A's `byLicence` holds them. */
function countFields(entries) {
  const counts = {};
  for (const { field } of entries) counts[field] = (counts[field] ?? 0) + 1;
  return counts;
}

function sameCounts(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

/**
 * The identifiers a new name's licence may be made of for step 7 to accept
 * it as an addition (ruling 154): the permissive licences among G.A's
 * `RECOGNISED_IDENTIFIERS`. G.A also leaves Creative Commons attribution
 * licences, public-domain dedications, `Python-2.0` and `WTFPL` unflagged;
 * those are not here.
 */
export const ADDITION_IDENTIFIERS = Object.freeze([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MIT-0",
  "Zlib",
]);

/**
 * Whether a consumer can take a package licensed `field` under
 * `ADDITION_IDENTIFIERS` alone: both sides of an `AND`, either side of an
 * `OR`. A leaf's exception is left to G.A, which flags one it does not
 * recognise; a reference to a text of the package's own is not accepted,
 * and neither is a field that is not an SPDX expression.
 */
export function additionAccepted(field) {
  const parsed = parseSpdxExpression(field);
  if (!parsed.ok) return false;
  const accepted = (node) => {
    if (node.operator === "AND") {
      return accepted(node.left) && accepted(node.right);
    }
    if (node.operator === "OR") {
      return accepted(node.left) || accepted(node.right);
    }
    return ADDITION_IDENTIFIERS.includes(node.identifier);
  };
  return accepted(parsed.tree);
}

/**
 * The judgement by name of `entries` against `reference` (ruling 153, which
 * amends ruling 104's `name@version`): a name the reference does not hold
 * that G.A's classifier flags fails, whatever the flag; a known name whose
 * flags differ from the reference's has changed class, and fails. A new name
 * it does not flag is an accepted addition only when a consumer can take it
 * under `ADDITION_IDENTIFIERS` alone (ruling 154); one G.A leaves unflagged
 * under any other identifier (an attribution licence, a public-domain
 * dedication) fails, for the driver to decide. A version the reference does
 * not hold is recorded with its licence. The accepted additions and the
 * other versions are in the comparison, not in the problems.
 */
function judgeByName(entries, reference) {
  const problems = [];
  const comparison = {
    entries: entries.length,
    names: new Set(entries.map(({ name }) => name)).size,
    sameVersion: 0,
    otherVersion: [],
    added: [],
    absent: [],
  };
  for (const entry of entries) {
    const versions = reference.names.get(entry.name);
    if (versions === undefined) {
      if (entry.flags.length > 0) {
        problems.push(
          `${entry.key}: a name the reference does not hold, ${flagText(entry.flags)} (${entry.field})`,
        );
      } else if (additionAccepted(entry.field)) {
        comparison.added.push({ key: entry.key, field: entry.field });
      } else {
        problems.push(
          `${entry.key}: a name the reference does not hold, under ${entry.field}, which G.A does not flag and ADDITION_IDENTIFIERS does not cover (ruling 154)`,
        );
      }
      continue;
    }
    const was = [...(reference.flagged[entry.name] ?? [])].sort();
    if ([...entry.flags].sort().join("\n") !== was.join("\n")) {
      problems.push(
        `${entry.key}: its licence changed class, ${flagText(entry.flags)} (${entry.field}), where the reference's ${entry.name} is ${flagText(was)}`,
      );
    }
    if (reference.packages.has(entry.key)) {
      comparison.sameVersion += 1;
    } else {
      comparison.otherVersion.push({
        key: entry.key,
        field: entry.field,
        flags: entry.flags,
        reference: versions,
      });
    }
  }
  const held = new Set(entries.map(({ name }) => name));
  comparison.absent = [...reference.packages]
    .filter((key) => !held.has(splitKey(key).name))
    .sort();
  return { comparison, problems };
}

/**
 * Step 7's judgement. `result` is G.A's JSON document over the consumer,
 * `licences` what `consumerLicences` read there, `reference` what
 * `readLicenceReference` read, and `members` the set the closure must be
 * (`S8`). Returns the comparison and every problem:
 *
 * - the run: the consumer read as a plain installed tree (no `workspace`),
 *   one candidate whose members are the set, each found, with no dependency
 *   left unresolved; no platform package in the set's closure and no
 *   linux-x64 build skipped there, because no step reads their Linux
 *   counterparts (ruling 151's bindings are the build's, below);
 * - the walk reaches the set and no first-party package outside it, and
 *   agrees with G.A's view (b): the same entries, the same flagged entries,
 *   the same counts by licence;
 * - by name against the reference (`judgeByName`): the set's closure, the
 *   union, and each package's own closure, whose problems are prefixed with
 *   its name. The comparison is the union's, with each package's beside it
 *   in `packages`.
 */
export function licenceProblems(
  result,
  licences,
  reference,
  { members = S8 } = {},
) {
  const problems = [];
  const set = [...members].sort();
  if (result?.workspace !== undefined) {
    problems.push(
      `the inventory read the consumer as a pnpm workspace (${[result.workspace].flat().join(", ")}), not as a plain installed tree`,
    );
  }
  const candidates = result?.candidates ?? [];
  const [candidate] = candidates;
  if (
    candidates.length !== 1 ||
    JSON.stringify(candidate.members) !== JSON.stringify(set)
  ) {
    problems.push(
      `the inventory's members are ${JSON.stringify(candidates.map(({ members }) => members))}, not the set's ${set.join(", ")}`,
    );
  }
  if (candidate === undefined) return { comparison: null, problems };
  for (const name of candidate.missingMembers ?? []) {
    problems.push(`the inventory did not find ${name} in the consumer`);
  }
  const viewB = candidate.viewB ?? {};
  for (const { dependent, name, range, kind } of viewB.unresolved ?? []) {
    problems.push(
      `the inventory could not resolve ${dependent} > ${name} (${range}, ${kind})`,
    );
  }
  for (const { key, os, cpu, libc } of candidate.platform ?? []) {
    problems.push(
      `the set's closure holds a platform package, ${key} (${[os, cpu, libc].flat().filter(Boolean).join(" ")}): no step reads its Linux counterparts`,
    );
  }
  for (const { dependent, name } of candidate.linuxX64 ?? []) {
    problems.push(
      `the set's closure skipped a linux-x64 build, ${dependent} > ${name}: no step reads its licence`,
    );
  }

  for (const name of licences.missing ?? []) {
    problems.push(`the walk did not find ${name} in the consumer`);
  }
  for (const name of licences.members) {
    if (!set.includes(name)) {
      problems.push(
        `the set's closure reaches ${name}, a first-party package outside the set`,
      );
    }
  }
  for (const name of set) {
    if (!licences.members.includes(name)) {
      problems.push(`the walk did not reach ${name}`);
    }
  }
  const walked = new Set(licences.entries.map(({ key }) => key));
  const listed = new Set(viewB.packages ?? []);
  const onlyWalked = [...walked].filter((key) => !listed.has(key)).sort();
  const onlyListed = [...listed].filter((key) => !walked.has(key)).sort();
  if (onlyWalked.length + onlyListed.length > 0) {
    problems.push(
      `the walk and the inventory's view (b) differ: only in the walk: ${onlyWalked.join(", ") || "none"}; only in the inventory: ${onlyListed.join(", ") || "none"}`,
    );
  }
  const walkedFlagged = licences.entries
    .filter(({ flags }) => flags.length > 0)
    .map(({ key }) => key)
    .sort();
  const listedFlagged = (viewB.flagged ?? []).map(({ key }) => key).sort();
  if (walkedFlagged.join("\n") !== listedFlagged.join("\n")) {
    problems.push(
      `the walk flags ${walkedFlagged.join(", ") || "nothing"}, and the inventory ${listedFlagged.join(", ") || "nothing"}`,
    );
  }
  const counts = countFields(licences.entries);
  if (!sameCounts(counts, viewB.byLicence ?? {})) {
    problems.push(
      `the walk counts ${JSON.stringify(counts)} by licence, and the inventory ${JSON.stringify(viewB.byLicence ?? {})}`,
    );
  }

  const union = judgeByName(licences.entries, reference);
  problems.push(...union.problems);
  const entryOf = new Map(licences.entries.map((entry) => [entry.key, entry]));
  const packages = {};
  for (const [name, { keys, firstParty }] of Object.entries(
    licences.packages ?? {},
  )) {
    const own = judgeByName(
      keys.map((key) => entryOf.get(key)).filter(Boolean),
      reference,
    );
    problems.push(...own.problems.map((problem) => `${name}: ${problem}`));
    packages[name] = {
      entries: own.comparison.entries,
      names: own.comparison.names,
      sameVersion: own.comparison.sameVersion,
      otherVersion: own.comparison.otherVersion.map(({ key }) => key),
      added: own.comparison.added.map(({ key }) => key),
      firstParty,
    };
  }
  return { comparison: { ...union.comparison, packages }, problems };
}

/**
 * `entry` added to both inputs, G.A's document and the walk's entries,
 * alike, and to the own closure of the member `member` when one is named.
 */
function plantEntry(input, entry, member) {
  const viewB = input.result.candidates[0].viewB;
  viewB.packages = [...viewB.packages, entry.key].sort();
  viewB.byLicence = {
    ...viewB.byLicence,
    [entry.field]: (viewB.byLicence[entry.field] ?? 0) + 1,
  };
  if (entry.flags.length > 0) {
    viewB.flagged = [
      ...viewB.flagged,
      { key: entry.key, field: entry.field, flags: entry.flags },
    ];
  }
  input.licences.entries = [...input.licences.entries, entry].sort(byKey);
  if (member !== undefined) {
    const own = input.licences.packages[member];
    if (own === undefined) throw new Error(`no ${member} in the set's closure`);
    own.keys = [...own.keys, entry.key].sort();
  }
  return input;
}

/** The entry named `name` given another licence, in both inputs alike. */
function relicense(input, name, field, flags) {
  const entry = input.licences.entries.find((value) => value.name === name);
  if (entry === undefined) throw new Error(`no ${name} in the set's closure`);
  const viewB = input.result.candidates[0].viewB;
  viewB.byLicence = { ...viewB.byLicence };
  viewB.byLicence[entry.field] -= 1;
  if (viewB.byLicence[entry.field] === 0) delete viewB.byLicence[entry.field];
  viewB.byLicence[field] = (viewB.byLicence[field] ?? 0) + 1;
  viewB.flagged = [
    ...viewB.flagged.filter(({ key }) => key !== entry.key),
    ...(flags.length > 0 ? [{ key: entry.key, field, flags }] : []),
  ];
  entry.field = field;
  entry.flags = flags;
  return input;
}

const firstCandidate = (input, change) => {
  change(input.result.candidates[0]);
  return input;
};

/**
 * Plants in a copy of step 7's inputs, `{ result, licences }`, each with
 * words its problem must hold. `unreportedInventoryPlants` writes each into
 * the real inputs, so the judgement must fire on the real object.
 */
export const INVENTORY_PLANTS = Object.freeze([
  {
    plant: "a new name under a copyleft licence",
    change: (input) =>
      plantEntry(input, {
        key: "planted-copyleft@1.0.0",
        name: "planted-copyleft",
        version: "1.0.0",
        field: "GPL-3.0-only",
        flags: ["copyleft"],
      }),
    expect:
      "planted-copyleft@1.0.0: a name the reference does not hold, flagged copyleft",
  },
  {
    plant: "a new name with no licence field",
    change: (input) =>
      plantEntry(input, {
        key: "planted-unlicensed@1.0.0",
        name: "planted-unlicensed",
        version: "1.0.0",
        field: "(no licence field)",
        flags: ["unknown"],
      }),
    expect:
      "planted-unlicensed@1.0.0: a name the reference does not hold, flagged unknown",
  },
  {
    plant:
      "a new name under a licence G.A does not flag that is not permissive",
    change: (input) =>
      plantEntry(input, {
        key: "planted-attribution@1.0.0",
        name: "planted-attribution",
        version: "1.0.0",
        field: "CC-BY-4.0",
        flags: [],
      }),
    expect:
      "planted-attribution@1.0.0: a name the reference does not hold, under CC-BY-4.0, which G.A does not flag and ADDITION_IDENTIFIERS does not cover",
  },
  {
    plant: "a known name's licence changed class",
    change: (input) => relicense(input, "pg", "LGPL-3.0-only", ["copyleft"]),
    expect: "its licence changed class, flagged copyleft (LGPL-3.0-only)",
  },
  {
    plant: "the consumer read as a pnpm workspace",
    change: (input) => {
      input.result.workspace = ["requestport-core-smoke-consumer"];
      return input;
    },
    expect: "the inventory read the consumer as a pnpm workspace",
  },
  {
    plant: "core not found",
    change: (input) =>
      firstCandidate(input, (candidate) => {
        candidate.missingMembers = ["@requestport/core"];
      }),
    expect: "the inventory did not find @requestport/core",
  },
  {
    plant: "another member beside the set",
    change: (input) =>
      firstCandidate(input, (candidate) => {
        candidate.members = [...candidate.members, "@requestport/auth"].sort();
      }),
    expect: "not the set's",
  },
  {
    plant: "a dependency left unresolved",
    change: (input) =>
      firstCandidate(input, (candidate) => {
        candidate.viewB.unresolved = [
          {
            dependent: "@requestport/core",
            name: "planted-missing",
            range: "1.0.0",
            kind: "dependency",
          },
        ];
      }),
    expect: "could not resolve @requestport/core > planted-missing",
  },
  {
    plant: "a platform package in the set's closure",
    change: (input) =>
      firstCandidate(input, (candidate) => {
        candidate.platform = [
          {
            key: "planted-binding-darwin-arm64@1.0.0",
            os: ["darwin"],
            cpu: ["arm64"],
          },
        ];
      }),
    expect:
      "the set's closure holds a platform package, planted-binding-darwin-arm64@1.0.0",
  },
  {
    plant: "a linux-x64 build skipped in the set's closure",
    change: (input) =>
      firstCandidate(input, (candidate) => {
        candidate.linuxX64 = [
          {
            dependent: "planted-binding@1.0.0",
            name: "planted-binding-linux-x64-gnu",
            range: "1.0.0",
          },
        ];
      }),
    expect:
      "skipped a linux-x64 build, planted-binding@1.0.0 > planted-binding-linux-x64-gnu",
  },
  {
    plant: "an entry in the inventory the walk does not hold",
    change: (input) =>
      firstCandidate(input, (candidate) => {
        candidate.viewB.packages = [
          ...candidate.viewB.packages,
          "planted-only-listed@1.0.0",
        ];
      }),
    expect: "only in the inventory: planted-only-listed@1.0.0",
  },
  {
    plant: "a first-party package outside the set reached",
    change: (input) => {
      input.licences.members = [
        ...input.licences.members,
        "@requestport/planted",
      ].sort();
      return input;
    },
    expect:
      "the set's closure reaches @requestport/planted, a first-party package outside the set",
  },
  {
    plant: "a new name under a copyleft licence in db's own closure",
    change: (input) =>
      plantEntry(
        input,
        {
          key: "planted-in-db@1.0.0",
          name: "planted-in-db",
          version: "1.0.0",
          field: "GPL-3.0-only",
          flags: ["copyleft"],
        },
        "@requestport/db",
      ),
    expect:
      "@requestport/db: planted-in-db@1.0.0: a name the reference does not hold, flagged copyleft",
  },
]);

/** The plants of `INVENTORY_PLANTS` that `licenceProblems` (with `options`) does not report in a copy of `input`. */
export function unreportedInventoryPlants(input, reference, options) {
  const unreported = [];
  for (const { plant, change, expect } of INVENTORY_PLANTS) {
    let problems;
    try {
      const changed = change(structuredClone(input));
      ({ problems } = licenceProblems(
        changed.result,
        changed.licences,
        reference,
        options,
      ));
    } catch (error) {
      problems = [`the plant could not be written: ${error.message}`];
    }
    if (!problems.some((problem) => problem.includes(expect))) {
      unreported.push(plant);
    }
  }
  return unreported;
}

/** The scripts a package manager runs at install, which `--ignore-scripts` skips. */
export const INSTALL_SCRIPTS = Object.freeze([
  "preinstall",
  "install",
  "postinstall",
]);

/**
 * Core's devDependencies, at the exact versions `packages/core` pins: the
 * bundler and declaration tools `packages/core/bundle.mjs` builds every
 * package of the pack with, whose Linux platform bindings ruling 151 asks
 * G.8 to read. No tarball names them, so the consumer installs none of
 * them.
 */
export function buildDevDependencies(
  manifest = JSON.parse(
    readFileSync(
      join(repositoryRoot, "packages", "core", "package.json"),
      "utf8",
    ),
  ),
) {
  const pinned = { ...(manifest.devDependencies ?? {}) };
  if (Object.keys(pinned).length === 0) {
    throw new Error(
      "core-tarball-smoke: packages/core declares no devDependencies, so no build binding is read.",
    );
  }
  for (const [name, version] of Object.entries(pinned)) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
      throw new Error(
        `core-tarball-smoke: packages/core pins ${name} at ${JSON.stringify(version)}, not an exact version.`,
      );
    }
  }
  return pinned;
}

/**
 * The scratch project that reads them (ruling 153, question 7): those
 * devDependencies, and pnpm's `supportedArchitectures` asking for Linux on
 * arm64 and x64, glibc and musl, beside this machine's own platform.
 */
export function linuxBindingsFiles(devDependencies) {
  const manifest = {
    name: "requestport-core-smoke-linux-bindings",
    private: true,
    devDependencies,
  };
  return {
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "pnpm-workspace.yaml":
      "supportedArchitectures:\n  os: [current, linux]\n  cpu: [current, arm64, x64]\n  libc: [current, glibc, musl]\n",
  };
}

/**
 * Each package in `project`'s pnpm store (`node_modules/.pnpm`) whose
 * manifest names `linux` in `os`, read once, from its own directory and not
 * from the links pnpm lays beside it: its key, its platform fields, its
 * licence as G.A's classifier reads it, and the install scripts it declares,
 * a `binding.gyp` counted as one (a package manager builds it with
 * node-gyp when no install script is declared).
 */
export function linuxBindings(project) {
  const store = join(project, "node_modules", ".pnpm");
  if (!existsSync(store)) return [];
  const found = new Map();
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const modules = join(store, entry.name, "node_modules");
    if (!existsSync(modules)) continue;
    const directories = [];
    for (const top of readdirSync(modules, { withFileTypes: true })) {
      if (!top.isDirectory()) continue;
      if (!top.name.startsWith("@")) {
        directories.push(join(modules, top.name));
        continue;
      }
      for (const inner of readdirSync(join(modules, top.name), {
        withFileTypes: true,
      })) {
        if (inner.isDirectory()) {
          directories.push(join(modules, top.name, inner.name));
        }
      }
    }
    for (const directory of directories) {
      const file = join(directory, "package.json");
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      if (!(manifest.os ?? []).includes("linux")) continue;
      const key = `${manifest.name}@${manifest.version}`;
      if (found.has(key)) continue;
      const { field, flags } = classifyLicence(manifest);
      found.set(key, {
        key,
        os: manifest.os,
        cpu: manifest.cpu ?? null,
        libc: manifest.libc ?? null,
        field,
        flags,
        installScripts: [
          ...INSTALL_SCRIPTS.filter((name) =>
            Object.hasOwn(manifest.scripts ?? {}, name),
          ),
          ...(existsSync(join(directory, "binding.gyp"))
            ? ["binding.gyp"]
            : []),
        ],
      });
    }
  }
  return [...found.values()].sort(byKey);
}

/**
 * The Linux bindings' judgement: the scratch install exited 0 and read at
 * least one Linux binding on arm64 and one on x64, each unflagged by G.A's
 * classifier and with no install script; and the consumer's lockfile
 * (`consumerNames`) names none of them, nor any of core's build
 * devDependencies.
 */
export function linuxBindingProblems(reading, { consumerNames }) {
  const problems = [];
  if (reading.status !== 0) {
    problems.push(`the scratch install exited ${reading.status}`);
  }
  if (reading.bindings.length === 0) {
    problems.push(
      "the scratch install read no Linux binding: the check would see nothing",
    );
  }
  for (const cpu of ["arm64", "x64"]) {
    if (!reading.bindings.some((binding) => binding.cpu?.includes(cpu))) {
      problems.push(`no Linux binding for ${cpu} was read`);
    }
  }
  for (const binding of reading.bindings) {
    if (binding.flags.length > 0) {
      problems.push(
        `${binding.key}: ${flagText(binding.flags)} (${binding.field})`,
      );
    }
    if (binding.installScripts.length > 0) {
      problems.push(
        `${binding.key}: declares ${binding.installScripts.join(", ")}`,
      );
    }
  }
  const buildOnly = new Set([
    ...reading.bindings.map(({ key }) => splitKey(key).name),
    ...Object.keys(reading.devDependencies),
  ]);
  for (const name of [...new Set(consumerNames)].sort()) {
    if (buildOnly.has(name)) {
      problems.push(`the consumer installs ${name}, which only the build uses`);
    }
  }
  return problems;
}

/** The first binding of `reading` changed by `change`. */
const firstBinding = (input, change) => {
  change(input.reading.bindings[0]);
  return input;
};

/**
 * Plants in a copy of the Linux bindings' inputs, `{ reading, context }`,
 * each with words its problem must hold; `unreportedLinuxPlants` writes
 * each into the real reading.
 */
export const LINUX_PLANTS = Object.freeze([
  {
    plant: "a failed install",
    change: (input) => {
      input.reading.status = 1;
      return input;
    },
    expect: "the scratch install exited 1",
  },
  {
    plant: "no binding read",
    change: (input) => {
      input.reading.bindings = [];
      return input;
    },
    expect: "the scratch install read no Linux binding",
  },
  {
    plant: "no x64 binding read",
    change: (input) => {
      input.reading.bindings = input.reading.bindings.filter(
        ({ cpu }) => !cpu?.includes("x64"),
      );
      return input;
    },
    expect: "no Linux binding for x64 was read",
  },
  {
    plant: "a binding under a copyleft licence",
    change: (input) =>
      firstBinding(input, (binding) => {
        binding.field = "GPL-3.0-only";
        binding.flags = ["copyleft"];
      }),
    expect: ": flagged copyleft (GPL-3.0-only)",
  },
  {
    plant: "a binding with no licence field",
    change: (input) =>
      firstBinding(input, (binding) => {
        binding.field = "(no licence field)";
        binding.flags = ["unknown"];
      }),
    expect: ": flagged unknown ((no licence field))",
  },
  {
    plant: "a binding with an install script",
    change: (input) =>
      firstBinding(input, (binding) => {
        binding.installScripts = ["postinstall"];
      }),
    expect: ": declares postinstall",
  },
  {
    plant: "a binding the consumer installs",
    change: (input) => {
      input.context.consumerNames = [
        ...input.context.consumerNames,
        splitKey(input.reading.bindings[0].key).name,
      ];
      return input;
    },
    expect: "the consumer installs",
  },
]);

/** The plants of `LINUX_PLANTS` that `linuxBindingProblems` does not report in a copy of `reading`. */
export function unreportedLinuxPlants(reading, context) {
  const unreported = [];
  for (const { plant, change, expect } of LINUX_PLANTS) {
    let problems;
    try {
      const changed = change(structuredClone({ reading, context }));
      problems = linuxBindingProblems(changed.reading, changed.context);
    } catch (error) {
      problems = [`the plant could not be written: ${error.message}`];
    }
    if (!problems.some((problem) => problem.includes(expect))) {
      unreported.push(plant);
    }
  }
  return unreported;
}

/** The paths under `directory`, to `depth` levels. */
function listing(directory, depth) {
  if (!existsSync(directory)) return [];
  const found = [];
  const walk = (current, level) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      found.push(relative(directory, path).split(sep).join("/"));
      if (entry.isDirectory() && level < depth) walk(path, level + 1);
    }
  };
  walk(directory, 1);
  return found.sort();
}

/** Refuses `directory` inside the repository, under either spelling of its path. */
function refuseRepositoryPath(directory) {
  refuseInsideRepository(directory);
  const real = realpathSync(directory);
  const root = realpathSync(repositoryRoot);
  const path = relative(root, real);
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) {
    throw new Error(
      `core-tarball-smoke: ${directory} is inside the repository (${real}).`,
    );
  }
}

/**
 * The command. Of `environment`, the cold install takes `TMPDIR` alone
 * (`installEnvironment`), and `pinnedPnpm` reads corepack's directories.
 * Returns the record it wrote.
 */
export async function main(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: "string" },
      from: { type: "string" },
      out: { type: "string" },
      pnpm: { type: "string" },
      database: { type: "string" },
    },
    strict: true,
  });
  if ((values.version === undefined) === (values.from === undefined)) {
    throw new Error(
      "core-tarball-smoke: pass --version <version> to pack, or --from <pack directory> to reuse a pack; not both.",
    );
  }
  const server =
    values.database === undefined ? undefined : localServer(values.database);
  const out = resolve(
    values.out ?? mkdtempSync(join(tmpdir(), "requestport-core-smoke-")),
  );
  refuseInsideRepository(out);
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`core-tarball-smoke: ${out} is not empty.`);
  }
  mkdirSync(out, { recursive: true });
  refuseRepositoryPath(out);

  const failures = [];
  const record = {
    smoke: {
      commit: spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).stdout.trim(),
      treeStatus: readTreeStatus(),
      node: process.version,
      tmpdir: tmpdir(),
      tmpdirReal: realpathSync(tmpdir()),
      TMPDIR: environment.TMPDIR ?? null,
      database: server?.redacted ?? null,
      out,
      outReal: realpathSync(out),
    },
    failures,
  };
  const fail = (step, problem) => {
    failures.push(`step ${step}: ${problem}`);
    process.stdout.write(`FAIL step ${step}: ${problem}\n`);
  };
  const say = (line) => process.stdout.write(`${line}\n`);

  try {
    // Step 1.
    let packed;
    if (values.from === undefined) {
      const result = await pack(
        ["--version", values.version, "--out", join(out, "pack")],
        { log: say },
      );
      packed = { record: result.record, packs: result.packs };
      record.pack = { from: null, directory: result.out };
    } else {
      packed = reusePack(values.from);
      record.pack = {
        from: resolve(values.from),
        directory: resolve(values.from),
      };
    }
    record.pack.buildRecord = packed.record;
    const tarballs = packed.packs.map(({ staged, tarball }) => {
      const facts = packed.record.tarballs.find(
        ({ name }) => name === staged.manifest.name,
      );
      return {
        name: facts.name,
        version: facts.version,
        integrity: facts.integrity,
        path: tarball,
      };
    });
    say(
      `step 1: ${tarballs.map(({ path }) => basename(path)).join(", ")} from ${record.pack.directory} (commit ${packed.record.commit})`,
    );
    record.pack.setProblems = packSetProblems(tarballs.map(({ name }) => name));
    for (const problem of record.pack.setProblems) fail(1, problem);
    if (failures.length > 0) return record;

    // Step 2.
    const read = packed.packs.map(({ staged, tarball }) => ({
      staged,
      tarball,
      entries: readTarball(tarball),
    }));
    const exported = exportedSubpaths(read.map(({ entries }) => entries));
    record.tarballs = [];
    for (const { staged, tarball, entries } of read) {
      const integrity = integrityOf(tarball);
      const facts = tarballs.find(({ path }) => path === tarball);
      const packageName = staged.manifest.name;
      const g7 = checkTarball(entries, staged);
      const g8 = tarballProblems(entries, packageName, exported);
      const plants =
        modulePlants(packageName).length + tarballPlants(packageName).length;
      const unrefused = unrefusedModulePlants(entries, packageName, exported);
      record.tarballs.push({
        file: basename(tarball),
        name: packageName,
        integrity,
        integrityMatches: integrity === facts.integrity,
        files: entries.size,
        checkTarball: g7,
        own: g8,
        plants,
        unrefusedPlants: unrefused,
      });
      const name = basename(tarball);
      if (integrity !== facts.integrity) {
        fail(2, `${name}'s integrity differs from the build record's`);
      }
      for (const problem of g7) fail(2, `${name}: checkTarball: ${problem}`);
      for (const problem of g8.problems) fail(2, `${name}: ${problem}`);
      for (const plant of unrefused) {
        fail(2, `${name}: the plant (${plant}) was not refused`);
      }
      say(
        `step 2: ${name}: checkTarball ${g7.length} problems; module comments ${g8.counted.javascript} in JavaScript, ${g8.counted.declarations} in declarations; ${g8.counted.specifiers} @requestport specifiers; ${g8.problems.length} refused; ${plants - unrefused.length} of ${plants} plants refused`,
      );
    }
    record.checkRun = await checkRun(read);
    for (const problem of record.checkRun) fail(2, `checkRun: ${problem}`);
    say(
      `step 2: checkRun over the ${read.length} tarballs: ${record.checkRun.length} problems`,
    );
    if (failures.length > 0) return record;

    // Step 3.
    const consumer = join(out, "consumer");
    const home = join(out, "home");
    const store = join(out, "store");
    for (const directory of [consumer, home, store]) mkdirSync(directory);
    const above = ancestorsHolding(consumer, ["node_modules", ".npmrc"]);
    record.consumer = {
      directory: consumer,
      real: realpathSync(consumer),
      above,
    };
    if (above.length > 0) {
      fail(3, `found in or above the consumer: ${above.join(", ")}`);
      return record;
    }
    const devDependencies = consumerDevDependencies();
    const files = consumerFiles(tarballs, devDependencies);
    record.consumer.unoverridden = unoverriddenNames(
      read.map(({ staged }) => staged.manifest),
    );
    for (const name of record.consumer.unoverridden) {
      fail(3, `a packed manifest names ${name}, which no override maps`);
    }
    if (failures.length > 0) return record;
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(consumer, file), text);
    }
    record.consumer.files = files;
    say(
      `step 3: the consumer is ${consumer}: it depends on ${CONSUMER_DEPENDENCIES.join(", ")}, and overrides the ${PACKED.length} of the pack`,
    );

    // Step 4.
    const pnpm = pinnedPnpm(values.pnpm, environment);
    const env = installEnvironment(home, environment);
    record.install = { pnpm, environment: Object.keys(env).sort() };
    const version = runPnpm(pnpm, ["--version"], { cwd: consumer, env });
    const registry = runPnpm(pnpm, ["config", "get", "registry"], {
      cwd: consumer,
      env,
    });
    record.install.version = version.output.trim();
    record.install.registry = registry.output.trim();
    if (version.status !== 0 || version.output.trim() !== pnpm.version) {
      fail(
        4,
        `${pnpm.path} reports ${JSON.stringify(version.output.trim())}, not ${pnpm.version}`,
      );
      return record;
    }
    if (registry.status !== 0 || registry.output.trim() !== PUBLIC_REGISTRY) {
      fail(
        4,
        `pnpm's registry is ${JSON.stringify(registry.output.trim())}, not ${PUBLIC_REGISTRY}`,
      );
      return record;
    }
    const install = runPnpm(pnpm, ["install", "--store-dir", store], {
      cwd: consumer,
      env,
    });
    writeFileSync(join(out, "install.log"), install.output);
    record.install.status = install.status;
    record.install.seconds = install.seconds;
    // pnpm's last progress line: what it resolved, took from the store,
    // downloaded and linked. From an empty store it reuses nothing.
    const progress =
      /resolved (\d+), reused (\d+), downloaded (\d+), added (\d+), done/u.exec(
        install.output,
      );
    record.install.progress =
      progress === null
        ? null
        : Object.fromEntries(
            ["resolved", "reused", "downloaded", "added"].map((field, at) => [
              field,
              Number(progress[at + 1]),
            ]),
          );
    record.install.updateNotice = /Update available/u.test(install.output);
    record.install.home = listing(home, 3);
    say(
      `step 4: pnpm ${record.install.version} install exited ${install.status} in ${install.seconds} s: ${JSON.stringify(record.install.progress)}`,
    );
    if (install.status !== 0) {
      fail(
        4,
        `pnpm install exited ${install.status}; see ${join(out, "install.log")}`,
      );
      return record;
    }
    if (record.install.progress?.reused !== 0) {
      fail(4, "pnpm did not report reusing nothing from the store");
    }
    if (record.install.updateNotice) fail(4, "pnpm printed its update notice");

    const text = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
    const context = {
      consumer,
      tarballs,
      direct: CONSUMER_DEPENDENCIES,
      overridden: PACKED,
      version: tarballs.find(({ name }) => name === "@requestport/core")
        .version,
    };
    const problems = lockfileProblems(parseLockfile(text), context);
    const unreported = unreportedLockfilePlants(text, context);
    record.lockfile = {
      requestPortLines: requestPortLines(text, tarballs),
      problems,
      plants: LOCKFILE_PLANTS.length,
      unreportedPlants: unreported,
      zod: Object.keys(parseLockfile(text).packages ?? {}).filter((key) =>
        key.startsWith("zod@"),
      ),
    };
    for (const problem of problems) fail(4, `the lockfile: ${problem}`);
    for (const { plant } of unreported) {
      fail(4, `the planted lockfile (${plant}) was not reported`);
    }
    const copies = installedCopies(
      consumer,
      tarballs.map(({ name }) => name),
    );
    const installed = installedProblems(copies, context);
    record.installed = { copies, problems: installed };
    for (const problem of installed) fail(4, problem);
    say(
      `step 4: the lockfile: ${problems.length} problems; ${LOCKFILE_PLANTS.length - unreported.length} of ${LOCKFILE_PLANTS.length} plants reported; installed: ${Object.entries(
        copies,
      )
        .map(([name, found]) => `${name} ${found.length}`)
        .join(", ")} copies; ${installed.length} problems`,
    );
    if (failures.length > 0) return record;

    // Step 5.
    for (const file of FIXTURE.files) {
      copyFileSync(join(FIXTURE.directory, file), join(consumer, file));
    }
    const tools = consumerTypeCheckTools(consumer, devDependencies);
    const { tsc } = tools;
    record.typeCheck = {
      tsc,
      typesNode: tools.typesNode,
      arguments: { true: tscArguments(true), false: tscArguments(false) },
      runs: [],
      plant: { name: PLANTED_IMPORT, runs: [] },
    };
    for (const problem of tools.problems) fail(5, problem);
    const typeCheck = (cwd, skipLibCheck, log) => {
      const run = runNode(tsc.path, tscArguments(skipLibCheck), { cwd, env });
      writeFileSync(join(out, log), run.output);
      return {
        run,
        result: typeCheckProblems(run, { cwd, consumer, skipLibCheck }),
      };
    };
    for (const skipLibCheck of [true, false]) {
      const { run, result } = typeCheck(
        consumer,
        skipLibCheck,
        `tsc-skipLibCheck-${skipLibCheck}.log`,
      );
      record.typeCheck.runs.push({
        skipLibCheck,
        status: run.status,
        seconds: run.seconds,
        ...result,
      });
      for (const problem of result.problems) {
        fail(5, `skipLibCheck ${skipLibCheck}: ${problem}`);
      }
      const counts = Object.entries(result.byPackage)
        .map(([name, { errors }]) => `${name} ${errors}`)
        .join(", ");
      say(
        `step 5: tsc ${tsc.version}, skipLibCheck ${skipLibCheck}: exited ${run.status} in ${run.seconds} s; ${result.errors} errors (${counts || "none"}); ${result.problems.length} problems`,
      );
    }

    // The check must fire: the fixture with an import of a name core's `.`
    // does not export, in `<consumer>/plant`, is reported by both runs.
    const plant = join(consumer, "plant");
    mkdirSync(plant);
    writeFileSync(
      join(plant, "consumer.ts"),
      plantImport(readFileSync(join(FIXTURE.directory, "consumer.ts"), "utf8")),
    );
    copyFileSync(
      join(FIXTURE.directory, "tsconfig.json"),
      join(plant, "tsconfig.json"),
    );
    for (const skipLibCheck of [true, false]) {
      const { run, result } = typeCheck(
        plant,
        skipLibCheck,
        `tsc-plant-skipLibCheck-${skipLibCheck}.log`,
      );
      const reported = run.status !== 0 && plantReported(result.problems);
      record.typeCheck.plant.runs.push({
        skipLibCheck,
        status: run.status,
        seconds: run.seconds,
        reported,
        errors: result.errors,
        problems: result.problems.length,
      });
      if (!reported) {
        fail(
          5,
          `the planted import of ${PLANTED_IMPORT} was not reported with skipLibCheck ${skipLibCheck}`,
        );
      }
      say(
        `step 5: the plant, skipLibCheck ${skipLibCheck}: exited ${run.status}; ${reported ? "reported" : "NOT reported"}`,
      );
    }
    if (failures.length > 0) return record;

    // Step 6.
    if (server === undefined) {
      fail(6, "no --database <server URL> was given, so the run did not start");
      return record;
    }
    const database = `rp_g8_smoke_${randomBytes(4).toString("hex")}`;
    const reportPath = join(out, "run-report.json");
    const runEnv = runEnvironment(home, environment);
    record.run = {
      server: server.redacted,
      database,
      environment: Object.keys(runEnv).sort(),
    };
    // The PGlite case needs the optional peer absent from the consumer
    // (ruling 153), by a check that finds it planted in the lockfile.
    const db = realpathSync(join(consumer, "node_modules", "@requestport/db"));
    const lock = parseLockfile(text);
    const pgliteFound = installedPglite(lock, consumer);
    const pglitePlantFound =
      installedPglite(plantPglite(lock), consumer).length > 0;
    record.run.pglite = {
      db,
      installed: pgliteFound,
      plantFound: pglitePlantFound,
    };
    for (const where of pgliteFound) {
      fail(6, `the consumer holds ${PGLITE}, which must be absent: ${where}`);
    }
    if (!pglitePlantFound) {
      fail(6, `${PGLITE} planted in a copy of the lockfile was not found`);
    }
    const run = runNode(
      join(consumer, FIXTURE.files[0]),
      [server.url, database, reportPath],
      { cwd: consumer, env: runEnv },
    );
    writeFileSync(join(out, "run.log"), run.output);
    record.run.status = run.status;
    record.run.seconds = run.seconds;
    const report = existsSync(reportPath)
      ? JSON.parse(readFileSync(reportPath, "utf8"))
      : null;
    record.run.report = report;
    const runFound = runProblems(report, { database, db });
    const unreportedRun =
      report === null ? [] : unreportedRunPlants(report, { database, db });
    record.run.problems = runFound;
    record.run.plants = RUN_PLANTS.length;
    record.run.unreportedPlants = unreportedRun;
    for (const problem of runFound) fail(6, problem);
    for (const plant of unreportedRun) {
      fail(6, `the planted report (${plant}) was not reported`);
    }
    if (run.status !== 0 && runFound.length === 0) {
      fail(6, `the consumer exited ${run.status}; see ${join(out, "run.log")}`);
    }
    say(
      `step 6: the consumer exited ${run.status} in ${run.seconds} s on ${database}: ${report?.capabilities?.length ?? 0} capabilities, ${runFound.length} problems; ${RUN_PLANTS.length - unreportedRun.length} of ${RUN_PLANTS.length} plants reported`,
    );
    say(
      `step 6: PGlite, the peer ${pgliteFound.length === 0 ? "absent" : "FOUND"} (a planted one ${pglitePlantFound ? "found" : "NOT found"}): createStorage({ driver: "pglite" }) ${report?.pglite?.outcome ?? "did not run"}${report?.pglite?.error ? ` ${report.pglite.error.code}` : ""}`,
    );
    say(
      `step 6: the identity case: core's . shares ${JSON.stringify(report?.identity?.shared?.["."] ?? null)} with db's, ./migrate ${JSON.stringify(report?.identity?.shared?.["./migrate"] ?? null)}; differing ${JSON.stringify(report?.identity?.differing ?? null)}; the three DomainErrors one class: ${["coreSameClassAsAgentServices", "coreSameClassAsAuth", "authInstanceOfCoreClass", "coreInstanceOfAuthClass"].every((comparison) => report?.domainErrors?.[comparison] === true)}`,
    );
    const zod = zodBehaviour(
      consumer,
      out,
      runEnv,
      Object.fromEntries(
        Object.entries(copies).map(([name, [copy]]) => [name, copy.directory]),
      ),
    );
    record.zod = zod;
    for (const problem of zod.problems) fail(6, `zod: ${problem}`);
    say(
      `step 6: zod ${zod.versions.join(" and ")}: ${Object.entries(zod.copies)
        .map(([name, copy]) => `${name} resolves ${copy.resolved}`)
        .join(
          ", ",
        )}; the battery, each copy alone, differs in ${JSON.stringify(zod.differing)} (ruling 144's four: ${zod.sameAsRuling144 ? "the same" : "NOT the same"}); both in one process: ${JSON.stringify(zod.differingTogether)}; after the fixture's imports: ${JSON.stringify(zod.differingAsTheConsumerLoads)}`,
    );
    if (failures.length > 0) return record;

    // Step 7: G.A's script over the set's closure in the consumer.
    const inventoryJson = join(out, "licence-inventory.json");
    const inventoryArguments = licenceInventoryArguments(
      consumer,
      inventoryJson,
      INVENTORY_PACKAGES,
    );
    const inventoryRun = runNode(LICENCE_INVENTORY, inventoryArguments, {
      cwd: consumer,
      env,
    });
    writeFileSync(join(out, "licence-inventory.log"), inventoryRun.output);
    record.licences = {
      script: relative(repositoryRoot, LICENCE_INVENTORY),
      arguments: inventoryArguments,
      status: inventoryRun.status,
      seconds: inventoryRun.seconds,
    };
    say(
      `step 7: G.A's script over the consumer exited ${inventoryRun.status} in ${inventoryRun.seconds} s`,
    );
    if (inventoryRun.status !== 0) {
      fail(
        7,
        `G.A's script exited ${inventoryRun.status}; see ${join(out, "licence-inventory.log")}`,
      );
      return record;
    }
    const inventoryResult = JSON.parse(readFileSync(inventoryJson, "utf8"));
    const licences = consumerLicences(consumer, INVENTORY_PACKAGES);
    const reference = readLicenceReference();
    const judged = licenceProblems(inventoryResult, licences, reference, {
      members: S8,
    });
    const unreportedInventory = unreportedInventoryPlants(
      { result: inventoryResult, licences },
      reference,
      { members: S8 },
    );
    const closure = inventoryResult.candidates[0];
    record.licences = {
      ...record.licences,
      reference: {
        file: relative(repositoryRoot, LICENCE_REFERENCE.file),
        row: reference.row,
        entries: reference.packages.size,
        names: reference.names.size,
        flagged: reference.flagged,
      },
      closure: {
        members: closure?.members ?? null,
        nameVersions: closure?.viewB?.nameVersions ?? null,
        distinct: closure?.viewB?.distinct ?? null,
        byLicence: closure?.viewB?.byLicence ?? null,
        flagged: closure?.viewB?.flagged ?? null,
        optionalPeersExcluded: closure?.viewB?.optionalPeersExcluded ?? null,
        platform: closure?.platform ?? null,
        linuxX64: closure?.linuxX64 ?? null,
      },
      entries: licences.entries,
      packages: licences.packages,
      comparison: judged.comparison,
      problems: judged.problems,
      plants: INVENTORY_PLANTS.length,
      unreportedPlants: unreportedInventory,
    };
    for (const problem of judged.problems) fail(7, problem);
    for (const plant of unreportedInventory) {
      fail(7, `the planted inventory (${plant}) was not reported`);
    }
    const compared = judged.comparison;
    say(
      `step 7: the set's closure, ${closure?.members?.length} members: ${compared?.entries} name@version (${compared?.names} names), by licence ${JSON.stringify(closure?.viewB?.byLicence ?? null)}; against the reference's ${reference.row} (${reference.packages.size}): ${compared?.sameVersion} at its version, ${compared?.otherVersion.length} at another, ${compared?.added.length} new names accepted (${compared?.added.map(({ key, field }) => `${key} ${field}`).join(", ") || "none"}), ${compared?.absent.length} absent; ${judged.problems.length} problems; ${INVENTORY_PLANTS.length - unreportedInventory.length} of ${INVENTORY_PLANTS.length} plants reported`,
    );
    say(
      `step 7: each package's own closure, name@version (new names accepted): ${Object.entries(
        compared?.packages ?? {},
      )
        .map(([name, own]) => `${name} ${own.entries} (${own.added.length})`)
        .join(", ")}`,
    );

    // Step 7: the build's Linux bindings (ruling 151, read as ruling 153
    // rules), in a scratch project beside the consumer.
    const linux = join(out, "linux");
    const linuxProject = join(linux, "project");
    const linuxHome = join(linux, "home");
    const linuxStore = join(linux, "store");
    for (const directory of [linux, linuxProject, linuxHome, linuxStore]) {
      mkdirSync(directory);
    }
    const linuxAbove = ancestorsHolding(linuxProject, [
      "node_modules",
      ".npmrc",
    ]);
    record.linuxBindings = { project: linuxProject, above: linuxAbove };
    if (linuxAbove.length > 0) {
      fail(
        7,
        `found in or above the Linux bindings' project: ${linuxAbove.join(", ")}`,
      );
      return record;
    }
    const buildDependencies = buildDevDependencies();
    const linuxFiles = linuxBindingsFiles(buildDependencies);
    for (const [file, content] of Object.entries(linuxFiles)) {
      writeFileSync(join(linuxProject, file), content);
    }
    const linuxInstall = runPnpm(
      pnpm,
      ["install", "--ignore-scripts", "--store-dir", linuxStore],
      { cwd: linuxProject, env: installEnvironment(linuxHome, environment) },
    );
    writeFileSync(join(out, "linux-install.log"), linuxInstall.output);
    const reading = {
      status: linuxInstall.status,
      devDependencies: buildDependencies,
      bindings: linuxBindings(linuxProject),
    };
    const linuxContext = {
      consumerNames: Object.keys(lock.packages ?? {}).map(
        (key) => splitKey(key).name,
      ),
    };
    const linuxFound = linuxBindingProblems(reading, linuxContext);
    const unreportedLinux = unreportedLinuxPlants(reading, linuxContext);
    record.linuxBindings = {
      ...record.linuxBindings,
      files: linuxFiles,
      seconds: linuxInstall.seconds,
      ...reading,
      problems: linuxFound,
      plants: LINUX_PLANTS.length,
      unreportedPlants: unreportedLinux,
    };
    for (const problem of linuxFound) fail(7, `the Linux bindings: ${problem}`);
    for (const plant of unreportedLinux) {
      fail(7, `the planted Linux reading (${plant}) was not reported`);
    }
    const licenceCounts = countFields(reading.bindings);
    say(
      `step 7: the build's Linux bindings: pnpm install --ignore-scripts exited ${linuxInstall.status} in ${linuxInstall.seconds} s; ${reading.bindings.length} read (${JSON.stringify(licenceCounts)}), ${reading.bindings.filter(({ installScripts }) => installScripts.length > 0).length} with an install script; ${linuxFound.length} problems; ${LINUX_PLANTS.length - unreportedLinux.length} of ${LINUX_PLANTS.length} plants reported`,
    );
    return record;
  } catch (error) {
    fail("-", error instanceof Error ? error.message : String(error));
    return record;
  } finally {
    writeFileSync(
      join(out, "smoke-record.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    say(
      failures.length === 0
        ? `core-tarball-smoke: every step passed; the record is ${join(out, "smoke-record.json")}`
        : `core-tarball-smoke: ${failures.length} failures; the record is ${join(out, "smoke-record.json")}`,
    );
    if (failures.length > 0) process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
