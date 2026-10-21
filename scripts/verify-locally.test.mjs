import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  hostedDriverPackages,
  localProxyVariable,
} from "./hosted-deployment.mjs";
import { databaseHostDigest } from "./production-database-guard.mjs";

import {
  applyForce,
  artefactsToClearAfter,
  checkDatabaseTarget,
  hostLoad,
  invokedDirectly,
  LOCAL_DATABASE_DRIVER,
  LOCAL_DATABASE_INCOMPLETE,
  LOCAL_DATABASE_NOT_LOCAL,
  LOCAL_DATABASE_QUERY_REFUSED,
  LOCAL_DATABASE_UNNAMED,
  LOCAL_DRIVER_NOT_PG,
  LOCAL_STACK_ABSENT,
  LOCAL_VERCEL_ENV_SET,
  localDatabaseFor,
  localDatabaseListening,
  planLocalRun,
  RETIRED_LOCAL_PROXY,
  renderRecord,
  runVerification,
  STEPS,
  stepsFor,
  treeIdentity,
  UNPROVEN_LOCALLY,
  unprovenAfter,
} from "./verify-locally.mjs";

const LOCAL = "postgres://u:p@127.0.0.1:55432/requestport_local";
const STAGING_HOST = "db-staging-pooler.region-1.example.test";
const PRODUCTION_HOST = "db-production-pooler.region-1.example.test";
const STAGING = `postgres://u:p@${STAGING_HOST}/appdb`;
const PRODUCTION = `postgres://u:p@${PRODUCTION_HOST}/appdb`;

/**
 * `checkDatabaseTarget` from a temporary copy of verify-locally.mjs and the
 * scripts it imports, beside a `hosted-deployment.mjs` naming STAGING's and
 * PRODUCTION's synthetic hosts in place of the private module (ruling 91,
 * option (d)). So the refusal is seen through verify-locally's own code, and
 * this file names no shared database's host.
 */
async function checkDatabaseTargetAgainstSyntheticList(t) {
  const root = mkdtempSync(join(tmpdir(), "requestport-verify-locally-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = dirname(fileURLToPath(import.meta.url));
  mkdirSync(join(root, "scripts"));
  for (const name of [
    "verify-locally.mjs",
    "clean-locally.mjs",
    "create-track-worktree.mjs",
    "with-root-env.mjs",
    "owner-capable-variables.mjs",
    "production-database-guard.mjs",
  ]) {
    copyFileSync(join(scripts, name), join(root, "scripts", name));
  }
  const entries = [
    {
      name: "production",
      hostSha256: databaseHostDigest(PRODUCTION_HOST).toString("hex"),
      databaseNameSha256: null,
      optIn: "REQUESTPORT_PRODUCTION_DATABASE",
    },
    {
      name: "staging",
      hostSha256: databaseHostDigest(STAGING_HOST).toString("hex"),
      databaseNameSha256: createHash("sha256").update("appdb").digest("hex"),
      optIn: "REQUESTPORT_STAGING_DATABASE",
    },
  ];
  // The public variant's text with a private kind and the two synthetic
  // entries, so the copy carries every name the scripts import from the
  // module, and no hosted driver.
  const publicVariant = readFileSync(
    join(scripts, "hosted-deployment.public.mjs"),
    "utf8",
  );
  const planted = publicVariant
    .replace('export const kind = "public";', 'export const kind = "private";')
    .replace(
      "export const sharedDatabases = Object.freeze([]);",
      `export const sharedDatabases = ${JSON.stringify(entries)};`,
    );
  assert.match(planted, /^export const kind = "private";$/mu);
  assert.ok(planted.includes(JSON.stringify(entries)));
  writeFileSync(join(root, "scripts/hosted-deployment.mjs"), planted);
  const copy = await import(
    pathToFileURL(join(root, "scripts/verify-locally.mjs")).href
  );
  return copy.checkDatabaseTarget;
}

test("refuses to verify against a database somebody else is using", async (t) => {
  const checkPlanted = await checkDatabaseTargetAgainstSyntheticList(t);
  assert.throws(
    () => checkPlanted({ DATABASE_URL: STAGING }),
    /staging database/u,
  );
  assert.throws(
    () => checkPlanted({ DATABASE_URL: PRODUCTION }),
    /production database/u,
  );
  for (const check of [checkPlanted, checkDatabaseTarget]) {
    assert.deepEqual(check({ DATABASE_URL: LOCAL }), {
      ok: true,
      reason: "",
    });
  }
});

test("says so rather than pretending when there is no database at all", () => {
  const { ok, reason } = checkDatabaseTarget({});
  assert.equal(ok, false);
  assert.match(reason, /unset/iu);
});

/**
 * The half that matters.
 *
 * A local run is not a CI run, and a record that reads like a green tick is
 * worse than none. Every rendered record has to carry the list of what it did
 * not check, and the list has to be non-empty — an empty one would mean this
 * had quietly become a substitute for CI, which it is not.
 */
test("every record names what it did not prove", () => {
  const report = runVerification({
    env: { DATABASE_URL: LOCAL },
    steps: [{ id: "only", argv: ["true"] }],
    spawn: () => ({ status: 0 }),
  });
  const text = renderRecord(report, {
    head: "a".repeat(40),
    clean: true,
    workingTreeDigest: "0".repeat(16),
  });

  assert.ok(UNPROVEN_LOCALLY.length > 0);
  assert.match(text, /NOT PROVEN BY THIS RUN:/u);
  for (const entry of UNPROVEN_LOCALLY) {
    assert.ok(
      text.includes(entry.what),
      `${entry.what} is missing from the record`,
    );
    assert.ok(
      entry.why.length > 40,
      `${entry.what} has no reason worth reading`,
    );
  }
});

test("names the browser lanes among them, and no longer staging", () => {
  const named = UNPROVEN_LOCALLY.map((entry) => entry.what).join(" ");

  assert.match(named, /browser lanes/u);
  /*
   * Staging was retired on 2026-09-20. While it was listed here, the entry
   * read as "someone else proves this" — and nobody had since PR #45, with the
   * branch sixty-six commits behind main. An unproven list that names a check
   * nobody runs is worse than one that admits the gap.
   */
  assert.doesNotMatch(named, /staging/iu);
});

test("a failing step makes the whole record fail", () => {
  const report = runVerification({
    env: { DATABASE_URL: LOCAL },
    steps: [
      { id: "green", argv: ["true"] },
      { id: "red", argv: ["false"] },
    ],
    // The stub keys on the command itself, because that is what `spawn`
    // receives; the step id never reaches it.
    spawn: (command) => ({ status: command === "false" ? 1 : 0 }),
  });

  assert.equal(
    report.results.some((result) => !result.passed),
    true,
  );
  assert.match(renderRecord(report, { head: "x", clean: true }), /FAIL/u);
});

test("records the tree it verified, and whether it was clean", () => {
  const identity = treeIdentity((argv) =>
    argv.includes("--porcelain")
      ? { stdout: " M packages/db/src/schema.ts\n" }
      : { stdout: `${"b".repeat(40)}\n` },
  );

  assert.equal(identity.head, "b".repeat(40));
  assert.equal(identity.clean, false);
  assert.match(identity.workingTreeDigest, /^[0-9a-f]{16}$/u);
});

test("recognises its own invocation through a path that needs encoding", () => {
  const path = "/opt/GitHub Runner/_work/scripts/verify-locally.mjs";
  assert.equal(invokedDirectly(path, `file://${encodeURI(path)}`), true);
  assert.equal(invokedDirectly(undefined, "file:///x.mjs"), false);
});

test("keeps the proxy address it no longer uses, empty-argumented, as the value older tracks carry", () => {
  // The gate stopped reading this on 2026-09-28, when the proxy left the
  // local stack, and scripts/create-track-worktree.mjs no longer
  // writes it. A track's .env.local generated before that still carries it,
  // and the cases below use it as that value, so it stays exported, as it was.
  assert.match(RETIRED_LOCAL_PROXY, /\/v1\?address=$/u);
});

test("keeps the browser lanes opt-in", () => {
  assert.deepEqual(
    stepsFor([]).map((step) => step.id),
    [
      "lint",
      "lint-scripts",
      "typecheck",
      "scripts",
      "migration-state",
      "workspace-tests",
      "application-role-lane",
      "worker-role-lane",
    ],
  );
  assert.deepEqual(
    stepsFor(["--e2e"]).map((step) => step.id),
    [
      "lint",
      "lint-scripts",
      "typecheck",
      "scripts",
      "migration-state",
      "workspace-tests",
      "application-role-lane",
      "worker-role-lane",
      "browser-lanes",
    ],
  );
});

const LOCAL_TRACK_WITH_PASSWORD =
  "postgres://requestport:requestport_local@127.0.0.1:55432/rp_track_x";

describe("the local database the gate points pg at", () => {
  test("names the database REQUESTPORT_LOCAL_DATABASE_URL names, and where pg will dial it", () => {
    assert.deepEqual(
      localDatabaseFor({
        DATABASE_URL: "postgresql://someone@ep-elsewhere.example.test/appdb",
        REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
      }),
      {
        ok: true,
        url: LOCAL_TRACK_WITH_PASSWORD,
        host: "127.0.0.1",
        port: 55432,
      },
    );
  });

  test("defaults the port as pg does, and unwraps an IPv6 loopback", () => {
    const local = localDatabaseFor({
      REQUESTPORT_LOCAL_DATABASE_URL: "postgres://u:p@[::1]/requestport_local",
    });

    assert.equal(local.ok, true);
    assert.equal(local.host, "::1");
    assert.equal(local.port, 5432);
  });

  test("refuses to invent a local database that was never named", () => {
    for (const env of [{}, { REQUESTPORT_LOCAL_DATABASE_URL: "  " }]) {
      const local = localDatabaseFor(env);

      assert.equal(local.ok, false);
      assert.equal(local.reason, LOCAL_DATABASE_UNNAMED);
    }
  });

  test("refuses a host that is not this machine, because pg dials the host it is given", () => {
    // Through the proxy the host never mattered: the proxy dialled `db:5432`
    // whatever the string said. pg dials what the string says, so a variable
    // that used to reach the local database whatever it named would now carry
    // the gate's seeding and deleting to whichever machine it names.
    for (const url of [
      "postgres://u:p@ep-elsewhere.example.test/appdb",
      // Contains loopback, and is somebody else's machine.
      "postgres://u:p@127.0.0.1.evil.example:55432/requestport_local",
      "postgres://u:p@10.0.0.5:55432/requestport_local",
      "not a url",
    ]) {
      const local = localDatabaseFor({ REQUESTPORT_LOCAL_DATABASE_URL: url });

      assert.equal(local.ok, false, url);
      assert.equal(local.reason, LOCAL_DATABASE_NOT_LOCAL, url);
    }
  });

  test("refuses a loopback string whose query would send pg somewhere else", () => {
    // pg takes `host` (and `port`, `user`, `password`) from the query over the
    // authority, so this string's `127.0.0.1` is not where pg goes. The probe
    // would have dialled 127.0.0.1:55432, found the local server, and handed
    // every suite a string that seeds and deletes on another machine.
    for (const url of [
      "postgres://u:p@127.0.0.1:55432/appdb?host=elsewhere.example.invalid",
      "postgres://u:p@localhost:55432/appdb?port=5432&user=other",
    ]) {
      const local = localDatabaseFor({ REQUESTPORT_LOCAL_DATABASE_URL: url });

      assert.equal(local.ok, false, url);
      assert.equal(local.reason, LOCAL_DATABASE_QUERY_REFUSED, url);
    }
  });

  test("refuses such a string before probing, and leaves the environment alone", () => {
    const url =
      "postgres://u:p@127.0.0.1:55432/appdb?host=elsewhere.example.invalid";
    const env = { REQUESTPORT_LOCAL_DATABASE_URL: url };
    const plan = planLocalRun(env, [], () => {
      throw new Error("nothing may be probed for a string pg would redirect");
    });

    assert.equal(plan.ok, false);
    assert.equal(plan.reason, LOCAL_DATABASE_QUERY_REFUSED);
    assert.deepEqual(env, { REQUESTPORT_LOCAL_DATABASE_URL: url });
    assert.equal(
      localDatabaseListening(url, () => ({ status: 0 })),
      false,
    );
  });

  test("refuses a run whose environment names a Vercel environment, before probing, and leaves it alone", () => {
    // Under VERCEL_ENV=preview packages/db reads REQUESTPORT_PREVIEW_DATABASE_URL
    // instead of DATABASE_URL, so the local string this run sets would not be
    // the one the suites dial. No Vercel environment is a local run, so every
    // non-empty value is refused; an empty one selects nothing.
    for (const vercelEnv of ["preview", "production", "development"]) {
      const env = {
        VERCEL_ENV: vercelEnv,
        REQUESTPORT_PREVIEW_DATABASE_URL:
          "postgres://u:p@db.remote.example:5432/app",
        REQUESTPORT_LOCAL_DATABASE_URL:
          "postgres://requestport:x@127.0.0.1:55432/rp_track",
      };
      const before = { ...env };
      const plan = planLocalRun(env, [], () => {
        throw new Error("nothing may be probed under a Vercel environment");
      });

      assert.equal(plan.ok, false, vercelEnv);
      assert.equal(plan.reason, LOCAL_VERCEL_ENV_SET, vercelEnv);
      assert.deepEqual(env, before, vercelEnv);
    }

    const env = {
      VERCEL_ENV: "",
      REQUESTPORT_LOCAL_DATABASE_URL:
        "postgres://requestport:x@127.0.0.1:55432/rp_track",
    };

    assert.equal(planLocalRun(env, [], () => true).ok, true);
  });

  test("refuses a string without its user or password, which pg will not fill from PG*", () => {
    for (const url of [
      "postgresql://requestport@127.0.0.1:55432/requestport_local",
      "postgresql://requestport:@127.0.0.1:55432/requestport_local",
      "postgresql://127.0.0.1:55432/requestport_local",
    ]) {
      const local = localDatabaseFor({ REQUESTPORT_LOCAL_DATABASE_URL: url });

      assert.equal(local.ok, false, url);
      assert.equal(local.reason, LOCAL_DATABASE_INCOMPLETE, url);
    }
  });

  test("no refusal asks anybody to approve staging", () => {
    for (const reason of [
      LOCAL_DATABASE_UNNAMED,
      LOCAL_DATABASE_NOT_LOCAL,
      LOCAL_DATABASE_QUERY_REFUSED,
      LOCAL_DATABASE_INCOMPLETE,
      LOCAL_DRIVER_NOT_PG,
      LOCAL_STACK_ABSENT,
      LOCAL_VERCEL_ENV_SET,
    ]) {
      assert.doesNotMatch(reason, /REQUESTPORT_STAGING_DATABASE|approved/u);
    }
  });
});

test("stops calling a thing unproven once this run has proven it", () => {
  // Otherwise `--e2e` prints "the browser lanes are not proven by this run"
  // directly underneath the browser lanes passing, and a record that
  // contradicts itself teaches a reader to skip the part that matters.
  const entries = [
    { what: "staging acceptance", why: "nothing local stands in for it." },
    {
      what: "the browser lanes",
      why: "they are opt-in, because they cost minutes.",
      provenBy: "browser-lanes",
    },
  ];
  const names = (results) => unprovenAfter(results, entries).map((e) => e.what);

  assert.deepEqual(names([{ id: "browser-lanes", passed: true }]), [
    "staging acceptance",
  ]);
  // A lane that ran and failed proved nothing.
  assert.deepEqual(names([{ id: "browser-lanes", passed: false }]), [
    "staging acceptance",
    "the browser lanes",
  ]);
  assert.deepEqual(names([]), ["staging acceptance", "the browser lanes"]);
});

test("probes the host and port pg will actually dial, not the proxy's", () => {
  let probed = "";

  localDatabaseListening(
    "postgres://u:p@127.0.0.1:55432/rp_track_x",
    (_command, args) => {
      probed = args.join(" ");
      return { status: 1 };
    },
  );

  assert.ok(probed.includes(`host:${JSON.stringify("127.0.0.1")}`), probed);
  assert.ok(probed.includes("port:55432"), probed);
  assert.doesNotMatch(probed, /55433/u);
});

test("reads a closed port as absent and a listening one as present", () => {
  assert.equal(
    localDatabaseListening(LOCAL_TRACK_WITH_PASSWORD, () => ({ status: 1 })),
    false,
  );
  assert.equal(
    localDatabaseListening(LOCAL_TRACK_WITH_PASSWORD, () => ({ status: 0 })),
    true,
  );
});

describe("what a direct run decides before it runs anything", () => {
  const STAGING_CHECKOUT = "postgresql://someone@ep-staging.example.test/x";

  test("refuses a missing local stack without ever naming the staging approval", () => {
    // The bug this pins: with nothing listening, DATABASE_URL stayed as
    // `.env.local` had it — staging, in a checkout pulled from Vercel — and the
    // run reached the production guard, whose refusal tells the reader to set
    // REQUESTPORT_STAGING_DATABASE=approved. The first thing a developer saw
    // after a reboot was an instruction to point the suites at staging.
    const env = {
      DATABASE_URL: STAGING_CHECKOUT,
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
    };
    const probed = [];
    const plan = planLocalRun(env, [], (url) => {
      probed.push(url);
      return false;
    });

    assert.equal(plan.ok, false);
    assert.equal(plan.database, "absent");
    assert.equal(plan.reason, LOCAL_STACK_ABSENT);
    assert.match(plan.reason, /docker compose up -d/u);
    assert.doesNotMatch(plan.reason, /supbuddy/iu);
    // It probed the database it was about to use, and nothing else.
    assert.deepEqual(probed, [LOCAL_TRACK_WITH_PASSWORD]);
    // and it must not have touched the environment on its way out
    assert.deepEqual(env, {
      DATABASE_URL: STAGING_CHECKOUT,
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
    });
  });

  test("refuses an unnamed local database before probing anything", () => {
    const env = { DATABASE_URL: STAGING_CHECKOUT };
    const plan = planLocalRun(env, [], () => {
      throw new Error("nothing may be probed without a named database");
    });

    assert.equal(plan.ok, false);
    assert.equal(plan.reason, LOCAL_DATABASE_UNNAMED);
    assert.deepEqual(env, { DATABASE_URL: STAGING_CHECKOUT });
  });

  test("selects pg for every step, and points it at the local database", () => {
    const env = {
      DATABASE_URL: STAGING_CHECKOUT,
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
    };
    const plan = planLocalRun(env, ["--e2e"], () => true);

    assert.equal(plan.ok, true);
    assert.equal(plan.driver, "selected");
    assert.equal(LOCAL_DATABASE_DRIVER, "pg");
    assert.equal(env.REQUESTPORT_DATABASE_DRIVER, "pg");
    assert.equal(env.DATABASE_URL, env.REQUESTPORT_LOCAL_DATABASE_URL);
    assert.deepEqual(
      plan.steps.map((s) => s.id),
      [
        "lint",
        "lint-scripts",
        "typecheck",
        "scripts",
        "migration-state",
        "workspace-tests",
        "application-role-lane",
        "worker-role-lane",
        "browser-lanes",
      ],
    );
  });

  test("selects pg over an empty value, the one .env.example carries", () => {
    const env = {
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
      REQUESTPORT_DATABASE_DRIVER: "",
    };
    const plan = planLocalRun(env, [], () => true);

    assert.equal(plan.driver, "selected");
    assert.equal(env.REQUESTPORT_DATABASE_DRIVER, "pg");
  });

  test("keeps a pg the caller already chose, and says so", () => {
    const env = {
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
      REQUESTPORT_DATABASE_DRIVER: "pg",
    };

    assert.equal(planLocalRun(env, [], () => true).driver, "configured");
  });

  test("refuses any other driver rather than run the suites somewhere they cannot reach", () => {
    for (const driver of ["pglite", "mysql", "sqlite"]) {
      const env = {
        REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
        REQUESTPORT_DATABASE_DRIVER: driver,
      };
      const plan = planLocalRun(env, ["--force"], () => true);

      assert.equal(plan.ok, false, driver);
      assert.equal(plan.reason, LOCAL_DRIVER_NOT_PG, driver);
      assert.equal(env.REQUESTPORT_DATABASE_DRIVER, driver);
      assert.equal(env.DATABASE_URL, undefined);
      assert.equal(env.TURBO_FORCE, undefined);
    }
  });

  test("empties the hosted driver's proxy variable, so no suite reaches a proxy the stack no longer declares", {
    skip: localProxyVariable === null && "this tree has no hosted driver",
  }, () => {
    // Emptied rather than deleted: each workspace's vitest config calls
    // loadRootEnv, which fills only *unset* variables from `.env.local` — and
    // one generated by an older create-track-worktree.mjs still names the
    // proxy. Turbo passes the empty value through because turbo.json declares
    // the variable.
    const env = {
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
      [localProxyVariable]: RETIRED_LOCAL_PROXY,
    };

    assert.equal(planLocalRun(env, [], () => true).ok, true);
    assert.equal(env[localProxyVariable], "");
  });

  /*
   * A track's `.env.local` names its application login on the container
   * database (I.2 step 5, `create-track-worktree.mjs`). The run points
   * DATABASE_URL at the local database, so a suite that seeds through the
   * owner and reads through that login would otherwise seed one database and
   * read another (review of I.2 step 5, measured: role-guard.test.ts's lane
   * block, 1 failed).
   */
  const LOCAL_NATIVE =
    "postgres://requestport:requestport_local@127.0.0.1:55433/rp_track_x";
  /** A placeholder password for the track's login in these cases. */
  const LOGIN_PASSWORD = "abc123";
  const TRACK_LOGIN = `postgres://rp_track_y_dev_app:${LOGIN_PASSWORD}@127.0.0.1:55432/rp_track_y`;

  test("points the application login at the local database when both are on one server, keeping the login", () => {
    const env = {
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
      REQUESTPORT_APPLICATION_DATABASE_URL: TRACK_LOGIN,
    };
    const plan = planLocalRun(env, [], () => true);
    const login = new URL(env.REQUESTPORT_APPLICATION_DATABASE_URL);

    assert.equal(plan.ok, true);
    assert.equal(plan.applicationLogin, "repointed");
    assert.equal(
      env.REQUESTPORT_APPLICATION_DATABASE_URL,
      `postgres://rp_track_y_dev_app:${LOGIN_PASSWORD}@127.0.0.1:55432/rp_track_x`,
    );
    assert.equal(login.pathname, new URL(env.DATABASE_URL).pathname);
  });

  test("empties the application login when it names another server, where the login does not exist", () => {
    // Emptied rather than deleted, as the proxy variable is: loadRootEnv
    // fills only unset variables from `.env.local`, which still names it.
    const env = {
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_NATIVE,
      REQUESTPORT_APPLICATION_DATABASE_URL: TRACK_LOGIN,
    };
    const plan = planLocalRun(env, [], () => true);

    assert.equal(plan.ok, true);
    assert.equal(plan.applicationLogin, "emptied");
    assert.equal(env.REQUESTPORT_APPLICATION_DATABASE_URL, "");
    assert.equal(env.DATABASE_URL, LOCAL_NATIVE);
  });

  test("keeps an application login that names the local database, and leaves an unset one unset", () => {
    const local = `postgres://rp_track_x_dev_app:${LOGIN_PASSWORD}@127.0.0.1:55432/rp_track_x`;
    const named = {
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
      REQUESTPORT_APPLICATION_DATABASE_URL: local,
    };
    const unset = { REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD };

    assert.equal(planLocalRun(named, [], () => true).applicationLogin, "kept");
    assert.equal(named.REQUESTPORT_APPLICATION_DATABASE_URL, local);
    assert.equal(planLocalRun(unset, [], () => true).applicationLogin, "unset");
    assert.equal("REQUESTPORT_APPLICATION_DATABASE_URL" in unset, false);
  });

  test("touches no application login on a run it refuses", () => {
    const env = {
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_NATIVE,
      REQUESTPORT_APPLICATION_DATABASE_URL: TRACK_LOGIN,
    };

    assert.equal(planLocalRun(env, [], () => false).ok, false);
    assert.equal(env.REQUESTPORT_APPLICATION_DATABASE_URL, TRACK_LOGIN);
  });
});

test("every step of a planned run receives pg, the local database and no proxy", () => {
  const env = {
    DATABASE_URL: "postgresql://someone@ep-staging.example.test/x",
    REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
    ...(localProxyVariable === null
      ? {}
      : { [localProxyVariable]: RETIRED_LOCAL_PROXY }),
  };
  const plan = planLocalRun(env, ["--e2e"], () => true);
  const handed = [];

  runVerification({
    env,
    steps: plan.steps,
    spawn: (_command, _args, options) => {
      handed.push(options.env);
      return { status: 0 };
    },
    readLoad: () => ({ oneMinute: 1, cores: 10 }),
  });

  assert.equal(handed.length, plan.steps.length);
  for (const stepEnv of handed) {
    assert.equal(stepEnv.REQUESTPORT_DATABASE_DRIVER, "pg");
    assert.equal(stepEnv.DATABASE_URL, LOCAL_TRACK_WITH_PASSWORD);
    if (localProxyVariable !== null) {
      assert.equal(stepEnv[localProxyVariable], "");
    }
  }
});

test("names the hosted driver among what a local run cannot prove, where the tree has one", () => {
  const entry = UNPROVEN_LOCALLY.find((e) =>
    /hosted database driver/u.test(e.what),
  );

  if (hostedDriverPackages.length === 0) {
    assert.equal(entry, undefined, "the public tree has no hosted driver");
  } else {
    assert.ok(
      entry,
      "the hosted driver is unproven locally once the proxy is gone",
    );
    assert.equal(entry.provenBy, undefined);
    assert.ok(entry.why.includes(localProxyVariable), entry.why);
  }
  // and the browser lanes no longer claim a proxy
  for (const e of UNPROVEN_LOCALLY) {
    assert.doesNotMatch(e.why, /through the same WebSocket proxy/u, e.what);
  }
});

test("a run whose database target was refused cannot report success", () => {
  // checkDatabaseTarget's verdict was computed and then dropped on the floor:
  // with DATABASE_URL unset every step still ran, and `results.every(passed)`
  // over an empty list is true, so the record could read green.
  const report = runVerification({
    env: {},
    steps: [{ id: "would-have-run", argv: ["true"] }],
    spawn: () => {
      throw new Error("no step may spawn once the target is refused");
    },
  });

  assert.equal(report.target.ok, false);
  assert.deepEqual(report.results, []);
  assert.equal(report.passed, false);
});

describe("tidying up after the browser lanes", () => {
  test("clears the run's artefacts when the lanes passed", () => {
    assert.equal(
      artefactsToClearAfter([
        { id: "workspace-tests", passed: true },
        { id: "browser-lanes", passed: true },
      ]),
      true,
    );
  });

  test("keeps everything when a lane failed, because that is the evidence", () => {
    // Playwright writes the trace, the screenshot and the error context for a
    // failed case into test-results/. Clearing those on the one run that
    // produced them would delete the only account of what went wrong.
    assert.equal(
      artefactsToClearAfter([
        { id: "workspace-tests", passed: true },
        { id: "browser-lanes", passed: false },
      ]),
      false,
    );
  });

  test("does nothing on a run that never opened a browser", () => {
    assert.equal(
      artefactsToClearAfter([{ id: "workspace-tests", passed: true }]),
      false,
    );
  });
});

/**
 * `--force` was accepted and ignored until 2026-09-27: nothing read it, every
 * Turbo step had a fixed argv, and CLAUDE.md told readers it made a run cold.
 * These run the real plan through `runVerification` with a spawn that records
 * what each step was handed, so they fail on what a step would receive rather
 * than on how this file happens to be written.
 */
describe("--force reaches every Turbo step, and only when asked for", () => {
  function spawnedBy(argv, inherited = {}) {
    const env = {
      REQUESTPORT_LOCAL_DATABASE_URL: LOCAL_TRACK_WITH_PASSWORD,
      ...inherited,
    };
    const plan = planLocalRun(env, argv, () => true);
    const spawned = [];
    const report = runVerification({
      env,
      steps: plan.steps,
      spawn: (command, args, options) => {
        spawned.push({ line: [command, ...args].join(" "), env: options.env });
        return { status: 0 };
      },
    });
    return { plan, report, spawned };
  }

  const turboSteps = (spawned) =>
    spawned.filter((step) => /\bturbo\b/u.test(step.line));

  test("the gate has Turbo steps for this to reach", () => {
    // Guards the tests below against passing vacuously over an empty list.
    assert.ok(STEPS.filter((step) => step.argv.includes("turbo")).length >= 3);
  });

  for (const argv of [
    ["--force"],
    ["--force", "--e2e"],
    ["--e2e", "--force"],
  ]) {
    test(`hands every Turbo step the bypass under ${argv.join(" ")}`, () => {
      const { plan, report, spawned } = spawnedBy(argv);

      assert.equal(plan.forced, true);
      assert.equal(report.forced, true);
      assert.ok(turboSteps(spawned).length >= 3);
      for (const step of spawned) {
        assert.equal(step.env.TURBO_FORCE, "true", step.line);
      }
    });
  }

  for (const argv of [[], ["--e2e"]]) {
    test(`adds no bypass to a run without --force (${argv.join(" ") || "no flags"})`, () => {
      const { plan, report, spawned } = spawnedBy(argv);

      assert.equal(plan.forced, false);
      assert.equal(report.forced, false);
      assert.ok(turboSteps(spawned).length >= 3);
      for (const step of spawned) {
        assert.equal(step.env.TURBO_FORCE, undefined, step.line);
        assert.doesNotMatch(step.line, /--force/u);
      }
    });
  }

  test("reports a bypass the caller exported, because Turbo honours it anyway", () => {
    const { report, spawned } = spawnedBy([], { TURBO_FORCE: "true" });

    assert.equal(report.forced, true);
    for (const step of spawned) assert.equal(step.env.TURBO_FORCE, "true");
  });

  test("calls a run forced only on the values Turbo was measured to honour", () => {
    // Turbo 2.10.10 bypassed its cache for `true` and `1`, and silently
    // replayed it for each of the others.
    for (const value of ["true", "1"]) {
      assert.equal(applyForce({ TURBO_FORCE: value }, []), true, value);
    }
    for (const value of ["TRUE", "yes", "0", "false", "", undefined]) {
      assert.equal(applyForce({ TURBO_FORCE: value }, []), false, value);
    }
  });

  test("the record says whether the run was forced", () => {
    const identity = { head: "c".repeat(40), clean: true };
    const forced = renderRecord(spawnedBy(["--force"]).report, identity);
    const warm = renderRecord(spawnedBy([]).report, identity);

    assert.match(forced, /^forced=true/mu);
    assert.match(warm, /^forced=false/mu);
    assert.match(warm, /--force/u);
  });

  test("a refused plan does not set the bypass either", () => {
    const env = {};
    const plan = planLocalRun(env, ["--force"], () => false);

    assert.equal(plan.ok, false);
    assert.equal(env.TURBO_FORCE, undefined);
  });
});

/**
 * A red run at a load average of 150 on a ten-core machine is not the same
 * evidence as a red run on a quiet one: every database suite's connection waits
 * for a CPU, and timeouts follow. The record has to say which it was, so a
 * reader can tell a regression from a busy host without asking whoever ran it.
 */
describe("the record says how loaded the host was", () => {
  const identity = { head: "d".repeat(40), clean: true };

  function readings(...values) {
    const queue = [...values];
    const calls = [];
    return {
      read: () => {
        calls.push(queue.length);
        return queue.shift();
      },
      calls,
    };
  }

  test("reads the load once before the first step and once after the last", () => {
    const order = [];
    const load = readings(
      { oneMinute: 150.2, cores: 10 },
      { oneMinute: 131.04, cores: 10 },
    );
    const report = runVerification({
      env: { DATABASE_URL: LOCAL },
      steps: [
        { id: "first", argv: ["true"] },
        { id: "second", argv: ["true"] },
      ],
      spawn: (command, args) => {
        order.push(`spawn ${args.at(-1) ?? command}`);
        return { status: 0 };
      },
      readLoad: () => {
        order.push("load");
        return load.read();
      },
    });

    assert.deepEqual(order, ["load", "spawn true", "spawn true", "load"]);
    assert.deepEqual(report.load, {
      start: { oneMinute: 150.2, cores: 10 },
      end: { oneMinute: 131.04, cores: 10 },
    });
  });

  test("a red run at load 150 reads as taken under load", () => {
    const report = runVerification({
      env: { DATABASE_URL: LOCAL },
      steps: [{ id: "workspace-tests", argv: ["false"] }],
      spawn: () => ({ status: 1 }),
      readLoad: readings(
        { oneMinute: 150.2, cores: 10 },
        { oneMinute: 131.04, cores: 10 },
      ).read,
    });
    const text = renderRecord(report, identity);

    assert.match(text, /^load=150\.2→131\.0 /mu);
    assert.match(text, /10 cores/u);
    assert.match(text, /under load/u);
    assert.match(text, /FAIL workspace-tests/u);
  });

  test("a run on a quiet host does not claim load", () => {
    const report = runVerification({
      env: { DATABASE_URL: LOCAL },
      steps: [{ id: "only", argv: ["true"] }],
      spawn: () => ({ status: 0 }),
      readLoad: readings(
        { oneMinute: 3.4, cores: 10 },
        { oneMinute: 4.1, cores: 10 },
      ).read,
    });
    const text = renderRecord(report, identity);

    assert.match(text, /^load=3\.4→4\.1 /mu);
    assert.doesNotMatch(text, /under load/u);
  });

  test("counts a run as loaded if either end of it was", () => {
    for (const [start, end] of [
      [2, 40],
      [40, 2],
    ]) {
      const report = runVerification({
        env: { DATABASE_URL: LOCAL },
        steps: [{ id: "only", argv: ["true"] }],
        spawn: () => ({ status: 0 }),
        readLoad: readings(
          { oneMinute: start, cores: 10 },
          { oneMinute: end, cores: 10 },
        ).read,
      });

      assert.match(renderRecord(report, identity), /under load/u);
    }
  });

  test("a refused run still records the load it was refused at", () => {
    const report = runVerification({
      env: {},
      steps: [{ id: "would-have-run", argv: ["true"] }],
      spawn: () => {
        throw new Error("no step may spawn once the target is refused");
      },
      readLoad: readings(
        { oneMinute: 7, cores: 10 },
        { oneMinute: 8, cores: 10 },
      ).read,
    });

    assert.deepEqual(report.load, {
      start: { oneMinute: 7, cores: 10 },
      end: { oneMinute: 8, cores: 10 },
    });
  });

  test("the default reader returns this host's 1-minute load and core count", () => {
    const { oneMinute, cores } = hostLoad();

    assert.equal(typeof oneMinute, "number");
    assert.ok(Number.isFinite(oneMinute) && oneMinute >= 0);
    assert.ok(Number.isInteger(cores) && cores >= 1);
  });

  test("a run that names no reader records this host's load, not a stand-in", () => {
    // Every other test here injects `readLoad`, so without this one a default
    // swapped for a constant would pass them all while real records lied. The
    // refused target means no step spawns. The OS refreshes the load average
    // every few seconds, so the run's readings must each equal one taken just
    // before it or one taken just after it.
    const before = loadavg()[0];
    const report = runVerification({
      env: {},
      steps: [{ id: "would-have-run", argv: ["true"] }],
      spawn: () => {
        throw new Error("no step may spawn once the target is refused");
      },
    });
    const after = loadavg()[0];

    for (const reading of [report.load.start, report.load.end]) {
      assert.equal(reading.cores, availableParallelism());
      assert.ok(
        [before, after].includes(reading.oneMinute),
        `${reading.oneMinute} is neither ${before} nor ${after}`,
      );
    }
  });
});

test("runs the worker-role lane after the application-role lane, on its own configuration", () => {
  const ids = STEPS.map((step) => step.id);
  const lane = STEPS.find((step) => step.id === "worker-role-lane");

  assert.equal(
    ids.indexOf("worker-role-lane"),
    ids.indexOf("application-role-lane") + 1,
  );
  assert.deepEqual(lane?.argv, [
    "pnpm",
    "--filter",
    "@requestport/jobs",
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.worker-role.config.ts",
  ]);
});

test("runs the application-role lane after the workspace suites, on its own configuration", () => {
  const ids = STEPS.map((step) => step.id);
  const lane = STEPS.find((step) => step.id === "application-role-lane");

  assert.equal(
    ids.indexOf("application-role-lane"),
    ids.indexOf("workspace-tests") + 1,
  );
  assert.deepEqual(lane?.argv, [
    "pnpm",
    "--filter",
    "@requestport/db",
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.application-role.config.ts",
  ]);
});
