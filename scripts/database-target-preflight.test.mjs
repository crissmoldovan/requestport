import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { databaseProjectVariables } from "./hosted-deployment.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/database-target-preflight.mjs",
);
const successMessage = "RequestPort database target verified.\n";
const failureMessage = "RequestPort database target verification failed.\n";
const databasePassword = "database-password-must-not-leak";
const projectId = "non-production-project-id";
const databaseHost = "ep-requestport-preview.example.test";
const databaseName = "requestport_preview";
const databaseUrl = `postgresql://requestport:${databasePassword}@${databaseHost}/${databaseName}?sslmode=require`;
const hostHash = createHash("sha256").update(databaseHost).digest("hex");
const databaseNameHash = createHash("sha256")
  .update(databaseName)
  .digest("hex");

/**
 * The database project's variables, where this tree's hosted deployment names
 * them (`hosted-deployment.mjs`); `null` in the public tree, whose preflight
 * compares no project.
 */
const project = databaseProjectVariables;
const NO_PROJECT = project === null && "this tree names no database project";

/** `values` ({ expected, production, preview }) under this tree's project variables; nothing where it names none. */
function projectEnvironment(values) {
  if (project === null) return {};
  return Object.fromEntries(
    Object.entries(values).map(([which, value]) => [project[which], value]),
  );
}

function runScript(path, overrides = {}) {
  return spawnSync(process.execPath, [path], {
    cwd: dirname(dirname(path)),
    encoding: "utf8",
    env: {
      DATABASE_URL: databaseUrl,
      EXPECTED_DATABASE_HOST_SHA256: hostHash,
      EXPECTED_DATABASE_NAME_SHA256: databaseNameHash,
      ...projectEnvironment({ expected: projectId, production: projectId }),
      PATH: process.env.PATH,
      ...overrides,
    },
  });
}

function run(overrides = {}) {
  return runScript(scriptPath, overrides);
}

function assertFixedFailure(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, failureMessage);
  assert.doesNotMatch(result.stderr, /database-password-must-not-leak/u);
  assert.doesNotMatch(result.stderr, /non-production-project-id/u);
  assert.doesNotMatch(result.stderr, /ep-requestport-preview/u);
}

test("accepts an explicitly matched database project and database host", () => {
  const result = run();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, successMessage);
  assert.equal(result.stderr, "");
});

test("fails closed when the database URL is absent", () => {
  assertFixedFailure(run({ DATABASE_URL: "" }));
});

test("fails closed when the database project does not match", {
  skip: NO_PROJECT,
}, () => {
  assertFixedFailure(
    run(projectEnvironment({ production: "production-project-id" })),
  );
});

test("fails closed when the database host does not match", () => {
  assertFixedFailure(
    run({
      DATABASE_URL:
        "postgresql://requestport:other-secret@ep-production.example.test/requestport",
    }),
  );
});

test("fails closed when the database name does not match", () => {
  assertFixedFailure(
    run({
      DATABASE_URL: `postgresql://requestport:${databasePassword}@${databaseHost}/production`,
    }),
  );
});

test("fails closed for a non-Postgres database URL", () => {
  assertFixedFailure(
    run({
      DATABASE_URL: "https://database-password-must-not-leak@example.com",
    }),
  );
});

test("fails closed when an expected identity is absent or malformed", () => {
  if (project !== null) {
    assertFixedFailure(run(projectEnvironment({ expected: "" })));
  }
  assertFixedFailure(run({ EXPECTED_DATABASE_HOST_SHA256: "not-a-sha256" }));
  assertFixedFailure(run({ EXPECTED_DATABASE_NAME_SHA256: "" }));
});

test("requires Preview-prefixed identity instead of accepting an unprefixed fallback", () => {
  assertFixedFailure(
    run({
      VERCEL_ENV: "preview",
      REQUESTPORT_PREVIEW_DATABASE_URL: "",
      ...projectEnvironment({ preview: "" }),
    }),
  );
});

test("verifies the Preview-prefixed identity even when Production values are present", () => {
  const result = run({
    VERCEL_ENV: "preview",
    DATABASE_URL:
      "postgresql://requestport:production-password-must-not-leak@ep-production.example.test/requestport",
    ...projectEnvironment({
      production: "production-project-id",
      preview: projectId,
    }),
    REQUESTPORT_PREVIEW_DATABASE_URL: databaseUrl,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, successMessage);
  assert.equal(result.stderr, "");
});

test("under the public variant, which names no database project, verifies the host and database name alone", (t) => {
  // The public seed carries hosted-deployment.public.mjs at the module's
  // path (release/public-tree.json). A checkout holding the preflight beside
  // that text runs it as the seed would.
  const root = mkdtempSync(join(tmpdir(), "requestport-target-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  copyFileSync(scriptPath, join(root, "scripts/database-target-preflight.mjs"));
  copyFileSync(
    resolve(repositoryRoot, "scripts/hosted-deployment.public.mjs"),
    join(root, "scripts/hosted-deployment.mjs"),
  );
  assert.match(
    readFileSync(join(root, "scripts/hosted-deployment.mjs"), "utf8"),
    /^export const databaseProjectVariables = null;$/mu,
  );
  const copy = join(root, "scripts/database-target-preflight.mjs");
  const unnamed = Object.fromEntries(
    Object.keys(projectEnvironment({ expected: "", production: "" })).map(
      (name) => [name, undefined],
    ),
  );

  const accepted = runScript(copy, unnamed);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, successMessage);
  assert.equal(accepted.stderr, "");

  assertFixedFailure(
    runScript(copy, {
      ...unnamed,
      DATABASE_URL:
        "postgresql://requestport:other-secret@ep-production.example.test/requestport",
    }),
  );
  assertFixedFailure(
    runScript(copy, {
      ...unnamed,
      DATABASE_URL: `postgresql://requestport:${databasePassword}@${databaseHost}/production`,
    }),
  );
  assertFixedFailure(
    runScript(copy, {
      ...unnamed,
      VERCEL_ENV: "preview",
      REQUESTPORT_PREVIEW_DATABASE_URL: "",
    }),
  );
});
