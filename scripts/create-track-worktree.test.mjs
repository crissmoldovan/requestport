import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  applicationLoginName,
  assertLocalDatabaseUrl,
  assertTrackWorktree,
  childEnvironment,
  createTrackWorktree,
  DEFAULT_BASE,
  ensureDatabase,
  keptEnvWarning,
  localStackRunning,
  mainRepositoryRoot,
  parseArguments,
  Refusal,
  renderTrackEnv,
  STACK_NOT_RUNNING,
  TRACK_ENV_KEYS,
  trackLayout,
  validateTrackName,
  writeTrackEnv,
} from "./create-track-worktree.mjs";
import {
  databaseProjectVariables,
  providerVariablePrefixes,
} from "./hosted-deployment.mjs";
import { refuseUnapprovedProductionDatabase } from "./production-database-guard.mjs";
import { loadRootEnv } from "./with-root-env.mjs";

/*
 * `readDatabaseUrl` comes from packages/db's TypeScript source, which Node runs
 * here with its types stripped. That source names its sibling modules as
 * TypeScript resolves them, `./shared-databases.js` for `shared-databases.ts`,
 * and Node's stripping does not map one to the other. So in this file's
 * process a relative `.js` specifier that names no file, imported from a `.ts`
 * module, resolves to the `.ts` beside it; every other specifier resolves as
 * Node resolves it. The import comes after the hook, so it is a dynamic one: a
 * static import would be linked before the hook exists.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === "ERR_MODULE_NOT_FOUND" &&
        specifier.startsWith(".") &&
        specifier.endsWith(".js") &&
        context.parentURL?.endsWith(".ts")
      ) {
        return nextResolve(specifier.replace(/\.js$/u, ".ts"), context);
      }
      throw error;
    }
  },
});
const { readDatabaseUrl } = await import("../packages/db/src/database-url.ts");

const ROOT = "/repo";
const SECRET = "s".repeat(43);
// Not a real password: hex, as generated ones are, and recognisable.
const APPLICATION_PASSWORD = "a1".repeat(24);

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

/**
 * A fake of everything outside this process. It records each call and answers
 * as a running local stack would, unless told otherwise; nothing real runs.
 */
function fakeWorld({
  stack = "true\n",
  stackStatus = 0,
  databaseFound = "",
  worktreeExists = false,
  envExists = false,
  worktreeCommon = `${ROOT}/.git`,
  worktreeBranch = "track/t0-gate",
  failOn,
} = {}) {
  const calls = [];
  const writes = [];
  const chmods = [];
  const spawn = (command, args, options = {}) => {
    calls.push({ command, args, options });
    // A statement handed on standard input is part of what a step runs.
    const line = [command, ...args, options.input ?? ""].join(" ");
    if (failOn && line.includes(failOn)) return { status: 1, stdout: "" };
    const inWorktree = command === "git" && args[1]?.includes("/track-");
    if (inWorktree && args.includes("--git-common-dir")) {
      return { status: 0, stdout: `${worktreeCommon}\n` };
    }
    if (inWorktree && args.includes("--abbrev-ref")) {
      return { status: 0, stdout: `${worktreeBranch}\n` };
    }
    if (command === "git" && args.includes("--git-common-dir")) {
      return { status: 0, stdout: `${ROOT}/.git\n` };
    }
    if (command === "docker" && args[0] === "inspect") {
      return { status: stackStatus, stdout: stack };
    }
    if (command === "docker" && line.includes("from pg_database")) {
      return { status: 0, stdout: databaseFound };
    }
    return { status: 0, stdout: "" };
  };
  const fs = {
    writeFileSync(path, contents, options) {
      if (envExists) {
        const error = new Error("exists");
        error.code = "EEXIST";
        throw error;
      }
      writes.push({ path, contents, options });
    },
    chmodSync(path, mode) {
      chmods.push({ path, mode });
    },
  };
  return {
    calls,
    writes,
    chmods,
    spawn,
    fs,
    exists: () => worktreeExists,
    commands: () => calls.map((c) => [c.command, ...c.args].join(" ")),
  };
}

function create(
  world,
  argv = ["t0-gate"],
  env = { PATH: "/usr/bin" },
  warnings = [],
) {
  return createTrackWorktree({
    argv,
    scriptRoot: "/repo/.worktrees/elsewhere",
    env,
    spawn: world.spawn,
    exists: world.exists,
    fs: world.fs,
    secret: () => SECRET,
    applicationPassword: () => APPLICATION_PASSWORD,
    log: () => undefined,
    warn: (message) => warnings.push(message),
  });
}

describe("track names", () => {
  test("accepts lower-case letters, digits and hyphens, up to 41 characters", () => {
    for (const name of ["a", "t0-gate", "0", "e2", `a${"-".repeat(40)}`]) {
      assert.equal(validateTrackName(name), name);
    }
  });

  test("refuses anything else before it can reach a path, a branch or SQL", () => {
    for (const name of [
      "",
      "-leading",
      "Upper",
      "has_underscore",
      "has space",
      "../escape",
      "a/b",
      "x;drop",
      `a${"b".repeat(41)}`,
      "é",
      undefined,
    ]) {
      assert.throws(() => validateTrackName(name), Refusal, String(name));
    }
  });

  test("derives the worktree, branch, database and URL from the name", () => {
    assert.deepEqual(trackLayout(ROOT, "t0-gate"), {
      name: "t0-gate",
      worktree: "/repo/.worktrees/track-t0-gate",
      branch: "track/t0-gate",
      database: "rp_track_t0_gate",
      databaseUrl:
        "postgres://requestport:requestport_local@127.0.0.1:55432/rp_track_t0_gate",
    });
  });
});

describe("arguments", () => {
  test("defaults the base to origin/main", () => {
    assert.equal(DEFAULT_BASE, "origin/main");
    assert.deepEqual(parseArguments(["a1"]), {
      name: "a1",
      base: "origin/main",
    });
  });

  test("takes --base on either side of the name", () => {
    assert.deepEqual(parseArguments(["a1", "--base", "main"]), {
      name: "a1",
      base: "main",
    });
    assert.deepEqual(parseArguments(["--base", "c14e252", "a1"]), {
      name: "a1",
      base: "c14e252",
    });
  });

  test("refuses a missing name, a second name, a bare --base and unknown flags", () => {
    for (const argv of [
      [],
      ["a", "b"],
      ["a", "--base"],
      ["a", "--base", "--force"],
      ["a", "--force"],
    ]) {
      assert.throws(() => parseArguments(argv), Refusal, argv.join(" "));
    }
  });
});

describe("the database it will touch", () => {
  test("accepts only a track database on 127.0.0.1:55432", () => {
    assert.ok(
      assertLocalDatabaseUrl(
        "postgres://requestport:requestport_local@127.0.0.1:55432/rp_track_x",
      ),
    );
  });

  test("refuses every other server, port, database or shape", () => {
    for (const url of [
      "postgres://u:p@db-production-pooler.region-1.example.test/appdb",
      "postgres://u:p@127.0.0.1.evil.example:55432/rp_track_x",
      "postgres://u:p@localhost:55432/rp_track_x",
      "postgres://u:p@127.0.0.1:5432/rp_track_x",
      "postgres://u:p@127.0.0.1/rp_track_x",
      "postgres://u:p@127.0.0.1:55432/requestport_local",
      "postgres://u:p@127.0.0.1:55432/appdb",
      "mysql://u:p@127.0.0.1:55432/rp_track_x",
      "not a url",
      "",
    ]) {
      assert.throws(() => assertLocalDatabaseUrl(url), Refusal, url);
    }
  });

  test("never builds a database statement from a name that is not a track's", () => {
    const world = fakeWorld();
    assert.throws(
      () => ensureDatabase('rp_track_x"; drop database prod; --', world.spawn),
      Refusal,
    );
    assert.deepEqual(world.calls, []);
  });

  test("names the track's application login so that no other login scheme on the server can produce it", () => {
    // Review of I.2 step 5: the acceptance server's login
    // (start-e2e-server.mjs) and the application-role lane's
    // (vitest.application-role.config.ts) are each the first 40 characters
    // of a database's name and a suffix. With `_app`, track `foo-e2e`'s
    // login was track `foo`'s acceptance login, and each script dropped and
    // recreated the other's.
    const sourceOf = (path) =>
      readFileSync(new URL(path, import.meta.url), "utf8");
    const suffixesOf = (text) =>
      [
        ...text.matchAll(
          /left\(current_database\(\), 40\) \|\| '(_[a-z0-9_]+)'/gu,
        ),
      ].map((match) => match[1]);
    const others = [
      ...suffixesOf(sourceOf("./start-e2e-server.mjs")),
      ...suffixesOf(
        sourceOf("../packages/db/vitest.application-role.config.ts"),
      ),
    ];
    assert.deepEqual(others, ["_e2e_app", "_app_lane"]);

    const names = [
      "foo",
      "foo-e2e",
      "foo-app",
      "foo-app-lane",
      "foo-dev",
      "e2e",
      "a".repeat(41),
      `${"a".repeat(31)}-e2e`,
    ];
    for (const own of names) {
      const login = applicationLoginName(trackLayout("/r", own).database);
      assert.ok(login.length <= 63, `${login} fits PostgreSQL's 63 bytes`);
      for (const other of names) {
        for (const suffix of others) {
          assert.notEqual(
            login,
            `${trackLayout("/r", other).database.slice(0, 40)}${suffix}`,
            `track ${own}'s login against track ${other}'s ${suffix}`,
          );
        }
      }
    }
  });

  test("creates the database only when the server does not have it", () => {
    const absent = fakeWorld({ databaseFound: "" });
    assert.equal(ensureDatabase("rp_track_x", absent.spawn), "created");
    assert.ok(
      absent.commands().some((c) => c.endsWith('create database "rp_track_x"')),
    );

    const present = fakeWorld({ databaseFound: "1\n" });
    assert.equal(ensureDatabase("rp_track_x", present.spawn), "exists");
    assert.ok(!present.commands().some((c) => c.includes("create database")));
  });
});

describe("the generated .env.local", () => {
  const layout = trackLayout(ROOT, "t0-gate");
  const text = renderTrackEnv({
    name: "t0-gate",
    databaseUrl: layout.databaseUrl,
    secret: SECRET,
    applicationPassword: APPLICATION_PASSWORD,
  });
  const values = parseEnv(text);

  test("holds exactly the expected keys", () => {
    assert.deepEqual(Object.keys(values).sort(), [...TRACK_ENV_KEYS].sort());
    assert.deepEqual(TRACK_ENV_KEYS.toSorted(), [
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "DATABASE_URL",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "LOG_LEVEL",
      "NEXT_PUBLIC_APP_URL",
      "NODE_ENV",
      "REQUESTPORT_APPLICATION_DATABASE_URL",
      "REQUESTPORT_DATABASE_DRIVER",
      "REQUESTPORT_LOCAL_DATABASE_URL",
      "RESEND_API_KEY",
      "RESEND_FROM_EMAIL",
    ]);
  });

  test("gives the application the track's own login, on the track database, and the owner's URL to everything else", () => {
    // Plan 13, I.2 step 5 (ruling 221 item 2): `pnpm dev`'s application
    // connects as a login in requestport_application, made after the
    // migration (the whole run, below), and the migration, the operator CLI
    // and every storage a suite builds with storageOptionsFromEnv keep
    // DATABASE_URL, the owner.
    const application = new URL(values.REQUESTPORT_APPLICATION_DATABASE_URL);

    assert.equal(
      values.REQUESTPORT_APPLICATION_DATABASE_URL,
      `postgres://rp_track_t0_gate_dev_app:${APPLICATION_PASSWORD}@127.0.0.1:55432/rp_track_t0_gate`,
    );
    assert.doesNotThrow(() =>
      assertLocalDatabaseUrl(values.REQUESTPORT_APPLICATION_DATABASE_URL),
    );
    assert.equal(application.pathname, new URL(layout.databaseUrl).pathname);
    assert.notEqual(application.username, new URL(layout.databaseUrl).username);
  });

  test("refuses an application password that is not the hex it generates", () => {
    for (const applicationPassword of [
      undefined,
      "",
      "short1",
      "a1".repeat(24).toUpperCase(),
      `${"a1".repeat(24)}' superuser --`,
    ]) {
      assert.throws(
        () =>
          renderTrackEnv({
            name: "t0-gate",
            databaseUrl: layout.databaseUrl,
            secret: SECRET,
            applicationPassword,
          }),
        Refusal,
        String(applicationPassword),
      );
    }
  });

  test("names only the track database, and only on loopback", () => {
    assert.equal(values.DATABASE_URL, layout.databaseUrl);
    assert.equal(values.REQUESTPORT_LOCAL_DATABASE_URL, layout.databaseUrl);
    assert.equal(values.NODE_ENV, "development");
    assert.equal(values.NEXT_PUBLIC_APP_URL, "http://localhost:3000");
    assert.equal(values.BETTER_AUTH_URL, "http://localhost:3000");
    assert.equal(values.BETTER_AUTH_SECRET, SECRET);
  });

  test("selects the pg driver, as the gate does", () => {
    // The gate sets this itself; a targeted run outside it — `pnpm --filter
    // @requestport/db test` or `pnpm dev` in the track — reads it only from
    // this file. Unset, packages/db selects its default driver, which in the
    // private tree is the hosted one, and that cannot reach a plain
    // PostgreSQL without the proxy the stack no longer runs.
    assert.equal(values.REQUESTPORT_DATABASE_DRIVER, "pg");
  });

  test("carries nothing that could name a real database, deployment or provider", () => {
    for (const key of Object.keys(values)) {
      for (const prefix of [
        "PG",
        "POSTGRES_",
        "VERCEL_",
        ...providerVariablePrefixes,
      ]) {
        assert.ok(!key.startsWith(prefix), key);
      }
    }
    assert.doesNotMatch(text, /vercel|supabase|amazonaws/iu);
    // Every URL the file holds names this machine, so none names a database
    // service's host.
    const urls = text.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/giu) ?? [];
    assert.ok(urls.length > 0, text);
    for (const url of urls) {
      assert.match(new URL(url).hostname, /^(?:127\.0\.0\.1|localhost)$/u, url);
    }
    assert.match(values.GITHUB_CLIENT_ID, /not-a-real/u);
    assert.match(values.GITHUB_CLIENT_SECRET, /not-a-real/u);
    assert.match(values.RESEND_API_KEY, /not_a_real/u);
    assert.match(values.RESEND_FROM_EMAIL, /@example\.invalid$/u);
    // GitHub OAuth client ids are 20 hex characters or `Iv1.`/`Ov2…` forms;
    // Resend keys are `re_` plus a long random tail. None of these is.
    assert.doesNotMatch(values.GITHUB_CLIENT_ID, /^(Iv1\.|Ov2|[0-9a-f]{20}$)/u);
    assert.doesNotMatch(values.RESEND_API_KEY, /^re_[A-Za-z0-9]{20,}$/u);
  });

  test("refuses to render a non-local database or a short secret", () => {
    assert.throws(
      () =>
        renderTrackEnv({
          name: "x",
          databaseUrl: "postgres://u:p@db.example.com:5432/appdb",
          secret: SECRET,
        }),
      Refusal,
    );
    assert.throws(
      () =>
        renderTrackEnv({
          name: "x",
          databaseUrl: layout.databaseUrl,
          secret: "short",
        }),
      Refusal,
    );
  });

  test("is written with mode 0600 and only when absent", () => {
    const world = fakeWorld();
    assert.equal(writeTrackEnv("/wt/.env.local", "A=1\n", world.fs), "written");
    assert.equal(world.writes[0].options.flag, "wx");
    assert.equal(world.writes[0].options.mode, 0o600);
    assert.deepEqual(world.chmods, [{ path: "/wt/.env.local", mode: 0o600 }]);
  });

  test("leaves an existing file exactly as it was", () => {
    const world = fakeWorld({ envExists: true });
    assert.equal(writeTrackEnv("/wt/.env.local", "A=1\n", world.fs), "kept");
    assert.deepEqual(world.writes, []);
    assert.deepEqual(world.chmods, []);
  });
});

describe("the environment its children run in", () => {
  test("drops every variable that could point somewhere real, and names the track database", () => {
    const url = trackLayout(ROOT, "x").databaseUrl;
    const env = childEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home/x",
        PGHOST: "prod.example",
        PGPASSWORD: "p",
        POSTGRES_URL: "postgres://prod",
        // The database service's own, where the hosted deployment names it.
        ...Object.fromEntries(
          providerVariablePrefixes.map((prefix) => [
            `${prefix}PROJECT_ID`,
            "n",
          ]),
        ),
        VERCEL_ENV: "production",
        DATABASE_URL: "postgres://prod",
        DATABASE_URL_UNPOOLED: "postgres://prod",
        REQUESTPORT_LOCAL_DATABASE_URL: "postgres://elsewhere",
        REQUESTPORT_PREVIEW_DATABASE_URL: "postgres://preview",
        ...(databaseProjectVariables === null
          ? {}
          : { [databaseProjectVariables.preview]: "p" }),
      },
      url,
    );

    assert.deepEqual(env, {
      PATH: "/usr/bin",
      HOME: "/home/x",
      DATABASE_URL: url,
      REQUESTPORT_LOCAL_DATABASE_URL: url,
      REQUESTPORT_PREVIEW_DATABASE_URL: url,
    });
  });

  test("a kept .env.local cannot move the migration off the track database", () => {
    // The migration child runs through with-root-env.mjs, which fills unset
    // variables from the worktree's .env.local, and drizzle.config.ts asks
    // readDatabaseUrl — which reads the preview URL when VERCEL_ENV is preview.
    // Here is a kept file that tries both routes to a non-local database.
    const url = trackLayout(ROOT, "x").databaseUrl;
    const elsewhere = "postgres://u:p@db-unrelated.region-1.example.test/appdb";
    const directory = mkdtempSync(join(tmpdir(), "track-kept-env-"));
    try {
      writeFileSync(
        join(directory, ".env.local"),
        [
          "VERCEL_ENV=preview",
          `REQUESTPORT_PREVIEW_DATABASE_URL=${elsewhere}`,
          `DATABASE_URL=${elsewhere}`,
          `REQUESTPORT_LOCAL_DATABASE_URL=${elsewhere}`,
          "",
        ].join("\n"),
      );
      const env = loadRootEnv({
        env: childEnvironment(
          { PATH: "/usr/bin", VERCEL_ENV: "production" },
          url,
        ),
        rootDirectory: directory,
      });

      assert.equal(env.VERCEL_ENV, "preview", "the file did fill VERCEL_ENV");
      assert.doesNotThrow(() => refuseUnapprovedProductionDatabase(env));
      assert.equal(readDatabaseUrl(env), url);
      assert.equal(readDatabaseUrl({ ...env, VERCEL_ENV: undefined }), url);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the local stack", () => {
  test("is running only when the database container says so", () => {
    const world = fakeWorld();
    assert.equal(localStackRunning(world.spawn), true);
    assert.deepEqual(world.commands(), [
      "docker inspect --format {{.State.Running}} requestport-local-db",
    ]);
    assert.equal(
      localStackRunning(fakeWorld({ stack: "false\n" }).spawn),
      false,
    );
    assert.equal(
      localStackRunning(fakeWorld({ stack: "", stackStatus: 1 }).spawn),
      false,
    );
  });
});

describe("a whole run, with nothing real behind it", () => {
  test("finds the main checkout from inside another worktree", () => {
    assert.equal(
      mainRepositoryRoot("/repo/.worktrees/x", fakeWorld().spawn),
      ROOT,
    );
  });

  test("creates the worktree, the database and the file, then installs and migrates", () => {
    const world = fakeWorld();
    const result = create(world);
    const commands = world.commands();

    assert.equal(result.worktree, "/repo/.worktrees/track-t0-gate");
    assert.equal(result.worktreeState, "created");
    assert.equal(result.databaseState, "created");
    assert.equal(result.envFile, "written");
    assert.ok(
      commands.includes(
        "git -C /repo worktree add /repo/.worktrees/track-t0-gate -b track/t0-gate origin/main",
      ),
    );
    assert.ok(
      commands.some((c) => c.endsWith('create database "rp_track_t0_gate"')),
    );
    assert.equal(
      world.writes[0].path,
      "/repo/.worktrees/track-t0-gate/.env.local",
    );

    const migrate = world.calls.find(
      (c) => c.command === "pnpm" && c.args.includes("db:migrate"),
    );
    assert.deepEqual(migrate.args, [
      "--filter",
      "@requestport/db",
      "db:migrate",
    ]);
    assert.equal(migrate.options.cwd, "/repo/.worktrees/track-t0-gate");
    assert.equal(
      migrate.options.env.DATABASE_URL,
      "postgres://requestport:requestport_local@127.0.0.1:55432/rp_track_t0_gate",
    );

    // install before migrate, and after it only the application login
    const install = commands.indexOf("pnpm install --frozen-lockfile");
    const migrated = commands.indexOf(
      "pnpm --filter @requestport/db db:migrate",
    );
    assert.ok(install >= 0 && install < migrated);
    assert.equal(commands.length, migrated + 2);
  });

  test("after migrating, makes the application login the file names: a member of requestport_application alone, its password sent on standard input", () => {
    const world = fakeWorld();
    const result = create(world);
    const migrated = world.calls.findIndex(
      (c) => c.command === "pnpm" && c.args.includes("db:migrate"),
    );
    const login = world.calls[migrated + 1];
    const values = parseEnv(world.writes[0].contents);

    assert.equal(result.applicationLogin, "rp_track_t0_gate_dev_app");
    assert.equal(
      values.REQUESTPORT_APPLICATION_DATABASE_URL,
      `postgres://rp_track_t0_gate_dev_app:${APPLICATION_PASSWORD}@127.0.0.1:55432/rp_track_t0_gate`,
    );
    // The group exists once the migration has run (0019), so the login is
    // made after it, through the stack's own psql, in one transaction.
    assert.deepEqual(login.args, [
      "exec",
      "-i",
      "requestport-local-db",
      "psql",
      "-X",
      "-At",
      "-U",
      "requestport",
      "-d",
      "requestport_local",
      "-v",
      "ON_ERROR_STOP=1",
      "-1",
      "-f",
      "-",
    ]);
    assert.equal(
      login.options.input,
      [
        "SET scram_iterations = 1;",
        'DROP ROLE IF EXISTS "rp_track_t0_gate_dev_app";',
        `CREATE ROLE "rp_track_t0_gate_dev_app" LOGIN PASSWORD '${APPLICATION_PASSWORD}' ` +
          "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION " +
          "IN ROLE requestport_application;",
        "",
      ].join("\n"),
    );
    // The password is in no command line, where `ps` would show it.
    for (const call of world.calls) {
      assert.ok(
        !call.args.some((arg) => arg.includes(APPLICATION_PASSWORD)),
        [call.command, ...call.args].join(" "),
      );
    }
  });

  test("uses the base it was given", () => {
    const world = fakeWorld();
    create(world, ["a1", "--base", "main"]);
    assert.ok(
      world
        .commands()
        .includes(
          "git -C /repo worktree add /repo/.worktrees/track-a1 -b track/a1 main",
        ),
    );
  });

  test("reuses its own worktree, never overwrites an .env.local, and says it kept one", () => {
    const world = fakeWorld({
      worktreeExists: true,
      envExists: true,
      databaseFound: "1",
    });
    const warnings = [];
    const result = create(world, undefined, undefined, warnings);

    assert.equal(result.worktreeState, "exists");
    assert.equal(result.envFile, "kept");
    assert.deepEqual(world.writes, []);
    assert.ok(!world.commands().some((c) => c.includes("worktree add")));
    assert.ok(!world.commands().some((c) => c.includes("create database")));
    // A login whose password no file holds would be no use, and replacing
    // one would break a kept file that names it: no login is made or touched.
    assert.equal(result.applicationLogin, undefined);
    assert.ok(!world.calls.some((c) => /ROLE/u.test(c.options.input ?? "")));
    assert.deepEqual(warnings, [
      keptEnvWarning(
        "/repo/.worktrees/track-t0-gate/.env.local",
        "rp_track_t0_gate",
      ),
    ]);
    assert.match(warnings[0], /^WARNING: .*kept without being read/u);
    assert.match(
      warnings[0],
      /no application login was made.*REQUESTPORT_APPLICATION_DATABASE_URL/su,
    );
  });

  test("says nothing about an .env.local it wrote itself", () => {
    const warnings = [];
    create(fakeWorld(), undefined, undefined, warnings);
    assert.deepEqual(warnings, []);
  });

  test("refuses an existing path that is not this repository's track worktree", () => {
    for (const [what, options] of [
      ["another repository", { worktreeCommon: "/elsewhere/.git" }],
      ["another branch", { worktreeBranch: "main" }],
      ["a detached head", { worktreeBranch: "HEAD" }],
      ["not a checkout", { worktreeCommon: "", worktreeBranch: "" }],
    ]) {
      const world = fakeWorld({ worktreeExists: true, ...options });
      assert.throws(
        () => create(world),
        /exists but is not this repository's worktree on track\/t0-gate/u,
        what,
      );
      assert.deepEqual(world.writes, [], what);
      assert.ok(
        !world.commands().some((c) => /fetch|worktree add|psql|pnpm/u.test(c)),
        what,
      );
    }
  });

  test("asks git about the path itself, not about the main checkout", () => {
    const world = fakeWorld();
    const layout = trackLayout(ROOT, "t0-gate");
    assertTrackWorktree(ROOT, layout, world.spawn);
    assert.deepEqual(
      world.calls.map((c) => c.args.slice(0, 2)),
      [
        ["-C", "/repo/.worktrees/track-t0-gate"],
        ["-C", "/repo/.worktrees/track-t0-gate"],
      ],
    );
  });

  test("refuses a bad name before running anything", () => {
    const world = fakeWorld();
    assert.throws(() => create(world, ["Bad_Name"]), Refusal);
    assert.deepEqual(world.calls, []);
  });

  test("refuses when the local stack is not running, having created nothing", () => {
    for (const stack of [{ stack: "", stackStatus: 1 }, { stack: "false\n" }]) {
      const world = fakeWorld(stack);
      assert.throws(
        () => create(world),
        (error) => error.message === STACK_NOT_RUNNING,
      );
      assert.deepEqual(
        world
          .commands()
          .filter(
            (c) => !c.includes("rev-parse") && !c.startsWith("docker inspect"),
          ),
        [],
      );
      assert.deepEqual(world.writes, []);
    }
  });

  test("stops at the first failing step and says which", () => {
    for (const [failOn, what] of [
      ["fetch", /git fetch/u],
      ["worktree add", /git worktree add/u],
      ["from pg_database", /Could not ask/u],
      ["create database", /Could not create/u],
      ["install", /pnpm install/u],
      ["db:migrate", /migration/u],
      [
        "CREATE ROLE",
        /Could not make the application login rp_track_t0_gate_dev_app/u,
      ],
    ]) {
      const world = fakeWorld({ failOn });
      assert.throws(
        () => create(world),
        (error) =>
          what.test(error.message) &&
          !error.message.includes(APPLICATION_PASSWORD),
        failOn,
      );
    }
  });
});

test("has no way to read a file: nothing that reads is imported", () => {
  // The main checkout's .env.local names production. The script writes the
  // new worktree's file and must never read one, so it imports nothing that
  // could — and no dynamic import could bring it in.
  const source = readFileSync(
    new URL("./create-track-worktree.mjs", import.meta.url),
    "utf8",
  );
  const imported = [
    ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:fs/gu),
  ]
    .flatMap((match) => match[1].split(","))
    .map((name) => name.trim())
    .filter(Boolean);

  assert.deepEqual(imported.sort(), [
    "chmodSync",
    "existsSync",
    "writeFileSync",
  ]);
  assert.doesNotMatch(
    source,
    /\bimport\(|require\(|readFile|createReadStream/u,
  );
});
