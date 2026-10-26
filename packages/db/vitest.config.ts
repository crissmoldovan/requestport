import { existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import type { Reporter } from "vitest/reporters";

import { refuseUnapprovedProductionDatabase } from "../../scripts/production-database-guard.mjs";
import { loadRootEnv } from "../../scripts/with-root-env.mjs";

// A bare `pnpm --filter @requestport/db test` reaches this file without going
// through scripts/with-root-env.mjs's `run`, which is where the entry-point
// guard otherwise sits. loadRootEnv fills DATABASE_URL from `.env.local`, and
// several suites here build pg storages from it directly; pg dials the URL's
// host whatever the hosted driver's proxy variable says. So the guard runs here too,
// before any suite: production, or staging's own database, is refused unless
// its opt-in reads exactly `approved`. It judges DATABASE_URL only, as the
// script does; the suites' own storages also pass through
// `refuseUnapprovedSharedPgDatabase`, which judges the URL they use.
loadRootEnv();
refuseUnapprovedProductionDatabase(process.env);

/*
 * The PGlite lane (Plan 13, Track E.2 step 3; track-e.md): the database
 * suites on PGlite, with no server. `pnpm --filter @requestport/db
 * test:pglite` runs it. It is not part of the gate — verify-locally refuses
 * any driver but pg, and no Turbo task runs the script — and it is labelled
 * single-session, because that is what it is: PGlite has one connection.
 *
 * It selects PGlite through the same rule every process uses,
 * REQUESTPORT_DATABASE_DRIVER=pglite, and names its database in its own
 * variable, REQUESTPORT_PGLITE_DATA_DIR: given, that directory is used and
 * kept; unset, a fresh temporary directory is made and removed when the run
 * exits. Either way it is migrated once, here, through migrate() — the
 * lane's equivalent of the gate migrating its database before the suites —
 * and each database suite's own storage, built from the environment
 * (`storageOptionsFromEnv`, which reads that variable), then opens it.
 */

/** Relative to this package. The database suites, and the three that prove the seam on PGlite. */
export const PGLITE_LANE_FILES: readonly string[] = [
  "src/advisory-lock.integration.test.ts",
  "src/appearance-migration.integration.test.ts",
  "src/better-auth-expand.integration.test.ts",
  "src/integrity/integrity-check.integration.test.ts",
  "src/queries/administration/agent-reads.integration.test.ts",
  "src/queries/administration/import-reads.integration.test.ts",
  "src/queries/administration/member-reads.integration.test.ts",
  "src/queries/administration/operations-reads.integration.test.ts",
  "src/queries/administration/organization-reads.integration.test.ts",
  "src/queries/administration/project-settings-reads.integration.test.ts",
  "src/queries/administration/routing-reads.integration.test.ts",
  "src/queries/administration/slack-reads.integration.test.ts",
  "src/queries/overview-query-repository.integration.test.ts",
  "src/queries/project-settings-repository.integration.test.ts",
  "src/queries/request-query-repository.integration.test.ts",
  "src/repositories/agent-auth-repository.audience.integration.test.ts",
  "src/repositories/agent-auth-repository.integration.test.ts",
  "src/repositories/agent-repository.integration.test.ts",
  "src/repositories/appearance-repository.integration.test.ts",
  "src/repositories/command-authorization.integration.test.ts",
  "src/repositories/foundation-query.integration.test.ts",
  "src/repositories/foundation-repository.integration.test.ts",
  "src/repositories/foundation-repository.local-credential.integration.test.ts",
  "src/repositories/foundation-repository.operator-revocation.integration.test.ts",
  "src/repositories/foundation-repository.invitation-renewal.integration.test.ts",
  "src/repositories/import-repository.integration.test.ts",
  "src/repositories/operator-credential-repository.integration.test.ts",
  "src/repositories/operator-credential-repository.row-security.integration.test.ts",
  "src/repositories/command-authorization.operator.integration.test.ts",
  "src/repositories/operations-repository.integration.test.ts",
  "src/repositories/organization-management-repository.integration.test.ts",
  "src/repositories/request-draft-ownership.integration.test.ts",
  "src/repositories/request-assignment.integration.test.ts",
  "src/repositories/routing-repository.integration.test.ts",
  "src/repositories/slack-repository.integration.test.ts",
  "src/repositories/retention-hold-repository.integration.test.ts",
  "src/signup-eligibility-guard.integration.test.ts",
  "src/migrate.test.ts",
  "src/testing.test.ts",
  "src/transaction.test.ts",
];

/**
 * The integration suites here that the lane does not run, each with the
 * reason. Every `*.integration.test.ts` under src/ is in PGLITE_LANE_FILES or
 * here, never neither and never both; scripts/workspace-contract.test.mjs
 * fails otherwise, so a new suite has to be placed rather than being silently
 * left out.
 */
export const PGLITE_LANE_LEFT_OUT: readonly { file: string; why: string }[] = [
  {
    file: "src/one-query-at-a-time.integration.test.ts",
    why:
      "Its subject is the guard on `pg`'s client (X24), which PGlite's " +
      "storage does not use: on PGlite the guard records nothing, so its " +
      "first case, which shows the guard firing, would fail.",
  },
  {
    file: "src/test-support/appearance-cutover.integration.test.ts",
    why:
      "Its subject is lock contention between sessions on the shared " +
      "tables, which PGlite's one connection cannot have: two of its four " +
      "cases hold three sessions at once. The setup and teardown it " +
      "drives still run in the lane, as the hooks of " +
      "appearance-repository.integration.test.ts's lock choreography suite.",
  },
  {
    file: "src/repositories/organization-management-repository.sessions.integration.test.ts",
    why:
      "Its subject is organisation access commands overlapping on separate " +
      "connections, which PGlite's one connection cannot have: every case " +
      "holds three sessions at once. The same commands, one session at a " +
      "time, run in the lane as " +
      "organization-management-repository.integration.test.ts.",
  },
  {
    file: "src/row-security.integration.test.ts",
    why:
      "row-level security is tested on native PostgreSQL only " +
      "(manifest-i2.md §2.8 item 5): PGlite connects as a superuser, so " +
      "its lane is not where a policy or a grant is proved.",
  },
  {
    file: "src/row-security.catalogue.integration.test.ts",
    why:
      "row-level security is tested on native PostgreSQL only " +
      "(manifest-i2.md §2.8 item 5): PGlite connects as a superuser, so " +
      "its lane is not where a policy or a grant is proved.",
  },
  {
    file: "src/worker-row-security.integration.test.ts",
    why:
      "row-level security is tested on native PostgreSQL only " +
      "(manifest-i2.md §2.8 item 5), and this suite logs in as roles it " +
      "creates and holds two claiming sessions at once, which PGlite's one " +
      "superuser connection cannot do.",
  },
];

export interface PgliteLaneExclusion {
  file: string;
  /** The enclosing describe blocks, then the test's own title. */
  names: readonly string[];
}

const advisoryLock = "src/advisory-lock.integration.test.ts";
const appearance = "src/repositories/appearance-repository.integration.test.ts";
const foundation = "src/repositories/foundation-repository.integration.test.ts";
const signup = "src/signup-eligibility-guard.integration.test.ts";
const advisoryLockSuite = "the Postgres worker's per-tick advisory lock";
const appearanceSuite = "live appearance lock choreography";
const foundationSuite = "live foundation repository";
const signupSuite = "live signup eligibility insert guard";

/**
 * The cases that hold two or three sessions open at once, each asserting on
 * what one session's lock does to another: 18 on 2026-09-29, after X15's
 * invitation renewal race (17 on 2026-09-28). Plan §3 R1 counted 15 of 85
 * before Track C added the job worker's advisory-lock suite, whose two cases
 * here hold the lock's transaction open while another connection asks for
 * the same key or a different one.
 *
 * The other 16 each open a second `openSession()` while the first is still
 * held — the third, where there is one, is "serializes same normalized
 * bootstrap slug without blocking unrelated slugs", which also shows
 * unrelated work proceeding meanwhile. On PGlite the second `openSession()`
 * is refused (`SingleSessionPglite`), so such a case fails, loudly, rather
 * than proving less. The advisory-lock two do not fail that way: their
 * second statement goes through the suite's storage's handle
 * (`suiteStorage.db`), waits behind the held
 * transaction, and the case times out (measured 2026-09-28: 30s each, and
 * the file's third case, which passes on its own, timed out behind them).
 */
export const PGLITE_LANE_EXCLUDED: readonly PgliteLaneExclusion[] = [
  [
    advisoryLock,
    advisoryLockSuite,
    "admits one holder of a key; a second, on another connection, is turned away without waiting",
  ],
  [
    advisoryLock,
    advisoryLockSuite,
    "does not make different keys wait for each other",
  ],
  [
    appearance,
    appearanceSuite,
    "blocks a second owner until the first update commits",
  ],
  [
    appearance,
    appearanceSuite,
    "serializes two first-time personal writers for the same user",
  ],
  [
    appearance,
    appearanceSuite,
    "holds a concurrent membership revoke until the command commits",
  ],
  [
    appearance,
    appearanceSuite,
    "blocks a duplicate dispatch on the receipt lock and replays it",
  ],
  [
    foundation,
    foundationSuite,
    "serializes same normalized bootstrap slug without blocking unrelated slugs",
  ],
  [
    foundation,
    foundationSuite,
    "activates one allowlist row safely across unrelated bootstrap slug locks",
  ],
  [
    foundation,
    foundationSuite,
    "serializes exact and conflicting concurrent invitation payloads per tenant and email",
  ],
  [
    foundation,
    foundationSuite,
    "a revoke that reaches an invitation a renewal holds waits, and is refused once the renewal commits",
  ],
  [
    foundation,
    foundationSuite,
    "revocation that locks first wins against project authorization",
  ],
  [
    foundation,
    foundationSuite,
    "suspension that locks first wins against invitation authorization",
  ],
  [
    foundation,
    foundationSuite,
    "bootstrap re-evaluates a locked organization after suspension waits",
  ],
  [
    signup,
    signupSuite,
    "invitation revocation that locks first denies signup and membership",
  ],
  [
    signup,
    signupSuite,
    "an invitation insertion blocked past expiry grants no membership",
  ],
  [
    signup,
    signupSuite,
    "revocation wins when it locks the allowlist row before user insertion",
  ],
  [
    signup,
    signupSuite,
    "a blocked insertion rechecks database time after eligibility expires",
  ],
  [
    signup,
    signupSuite,
    "user insertion wins when its share lock precedes revocation",
  ],
].map(([file, ...names]) => ({ file, names }));

function escapeForPattern(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Vitest's `testNamePattern` is matched against a case's describe titles and
 * its own title joined by spaces; a case it does not match is skipped. This
 * matches every name except the excluded ones, whole — a longer or shorter
 * title still runs — whether or not the file's own name leads it.
 */
export function pgliteLaneNamePattern(
  excluded: readonly PgliteLaneExclusion[] = PGLITE_LANE_EXCLUDED,
): RegExp {
  const names = excluded.map((entry) =>
    escapeForPattern(entry.names.join(" ")),
  );

  return new RegExp(`^(?!(?:.* )?(?:${names.join("|")})$)`, "u");
}

export interface CollectedCase {
  /** Relative to this package. */
  file: string;
  /** Vitest's `TestCase.fullName`: describe titles and the title, joined by " > ". */
  fullName: string;
  state: string;
}

/**
 * What is wrong with the exclusions, given what the run collected: a named
 * case that no longer exists — renamed, moved or deleted — or one that ran.
 * Either means the lane no longer excludes what this file says it does.
 *
 * Only the exclusions in `files`, the test files the run collected, are
 * judged: a run filtered to other files never collects them, and that says
 * nothing about their names. A lane file that is missing altogether is
 * refused before the run starts (`preparePgliteLane`), so it cannot hide
 * here. `files` defaults to the files `collected` names.
 */
export function pgliteLaneExclusionProblems(
  collected: readonly CollectedCase[],
  excluded: readonly PgliteLaneExclusion[] = PGLITE_LANE_EXCLUDED,
  files: readonly string[] = collected.map((testCase) => testCase.file),
): string[] {
  const problems: string[] = [];
  const inRun = new Set(files);

  for (const entry of excluded) {
    if (!inRun.has(entry.file)) continue;

    const fullName = entry.names.join(" > ");
    const found = collected.find(
      (testCase) =>
        testCase.file === entry.file && testCase.fullName === fullName,
    );

    if (found === undefined) {
      problems.push(
        `${entry.file} › ${fullName}: excluded by name, but no longer ` +
          "collected. Correct PGLITE_LANE_EXCLUDED in vitest.config.ts.",
      );
    } else if (found.state !== "skipped") {
      problems.push(
        `${entry.file} › ${fullName}: excluded by name, but it ran ` +
          `(${found.state}).`,
      );
    }
  }
  return problems;
}

/**
 * The lane's reporter: says what the lane ran and, when
 * `pgliteLaneExclusionProblems` finds anything in the files the run
 * collected, prints it and sets a failing exit code.
 */
export function createPgliteLaneReporter(
  excluded: readonly PgliteLaneExclusion[] = PGLITE_LANE_EXCLUDED,
): Reporter {
  return {
    onTestRunEnd(testModules) {
      const files = testModules.map(
        (testModule) => testModule.relativeModuleId,
      );
      const collected: CollectedCase[] = testModules.flatMap((testModule) =>
        [...testModule.children.allTests()].map((testCase) => ({
          file: testModule.relativeModuleId,
          fullName: testCase.fullName,
          state: testCase.result().state,
        })),
      );
      const problems = pgliteLaneExclusionProblems(collected, excluded, files);
      const count = (state: string) =>
        collected.filter((testCase) => testCase.state === state).length;
      const judged = excluded.filter((entry) => files.includes(entry.file));

      console.log(
        `\nPGlite lane (single-session): ${collected.length} cases collected, ` +
          `${count("passed")} passed, ${count("failed")} failed, ` +
          `${count("skipped")} skipped; ${judged.length} of the ` +
          `${excluded.length} multi-session cases excluded by name are in ` +
          "the files this run collected.",
      );
      if (problems.length > 0) {
        console.error(
          `\nThe PGlite lane's exclusions are out of date:\n- ${problems.join("\n- ")}`,
        );
        process.exitCode = 1;
      }
    },
  };
}

/**
 * Adds the lane's reporter to the resolved configuration rather than to
 * `test.reporters`, which a `--reporter` on the command line replaces: added
 * here, it runs whatever reporters the run was given.
 */
export function pgliteLanePlugin(
  excluded: readonly PgliteLaneExclusion[] = PGLITE_LANE_EXCLUDED,
) {
  return {
    name: "requestport-pglite-lane-exclusions",
    configureVitest({
      vitest,
    }: {
      vitest: { config: { reporters: unknown[] } };
    }) {
      vitest.config.reporters.push(createPgliteLaneReporter(excluded));
    },
  };
}

const pgliteLane = process.env.REQUESTPORT_DATABASE_DRIVER === "pglite";

async function preparePgliteLane() {
  const missing = PGLITE_LANE_FILES.filter((file) => !existsSync(file));

  if (missing.length > 0) {
    throw new Error(
      `The PGlite lane names files that do not exist: ${missing.join(", ")}.`,
    );
  }

  const given = process.env.REQUESTPORT_PGLITE_DATA_DIR?.trim() ?? "";

  if (given === "memory://") {
    throw new Error(
      "REQUESTPORT_PGLITE_DATA_DIR=memory:// gives every test file a " +
        "database of its own, empty and unmigrated. Name a directory, or " +
        "leave it unset for a temporary one.",
    );
  }

  let dataDir = given;

  if (dataDir === "") {
    dataDir = await mkdtemp(join(tmpdir(), "requestport-pglite-lane-"));
    const made = dataDir;

    process.once("exit", () => {
      rmSync(made, { recursive: true, force: true });
    });
  }
  // Read by client.ts, here and in every test worker, which inherit it.
  process.env.REQUESTPORT_PGLITE_DATA_DIR = dataDir;

  const { createStorage } = await import("./src/client.js");
  const { migrate } = await import("./src/migrate.js");
  const storage = createStorage({ driver: "pglite", dataDir });

  try {
    const report = await migrate(storage);

    console.log(
      `PGlite lane (single-session): ${dataDir}, ` +
        `${report.applied.length} migrations applied.`,
    );
  } finally {
    await storage.close();
  }
  return dataDir;
}

const pgliteDataDir = pgliteLane ? await preparePgliteLane() : undefined;

export default defineConfig({
  // The lane's exclusion check (`pgliteLanePlugin`), in the lane only.
  plugins: pgliteDataDir === undefined ? [] : [pgliteLanePlugin()],
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // The `test` database surface (manifest-i2.md §2.2), declared before any
    // suite is imported, and the guard that fails a case which issues a query
    // on a `pg` client while another is in flight on it (X24). At the top
    // level, so the PGlite lane inherits both; the guard sees no PGlite query.
    setupFiles: [
      "./src/test-support/declare-test-surface.ts",
      "./src/test-support/one-query-at-a-time.ts",
    ],
    // Every suite here that opens a connection talks to the one PostgreSQL
    // database the run names, and several deliberately keep conflicting
    // transactions open — the signup-guard and appearance lock choreography.
    // On a database that has not applied 0014, the cutover replay in
    // src/test-support/appearance-cutover.ts also takes SHARE ROW EXCLUSIVE
    // table locks; on a migrated one, which is what the gate runs against, it
    // returns before taking any. Vitest's default file parallelism turned this
    // into `deadlock detected` in unrelated suites, so `fileParallelism: false`
    // runs this workspace's files one at a time.
    //
    // That covers this workspace only. Other workspaces open the same database
    // in their tests: a test file elsewhere does when it queries a storage it
    // builds over it (`createStorage`, `createTestStorage`, or a root's through
    // @requestport/db/wiring), or reaches a pool through
    // @requestport/db/testing. They are not named or counted here, because an
    // earlier list in this comment went false as soon as a file was added. From
    // the repository root this lists the files elsewhere that build a storage
    // or reach a pool; a listed file that never queries the storage it
    // builds, or builds it over another database, opens nothing here:
    //   grep -rlE --include='*.test.ts' --include='*.test.tsx' \
    //     --exclude-dir=node_modules \
    //     'create(Test)?Storage\(|StorageFromEnv\(|"@requestport/db/testing"' \
    //     apps packages trigger | grep -v '^packages/db/'
    // None of them is ordered against this workspace, on evidence. Making @requestport/auth#test wait for this
    // workspace's test task was tried on 2026-09-27 and removed: no blocking
    // lock was caught in twelve gate runs, this suite still timed out in seven
    // of nine forced runs with auth never overlapping it, and running the
    // signup-guard file with the auth files deliberately overlapping it passed
    // every time. The ordering cost gate time, and its workspace-specific entry
    // silently replaced Turbo's generic `test` task for auth rather than
    // adding to it.
    //
    // Why 30 seconds and not Vitest's 5: opening a connection is slow under
    // load. The hosted driver (1.1.0) derives the SCRAM key in JavaScript,
    // one awaited `crypto.subtle.sign` per iteration, on every new connection.
    // With the local role stored at 4,096 iterations that measured 167–332ms of
    // CPU per connection; at a load average of 157–240 one connection took
    // 1.7–6.4s, and connecting was 57–97% of each slow case. compose.yaml
    // stores the role at 1 iteration on a fresh volume (an existing one needs
    // the one-time command written beside that setting there); at 1, a probe
    // measured a median of 15ms of CPU per connection, but under a load
    // average of 126–165 a connection still took a median of 1.8s of wall
    // time, waiting for a CPU, and one took 67s. That cuts the cost; it has
    // not been shown to keep every case inside this budget on a host that
    // busy. apps/web already uses 30s. A case blocked on a lock still fails,
    // at 30s instead of 5.
    // The measurements are in docs/implementation/plans/2026-09-27-13/track-t0.md.
    // Since 2026-09-28 the gate runs these suites on pg, which derives the key
    // with native PBKDF2: measured side by side, 1.4ms of CPU per connection at
    // 1 iteration and 1.8ms at 4,096 (the hosted driver: 2.4ms and 62.7ms). Waiting for a
    // CPU on a busy host is not a SCRAM cost, and pg has not been measured at
    // the loads that broke this budget, so the budget stays (track-e.md, E.2
    // step 2).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    // Dead: Vitest 4 removed `poolOptions`, ignores this and prints a
    // deprecation notice, so it makes nothing single-threaded. It stays only
    // because scripts/workspace-contract.test.mjs asserts `singleThread: true`
    // here, and that file is outside this change's scope. Remove both together.
    poolOptions: { threads: { singleThread: true } },
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["json"],
    },
    /*
     * The PGlite lane. `fileParallelism: false` above matters more here: the
     * files share one PGlite directory, each file's storage opens it in turn,
     * and PGlite takes no lock on it (measured: two processes opened one
     * directory at once, neither refused). A file that does not close its
     * storage leaves the directory unclosed; the next file's PGlite recovers
     * it on open (measured, track-e.md).
     */
    ...(pgliteDataDir === undefined
      ? {}
      : {
          name: "pglite (single-session)",
          include: [...PGLITE_LANE_FILES],
          testNamePattern: pgliteLaneNamePattern(),
          env: { REQUESTPORT_PGLITE_DATA_DIR: pgliteDataDir },
          coverage: { enabled: false },
        }),
  },
});
