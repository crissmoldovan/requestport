import { runJobWorkerCli } from "@requestport/jobs";

/**
 * `requestport worker`: `requestport-jobs` under this program's name, for a
 * self-hoster who runs the worker on its own, for example on a second
 * machine (manifest-h.md §2.5). It reads the environment it is given, which
 * the executable passes as `process.env`, as `requestport-jobs` does (ruling
 * 158, 7), and has no data directory. Its own lines, the job bodies' and the
 * metrics carry the self-host's service names (`requestport-worker`,
 * `requestport-outbox-delivery` and the rest), not the Trigger.dev worker's
 * (ruling 158, 9).
 *
 * On PostgreSQL only (§2.5): an environment that selects PGlite
 * (`REQUESTPORT_DATABASE_DRIVER=pglite`) is refused before anything opens.
 * A PGlite database is opened by one process, `requestport start`, which
 * runs its worker itself (§2.6 items 1 and 3); a second process would open
 * a second engine on the same files, and its advisory runner would never
 * settle on PGlite's one connection.
 *
 * Its own module, which `cli.ts` loads only for this command:
 * `@requestport/jobs`' index registers the worker root as it loads, and no
 * other command may load it. A module of its own, rather than an `import(…)`
 * of the package in `cli.ts`, because the tenant-scope sweep reports an
 * `import(…)` of `@requestport/jobs`, a module it models, and follows a named
 * import (`packages/db`'s `tenant-scope-sweep.test.ts`).
 */
export async function runWorker(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stderr: { write(text: string): unknown } = process.stderr,
): Promise<number> {
  const help = argv.includes("--help") || argv.includes("-h");
  if (!help && env.REQUESTPORT_DATABASE_DRIVER === "pglite") {
    stderr.write(
      "requestport worker: runs on PostgreSQL only. On PGlite, requestport start runs the worker in its own process, the one process that opens the database. Set REQUESTPORT_DATABASE_DRIVER to pg, or unset it.\n",
    );
    return 2;
  }
  return runJobWorkerCli(argv, env, "requestport worker", "self-host");
}
