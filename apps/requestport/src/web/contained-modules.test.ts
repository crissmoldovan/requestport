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
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  ContainedModulesWebpackPlugin,
  moduleFile,
  SELF_HOST_CONTAINED_VARIABLE,
  writeContainedModules,
} from "./contained-modules.js";

/*
 * The self-host build's recorder of what it compiles in (H.7 round 5;
 * ruling 197 item 4), against a stand-in for webpack's compiler: the hooks
 * the plugin taps, and a compilation whose chunk graph puts some modules in
 * a chunk and leaves others out. The real build is the pack's: H.7 round
 * 5's packs record it.
 */

type Module = { resource?: unknown; modules?: Module[] };

/** A compiler with one `compilation` hook, and a way to seal a compilation through it. */
function compiler() {
  const taps: ((compilation: unknown) => void)[] = [];
  return {
    hooks: {
      compilation: {
        tap(_name: string, callback: (compilation: unknown) => void) {
          taps.push(callback);
        },
      },
    },
    seal(modules: Module[], inChunks: Set<Module>, name?: string) {
      const sealed: (() => void)[] = [];
      const compilation = {
        compiler: name === undefined ? {} : { name },
        modules,
        chunkGraph: {
          getNumberOfModuleChunks: (module: Module) =>
            inChunks.has(module) ? 1 : 0,
        },
        hooks: {
          afterSeal: {
            tap(_name: string, callback: () => void) {
              sealed.push(callback);
            },
          },
        },
      };
      for (const tap of taps) tap(compilation);
      for (const callback of sealed) callback();
    },
  };
}

/** The stand-in, as the plugin's `apply` takes it. */
function asCompiler(
  made: ReturnType<typeof compiler>,
): Parameters<ContainedModulesWebpackPlugin["apply"]>[0] {
  return made as unknown as Parameters<
    ContainedModulesWebpackPlugin["apply"]
  >[0];
}

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ContainedModulesWebpackPlugin", () => {
  test("records, once each compilation is sealed, its compiler's name, and the file of every module in a chunk, each module a concatenated module holds, without a query or fragment; not a module in no chunk, nor one with no file", () => {
    const plugin = new ContainedModulesWebpackPlugin();
    const made = compiler();
    plugin.apply(asCompiler(made));
    const inChunk = { resource: "/r/node_modules/a/index.js" };
    const withQuery = {
      resource: "/r/node_modules/b/page.js?__next_metadata__",
    };
    const withFragment = { resource: "/r/node_modules/c/x.css#hash" };
    const leftOut = { resource: "/r/node_modules/d/unused.js" };
    const generated = { resource: "" };
    const runtime = {};
    const concatenated = {
      modules: [
        { resource: "/r/node_modules/e/one.js" },
        { resource: "/r/apps/web/src/two.ts" },
      ],
    };
    made.seal(
      [
        inChunk,
        withQuery,
        withFragment,
        leftOut,
        generated,
        runtime,
        concatenated,
      ],
      new Set([
        inChunk,
        withQuery,
        withFragment,
        generated,
        runtime,
        concatenated,
      ]),
      "server",
    );
    made.seal(
      [{ resource: "/r/node_modules/f/server.js" }],
      new Set(),
      "edge-server",
    );
    made.seal([], new Set());
    made.seal([], new Set(), "client");

    expect(plugin.recorded()).toEqual({
      compilers: ["", "client", "edge-server", "server"],
      files: [
        "/r/apps/web/src/two.ts",
        "/r/node_modules/a/index.js",
        "/r/node_modules/b/page.js",
        "/r/node_modules/c/x.css",
        "/r/node_modules/e/one.js",
      ],
      replaced: [],
    });
  });

  test("records as replaced each file every module of which that it put in a chunk, in every compilation it saw sealed, the predicate it was handed says was built from its replacement (the inert-seams plugin's builtFromReplacement): not a file one such module of which was built as it is, in any compilation, nor one whose replaced module is in no chunk; none without a predicate", () => {
    const built = new Set<Module>();
    const plugin = new ContainedModulesWebpackPlugin((module) =>
      built.has(module as Module),
    );
    const made = compiler();
    plugin.apply(asCompiler(made));
    const serverA = { resource: "/r/packages/db/src/a.ts" };
    const clientA = { resource: "/r/packages/db/src/a.ts" };
    const b = { resource: "/r/packages/db/src/b.ts?query" };
    const inner = { resource: "/r/packages/db/src/c.ts" };
    const leftOut = { resource: "/r/packages/db/src/d.ts" };
    const other = { resource: "/r/node_modules/e/index.js" };
    const concatenated = { modules: [inner, other] };
    for (const module of [serverA, b, inner, leftOut]) built.add(module);
    made.seal(
      [serverA, b, concatenated, leftOut],
      new Set<Module>([serverA, b, concatenated]),
      "server",
    );
    made.seal([clientA], new Set([clientA]), "client");
    expect(plugin.recorded()).toEqual({
      compilers: ["client", "server"],
      files: [
        "/r/node_modules/e/index.js",
        "/r/packages/db/src/a.ts",
        "/r/packages/db/src/b.ts",
        "/r/packages/db/src/c.ts",
      ],
      replaced: ["/r/packages/db/src/b.ts", "/r/packages/db/src/c.ts"],
    });
    const without = new ContainedModulesWebpackPlugin();
    const again = compiler();
    without.apply(asCompiler(again));
    again.seal([serverA], new Set([serverA]), "server");
    expect(without.recorded().replaced).toEqual([]);
  });

  test("keys what it records as built as it is, and as replaced, by the file's real path (ruling 199 item 2): a module webpack put in chunks under two of its paths in one process, through a symbolic link to its workspace (as webpack keeps it with resolve.symlinks off) and by the checkout's own path to it, past that link (under macOS's default TMPDIR still through /var's), one built as it is and one from its replacement, is not replaced, whichever path was which; one built from its replacement under both is, by its real path", () => {
    // The checkout under the temporary directory, which under macOS's default
    // TMPDIR is itself under a symbolic link (/var is /private/var), and
    // apps/web's link to db's workspace, as pnpm makes it.
    const root = mkdtempSync(join(tmpdir(), "contained-modules-paths-"));
    scratch.push(root);
    mkdirSync(join(root, "packages/db/src"), { recursive: true });
    writeFileSync(join(root, "packages/db/src/hidden.ts"), "export {};\n");
    mkdirSync(join(root, "apps/web/node_modules/@requestport"), {
      recursive: true,
    });
    symlinkSync(
      "../../../../packages/db",
      join(root, "apps/web/node_modules/@requestport/db"),
    );
    const inCheckout = join(root, "packages/db/src/hidden.ts");
    const linked = join(
      root,
      "apps/web/node_modules/@requestport/db/src/hidden.ts",
    );
    /** What one process records of the two paths, `replaced` naming those built from the replacement. */
    const recordedOf = (replaced: readonly string[]) => {
      const modules = [linked, inCheckout].map((resource) => ({ resource }));
      const plugin = new ContainedModulesWebpackPlugin((module) =>
        replaced.includes((module as Module).resource as string),
      );
      const made = compiler();
      plugin.apply(asCompiler(made));
      made.seal(modules, new Set(modules), "server");
      return plugin.recorded();
    };
    for (const replaced of [[inCheckout], [linked]]) {
      expect(recordedOf(replaced), `${replaced[0]} replaced`).toEqual({
        compilers: ["server"],
        files: [linked, inCheckout].sort(),
        replaced: [],
      });
    }
    expect(recordedOf([linked, inCheckout]).replaced).toEqual([
      realpathSync(inCheckout),
    ]);
  });

  test("moduleFile drops what follows the path, and answers nothing for no path", () => {
    expect(moduleFile("/a/b.js?x=1")).toBe("/a/b.js");
    expect(moduleFile("/a/b.js")).toBe("/a/b.js");
    expect(moduleFile("?only-a-query")).toBeUndefined();
    expect(moduleFile(undefined)).toBeUndefined();
    expect(moduleFile(42)).toBeUndefined();
  });
});

describe("writeContainedModules", () => {
  test("writes what a process recorded as <pid>.json in the directory SELF_HOST_CONTAINED_VARIABLE names, and nothing for a process that sealed no compilation", () => {
    expect(SELF_HOST_CONTAINED_VARIABLE).toBe(
      "REQUESTPORT_SELF_HOST_CONTAINED",
    );
    const directory = mkdtempSync(join(tmpdir(), "contained-modules-"));
    scratch.push(directory);
    const idle = new ContainedModulesWebpackPlugin();
    expect(writeContainedModules(directory, idle, 7)).toBeUndefined();
    const plugin = new ContainedModulesWebpackPlugin();
    const made = compiler();
    plugin.apply(asCompiler(made));
    made.seal(
      [{ resource: "/r/node_modules/a/index.js" }],
      new Set([]),
      "client",
    );
    const file = writeContainedModules(directory, plugin, 8);
    expect(file).toBe(join(directory, "8.json"));
    expect(JSON.parse(readFileSync(join(directory, "8.json"), "utf8"))).toEqual(
      {
        compilers: ["client"],
        files: [],
        replaced: [],
      },
    );
  });
});
