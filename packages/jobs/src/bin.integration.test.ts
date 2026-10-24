import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  domainEvents,
  organizations,
  outbox,
  ownerCapableVariableNames,
  readDatabaseUrl,
  WORKER_DATABASE_URL_VARIABLES,
  WORKER_GROUP_ROLES,
  type WorkerStorageRole,
} from "@requestport/db";
import { openSession, type TestSession } from "@requestport/db/testing";
import { rootStorageFromEnv } from "@requestport/db/wiring";
import { and, eq, inArray } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  test,
} from "vitest";

// The keys this file reads. vitest.jobs-database-env.ts declares them too;
// that file is outside this package's tsconfig.
declare module "vitest" {
  export interface ProvidedContext {
    jobsDatabaseUrl: string;
    jobsBinDatabaseUrl: string;
  }
}

/*
 * This file's own database (X28, ruling 231). `requestport-jobs` runs every
 * schedule on its database when it starts, so a worker started on the run's
 * database works whatever due rows the files before this one left there, and
 * the case below that asserts nothing failed would fail on their account.
 * The jobs setup (vitest.jobs-database.ts) makes and migrates a second
 * database for this file alone, in a project whose files include this one
 * (ruling 232 item 1). vitest.jobs-database-env.ts has pointed
 * `DATABASE_URL` at the run's database before this module loads; this points
 * it at that second one, so the owner's session, the logins' URLs and every
 * worker this file starts use it. The first case below reads which database
 * the owner's session is on.
 */
const binDatabaseUrl = inject("jobsBinDatabaseUrl");
if (typeof binDatabaseUrl !== "string" || binDatabaseUrl === "") {
  throw new Error(
    "No database of this file's own was provided; vitest.jobs-database.ts makes one only for a project whose files include src/bin.integration.test.ts, as packages/jobs/vitest.config.ts's integration project's do.",
  );
}
process.env.DATABASE_URL = binDatabaseUrl;

const bin = resolve(import.meta.dirname, "../bin/requestport-jobs.mjs");
const children = new Set<ChildProcess>();
const directories: string[] = [];

/*
 * The worker's three logins (Plan 13, I.2b's b5; ruling 214 item 1). Since
 * b5, requestport-jobs refuses to start on pg without them, so the cases
 * that run it make one login in each worker group on this file's database
 * (above), as worker-row-security.integration.test.ts does on the run's:
 * `NOSUPERUSER NOBYPASSRLS`, a member of its group and of nothing else,
 * owning nothing, its name unique to the run, its password made here and
 * never written down. The file drops them when it ends. The owner's session
 * that makes them is checked out of the storage the wiring builds for the
 * worker surface, over `DATABASE_URL`; the executable itself never uses that
 * variable's storage.
 */
let owner: TestSession | undefined;
const logins = {} as Record<WorkerStorageRole, { name: string; url: string }>;

beforeAll(async () => {
  owner = await openSession(rootStorageFromEnv("worker"));
  const { rows } = await owner.query<{ prefix: string }>(
    "select left(current_database(), 24) || '_bin_' || substr(md5(random()::text), 1, 8) as prefix",
  );
  const prefix = rows[0]?.prefix;
  if (!prefix) throw new Error("no prefix for this run's logins");
  const base = readDatabaseUrl(process.env);
  await owner.query("SET scram_iterations = 1");
  try {
    for (const role of Object.keys(WORKER_GROUP_ROLES) as WorkerStorageRole[]) {
      const name = `${prefix}_${role.slice(0, 1)}`;
      const password = randomUUID().replaceAll("-", "");
      await owner.query(
        `create role "${name}" login password '${password}' nosuperuser nobypassrls nocreatedb nocreaterole noreplication in role ${WORKER_GROUP_ROLES[role]}`,
      );
      const url = new URL(base);
      url.username = name;
      url.password = password;
      logins[role] = { name, url: url.toString() };
    }
  } finally {
    await owner.query("RESET scram_iterations").catch(() => undefined);
  }
});

afterAll(async () => {
  if (!owner) return;
  try {
    for (const login of Object.values(logins)) {
      await owner.query(`drop role if exists "${login.name}"`);
    }
  } finally {
    owner.release();
  }
});

/**
 * The names that could carry the owner's connection: `DATABASE_URL`, every
 * `DATABASE_URL_*`, every `PG*` and every `POSTGRES_*`, by the role guard's
 * own `ownerCapableVariableNames`. Since I.2b's b6 the executable refuses to
 * start in an environment naming one, and each worker storage's guard
 * refuses its first use there (ruling 217).
 */
const ownerCapable = (name: string) =>
  ownerCapableVariableNames({ [name]: "" }).length > 0;

/**
 * `process.env` without the owner's names (`ownerCapable`), on pg,
 * selecting the Postgres runner, the three set to this file's logins, and
 * with no Resend key or sender: the worker runs every schedule on its
 * database when it starts, which is this file's own (above), and with no
 * Resend pair no due notification it finds there may reach Resend from it.
 */
function workerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REQUESTPORT_DATABASE_DRIVER: "pg",
    REQUESTPORT_JOB_RUNNER: "postgres",
  };
  for (const name of Object.keys(env)) {
    if (ownerCapable(name)) delete env[name];
  }
  delete env.RESEND_API_KEY;
  delete env.RESEND_FROM_EMAIL;
  for (const role of Object.keys(logins) as WorkerStorageRole[]) {
    env[WORKER_DATABASE_URL_VARIABLES[role]] = logins[role].url;
  }
  return env;
}

/**
 * `workerEnv()` with every other variable whose name ends in `DATABASE_URL`
 * removed too, but the three (`REQUESTPORT_LOCAL_DATABASE_URL`, which names
 * the owner, among them), so nothing in it names a database but the three
 * logins.
 */
function strippedWorkerEnv(): NodeJS.ProcessEnv {
  const env = workerEnv();
  const three = new Set<string>(Object.values(WORKER_DATABASE_URL_VARIABLES));
  for (const name of Object.keys(env)) {
    if (three.has(name)) continue;
    if (ownerCapable(name) || name.endsWith("DATABASE_URL")) delete env[name];
  }
  return env;
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };

function start(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [bin, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<Exit>((resolveExit) => {
    child.on("exit", (code, signal) => {
      children.delete(child);
      resolveExit({ code, signal });
    });
  });
  return {
    child,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function until(condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

/** `until`, for a condition read from the database. */
async function untilRead(condition: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
}

function logEvents(stdout: string) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The events on the lines written so far, not a line still arriving. */
function completeLogEvents(stdout: string) {
  return logEvents(stdout.slice(0, stdout.lastIndexOf("\n") + 1));
}

afterEach(async () => {
  // Nothing this file starts may outlive it.
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("this file's database (X28; ruling 232 item 1)", () => {
  test("the owner's session is on this file's own database, not the run's", async () => {
    const own = decodeURIComponent(new URL(binDatabaseUrl).pathname.slice(1));
    const run = decodeURIComponent(
      new URL(inject("jobsDatabaseUrl")).pathname.slice(1),
    );
    expect(own).not.toBe(run);
    if (!owner) throw new Error("the owner's session was not opened");
    const { rows } = await owner.query<{ name: string }>(
      "select current_database() as name",
    );
    expect(rows[0]?.name).toBe(own);
  });
});

describe("the requestport-jobs executable", () => {
  test("refuses to run unless the environment selects the Postgres runner", async () => {
    const env = { ...process.env };
    delete env.REQUESTPORT_JOB_RUNNER;

    const run = start([], env);
    const exit = await run.exited;

    // Trigger.dev is selected, so Trigger.dev's worker delivers these jobs;
    // a second deliverer claiming the same rows would only compete with it.
    expect(exit.code).toBe(2);
    expect(run.stderr()).toMatch(/REQUESTPORT_JOB_RUNNER=postgres/u);
  });

  test("refuses postgres at boot wherever VERCEL_ENV is set, before starting the worker", async () => {
    const run = start([], {
      ...process.env,
      REQUESTPORT_JOB_RUNNER: "postgres",
      VERCEL_ENV: "production",
    });
    // Raced against the worker starting, not against a clock. The refusal
    // writes to stderr and exits; a worker that starts writes a log event to
    // stdout within milliseconds of starting its loops — `worker.ready` once
    // a tick reaches the database, and before that `worker.tick_failed` and
    // `schedule.failed`, which is all it writes here, because packages/db
    // withholds the local proxy wherever VERCEL_ENV is set. A 10s clock
    // failed the full gate at d06bbc0 on a cold start under load; a slow
    // start now only delays the answer, and the file's test timeout stays
    // the outer bound.
    const started = new Promise<{ started: unknown }>((resolveStarted) => {
      run.child.stdout?.on("data", () => {
        const [event] = completeLogEvents(run.stdout());
        if (event) resolveStarted({ started: event.event });
      });
    });
    const exit = await Promise.race([run.exited, started]);

    expect(exit).toEqual({ code: 2, signal: null });
    expect(run.stderr()).toMatch(
      /REQUESTPORT_JOB_RUNNER=postgres is refused wherever VERCEL_ENV is set/u,
    );
    expect(logEvents(run.stdout())).toEqual([]);
  });

  test("refuses to start on pg without the worker's three logins, naming them, before starting the worker", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REQUESTPORT_DATABASE_DRIVER: "pg",
      REQUESTPORT_JOB_RUNNER: "postgres",
    };
    for (const name of Object.values(WORKER_DATABASE_URL_VARIABLES)) {
      delete env[name];
    }
    const run = start([], env);
    // Raced against the worker starting, as the VERCEL_ENV case above is:
    // before b5 this environment started the worker as the owner.
    const started = new Promise<{ started: unknown }>((resolveStarted) => {
      run.child.stdout?.on("data", () => {
        const [event] = completeLogEvents(run.stdout());
        if (event) resolveStarted({ started: event.event });
      });
    });
    const exit = await Promise.race([run.exited, started]);

    expect(exit).toEqual({ code: 2, signal: null });
    expect(run.stderr()).toContain(
      "requestport-jobs: RequestPort's worker connects as its three roles, and REQUESTPORT_DISPATCHER_DATABASE_URL, REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL and REQUESTPORT_MAINTENANCE_DATABASE_URL are unset. Set all three, each to a login in its worker group.\n",
    );
    expect(logEvents(run.stdout())).toEqual([]);
  });

  test("refuses to start beside a variable that can reach the database as its owner, naming it and never its value, before starting the worker (ruling 217)", async () => {
    const placeholder = "postgres://owner-placeholder@127.0.0.1:1/requestport";
    const run = start([], {
      ...workerEnv(),
      DATABASE_URL_UNPOOLED: placeholder,
    });
    const started = new Promise<{ started: unknown }>((resolveStarted) => {
      run.child.stdout?.on("data", () => {
        const [event] = completeLogEvents(run.stdout());
        if (event) resolveStarted({ started: event.event });
      });
    });
    const exit = await Promise.race([run.exited, started]);

    expect(exit).toEqual({ code: 2, signal: null });
    expect(run.stderr()).toContain(
      "requestport-jobs: this environment names DATABASE_URL_UNPOOLED, which can reach the database as its owner. The worker connects only as its three logins and refuses to start beside it: remove it from the worker's environment.\n",
    );
    expect(run.stderr()).not.toContain(placeholder);
    expect(logEvents(run.stdout())).toEqual([]);
  });

  test("signals readiness, then drains and exits cleanly on SIGTERM", async () => {
    const directory = mkdtempSync(join(tmpdir(), "requestport-jobs-"));
    directories.push(directory);
    const readyFile = join(directory, "ready");
    const run = start(["--ready-file", readyFile], workerEnv());

    await until(() => existsSync(readyFile), 25_000);
    expect(readFileSync(readyFile, "utf8").trim()).toBe(String(run.child.pid));
    // The log line and the file come from the same readiness; the pipe may
    // deliver the line a moment after the file appears.
    await until(() => run.stdout().includes('"worker.ready"'), 5_000);
    expect(logEvents(run.stdout())).toContainEqual(
      expect.objectContaining({ event: "worker.ready", status: "ready" }),
    );

    run.child.kill("SIGTERM");
    const exit = await run.exited;

    expect(exit).toEqual({ code: 0, signal: null });
    expect(existsSync(readyFile)).toBe(false);
    expect(logEvents(run.stdout())).toContainEqual(
      expect.objectContaining({ event: "worker.stopped", status: "drained" }),
    );
  });

  test("a SIGTERM and a SIGINT sent together are one stop, as a terminal's Ctrl-C passed on by pnpm or npm arrives: it logs worker.stop_repeated, drains, removes its ready file and exits 0 (ruling 246)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "requestport-jobs-"));
    directories.push(directory);
    const readyFile = join(directory, "ready");
    const run = start(["--ready-file", readyFile], workerEnv());

    await until(() => existsSync(readyFile), 25_000);
    // Two different signals, so neither can merge into the other while both
    // are pending; which of the two the process takes first is the kernel's.
    run.child.kill("SIGTERM");
    run.child.kill("SIGINT");
    const exit = await run.exited;

    expect(exit).toEqual({ code: 0, signal: null });
    expect(existsSync(readyFile)).toBe(false);
    const stops = logEvents(run.stdout()).filter((event) =>
      [
        "worker.stopping",
        "worker.stop_repeated",
        "worker.stopped",
        "worker.forced_exit",
      ].includes(String(event.event)),
    );
    expect(stops.map((event) => event.event)).toEqual([
      "worker.stopping",
      "worker.stop_repeated",
      "worker.stopped",
    ]);
    expect(
      stops
        .slice(0, 2)
        .map((event) => event.status)
        .sort(),
    ).toEqual(["sigint", "sigterm"]);
    expect(stops[2]).toMatchObject({ status: "drained" });
  });

  test("with DATABASE_URL, every DATABASE_URL_*, PG* and POSTGRES_*, and every other variable naming a database removed, it starts as its three logins, routes a committed event, whose routing parses the configuration, and drains and exits cleanly", {
    timeout: 120_000,
  }, async () => {
    const env = strippedWorkerEnv();

    expect(Object.keys(env).filter(ownerCapable)).toEqual([]);
    expect(
      Object.keys(env)
        .filter((name) => name.endsWith("DATABASE_URL"))
        .sort(),
    ).toEqual(Object.values(WORKER_DATABASE_URL_VARIABLES).sort());

    // Seeded as the owner, in this process: an organisation and, once the
    // worker is ready, one committed event, registered with no webhook
    // subscription or notification behind it, as worker.integration.test.ts
    // seeds one. Routing it reads the configuration's public URL
    // (`outbox-delivery.ts`), so the worker parses its configuration, with no
    // DATABASE_URL to parse.
    const database = rootStorageFromEnv("worker").db;
    const organizationId = randomUUID();
    const eventId = randomUUID();
    await database.insert(organizations).values({
      id: organizationId,
      name: "requestport-jobs, owner's names removed",
      slug: `bin-stripped-${organizationId}`,
      status: "active",
    });
    let outboxId: string | undefined;
    try {
      const directory = mkdtempSync(join(tmpdir(), "requestport-jobs-"));
      directories.push(directory);
      const readyFile = join(directory, "ready");
      const run = start(["--ready-file", readyFile], env);

      await until(() => existsSync(readyFile), 25_000);
      await database.insert(domainEvents).values({
        id: eventId,
        organizationId,
        aggregateType: "organization",
        aggregateId: organizationId,
        aggregateVersion: 1,
        type: "retention.hold_changed.v1",
        schemaVersion: 1,
        actor: { type: "system", id: "bin-integration-test" },
        correlationId: `corr_${eventId}`,
        causationId: `cause_${eventId}`,
        data: { category: "all", status: "active" },
      });
      const [row] = await database
        .insert(outbox)
        .values({ eventId })
        .returning({ id: outbox.id });
      const id = row?.id;
      if (!id) throw new Error("outbox row was not created");
      outboxId = id;
      const state = async () =>
        (
          await database
            .select({ state: outbox.state })
            .from(outbox)
            .where(eq(outbox.id, id))
        )[0]?.state;
      const events = () => logEvents(run.stdout());

      // Routed, or a failed routing's retry, whichever is first.
      await untilRead(
        async () =>
          (await state()) === "completed" ||
          events().some(
            (event) =>
              event.event === "outbox.retry_scheduled" && event.outboxId === id,
          ),
        45_000,
      );

      expect(await state(), run.stdout().slice(-4_000)).toBe("completed");
      expect(events()).toContainEqual(
        expect.objectContaining({
          event: "outbox.routed",
          outboxId: id,
          status: "routed",
        }),
      );

      run.child.kill("SIGTERM");
      const exit = await run.exited;

      expect(exit).toEqual({ code: 0, signal: null });
      expect(events()).toContainEqual(
        expect.objectContaining({ event: "worker.stopped", status: "drained" }),
      );
      expect(
        events().filter(
          (event) =>
            event.level === "error" ||
            [
              "worker.tick_failed",
              "schedule.failed",
              "job.failed",
              "job.timed_out",
            ].includes(String(event.event)),
        ),
      ).toEqual([]);
    } finally {
      // No row this case made may stay claimable for the case after it,
      // whose worker runs on the same database.
      if (outboxId) {
        await database
          .update(outbox)
          .set({ state: "completed", leaseOwner: null, leaseExpiresAt: null })
          .where(
            and(
              eq(outbox.id, outboxId),
              inArray(outbox.state, ["pending", "leased", "accepted"]),
            ),
          );
      }
    }
  });

  test("declares the worker database surface before its first query, and each storage it uses passes its role check in enforce mode, as its own login, with one info line on standard output", async () => {
    // The worker process has no `test` declaration: it is not a Vitest
    // worker. Each storage's first use runs its role guard's check, which
    // writes one line when it passes, naming the storage, the login it acts
    // as, the surface it found declared and the mode the check ran in
    // (`announcePassed`): enforce, the worker's since I.2b's b5, which the
    // executable hands no mode to change (ruling 214 item 2). Had the
    // declaration come after that first use, the storage's guard would have
    // refused that use as undeclared. The line is written with console.info,
    // so it is on standard output beside the worker's own log, and nothing
    // the guard writes is on standard error (ruling 215 item 7).
    const directory = mkdtempSync(join(tmpdir(), "requestport-jobs-"));
    directories.push(directory);
    const readyFile = join(directory, "ready");
    const run = start(["--ready-file", readyFile], workerEnv());

    await until(() => existsSync(readyFile), 25_000);
    await until(() => run.stdout().includes('"storage":"dispatcher"'), 5_000);
    run.child.kill("SIGTERM");
    await run.exited;

    expect(run.stderr()).not.toContain("database.role_guard");
    const guard = run
      .stdout()
      .split("\n")
      .filter((line) => line.startsWith('{"level"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => String(event.event).startsWith("database.role_guard"));

    expect(guard.map((event) => event.storage)).toContain("dispatcher");
    // One line per storage: a passed check writes once.
    expect(new Set(guard.map((event) => event.storage)).size).toBe(
      guard.length,
    );
    for (const event of guard) {
      expect(event).toMatchObject({
        level: "info",
        event: "database.role_guard.role",
        status: "passed",
        mode: "enforce",
        surface: "worker",
        objections: [],
      });
      expect(event.role, String(event.storage)).toBe(
        logins[event.storage as WorkerStorageRole]?.name,
      );
    }
  });
});
