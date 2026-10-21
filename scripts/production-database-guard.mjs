import { createHash } from "node:crypto";

import * as hostedDeployment from "./hosted-deployment.mjs";

/**
 * The shared databases this guard refuses live in `./hosted-deployment.mjs`
 * (ruling 91, option (d)), each named by a digest of its hostname, never by
 * the hostname. That module is private: the public seed carries
 * `hosted-deployment.public.mjs` at its path, which names no database. It is
 * imported statically, above, so a checkout without it stops every module
 * that imports this one at import, before any of its code runs.
 *
 * A digest rather than the hostname, because a hostname is a small piece of
 * infrastructure detail nobody needs to publish. The tests beside this file
 * prove the refusal with synthetic hosts and their digests, handed in through
 * the refusal's second parameter, so they name no shared database's host.
 *
 * The digest is of the *normalised* host — see `normalizeDatabaseHostname`.
 */

/**
 * One database answers to more than one name, so compare the name it settles
 * to rather than the name somebody typed.
 *
 * A hosted database publishes two hostnames for the same data: a pooled endpoint
 * and a direct one, differing only by a `-pooler` suffix on the first label.
 * The console hands out the direct string for schema work and drizzle-kit's
 * own guidance asks for it, so an operator reaching for it is following
 * instructions, not going around anything. This guard used to pin the pooled
 * spelling alone and wave the direct one through in silence — which is the
 * 2026-09-07 incident with the alarm disconnected, because the incident was a
 * migration run, and a migration run is exactly when the direct string is used.
 *
 * A trailing dot is stripped for the same reason: `host.` and `host` are the
 * same machine and differ only as text. Case is folded for it too: DNS ignores
 * case, and `new URL()` lowercases a host only for its special schemes
 * (`http:`, `https:` and the rest), never for `postgres:`, so an upper-case
 * spelling of production used to reach this function intact, hash to another
 * digest, and pass.
 *
 * Normalising cannot make a neighbour look like production. Endpoint ids are
 * random, so no project's id is another's with `-pooler` appended, and the test
 * beside this file pins that with a synthetic staging entry's direct host.
 */
export function normalizeDatabaseHostname(hostname) {
  const [first, ...rest] = hostname
    .toLowerCase()
    .replace(/\.$/u, "")
    .split(".");
  return [first.replace(/-pooler$/u, ""), ...rest].join(".");
}

/** The digest this guard compares against, for anyone who must agree with it. */
export function databaseHostDigest(hostname) {
  return createHash("sha256")
    .update(normalizeDatabaseHostname(hostname))
    .digest();
}

const APPROVAL = "approved";
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const ENTRY_NAME = /^[a-z][a-z0-9-]*$/u;
const OPT_IN_NAME = /^REQUESTPORT_[A-Z0-9_]+_DATABASE$/u;
const ENTRY_KEYS = ["databaseNameSha256", "hostSha256", "name", "optIn"].join();

/**
 * What the guard throws when the list itself is wrong. It quotes nothing from
 * the list.
 */
export const SHARED_DATABASE_LIST_MALFORMED =
  "Refused: the shared-database list is malformed (scripts/hosted-deployment.mjs), so every command is refused until it is fixed.";

/**
 * The shared databases `deployment` names, once checked; by default the
 * hosted deployment's, `./hosted-deployment.mjs`.
 *
 * Well formed means: `kind` exactly `"private"` with at least one entry, or
 * exactly `"public"` with none; and every entry an object with exactly `name`,
 * `hostSha256`, `databaseNameSha256` and `optIn`, where `name` is a lower-case
 * word used once, `hostSha256` is 64 lower-case hex characters,
 * `databaseNameSha256` is `null` or 64 lower-case hex characters, and `optIn`
 * is a variable named `REQUESTPORT_<…>_DATABASE`. Anything else throws
 * `SHARED_DATABASE_LIST_MALFORMED`: a list the guard cannot read refuses
 * everything rather than nothing.
 *
 * An entry with a `databaseNameSha256` is refused only when the database name
 * matches too; one without is refused by its host alone. The private module
 * says why each of its entries is one or the other.
 */
export function sharedDatabasesOf(deployment = hostedDeployment) {
  const malformed = () => new Error(SHARED_DATABASE_LIST_MALFORMED);
  if (deployment === null || typeof deployment !== "object") throw malformed();
  const { kind, sharedDatabases } = deployment;
  if (!Array.isArray(sharedDatabases)) throw malformed();
  const shapeFits =
    (kind === "private" && sharedDatabases.length > 0) ||
    (kind === "public" && sharedDatabases.length === 0);
  if (!shapeFits) throw malformed();
  const names = new Set();
  for (const entry of sharedDatabases) {
    if (entry === null || typeof entry !== "object") throw malformed();
    if (Object.keys(entry).sort().join() !== ENTRY_KEYS) throw malformed();
    const { name, hostSha256, databaseNameSha256, optIn } = entry;
    if (typeof name !== "string" || !ENTRY_NAME.test(name) || names.has(name))
      throw malformed();
    names.add(name);
    if (typeof hostSha256 !== "string" || !HEX_DIGEST.test(hostSha256))
      throw malformed();
    if (
      databaseNameSha256 !== null &&
      (typeof databaseNameSha256 !== "string" ||
        !HEX_DIGEST.test(databaseNameSha256))
    )
      throw malformed();
    if (typeof optIn !== "string" || !OPT_IN_NAME.test(optIn))
      throw malformed();
  }
  return sharedDatabases;
}

/**
 * Refuse to touch a shared database unless somebody said to.
 *
 * On 2026-09-07 this checkout's `.env.local` named the production database, so
 * every integration test and every migration run in the worktree wrote to
 * production — a hundred test organizations created, and one half of a
 * migration pair applied outside any pipeline. Nothing was malicious and
 * nothing was even unusual: `with-root-env.mjs` fills unset variables from
 * `.env.local`, which is exactly what it is for.
 *
 * The runbook had already warned about this in prose. Prose did not stop it, so
 * this does. A shared database is reachable deliberately — set its opt-in, or
 * export the values from `.env.prod` — and unreachable by default.
 *
 * The databases are the ones `deployment` names (`sharedDatabasesOf`), by
 * default the hosted deployment's: production and staging in the private
 * tree, none in the public seed. A test hands in its own. The list is checked
 * first, before anything else, so a malformed one refuses even a command with
 * no `DATABASE_URL` at all.
 *
 * The opt-in must read exactly `approved`. A truthy string is something a
 * script sets by accident; a specific word is something a person types.
 */
export function refuseUnapprovedProductionDatabase(
  environment,
  deployment = hostedDeployment,
) {
  const sharedDatabases = sharedDatabasesOf(deployment);
  const url = environment.DATABASE_URL;
  if (typeof url !== "string" || url.trim() === "") return;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not a url this guard can judge. `readDatabaseUrl` refuses it later, and
    // refusing here would only move the error somewhere less informative.
    return;
  }

  // Every host the drivers can dial from this string, not only the one
  // `new URL()` reports: pg and the hosted driver read a `host` in the query in
  // place of the authority's, and pg-connection-string percent-decodes the
  // host where `new URL()` leaves a `postgres:` host encoded. Judging the
  // authority alone passed `…@127.0.0.1/<database>?host=<production>` and a
  // production host with each `-` written `%2D`, both of which reach
  // production.
  const digests = [
    parsed.hostname,
    ...parsed.searchParams.getAll("host").filter((host) => host !== ""),
  ].map((host) => {
    let decoded = host;
    try {
      decoded = decodeURIComponent(host);
    } catch {
      // An undecodable sequence is judged as typed.
    }
    return databaseHostDigest(decoded).toString("hex");
  });
  let databaseName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    databaseName = "";
  }
  const nameDigest = createHash("sha256").update(databaseName).digest("hex");

  for (const shared of sharedDatabases) {
    if (!digests.includes(shared.hostSha256)) continue;
    if (
      shared.databaseNameSha256 !== null &&
      nameDigest !== shared.databaseNameSha256
    )
      continue;
    if (environment[shared.optIn] === APPROVAL) return;

    throw new Error(
      `This command would run against the ${shared.name} database. Set ${shared.optIn}=${APPROVAL} to do that deliberately, or point DATABASE_URL somewhere else — a checkout's .env.local should name neither.`,
    );
  }
}
