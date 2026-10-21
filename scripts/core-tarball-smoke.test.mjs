import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { hostPackages, packageSet } from "../packages/core/bundle.mjs";
import {
  ADDITION_IDENTIFIERS,
  additionAccepted,
  ancestorsHolding,
  buildDevDependencies,
  CONSUMER_DEPENDENCIES,
  consumerDevDependencies,
  consumerFiles,
  consumerLicences,
  consumerTypeCheckTools,
  exportedSubpaths,
  FIXTURE,
  HOST,
  IDENTITY_REQUIRED,
  INSTALL_SCRIPTS,
  INVENTORY_PACKAGES,
  INVENTORY_PLANTS,
  importedSpecifiers,
  installEnvironment,
  installedCopies,
  installedPglite,
  installedProblems,
  LICENCE_INVENTORY,
  LICENCE_REFERENCE,
  LINUX_PLANTS,
  LOCKFILE_PLANTS,
  LOOPBACK_HOSTS,
  licenceInventoryArguments,
  licenceProblems,
  linuxBindingProblems,
  linuxBindings,
  linuxBindingsFiles,
  localServer,
  lockfileProblems,
  MODULE_PLANTS,
  moduleCommentProblems,
  moduleOwner,
  modulePlants,
  OWN_PUBLISHED_MODULES,
  PACKED,
  PGLITE,
  PGLITE_ABSENT,
  PLANTED_IMPORT,
  packSetProblems,
  parseLockfile,
  parseTscReport,
  pinnedPnpm,
  plantImport,
  plantModule,
  plantPglite,
  plantReported,
  RULED_PRINCIPALS,
  RULING_144_MOVED,
  RUN_ENVIRONMENT_NAMES,
  RUN_PLANTS,
  readLicenceReference,
  reusePack,
  runEnvironment,
  runProblems,
  S8,
  smokeModuleRefusal,
  specifierProblems,
  TYPE_CHECK_PACKAGES,
  tarballPlants,
  tarballProblems,
  thirdPartyDeclaration,
  tscArguments,
  typeCheckProblems,
  UNBOUND_MESSAGE,
  unoverriddenNames,
  unrefusedModulePlants,
  unreportedInventoryPlants,
  unreportedLinuxPlants,
  unreportedLockfilePlants,
  unreportedRunPlants,
  zodBattery,
  zodBatteryDifferences,
  zodBehaviour,
} from "./core-tarball-smoke.mjs";
import {
  FLAGS,
  inventory,
  RECOGNISED_IDENTIFIERS,
} from "./licence-inventory.mjs";
import { PACKAGES } from "./pack-packages.mjs";

/*
 * `scripts/core-tarball-smoke.mjs` (Plan 13, G.8; ruling 153), under S8
 * (ruling 175): its checks on planted input, offline. No case packs,
 * installs or reaches a registry; the smoke itself is run by hand and
 * recorded in `track-g.md`.
 *
 * - The set: `S8` is `bundle.mjs`'s `packageSet`, `HOST` its
 *   `hostPackages`, the rest of `PACKAGES` (ruling 190), and step 1 refuses
 *   a run's tarballs that are not each of them once.
 * - Step 4's lockfile assertion, on a lockfile written here in the shape
 *   pnpm 11.22.0 writes for the consumer, with four planted tarballs: the
 *   consumer's three dependencies and one package it reaches through the
 *   overrides alone. The dependency-confusion path (`auth`'s dependency on
 *   core resolved from the registry) is reported, and so is each of
 *   `LOCKFILE_PLANTS`, an override the consumer does not make, and an
 *   importer that does not depend on exactly `direct`; a consumer reached
 *   through a symbolic link has its relative `file:` paths read from its
 *   real path. The installed copies are read from a planted pnpm store.
 * - Step 2's own refusals (ruling 152), on planted tarballs' files: a module
 *   comment naming a test, or a module of another package (`server`'s
 *   copy of core's `./adapters` among them: it imports that subpath, which
 *   ruling 193 item 1 publishes), is refused, in the JavaScript and the
 *   declarations, and so is each of `MODULE_PLANTS` but a package's own
 *   published modules in its own tarball (`OWN_PUBLISHED_MODULES`);
 *   the specifiers are read by their import shapes and not from prose, and
 *   an unpublished subpath, a package the run does not pack and, in a
 *   package of `S8`, a package of `HOST` are refused; each of
 *   `tarballPlants` is refused in a tarball of every package; the criterion
 *   is the script's own, and the script names neither of `bundle.mjs`'s
 *   list functions.
 * - Step 1's `--from`: a tarball whose bytes or size differ from the build
 *   record's, or a staged directory with no manifest, is refused.
 * - Step 3: a `node_modules` or `.npmrc` above the consumer is found under
 *   the path as given and under its real path; the consumer depends on
 *   `CONSUMER_DEPENDENCIES` and overrides `PACKED`; a packed manifest naming
 *   a `@requestport/*` no override maps is reported.
 * - Step 4's runner: the install's whole environment, and the pinned pnpm's
 *   path in corepack's cache.
 * - Step 5's type check (ruling 150), on planted `tsc` reports over a
 *   planted consumer tree: with `skipLibCheck` false only errors in
 *   third-party declarations pass, counted by package and code, and an error
 *   in the consumer's own file, in an `@requestport/*` declaration, in a
 *   third-party source file, in no file or in a file that is not there is
 *   reported; with it true every error is; a path is read from `tsc`'s
 *   directory under its real path and its path as given; the plant, an
 *   import of a name core's `.` does not export, is reported by both rules.
 *   The consumer's `devDependencies` are the root's exact versions, an
 *   installed `typescript` or `@types/node` at another version is reported,
 *   and the fixture's tsconfig, imports and human scopes are pinned.
 * - Step 6's run (ruling 153), on a planted report: `--database` names a
 *   loopback `postgres:` server or is refused; the consumer's environment;
 *   a report with core's re-exports `db`'s own, every module under its
 *   ruled principal, read back, the `tenantBinding: "off"` read failing with
 *   42501, a `DomainError` of one class from each refusal, no session left
 *   and both dropped passes, and each of `RUN_PLANTS` and each other failure
 *   is reported; `IDENTITY_REQUIRED` is what core's sources re-export from
 *   `db`; the fixture's modules, and its operator and agent scopes, are
 *   pinned to the domain's lists, the operator's to exactly the scopes the
 *   registry asks of the reads the fixture makes; and the `zod` copies, on a
 *   planted installed tree, with G.7a's battery compared, the last run after
 *   the fixture's imports.
 * - Step 6's PGlite case (ruling 153: the optional peer absent): H.4's
 *   refusal, `MODULE_NOT_FOUND` with Node's error for `@electric-sql/pglite`
 *   as its cause (rulings 151 and 154), from a lookup in `db`'s installed
 *   package, passes, and a case not run, a storage answered, another error,
 *   Node's generic error alone and a lookup started elsewhere are reported;
 *   the peer found anywhere in a planted lockfile or installed tree is
 *   reported, its declarations as a peer are not; and the fixture's one
 *   PGlite call is an in-memory one.
 * - Step 7 (rulings 139, 151 and 153), on planted installed trees: G.A's
 *   script's arguments, and the reference's S8 row read from the committed
 *   file; the set's closure as the walk of view (b) reads it with G.A's
 *   classifier, member by member, judged with G.A's own document over the
 *   same tree; the comparison by name, of the union and of each package, in
 *   which a version the reference lacks is recorded with its licence and a
 *   new unflagged name is accepted, and a new flagged name, a known name
 *   changing class, the walk and the document disagreeing and each of
 *   `INVENTORY_PLANTS` are reported; the Linux bindings' scratch project,
 *   the reading of a planted pnpm store, and their judgement, with each of
 *   `LINUX_PLANTS` reported.
 * - Nothing published (§3.6): the smoke, its fixture and the fixture's
 *   tsconfig name no publish command, by G.7's two patterns, and no
 *   `adduser`, `_authToken` or `config set`.
 *
 * Every temporary file is under one directory in `os.tmpdir()`, removed
 * after the suite.
 */

const scratch = mkdtempSync(join(tmpdir(), "requestport-smoke-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const VERSION = "1.0.0-g8-test.1";

function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/**
 * Four planted tarballs in `<root>/pack`, a consumer directory (`consumer`,
 * the path the assertion is handed; `<root>/consumer` by default), and the
 * lockfile pnpm would write there: the consumer depends on core, `db` and
 * `auth`, and overrides core, `db` and `domain`, which it reaches only
 * through them. Its relative `file:` paths start from the consumer's real
 * path and end at each tarball's path as given, as pnpm 11.22.0 wrote them
 * in G.8's runs: under macOS's default `TMPDIR` they climb from
 * `/private/var/…` to `/` and come down through `var/…`. Its peer suffixes
 * and `transitivePeerDependencies` are as G's S8 trial install wrote them.
 */
function plantedInstall(root, { consumer } = {}) {
  const pack = join(root, "pack");
  mkdirSync(pack, { recursive: true });
  const directory = consumer ?? join(root, "consumer");
  mkdirSync(directory, { recursive: true });
  const tarballs = ["core", "db", "domain", "auth"].map((name) => {
    const path = join(pack, `requestport-${name}-${VERSION}.tgz`);
    const bytes = Buffer.from(`a planted ${name} tarball\n`);
    writeFileSync(path, bytes);
    return {
      name: `@requestport/${name}`,
      version: VERSION,
      integrity: integrityOf(bytes),
      path,
    };
  });
  const [core, db, domain, auth] = tarballs;
  const from = realpathSync(directory);
  const rel = (tarball) => relative(from, tarball.path);
  const packageEntry = (tarball, extra = []) => [
    `  '${tarball.name}@file:${rel(tarball)}':`,
    `    resolution: {integrity: ${tarball.integrity}, tarball: file:${rel(tarball)}}`,
    `    version: ${VERSION}`,
    "    engines: {node: '>=22 <23'}",
    ...extra,
    "",
  ];
  const text = [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "overrides:",
    `  '@requestport/domain': file:${domain.path}`,
    `  '@requestport/db': file:${db.path}`,
    `  '@requestport/core': file:${core.path}`,
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      '@requestport/auth':",
    `        specifier: file:${auth.path}`,
    `        version: file:${rel(auth)}(kysely@0.29.6)(zod@4.5.4)`,
    "      '@requestport/core':",
    `        specifier: file:${core.path}`,
    `        version: file:${rel(core)}(kysely@0.29.6)`,
    "      '@requestport/db':",
    `        specifier: file:${db.path}`,
    `        version: file:${rel(db)}(kysely@0.29.6)`,
    "",
    "packages:",
    "",
    ...packageEntry(auth),
    ...packageEntry(core),
    ...packageEntry(db, [
      "    peerDependencies:",
      "      '@electric-sql/pglite': 0.5.8",
      "    peerDependenciesMeta:",
      "      '@electric-sql/pglite':",
      "        optional: true",
    ]),
    ...packageEntry(domain),
    "  zod@4.4.3:",
    `    resolution: {integrity: ${integrityOf("zod 4.4.3")}}`,
    "",
    "  zod@4.5.4:",
    `    resolution: {integrity: ${integrityOf("zod 4.5.4")}}`,
    "",
    "snapshots:",
    "",
    `  '@requestport/auth@file:${rel(auth)}(kysely@0.29.6)(zod@4.5.4)':`,
    "    dependencies:",
    `      '@requestport/core': file:${rel(core)}(kysely@0.29.6)`,
    `      '@requestport/db': file:${rel(db)}(kysely@0.29.6)`,
    `      '@requestport/domain': file:${rel(domain)}`,
    "      zod: 4.5.4",
    "    transitivePeerDependencies:",
    "      - '@electric-sql/pglite'",
    "",
    `  '@requestport/core@file:${rel(core)}(kysely@0.29.6)':`,
    "    dependencies:",
    `      '@requestport/db': file:${rel(db)}(kysely@0.29.6)`,
    `      '@requestport/domain': file:${rel(domain)}`,
    "      zod: 4.4.3",
    "    transitivePeerDependencies:",
    "      - '@electric-sql/pglite'",
    "",
    `  '@requestport/db@file:${rel(db)}(kysely@0.29.6)':`,
    "    dependencies:",
    `      '@requestport/domain': file:${rel(domain)}`,
    "",
    `  '@requestport/domain@file:${rel(domain)}':`,
    "    dependencies:",
    "      zod: 4.4.3",
    "",
    "  zod@4.4.3: {}",
    "",
    "  zod@4.5.4: {}",
    "",
  ].join("\n");
  return {
    text,
    context: {
      consumer: directory,
      tarballs,
      version: VERSION,
      direct: ["@requestport/core", "@requestport/db", "@requestport/auth"],
      overridden: [
        "@requestport/domain",
        "@requestport/db",
        "@requestport/core",
      ],
    },
  };
}

describe("step 4: the lockfile assertion", () => {
  const planted = plantedInstall(join(scratch, "lockfile"));
  const problemsOf = (text) =>
    lockfileProblems(parseLockfile(text), planted.context);

  test("a lockfile in which every @requestport/* resolves to the pack's tarballs, with the build record's integrity, the consumer depending on its three and the overrides mapping the rest, has no problem (the control)", () => {
    assert.deepEqual(problemsOf(planted.text), []);
  });

  test("auth's dependency on core resolved from the registry, the dependency-confusion path, is reported in the snapshot, in packages and in the resolution", () => {
    const plant = LOCKFILE_PLANTS.find(({ name }) =>
      name.includes("resolved from the registry"),
    );
    const problems = problemsOf(plant.plant(planted.text, planted.context));
    for (const expected of [
      `dependencies: @requestport/core resolves to "${VERSION}", not a file: tarball of the pack`,
      `packages: @requestport/core@${VERSION}: @requestport/core resolves to "${VERSION}", not a file: tarball of the pack`,
      `packages: @requestport/core@${VERSION}: its resolution names no tarball`,
      "packages: @requestport/core is there 2 times, not once",
    ]) {
      assert.ok(
        problems.some((problem) => problem.includes(expected)),
        `${JSON.stringify(expected)} is not among ${JSON.stringify(problems, null, 2)}`,
      );
    }
  });

  test("each of LOCKFILE_PLANTS is reported with every line it expects: another integrity, the importer at the registry's version, no override for core or for domain, @requestport/ where the assertion does not look, and a second copy of domain from the registry", () => {
    assert.equal(LOCKFILE_PLANTS.length, 7);
    assert.deepEqual(
      unreportedLockfilePlants(planted.text, planted.context),
      [],
    );
    const domain = LOCKFILE_PLANTS.find(({ name }) =>
      name.startsWith("a second copy of domain"),
    );
    const problems = problemsOf(domain.plant(planted.text, planted.context));
    for (const expected of [
      `snapshots: @requestport/auth@file:`,
      `dependencies: @requestport/domain resolves to "${VERSION}", not a file: tarball of the pack`,
      `packages: @requestport/domain@${VERSION}: its resolution names no tarball`,
      "packages: @requestport/domain is there 2 times, not once",
    ]) {
      assert.ok(
        problems.some((problem) => problem.includes(expected)),
        `${JSON.stringify(expected)} is not among ${JSON.stringify(problems, null, 2)}`,
      );
    }
  });

  test("an override the consumer does not make is reported: of a package of the pack it does not override, and of a package the pack does not hold", () => {
    for (const [name, expected] of [
      [
        "@requestport/auth",
        "overrides: @requestport/auth is overridden, where the consumer overrides @requestport/domain, @requestport/db, @requestport/core and no other",
      ],
      [
        "@requestport/theme",
        "overrides: @requestport/theme is not a tarball of the pack",
      ],
    ]) {
      const problems = problemsOf(
        planted.text.replace(
          /^overrides:\n/mu,
          `overrides:\n  '${name}': file:${planted.context.tarballs[3].path}\n`,
        ),
      );
      assert.ok(
        problems.some((problem) => problem.startsWith(expected)),
        `${expected}: ${JSON.stringify(problems)}`,
      );
    }
  });

  test("the consumer's importer must depend on exactly its three: one more, a package it reaches through the overrides, and one fewer are reported", () => {
    const [, , domain] = planted.context.tarballs;
    const extra = planted.text.replace(
      /^( {6}'@requestport\/db':\n {8}specifier: \S+\n {8}version: \S+\n)/mu,
      `$1      '@requestport/domain':\n        specifier: file:${domain.path}\n        version: file:${relative(realpathSync(planted.context.consumer), domain.path)}\n`,
    );
    assert.notEqual(extra, planted.text);
    assert.deepEqual(problemsOf(extra), [
      "importers: ., dependencies: the consumer depends on @requestport/domain, which it does not import",
    ]);
    const fewer = planted.text.replace(
      /^ {6}'@requestport\/db':\n {8}specifier: \S+\n {8}version: \S+\n/mu,
      "",
    );
    assert.notEqual(fewer, planted.text);
    assert.deepEqual(problemsOf(fewer), [
      "importers: the consumer does not depend on @requestport/db",
    ]);
  });

  test("a consumer reached through a symbolic link has its relative file: paths read from its real path, as pnpm writes them", () => {
    // `<root>` is a real path, so `link` is the only link: from the
    // consumer's real path, `<root>/a/b/consumer`, the tarballs are
    // `../../../pack/…`; from its path as given, `<root>/link/consumer`,
    // those would name a `pack/` beside `<root>`, which does not exist.
    const root = join(realpathSync(scratch), "linked");
    const real = join(root, "a", "b");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(root, "link"));
    const linked = plantedInstall(root, {
      consumer: join(root, "link", "consumer"),
    });
    assert.match(linked.text, /version: file:\.\.\/\.\.\/\.\.\/pack\//u);
    assert.deepEqual(
      lockfileProblems(parseLockfile(linked.text), linked.context),
      [],
    );
  });

  test("the reader refuses a line pnpm's lockfile does not write, and a key written twice, rather than reading past it", () => {
    assert.throws(
      () => parseLockfile("lockfileVersion: '9.0'\n&anchor value\n"),
      /pnpm-lock\.yaml:2: not a line pnpm's lockfile writes/u,
    );
    assert.throws(
      () => parseLockfile("importers:\n  .: {}\n  .: {}\n"),
      /pnpm-lock\.yaml:3: \. is written twice/u,
    );
  });
});

describe("step 4: the installed copies", () => {
  /** A consumer whose pnpm store holds each name once, linked from its node_modules when `direct`. */
  function plantedStore(root, names, direct) {
    const consumer = join(root, "consumer");
    for (const name of names) {
      const copy = join(
        consumer,
        "node_modules/.pnpm",
        `${name.replace("/", "+")}@file+..+pack+${name.split("/")[1]}.tgz`,
        "node_modules",
        name,
      );
      mkdirSync(copy, { recursive: true });
      writeFileSync(
        join(copy, "package.json"),
        JSON.stringify({ name, version: VERSION }),
      );
      if (direct.includes(name)) {
        const link = join(consumer, "node_modules", name);
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(relative(dirname(link), copy), link);
      }
    }
    return consumer;
  }
  const names = ["@requestport/core", "@requestport/db", "@requestport/domain"];
  const direct = ["@requestport/core", "@requestport/db"];
  const tarballs = names.map((name) => ({ name, version: VERSION }));

  test("each package once in pnpm's store at the build record's version, and the consumer's own linked to that copy, has no problem (the control); another package of the scope is not a copy", () => {
    const consumer = plantedStore(
      join(scratch, "copies-control"),
      names,
      direct,
    );
    mkdirSync(
      join(
        consumer,
        "node_modules/.pnpm/@requestport+domain-tools@1.0.0/node_modules/@requestport/domain-tools",
      ),
      { recursive: true },
    );
    const copies = installedCopies(consumer, names);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(copies).map(([name, found]) => [
          name,
          found.map(({ version }) => version),
        ]),
      ),
      Object.fromEntries(names.map((name) => [name, [VERSION]])),
    );
    assert.deepEqual(
      installedProblems(copies, { consumer, tarballs, direct }),
      [],
    );
  });

  test("a second copy, a copy at another version, a package not installed, and a dependency of the consumer's that is not linked to the one copy are each reported", () => {
    const consumer = plantedStore(
      join(scratch, "copies-problems"),
      names,
      direct,
    );
    const second = join(
      consumer,
      "node_modules/.pnpm/@requestport+domain@file+..+pack+domain.tgz_planted/node_modules/@requestport/domain",
    );
    mkdirSync(second, { recursive: true });
    writeFileSync(
      join(second, "package.json"),
      JSON.stringify({ name: "@requestport/domain", version: "0.0.0-other" }),
    );
    rmSync(join(consumer, "node_modules/@requestport/db"));
    symlinkSync(second, join(consumer, "node_modules/@requestport/db"));
    const problems = installedProblems(installedCopies(consumer, names), {
      consumer,
      tarballs: [...tarballs, { name: "@requestport/jobs", version: VERSION }],
      direct: [...direct, "@requestport/auth"],
    });
    for (const expected of [
      "node_modules/.pnpm holds 2 copies of @requestport/domain, not one",
      `@requestport/domain is installed at 0.0.0-other, not the build record's ${VERSION}`,
      "node_modules/.pnpm holds 0 copies of @requestport/jobs, not one",
      "node_modules/@requestport/auth is not there",
      "node_modules/@requestport/db is ",
    ]) {
      assert.ok(
        problems.some((problem) => problem.startsWith(expected)),
        `${expected}: ${JSON.stringify(problems, null, 2)}`,
      );
    }
  });
});

/**
 * A planted tarball of `@requestport/<key>`'s files: two of its own modules
 * (for `config` and `jobs`, two G.8 accepts, not their roots' or
 * env-parsing ones) in each of its JavaScript and its declarations, and an
 * import of `domain`'s `.` in each (none in `domain`'s own).
 */
function plantedEntries(key = "core") {
  const name = `@requestport/${key}`;
  const [first, second] = {
    config: ["logger", "redaction"],
    jobs: ["catalogue", "dispatch"],
  }[key] ?? ["index", "other"];
  const imports =
    key === "domain"
      ? ""
      : 'import { DomainError } from "@requestport/domain";\n';
  return new Map([
    [
      "package/package.json",
      Buffer.from(
        `${JSON.stringify({ name, exports: { ".": { import: "./dist/index.js" } } })}\n`,
      ),
    ],
    [
      "package/dist/index.js",
      Buffer.from(
        `${imports}// packages/${key}/src/${first}.ts\nexport const a = 1;\n// packages/${key}/src/${second}.ts\nexport const b = 2;\n`,
      ),
    ],
    [
      "package/dist/index.d.ts",
      Buffer.from(
        `${imports}//#region packages/${key}/src/${first}.d.ts\ndeclare const a: number;\n//#endregion\n//#region packages/${key}/src/${second}.d.ts\ndeclare const b: number;\n//#endregion\n`,
      ),
    ],
  ]);
}

/** Each package's packed `exports` keys as `exportedSubpaths` reads them, for the planted runs. */
const PLANTED_EXPORTS = new Map([
  ...S8.map((name) => [name, ["."]]),
  ["@requestport/db", [".", "./migrate", "./wiring"]],
  [
    "@requestport/config",
    ["./logger", "./server", "./server-deferred", "./sign-in-methods"],
  ],
  ["@requestport/core", [".", "./adapters", "./agent-services", "./migrate"]],
  ["@requestport/auth", ["./auth-handler", "./create-auth"]],
  ["@requestport/mcp", ["."]],
  ["@requestport/server", ["."]],
]);

describe("the set: S8, and auth, mcp and server (rulings 175 and 190)", () => {
  test("S8 is bundle.mjs's packageSet, in its order, HOST its hostPackages, which are every other row of PACKAGES, and PACKED the two in G.7's order; the consumer depends on core, db, auth and server, of which server installs mcp", () => {
    assert.deepEqual(S8, packageSet);
    assert.deepEqual(HOST, hostPackages);
    assert.deepEqual(HOST, [
      "@requestport/auth",
      "@requestport/mcp",
      "@requestport/server",
    ]);
    assert.deepEqual(
      Object.values(PACKAGES)
        .map(({ bundle }) => bundle.package)
        .filter((name) => !S8.includes(name)),
      HOST,
    );
    assert.deepEqual(
      PACKED,
      Object.values(PACKAGES).map(({ bundle }) => bundle.package),
    );
    assert.deepEqual(CONSUMER_DEPENDENCIES, [
      "@requestport/core",
      "@requestport/db",
      "@requestport/auth",
      "@requestport/server",
    ]);
  });

  test("step 1 accepts a run of each of them once (the control), and reports one missing, one packed twice, and a package of neither", () => {
    const names = [...PACKED];
    assert.deepEqual(packSetProblems(names), []);
    assert.deepEqual(
      packSetProblems([
        ...names.filter((name) => name !== "@requestport/config"),
        "@requestport/db",
        "@requestport/theme",
      ]),
      [
        "the pack holds 0 tarballs of @requestport/config, not one",
        "the pack holds 2 tarballs of @requestport/db, not one",
        "the pack holds @requestport/theme, which is neither of S8 nor of HOST",
      ],
    );
  });
});

describe("step 2: G.8's own module-comment and specifier refusals (ruling 152)", () => {
  test("a planted tarball whose comments name only its own package's src/ modules has nothing refused, and its comments and specifiers are counted (the control)", () => {
    assert.deepEqual(
      tarballProblems(plantedEntries(), "@requestport/core", PLANTED_EXPORTS),
      {
        problems: [],
        counted: { javascript: 2, declarations: 2, specifiers: 2 },
      },
    );
    assert.deepEqual(
      moduleOwner("packages/config/src/logger.ts"),
      "@requestport/config",
    );
  });

  test("a module comment naming a test file is refused, in the JavaScript and in the declarations", () => {
    for (const plant of [
      { module: "packages/core/src/client.test.ts" },
      { module: "packages/core/src/client.integration.test.ts" },
      { module: "packages/core/src/client.test.d.ts", declaration: true },
    ]) {
      const { problems } = moduleCommentProblems(
        plantModule(plantedEntries(), plant),
        "@requestport/core",
      );
      assert.deepEqual(
        problems,
        [
          `package/dist/index.${plant.declaration ? "d.ts" : "js"} inlines ${plant.module}, which is a test`,
        ],
        plant.module,
      );
    }
  });

  test("a module of another package is refused, in the JavaScript and in the declarations: core's ./adapters in server's tarball among them, which server imports rather than inlines (ruling 193 item 1)", () => {
    const refused = (key, plant) =>
      moduleCommentProblems(
        plantModule(plantedEntries(key), plant),
        `@requestport/${key}`,
      ).problems;
    assert.deepEqual(refused("core", { module: "packages/db/src/client.ts" }), [
      "package/dist/index.js inlines packages/db/src/client.ts, a module of @requestport/db, not of @requestport/core",
    ]);
    assert.deepEqual(
      refused("core", {
        module: "packages/domain/src/index.d.ts",
        declaration: true,
      }),
      [
        "package/dist/index.d.ts inlines packages/domain/src/index.d.ts, a module of @requestport/domain, not of @requestport/core",
      ],
    );
    for (const declaration of [false, true]) {
      const module = declaration
        ? "packages/core/src/adapters.d.ts"
        : "packages/core/src/adapters.ts";
      assert.deepEqual(
        refused("server", { module, declaration }),
        [
          `package/dist/index.${declaration ? "d.ts" : "js"} inlines ${module}, a module of @requestport/core, not of @requestport/server`,
        ],
        module,
      );
      assert.deepEqual(refused("core", { module, declaration }), [], module);
    }
  });

  test("the specifiers are read in their import shapes, from, import, import() and require, in code or in a comment's example, and not from prose that names a package otherwise", () => {
    const entries = new Map([
      [
        "package/dist/index.js",
        Buffer.from(
          [
            'import { a } from "@requestport/db";',
            "import {",
            "  b",
            "} from '@requestport/domain';",
            'import "@requestport/webhooks";',
            'const c = await import("@requestport/jobs/worker");',
            'const d = require("@requestport/importer");',
            'export * from "@requestport/notifications/slack";',
            '// see "@requestport/db/wiring", which the roots import',
            'const e = "imports @requestport/config/server at import";',
          ].join("\n"),
        ),
      ],
      [
        "package/dist/index.d.ts",
        Buffer.from(
          [
            'import type { F } from "@requestport/db/migrate";',
            'type G = import("@requestport/core").G;',
            ' * as `import { createStorage } from "@requestport/db"` reads',
          ].join("\n"),
        ),
      ],
      ["package/README.md", Buffer.from('import "@requestport/theme";\n')],
    ]);
    assert.deepEqual(importedSpecifiers(entries), [
      { file: "package/dist/index.d.ts", specifier: "@requestport/core" },
      { file: "package/dist/index.d.ts", specifier: "@requestport/db" },
      { file: "package/dist/index.d.ts", specifier: "@requestport/db/migrate" },
      { file: "package/dist/index.js", specifier: "@requestport/db" },
      { file: "package/dist/index.js", specifier: "@requestport/domain" },
      { file: "package/dist/index.js", specifier: "@requestport/importer" },
      { file: "package/dist/index.js", specifier: "@requestport/jobs/worker" },
      {
        file: "package/dist/index.js",
        specifier: "@requestport/notifications/slack",
      },
      { file: "package/dist/index.js", specifier: "@requestport/webhooks" },
    ]);
  });

  test("a specifier must name a package of the run and a subpath its packed manifest exports, and a package of S8 must import nothing of HOST, whose packages may import S8's", () => {
    const entries = (lines) =>
      new Map([["package/dist/index.js", Buffer.from(lines.join("\n"))]]);
    assert.deepEqual(
      specifierProblems(
        entries([
          'import { a } from "@requestport/db/migrate";',
          'import { b } from "@requestport/config/logger";',
        ]),
        "@requestport/core",
        PLANTED_EXPORTS,
      ),
      [],
    );
    assert.deepEqual(
      specifierProblems(
        entries([
          'import "@requestport/db/testing";',
          'import "@requestport/config";',
          'import "@requestport/theme";',
          'import "@requestport/auth/create-auth";',
        ]),
        "@requestport/core",
        PLANTED_EXPORTS,
      ),
      [
        "package/dist/index.js imports @requestport/auth/create-auth, of @requestport/auth, which no package of S8 may import",
        "package/dist/index.js imports @requestport/config, which @requestport/config's packed manifest does not export",
        "package/dist/index.js imports @requestport/db/testing, which @requestport/db's packed manifest does not export",
        "package/dist/index.js imports @requestport/theme, and the run packs no @requestport/theme",
      ],
    );
    assert.deepEqual(
      specifierProblems(
        entries(['import { createAuth } from "@requestport/core";']),
        "@requestport/auth",
        PLANTED_EXPORTS,
      ),
      [],
    );
    assert.deepEqual(
      exportedSubpaths([plantedEntries("db"), plantedEntries("core")]),
      new Map([
        ["@requestport/db", ["."]],
        ["@requestport/core", ["."]],
      ]),
    );
  });

  test("each of MODULE_PLANTS but a package's own published modules, and each of tarballPlants, is refused in a planted tarball of every package of the pack: test support, the ledger, the roots' modules, config's env-parsing modules, jobs' bin/, a module outside packages, two declaration regions, two other packages' modules in each kind of file, three specifiers, and for a package of S8 a fourth, auth's, of HOST", () => {
    assert.equal(MODULE_PLANTS.length, 18);
    for (const name of PACKED) {
      const own = OWN_PUBLISHED_MODULES[name] ?? [];
      assert.deepEqual(
        MODULE_PLANTS.filter(
          (plant) => !modulePlants(name).includes(plant),
        ).map(({ module }) => module.replace(/\.d\.ts$/u, ".ts")),
        MODULE_PLANTS.map(({ module }) =>
          module.replace(/\.d\.ts$/u, ".ts"),
        ).filter((module) => own.includes(module)),
        name,
      );
      const key = name.split("/")[1];
      assert.equal(
        tarballPlants(name).length,
        HOST.includes(name) ? 7 : 8,
        name,
      );
      assert.deepEqual(
        tarballProblems(plantedEntries(key), name, PLANTED_EXPORTS).problems,
        [],
        name,
      );
      assert.deepEqual(
        unrefusedModulePlants(plantedEntries(key), name, PLANTED_EXPORTS),
        [],
        name,
      );
    }
    // The ownership plants name a module of another package for each.
    for (const name of PACKED) {
      for (const { module } of tarballPlants(name).filter(
        ({ module }) => module !== undefined,
      )) {
        assert.notEqual(moduleOwner(module), name, `${name}: ${module}`);
      }
    }
  });

  test("by its own criterion it refuses the roots' modules and config's env-parsing modules by path, and also a config module it does not know, a .spec and a .test.mts module, and a module outside a package's src/; of them it accepts the ones ruling 193 item 1 publishes in their own package's tarball alone, and db's testing.ts in none", () => {
    assert.deepEqual(OWN_PUBLISHED_MODULES, {
      "@requestport/config": [
        "packages/config/src/server-deferred.ts",
        "packages/config/src/server-schema.ts",
        "packages/config/src/server.ts",
      ],
      "@requestport/db": ["packages/db/src/wiring.ts"],
      "@requestport/jobs": [
        "packages/jobs/src/cli.ts",
        "packages/jobs/src/index.ts",
        "packages/jobs/src/worker-root.ts",
      ],
    });
    for (const [owner, modules] of Object.entries(OWN_PUBLISHED_MODULES)) {
      for (const module of modules) {
        assert.equal(smokeModuleRefusal(module, owner), undefined, module);
        assert.equal(
          smokeModuleRefusal(module.replace(/\.ts$/u, ".d.ts"), owner),
          undefined,
          module,
        );
        for (const other of PACKED.filter((name) => name !== owner)) {
          assert.ok(
            smokeModuleRefusal(module, other) !== undefined,
            `${module} in ${other}`,
          );
        }
      }
    }
    assert.ok(
      smokeModuleRefusal(
        "packages/db/src/testing.ts",
        "@requestport/db",
      )?.startsWith("is a root's module"),
    );
    assert.ok(
      smokeModuleRefusal(
        "packages/config/src/index.ts",
        "@requestport/config",
      )?.startsWith("is a config module"),
    );
    for (const [module, reason] of [
      ["packages/db/src/wiring.ts", "is a root's module"],
      ["packages/db/src/testing.ts", "is a root's module"],
      ["packages/jobs/src/worker-root.ts", "is a root's module"],
      ["packages/jobs/src/index.ts", "is a root's module"],
      ["packages/jobs/src/cli.ts", "is a root's module"],
      ["packages/config/src/index.ts", "is a config module"],
      ["packages/config/src/server.ts", "is a config module"],
      ["packages/config/src/client.ts", "is a config module"],
      ["packages/config/src/server-deferred.ts", "is a config module"],
      ["packages/config/src/server-schema.ts", "is a config module"],
      ["packages/config/src/a-new-reader.ts", "is a config module"],
      ["packages/db/src/client.spec.ts", "is a test"],
      ["packages/db/src/client.test.mts", "is a test"],
      ["packages/db/scripts/seed.ts", "is not a module of a package's src/"],
    ]) {
      assert.ok(smokeModuleRefusal(module)?.startsWith(reason), module);
    }
  });

  test("the script names neither bundle.mjs's forbiddenModule nor its testOnlyModule, so a module removed from that list is still refused here (ruling 152)", () => {
    const source = readFileSync(
      new URL("./core-tarball-smoke.mjs", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("forbiddenModule"), false);
    assert.equal(source.includes("testOnlyModule"), false);
  });

  test("a tarball with no module comment in its JavaScript, or none in its declarations, is refused: the check would see nothing", () => {
    const entries = new Map([["package/package.json", Buffer.from("{}\n")]]);
    assert.deepEqual(
      moduleCommentProblems(entries, "@requestport/core").problems,
      [
        "no module comment in its JavaScript: the check would see nothing",
        "no module comment in its declarations: the check would see nothing",
      ],
    );
  });
});

/**
 * A directory `pack-packages.mjs` would write, planted: a build record, and a
 * tarball and a staged manifest for each row of its `PACKAGES`, which
 * `reusePack` reads, in its order.
 */
function plantedPack(root, { tamper } = {}) {
  const tarballs = [];
  for (const name of Object.keys(PACKAGES)) {
    mkdirSync(join(root, "stage", name), { recursive: true });
    writeFileSync(
      join(root, "stage", name, "package.json"),
      `${JSON.stringify({ name: `@requestport/${name}`, version: VERSION })}\n`,
    );
    const file = `requestport-${name}-${VERSION}.tgz`;
    const bytes = Buffer.from(`a planted ${name} tarball\n`);
    writeFileSync(join(root, file), bytes);
    tarballs.push({
      file,
      name: `@requestport/${name}`,
      version: VERSION,
      integrity: integrityOf(bytes),
      size: bytes.length,
      files: 1,
    });
  }
  tamper?.(tarballs);
  writeFileSync(
    join(root, "build-record.json"),
    `${JSON.stringify({ commit: "0".repeat(40), treeStatus: "", tarballs })}\n`,
  );
  return root;
}

describe("step 1: --from <pack directory>", () => {
  test("a pack whose tarballs match the build record is reused, each with its staged manifest and the staged directory's files as the allow-list (the control)", () => {
    const { record, packs } = reusePack(
      plantedPack(join(scratch, "from-control")),
    );
    assert.equal(record.tarballs.length, 11);
    assert.deepEqual(
      packs.map(({ staged }) => [staged.manifest.name, staged.allowList]),
      [
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
      ].map((name) => [`@requestport/${name}`, ["package.json"]]),
    );
  });

  test("a tarball whose bytes differ from the build record's integrity is refused", () => {
    const root = plantedPack(join(scratch, "from-bytes"));
    writeFileSync(join(root, `requestport-auth-${VERSION}.tgz`), "tampered\n");
    assert.throws(
      () => reusePack(root),
      new RegExp(
        `requestport-auth-${VERSION.replaceAll(".", "\\.")}\\.tgz's integrity is sha512-\\S+, not the build record's`,
        "u",
      ),
    );
  });

  test("a tarball whose size differs from the build record's is refused", () => {
    const root = plantedPack(join(scratch, "from-size"), {
      tamper: (tarballs) => {
        tarballs[0].size += 1;
      },
    });
    assert.throws(
      () => reusePack(root),
      /is \d+ bytes, not the build record's \d+/u,
    );
  });

  test("a staged directory with no package.json is refused", () => {
    const root = plantedPack(join(scratch, "from-stage"));
    rmSync(join(root, "stage", "auth"), { recursive: true });
    assert.throws(() => reusePack(root), /stage\/auth holds no package\.json/u);
  });
});

describe("step 3: the consumer", () => {
  test("a node_modules or an .npmrc above the consumer is found, under the path as given and under its real path", () => {
    // `<root>/side/link` is a link to `<root>/top/a/b`: `side/` is above the
    // path as given only, and `top/` and `top/a/` above the real path only.
    const root = join(scratch, "above");
    const real = join(root, "top", "a", "b");
    mkdirSync(join(real, "consumer"), { recursive: true });
    mkdirSync(join(root, "side"));
    mkdirSync(join(root, "top", "node_modules"));
    writeFileSync(join(root, "top", "a", ".npmrc"), "registry=planted\n");
    writeFileSync(join(root, "side", ".npmrc"), "registry=planted\n");
    symlinkSync(real, join(root, "side", "link"));
    const found = ancestorsHolding(join(root, "side", "link", "consumer"), [
      "node_modules",
      ".npmrc",
    ]);
    const top = join(realpathSync(root), "top");
    for (const expected of [
      join(root, "side", ".npmrc"),
      join(top, "node_modules"),
      join(top, "a", ".npmrc"),
    ]) {
      assert.ok(
        found.includes(expected),
        `${expected}: ${JSON.stringify(found)}`,
      );
    }
  });

  test("its package.json depends on CONSUMER_DEPENDENCIES alone, each as file:<absolute path>, with step 5's devDependencies as handed, and its pnpm-workspace.yaml overrides each package of PACKED, in its order, to its tarball; a package of either the pack lacks is refused", () => {
    const tarballs = PACKED.map((name) => ({
      name,
      path: `/planted/pack/${name.split("/")[1]}.tgz`,
    }));
    const devDependencies = { typescript: "7.0.2", "@types/node": "22.20.1" };
    const files = consumerFiles(tarballs, devDependencies);
    assert.deepEqual(JSON.parse(files["package.json"]).dependencies, {
      "@requestport/core": "file:/planted/pack/core.tgz",
      "@requestport/db": "file:/planted/pack/db.tgz",
      "@requestport/auth": "file:/planted/pack/auth.tgz",
      "@requestport/server": "file:/planted/pack/server.tgz",
    });
    assert.deepEqual(
      JSON.parse(files["package.json"]).devDependencies,
      devDependencies,
    );
    assert.equal(
      files["pnpm-workspace.yaml"],
      [
        "overrides:",
        ...PACKED.map(
          (name) =>
            `  "${name}": "file:/planted/pack/${name.split("/")[1]}.tgz"`,
        ),
        "",
      ].join("\n"),
    );
    for (const name of ["@requestport/jobs", "@requestport/mcp"]) {
      assert.throws(
        () =>
          consumerFiles(
            tarballs.filter((tarball) => tarball.name !== name),
            devDependencies,
          ),
        new RegExp(`the pack holds no ${name.replace("/", "\\/")}\\.`, "u"),
      );
    }
  });

  test("a @requestport/* name a packed manifest names that no override maps is reported, with the packages naming it: a package outside the pack; the pack's own names are not, HOST's among them (the control)", () => {
    const manifests = [
      {
        name: "@requestport/core",
        dependencies: { "@requestport/db": VERSION, zod: "4.4.3" },
      },
      {
        name: "@requestport/server",
        dependencies: {
          "@requestport/auth": VERSION,
          "@requestport/core": VERSION,
          "@requestport/mcp": VERSION,
        },
      },
    ];
    assert.deepEqual(unoverriddenNames(manifests), []);
    assert.deepEqual(
      unoverriddenNames([
        ...manifests,
        {
          name: "@requestport/jobs",
          peerDependencies: { "@requestport/theme": VERSION },
        },
        {
          name: "@requestport/db",
          optionalDependencies: { "@requestport/theme": "1.0.2" },
          dependencies: { "@requestport/notifier": VERSION },
        },
      ]),
      [
        "@requestport/notifier (named by @requestport/db)",
        "@requestport/theme (named by @requestport/db, @requestport/jobs)",
      ],
    );
  });
});

describe("step 4: the cold install's runner", () => {
  test("the environment is PATH (this Node's directory, /usr/bin, /bin), the HOME it is handed and pnpm's update notice off, with TMPDIR only when this process has one, and nothing else of this process's", () => {
    const PATH = [dirname(process.execPath), "/usr/bin", "/bin"].join(
      delimiter,
    );
    assert.deepEqual(installEnvironment("/planted/home", {}), {
      PATH,
      HOME: "/planted/home",
      pnpm_config_update_notifier: "false",
    });
    assert.deepEqual(
      installEnvironment("/planted/home", {
        TMPDIR: "/planted/tmp",
        HOME: "/Users/someone",
        npm_config_registry: "https://planted.invalid/",
      }),
      {
        PATH,
        HOME: "/planted/home",
        pnpm_config_update_notifier: "false",
        TMPDIR: "/planted/tmp",
      },
    );
  });

  test("the pnpm is the root's packageManager pin, by its path in corepack's cache", () => {
    const { packageManager } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const version = packageManager.replace(/^pnpm@/u, "").split("+")[0];
    assert.deepEqual(
      pinnedPnpm(undefined, { COREPACK_HOME: "/planted/corepack" }),
      {
        version,
        path: `/planted/corepack/v1/pnpm/${version}/bin/pnpm.cjs`,
      },
    );
  });
});

/** Files as pnpm lays a consumer out, each planted, and the fixture's directory for the plant. */
const CONSUMER_FILES = Object.freeze({
  drizzle:
    "node_modules/.pnpm/drizzle-orm@0.45.2_pg@8.23.0/node_modules/drizzle-orm/gel-core/columns/duration.d.ts",
  betterAuthCore:
    "node_modules/.pnpm/@better-auth+core@1.7.6_bee2c9b8/node_modules/@better-auth/core/dist/types/init-options.d.mts",
  requestport:
    "node_modules/.pnpm/@requestport+core@file+..+pack+requestport-core-1.0.0.tgz_kysely@0.29.6/node_modules/@requestport/core/dist/index.d.ts",
  thirdPartySource:
    "node_modules/.pnpm/drizzle-orm@0.45.2_pg@8.23.0/node_modules/drizzle-orm/index.ts",
  own: "consumer.ts",
  plant: "plant/consumer.ts",
});

function plantedConsumer(consumer) {
  for (const file of Object.values(CONSUMER_FILES)) {
    mkdirSync(dirname(join(consumer, file)), { recursive: true });
    writeFileSync(join(consumer, file), "export {};\n");
  }
  return consumer;
}

/** One line of `tsc --pretty false`'s report. */
function tscError(
  file,
  code = "TS2307",
  message = "Cannot find module 'gel' or its corresponding type declarations.",
) {
  return `${file}(1,35): error ${code}: ${message}`;
}

/** A source's string literals between `start` and the next `end`, comment lines left out. */
function quotedBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${start} is not in the source`);
  const block = source.slice(from + start.length, source.indexOf(end, from));
  return block
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .flatMap((line) =>
      [...line.matchAll(/"([^"]+)"/gu)].map(([, text]) => text),
    );
}

describe("step 5: the type check (ruling 150)", () => {
  const consumer = plantedConsumer(join(scratch, "type-check", "consumer"));
  const third = { cwd: consumer, consumer, skipLibCheck: false };

  test("tsc's report is read: an error with a file and one without, an error's indented lines, and every other line returned unread", () => {
    const { diagnostics, unread } = parseTscReport(
      [
        tscError("a.d.ts"),
        "  Type '\"config\"' is not assignable to type 'keyof this'.",
        "error TS2318: Cannot find global type 'Array'.",
        "Found 2 errors.",
        "  an indented line below one the reader cannot read",
        "",
      ].join("\n"),
    );
    assert.deepEqual(
      diagnostics.map(({ file, line, column, code }) => [
        file,
        line,
        column,
        code,
      ]),
      [
        ["a.d.ts", 1, 35, "TS2307"],
        [null, null, null, "TS2318"],
      ],
    );
    assert.equal(
      diagnostics[0].message,
      "Cannot find module 'gel' or its corresponding type declarations.\n  Type '\"config\"' is not assignable to type 'keyof this'.",
    );
    assert.deepEqual(unread, [
      "Found 2 errors.",
      "  an indented line below one the reader cannot read",
    ]);
  });

  test("with skipLibCheck false, errors in third-party declarations alone pass, each counted by package, version and code (the control)", () => {
    const run = {
      status: 1,
      signal: null,
      output: [
        tscError(CONSUMER_FILES.drizzle),
        tscError(CONSUMER_FILES.drizzle, "TS2515", "Non-abstract class."),
        tscError(
          CONSUMER_FILES.betterAuthCore,
          "TS2307",
          "Cannot find module 'bun:sqlite' or its corresponding type declarations.",
        ),
      ].join("\n"),
    };
    assert.deepEqual(typeCheckProblems(run, third), {
      problems: [],
      errors: 3,
      byPackage: {
        "drizzle-orm@0.45.2": { errors: 2, codes: { TS2307: 1, TS2515: 1 } },
        "@better-auth/core@1.7.6": { errors: 1, codes: { TS2307: 1 } },
      },
    });
  });

  test("with skipLibCheck true, an exit 0 with an empty report passes (the control), and every error is a problem, one in a third-party declaration included", () => {
    const options = { ...third, skipLibCheck: true };
    assert.deepEqual(
      typeCheckProblems({ status: 0, signal: null, output: "" }, options),
      { problems: [], errors: 0, byPackage: {} },
    );
    const { problems } = typeCheckProblems(
      { status: 1, signal: null, output: tscError(CONSUMER_FILES.drizzle) },
      options,
    );
    assert.deepEqual(problems, [
      `with skipLibCheck true: ${tscError(CONSUMER_FILES.drizzle)}`,
    ]);
  });

  test("with skipLibCheck false, an error outside third-party declarations is reported: the consumer's own, an @requestport/* declaration's, a third-party source file's, one in no file, and one in a file that is not there", () => {
    for (const [line, expected] of [
      [tscError("consumer.ts"), "consumer.ts is not in a package under"],
      [tscError(CONSUMER_FILES.requestport), "is in an @requestport/* package"],
      [
        tscError(CONSUMER_FILES.thirdPartySource),
        "drizzle-orm/index.ts is not a declaration file",
      ],
      [
        "error TS2318: Cannot find global type 'Array'.",
        "an error in no file: error TS2318",
      ],
      [
        tscError("node_modules/.pnpm/zod@4.4.3/node_modules/zod/gone.d.ts"),
        "an error in a file that is not there",
      ],
    ]) {
      const { problems } = typeCheckProblems(
        { status: 1, signal: null, output: line },
        third,
      );
      assert.equal(problems.length, 1, `${line}: ${JSON.stringify(problems)}`);
      assert.ok(problems[0].includes(expected), `${expected}: ${problems[0]}`);
    }
  });

  test("a line the reader cannot read, an exit other than 0 with no error read, and a run that did not exit are reported", () => {
    for (const [run, expected] of [
      [
        { status: 0, signal: null, output: "Found 0 errors." },
        "tsc wrote a line the check cannot read: Found 0 errors.",
      ],
      [
        { status: 2, signal: null, output: "" },
        "tsc exited 2 and reported no error the check can read",
      ],
      [
        { status: null, signal: "SIGKILL", output: "" },
        "tsc did not exit: SIGKILL",
      ],
    ]) {
      for (const skipLibCheck of [true, false]) {
        assert.deepEqual(
          typeCheckProblems(run, { ...third, skipLibCheck }).problems,
          [expected],
        );
      }
    }
  });

  test("a path tsc reports is read from its directory under its real path and under its path as given: from plant/ through a symbolic link, a third-party declaration is counted either way", () => {
    // `<root>/link` is a link to `<root>/a/b`, a level deeper: a path that
    // climbs to `<root>` resolves from one spelling of tsc's directory only.
    const root = join(realpathSync(scratch), "type-check-linked");
    const real = join(root, "a", "b");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(root, "link"));
    const given = join(root, "link", "consumer");
    plantedConsumer(join(real, "consumer"));
    const plant = { from: join(real, "consumer", "plant") };
    plant.given = join(given, "plant");
    for (const file of [
      relative(plant.from, join(given, CONSUMER_FILES.drizzle)),
      relative(plant.given, join(real, "consumer", CONSUMER_FILES.drizzle)),
    ]) {
      assert.match(file, /^\.\.\/\.\.\/\.\.\//u);
      assert.deepEqual(
        typeCheckProblems(
          { status: 1, signal: null, output: tscError(file) },
          { cwd: plant.given, consumer: given, skipLibCheck: false },
        ),
        {
          problems: [],
          errors: 1,
          byPackage: {
            "drizzle-orm@0.45.2": { errors: 1, codes: { TS2307: 1 } },
          },
        },
        file,
      );
    }
  });

  test("a third-party declaration's version is read from pnpm's directory only where that directory is named for the package", () => {
    assert.deepEqual(thirdPartyDeclaration(CONSUMER_FILES.betterAuthCore), {
      name: "@better-auth/core",
      version: "1.7.6",
    });
    assert.deepEqual(
      thirdPartyDeclaration(
        "node_modules/.pnpm/better-auth@1.7.6_x/node_modules/@better-auth/core/a.d.ts",
      ),
      { name: "@better-auth/core", version: undefined },
    );
  });

  test("the plant, an import of a name core's . does not export above the fixture, is reported as TS2305 naming it, by the rule of either run", () => {
    assert.equal(
      plantImport("export {};\n"),
      `import { ${PLANTED_IMPORT} } from "@requestport/core";\nexport {};\n`,
    );
    const output = `consumer.ts(1,10): error TS2305: Module '"@requestport/core"' has no exported member '${PLANTED_IMPORT}'.`;
    for (const skipLibCheck of [true, false]) {
      const { problems } = typeCheckProblems(
        { status: 1, signal: null, output },
        { cwd: join(consumer, "plant"), consumer, skipLibCheck },
      );
      assert.equal(plantReported(problems), true, JSON.stringify(problems));
    }
    assert.equal(
      plantReported([
        `with skipLibCheck true: consumer.ts(1,10): error TS2305: Module '"@requestport/core"' has no exported member 'another'.`,
        `with skipLibCheck true: consumer.ts(1,10): error TS2724: '"@requestport/core"' has no exported member named '${PLANTED_IMPORT}'.`,
      ]),
      false,
    );
  });

  test("each run is tsc -p tsconfig.json --noEmit --pretty false, with skipLibCheck given", () => {
    for (const skipLibCheck of [true, false]) {
      assert.deepEqual(tscArguments(skipLibCheck), [
        "-p",
        "tsconfig.json",
        "--noEmit",
        "--pretty",
        "false",
        "--skipLibCheck",
        String(skipLibCheck),
      ]);
    }
  });

  test("the consumer's devDependencies are typescript and @types/node at the root's exact versions; a range or a missing pin is refused", () => {
    assert.deepEqual(TYPE_CHECK_PACKAGES, ["typescript", "@types/node"]);
    const root = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(consumerDevDependencies(), {
      typescript: root.devDependencies.typescript,
      "@types/node": root.devDependencies["@types/node"],
    });
    assert.throws(
      () =>
        consumerDevDependencies({
          devDependencies: { typescript: "^7.0.2", "@types/node": "22.20.1" },
        }),
      /the root pins typescript at "\^7\.0\.2", not an exact version/u,
    );
    assert.throws(
      () =>
        consumerDevDependencies({ devDependencies: { typescript: "7.0.2" } }),
      /the root pins @types\/node at undefined, not an exact version/u,
    );
  });

  test("the consumer's installed tsc is typescript's bin.tsc, and a typescript or @types/node at another version than the one declared is reported", () => {
    const declared = { typescript: "7.0.2", "@types/node": "22.20.1" };
    const tools = join(scratch, "tools", "consumer");
    const installed = (name, version, extra = {}) => {
      const directory = join(tools, "node_modules", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name, version, ...extra }),
      );
    };
    installed("typescript", "7.0.2", { bin: { tsc: "./bin/tsc" } });
    installed("@types/node", "22.20.1");
    assert.deepEqual(consumerTypeCheckTools(tools, declared), {
      tsc: {
        version: "7.0.2",
        path: join(tools, "node_modules", "typescript", "bin", "tsc"),
      },
      typesNode: "22.20.1",
      problems: [],
    });
    installed("typescript", "7.0.1", { bin: { tsc: "./bin/tsc" } });
    installed("@types/node", "22.20.0");
    assert.deepEqual(consumerTypeCheckTools(tools, declared).problems, [
      "the consumer's typescript is 7.0.1, not 7.0.2",
      "the consumer's @types/node is 22.20.0, not 22.20.1",
    ]);
    installed("typescript", "7.0.2");
    assert.throws(
      () => consumerTypeCheckTools(tools, declared),
      /names no tsc bin/u,
    );
  });

  test("the fixture's tsconfig is strict, nodenext, types [node], noEmit, skipLibCheck true, verbatimModuleSyntax and erasableSyntaxOnly, over consumer.ts alone", () => {
    assert.deepEqual(FIXTURE.files, ["consumer.ts", "tsconfig.json"]);
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(FIXTURE.directory, "tsconfig.json"), "utf8"),
      ),
      {
        compilerOptions: {
          target: "es2023",
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
          verbatimModuleSyntax: true,
          erasableSyntaxOnly: true,
        },
        files: ["consumer.ts"],
      },
    );
  });

  test("the fixture imports node: builtins and the tarballs' exported entries alone: core's . and ./migrate, db's . and ./migrate, and auth's ./create-auth", () => {
    const source = readFileSync(join(FIXTURE.directory, "consumer.ts"), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(?\s*"([^"]+)"/gu),
    ].map(([, from, bare]) => from ?? bare);
    assert.deepEqual(
      [
        ...new Set(specifiers.filter((name) => !name.startsWith("node:"))),
      ].sort(),
      [
        "@requestport/auth/create-auth",
        "@requestport/core",
        "@requestport/core/migrate",
        "@requestport/db",
        "@requestport/db/migrate",
      ],
    );
    // createStorage and migrate come from db's entries (manifest-g.md §4
    // step 6 under S8), and core's are read only by the identity case.
    assert.match(
      source,
      /^import \{ createStorage, type Storage \} from "@requestport\/db";$/mu,
    );
    assert.match(
      source,
      /^import \{ migrate \} from "@requestport\/db\/migrate";$/mu,
    );
  });

  test("the fixture's HUMAN_SCOPES are the 22 of humanScopes in packages/core/src/command-bus.ts, in its order", () => {
    const core = quotedBetween(
      readFileSync(
        new URL("../packages/core/src/command-bus.ts", import.meta.url),
        "utf8",
      ),
      "export const humanScopes = new Set([",
      "]);",
    );
    const fixture = quotedBetween(
      readFileSync(join(FIXTURE.directory, "consumer.ts"), "utf8"),
      "export const HUMAN_SCOPES: readonly string[] = [",
      "];",
    );
    assert.equal(core.length, 22);
    assert.deepEqual(fixture, core);
  });
});

/** `db`'s installed package, by its real path, as the smoke hands it to `runProblems`. */
const PLANTED_DB =
  "/planted/consumer/node_modules/.pnpm/@requestport+db@planted/node_modules/@requestport/db";

/**
 * A report as the fixture writes one for a run that passed: core's
 * re-exports `db`'s own, every module of `RULED_PRINCIPALS` once, under its
 * principal, with its effect read back, the three `DomainError`s of one
 * class, and the PGlite case refused in H.4's words, with Node's refusal of
 * the module it cannot find from a chunk of `db`'s as its cause.
 */
function plantedReport() {
  const domainError = (code) => ({
    name: "DomainError",
    code,
    message: `planted ${code}`,
    causes: [],
  });
  return {
    environment: ["HOME", "PATH", "TMPDIR", "__CF_USER_TEXT_ENCODING"],
    database: "rp_g8_smoke_planted",
    login: "rp_g8_smoke_planted_app",
    migrate: { applied: 22 },
    owner: { status: "owner_active", localCredential: "issued" },
    signIn: { session: true, userId: "planted-user" },
    fixture: { name: "G.8's captured snapshot" },
    capabilities: Object.entries(RULED_PRINCIPALS).map(
      ([module, principal]) => ({
        module,
        capability: `the planted capability of ${module}`,
        principal,
        through: "planted",
        result: {},
        readBack: {
          through: "a planted read",
          principal,
          found: true,
          row: {},
        },
      }),
    ),
    negative: {
      through: "planted",
      outcome: "failed",
      answered: null,
      error: {
        name: "Error",
        code: null,
        message: "Failed query: planted",
        causes: [{ name: "error", code: "42501", message: UNBOUND_MESSAGE }],
      },
      administrationRead: { outcome: "answered", detail: [] },
    },
    domainErrors: {
      core: domainError("forbidden"),
      agentServices: domainError("validation_failed"),
      auth: domainError("unauthenticated"),
      coreSameClassAsAgentServices: true,
      coreSameClassAsAuth: true,
      authInstanceOfCoreClass: true,
      coreInstanceOfAuthClass: true,
    },
    close: { readings: [0], sessions: 0 },
    dropped: { database: true, login: true, forced: false },
    pglite: {
      dataDir: "memory://",
      outcome: "threw",
      error: {
        name: "Error",
        code: "MODULE_NOT_FOUND",
        message:
          "A PGlite storage needs @electric-sql/pglite, and it is not installed: Node found no such package from the module that loads it, which the error's requireStack names. Install @electric-sql/pglite where that module can find it (@requestport/db declares it as an optional peer dependency), or use a PostgreSQL server through the pg driver.",
        causes: [
          {
            name: "Error",
            code: "MODULE_NOT_FOUND",
            message: `Cannot find module '@electric-sql/pglite'\nRequire stack:\n- ${PLANTED_DB}/dist/chunk-PLANTED.js`,
          },
        ],
      },
      requireStack: [`${PLANTED_DB}/dist/chunk-PLANTED.js`],
      closeError: null,
    },
    identity: {
      shared: {
        ".": [
          "DatabaseSurfaceError",
          "createDatabaseRoleGuard",
          "createStorage",
          "createWorkerStorages",
        ],
        "./migrate": ["migrate"],
      },
      differing: { ".": [], "./migrate": [] },
    },
    error: null,
  };
}

describe("step 6: the run (Done when 8; ruling 153)", () => {
  const context = { database: "rp_g8_smoke_planted", db: PLANTED_DB };

  test("--database is a postgres: URL of this machine's loopback, with a user and a database and no query, and the record's spelling hides its password; anything else is refused", () => {
    assert.deepEqual(LOOPBACK_HOSTS, ["127.0.0.1", "localhost", "[::1]"]);
    assert.deepEqual(
      localServer("postgres://requestport:secret@127.0.0.1:55433/rp_planted"),
      {
        url: "postgres://requestport:secret@127.0.0.1:55433/rp_planted",
        redacted: "postgres://requestport:***@127.0.0.1:55433/rp_planted",
      },
    );
    assert.equal(
      localServer("postgresql://requestport@localhost/rp_planted").redacted,
      "postgresql://requestport@localhost/rp_planted",
    );
    assert.equal(
      localServer("postgres://requestport@[::1]:5432/rp_planted").url,
      "postgres://requestport@[::1]:5432/rp_planted",
    );
    for (const [text, why] of [
      ["not a url", "is not a URL"],
      ["mysql://requestport@127.0.0.1/rp_planted", "is a mysql: URL"],
      ["postgres://requestport@10.0.0.5/rp_planted", "names 10.0.0.5"],
      [
        "postgres://requestport@db.planted.invalid/rp_planted",
        "names db.planted.invalid",
      ],
      ["postgres://127.0.0.1/rp_planted", "names no user"],
      ["postgres://requestport@127.0.0.1/", "names no database"],
      [
        "postgres://requestport@127.0.0.1/rp_planted?sslmode=require",
        "carries a query",
      ],
    ]) {
      assert.throws(
        () => localServer(text),
        new RegExp(why.replace(/[.]/gu, "\\.")),
        text,
      );
    }
  });

  test("the consumer's environment is PATH (this Node's directory, /usr/bin, /bin) and the HOME it is handed, with TMPDIR only when this process has one, and nothing else of this process's", () => {
    const PATH = [dirname(process.execPath), "/usr/bin", "/bin"].join(
      delimiter,
    );
    assert.deepEqual(runEnvironment("/planted/home", {}), {
      PATH,
      HOME: "/planted/home",
    });
    assert.deepEqual(
      runEnvironment("/planted/home", {
        TMPDIR: "/planted/tmp",
        DATABASE_URL: "postgres://planted",
        PGHOST: "planted",
        REQUESTPORT_DATABASE_DRIVER: "pg",
        REQUESTPORT_APPLICATION_DATABASE_URL: "postgres://planted",
      }),
      { PATH, HOME: "/planted/home", TMPDIR: "/planted/tmp" },
    );
    assert.deepEqual(RUN_ENVIRONMENT_NAMES, [
      "HOME",
      "PATH",
      "TMPDIR",
      "__CF_USER_TEXT_ENCODING",
    ]);
  });

  test('a report with core\'s re-exports db\'s own, every module once under its ruled principal and read back, the "off" read failed with 42501, a DomainError of one class from each refusal, no session left, both dropped and the PGlite case refused in the words H.4 gives it has no problem (the control), and each of RUN_PLANTS is reported in a copy of it, in one whose "off" read answered, and in one whose PGlite case answered a storage', () => {
    const report = plantedReport();
    assert.deepEqual(runProblems(report, context), []);
    assert.equal(RUN_PLANTS.length, 20);
    assert.deepEqual(unreportedRunPlants(report, context), []);
    // The plants are written into the real report, which may already fail:
    // each must still be reported in one whose "off" read answered, and in
    // one whose PGlite case answered a storage.
    const answered = {
      ...report,
      negative: {
        ...report.negative,
        outcome: "answered",
        answered: [],
        error: null,
      },
    };
    assert.deepEqual(unreportedRunPlants(answered, context), []);
    const storage = {
      ...report,
      pglite: {
        ...report.pglite,
        outcome: "returned",
        error: null,
        requireStack: null,
      },
    };
    assert.deepEqual(unreportedRunPlants(storage, context), []);
  });

  test("what the plants leave out is reported too: no report, a database other than the run's, a variable in the environment, no migration, no owner, no sign-in, a module twice or outside the list, the \"off\" case not run or failing with another message, a missing DomainError, two DomainError classes, a re-export core and db do not share, and one that is not db's own", () => {
    assert.deepEqual(runProblems(null, context), [
      "the consumer wrote no report",
    ]);
    const cases = [
      [
        (report) => ({ ...report, database: "rp_other" }),
        "the report names the database rp_other, not rp_g8_smoke_planted",
      ],
      ...["DATABASE_URL", "REQUESTPORT_DATABASE_DRIVER", "PGPASSWORD"].map(
        (name) => [
          (report) => ({
            ...report,
            environment: [...report.environment, name],
          }),
          `the consumer's environment holds ${name}`,
        ],
      ),
      [
        (report) => ({ ...report, migrate: { applied: 0 } }),
        "migrate applied no migration to the fresh database",
      ],
      [
        (report) => ({
          ...report,
          owner: { status: "awaiting_authentication" },
        }),
        "bootstrapOwner answered",
      ],
      [
        (report) => ({ ...report, signIn: null }),
        "the person was not signed in",
      ],
      [
        (report) => ({
          ...report,
          capabilities: [...report.capabilities, report.capabilities[0]],
        }),
        `${plantedReport().capabilities[0].module}: 2 results, not 1`,
      ],
      [
        (report) => ({
          ...report,
          capabilities: [
            ...report.capabilities,
            { ...report.capabilities[0], module: "oauth/agent-consent" },
          ],
        }),
        "a result for oauth/agent-consent, which is not a module of the list",
      ],
      [
        (report) => ({ ...report, negative: null }),
        'the tenantBinding "off" case did not run',
      ],
      [
        (report) => ({
          ...report,
          negative: {
            ...report.negative,
            error: {
              ...report.negative.error,
              causes: [
                {
                  name: "error",
                  code: "42501",
                  message: "permission denied for table webhook_subscriptions",
                },
              ],
            },
          },
        }),
        "failed, but not with 42501",
      ],
      [
        (report) => ({
          ...report,
          domainErrors: {
            ...report.domainErrors,
            auth: { ...report.domainErrors.auth, name: "Error" },
          },
        }),
        "the auth refusal was no DomainError",
      ],
      [
        (report) => ({
          ...report,
          domainErrors: {
            ...report.domainErrors,
            coreSameClassAsAgentServices: false,
          },
        }),
        "the refusals' DomainError classes are not one, so @requestport/domain's code is loaded more than once: coreSameClassAsAgentServices not true",
      ],
      [
        (report) => ({
          ...report,
          identity: {
            ...report.identity,
            shared: {
              ...report.identity.shared,
              ".": report.identity.shared["."].filter(
                (name) => name !== "createWorkerStorages",
              ),
            },
          },
        }),
        "core's . and db's . share no createWorkerStorages, which core re-exports",
      ],
      [
        (report) => ({
          ...report,
          identity: {
            ...report.identity,
            differing: { ".": [], "./migrate": ["migrate"] },
          },
        }),
        "core's ./migrate exports migrate, and it is not db's own",
      ],
    ];
    for (const [change, words] of cases) {
      const problems = runProblems(change(plantedReport()), context);
      assert.ok(
        problems.some((problem) => problem.includes(words)),
        `${words}: ${JSON.stringify(problems)}`,
      );
    }
  });

  test("IDENTITY_REQUIRED is what core's sources re-export from db: the values of index.ts's export from @requestport/db, and migrate.ts's migrate; the fixture's identity case compares core's . and ./migrate with db's, before its PGlite case", () => {
    const source = (path) =>
      readFileSync(
        new URL(`../packages/core/src/${path}`, import.meta.url),
        "utf8",
      );
    const reexported = (text, specifier) => {
      const block = text.match(
        new RegExp(
          `export \\{([^}]*)\\} from "${specifier.replaceAll("/", "\\/")}";`,
          "u",
        ),
      )?.[1];
      assert.ok(block, `no export from ${specifier}`);
      return block
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "" && !name.startsWith("type "))
        .sort();
    };
    assert.deepEqual(IDENTITY_REQUIRED, {
      ".": reexported(source("index.ts"), "@requestport/db"),
      "./migrate": reexported(source("migrate.ts"), "@requestport/db/migrate"),
    });
    assert.deepEqual(IDENTITY_REQUIRED["./migrate"], ["migrate"]);
    const fixture = readFileSync(
      join(FIXTURE.directory, "consumer.ts"),
      "utf8",
    );
    for (const specifier of [
      "@requestport/core",
      "@requestport/db",
      "@requestport/core/migrate",
      "@requestport/db/migrate",
    ]) {
      assert.ok(
        fixture.includes(`values(await import("${specifier}"))`),
        specifier,
      );
    }
    assert.match(
      fixture,
      /report\.identity = await identityCase\(\);\n\s*report\.pglite = await pgliteCase\(\);/u,
    );
  });

  test("the PGlite case (rulings 153 and 154): the optional peer absent must give H.4's refusal, MODULE_NOT_FOUND with Node's MODULE_NOT_FOUND for @electric-sql/pglite as its first cause, from a lookup that starts in db's installed package; a case not run, a storage answered, another error, Node's generic error alone, another module not found, another cause, and a lookup started elsewhere, a directory beside db's that shares its name's start among them, are each reported", () => {
    assert.equal(PGLITE, "@electric-sql/pglite");
    assert.deepEqual(PGLITE_ABSENT, {
      code: "MODULE_NOT_FOUND",
      message:
        "A PGlite storage needs @electric-sql/pglite, and it is not installed",
      cause: "Cannot find module '@electric-sql/pglite'",
    });
    const withCase = (change) => {
      const report = plantedReport();
      return { ...report, pglite: change(report.pglite) };
    };
    const NOT_REFUSED =
      'createStorage({ driver: "pglite" }) failed, but not with H.4\'s refusal';
    const cases = [
      [() => null, "the PGlite case did not run"],
      [
        (pglite) => ({
          ...pglite,
          outcome: "returned",
          error: null,
          requireStack: null,
        }),
        'createStorage({ driver: "pglite" }) answered a storage with @electric-sql/pglite absent',
      ],
      [
        (pglite) => ({
          ...pglite,
          error: {
            name: "Error",
            code: null,
            message:
              "A PGlite storage needs a dataDir: a directory, or memory://.",
            causes: [],
          },
        }),
        NOT_REFUSED,
      ],
      [
        (pglite) => ({
          ...pglite,
          error: {
            ...pglite.error,
            message: "Cannot find module '@electric-sql/pglite/contrib/citext'",
          },
        }),
        NOT_REFUSED,
      ],
      [
        (pglite) => ({
          ...pglite,
          error: { ...pglite.error, code: "ERR_MODULE_NOT_FOUND" },
        }),
        NOT_REFUSED,
      ],
      // Node's generic error, as core threw it before H.4 worded its own.
      [
        (pglite) => ({
          ...pglite,
          error: { ...pglite.error.causes[0], causes: [] },
        }),
        NOT_REFUSED,
      ],
      // The refusal over another module's absence, or with no cause.
      [
        (pglite) => ({
          ...pglite,
          error: {
            ...pglite.error,
            causes: [
              {
                ...pglite.error.causes[0],
                message:
                  "Cannot find module '@electric-sql/pglite/contrib/citext'",
              },
            ],
          },
        }),
        NOT_REFUSED,
      ],
      [
        (pglite) => ({ ...pglite, error: { ...pglite.error, causes: [] } }),
        NOT_REFUSED,
      ],
      [
        (pglite) => ({
          ...pglite,
          error: {
            ...pglite.error,
            causes: [
              { ...pglite.error.causes[0], code: "ERR_MODULE_NOT_FOUND" },
            ],
          },
        }),
        NOT_REFUSED,
      ],
      [
        (pglite) => ({
          ...pglite,
          requireStack: ["/planted/consumer/consumer.ts"],
        }),
        `the lookup of @electric-sql/pglite did not start in db's installed package (${PLANTED_DB})`,
      ],
      [
        (pglite) => ({
          ...pglite,
          requireStack: [`${PLANTED_DB}-planted/dist/chunk-PLANTED.js`],
        }),
        "did not start in db's installed package",
      ],
      [
        (pglite) => ({ ...pglite, requireStack: null }),
        "did not start in db's installed package",
      ],
    ];
    for (const [change, words] of cases) {
      const problems = runProblems(withCase(change), context);
      assert.ok(
        problems.some((problem) => problem.includes(words)),
        `${words}: ${JSON.stringify(problems)}`,
      );
    }
    // The other cases' problems stay out of a refusal that passes.
    assert.deepEqual(
      runProblems(
        withCase((pglite) => pglite),
        context,
      ),
      [],
    );
  });

  test("the consumer holds @electric-sql/pglite nowhere while it is only declared as a peer (the control); a version of it in packages, a snapshot resolved with it as a peer, a dependency on it, a reference carrying it, and its directory in node_modules, hoisted in pnpm's store or in that store under its own name, are each found; plantPglite's copy is found and the lockfile handed is left as it was", () => {
    const consumer = join(scratch, "pglite", "consumer");
    mkdirSync(consumer, { recursive: true });
    const lock = parseLockfile(
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      '@requestport/core':",
        "        specifier: file:/planted/pack/core.tgz",
        "        version: file:../pack/core.tgz",
        "",
        "packages:",
        "",
        "  '@requestport/core@file:../pack/core.tgz':",
        "    resolution: {integrity: sha512-planted, tarball: file:../pack/core.tgz}",
        "    version: 1.0.0-g8-test.1",
        "    peerDependencies:",
        "      '@electric-sql/pglite': 0.5.8",
        "    peerDependenciesMeta:",
        "      '@electric-sql/pglite':",
        "        optional: true",
        "",
        "  drizzle-orm@0.45.2:",
        "    resolution: {integrity: sha512-planted}",
        "    peerDependencies:",
        "      '@electric-sql/pglite': '>=0.2.0'",
        "    peerDependenciesMeta:",
        "      '@electric-sql/pglite':",
        "        optional: true",
        "",
        "snapshots:",
        "",
        "  '@requestport/core@file:../pack/core.tgz':",
        "    dependencies:",
        "      drizzle-orm: 0.45.2",
        "",
        "  drizzle-orm@0.45.2: {}",
        "",
      ].join("\n"),
    );
    const before = structuredClone(lock);
    assert.deepEqual(installedPglite(lock, consumer), []);

    const planted = plantPglite(lock);
    assert.deepEqual(installedPglite(planted, consumer), [
      "pnpm-lock.yaml: packages > @electric-sql/pglite@0.5.8",
      "pnpm-lock.yaml: snapshots > @electric-sql/pglite@0.5.8",
    ]);
    assert.deepEqual(lock, before);

    const changed = (change) => {
      const copy = structuredClone(lock);
      change(copy);
      return installedPglite(copy, consumer);
    };
    assert.deepEqual(
      changed((copy) => {
        copy.snapshots["drizzle-orm@0.45.2(@electric-sql/pglite@0.5.8)"] =
          copy.snapshots["drizzle-orm@0.45.2"];
        delete copy.snapshots["drizzle-orm@0.45.2"];
      }),
      [
        "pnpm-lock.yaml: snapshots > drizzle-orm@0.45.2(@electric-sql/pglite@0.5.8)",
      ],
    );
    assert.deepEqual(
      changed((copy) => {
        copy.importers["."].dependencies[PGLITE] = {
          specifier: "0.5.8",
          version: "0.5.8",
        };
      }),
      ["pnpm-lock.yaml: importers > . > dependencies > @electric-sql/pglite"],
    );
    assert.deepEqual(
      changed((copy) => {
        copy.snapshots["@requestport/core@file:../pack/core.tgz"].dependencies[
          PGLITE
        ] = "0.5.8";
      }),
      [
        "pnpm-lock.yaml: snapshots > @requestport/core@file:../pack/core.tgz > dependencies > @electric-sql/pglite",
      ],
    );
    assert.deepEqual(
      changed((copy) => {
        copy.importers["."].dependencies["@requestport/core"].version =
          "file:../pack/core.tgz(@electric-sql/pglite@0.5.8)";
      }),
      [
        "pnpm-lock.yaml: importers > . > dependencies > @requestport/core > version: file:../pack/core.tgz(@electric-sql/pglite@0.5.8)",
      ],
    );

    for (const directory of [
      "node_modules/@electric-sql/pglite",
      "node_modules/.pnpm/node_modules/@electric-sql/pglite",
      "node_modules/.pnpm/@electric-sql+pglite@0.5.8",
    ]) {
      mkdirSync(join(consumer, directory), { recursive: true });
      assert.deepEqual(installedPglite(lock, consumer), [directory], directory);
      rmSync(join(consumer, "node_modules"), { recursive: true });
    }
    // Another package of the scope, in the store, is not it.
    mkdirSync(
      join(consumer, "node_modules/.pnpm/@electric-sql+pglite-tools@1.0.0"),
      {
        recursive: true,
      },
    );
    assert.deepEqual(installedPglite(lock, consumer), []);
  });

  test("the fixture asks core for one PGlite storage, in memory, and imports nothing of PGlite's", () => {
    const fixture = readFileSync(
      join(FIXTURE.directory, "consumer.ts"),
      "utf8",
    );
    assert.equal(fixture.match(/driver: "pglite"/gu)?.length, 1);
    assert.match(
      fixture,
      /createStorage\(\{\s*driver: "pglite",\s*dataDir: PGLITE_DATA_DIR,?\s*\}\)/u,
    );
    assert.match(fixture, /export const PGLITE_DATA_DIR = "memory:\/\/";/u);
    assert.doesNotMatch(fixture, /from "@electric-sql\//u);
  });

  test("the ruled principals: the person for every module but Slack's read (the operator) and the imports' analysis (an agent key issued as the person), and the fixture's MODULES are the same thirteen names", () => {
    assert.deepEqual(
      Object.entries(RULED_PRINCIPALS).filter(
        ([, principal]) => principal !== "person",
      ),
      [
        ["imports", "agent"],
        ["slack", "operator"],
      ],
    );
    assert.equal(Object.keys(RULED_PRINCIPALS).length, 13);
    assert.deepEqual(
      quotedBetween(
        readFileSync(join(FIXTURE.directory, "consumer.ts"), "utf8"),
        "export const MODULES: readonly string[] = [",
        "];",
      ),
      Object.keys(RULED_PRINCIPALS),
    );
  });

  test("the fixture's operator credential carries operator scopes alone and its agent key agent scopes alone, as the domain lists them", () => {
    const fixture = readFileSync(
      join(FIXTURE.directory, "consumer.ts"),
      "utf8",
    );
    const operatorTypes = readFileSync(
      new URL(
        "../packages/domain/src/operators/operator-types.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const operatorScopes = [
      ...quotedBetween(
        operatorTypes,
        "export const operatorScopes: readonly string[] = [",
        "];",
      ),
      // The two constants the list names, by their values.
      "operator:revoke",
      "agent:revoke",
    ];
    const agentScopes = quotedBetween(
      readFileSync(
        new URL(
          "../packages/domain/src/agents/agent-types.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      "export const agentScopes = [",
      "]",
    );
    const operator = quotedBetween(
      fixture,
      "export const OPERATOR_READ_SCOPES: readonly string[] = [",
      "];",
    );
    const agent = quotedBetween(
      fixture,
      "export const AGENT_SCOPES: readonly string[] = [",
      "];",
    );
    assert.ok(operator.length > 0 && agent.length > 0);
    assert.deepEqual(
      operator.filter((scope) => !operatorScopes.includes(scope)),
      [],
    );
    assert.deepEqual(
      agent.filter((scope) => !agentScopes.includes(scope)),
      [],
    );
  });

  test("the fixture's operator credential carries exactly the scopes the registry asks of the administration reads the fixture makes, and no other", () => {
    const fixture = readFileSync(
      join(FIXTURE.directory, "consumer.ts"),
      "utf8",
    );
    const domain = (path) =>
      readFileSync(
        new URL(`../packages/domain/src/${path}`, import.meta.url),
        "utf8",
      );
    const registry = domain("transport-metadata.ts");
    // The two constants the registry names a scope by, by their values.
    const constants = Object.fromEntries(
      [
        ["agentRevokeScope", domain("operators/operator-types.ts")],
        ["importReviewScope", domain("imports/import-review-commands.ts")],
      ].map(([name, source]) => {
        const value = source.match(
          new RegExp(`export const ${name} = "([^"]+)";`, "u"),
        )?.[1];
        assert.ok(value, `${name} is not defined`);
        return [name, value];
      }),
    );
    // Each read's scope: the fourth argument of its `administrationRead`, or
    // the `scope` of its entry when it is written out.
    const scopeOf = (name) => {
      const short = registry.match(
        new RegExp(
          `administrationRead\\(\\s*"${name}",\\s*"[^"]*",\\s*"[a-z-]+",\\s*(\\w+|"[^"]+")`,
          "u",
        ),
      )?.[1];
      const long = registry.match(
        new RegExp(
          `name: "${name}",\\s*dispatch: \\{[^}]*\\},\\s*binding: "[a-z-]+",\\s*scope: "([^"]+)"`,
          "u",
        ),
      )?.[1];
      const found = short ?? (long === undefined ? undefined : `"${long}"`);
      assert.ok(found, `the registry names no scope for ${name}`);
      return found.startsWith('"') ? found.slice(1, -1) : constants[found];
    };
    const reads = [
      ...new Set(
        [...fixture.matchAll(/\b(?:read|query)\(\s*"([a-z_]+)"/gu)].map(
          ([, name]) => name,
        ),
      ),
    ].sort();
    assert.deepEqual(reads, [
      "get_administration_organization_appearance",
      "get_administration_project_settings",
      "get_administration_slack_configuration",
      "list_administration_agent_principals",
      "list_administration_import_runs",
      "list_administration_invitations",
      "list_administration_projects",
      "list_administration_retention_holds",
      "list_administration_routing_rules",
    ]);
    assert.deepEqual(
      [
        ...quotedBetween(
          fixture,
          "export const OPERATOR_READ_SCOPES: readonly string[] = [",
          "];",
        ),
      ].sort(),
      [...new Set(reads.map(scopeOf))].sort(),
    );
  });

  test("the battery is G.7a's forty cases, ruling 144's four among them, and the differences are the cases whose results differ, a case one run lacks included", () => {
    // A stand-in `zod` whose every member is itself and whose parse answers
    // the version handed, so that only the cases' names are read here.
    const fakeZod = (version) => {
      const fake = new Proxy(() => {}, {
        get: (_, key) =>
          key === "safeParse" ? () => ({ success: true, data: version }) : fake,
        apply: () => fake,
      });
      return fake;
    };
    const names = Object.keys(zodBattery(fakeZod("4.4.3")));
    assert.equal(names.length, 40);
    assert.deepEqual(
      RULING_144_MOVED.filter((name) => !names.includes(name)),
      [],
    );
    assert.deepEqual(
      zodBatteryDifferences(
        { same: ["ok", 1], moved: ["ok", "a"], gone: ["no", []] },
        { same: ["ok", 1], moved: ["ok", "b"], added: ["ok", 2] },
      ),
      ["added", "gone", "moved"],
    );
  });

  test("the zod copies are read from an installed tree: each package handed that declares zod, its declared and resolved version and its files importing zod, and none for a package that declares none; Better Auth's copy through auth's resolution, the battery on each version alone and on both in one process in each order, and a package resolving another version than it declares is a problem", async () => {
    const root = join(scratch, "zod-tree");
    const plantPackage = (directory, manifest, files = {}) => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
      for (const [file, body] of Object.entries(files)) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        writeFileSync(join(directory, file), body);
      }
    };
    // A stand-in zod: every member is itself, and parse answers the version,
    // marked when the planted fixture was imported before it ran.
    const plantZod = (directory, version) =>
      plantPackage(
        directory,
        {
          name: "zod",
          version,
          exports: { ".": { import: "./index.js", require: "./index.cjs" } },
        },
        {
          "index.js": `const fake = new Proxy(() => {}, { get: (_, key) => key === "safeParse" ? () => ({ success: true, data: ${JSON.stringify(version)} + (globalThis.plantedFixtureLoaded ? " after the fixture" : "") }) : fake, apply: () => fake });\nexport const z = fake;\n`,
          "index.cjs": "module.exports = {};\n",
        },
      );
    const core = join(root, "consumer", "node_modules", "@requestport", "core");
    const auth = join(root, "consumer", "node_modules", "@requestport", "auth");
    plantPackage(
      core,
      { name: "@requestport/core", dependencies: { zod: "4.4.3" } },
      {
        "dist/index.js": 'import { z } from "zod";\n',
        "dist/migrate.js": "export {};\n",
      },
    );
    plantZod(join(core, "node_modules", "zod"), "4.4.3");
    // A planted auth declares 4.5.4 and resolves 4.4.3: a problem.
    plantPackage(
      auth,
      { name: "@requestport/auth", dependencies: { zod: "4.5.4" } },
      { "dist/create-auth.js": "import { z as z2 } from 'zod';\n" },
    );
    plantZod(join(auth, "node_modules", "zod"), "4.4.3");
    // db declares no zod, so it has no copy to read.
    const db = join(root, "consumer", "node_modules", "@requestport", "db");
    plantPackage(
      db,
      { name: "@requestport/db", dependencies: { pg: "8.23.0" } },
      { "dist/index.js": "export {};\n" },
    );
    plantPackage(
      join(auth, "node_modules", "better-auth"),
      {
        name: "better-auth",
        main: "index.js",
      },
      { "index.js": "module.exports = {};\n" },
    );
    plantZod(
      join(auth, "node_modules", "better-auth", "node_modules", "zod"),
      "4.5.4",
    );
    // The fixture, which the last run imports before either copy.
    writeFileSync(
      join(root, "consumer", "consumer.ts"),
      "globalThis.plantedFixtureLoaded = true;\n",
    );

    const out = join(root, "out");
    mkdirSync(out);
    const zod = zodBehaviour(
      join(root, "consumer"),
      out,
      { PATH: process.env.PATH },
      {
        "@requestport/core": core,
        "@requestport/db": db,
        "@requestport/auth": auth,
      },
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(zod.copies).map(([name, copy]) => [
          name,
          [copy.declared, copy.resolved, copy.filesImportingZod],
        ]),
      ),
      {
        "@requestport/core": ["4.4.3", "4.4.3", ["index.js"]],
        "@requestport/auth": ["4.5.4", "4.4.3", ["create-auth.js"]],
        "better-auth": [null, "4.5.4", null],
      },
    );
    assert.deepEqual(zod.problems, [
      "@requestport/auth declares zod 4.5.4 and resolves 4.4.3",
    ]);
    assert.deepEqual(zod.versions, ["4.4.3", "4.5.4"]);
    // Each stand-in answers its own version, alone and together alike.
    assert.equal(zod.alone["4.4.3"].uuid[1], "4.4.3");
    assert.equal(zod.alone["4.5.4"].uuid[1], "4.5.4");
    assert.deepEqual(Object.keys(zod.together), ["4.4.3 first", "4.5.4 first"]);
    assert.equal(zod.together["4.5.4 first"]["4.4.3"].uuid[1], "4.4.3");
    // The last run imported the fixture first, and only that run.
    assert.equal(
      zod.asTheConsumerLoads["4.4.3"].uuid[1],
      "4.4.3 after the fixture",
    );
    assert.equal(
      zod.asTheConsumerLoads["4.5.4"].uuid[1],
      "4.5.4 after the fixture",
    );
    assert.equal(zod.differing.length, 40);
    assert.deepEqual(
      Object.values(zod.differingTogether).map((names) => names.length),
      [40, 40],
    );
    assert.equal(zod.differingAsTheConsumerLoads.length, 40);
    assert.equal(zod.sameAsRuling144, false);
    // Each run wrote its results beside the runner.
    assert.deepEqual(
      [
        "alone-4.4.3",
        "alone-4.5.4",
        "together-4.4.3-first",
        "together-4.5.4-first",
        "consumer",
      ].filter(
        (label) =>
          JSON.parse(
            readFileSync(join(out, `zod-battery-${label}.json`), "utf8"),
          ).length === (label.startsWith("alone") ? 1 : 2),
      ).length,
      5,
    );
  });
});

describe("step 7: the licence inventory and the build's Linux bindings (rulings 139, 151 and 153)", () => {
  /** The planted set: core and `db`, which the consumer depends on, and `domain`, which `db` reaches. */
  const MEMBERS = Object.freeze([
    "@requestport/core",
    "@requestport/db",
    "@requestport/domain",
  ]);

  /**
   * A consumer tree, as Node resolves it, with the planted set's closure:
   * core and `db` at its root, as pnpm links the consumer's own
   * dependencies; core's zod and its dependency on `db`; `db`'s pg (and its
   * pg-protocol, whose own dependency `fresh` the reference does not hold)
   * and its dependency on `domain`, which only `db` resolves, as pnpm lays a
   * package the consumer does not depend on; `domain`'s zod; and pg's
   * optional peer pg-native installed beside them. Its pnpm-workspace.yaml
   * holds only overrides, as G.8's does.
   */
  function plantedConsumer() {
    const root = join(scratch, `step7-${Math.random().toString(16).slice(2)}`);
    const manifest = (directory, value) => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify(value));
    };
    manifest(root, {
      name: "requestport-core-smoke-consumer",
      dependencies: {
        "@requestport/core": "file:/planted/core.tgz",
        "@requestport/db": "file:/planted/db.tgz",
      },
    });
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'overrides:\n  "@requestport/core": "file:/planted/core.tgz"\n  "@requestport/db": "file:/planted/db.tgz"\n  "@requestport/domain": "file:/planted/domain.tgz"\n',
    );
    manifest(join(root, "node_modules/@requestport/core"), {
      name: "@requestport/core",
      version: VERSION,
      dependencies: { "@requestport/db": VERSION, zod: "4.4.3" },
    });
    manifest(join(root, "node_modules/@requestport/db"), {
      name: "@requestport/db",
      version: VERSION,
      dependencies: { "@requestport/domain": VERSION, pg: "8.23.0" },
      peerDependencies: { [PGLITE]: "0.5.8" },
      peerDependenciesMeta: { [PGLITE]: { optional: true } },
    });
    manifest(
      join(
        root,
        "node_modules/@requestport/db/node_modules/@requestport/domain",
      ),
      {
        name: "@requestport/domain",
        version: VERSION,
        dependencies: { zod: "4.4.3" },
      },
    );
    manifest(join(root, "node_modules/pg"), {
      name: "pg",
      version: "8.23.0",
      license: "MIT",
      dependencies: { "pg-protocol": "^1.10.0" },
      peerDependencies: { "pg-native": ">=3.0.0" },
      peerDependenciesMeta: { "pg-native": { optional: true } },
    });
    // An optional peer this tree happens to hold: view (b) leaves it out.
    manifest(join(root, "node_modules/pg-native"), {
      name: "pg-native",
      version: "3.0.0",
      license: "MIT",
    });
    manifest(join(root, "node_modules/pg-protocol"), {
      name: "pg-protocol",
      version: "1.16.1",
      license: "MIT",
      dependencies: { fresh: "1.0.0" },
    });
    manifest(join(root, "node_modules/fresh"), {
      name: "fresh",
      version: "1.0.0",
      license: "ISC",
    });
    manifest(join(root, "node_modules/zod"), {
      name: "zod",
      version: "4.4.3",
      license: "MIT",
    });
    return root;
  }

  /** G.A's JSON document over `root`, as its --json writes it for INVENTORY_PACKAGES. */
  function inventoryDocument(root) {
    return JSON.parse(
      JSON.stringify(
        inventory(root, { packages: [...INVENTORY_PACKAGES], pnpm: false }),
      ),
    );
  }

  const REFERENCE_DOCUMENT = {
    rows: {
      S8: {
        viewA: ["ignored@1.0.0"],
        viewB: ["gone@2.0.0", "pg-protocol@1.10.0", "pg@8.23.0", "zod@4.4.3"],
      },
    },
  };
  const options = { members: MEMBERS };

  test("G.A's script runs as --root <consumer> --package @requestport/core --package @requestport/db --no-pnpm --json <file>, the published packages the consumer depends on, and the reference is the committed file's S8 row, view (b), the S1 row's list, whose names G.A's report flags none of", () => {
    assert.deepEqual(INVENTORY_PACKAGES, [
      "@requestport/core",
      "@requestport/db",
    ]);
    assert.deepEqual(licenceInventoryArguments("/c", "/c.json"), [
      "--root",
      "/c",
      "--package",
      "@requestport/core",
      "--package",
      "@requestport/db",
      "--no-pnpm",
      "--json",
      "/c.json",
    ]);
    assert.equal(
      LICENCE_INVENTORY,
      fileURLToPath(new URL("./licence-inventory.mjs", import.meta.url)),
    );
    assert.equal(LICENCE_REFERENCE.row, "S8");
    assert.deepEqual(LICENCE_REFERENCE.flagged, {});
    const committed = JSON.parse(readFileSync(LICENCE_REFERENCE.file, "utf8"));
    const reference = readLicenceReference();
    assert.deepEqual([...reference.packages], committed.rows.S8.viewB);
    assert.deepEqual(
      [...committed.rows.S8.viewB].sort(),
      [...committed.rows.S1.viewB].sort(),
    );
    assert.deepEqual(reference.names.get("pg"), ["8.23.0"]);
    assert.throws(
      () => readLicenceReference({ rows: { S1: { viewB: ["pg@8.23.0"] } } }),
      /no S8 row with a view \(b\)/u,
    );
  });

  test("the set's closure read as a plain tree, member by member, and matching the reference by name has no problem (the control): G.A's members and the walk's are the set, found from the consumer's root and through db; each package's own closure is recorded; a version the reference lacks is recorded with its licence, a new name G.A does not flag is an accepted addition, and a reference entry whose name the consumer lacks is recorded", () => {
    const root = plantedConsumer();
    const result = inventoryDocument(root);
    const licences = consumerLicences(root);
    const reference = readLicenceReference(REFERENCE_DOCUMENT);
    const { comparison, problems } = licenceProblems(
      result,
      licences,
      reference,
      options,
    );

    assert.deepEqual(problems, []);
    assert.deepEqual(result.candidates[0].members, MEMBERS);
    assert.deepEqual(licences.members, MEMBERS);
    assert.deepEqual(licences.missing, []);
    assert.deepEqual(
      licences.entries.map(({ key, field, flags }) => [key, field, flags]),
      [
        ["fresh@1.0.0", "ISC", []],
        ["pg-protocol@1.16.1", "MIT", []],
        ["pg@8.23.0", "MIT", []],
        ["zod@4.4.3", "MIT", []],
      ],
    );
    assert.deepEqual(licences.packages, {
      "@requestport/core": {
        keys: ["zod@4.4.3"],
        firstParty: ["@requestport/db"],
      },
      "@requestport/db": {
        keys: ["fresh@1.0.0", "pg-protocol@1.16.1", "pg@8.23.0"],
        firstParty: ["@requestport/domain"],
      },
      "@requestport/domain": { keys: ["zod@4.4.3"], firstParty: [] },
    });
    assert.deepEqual(comparison, {
      entries: 4,
      names: 4,
      sameVersion: 2,
      otherVersion: [
        {
          key: "pg-protocol@1.16.1",
          field: "MIT",
          flags: [],
          reference: ["1.10.0"],
        },
      ],
      added: [{ key: "fresh@1.0.0", field: "ISC" }],
      absent: ["gone@2.0.0"],
      packages: {
        "@requestport/core": {
          entries: 1,
          names: 1,
          sameVersion: 1,
          otherVersion: [],
          added: [],
          firstParty: ["@requestport/db"],
        },
        "@requestport/db": {
          entries: 3,
          names: 3,
          sameVersion: 1,
          otherVersion: ["pg-protocol@1.16.1"],
          added: ["fresh@1.0.0"],
          firstParty: ["@requestport/domain"],
        },
        "@requestport/domain": {
          entries: 1,
          names: 1,
          sameVersion: 1,
          otherVersion: [],
          added: [],
          firstParty: [],
        },
      },
    });
    assert.deepEqual(
      unreportedInventoryPlants({ result, licences }, reference, options),
      [],
    );
  });

  test("each of INVENTORY_PLANTS is reported: a new name flagged copyleft or unknown, a new name under a licence G.A does not flag that is not permissive, a known name's licence changing class, the consumer read as a workspace, a member not found or one beside the set, a dependency unresolved, a platform package or a skipped linux-x64 build in the set's closure, the walk and the inventory disagreeing, a first-party package outside the set reached, and a new flagged name in one package's own closure", () => {
    const root = plantedConsumer();
    const input = {
      result: inventoryDocument(root),
      licences: consumerLicences(root),
    };
    const reference = readLicenceReference(REFERENCE_DOCUMENT);

    assert.equal(INVENTORY_PLANTS.length, 13);
    for (const { plant, change, expect } of INVENTORY_PLANTS) {
      const changed = change(structuredClone(input));
      const { problems } = licenceProblems(
        changed.result,
        changed.licences,
        reference,
        options,
      );
      assert.ok(
        problems.some((problem) => problem.includes(expect)),
        `${plant}: ${JSON.stringify(problems)}`,
      );
    }
    // A plant that cannot be written is unreported, not passed.
    const withoutPg = structuredClone(input);
    withoutPg.licences.entries = withoutPg.licences.entries.filter(
      ({ name }) => name !== "pg",
    );
    assert.ok(
      unreportedInventoryPlants(withoutPg, reference, options).includes(
        "a known name's licence changed class",
      ),
    );
  });

  test("the set is judged as the members must be: a member G.A or the walk does not find, or one the walk does not reach, is reported, and so is the default set, S8, against the planted three", () => {
    const root = plantedConsumer();
    const result = inventoryDocument(root);
    const licences = consumerLicences(root);
    const reference = readLicenceReference(REFERENCE_DOCUMENT);
    const judge = (changedLicences, judged = options) =>
      licenceProblems(result, changedLicences, reference, judged).problems;
    assert.ok(
      judge({ ...licences, missing: ["@requestport/core"] }).includes(
        "the walk did not find @requestport/core in the consumer",
      ),
    );
    assert.ok(
      judge({
        ...licences,
        members: licences.members.filter(
          (name) => name !== "@requestport/domain",
        ),
      }).includes("the walk did not reach @requestport/domain"),
    );
    const against = judge(licences, {});
    assert.ok(
      against.some((problem) =>
        problem.endsWith(`not the set's ${[...S8].sort().join(", ")}`),
      ),
      JSON.stringify(against),
    );
    assert.ok(against.includes("the walk did not reach @requestport/jobs"));
    // Nothing found at the consumer's root: G.A's members and the walk's.
    const empty = join(scratch, "step7-empty");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "package.json"), "{}");
    assert.deepEqual(consumerLicences(empty), {
      members: [],
      missing: [...INVENTORY_PACKAGES],
      packages: {},
      entries: [],
    });
  });

  test("a new name G.A does not flag is accepted only under ADDITION_IDENTIFIERS, the permissive part of G.A's recognised identifiers (ruling 154): both sides of an AND, either side of an OR", () => {
    for (const identifier of ADDITION_IDENTIFIERS) {
      assert.ok(RECOGNISED_IDENTIFIERS.includes(identifier), identifier);
    }
    for (const field of [
      "MIT",
      "(MIT OR CC0-1.0)",
      "Apache-2.0 AND BSD-3-Clause",
      "Apache-2.0 WITH LLVM-exception",
      "(CC-BY-4.0 OR (ISC AND Zlib))",
    ]) {
      assert.equal(additionAccepted(field), true, field);
    }
    for (const field of [
      "CC-BY-4.0",
      "CC0-1.0",
      "Unlicense",
      "WTFPL",
      "Python-2.0",
      "MIT AND CC-BY-3.0",
      "LicenseRef-planted",
      "(no licence field)",
    ]) {
      assert.equal(additionAccepted(field), false, field);
    }

    const root = plantedConsumer();
    const result = inventoryDocument(root);
    const licences = consumerLicences(root);
    const reference = readLicenceReference(REFERENCE_DOCUMENT);
    const judged = (field) =>
      licenceProblems(
        result,
        {
          ...licences,
          entries: [
            ...licences.entries,
            {
              key: "planted@1.0.0",
              name: "planted",
              version: "1.0.0",
              field,
              flags: [],
            },
          ],
        },
        reference,
        options,
      );
    // Planted in the walk alone: the walk-against-inventory problems are
    // other cases', so only the planted name's own are compared.
    const own = ({ problems }) =>
      problems.filter((problem) => problem.startsWith("planted@1.0.0:"));
    const unlicense = judged("Unlicense");
    assert.deepEqual(own(unlicense), [
      "planted@1.0.0: a name the reference does not hold, under Unlicense, which G.A does not flag and ADDITION_IDENTIFIERS does not cover (ruling 154)",
    ]);
    assert.ok(
      !unlicense.comparison.added.some(({ key }) => key === "planted@1.0.0"),
    );
    const either = judged("(MIT OR CC0-1.0)");
    assert.deepEqual(own(either), []);
    assert.ok(
      either.comparison.added.some(({ key }) => key === "planted@1.0.0"),
    );
  });

  test("a new name G.A flags fails whatever its flag; a known name whose flags differ from the reference's fails, at its version or another, in the union and in each package whose own closure holds it; a known name flagged as the reference flags it does not change class", () => {
    const root = plantedConsumer();
    const result = inventoryDocument(root);
    const licences = consumerLicences(root);
    const reference = readLicenceReference(REFERENCE_DOCUMENT);
    const judge = (entries, against = reference) =>
      licenceProblems(result, { ...licences, entries }, against, options)
        .problems;

    for (const flag of FLAGS) {
      const problems = judge([
        ...licences.entries,
        {
          key: "planted@1.0.0",
          name: "planted",
          version: "1.0.0",
          field: "planted",
          flags: [flag],
        },
      ]);
      assert.ok(
        problems.some((problem) =>
          problem.startsWith(
            `planted@1.0.0: a name the reference does not hold, flagged ${flag}`,
          ),
        ),
        flag,
      );
    }
    const relicensed = (name, flags) =>
      licences.entries.map((entry) =>
        entry.name === name ? { ...entry, field: "planted", flags } : entry,
      );
    const changed = (problems) =>
      problems.filter((problem) => problem.includes("changed class"));
    // At the reference's version, and at another; zod is in core's and
    // domain's own closures, pg-protocol in db's.
    assert.deepEqual(changed(judge(relicensed("zod", ["unknown"]))), [
      "zod@4.4.3: its licence changed class, flagged unknown (planted), where the reference's zod is unflagged",
      "@requestport/core: zod@4.4.3: its licence changed class, flagged unknown (planted), where the reference's zod is unflagged",
      "@requestport/domain: zod@4.4.3: its licence changed class, flagged unknown (planted), where the reference's zod is unflagged",
    ]);
    assert.deepEqual(
      changed(judge(relicensed("pg-protocol", ["copyleft"]))).map(
        (problem) => problem.split(":")[0],
      ),
      ["pg-protocol@1.16.1", "@requestport/db"],
    );
    // The reference's own flags: kept, no change of class; dropped, one in
    // the union and one in each package holding it.
    const flaggedReference = readLicenceReference(REFERENCE_DOCUMENT, {
      flagged: { zod: ["unknown"] },
    });
    assert.deepEqual(
      changed(judge(relicensed("zod", ["unknown"]), flaggedReference)),
      [],
    );
    assert.deepEqual(changed(judge(licences.entries, flaggedReference)), [
      "zod@4.4.3: its licence changed class, unflagged (MIT), where the reference's zod is flagged unknown",
      "@requestport/core: zod@4.4.3: its licence changed class, unflagged (MIT), where the reference's zod is flagged unknown",
      "@requestport/domain: zod@4.4.3: its licence changed class, unflagged (MIT), where the reference's zod is flagged unknown",
    ]);
  });

  test("the walk and G.A's view (b) must agree: an entry, a flag and a count by licence that differ are each reported", () => {
    const root = plantedConsumer();
    const result = inventoryDocument(root);
    const licences = consumerLicences(root);
    const reference = readLicenceReference(REFERENCE_DOCUMENT);
    const judge = (changeResult, changeLicences = (value) => value) =>
      licenceProblems(
        changeResult(structuredClone(result)),
        changeLicences(structuredClone(licences)),
        reference,
        options,
      ).problems;

    assert.ok(
      judge(
        (value) => value,
        (value) => ({
          ...value,
          entries: value.entries.filter(({ name }) => name !== "fresh"),
        }),
      ).some((problem) =>
        problem.includes(
          "only in the walk: none; only in the inventory: fresh@1.0.0",
        ),
      ),
    );
    assert.ok(
      judge((value) => {
        value.candidates[0].viewB.flagged = [{ key: "zod@4.4.3" }];
        return value;
      }).some((problem) =>
        problem.includes("the walk flags nothing, and the inventory zod@4.4.3"),
      ),
    );
    assert.ok(
      judge((value) => {
        value.candidates[0].viewB.byLicence = { MIT: 4 };
        return value;
      }).some((problem) => problem.startsWith("the walk counts")),
    );
  });

  test("the Linux bindings' project: core's devDependencies at exact versions, the bundler's, and pnpm's supportedArchitectures asking for Linux on arm64 and x64, glibc and musl, beside this machine's; a range is refused", () => {
    assert.deepEqual(Object.keys(buildDevDependencies()).sort(), [
      "esbuild",
      "rolldown",
      "rolldown-plugin-dts",
    ]);
    assert.deepEqual(
      buildDevDependencies({ devDependencies: { esbuild: "0.28.2" } }),
      { esbuild: "0.28.2" },
    );
    assert.throws(
      () => buildDevDependencies({ devDependencies: { esbuild: "^0.28.2" } }),
      /packages\/core pins esbuild at "\^0\.28\.2", not an exact version/u,
    );
    assert.throws(() => buildDevDependencies({}), /no devDependencies/u);
    const files = linuxBindingsFiles({ esbuild: "0.28.2" });
    assert.deepEqual(JSON.parse(files["package.json"]).devDependencies, {
      esbuild: "0.28.2",
    });
    assert.equal(JSON.parse(files["package.json"]).private, true);
    assert.equal(
      files["pnpm-workspace.yaml"],
      "supportedArchitectures:\n  os: [current, linux]\n  cpu: [current, arm64, x64]\n  libc: [current, glibc, musl]\n",
    );
  });

  /**
   * A planted pnpm store: three Linux bindings, one of them in two
   * directories, a darwin binding, the tool, and pnpm's links to a binding.
   */
  function plantedLinuxProject() {
    const project = join(
      scratch,
      `linux-${Math.random().toString(16).slice(2)}`,
    );
    const store = join(project, "node_modules/.pnpm");
    const own = (directory, name, manifest, files = {}) => {
      const path = join(store, directory, "node_modules", name);
      mkdirSync(path, { recursive: true });
      writeFileSync(
        join(path, "package.json"),
        JSON.stringify({ name, ...manifest }),
      );
      for (const [file, text] of Object.entries(files)) {
        writeFileSync(join(path, file), text);
      }
      return path;
    };
    const x64 = own("@esbuild+linux-x64@0.28.2", "@esbuild/linux-x64", {
      version: "0.28.2",
      license: "MIT",
      os: ["linux"],
      cpu: ["x64"],
    });
    const arm64 = {
      version: "1.2.4",
      license: "MIT",
      os: ["linux"],
      cpu: ["arm64"],
      libc: ["glibc"],
    };
    own(
      "@rolldown+binding-linux-arm64-gnu@1.2.4",
      "@rolldown/binding-linux-arm64-gnu",
      arm64,
    );
    // The same package in a second directory of pnpm's, as a peer variant
    // would be: read once.
    own(
      "@rolldown+binding-linux-arm64-gnu@1.2.4_planted@1.0.0",
      "@rolldown/binding-linux-arm64-gnu",
      arm64,
    );
    own(
      "planted-binding-linux-x64-musl@1.0.0",
      "planted-binding-linux-x64-musl",
      {
        version: "1.0.0",
        license: "MIT",
        os: ["linux"],
        cpu: ["x64"],
        libc: ["musl"],
        scripts: { postinstall: "node build.js", test: "node test.js" },
      },
      { "binding.gyp": "{}" },
    );
    own("@esbuild+darwin-arm64@0.28.2", "@esbuild/darwin-arm64", {
      version: "0.28.2",
      license: "MIT",
      os: ["darwin"],
      cpu: ["arm64"],
    });
    const tool = own("esbuild@0.28.2", "esbuild", {
      version: "0.28.2",
      license: "MIT",
      optionalDependencies: { "@esbuild/linux-x64": "0.28.2" },
    });
    // pnpm's link to the binding beside the tool, and its hoisted one.
    const besideTool = join(dirname(tool), "@esbuild/linux-x64");
    mkdirSync(dirname(besideTool), { recursive: true });
    symlinkSync(relative(dirname(besideTool), x64), besideTool);
    const hoisted = join(store, "node_modules/@esbuild/linux-x64");
    mkdirSync(dirname(hoisted), { recursive: true });
    symlinkSync(relative(dirname(hoisted), x64), hoisted);
    return project;
  }

  test("linuxBindings reads each package in the pnpm store whose os names linux, once, from its own directory: its platform, its licence as G.A's classifier reads it, and its install scripts, a binding.gyp counted as one", () => {
    assert.deepEqual(INSTALL_SCRIPTS, ["preinstall", "install", "postinstall"]);
    assert.deepEqual(linuxBindings(plantedLinuxProject()), [
      {
        key: "@esbuild/linux-x64@0.28.2",
        os: ["linux"],
        cpu: ["x64"],
        libc: null,
        field: "MIT",
        flags: [],
        installScripts: [],
      },
      {
        key: "@rolldown/binding-linux-arm64-gnu@1.2.4",
        os: ["linux"],
        cpu: ["arm64"],
        libc: ["glibc"],
        field: "MIT",
        flags: [],
        installScripts: [],
      },
      {
        key: "planted-binding-linux-x64-musl@1.0.0",
        os: ["linux"],
        cpu: ["x64"],
        libc: ["musl"],
        field: "MIT",
        flags: [],
        installScripts: ["postinstall", "binding.gyp"],
      },
    ]);
    assert.deepEqual(linuxBindings(join(scratch, "no-such-project")), []);
  });

  test("the Linux bindings' judgement: an install exiting 0 that read MIT bindings on arm64 and x64 with no install script, none of which the consumer installs, has no problem (the control); each of LINUX_PLANTS is reported", () => {
    const binding = (key, cpu) => ({
      key,
      os: ["linux"],
      cpu: [cpu],
      libc: null,
      field: "MIT",
      flags: [],
      installScripts: [],
    });
    const reading = {
      status: 0,
      devDependencies: { esbuild: "0.28.2" },
      bindings: [
        binding("@esbuild/linux-arm64@0.28.2", "arm64"),
        binding("@esbuild/linux-x64@0.28.2", "x64"),
      ],
    };
    const context = { consumerNames: ["pg", "zod", "@requestport/core"] };

    assert.deepEqual(linuxBindingProblems(reading, context), []);
    assert.equal(LINUX_PLANTS.length, 7);
    assert.deepEqual(unreportedLinuxPlants(reading, context), []);
    for (const { plant, change, expect } of LINUX_PLANTS) {
      const changed = change(structuredClone({ reading, context }));
      assert.ok(
        linuxBindingProblems(changed.reading, changed.context).some((problem) =>
          problem.includes(expect),
        ),
        plant,
      );
    }
    // The build tool itself in the consumer is reported too.
    assert.ok(
      linuxBindingProblems(reading, {
        consumerNames: [...context.consumerNames, "esbuild"],
      }).includes("the consumer installs esbuild, which only the build uses"),
    );
  });
});

describe("nothing published (manifest-g.md §3.6)", () => {
  test("the smoke, its fixture and the fixture's tsconfig name no publish command, no adduser, no _authToken and no config set", () => {
    for (const file of [
      "core-tarball-smoke.mjs",
      "core-tarball-smoke/consumer.ts",
      "core-tarball-smoke/tsconfig.json",
    ]) {
      const text = readFileSync(
        fileURLToPath(new URL(`./${file}`, import.meta.url)),
        "utf8",
      );
      // G.7's two patterns (`pack-packages.test.mjs`, "built, not published"),
      // then a registry login or setting written.
      assert.doesNotMatch(text, /(["'`])publish\1/u, file);
      assert.doesNotMatch(
        text,
        /\b(?:npm|pnpm|yarn|bun)\b[\s"',[\]]*publish\b/u,
        file,
      );
      assert.doesNotMatch(
        text,
        /\badduser\b|_authToken|\bconfig set\b|(["'`])config\1\s*,\s*(["'`])set\2/u,
        file,
      );
    }
  });
});
