import { configDefaults, defineConfig } from "vitest/config";

import { refuseUnapprovedProductionDatabase } from "../../scripts/production-database-guard.mjs";
import { loadRootEnv } from "../../scripts/with-root-env.mjs";

// The integration suites create databases and cluster-wide roles, as the
// superuser DATABASE_URL names (ruling 158, item 15). As packages/db's
// configuration does, production, or staging's own database, is refused
// here before any suite runs, unless its opt-in reads exactly `approved`;
// the suites also refuse any server not on this machine.
loadRootEnv();
refuseUnapprovedProductionDatabase(process.env);

const integrationSuites = "src/**/*.integration.test.ts";

export default defineConfig({
  test: {
    environment: "node",
    // Several cases start the executable as a child process through tsx, which
    // takes seconds on a loaded host; 30s, as packages/jobs gives its own.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, integrationSuites],
        },
      },
      {
        // On the run's PostgreSQL: one file at a time, each first start in
        // a database of its own, and two processes per start. A start serves
        // the web UI from the self-host build and refuses without one, so
        // the global setup builds it first when it is missing or stale
        // (src/web/self-host-build.global-setup.ts; ruling 160, item 2).
        extends: true,
        test: {
          name: "integration",
          include: [integrationSuites],
          globalSetup: ["src/web/self-host-build.global-setup.ts"],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
