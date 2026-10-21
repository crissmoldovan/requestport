import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(
  scriptsDirectory,
  "read-preview-migration-journal.mjs",
);
const journalModule = await import(pathToFileURL(scriptPath)).catch(() => ({}));
const validHash = "a".repeat(64);
const previewUrl =
  "postgresql://preview-user:preview-password-must-not-leak@preview.invalid/requestport";
const genericUrl =
  "postgresql://production-user:production-password-must-not-leak@production.invalid/requestport";
const failureMessage =
  "RequestPort preview migration journal verification failed.";

function requireExport(name) {
  assert.equal(
    typeof journalModule[name],
    "function",
    `${name} must be exported by the journal executable`,
  );
  return journalModule[name];
}

function createPool({ endError, queryError, rows } = {}) {
  const calls = { end: 0, queries: [] };
  const listeners = new Map();
  const pool = {
    calls,
    emit(event, value) {
      listeners.get(event)?.(value);
    },
    async end() {
      calls.end += 1;
      if (endError) throw endError;
    },
    on(event, listener) {
      listeners.set(event, listener);
      return pool;
    },
    async query(query) {
      calls.queries.push(query);
      if (queryError) throw queryError;
      return { rows };
    },
  };
  return pool;
}

async function runJournal({ env, pool, poolError } = {}) {
  const output = [];
  const errors = [];
  const createPoolCalls = [];
  const runPreviewMigrationJournal = requireExport(
    "runPreviewMigrationJournal",
  );
  const status = await runPreviewMigrationJournal({
    createPool(options) {
      createPoolCalls.push(options);
      if (poolError) throw poolError;
      return pool;
    },
    env,
    writeError(line) {
      errors.push(line);
    },
    writeOutput(line) {
      output.push(line);
    },
  });

  return { createPoolCalls, errors, output, status };
}

function assertFixedFailure(result) {
  assert.equal(result.status, 1);
  assert.deepEqual(result.output, []);
  assert.deepEqual(result.errors, [failureMessage]);
  const diagnostics = `${result.output.join("\n")}\n${result.errors.join("\n")}`;
  assert.doesNotMatch(diagnostics, /password-must-not-leak/u);
  assert.doesNotMatch(diagnostics, /driver-secret-sentinel/u);
}

test("canonicalizes one positive migration count and lowercase SHA-256 hash", () => {
  const canonicalizeJournalRows = requireExport("canonicalizeJournalRows");

  assert.equal(
    canonicalizeJournalRows([{ latestHash: validHash, migrationCount: "6" }]),
    `count=6 hash=${validHash}`,
  );
});

test("rejects missing, empty, and malformed journal rows with one fixed error", () => {
  const canonicalizeJournalRows = requireExport("canonicalizeJournalRows");
  const malformedRows = [
    undefined,
    null,
    {},
    [],
    [null],
    [{ latestHash: validHash, migrationCount: "0" }],
    [{ latestHash: validHash, migrationCount: "01" }],
    [{ latestHash: validHash, migrationCount: 6 }],
    [{ latestHash: validHash.toUpperCase(), migrationCount: "6" }],
    [{ latestHash: "f".repeat(63), migrationCount: "6" }],
    [
      { latestHash: validHash, migrationCount: "6" },
      { latestHash: validHash, migrationCount: "6" },
    ],
  ];

  for (const rows of malformedRows) {
    assert.throws(() => canonicalizeJournalRows(rows), {
      message: failureMessage,
    });
  }
});

test("queries the Drizzle journal using only the injected Preview database URL", async () => {
  const pool = createPool({
    rows: [{ latestHash: validHash, migrationCount: "6" }],
  });
  const accesses = [];
  const env = new Proxy(
    {
      DATABASE_URL: genericUrl,
      REQUESTPORT_PREVIEW_DATABASE_URL: previewUrl,
      VERCEL_ENV: "preview",
    },
    {
      get(target, property) {
        accesses.push(property);
        if (property === "DATABASE_URL") {
          throw new Error("generic database identity was read");
        }
        return Reflect.get(target, property);
      },
    },
  );

  const result = await runJournal({ env, pool });

  assert.equal(result.status, 0);
  assert.deepEqual(result.output, [`count=6 hash=${validHash}`]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.createPoolCalls, [{ connectionString: previewUrl }]);
  assert.deepEqual(accesses, [
    "VERCEL_ENV",
    "REQUESTPORT_PREVIEW_DATABASE_URL",
  ]);
  assert.equal(pool.calls.queries.length, 1);
  assert.match(
    pool.calls.queries[0],
    /FROM "drizzle"\."__drizzle_migrations"/u,
  );
  assert.match(pool.calls.queries[0], /ORDER BY "created_at" DESC, "id" DESC/u);
  assert.equal(pool.calls.end, 1);
});

test("fails closed before pool creation outside Preview or without Preview identity", async () => {
  for (const env of [
    { DATABASE_URL: genericUrl, VERCEL_ENV: "production" },
    {
      DATABASE_URL: genericUrl,
      REQUESTPORT_PREVIEW_DATABASE_URL: "",
      VERCEL_ENV: "preview",
    },
    {
      DATABASE_URL: genericUrl,
      REQUESTPORT_PREVIEW_DATABASE_URL: "   ",
      VERCEL_ENV: "preview",
    },
  ]) {
    const result = await runJournal({ env });
    assertFixedFailure(result);
    assert.deepEqual(result.createPoolCalls, []);
  }
});

test("fails with one fixed line when pool creation or the journal query fails", async () => {
  const env = {
    DATABASE_URL: genericUrl,
    REQUESTPORT_PREVIEW_DATABASE_URL: previewUrl,
    VERCEL_ENV: "preview",
  };
  const creationFailure = await runJournal({
    env,
    poolError: new Error(`driver-secret-sentinel ${previewUrl}`),
  });
  assertFixedFailure(creationFailure);

  const pool = createPool({
    queryError: new Error(`driver-secret-sentinel ${previewUrl}`),
  });
  const queryFailure = await runJournal({ env, pool });
  assertFixedFailure(queryFailure);
  assert.equal(pool.calls.end, 1);
});

test("fails with one fixed line when rows are malformed or pool cleanup fails", async () => {
  const env = {
    DATABASE_URL: genericUrl,
    REQUESTPORT_PREVIEW_DATABASE_URL: previewUrl,
    VERCEL_ENV: "preview",
  };
  const malformedPool = createPool({ rows: [] });
  const malformed = await runJournal({ env, pool: malformedPool });
  assertFixedFailure(malformed);
  assert.equal(malformedPool.calls.end, 1);

  const cleanupPool = createPool({
    endError: new Error(`driver-secret-sentinel ${previewUrl}`),
    rows: [{ latestHash: validHash, migrationCount: "6" }],
  });
  const cleanupFailure = await runJournal({ env, pool: cleanupPool });
  assertFixedFailure(cleanupFailure);
  assert.equal(cleanupPool.calls.end, 1);
});

test("fails closed after an asynchronous pool error without serializing it", async () => {
  const pool = createPool({
    rows: [{ latestHash: validHash, migrationCount: "6" }],
  });
  const originalQuery = pool.query;
  pool.query = async (query) => {
    const result = await originalQuery(query);
    pool.emit("error", new Error(`driver-secret-sentinel ${previewUrl}`));
    return result;
  };

  const result = await runJournal({
    env: {
      REQUESTPORT_PREVIEW_DATABASE_URL: previewUrl,
      VERCEL_ENV: "preview",
    },
    pool,
  });

  assertFixedFailure(result);
  assert.equal(pool.calls.end, 1);
});

test("the executable prints one fixed failure line for generic identity", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: {
      DATABASE_URL: genericUrl,
      PATH: process.env.PATH,
      VERCEL_ENV: "production",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${failureMessage}\n`);
  assert.doesNotMatch(result.stderr, /password-must-not-leak/u);
});
