import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "node:test";

import * as hostedDeployment from "./hosted-deployment.mjs";
import * as publicVariant from "./hosted-deployment.public.mjs";
import {
  buildRecordedState,
  lastInTransactionStatus,
  MIGRATION_STATE_MALFORMED,
  migrationStateOutcome,
  migrationStatePathOf,
  migrationStatus,
  NO_HOSTED_DEPLOYMENT,
  NOTHING_RECORDED,
  parseRecordedState,
  readRecordedState,
  renderLastInTransactionStatus,
  renderMigrationStatus,
  STATE_PATH,
  writeRecordedState,
} from "./migration-state.mjs";
import {
  checkedInJournalEntries,
  checkedInMigrationJournal,
  LAST_IN_TRANSACTION_MARKER,
  migrationsThatMustBeLast,
} from "./migration-support.mjs";

const JOURNAL = "count=17 hash=" + "a".repeat(64);
const AHEAD = "count=18 hash=" + "b".repeat(64);
/** A state file no real deployment names, so a case that finds it was handed it. */
const SYNTHETIC_STATE_PATH = "docs/example/migration-state.json";
/**
 * A private deployment naming it: what a case about the two rails is handed,
 * so it holds where the tree's own module is the public variant. The step
 * reads only a deployment's `kind` and `migrationState`.
 */
const PRIVATE = { kind: "private", migrationState: SYNTHETIC_STATE_PATH };

/**
 * The skip option of a case that reads a path the public seed does not carry
 * (manifest-j.md §2.4 item 6, Appendix A.3; ruling 92): a reason naming
 * `paths` when `scripts/hosted-deployment.mjs` declares the tree public, as
 * the seed's substitution makes it, and `false` otherwise. So in this private
 * tree neither such case skips, a missing record still fails it, and
 * `private-paths.test.mjs` fails if a path named here is gone.
 */
function skipInPublicTree(...paths) {
  return hostedDeployment.kind === "public"
    ? `the public tree does not carry ${paths.join(", ")} (scripts/hosted-deployment.mjs declares kind "public")`
    : false;
}

describe("comparing the tree against what production was last given", () => {
  test("is quiet when the record matches the tree", () => {
    const status = migrationStatus({
      checkedIn: JOURNAL,
      recorded: { journal: JOURNAL, tag: "0016_hot_randall" },
      branch: "main",
    });

    assert.equal(status.pending, false);
    assert.equal(status.blocking, false);
  });

  test("reports pending when the tree is ahead of the record", () => {
    const status = migrationStatus({
      checkedIn: AHEAD,
      recorded: { journal: JOURNAL, tag: "0016_hot_randall" },
      branch: "feat/something",
    });

    assert.equal(status.pending, true);
    assert.match(status.message, /has not been applied/u);
  });

  test("blocks on main and only notices elsewhere", () => {
    // The workflow this replaces failed the push on `main` and nothing else.
    // A pending migration is everybody's problem eventually and nobody's
    // problem right now: failing an unrelated feature branch's push would
    // teach people to pass --no-verify, which costs more than the alarm is
    // worth.
    const ahead = { checkedIn: AHEAD, recorded: { journal: JOURNAL } };

    assert.equal(migrationStatus({ ...ahead, branch: "main" }).blocking, true);
    assert.equal(
      migrationStatus({ ...ahead, branch: "feat/x" }).blocking,
      false,
    );
    assert.equal(migrationStatus({ ...ahead, branch: "HEAD" }).blocking, false);
  });

  test("treats a missing record as pending, never as applied", () => {
    // The dangerous direction is a false "applied". An operator who forgets to
    // commit the record leaves it behind the tree, so the alarm keeps firing —
    // annoying, and the right way round.
    const status = migrationStatus({
      checkedIn: JOURNAL,
      recorded: undefined,
      branch: "main",
    });

    assert.equal(status.pending, true);
    assert.equal(status.blocking, true);
    assert.equal(status.reason, NOTHING_RECORDED);
  });
});

describe("reading the record", () => {
  test("accepts a well-formed record", () => {
    const parsed = parseRecordedState(
      JSON.stringify({
        journal: JOURNAL,
        tag: "0016_hot_randall",
        appliedAt: "2026-09-18T21:00:00.000Z",
        gitSha: "f".repeat(40),
      }),
    );

    assert.equal(parsed.journal, JOURNAL);
    assert.equal(parsed.tag, "0016_hot_randall");
  });

  test("refuses anything it cannot trust, rather than guessing", () => {
    for (const text of [
      "",
      "not json",
      "{}",
      JSON.stringify({ journal: "" }),
      JSON.stringify({ journal: "count=17" }),
      JSON.stringify({ journal: 17 }),
    ]) {
      assert.equal(
        parseRecordedState(text),
        undefined,
        `${JSON.stringify(text)} must not parse`,
      );
    }
  });

  test("names one path, so the writer and the reader cannot disagree", () => {
    // Spelled once, as scripts/hosted-deployment.mjs's migrationState: a
    // relative .json path where the tree records a hosted deployment, and
    // null where it records none (the public variant's).
    assert.equal(STATE_PATH, hostedDeployment.migrationState);
    assert.equal(STATE_PATH, migrationStatePathOf(hostedDeployment));
    if (hostedDeployment.kind === "private") {
      assert.match(STATE_PATH, /\.json$/u);
      assert.ok(!STATE_PATH.startsWith("/"));
    } else {
      assert.equal(hostedDeployment.kind, "public");
      assert.equal(STATE_PATH, null);
    }
  });
});

test("the rendered notice says what to run", () => {
  const status = migrationStatus({
    checkedIn: AHEAD,
    recorded: { journal: JOURNAL, tag: "0016_hot_randall" },
    branch: "main",
  });
  const rendered = renderMigrationStatus(status);

  assert.match(rendered, /run-production-migrations\.mjs/u);
  assert.match(rendered, /EXPECTED_MIGRATION_GIT_SHA/u);
  // It must not tell anybody to approve staging, or to set a production opt-in
  // they have not thought about.
  assert.doesNotMatch(rendered, /REQUESTPORT_STAGING_DATABASE/u);
});

describe("a migration after one that must be last in its transaction", () => {
  const entries = (...tags) => tags.map((tag, index) => ({ tag, when: index }));
  const recordedAt = (count) => ({
    journal: `count=${count} hash=${"c".repeat(64)}`,
  });
  const mustBeLast = new Set(["0019_row_security_expand"]);
  const tree = entries(
    "0017_better_auth_1_7_expand",
    "0018_operator_credentials",
    "0019_row_security_expand",
  );
  const later = [...tree, { tag: "0020_later", when: 3 }];

  test("passes on the checked-in tree against the committed record", {
    skip: skipInPublicTree(
      "docs/implementation/production-migration-state.json",
    ),
  }, () => {
    // The checked-in tree must pass against the committed record, whatever it
    // holds: every marked migration must be the last one the record has not
    // yet given production, or already given.
    const real = checkedInJournalEntries();
    const status = lastInTransactionStatus({
      entries: real,
      mustBeLast: migrationsThatMustBeLast(real),
      recorded: readRecordedState(),
    });

    assert.equal(status.failing, false);
    assert.equal(renderLastInTransactionStatus(status), undefined);
  });

  test("passes while the marked migration is the last unrecorded one", () => {
    for (const recorded of [recordedAt(0), recordedAt(2), undefined]) {
      assert.equal(
        lastInTransactionStatus({ entries: tree, mustBeLast, recorded })
          .failing,
        false,
      );
    }
  });

  test("passes once production is recorded as given the marked migration", () => {
    for (const count of [3, 4, 9]) {
      assert.equal(
        lastInTransactionStatus({
          entries: later,
          mustBeLast,
          recorded: recordedAt(count),
        }).failing,
        false,
        `recorded count=${count}`,
      );
    }
  });

  test("fails, on any branch, when an entry follows the unrecorded marked one", () => {
    for (const recorded of [recordedAt(2), recordedAt(0), undefined]) {
      const status = lastInTransactionStatus({
        entries: later,
        mustBeLast,
        recorded,
      });

      assert.equal(status.failing, true);
      assert.equal(status.marked, "0019_row_security_expand");
      assert.deepEqual(status.after, ["0020_later"]);
    }
  });

  test("the failure says what to do", () => {
    const rendered = renderLastInTransactionStatus(
      lastInTransactionStatus({
        entries: later,
        mustBeLast,
        recorded: recordedAt(2),
      }),
      { path: SYNTHETIC_STATE_PATH },
    );

    assert.match(
      rendered,
      /Apply 0019_row_security_expand to production alone/u,
    );
    assert.match(rendered, /from a checkout whose journal\nends at it/u);
    assert.match(rendered, /the record's count is 2\)/u);
    assert.ok(rendered.includes(SYNTHETIC_STATE_PATH));
    assert.ok(rendered.includes(LAST_IN_TRANSACTION_MARKER));
    assert.match(rendered, /after it {5}: 0020_later/u);
  });

  /*
    The step's exit status is what fails the gate, so it is tested through
    the function the invoked-directly block calls, not only through the
    status and renderer above.
  */
  test("the step exits 1 on a feature branch when an entry follows the unrecorded marked one", () => {
    const outcome = migrationStateOutcome({
      checkedIn: `count=4 hash=${"d".repeat(64)}`,
      entries: later,
      mustBeLast,
      recorded: recordedAt(2),
      branch: "track/anything",
      deployment: PRIVATE,
    });

    assert.equal(outcome.exitCode, 1);
  });

  test("the step exits 0 for the checked-in tree and record on a feature branch", {
    skip: skipInPublicTree(
      "docs/implementation/production-migration-state.json",
    ),
  }, () => {
    const real = checkedInJournalEntries();
    const outcome = migrationStateOutcome({
      checkedIn: checkedInMigrationJournal(),
      entries: real,
      mustBeLast: migrationsThatMustBeLast(real),
      recorded: readRecordedState(),
      branch: "track/anything",
    });

    assert.equal(outcome.exitCode, 0);
  });

  test("the step prints the ordering failure first, and never the plain whole-tree instruction", () => {
    const { text } = migrationStateOutcome({
      checkedIn: `count=4 hash=${"d".repeat(64)}`,
      entries: later,
      mustBeLast,
      recorded: recordedAt(2),
      branch: "track/anything",
      deployment: PRIVATE,
    });

    assert.ok(
      text.indexOf("Apply 0019_row_security_expand to production alone") <
        text.indexOf("run-production-migrations.mjs"),
    );
    assert.doesNotMatch(text, /^Apply it deliberately/mu);
    assert.match(text, /the launcher refuses this tree/u);
    assert.match(text, /Apply the migration named above alone first/u);
  });
});

/*
  The deployment the step is given (manifest-j.md §2.4 item 5; ruling 99). A
  private one names the state file, and the two rails give what they gave
  when the path was a constant in this module; the public variant names
  none, and the step reports without failing. Every deployment here is
  synthetic or the committed public variant, so these cases hold in both
  trees.
*/
describe("the step under the deployment it is given", () => {
  const ROOT = "/checkout";
  const marked = new Set(["0019_row_security_expand"]);
  const entries = (...tags) => tags.map((tag, index) => ({ tag, when: index }));
  // The marked migration is the journal's last, so the ordering check
  // passes whatever the record says, and the alarm is the only rail.
  const alarmOnly = entries(
    "0017_better_auth_1_7_expand",
    "0018_operator_credentials",
    "0019_row_security_expand",
  );
  // An entry follows the marked migration: the ordering check's rail.
  const ordering = [...alarmOnly, { tag: "0020_later", when: 3 }];
  const FOUR = `count=4 hash=${"d".repeat(64)}`;

  /**
   * The record a state file at the private deployment's path gives, read
   * under `ROOT`: "absent" fails the read as a missing file does,
   * "malformed" holds no record, and a journal string is a record of it.
   */
  function recordedFrom(file) {
    const reads = [];
    const recorded = readRecordedState(PRIVATE.migrationState, ROOT, (path) => {
      reads.push(path);
      if (file === "absent") {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      if (file === "malformed") return "not json";
      return JSON.stringify({ journal: file, tag: "0016_hot_randall" });
    });
    assert.deepEqual(reads, [resolve(ROOT, SYNTHETIC_STATE_PATH)]);
    return recorded;
  }

  test("under a private deployment, an absent, a malformed and a present state file give the outcomes the step gave before, on main and on a feature branch, for both rails, naming the deployment's path", () => {
    const ordered = "Apply 0019_row_security_expand to production alone";
    const cases = [
      // The alarm: pending blocks on main, and only there.
      [alarmOnly, AHEAD, "absent", 1, 0, NOTHING_RECORDED],
      [alarmOnly, AHEAD, "malformed", 1, 0, NOTHING_RECORDED],
      [alarmOnly, AHEAD, JOURNAL, 1, 0, "has not been applied"],
      [alarmOnly, JOURNAL, JOURNAL, 0, 0, "Production has been given"],
      // The ordering check: fails on every branch.
      [ordering, FOUR, "absent", 1, 1, ordered],
      [ordering, FOUR, "malformed", 1, 1, ordered],
      [ordering, FOUR, `count=2 hash=${"c".repeat(64)}`, 1, 1, ordered],
      // Production given the marked migration: the alarm is left.
      [ordering, FOUR, `count=3 hash=${"c".repeat(64)}`, 1, 0, "has not been"],
    ];
    for (const [rail, checkedIn, file, onMain, onFeature, says] of cases) {
      for (const [branch, exitCode] of [
        ["main", onMain],
        ["track/anything", onFeature],
      ]) {
        const label = `${file}, ${checkedIn}, on ${branch}`;
        const { text, exitCode: actual } = migrationStateOutcome({
          checkedIn,
          entries: rail,
          mustBeLast: marked,
          recorded: recordedFrom(file),
          branch,
          deployment: PRIVATE,
        });

        assert.equal(actual, exitCode, label);
        assert.ok(text.includes(says), label);
        assert.equal(
          text.includes(SYNTHETIC_STATE_PATH),
          says !== "Production has been given",
          label,
        );
        assert.ok(!text.includes("production-migration-state.json"), label);
      }
    }
  });

  test("under the public variant, the step exits 0 on main and on a feature branch, says the tree records no hosted deployment, prints the ordering constraint, and names no path", () => {
    assert.equal(publicVariant.kind, "public");
    for (const branch of ["main", "track/anything"]) {
      // Nothing recorded and a migration after the marked one: under a
      // private deployment, both rails would fail this on main.
      const { text, exitCode } = migrationStateOutcome({
        checkedIn: FOUR,
        entries: ordering,
        mustBeLast: marked,
        recorded: undefined,
        branch,
        deployment: publicVariant,
      });

      assert.equal(exitCode, 0, branch);
      assert.ok(text.includes(NO_HOSTED_DEPLOYMENT), branch);
      assert.match(
        text,
        / {2}must be last : 0019_row_security_expand\n {2}after it {5}: 0020_later\n/u,
      );
      assert.ok(text.includes(LAST_IN_TRANSACTION_MARKER), branch);
      assert.doesNotMatch(
        text,
        /\.json|run-production-migrations|EXPECTED_MIGRATION_GIT_SHA/u,
      );
    }
  });

  test("under the public variant, the report on the checked-in journal names each migration that must be last, and what follows it", () => {
    const real = checkedInJournalEntries();
    const mustBeLast = migrationsThatMustBeLast(real);
    const tags = real.map(({ tag }) => tag);
    const { text, exitCode } = migrationStateOutcome({
      checkedIn: checkedInMigrationJournal(),
      entries: real,
      mustBeLast,
      recorded: undefined,
      branch: "main",
      deployment: publicVariant,
    });

    assert.equal(exitCode, 0);
    assert.ok(mustBeLast.size > 0);
    for (const tag of mustBeLast) {
      const after = tags.slice(tags.indexOf(tag) + 1);
      assert.ok(
        text.includes(
          `  must be last : ${tag}\n  after it     : ${after.length > 0 ? after.join(", ") : "(nothing)"}\n`,
        ),
        tag,
      );
    }
  });

  test("a malformed deployment exits 1 on main and on a feature branch, saying so, where a private one passes", () => {
    const passing = {
      checkedIn: JOURNAL,
      entries: alarmOnly,
      mustBeLast: marked,
      recorded: { journal: JOURNAL },
    };
    assert.equal(
      migrationStateOutcome({ ...passing, branch: "main", deployment: PRIVATE })
        .exitCode,
      0,
    );
    for (const deployment of [
      null,
      {},
      { kind: "public", migrationState: SYNTHETIC_STATE_PATH },
      { kind: "Public", migrationState: null },
      { kind: "staging", migrationState: null },
      { kind: "private", migrationState: null },
      { kind: "private" },
      { kind: "private", migrationState: `/${SYNTHETIC_STATE_PATH}` },
      { kind: "private", migrationState: `../${SYNTHETIC_STATE_PATH}` },
      {
        kind: "private",
        migrationState: "docs/./example/migration-state.json",
      },
      { kind: "private", migrationState: "docs/example/migration-state.txt" },
      { kind: "private", migrationState: 42 },
    ]) {
      const label = JSON.stringify(deployment);
      assert.throws(
        () => migrationStatePathOf(deployment),
        { message: MIGRATION_STATE_MALFORMED },
        label,
      );
      for (const branch of ["main", "track/anything"]) {
        assert.deepEqual(
          migrationStateOutcome({ ...passing, branch, deployment }),
          { text: MIGRATION_STATE_MALFORMED, exitCode: 1 },
          `${label} on ${branch}`,
        );
      }
    }
  });

  test("the writer writes the path it is handed, and for a deployment with no state file throws before writing anything", () => {
    const state = {
      journal: JOURNAL,
      tag: "applied=17",
      gitSha: "f".repeat(40),
      appliedAt: "2026-10-08T00:00:00.000Z",
    };
    const writes = [];
    const write = (...args) => writes.push(args);

    assert.throws(() => writeRecordedState(state, null, ROOT, write), {
      message: new RegExp(NO_HOSTED_DEPLOYMENT, "u"),
    });
    assert.deepEqual(writes, []);

    writeRecordedState(state, SYNTHETIC_STATE_PATH, ROOT, write);
    assert.deepEqual(writes, [
      [resolve(ROOT, SYNTHETIC_STATE_PATH), buildRecordedState(state), "utf8"],
    ]);
  });

  test("the reader reads the path it is handed, and for a deployment with no state file reads nothing", () => {
    const reads = [];
    const read = (path) => {
      reads.push(path);
      return JSON.stringify({ journal: JOURNAL });
    };

    assert.equal(readRecordedState(null, ROOT, read), undefined);
    assert.deepEqual(reads, []);
    assert.equal(
      readRecordedState(SYNTHETIC_STATE_PATH, ROOT, read).journal,
      JOURNAL,
    );
    assert.deepEqual(reads, [resolve(ROOT, SYNTHETIC_STATE_PATH)]);
  });
});
