import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as Pg from "pg";
import { defineConfig } from "vitest/config";

import { refuseUnapprovedProductionDatabase } from "../../scripts/production-database-guard.mjs";
import { loadRootEnv } from "../../scripts/with-root-env.mjs";

/*
 * The application-role lane (Plan 13, Track I.2; manifest-i2.md §2.9,
 * ruling 17 open question 9). Named database suites run a second time with
 * each storage they build from the application's options
 * (`applicationStorageOptionsFromEnv`, as the application root builds its
 * own) connected as a login that is a member of
 * `requestport_application` and nothing else: not a superuser, not
 * `BYPASSRLS`, owning nothing. So every policy applies, and a query the
 * application makes without a binding fails here instead of in production.
 * A storage a suite builds with `storageOptionsFromEnv` dials `DATABASE_URL`,
 * the owner, here as in every other run (I.2 step 5, slice 1).
 *
 * How: before any suite, this file creates that login on the run's own
 * PostgreSQL — named from the database, so tracks sharing the server never
 * collide; stored with one SCRAM iteration; with a password made for this
 * run and never written down — and hands its URL to every suite as
 * `REQUESTPORT_APPLICATION_DATABASE_URL`. That is the variable production's
 * application reads (§1), and setting it also turns on the wrapping of pool
 * reads in bound transactions (ruling 17), which is what this lane is for.
 * The login is dropped when the run ends. `DATABASE_URL` still names the
 * owner, as it does in production until §3 step 6.
 *
 * What it runs is `APPLICATION_ROLE_LANE_FILES`, not every suite: a suite
 * joins the list by name, once it has been run here and passes as this
 * role — never by glob, which would take a suite into the gate before anyone
 * had run it here. It is run as this role only through the storages it
 * builds from the application's options. F.2's administration reads
 * (`queries/administration/*-reads.integration.test.ts`, ruling 50) are not
 * on it yet: each of those suites builds its one storage with
 * `storageOptionsFromEnv`, seeding and reading through it, so here it would
 * run as the owner. Each joins once it reads through an application storage
 * and seeds through an owner storage of its own.
 *
 * `pnpm --filter @requestport/db exec vitest run --config
 * vitest.application-role.config.ts`; the gate runs it as its own step
 * (`scripts/verify-locally.mjs`, "application-role-lane"). It needs pg: the
 * gate selects it, and this file refuses any other driver.
 */

loadRootEnv();
refuseUnapprovedProductionDatabase(process.env);

/** Relative to this package: the suites that pass as the application role. */
export const APPLICATION_ROLE_LANE_FILES: readonly string[] = [
  "src/role-guard.test.ts",
  // I.2 step 8 (0024): the buses and an issuance under the receipts policy.
  "src/command-receipts.application-role.test.ts",
];

function ownerUrl() {
  const url = process.env.DATABASE_URL;

  if (typeof url !== "string" || url.trim() === "") {
    throw new Error(
      "The application-role lane needs DATABASE_URL: the owner that creates " +
        "its login and applies the migrations.",
    );
  }
  return url;
}

async function withOwner<T>(work: (client: Pg.Client) => Promise<T>) {
  const { Client } = createRequire(import.meta.url)("pg") as typeof Pg;
  const client = new Client({ connectionString: ownerUrl(), ssl: false });

  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Creates the lane's login, replacing one a stopped run left, and answers its URL. */
async function prepareApplicationRoleLane() {
  const driver = process.env.REQUESTPORT_DATABASE_DRIVER;

  if (driver !== "pg") {
    throw new Error(
      "The application-role lane runs on pg, against a real PostgreSQL: set " +
        "REQUESTPORT_DATABASE_DRIVER=pg.",
    );
  }

  const password = randomUUID().replaceAll("-", "");
  const role = await withOwner(async (client) => {
    const { rows } = await client.query<{ role: string }>(
      "select left(current_database(), 40) || '_app_lane' as role",
    );
    const name = (rows[0] as { role: string }).role;

    const lane = client.escapeIdentifier(name);

    await client.query("SET scram_iterations = 1");
    await client.query(`drop role if exists ${lane}`);
    await client.query(
      `create role ${lane} login password ${client.escapeLiteral(password)} ` +
        "nosuperuser nobypassrls nocreatedb nocreaterole noreplication " +
        "in role requestport_application",
    );
    return name;
  });
  const url = new URL(ownerUrl());

  url.username = role;
  url.password = password;
  return { role, url: url.toString() };
}

async function dropApplicationRoleLane(role: string) {
  await withOwner(async (client) => {
    await client.query(`drop role if exists ${client.escapeIdentifier(role)}`);
  });
}

const lane = await prepareApplicationRoleLane();

export default defineConfig({
  plugins: [
    {
      name: "requestport-application-role-lane",
      configureVitest({
        vitest,
      }: {
        vitest: { onClose(close: () => Promise<void>): void };
      }) {
        vitest.onClose(() => dropApplicationRoleLane(lane.role));
      },
    },
  ],
  test: {
    name: "application role",
    include: [...APPLICATION_ROLE_LANE_FILES],
    passWithNoTests: false,
    setupFiles: [
      "./src/test-support/declare-test-surface.ts",
      "./src/test-support/one-query-at-a-time.ts",
    ],
    env: { REQUESTPORT_APPLICATION_DATABASE_URL: lane.url },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
