/*
 * The owner-capable variable names, for the scripts that start a process
 * refused beside one (Plan 13, I.2 step 7; ruling 224 item 3).
 *
 * Since step 7 the role guard's environment check refuses an `application`
 * storage at its first use in a process whose environment names
 * `DATABASE_URL`, any `DATABASE_URL_*`, any `PG*` or any `POSTGRES_*`
 * (`ownerCapableVariableNames`, `packages/db/src/role-guard.ts`), and since
 * I.2b's b6 `requestport-jobs` exits 2 before starting beside one. The
 * scripts here hand those processes an environment without them:
 * `with-root-env.mjs --without-owner-variables`, which `pnpm dev` runs for
 * the web application and `pnpm --filter @requestport/jobs worker` for the
 * worker (ruling 225 item 3), and the acceptance server's start
 * (`start-e2e-server.mjs`). Migrations, the suites and the browser lanes'
 * runner keep `DATABASE_URL`.
 *
 * The rule is written out here because a script cannot load the database
 * package's TypeScript; `packages/db/src/owner-capable-copies.test.ts` holds
 * it equal to the guard's own, name by name.
 */

/**
 * The owner-capable names in `env`: `DATABASE_URL`, every `DATABASE_URL_*`,
 * every `POSTGRES_*` and every `PG*` name. Names only, sorted; an empty value
 * still counts.
 */
export function ownerCapableVariableNames(env) {
  return Object.keys(env)
    .filter(
      (name) =>
        name === "DATABASE_URL" ||
        name.startsWith("DATABASE_URL_") ||
        name.startsWith("POSTGRES_") ||
        /^PG[A-Z0-9_]*$/u.test(name),
    )
    .sort();
}

/**
 * Removes every owner-capable name from `env`, in place, calling `say` with
 * each name removed (never its value), and answers the names.
 */
export function removeOwnerCapableVariables(env, say = () => undefined) {
  const names = ownerCapableVariableNames(env);

  for (const name of names) {
    delete env[name];
    say(name);
  }
  return names;
}
