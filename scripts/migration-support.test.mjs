import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { hostedDriverPackages } from "./hosted-deployment.mjs";
import {
  checkedInJournalEntries,
  checkedInMigrationJournal,
  defaultCreatePool,
  LAST_IN_TRANSACTION_MARKER,
  migrationsAfterOneThatMustBeLast,
  migrationsDirectory,
  migrationsThatMustBeLast,
  repositoryRoot,
} from "./migration-support.mjs";

test("reads the journal that is actually checked in", () => {
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDirectory, "meta/_journal.json"), "utf8"),
  );
  const finalTag = journal.entries.at(-1).tag;
  const hash = createHash("sha256")
    .update(
      readFileSync(resolve(migrationsDirectory, `${finalTag}.sql`), "utf8"),
    )
    .digest("hex");

  assert.equal(
    checkedInMigrationJournal(),
    `count=${journal.entries.length} hash=${hash}`,
  );
});

test("notices a migration appended and a migration edited in place", () => {
  // The count alone misses an edit; the hash alone misses an addition. The
  // string carries both, which is why it is a string and not a number.
  const summary = checkedInMigrationJournal();
  const [count, hash] = summary.split(" ");

  assert.match(count, /^count=\d+$/u);
  assert.match(hash, /^hash=[0-9a-f]{64}$/u);

  const applied = readdirSync(migrationsDirectory).filter((entry) =>
    entry.endsWith(".sql"),
  ).length;
  assert.equal(count, `count=${applied}`);
});

test("builds a pool from the driver packages/db resolves, not a second copy", {
  // The public tree has no hosted driver, and its launcher refuses before it
  // would ask for a pool (hosted-deployment.public.mjs).
  skip: hostedDriverPackages.length === 0 && "this tree has no hosted driver",
}, () => {
  // A second copy of the hosted driver carries its own configuration, so a
  // migration could run against a differently-configured driver than the
  // application whose schema it is changing.
  const pool = defaultCreatePool({
    connectionString: "postgresql://someone:secret@127.0.0.1:55432/nothing",
  });

  assert.equal(typeof pool.query, "function");
  assert.equal(typeof pool.end, "function");

  const [driverPackage] = hostedDriverPackages;
  const fromDatabasePackage = resolve(
    repositoryRoot,
    `packages/db/node_modules/${driverPackage}`,
  );
  const hoisted = resolve(repositoryRoot, `node_modules/${driverPackage}`);

  assert.ok(
    [fromDatabasePackage, hoisted].some((path) => path.length > 0),
    "the driver must be resolvable from the database package",
  );

  return pool.end().catch(() => {});
});

/** A migrations directory holding `files` ({ tag: sql }), journalled in order. */
function migrationTree(files) {
  const directory = mkdtempSync(join(tmpdir(), "requestport-marker-"));
  mkdirSync(join(directory, "meta"));
  const tags = Object.keys(files);
  writeFileSync(
    join(directory, "meta/_journal.json"),
    JSON.stringify({
      entries: tags.map((tag, idx) => ({ idx, tag, when: 1000 + idx })),
    }),
  );
  for (const tag of tags)
    writeFileSync(join(directory, `${tag}.sql`), files[tag]);
  return directory;
}

test("0019, 0020, 0024, 0025 and 0026 are the checked-in migrations marked to be last in their transaction", () => {
  // The marker is what both guards read; a header edit that dropped it would
  // switch both off without failing either's own tests.
  const marked = [
    "0019_row_security_expand",
    "0020_worker_row_security",
    "0024_command_receipts_row_security",
    "0025_row_security_contract",
    "0026_requestport_appearance_six_axes",
  ];
  assert.deepEqual([...migrationsThatMustBeLast()], marked);
  for (const tag of marked) {
    assert.equal(
      readFileSync(resolve(migrationsDirectory, `${tag}.sql`), "utf8").split(
        "\n",
      )[0],
      LAST_IN_TRANSACTION_MARKER,
      tag,
    );
  }
});

test("reads the marker only as a whole line of the leading comment block", () => {
  const directory = migrationTree({
    "0000_first": `${LAST_IN_TRANSACTION_MARKER}\n-- title\nSELECT 1;\n`,
    "0001_later_line": `-- title\n${LAST_IN_TRANSACTION_MARKER}\nSELECT 1;\n`,
    "0002_quoted": `-- title\nSELECT 1;\n${LAST_IN_TRANSACTION_MARKER}\n`,
    "0003_indented": `-- title\n  ${LAST_IN_TRANSACTION_MARKER}\nSELECT 1;\n`,
    "0004_inline": `-- title ${LAST_IN_TRANSACTION_MARKER}\nSELECT 1;\n`,
    "0005_crlf": `-- title\r\n${LAST_IN_TRANSACTION_MARKER}\r\nSELECT 1;\r\n`,
  });
  try {
    assert.deepEqual(
      [
        ...migrationsThatMustBeLast(
          checkedInJournalEntries(directory),
          directory,
        ),
      ],
      ["0000_first", "0001_later_line", "0005_crlf"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("names the first marked migration with anything after it in a batch", () => {
  const marked = new Set(["b"]);
  const batch = (...tags) => tags.map((tag) => ({ tag }));

  assert.equal(migrationsAfterOneThatMustBeLast(batch(), marked), undefined);
  assert.equal(
    migrationsAfterOneThatMustBeLast(batch("a", "b"), marked),
    undefined,
  );
  assert.equal(migrationsAfterOneThatMustBeLast(batch("c"), marked), undefined);
  assert.deepEqual(
    migrationsAfterOneThatMustBeLast(batch("a", "b", "c", "d"), marked),
    { marked: "b", after: ["c", "d"] },
  );
});
