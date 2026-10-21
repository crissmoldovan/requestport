import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

import {
  ARTEFACT_PATHS,
  artefactPlan,
  CLEAN_PATHS,
  DATABASE_NOT_IN_THE_STACK,
  DATABASE_NOT_LOCAL,
  DATABASE_NOT_NAMED,
  DATABASE_QUERY_NOT_ALLOWED,
  LOCAL_DATABASE_QUERY_PARAMETERS,
  localDatabaseTarget,
  planClean,
  REPORT_PATH,
  RESET_STATEMENT,
  removeArtefacts,
  repositoryRoot,
  resetDatabase,
  STACK_DOWN,
  stopStack,
} from "./clean-locally.mjs";

const LOCAL =
  "postgresql://requestport:requestport_local@127.0.0.1:55432/requestport_local";

describe("choosing what to remove", () => {
  test("names artefacts by absolute path under the repository root", () => {
    const plan = artefactPlan("/repo", () => true);

    assert.ok(plan.length > 0);
    for (const path of plan) {
      assert.ok(
        path.startsWith("/repo/"),
        `${path} is not inside the repository`,
      );
    }
    assert.ok(plan.some((p) => p.endsWith("apps/web/.next")));
    assert.ok(plan.some((p) => p.endsWith("apps/web/test-results")));
    assert.ok(plan.some((p) => p.endsWith("packages/db/coverage")));
  });

  test("skips what is not there, so a clean tree is not a pile of errors", () => {
    const present = new Set(["/repo/apps/web/.next"]);

    assert.deepEqual(
      artefactPlan("/repo", (path) => present.has(path)),
      ["/repo/apps/web/.next"],
    );
  });

  test("removes each path exactly once, recursively, and never throws on absence", () => {
    const removed = [];

    removeArtefacts(["/repo/a", "/repo/b"], (path, options) => {
      removed.push([path, options]);
    });

    assert.deepEqual(
      removed.map(([path]) => path),
      ["/repo/a", "/repo/b"],
    );
    for (const [, options] of removed) {
      assert.equal(options.recursive, true);
      assert.equal(options.force, true);
    }
  });
});

describe("refusing to reset anything but the local database", () => {
  test("accepts a loopback target", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const url = `postgresql://requestport:pw@${host}:55432/requestport_local`;
      assert.equal(
        localDatabaseTarget({ REQUESTPORT_LOCAL_DATABASE_URL: url }),
        url,
        `${host} should be accepted`,
      );
    }
  });

  test("refuses every target that is not loopback", () => {
    // The reset drops two schemas. Nothing about `psql` asks who it is talking
    // to, and the repository's production guard runs in exactly one place —
    // `with-root-env` — which a shell command typed by a person never reaches.
    // This is the whole safety of the reset, so it is a whitelist of loopback
    // rather than a blacklist of the hosts we happen to know about.
    for (const url of [
      "postgresql://x:y@ep-anything.eu-central-1.aws.example.test/appdb",
      "postgresql://x:y@db.internal:5432/requestport",
      "postgresql://x:y@10.0.0.4:5432/requestport",
      "postgresql://x:y@127.0.0.1.evil.example/requestport",
    ]) {
      assert.throws(
        () => localDatabaseTarget({ REQUESTPORT_LOCAL_DATABASE_URL: url }),
        (error) => error.message === DATABASE_NOT_LOCAL,
        `${url} must be refused`,
      );
    }
  });

  test("refuses a loopback string whose query names somewhere else", () => {
    // pg-connection-string copies every query parameter into the config pg
    // dials, and a `host`, `port`, `user` or `password` there replaces the
    // one the string names before it. So `127.0.0.1` in the authority says
    // nothing about where pg goes while the query may still speak. Measured
    // 2026-09-28: `…@127.0.0.1:55432/<database>?host=elsewhere.example.invalid`
    // passed this check, and pg would have dialled elsewhere.example.invalid.
    for (const query of [
      "host=elsewhere.example.invalid",
      "sslmode=disable&host=elsewhere.example.invalid",
      "hostaddr=10.0.0.4",
      "port=5433",
      "user=someone",
      "password=another",
      "options=-c%20search_path%3Delsewhere",
      // pg ignores a key it does not know by name, but nothing here is going
      // to keep a list of which spellings pg reads.
      "HOST=elsewhere.example.invalid",
    ]) {
      const url = `postgresql://requestport:pw@127.0.0.1:55432/appdb?${query}`;
      assert.throws(
        () => localDatabaseTarget({ REQUESTPORT_LOCAL_DATABASE_URL: url }),
        (error) => error.message === DATABASE_QUERY_NOT_ALLOWED,
        `${query} must be refused`,
      );
    }
  });

  test("says which parameters it does accept", () => {
    assert.match(DATABASE_QUERY_NOT_ALLOWED, /sslmode/u);
    assert.match(DATABASE_QUERY_NOT_ALLOWED, /application_name/u);
  });

  test("accepts the query parameters that cannot move the connection", () => {
    assert.deepEqual([...LOCAL_DATABASE_QUERY_PARAMETERS].sort(), [
      "application_name",
      "sslmode",
    ]);
    const url = `${LOCAL}?sslmode=disable&application_name=gate`;
    assert.equal(
      localDatabaseTarget({ REQUESTPORT_LOCAL_DATABASE_URL: url }),
      url,
    );
  });

  test("refuses an unnamed target rather than guessing one", () => {
    for (const env of [{}, { REQUESTPORT_LOCAL_DATABASE_URL: "  " }]) {
      assert.throws(() => localDatabaseTarget(env));
    }
  });

  test("never reads DATABASE_URL, which is what a pulled checkout poisons", () => {
    assert.throws(() =>
      localDatabaseTarget({
        DATABASE_URL: "postgresql://x:y@ep-staging.example.test/appdb",
      }),
    );
  });
});

test("the reset drops drizzle, requestport_private and public, because public alone leaves the journal", () => {
  // Dropping only `public` leaves drizzle's journal in the `drizzle` schema
  // still claiming every migration is applied, so the migrate that follows
  // reports success, applies nothing, and every suite afterwards fails on a
  // missing relation. That cost a full run on 2026-09-17.
  assert.match(RESET_STATEMENT, /drop schema if exists drizzle cascade/iu);
  assert.match(RESET_STATEMENT, /drop schema if exists public cascade/iu);
  // 0019's own schema (Plan 13, Track I.2, D4): its definer functions would
  // otherwise outlive the reset.
  assert.match(
    RESET_STATEMENT,
    /drop schema if exists requestport_private cascade/iu,
  );
  // Cluster-wide roles are shared with every other database on the server.
  assert.doesNotMatch(RESET_STATEMENT, /drop role/iu);
  assert.match(RESET_STATEMENT, /create schema public/iu);
});

describe("what a run is asked to clean", () => {
  test("cleans artefacts by default and leaves the database and stack alone", () => {
    const plan = planClean([], { REQUESTPORT_LOCAL_DATABASE_URL: LOCAL });

    assert.equal(plan.artefacts, true);
    assert.equal(plan.database, false);
    assert.equal(plan.stack, false);
  });

  test("takes the database and the stack only when asked", () => {
    const all = planClean(["--database", "--stack"], {
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL,
    });

    assert.equal(all.database, true);
    assert.equal(all.stack, true);
  });

  test("resolves the database target while planning, so it refuses before it removes", () => {
    assert.throws(() =>
      planClean(["--database"], {
        REQUESTPORT_LOCAL_DATABASE_URL:
          "postgresql://x:y@ep-staging.example.test/appdb",
      }),
    );
  });
});

describe("resetting the database the URL names, and no other (Plan 13, X20)", () => {
  const TRACK =
    "postgresql://requestport:requestport_local@127.0.0.1:55432/rp_track_x";

  const recording = (calls) => (command, argv, options) => {
    calls.push({ command, argv, options });
    return { status: 0 };
  };

  test("drops the schemas of the database the migrate that follows applies to", () => {
    // Until X20 the drop named `requestport_local` whatever the URL said, and
    // the migrate named the URL. From a track worktree the reset emptied the
    // main checkout's database, migrated the track's own (untouched, so it
    // applied nothing), and printed "Local database reset and migrated from
    // empty."
    const calls = [];
    const plan = planClean(["--database"], {
      REQUESTPORT_LOCAL_DATABASE_URL: TRACK,
    });

    assert.equal(resetDatabase(plan, recording(calls)), true);
    assert.equal(calls.length, 2);
    const [drop, migrate] = calls;
    assert.equal(drop.command, "docker");
    assert.ok(drop.argv.includes("requestport-local-db"));
    assert.equal(drop.argv[drop.argv.indexOf("-d") + 1], "rp_track_x");
    assert.equal(drop.argv.includes("requestport_local"), false);
    assert.ok(drop.argv.includes(RESET_STATEMENT));
    assert.equal(migrate.command, "pnpm");
    assert.equal(migrate.options.env.DATABASE_URL, TRACK);
  });

  test("reads the name as pg does, percent-encoding and all", () => {
    const calls = [];
    const plan = planClean(["--database"], {
      REQUESTPORT_LOCAL_DATABASE_URL:
        "postgresql://requestport:requestport_local@127.0.0.1:55432/rp%5Ftrack%5Fx",
    });

    resetDatabase(plan, recording(calls));
    assert.equal(calls[0].argv[calls[0].argv.indexOf("-d") + 1], "rp_track_x");
  });

  test("does not migrate a database whose drop failed", () => {
    const calls = [];
    const plan = planClean(["--database"], {
      REQUESTPORT_LOCAL_DATABASE_URL: TRACK,
    });

    assert.equal(
      resetDatabase(plan, (command, argv, options) => {
        calls.push({ command, argv, options });
        return { status: 1 };
      }),
      false,
    );
    assert.equal(calls.length, 1);
  });

  test("refuses a URL on another port, which names another server", () => {
    // `docker exec requestport-local-db` reaches the server in that container,
    // which compose.yaml publishes on 55432. Resetting the database of
    // the same name in the container, for a URL that names some other server,
    // would be X20 again by another route.
    for (const url of [
      "postgresql://requestport:pw@127.0.0.1:5432/rp_track_x",
      "postgresql://requestport:pw@localhost/rp_track_x",
    ]) {
      assert.throws(
        () =>
          planClean(["--database"], { REQUESTPORT_LOCAL_DATABASE_URL: url }),
        (error) => error.message === DATABASE_NOT_IN_THE_STACK,
        `${url} must be refused`,
      );
    }
  });

  test("refuses a URL that names no database, rather than choosing one", () => {
    for (const url of [
      "postgresql://requestport:pw@127.0.0.1:55432",
      "postgresql://requestport:pw@127.0.0.1:55432/",
    ]) {
      assert.throws(
        () =>
          planClean(["--database"], { REQUESTPORT_LOCAL_DATABASE_URL: url }),
        (error) => error.message === DATABASE_NOT_NAMED,
        `${url} must be refused`,
      );
    }
  });

  test("checks none of that when the database was not asked for", () => {
    const plan = planClean([], {
      REQUESTPORT_LOCAL_DATABASE_URL:
        "postgresql://requestport:pw@127.0.0.1:5432/",
    });

    assert.equal(plan.database, false);
  });
});

describe("putting the stack away (--stack, ruling 175, owner question 2d)", () => {
  // Pinned as data, never run: the stack is every worktree's database, so no
  // test here starts or stops it.
  const PINNED_DOWN = [
    "compose",
    "--project-name",
    "requestport-local",
    "--file",
    "compose.yaml",
    "down",
  ];

  test("runs `docker compose down` in the repository root on compose.yaml's own project and file, named on the command line, and never with --volumes, which would delete the database's named volume", () => {
    assert.deepEqual(
      { ...STACK_DOWN, args: [...STACK_DOWN.args] },
      { command: "docker", args: PINNED_DOWN, cwd: repositoryRoot },
    );
    for (const flag of ["--volumes", "-v"]) {
      assert.equal(STACK_DOWN.args.includes(flag), false, flag);
    }
    const file = STACK_DOWN.args[STACK_DOWN.args.indexOf("--file") + 1];
    assert.ok(
      existsSync(resolve(STACK_DOWN.cwd, file)),
      "the file the command names is not in the directory it runs in",
    );
    // The project the command names is the one compose.yaml declares, so a
    // `docker compose up -d` run beside the file and this `down` act on the
    // same stack.
    assert.equal(
      STACK_DOWN.args[STACK_DOWN.args.indexOf("--project-name") + 1],
      /^name: (\S+)$/mu.exec(
        readFileSync(resolve(STACK_DOWN.cwd, file), "utf8"),
      )?.[1],
    );

    const calls = [];
    const stopped = stopStack((command, argv, options) => {
      calls.push({ command, argv, cwd: options.cwd });
      return { status: 0 };
    });

    assert.equal(stopped, true);
    assert.deepEqual(calls, [
      { command: "docker", argv: PINNED_DOWN, cwd: repositoryRoot },
    ]);
  });

  test("passes docker no COMPOSE_ variable from the caller's environment, so an exported project, file or profile cannot point the down at another stack, and keeps every other variable", () => {
    const calls = [];
    stopStack(
      (_command, _argv, options) => {
        calls.push(options.env);
        return { status: 0 };
      },
      {
        PATH: "/usr/bin",
        DOCKER_HOST: "unix:///var/run/docker.sock",
        COMPOSE_PROJECT_NAME: "someone-elses",
        COMPOSE_FILE: "/elsewhere/compose.yaml",
        COMPOSE_PROFILES: "everything",
        COMPOSE_REMOVE_ORPHANS: "1",
      },
    );

    assert.deepEqual(calls, [
      { PATH: "/usr/bin", DOCKER_HOST: "unix:///var/run/docker.sock" },
    ]);
  });

  test("reports a down that failed, or a docker that never started, as not stopped", () => {
    assert.equal(
      stopStack(() => ({ status: 1 })),
      false,
    );
    assert.equal(
      stopStack(() => ({
        status: null,
        error: new Error("spawn docker ENOENT"),
      })),
      false,
    );
  });
});

test("keeps the acceptance reports out of the gate's own sweep", () => {
  // The gate clears artefacts after a passing lane run. Sweeping the reports
  // there would delete what `pnpm test:webkit` carried out of its container,
  // on the next `verify-locally --e2e` — a run that produced none of it, and
  // the deletion the WebKit runner exists to stop.
  assert.equal(ARTEFACT_PATHS.includes(REPORT_PATH), false);
  // `pnpm clean` is a person asking for it, so that one does remove them.
  assert.equal(CLEAN_PATHS.includes(REPORT_PATH), true);
  for (const path of ARTEFACT_PATHS)
    assert.ok(CLEAN_PATHS.includes(path), path);
});

test("sweeps the self-host build's own output, which git ignores", () => {
  // Plan 13, H.5 (manifest-h.md §2.7.1): REQUESTPORT_SELF_HOST_BUILD=1 builds
  // apps/web into .next-self-host, never .next, so .next's entry does not
  // cover it.
  assert.ok(ARTEFACT_PATHS.includes("apps/web/.next-self-host"));
  const ignored = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--quiet", "apps/web/.next-self-host/"],
    { cwd: repositoryRoot },
  );
  assert.equal(ignored.status, 0, "apps/web/.next-self-host/ is not ignored");
});
