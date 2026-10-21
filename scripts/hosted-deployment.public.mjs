/**
 * The public variant of `scripts/hosted-deployment.mjs` (Plan 13, Track J:
 * `manifest-j.md` §2.2 and §2.4 items 2 and 5; ruling 91, option (d)).
 *
 * `release/public-tree.json`'s `substitute` rule names this file as the text
 * the public seed carries at that path in place of the private module, which
 * the seed excludes. It declares that the tree operates no hosted deployment:
 * no shared database to refuse, and no production migration state. So in the
 * seed the guard's refusal (`production-database-guard.mjs`) compares against
 * an empty list and refuses nothing, and a checkout of the public repository
 * is not protected from a database it was never told about (owner question
 * 15). The migration-state step (`migration-state.mjs`) reads no record,
 * reports the journal's ordering constraint and fails nothing, and the
 * production launcher refuses to run (ruling 99; `hosted-deployment.test.mjs`
 * runs both against this file).
 *
 * Nor does the tree run a hosted database driver (J.2b; ruling 175, owner
 * question 3): its drivers are pg and PGlite (`packages/db/src/hosted-driver.ts`,
 * whose public variant this tree carries too). So it names no driver package
 * and no local proxy variable, and has no pool to hand the launcher, which
 * refuses before it would ask for one, or the preview journal command
 * (`packages/db/scripts/read-preview-migration-journal.mjs`), which prints its
 * one failure line when it asks. It names no database project either,
 * so the deployment preflight (`database-target-preflight.mjs`) compares the
 * database's host and name alone, and no service's variable prefix, so a
 * track worktree's children and `packages/jobs`' database setup drop by
 * their own prefixes alone (`PG`, `POSTGRES_`, `VERCEL_`, `DATABASE_` and
 * `REQUESTPORT_PREVIEW_`).
 *
 * It exports exactly the names the private module exports
 * (`export-public-tree.test.mjs`), and `workspace-contract.test.mjs` pins it
 * to `kind: "public"` with no entry, no path, no driver and no project.
 */
export const kind = "public";

export const sharedDatabases = Object.freeze([]);

export const migrationState = null;

export const hostedDriverPackages = Object.freeze([]);

export const localProxyVariable = null;

export const databaseProjectVariables = null;

export const providerVariablePrefixes = Object.freeze([]);

export function createHostedPool() {
  throw new Error(
    "This tree has no hosted database driver: its drivers are pg and PGlite.",
  );
}
