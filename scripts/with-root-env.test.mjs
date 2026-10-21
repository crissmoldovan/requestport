import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRootEnv } from "./with-root-env.mjs";

test("loads missing values from the optional root .env.local without replacing injected values", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "requestport-env-"));

  try {
    await writeFile(
      join(rootDirectory, ".env.local"),
      "NEXT_PUBLIC_APP_URL=http://localhost:3000\nLOG_LEVEL=debug\n",
    );

    const env = { LOG_LEVEL: "warn" };
    loadRootEnv({ env, rootDirectory });

    assert.equal(env.NEXT_PUBLIC_APP_URL, "http://localhost:3000");
    assert.equal(env.LOG_LEVEL, "warn");
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("accepts a missing root .env.local", () => {
  const env = {};

  loadRootEnv({ env, rootDirectory: tmpdir() });

  assert.deepEqual(env, {});
});

/**
 * A spawn that does not depend on whose machine it runs on.
 *
 * These two cases are about Corepack pinning and argv redaction, and both
 * spawn the real launcher in the real checkout — so they read the real
 * `.env.local`, and their result depended on what a developer happened to have
 * pointed `DATABASE_URL` at. That went unnoticed while the guard pinned only
 * production; the moment staging was guarded too, both failed on a machine
 * whose environment file named it.
 *
 * An empty `DATABASE_URL` is defined, so the launcher will not fill it from
 * `.env.local`, and the guard returns early on it. Neither case is about a
 * database, and now neither asks about one.
 */
function hermeticEnvironment() {
  return { ...process.env, DATABASE_URL: "" };
}

test("runs child pnpm commands through the pinned Corepack version", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/with-root-env.mjs", "pnpm", "--version"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: hermeticEnvironment(),
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "11.22.0");
});

test("redacts child spawn failures without reflecting argv", () => {
  const commandSentinel = "missing-command-secret-sentinel";
  const emailSentinel = "owner+secret-sentinel@example.invalid";
  const valueSentinel = "child-argv-secret-sentinel";
  const result = spawnSync(
    process.execPath,
    [
      "scripts/with-root-env.mjs",
      commandSentinel,
      "--email",
      emailSentinel,
      "--value",
      valueSentinel,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: hermeticEnvironment(),
    },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "RequestPort child command failed to start.\n");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-sentinel/u);
});

/*
 * `--without-owner-variables` (Plan 13, I.2 step 7; ruling 224 item 3): what
 * `pnpm dev` runs, so that the web application it starts carries no
 * owner-capable name, and, since ruling 225 item 3, what
 * `pnpm --filter @requestport/jobs worker` runs, so that `requestport-jobs`
 * starts. Migrations and the suites keep `DATABASE_URL`.
 */

const OWNER_CAPABLE = /^(DATABASE_URL(_.*)?|PG[A-Z0-9_]*|POSTGRES_.*)$/u;
const PRINT_OWNER_CAPABLE = `process.stdout.write(JSON.stringify(Object.keys(process.env).filter((n) => ${OWNER_CAPABLE}.test(n)).sort()))`;

function ownerNamedEnvironment(secret) {
  return {
    ...hermeticEnvironment(),
    DATABASE_URL: `postgresql://requestport:${secret}@127.0.0.1:55432/rp_x`,
    DATABASE_URL_UNPOOLED: `postgresql://requestport:${secret}@127.0.0.1:55432/rp_x`,
    PGHOST: "127.0.0.1",
    POSTGRES_URL: `postgresql://requestport:${secret}@127.0.0.1:55432/rp_x`,
  };
}

test("--without-owner-variables hands the command no owner-capable name, saying one line for each on standard error, never its value", () => {
  const secret = "with-root-env-owner-secret-sentinel";
  const result = spawnSync(
    process.execPath,
    [
      "scripts/with-root-env.mjs",
      "--without-owner-variables",
      process.execPath,
      "-e",
      PRINT_OWNER_CAPABLE,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: ownerNamedEnvironment(secret),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "[]");
  for (const name of [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "PGHOST",
    "POSTGRES_URL",
  ]) {
    assert.match(
      result.stderr,
      new RegExp(
        `^with-root-env: removed ${name} from this command's environment \\(--without-owner-variables\\): the process it starts connects through a login of its own, and is refused beside a variable that can reach the database as its owner\\.$`,
        "mu",
      ),
    );
  }
  // The flag serves the worker as well as the web (ruling 225 item 3), so
  // its line names neither.
  assert.doesNotMatch(result.stderr, /web application|worker/u);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    new RegExp(secret, "u"),
  );
});

test("without the flag, the command keeps every name it was given", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/with-root-env.mjs", process.execPath, "-e", PRINT_OWNER_CAPABLE],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: ownerNamedEnvironment("kept"),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  for (const name of [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "PGHOST",
    "POSTGRES_URL",
  ]) {
    assert.ok(JSON.parse(result.stdout).includes(name), name);
  }
});

test("pnpm dev runs with --without-owner-variables, and no other root script does", async () => {
  const { readFile } = await import("node:fs/promises");
  const { scripts } = JSON.parse(await readFile("package.json", "utf8"));

  assert.match(
    scripts.dev,
    /^node scripts\/with-root-env\.mjs --without-owner-variables /u,
  );
  for (const [name, command] of Object.entries(scripts)) {
    if (name === "dev") continue;
    assert.doesNotMatch(command, /--without-owner-variables/u, name);
  }
});

test("pnpm --filter @requestport/jobs worker runs requestport-jobs with --without-owner-variables, so .env.local's DATABASE_URL does not stop it", async () => {
  const { readFile } = await import("node:fs/promises");
  const { scripts } = JSON.parse(
    await readFile("packages/jobs/package.json", "utf8"),
  );

  assert.equal(
    scripts.worker,
    "node ../../scripts/with-root-env.mjs --without-owner-variables node bin/requestport-jobs.mjs",
  );
});
