#!/usr/bin/env node

/**
 * Applies the checked-in migration history to the production database, and
 * proves the result the same way the CI launcher does: twice, against the
 * journal the checked-in tree must produce. Then it proves the database's
 * integrity the way the staging launcher already did — a gate this one did not
 * have, which left the environment that matters most the only one where a
 * migration could apply and report success over a database in any state at all.
 *
 * Every other launcher in this repository refuses production. This one refuses
 * everything else, and that inversion is the point. A production migration job
 * pointed at some other database exits zero, says "production migrations
 * completed", and leaves production un-migrated — a failure that reads exactly
 * like a success. So the target is checked against the recorded production
 * host digest before anything runs, and the opt-in word is required on top,
 * because a job that can only ever touch production should still say out loud
 * that somebody meant it.
 */

import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as hostedDeployment from "./hosted-deployment.mjs";
import {
  migrationStatePathOf,
  NO_HOSTED_DEPLOYMENT,
  writeRecordedState,
} from "./migration-state.mjs";
import {
  checkedInJournalEntries,
  checkedInMigrationJournal,
  defaultCreatePool,
  defaultRunMigrate,
  migrationEnvironment,
  migrationsAfterOneThatMustBeLast,
  migrationsThatMustBeLast,
  readIntegrityEvidence,
  readJournal,
} from "./migration-support.mjs";
import {
  databaseHostDigest,
  sharedDatabasesOf,
} from "./production-database-guard.mjs";

// What this launcher shares rather than copies: migration-support.mjs's journal
// and integrity-evidence readers, and the guard's databaseHostDigest and
// sharedDatabasesOf. Production's host digest is read through the guard's own
// check of the deployment's list, never copied, so the launcher and the guard
// cannot name different databases.

/** The deployment a run handed none reads: the module the guard reads. */
export const DEFAULT_DEPLOYMENT = hostedDeployment;

const SUCCESS_MESSAGE = "RequestPort production migrations completed.";
const FAILURE_MESSAGE = "RequestPort production migration failed.";

/**
 * Why it refused, in words that reveal nothing.
 *
 * The first real run of this job printed only the line above, and the cause —
 * a connection string stored with its surrounding quotes — was
 * indistinguishable from a missing secret, a wrong database, or a migration
 * that would not apply. That cost a round trip to find out, which is the same
 * shape of afternoon that `Installation failed` cost on the Trigger.dev build.
 *
 * None of these names a value. Each names a check.
 */
const REFUSALS = {
  optIn: `Refused: ${"REQUESTPORT_PRODUCTION_DATABASE"} was not set to the exact approval word.`,
  url: "Refused: DATABASE_URL is not a Postgres URL naming a database. A value stored with surrounding quotes or padding fails here.",
  target:
    "Refused: DATABASE_URL does not name the recorded production database.",
  checkedIn: "Refused: the checked-in migration journal could not be read.",
  command: "Refused: the migration command did not succeed.",
  applied: "Refused: what applied is not the checked-in migration history.",
  converge:
    "Refused: the second apply changed the journal, so the history did not converge.",
  integrity:
    "Refused: the production integrity evidence is missing, malformed, or not clean.",
  sha: `Refused: ${"EXPECTED_MIGRATION_GIT_SHA"} is unset or does not match this checkout's HEAD.`,
  pending:
    "Refused: the database's applied migrations could not be read, so what this run would apply is unknown.",
  lastInTransaction:
    "Refused: a migration that must be the last one applied in its transaction is pending, with another pending migration after it. Apply it from a checkout whose journal ends at that migration, record that, then apply the rest from this checkout.",
  publicTree: `Refused: ${NO_HOSTED_DEPLOYMENT} (scripts/hosted-deployment.mjs is kind "public"), so there is no production database for this launcher to migrate.`,
};
const APPROVAL = "approved";
const OPT_IN = "REQUESTPORT_PRODUCTION_DATABASE";
const EXPECTED_SHA = "EXPECTED_MIGRATION_GIT_SHA";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Rows this gate is required to tolerate, and the number that may not move.
 *
 * The same undeletable residue staging carries twelve of, and whose cause is
 * written down beside staging's number in `run-preview-migrations.mjs`:
 * orphaned appearance events, counted by `aggregate_version_sequence`, in a
 * table the `domain_events_append_only` trigger forbids every UPDATE and DELETE
 * on. The producer was fixed, so this is a fact about rows already written
 * rather than about the schema — and a check that is red forever is not a gate,
 * because the next real corruption arrives indistinguishable from it.
 *
 * Production held 36 on 2026-09-13, none newer than 2026-09-06. Pinned rather
 * than waived, in both directions: a thirty-seventh is either a real gap or the
 * old fixture run against production, and thirty-five means these are not the
 * rows the number was recorded for. Staging's gate carries staging's number.
 */
export const TOLERATED_INTEGRITY_VIOLATIONS = new Map([
  ["aggregate_version_sequence", 36],
]);

/**
 * Runs the CLI's integrity check against production and returns its report.
 *
 * The report is the verdict, not the exit code. The command exits 1 whenever
 * the report is not clean, and this database holds rows it cannot delete, so a
 * launcher that read the exit code would refuse every production run. The exit
 * code carries nothing the report does not — it is one when `ok` is false, and
 * `ok` is in the JSON — and a command that dies without printing a report still
 * fails, because a report that will not parse is refused.
 *
 * The child's output is captured rather than inherited: it is spawned with a
 * production connection string in its environment, and nothing it writes is
 * printed by this launcher.
 */
export function defaultRunIntegrityCheck(env, spawn = spawnSync) {
  const result = spawn(
    "pnpm",
    [
      "--silent",
      "--filter",
      "@requestport/cli",
      "integrity-check",
      "--environment",
      "production",
    ],
    { cwd: repositoryRoot, encoding: "utf8", env, maxBuffer: 1024 * 1024 },
  );

  return typeof result?.stdout === "string" ? result.stdout : "";
}

/**
 * What this launcher takes from a hosted deployment, once checked: its `kind`;
 * the production entry's host digest, `hostSha256`, read through the guard's
 * own check of the list (`sharedDatabasesOf`) rather than copied, because the
 * guard and this launcher have to name the same database or they contradict
 * each other, and two constants drift; and `statePath`, the state file a run
 * records into and names (`migrationStatePathOf`, the check
 * `migration-state.mjs` applies to the same field). A malformed deployment
 * throws, the list checked first. The public variant has no production entry
 * and no state file, and a private one may lack the production entry: both
 * leave `hostSha256` undefined, which `runProductionMigrations` refuses.
 */
export function productionDeploymentOf(deployment) {
  const sharedDatabases = sharedDatabasesOf(deployment);
  const statePath = migrationStatePathOf(deployment);
  return {
    kind: deployment.kind,
    hostSha256: sharedDatabases.find(({ name }) => name === "production")
      ?.hostSha256,
    statePath,
  };
}

// The module's deployment, checked at import, as `migration-state.mjs` checks
// its state file at import: a malformed one stops this module before the
// direct run at the bottom starts.
productionDeploymentOf(hostedDeployment);

export { REFUSALS };

/**
 * The commit this run is allowed to migrate.
 *
 * `production-migrations.yml` did this in shell — it re-fetched `main` right
 * before applying and compared it to `EXPECTED_MIGRATION_GIT_SHA`, so an
 * approval that had sat for hours could not migrate a commit nobody looked at.
 * The workflow is gone and the launcher never read that variable, so the
 * protection went with it and the runbook documented one that did not exist.
 * It exists here now.
 *
 * Required rather than optional. A hand-run migration has no reviewer, so the
 * one remaining discipline is that the operator names what they are migrating
 * and the machine checks they are standing on it.
 */
export function expectedShaMatchesHead(env, readHead = defaultReadHead) {
  const expected = env[EXPECTED_SHA];

  if (
    typeof expected !== "string" ||
    !/^[0-9a-f]{7,40}$/u.test(expected.trim())
  ) {
    return false;
  }

  const head = readHead();

  if (typeof head !== "string" || head === "") return false;

  return head.startsWith(expected.trim()) || expected.trim().startsWith(head);
}

export function defaultReadHead(spawn = spawnSync) {
  const result = spawn("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  return (result.stdout ?? "").trim();
}

function productionConnectionString(env, expectedHostSha256) {
  if (env[OPT_IN] !== APPROVAL) return { refusal: REFUSALS.optIn };

  let url;
  try {
    url = new URL(env.DATABASE_URL ?? "");
  } catch {
    return { refusal: REFUSALS.url };
  }

  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    !url.pathname.startsWith("/") ||
    url.pathname.length < 2
  ) {
    return { refusal: REFUSALS.url };
  }

  // A deployment with no production entry names no database to compare with,
  // so no URL names it.
  if (expectedHostSha256 === undefined) return { refusal: REFUSALS.target };

  // Through the guard's own helper, not a second copy of the rule. A hosted
  // database answers on a pooled and a direct hostname; if one file normalises
  // them together and the other does not, this launcher refuses the database
  // the pipeline was told to migrate and the run fails at the last gate.
  const actual = databaseHostDigest(url.hostname);
  const expected = Buffer.from(expectedHostSha256, "hex");

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { refusal: REFUSALS.target };
  }

  return { connectionString: env.DATABASE_URL };
}

/*
  What Drizzle's migrator will apply, asked the way it asks.

  `drizzle-kit migrate` (0.31.10) imports the migrator of the `drizzle-orm`
  it resolves (0.45.2 here; with `pg` installed, `bin.cjs:78880` imports
  `drizzle-orm/node-postgres/migrator`, and the migrator files of the
  hosted driver's adapter, postgres-js, vercel-postgres and pglite are
  byte-identical to it). Its `migrate` reads the journal with `readMigrationFiles`
  (`drizzle-orm/migrator.js`: each entry's `when` becomes `folderMillis`)
  and hands it to `PgDialect.migrate` (`drizzle-orm/pg-core/dialect.js:44-72`).
  No migrations table or schema is configured in
  `packages/db/drizzle.config.ts`, so it is the default
  `drizzle.__drizzle_migrations` (:45-46). It creates that if it is absent
  (:47-55), reads the one row with the greatest `created_at` (:56-58:
  `select id, hash, created_at from … order by created_at desc limit 1`,
  where a NULL `created_at` sorts first), and inside ONE transaction
  (:60-71) applies every journal entry for which there is no such row or
  `Number(lastDbMigration.created_at) < migration.folderMillis` (:62). Only
  `created_at` is compared; the row's `hash` is never read.

  So this reads the same column of the same row with the same statement, and
  filters the journal with the same comparison. The table's existence is
  asked first, because Drizzle creates it where this must not.
*/
const APPLIED_TABLE_QUERY = `SELECT pg_catalog.to_regclass('"drizzle"."__drizzle_migrations"') IS NOT NULL AS "present"`;
const LATEST_APPLIED_QUERY = `select id, hash, created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1`;

/**
 * The row Drizzle's migrator compares the journal with: `{ latest }`, where
 * `latest` is `undefined` when nothing is applied; or `undefined` itself if
 * anything went wrong, which the caller refuses.
 */
export async function readLatestAppliedMigration(createPool, connectionString) {
  const pool = createPool({ connectionString });
  let failed = false;
  let latest;

  pool.on?.("error", () => {
    failed = true;
  });

  try {
    const table = await pool.query(APPLIED_TABLE_QUERY);
    const present = table?.rows?.[0]?.present;
    if (typeof present !== "boolean") {
      failed = true;
    } else if (present) {
      const result = await pool.query(LATEST_APPLIED_QUERY);
      if (!Array.isArray(result?.rows)) failed = true;
      else latest = result.rows[0];
    }
  } catch {
    failed = true;
  }

  try {
    await pool.end();
  } catch {
    failed = true;
  }

  return failed ? undefined : { latest };
}

/** The journal entries Drizzle's migrator would apply, in its order (:62). */
export function pendingMigrations(entries, latest) {
  return entries.filter(
    (migration) => !latest || Number(latest.created_at) < migration.when,
  );
}

/** The checked-in journal and the tags marked to be last, read from disk. */
function defaultReadMigrationTree() {
  const entries = checkedInJournalEntries();
  return { entries, mustBeLast: migrationsThatMustBeLast(entries) };
}

export async function runProductionMigrations({
  createPool = defaultCreatePool,
  env = process.env,
  // Injected so a suite can hand in a synthetic deployment: the real
  // production host is recorded only as a digest, and only in the private
  // module, which the public seed does not carry.
  deployment = DEFAULT_DEPLOYMENT,
  runIntegrityCheck = defaultRunIntegrityCheck,
  runMigrate = defaultRunMigrate,
  writeError = (line) => console.error(line),
  writeOutput = (line) => console.log(line),
  // Injected so the success path can be tested without touching the tree. The
  // record is what the credential-free alarm in `migration-state.mjs` compares
  // against: without it, nothing outside this machine can tell that production
  // has been given a migration.
  recordState = writeRecordedState,
  readHead = defaultReadHead,
  // Injected so the ordering refusal can be tested against a journal that
  // is not the checked-in one.
  readMigrationTree = defaultReadMigrationTree,
} = {}) {
  const fail = (refusal, ...details) => {
    writeError(FAILURE_MESSAGE);
    writeError(refusal);
    for (const detail of details) writeError(detail);
    return 1;
  };

  // Before a variable is read: the deployment must be well formed, and must
  // record a hosted deployment. The public variant records none, so there is
  // no production database here to migrate.
  let hosted;
  try {
    hosted = productionDeploymentOf(deployment);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (hosted.kind === "public") return fail(REFUSALS.publicTree);

  // Before anything connects: the operator must name the commit they are
  // migrating, and be standing on it.
  if (!expectedShaMatchesHead(env, readHead)) return fail(REFUSALS.sha);

  const target = productionConnectionString(env, hosted.hostSha256);
  if (target.refusal) return fail(target.refusal);
  const { connectionString } = target;

  let expected;
  let tree;
  try {
    expected = checkedInMigrationJournal();
    tree = readMigrationTree();
  } catch {
    return fail(REFUSALS.checkedIn);
  }

  // Before anything is applied: a migration marked to be the last one in its
  // transaction must not be pending with anything after it, because Drizzle
  // would apply both in one transaction (LAST_IN_TRANSACTION_MARKER in
  // migration-support.mjs says why).
  // Asked of the database, not of the recorded state, because the database
  // is what decides what Drizzle applies.
  const applied = await readLatestAppliedMigration(
    createPool,
    connectionString,
  );
  if (applied === undefined) return fail(REFUSALS.pending);
  const blocked = migrationsAfterOneThatMustBeLast(
    pendingMigrations(tree.entries, applied.latest),
    tree.mustBeLast,
  );
  if (blocked !== undefined) {
    return fail(
      REFUSALS.lastInTransaction,
      `  must be last : ${blocked.marked}`,
      `  pending after: ${blocked.after.join(", ")}`,
    );
  }

  const child = migrationEnvironment(env, connectionString);
  const snapshots = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!runMigrate(child)) return fail(REFUSALS.command);

    const snapshot = await readJournal(createPool, connectionString);
    if (snapshot !== expected) {
      return fail(attempt === 0 ? REFUSALS.applied : REFUSALS.converge);
    }
    snapshots.push(snapshot);
  }

  // Byte equality across the two runs is what proves the second apply was a
  // no-op rather than a second, differently-ordered history.
  if (snapshots.length !== 2 || snapshots[0] !== snapshots[1]) {
    return fail(REFUSALS.converge);
  }

  /*
    A journal proves which migrations ran and nothing about what the database
    holds, so the integrity check runs here, against the database this launcher
    has just proved it migrated.

    `VERCEL_ENV` is set because the CLI refuses to run a check for an
    environment it is not in, and `production` is also the value that points
    `@requestport/db` at `DATABASE_URL`: it reads
    `REQUESTPORT_PREVIEW_DATABASE_URL` only when that variable reads `preview`,
    and `migrationEnvironment` has already dropped both preview variables from
    this child.

    A check that will not start returns no report, and no report is a refusal.
  */
  let report;
  try {
    report = runIntegrityCheck({ ...child, VERCEL_ENV: "production" });
  } catch {
    report = undefined;
  }

  const integrity = readIntegrityEvidence(report, {
    environment: "production",
    tolerated: TOLERATED_INTEGRITY_VIOLATIONS,
  });
  if (integrity === undefined) return fail(REFUSALS.integrity);

  // Written before the success line, so a failure to record is a failed run
  // rather than a silent one. The alarm errs towards "pending", so a record
  // that never lands keeps nagging — which is the right way round — but a run
  // that could not write it should say so rather than claim completion. It is
  // handed the deployment's state file, the one named below, so the file
  // written and the `recorded=` line cannot name two paths.
  try {
    recordState(
      {
        journal: expected,
        tag: expected.split(" ")[0].replace("count=", "applied="),
        gitSha: readHead(),
        appliedAt: new Date().toISOString(),
        source: "applied",
      },
      hosted.statePath,
    );
  } catch (error) {
    writeError(
      `Applied, but could not record the state in ${hosted.statePath}: ${error instanceof Error ? error.message : error}`,
    );
    return 1;
  }

  writeOutput(SUCCESS_MESSAGE);
  writeOutput(expected);
  writeOutput(`integrity=ok checks=${integrity.checks}`);
  writeOutput(`recorded=${hosted.statePath}`);
  // Which tolerance this run spent, and at what count. Absent means nothing was
  // spent: every check stood at zero.
  for (const spent of integrity.tolerated) {
    writeOutput(`tolerated=${spent}`);
  }
  return 0;
}

/**
 * Whether this module was run, rather than imported.
 *
 * Compared as filesystem paths, because that is what `process.argv[1]` is. The
 * obvious spelling — `new URL(import.meta.url).pathname` — is the same path
 * percent-encoded, so the two agree only while the checkout path contains no
 * space, `%`, `+` or non-ASCII character. Where they disagree this file is
 * imported and nothing runs: no migration, no output, exit 0, and a green step
 * over an un-migrated production database. Exported so that can be tested,
 * because nothing else about a top-level `if` can be.
 */
export function invokedDirectly(argv1, moduleUrl) {
  return typeof argv1 === "string" && argv1 === fileURLToPath(moduleUrl);
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  process.exitCode = await runProductionMigrations();
}
