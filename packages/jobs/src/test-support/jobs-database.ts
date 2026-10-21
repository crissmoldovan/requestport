/*
 * The pure half of the integration suites' own databases: their names, their
 * URLs, and which leftovers are safe to drop. The half that talks to the local
 * server, and the guards that decide it may, is packages/jobs/
 * vitest.jobs-database.ts. Nothing here imports a database driver.
 */

/**
 * The comment every database the setup creates carries. Its stale sweep drops
 * a database only when it carries this exact comment, so a database that
 * merely has a matching name — another track's, say — is never touched.
 */
export const jobsDatabaseMarker =
  "requestport-jobs integration database, created and dropped by packages/jobs/vitest.jobs-database.ts";

/** What the local server's database names are made of; nothing needs quoting. */
const identifier = /^[a-z_][a-z0-9_]*$/u;

/** PostgreSQL truncates a longer name without saying so. */
const maxIdentifierLength = 63;

/** `name`, unless PostgreSQL would truncate it. */
function untruncated(name: string): string {
  if (name.length > maxIdentifierLength) {
    throw new Error(
      `${name} is longer than PostgreSQL's ${maxIdentifierLength} characters, which it would truncate.`,
    );
  }
  return name;
}

/**
 * What a database name of the setup's holds between the configured local
 * database's name and the process id: `_jobs_` for the run's, `_jbin_` for
 * `src/bin.integration.test.ts`'s. The two are as long as each other, so the
 * second name is no longer than the first (ruling 232 item 1).
 */
const runInfix = "_jobs_";
const binInfix = "_jbin_";

/** `<base><infix><pid>`, refused unless `base` and `pid` are plain, or past 63 characters. */
function databaseName(base: string, infix: string, pid: number): string {
  if (!identifier.test(base)) {
    throw new Error(
      `The local database's name ${JSON.stringify(base)} is not made of a-z, 0-9 and _, so no name for the jobs integration database is derived from it.`,
    );
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Not a process id: ${pid}.`);
  }
  return untruncated(`${base}${infix}${pid}`);
}

/**
 * `<base>_jobs_<pid>`: the configured local database's name, and the id of the
 * process that creates it, so two runs never share one and a leftover names
 * the run that left it.
 */
export function jobsDatabaseName(base: string, pid: number): string {
  return databaseName(base, runInfix, pid);
}

/**
 * `<base>_jbin_<pid>`: the database `src/bin.integration.test.ts` alone
 * uses (X28, ruling 231), which the same setup makes beside the run's, for
 * the same run, in a project whose files include that one (ruling 232 item
 * 1). That file's workers run every schedule on their database when they
 * start, so they get one no other suite writes to: due work another suite
 * leaves in the run's database cannot reach them. It is as long as the
 * run's name: scripts/create-track-worktree.mjs accepts a base of up to 50
 * characters, and with a process id of up to 7 digits both fit in 63.
 */
export function jobsBinDatabaseName(base: string, pid: number): string {
  return databaseName(base, binInfix, pid);
}

/**
 * The process id in a name `jobsDatabaseName(base, …)` or
 * `jobsBinDatabaseName(base, …)` made, or undefined.
 */
export function jobsDatabasePid(
  name: string,
  base: string,
): number | undefined {
  for (const infix of [runInfix, binInfix]) {
    const prefix = `${base}${infix}`;
    if (!name.startsWith(prefix)) continue;
    const pid = name.slice(prefix.length);
    return /^[1-9][0-9]*$/u.test(pid) ? Number(pid) : undefined;
  }
  return undefined;
}

/**
 * Of the databases carrying `jobsDatabaseMarker`, the ones a run of `base`
 * left behind whose process no longer exists, the run's and bin's alike: a
 * run that was killed before its teardown. A live run's database, or another
 * base's, is never chosen.
 */
export function staleJobsDatabases(
  marked: readonly string[],
  base: string,
  alive: (pid: number) => boolean,
): string[] {
  return marked.filter((name) => {
    const pid = jobsDatabasePid(name, base);
    return pid !== undefined && !alive(pid);
  });
}

/** Whether a process with this id exists on this machine. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `url` with only its database name replaced. */
export function withDatabaseName(url: string, name: string): string {
  if (!identifier.test(name)) {
    throw new Error(`Not a database name this setup creates: ${name}.`);
  }
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
