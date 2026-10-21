import { resolveJobRunnerKind } from "@requestport/jobs/selection";

/**
 * Next.js calls `register` once per server instance and awaits it before any
 * route runs. It keeps the promise, so a throw here fails every request that
 * instance handles rather than only the first.
 *
 * `REQUESTPORT_JOB_RUNNER` is checked here so a value the web process cannot
 * honour stops it at boot instead of on the first dispatch: anything but unset,
 * empty, `trigger` or `postgres`, and `postgres` wherever `VERCEL_ENV` is set.
 * `src/lib/trigger-client.ts` still reads the variable on every dispatch; the
 * environment does not change under a running process, so what passed here is
 * what it reads.
 *
 * It first declares this process the `application` database surface
 * (manifest-i2.md §2.2, ruling 45), before any route can query: the role
 * guard in `@requestport/db` judges the connection by the surface declared.
 * The one exception is a process `requestport start` has already declared
 * `embedded`: on PGlite it serves this app beside its own host, in its own
 * process, and a second surface would be refused, failing every request
 * (manifest-h.md §2.7.1; ruling 160, item 6). There it declares nothing, and
 * the web's roots answer the storage the host's handoff carries
 * (`@requestport/db/wiring`).
 * Next also compiles this file for the edge runtime, where
 * `@requestport/db` cannot be built (`node:crypto`) and no connection can be
 * opened, so the package is imported only outside it; Next sets
 * `NEXT_RUNTIME` to `edge` there, and webpack drops the branch from that
 * build. A Node process that lacked the variable would still declare.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "edge") {
    const { declareDatabaseSurface, declaredDatabaseSurface } = await import(
      "@requestport/db"
    );
    if (declaredDatabaseSurface() !== "embedded") {
      declareDatabaseSurface("application");
    }
  }
  resolveJobRunnerKind(process.env);
}
