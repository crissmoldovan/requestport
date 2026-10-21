// The two functions of @requestport/db that `run.ts` needs once it has
// written the environment: the surface declaration and its reading
// (`packages/db/src/role-guard.ts`). `run.ts` imports this module
// dynamically, where it imported the package itself before. esbuild keeps
// every export of a module imported dynamically, so the bundle it writes for
// the tarball held the E2E owner storage (two chunks of `dist/` at 867927cc);
// re-exported by name from here, the package's other exports stayed only
// where a bundled module used them, and with this module none of `dist/` held
// the storage (H.7, ruling 170's round; scripts/pack-requestport.mjs refuses a
// tarball that holds it). Since H.7's fourth round's slice d the bundle leaves
// @requestport/db external, so `dist/` holds none of db's modules either way;
// this module stays `run.ts`'s one import of the two. In the repository
// nothing changes: tsx loads the package whole either way.
//
// The two are imported by name and exported, not re-exported with
// `export … from`: the tenant-scope sweep
// (`packages/db/src/tenant-scope-sweep.test.ts`, "finds no query outside
// packages/db but the E2E hook") refuses a re-export of `@requestport/db`
// outside packages/db, which it cannot follow, and checks a named import by
// its names, neither of which opens a storage.
import {
  declareDatabaseSurface,
  declaredDatabaseSurface,
} from "@requestport/db";

export { declareDatabaseSurface, declaredDatabaseSurface };
