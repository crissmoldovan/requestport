#!/usr/bin/env node
/**
 * The alarm that says a migration has reached the tree and not production.
 *
 * `.github/workflows/production-migrations.yml` used to carry one: a job that
 * ran on every push to `main` touching `packages/db/migrations/**`, applied
 * nothing, and deliberately failed with "A migration reached main and has not
 * been applied… Until then production is serving the previous schema." When CI
 * was deleted on 2026-09-18 the applier survived and the alarm did not, so a
 * migration could land and nothing would say so.
 *
 * This is its replacement, and it deliberately needs **no credentials**. It
 * compares the journal of the checked-in migration tree against the journal
 * recorded the last time somebody applied migrations to production. Putting a
 * production connection string on a laptop so a pre-push hook can ask the
 * database directly is precisely what the local-first arrangement exists to
 * avoid; `pnpm migrations:status` is there for when somebody genuinely has that
 * access and wants the truth rather than the bookkeeping.
 *
 * It fails in the safe direction. A record that is missing, unreadable or
 * behind the tree reads as *pending*, so an operator who applies a migration
 * and forgets to commit the updated record gets a nagging alarm rather than a
 * false all-clear. A false "pending" costs a minute; a false "applied" is how
 * production serves the previous schema while everybody believes otherwise.
 *
 * It also fails, on every branch, when the journal holds a migration after one
 * marked as the last one applied in its transaction and the record says
 * production has not been given the marked one (`lastInTransactionStatus`).
 * That tree could only be applied to production in one run, which the launcher
 * refuses. The gate fails such a tree wherever it runs (the pre-push hook, or
 * by hand). It does not gate the merge, so the launcher's refusal is the
 * backstop.
 *
 * Both rails run only where the tree records a hosted deployment
 * (`./hosted-deployment.mjs`, kind `"private"`), whose `migrationState` names
 * the record. The public seed carries that module's public variant instead,
 * which records none: there the step reads no record, reports the ordering
 * constraint, and fails nothing (manifest-j.md §2.4 item 5; ruling 99). A
 * missing record still reads as pending wherever a deployment is recorded;
 * only the module's own declaration turns the alarm off.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as hostedDeployment from "./hosted-deployment.mjs";
import {
  checkedInJournalEntries,
  checkedInMigrationJournal,
  LAST_IN_TRANSACTION_MARKER,
  migrationsAfterOneThatMustBeLast,
  migrationsThatMustBeLast,
  repositoryRoot,
} from "./migration-support.mjs";

/**
 * What the step and the launcher refuse a deployment for when its state file
 * is not one they can use. It quotes nothing from the deployment.
 */
export const MIGRATION_STATE_MALFORMED =
  "Refused: the hosted deployment's migration state is malformed (scripts/hosted-deployment.mjs): a private deployment names a relative .json path, and a public one null.";

export const NO_HOSTED_DEPLOYMENT = "this tree records no hosted deployment";

/**
 * One segment of the state file's path: letters, digits, `_`, `.` and `-`.
 * With the checks beside it no segment is empty, `.` or `..`, so the path is
 * relative and never climbs out of the directory it is resolved under.
 */
const RELATIVE_SEGMENT = /^[\w.-]+$/u;

/**
 * The state file `deployment` names, once checked; by default the hosted
 * deployment's, `./hosted-deployment.mjs`.
 *
 * Well formed means `kind` exactly `"private"` with `migrationState` a
 * relative `.json` path inside the repository, or exactly `"public"` with
 * `migrationState` `null`, which is what this returns for it. Anything else
 * throws `MIGRATION_STATE_MALFORMED`.
 */
export function migrationStatePathOf(deployment = hostedDeployment) {
  const malformed = () => new Error(MIGRATION_STATE_MALFORMED);
  if (deployment === null || typeof deployment !== "object") throw malformed();
  const { kind, migrationState } = deployment;
  if (kind === "public" && migrationState === null) return null;
  if (
    kind !== "private" ||
    typeof migrationState !== "string" ||
    !migrationState.endsWith(".json") ||
    !migrationState
      .split("/")
      .every(
        (segment) =>
          RELATIVE_SEGMENT.test(segment) && segment !== "." && segment !== "..",
      )
  ) {
    throw malformed();
  }
  return migrationState;
}

/**
 * One path, named once, so the writer and the reader cannot disagree. The
 * one spelling is `./hosted-deployment.mjs`'s `migrationState`; this is that
 * value, checked here at import, so a module whose state file is malformed
 * stops this module at import, and with it the launcher that imports it. It
 * is `null` where the tree records no hosted deployment.
 */
export const STATE_PATH = migrationStatePathOf(hostedDeployment);

export const NOTHING_RECORDED =
  "no production migration state is recorded, so nothing here can say what production has been given";

export const TREE_IS_AHEAD =
  "the checked-in migration tree is ahead of what production was last given";

/**
 * A record, or `undefined` for anything that cannot be trusted.
 *
 * Every malformed shape collapses to `undefined`, which the caller reads as
 * pending. There is no half-usable record: a file that cannot be parsed tells
 * us nothing about production, and "nothing" must never be mistaken for "up to
 * date".
 */
export function parseRecordedState(text) {
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object") return undefined;

  const { journal } = parsed;

  if (typeof journal !== "string") return undefined;
  if (!/^count=\d+ hash=[0-9a-f]{64}$/u.test(journal)) return undefined;

  return parsed;
}

/**
 * The record at `path` under `root`, parsed (`parseRecordedState`). With no
 * path, a tree that records no hosted deployment, it reads nothing and returns
 * `undefined`, the same answer as a missing file; the step's public branch
 * never asks.
 */
export function readRecordedState(
  path = STATE_PATH,
  root = repositoryRoot,
  read = readFileSync,
) {
  if (path === null) return undefined;
  try {
    return parseRecordedState(String(read(resolve(root, path), "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * Whether the tree is ahead, and whether that should stop a push.
 *
 * Blocking only on `main`, which is where the deleted workflow blocked. A
 * pending migration is everybody's problem eventually and nobody's problem
 * right now; failing an unrelated feature branch's push would teach people to
 * reach for `--no-verify`, and a bypassed alarm is worth less than no alarm at
 * all, because it also teaches them to bypass the rest of the gate.
 */
export function migrationStatus({ checkedIn, recorded, branch }) {
  if (recorded === undefined) {
    return {
      pending: true,
      blocking: branch === "main",
      reason: NOTHING_RECORDED,
      message: `${NOTHING_RECORDED}.`,
      checkedIn,
    };
  }

  if (recorded.journal === checkedIn) {
    return { pending: false, blocking: false, checkedIn, recorded };
  }

  return {
    pending: true,
    blocking: branch === "main",
    reason: TREE_IS_AHEAD,
    message: `A migration has reached this tree and has not been applied to production. Until it is, production serves the previous schema.`,
    checkedIn,
    recorded,
  };
}

/**
 * The alarm's notice. `afterOrdering` is set when the ordering failure below
 * (`renderLastInTransactionStatus`) is printed first: the launcher refuses
 * this tree in one run, so the notice must not tell the operator to run it on
 * the whole tree, and says instead to apply the migration named above alone
 * first. `path` is the state file it names: `migrationStateOutcome` hands it
 * the path of the deployment it is given, and it defaults to `STATE_PATH`.
 * The step's public branch never calls it.
 */
export function renderMigrationStatus(
  status,
  { afterOrdering = false, path = STATE_PATH } = {},
) {
  if (!status.pending) {
    return "Production has been given every migration in this tree.";
  }

  return [
    status.message,
    "",
    `  checked in : ${status.checkedIn}`,
    `  production : ${status.recorded?.journal ?? "(nothing recorded)"}`,
    "",
    ...(afterOrdering
      ? [
          "Not in one run: the launcher refuses this tree, for the reason above.",
          "Apply the migration named above alone first, as it says. Then apply the",
          "rest deliberately, from a machine that holds the production credential:",
        ]
      : [
          "Apply it deliberately, from a machine that holds the production credential:",
        ]),
    "",
    "    EXPECTED_MIGRATION_GIT_SHA=<the sha you are migrating for> \\",
    "      node scripts/run-production-migrations.mjs",
    "",
    `The launcher records the result in ${path}; commit that file, or this`,
    "will keep saying a migration is pending. It errs that way on purpose.",
  ].join("\n");
}

/**
 * Whether the journal holds a migration after one that must be the last one
 * applied in its transaction, while production is not recorded as given that
 * one. It fails the gate on every branch, unlike the alarm above.
 *
 * The record's count is how many journal entries production was given, so
 * the entries after it are what one production run would apply together, in
 * one transaction. A marked migration among them with anything after it is a
 * tree that cannot be applied safely in one run (`LAST_IN_TRANSACTION_MARKER`
 * in migration-support.mjs says why), and the production launcher would
 * refuse it. A missing or unreadable record counts as nothing given, the safe
 * direction, as it does for the alarm.
 */
export function lastInTransactionStatus({ entries, mustBeLast, recorded }) {
  const given =
    recorded === undefined
      ? 0
      : Number(/^count=(\d+) /u.exec(recorded.journal)?.[1] ?? 0);
  const blocked = migrationsAfterOneThatMustBeLast(
    entries.slice(given),
    mustBeLast,
  );

  return blocked === undefined
    ? { failing: false }
    : { failing: true, given, ...blocked };
}

/** `path` is the state file it names, as `renderMigrationStatus` takes it. */
export function renderLastInTransactionStatus(
  status,
  { path = STATE_PATH } = {},
) {
  if (!status.failing) return undefined;

  return [
    "The journal has a migration after one that must be the last migration",
    "applied in its transaction, and production is not recorded as given that",
    `one (the record's count is ${status.given}). One production run would apply them`,
    "together, in one transaction, and the launcher refuses that.",
    "",
    `  must be last : ${status.marked}`,
    `  after it     : ${status.after.join(", ")}`,
    "",
    `Apply ${status.marked} to production alone, from a checkout whose journal`,
    `ends at it, and commit the updated ${path}`,
    "before any migration after it lands. The marker is this header line:",
    "",
    `    ${LAST_IN_TRANSACTION_MARKER}`,
  ].join("\n");
}

/**
 * The ordering constraint as a tree that records no hosted deployment reports
 * it: each migration that must be the last one applied in its transaction, and
 * what the journal holds after it. It fails nothing and names no state file:
 * there is no production run here for the ordering check to protect, and
 * whether a fresh database can take the whole journal in one run is a question
 * for whoever runs it (manifest-j.md §2.4 item 5; ruling 99).
 */
export function renderOrderingConstraint({ entries, mustBeLast }) {
  const tags = entries.map(({ tag }) => tag);
  const marked = tags.flatMap((tag, index) =>
    mustBeLast.has(tag) ? [{ tag, after: tags.slice(index + 1) }] : [],
  );

  if (marked.length === 0) {
    return "No migration in this journal must be the last one applied in its transaction.";
  }

  return [
    "These migrations must each be the last one applied in its transaction, and",
    "the journal holds the ones after each. Drizzle applies every pending",
    "migration in one transaction, so a run that has a marked one pending with",
    "another after it applies the two together:",
    "",
    ...marked.flatMap(({ tag, after }) => [
      `  must be last : ${tag}`,
      `  after it     : ${after.length > 0 ? after.join(", ") : "(nothing)"}`,
      "",
    ]),
    "The marker is this header line:",
    "",
    `    ${LAST_IN_TRANSACTION_MARKER}`,
  ].join("\n");
}

/** What the record should say once a run has proved the journal. */
export function buildRecordedState({ journal, tag, gitSha, appliedAt }) {
  return `${JSON.stringify({ appliedAt, gitSha, journal, tag }, null, 2)}\n`;
}

/**
 * Writes the record to `path` under `root`. The launcher hands it the path of
 * the deployment it migrated, the one it prints. With no path, a tree that
 * records no hosted deployment, it throws before writing anything rather than
 * resolve `null` into a file name.
 */
export function writeRecordedState(
  state,
  path = STATE_PATH,
  root = repositoryRoot,
  write = writeFileSync,
) {
  if (path === null) {
    throw new Error(
      `${NO_HOSTED_DEPLOYMENT}, so there is no production migration state to write`,
    );
  }
  write(resolve(root, path), buildRecordedState(state), "utf8");
}

function currentBranch(spawn = spawnSync) {
  const result = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  return (result.stdout ?? "").trim();
}

export function invokedDirectly(argv1, moduleUrl) {
  return typeof argv1 === "string" && argv1 === fileURLToPath(moduleUrl);
}

/**
 * What the gate's migration-state step prints, and the exit status that makes
 * the gate pass or fail: 1 when the alarm blocks (a pending migration on
 * `main`) or when the ordering check fails (on any branch), otherwise 0.
 *
 * When the ordering check fails its explanation comes first, and the alarm's
 * notice after it names the same order of work, so one failure never gives
 * two contradictory instructions.
 *
 * Under `deployment` (by default `./hosted-deployment.mjs`): a private one's
 * state file is the path both notices name; the public variant's report says
 * the tree records no hosted deployment, prints the ordering constraint
 * (`renderOrderingConstraint`), ignores `recorded`, and exits 0; a malformed
 * one exits 1 with `MIGRATION_STATE_MALFORMED`.
 */
export function migrationStateOutcome({
  checkedIn,
  entries,
  mustBeLast,
  recorded,
  branch,
  deployment = hostedDeployment,
}) {
  let path;
  try {
    path = migrationStatePathOf(deployment);
  } catch (error) {
    return { text: error.message, exitCode: 1 };
  }

  if (path === null) {
    return {
      text: [
        `Nothing to compare: ${NO_HOSTED_DEPLOYMENT} (scripts/hosted-deployment.mjs is kind "public"), so there is no production whose migration state it could record, and nothing here blocks.`,
        "",
        renderOrderingConstraint({ entries, mustBeLast }),
      ].join("\n"),
      exitCode: 0,
    };
  }

  const status = migrationStatus({ checkedIn, recorded, branch });
  const ordering = lastInTransactionStatus({ entries, mustBeLast, recorded });
  const text = ordering.failing
    ? [
        renderLastInTransactionStatus(ordering, { path }),
        renderMigrationStatus(status, { afterOrdering: true, path }),
      ].join("\n\n")
    : renderMigrationStatus(status, { path });

  return { text, exitCode: status.blocking || ordering.failing ? 1 : 0 };
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  const entries = checkedInJournalEntries();
  const { text, exitCode } = migrationStateOutcome({
    checkedIn: checkedInMigrationJournal(),
    entries,
    mustBeLast: migrationsThatMustBeLast(entries),
    // STATE_PATH is the module's, checked at import; where it is null the
    // tree records no hosted deployment, and nothing is read.
    recorded: STATE_PATH === null ? undefined : readRecordedState(STATE_PATH),
    branch: currentBranch(),
  });

  console.log(text);
  process.exitCode = exitCode;
}
