import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import * as authorize from "./authorize.js";
import * as callbackServer from "./callback-server.js";
import * as ci from "./ci.js";
import * as credentials from "./credentials.js";
import * as http from "./http.js";
import * as barrel from "./index.js";
import * as oauth from "./oauth.js";
import * as project from "./project.js";
import * as resolveModule from "./resolve.js";
import * as tokenSource from "./token-source.js";

/**
 * The package as a whole, rather than any one module in it.
 *
 * Each module's own suite says what that module does. What none of them can
 * say is what the package is made of: which files exist, which subpaths a
 * consumer may import, and what a build emits. Those are this file's.
 */
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

/**
 * Directories that hold output or installed code, never source: what a build,
 * a coverage run or an install leaves behind is not part of the package's
 * design, and is not judged here.
 */
const GENERATED = new Set(["coverage", "dist", "node_modules"]);

function filesUnder(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!GENERATED.has(entry.name)) {
        found.push(...filesUnder(join(directory, entry.name)));
      }
      continue;
    }
    found.push(join(directory, entry.name));
  }

  return found;
}

describe("what the package is made of", () => {
  /**
   * `tsconfig.json` compiles `src/**`, `biome check src` lints it and the
   * suite runs it, so TypeScript anywhere else in the package is compiled,
   * linted and tested by nothing. That is how a one-off script with a
   * session's scratch path written into it sat beside the package
   * (`onboard-live.ts`, deleted by ruling 81). The vitest configuration is
   * the one file that has to live at the root, and it is named.
   */
  test("holds no TypeScript outside src/ but its vitest configuration", () => {
    const outside = filesUnder(PACKAGE_ROOT)
      .map((path) => relative(PACKAGE_ROOT, path))
      .filter((path) => !path.startsWith("src/"))
      .filter((path) => /\.[cm]?tsx?$/u.test(path));

    expect(outside).toEqual(["vitest.config.ts"]);
  });
});

type Manifest = {
  readonly exports: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
};

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
}

/**
 * Every module a consumer may import, by subpath: the six there were, and
 * the four manifest-h.md §2.8.1 adds (`./authorize`, `./callback-server`,
 * `./http`, `./token-source`). `lock.ts` is not one: the token source and
 * the file store use it, and its error reaches callers through
 * `./token-source`.
 */
const MODULES = {
  "./authorize": ["authorize", authorize],
  "./callback-server": ["callback-server", callbackServer],
  "./ci": ["ci", ci],
  "./credentials": ["credentials", credentials],
  "./http": ["http", http],
  "./oauth": ["oauth", oauth],
  "./project": ["project", project],
  "./resolve": ["resolve", resolveModule],
  "./token-source": ["token-source", tokenSource],
} as const;

const modules = Object.entries(MODULES).map(
  ([subpath, [file, loaded]]) => [subpath, file, loaded] as const,
);

describe("what a consumer may import", () => {
  test("names the barrel and exactly these subpaths, each its module in src/", () => {
    expect(manifest().exports).toEqual({
      ".": "./src/index.ts",
      ...Object.fromEntries(
        modules.map(([subpath, file]) => [subpath, `./src/${file}.ts`]),
      ),
    });
    for (const target of Object.values(manifest().exports)) {
      expect(existsSync(join(PACKAGE_ROOT, target)), target).toBe(true);
    }
  });

  test("exports ./authorize, ./callback-server, ./http and ./token-source", () => {
    expect(Object.keys(manifest().exports)).toEqual(
      expect.arrayContaining([
        "./authorize",
        "./callback-server",
        "./http",
        "./token-source",
      ]),
    );
  });

  /**
   * The barrel is the union of the subpaths (R4): a name a subpath offers is
   * offered by `.` too, as the very same value, so the two cannot drift.
   */
  test.each(modules)(
    "the barrel offers every value %s exports, as the same value",
    (_subpath, _file, loaded) => {
      const values = barrel as Record<string, unknown>;
      for (const [name, value] of Object.entries(loaded)) {
        expect(values[name], name).toBe(value);
      }
    },
  );

  test("the barrel offers no value that no subpath exports", () => {
    const offered = new Set(
      modules.flatMap(([, , loaded]) => Object.keys(loaded)),
    );

    expect(Object.keys(barrel).filter((name) => !offered.has(name))).toEqual(
      [],
    );
  });

  /**
   * Types are gone at run time, so they are read from the sources: every
   * `export type` and `export interface` a subpath's module declares is
   * named, as a type, in the barrel.
   */
  test.each(modules)(
    "the barrel names every type %s exports",
    (_subpath, file) => {
      const source = readFileSync(
        join(PACKAGE_ROOT, "src", `${file}.ts`),
        "utf8",
      );
      const index = readFileSync(join(PACKAGE_ROOT, "src", "index.ts"), "utf8");
      const types = [
        ...source.matchAll(/^export (?:type|interface) (?<name>\w+)/gmu),
      ].map((match) => match.groups?.name ?? "");

      for (const name of types) {
        expect(index, name).toMatch(new RegExp(`\\btype ${name}\\b`, "u"));
      }
    },
  );
});

/**
 * The package's own build (manifest-h.md §2.8.5): `tsconfig.build.json`
 * compiles exactly the modules `exports` names, and what they import, into
 * `dist/` as ESM `.js` and `.d.ts`. `tsconfig.json`, which also compiles the
 * tests, stays for `typecheck`.
 *
 * The build is run here for real, into a temporary directory, with the
 * repository's own `tsc`, and plain Node then loads what it emitted. What
 * `exclude` lists only records intent: TypeScript applies it to `include`'s
 * globs, never to a file an import reaches, so the emitted files are what
 * prove that no test is in the build.
 */
describe("what the build emits", () => {
  type BuildConfig = {
    readonly exclude?: readonly string[];
    readonly extends?: string;
    readonly files?: readonly string[];
    readonly include?: readonly string[];
  };

  let root = "";
  let built: { readonly status: number | null; readonly output: string };
  let emitted: string[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "requestport-client-build-"));
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
        join(PACKAGE_ROOT, "tsconfig.build.json"),
        "--outDir",
        join(root, "dist"),
      ],
      { encoding: "utf8" },
    );
    built = { output: `${run.stdout}${run.stderr}`, status: run.status };
    emitted = existsSync(join(root, "dist"))
      ? filesUnder(join(root, "dist")).map((path) =>
          relative(join(root, "dist"), path),
        )
      : [];
  }, 60_000);

  afterAll(() => {
    if (root !== "") rmSync(root, { force: true, recursive: true });
  });

  function buildConfig(): BuildConfig {
    return JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "tsconfig.build.json"), "utf8"),
    );
  }

  test("compiles from the modules exports names, and the build script uses it", () => {
    const config = buildConfig();

    expect(config.extends).toBe("./tsconfig.json");
    expect(config.include).toEqual([]);
    expect([...(config.files ?? [])].sort()).toEqual(
      Object.values(manifest().exports)
        .map((target) => target.replace(/^\.\//u, ""))
        .sort(),
    );
    expect(config.exclude).toEqual(
      expect.arrayContaining(["**/*.test.ts", "src/test-support/**"]),
    );
    expect(manifest().scripts.build).toBe("tsc -p tsconfig.build.json");
    expect(manifest().scripts.typecheck).toBe("tsc --noEmit");
  });

  test("builds", () => {
    expect(built.status, built.output).toBe(0);
  });

  test("emits each subpath's module as .js and .d.ts", () => {
    for (const target of Object.values(manifest().exports)) {
      const module = target.replace(/^\.\/src\//u, "").replace(/\.ts$/u, "");
      expect(emitted).toContain(`${module}.js`);
      expect(emitted).toContain(`${module}.d.ts`);
    }
  });

  test("emits nothing but .js and .d.ts, and nothing from a test, src/ or onboard-live", () => {
    expect(emitted.length).toBeGreaterThan(0);
    expect(
      emitted.filter(
        (path) =>
          !/^[a-z-]+\.(?:js|d\.ts)$/u.test(path) ||
          /\.test\.|test-support|onboard-live|^src\//u.test(path),
      ),
    ).toEqual([]);
  });

  /**
   * In a separate Node process, with only `node_modules` beside it: what a
   * consumer of the built package would load. It offers what the source
   * barrel offers.
   */
  test("loads in plain Node, offering what the source barrel offers", () => {
    symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(root, "node_modules"));
    const entry = pathToFileURL(join(root, "dist", "index.js")).href;
    const loaded = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const names = Object.keys(await import(${JSON.stringify(entry)})); console.log(JSON.stringify(names.sort()));`,
      ],
      { encoding: "utf8" },
    );

    expect(loaded.status, loaded.stderr).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual(Object.keys(barrel).sort());
  });
});
