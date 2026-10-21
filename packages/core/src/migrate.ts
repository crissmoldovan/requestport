/*
  `@requestport/core/migrate`: the migrator, re-exported from
  `@requestport/db/migrate` (Done when 12 under S1; Plan 13, G.7, rulings 139
  and 150). A subpath of its own, as in `db`, so that a process importing `.`
  does not load the migrator: `RequestPort.migrate` reaches it only through a
  dynamic import when it is called (`request-port.ts`). `.` re-exports the
  `MigrationReport` type, which `RequestPort.migrate` returns. The
  tenant-scope sweep follows `migrate` imported from here as it follows it
  imported from `@requestport/db/migrate`
  (`packages/db/src/tenant-scope-sweep.test.ts`, `coreReexports`).
*/
export { type MigrationReport, migrate } from "@requestport/db/migrate";
