import { declareDatabaseSurface } from "@requestport/db";

/*
  The configuration `auth:schema` hands the Better Auth CLI
  (`packages/auth/package.json`; ruling 120).

  The CLI's process is an entry point, so it declares its database surface
  first, as the operator CLI does (`apps/cli/src/index.ts`): `operator`,
  never one inferred (ruling 37). The installer is loaded only after that.

  `auth:schema` passes `--adapter drizzle --dialect pg`, so the CLI never
  calls `getAdapter` and nothing asks for a storage. Were anything to, the
  composition's `database` function asks the application root, which
  refuses a process declared as `operator` (`@requestport/db/wiring`).

  The CLI reads `auth.options` after its loader (c12) has merged this module's
  `auth` with `defu`, which spreads it. `server.ts`'s `auth` is a `Proxy` over
  an empty object, which spreads to nothing, so the composition is handed
  over here as a plain object.
*/

declareDatabaseSurface("operator");

const { auth: installed } = await import("./server.js");

export const auth = { options: installed.options };
