import { spawnSync } from "node:child_process";
import {
  cpSync,
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
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTED_DRIVER_PACKAGES } from "@requestport/db/testing";
import type { Metafile } from "esbuild";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseAst } from "vitest/node";
import {
  type BundleName,
  buildBundle,
  buildOrder,
  buildPackage,
  bundles,
  forbiddenModule,
  forbiddenModules,
  holdsDocComment,
  hostPackages,
  inertSeams,
  type PackageBundle,
  packageSet,
  privateDocComments,
  publicVariants,
  seamMarkersIn,
  siblingProblems,
  testSeams,
  topologicalOrder,
} from "../bundle.mjs";

/*
 * The publishable bundles `packages/core/bundle.mjs` builds (Plan 13, G):
 * one per package of the S8 set (ruling 175), and one for each of
 * `@requestport/auth`, `mcp` and `server` (ruling 190), each built once by
 * `buildPackage`, in `buildOrder`'s order, into a temporary directory.
 * Nothing here is packed or published. `scripts/pack-packages.mjs` packs
 * these rows in that order, and its test holds the tarballs.
 *
 * The rows:
 * - the set is ruling 175's eight packages, `hostPackages` ruling 190's
 *   three, and `bundles` holds a row for each, none test-only. Each row's
 *   entries are the subpaths pinned below (`published`), each at the source
 *   its manifest's `exports` names; the source manifest's other subpaths
 *   are pinned too (`unpublished`). Ruling 193 item 1 publishes five
 *   subpaths G's rows left out: `db`'s `./wiring`, `config`'s `./server`
 *   and `./server-deferred`, `jobs`' `.` and core's `./adapters`; and
 *   ruling 183 item 3 `config`'s `./sign-in-methods`. A row of the set
 *   leaves the other seven external, and a row of the three every other
 *   package `bundles` builds; none inlines anything of another package's.
 *   Every row names `publicVariants`, so it builds each of `db`'s three
 *   private modules as its public variant: `shared-databases.ts` as
 *   `shared-databases.public.ts` (ruling 183 item 9), and `hosted-driver.ts`
 *   and `hosted-migrator.ts` as `hosted-driver.public.ts` and
 *   `hosted-migrator.public.ts` (ruling 194 item 3); and `inertSeams`, so
 *   its JavaScript builds each
 *   test seam's real module as its inert module (`testSeams`, the seams'
 *   one list, pinned below as `seams`; ruling 174, and ruling 193 item 2);
 * - `buildOrder` puts each row after every row whose package its source
 *   manifest's `dependencies` name with a `workspace:` version; it refuses
 *   such a package that no row builds, and `topologicalOrder` a cycle.
 * - the forbidden-module list (`forbiddenModules`) names each module with
 *   why, and five of its modules' packages publish them (ruling 193 item
 *   1): `forbiddenModule` refuses those in every bundle but their own
 *   package's.
 *
 * Each bundle:
 * - writes every output, JavaScript and declarations, directly in `dist/`,
 *   with a `.js` and a `.d.ts` per entry;
 * - inlines exactly the modules a walk of its entries' sources reaches at
 *   run time with its external packages left out and each private module
 *   taken as its public variant and each seam's real module as its inert
 *   module (`runtimeWalk`), every one in its own package or in its
 *   `inlines`, none forbidden to it (`bundle.mjs`'s `forbiddenModule`, the
 *   one copy of the list; ruling 151), none private, none a seam's real
 *   module, and none of the E2E owner storage, whose text no output holds;
 *   `db`'s inlines each public variant, and `server`'s the CSP fence's inert
 *   module and not its real one;
 * - leaves to the consumer's install the third-party packages and the
 *   sibling subpaths pinned below (`javascriptImports`), and `node:`
 *   builtins: each third-party package one its source manifest declares,
 *   and each sibling subpath one a row publishes. `db`'s are none of the
 *   hosted driver's packages (`HOSTED_DRIVER_PACKAGES`);
 * - bundles declarations that import the sibling subpaths and third-party
 *   packages pinned below (`declarationImports`), `node:` builtins aside,
 *   each third-party package one its source manifest declares, and none of
 *   `pg`'s, PGlite's or the hosted driver's types (`driverTypes`): the
 *   property tsc's per-module declarations lack (G's S8 survey, §1.5), which
 *   the same check finds in a bundle of `db`'s `client.ts` built with
 *   `shared-databases.ts`'s variant alone;
 *   each `//#region` comment names, by its path in the repository, a module
 *   of its own package or of its `inlines`, and none a private module or a
 *   test seam's real module; and
 *   no declaration holds a doc comment of a private module that its public
 *   variant lacks (`privateDocComments`). rolldown gives a module that a
 *   declaration imports as a namespace no `//#region` of its own, so the
 *   regions alone cannot show it absent. A control bundle of core's test
 *   support, whose declaration imports `db`'s `shared-databases.ts` that
 *   way, holds the variant's doc comments in its place, and built without
 *   `publicVariants`, the module's, under no region naming it;
 * - holds no seam's marker in any output (`seamMarkersIn`);
 * - has, for each entry, a bundled declaration file that exports exactly the
 *   names, types and values alike, its source entry exports (ruling 151;
 *   `exportNames`, below);
 * - holds no path of this machine.
 *
 * `buildPackage` refuses a bundle that inlines a module of a package it
 * should leave external (a row with one sibling left out of `external`), or
 * that imports a subpath no row publishes (`server` built without
 * `inertSeams`, whose real CSP fence imports `auth`'s `./e2e`, and whose
 * JavaScript then holds the fence's real module); `siblingProblems` reads
 * the same from declarations.
 *
 * The eleven, laid out as an install: each package's `dist/` and a manifest
 * whose `exports` name its entries, and `db`'s `migrations/` (the SQL files
 * and `meta/_journal.json`), under `node_modules/@requestport/`, beside the
 * third-party packages they import and the optional PGlite peer, and a
 * package's own copy of one under that package where it is another than the
 * top's (`auth`'s `zod`), as an install nests a version the top does not
 * hold; in a directory with no `node_modules` above it; loaded by Node with
 * an empty environment. Importing every entry, in build order, by its
 * package's name, but `config`'s `./server`, reads no variable in the
 * packages' own code, and adds only the globals its dependencies add;
 * `config`'s `./server`, imported after them, parses `process.env` as it is
 * imported, so it refuses the empty environment (ruling 176); a storage
 * `db`'s `createStorage` builds is one `db`'s `./migrate`'s `migrate`
 * accepts, migrating a fresh PGlite database through every migration in the
 * journal; and core's `createStorage` and `migrate` are `db`'s own
 * functions, so one copy of `db` runs.
 */

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** The subpaths each row publishes, its entries. */
const published: Record<BundleName, string[]> = {
  domain: ["."],
  notifications: [".", "./view-model", "./slack"],
  webhooks: ["."],
  importer: ["."],
  config: ["./logger", "./server", "./server-deferred", "./sign-in-methods"],
  db: [".", "./migrate", "./wiring"],
  jobs: [".", "./catalogue", "./dispatch", "./worker", "./worker-storages"],
  core: [".", "./adapters", "./agent-services", "./migrate"],
  auth: ["./auth-handler", "./create-auth"],
  mcp: ["."],
  server: ["."],
};

/** The subpaths of each row's source manifest that it does not publish. */
const unpublished: Record<BundleName, string[]> = {
  domain: ["./browser"],
  notifications: [],
  webhooks: [],
  importer: [],
  config: [".", "./client", "./redaction"],
  db: ["./e2e", "./testing"],
  jobs: ["./selection"],
  // `personCommandContext`, for the repository's web (ruling 230 item 3).
  core: ["./person-context"],
  auth: [".", "./client", "./e2e", "./server"],
  mcp: [],
  server: [
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
};

/**
 * The test seams every row's JavaScript builds as their inert modules, by
 * real module: `bundle.mjs`'s `testSeams`, the one list (ruling 193 item 2),
 * as its `inertSeams` maps them.
 */
const seams = {
  "packages/auth/src/e2e-email-outbox.ts":
    "apps/requestport/src/inert/e2e-email-outbox.ts",
  "apps/web/src/lib/e2e-scenario-fault.ts":
    "apps/requestport/src/inert/e2e-scenario-fault.ts",
  "packages/server/src/e2e-csp-fence.ts":
    "packages/server/src/inert/e2e-csp-fence.ts",
};

/**
 * The modules of `forbiddenModules` a package's own bundle may inline, by
 * that package (ruling 193 item 1); the list's other modules no bundle may.
 */
const publishedForbidden: Record<string, string[]> = {
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
};

/**
 * What each bundle's JavaScript imports from outside itself: the
 * third-party packages, and the `@requestport/*` specifiers.
 */
const javascriptImports: Record<
  BundleName,
  { thirdParty: string[]; siblings: string[] }
> = {
  domain: { thirdParty: ["uuid", "zod"], siblings: [] },
  notifications: {
    thirdParty: [
      "@react-email/components",
      "@react-email/render",
      "@slack/web-api",
      "react",
      "resend",
      "zod",
    ],
    siblings: ["@requestport/domain"],
  },
  webhooks: { thirdParty: ["uuid", "zod"], siblings: ["@requestport/domain"] },
  importer: {
    thirdParty: [
      "mdast-util-to-string",
      "remark-gfm",
      "remark-parse",
      "unified",
      "unist-util-visit",
    ],
    siblings: ["@requestport/domain"],
  },
  config: { thirdParty: ["zod"], siblings: [] },
  // None of `HOSTED_DRIVER_PACKAGES`: `db`'s row builds `hosted-driver.ts`
  // and `hosted-migrator.ts` as their public variants (ruling 194 item 3).
  db: {
    thirdParty: ["drizzle-orm", "uuid"],
    siblings: ["@requestport/domain", "@requestport/notifications/view-model"],
  },
  jobs: {
    thirdParty: ["@slack/web-api", "zod"],
    siblings: [
      "@requestport/config/logger",
      "@requestport/config/server-deferred",
      "@requestport/db",
      "@requestport/db/wiring",
      "@requestport/domain",
      "@requestport/importer",
      "@requestport/notifications",
      "@requestport/notifications/slack",
      "@requestport/notifications/view-model",
      "@requestport/webhooks",
    ],
  },
  core: {
    thirdParty: ["zod"],
    siblings: [
      "@requestport/db",
      "@requestport/db/migrate",
      "@requestport/domain",
      "@requestport/importer",
      "@requestport/jobs/catalogue",
      "@requestport/jobs/dispatch",
      "@requestport/jobs/worker",
      "@requestport/jobs/worker-storages",
      "@requestport/webhooks",
    ],
  },
  auth: {
    thirdParty: [
      "@better-auth/api-key",
      "@better-auth/cimd",
      "@better-auth/oauth-provider",
      "better-auth",
      "jose",
      "zod",
    ],
    siblings: [
      "@requestport/config/sign-in-methods",
      "@requestport/core/agent-services",
      "@requestport/db",
      "@requestport/domain",
    ],
  },
  mcp: {
    thirdParty: ["@modelcontextprotocol/server", "zod"],
    siblings: ["@requestport/domain"],
  },
  server: {
    thirdParty: ["zod"],
    siblings: [
      "@requestport/auth/auth-handler",
      "@requestport/core/adapters",
      "@requestport/db",
      "@requestport/domain",
      "@requestport/importer",
      "@requestport/mcp",
    ],
  },
};

/**
 * What each bundle's declarations import: the third-party packages, and the
 * `@requestport/*` specifiers.
 */
const declarationImports: Record<
  BundleName,
  { thirdParty: string[]; siblings: string[] }
> = {
  domain: { thirdParty: ["zod"], siblings: [] },
  notifications: {
    thirdParty: ["@slack/web-api", "react", "resend", "zod"],
    siblings: [],
  },
  webhooks: { thirdParty: [], siblings: ["@requestport/domain"] },
  importer: { thirdParty: [], siblings: [] },
  config: { thirdParty: ["zod"], siblings: [] },
  db: {
    thirdParty: ["drizzle-orm"],
    siblings: ["@requestport/domain", "@requestport/webhooks"],
  },
  jobs: {
    thirdParty: ["@slack/web-api"],
    siblings: ["@requestport/config/logger", "@requestport/db"],
  },
  core: {
    thirdParty: [],
    siblings: [
      "@requestport/db",
      "@requestport/db/migrate",
      "@requestport/domain",
      "@requestport/jobs/dispatch",
      "@requestport/webhooks",
    ],
  },
  // `@better-auth/core` is named by the declarations alone: the third source
  // of a packed manifest's dependencies (ruling 150).
  auth: {
    thirdParty: [
      "@better-auth/api-key",
      "@better-auth/core",
      "@better-auth/oauth-provider",
      "better-auth",
      "zod",
    ],
    siblings: [
      "@requestport/config/sign-in-methods",
      "@requestport/db",
      "@requestport/domain",
    ],
  },
  mcp: {
    thirdParty: ["@modelcontextprotocol/server"],
    siblings: ["@requestport/auth/create-auth", "@requestport/domain"],
  },
  server: {
    thirdParty: [],
    siblings: [
      "@requestport/auth/create-auth",
      "@requestport/core",
      "@requestport/db",
      "@requestport/domain",
    ],
  },
};

/**
 * Packages whose types no declaration may import (ruling 150): PGlite's,
 * the hosted driver's (`HOSTED_DRIVER_PACKAGES`; none in the public tree)
 * and `pg`'s.
 */
const driverTypes = [
  "@electric-sql/pglite",
  ...HOSTED_DRIVER_PACKAGES,
  "pg",
].sort();

type Built = {
  directory: string;
  metafile: Metafile;
  declarations: string[];
};

let root = "";
/** Where the eleven are laid out as an install. */
let install = "";
const built = new Map<BundleName, Built>();
const order = buildOrder() as BundleName[];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "requestport-bundle-"));
  install = join(root, "install");
  for (const name of order) {
    const directory = join(install, "node_modules", "@requestport", name);
    built.set(name, {
      directory,
      ...(await buildPackage(bundles[name], directory)),
    });
  }
}, 900_000);

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

function builtOf(name: BundleName): Built {
  const found = built.get(name);
  if (found === undefined) throw new Error(`${name} was not built`);
  return found;
}

/** The workspace directory of a row, from the repository's root. */
function directoryOf(bundle: PackageBundle): string {
  return `packages/${bundle.package.slice("@requestport/".length)}`;
}

function manifestOf(bundle: PackageBundle): {
  exports: string | Record<string, string>;
  dependencies?: Record<string, string>;
} {
  return JSON.parse(
    readFileSync(
      join(repositoryRoot, directoryOf(bundle), "package.json"),
      "utf8",
    ),
  );
}

function exportsOf(bundle: PackageBundle): Record<string, string> {
  const { exports } = manifestOf(bundle);
  return typeof exports === "string" ? { ".": exports } : exports;
}

const names = Object.keys(bundles) as BundleName[];

describe("the rows", () => {
  test("are ruling 175's eight packages and ruling 190's auth, mcp and server, none test-only; each of the eight leaves the other seven external, each of the three every other package bundles builds, and none inlines anything of another package's; every row names publicVariants, which builds db's shared-databases.ts, hosted-driver.ts and hosted-migrator.ts each as its .public.ts variant, and inertSeams, testSeams as a map, with which its JavaScript builds each test seam's real module as its inert module (ruling 193 item 2)", () => {
    expect([...packageSet].sort()).toEqual([
      "@requestport/config",
      "@requestport/core",
      "@requestport/db",
      "@requestport/domain",
      "@requestport/importer",
      "@requestport/jobs",
      "@requestport/notifications",
      "@requestport/webhooks",
    ]);
    expect(hostPackages).toEqual([
      "@requestport/auth",
      "@requestport/mcp",
      "@requestport/server",
    ]);
    expect(names).toEqual(
      [...packageSet, ...hostPackages].map((name) =>
        name.slice("@requestport/".length),
      ),
    );
    for (const name of names) {
      expect(bundles[name].package, name).toBe(`@requestport/${name}`);
      expect(bundles[name].inlines, name).toEqual([]);
    }
    for (const name of packageSet) {
      const row = bundles[name.slice("@requestport/".length) as BundleName];
      expect([...row.external].sort(), name).toEqual(
        packageSet.filter((other) => other !== name).sort(),
      );
      expect(row.declarations, name).toBe("packages/core/tsconfig.build.json");
    }
    for (const name of hostPackages) {
      const row = bundles[name.slice("@requestport/".length) as BundleName];
      expect([...row.external].sort(), name).toEqual(
        [...packageSet, ...hostPackages]
          .filter((other) => other !== name)
          .sort(),
      );
      expect(row.declarations, name).toBe(
        "packages/core/tsconfig.host-packages.json",
      );
    }
    expect(publicVariants).toEqual({
      "packages/db/src/shared-databases.ts":
        "packages/db/src/shared-databases.public.ts",
      "packages/db/src/hosted-driver.ts":
        "packages/db/src/hosted-driver.public.ts",
      "packages/db/src/hosted-migrator.ts":
        "packages/db/src/hosted-migrator.public.ts",
    });
    expect(inertSeams).toEqual(seams);
    expect(
      testSeams.map(({ name, real, inert }) => [name, real, inert]),
    ).toEqual([
      [
        "auth's E2E magic-link outbox",
        "packages/auth/src/e2e-email-outbox.ts",
        seams["packages/auth/src/e2e-email-outbox.ts"],
      ],
      [
        "apps/web's scenario-fault register",
        "apps/web/src/lib/e2e-scenario-fault.ts",
        seams["apps/web/src/lib/e2e-scenario-fault.ts"],
      ],
      [
        "the CSP's E2E fence",
        "packages/server/src/e2e-csp-fence.ts",
        seams["packages/server/src/e2e-csp-fence.ts"],
      ],
    ]);
    for (const name of names) {
      expect(bundles[name].publicVariants, name).toBe(publicVariants);
      expect(bundles[name].inertSeams, name).toBe(inertSeams);
    }
  });

  test("the forbidden-module list names each module with a reason, and the modules ruling 193 item 1 publishes are refused in every bundle but their own package's; the others in every bundle", () => {
    expect(
      forbiddenModules.filter(
        ({ reason }) => typeof reason !== "string" || reason.length === 0,
      ),
    ).toEqual([]);
    const scoped: Record<string, string[]> = {};
    for (const { module, publishedBy } of forbiddenModules) {
      if (publishedBy !== undefined) {
        scoped[publishedBy] = [...(scoped[publishedBy] ?? []), module].sort();
      }
    }
    expect(scoped).toEqual(publishedForbidden);
    for (const { module, publishedBy } of forbiddenModules) {
      expect(forbiddenModule(module), module).toBe(true);
      for (const name of [...packageSet, ...hostPackages]) {
        expect(forbiddenModule(module, name), `${module} in ${name}`).toBe(
          name !== publishedBy,
        );
      }
    }
    expect(forbiddenModules.map(({ module }) => module).sort()).toEqual(
      [
        "packages/config/src/client.ts",
        "packages/config/src/index.ts",
        "packages/db/src/testing.ts",
        ...Object.values(publishedForbidden).flat(),
      ].sort(),
    );
    expect(
      forbiddenModule("packages/db/src/client.test.ts", "@requestport/db"),
    ).toBe(true);
  });

  test("each entry is a subpath its source manifest exports, at the source it names, with its output named for it; the other subpaths are the ones pinned as unpublished", () => {
    const subpaths = Object.fromEntries(
      names.map((name) => [
        name,
        bundles[name].entries.map(({ subpath }) => subpath),
      ]),
    );
    expect(subpaths).toEqual(published);

    for (const name of names) {
      const bundle = bundles[name];
      const exports = exportsOf(bundle);
      for (const { subpath, name: file, source } of bundle.entries) {
        expect(
          join(directoryOf(bundle), exports[subpath] ?? "(not exported)"),
          `${name} ${subpath}`,
        ).toBe(source);
        expect(file, `${name} ${subpath}`).toBe(
          subpath === "." ? "index" : subpath.slice(2).replaceAll("/", "-"),
        );
      }
    }
    expect(
      Object.fromEntries(
        names.map((name) => [
          name,
          Object.keys(exportsOf(bundles[name]))
            .filter((subpath) => !published[name].includes(subpath))
            .sort(),
        ]),
      ),
    ).toEqual(unpublished);
  });
});

describe("the build order", () => {
  test("puts each row after every row whose package its source manifest names as a workspace: dependency, in manifest-g.md §3.1's order for S8, then auth, mcp and server", () => {
    const position = new Map(order.map((name, index) => [name, index]));
    const late: string[] = [];
    for (const name of names) {
      for (const [dependency, version] of Object.entries(
        manifestOf(bundles[name]).dependencies ?? {},
      )) {
        if (!version.startsWith("workspace:")) continue;
        const needed = position.get(
          dependency.slice("@requestport/".length) as BundleName,
        );
        const at = position.get(name);
        if (needed === undefined || at === undefined || needed >= at) {
          late.push(`${name} is not after ${dependency}`);
        }
      }
    }

    expect([...order].sort()).toEqual([...names].sort());
    expect(late).toEqual([]);
    expect(order).toEqual([
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
    ]);
  });

  test("refuses a workspace dependency that no row builds", () => {
    const { domain: _domain, ...withoutDomain } = bundles;

    expect(() => buildOrder(withoutDomain)).toThrow(
      "@requestport/notifications depends on @requestport/domain, and no bundle of the set builds it",
    );
  });

  test("takes, at each step, the first node in the given order whose dependencies are placed, and refuses a cycle", () => {
    expect(
      topologicalOrder([
        ["c", ["a"]],
        ["a", []],
        ["b", []],
      ]),
    ).toEqual(["a", "c", "b"]);
    expect(() =>
      topologicalOrder([
        ["a", ["b"]],
        ["b", ["c"]],
        ["c", ["a"]],
        ["d", []],
      ]),
    ).toThrow("a cycle among a, b, c");
  });
});

describe("buildPackage's refusal", () => {
  test("refuses a bundle with one sibling left out of external, which inlines that sibling's modules", {
    timeout: 300_000,
  }, async () => {
    const planted = {
      ...bundles.webhooks,
      external: bundles.webhooks.external.filter(
        (name) => name !== "@requestport/domain",
      ),
      declarations: undefined,
    };

    await expect(
      buildPackage(planted, join(root, "planted-webhooks")),
    ).rejects.toThrow(
      /^@requestport\/webhooks: inlines packages\/domain\/src\/[\w/.-]+\.ts, a module of @requestport\/domain(?:;|$)/u,
    );
  });

  test("refuses a bundle that imports a subpath no row publishes: server built without inertSeams, whose real CSP fence, which its host imports, imports auth's ./e2e, and whose JavaScript then holds that real module in place of the inert one", {
    timeout: 300_000,
  }, async () => {
    const planted = {
      ...bundles.server,
      inertSeams: {},
      declarations: undefined,
    };
    const directory = join(root, "planted-server-without-inert-seams");

    const refusal = await buildPackage(planted, directory).then(
      () => "built",
      (error: Error) => error.message,
    );
    expect(refusal).toBe(
      "@requestport/server: imports @requestport/auth/e2e, which @requestport/auth does not publish",
    );
    const javascript = readdirSync(join(directory, "dist"))
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFileSync(join(directory, "dist", file), "utf8"))
      .join("\n");
    expect(javascript).toContain("\n// packages/server/src/e2e-csp-fence.ts\n");
    expect(javascript).not.toContain(
      "\n// packages/server/src/inert/e2e-csp-fence.ts\n",
    );
  });

  test("reads the declarations too: a subpath no row publishes, and a package no row builds", async () => {
    const dist = join(root, "planted-declarations");
    mkdirSync(dist);
    writeFileSync(
      join(dist, "index.d.ts"),
      [
        'import type { TestStorage } from "@requestport/db/testing";',
        'export * from "@requestport/db";',
        'export type Theme = import("@requestport/theme").Theme;',
        "export type Test = TestStorage;",
      ].join("\n"),
    );
    const empty: Metafile = { inputs: {}, outputs: {} };

    expect(
      await siblingProblems(bundles.core, empty, dist, ["index.d.ts"]),
    ).toEqual([
      "imports @requestport/db/testing, which @requestport/db does not publish",
      "imports @requestport/theme, and no bundle builds @requestport/theme",
    ]);
  });
});

describe("each bundle", () => {
  test("writes every output, JavaScript and declarations, directly in dist/, with a .js and a .d.ts for each entry", () => {
    for (const name of names) {
      const { directory, metafile, declarations } = builtOf(name);
      const dist = join(directory, "dist");
      const written = readdirSync(dist, { withFileTypes: true });
      const javascript = Object.keys(metafile.outputs).map((output) =>
        resolve(repositoryRoot, output),
      );

      expect(
        written.filter((entry) => !entry.isFile()),
        name,
      ).toEqual([]);
      expect(
        javascript.filter((file) => dirname(file) !== dist),
        name,
      ).toEqual([]);
      expect(written.map((entry) => entry.name).sort(), name).toEqual(
        [
          ...javascript.map((file) => relative(dist, file)),
          ...declarations,
        ].sort(),
      );
      expect(
        written
          .map((entry) => entry.name)
          .filter((file) => !/^[\w-]+(?:\.d\.ts|\.js)$/u.test(file)),
        name,
      ).toEqual([]);
      for (const entry of bundles[name].entries) {
        expect(declarations, name).toContain(`${entry.name}.d.ts`);
        expect(existsSync(join(dist, `${entry.name}.js`)), name).toBe(true);
      }
    }
  });

  test("inlines exactly the modules a walk of its entries reaches at run time, each private module taken as its public variant and each seam's real module as its inert module, all in its own package or its inlines, none forbidden to it, none private, none a seam's real module, and nothing of the E2E owner storage; no output holds a seam's marker; server inlines the CSP fence's inert module, and the modules ruling 193 item 1 publishes are inlined by their own packages", () => {
    for (const name of names) {
      const bundle = bundles[name];
      const { metafile } = builtOf(name);
      const inputs = Object.keys(metafile.inputs).sort();
      const walk = runtimeWalk(bundle);

      expect(walk.unresolved, name).toEqual([]);
      expect(inputs, name).toEqual(walk.modules);
      expect(inputs.length, name).toBeGreaterThan(0);
      expect(
        inputs.filter(
          (path) =>
            !path.startsWith(`${directoryOf(bundle)}/src/`) &&
            !bundle.inlines.includes(path),
        ),
        name,
      ).toEqual([]);
      expect(
        inputs.filter((path) => forbiddenModule(path, bundle.package)),
        name,
      ).toEqual([]);
      expect(
        inputs.filter((path) => Object.hasOwn(publicVariants, path)),
        name,
      ).toEqual([]);
      expect(
        inputs.filter((path) => Object.hasOwn(seams, path)),
        name,
      ).toEqual([]);
      expect(
        outputFiles(builtOf(name)).flatMap((file) =>
          seamMarkersIn(readFileSync(file, "utf8")).map(
            ({ seam, marker }) =>
              `${relative(builtOf(name).directory, file)} holds ${seam.name} (${marker})`,
          ),
        ),
        name,
      ).toEqual([]);
      if (name === "db") {
        expect(inputs).toEqual(
          expect.arrayContaining([
            "packages/db/src/hosted-driver.public.ts",
            "packages/db/src/hosted-migrator.public.ts",
            "packages/db/src/shared-databases.public.ts",
          ]),
        );
      }
      expect(inputs, name).not.toContain(
        "packages/db/src/e2e-owner-storage.ts",
      );
      expect(
        outputFiles(builtOf(name)).filter((file) =>
          /createE2EOwnerStorage|E2E_OWNER_STORAGE_REFUSED|E2E owner storage/u.test(
            readFileSync(file, "utf8"),
          ),
        ),
        name,
      ).toEqual([]);
    }
    expect(
      names.flatMap((name) =>
        Object.keys(builtOf(name).metafile.inputs).filter((path) =>
          Object.values(seams).includes(path),
        ),
      ),
    ).toEqual(["packages/server/src/inert/e2e-csp-fence.ts"]);
    for (const [packed, modules] of Object.entries(publishedForbidden)) {
      const name = packed.slice("@requestport/".length) as BundleName;
      expect(
        modules.filter(
          (module) => !Object.hasOwn(builtOf(name).metafile.inputs, module),
        ),
        packed,
      ).toEqual([]);
    }
  });

  test("leaves to the consumer's install the pinned third-party packages, each one its source manifest declares, node: builtins, and the pinned sibling subpaths, each one a row publishes", () => {
    const measured = Object.fromEntries(
      names.map((name) => {
        const external = externalSpecifiers(builtOf(name).metafile).filter(
          (specifier) => !specifier.startsWith("node:"),
        );
        return [
          name,
          {
            thirdParty: [
              ...new Set(
                external
                  .filter((specifier) => !specifier.startsWith("@requestport/"))
                  .map(packageOf),
              ),
            ].sort(),
            siblings: external.filter((specifier) =>
              specifier.startsWith("@requestport/"),
            ),
          },
        ];
      }),
    );

    expect(measured).toEqual(javascriptImports);
    for (const name of names) {
      const declared = Object.keys(
        manifestOf(bundles[name]).dependencies ?? {},
      );
      expect(
        measured[name]?.thirdParty.filter(
          (dependency) => !declared.includes(dependency),
        ),
        name,
      ).toEqual([]);
      expect(
        measured[name]?.siblings.filter(
          (specifier) => !publishedSubpath(specifier),
        ),
        name,
      ).toEqual([]);
    }
  });

  test("bundles declarations that import the pinned sibling subpaths and third-party packages, node: builtins aside, each one its source manifest declares, and none of pg's, PGlite's or the hosted driver's types; whose //#region comments name its own modules by repository path, none a private module or a test seam's real module; that hold no doc comment of a private module that its public variant lacks; and no output holds a path of this machine", () => {
    const measured: Record<
      string,
      { thirdParty: string[]; siblings: string[] }
    > = {};
    const strayRegions: string[] = [];
    const relativeImports: string[] = [];
    // A module a declaration imports as a namespace gets no //#region of its
    // own (the control below), so the regions alone cannot show a private
    // module absent; its doc comments can.
    const privateText: string[] = [];
    for (const name of names) {
      const bundle = bundles[name];
      const { directory, declarations } = builtOf(name);
      const dist = join(directory, "dist");
      const bare = new Set<string>();
      let regions = 0;
      for (const file of declarations) {
        const text = readFileSync(join(dist, file), "utf8");
        for (const { module, comment } of privateDocComments()) {
          if (holdsDocComment(text, comment)) {
            privateText.push(`${name} ${file}: a doc comment of ${module}`);
          }
        }
        for (const specifier of declarationSpecifiers(text)) {
          if (specifier.startsWith(".")) {
            // A declaration chunk is imported by the `.js` name TypeScript
            // maps to it.
            if (
              !declarations.includes(
                specifier.replace(/^\.\/(.*)\.js$/u, "$1.d.ts"),
              )
            ) {
              relativeImports.push(`${name} ${file}: ${specifier}`);
            }
          } else {
            bare.add(specifier);
          }
        }
        for (const match of text.matchAll(/^\/\/#region (.*)$/gmu)) {
          regions += 1;
          const path = match[1] ?? "";
          const own = new RegExp(
            `^${directoryOf(bundle)}/src/[\\w/.-]+\\.d\\.ts$`,
            "u",
          );
          if (
            isAbsolute(path) ||
            path.split("/").includes("..") ||
            !(
              own.test(path) ||
              bundle.inlines.includes(path.replace(/\.d\.ts$/u, ".ts"))
            ) ||
            forbiddenModule(path.replace(/\.d\.ts$/u, ".ts"), bundle.package) ||
            Object.hasOwn(publicVariants, path.replace(/\.d\.ts$/u, ".ts")) ||
            Object.hasOwn(seams, path.replace(/\.d\.ts$/u, ".ts"))
          ) {
            strayRegions.push(`${name} ${file}: ${path}`);
          }
        }
      }
      expect(regions, name).toBeGreaterThan(0);
      measured[name] = {
        // `node:` builtins aside, as in the JavaScript's: `server`'s
        // declarations name `node:http`'s types, which `@types/node` gives.
        thirdParty: [
          ...new Set(
            [...bare]
              .filter(
                (specifier) =>
                  !specifier.startsWith("@requestport/") &&
                  !specifier.startsWith("node:"),
              )
              .map(packageOf),
          ),
        ].sort(),
        siblings: [...bare]
          .filter((specifier) => specifier.startsWith("@requestport/"))
          .sort(),
      };
    }

    expect(measured).toEqual(declarationImports);
    expect(strayRegions).toEqual([]);
    expect(privateText).toEqual([]);
    expect(relativeImports).toEqual([]);
    for (const name of names) {
      const declared = Object.keys(
        manifestOf(bundles[name]).dependencies ?? {},
      );
      expect(
        measured[name]?.thirdParty.filter(
          (dependency) => !declared.includes(dependency),
        ),
        name,
      ).toEqual([]);
      expect(
        measured[name]?.thirdParty.filter((dependency) =>
          driverTypes.includes(dependency),
        ),
        name,
      ).toEqual([]);
      expect(machinePathsIn(builtOf(name)), name).toEqual([]);
    }
  });

  test("the same check finds pg's, PGlite's and the hosted driver's types in a bundle of db's client.ts built with shared-databases.ts's variant alone, which exports the driver types db's entries do not", {
    timeout: 300_000,
  }, async () => {
    // Built with `bundles.db`'s variants, `client.ts`'s declarations would
    // reach `hosted-driver.public.ts`, which has no hosted driver, so the
    // control would show nothing of that driver's types.
    const shared = "packages/db/src/shared-databases.ts";
    const control = {
      ...bundles.db,
      publicVariants: { [shared]: publicVariants[shared] },
      entries: [
        {
          subpath: "./client",
          name: "client",
          source: "packages/db/src/client.ts",
        },
      ],
    };
    const directory = join(root, "control-db-client");
    const { declarations } = await buildBundle(control, directory);
    const found = new Set<string>();
    for (const file of declarations) {
      for (const specifier of declarationSpecifiers(
        readFileSync(join(directory, "dist", file), "utf8"),
      )) {
        if (!specifier.startsWith(".")) found.add(packageOf(specifier));
      }
    }

    expect(
      [...found].filter((name) => driverTypes.includes(name)).sort(),
    ).toEqual(driverTypes);
  });

  test("a declaration that imports db's private module shared-databases.ts as a namespace a type reads is bundled with the public variant's declarations in its place: built from core's test support, its declarations hold every doc comment of shared-databases.public.ts and none that only shared-databases.ts holds; built without publicVariants they hold every doc comment of the module at shared-databases.ts, and no //#region names it", {
    timeout: 300_000,
  }, async () => {
    const module = "packages/db/src/shared-databases.ts";
    const variant = publicVariants[module] ?? "(not in publicVariants)";
    const control = {
      ...bundles.db,
      entries: [
        {
          subpath: "./control",
          name: "control",
          source:
            "packages/core/test-support/declaration-reaches-private-module.ts",
        },
      ],
      declarations: "packages/core/tsconfig.private-module-control.json",
    };
    const declarationText = async (
      bundle: typeof control,
      directory: string,
    ) => {
      const { declarations } = await buildBundle(bundle, directory);
      expect(declarations.length, directory).toBeGreaterThan(0);
      return declarations
        .map((file) => readFileSync(join(directory, "dist", file), "utf8"))
        .join("\n");
    };
    const docComments = (path: string): string[] =>
      readFileSync(join(repositoryRoot, path), "utf8").match(
        /\/\*\*[\s\S]*?\*\//gu,
      ) ?? [];
    // In this tree, the module's two doc comments; in the public seed, whose
    // module is the variant, none.
    const moduleOnly = docComments(module).filter(
      (comment) => !docComments(variant).includes(comment),
    );
    expect(
      privateDocComments()
        .filter((found) => found.module === module)
        .map(({ comment }) => comment),
    ).toEqual(moduleOnly);
    const held = (text: string, comments: string[]) =>
      comments.filter((comment) => holdsDocComment(text, comment));
    const regions = (text: string) =>
      [...text.matchAll(/^\/\/#region (.*)$/gmu)].map(([, path]) => path);

    const built = await declarationText(
      control,
      join(root, "control-private-module"),
    );
    expect(docComments(variant).length).toBeGreaterThan(0);
    expect(held(built, docComments(variant))).toEqual(docComments(variant));
    expect(held(built, moduleOnly)).toEqual([]);

    const unsubstituted = await declarationText(
      { ...control, publicVariants: {} },
      join(root, "control-private-module-unsubstituted"),
    );
    expect(docComments(module).length).toBeGreaterThan(0);
    expect(held(unsubstituted, docComments(module))).toEqual(
      docComments(module),
    );
    expect(regions(unsubstituted)).not.toContain(
      module.replace(/\.ts$/u, ".d.ts"),
    );
  });

  test("has, for each entry, a bundled declaration file that exports exactly the names its source entry exports, types and values alike", () => {
    const compared = names.flatMap((name) => {
      const bundle = bundles[name];
      const dist = join(builtOf(name).directory, "dist");
      return bundle.entries.map(({ name: file, source }) => ({
        entry: `${name} ${file}`,
        bundled: exportNames(
          `${file}.d.ts`,
          "dts",
          (path) => readFileSync(join(dist, path), "utf8"),
          // A declaration chunk is imported by the `.js` name TypeScript
          // maps to it.
          (_from, specifier) =>
            /^\.\/[\w-]+\.js$/u.test(specifier)
              ? specifier.replace(/^\.\/(.*)\.js$/u, "$1.d.ts")
              : null,
        ),
        source: exportNames(
          source,
          "source",
          (path) => readFileSync(join(repositoryRoot, path), "utf8"),
          (from, specifier) => resolveSpecifier(bundle, from, specifier),
        ),
      }));
    });

    expect(compared.map(({ entry }) => entry)).toEqual(
      names.flatMap((name) =>
        bundles[name].entries.map(({ name: file }) => `${name} ${file}`),
      ),
    );
    for (const { entry, source } of compared) {
      expect(source.length, entry).toBeGreaterThan(0);
    }
    expect(
      compared.map(({ entry, bundled }) => ({ entry, names: bundled })),
    ).toEqual(compared.map(({ entry, source }) => ({ entry, names: source })));
  });
});

/**
 * The entries that parse `process.env` as they are imported, which the probe
 * imports after the others, each refusing the empty environment: `config`'s
 * `./server` (ruling 176), which ruling 193 item 1 publishes because
 * `requestport` imports it.
 */
const parsesAtImport = ["@requestport/config/server"];

describe("the eleven, laid out as an install", () => {
  test("loaded by Node with an empty environment from a directory with no node_modules above it, their entries but config's ./server read no variable in the packages' own code and add only their dependencies' globals; config's ./server, imported after them, refuses the empty environment; a storage from db's createStorage is one db's ./migrate's migrate accepts; and core's createStorage and migrate are db's own", {
    timeout: 300_000,
  }, () => {
    const set = order;
    const journal = JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/db/migrations/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    layOut(set);
    const probe = join(install, "probe.mjs");
    writeFileSync(probe, probeProgram(set));

    const above: string[] = [];
    for (
      let parent = dirname(realpathSync(install));
      parent !== dirname(parent);
      parent = dirname(parent)
    ) {
      if (existsSync(join(parent, "node_modules"))) above.push(parent);
    }
    expect(above).toEqual([]);

    const child = spawnSync(process.execPath, ["--no-warnings", probe], {
      cwd: install,
      env: {},
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
    });
    expect({ status: child.status, stderr: child.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    const report = JSON.parse(child.stdout) as {
      environment: string[];
      reads: Array<{ variable: string; reader: string; importing: string }>;
      globals: Record<string, string[]>;
      symbols: Record<string, string[]>;
      meet: unknown;
      same: unknown;
      refused: Record<string, string>;
    };
    const setReads: string[] = [];
    const dependencyReads = new Set<string>();
    const unattributed: string[] = [];
    // The packages whose code reads a variable while an entry of
    // `parsesAtImport` is imported, by that entry.
    const parsing: Record<string, string[]> = {};
    for (const { variable, reader, importing } of report.reads) {
      const location = reader
        .replace(/^at (?:.*? \()?/u, "")
        .replace(/\)$/u, "")
        .replace(/:\d+:\d+$/u, "");
      if (location.startsWith("node:")) continue;
      const path = location.startsWith("file:")
        ? fileURLToPath(location)
        : location;
      if (parsesAtImport.includes(importing)) {
        const reading = path.includes("/node_modules/")
          ? packageOf(path.split("/node_modules/").at(-1) ?? "")
          : reader;
        parsing[importing] = [
          ...new Set([...(parsing[importing] ?? []), reading]),
        ].sort();
      } else if (path.includes("/node_modules/@requestport/")) {
        setReads.push(
          `${path.split("/node_modules/").at(-1)} reads ${variable}, importing ${importing}`,
        );
      } else if (path.includes("/node_modules/")) {
        dependencyReads.add(
          `${packageOf(path.split("/node_modules/").at(-1) ?? "")} reads ${variable}, importing ${importing}`,
        );
      } else {
        unattributed.push(`${reader} reads ${variable}`);
      }
    }

    expect({
      environment: report.environment.filter(
        (name) => name !== "__CF_USER_TEXT_ENCODING",
      ),
      setReads,
      dependencyReads: [...dependencyReads].sort(),
      unattributed,
      globals: report.globals,
      symbols: report.symbols,
      meet: report.meet,
      same: report.same,
      refused: report.refused,
      parsing,
    }).toEqual({
      environment: [],
      setReads: [],
      // Better Auth's core reads the terminal's colour settings and
      // `NODE_ENV` as `auth`'s `./create-auth` loads it. No hosted driver's
      // package reads a variable: `db`'s bundle imports none (ruling 194
      // item 3), so `layOut` links none.
      dependencyReads: [
        ...[
          "CI",
          "COLORTERM",
          "FORCE_COLOR",
          "NODE_DISABLE_COLORS",
          "NODE_ENV",
          "NO_COLOR",
          "TEAMCITY_VERSION",
          "TERM",
          "TERM_PROGRAM",
          "TF_BUILD",
          "TMUX",
        ].map(
          (variable) =>
            `@better-auth/core reads ${variable}, importing @requestport/auth/create-auth`,
        ),
        "react reads NODE_ENV, importing @requestport/notifications",
      ],
      unattributed: [],
      // Each entry that adds anything (`import.test.ts` pins the same for
      // the source: zod's two, and `Prism`, which importing `jobs`' worker,
      // and so `notifications`' `.`, adds there; and `nanostoresGlobal`,
      // which importing `auth`'s `./create-auth` adds: `nanostores`, which
      // `better-auth` and `@better-auth/core` depend on).
      globals: {
        "@requestport/auth/create-auth": ["nanostoresGlobal"],
        "@requestport/domain": ["__zod_globalConfig", "__zod_globalRegistry"],
        "@requestport/notifications": ["Prism"],
      },
      symbols: {
        "@requestport/webhooks": ["Symbol(undici.globalDispatcher.1)"],
      },
      meet: {
        applied: journal.entries.map(({ tag }) => tag),
        ready: "ok",
      },
      same: { createStorage: true, migrate: true },
      refused: { "@requestport/config/server": "ZodError" },
      parsing: {
        "@requestport/config/server": ["@requestport/config", "zod"],
      },
    });
  });
});

/** Whether a `@requestport/*` specifier names a subpath a row publishes. */
function publishedSubpath(specifier: string): boolean {
  const name = packageOf(specifier);
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  return Object.values(bundles).some(
    (row) =>
      row.package === name &&
      row.entries.some((entry) => entry.subpath === subpath),
  );
}

/**
 * Every name a module exports, types and values alike, counted as
 * `published-types.test.ts`'s `exportNames` counts them over tsc's
 * declarations, and read here from a module's source (`kind` "source",
 * parsed as TSX for a `.tsx` file and as TypeScript otherwise) or from a
 * bundled declaration file (`kind` "dts"): the declarations it exports, the
 * names its `export { … }` lists give, a name an `export * as` gives, and
 * every name of the module each of its relative `export *` names, which
 * `resolve` finds from `path`. `read` gives a module's text by its path. An
 * `export *` of anything else is not followed: it is returned as
 * `* from <specifier>`, so that a comparison shows it. A default export, or
 * TypeScript's `export =`, is not read here, and throws.
 */
function exportNames(
  path: string,
  kind: "source" | "dts",
  read: (path: string) => string,
  resolve: (from: string, specifier: string) => string | null | undefined,
): string[] {
  const lang = kind === "dts" ? "dts" : path.endsWith(".tsx") ? "tsx" : "ts";
  const program = parseAst(read(path), { lang }) as unknown as AstNode;
  const names = new Set<string>();
  for (const node of program.body as AstNode[]) {
    if (node.type === "ExportNamedDeclaration") {
      if (isNode(node.declaration)) {
        for (const name of declaredNames(node.declaration)) names.add(name);
      }
      for (const specifier of node.specifiers as AstNode[]) {
        names.add(nameOf(specifier.exported));
      }
    } else if (node.type === "ExportAllDeclaration") {
      const specifier = literal(node.source) ?? "";
      const target = specifier.startsWith(".")
        ? resolve(path, specifier)
        : undefined;
      if (isNode(node.exported)) names.add(nameOf(node.exported));
      else if (typeof target !== "string") names.add(`* from ${specifier}`);
      else {
        for (const name of exportNames(target, kind, read, resolve)) {
          names.add(name);
        }
      }
    } else if (
      node.type === "ExportDefaultDeclaration" ||
      node.type === "TSExportAssignment" ||
      node.type === "TSNamespaceExportDeclaration"
    ) {
      throw new Error(`${path}: a ${node.type} is not read here`);
    }
  }
  return [...names].sort();
}

/** The names a declaration an `export` writes binds. */
function declaredNames(declaration: AstNode): string[] {
  return declaration.type === "VariableDeclaration"
    ? (declaration.declarations as AstNode[]).map((declarator) =>
        nameOf(declarator.id),
      )
    : [nameOf(declaration.id)];
}

/** An identifier's name, or a string literal's value. */
function nameOf(node: unknown): string {
  if (isNode(node) && typeof node.name === "string") return node.name;
  if (isNode(node) && typeof node.value === "string") return node.value;
  throw new Error(`no name on ${isNode(node) ? node.type : String(node)}`);
}

/** The package a bare specifier, or a path below `node_modules/`, names. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return (
    specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)
  ).join("/");
}

/** Every specifier a bundle's JavaScript imports from outside itself. */
function externalSpecifiers(metafile: Metafile): string[] {
  return [
    ...new Set(
      Object.values(metafile.outputs).flatMap(({ imports }) =>
        imports.filter(({ external }) => external).map(({ path }) => path),
      ),
    ),
  ].sort();
}

/** Every file a build wrote. */
function outputFiles(built: Built): string[] {
  const dist = join(built.directory, "dist");
  return readdirSync(dist).map((name) => join(dist, name));
}

/**
 * Each of this machine's paths that a built file holds: the repository's,
 * the temporary directory's, and the home directory's.
 */
function machinePathsIn(built: Built): string[] {
  const paths = [
    repositoryRoot.replace(/\/$/u, ""),
    tmpdir(),
    realpathSync(tmpdir()),
    homedir(),
  ];
  return outputFiles(built).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return paths
      .filter((path) => text.includes(path))
      .map((path) => `${relative(built.directory, file)} holds ${path}`);
  });
}

/* A loose view of the ESTree that `parseAst` returns. */
type AstNode = { type: string } & Record<string, unknown>;

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function* descendants(node: AstNode): Generator<AstNode> {
  yield node;
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child)) yield* descendants(child);
    }
  }
}

function literal(node: unknown): string | undefined {
  return isNode(node) && typeof node.value === "string"
    ? node.value
    : undefined;
}

/** Every specifier a declaration file imports or re-exports, or names in `import("…")`. */
function declarationSpecifiers(text: string): string[] {
  const program = parseAst(text, { lang: "dts" }) as unknown as AstNode;
  const found: string[] = [];
  for (const node of descendants(program)) {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "TSImportType"
    ) {
      const specifier = literal(node.source);
      if (specifier !== undefined) found.push(specifier);
    }
  }
  return found;
}

/**
 * The modules a bundle's entries reach at run time, walked from their
 * sources: every import and re-export that is not type-only, and every
 * `import(…)` of a string literal, followed through relative paths and
 * through each `@requestport/*` workspace's `exports`, but those of a
 * package the bundle leaves external, each private module the bundle names
 * in `publicVariants` taken as its public variant, and each seam's real
 * module it names in `inertSeams` as its inert module. A third-party or `node:`
 * specifier ends the walk. An `import(…)` of anything but a literal, or a
 * specifier that resolves to nothing, is `unresolved`.
 */
function runtimeWalk(bundle: PackageBundle): {
  modules: string[];
  unresolved: string[];
} {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const queue = bundle.entries.map(({ source }) => source);
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (seen.has(path)) continue;
    seen.add(path);
    for (const specifier of runtimeSpecifiers(path, unresolved)) {
      const target = resolveSpecifier(bundle, path, specifier);
      if (target === null) unresolved.push(`${path}: ${specifier}`);
      else if (target !== undefined) {
        queue.push(
          bundle.publicVariants[target] ?? bundle.inertSeams[target] ?? target,
        );
      }
    }
  }
  return { modules: [...seen].sort(), unresolved };
}

function runtimeSpecifiers(path: string, unresolved: string[]): string[] {
  const program = parseAst(readFileSync(join(repositoryRoot, path), "utf8"), {
    lang: path.endsWith(".tsx") ? "tsx" : "ts",
  }) as unknown as AstNode;
  const specifiers: string[] = [];
  const typeOnly = (node: AstNode, kind: "importKind" | "exportKind") => {
    const listed = Array.isArray(node.specifiers)
      ? (node.specifiers as AstNode[])
      : [];
    return (
      node[kind] === "type" ||
      (listed.length > 0 &&
        listed.every((specifier) => specifier[kind] === "type"))
    );
  };
  for (const node of descendants(program)) {
    if (node.type === "ImportDeclaration" && !typeOnly(node, "importKind")) {
      specifiers.push(literal(node.source) ?? "");
    } else if (
      (node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source !== null &&
      node.source !== undefined &&
      !typeOnly(node, "exportKind")
    ) {
      specifiers.push(literal(node.source) ?? "");
    } else if (node.type === "ImportExpression") {
      const specifier = literal(node.source);
      if (specifier === undefined) unresolved.push(`${path}: import(…)`);
      else specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * A module's path from the repository's root; `undefined` when the
 * specifier leaves the bundle; `null` when it resolves to nothing.
 */
function resolveSpecifier(
  bundle: PackageBundle,
  from: string,
  specifier: string,
): string | null | undefined {
  if (specifier.startsWith(".")) {
    const base = join(dirname(from), specifier);
    return (
      [
        base.replace(/\.js$/u, ".ts"),
        base.replace(/\.js$/u, ".tsx"),
        join(base, "index.ts"),
      ].find(
        (candidate) =>
          /\.tsx?$/u.test(candidate) &&
          existsSync(join(repositoryRoot, candidate)),
      ) ?? null
    );
  }
  const name = packageOf(specifier);
  if (!name.startsWith("@requestport/") || bundle.external.includes(name)) {
    return undefined;
  }
  const directory = `packages/${name.slice("@requestport/".length)}`;
  const { exports } = JSON.parse(
    readFileSync(join(repositoryRoot, directory, "package.json"), "utf8"),
  ) as { exports: string | Record<string, string> };
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  const target =
    typeof exports === "string"
      ? subpath === "."
        ? exports
        : undefined
      : exports[subpath];
  return target === undefined ? null : join(directory, target);
}

/**
 * Lays the packages of `set` out as an install under `install`: beside each
 * package's `dist/`, a manifest whose `exports` name its entries'
 * JavaScript; `db`'s `migrations/`, the SQL files and the journal; in
 * `install/node_modules/` a link to each third-party package their
 * JavaScript imports and to the optional PGlite peer, resolved from the first
 * workspace of `set` that has it; and under a package's own `node_modules/`
 * a link to each it imports whose copy in its own workspace is another than
 * that one, as an install nests a version the top does not hold (`auth`'s
 * `zod`).
 */
function layOut(set: readonly BundleName[]) {
  const thirdParty = new Set(["@electric-sql/pglite"]);
  for (const name of set) {
    const bundle = bundles[name];
    const { directory, metafile } = builtOf(name);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: bundle.package,
        private: true,
        type: "module",
        exports: Object.fromEntries(
          bundle.entries.map(({ subpath, name: file }) => [
            subpath,
            `./dist/${file}.js`,
          ]),
        ),
      }),
    );
    for (const specifier of externalSpecifiers(metafile)) {
      if (
        !specifier.startsWith("node:") &&
        !specifier.startsWith("@requestport/")
      ) {
        thirdParty.add(packageOf(specifier));
      }
    }
  }

  const migrations = join(repositoryRoot, "packages/db/migrations");
  const copied = join(builtOf("db").directory, "migrations");
  mkdirSync(join(copied, "meta"), { recursive: true });
  for (const file of readdirSync(migrations)) {
    if (file.endsWith(".sql"))
      cpSync(join(migrations, file), join(copied, file));
  }
  cpSync(
    join(migrations, "meta", "_journal.json"),
    join(copied, "meta", "_journal.json"),
  );

  for (const name of [...thirdParty].sort()) {
    const installed = set
      .map((workspace) =>
        join(
          repositoryRoot,
          directoryOf(bundles[workspace]),
          "node_modules",
          name,
        ),
      )
      .find((candidate) => existsSync(candidate));
    if (installed === undefined) throw new Error(`${name} is not installed`);
    const link = join(install, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(installed), link);
  }

  for (const name of set) {
    const { directory, metafile } = builtOf(name);
    for (const specifier of externalSpecifiers(metafile)) {
      if (
        specifier.startsWith("node:") ||
        specifier.startsWith("@requestport/")
      ) {
        continue;
      }
      const dependency = packageOf(specifier);
      const own = join(
        repositoryRoot,
        directoryOf(bundles[name]),
        "node_modules",
        dependency,
      );
      const link = join(directory, "node_modules", dependency);
      if (
        !existsSync(own) ||
        existsSync(link) ||
        realpathSync(own) ===
          realpathSync(join(install, "node_modules", dependency))
      ) {
        continue;
      }
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(realpathSync(own), link);
    }
  }
}

/**
 * The program the child runs, from `install`: it imports each entry of each
 * package of `set` but those of `parsesAtImport`, in that order, by its
 * package's name, with `process.env` replaced by a proxy that records each
 * read with the first frame outside this program, and records the globals
 * and symbols each import adds; then it builds a PGlite storage in memory
 * with `db`'s `createStorage`, migrates it with `db`'s `./migrate`'s
 * `migrate`, checks it is ready, and closes it; and it compares core's
 * `createStorage` and `migrate` with `db`'s. Last, it imports each entry of
 * `parsesAtImport`, recording its reads the same way, and the name of the
 * error it throws (`refused`). It writes one line of JSON.
 */
function probeProgram(set: readonly BundleName[]): string {
  const all = set.flatMap((name) =>
    bundles[name].entries.map(({ subpath }) =>
      subpath === "."
        ? bundles[name].package
        : `${bundles[name].package}${subpath.slice(1)}`,
    ),
  );
  const specifiers = all.filter(
    (specifier) => !parsesAtImport.includes(specifier),
  );
  const last = all.filter((specifier) => parsesAtImport.includes(specifier));
  return [
    "const environment = Object.keys(process.env);",
    "const reads = [];",
    "let importing;",
    "const record = (variable) => {",
    '  const frames = new Error().stack.split("\\n").slice(1).map((frame) => frame.trim());',
    '  const reader = frames.find((frame) => !frame.includes("probe.mjs"));',
    '  reads.push({ variable, reader: reader ?? "", importing });',
    "};",
    "const original = process.env;",
    "const recording = new Proxy(original, {",
    '  get(target, key, receiver) { if (typeof key === "string") record(key); return Reflect.get(target, key, receiver); },',
    '  has(target, key) { if (typeof key === "string") record(key); return Reflect.has(target, key); },',
    '  ownKeys(target) { record("(its names)"); return Reflect.ownKeys(target); },',
    '  getOwnPropertyDescriptor(target, key) { if (typeof key === "string") record(key); return Reflect.getOwnPropertyDescriptor(target, key); },',
    "});",
    "const globals = {};",
    "const symbols = {};",
    "const modules = {};",
    `for (const specifier of ${JSON.stringify(specifiers)}) {`,
    "  const names = new Set(Object.getOwnPropertyNames(globalThis));",
    "  const own = new Set(Object.getOwnPropertySymbols(globalThis));",
    "  importing = specifier;",
    "  process.env = recording;",
    "  modules[specifier] = await import(specifier);",
    "  process.env = original;",
    "  const added = Object.getOwnPropertyNames(globalThis).filter((name) => !names.has(name)).sort();",
    "  const addedSymbols = Object.getOwnPropertySymbols(globalThis).filter((symbol) => !own.has(symbol)).map(String);",
    "  if (added.length > 0) globals[specifier] = added;",
    "  if (addedSymbols.length > 0) symbols[specifier] = addedSymbols;",
    "}",
    "let meet;",
    "try {",
    '  const storage = modules["@requestport/db"].createStorage({ driver: "pglite", dataDir: "memory://" });',
    "  try {",
    '    const report = await modules["@requestport/db/migrate"].migrate(storage);',
    "    await storage.ready();",
    '    meet = { applied: report.applied.map(({ tag }) => tag), ready: "ok" };',
    "  } finally {",
    "    await storage.close();",
    "  }",
    "} catch (error) {",
    "  meet = { threw: error.message };",
    "}",
    "const same = {",
    '  createStorage: modules["@requestport/core"].createStorage === modules["@requestport/db"].createStorage,',
    '  migrate: modules["@requestport/core/migrate"].migrate === modules["@requestport/db/migrate"].migrate,',
    "};",
    "const refused = {};",
    `for (const specifier of ${JSON.stringify(last)}) {`,
    "  importing = specifier;",
    "  process.env = recording;",
    "  try {",
    "    await import(specifier);",
    '    refused[specifier] = "nothing";',
    "  } catch (error) {",
    "    refused[specifier] = error.name;",
    "  } finally {",
    "    process.env = original;",
    "  }",
    "}",
    "process.stdout.write(JSON.stringify({ environment, reads, globals, symbols, meet, same, refused }));",
  ].join("\n");
}
