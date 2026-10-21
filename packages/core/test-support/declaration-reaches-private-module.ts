/*
  Test support for `src/bundle.test.ts`, and no entry of a row of
  `bundle.mjs`'s `bundles`: that test's control bundles build it through
  `tsconfig.private-module-control.json`, with and without `publicVariants`.
  It imports `db`'s private module as a namespace that a type reads, so its
  declaration imports the module too, as a planted
  `export type … = typeof sharedDatabases.kind` in `database-url.ts` would
  (G's S8 set, ruling 183's round, after the independent review).
*/
// biome-ignore lint/style/useImportType: the namespace import in the form database-url.ts uses.
import * as sharedDatabases from "../../db/src/shared-databases.js";

export type PrivateModuleKind = typeof sharedDatabases.kind;
