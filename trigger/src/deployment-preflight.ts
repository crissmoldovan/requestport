import "./database-surface.js";

import { createHash } from "node:crypto";

import { WORKER_DATABASE_URL_VARIABLES } from "@requestport/db";
import { task } from "@trigger.dev/sdk";

/**
 * The shape of this task's answer, frozen.
 *
 * Staging acceptance promotes a worker and then migrates a database on the
 * strength of what this task says, so its answer is a claim about identity
 * rather than a diagnostic. It therefore carries a contract number the verifier
 * pins: a later worker that changes what any field means changes this number
 * too, and the verifier refuses the old reading instead of silently accepting a
 * differently-shaped one.
 */
export const deploymentPreflightContract = 1;

/**
 * Every way this task can decline to answer.
 *
 * A refusal is one of these words and nothing else. The value that caused it —
 * a database URL, an application URL, a project ref — never reaches the message,
 * because a failed run's error is stored and displayed by a third party and a
 * connection string is a credential.
 */
export const deploymentPreflightRefusals = [
  "application_origin_unresolved",
  "database_target_unresolved",
  "environment_unrecognized",
  "project_unrecognized",
  "task_version_unrecognized",
] as const;

export type DeploymentPreflightRefusal =
  (typeof deploymentPreflightRefusals)[number];

const environments = [
  "DEVELOPMENT",
  "PREVIEW",
  "PRODUCTION",
  "STAGING",
] as const;

export type DeploymentPreflightEnvironment = (typeof environments)[number];

export type DeploymentPreflightReport = {
  applicationOriginSha256: string;
  contract: typeof deploymentPreflightContract;
  databaseHostSha256: string;
  databaseNameSha256: string;
  environment: DeploymentPreflightEnvironment;
  projectRef: string;
  taskVersion: string;
};

export type DeploymentPreflightSource = {
  applicationOrigin: string | undefined;
  databaseUrl: string | undefined;
  deploymentVersion: string | undefined;
  environmentType: string | undefined;
  projectRef: string | undefined;
};

/** Trigger.dev project refs: the `proj_` prefix plus a lowercase opaque id. */
const PROJECT_REF = /^proj_[a-z0-9]{8,64}$/u;
/** Trigger.dev deployment versions, as the CLI prints them: `20250208.1`. */
const TASK_VERSION = /^[0-9]{8}\.[0-9]{1,4}$/u;

function refuse(code: DeploymentPreflightRefusal): never {
  throw new Error(code);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The database this worker would actually open a connection to, reduced to two
 * hashes.
 *
 * `scripts/database-target-preflight.mjs` hashes the URL's `hostname` and its
 * percent-decoded database name, and the migration gate compares those two
 * digests with the checked-in expectations. The worker has to reduce its own
 * target exactly the same way or the two gates would be proving two different
 * databases while reporting the same words.
 */
function hashDatabaseTarget(databaseUrl: string | undefined) {
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    refuse("database_target_unresolved");
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return refuse("database_target_unresolved");
  }

  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    !url.pathname.startsWith("/")
  ) {
    refuse("database_target_unresolved");
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return refuse("database_target_unresolved");
  }

  if (databaseName.length === 0 || databaseName.includes("/")) {
    refuse("database_target_unresolved");
  }

  return {
    databaseHostSha256: sha256(url.hostname),
    databaseNameSha256: sha256(databaseName),
  };
}

function hashApplicationOrigin(applicationOrigin: string | undefined) {
  if (typeof applicationOrigin !== "string" || applicationOrigin.length === 0) {
    refuse("application_origin_unresolved");
  }

  let url: URL;
  try {
    url = new URL(applicationOrigin);
  } catch {
    return refuse("application_origin_unresolved");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.origin === "null"
  ) {
    refuse("application_origin_unresolved");
  }

  // The origin, not the URL it was read out of: a path or a query string would
  // be free-form text, and the only question worth answering is which site this
  // worker believes it serves.
  return sha256(url.origin);
}

export function buildDeploymentPreflightReport(
  source: DeploymentPreflightSource,
): DeploymentPreflightReport {
  const environment = environments.find(
    (candidate) => candidate === source.environmentType,
  );
  if (!environment) refuse("environment_unrecognized");
  if (
    typeof source.projectRef !== "string" ||
    !PROJECT_REF.test(source.projectRef)
  ) {
    refuse("project_unrecognized");
  }
  if (
    typeof source.deploymentVersion !== "string" ||
    !TASK_VERSION.test(source.deploymentVersion)
  ) {
    refuse("task_version_unrecognized");
  }

  const database = hashDatabaseTarget(source.databaseUrl);
  const applicationOriginSha256 = hashApplicationOrigin(
    source.applicationOrigin,
  );

  return {
    applicationOriginSha256,
    contract: deploymentPreflightContract,
    databaseHostSha256: database.databaseHostSha256,
    databaseNameSha256: database.databaseNameSha256,
    environment,
    projectRef: source.projectRef,
    taskVersion: source.deploymentVersion,
  };
}

/** A URL's host and database name, compared the way the report hashes them. */
function databaseTargetOf(value: string) {
  try {
    const url = new URL(value);
    return `${url.hostname}\u0000${decodeURIComponent(url.pathname.slice(1))}`;
  } catch {
    return undefined;
  }
}

/**
 * The database this worker's storages connect to (manifest-i2.md §5.2 b2).
 *
 * The storages connect through the worker's three variables and through
 * nothing else (Plan 13, I.2b's b5; ruling 214 items 1 and 3), so the report
 * is theirs: the tenant processor's URL, provided all three name the same
 * host and database. It reads only those three: none set, a partial set, or
 * three that disagree resolve nothing, and the task refuses with
 * `database_target_unresolved`. With none set it used to report
 * `DATABASE_URL`'s database, the owner's, on which the worker ran unbound;
 * since b5 the worker refuses to run that way, so there is nothing of the
 * worker's to report.
 */
export function resolveWorkerDatabaseUrl(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const set = Object.values(WORKER_DATABASE_URL_VARIABLES)
    .map((name) => env[name])
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim() !== "",
    );

  if (set.length !== Object.keys(WORKER_DATABASE_URL_VARIABLES).length) {
    return undefined;
  }
  const targets = new Set(set.map(databaseTargetOf));
  if (targets.size !== 1 || targets.has(undefined)) return undefined;
  return env[WORKER_DATABASE_URL_VARIABLES.processor];
}

/**
 * The deployed worker's own account of what it is bound to.
 *
 * A `dev` session has no deployment, so `ctx.deployment` is absent and the task
 * refuses: an undeployed worker cannot attest a version, and a promotion gate
 * that accepted "no version" would accept anything.
 */
export const deploymentPreflight = task({
  id: "deployment-preflight",
  run: async (_payload: unknown, { ctx }) =>
    buildDeploymentPreflightReport({
      applicationOrigin: process.env.BETTER_AUTH_URL,
      databaseUrl: resolveWorkerDatabaseUrl(process.env),
      deploymentVersion: ctx.deployment?.version,
      environmentType: ctx.environment.type,
      projectRef: ctx.project.ref,
    }),
});
