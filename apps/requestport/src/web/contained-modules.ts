import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What requestport's self-host Next build compiles in (Plan 13, H.7, round
 * 5; ruling 197 item 4, which ruling 198 item 1 restates: a tarball's
 * `THIRD-PARTY-NOTICES` covers every third-party package whose code that
 * tarball contains, and may cover more).
 *
 * `self-host-seams.ts`, the module `buildSelfHostWeb` preloads into `next
 * build`, gives `ContainedModulesWebpackPlugin` to every webpack
 * configuration of that build when `SELF_HOST_CONTAINED_VARIABLE` names a
 * directory, which `scripts/pack-requestport.mjs`'s `buildWeb` does and
 * nothing else does. Once each compilation is sealed (child compilations
 * among them), the plugin records its compiler's name (Next names its three
 * `client`, `server` and `edge-server`: `next@16.4.2`'s
 * `dist/build/webpack/config/blocks/base.js:27`, which webpack gives the
 * compiler as its `name`), and the file of every module webpack put in a
 * chunk of it; a module that webpack concatenated into another is recorded
 * by each module it holds. The pack refuses a record that lacks any of the
 * three, so a compilation whose record was lost cannot drop its packages
 * from the notices unseen. A module webpack built and then left out of
 * every chunk (an unused re-export of a package without side effects) is not
 * recorded, and neither is an external, which has no file of its own
 * (webpack's `ExternalModule` has no `resource`): Next's trace copies those
 * into the standalone tree, and
 * `scripts/pack-requestport.mjs` ships none of it. On exit the preload
 * writes what its process recorded (`writeContainedModules`), and the pack
 * maps each file to the package whose `node_modules` directory holds it.
 *
 * It records; it changes nothing webpack builds.
 */
export const SELF_HOST_CONTAINED_VARIABLE = "REQUESTPORT_SELF_HOST_CONTAINED";

/**
 * What a process of the build recorded: the compiler of each compilation it
 * sealed, by name (`""` for a compiler without one), once per compilation;
 * each file in a chunk, by the path webpack gave its module; and, by its
 * real path (`realPath`), each file every module of which that webpack put
 * in a chunk, under any of the file's paths, in every compilation the
 * process sealed, was built from another module's text (`replaced`: a test
 * seam's real module from its inert one, a private module from its public
 * variant, as `test-seams.ts`' `InertSeamsWebpackPlugin`'s
 * `builtFromReplacement` says of the module), so that a file one module of
 * which was built as it is, in any compilation and under any of its paths
 * (through a symbolic link to its workspace, as webpack keeps a path with
 * `resolve.symlinks` off, or as resolved), is not; each sorted.
 */
export type ContainedModules = Readonly<{
  compilers: readonly string[];
  files: readonly string[];
  replaced: readonly string[];
}>;

type ModuleLike = {
  resource?: unknown;
  loaders?: unknown;
  modules?: Iterable<ModuleLike>;
};
type CompilationLike = {
  compiler: { name?: string };
  modules: Iterable<ModuleLike>;
  chunkGraph: { getNumberOfModuleChunks(module: ModuleLike): number };
  hooks: { afterSeal: { tap(name: string, callback: () => void): void } };
};
type CompilerLike = {
  hooks: {
    compilation: {
      tap(name: string, callback: (compilation: CompilationLike) => void): void;
    };
  };
};

const PLUGIN = "RequestPortContainedModules";

/**
 * A module's file: its `resource` without the query or fragment webpack keeps
 * after the path (`?__next_metadata__`, a loader's options), or `undefined`
 * when it has none (a module a loader generates, a runtime module).
 */
export function moduleFile(resource: unknown): string | undefined {
  if (typeof resource !== "string") return undefined;
  const [file] = resource.split(/[?#]/u);
  return file === "" ? undefined : file;
}

/** `file` as the file system resolves it where it exists, and as given where it does not. */
function realPath(file: string): string {
  return existsSync(file) ? realpathSync(file) : file;
}

/** The webpack plugin (this module's header): `files` and `compilers` are what it recorded. */
export class ContainedModulesWebpackPlugin {
  readonly files = new Set<string>();
  readonly compilers: string[] = [];
  readonly #builtFromReplacement: (module: ModuleLike) => boolean;
  /** Each file built from its replacement, and each built as it is, by its real path. */
  readonly #replaced = new Set<string>();
  readonly #asIs = new Set<string>();
  /** Each file's real path, by the path webpack gave it, read once. */
  readonly #real = new Map<string, string>();

  /**
   * `builtFromReplacement`: whether webpack built a module from another
   * module's text, as the inert-seams plugin of the same process says of it
   * (`InertSeamsWebpackPlugin`'s `builtFromReplacement`, which reads the
   * module's own loaders); no module, unless a caller hands one.
   */
  constructor(
    builtFromReplacement: (module: ModuleLike) => boolean = () => false,
  ) {
    this.#builtFromReplacement = builtFromReplacement;
  }

  apply(compiler: CompilerLike): void {
    compiler.hooks.compilation.tap(PLUGIN, (compilation) => {
      compilation.hooks.afterSeal.tap(PLUGIN, () => {
        this.compilers.push(compilation.compiler.name ?? "");
        for (const module of compilation.modules) {
          if (compilation.chunkGraph.getNumberOfModuleChunks(module) > 0) {
            this.#record(module);
          }
        }
      });
    });
  }

  #record(module: ModuleLike): void {
    if (module.modules !== undefined) {
      for (const inner of module.modules) this.#record(inner);
      return;
    }
    const file = moduleFile(module.resource);
    if (file === undefined) return;
    this.files.add(file);
    let real = this.#real.get(file);
    if (real === undefined) {
      real = realPath(file);
      this.#real.set(file, real);
    }
    if (this.#builtFromReplacement(module)) this.#replaced.add(real);
    else this.#asIs.add(real);
  }

  /** What it recorded, as `writeContainedModules` writes it. */
  recorded(): ContainedModules {
    return {
      compilers: [...this.compilers].sort(),
      files: [...this.files].sort(),
      replaced: [...this.#replaced]
        .filter((file) => !this.#asIs.has(file))
        .sort(),
    };
  }
}

/**
 * Writes what `plugin` recorded into `directory`, as `<pid>.json`, one file
 * per process, so that no process of the build overwrites another's. Writes
 * nothing for a process that sealed no compilation (one Next starts that
 * inherits the preload and runs no webpack). Answers the file, or
 * `undefined`.
 */
export function writeContainedModules(
  directory: string,
  plugin: ContainedModulesWebpackPlugin,
  pid: number = process.pid,
): string | undefined {
  if (plugin.compilers.length === 0) return undefined;
  const file = join(directory, `${pid}.json`);
  writeFileSync(file, `${JSON.stringify(plugin.recorded())}\n`);
  return file;
}
