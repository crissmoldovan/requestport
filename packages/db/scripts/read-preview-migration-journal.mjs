#!/usr/bin/env node

import { fileURLToPath } from "node:url";

// The pool is the hosted driver's, from the private module the public seed
// substitutes (Plan 13, J.2b; ruling 175, owner question 3): `createHostedPool`
// requires the driver from this package's own manifest when called. Its public
// variant has no hosted driver and throws, which this command reports as its
// one failure line.
import { createHostedPool } from "../../../scripts/hosted-deployment.mjs";

const FAILURE_MESSAGE =
  "RequestPort preview migration journal verification failed.";
const COUNT_PATTERN = /^[1-9][0-9]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const JOURNAL_QUERY = `SELECT COUNT(*)::text AS "migrationCount",
  (
    SELECT "hash"
    FROM "drizzle"."__drizzle_migrations"
    ORDER BY "created_at" DESC, "id" DESC
    LIMIT 1
  ) AS "latestHash"
FROM "drizzle"."__drizzle_migrations"`;

function journalFailure() {
  return new Error(FAILURE_MESSAGE);
}

export function canonicalizeJournalRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw journalFailure();
  }

  const [row] = rows;
  if (
    typeof row !== "object" ||
    row === null ||
    Array.isArray(row) ||
    typeof row.migrationCount !== "string" ||
    !COUNT_PATTERN.test(row.migrationCount) ||
    typeof row.latestHash !== "string" ||
    !SHA256_PATTERN.test(row.latestHash)
  ) {
    throw journalFailure();
  }

  return `count=${row.migrationCount} hash=${row.latestHash}`;
}

export async function runPreviewMigrationJournal({
  createPool = createHostedPool,
  env = process.env,
  writeError = (line) => console.error(line),
  writeOutput = (line) => console.log(line),
} = {}) {
  if (env.VERCEL_ENV !== "preview") {
    writeError(FAILURE_MESSAGE);
    return 1;
  }

  const databaseUrl = env.REQUESTPORT_PREVIEW_DATABASE_URL;
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) {
    writeError(FAILURE_MESSAGE);
    return 1;
  }

  let pool;
  try {
    pool = createPool({ connectionString: databaseUrl });
  } catch {
    writeError(FAILURE_MESSAGE);
    return 1;
  }

  let failed = false;
  let snapshot;
  pool.on("error", () => {
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

  if (failed || !snapshot) {
    writeError(FAILURE_MESSAGE);
    return 1;
  }

  writeOutput(snapshot);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPreviewMigrationJournal();
}
