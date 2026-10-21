import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    jobsDatabaseUrl: string;
    /**
     * src/bin.integration.test.ts's own database (X28), provided only to a
     * project whose files include that one (ruling 232 item 1).
     */
    jobsBinDatabaseUrl: string;
  }
}

/*
 * A setup file of the integration project in vitest.config.ts: it runs in the
 * worker before each integration suite is imported, and points it at the
 * database packages/jobs/vitest.jobs-database.ts created for this run.
 *
 * Setting `DATABASE_URL` here is enough for `@requestport/db`, whose pool
 * reads it each time it opens a connection rather than when it is imported.
 * bin.integration.test.ts sets it again, to its own database
 * (`jobsBinDatabaseUrl`, X28), as its module loads, and its worker processes
 * inherit that; this file runs again before the next file, which reads the
 * run's database once more.
 *
 * It sits beside vitest.config.ts rather than under src/ because
 * trigger/src/config-imports.test.ts imports every non-test module under
 * packages/jobs/src, and this one refuses to load outside the integration
 * project.
 */
const url = inject("jobsDatabaseUrl");

if (typeof url !== "string" || url === "") {
  throw new Error(
    "No jobs integration database was provided; these suites run only in the integration project of packages/jobs/vitest.config.ts, whose global setup creates one.",
  );
}

process.env.DATABASE_URL = url;
