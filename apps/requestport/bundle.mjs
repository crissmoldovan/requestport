/*
  The `requestport` tarball's JavaScript (Plan 13, H.7; manifest-h.md
  §2.7.3, owner question 8's second branch, which rulings 190 and 193
  choose): esbuild's configuration for `apps/requestport`. Nothing deployed
  imports this module, and the workspace has no `build` script, so no Turbo
  task reaches it. Its importers are `scripts/pack-requestport.mjs`
  (`buildRequestPortBundle` and `entries`) and that script's test
  (`bundleProblems`, `published` and `publishedSubpaths`); the package
  contract (`scripts/requestport-package-contract.test.mjs`) reaches it
  only through the script.

  `buildRequestPortBundle` writes `dist/` into the directory it is given,
  which must not hold one yet:

  - **Two entries:** `requestport` (`src/main.ts`, the program), and
    `operator` (`src/operator/entry.ts`, the child `requestport start` runs
    for its operator step, `src/operator/command.ts`).
  - **esbuild 0.28.2, ESM for Node 22, split, no source maps.** Split, an
    entry links only what it imports statically, so `--version` and `--help`
    load no package, and each command's modules load when it runs
    (`src/cli.ts`). Entries and chunks are written directly in `dist/`, so
    that a bundled module's `./` is `dist/` and its `../` the package's
    root: `cli.ts`'s `../package.json`, and `operator/command.ts`'s
    `./operator.js` (`src/layout.ts`).
  - **Externals:** every bare specifier, `node:` builtins among them, is
    left to the install, by `packages/core/bundle.mjs`'s `isExternal` with
    `published` named external: every package G's machinery packs
    (`packageSet` and `hostPackages`) and `@requestport/client`, which
    `requestport` depends on at the stamped version (ruling 190; ruling 193
    item 6). Any other `@requestport/*` specifier would be inlined, and is
    refused below.
  - esbuild's `absWorkingDir` is the repository's root, so the module
    comments it writes name repository paths.

  It refuses the build, after esbuild writes it, when `bundleProblems` finds
  any (G's `buildPackage` refuses its rows' builds the same way):

  - an input that is not one of `apps/requestport`'s modules: a second copy
    of another workspace's code, beside the package that carries it (db's
    `client.ts` refuses a storage another copy created, ruling 193 item 1).
    So no module of another workspace is in `dist/`: no test seam's real or
    inert module (the seams' real modules are `auth`'s, `apps/web`'s and
    `server`'s), and none of `db`'s, its private modules among them;
  - an `@requestport/*` specifier its JavaScript imports, statically or
    through `import(…)`, that names no package of `published`, or a subpath
    that package does not publish (`publishedSubpaths`).

  esbuild is loaded from `packages/core`'s devDependencies, the 0.28.2 G.7's
  bundler uses, as K8's spike loaded it, so this workspace declares no
  copy of its own (H.7's survey, for the driver, question 1).

  It returns esbuild's metafile. `scripts/pack-requestport.mjs` checks what
  it built.
*/
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bundles,
  hostPackages,
  isExternal,
  packageName,
  packageSet,
} from "../../packages/core/bundle.mjs";

/** The repository's root: esbuild's `absWorkingDir`, and every path's base. */
export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** This workspace's directory, from the repository's root, whose modules alone the bundle inlines. */
export const workspace = "apps/requestport";

/** The client's workspace, whose source manifest's `exports` its packed manifest publishes (`scripts/pack-requestport.mjs`'s `stageClient`). */
const CLIENT_SOURCE = "packages/client";

/**
 * The `@requestport/*` packages the bundle leaves external: G's eleven,
 * which `packages/core/bundle.mjs`'s rows build (the S8 set and `auth`,
 * `mcp` and `server`), and `@requestport/client`.
 */
export const published = Object.freeze([
  ...packageSet,
  ...hostPackages,
  "@requestport/client",
]);

/** Each entry: the file name its output takes in `dist/`, and its source, from the repository's root. */
export const entries = Object.freeze([
  Object.freeze({
    name: "requestport",
    source: "apps/requestport/src/main.ts",
  }),
  Object.freeze({
    name: "operator",
    source: "apps/requestport/src/operator/entry.ts",
  }),
]);

/** `isExternal`'s view of this bundle: the packages of `published` are left external. */
const bundle = Object.freeze({ external: published });

/**
 * Each package of `published`, by name, with the subpaths its packed
 * manifest exports: a row of `packages/core/bundle.mjs`'s `bundles`, its
 * entries' subpaths; the client, each subpath its source manifest exports,
 * which `scripts/pack-requestport.mjs`'s `stageClient` packs whole.
 */
export function publishedSubpaths() {
  const subpaths = new Map(
    Object.values(bundles).map((row) => [
      row.package,
      row.entries.map(({ subpath }) => subpath),
    ]),
  );
  const client = JSON.parse(
    readFileSync(join(repositoryRoot, CLIENT_SOURCE, "package.json"), "utf8"),
  );
  subpaths.set(client.name, Object.keys(client.exports ?? {}));
  return subpaths;
}

let workspaces;
/** Each workspace's directory under `apps/` and `packages/`, by its package name. */
function workspaceNames() {
  if (workspaces === undefined) {
    workspaces = new Map();
    for (const parent of ["apps", "packages"]) {
      for (const entry of readdirSync(join(repositoryRoot, parent))) {
        const manifest = join(repositoryRoot, parent, entry, "package.json");
        if (!existsSync(manifest)) continue;
        workspaces.set(
          `${parent}/${entry}`,
          JSON.parse(readFileSync(manifest, "utf8")).name,
        );
      }
    }
  }
  return workspaces;
}

/** The package whose workspace holds `module`, a path from the repository's root, or "no workspace". */
function ownerOf(module) {
  for (const [directory, name] of workspaceNames()) {
    if (module.startsWith(`${directory}/`)) return name;
  }
  return "no workspace";
}

/**
 * What the build that `metafile` describes may not hold (this module's
 * header): each input outside `apps/requestport`, and each `@requestport/*`
 * specifier its outputs import that names no package of `published`, or a
 * subpath that package does not publish. `subpaths` is
 * `publishedSubpaths()` unless a test hands another.
 */
export function bundleProblems(metafile, subpaths = publishedSubpaths()) {
  const problems = [];
  for (const input of Object.keys(metafile.inputs).sort()) {
    if (!input.startsWith(`${workspace}/`)) {
      problems.push(`inlines ${input}, a module of ${ownerOf(input)}`);
    }
  }
  const specifiers = new Set();
  for (const { imports } of Object.values(metafile.outputs)) {
    for (const { path, external } of imports) {
      if (external && path.startsWith("@requestport/")) specifiers.add(path);
    }
  }
  for (const specifier of [...specifiers].sort()) {
    const name = packageName(specifier);
    const subpath =
      specifier === name ? "." : `.${specifier.slice(name.length)}`;
    if (!subpaths.has(name)) {
      problems.push(
        `imports ${specifier}, and no tarball of the run is ${name}`,
      );
    } else if (!subpaths.get(name).includes(subpath)) {
      problems.push(`imports ${specifier}, which ${name} does not publish`);
    }
  }
  return problems;
}

/**
 * Builds the two entries into `directory`'s `dist/`, which must not exist,
 * refuses the build on any problem `bundleProblems` finds, and returns
 * esbuild's metafile.
 */
export async function buildRequestPortBundle(directory) {
  const dist = join(directory, "dist");
  if (existsSync(dist)) {
    throw new Error(`${dist} exists: the bundle is built into a new dist/.`);
  }
  mkdirSync(dist, { recursive: true });
  const esbuild = createRequire(
    join(repositoryRoot, "packages/core/package.json"),
  )("esbuild");
  const result = await esbuild.build({
    absWorkingDir: repositoryRoot,
    entryPoints: Object.fromEntries(
      entries.map(({ name, source }) => [name, source]),
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
    ],
  });
  if (result.errors.length > 0 || result.warnings.length > 0) {
    throw new Error(
      `esbuild: ${[...result.errors, ...result.warnings].map(({ text }) => text).join("; ")}`,
    );
  }
  const problems = bundleProblems(result.metafile);
  if (problems.length > 0) {
    throw new Error(`requestport's bundle: ${problems.join("; ")}`);
  }
  return result.metafile;
}
