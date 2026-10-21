import type { WorkerStorages } from "@requestport/db";
import {
  useWorkerSettings,
  useWorkerStorages,
  type WorkerSettings,
  workSweepFingerprintSecret,
} from "@requestport/jobs/worker-storages";

/*
 * The worker settings' holder (`@requestport/jobs/worker-storages`), as a
 * `postgres` background uses it (`background.ts`). Only the dynamic imports
 * in `background.ts` load this module, when a background's function runs,
 * and core's entry does not. The holder imports no root: the worker root,
 * which reaches the lazily parsed server configuration and db's wiring
 * module, is registered by `@requestport/jobs`' own module, which core never
 * loads (ruling 139, option (b); `import.test.ts`). Unless something else in
 * the process loads that module, the holder holds only what a background
 * installs, and refuses with nothing installed. The sweep key's derivation,
 * `workSweepFingerprintSecret`, is the holder's own (ruling 144). It takes
 * the holder's functions by name, as a module the tenant-scope sweep models
 * must be taken (`packages/db/src/tenant-scope-sweep.test.ts`), which
 * reports a dynamic import of the holder itself as a binding it cannot
 * follow.
 */

/** Installs `storages` and `settings` where the job bodies reach them. */
export function installWorkerHolders(
  storages: WorkerStorages,
  settings: WorkerSettings,
): void {
  useWorkerStorages(storages);
  useWorkerSettings(settings);
}

/** Forgets what `installWorkerHolders` installed, so another may install. */
export function forgetWorkerHolders(): void {
  useWorkerStorages(undefined);
  useWorkerSettings(undefined);
}

export { workSweepFingerprintSecret };
