/*
  The publishable bundles, in `bundles`: one per package of the S8 set
  (Plan 13, G; the owner's answer, ruling 175, and `config`'s option (a),
  ruling 176), and one for each of `@requestport/auth`, `mcp` and `server`
  (`hostPackages`), which ruling 190 has G's machinery build, pack and check
  beside the set (H question 8, the manifest's alternative), with the order
  they build in (`buildOrder`), which is the order
  `scripts/pack-packages.mjs` packs them in. Nothing deployed imports this
  module, and core's `build` script stays `tsc -p tsconfig.json` (ruling
  150). Its importers are its test, `src/bundle.test.ts`; G.7's pack script,
  `scripts/pack-packages.mjs`, and that script's test; G.8's smoke's test,
  `scripts/core-tarball-smoke.test.mjs`, which reads `packageSet` and
  `hostPackages`; K8's stand-in builder,
  `spikes/h0-probe/k8-bundle.mjs`, which reads the forbidden-module list and
  `isExternal`; and H.7's: `apps/requestport/bundle.mjs` (`isExternal`,
  `packageName`, `packageSet`, `hostPackages` and `bundles`' entries),
  `apps/requestport/src/web/test-seams.ts` (the test seams' list and
  `publicVariants`) and its test (those, and `testOnlyModule`), and
  `scripts/pack-requestport.mjs` (`packageName` and `testOnlyModule`) and its
  test (`privateDocComments`). It is outside `src/`,
  because core's typecheck, its build and `published-types.test.ts` take
  `src/**`, and `import.test.ts` refuses `createRequire(` in a module there.

  `buildBundle` writes a bundle's `dist/` into the package directory it is
  given, which must not hold one yet:

  - **JavaScript**, by esbuild 0.28.2: ESM for Node 22, split, no source
    maps. Every `@requestport/*` specifier is inlined, but a package the
    bundle names in `external`; every other bare specifier, `node:` builtins
    among them, is left to the consumer's install (`isExternal`). Each row
    of the set names the other seven in `external`, and each of `auth`,
    `mcp` and `server` every other package `bundles` builds, so each inlines
    its own package's modules alone. `buildPackage` refuses a build that
    inlines a module of another package (a row may name such a module in
    `inlines`, and none does). The split is required:
    S1's core bundle, built unsplit, carried a copy of `db` in each entry,
    so `migrate` from `./migrate` refused a storage that `.`'s
    `createStorage` built ("Not a storage created by createStorage."), and
    importing `.` loaded the packages only the job bodies' lazy imports
    need; `db`'s `.`, `./migrate` and `./wiring` share
    its storage module through a chunk in the same way, and the test's
    meeting of the first two holds it. Entries and chunks are written
    directly in `dist/`, so that `db`'s migrator's `../migrations` names the
    package root's `migrations/`. esbuild's `absWorkingDir` is the
    repository's root, so the module comments it writes name repository paths.
  - **Declarations**, for a bundle that names its `declarations` project:
    tsc 7.0.2 emits the declarations of that project's sources into a scratch
    directory laid out as the repository is (its `rootDir` is the
    repository's root), and rolldown 1.2.4 with rolldown-plugin-dts 0.28.6
    bundles them from the same entries, each `@requestport/*` specifier the
    bundle inlines resolved to the declaration its workspace's `exports`
    names. rolldown's `cwd` is that scratch directory, so each `//#region`
    comment it writes names a module by its path in the repository
    (`packages/db/src/client.d.ts`), never by the machine's.
    A specifier of a package the bundle leaves external stays an import.
    Bundled, only what an entry's exports reach is kept, so the declarations
    of `bundles`' rows name none of `pg`'s, PGlite's or the hosted
    driver's types (the test pins it, and in this tree finds all three in a
    bundle of `db`'s `client.ts` built with `shared-databases.ts`'s variant
    alone, which exports the driver types): shipping tsc's
    per-module declarations instead would have a consumer's type check need
    `@types/pg` (ruling 150;
    G's S8 survey measured `db`'s per-module declarations importing `pg` and
    `@electric-sql/pglite`).
  - **Private modules** (ruling 183 item 9): both steps build each module a
    bundle's `publicVariants` names as its public variant, the JavaScript
    step by an esbuild plugin and the declaration step by a rolldown one.
    Every row of `bundles` names `publicVariants`, whose three modules are
    `db`'s, each paired with its variant as `release/public-tree.json`'s
    `substitute` pairs them for the public seed, which carries each variant
    at its module's path:
    - `packages/db/src/shared-databases.ts`, the shared databases by
      digest, which `db`'s `database-url.ts` imports (J.2; ruling 91,
      option (d)). In this tree it names production's and staging's. Its
      variant, `shared-databases.public.ts`, names none. No declaration a
      row's entries reach imports it (tsc drops `database-url.ts`'s import,
      which only a default value uses), so the declaration step's
      substitution of this module is shown on a control bundle of core's
      test support (`src/bundle.test.ts`);
    - `packages/db/src/hosted-driver.ts`, the hosted driver (the
      serverless driver production runs on), which `client.ts`,
      `migrate.ts` and other modules of `db` import, and
      `packages/db/src/hosted-migrator.ts`, its migrator, which `migrate.ts`
      imports (J.2b; ruling 175, owner question 3; ruling 194 item 3).
      Their variants, `hosted-driver.public.ts` and
      `hosted-migrator.public.ts`, have no hosted driver, so `db`'s
      JavaScript imports none of the driver's packages and its packed
      manifest names none. `client.ts`'s declarations reach
      `hosted-driver.ts`, so `db`'s own declarations hold the variant's.
    So `db`'s tarball inlines the three variants in the modules' place. The
    repository's own builds and tests still compile the private modules,
    but for `requestport`'s self-host Next build, which builds each public
    variant in its module's place too, so that `@requestport/web` carries
    none of them (`selfHostReplacements` in
    `apps/requestport/src/web/test-seams.ts`; ruling 193 item 5).
    A bundle that names no `publicVariants` builds each module as it is, and
    `scripts/pack-packages.mjs` refuses a tarball whose JavaScript names a
    private module in a module comment, whose declarations name one in a
    `//#region`, or that holds, in any file, a doc comment of one that its
    variant lacks (`privateDocComments`), its digests or its
    `kind = "private"` marker. rolldown gives a module that a declaration
    imports as a namespace no `//#region` of its own, so in the declarations
    the doc comments are what show such a module inlined.
  - **Test seams** (ruling 174; rulings 190 and 193 item 2: no test seam
    ships in a published package): the JavaScript step builds each seam's
    real module a bundle's `inertSeams` names as its inert module, by the
    plugin that builds the public variants, the way `publicVariants` names
    the private module. Every row names `inertSeams`, which is `testSeams`,
    below, the seams' one list (ruling 151), as a map. Of the rows, only
    `server`'s JavaScript reaches a seam, the CSP's E2E fence, whose inert
    module is in `packages/server` beside the real one, so `server`'s
    JavaScript holds that module and not the real one. A row whose
    JavaScript reached the outbox or the fault register would inline an
    inert module of `apps/requestport`, which `buildPackage` refuses. The
    declaration step builds each seam as it is: rolldown keeps only what
    an entry's exports reach, and no row's declarations reach a seam (the
    test holds that no declaration holds a marker). `scripts/pack-packages.mjs`
    refuses a tarball whose JavaScript or declarations name a seam's real
    module in a module comment or `//#region`, or that holds any seam's
    marker (`seamMarkersIn`).

  It returns esbuild's metafile and the declaration files it wrote.
  `buildPackage` builds a row of `bundles` with `buildBundle`, then refuses
  the build when it inlines a module of another package that the row does not
  name in `inlines`, or imports a subpath of a package that no row of
  `bundles` publishes (`siblingProblems`). `packages/core/src/bundle.test.ts`
  holds what they build.

  It also holds the forbidden-module list (`forbiddenModules`, read through
  `forbiddenModule`, and its test-only half, `testOnlyModule`) and the test
  seams' list (`testSeams`), which each of their readers reads from here and
  nowhere else (ruling 151; ruling 193 item 2).
*/
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's root: esbuild's `absWorkingDir`, and every path's base. */
export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The S8 package set (ruling 175): D3's eight packages, each built and
 * packed as its own package. Nothing is published.
 */
export const packageSet = Object.freeze([
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
 * beside the set (H question 8, the manifest's alternative), which
 * `requestport` depends on: the host, `@requestport/server`, and the two it
 * composes that are not of the set, `@requestport/auth` and
 * `@requestport/mcp`. Nothing is published.
 */
export const hostPackages = Object.freeze([
  "@requestport/auth",
  "@requestport/mcp",
  "@requestport/server",
]);

/** The declaration project every package of the set builds from. */
const setDeclarations = "packages/core/tsconfig.build.json";

/**
 * The declaration project `auth`, `mcp` and `server` build from: their
 * entries' sources, and `db`'s `src/`, so that tsc emits the private
 * module's public variant, as every project `bundles` names does.
 */
const hostDeclarations = "packages/core/tsconfig.host-packages.json";

/**
 * The private modules, each by its path from the repository's root, with
 * the public variant a bundle builds in its place (ruling 183 item 9): the
 * pairs `release/public-tree.json`'s `substitute` names for `db`'s list of
 * shared databases (J.2), and for its hosted driver and that driver's
 * migrator (J.2b; ruling 194 item 3). Every row of `bundles` names this map
 * as its `publicVariants`, and `requestport`'s self-host Next build reads it
 * through `apps/requestport/src/web/test-seams.ts` (`selfHostReplacements`;
 * ruling 193 item 5).
 */
export const publicVariants = Object.freeze({
  "packages/db/src/shared-databases.ts":
    "packages/db/src/shared-databases.public.ts",
  "packages/db/src/hosted-driver.ts": "packages/db/src/hosted-driver.public.ts",
  "packages/db/src/hosted-migrator.ts":
    "packages/db/src/hosted-migrator.public.ts",
});

/**
 * The test seams (Plan 13, H.7; ruling 174), the one list of them (ruling
 * 151; ruling 193 item 2), which every build that leaves them out reads:
 * the JavaScript step of every row of `bundles` (`inertSeams`), the
 * per-tarball check of `scripts/pack-packages.mjs` (`seamMarkersIn`), and,
 * through `apps/requestport/src/web/test-seams.ts`, which gives it as
 * `TEST_SEAMS`, the self-host Next build `@requestport/web` carries, and
 * `scripts/pack-requestport.mjs`. `requestport`'s esbuild bundle inlines
 * `apps/requestport`'s modules alone, so it reaches no seam. Each seam acts only in E2E mode (a
 * run-time `NODE_ENV` of `development` or `test`, `REQUESTPORT_E2E_MODE=1`
 * and a token of at least 32 characters), and each reads that gate through one module,
 * its real module (`real`). A build that leaves it out puts its inert module
 * (`inert`) in its place, in which the E2E predicate is false, the capture
 * and the register refuse, and nothing else of the real module is there.
 * apps/web's own build (Vercel's, and the one `--e2e` serves) keeps the real
 * modules, and so does every suite that loads the source.
 *
 * `markers` are text that shows the seam's real module in a build: its own
 * path, which esbuild writes in the module comment above it, and the names
 * and words a minifier keeps. Of the repository's source outside tests and
 * test support, each is held by its real module alone, and a path by no
 * module, but two: the outbox's `REQUESTPORT_E2E_MODE` and
 * `REQUESTPORT_E2E_TOKEN` are E2E mode's own variables, which other E2E
 * modules hold too (`apps/web`'s and `db`'s E2E owner storage, `apps/web`'s
 * scenario hook and its email-outbox route's handlers, the fault register
 * and the fence; `apps/requestport/src/web/test-seams.test.ts` lists each
 * marker's holders). The CSP fence's one marker is its path: its condition
 * is the outbox's predicate, which reads E2E mode's two variables. The list
 * is plain literals.
 */
export const testSeams = Object.freeze(
  [
    {
      name: "auth's E2E magic-link outbox",
      real: "packages/auth/src/e2e-email-outbox.ts",
      inert: "apps/requestport/src/inert/e2e-email-outbox.ts",
      markers: [
        "packages/auth/src/e2e-email-outbox.ts",
        "requestport.e2e.magic-link-outbox",
        "x-requestport-e2e-token",
        "E2E email outbox is unavailable",
        "REQUESTPORT_E2E_MODE",
        "REQUESTPORT_E2E_TOKEN",
      ],
    },
    {
      name: "apps/web's scenario-fault register",
      real: "apps/web/src/lib/e2e-scenario-fault.ts",
      inert: "apps/requestport/src/inert/e2e-scenario-fault.ts",
      markers: [
        "apps/web/src/lib/e2e-scenario-fault.ts",
        "requestport.e2e.scenario-runs",
        "requestport.e2e_scenario",
      ],
    },
    {
      name: "the CSP's E2E fence",
      real: "packages/server/src/e2e-csp-fence.ts",
      inert: "packages/server/src/inert/e2e-csp-fence.ts",
      markers: ["packages/server/src/e2e-csp-fence.ts"],
    },
  ].map((seam) =>
    Object.freeze({ ...seam, markers: Object.freeze(seam.markers) }),
  ),
);

/** Every seam's marker `text` holds, in `testSeams`' order, with its seam. */
export function seamMarkersIn(text) {
  return testSeams.flatMap((seam) =>
    seam.markers
      .filter((marker) => text.includes(marker))
      .map((marker) => ({ seam, marker })),
  );
}

/**
 * `testSeams` as a map: each real module to the inert module a bundle
 * builds in its place, both by path from the repository's root. Every row of
 * `bundles` names it as its `inertSeams`.
 */
export const inertSeams = Object.freeze(
  Object.fromEntries(testSeams.map(({ real, inert }) => [real, inert])),
);

/**
 * A row of `bundles` for `name`, a package of the set: its entries, every
 * other package of the set external, nothing of another package inlined,
 * each private module built as its public variant, and each test seam as
 * its inert module.
 */
function setBundle(name, entries) {
  return Object.freeze({
    package: name,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    external: Object.freeze(packageSet.filter((other) => other !== name)),
    inlines: Object.freeze([]),
    declarations: setDeclarations,
    publicVariants,
    inertSeams,
  });
}

/**
 * A row of `bundles` for `name`, one of `hostPackages`: its entries, every
 * other package `bundles` builds external, nothing of another package
 * inlined, each private module built as its public variant, and each test
 * seam as its inert module.
 */
function hostBundle(name, entries) {
  return Object.freeze({
    package: name,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    external: Object.freeze(
      [...packageSet, ...hostPackages].filter((other) => other !== name),
    ),
    inlines: Object.freeze([]),
    declarations: hostDeclarations,
    publicVariants,
    inertSeams,
  });
}

/**
 * The bundles, by name, in the order `buildOrder` is given them in. Each
 * entry is a subpath of the package the bundle builds, the file name its
 * output takes in `dist/`, and its source, from the repository's root. A
 * row publishes each subpath that a published entry imports, or that
 * `requestport`'s own modules import, or that is core's but
 * `./person-context` (ruling 230 item 3), and that is neither test-only nor
 * a test seam (G's S8 survey, §1.4, and its open questions 3 and 4, which
 * ruling 183 items 3 and 4 rule: only the subpaths reachable from a
 * published entry are published; H.7's fourth round's
 * survey, recount 3, which ruling 193 item 1 rules, option (A)). Its source
 * manifest's other subpaths are not entries:
 *
 * - `domain`'s `./browser`, which only the repository's web imports;
 * - `config`'s `.` and `./client`, which parse `process.env` at import
 *   (ruling 176), and `./redaction`, which no published entry imports.
 *   `config` publishes `./logger`; `./sign-in-methods`, which `auth`'s
 *   `./create-auth` imports (ruling 183 item 3); and `./server` and
 *   `./server-deferred`: `requestport` imports the first, which parses
 *   `process.env` as it is imported, and `jobs`' `.` the second (ruling 193
 *   item 1);
 * - `db`'s `./testing`, test support (ruling 185), and `./e2e`, the E2E
 *   owner storage. `db` publishes `./wiring`, the roots' (G.1), which
 *   `requestport` and `jobs`' `.` import (ruling 193 item 1);
 * - `jobs`' `./selection`, which only the repository's web imports, and its
 *   bin, which is not packed (ruling 185). `jobs` publishes `.`, which
 *   `requestport` imports (ruling 193 item 1);
 * - core's `./person-context`, which only the repository's web imports, and
 *   which ruling 230 item 3 does not publish. Core publishes its other
 *   subpaths: `./adapters` too, which `server` imports (ruling 193 item 1;
 *   ruling 144 had left it out);
 * - `auth`'s `.` and `./server`, which install Better Auth from the
 *   process's environment as they are imported (ruling 193 item 3),
 *   `./client`, the browser's, and `./e2e`, the magic-link outbox, a test
 *   seam. `auth` publishes `./create-auth`, which `requestport` imports and
 *   which also gives the agent contexts' types `mcp` and `server` name, and
 *   `./auth-handler`, which `server` imports;
 * - `server`'s every subpath but `.`, the host, which `requestport` imports:
 *   only the repository's web imports the other fourteen. Its JavaScript
 *   holds the CSP fence's inert module (`inertSeams`).
 *
 * @type {Readonly<Record<import("./bundle.d.mts").BundleName, import("./bundle.d.mts").PackageBundle>>}
 */
export const bundles = Object.freeze({
  domain: setBundle("@requestport/domain", [
    { subpath: ".", name: "index", source: "packages/domain/src/index.ts" },
  ]),
  notifications: setBundle("@requestport/notifications", [
    {
      subpath: ".",
      name: "index",
      source: "packages/notifications/src/index.ts",
    },
    {
      subpath: "./view-model",
      name: "view-model",
      source: "packages/notifications/src/view-model.ts",
    },
    {
      subpath: "./slack",
      name: "slack",
      source: "packages/notifications/src/slack/index.ts",
    },
  ]),
  webhooks: setBundle("@requestport/webhooks", [
    { subpath: ".", name: "index", source: "packages/webhooks/src/index.ts" },
  ]),
  importer: setBundle("@requestport/importer", [
    { subpath: ".", name: "index", source: "packages/importer/src/index.ts" },
  ]),
  config: setBundle("@requestport/config", [
    {
      subpath: "./logger",
      name: "logger",
      source: "packages/config/src/logger.ts",
    },
    {
      subpath: "./server",
      name: "server",
      source: "packages/config/src/server.ts",
    },
    {
      subpath: "./server-deferred",
      name: "server-deferred",
      source: "packages/config/src/server-deferred.ts",
    },
    {
      subpath: "./sign-in-methods",
      name: "sign-in-methods",
      source: "packages/config/src/sign-in-methods.ts",
    },
  ]),
  db: setBundle("@requestport/db", [
    { subpath: ".", name: "index", source: "packages/db/src/index.ts" },
    {
      subpath: "./migrate",
      name: "migrate",
      source: "packages/db/src/migrate.ts",
    },
    {
      subpath: "./wiring",
      name: "wiring",
      source: "packages/db/src/wiring.ts",
    },
  ]),
  jobs: setBundle("@requestport/jobs", [
    { subpath: ".", name: "index", source: "packages/jobs/src/index.ts" },
    {
      subpath: "./catalogue",
      name: "catalogue",
      source: "packages/jobs/src/catalogue.ts",
    },
    {
      subpath: "./dispatch",
      name: "dispatch",
      source: "packages/jobs/src/dispatch.ts",
    },
    {
      subpath: "./worker",
      name: "worker",
      source: "packages/jobs/src/worker.ts",
    },
    {
      subpath: "./worker-storages",
      name: "worker-storages",
      source: "packages/jobs/src/worker-storages.ts",
    },
  ]),
  core: setBundle("@requestport/core", [
    { subpath: ".", name: "index", source: "packages/core/src/index.ts" },
    {
      subpath: "./adapters",
      name: "adapters",
      source: "packages/core/src/adapters.ts",
    },
    {
      subpath: "./agent-services",
      name: "agent-services",
      source: "packages/core/src/agent-services/index.ts",
    },
    {
      subpath: "./migrate",
      name: "migrate",
      source: "packages/core/src/migrate.ts",
    },
  ]),
  auth: hostBundle("@requestport/auth", [
    {
      subpath: "./auth-handler",
      name: "auth-handler",
      source: "packages/auth/src/auth-handler.ts",
    },
    {
      subpath: "./create-auth",
      name: "create-auth",
      source: "packages/auth/src/create-auth.ts",
    },
  ]),
  mcp: hostBundle("@requestport/mcp", [
    { subpath: ".", name: "index", source: "packages/mcp/src/index.ts" },
  ]),
  server: hostBundle("@requestport/server", [
    { subpath: ".", name: "index", source: "packages/server/src/index.ts" },
  ]),
});

/** A test, test support, or the sweep's ledger, by its path from the repository's root. */
export function testOnlyModule(path) {
  return (
    /\.test\.tsx?$/u.test(path) ||
    path.includes("/test-support/") ||
    path.includes("tenant-scope-sweep")
  );
}

/**
 * The forbidden-module list, the one copy of it (ruling 151), beside its
 * test-only half (`testOnlyModule`): each module a bundle may not inline
 * (manifest-g.md Appendix A.7, §4 step 2, Done when 9 under S1), by its path
 * from the repository's root, with why. A module that names `publishedBy`
 * is one of that package's published entries, or a module only they reach
 * (ruling 193 item 1: "G's forbidden-module list is scoped to match"): that
 * package's own bundle may inline it, and no other bundle may.
 */
export const forbiddenModules = Object.freeze(
  [
    {
      module: "packages/db/src/testing.ts",
      reason:
        "`db`'s `./testing`, test support, which no tarball publishes (ruling 185)",
    },
    {
      module: "packages/config/src/index.ts",
      reason:
        "`config`'s `.`, which parses `process.env` as it is imported, and which no tarball publishes (ruling 176)",
    },
    {
      module: "packages/config/src/client.ts",
      reason:
        "`config`'s `./client`, which parses `process.env` as it is imported, and which no tarball publishes (ruling 176)",
    },
    {
      module: "packages/db/src/wiring.ts",
      publishedBy: "@requestport/db",
      reason:
        "the roots' wiring (G.1), `db`'s `./wiring`, which `requestport` and `jobs`' `.` import (ruling 193 item 1)",
    },
    {
      module: "packages/jobs/src/index.ts",
      publishedBy: "@requestport/jobs",
      reason:
        "`jobs`' `.`, which registers the worker's root as it is imported and which `requestport` imports (ruling 193 item 1)",
    },
    {
      module: "packages/jobs/src/worker-root.ts",
      publishedBy: "@requestport/jobs",
      reason:
        "the worker's root, which builds storages from the process's environment through `db`'s `./wiring`; `jobs`' `.` registers it",
    },
    {
      module: "packages/jobs/src/cli.ts",
      publishedBy: "@requestport/jobs",
      reason:
        "the worker's command, `runJobWorkerCli`, which `jobs`' `.` exports; the bin that runs it is not packed (ruling 185)",
    },
    {
      module: "packages/config/src/server.ts",
      publishedBy: "@requestport/config",
      reason:
        "`config`'s `./server`, which parses `process.env` as it is imported (ruling 176) and which `requestport` imports (ruling 193 item 1)",
    },
    {
      module: "packages/config/src/server-deferred.ts",
      publishedBy: "@requestport/config",
      reason:
        "`config`'s `./server-deferred`, which parses `process.env` when it is first read and which `jobs`' `.` imports (ruling 193 item 1)",
    },
    {
      module: "packages/config/src/server-schema.ts",
      publishedBy: "@requestport/config",
      reason:
        "the schema `./server` and `./server-deferred` parse `process.env` with",
    },
  ].map((entry) => Object.freeze(entry)),
);

/**
 * Whether a bundle of the package named `packed` may not inline `path`, a
 * module by its path from the repository's root: a test, test support or
 * the sweep's ledger (`testOnlyModule`), or a module of `forbiddenModules`
 * that is not one of `packed`'s own published modules. Without `packed`, as
 * for a bundle that is no row of `bundles` (K8's stand-in), every module of
 * the list is forbidden. `src/bundle.test.ts`, `scripts/pack-packages.mjs`,
 * that script's test and `spikes/h0-probe/k8-bundle.mjs` all read it here;
 * `requestport`'s bundle inlines no module outside `apps/requestport`
 * (`apps/requestport/bundle.mjs`), so it needs no part of the list.
 */
export function forbiddenModule(path, packed) {
  return (
    testOnlyModule(path) ||
    forbiddenModules.some(
      ({ module, publishedBy }) =>
        module === path &&
        (publishedBy === undefined || publishedBy !== packed),
    )
  );
}

/** The package a bare specifier names: `@scope/name` or `name`. */
export function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * The externals rule: whether `bundle` leaves `specifier` to the consumer's
 * install. A relative or absolute path is part of the bundle. A bare
 * specifier is external, unless it names a `@requestport/*` package the
 * bundle does not name in `external`, which is inlined.
 */
export function isExternal(bundle, specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  const name = packageName(specifier);
  return !name.startsWith("@requestport/") || bundle.external.includes(name);
}

/**
 * The public variant `bundle` builds in place of `module`, a path from the
 * repository's root as an import names it (`.js` for a `.ts` source), by
 * `bundle.publicVariants`; `undefined` when `module` is no private module the
 * bundle names. Both steps of `buildBundle` read it. An import that names the
 * module another way is built as it is, and `scripts/pack-packages.mjs`
 * refuses what that inlines by the checks step 7 of its header lists.
 */
export function publicVariantOf(bundle, module) {
  const source = module.replace(/\.js$/u, ".ts");
  const variants = bundle.publicVariants ?? {};
  return Object.hasOwn(variants, source) ? variants[source] : undefined;
}

/**
 * The inert module `bundle` builds in place of `module`, a path from the
 * repository's root as an import names it, by `bundle.inertSeams`;
 * `undefined` when `module` is no seam's real module the bundle names. The
 * JavaScript step of `buildBundle` reads it.
 */
export function inertSeamOf(bundle, module) {
  const source = module.replace(/\.js$/u, ".ts");
  const seams = bundle.inertSeams ?? {};
  return Object.hasOwn(seams, source) ? seams[source] : undefined;
}

/**
 * What the JavaScript step of `buildBundle` builds in place of `module`: its
 * public variant (`publicVariantOf`), else its inert module (`inertSeamOf`),
 * else `undefined`, the module as it is. The declaration step reads
 * `publicVariantOf` alone (this module's header).
 */
function replacementOf(bundle, module) {
  return publicVariantOf(bundle, module) ?? inertSeamOf(bundle, module);
}

/**
 * Each doc comment (`/** … *\/`) of a private module of `variants` that its
 * public variant does not hold, with the module and the variant, by path
 * from the repository's root. In the public seed the module's path holds the
 * variant, so there are none. tsc keeps a declaration's doc comment in its
 * emit, and rolldown keeps it in the bundle, so a declaration bundle that
 * inlines a declaration of the module holds its doc comment, whether or not
 * rolldown gives the module a `//#region`: `src/bundle.test.ts` builds one
 * without `publicVariants`, and `scripts/pack-packages.mjs` refuses a
 * tarball holding any (`holdsDocComment`).
 */
export function privateDocComments(variants = publicVariants) {
  const docComments = (path) =>
    readFileSync(join(repositoryRoot, path), "utf8").match(
      /\/\*\*[\s\S]*?\*\//gu,
    ) ?? [];
  return Object.entries(variants).flatMap(([module, variant]) => {
    const kept = new Set(docComments(variant));
    return docComments(module)
      .filter((comment) => !kept.has(comment))
      .map((comment) => ({ module, variant, comment }));
  });
}

/**
 * Whether `text` holds `comment`, each line of both read with the space
 * around it trimmed, so a comment re-indented in a bundle still counts.
 */
export function holdsDocComment(text, comment) {
  const trimmed = (lines) =>
    lines
      .split("\n")
      .map((line) => line.trim())
      .join("\n");
  return trimmed(text).includes(trimmed(comment));
}

/**
 * Builds `bundle` into `packageDirectory`'s `dist/`, which must not exist:
 * its JavaScript, then its declarations, when it names a declaration project.
 */
export async function buildBundle(bundle, packageDirectory) {
  const dist = join(packageDirectory, "dist");
  if (existsSync(dist)) {
    throw new Error(`${dist} exists: a bundle is built into a new dist/.`);
  }
  mkdirSync(dist, { recursive: true });
  const metafile = await buildJavaScript(bundle, dist);
  const declarations =
    bundle.declarations === undefined
      ? []
      : await buildDeclarations(bundle, dist);
  return { metafile, declarations };
}

/**
 * Builds `bundle`, a row of `bundles` or a row planted from one, into
 * `packageDirectory`'s `dist/` with `buildBundle`, and throws when
 * `siblingProblems` finds any: a module of another package inlined that the
 * row does not name in `inlines`, or a `@requestport/*` subpath imported that
 * no row of `bundles` publishes.
 */
export async function buildPackage(bundle, packageDirectory) {
  const built = await buildBundle(bundle, packageDirectory);
  const problems = await siblingProblems(
    bundle,
    built.metafile,
    join(packageDirectory, "dist"),
    built.declarations,
  );
  if (problems.length > 0) {
    throw new Error(`${bundle.package}: ${problems.join("; ")}`);
  }
  return built;
}

/**
 * What `buildPackage` refuses in a build of `bundle`, from esbuild's
 * `metafile` and the declaration files `declarations` names in `dist`:
 *
 * - each module esbuild inlined that is not in `bundle.package`'s own
 *   workspace and not in `bundle.inlines`: a second copy of another
 *   package's code;
 * - each `@requestport/*` specifier the JavaScript imports (statically or
 *   through `import(…)`) or the declarations import, re-export or name in
 *   `import("…")` that names a package no row of `bundles` builds, or a
 *   subpath that the row building its package has no entry for.
 */
export async function siblingProblems(bundle, metafile, dist, declarations) {
  const directories = workspaceDirectories();
  const own = `${directories.get(bundle.package)}/`;
  const ownerOf = (module) =>
    [...directories].find(([, directory]) =>
      module.startsWith(`${directory}/`),
    )?.[0] ?? "no workspace";
  const problems = [];
  for (const module of Object.keys(metafile.inputs).sort()) {
    if (!module.startsWith(own) && !bundle.inlines.includes(module)) {
      problems.push(`inlines ${module}, a module of ${ownerOf(module)}`);
    }
  }

  const specifiers = new Set();
  for (const { imports } of Object.values(metafile.outputs)) {
    for (const { path, external } of imports) {
      if (external && path.startsWith("@requestport/")) specifiers.add(path);
    }
  }
  for (const file of declarations) {
    const text = readFileSync(join(dist, file), "utf8");
    for (const specifier of await declarationSpecifiers(text)) {
      if (specifier.startsWith("@requestport/")) specifiers.add(specifier);
    }
  }
  for (const specifier of [...specifiers].sort()) {
    const name = packageName(specifier);
    const subpath =
      specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const row = Object.values(bundles).find((other) => other.package === name);
    if (row === undefined) {
      problems.push(`imports ${specifier}, and no bundle builds ${name}`);
    } else if (!row.entries.some((entry) => entry.subpath === subpath)) {
      problems.push(`imports ${specifier}, which ${name} does not publish`);
    }
  }
  return problems;
}

/**
 * Every specifier a declaration file imports or re-exports, or names in
 * `import("…")`, read with rolldown's parser.
 */
async function declarationSpecifiers(text) {
  const { parseAst } = await import("rolldown/parseAst");
  const found = [];
  const visit = (node) => {
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "TSImportType",
      ].includes(node.type) &&
      typeof node.source?.value === "string"
    ) {
      found.push(node.source.value);
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (typeof child?.type === "string") visit(child);
      }
    }
  };
  visit(parseAst(text, { lang: "dts" }));
  return found;
}

/**
 * The keys of `set`'s rows in the order they build and pack in: each after
 * every package its source manifest's `dependencies` name with a
 * `workspace:` version (`topologicalOrder`, taking `set`'s order as the
 * given one). It throws when such a package is built by no row of `set`, or
 * when the dependencies form a cycle.
 */
export function buildOrder(set = bundles) {
  const keyOf = new Map(
    Object.entries(set).map(([key, row]) => [row.package, key]),
  );
  return topologicalOrder(
    Object.entries(set).map(([key, row]) => {
      const directory = workspaceDirectories().get(row.package);
      if (directory === undefined)
        throw new Error(`no workspace is ${row.package}`);
      const { dependencies = {} } = JSON.parse(
        readFileSync(join(repositoryRoot, directory, "package.json"), "utf8"),
      );
      const needs = Object.entries(dependencies)
        .filter(([, version]) => version.startsWith("workspace:"))
        .map(([name]) => {
          const needed = keyOf.get(name);
          if (needed === undefined) {
            throw new Error(
              `${row.package} depends on ${name}, and no bundle of the set builds it`,
            );
          }
          return needed;
        });
      return [key, needs];
    }),
  );
}

/**
 * `graph`'s nodes, each after every node of `graph` it names: at each step,
 * the first node left, in `graph`'s order, whose named nodes are all placed
 * (Kahn's algorithm). A name that is not a node of `graph` is not waited
 * for. It throws when the nodes left form a cycle.
 */
export function topologicalOrder(graph) {
  const pending = new Map(graph.map(([node, needs]) => [node, needs]));
  const order = [];
  while (pending.size > 0) {
    const ready = [...pending].find(([, needs]) =>
      needs.every((needed) => !pending.has(needed)),
    );
    if (ready === undefined) {
      throw new Error(`a cycle among ${[...pending.keys()].join(", ")}`);
    }
    order.push(ready[0]);
    pending.delete(ready[0]);
  }
  return order;
}

async function buildJavaScript(bundle, dist) {
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    absWorkingDir: repositoryRoot,
    entryPoints: Object.fromEntries(
      bundle.entries.map(({ name, source }) => [name, source]),
    ),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    splitting: true,
    outdir: dist,
    entryNames: "[name]",
    chunkNames: "chunk-[hash]",
    sourcemap: false,
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "requestport-externals",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, ({ path }) =>
            isExternal(bundle, path) ? { path, external: true } : undefined,
          );
        },
      },
      {
        // A relative import of a private module resolves to its public
        // variant, and of a seam's real module to its inert module; every
        // other import is resolved by esbuild as before.
        name: "requestport-public-variants",
        setup(build) {
          build.onResolve({ filter: /^\./ }, ({ path, resolveDir }) => {
            const variant = replacementOf(
              bundle,
              relative(repositoryRoot, join(resolveDir, path)),
            );
            return variant === undefined
              ? undefined
              : { path: join(repositoryRoot, variant) };
          });
        },
      },
    ],
  });
  if (result.errors.length > 0 || result.warnings.length > 0) {
    throw new Error(
      `esbuild: ${[...result.errors, ...result.warnings].map(({ text }) => text).join("; ")}`,
    );
  }
  return result.metafile;
}

async function buildDeclarations(bundle, dist) {
  // The real path: macOS's default TMPDIR is under /var, a symlink to
  // /private/var. rolldown resolves its inputs' real paths against an
  // unresolved cwd, so from the symlinked path each region comment would climb
  // out to the build machine's temporary directory.
  const scratch = mkdtempSync(
    join(realpathSync(tmpdir()), "requestport-declarations-"),
  );
  try {
    const emitted = join(scratch, "repository");
    const tsc = join(
      dirname(
        createRequire(import.meta.url).resolve("typescript/package.json"),
      ),
      "bin",
      "tsc",
    );
    const run = spawnSync(
      process.execPath,
      [
        tsc,
        "-p",
        join(repositoryRoot, bundle.declarations),
        "--outDir",
        emitted,
      ],
      { encoding: "utf8" },
    );
    if (run.status !== 0 || `${run.stdout}${run.stderr}` !== "") {
      throw new Error(
        `tsc -p ${bundle.declarations} exited ${run.status}: ${run.stdout}${run.stderr}`,
      );
    }

    const { rolldown } = await import("rolldown");
    const { dts } = await import("rolldown-plugin-dts");
    const warnings = [];
    const build = await rolldown({
      cwd: emitted,
      input: Object.fromEntries(
        bundle.entries.map(({ name, source }) => [
          name,
          join(emitted, declarationOf(source)),
        ]),
      ),
      platform: "node",
      external: (id) => !id.startsWith("\0") && isExternal(bundle, id),
      onwarn: (warning) => warnings.push(warning.message),
      plugins: [
        {
          // Before the plugin's own resolver, which would otherwise resolve a
          // workspace to a declaration beside its source in the repository
          // (`packages/db/src/index.d.ts`), where none exists.
          name: "requestport-workspace-declarations",
          resolveId: {
            order: "pre",
            handler(source) {
              if (!source.startsWith("@requestport/")) return null;
              if (isExternal(bundle, source)) {
                return { id: source, external: true };
              }
              return join(emitted, declarationOf(workspaceExport(source)));
            },
          },
        },
        {
          // A relative import of a private module's declaration resolves to
          // its public variant's, which tsc must have emitted too (each
          // project `bundles` names includes `db`'s `src/`); every other
          // import falls through, a seam's real module's among them. Before
          // the plugin's own resolver, as above.
          name: "requestport-public-variant-declarations",
          resolveId: {
            order: "pre",
            handler(source, importer) {
              if (importer === undefined || !source.startsWith(".")) {
                return null;
              }
              const variant = publicVariantOf(
                bundle,
                relative(emitted, join(dirname(importer), source)),
              );
              return variant === undefined
                ? null
                : join(emitted, declarationOf(variant));
            },
          },
        },
        // The inputs are declarations already (`dtsInput`), so no generator
        // runs. One is named all the same, because the plugin resolves its
        // options first: with TypeScript 7 installed it would choose `tsgo`,
        // which throws without a tsconfig file.
        dts({
          cwd: emitted,
          dtsInput: true,
          emitDtsOnly: true,
          tsconfig: false,
          generator: "oxc",
        }),
      ],
    });
    try {
      const { output } = await build.write({
        dir: dist,
        format: "esm",
        entryFileNames: "[name].d.ts",
        chunkFileNames: "[name]-[hash].d.ts",
      });
      if (warnings.length > 0) {
        throw new Error(`rolldown: ${warnings.join("; ")}`);
      }
      return output.map(({ fileName }) => fileName).sort();
    } finally {
      await build.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `packages/db/src/client.ts` → `packages/db/src/client.d.ts`. */
function declarationOf(source) {
  return source.replace(/\.tsx?$/u, ".d.ts");
}

/**
 * The source file a `@requestport/*` specifier names, from the repository's
 * root, by its workspace's `exports`.
 */
function workspaceExport(specifier) {
  const name = packageName(specifier);
  const directory = workspaceDirectories().get(name);
  if (directory === undefined) throw new Error(`no workspace is ${name}`);
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, directory, "package.json"), "utf8"),
  );
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  const target =
    typeof manifest.exports === "string"
      ? subpath === "."
        ? manifest.exports
        : undefined
      : manifest.exports?.[subpath];
  if (typeof target !== "string") {
    throw new Error(`${name} exports no ${subpath}`);
  }
  return relative(repositoryRoot, join(repositoryRoot, directory, target));
}

let workspaces;
/** Each `packages/*` workspace's directory, by its package name. */
function workspaceDirectories() {
  if (workspaces === undefined) {
    workspaces = new Map();
    for (const entry of readdirSync(join(repositoryRoot, "packages"))) {
      const manifest = join(repositoryRoot, "packages", entry, "package.json");
      if (!existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, "utf8"));
      workspaces.set(name, join("packages", entry));
    }
  }
  return workspaces;
}
