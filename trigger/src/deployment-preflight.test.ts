import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { databaseProjectVariables } from "../../scripts/hosted-deployment.mjs";
import {
  buildDeploymentPreflightReport,
  deploymentPreflight,
  deploymentPreflightContract,
  deploymentPreflightRefusals,
  resolveWorkerDatabaseUrl,
} from "./deployment-preflight.js";

const password = "staging-database-password-must-not-leak";
const host = "ep-requestport-staging.example.test";
const databaseName = "requestport_staging";
const origin = "https://staging.requestport.com";
const databaseUrl = `postgresql://requestport:${password}@${host}/${databaseName}?sslmode=require`;
const projectRef = "proj_requestportstagingref";
const taskVersion = "20260828.1";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const staging = {
  applicationOrigin: origin,
  databaseUrl,
  deploymentVersion: taskVersion,
  environmentType: "STAGING",
  projectRef,
};

describe("deployment preflight report", () => {
  test("returns exactly the fixed identity fields and the three hashes", () => {
    expect(buildDeploymentPreflightReport(staging)).toEqual({
      applicationOriginSha256: sha256(origin),
      contract: 1,
      databaseHostSha256: sha256(host),
      databaseNameSha256: sha256(databaseName),
      environment: "STAGING",
      projectRef,
      taskVersion,
    });
  });

  test("locks the contract version the verifier pins", () => {
    expect(deploymentPreflightContract).toBe(1);
    expect(buildDeploymentPreflightReport(staging).contract).toBe(
      deploymentPreflightContract,
    );
  });

  // The whole point of the two hashes is that the migration gate and the worker
  // are proving the *same* database. Rather than restate that script's rule
  // here — a second copy that can drift — hand the report's digests to the
  // gate itself as its expectations and require it to accept them. A database
  // name only percent-decoding reveals is included because that decoding step
  // is the part a reimplementation would most plausibly omit.
  test.each([
    ["a plain name", "requestport_staging"],
    ["a percent-encoded name", "request%20port"],
    ["a mixed-case host", "requestport_staging"],
  ])(
    "agrees with the migration gate's own target reduction for %s",
    async (label, encodedName) => {
      const targetHost = label.includes("mixed-case")
        ? "EP-RequestPort-Staging.example.test"
        : host;
      const target = `postgresql://requestport:${password}@${targetHost}/${encodedName}?sslmode=require`;
      const report = buildDeploymentPreflightReport({
        ...staging,
        databaseUrl: target,
      });
      const gate = spawnSync(
        process.execPath,
        [
          resolve(
            import.meta.dirname,
            "../../scripts/database-target-preflight.mjs",
          ),
        ],
        {
          encoding: "utf8",
          env: {
            DATABASE_URL: target,
            EXPECTED_DATABASE_HOST_SHA256: report.databaseHostSha256,
            EXPECTED_DATABASE_NAME_SHA256: report.databaseNameSha256,
            // The database project, where the hosted deployment names its
            // variables; the public tree names none, and its gate compares
            // the host and the name alone.
            ...(databaseProjectVariables === null
              ? {}
              : {
                  [databaseProjectVariables.expected]:
                    "non-production-project-id",
                  [databaseProjectVariables.production]:
                    "non-production-project-id",
                }),
            PATH: process.env.PATH ?? "",
          },
        },
      );

      expect(gate.stderr).toBe("");
      expect(gate.status).toBe(0);
    },
  );

  test("hashes the origin rather than the whole application URL", () => {
    expect(
      buildDeploymentPreflightReport({
        ...staging,
        applicationOrigin: `${origin}/sign-in?redirect=%2Fdashboard`,
      }).applicationOriginSha256,
    ).toBe(sha256(origin));
  });

  test("never carries a URL, a credential, or free-form text", () => {
    const serialized = JSON.stringify(buildDeploymentPreflightReport(staging));

    for (const secret of [password, host, databaseName, origin, "://"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys(JSON.parse(serialized)).toSorted()).toEqual([
      "applicationOriginSha256",
      "contract",
      "databaseHostSha256",
      "databaseNameSha256",
      "environment",
      "projectRef",
      "taskVersion",
    ]);
  });
});

describe("deployment preflight refusals", () => {
  test.each([
    ["environment_unrecognized", { environmentType: "STAGING_2" }],
    ["environment_unrecognized", { environmentType: undefined }],
    ["project_unrecognized", { projectRef: "requestport" }],
    ["project_unrecognized", { projectRef: undefined }],
    ["task_version_unrecognized", { deploymentVersion: undefined }],
    ["task_version_unrecognized", { deploymentVersion: "latest" }],
    ["database_target_unresolved", { databaseUrl: undefined }],
    ["database_target_unresolved", { databaseUrl: `https://${host}/x` }],
    ["database_target_unresolved", { databaseUrl: `postgresql://${host}/` }],
    ["application_origin_unresolved", { applicationOrigin: undefined }],
    ["application_origin_unresolved", { applicationOrigin: "staging" }],
  ])("refuses with %s", (code, override) => {
    expect(() =>
      buildDeploymentPreflightReport({ ...staging, ...override }),
    ).toThrow(code);
    expect(deploymentPreflightRefusals).toContain(code);
  });

  /**
   * Every refusal site, not the three an earlier version happened to reach.
   *
   * The contract this guards is in `deployment-preflight.ts`: a refusal is one
   * of these words and nothing else, because a failed run's error is stored and
   * displayed by a third party and a connection string is a credential. That is
   * a property of eleven throw sites, and only three were driven — so putting
   * the rejected value into any of the other eight, three of which hold a
   * database URL, would have shipped with this suite green.
   *
   * Each case below names the site it reaches, so a reader can tell that the
   * list is the whole set rather than a sample.
   */
  test.each([
    // hashDatabaseTarget — the three that can hold a credential.
    [
      "database url that will not parse",
      {
        databaseUrl: `postgresql://requestport:${password}@${host}:not-a-port/db`,
      },
    ],
    [
      "database url of the wrong protocol",
      { databaseUrl: `mysql://requestport:${password}@${host}/db` },
    ],
    [
      "database url with no database name",
      { databaseUrl: `postgresql://requestport:${password}@${host}/` },
    ],
    [
      "database url whose name will not decode",
      { databaseUrl: `postgresql://requestport:${password}@${host}/%zz` },
    ],
    [
      "database url with a nested path",
      { databaseUrl: `postgresql://requestport:${password}@${host}/one/two` },
    ],
    ["absent database url", { databaseUrl: undefined }],
    // hashApplicationOrigin.
    [
      "origin that will not parse",
      { applicationOrigin: `not-a-url-${origin}` },
    ],
    ["origin of the wrong protocol", { applicationOrigin: `ftp://${origin}` }],
    ["absent origin", { applicationOrigin: "" }],
    // The remaining two.
    ["unrecognized environment", { environmentType: `dev-${origin}` }],
    ["unrecognized project ref", { projectRef: `proj_${password}!` }],
    ["unrecognized task version", { deploymentVersion: `v-${password}` }],
  ])("says only the refusal word for a %s", (_site, override) => {
    let raised: unknown;
    try {
      buildDeploymentPreflightReport({ ...staging, ...override });
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(Error);
    const message = (raised as Error).message;
    // An exact match against the list, so a message that merely *starts* with
    // a refusal word and then appends the value it rejected fails here.
    expect(deploymentPreflightRefusals).toContain(message);
    for (const secret of [password, origin, host, "://", "%", "@"]) {
      expect(message).not.toContain(secret);
    }
  });
});

describe("deployment preflight task", () => {
  test("is registered under the id the staging verifier looks for", () => {
    expect(deploymentPreflight).toMatchObject({ id: "deployment-preflight" });
  });
});

/*
 * The worker's own variables (Plan 13, I.2b steps b2 and b5; manifest-i2.md
 * §5.2): the storages connect through them and through nothing else, so the
 * report must be about theirs, and with none of them set there is nothing of
 * the worker's to report (ruling 214 items 1 and 3).
 */
describe("the database the preflight reports, with the worker's variables", () => {
  const owner = `postgresql://owner:${password}@${host}/${databaseName}`;
  const as = (login: string, name = databaseName, onHost = host) =>
    `postgresql://${login}:${password}@${onHost}/${name}?sslmode=require`;
  const worker = {
    REQUESTPORT_DISPATCHER_DATABASE_URL: as("rp_dispatcher"),
    REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL: as("rp_processor"),
    REQUESTPORT_MAINTENANCE_DATABASE_URL: as("rp_maintenance"),
  };
  /** The names that could carry the owner's connection. */
  const ownerCapable = (name: string) =>
    name === "DATABASE_URL" ||
    /^PG[A-Z0-9_]*$/u.test(name) ||
    name.startsWith("POSTGRES_");
  /**
   * `values` behind a proxy that records each name read or tested, and `*`
   * for each listing of every name, as the survey's probe recorded the
   * worker's reads (track-i2.md, "I.2b b5, the survey", §(c)).
   */
  const recording = (values: Record<string, string>) => {
    const read: string[] = [];
    const env = new Proxy(values, {
      get(target, key) {
        if (typeof key === "string") read.push(key);
        return Reflect.get(target, key);
      },
      has(target, key) {
        if (typeof key === "string") read.push(key);
        return Reflect.has(target, key);
      },
      ownKeys(target) {
        read.push("*");
        return Reflect.ownKeys(target);
      },
    }) as NodeJS.ProcessEnv;
    return { env, read };
  };

  test("unset, it resolves nothing, beside a DATABASE_URL, PG* and POSTGRES_* too, and reads none of them, so the task refuses without naming a value", () => {
    const { env, read } = recording({
      DATABASE_URL: owner,
      POSTGRES_URL: owner,
      PGHOST: host,
      PGUSER: "owner",
    });
    const resolved = resolveWorkerDatabaseUrl(env);

    expect(resolved).toBeUndefined();
    expect(read.filter(ownerCapable)).toEqual([]);
    expect(new Set(read)).toEqual(new Set(Object.keys(worker)));
    expect(() =>
      buildDeploymentPreflightReport({ ...staging, databaseUrl: resolved }),
    ).toThrowError(/^database_target_unresolved$/u);
  });

  /*
   * The Trigger.dev worker's shape once I.2b's b6 has removed `DATABASE_URL`,
   * `PG*` and `POSTGRES_*` from `prod`: the three, beside the names the
   * task's report reads from elsewhere.
   */
  test("set, with DATABASE_URL, PG* and POSTGRES_* absent, it reads only the three and reports the processor's database", () => {
    const { env, read } = recording({
      ...worker,
      BETTER_AUTH_URL: origin,
      TRIGGER_PROJECT_REF: projectRef,
    });
    const resolved = resolveWorkerDatabaseUrl(env);

    expect(resolved).toBe(worker.REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL);
    expect(new Set(read)).toEqual(new Set(Object.keys(worker)));
    expect(
      buildDeploymentPreflightReport({ ...staging, databaseUrl: resolved }),
    ).toMatchObject({
      databaseHostSha256: sha256(host),
      databaseNameSha256: sha256(databaseName),
    });
  });

  test("set, it is the processor's, even beside a DATABASE_URL naming another database, which it does not read", () => {
    const { env, read } = recording({
      DATABASE_URL: as("owner", "some_other_database"),
      ...worker,
    });
    const resolved = resolveWorkerDatabaseUrl(env);

    expect(read.filter(ownerCapable)).toEqual([]);
    expect(resolved).toBe(worker.REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL);
    expect(
      buildDeploymentPreflightReport({ ...staging, databaseUrl: resolved }),
    ).toMatchObject({
      databaseHostSha256: sha256(host),
      databaseNameSha256: sha256(databaseName),
    });
  });

  test.each([
    [
      "a partial set",
      {
        REQUESTPORT_DISPATCHER_DATABASE_URL:
          worker.REQUESTPORT_DISPATCHER_DATABASE_URL,
      },
    ],
    [
      "three naming two databases",
      {
        ...worker,
        REQUESTPORT_MAINTENANCE_DATABASE_URL: as("rp_maintenance", "elsewhere"),
      },
    ],
    [
      "three naming two hosts",
      {
        ...worker,
        REQUESTPORT_DISPATCHER_DATABASE_URL: as(
          "rp_dispatcher",
          databaseName,
          "ep-other.example.test",
        ),
      },
    ],
  ])(
    "%s resolves nothing, so the task refuses without naming a value",
    (_label, env) => {
      const resolved = resolveWorkerDatabaseUrl({
        DATABASE_URL: owner,
        ...env,
      });

      expect(resolved).toBeUndefined();
      expect(() =>
        buildDeploymentPreflightReport({ ...staging, databaseUrl: resolved }),
      ).toThrowError(/^database_target_unresolved$/u);
    },
  );
});
