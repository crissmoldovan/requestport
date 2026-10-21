/**
 * The two things every migration launcher needs, and nothing else.
 *
 * Both of these used to live inside the CI launchers — `defaultCreatePool` in
 * `create-ci-migration-database.mjs`, `checkedInMigrationJournal` in
 * `run-ci-migrations.mjs` — which meant the production and preview launchers
 * imported from files whose reason for existing was to provision ephemeral
 * hosted databases for a CI job. When that job was deleted on 2026-09-17,
 * deleting the files with it would have taken production migrations down with
 * them; moving these six pieces here is what let the rest go.
 *
 * They belong together because they are one question asked from both ends: what
 * a migration run connects with, what it is supposed to be applying, and what
 * the database says it has applied already.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeJournalRows } from "../packages/db/scripts/read-preview-migration-journal.mjs";
import {
  createHostedPool,
  databaseProjectVariables,
} from "./hosted-deployment.mjs";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const migrationsDirectory = resolve(
  repositoryRoot,
  "packages/db/migrations",
);

/**
 * A pool from the driver `packages/db` itself resolves: production's hosted
 * driver, through `createHostedPool` in `hosted-deployment.mjs`, which says
 * why it is required from the database package's manifest, and only when
 * called. The public variant has no hosted driver and refuses, and the
 * launcher refuses there before it would ask.
 */
export function defaultCreatePool(options) {
  return createHostedPool(options);
}

/**
 * What the checked-in migration tree says it is, as one comparable string.
 *
 * The count alone would not notice a migration edited in place, and the hash
 * alone would not notice one appended, so it is both: the number of entries in
 * the journal, and the digest of the final migration's SQL.
 */
export function checkedInMigrationJournal() {
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDirectory, "meta/_journal.json"), "utf8"),
  );
  const entries = journal.entries;
  const finalTag = entries.at(-1).tag;
  const hash = createHash("sha256")
    .update(
      readFileSync(resolve(migrationsDirectory, `${finalTag}.sql`), "utf8"),
    )
    .digest("hex");

  return `count=${entries.length} hash=${hash}`;
}

/**
 * The checked-in journal's entries, in journal order: each migration's `tag`
 * (its file is `<tag>.sql`) and `when`, the number Drizzle's migrator compares
 * with the database's `created_at` to decide whether it is pending.
 */
export function checkedInJournalEntries(directory = migrationsDirectory) {
  const journal = JSON.parse(
    readFileSync(resolve(directory, "meta/_journal.json"), "utf8"),
  );

  return journal.entries.map(({ tag, when }) => ({ tag, when }));
}

/**
 * The header line that marks a migration as one that must be the last one
 * applied in its transaction.
 *
 * Why such a migration exists: Drizzle's migrator applies every pending
 * migration in one transaction (drizzle-orm `pg-core/dialect.js`,
 * `PgDialect.migrate`: one `session.transaction` around the loop over
 * migrations). So a marked migration's `SET LOCAL` settings carry into
 * anything applied after it in that transaction, and the table locks it
 * takes are held through every round trip of everything after it, to that
 * transaction's commit. `0019_row_security_expand` is the first: its
 * `lock_timeout` of 100 ms would bound a later migration's waits, and its 61
 * `ACCESS EXCLUSIVE` locks would be held while a later migration waited for
 * a lock of its own, which closes the deadlock cycle with queued requests
 * that 0019's NOWAIT loop exists to prevent (track-i2.md §14).
 * `0020_worker_row_security` is the second: the one table it locks is
 * `requestport_private.retention_ages`, which it creates, but its table
 * GRANTs rewrite pg_class rows, so a VACUUM or ANALYZE of a granted
 * table waits for its commit holding SHARE UPDATE EXCLUSIVE, and a later
 * migration in the same transaction that altered that table would wait on
 * the vacuum while the vacuum waited on the transaction (track-i2.md, "b1
 * built").
 *
 * The marker is a line exactly equal to this string in the migration's
 * leading comment block (the lines before its first line that does not start
 * with `--`), so the text quoted in a later comment does not count.
 */
export const LAST_IN_TRANSACTION_MARKER =
  "-- requestport: this migration must be the last one applied in its transaction";

/**
 * The tags of the journal's migrations that carry
 * {@link LAST_IN_TRANSACTION_MARKER} in their header.
 *
 * The one reader of the marker. The production launcher refuses to apply a
 * marked migration with anything pending after it, and the gate's
 * migration-state step fails while the journal holds an entry after a marked
 * migration and production has not been recorded as given the marked one;
 * both ask this.
 */
export function migrationsThatMustBeLast(
  entries = checkedInJournalEntries(),
  directory = migrationsDirectory,
) {
  const marked = new Set();

  for (const { tag } of entries) {
    const lines = readFileSync(resolve(directory, `${tag}.sql`), "utf8").split(
      /\r?\n/u,
    );
    const header = [];
    for (const line of lines) {
      if (!line.startsWith("--")) break;
      header.push(line);
    }
    if (header.includes(LAST_IN_TRANSACTION_MARKER)) marked.add(tag);
  }

  return marked;
}

/**
 * The first marked migration in `batch` that has anything after it, and what
 * follows it, or `undefined` when every marked migration in it is last.
 *
 * `batch` is a set of migrations Drizzle would apply in one transaction, in
 * the order it would apply them: the launcher passes the database's pending
 * migrations, the gate the journal's entries after the recorded count.
 */
export function migrationsAfterOneThatMustBeLast(batch, marked) {
  const tags = batch.map((entry) => entry.tag);
  const index = tags.findIndex(
    (tag, position) => marked.has(tag) && position < tags.length - 1,
  );

  return index === -1
    ? undefined
    : { marked: tags[index], after: tags.slice(index + 1) };
}

/**
 * What the database says it has applied, as the same shape the journal file
 * produces — so the two can simply be compared.
 */
const JOURNAL_QUERY = `SELECT COUNT(*)::text AS "migrationCount",
  (
    SELECT "hash"
    FROM "drizzle"."__drizzle_migrations"
    ORDER BY "created_at" DESC, "id" DESC
    LIMIT 1
  ) AS "latestHash"
FROM "drizzle"."__drizzle_migrations"`;

/**
 * The applied journal, or `undefined` if anything at all went wrong.
 *
 * Every failure collapses to the same answer on purpose. A caller that can tell
 * "the query failed" from "the pool would not close" would be tempted to carry
 * on for one of them, and neither is a state in which it is safe to say what a
 * database has applied.
 */
export async function readJournal(createPool, connectionString) {
  const pool = createPool({ connectionString });
  let failed = false;
  let snapshot;

  pool.on?.("error", () => {
    failed = true;
  });

  try {
    const result = await pool.query(JOURNAL_QUERY);
    snapshot = canonicalizeJournalRows(result?.rows);
  } catch {
    failed = true;
  }

  try {
    await pool.end();
  } catch {
    failed = true;
  }

  return failed ? undefined : snapshot;
}

/** Apply the checked-in migrations, through the workspace's own drizzle-kit. */
export function defaultRunMigrate(env) {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@requestport/db", "db:migrate"],
    { cwd: repositoryRoot, encoding: "utf8", env, stdio: "inherit" },
  );

  return !result.error && result.status === 0;
}

/**
 * An environment naming exactly one database.
 *
 * The preview and Vercel variables are stripped rather than merely overridden,
 * because the Drizzle config reads several of them and the failure mode of
 * getting this wrong is a migration applied to a database nobody named. The
 * application variable is stripped for the integrity check, as a second line:
 * the storage the check reads through, the operator root's, dials
 * `DATABASE_URL` whatever that variable says (`storageOptionsFromEnv` in
 * packages/db; Plan 13, I.2 step 5, slice 1). Before that slice it preferred
 * the variable, and as the application role the check could not see every
 * organisation's rows (manifest-i2.md §1).
 */
export function migrationEnvironment(env, connectionString) {
  const child = { ...env };

  delete child.REQUESTPORT_APPLICATION_DATABASE_URL;
  delete child.VERCEL_ENV;
  delete child.VERCEL_GIT_COMMIT_REF;
  delete child.REQUESTPORT_PREVIEW_DATABASE_URL;
  if (databaseProjectVariables !== null) {
    delete child[databaseProjectVariables.preview];
  }
  child.DATABASE_URL = connectionString;

  return child;
}

/*
 * Moved here from `run-preview-migrations.mjs` when the staging acceptance
 * apparatus was retired. `run-production-migrations.mjs` reads an integrity
 * report with this, so it was the one thing production took from a staging
 * script — and a production launcher importing from a deleted file is how that
 * retirement would have surfaced.
 */
export const INTEGRITY_CHECK_NAMES = new Set([
  "accepted_answer_uniqueness",
  "aggregate_version_sequence",
  "applied_import_report",
  "dispatcher_receipt_reference",
  "event_outbox_correspondence",
  "import_mapping_source",
  "import_report_manifest",
  "live_claim_uniqueness",
  "notification_delivery_reference",
  "outbox_event_reference",
  "question_answer_state",
  "request_scope_consistency",
  "request_event_version",
  "webhook_filter_project_reference",
  "webhook_delivery_reference",
  "work_scope_consistency",
]);

/**
 * The integrity report's verdict, or nothing.
 *
 * Exported and shared with the production launcher rather than copied. The two
 * databases pin different residues, so the tolerances are passed in — but what
 * counts as evidence is one rule, and a second copy of it would drift.
 *
 * The report is the verdict: the CLI exits 1 whenever a check is not clean, and
 * both of these databases hold rows that cannot be deleted, so the callers read
 * this instead of an exit code. Which means this has to fail closed. Anything
 * that is not one canonical JSON object, naming the environment asked about,
 * carrying exactly the sixteen known checks once each with every one either
 * clean at zero or standing at exactly its recorded count, returns `undefined`
 * — and every caller treats that as a refusal.
 *
 * What comes back names the tolerances the report actually spent, because
 * `integrity=ok` cannot distinguish a clean database from one leaning on a
 * pinned residue, and only the run that read the report can say which it was.
 */
export function readIntegrityEvidence(evidence, { environment, tolerated }) {
  try {
    if (typeof evidence !== "string" || !evidence.endsWith("\n")) {
      return undefined;
    }
    const parsed = JSON.parse(evidence.slice(0, -1));
    if (
      `${JSON.stringify(parsed)}\n` !== evidence ||
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.environment !== environment ||
      !Array.isArray(parsed.checks) ||
      parsed.checks.length !== INTEGRITY_CHECK_NAMES.size
    )
      return undefined;
    const names = new Set();
    const spent = [];
    for (const check of parsed.checks) {
      if (
        check === null ||
        typeof check !== "object" ||
        Array.isArray(check) ||
        Object.keys(check).toSorted().join("\n") !== "name\nok\nviolations" ||
        typeof check.name !== "string" ||
        typeof check.ok !== "boolean" ||
        !INTEGRITY_CHECK_NAMES.has(check.name) ||
        names.has(check.name)
      )
        return undefined;
      if (check.ok) {
        if (check.violations !== 0) return undefined;
      } else if (check.violations !== tolerated.get(check.name)) {
        return undefined;
      } else {
        spent.push(`${check.name}:${check.violations}`);
      }
      names.add(check.name);
    }
    return names.size === INTEGRITY_CHECK_NAMES.size
      ? { checks: names.size, tolerated: spent.toSorted() }
      : undefined;
  } catch {
    return undefined;
  }
}
