import {
  LOGIN_KINDS,
  LOGIN_URL_VARIABLES,
  type StorageKind,
} from "../configuration.js";

/**
 * The serving process's environment (manifest-h.md §2.3, §2.4; ruling 158,
 * item 11). This module imports no workspace package: `requestport start`
 * changes its environment before it imports what reads it.
 */

/**
 * The names the role guard's environment check objects to
 * (`ownerCapableVariableNames`, `packages/db/src/role-guard.ts`):
 * `DATABASE_URL`, every `DATABASE_URL_*` name (a direct owner URL,
 * `DATABASE_URL_UNPOOLED`, among them; ruling 217 item 2), and every
 * `POSTGRES_*` and `PG*` name, which is what a database service's Vercel
 * connection injects and what an owner's URL or a libpq default travels in.
 * Written out here so that this module loads no workspace package;
 * `environment.test.ts` holds it equal to the guard's own list, name by
 * name.
 */
export function ownerCapableNames(env: NodeJS.ProcessEnv): string[] {
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
 * Removes every owner-capable name from `env`, the serving process's own
 * environment, and says one line for each, naming the variable and never its
 * value. On pg the serving process connects as the instance's logins,
 * through the URLs `requestport start` writes, and on PGlite to no server,
 * and it carries none of these, so a self-hoster's shell that sets one is
 * not refused (ruling 158, item 11). Answers the names removed.
 */
export function removeOwnerCapableVariables(
  env: NodeJS.ProcessEnv,
  say: (line: string) => void,
  kind: StorageKind = "pg",
): string[] {
  const names = ownerCapableNames(env);
  for (const name of names) {
    delete env[name];
    say(
      kind === "pg"
        ? `removed ${name} from the serving process's environment: it connects as this instance's logins, never through ${name}.`
        : `removed ${name} from the serving process's environment: on PGlite it connects to no server.`,
    );
  }
  return names;
}

/**
 * On PGlite, removes the instance logins' four URL variables from `env`, one
 * line each, never the value: they name a PostgreSQL server, which a PGlite
 * instance never connects to, and the application's would turn the root
 * storage's tenant binding on (`tenantWrappingEnabled`) and the worker's
 * three would bind the worker to a server. Answers the names removed.
 */
export function removeLoginUrlVariables(
  env: NodeJS.ProcessEnv,
  say: (line: string) => void,
): string[] {
  const names = LOGIN_KINDS.map((kind) => LOGIN_URL_VARIABLES[kind]).filter(
    (name) => env[name] !== undefined,
  );
  for (const name of names) {
    delete env[name];
    say(
      `removed ${name} from the serving process's environment: on PGlite it connects to no server.`,
    );
  }
  return names;
}

/**
 * The GitHub pair and the Resend pair (`@requestport/config`'s sign-in
 * methods). `requestport start` composes Better Auth without either
 * (`authEnvironment`, `serve.ts`) and hands core no e-mail sender
 * (`requestPortSecrets`), so it offers neither GitHub nor an e-mailed link.
 * Next's pages, served in the same process, read the sign-in methods from
 * `process.env` (`apps/web/src/app/(auth)/sign-in/page.tsx`), where either
 * pair would offer a method the host does not serve and turn the owner's
 * local credential off (`localCredentialEnabled`).
 */
export const SIGN_IN_PROVIDER_VARIABLES = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
] as const;

/**
 * Removes the GitHub and Resend pairs' names (above) from `env`, the serving
 * process's own environment, one line each, naming the variable and never
 * its value, so that the sign-in page Next serves offers what the host's
 * Better Auth serves. Half a pair, or an empty value, is removed too.
 * Answers the names removed.
 */
export function removeSignInProviderVariables(
  env: NodeJS.ProcessEnv,
  say: (line: string) => void,
): string[] {
  const names = SIGN_IN_PROVIDER_VARIABLES.filter(
    (name) => env[name] !== undefined,
  );
  for (const name of names) {
    delete env[name];
    say(
      `removed ${name} from the serving process's environment: requestport start offers no GitHub sign-in and sends no e-mail, and the sign-in page Next serves reads this environment.`,
    );
  }
  return names;
}

/**
 * What a start on PGlite says before it serves (manifest-h.md §2.6 item 5):
 * it serves one user, binds a loopback address only, and row-level security
 * does not apply to it, because PGlite's one session is its superuser.
 */
export function pgliteHonestyLine(host: string): string {
  return `PGlite serves one user on this machine: this instance binds ${host} only, and row-level security does not apply to its database, which it opens as PGlite's superuser.`;
}

/**
 * What every connection the serving process opens is named in
 * `pg_stat_activity.application_name`: the program and the process's pid,
 * so that an operator, and Done when 10's test, can tell its connections
 * from any other process's.
 */
export function servingApplicationName(pid: number): string {
  return `requestport start ${pid}`;
}

/**
 * `url` with its `application_name` parameter set to `name`. A URL
 * parameter, not `PGAPPNAME`, which the pg path refuses
 * (`UNOVERRIDABLE_PG_VARIABLES`, `packages/db/src/database-url.ts`).
 */
export function withApplicationName(url: string, name: string): string {
  const named = new URL(url);
  named.searchParams.set("application_name", name);
  return named.toString();
}

/**
 * The four login URLs of a canonical environment
 * (`configuration.ts`'s `canonicalEnvironment`), each with the serving
 * process's `application_name`. A name it does not hold is left out.
 */
export function namedLoginUrls(
  environment: Readonly<Record<string, string>>,
  name: string,
): Record<string, string> {
  const named: Record<string, string> = {};
  for (const kind of LOGIN_KINDS) {
    const variable = LOGIN_URL_VARIABLES[kind];
    const url = environment[variable];
    if (url !== undefined) named[variable] = withApplicationName(url, name);
  }
  return named;
}
