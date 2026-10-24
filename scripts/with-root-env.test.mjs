import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SHARED_DATABASE_LIST_MALFORMED } from "./production-database-guard.mjs";
import * as withRootEnv from "./with-root-env.mjs";
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

/**
 * The entry's rejection handler prints a refusal's own message, one line, and
 * exits 1. Without the handler, the same refusal is an unhandled rejection:
 * Node prints the source line, a caret and a stack, and also exits 1, so only
 * the exact output tells the two apart. The wrapper and its local imports run
 * from a scratch checkout whose `hosted-deployment.mjs` holds a
 * shared-database list of the wrong shape, which the guard refuses for every
 * command.
 */
test("a refusal before the spawn prints its own one line and nothing more, exits 1, and starts nothing", (t) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "requestport-with-root-env-refusal-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  for (const name of [
    "with-root-env.mjs",
    "owner-capable-variables.mjs",
    "production-database-guard.mjs",
  ]) {
    copyFileSync(join("scripts", name), join(root, "scripts", name));
  }
  writeFileSync(
    join(root, "scripts", "hosted-deployment.mjs"),
    'export const kind = "public";\nexport const sharedDatabases = null;\nexport const migrationState = null;\n',
  );
  const sentinel = join(root, "child-ran");

  const result = spawnSync(
    process.execPath,
    [
      join(root, "scripts", "with-root-env.mjs"),
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${SHARED_DATABASE_LIST_MALFORMED}\n`);
  assert.equal(existsSync(sentinel), false, "the wrapped command ran");
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

/*
 * How the wrapper ends, and what it does with a stop signal (ruling 246,
 * closing the open half of ruling 242 item 4): it passes SIGINT, SIGTERM and
 * SIGHUP on to its command. The cases from here to the `passSignalsOn` case
 * start the real wrapper in this checkout over `SIGNAL_RECORDER`; that case
 * and the `run` cases after it hand the code a fake child and a fake source
 * of signals.
 */

/**
 * SIGINT, SIGTERM and SIGHUP: the signals the cases below send to the real
 * wrapper or emit on a fake source, and whose handlers they wait for or
 * count.
 */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** How long a case waits for a line from the command before it fails. */
const WAIT_MS = 15_000;

/**
 * The command these cases run under the wrapper. It prints `ready <pid>`,
 * then `got <signal>` for each SIGINT, SIGTERM or SIGHUP it receives, and
 * runs until a line on its standard input, which it inherits from the
 * wrapper, says how to end: `exit <code>`, or `die <signal>`, which removes
 * its handlers and sends itself that signal.
 */
const SIGNAL_RECORDER = `
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of signals) {
  process.on(signal, () => process.stdout.write("got " + signal + "\\n"));
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const end = input.indexOf("\\n");
  if (end === -1) return;
  const [how, value] = input.slice(0, end).split(" ");
  if (how === "die") {
    for (const signal of signals) process.removeAllListeners(signal);
    process.kill(process.pid, value);
  } else {
    process.exit(Number(value));
  }
});
process.stdout.write("ready " + process.pid + "\\n");
`;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A module the wrapper's Node loads first (`--import`) when a case traces
 * it, changing nothing else: on the wrapper's standard error it writes
 * `listen <signal>` once a handler for SIGINT, SIGTERM or SIGHUP is set on
 * the wrapper, and `kill <signal> <answer>` for each `ChildProcess#kill`
 * call. Only the wrapper loads it; its command is started without it.
 *
 * The cases that signal the wrapper wait for its three `listen` lines first.
 * The command can print `ready` before the wrapper has set its handlers,
 * since they are set only once the spawn has returned to it, and a signal
 * sent before that ends the wrapper as Node's default does.
 */
const SIGNAL_TRACE = `data:text/javascript,${encodeURIComponent(`
import { ChildProcess } from "node:child_process";
const kill = ChildProcess.prototype.kill;
ChildProcess.prototype.kill = function (signal) {
  const answer = kill.call(this, signal);
  process.stderr.write("kill " + signal + " " + answer + "\\n");
  return answer;
};
process.on("newListener", (event) => {
  if (["SIGINT", "SIGTERM", "SIGHUP"].includes(event)) {
    process.stderr.write("listen " + event + "\\n");
  }
});
`)}`;

/**
 * The wrapper over `SIGNAL_RECORDER`, started in this checkout. With
 * `detached`, the wrapper leads a process group of its own, so a signal sent
 * to `-wrapper.pid` reaches the wrapper and its command and nothing else.
 * With `trace`, the wrapper loads `SIGNAL_TRACE`. Whatever of the wrapper and
 * its command is still running when the case ends is sent SIGKILL.
 */
function startWrapped(t, { detached = false, trace = false } = {}) {
  const wrapper = spawn(
    process.execPath,
    [
      ...(trace ? ["--import", SIGNAL_TRACE] : []),
      "scripts/with-root-env.mjs",
      process.execPath,
      "-e",
      SIGNAL_RECORDER,
    ],
    {
      cwd: process.cwd(),
      detached,
      env: hermeticEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  let commandPid;
  const lookers = new Set();
  wrapper.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    for (const look of lookers) look();
  });
  wrapper.stderr.setEncoding("utf8").on("data", (chunk) => {
    errors += chunk;
    for (const look of lookers) look();
  });
  wrapper.stdin.on("error", () => undefined);
  const closed = new Promise((settle) => {
    wrapper.once("close", (code, signal) => settle({ code, signal }));
  });
  t.after(() => {
    for (const pid of [wrapper.pid, commandPid]) {
      if (pid !== undefined && isAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  /**
   * The first match of `pattern` on the command's output (or, with
   * `fromStandardError`, on standard error), once it is there.
   */
  const lineFor = (pattern, { fromStandardError = false } = {}) =>
    new Promise((settle, fail) => {
      const text = () => (fromStandardError ? errors : output);
      const timer = setTimeout(() => {
        lookers.delete(look);
        fail(
          new Error(
            `no line matching ${pattern} within ${WAIT_MS} ms; ${fromStandardError ? "standard error" : "the command's output"} was ${JSON.stringify(text())}`,
          ),
        );
      }, WAIT_MS);
      const look = () => {
        const match = text().match(pattern);
        if (!match) return;
        lookers.delete(look);
        clearTimeout(timer);
        settle(match);
      };
      lookers.add(look);
      look();
    });

  return {
    wrapper,
    closed,
    lineFor,
    async ready() {
      const [, pid] = await lineFor(/^ready (\d+)$/mu);
      commandPid = Number(pid);
      return commandPid;
    },
    /** Once the wrapper has set its three handlers (`SIGNAL_TRACE`). */
    async handlersSet() {
      for (const signal of STOP_SIGNALS) {
        await lineFor(new RegExp(`^listen ${signal}$`, "mu"), {
          fromStandardError: true,
        });
      }
    },
    tell: (line) => wrapper.stdin.write(`${line}\n`),
    received: (signal) =>
      (output.match(new RegExp(`^got ${signal}$`, "gmu")) ?? []).length,
    /** The wrapper's `kill` calls, as `SIGNAL_TRACE` wrote them. */
    kills: () => errors.match(/^kill \S+ \S+$/gmu) ?? [],
  };
}

for (const [signal, status] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
  ["SIGKILL", 137],
]) {
  test(`exits ${status} when its command ends by ${signal}: 128 plus the signal's number, as a shell reports it`, {
    timeout: 60_000,
  }, async (t) => {
    const run = startWrapped(t);
    await run.ready();

    run.tell(`die ${signal}`);

    assert.deepEqual(await run.closed, { code: status, signal: null });
  });
}

test("passes its command's exit code through", {
  timeout: 60_000,
}, async (t) => {
  for (const code of [0, 7]) {
    const run = startWrapped(t);
    await run.ready();

    run.tell(`exit ${code}`);

    assert.deepEqual(await run.closed, { code, signal: null });
  }
});

for (const signal of STOP_SIGNALS) {
  test(`passes ${signal}, sent to the wrapper's pid alone, on to its command once, stays until the command closes, and leaves nothing running`, {
    timeout: 60_000,
  }, async (t) => {
    const run = startWrapped(t, { trace: true });
    const commandPid = await run.ready();
    await run.handlersSet();

    run.wrapper.kill(signal);
    await run.lineFor(new RegExp(`^got ${signal}$`, "mu"));
    assert.deepEqual(
      [run.wrapper.exitCode, run.wrapper.signalCode],
      [null, null],
      "the wrapper ended before its command",
    );
    run.tell("exit 0");

    assert.deepEqual(await run.closed, { code: 0, signal: null });
    assert.equal(run.received(signal), 1);
    assert.deepEqual(run.kills(), [`kill ${signal} true`]);
    assert.equal(isAlive(commandPid), false, "the command is still running");
  });
}

for (const [signal, other] of [
  ["SIGINT", "SIGTERM"],
  ["SIGTERM", "SIGHUP"],
  ["SIGHUP", "SIGINT"],
]) {
  test(`passes ${signal}, sent to the wrapper's pid twice, on once, and ${other}, sent after it, on as well`, {
    timeout: 60_000,
  }, async (t) => {
    const run = startWrapped(t, { trace: true });
    await run.ready();
    await run.handlersSet();

    run.wrapper.kill(signal);
    await run.lineFor(new RegExp(`^got ${signal}$`, "mu"));
    run.wrapper.kill(signal);
    run.wrapper.kill(other);
    await run.lineFor(new RegExp(`^got ${other}$`, "mu"));
    // A second of room for the repeat, sent before `other`, to reach the
    // command if it were passed on; the passSignalsOn case below pins the
    // same with no clock.
    await new Promise((settle) => setTimeout(settle, 1000));
    run.tell("exit 0");

    assert.deepEqual(await run.closed, { code: 0, signal: null });
    assert.equal(
      run.received(signal),
      1,
      `${signal} reached the command again`,
    );
    assert.equal(run.received(other), 1);
    assert.deepEqual(run.kills(), [
      `kill ${signal} true`,
      `kill ${other} true`,
    ]);
  });
}

for (const signal of STOP_SIGNALS) {
  test(`${signal} sent to the wrapper's process group reaches its command from the group and again from the wrapper, which passes it on once and stays until the command closes`, {
    timeout: 60_000,
  }, async (t) => {
    const run = startWrapped(t, { detached: true, trace: true });
    const commandPid = await run.ready();
    await run.handlersSet();

    process.kill(-run.wrapper.pid, signal);
    await run.lineFor(new RegExp(`^got ${signal}$`, "mu"));
    // A second of room for the wrapper's copy to arrive after the group's.
    await new Promise((settle) => setTimeout(settle, 1000));
    assert.deepEqual(
      [run.wrapper.exitCode, run.wrapper.signalCode],
      [null, null],
      "the wrapper ended before its command",
    );
    run.tell("exit 0");

    assert.deepEqual(await run.closed, { code: 0, signal: null });
    assert.deepEqual(run.kills(), [`kill ${signal} true`]);
    // Two copies were sent. The command's handler runs twice, unless the
    // wrapper's copy reached it while the group's was still pending: the
    // kernel holds one pending copy of each signal, so the two are then
    // delivered as one.
    assert.ok(
      [1, 2].includes(run.received(signal)),
      `${signal} reached the command ${run.received(signal)} times`,
    );
    assert.equal(isAlive(commandPid), false, "the command is still running");
  });
}

/** How many handlers `signals` holds for each of SIGINT, SIGTERM and SIGHUP. */
function handlerCounts(signals) {
  return STOP_SIGNALS.map((signal) => signals.listenerCount(signal));
}

test("passSignalsOn passes the first SIGINT, SIGTERM and SIGHUP on with child.kill, passes no repeat of one on, and its answer removes its three handlers", () => {
  const signals = new EventEmitter();
  const sent = [];

  const stopPassing = withRootEnv.passSignalsOn(
    Object.assign(new EventEmitter(), { kill: (signal) => sent.push(signal) }),
    signals,
  );
  assert.deepEqual(handlerCounts(signals), [1, 1, 1]);
  for (const signal of [
    "SIGTERM",
    "SIGTERM",
    "SIGINT",
    "SIGHUP",
    "SIGINT",
    "SIGHUP",
    "SIGTERM",
  ]) {
    signals.emit(signal);
  }
  assert.deepEqual(sent, ["SIGTERM", "SIGINT", "SIGHUP"]);

  stopPassing();
  assert.deepEqual(handlerCounts(signals), [0, 0, 0]);
});

for (const [ending, end, status] of [
  ["closes by SIGTERM", (child) => child.emit("close", null, "SIGTERM"), 143],
  ["closes with exit code 3", (child) => child.emit("close", 3, null), 3],
  [
    "fails to start",
    (child) => child.emit("error", new Error("spawn command ENOENT")),
    1,
  ],
]) {
  test(`run sets the three handlers only once its command is spawned, and removes them when the command ${ending}`, async (t) => {
    const errors = t.mock.method(console, "error", () => undefined);
    const signals = new EventEmitter();
    // A command that started has a pid; one that failed to start has none.
    const child = Object.assign(new EventEmitter(), {
      kill: () => true,
      pid: ending === "fails to start" ? undefined : 4242,
    });
    let atSpawn;

    const exitStatus = withRootEnv.run(
      "command",
      ["argument"],
      {},
      {
        environment: { DATABASE_URL: "" },
        signals,
        spawnChild: () => {
          atSpawn = handlerCounts(signals);
          return child;
        },
      },
    );
    assert.deepEqual(atSpawn, [0, 0, 0]);
    assert.deepEqual(handlerCounts(signals), [1, 1, 1]);
    end(child);

    assert.equal(await exitStatus, status);
    assert.deepEqual(handlerCounts(signals), [0, 0, 0]);
    assert.deepEqual(
      errors.mock.calls.map((call) => call.arguments),
      ending === "fails to start"
        ? [["RequestPort child command failed to start."]]
        : [],
    );
  });
}

/**
 * A command that has started, whose `kill` fails as Node's
 * `ChildProcess#kill` does on EPERM: it emits `error` from inside the call,
 * then answers false. EPERM is what `kill` gets once the command runs as
 * another user, as one started by `sudo` does.
 */
function commandThatCannotBeSignalled() {
  const child = Object.assign(new EventEmitter(), { pid: 4242, tried: [] });
  child.kill = (signal) => {
    child.tried.push(signal);
    child.emit(
      "error",
      Object.assign(new Error("kill EPERM"), {
        code: "EPERM",
        errno: -1,
        syscall: "kill",
      }),
    );
    return false;
  };
  return child;
}

test("a pass-on that fails after the spawn is not a start failure: run writes one line naming the signal and the error's code, and goes on waiting for its command", async (t) => {
  const errors = t.mock.method(console, "error", () => undefined);
  const signals = new EventEmitter();
  const child = commandThatCannotBeSignalled();

  const exitStatus = withRootEnv.run(
    "command",
    ["argument"],
    {},
    { environment: { DATABASE_URL: "" }, signals, spawnChild: () => child },
  );
  signals.emit("SIGTERM");
  signals.emit("SIGTERM");
  const settledYet = await Promise.race([
    exitStatus.then(() => "settled"),
    new Promise((settle) => setImmediate(() => settle("waiting"))),
  ]);

  assert.equal(settledYet, "waiting", "run answered before its command closed");
  assert.deepEqual(child.tried, ["SIGTERM"]);
  assert.deepEqual(handlerCounts(signals), [1, 1, 1]);
  assert.deepEqual(
    errors.mock.calls.map((call) => call.arguments),
    [
      [
        "with-root-env: could not pass SIGTERM on to its command (EPERM); waiting for it to close.",
      ],
    ],
  );

  child.emit("close", 0, null);

  assert.equal(await exitStatus, 0);
  assert.deepEqual(handlerCounts(signals), [0, 0, 0]);
  assert.equal(errors.mock.callCount(), 1);
});
