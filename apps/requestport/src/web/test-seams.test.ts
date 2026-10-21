import { spawnSync } from "node:child_process";
import {
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
import { join, resolve } from "node:path";

import type * as RealOutbox from "@requestport/auth/e2e";
import type * as RealFence from "@requestport/server/e2e-csp-fence";
import { afterEach, describe, expect, test } from "vitest";

import {
  publicVariants,
  testOnlyModule,
  testSeams,
} from "../../../../packages/core/bundle.mjs";
import * as inertFence from "../../../../packages/server/src/inert/e2e-csp-fence.js";
import type * as RealRegister from "../../../web/src/lib/e2e-scenario-fault.js";
import * as inertOutbox from "../inert/e2e-email-outbox.js";
import * as inertRegister from "../inert/e2e-scenario-fault.js";
import { selfHostSeamsPreload } from "./self-host-build.js";
import {
  InertSeamsWebpackPlugin,
  inertSeamLoaderPath,
  installNextConfigHook,
  type ModuleClassLike,
  seamMarkersIn,
  seamReplacements,
  selfHostReplacements,
  TEST_SEAMS,
  withInertSeams,
} from "./test-seams.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const read = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");

/** A JavaScript or TypeScript module, by its file name. */
const MODULE = /\.[cm]?[jt]sx?$/u;

/**
 * The repository's source, with its text: every module under the `src` of a
 * workspace in `apps` or `packages`, but a test, test support or the
 * sweep's ledger (G's `testOnlyModule`). Each by its path from the
 * repository's root. The seams' list, which holds every marker, is
 * `packages/core/bundle.mjs`'s, outside every `src` (ruling 193 item 2).
 */
function sourceModules(): Map<string, string> {
  const modules = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(repositoryRoot, directory), {
      withFileTypes: true,
    })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (MODULE.test(entry.name) && !testOnlyModule(path)) {
        modules.set(path, read(path));
      }
    }
  };
  for (const top of ["apps", "packages"]) {
    for (const workspace of readdirSync(join(repositoryRoot, top), {
      withFileTypes: true,
    })) {
      const src = `${top}/${workspace.name}/src`;
      if (workspace.isDirectory() && existsSync(join(repositoryRoot, src))) {
        walk(src);
      }
    }
  }
  return modules;
}

/**
 * E2E mode's own variables, two of the outbox's markers, to the modules of
 * `sourceModules` that hold them: the outbox's predicate reads both, and
 * other E2E modules hold them too (measured in H.7, round 4, slice a).
 */
const E2E_MODE_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  REQUESTPORT_E2E_MODE: [
    "apps/web/src/lib/e2e-owner-storage.ts",
    "apps/web/src/lib/e2e-scenario-fault.ts",
    "apps/web/src/lib/e2e-scenario.ts",
    "packages/auth/src/e2e-email-outbox.ts",
    "packages/db/src/e2e-owner-storage.ts",
    "packages/server/src/e2e-csp-fence.ts",
  ],
  REQUESTPORT_E2E_TOKEN: [
    "apps/web/src/lib/e2e-scenario.ts",
    "apps/web/src/test/fake-email-outbox.ts",
    "packages/auth/src/e2e-email-outbox.ts",
    "packages/server/src/e2e-csp-fence.ts",
  ],
};

/** Each seam's marker, to the modules of `sourceModules` that hold it, sorted. */
function markerHolders(): Record<string, string[]> {
  const modules = [...sourceModules()];
  return Object.fromEntries(
    TEST_SEAMS.flatMap(({ markers }) => markers).map((marker) => [
      marker,
      modules
        .filter(([, text]) => text.includes(marker))
        .map(([path]) => path)
        .sort(),
    ]),
  );
}

// Each inert export has a type its real namesake's importers accept: tsc
// checks these three assignments.
const outboxConforms: Pick<typeof RealOutbox, keyof typeof inertOutbox> =
  inertOutbox;
const registerConforms: Pick<typeof RealRegister, keyof typeof inertRegister> =
  inertRegister;
const fenceConforms: Pick<typeof RealFence, keyof typeof inertFence> =
  inertFence;

const E2E_MODE = {
  NODE_ENV: "test",
  REQUESTPORT_E2E_MODE: "1",
  REQUESTPORT_E2E_TOKEN: "t".repeat(32),
};
const NAMESPACE = "00000000-0000-4000-8000-000000000000";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TEST_SEAMS (ruling 174)", () => {
  test("is packages/core/bundle.mjs's testSeams, the one list (ruling 193 item 2), and names the outbox, the fault register and the CSP fence, each a real module, its inert module (the outbox's and the register's under apps/requestport/src/inert, the fence's beside its real module in packages/server, whose bundle builds it), and markers", () => {
    expect(TEST_SEAMS).toBe(testSeams);
    expect(TEST_SEAMS.map(({ real, inert }) => [real, inert])).toEqual([
      [
        "packages/auth/src/e2e-email-outbox.ts",
        "apps/requestport/src/inert/e2e-email-outbox.ts",
      ],
      [
        "apps/web/src/lib/e2e-scenario-fault.ts",
        "apps/requestport/src/inert/e2e-scenario-fault.ts",
      ],
      [
        "packages/server/src/e2e-csp-fence.ts",
        "packages/server/src/inert/e2e-csp-fence.ts",
      ],
    ]);
    for (const { markers } of TEST_SEAMS)
      expect(markers.length).toBeGreaterThan(0);
  });

  test("each real module holds every one of its markers, its own path among them; no inert module holds any seam's marker", () => {
    for (const seam of TEST_SEAMS) {
      const source = read(seam.real);
      for (const marker of seam.markers) {
        if (marker === seam.real) continue;
        expect(source, `${seam.real} holds ${marker}`).toContain(marker);
      }
      expect(seam.markers).toContain(seam.real);
    }
    for (const { inert } of TEST_SEAMS) {
      expect(seamMarkersIn(read(inert)), inert).toEqual([]);
    }
  });

  test("of the repository's source, each seam's marker is held by its real module alone and a path by no module, but E2E mode's two variables, the outbox's markers, which the outbox and the other E2E modules hold (ruling 190, minor 2)", () => {
    expect(markerHolders()).toEqual(
      Object.fromEntries(
        TEST_SEAMS.flatMap((seam) =>
          seam.markers.map((marker) => [
            marker,
            E2E_MODE_VARIABLES[marker] ??
              (marker === seam.real ? [] : [seam.real]),
          ]),
        ),
      ),
    );
    expect(TEST_SEAMS[0]?.markers).toEqual(
      expect.arrayContaining(Object.keys(E2E_MODE_VARIABLES)),
    );
  });

  test("seamMarkersIn names each seam and marker a text holds", () => {
    expect(seamMarkersIn("nothing here")).toEqual([]);
    expect(
      seamMarkersIn(
        'Symbol.for("requestport.e2e.scenario-runs");a.REQUESTPORT_E2E_MODE',
      ).map(({ seam, marker }) => [seam.name, marker]),
    ).toEqual([
      ["auth's E2E magic-link outbox", "REQUESTPORT_E2E_MODE"],
      ["apps/web's scenario-fault register", "requestport.e2e.scenario-runs"],
    ]);
  });

  test("host.ts and apps/web's proxy.ts read the CSP's E2E fence through its real module, and neither imports auth's E2E module itself", () => {
    const host = read("packages/server/src/host.ts");
    const proxy = read("apps/web/src/proxy.ts");
    expect(host).toContain(
      'import { isE2ECspFenceOpen } from "./e2e-csp-fence.js";',
    );
    expect(proxy).toContain(
      'import { isE2ECspFenceOpen } from "@requestport/server/e2e-csp-fence";',
    );
    for (const source of [host, proxy]) {
      expect(source).not.toContain("@requestport/auth/e2e");
      expect(source).not.toContain("isE2EEmailMode(");
      expect(source).toContain("!isE2ECspFenceOpen(process.env) &&");
    }
  });
});

describe("the inert modules, in E2E mode's own environment", () => {
  test("the outbox: the E2E predicate is false, and capturing, reading and clearing refuse", () => {
    expect(inertOutbox.isE2EEmailMode(E2E_MODE)).toBe(false);
    expect(inertOutbox.isE2EEmailMode()).toBe(false);
    expect(() =>
      inertOutbox.captureE2EMagicLink(
        { email: "a@example.com", url: "https://x.invalid" },
        E2E_MODE,
      ),
    ).toThrow("This build of RequestPort has no test outbox.");
    expect(() =>
      inertOutbox.readE2EMagicLink("a@example.com", E2E_MODE),
    ).toThrow("This build of RequestPort has no test outbox.");
    expect(() => inertOutbox.clearE2EMagicLinks(E2E_MODE)).toThrow(
      "This build of RequestPort has no test outbox.",
    );
  });

  test("the register: a registered run is not active, no cookie names a run, no request is inside a fault, and every effect is none", async () => {
    inertRegister.registerE2EScenarioRun(NAMESPACE, "error", E2E_MODE);
    expect(inertRegister.isE2EScenarioRunActive(NAMESPACE, E2E_MODE)).toBe(
      false,
    );
    expect(
      inertRegister.e2eScenarioFaultFor({
        cookieHeader: `requestport.e2e_scenario=${NAMESPACE}`,
        env: E2E_MODE,
      }),
    ).toBeNull();
    expect(
      inertRegister.e2eScenarioNamespaceFrom(
        `requestport.e2e_scenario=${NAMESPACE}`,
      ),
    ).toBeNull();
    expect(
      inertRegister.e2eScenarioReadEffect({
        fault: "error",
        isActionDispatch: false,
      }),
    ).toBe("none");
    expect(inertRegister.e2eScenarioAppearanceEffect("global_error")).toBe(
      "none",
    );
    expect(
      inertRegister.e2eScenarioProviderEffect("provider_unavailable"),
    ).toBe("none");
    expect(
      await inertRegister.waitForE2EScenarioRelease(NAMESPACE, {
        env: E2E_MODE,
      }),
    ).toBe("released");
    inertRegister.releaseE2EScenarioRun(NAMESPACE, E2E_MODE);
    inertRegister.forgetE2EScenarioRuns(E2E_MODE);
  });

  test("the fence is never open", () => {
    expect(inertFence.isE2ECspFenceOpen(E2E_MODE)).toBe(false);
    expect(inertFence.isE2ECspFenceOpen()).toBe(false);
  });

  test("each exports only names its real module exports", async () => {
    const real = {
      outbox: await import("@requestport/auth/e2e"),
      register: await import("../../../web/src/lib/e2e-scenario-fault.js"),
      fence: await import("@requestport/server/e2e-csp-fence"),
    };
    for (const [inert, actual] of [
      [inertOutbox, real.outbox],
      [inertRegister, real.register],
      [inertFence, real.fence],
    ] as const) {
      expect(Object.keys(actual)).toEqual(
        expect.arrayContaining(Object.keys(inert)),
      );
    }
    expect([outboxConforms, registerConforms, fenceConforms]).toHaveLength(3);
  });
});

describe("seamReplacements", () => {
  test("maps each real module's absolute path to its inert module's", () => {
    const replacements = seamReplacements(repositoryRoot);
    for (const { real, inert } of TEST_SEAMS) {
      expect(replacements.get(join(repositoryRoot, real))).toBe(
        join(repositoryRoot, inert),
      );
    }
  });
});

describe("selfHostReplacements (ruling 193 item 5)", () => {
  test("is seamReplacements' entries, and each private module of packages/core/bundle.mjs's publicVariants, by its absolute and its resolved path, to its public variant's: db's shared databases, whose digests the self-host build would otherwise compile into its chunks, and its hosted driver and that driver's migrator (ruling 194 item 3), whose driver it would", () => {
    const replacements = selfHostReplacements(repositoryRoot);
    const seams = seamReplacements(repositoryRoot);
    expect(publicVariants).toEqual({
      "packages/db/src/shared-databases.ts":
        "packages/db/src/shared-databases.public.ts",
      "packages/db/src/hosted-driver.ts":
        "packages/db/src/hosted-driver.public.ts",
      "packages/db/src/hosted-migrator.ts":
        "packages/db/src/hosted-migrator.public.ts",
    });
    const expected = new Map(seams);
    for (const [module, variant] of Object.entries(publicVariants)) {
      const path = join(repositoryRoot, module);
      expected.set(path, join(repositoryRoot, variant));
      expected.set(realpathSync(path), join(repositoryRoot, variant));
    }
    expect(new Map(replacements)).toEqual(expected);
  });

  test("the plugin given it puts the loader, with the public variant, in db's private module's chain, and the loader answers the variant's text", () => {
    const plugin = new InertSeamsWebpackPlugin(
      selfHostReplacements(repositoryRoot),
    );
    const { compiler, resolve: resolved } = fakeCompiler();
    plugin.apply(compiler);
    const resource = join(
      repositoryRoot,
      "packages/db/src/shared-databases.ts",
    );
    const variant = join(
      repositoryRoot,
      "packages/db/src/shared-databases.public.ts",
    );
    expect(
      resolved({ resource, request: resource, loaders: [] }).loaders,
    ).toEqual([
      {
        loader: inertSeamLoaderPath(),
        options: { inert: variant },
        ident: "requestport-inert-seam",
      },
    ]);
    expect([...plugin.replaced]).toEqual([resource]);
    const loader = createRequire(import.meta.url)(inertSeamLoaderPath()) as (
      this: unknown,
      source: string,
    ) => string;
    expect(
      loader.call(
        { getOptions: () => ({ inert: variant }), addDependency: () => {} },
        read("packages/db/src/shared-databases.ts"),
      ),
    ).toBe(read("packages/db/src/shared-databases.public.ts"));
  });

  test("self-host-seams.ts, preloaded into a process of its own as next build is, gives the configuration Next compiles there a plugin built from it, which replaces each of db's three private modules, and says so on exit", () => {
    const directory = mkdtempSync(join(tmpdir(), "requestport-preload-"));
    directories.push(directory);
    const resources = [
      join(repositoryRoot, "packages/auth/src/e2e-email-outbox.ts"),
      join(repositoryRoot, "packages/db/src/shared-databases.ts"),
      join(repositoryRoot, "packages/db/src/hosted-driver.ts"),
      join(repositoryRoot, "packages/db/src/hosted-migrator.ts"),
      join(repositoryRoot, "packages/db/src/database-url.ts"),
    ];
    // What Next does with apps/web's configuration (`installNextConfigHook`'s
    // comment), then what webpack does with each resource it resolves.
    const script = [
      'const Module = require("node:module");',
      'const file = require("node:path").join(process.cwd(), "next.config.compiled.js");',
      "const config = new Module(file);",
      'config._compile("module.exports = { output: \\"standalone\\" };", file);',
      "const [plugin] = config.exports.webpack({ plugins: [] }, {}).plugins;",
      "const taps = [];",
      "plugin.apply({ hooks: { normalModuleFactory: { tap: (_, f) => f({ hooks: { afterResolve: { tap: (_, g) => taps.push(g) } } }) } } });",
      "for (const resource of JSON.parse(process.env.RESOURCES)) for (const tap of taps) tap({ createData: { resource, request: resource, loaders: [] } });",
      "process.stdout.write(JSON.stringify([...plugin.replacements]));",
    ].join("\n");
    const run = spawnSync(
      process.execPath,
      ["--import", selfHostSeamsPreload(), "-e", script],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, RESOURCES: JSON.stringify(resources) },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(new Map(JSON.parse(run.stdout))).toEqual(
      new Map(selfHostReplacements(repositoryRoot)),
    );
    expect(run.stderr).toBe(
      "requestport self-host build: the inert test seams and the private modules' public variants were given to 1 next.config load(s); modules replaced: packages/auth/src/e2e-email-outbox.ts, packages/db/src/hosted-driver.ts, packages/db/src/hosted-migrator.ts, packages/db/src/shared-databases.ts\n",
    );
  });

  test("self-host-seams.ts, with SELF_HOST_CONTAINED_VARIABLE naming a directory, gives that configuration the recorder after the plugin, and the recorder takes a module as replaced by the plugin's builtFromReplacement: a private module the plugin built from its variant in one compilation and a compiler without it built as it is in another is recorded, and not as replaced; on exit it writes the record there", () => {
    const directory = mkdtempSync(join(tmpdir(), "requestport-preload-"));
    const records = mkdtempSync(join(tmpdir(), "requestport-records-"));
    directories.push(directory, records);
    const driver = join(repositoryRoot, "packages/db/src/hosted-driver.ts");
    const migrator = join(repositoryRoot, "packages/db/src/hosted-migrator.ts");
    const shared = join(repositoryRoot, "packages/db/src/shared-databases.ts");
    const own = join(repositoryRoot, "packages/db/src/database-url.ts");
    // What Next does with apps/web's configuration, then a compiler with both
    // plugins that resolves and seals the four modules, and one without the
    // inert plugin that seals the migrator as it resolves it, unreplaced.
    const script = [
      'const Module = require("node:module");',
      'const file = require("node:path").join(process.cwd(), "next.config.compiled.js");',
      "const config = new Module(file);",
      'config._compile("module.exports = {};", file);',
      "const [plugin, recorder] = config.exports.webpack({ plugins: [] }, {}).plugins;",
      "const seal = (name, modules, plugins) => {",
      "  const taps = [];",
      "  const compilations = [];",
      "  const compiler = { name, hooks: {",
      "    normalModuleFactory: { tap: (_, f) => f({ hooks: { afterResolve: { tap: (_, g) => taps.push(g) } } }) },",
      "    compilation: { tap: (_, f) => compilations.push(f) } } };",
      "  for (const each of plugins) each.apply(compiler);",
      "  const built = modules.map((resource) => {",
      "    const data = { createData: { resource, request: resource, loaders: [] } };",
      "    for (const tap of taps) tap(data);",
      "    return { resource, loaders: data.createData.loaders };",
      "  });",
      "  for (const tap of compilations) {",
      "    const after = [];",
      "    tap({ compiler, modules: built, chunkGraph: { getNumberOfModuleChunks: () => 1 }, hooks: { afterSeal: { tap: (_, g) => after.push(g) } } });",
      "    for (const g of after) g();",
      "  }",
      "};",
      "const [driver, migrator, shared, own] = JSON.parse(process.env.RESOURCES);",
      'seal("server", [driver, migrator, shared, own], [plugin, recorder]);',
      'seal("client", [migrator], [recorder]);',
    ].join("\n");
    const run = spawnSync(
      process.execPath,
      ["--import", selfHostSeamsPreload(), "-e", script],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          RESOURCES: JSON.stringify([driver, migrator, shared, own]),
          REQUESTPORT_SELF_HOST_CONTAINED: records,
        },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const written = readdirSync(records);
    expect(written).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(records, written[0] ?? ""), "utf8")),
    ).toEqual({
      compilers: ["client", "server"],
      files: [own, driver, migrator, shared].sort(),
      replaced: [driver, shared].sort(),
    });
  });
});

type Tap<T> = { tap(name: string, callback: (value: T) => void): void };
type CreateData = { resource?: string; request?: string; loaders?: unknown[] };

/** A compiler of the shape the plugin taps; `resolve` runs its afterResolve callbacks on one module's data. */
function fakeCompiler() {
  const afterResolve: ((data: { createData: CreateData }) => void)[] = [];
  const factory = {
    hooks: {
      afterResolve: {
        tap: (_name, callback) => {
          afterResolve.push(callback);
        },
      } as Tap<{ createData: CreateData }>,
    },
  };
  const compiler = {
    hooks: {
      normalModuleFactory: {
        tap: (_name, callback) => callback(factory),
      } as Tap<typeof factory>,
    },
  };
  const resolve = (createData: CreateData): CreateData => {
    const data = { createData: { ...createData } };
    for (const callback of afterResolve) callback(data);
    return data.createData;
  };
  return { compiler, resolve };
}

const SWC = { loader: "/next/dist/build/webpack/loaders/next-swc-loader.js" };

describe("InertSeamsWebpackPlugin", () => {
  test("gives each real module, after webpack resolves it, the inert loader last in its chain (so first to run) with its inert module, keeps its path, and names the loader in its identifier; leaves every other module as it is", () => {
    const plugin = new InertSeamsWebpackPlugin(
      seamReplacements(repositoryRoot),
    );
    const { compiler, resolve: resolved } = fakeCompiler();
    plugin.apply(compiler);
    const loader = inertSeamLoaderPath();
    expect(loader).toBe(join(import.meta.dirname, "inert-seam-loader.cjs"));
    for (const { real, inert } of TEST_SEAMS) {
      const resource = join(repositoryRoot, real);
      expect(
        resolved({
          resource,
          request: `${SWC.loader}!${resource}`,
          loaders: [SWC],
        }),
      ).toEqual({
        resource,
        request: `${SWC.loader}!${loader}??requestport-inert-seam!${resource}`,
        loaders: [
          SWC,
          {
            loader,
            options: { inert: join(repositoryRoot, inert) },
            ident: "requestport-inert-seam",
          },
        ],
      });
    }
    const other = join(repositoryRoot, "apps/web/src/lib/server-appearance.ts");
    const untouched = {
      resource: other,
      request: `${SWC.loader}!${other}`,
      loaders: [SWC],
    };
    expect(resolved(untouched)).toEqual(untouched);
    expect(resolved({})).toEqual({});
    expect([...plugin.replaced].sort()).toEqual(
      TEST_SEAMS.map(({ real }) => join(repositoryRoot, real)).sort(),
    );
  });

  test("builtFromReplacement: a module whose loaders hold the loader its afterResolve hook put there, by that loader's path and ident, was built from its replacement; one without it, with another ident or another loader's path, with no loaders, or no module, was not", () => {
    const plugin = new InertSeamsWebpackPlugin(
      seamReplacements(repositoryRoot),
    );
    const { compiler, resolve: resolved } = fakeCompiler();
    plugin.apply(compiler);
    const resource = join(repositoryRoot, TEST_SEAMS[0]?.real ?? "");
    const { loaders } = resolved({
      resource,
      request: resource,
      loaders: [SWC],
    });
    expect(plugin.builtFromReplacement({ resource, loaders })).toBe(true);
    for (const module of [
      { resource, loaders: [SWC] },
      {
        resource,
        loaders: [SWC, { loader: plugin.loader, ident: "another-loader" }],
      },
      {
        resource,
        loaders: [
          { loader: "/elsewhere.cjs", ident: "requestport-inert-seam" },
        ],
      },
      { resource },
      undefined,
    ]) {
      expect(plugin.builtFromReplacement(module)).toBe(false);
    }
  });

  test("refuses a real module whose identifier does not end with its path", () => {
    const plugin = new InertSeamsWebpackPlugin(
      seamReplacements(repositoryRoot),
    );
    const { compiler, resolve: resolved } = fakeCompiler();
    plugin.apply(compiler);
    const resource = join(repositoryRoot, TEST_SEAMS[0]?.real ?? "");
    expect(() =>
      resolved({ resource, request: `${resource}?query`, loaders: [] }),
    ).toThrow("does not end with it");
  });
});

describe("inert-seam-loader.cjs", () => {
  test("answers the inert module's text, whatever the real module's, and makes the inert module a dependency", () => {
    const require = createRequire(import.meta.url);
    const loader = require(inertSeamLoaderPath()) as (
      this: unknown,
      source: string,
    ) => string;
    for (const { inert } of TEST_SEAMS) {
      const path = join(repositoryRoot, inert);
      const dependencies: string[] = [];
      const answer = loader.call(
        {
          getOptions: () => ({ inert: path }),
          addDependency: (file: string) => dependencies.push(file),
        },
        "export const real = true;",
      );
      expect(answer).toBe(readFileSync(path, "utf8"));
      expect(dependencies).toEqual([path]);
    }
  });
});

describe("withInertSeams", () => {
  test("gives a configuration without webpack one that adds the plugin to each webpack configuration", () => {
    const plugin = new InertSeamsWebpackPlugin(new Map());
    const config: { webpack?: unknown; output?: string } = {
      output: "standalone",
    };
    withInertSeams(config, plugin);
    expect(config.output).toBe("standalone");
    const webpack = config.webpack as (
      c: { plugins?: unknown[] },
      context: unknown,
    ) => { plugins?: unknown[] };
    const other = { name: "other" };
    expect(webpack({ plugins: [other] }, {}).plugins).toEqual([other, plugin]);
    expect(webpack({}, {}).plugins).toEqual([plugin]);
  });

  test("runs the configuration's own webpack first, and adds the plugin to what it answers", () => {
    const plugin = new InertSeamsWebpackPlugin(new Map());
    const seen: unknown[] = [];
    const own = (c: { plugins?: unknown[] }, context: unknown) => {
      seen.push(context);
      return { ...c, plugins: ["own"] };
    };
    const config = { webpack: own as unknown };
    withInertSeams(config, plugin);
    expect(
      (config.webpack as typeof own)({}, { isServer: true }).plugins,
    ).toEqual(["own", plugin]);
    expect(seen).toEqual([{ isServer: true }]);
  });

  test("refuses a configuration that is not an object, or whose webpack is not a function", () => {
    const plugin = new InertSeamsWebpackPlugin(new Map());
    expect(() => withInertSeams(() => ({}), plugin)).toThrow("not an object");
    expect(() => withInertSeams(null, plugin)).toThrow("not an object");
    expect(() => withInertSeams({ webpack: {} }, plugin)).toThrow(
      "webpack that is not a function",
    );
  });
});

describe("installNextConfigHook", () => {
  function fakeModuleClass() {
    class FakeModule {
      exports: unknown = {};
      _compile(content: string, _filename: string): unknown {
        this.exports = JSON.parse(content);
        return undefined;
      }
    }
    return FakeModule;
  }

  test("gives the plugin to the configuration Next compiles as next.config.compiled.js in the project directory, and to nothing else", () => {
    // Under the default temporary directory, which on macOS is reached
    // through the /var link (ruling 152): Next names the file under the
    // project directory's real path, and the hook is handed the path as given.
    const directory = mkdtempSync(join(tmpdir(), "requestport-test-seams "));
    directories.push(directory);
    const project = realpathSync(directory);
    mkdirSync(join(directory, "other"));
    writeFileSync(join(directory, "next.config.ts"), "");
    const FakeModule = fakeModuleClass();
    const plugin = new InertSeamsWebpackPlugin(new Map());
    const seen = installNextConfigHook({
      directory,
      plugin,
      moduleClass: FakeModule as unknown as ModuleClassLike,
    });

    const config = new FakeModule();
    config._compile(
      '{"default":{"output":"standalone"}}',
      join(project, "next.config.compiled.js"),
    );
    const elsewhere = new FakeModule();
    elsewhere._compile(
      '{"default":{}}',
      join(project, "other", "next.config.compiled.js"),
    );
    const another = new FakeModule();
    another._compile('{"default":{}}', join(project, "page.js"));

    const exported = config.exports as { default: { webpack?: unknown } };
    expect(typeof exported.default.webpack).toBe("function");
    expect(
      (elsewhere.exports as { default: { webpack?: unknown } }).default.webpack,
    ).toBeUndefined();
    expect(
      (another.exports as { default: { webpack?: unknown } }).default.webpack,
    ).toBeUndefined();
    expect(seen.configs).toBe(1);
  });
});
