import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = resolve(
  repositoryRoot,
  "scripts/install-vercel-dependencies.mjs",
);
const successOutput = "RequestPort Vercel dependency install completed.\n";
const failureOutput = "RequestPort Vercel dependency install failed.\n";
const packageReadToken = "fixture-package-read-token-must-not-leak";
const childSentinel = "fixture-child-detail-must-not-leak";
const temporaryDirectories = [];

function createTemporaryDirectory() {
  const directory = mkdtempSync(resolve(tmpdir(), "requestport-install-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Stub `pnpm` on PATH. The stub records how it was invoked so the test can
 * prove the launcher resolved the repository root from its own checked-in
 * location, ran the frozen install, and handed the child an ephemeral
 * user-level registry config instead of the raw token.
 */
function createStubbedPnpm({
  exitCode = 0,
  stderr = childSentinel,
  stdout = childSentinel,
} = {}) {
  const directory = createTemporaryDirectory();
  const recordPath = resolve(directory, "invocation.json");
  const binDirectory = resolve(directory, "bin");
  const stubPath = resolve(binDirectory, "pnpm");

  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env node",
      'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
      "const userconfig = process.env.NPM_CONFIG_USERCONFIG || null;",
      "writeFileSync(",
      `  ${JSON.stringify(recordPath)},`,
      "  JSON.stringify({",
      "    argv: process.argv.slice(2),",
      "    cwd: process.cwd(),",
      "    userconfig,",
      "    userconfigExists: userconfig === null ? false : existsSync(userconfig),",
      "    userconfigContents:",
      "      userconfig !== null && existsSync(userconfig)",
      '        ? readFileSync(userconfig, "utf8")',
      "        : null,",
      "    sawToken: Object.values(process.env).some((value) =>",
      `      String(value).includes(${JSON.stringify(packageReadToken)}),`,
      "    ),",
      "  }),",
      ");",
      `console.log(${JSON.stringify(stdout)});`,
      `console.error(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join("\n"),
  );
  chmodSync(stubPath, 0o755);

  return {
    binDirectory,
    readRecord() {
      return existsSync(recordPath)
        ? JSON.parse(readFileSync(recordPath, "utf8"))
        : undefined;
    },
  };
}

function runLauncher(env, binDirectory) {
  return spawnSync(process.execPath, [launcherPath], {
    cwd: resolve(repositoryRoot, "apps/web"),
    encoding: "utf8",
    env: {
      PATH: `${binDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: process.env.HOME ?? "/tmp",
      ...env,
    },
  });
}

function countEphemeralAuthDirectories() {
  return readdirSync(tmpdir()).filter((entry) =>
    entry.startsWith("requestport-package-auth-"),
  ).length;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

test("runs the root frozen install with ephemeral Preview registry auth", () => {
  const stub = createStubbedPnpm();
  const before = countEphemeralAuthDirectories();
  const result = runLauncher(
    {
      VERCEL_ENV: "preview",
      REQUESTPORT_PACKAGE_READ_TOKEN: packageReadToken,
    },
    stub.binDirectory,
  );
  const record = stub.readRecord();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, successOutput);
  assert.equal(result.stderr, "");
  assert.deepEqual(record.argv, ["install", "--frozen-lockfile"]);
  assert.equal(record.cwd, repositoryRoot);
  assert.notEqual(record.userconfig, null);
  assert.equal(record.userconfigExists, true);
  assert.match(
    record.userconfigContents,
    /^\/\/npm\.pkg\.github\.com\/:_authToken=fixture-package-read-token-must-not-leak\n$/u,
  );
  assert.equal(record.sawToken, false);
  assert.equal(countEphemeralAuthDirectories(), before);
});

test("never prints the package token or child output", () => {
  const stub = createStubbedPnpm({ exitCode: 1 });
  const result = runLauncher(
    {
      VERCEL_ENV: "preview",
      REQUESTPORT_PACKAGE_READ_TOKEN: packageReadToken,
    },
    stub.binDirectory,
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.startsWith(failureOutput.trim()));
  assert.ok(!result.stderr.includes(packageReadToken));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(packageReadToken));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(childSentinel));
});

test("removes the ephemeral credential after a failed install", () => {
  const stub = createStubbedPnpm({ exitCode: 1 });
  const before = countEphemeralAuthDirectories();
  const result = runLauncher(
    {
      VERCEL_ENV: "preview",
      REQUESTPORT_PACKAGE_READ_TOKEN: packageReadToken,
    },
    stub.binDirectory,
  );
  const record = stub.readRecord();

  assert.equal(result.status, 1);
  assert.equal(countEphemeralAuthDirectories(), before);
  assert.equal(existsSync(record.userconfig), false);
});

test("refuses a Production install without a separately approved token", () => {
  const stub = createStubbedPnpm();
  const result = runLauncher(
    {
      VERCEL_ENV: "production",
      REQUESTPORT_PACKAGE_READ_TOKEN: packageReadToken,
    },
    stub.binDirectory,
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.startsWith(failureOutput.trim()));
  assert.ok(!result.stderr.includes(packageReadToken));
  assert.equal(stub.readRecord(), undefined);
});

/**
 * Production installs, and why a token alone is not the approval.
 *
 * The launcher refused Production outright, with a comment naming the change
 * as "a separately approved release prerequisite". The approval arrived on
 * 2026-09-06, so Production may install — but the shape of the gate is kept
 * rather than removed.
 *
 * A token is a credential, not a decision. Vercel copies variables between
 * environments readily, and this session watched a marketplace integration
 * write one to both environments unasked; a rule that said "install if a token
 * is present" would have been satisfied by that accident. So the opt-in is a
 * second, explicit variable that means nothing except "a person decided this",
 * and the original refusal — a valid token, no opt-in — is asserted unchanged
 * above.
 */
test("installs in Production when a token and the explicit opt-in are both present", () => {
  const stub = createStubbedPnpm();
  const before = countEphemeralAuthDirectories();
  const result = runLauncher(
    {
      REQUESTPORT_PACKAGE_READ_TOKEN: packageReadToken,
      REQUESTPORT_PRODUCTION_PACKAGE_INSTALL: "approved",
      VERCEL_ENV: "production",
    },
    stub.binDirectory,
  );
  const record = stub.readRecord();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, successOutput);
  assert.equal(result.stderr, "");
  assert.deepEqual(record.argv, ["install", "--frozen-lockfile"]);
  assert.equal(record.userconfigExists, true);
  assert.equal(record.sawToken, false);
  assert.equal(countEphemeralAuthDirectories(), before);
});

test("installs Production on the opt-in alone, with no credential", () => {
  const stub = createStubbedPnpm();
  const result = runLauncher(
    {
      REQUESTPORT_PRODUCTION_PACKAGE_INSTALL: "approved",
      VERCEL_ENV: "production",
    },
    stub.binDirectory,
  );
  const record = stub.readRecord();

  // The CUE++ packages are vendored, so no dependency is fetched from a
  // registry and an install needs no credential. What Production still
  // requires is the decision: the opt-in, spelled exactly.
  assert.equal(result.status, 0);
  assert.equal(result.stdout, successOutput);
  assert.deepEqual(record.argv, ["install", "--frozen-lockfile"]);
  assert.equal(record.cwd, repositoryRoot);
  assert.equal(record.userconfig, null);
  assert.equal(record.sawToken, false);
});

test("refuses a Production opt-in that is not the exact approval word", () => {
  for (const value of ["", "true", "1", "yes", "Approved", " approved"]) {
    const stub = createStubbedPnpm();
    const result = runLauncher(
      {
        REQUESTPORT_PACKAGE_READ_TOKEN: packageReadToken,
        REQUESTPORT_PRODUCTION_PACKAGE_INSTALL: value,
        VERCEL_ENV: "production",
      },
      stub.binDirectory,
    );

    assert.equal(result.status, 1, `opt-in value ${JSON.stringify(value)}`);
    assert.equal(stub.readRecord(), undefined);
  }
});

test("installs Preview without a token, writing no registry auth", () => {
  const stub = createStubbedPnpm();
  const result = runLauncher({ VERCEL_ENV: "preview" }, stub.binDirectory);
  const record = stub.readRecord();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, successOutput);
  assert.deepEqual(record.argv, ["install", "--frozen-lockfile"]);
  assert.equal(record.userconfig, null);
  assert.equal(record.sawToken, false);
});

test("refuses any target carrying a malformed credential", () => {
  // A value meant to be a credential and shaped like nothing is a
  // misconfiguration whether or not an install would have spent it. Refusing
  // is what makes it visible; installing anyway would bury it.
  for (const env of [
    { REQUESTPORT_PACKAGE_READ_TOKEN: "short", VERCEL_ENV: "preview" },
    {
      REQUESTPORT_PACKAGE_READ_TOKEN: "short",
      REQUESTPORT_PRODUCTION_PACKAGE_INSTALL: "approved",
      VERCEL_ENV: "production",
    },
  ]) {
    const stub = createStubbedPnpm();
    const result = runLauncher(env, stub.binDirectory);

    assert.equal(result.status, 1, `${env.VERCEL_ENV} with a malformed token`);
    assert.ok(result.stderr.startsWith(failureOutput.trim()));
    assert.ok(!result.stderr.includes(packageReadToken));
    assert.equal(stub.readRecord(), undefined);
  }
});

test("refuses an unknown or absent Vercel target", () => {
  const stub = createStubbedPnpm();

  for (const env of [{}, { VERCEL_ENV: "" }, { VERCEL_ENV: "staging" }]) {
    const result = runLauncher(env, stub.binDirectory);

    assert.equal(result.status, 1);
    assert.ok(result.stderr.startsWith(failureOutput.trim()));
    assert.ok(!result.stderr.includes(packageReadToken));
    assert.equal(stub.readRecord(), undefined);
  }
});

test("uses documented user-level package config for local Development", () => {
  const stub = createStubbedPnpm();
  const result = runLauncher({ VERCEL_ENV: "development" }, stub.binDirectory);
  const record = stub.readRecord();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, successOutput);
  assert.equal(record.userconfig, null);
  assert.equal(record.cwd, repositoryRoot);
});

test("rejects a sensitive package token attached to Development", () => {
  const stub = createStubbedPnpm();
  const result = runLauncher(
    {
      VERCEL_ENV: "development",
      REQUESTPORT_PACKAGE_READ_TOKEN: packageReadToken,
    },
    stub.binDirectory,
  );

  assert.equal(result.status, 1);
  assert.ok(result.stderr.startsWith(failureOutput.trim()));
  assert.ok(!result.stderr.includes(packageReadToken));
  assert.equal(stub.readRecord(), undefined);
});

test("rejects a malformed package-read token before spawning an install", () => {
  const stub = createStubbedPnpm();

  for (const token of ["  ", "short", `${packageReadToken}\n`]) {
    const result = runLauncher(
      { VERCEL_ENV: "preview", REQUESTPORT_PACKAGE_READ_TOKEN: token },
      stub.binDirectory,
    );

    assert.equal(result.status, 1);
    assert.ok(result.stderr.startsWith(failureOutput.trim()));
    assert.ok(!result.stderr.includes(packageReadToken));
    assert.equal(stub.readRecord(), undefined);
  }
});

/**
 * A production build that cannot say why it refused is a production build
 * nobody can fix.
 *
 * On 2026-09-17 the merge of #51 triggered the first production build since the
 * registry switch, and it failed inside this launcher. The only thing it
 * printed was the fixed failure sentence, which is the same sentence for a
 * refusal it decided in a millisecond and for a `pnpm install` that ran for
 * eight seconds and exited non-zero — so the outage could not be told apart
 * from a policy decision, and production sat on the previous commit.
 *
 * The reason is a closed set of constants and an exit code. Neither can carry a
 * credential, which is what lets this be printed when the child's own output
 * still cannot be.
 */
test("says which decision refused an install, without echoing anything", () => {
  const stub = createStubbedPnpm();
  const result = runLauncher(
    {
      VERCEL_ENV: "production",
      REQUESTPORT_PACKAGE_READ_TOKEN: packageReadToken,
    },
    stub.binDirectory,
  );

  assert.equal(result.status, 1);
  assert.ok(result.stderr.startsWith(failureOutput.trim()));
  assert.match(result.stderr, /REQUESTPORT_PRODUCTION_PACKAGE_INSTALL/u);
  assert.equal(stub.readRecord(), undefined);
  assert.ok(!result.stderr.includes(packageReadToken));
  assert.ok(!result.stderr.includes(childSentinel));
});

test("distinguishes an install that ran and failed from one never started", () => {
  const refused = runLauncher(
    { VERCEL_ENV: "production" },
    createStubbedPnpm().binDirectory,
  );
  const ran = runLauncher(
    {
      VERCEL_ENV: "preview",
      REQUESTPORT_PACKAGE_READ_TOKEN: packageReadToken,
    },
    createStubbedPnpm({ exitCode: 1 }).binDirectory,
  );

  assert.equal(refused.status, 1);
  assert.equal(ran.status, 1);
  assert.match(refused.stderr, /refused before any install/u);
  assert.match(ran.stderr, /exited 1/u);
  assert.notEqual(refused.stderr, ran.stderr);
  for (const output of [refused.stderr, ran.stderr]) {
    assert.ok(!output.includes(packageReadToken));
    assert.ok(!output.includes(childSentinel));
  }
});

/**
 * The one thing the child's output may contribute: pnpm's own error code.
 *
 * `ERR_PNPM_OUTDATED_LOCKFILE` and `ERR_PNPM_UNSUPPORTED_ENGINE` are different
 * outages with different fixes, and for three builds on 2026-09-17 they were
 * the same sentence. The code is matched as `ERR_PNPM_` followed by capitals,
 * digits and underscores, and only the matched token is printed — never the
 * line it came from. A credential cannot be that token, and the URL and headers
 * a registry repeats back are discarded with the remainder of every line.
 */
test("prints pnpm's error code and nothing else from the child", () => {
  const stub = createStubbedPnpm({
    exitCode: 1,
    stderr: [
      " ERR_PNPM_FETCH_401  GET https://registry.example.test/@scope/pkg: Unauthorized",
      `authorization: Bearer ${packageReadToken}`,
      `npm-session ${childSentinel}`,
    ].join("\n"),
  });
  const result = runLauncher({ VERCEL_ENV: "preview" }, stub.binDirectory);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_PNPM_FETCH_401/u);
  assert.ok(!result.stderr.includes(packageReadToken));
  assert.ok(!result.stderr.includes(childSentinel));
  assert.ok(!result.stderr.includes("registry.example.test"));
  assert.ok(!result.stderr.includes("Bearer"));
});

test("says so plainly when the child named no error code", () => {
  const stub = createStubbedPnpm({ exitCode: 1, stderr: childSentinel });
  const result = runLauncher({ VERCEL_ENV: "preview" }, stub.binDirectory);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /named no error code/u);
  assert.ok(!result.stderr.includes(childSentinel));
});

/**
 * pnpm prints its error block on stdout, not stderr.
 *
 * The first version of this scanned stderr only, and the very next Vercel build
 * reported "pnpm named no error code" against an install that had certainly
 * named one — `[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL]` had come back on stdout
 * from this same binary an hour earlier. Both streams are read now.
 */
test("finds pnpm's error code on stdout, where pnpm actually writes it", () => {
  const stub = createStubbedPnpm({
    exitCode: 1,
    stdout: `[ERR_PNPM_UNSUPPORTED_ENGINE] Unsupported environment ${childSentinel}`,
    stderr: `authorization: Bearer ${packageReadToken}`,
  });
  const result = runLauncher({ VERCEL_ENV: "preview" }, stub.binDirectory);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_PNPM_UNSUPPORTED_ENGINE/u);
  assert.ok(!result.stderr.includes(packageReadToken));
  assert.ok(!result.stderr.includes(childSentinel));
  assert.ok(!result.stderr.includes("Bearer"));
  assert.equal(result.stdout, "");
});
