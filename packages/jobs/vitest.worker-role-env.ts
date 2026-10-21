import { inject } from "vitest";

/*
 * A setup file of the worker-role lane (vitest.worker-role.config.ts): it
 * runs in the worker before each suite is imported, after
 * vitest.jobs-database-env.ts, and sets the worker's three variables to the
 * logins vitest.worker-role-logins.ts made. `workerStorages()` reads them the
 * first time a suite or a body asks for the storages.
 */
const urls = inject("workerRoleUrls");

if (!urls?.dispatcher || !urls.processor || !urls.maintenance) {
  throw new Error(
    "No worker-role logins were provided; these suites run in this lane only through vitest.worker-role.config.ts, whose global setup makes them.",
  );
}

process.env.REQUESTPORT_DISPATCHER_DATABASE_URL = urls.dispatcher;
process.env.REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL = urls.processor;
process.env.REQUESTPORT_MAINTENANCE_DATABASE_URL = urls.maintenance;
