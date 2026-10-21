/**
 * The module `buildSelfHostWeb` preloads into `next build` (`node --import`),
 * for the self-host build alone (Plan 13, H.7; ruling 174): it installs
 * `installNextConfigHook` in that process, so that apps/web's
 * configuration, as Next loads it there, adds `InertSeamsWebpackPlugin`
 * with `selfHostReplacements`, and each seam's real module is built from
 * its inert one, and each private module of `packages/core/bundle.mjs`'s
 * `publicVariants` (`db`'s shared databases, its hosted driver and that
 * driver's migrator) from its public variant (ruling 193 item 5; ruling 194
 * item 3; `test-seams.ts`). apps/web/next.config.ts is not
 * changed, and no other build loads this.
 *
 * Next runs webpack in this process: a configuration with a `webpack`
 * function turns its build worker off. A process that runs webpack without
 * this preload would build the real modules: `buildSelfHostWeb` would
 * refuse a seam's marker in what it built (`builtSeamProblems`); and that
 * process would record no compilation, so the build's record would lack its
 * compilers, and `scripts/pack-requestport.mjs` refuses a record that lacks
 * any of Next's three (`containedClosure`).
 *
 * When `SELF_HOST_CONTAINED_VARIABLE` names a directory
 * (`scripts/pack-requestport.mjs`'s `buildWeb` sets it; nothing else does),
 * it gives every such configuration `ContainedModulesWebpackPlugin` too,
 * after the inert-seams plugin, which records the file of every module the
 * build puts in a chunk (`contained-modules.ts`; ruling 197 item 4) and,
 * by the inert-seams plugin's `builtFromReplacement`, each file every such
 * module of which was built from its replacement; and on exit writes what
 * this process recorded there. The pack refuses a build that put a private
 * module in a chunk and did not build it from its public variant
 * (`privateModuleBuildProblems`).
 *
 * On exit, in a process where it gave the plugin to a configuration, it says
 * on standard error how many it gave it to and which modules were replaced.
 * It fails nothing itself: a process Next starts may inherit this preload
 * and never load a configuration, and what decides is the build's own scan
 * and the pack's check.
 */
import Module from "node:module";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ContainedModulesWebpackPlugin,
  SELF_HOST_CONTAINED_VARIABLE,
  writeContainedModules,
} from "./contained-modules.ts";
import {
  InertSeamsWebpackPlugin,
  installNextConfigHook,
  type ModuleClassLike,
  selfHostReplacements,
} from "./test-seams.ts";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const plugin = new InertSeamsWebpackPlugin(
  selfHostReplacements(repositoryRoot),
);
const seen = installNextConfigHook({
  directory: process.cwd(),
  plugin,
  moduleClass: Module as unknown as ModuleClassLike,
});
const records = process.env[SELF_HOST_CONTAINED_VARIABLE];
const recorder =
  records === undefined || records === ""
    ? undefined
    : new ContainedModulesWebpackPlugin((module) =>
        plugin.builtFromReplacement(module),
      );
if (recorder !== undefined) {
  installNextConfigHook({
    directory: process.cwd(),
    plugin: recorder,
    moduleClass: Module as unknown as ModuleClassLike,
  });
}

process.on("exit", () => {
  if (seen.configs === 0) return;
  const replaced = [...plugin.replaced]
    .map((path) => relative(repositoryRoot, path))
    .sort();
  process.stderr.write(
    `requestport self-host build: the inert test seams and the private modules' public variants were given to ${seen.configs} next.config load(s); modules replaced: ${replaced.length === 0 ? "none" : replaced.join(", ")}\n`,
  );
  if (recorder !== undefined && records !== undefined) {
    const written = writeContainedModules(records, recorder);
    if (written !== undefined) {
      process.stderr.write(
        `requestport self-host build: recorded ${recorder.files.size} module file(s) in the chunks of ${recorder.compilers.length} sealed compilation(s), by compiler ${JSON.stringify([...recorder.compilers].sort())}\n`,
      );
    }
  }
});
