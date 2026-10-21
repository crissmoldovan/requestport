#!/usr/bin/env node
/**
 * The verification a person can run when GitHub Actions cannot.
 *
 * Written on 2026-09-14, when the organisation's Actions account was locked
 * for billing and every job was refused before it started. Merging still had
 * to be possible, and "I ran some tests" is not evidence — so this runs what
 * can be run here and, more importantly, **says what it did not run**.
 *
 * That second half is the point. A local pass is not a CI pass, and a record
 * that implies otherwise is worse than no record: the gaps below are real, and
 * naming them is what keeps somebody from reading this as a green tick.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { fileURLToPath } from "node:url";

import {
  ARTEFACT_PATHS,
  artefactPlan,
  DATABASE_NOT_LOCAL,
  DATABASE_QUERY_NOT_ALLOWED,
  DATABASE_UNNAMED,
  LOCAL_DATABASE_QUERY_PARAMETERS,
  localDatabaseTarget,
  removeArtefacts,
  repositoryRoot,
} from "./clean-locally.mjs";
import {
  hostedDriverPackages,
  localProxyVariable,
} from "./hosted-deployment.mjs";
import { refuseUnapprovedProductionDatabase } from "./production-database-guard.mjs";
import { loadRootEnv } from "./with-root-env.mjs";

/**
 * What this cannot prove, whatever it prints.
 *
 * Each entry says what is unchecked and why it cannot be checked here, so the
 * list can be argued with rather than trusted. An entry leaves this list by
 * becoming runnable, not by being forgotten: one that names a `provenBy` step
 * drops out of a run's record the moment that step passes, and the rest leave
 * only by being deleted, which is a change somebody has to justify. The hosted
 * driver's entry is listed only where the tree has that driver
 * (`hostedDriverPackages` in `hosted-deployment.mjs`): the public tree's
 * drivers are pg and PGlite, and it has no other to leave unproven.
 */
export const UNPROVEN_LOCALLY = [
  {
    what: "the 0014 membership-lock migration race",
    why: "it needs a second disposable database provisioned alongside the first, which the CI chain creates per run.",
  },
  {
    what: "the production build",
    why: 'nothing here builds one. The default pass does not build at all, and `--e2e` builds with NODE_ENV=test — deliberately: `scripts/start-e2e-server.mjs` argues that a loopback acceptance run cannot be served by a `production` build, and passes `NODE_ENV: "test"` to the build it runs. So `--e2e` proves the tree compiles and serves, not that the artefact Vercel ships does. Vercel builds every pull request head, which is where that gate actually lives.',
  },
  {
    what: "WebKit, on this host only",
    why: "Playwright pins WebKit 2251 for mac14-arm64 against a mainline of 2336, so every WebKit case skips here. The engine is reachable on Linux: the same lanes run inside the matching mcr.microsoft.com/playwright image, which `pnpm test:webkit` runs. That lane is not reliably green — docs/implementation/gotchas.md records it failing intermittently — so running it is how WebKit is exercised, not a standing claim that WebKit passes.",
  },
  {
    what: "the browser lanes",
    why: "they cost minutes where the rest of this costs seconds, so they are opt-in rather than absent: run with `--e2e` and they run here — a real build of the tree (under NODE_ENV=test, not a production build), served locally, reaching the local database on pg as the workspace suites do. Without the flag nothing browser-shaped runs at all, which is what this entry is for.",
    provenBy: "browser-lanes",
  },
  ...(hostedDriverPackages.length === 0
    ? []
    : [
        {
          what: "the hosted database driver against a database",
          why: `it is the driver production runs (packages/db/src/hosted-driver.ts), and nothing here runs it. The WebSocket proxy that let it reach a plain PostgreSQL left the local stack on 2026-09-28, so this run selects pg for every step and empties ${localProxyVariable}, and the driver's cases in packages/db skip, because each runs only when that variable names a proxy. What still covers the hosted path locally is what needs no connection: its construction and options, in packages/db's tests. Only a deployment connects it.`,
        },
      ]),
];

export const STEPS = [
  { id: "lint", argv: ["pnpm", "exec", "turbo", "run", "lint"] },
  /*
   * The workspaces lint themselves through turbo; the root `scripts/` directory
   * is in no workspace, so nothing linted it — including this file and the
   * production-migration launcher. With no CI the gate is the only guard there
   * is, and it did not cover the directory it lives in.
   *
   * Two limits, said rather than implied. `scripts/hooks/pre-push` is a shell
   * script and biome ignores it, so the hook is still unlinted by anything. And
   * `biome check` exits zero on warnings, of which this directory currently has
   * several — this step fails the gate on errors, not on everything biome says.
   */
  { id: "lint-scripts", argv: ["pnpm", "run", "lint:scripts"] },
  { id: "typecheck", argv: ["pnpm", "exec", "turbo", "run", "typecheck"] },
  {
    id: "scripts",
    argv: ["node", "--test", "scripts/*.test.mjs"],
    shell: true,
  },
  // The alarm the deleted `production-migrations.yml` used to be. It needs no
  // credentials — it compares the checked-in migration journal against what was
  // recorded the last time somebody applied to production. A pending migration
  // fails it only on `main`, which is where that workflow failed; a migration
  // after one marked to be last in its transaction, while the record says the
  // marked one is not applied, fails it on every branch.
  { id: "migration-state", argv: ["node", "scripts/migration-state.mjs"] },
  // `--continue`, so one red workspace cannot hide the rest: a known failure
  // used to stop turbo at @requestport/auth and the web suite never reported,
  // which is how four red stylesheet checks sat on main unnoticed.
  {
    id: "workspace-tests",
    argv: ["pnpm", "exec", "turbo", "run", "test", "--continue"],
  },
  // The application-role lane (Plan 13, Track I.2; manifest-i2.md §2.9,
  // ruling 17): the suites packages/db/vitest.application-role.config.ts
  // names, again, with each storage they build from the application's options
  // (applicationStorageOptionsFromEnv) connected as a login that is a member of
  // requestport_application only, so every row-level security policy applies
  // to it. After the workspace suites and
  // never beside them: it uses the same database, and creates and drops its
  // login on that server.
  {
    id: "application-role-lane",
    argv: [
      "pnpm",
      "--filter",
      "@requestport/db",
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.application-role.config.ts",
    ],
  },
  // The worker-role lane (Plan 13, Track I.2b; manifest-i2.md §5.3, ruling
  // 35, the same hand-over): the suites packages/jobs/vitest.worker-role.config.ts
  // names, again, with the worker's three variables set to logins in the
  // dispatcher, tenant-processor and maintenance groups, so the pollers,
  // bodies and schedules run as the roles production switches to at b3.
  // After the application-role lane and never beside it: it creates and
  // drops a database of its own and three logins on the same server.
  {
    id: "worker-role-lane",
    argv: [
      "pnpm",
      "--filter",
      "@requestport/jobs",
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.worker-role.config.ts",
    ],
  },
];

/**
 * Refuse to verify against a database somebody else is using.
 *
 * The guard already refuses production and staging. This adds the reason it
 * matters here: a verification run seeds and deletes, so pointing it at a
 * shared database makes the run itself the thing that breaks the next gate.
 */
export function checkDatabaseTarget(env) {
  refuseUnapprovedProductionDatabase(env);
  const url = env.DATABASE_URL;
  if (typeof url !== "string" || url.trim() === "") {
    return {
      ok: false,
      reason: "DATABASE_URL is unset, so nothing that needs a database can run",
    };
  }
  return { ok: true, reason: "" };
}

/** A digest of the tree being verified, so a record names what it verified. */
export function treeIdentity(
  run = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: "utf8" }),
) {
  const head = run(["git", "rev-parse", "HEAD"]);
  const dirty = run(["git", "status", "--porcelain"]);
  const sha = (head.stdout ?? "").trim();
  const changes = (dirty.stdout ?? "").trim();
  return {
    head: sha,
    clean: changes === "",
    workingTreeDigest: createHash("sha256")
      .update(changes)
      .digest("hex")
      .slice(0, 16),
  };
}

/**
 * The host's 1-minute load average and how many cores it has.
 *
 * The record carries this because the gate's database suites were measured
 * timing out when other projects kept this machine's load average in the
 * hundreds (2026-09-27): each new connection waited seconds for a CPU. A red
 * record that does not say how busy the host was cannot be told apart from a
 * regression. `os.loadavg()` is always zeros on Windows, where this reads as a
 * quiet host whatever the truth.
 */
export function hostLoad() {
  return { oneMinute: loadavg()[0], cores: availableParallelism() };
}

export function runVerification({
  // The steps run turbo, which runs each workspace's own `vitest`. Nothing in
  // that chain reads `.env.local`, so without this the suites that parse their
  // configuration at import fail on a missing variable, and the record reports
  // a defect that is only a missing environment — which is exactly what three
  // web suites did until 2026-09-15. `loadRootEnv` fills unset keys only, so an
  // exported DATABASE_URL still wins, and the guard below still refuses
  // production and staging whatever the file names.
  env = loadRootEnv(),
  steps = STEPS,
  spawn = spawnSync,
  // Read once before the first step and once after the last, so the record
  // shows the load the run started and finished under, not one sample.
  readLoad = hostLoad,
} = {}) {
  const loadAtStart = readLoad();
  const target = checkDatabaseTarget(env);

  // The verdict used to be computed here and then carried into the record
  // unread: every step ran anyway, and `results.every(passed)` over the empty
  // list a refused run produces is `true`, so a record could read green while
  // naming its own refusal three lines above.
  // Read from the environment the steps are handed, so the record says what
  // the steps received rather than what the command line asked for.
  const forced = forcedBy(env);

  if (!target.ok) {
    return {
      target,
      forced,
      load: { start: loadAtStart, end: readLoad() },
      results: [],
      unproven: unprovenAfter([]),
      passed: false,
    };
  }

  const results = [];
  for (const step of steps) {
    const started = Date.now();
    const outcome = spawn(
      step.shell ? "sh" : step.argv[0],
      step.shell ? ["-c", step.argv.join(" ")] : step.argv.slice(1),
      {
        encoding: "utf8",
        env,
        stdio: "inherit",
      },
    );
    results.push({
      id: step.id,
      passed: outcome.status === 0,
      status: outcome.status,
      seconds: Math.round((Date.now() - started) / 1000),
    });
  }
  return {
    target,
    forced,
    load: { start: loadAtStart, end: readLoad() },
    results,
    unproven: unprovenAfter(results),
    passed: results.every((result) => result.passed),
  };
}

/**
 * The entries still unproven after a run, which is not the whole list.
 *
 * An entry that names the step which would prove it drops out once that step
 * has run and passed. Without this, `--e2e` prints "the browser lanes are not
 * proven by this run" directly beneath the browser lanes passing, and a record
 * that contradicts itself teaches a reader to skip the part that matters.
 *
 * A step that ran and failed proves nothing, so the entry stays.
 */
export function unprovenAfter(results, entries = UNPROVEN_LOCALLY) {
  return entries.filter(
    (entry) =>
      entry.provenBy === undefined ||
      !results.some(
        (result) => result.id === entry.provenBy && result.passed === true,
      ),
  );
}

export function renderRecord(report, identity) {
  const lines = [
    "RequestPort local verification",
    `head=${identity.head} clean=${identity.clean}`,
    report.forced
      ? "forced=true: every step ran with Turbo's cache bypass (TURBO_FORCE), so Turbo replayed nothing from its cache"
      : "forced=false: Turbo may have replayed cached results; pass --force for a cold run",
    ...(report.load ? [renderLoad(report.load)] : []),
    ...report.results.map(
      (r) => `${r.passed ? "pass" : "FAIL"} ${r.id} (${r.seconds}s)`,
    ),
    "",
    "NOT PROVEN BY THIS RUN:",
    ...report.unproven.map((u) => `- ${u.what}: ${u.why}`),
  ];
  return lines.join("\n");
}

/**
 * One line: the load at the start and end of the run, and whether either
 * exceeded the core count. Above it, work was waiting for a CPU on average, so
 * a timeout in the run may be the host rather than the code.
 */
function renderLoad({ start, end }) {
  const loaded = Math.max(start.oneMinute, end.oneMinute) > start.cores;
  const line = `load=${start.oneMinute.toFixed(1)}→${end.oneMinute.toFixed(1)} (1-minute load average at start→end, ${start.cores} cores)`;

  return loaded
    ? `${line}: under load — above the core count, so a timeout in this run may be the host rather than the code`
    : line;
}

/**
 * The proxy address this gate used until 2026-09-28, when the proxy left the
 * local stack and the gate moved to pg. Nothing here reads it any
 * more, and `scripts/create-track-worktree.mjs` no longer writes it. It stays
 * exported, its value unchanged, because a track's `.env.local` generated by
 * an older `create-track-worktree.mjs` still carries it in the hosted
 * driver's proxy variable (`localProxyVariable`), and this file's tests use it
 * as that value to show the gate empties it.
 */
export const RETIRED_LOCAL_PROXY = "127.0.0.1:55433/v1?address=";

/** The driver every step of a local run uses. */
export const LOCAL_DATABASE_DRIVER = "pg";

/**
 * The local database this run will point pg at, or why it will not.
 *
 * Through the proxy the connection string's host never mattered: the proxy
 * dialled `db:5432` whatever it said, so `REQUESTPORT_LOCAL_DATABASE_URL`
 * reached the local database even when it named somewhere else. pg dials the
 * host it is given. So the variable keeps its meaning — the local database —
 * by being refused when it names another machine, parsed by
 * `clean-locally.mjs`'s `localDatabaseTarget`, which judges the host as a host
 * and refuses a query parameter outside a short allowlist, because pg takes
 * `host`, `port`, `user` and `password` from the query over the authority.
 *
 * pg also refuses to take a user or password from `PG*` variables
 * (`packages/db/src/database-url.ts`), so a string without both would fail
 * every database suite on its first query. That is refused here, once.
 */
export function localDatabaseFor(env) {
  let url;
  try {
    url = localDatabaseTarget(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    return {
      ok: false,
      reason:
        message === DATABASE_UNNAMED
          ? LOCAL_DATABASE_UNNAMED
          : message === DATABASE_NOT_LOCAL
            ? LOCAL_DATABASE_NOT_LOCAL
            : message === DATABASE_QUERY_NOT_ALLOWED
              ? LOCAL_DATABASE_QUERY_REFUSED
              : message,
    };
  }

  const parsed = new URL(url);

  if (parsed.username === "" || parsed.password === "") {
    return { ok: false, reason: LOCAL_DATABASE_INCOMPLETE };
  }

  return {
    ok: true,
    url,
    host: parsed.hostname.replace(/^\[(.*)\]$/u, "$1"),
    port: parsed.port === "" ? 5432 : Number(parsed.port),
  };
}

/**
 * Whether something is listening where pg will dial: the host and port the
 * local database's own connection string names, so a probe cannot report a
 * database absent that is running somewhere this run was never going to look.
 */
export function localDatabaseListening(url, spawn = spawnSync) {
  const local = localDatabaseFor({ REQUESTPORT_LOCAL_DATABASE_URL: url });

  if (!local.ok) return false;

  const probe = spawn(
    process.execPath,
    [
      "-e",
      `const s=require("node:net").connect({host:${JSON.stringify(local.host)},port:${local.port}});s.setTimeout(1500);s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1));`,
    ],
    { encoding: "utf8" },
  );

  return probe.status === 0;
}

/**
 * `--force`: bypass Turbo's cache for every Turbo invocation this run makes.
 *
 * Until 2026-09-27 nothing read this flag — `stepsFor` knew only `--e2e` and
 * every Turbo step had a fixed argv — so a run given `--force` replayed
 * whatever the cache held, while CLAUDE.md told readers it was a cold run.
 *
 * It is set as `TURBO_FORCE=true` in the environment every step inherits,
 * rather than appended to each `turbo run` argv, because the Turbo runs are not
 * all in this file: the browser-lanes step can reach a `turbo run build` —
 * `start-e2e-server.mjs` runs `pnpm run build` when it judges the build stale —
 * and only the environment gets there. It does not make that script rebuild a
 * build it judges fresh; that decision is its own, not Turbo's.
 *
 * A bypass the caller already exported is reported the same way, because Turbo
 * honours it whatever this script says; this function never sets the bypass
 * without `--force`.
 */
export function applyForce(env, argv = []) {
  if (argv.includes("--force")) env.TURBO_FORCE = "true";

  return forcedBy(env);
}

/**
 * The `TURBO_FORCE` values Turbo 2.10.10 was measured to honour on 2026-09-27:
 * each printed `cache bypass, force executing` and `0 cached`. `TRUE`, `yes`,
 * `0` and `false` were measured too, and each replayed the cache without a
 * word, so none of them makes a run forced. This script only ever sets `true`.
 */
export const TURBO_FORCE_VALUES = Object.freeze(["true", "1"]);

/** Whether the steps of a run using this environment bypass Turbo's cache. */
export function forcedBy(env) {
  return TURBO_FORCE_VALUES.includes(env.TURBO_FORCE);
}

/** The browser lanes are opt-in: they cost minutes, the rest costs seconds. */
export function stepsFor(argv = []) {
  if (!argv.includes("--e2e")) return STEPS;

  return [...STEPS, { id: "browser-lanes", argv: ["pnpm", "test:e2e"] }];
}

/**
 * Why a local run may refuse before it starts, in words that point somewhere
 * useful.
 *
 * The first of these exists because of a real misdirection. With the local
 * stack down, `DATABASE_URL` kept whatever `.env.local` held — staging, in a
 * checkout pulled from Vercel — and the run walked into
 * `refuseUnapprovedProductionDatabase`, whose message tells the reader to set
 * `REQUESTPORT_STAGING_DATABASE=approved`. That message is right for the
 * question it was written to answer and exactly wrong here: the answer to "my
 * local database is not running" must never be "approve staging". None of
 * these refusals names that approval, and each is decided before anything in
 * the environment is changed.
 */
export const LOCAL_STACK_ABSENT = [
  "The local database stack is not running, so nothing here can reach a database.",
  "",
  "Start it:   docker compose up -d",
  "",
  "This run has changed nothing and pointed at nothing. It refuses here rather",
  "than one step later, because one step later the connection string still names",
  "whatever `.env.local` was pulled with — and the guard that catches that asks",
  "you to approve staging, which is not the answer to a stopped container.",
].join("\n");

export const LOCAL_DATABASE_UNNAMED = [
  "No local database is named.",
  "",
  "Add REQUESTPORT_LOCAL_DATABASE_URL to .env.local, naming the local",
  "PostgreSQL (127.0.0.1:55432, from compose.yaml) with its user and",
  "password.",
  "",
  "Without it this run would hand the suites whatever DATABASE_URL names — in",
  "a checkout pulled from Vercel, a database nobody chose for a test run.",
].join("\n");

export const LOCAL_DATABASE_NOT_LOCAL = [
  "REQUESTPORT_LOCAL_DATABASE_URL names a host that is not this machine.",
  "",
  "This run points every database suite at it on pg, which dials the host the",
  "string names. The WebSocket proxy the gate used before ignored that host, so",
  "a string like this once reached the local database anyway; on pg it would",
  "carry the suites' seeding and deleting to that machine. Name the local",
  "PostgreSQL (127.0.0.1:55432) instead.",
].join("\n");

export const LOCAL_DATABASE_QUERY_REFUSED = [
  "REQUESTPORT_LOCAL_DATABASE_URL carries a query parameter other than",
  `${LOCAL_DATABASE_QUERY_PARAMETERS.join(" or ")}.`,
  "",
  "pg reads host, port, user and password from the query as well, and prefers",
  "them to the ones before the `?`: `postgres://u:p@127.0.0.1:55432/db?host=x`",
  "connects to x. The loopback check, and the probe, judge the part before the",
  "`?`, so a string like this would carry the suites' seeding and deleting to",
  "whatever the query names. Remove the query, or keep only those parameters.",
].join("\n");

export const LOCAL_DATABASE_INCOMPLETE = [
  "REQUESTPORT_LOCAL_DATABASE_URL names no user or no password.",
  "",
  "This run uses pg, and packages/db refuses to let pg fill either from PG*",
  "variables, so every database suite would fail on its first query. Write",
  "both into the string: the local stack's are in compose.yaml.",
].join("\n");

export const LOCAL_DRIVER_NOT_PG = [
  "REQUESTPORT_DATABASE_DRIVER is set to something other than pg.",
  "",
  "This run points every database suite at the local PostgreSQL on pg. No",
  "other driver reaches it here: PGlite opens no server, and the hosted",
  "driver, where the tree has one, needs a WebSocket proxy that is no longer",
  "part of the local stack. Unset the variable, or set it to pg, for this run.",
].join("\n");

export const LOCAL_VERCEL_ENV_SET = [
  "VERCEL_ENV is set to a Vercel environment, and this is a local run.",
  "",
  "Under VERCEL_ENV=preview packages/db reads REQUESTPORT_PREVIEW_DATABASE_URL",
  "rather than DATABASE_URL, so the local database this run names would not be",
  "the one the suites dial; the other values switch on what only a deployment",
  "should. Unset VERCEL_ENV for this run (or leave it empty), and remove it from",
  ".env.local if it came from there.",
].join("\n");

/** The application login's variable (Plan 13, I.2; `database-url.ts`). */
export const APPLICATION_DATABASE_URL_VARIABLE =
  "REQUESTPORT_APPLICATION_DATABASE_URL";

/**
 * Make the application login's variable agree with the local database this
 * run points `DATABASE_URL` at, and answer what was done.
 *
 * A track's `.env.local` names its application login on the database it
 * was made on (`create-track-worktree.mjs`, I.2 step 5). A run whose local
 * database is another one would otherwise seed through the owner on one
 * database and read through the login on another, which is how
 * `role-guard.test.ts`'s application block failed in the review of I.2
 * step 5. So:
 * - `unset`: the variable is unset or blank, and is left as it is;
 * - `kept`: it names the local database's host, port and database already;
 * - `repointed`: it names the same host and port (a login is a role, which
 *   is the whole server's) and another database, so its database becomes
 *   the local one's, its user, password and query kept;
 * - `emptied`: it names another host or port, where its login need not
 *   exist, or does not parse. It is set to `""`, not deleted, because the
 *   vitest configs' `loadRootEnv` fills only unset variables from
 *   `.env.local`. With it empty, a storage built from the application's
 *   options connects in this run only where a suite sets the variable
 *   itself, and `role-guard.test.ts`'s block that runs wherever the
 *   variable is set is skipped. The application-role lane and auth's three
 *   integration suites (each sets it to `DATABASE_URL` in `vi.hoisted`)
 *   set it for themselves, so they are not affected.
 *
 * Host names are compared as written: `localhost` and `127.0.0.1` differ
 * here, which only ever empties the variable.
 */
export function alignApplicationLogin(env, localUrl) {
  const value = env[APPLICATION_DATABASE_URL_VARIABLE];

  if (typeof value !== "string" || value.trim() === "") return "unset";

  const local = new URL(localUrl);
  let login;
  try {
    login = new URL(value);
  } catch {
    env[APPLICATION_DATABASE_URL_VARIABLE] = "";
    return "emptied";
  }

  const portOf = (url) => (url.port === "" ? "5432" : url.port);
  if (login.hostname !== local.hostname || portOf(login) !== portOf(local)) {
    env[APPLICATION_DATABASE_URL_VARIABLE] = "";
    return "emptied";
  }

  if (login.pathname === local.pathname) return "kept";

  login.pathname = local.pathname;
  env[APPLICATION_DATABASE_URL_VARIABLE] = login.toString();
  return "repointed";
}

/**
 * Everything a direct invocation decides before it runs a step, in one place
 * that can be tested without spawning anything.
 *
 * Every refusal is decided before the environment is touched, the first
 * being a non-empty `VERCEL_ENV`: under `preview` packages/db reads
 * `REQUESTPORT_PREVIEW_DATABASE_URL` instead of `DATABASE_URL`, so the local
 * string set below would not be the one the suites dial. Once none applies,
 * the steps get: `DATABASE_URL` pointed at the local database; the
 * application login's variable made to agree with it
 * (`alignApplicationLogin`, whose answer the plan carries as
 * `applicationLogin`); `REQUESTPORT_DATABASE_DRIVER=pg`; and, where the tree has a hosted driver,
 * the variable it reads a proxy from (`localProxyVariable`) emptied, not
 * deleted, because the vitest configs of `packages/db` (where the driver's
 * cases live), `packages/auth`, `packages/jobs` and `trigger` call
 * `loadRootEnv`, which fills only unset variables from `.env.local` — and
 * one generated by an older `create-track-worktree.mjs` still names the proxy.
 * Turbo hands the empty value on because
 * `turbo.json` declares the variable (measured with Turbo 2.10.10: a declared
 * empty variable arrives as `""`, an undeclared one not at all).
 */
export function planLocalRun(
  env,
  argv = [],
  listening = localDatabaseListening,
) {
  if (typeof env.VERCEL_ENV === "string" && env.VERCEL_ENV !== "") {
    return { ok: false, reason: LOCAL_VERCEL_ENV_SET };
  }

  const local = localDatabaseFor(env);

  if (!local.ok) return { ok: false, reason: local.reason };

  if (!listening(local.url)) {
    return { ok: false, database: "absent", reason: LOCAL_STACK_ABSENT };
  }

  const chosen = env.REQUESTPORT_DATABASE_DRIVER;
  const driverChosen = typeof chosen === "string" && chosen !== "";

  if (driverChosen && chosen !== LOCAL_DATABASE_DRIVER) {
    return { ok: false, database: "local", reason: LOCAL_DRIVER_NOT_PG };
  }

  env.DATABASE_URL = local.url;
  const applicationLogin = alignApplicationLogin(env, local.url);
  env.REQUESTPORT_DATABASE_DRIVER = LOCAL_DATABASE_DRIVER;
  if (localProxyVariable !== null) env[localProxyVariable] = "";

  const forced = applyForce(env, argv);

  return {
    ok: true,
    database: "local",
    driver: driverChosen ? "configured" : "selected",
    applicationLogin,
    forced,
    steps: stepsFor(argv),
  };
}

/**
 * Whether this run should clear what it left on disk.
 *
 * Only after the browser lanes, and only when they passed. Playwright writes a
 * trace, a screenshot and an error context per failed case into
 * `test-results/`, so clearing them on the one run that produced them would
 * delete the only account of what went wrong. A run that never opened a browser
 * has nothing of its own to clear.
 */
export function artefactsToClearAfter(results) {
  const lanes = results.find((result) => result.id === "browser-lanes");

  return lanes !== undefined && lanes.passed === true;
}

export function invokedDirectly(argv1, moduleUrl) {
  return typeof argv1 === "string" && argv1 === fileURLToPath(moduleUrl);
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  const identity = treeIdentity();
  const env = loadRootEnv();
  const plan = planLocalRun(env, process.argv.slice(2));

  if (!plan.ok) {
    console.error(plan.reason);
    process.exit(1);
  }

  let report;
  try {
    report = runVerification({ env, steps: plan.steps });
  } catch (error) {
    // The database guard refuses by throwing. Its message is the useful part;
    // a stack trace through three modules is not, and reads as a crash in this
    // script rather than as the refusal it is.
    console.error(
      `\nRefused: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }

  if (artefactsToClearAfter(report.results)) {
    // `ARTEFACT_PATHS`, not everything `pnpm clean` removes: the acceptance
    // reports are evidence, and a `--e2e` run sweeping them would delete what
    // a WebKit run carried out of its container.
    const cleared = removeArtefacts(
      artefactPlan(repositoryRoot, existsSync, ARTEFACT_PATHS),
    );
    console.log(
      `\nCleared ${cleared} artefact(s) this run produced. A failing run keeps them.`,
    );
  }

  console.log(`\n${renderRecord(report, identity)}`);

  if (!report.target.ok) {
    console.error(`\nRefused: ${report.target.reason}`);
  } else {
    console.log(
      `\nThe database suites ran on pg (${plan.driver}), straight to the database REQUESTPORT_LOCAL_DATABASE_URL names${localProxyVariable === null ? "." : `; ${localProxyVariable} was emptied, so no step reached a proxy.`}`,
    );
    if (plan.applicationLogin === "repointed") {
      console.log(
        `${APPLICATION_DATABASE_URL_VARIABLE} was pointed at that database, with its own login.`,
      );
    } else if (plan.applicationLogin === "emptied") {
      console.log(
        `${APPLICATION_DATABASE_URL_VARIABLE} named another server, so it was emptied: a storage built from the application's options connected only where a suite, or the application-role lane, set the variable itself.`,
      );
    }
  }

  process.exitCode = report.passed ? 0 : 1;
}
