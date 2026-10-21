import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  publicVariants,
  type SeamMarker,
  seamMarkersIn,
  type TestSeam,
  testSeams,
} from "../../../../packages/core/bundle.mjs";

/**
 * The three test seams the self-host Next build leaves out (Plan 13, H.7;
 * ruling 174), and how it leaves them out. The list is
 * `packages/core/bundle.mjs`'s `testSeams`, the one list (ruling 193 item
 * 2), which G's rows and per-tarball check read there and this module gives
 * as `TEST_SEAMS`, with `seamMarkersIn`; that module describes each seam,
 * its inert module and its markers. The self-host Next build
 * (`self-host-build.ts`) puts the inert module in each real one's place,
 * through `InertSeamsWebpackPlugin` here, which `self-host-seams.ts` adds to
 * that build alone. `requestport`'s esbuild bundle (`../../bundle.mjs`)
 * needs no replacement: it inlines `apps/requestport`'s modules alone, and
 * every seam's real module is another workspace's, whose package carries
 * its inert module where G's row builds one (`server`'s CSP fence).
 * `scripts/pack-requestport.mjs` refuses a file of `requestport`'s or
 * `@requestport/web`'s tarball that holds any marker,
 * `scripts/pack-packages.mjs` a file of any tarball it packs, and
 * `buildSelfHostWeb` a self-host build that does, whichever module put it
 * there. `test-seams.test.ts` lists each marker's holders in the
 * repository's source.
 *
 * The self-host build replaces one more kind of module the same way: each
 * private module of `bundle.mjs`'s `publicVariants`, `db`'s shared
 * databases, its hosted driver and that driver's migrator, is built from
 * its public variant (ruling 193 item 5; ruling 194 item 3;
 * `selfHostReplacements`), as G's rows build it.
 * `scripts/pack-requestport.mjs` refuses an `@requestport/web` tarball that
 * holds a private module's digests, marker or doc comments (G's
 * `checkTarball`).
 *
 * Nothing at this module's top level calls anything. `requestport`'s bundle
 * does not reach this module: `serve/web.ts` takes `SELF_HOST_DIST_DIR`
 * from `self-host-dist-dir.ts`, which imports nothing, and
 * `scripts/pack-requestport.test.mjs` holds that neither this module nor
 * `self-host-build.ts` is an input of the bundle (ruling 190, minor 3).
 */
export type { SeamMarker, TestSeam };

/** `bundle.mjs`'s `testSeams`: the seams, in that list's order. */
export const TEST_SEAMS: readonly TestSeam[] = testSeams;

export { seamMarkersIn };

/**
 * Each seam's real module under `root`, by its absolute path and, where it
 * differs, its resolved one (a bundler resolves symbolic links), to its
 * inert module's absolute path.
 */
export function seamReplacements(root: string): ReadonlyMap<string, string> {
  const replacements = new Map<string, string>();
  for (const { real, inert } of TEST_SEAMS) {
    const path = join(root, real);
    const to = join(root, inert);
    replacements.set(path, to);
    replacements.set(realpathSync(path), to);
  }
  return replacements;
}

/**
 * What the self-host Next build replaces (`self-host-seams.ts`; ruling 193
 * item 5): `seamReplacements`' entries, and each private module of
 * `bundle.mjs`'s `publicVariants` under `root`, by its absolute path and,
 * where it differs, its resolved one, to its public variant's absolute path.
 */
export function selfHostReplacements(
  root: string,
): ReadonlyMap<string, string> {
  const replacements = new Map(seamReplacements(root));
  for (const [module, variant] of Object.entries(publicVariants)) {
    const path = join(root, module);
    const to = join(root, variant);
    replacements.set(path, to);
    replacements.set(realpathSync(path), to);
  }
  return replacements;
}

type CreateData = {
  resource?: string;
  request?: string;
  loaders?: unknown[];
};
type ResolveData = { createData: CreateData };
type NormalModuleFactoryLike = {
  hooks: {
    afterResolve: {
      tap(name: string, callback: (data: ResolveData) => void): void;
    };
  };
};
type CompilerLike = {
  hooks: {
    normalModuleFactory: {
      tap(
        name: string,
        callback: (factory: NormalModuleFactoryLike) => void,
      ): void;
    };
  };
};

const PLUGIN = "RequestPortInertSeams";
const LOADER_IDENT = "requestport-inert-seam";

/** The loader `InertSeamsWebpackPlugin` puts in a real module's chain: `inert-seam-loader.cjs`, beside this module. */
export function inertSeamLoaderPath(): string {
  return fileURLToPath(new URL("./inert-seam-loader.cjs", import.meta.url));
}

/**
 * A webpack plugin, for the self-host Next build alone: after webpack
 * resolves a module, a resource that is one of `replacements`' keys (a
 * seam's real module, or, in `selfHostReplacements`' answer, which
 * `self-host-seams.ts` hands it, a private module too), however it was
 * imported, is given `inert-seam-loader.cjs` first in its chain, which
 * answers its replacement's text (the inert module's, or the public
 * variant's) in place of its own. The module keeps the replaced module's
 * path: Next's output tracing then counts it as bundled, where a module read
 * from another path would leave the replaced file to be traced and copied
 * into the standalone tree (measured for the seams: H.7, ruling 174's
 * round). Its identifier (`request`) names the loader, so a cached build of
 * the replaced module is never taken for it. `replaced` collects the
 * modules it replaced, in every compilation of its process, and
 * `builtFromReplacement` says of one module webpack built whether it was
 * built so.
 */
export class InertSeamsWebpackPlugin {
  readonly replacements: ReadonlyMap<string, string>;
  readonly loader: string;
  readonly replaced = new Set<string>();

  constructor(
    replacements: ReadonlyMap<string, string>,
    loader: string = inertSeamLoaderPath(),
  ) {
    this.replacements = replacements;
    this.loader = loader;
  }

  apply(compiler: CompilerLike): void {
    compiler.hooks.normalModuleFactory.tap(PLUGIN, (factory) => {
      factory.hooks.afterResolve.tap(PLUGIN, ({ createData }) => {
        const resource = createData.resource;
        if (resource === undefined) return;
        const inert = this.replacements.get(resource);
        if (inert === undefined) return;
        const request = createData.request ?? resource;
        if (!request.endsWith(resource)) {
          throw new Error(
            `${PLUGIN}: the request for ${resource} does not end with it: ${request}`,
          );
        }
        createData.loaders = [
          ...(createData.loaders ?? []),
          { loader: this.loader, options: { inert }, ident: LOADER_IDENT },
        ];
        createData.request = `${request.slice(0, request.length - resource.length)}${this.loader}??${LOADER_IDENT}!${resource}`;
        this.replaced.add(resource);
      });
    });
  }

  /**
   * Whether webpack built `module` from its replacement's text: whether the
   * module's own `loaders`, as webpack keeps them on the module it builds
   * from the data this plugin's hook changed, hold this plugin's loader by
   * its path and ident.
   */
  builtFromReplacement(module: unknown): boolean {
    const loaders = (module as { loaders?: unknown } | undefined)?.loaders;
    return (
      Array.isArray(loaders) &&
      loaders.some(
        (each) =>
          typeof each === "object" &&
          each !== null &&
          (each as { loader?: unknown }).loader === this.loader &&
          (each as { ident?: unknown }).ident === LOADER_IDENT,
      )
    );
  }
}

type WebpackConfigLike = { plugins?: unknown[] };

/**
 * A webpack plugin, as a Next configuration's `webpack` function hands it to
 * webpack: `InertSeamsWebpackPlugin`, or `contained-modules.ts`'
 * `ContainedModulesWebpackPlugin`, which taps hooks of its own.
 */
export type WebpackPluginLike = { apply(compiler: never): void };
type WebpackHook = (
  config: WebpackConfigLike,
  context: unknown,
) => WebpackConfigLike;

/**
 * Gives a Next configuration object a `webpack` function that adds `plugin`
 * to every webpack configuration Next makes, after the configuration's own
 * `webpack` function, if it has one. It refuses a configuration that is not
 * an object, or whose `webpack` is not a function.
 */
export function withInertSeams(
  config: unknown,
  plugin: WebpackPluginLike,
): void {
  if (typeof config !== "object" || config === null) {
    throw new Error(
      `the self-host build's next.config exports ${config === null ? "null" : typeof config}, not an object, so its test seams cannot be left out`,
    );
  }
  const target = config as { webpack?: unknown };
  const own = target.webpack;
  if (own !== undefined && typeof own !== "function") {
    throw new Error(
      "the self-host build's next.config has a webpack that is not a function",
    );
  }
  const hook: WebpackHook = (webpackConfig, context) => {
    const made =
      own === undefined
        ? webpackConfig
        : (own as WebpackHook)(webpackConfig, context);
    made.plugins = [...(made.plugins ?? []), plugin];
    return made;
  };
  target.webpack = hook;
}

/** The part of Node's CommonJS `Module` the hook below replaces. */
export type ModuleClassLike = {
  prototype: {
    _compile(
      this: { exports: unknown },
      content: string,
      filename: string,
    ): unknown;
  };
};

/**
 * Next 16.3.8 loads `next.config.ts` by compiling it with SWC and running it
 * as `<project>/next.config.compiled.js` through `Module.prototype._compile`
 * (`next/dist/build/next-config-ts/transpile-config.js`: `handleCJS`,
 * `:105`, calls `requireFromString` with that path at `:122`; and
 * `require-hook.js`: `requireFromString`, `:77-81`, calls `m._compile`).
 * Both files are 16.3.1's byte for byte, where ruling 174's round measured
 * the hook first. This wraps `_compile` so that,
 * for that file in `directory` (Next's project directory, by its real path)
 * alone, the configuration it exports (`default`, or the exports themselves,
 * as Next reads them) is given `plugin` (`withInertSeams`). It changes no
 * file, and nothing in a process this is not installed in.
 */
export function installNextConfigHook({
  directory,
  plugin,
  moduleClass,
}: {
  directory: string;
  plugin: WebpackPluginLike;
  moduleClass: ModuleClassLike;
}): { configs: number } {
  const seen = { configs: 0 };
  const project = realpathSync(directory);
  const prototype = moduleClass.prototype;
  const compile = prototype._compile;
  prototype._compile = function (content, filename) {
    const result = compile.call(this, content, filename);
    if (
      basename(filename) === "next.config.compiled.js" &&
      dirname(filename) === project
    ) {
      const exported = this.exports as { default?: unknown } | undefined;
      withInertSeams(exported?.default ?? exported, plugin);
      seen.configs += 1;
    }
    return result;
  };
  return seen;
}
