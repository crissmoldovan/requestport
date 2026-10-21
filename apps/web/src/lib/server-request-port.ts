import type { Database, Storage } from "@requestport/db";
import { applicationStorageFromEnv } from "@requestport/db/wiring";

/**
 * The web's composition root (Plan 13, Track G; manifest-g.md §2.9): the
 * storage this process runs on. It is the one application storage Better
 * Auth's installer (`@requestport/auth/server`) also asks
 * `applicationStorageFromEnv` for, so the process holds one storage and one
 * pool. Importing this module asks for nothing; a call throws unless
 * `instrumentation.ts` has declared the application surface, which Next
 * does before any route runs. The first call builds the storage, from this
 * process's environment, and opens no connection; every later one, from any
 * copy of this module, answers the same storage (`@requestport/db/wiring`).
 *
 * The module imports nothing that parses the server configuration as it
 * loads, so the readiness route (`app/api/health/ready/route.ts`), which
 * imports it, loads where that configuration does not parse, and answers 503
 * (ruling 140). The web's RequestPort, which needs the configuration, is
 * composed over this storage in a module of its own
 * (`server-web-request-port.ts`).
 */
export function webStorage(): Storage {
  return applicationStorageFromEnv();
}

/**
 * The web root's handle, for what a module composes as it loads: the two
 * command transaction managers the web still builds as their modules load
 * (`server-user-commands.ts`, `server-slack.ts`). Each member read asks
 * `webStorage()` for the storage and answers the same member of that
 * storage's `db`, and a method bound to that `db` where the member is one.
 * So loading a module that holds this asks for nothing, and using it asks
 * as a call would (Plan 13, G.2).
 *
 * It stands in for that `db` through its members only, and is not that
 * object. Nothing keyed on a handle's identity sees it as `db`: not `===`,
 * not `instanceof`, and not the tenant binding `createStorage` records
 * against its storage's `db`, which `withTenant` reads through
 * `tenantBindingFor` and, finding none recorded against this object, takes
 * as `"wrapped"`, whatever the storage's own binding is. So it may be handed
 * only where `.transaction` is all that is called on it, as
 * `createCommandTransactionManager`'s `run` does. Where a handle's identity
 * matters, as for a repository or `withTenant`, a module takes
 * `webStorage().db` when the call runs.
 */
export const webDatabase: Database = new Proxy({} as Database, {
  get(_target, property) {
    const { db } = webStorage();
    const value: unknown = Reflect.get(db, property, db);
    return typeof value === "function" ? value.bind(db) : value;
  },
  has(_target, property) {
    return Reflect.has(webStorage().db, property);
  },
});
