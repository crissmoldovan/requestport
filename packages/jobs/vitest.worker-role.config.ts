import { defineConfig } from "vitest/config";

import { refuseUnapprovedProductionDatabase } from "../../scripts/production-database-guard.mjs";
import { loadRootEnv } from "../../scripts/with-root-env.mjs";

/*
 * The worker-role lane (Plan 13, Track I.2b; manifest-i2.md §5.3 Owns and
 * Done when 9, 12 and 14; ruling 35, the same hand-over as I.2's
 * application-role lane). Named integration suites run a second time with the
 * worker's three variables set to logins in the three worker groups, so the
 * pollers claim as the dispatcher, the bodies process as the tenant processor
 * bound to each row's organisation, and the maintenance bodies run as
 * maintenance: a grant the matrix missed fails here as 42501, not in
 * production.
 *
 * How: the run's own database is made and migrated by vitest.jobs-database.ts,
 * as the integration project's is; vitest.worker-role-logins.ts then makes the
 * three logins on that server and drops them when the run ends; and
 * vitest.worker-role-env.ts sets the three variables in each suite's worker.
 * `DATABASE_URL` still names the owner, which the suites seed through.
 *
 * What it runs is `WORKER_ROLE_LANE_FILES`, joined by name once a suite has
 * been run here and passes as these roles, never by glob.
 *
 * `pnpm --filter @requestport/jobs exec vitest run --config
 * vitest.worker-role.config.ts`; the gate runs it as its own step
 * (`scripts/verify-locally.mjs`, "worker-role-lane"). It needs pg, and the
 * local stack: the logins' global setup refuses any other driver.
 */

loadRootEnv();
refuseUnapprovedProductionDatabase(process.env);

/** Relative to this package: the suites that pass as the worker roles. */
export const WORKER_ROLE_LANE_FILES: readonly string[] = [
  "src/postgres/outbox-poller.integration.test.ts",
  "src/worker.integration.test.ts",
  "src/worker-row-security.integration.test.ts",
];

export default defineConfig({
  test: {
    name: "worker role",
    include: [...WORKER_ROLE_LANE_FILES],
    passWithNoTests: false,
    globalSetup: [
      "./vitest.jobs-database.ts",
      "./vitest.worker-role-logins.ts",
    ],
    setupFiles: [
      "./vitest.jobs-database-env.ts",
      "./vitest.worker-role-env.ts",
      "../db/src/test-support/declare-test-surface.ts",
      // X24's guard, as the integration project loads it (X25).
      "../db/src/test-support/one-query-at-a-time.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
