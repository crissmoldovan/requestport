import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import * as hostedDeployment from "./hosted-deployment.mjs";
import * as publicVariant from "./hosted-deployment.public.mjs";
import { MIGRATION_STATE_MALFORMED } from "./migration-state.mjs";
import {
  checkedInJournalEntries,
  checkedInMigrationJournal,
  migrationsThatMustBeLast,
} from "./migration-support.mjs";
import { SHARED_DATABASE_LIST_MALFORMED } from "./production-database-guard.mjs";
import {
  DEFAULT_DEPLOYMENT,
  defaultRunIntegrityCheck,
  invokedDirectly,
  pendingMigrations,
  REFUSALS,
  runProductionMigrations,
  TOLERATED_INTEGRITY_VIOLATIONS,
} from "./run-production-migrations.mjs";

const SUCCESS = "RequestPort production migrations completed.\n";
const FAILURE = "RequestPort production migration failed.\n";
const password = "production-database-password-must-not-leak";
// A stand-in for the production host, because the real one is recorded only as
// a digest and this suite must not be the place it gets written down. The
// deployment below is injected to match, and the test below proves the default
// it stands in for is the hosted deployment's.
const host = "ep-production-stand-in.example.test";
const hostSha256 = createHash("sha256").update(host).digest("hex");
const STATE_FILE = "docs/implementation/production-migration-state.json";
/**
 * The one synthetic private deployment every case is handed unless it names
 * another: the stand-in host as production, and the state file the private
 * tree records into, so the `recorded=` lines below read the same in a tree
 * whose own deployment is the public variant.
 */
const STAND_IN_DEPLOYMENT = Object.freeze({
  kind: "private",
  sharedDatabases: Object.freeze([
    Object.freeze({
      name: "production",
      hostSha256,
      databaseNameSha256: null,
      optIn: "REQUESTPORT_PRODUCTION_DATABASE",
    }),
  ]),
  migrationState: STATE_FILE,
});
/**
 * The same stand-in database, pooled.
 *
 * The stand-in above has no `-pooler` suffix, so a digest of it reads the same
 * whether or not the host was normalised first — which is precisely why this
 * suite stayed green while the guard beside it started normalising and this
 * launcher did not. One is a refusal of everything but production and the
 * other a refusal of production; disagreeing about which names are production
 * means the pipeline refuses the database it was told to migrate.
 */
const pooledHost = "ep-production-stand-in-pooler.example.test";
const pooledUrl = `postgresql://requestport:${password}@${pooledHost}/requestport?sslmode=require`;
const productionUrl = `postgresql://requestport:${password}@${host}/requestport?sslmode=require`;
const otherUrl =
  "postgresql://requestport:preview-password-must-not-leak@ep-preview.example.test/requestport?sslmode=require";

/**
 * A Preview's database project variable, where this tree's hosted deployment
 * names one (`hosted-deployment.mjs`); `null` in the public tree, which names
 * none.
 */
const PREVIEW_PROJECT =
  hostedDeployment.databaseProjectVariables?.preview ?? null;
const previewProject =
  PREVIEW_PROJECT === null ? {} : { [PREVIEW_PROJECT]: "preview-project" };

function baseEnvironment(overrides = {}) {
  return {
    DATABASE_URL: productionUrl,
    REQUESTPORT_PRODUCTION_DATABASE: "approved",
    ...overrides,
  };
}

/**
 * Pools that answer two kinds of question, recorded apart.
 *
 * The journal snapshot the launcher reads after each apply comes from
 * `snapshots`, in order, and is recorded in `calls`. The row Drizzle's
 * migrator compares the journal with, which the launcher reads once before
 * applying anything, comes from `database` and is recorded in `probes`:
 * `{ latest: undefined }` is a database with no migrations table, `{ latest:
 * row }` one whose newest row is `row`, and an Error a read that fails.
 */
function poolFactory(snapshots, calls, database, probes) {
  return (options) => {
    let call;
    const open = (list) => {
      if (call === undefined) {
        call = { connectionString: options.connectionString, queries: [] };
        call.index = calls.length;
        list.push(call);
      }
      return call;
    };
    return {
      on() {},
      async query(text) {
        if (
          /__drizzle_migrations"'\)|^select id, hash, created_at/u.test(text)
        ) {
          open(probes).queries.push(text);
          if (database instanceof Error) throw database;
          if (text.includes("to_regclass")) {
            return { rows: [{ present: database.latest !== undefined }] };
          }
          return { rows: [database.latest] };
        }
        const { index, queries } = open(calls);
        queries.push(text);
        const snapshot = snapshots[index];
        if (snapshot instanceof Error) throw snapshot;
        return { rows: [snapshot] };
      },
      async end() {
        if (call !== undefined) call.ended = true;
      },
    };
  };
}

function journalRow(count, hash) {
  return { migrationCount: String(count), latestHash: hash };
}

function expectedJournal() {
  const expected = checkedInMigrationJournal();
  const [, count, hash] = /^count=(\d+) hash=([a-f0-9]{64})$/u.exec(expected);
  return { expected, count, hash };
}

/**
 * The sixteen checks the CLI runs without `--expected-kek-version`, named here
 * so a report that is short one is a report this suite can build.
 */
const integrityCheckNames = [
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
];

/**
 * An integrity report in the shape the CLI prints: one JSON object and a
 * newline. `violations` names the checks that are not clean, and everything
 * unnamed reports zero.
 */
function integrityReport({
  environment = "production",
  names = integrityCheckNames,
  violations = {},
} = {}) {
  return `${JSON.stringify({
    environment,
    ok: Object.keys(violations).length === 0,
    checks: names.map((name) =>
      name in violations
        ? { name, ok: false, violations: violations[name] }
        : { name, ok: true, violations: 0 },
    ),
  })}\n`;
}

const HEAD_SHA = "c0ffee1c0ffee2c0ffee3c0ffee4c0ffee5c0ffe";

/**
 * A database row of the shape Drizzle's migrator reads, applied through
 * `when`. bigint arrives as a string from both drivers, which is what
 * Drizzle's `Number(lastDbMigration.created_at)` is there for.
 */
function appliedThrough(when) {
  return {
    latest: { id: 1, hash: "d".repeat(64), created_at: String(when) },
  };
}

const ALL_BUT_THE_LAST_APPLIED = appliedThrough(
  checkedInJournalEntries().at(-2).when,
);

async function execute({
  env,
  snapshots = [],
  migrate,
  deployment = STAND_IN_DEPLOYMENT,
  integrity = integrityReport(),
  // The launcher refuses unless the operator named the commit they are
  // migrating and is standing on it. Every case that is not about that gate
  // satisfies it, the way every case satisfies the opt-in.
  head = HEAD_SHA,
  recordState = () => {},
  // Everything but the journal's last entry applied, so exactly one
  // migration is pending and the ordering check passes whatever the journal
  // ends with. The ordering cases below set their own database and tree.
  database = ALL_BUT_THE_LAST_APPLIED,
  readMigrationTree,
}) {
  const output = [];
  const errors = [];
  const calls = [];
  const probes = [];
  const runs = [];
  const integrityRuns = [];
  const code = await runProductionMigrations({
    env: { EXPECTED_MIGRATION_GIT_SHA: HEAD_SHA, ...env },
    deployment,
    readHead: () => head,
    recordState,
    ...(readMigrationTree ? { readMigrationTree } : {}),
    createPool: poolFactory(snapshots, calls, database, probes),
    runMigrate: (environment) => {
      runs.push(environment);
      return migrate ? migrate(runs.length) : true;
    },
    runIntegrityCheck: (environment) => {
      integrityRuns.push(environment);
      // A function so a case can express a check that returned nothing or could
      // not start at all — `undefined` as a value would take this harness's own
      // default and quietly test a clean report instead.
      return typeof integrity === "function" ? integrity() : integrity;
    },
    writeOutput: (line) => output.push(`${line}\n`),
    writeError: (line) => errors.push(`${line}\n`),
  });

  return {
    code,
    calls,
    probes,
    runs,
    integrityRuns,
    stdout: output.join(""),
    stderr: errors.join(""),
  };
}

test("defaults to the deployment scripts/hosted-deployment.mjs records, the one the guard reads", async () => {
  // The launcher and the guard must name the same database. The default the
  // launcher takes is the very module the guard reads (DEFAULT_DEPLOYMENT is
  // scripts/hosted-deployment.mjs), and a run handed no deployment says, word
  // for word, what a run handed that module says: in the private tree the
  // target refusal, because the stand-in is not the production host the module
  // records, and where the module is the public variant, the public refusal.
  // Neither run gets as far as a database.
  assert.equal(DEFAULT_DEPLOYMENT, hostedDeployment);
  const run = async (handed) => {
    const errors = [];
    let pools = 0;
    const code = await runProductionMigrations({
      env: baseEnvironment({ EXPECTED_MIGRATION_GIT_SHA: HEAD_SHA }),
      readHead: () => HEAD_SHA,
      createPool: () => {
        pools += 1;
        throw new Error("no database here");
      },
      runMigrate: () => false,
      runIntegrityCheck: () => "",
      recordState: () => {},
      writeError: (line) => errors.push(`${line}\n`),
      writeOutput: () => {},
      ...handed,
    });
    return { code, stderr: errors.join(""), pools };
  };
  const implicit = await run({});

  assert.deepEqual(implicit, await run({ deployment: hostedDeployment }));
  assert.deepEqual(implicit, {
    code: 1,
    stderr: `${FAILURE}${hostedDeployment.kind === "public" ? REFUSALS.publicTree : REFUSALS.target}\n`,
    pools: 0,
  });
});

/**
 * Runs the launcher handed `deployment`, with an environment that records
 * every look taken at it and collaborators that record every call: what it
 * printed, what it touched, and what it called.
 */
async function refusedUpFront(deployment) {
  const touched = [];
  const watch =
    (trap) =>
    (...args) => {
      touched.push(`${trap} ${String(args[1] ?? "")}`);
      return Reflect[trap](...args);
    };
  const env = new Proxy(
    baseEnvironment({ EXPECTED_MIGRATION_GIT_SHA: HEAD_SHA }),
    {
      get: watch("get"),
      has: watch("has"),
      ownKeys: watch("ownKeys"),
      getOwnPropertyDescriptor: watch("getOwnPropertyDescriptor"),
    },
  );
  const called = [];
  const errors = [];
  const output = [];
  const code = await runProductionMigrations({
    env,
    deployment,
    readHead: () => {
      called.push("readHead");
      return HEAD_SHA;
    },
    createPool: () => {
      called.push("createPool");
      throw new Error("no database here");
    },
    runMigrate: () => {
      called.push("runMigrate");
      return false;
    },
    runIntegrityCheck: () => {
      called.push("runIntegrityCheck");
      return "";
    },
    recordState: () => {
      called.push("recordState");
    },
    readMigrationTree: () => {
      called.push("readMigrationTree");
      return { entries: [], mustBeLast: new Set() };
    },
    writeError: (line) => errors.push(`${line}\n`),
    writeOutput: (line) => output.push(`${line}\n`),
  });

  return {
    code,
    stderr: errors.join(""),
    stdout: output.join(""),
    touched,
    called,
  };
}

test("refuses the public variant before it reads a variable, and never connects", async () => {
  assert.equal(publicVariant.kind, "public");
  assert.deepEqual(await refusedUpFront(publicVariant), {
    code: 1,
    stderr: `${FAILURE}${REFUSALS.publicTree}\n`,
    stdout: "",
    touched: [],
    called: [],
  });
});

test("refuses a malformed deployment before it reads a variable, naming the part that is malformed", async () => {
  for (const [deployment, refusal] of [
    [null, SHARED_DATABASE_LIST_MALFORMED],
    [
      { ...STAND_IN_DEPLOYMENT, kind: "public" },
      SHARED_DATABASE_LIST_MALFORMED,
    ],
    [
      { ...STAND_IN_DEPLOYMENT, kind: "staging" },
      SHARED_DATABASE_LIST_MALFORMED,
    ],
    [
      { ...STAND_IN_DEPLOYMENT, sharedDatabases: undefined },
      SHARED_DATABASE_LIST_MALFORMED,
    ],
    [
      { ...STAND_IN_DEPLOYMENT, migrationState: null },
      MIGRATION_STATE_MALFORMED,
    ],
    [
      { ...STAND_IN_DEPLOYMENT, migrationState: `/${STATE_FILE}` },
      MIGRATION_STATE_MALFORMED,
    ],
    [
      { ...publicVariant, migrationState: STATE_FILE },
      MIGRATION_STATE_MALFORMED,
    ],
  ]) {
    assert.deepEqual(
      await refusedUpFront(deployment),
      {
        code: 1,
        stderr: `${FAILURE}${refusal}\n`,
        stdout: "",
        touched: [],
        called: [],
      },
      JSON.stringify(deployment),
    );
  }
});

test("refuses a private deployment that names no production database, and never connects", async () => {
  // The stand-in host, recorded under another name: a launcher that took
  // whichever entry came first would accept it.
  const stagingOnly = {
    ...STAND_IN_DEPLOYMENT,
    sharedDatabases: [
      {
        ...STAND_IN_DEPLOYMENT.sharedDatabases[0],
        name: "staging",
        optIn: "REQUESTPORT_STAGING_DATABASE",
      },
    ],
  };
  const { code, runs, probes, stdout, stderr } = await execute({
    env: baseEnvironment(),
    deployment: stagingOnly,
  });

  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, `${FAILURE}${REFUSALS.target}\n`);
  assert.equal(runs.length, 0);
  assert.equal(probes.length, 0);
});

test("hands recordState the deployment's state file, and names the same file on its recorded= line and when recording fails", async () => {
  const path = "docs/example/migration-state.json";
  const elsewhere = { ...STAND_IN_DEPLOYMENT, migrationState: path };
  const { count, hash } = expectedJournal();
  const handed = [];
  const recorded = await execute({
    env: baseEnvironment(),
    deployment: elsewhere,
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
    recordState: (_state, statePath) => handed.push(statePath),
  });

  assert.equal(recorded.code, 0);
  assert.deepEqual(handed, [path]);
  assert.match(
    recorded.stdout,
    /^recorded=docs\/example\/migration-state\.json$/mu,
  );
  assert.doesNotMatch(recorded.stdout, /production-migration-state/u);

  const failed = await execute({
    env: baseEnvironment(),
    deployment: elsewhere,
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
    recordState: () => {
      throw new Error("read-only filesystem");
    },
  });

  assert.equal(failed.code, 1);
  assert.match(
    failed.stderr,
    /could not record the state in docs\/example\/migration-state\.json: read-only filesystem/u,
  );
});

test("accepts production by either of the names it answers to", async () => {
  const { count, hash } = expectedJournal();
  const { code, stderr } = await execute({
    env: baseEnvironment({ DATABASE_URL: pooledUrl }),
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
  });

  assert.equal(stderr, "");
  assert.equal(code, 0);
});

test("migrates production twice and proves the checked-in journal both times", async () => {
  const { expected, count, hash } = expectedJournal();
  const { code, calls, runs, stdout, stderr } = await execute({
    env: baseEnvironment(),
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
  });

  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.equal(
    stdout,
    `${SUCCESS}${expected}\nintegrity=ok checks=16\nrecorded=docs/implementation/production-migration-state.json\n`,
  );
  assert.equal(runs.length, 2);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.connectionString, productionUrl);
    assert.equal(call.ended, true);
  }
});

test("refuses a database that is not the recorded production one", async () => {
  // The inversion that matters. Everywhere else in this repository refuses
  // production; a job whose whole purpose is production must refuse everything
  // else, or a mispointed run reports success having migrated a database
  // nobody asked about — and reports it in the words of a production result.
  const { code, runs, stdout, stderr } = await execute({
    env: baseEnvironment({ DATABASE_URL: otherUrl }),
  });

  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, `${FAILURE}${REFUSALS.target}\n`);
  assert.equal(runs.length, 0);
});

test("refuses production without the exact opt-in word", async () => {
  for (const value of [
    undefined,
    "",
    "true",
    "yes",
    "1",
    "Approved",
    " approved",
  ]) {
    const { code, runs } = await execute({
      env: baseEnvironment({ REQUESTPORT_PRODUCTION_DATABASE: value }),
    });

    assert.equal(code, 1, `opt-in ${JSON.stringify(value)} must not pass`);
    assert.equal(runs.length, 0);
  }
});

test("refuses a connection string that is not a Postgres URL", async () => {
  for (const value of [
    undefined,
    "",
    "not-a-url",
    "https://example.invalid/db",
    `postgresql://requestport:${password}@${host}`,
  ]) {
    const { code, runs } = await execute({
      env: baseEnvironment({ DATABASE_URL: value }),
    });

    assert.equal(code, 1, `url ${JSON.stringify(value)} must not pass`);
    assert.equal(runs.length, 0);
  }
});

test("refuses when the second apply changes the journal", async () => {
  const { count, hash } = expectedJournal();
  const { code, runs, stderr } = await execute({
    env: baseEnvironment(),
    snapshots: [journalRow(count, hash), journalRow(Number(count) + 1, hash)],
  });

  // Two zero exits are not evidence. A second apply that appended anything is
  // a history that did not converge, and this is what notices.
  assert.equal(code, 1);
  assert.equal(stderr, `${FAILURE}${REFUSALS.converge}\n`);
  assert.equal(runs.length, 2);
});

test("refuses when what applied is not the checked-in history", async () => {
  const { count } = expectedJournal();
  const wrongHash = "b".repeat(64);
  const { code, runs, stderr } = await execute({
    env: baseEnvironment(),
    snapshots: [journalRow(count, wrongHash), journalRow(count, wrongHash)],
  });

  assert.equal(code, 1);
  assert.equal(stderr, `${FAILURE}${REFUSALS.applied}\n`);
  assert.equal(runs.length, 1);
});

test("refuses when the journal cannot be read at all", async () => {
  const { code, stderr } = await execute({
    env: baseEnvironment(),
    snapshots: [new Error("connection reset")],
  });

  assert.equal(code, 1);
  assert.equal(stderr, `${FAILURE}${REFUSALS.applied}\n`);
});

test("refuses when the migration command itself fails", async () => {
  const { count, hash } = expectedJournal();
  const { code, runs, stderr } = await execute({
    env: baseEnvironment(),
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
    migrate: (attempt) => attempt !== 1,
  });

  assert.equal(code, 1);
  assert.equal(stderr, `${FAILURE}${REFUSALS.command}\n`);
  assert.equal(runs.length, 1);
});

test("names exactly one database to the migration child", async () => {
  const { count, hash } = expectedJournal();
  const { runs } = await execute({
    env: baseEnvironment({
      REQUESTPORT_APPLICATION_DATABASE_URL: otherUrl,
      REQUESTPORT_PREVIEW_DATABASE_URL: otherUrl,
      ...previewProject,
      VERCEL_ENV: "preview",
    }),
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
  });

  // Drizzle resolves its target from the environment it is handed, so a
  // preview variable left in scope is a second answer to a question that must
  // have exactly one. The application variable is stripped too: the
  // integrity check the launcher spawns reads through the operator root's
  // storage, built from the environment, which prefers it, and as the
  // application role it would read an empty view and report it clean
  // (manifest-i2.md §1).
  for (const child of runs) {
    assert.equal(child.DATABASE_URL, productionUrl);
    assert.equal(child.REQUESTPORT_APPLICATION_DATABASE_URL, undefined);
    assert.equal(child.REQUESTPORT_PREVIEW_DATABASE_URL, undefined);
    if (PREVIEW_PROJECT !== null) {
      assert.equal(child[PREVIEW_PROJECT], undefined);
    }
    assert.equal(child.VERCEL_ENV, undefined);
  }
});

test("prints no part of any connection string", async () => {
  const { count, hash } = expectedJournal();
  const passing = await execute({
    env: baseEnvironment(),
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
  });
  const refused = await execute({
    env: baseEnvironment({ DATABASE_URL: otherUrl }),
  });

  for (const stream of [
    passing.stdout,
    passing.stderr,
    refused.stdout,
    refused.stderr,
  ]) {
    assert.doesNotMatch(stream, /must-not-leak/u);
    for (const part of [host, new URL(otherUrl).hostname]) {
      assert.ok(!stream.includes(part), part);
    }
    assert.doesNotMatch(stream, /requestport:/u);
  }
});

/**
 * The quietest way this file can fail.
 *
 * `process.argv[1]` is a path; `new URL(import.meta.url).pathname` is that path
 * percent-encoded. They agree only while the checkout path contains nothing
 * worth encoding. Where they disagree — a self-hosted runner rooted at
 * `/opt/GitHub Runner/_work`, or any local clone under a directory with a
 * space — `node scripts/run-production-migrations.mjs` imports this module,
 * runs nothing, prints nothing, and exits 0. The step goes green, the workflow
 * goes green, and production is left un-migrated: the failure this file's own
 * header warns about, minus the warning.
 *
 * Every sibling launcher uses `fileURLToPath`. This one, the only one that
 * touches production, did not.
 */
test("recognises its own invocation through a path that needs encoding", () => {
  for (const directory of [
    "/home/runner/work/requestport/requestport",
    "/opt/GitHub Runner/_work/requestport",
    "/srv/c++/requestport",
    "/srv/100%/requestport",
    "/srv/r\u00e9pertoire/requestport",
  ]) {
    const path = `${directory}/scripts/run-production-migrations.mjs`;
    assert.equal(
      invokedDirectly(path, pathToFileURL(path).href),
      true,
      `should run when invoked as ${path}`,
    );
  }
});

test("does not mistake a different script for itself", () => {
  const mine = "/srv/requestport/scripts/run-production-migrations.mjs";
  assert.equal(
    invokedDirectly(
      "/srv/requestport/scripts/run-preview-migrations.mjs",
      pathToFileURL(mine).href,
    ),
    false,
  );
  assert.equal(invokedDirectly(undefined, pathToFileURL(mine).href), false);
});

/**
 * The gate production did not have.
 *
 * Staging migrates and then proves integrity; production migrated and proved
 * only its journal, so a production apply could report success over a database
 * in any state at all. These cover the verdict, the pinned residue production
 * actually holds, and every way the report can fail to be evidence.
 */
test("proves integrity after migrating, and says how many checks it read", async () => {
  const { expected, count, hash } = expectedJournal();
  const { code, stdout, stderr, integrityRuns } = await execute({
    env: baseEnvironment(),
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
  });

  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.equal(
    stdout,
    `${SUCCESS}${expected}\nintegrity=ok checks=16\nrecorded=docs/implementation/production-migration-state.json\n`,
  );
  assert.equal(integrityRuns.length, 1);
  assert.doesNotMatch(stdout, /^tolerated=/mu);
});

test("names the tolerance it spent, and the count it stood at", async () => {
  // `integrity=ok checks=16` reads the same whether the database is clean or
  // leaning on the pinned residue. The run has to say which.
  const { expected, count, hash } = expectedJournal();
  const { code, stdout } = await execute({
    env: baseEnvironment(),
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
    integrity: integrityReport({
      violations: { aggregate_version_sequence: 36 },
    }),
  });

  assert.equal(code, 0);
  assert.equal(
    stdout,
    `${SUCCESS}${expected}\nintegrity=ok checks=16\nrecorded=docs/implementation/production-migration-state.json\ntolerated=aggregate_version_sequence:36\n`,
  );
});

test("refuses one more than the recorded residue", async () => {
  const { count, hash } = expectedJournal();
  const { code, stdout, stderr } = await execute({
    env: baseEnvironment(),
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
    integrity: integrityReport({
      violations: { aggregate_version_sequence: 37 },
    }),
  });

  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, `${FAILURE}${REFUSALS.integrity}\n`);
});

test("refuses one fewer than the recorded residue", async () => {
  // Below the pin is not a smaller problem. `domain_events` is append-only, so
  // thirty-five means these are not the rows the number was recorded for.
  const { count, hash } = expectedJournal();
  const { code, stderr } = await execute({
    env: baseEnvironment(),
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
    integrity: integrityReport({
      violations: { aggregate_version_sequence: 35 },
    }),
  });

  assert.equal(code, 1);
  assert.equal(stderr, `${FAILURE}${REFUSALS.integrity}\n`);
});

test("refuses a count on a check that records none", async () => {
  const { count, hash } = expectedJournal();
  const { code, stderr } = await execute({
    env: baseEnvironment(),
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
    integrity: integrityReport({
      violations: { event_outbox_correspondence: 1 },
    }),
  });

  assert.equal(code, 1);
  assert.equal(stderr, `${FAILURE}${REFUSALS.integrity}\n`);
});

test("refuses evidence that is missing, malformed, short, or another environment's", async () => {
  const { count, hash } = expectedJournal();
  const clean = JSON.parse(integrityReport().slice(0, -1));
  const cases = [
    ["a report the command never produced", () => undefined],
    [
      "a check that could not start",
      () => {
        throw new Error("spawn pnpm ENOENT");
      },
    ],
    ["empty", ""],
    ["a bare newline", "\n"],
    ["not JSON", "integrity ok\n"],
    ["an unterminated report", integrityReport().slice(0, -1)],
    ["an array", "[]\n"],
    ["null", "null\n"],
    [
      "no checks at all",
      `${JSON.stringify({ environment: "production", ok: true, checks: [] })}\n`,
    ],
    ["staging's environment", integrityReport({ environment: "staging" })],
    [
      "no environment",
      `${JSON.stringify({ ok: true, checks: clean.checks })}\n`,
    ],
    [
      "fifteen checks",
      integrityReport({ names: integrityCheckNames.slice(1) }),
    ],
    [
      "sixteen entries naming fifteen checks",
      `${JSON.stringify({
        ...clean,
        checks: [clean.checks[0], ...clean.checks.slice(0, 15)],
      })}\n`,
    ],
    [
      "a check this repository does not run",
      `${JSON.stringify({
        ...clean,
        checks: [
          { name: "workspace_kek_version", ok: true, violations: 0 },
          ...clean.checks.slice(1),
        ],
      })}\n`,
    ],
    [
      "a clean flag over a count",
      `${JSON.stringify({
        ...clean,
        checks: [
          { name: clean.checks[0].name, ok: true, violations: 3 },
          ...clean.checks.slice(1),
        ],
      })}\n`,
    ],
    [
      // Not a boolean, and falsy — so a reader that only asked whether `ok` was
      // truthy would take this for a tolerated count and pass the run.
      "a null verdict over the tolerated count",
      `${JSON.stringify({
        ...clean,
        ok: false,
        checks: clean.checks.map((check) =>
          check.name === "aggregate_version_sequence"
            ? { name: check.name, ok: null, violations: 36 }
            : check,
        ),
      })}\n`,
    ],
    [
      "a string verdict over a clean count",
      `${JSON.stringify({
        ...clean,
        checks: clean.checks.map((check) =>
          check.name === "aggregate_version_sequence"
            ? { name: check.name, ok: "true", violations: 0 }
            : check,
        ),
      })}\n`,
    ],
    [
      "trailing text after the report",
      `${integrityReport().trimEnd()} migrated\n`,
    ],
  ];

  for (const [description, evidence] of cases) {
    const { code, stdout, stderr } = await execute({
      env: baseEnvironment(),
      snapshots: [journalRow(count, hash), journalRow(count, hash)],
      integrity: evidence,
    });

    assert.equal(code, 1, `${description} must not pass`);
    assert.equal(stdout, "", `${description} must print no success`);
    assert.equal(stderr, `${FAILURE}${REFUSALS.integrity}\n`);
  }
});

test("hands the integrity check one database, named as production", async () => {
  const { count, hash } = expectedJournal();
  const { integrityRuns } = await execute({
    env: baseEnvironment({
      REQUESTPORT_PREVIEW_DATABASE_URL: otherUrl,
      ...previewProject,
      VERCEL_ENV: "preview",
    }),
    snapshots: [journalRow(count, hash), journalRow(count, hash)],
  });

  // The CLI refuses a report whose environment does not match the one it was
  // asked for, and it reads that from VERCEL_ENV. A preview value left in
  // scope would also send @requestport/db to the preview connection string.
  assert.equal(integrityRuns.length, 1);
  for (const child of integrityRuns) {
    assert.equal(child.VERCEL_ENV, "production");
    assert.equal(child.DATABASE_URL, productionUrl);
    assert.equal(child.REQUESTPORT_PREVIEW_DATABASE_URL, undefined);
    if (PREVIEW_PROJECT !== null) {
      assert.equal(child[PREVIEW_PROJECT], undefined);
    }
  }
});

test("does not run the integrity check when the migration never proved out", async () => {
  const { count, hash } = expectedJournal();
  const refused = await execute({
    env: baseEnvironment({ DATABASE_URL: otherUrl }),
  });
  const diverged = await execute({
    env: baseEnvironment(),
    snapshots: [journalRow(count, hash), journalRow(Number(count) + 1, hash)],
  });

  assert.equal(refused.integrityRuns.length, 0);
  assert.equal(diverged.integrityRuns.length, 0);
});

test("reads the report rather than the integrity command's exit code", async () => {
  // The command exits 1 whenever the report is not clean, and production holds
  // rows it cannot delete, so an exit-code gate here would refuse every run.
  // The report carries everything the exit code does.
  const report = integrityReport({
    violations: { aggregate_version_sequence: 36 },
  });
  const spawns = [];

  assert.equal(
    defaultRunIntegrityCheck(
      { VERCEL_ENV: "production" },
      (command, args, options) => {
        spawns.push({ command, args, options });
        return { status: 1, stdout: report };
      },
    ),
    report,
  );
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args.slice(-4), [
    "@requestport/cli",
    "integrity-check",
    "--environment",
    "production",
  ]);
  assert.equal(spawns[0].options.env.VERCEL_ENV, "production");
});

test("treats an integrity command that printed nothing as no evidence", async () => {
  const spawns = [];
  const empty = defaultRunIntegrityCheck({}, (_command, args) => {
    spawns.push(args);
    return {
      error: new Error("spawn pnpm ENOENT"),
      status: null,
      stdout: null,
    };
  });

  assert.equal(spawns.length, 1);
  assert.equal(empty, "");
});

/**
 * What this gate is allowed to overlook, written down.
 *
 * Production holds thirty-six orphaned appearance events under the sequence
 * check — the same stranded version-2 rows staging holds twelve of, in an
 * append-only table that cannot be cleaned. Pinning the map makes adding a
 * tolerance a deliberate act with a reason attached, and removing one when its
 * rows go the same.
 */
test("overlooks exactly what is recorded for production, and nothing else", () => {
  assert.deepEqual([...TOLERATED_INTEGRITY_VIOLATIONS.entries()].toSorted(), [
    ["aggregate_version_sequence", 36],
  ]);
});

describe("the commit this run is allowed to migrate", () => {
  test("refuses when nobody named a sha", async () => {
    // `production-migrations.yml` re-fetched main and compared it to
    // EXPECTED_MIGRATION_GIT_SHA in shell, so an approval that had sat for
    // hours could not migrate a commit nobody looked at. The workflow is gone
    // and this launcher never read that variable — the runbook documented a
    // protection that did not exist. It exists here now.
    const { stderr, code } = await execute({
      env: baseEnvironment({ EXPECTED_MIGRATION_GIT_SHA: undefined }),
    });

    assert.equal(code, 1);
    assert.match(stderr, /EXPECTED_MIGRATION_GIT_SHA/u);
  });

  test("refuses when the named sha is not the one checked out", async () => {
    const { code, stderr } = await execute({
      env: baseEnvironment({ EXPECTED_MIGRATION_GIT_SHA: "a".repeat(40) }),
      head: "b".repeat(40),
    });

    assert.equal(code, 1);
    assert.match(stderr, /does not match/u);
  });

  test("accepts an abbreviated sha that prefixes HEAD", async () => {
    const head = "c0ffee1c0ffee2c0ffee3c0ffee4c0ffee5c0ffe";
    const { count, hash } = expectedJournal();
    const { code } = await execute({
      env: baseEnvironment({ EXPECTED_MIGRATION_GIT_SHA: head.slice(0, 12) }),
      snapshots: [journalRow(count, hash), journalRow(count, hash)],
      head,
    });

    assert.equal(code, 0);
  });

  test("refuses anything that is not a sha at all", async () => {
    for (const value of ["", "   ", "HEAD", "main", "zzzz"]) {
      const { code } = await execute({
        env: baseEnvironment({ EXPECTED_MIGRATION_GIT_SHA: value }),
      });
      assert.equal(code, 1, `${JSON.stringify(value)} must be refused`);
    }
  });

  test("records what it applied, so the credential-free alarm can see it", async () => {
    const recorded = [];
    const { count, hash } = expectedJournal();
    const { code } = await execute({
      env: baseEnvironment(),
      snapshots: [journalRow(count, hash), journalRow(count, hash)],
      recordState: (state) => recorded.push(state),
    });

    assert.equal(code, 0);
    assert.equal(recorded.length, 1);
    assert.match(recorded[0].journal, /^count=\d+ hash=[0-9a-f]{64}$/u);
    assert.equal(recorded[0].source, "applied");
    assert.ok(recorded[0].appliedAt);
  });

  test("a run that cannot record its result is a failed run, not a quiet one", async () => {
    const { count, hash } = expectedJournal();
    const { code, stderr } = await execute({
      env: baseEnvironment(),
      snapshots: [journalRow(count, hash), journalRow(count, hash)],
      recordState: () => {
        throw new Error("read-only filesystem");
      },
    });

    assert.equal(code, 1);
    assert.match(stderr, /could not record the state/u);
  });
});

/**
 * The ordering refusal (track-i2.md §14).
 *
 * Drizzle applies every pending migration in one transaction, so a migration
 * marked to be the last one in its transaction must not be pending with
 * another after it. What is pending is read from the database the way
 * Drizzle's migrator reads it: the newest row's `created_at` against each
 * journal entry's `when`.
 */
describe("a migration that must be the last one applied in its transaction", () => {
  // A synthetic journal, so these cases do not depend on what the checked-in
  // journal ends with: the real tree moves on once the marked migration is
  // applied and the next one lands.
  const entries = [
    { tag: "0000_before", when: 10 },
    { tag: "0001_marked", when: 20 },
    { tag: "0002_after", when: 30 },
  ];
  const mustBeLast = new Set(["0001_marked"]);
  const withLater = () => ({ entries, mustBeLast });
  const endingAtMarked = () => ({ entries: entries.slice(0, 2), mustBeLast });

  test("the checked-in 0019 carries the marker", () => {
    assert.ok(migrationsThatMustBeLast().has("0019_row_security_expand"));
  });

  test("refuses when another migration is pending after the marked one, and never migrates", async () => {
    const { code, runs, probes, calls, stdout, stderr } = await execute({
      env: baseEnvironment(),
      database: appliedThrough(10),
      readMigrationTree: withLater,
    });

    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.equal(
      stderr,
      `${FAILURE}${REFUSALS.lastInTransaction}\n  must be last : 0001_marked\n  pending after: 0002_after\n`,
    );
    assert.equal(runs.length, 0);
    assert.equal(calls.length, 0);
    assert.equal(probes.length, 1);
    assert.equal(probes[0].connectionString, productionUrl);
    assert.equal(probes[0].ended, true);
    assert.doesNotMatch(stderr, /must-not-leak|requestport:/u);
    assert.ok(!stderr.includes(host), host);
  });

  test("refuses when nothing is applied yet and the marked one is not last", async () => {
    const { code, runs, stderr } = await execute({
      env: baseEnvironment(),
      database: { latest: undefined },
      readMigrationTree: withLater,
    });

    assert.equal(code, 1);
    assert.match(stderr, /pending after: 0002_after\n$/u);
    assert.equal(runs.length, 0);
  });

  test("proceeds when the marked migration is the last one pending", async () => {
    const { count, hash } = expectedJournal();
    const { code, runs, probes, stderr } = await execute({
      env: baseEnvironment(),
      database: appliedThrough(10),
      readMigrationTree: endingAtMarked,
      snapshots: [journalRow(count, hash), journalRow(count, hash)],
    });

    assert.equal(stderr, "");
    assert.equal(code, 0);
    assert.equal(runs.length, 2);
    assert.equal(probes.length, 1);
  });

  test("proceeds when the marked migration is applied and later ones are pending", async () => {
    const { count, hash } = expectedJournal();
    const { code, runs, stderr } = await execute({
      env: baseEnvironment(),
      database: appliedThrough(20),
      readMigrationTree: withLater,
      snapshots: [journalRow(count, hash), journalRow(count, hash)],
    });

    assert.equal(stderr, "");
    assert.equal(code, 0);
    assert.equal(runs.length, 2);
  });

  test("refuses when the applied migrations cannot be read", async () => {
    const { code, runs, stderr } = await execute({
      env: baseEnvironment(),
      database: new Error("connection reset"),
    });

    assert.equal(code, 1);
    assert.equal(stderr, `${FAILURE}${REFUSALS.pending}\n`);
    assert.equal(runs.length, 0);
  });

  test("computes pending exactly as Drizzle's migrator compares", () => {
    const entries = [
      { tag: "a", when: 10 },
      { tag: "b", when: 20 },
      { tag: "c", when: 30 },
    ];
    const tags = (latest) =>
      pendingMigrations(entries, latest).map(({ tag }) => tag);

    assert.deepEqual(tags(undefined), ["a", "b", "c"]);
    assert.deepEqual(tags({ created_at: "20" }), ["c"]);
    assert.deepEqual(tags({ created_at: "19" }), ["b", "c"]);
    assert.deepEqual(tags({ created_at: "30" }), []);
    // A NULL created_at sorts first under Drizzle's `order by created_at
    // desc`, and `Number(null)` is 0: everything reads as pending.
    assert.deepEqual(tags({ created_at: null }), ["a", "b", "c"]);
  });
});
