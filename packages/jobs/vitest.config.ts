import { configDefaults, defineConfig } from "vitest/config";

import { loadRootEnv } from "../../scripts/with-root-env.mjs";

loadRootEnv();

const integrationSuites = "src/**/*.integration.test.{ts,tsx}";

export default defineConfig({
  test: {
    // The integration suites here hold advisory locks and leases across
    // several connections, so they run one file at a time. 30s rather than
    // Vitest's 5 for the same reason the database workspace gives: a new
    // connection is slow on a loaded host.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, integrationSuites],
        },
      },
      {
        // A database of their own, created for the run and dropped after it
        // (vitest.jobs-database.ts), because they claim every claimable
        // outbox row in whatever database they use. A separate project so a
        // run of the unit suites alone creates nothing and needs no stack:
        // Vitest runs a project's global setup only when the run includes
        // one of its files.
        extends: true,
        test: {
          name: "integration",
          include: [integrationSuites],
          globalSetup: ["./vitest.jobs-database.ts"],
          setupFiles: [
            "./vitest.jobs-database-env.ts",
            // The `test` database surface (manifest-i2.md §2.2). The unit
            // project opens nothing.
            "../db/src/test-support/declare-test-surface.ts",
            // X24's guard, as packages/db's configurations load it (X25): it
            // fails a case that issues a query on a `pg` client while
            // another is in flight on that client. It sees the suites' own
            // clients, in this process; the worker processes
            // bin.integration.test.ts starts are not Vitest's, and it is
            // not in them.
            "../db/src/test-support/one-query-at-a-time.ts",
          ],
        },
      },
    ],
  },
});
