import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, connect as openSocket } from "node:net";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { readSignInMethods } from "../packages/config/src/sign-in-methods.ts";
import {
  answersOnPort,
  RELEASE_ATTEMPTS,
  runSignInCombinations,
  SERVER_START_BUDGET_MS,
  SIGN_IN_BASE_URL,
  SIGN_IN_COMBINATION_VARIABLE,
  SIGN_IN_COMBINATIONS,
  SIGN_IN_DECIDED_VARIABLES,
  SIGN_IN_HOST,
  SIGN_IN_PORT,
  SIGN_IN_PROJECT,
  serverCommand,
  serving,
  signInCombinationEnvironment,
  signInCombinationTag,
  spawnServer,
  specCommand,
  stopServerGroup,
} from "./run-sign-in-combinations.mjs";
import {
  ACCEPTANCE_LOGIN_NAME_QUERY,
  ACCEPTANCE_LOGIN_PRESENT_QUERY,
  acceptanceLoginExists,
  plannedCommands,
  repositoryRoot,
} from "./start-e2e-server.mjs";

/*
 * Offline: nothing here starts the acceptance server, touches port 3100,
 * reaches a database or opens a browser. The runner's sequence is driven
 * through fakes, and Playwright is asked only to load its configuration and
 * list cases (`--list`), which launches no browser and, with no web server
 * declared or none started by a listing, starts nothing.
 *
 * The stop and the port probe are run for real: the stop against small node
 * processes `spawnServer` starts in place of the server, the probe against
 * ports the system assigns (port 0) on 127.0.0.1.
 */

const webDirectory = resolve(repositoryRoot, "apps/web");
const playwrightCli = createRequire(
  pathToFileURL(resolve(webDirectory, "package.json")).href,
).resolve("@playwright/test/cli");
const runnerUrl = pathToFileURL(
  resolve(repositoryRoot, "scripts/run-sign-in-combinations.mjs"),
).href;

const localOwner =
  "postgres://requestport:requestport_local@127.0.0.1:55433/rp_sign_in_offline";
const token = "offline-token-that-is-at-least-thirty-two-characters";

/** What a checkout's `.env.local` might hand down, every decided name set. */
const inherited = Object.freeze({
  DATABASE_URL: localOwner,
  GITHUB_CLIENT_ID: "inherited-github-client",
  GITHUB_CLIENT_SECRET: "inherited-github-secret",
  KEPT_SETTING: "kept",
  RESEND_API_KEY: "inherited-resend-key",
  RESEND_FROM_EMAIL: "inherited@example.invalid",
  REQUESTPORT_LOCAL_CREDENTIAL: "disabled",
  VERCEL_ENV: "development",
});

const expectedMethods = {
  none: { github: false, localCredential: true, magicLink: false },
  github: { github: true, localCredential: false, magicLink: false },
  "magic-link": { github: false, localCredential: false, magicLink: true },
  both: { github: true, localCredential: false, magicLink: true },
};

function decided(environment) {
  return Object.fromEntries(
    SIGN_IN_DECIDED_VARIABLES.filter((name) => name in environment).map(
      (name) => [name, environment[name]],
    ),
  );
}

describe("the four combinations", () => {
  test("run in the order none, GitHub, magic link, both", () => {
    assert.deepEqual(
      SIGN_IN_COMBINATIONS.map(({ name }) => name),
      ["none", "github", "magic-link", "both"],
    );
  });

  test("each sets exactly its own pairs, and replaces whatever was inherited", () => {
    const github = {
      GITHUB_CLIENT_ID: "e2e-sign-in-not-a-github-client",
      GITHUB_CLIENT_SECRET: "e2e-sign-in-not-a-github-secret",
    };
    const magicLink = {
      RESEND_API_KEY: "e2e-sign-in-not-a-resend-key",
      RESEND_FROM_EMAIL: "sign-in-combinations@example.invalid",
    };
    const expected = {
      none: {},
      github,
      "magic-link": magicLink,
      both: { ...github, ...magicLink },
    };

    for (const combination of SIGN_IN_COMBINATIONS) {
      const environment = signInCombinationEnvironment(combination, {
        baseEnvironment: inherited,
        token,
      });
      assert.deepEqual(
        decided(environment),
        expected[combination.name],
        combination.name,
      );
      assert.equal(environment[SIGN_IN_COMBINATION_VARIABLE], combination.name);
      assert.equal(environment.KEPT_SETTING, "kept");
      assert.equal(environment.DATABASE_URL, localOwner);
      assert.equal(environment.NODE_ENV, "test");
      assert.equal(environment.REQUESTPORT_E2E_MODE, "1");
      assert.equal(environment.REQUESTPORT_E2E_TOKEN, token);
    }
  });

  test("offer what the spec expects under the rule the page reads", () => {
    // The local credential's switch and VERCEL_ENV are among the removed
    // names: inherited, either would turn the credential off in "none".
    for (const combination of SIGN_IN_COMBINATIONS) {
      assert.deepEqual(
        readSignInMethods(
          signInCombinationEnvironment(combination, {
            baseEnvironment: inherited,
            token,
          }),
        ),
        expectedMethods[combination.name],
        combination.name,
      );
    }
    assert.deepEqual([...SIGN_IN_DECIDED_VARIABLES].toSorted(), [
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "REQUESTPORT_LOCAL_CREDENTIAL",
      "RESEND_API_KEY",
      "RESEND_FROM_EMAIL",
      "VERCEL_ENV",
    ]);
  });

  test("name one port, 3100, the port start-e2e-server.mjs serves on", () => {
    assert.equal(SIGN_IN_PORT, 3100);
    assert.equal(SIGN_IN_BASE_URL, "http://127.0.0.1:3100");
    for (const combination of SIGN_IN_COMBINATIONS) {
      const environment = signInCombinationEnvironment(combination, {
        baseEnvironment: inherited,
        token,
      });
      assert.equal(environment.BETTER_AUTH_URL, SIGN_IN_BASE_URL);
      assert.equal(environment.NEXT_PUBLIC_APP_URL, SIGN_IN_BASE_URL);
    }
    const [start] = plannedCommands(true);
    const flag = (name) => start.args[start.args.indexOf(name) + 1];
    assert.equal(flag("--hostname"), "127.0.0.1");
    assert.equal(flag("--port"), String(SIGN_IN_PORT));
  });

  test("refuse an E2E token shorter than the outbox admits", () => {
    assert.throws(
      () =>
        signInCombinationEnvironment(SIGN_IN_COMBINATIONS[0], {
          baseEnvironment: inherited,
          token: "short",
        }),
      /32 characters/u,
    );
  });
});

describe("the commands", () => {
  test("start each server from start-e2e-server.mjs, never through with-root-env.mjs", () => {
    // with-root-env.mjs fills every unset name from .env.local, so it would
    // put back the pairs a combination removed.
    const { args, command } = serverCommand();
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [
      resolve(repositoryRoot, "scripts/start-e2e-server.mjs"),
    ]);
  });

  test("run the spec as the sign-in project, selecting one combination by its tag", () => {
    for (const combination of SIGN_IN_COMBINATIONS) {
      assert.deepEqual(specCommand(combination), {
        args: [
          "--filter",
          "@requestport/web",
          "run",
          "test:e2e",
          "--project",
          SIGN_IN_PROJECT,
          "--grep",
          signInCombinationTag(combination.name),
        ],
        command: "pnpm",
      });
    }
    // --grep searches; no tag may be found inside another.
    const tags = SIGN_IN_COMBINATIONS.map(({ name }) =>
      signInCombinationTag(name),
    );
    for (const tag of tags) {
      assert.deepEqual(
        tags.filter((other) => other.includes(tag)),
        [tag],
      );
    }
  });
});

/**
 * Runs the runner over fakes and keeps what each was asked, in order.
 * `portTaken` and `loginPresent` are asked with the number of times each has
 * been asked before.
 */
async function fakeRun({
  baseEnvironment = inherited,
  loginPresent = () => false,
  portTaken = () => false,
  serverReady = () => true,
  specExit = () => 0,
} = {}) {
  const events = [];
  const environments = [];
  const records = [];
  let live = 0;
  let mostLive = 0;
  let portAsks = 0;
  let loginAsks = 0;
  let sleeps = 0;
  let tokens = 0;

  const exitCode = await runSignInCombinations({
    baseEnvironment,
    createToken: () => {
      tokens += 1;
      return `offline-token-${tokens}-that-is-longer-than-thirty-two`;
    },
    log: () => undefined,
    loginExists: async (ownerUrl) => {
      events.push(`login ${ownerUrl === localOwner ? "owner" : ownerUrl}`);
      return loginPresent(loginAsks++);
    },
    portAnswers: async (port) => {
      events.push(`port ${port}`);
      return portTaken(portAsks++);
    },
    record: (runDirectory, summary) => {
      records.push({ runDirectory, summary });
    },
    runDirectory: "/offline/run",
    runSpec: async (combination, environment) => {
      events.push(`spec ${combination.name}`);
      environments.push({ name: combination.name, spec: environment });
      return specExit(combination.name);
    },
    sleep: async () => {
      sleeps += 1;
    },
    startServer: (environment) => {
      live += 1;
      mostLive = Math.max(mostLive, live);
      const name = environment[SIGN_IN_COMBINATION_VARIABLE];
      events.push(`start ${name}`);
      environments.push({ name, server: environment });
      return { name };
    },
    stopServer: async (server) => {
      live -= 1;
      events.push(`stop ${server.name}`);
    },
    waitForServer: async (server) => {
      events.push(`ready ${server.name}`);
      return serverReady(server.name)
        ? { ready: true }
        : { ready: false, reason: "planted" };
    },
  });

  return { environments, events, exitCode, live, mostLive, records, sleeps };
}

describe("one server at a time on port 3100", () => {
  test("starts, runs, stops and releases each combination before the next", async () => {
    const run = await fakeRun();
    const each = (name) => [
      `start ${name}`,
      `ready ${name}`,
      `spec ${name}`,
      `stop ${name}`,
      "port 3100",
      "login owner",
    ];

    assert.equal(run.exitCode, 0);
    assert.deepEqual(run.events, [
      "port 3100",
      ...each("none"),
      ...each("github"),
      ...each("magic-link"),
      ...each("both"),
    ]);
    assert.equal(run.mostLive, 1);
    assert.equal(run.live, 0);
  });

  test("hands each spec the environment its server was started with", async () => {
    const run = await fakeRun();
    const tokens = new Set();

    for (const { name } of SIGN_IN_COMBINATIONS) {
      const server = run.environments.find(
        (entry) => entry.name === name && entry.server,
      ).server;
      const spec = run.environments.find(
        (entry) => entry.name === name && entry.spec,
      ).spec;
      assert.equal(spec, server, name);
      assert.equal(server.REQUESTPORT_E2E_RUN_DIRECTORY, "/offline/run");
      tokens.add(server.REQUESTPORT_E2E_TOKEN);
    }
    assert.equal(tokens.size, SIGN_IN_COMBINATIONS.length);
  });

  test("refuses to start anything while port 3100 is taken", async () => {
    const run = await fakeRun({ portTaken: () => true });

    assert.equal(run.exitCode, 1);
    assert.deepEqual(run.events, ["port 3100"]);
    const [{ summary }] = run.records;
    assert.match(summary.refusal, /port 3100/u);
    assert.deepEqual(
      summary.combinations.map(({ outcome }) => outcome),
      ["not run", "not run", "not run", "not run"],
    );
  });

  test("starts no second server while the first still holds the port", async () => {
    const run = await fakeRun({ portTaken: (asked) => asked > 0 });

    assert.equal(run.exitCode, 1);
    assert.deepEqual(
      run.events.filter((event) => event.startsWith("start")),
      ["start none"],
    );
    assert.equal(run.sleeps, RELEASE_ATTEMPTS);
    const [{ summary }] = run.records;
    assert.match(
      summary.refusal,
      /none server was stopped, but port 3100 still answers/u,
    );
    assert.deepEqual(
      summary.combinations.map(({ outcome }) => outcome),
      ["passed", "not run", "not run", "not run"],
    );
    for (const entry of summary.combinations.slice(1)) {
      assert.equal(entry.detail, "the run stopped after the none server");
    }
  });

  test("starts no second server while the first's acceptance login remains", async () => {
    // The stopped server's watcher drops a login of the name the next server
    // creates, so a drop still to come would take the next server's login.
    const run = await fakeRun({ loginPresent: () => true });

    assert.equal(run.exitCode, 1);
    assert.deepEqual(
      run.events.filter((event) => event.startsWith("start")),
      ["start none"],
    );
    const [{ summary }] = run.records;
    assert.match(summary.refusal, /acceptance login has not been dropped/u);
  });

  test("asks for the login by the name start-e2e-server.mjs creates it under", () => {
    // The query itself is offline here; acceptanceLoginExists runs it.
    assert.ok(
      ACCEPTANCE_LOGIN_PRESENT_QUERY.includes(
        `(${ACCEPTANCE_LOGIN_NAME_QUERY})`,
      ),
    );
    assert.match(
      ACCEPTANCE_LOGIN_PRESENT_QUERY,
      /^select exists \(select 1 from pg_roles where rolname = \(/u,
    );
  });

  test("answers whether the login is present from the query's own answer", async () => {
    // A fake owner connection in place of pg's: it is handed the owner's URL,
    // and the work is handed a client that answers the query with a row.
    for (const present of [true, false]) {
      const asked = [];
      const answer = await acceptanceLoginExists(localOwner, {
        withClient: async (ownerUrl, work) => {
          asked.push(ownerUrl);
          return await work({
            query: async (text) => {
              asked.push(text);
              return { rows: [{ present }] };
            },
          });
        },
      });

      assert.equal(answer, present);
      assert.deepEqual(asked, [localOwner, ACCEPTANCE_LOGIN_PRESENT_QUERY]);
    }
  });

  test("waits for the port and the login to be released, rather than refusing at the first ask", async () => {
    const run = await fakeRun({
      loginPresent: (asked) => asked < 2,
      portTaken: (asked) => asked > 0 && asked < 4,
    });

    assert.equal(run.exitCode, 0);
    assert.equal(
      run.events.filter((event) => event.startsWith("start")).length,
      4,
    );
    assert.equal(run.mostLive, 1);
  });
});

describe("the report", () => {
  test("names each combination's outcome, and runs the rest after a failure", async () => {
    const run = await fakeRun({
      specExit: (name) => (name === "github" ? 1 : 0),
    });

    assert.equal(run.exitCode, 1);
    const [{ runDirectory, summary }] = run.records;
    assert.equal(runDirectory, "/offline/run");
    assert.deepEqual(summary.combinations, [
      { name: "none", outcome: "passed", exitCode: 0 },
      {
        name: "github",
        outcome: "failed",
        exitCode: 1,
        detail: "the spec exited 1",
      },
      { name: "magic-link", outcome: "passed", exitCode: 0 },
      { name: "both", outcome: "passed", exitCode: 0 },
    ]);
    assert.equal(summary.baseUrl, SIGN_IN_BASE_URL);
    assert.equal(summary.refusal, null);
  });

  test("stops a server that never answered, runs no spec against it, and starts no further server", async () => {
    // What kept one server from answering can be shared, the build above
    // all: it is one for all four, and each start that finds no current build
    // builds again, within its own budget and the same hold of the gate lock.
    const run = await fakeRun({
      serverReady: (name) => name !== "magic-link",
    });

    assert.equal(run.exitCode, 1);
    assert.deepEqual(run.events.slice(-5), [
      "start magic-link",
      "ready magic-link",
      "stop magic-link",
      "port 3100",
      "login owner",
    ]);
    assert.ok(!run.events.includes("start both"));
    const [{ summary }] = run.records;
    assert.deepEqual(summary.combinations.slice(2), [
      {
        name: "magic-link",
        outcome: "server did not start",
        detail: "planted",
      },
      {
        name: "both",
        outcome: "not run",
        detail: "the run stopped after the magic-link server",
      },
    ]);
    assert.match(
      summary.refusal,
      /^The magic-link server did not start \(planted\); no further server was started\.$/u,
    );
  });

  test("refuses a database that is not on this machine before it asks about the port", async () => {
    // Every dependency is a fake, so a runner that went on would only be
    // seen to, never reach a port or a server.
    const asked = [];
    const answer = (name, value) => async () => {
      asked.push(name);
      return value;
    };

    await assert.rejects(
      runSignInCombinations({
        baseEnvironment: {
          ...inherited,
          DATABASE_URL: "postgres://owner:secret@db.example.com/requestport",
        },
        createToken: () => token,
        log: () => undefined,
        loginExists: answer("login", false),
        portAnswers: answer("port", false),
        record: () => undefined,
        runSpec: answer("spec", 0),
        sleep: async () => undefined,
        startServer: () => {
          asked.push("start");
          return {};
        },
        stopServer: answer("stop", undefined),
        waitForServer: answer("ready", { ready: true }),
      }),
      /not on this machine/u,
    );
    assert.deepEqual(asked, []);
  });
});

/** Every process on this machine, with its parent and its process group. */
function processTable() {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], {
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, pgid] = line.trim().split(/\s+/u).map(Number);
      return { pgid, pid, ppid };
    });
}

/** The processes whose process group is `group`. */
function groupMembers(group) {
  return processTable().filter((entry) => entry.pgid === group);
}

async function eventually(check, { attempts = 100, intervalMs = 50 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return true;
    await delay(intervalMs);
  }
  return check();
}

/** Fails, rather than waits forever, when `promise` does not settle in time. */
async function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not finish in ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

/**
 * A stand-in for the acceptance server: a node process that starts one child
 * of its own, as `start-e2e-server.mjs` starts `next start`. Both end on their
 * own after a minute, so a failed case leaves nothing running for long.
 */
function standInServer({ ignoreTerm = false } = {}) {
  const script = [
    ignoreTerm ? 'process.on("SIGTERM", () => {});' : "",
    'require("node:child_process").spawn(process.execPath,',
    '  ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
    "setTimeout(() => {}, 60000);",
  ].join("\n");
  return spawnServer(
    { PATH: process.env.PATH },
    { args: ["-e", script], command: process.execPath },
  );
}

/** Kills whatever a case's stand-in left: its children, its group, itself. */
function removeStandIn(server) {
  const { pid } = server.child;
  for (const entry of processTable()) {
    if (entry.pid !== pid && (entry.ppid === pid || entry.pgid === pid)) {
      signal(entry.pid, "SIGKILL");
    }
  }
  if (server.exit === undefined) signal(pid, "SIGKILL");
}

describe("the stop and the port probe, on real processes and sockets", () => {
  test("stops the server's whole process group: the server and the process it started", async () => {
    const server = standInServer();
    try {
      // Detached: the server leads a group of its own, which its child joins.
      assert.ok(
        await eventually(() => groupMembers(server.child.pid).length === 2),
        "the server and its child are the two members of the server's own process group",
      );

      await within(stopServerGroup(server), 15_000, "the stop");

      assert.equal(server.exit, "SIGTERM");
      assert.ok(
        await eventually(() => groupMembers(server.child.pid).length === 0),
        "nothing of the server's process group is left",
      );
    } finally {
      removeStandIn(server);
    }
  });

  test("kills a server that ignores SIGTERM once the grace period has passed", async () => {
    const server = standInServer({ ignoreTerm: true });
    try {
      // The child is started after the handler is installed, so a member
      // count of two means SIGTERM is now ignored.
      assert.ok(
        await eventually(() => groupMembers(server.child.pid).length === 2),
        "the server and its child are the two members of the server's own process group",
      );

      const started = Date.now();
      await within(
        stopServerGroup(server, { graceMs: 300 }),
        10_000,
        "the stop",
      );

      assert.equal(server.exit, "SIGKILL");
      assert.ok(Date.now() - started >= 300);
      assert.ok(
        await eventually(() => groupMembers(server.child.pid).length === 0),
        "nothing of the server's process group is left",
      );
    } finally {
      removeStandIn(server);
    }
  });

  test("takes a port where something accepts a connection as taken", async () => {
    const listener = createServer();
    await new Promise((settle) =>
      listener.listen({ host: SIGN_IN_HOST, port: 0 }, settle),
    );
    try {
      assert.equal(await answersOnPort(listener.address().port), true);
    } finally {
      await new Promise((settle) => listener.close(settle));
    }
  });

  test("takes a port that refuses a connection as free", async () => {
    const listener = createServer();
    await new Promise((settle) =>
      listener.listen({ host: SIGN_IN_HOST, port: 0 }, settle),
    );
    const { port } = listener.address();
    await new Promise((settle) => listener.close(settle));

    assert.equal(await answersOnPort(port), false);
  });

  test("takes a port that neither accepts nor refuses as taken, once its timeout passes", async () => {
    // A listener whose process is stopped, with a backlog of one: the kernel
    // completes connections into the backlog until it is full, then leaves
    // the next unanswered, neither accepted nor refused.
    const holder = spawn(
      process.execPath,
      [
        "-e",
        [
          'const server = require("node:net").createServer();',
          'server.listen({ backlog: 1, host: "127.0.0.1", port: 0 }, () => {',
          '  process.stdout.write(String(server.address().port) + "\\n");',
          "});",
          "setTimeout(() => process.exit(0), 60000);",
        ].join("\n"),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const fillers = [];
    try {
      const port = await within(
        new Promise((settle) =>
          holder.stdout.once("data", (chunk) =>
            settle(Number(String(chunk).trim())),
          ),
        ),
        10_000,
        "the listener",
      );
      holder.kill("SIGSTOP");

      // Fill the backlog until a connection is left unanswered.
      let unanswered = false;
      for (let attempt = 0; attempt < 16 && !unanswered; attempt += 1) {
        unanswered = await new Promise((settle) => {
          const socket = openSocket({ host: SIGN_IN_HOST, port });
          fillers.push(socket);
          socket.once("connect", () => settle(false));
          socket.once("error", () => settle(false));
          socket.setTimeout(300, () => settle(true));
        });
      }
      assert.ok(
        unanswered,
        "a connection to the stopped listener is left unanswered",
      );

      const started = Date.now();
      assert.equal(await answersOnPort(port), true);
      assert.ok(
        Date.now() - started >= 1_500,
        "the answer came from the probe's timeout, not from a connection or an error",
      );
    } finally {
      for (const socket of fillers) socket.destroy();
      signal(holder.pid, "SIGKILL");
    }
  });

  test("counts a server as up by Playwright's rule, 200 to 403", () => {
    assert.deepEqual(
      [199, 200, 302, 399, 400, 403, 404, 500].map((status) => [
        status,
        serving(status),
      ]),
      [
        [199, false],
        [200, true],
        [302, true],
        [399, true],
        [400, true],
        [403, true],
        [404, false],
        [500, false],
      ],
    );
  });
});

/** The environment Playwright's configuration refuses to load without. */
function guarded(extra = {}) {
  const environment = {
    ...process.env,
    DATABASE_URL:
      "postgres://listing:listing@127.0.0.1:1/requestport_listing_only",
    NODE_ENV: "test",
    REQUESTPORT_E2E_MODE: "1",
    REQUESTPORT_E2E_TOKEN: token,
    ...extra,
  };
  if (!(SIGN_IN_COMBINATION_VARIABLE in extra)) {
    delete environment[SIGN_IN_COMBINATION_VARIABLE];
  }
  return environment;
}

/** Every case Playwright lists, with where it came from. */
function listCases(environment) {
  const result = spawnSync(
    process.execPath,
    [playwrightCli, "test", "--list", "--reporter=json"],
    {
      cwd: webDirectory,
      encoding: "utf8",
      env: environment,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.deepEqual(listed.errors, [], "the listing must load every spec");

  const cases = [];
  const walk = (suite, describes) => {
    for (const spec of suite.specs ?? []) {
      for (const entry of spec.tests) {
        cases.push({
          describe: describes.at(-1) ?? null,
          file: spec.file,
          project: entry.projectName,
          // The JSON report gives a tag without its "@"; --grep is given it
          // with one.
          tags: (spec.tags ?? []).map((tag) =>
            tag.startsWith("@") ? tag : `@${tag}`,
          ),
          title: spec.title,
        });
      }
    }
    for (const child of suite.suites ?? []) {
      walk(
        child,
        child.file === suite.file ? [...describes, child.title] : describes,
      );
    }
  };
  for (const suite of listed.suites) walk(suite, []);
  return cases;
}

describe("Playwright's selection", () => {
  test("lists exactly the four combinations' cases when a combination is set", () => {
    const cases = listCases(
      guarded({ [SIGN_IN_COMBINATION_VARIABLE]: "none" }),
    );
    const names = SIGN_IN_COMBINATIONS.map(({ name }) => name);

    assert.ok(cases.length > 0);
    for (const entry of cases) {
      assert.equal(entry.project, SIGN_IN_PROJECT);
      assert.match(entry.file, /(^|\/)sign-in-methods\.spec\.ts$/u);
      assert.ok(
        entry.tags.includes(signInCombinationTag(entry.describe)),
        `${entry.describe} › ${entry.title} carries its combination's tag`,
      );
    }
    assert.deepEqual([...new Set(cases.map((entry) => entry.describe))], names);

    const perCombination = names.map(
      (name) => cases.filter((entry) => entry.describe === name).length,
    );
    // The same cases for each; fewer than five, the configuration's global
    // ceiling being five of its per-case timeout.
    assert.equal(new Set(perCombination).size, 1);
    assert.ok(perCombination[0] >= 1 && perCombination[0] < 5);
  });

  test("keeps the sign-in spec out of the default lanes", () => {
    const cases = listCases(guarded());

    assert.ok(cases.length > 0);
    assert.deepEqual(
      [...new Set(cases.map((entry) => entry.project))].toSorted(),
      [
        "appearance-chromium",
        "appearance-webkit",
        "route-state-chromium",
        "route-state-webkit",
      ],
    );
    assert.deepEqual(
      cases
        .filter((entry) => /sign-in-methods\.spec\.ts$/u.test(entry.file))
        .map((entry) => `${entry.project}: ${entry.file}`),
      [],
    );
  });
});

/**
 * Loads `playwright.config.ts` and this runner in one child, with an
 * environment made here rather than inherited, and answers what each says.
 */
function loadConfig(extra) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `const module = await import("./playwright.config.ts");
       const config = module.default;
       const runner = await import(${JSON.stringify(runnerUrl)});
       process.stdout.write(JSON.stringify({
         globalSetup: config.globalSetup ?? null,
         globalTimeout: config.globalTimeout ?? null,
         outputDir: config.outputDir ?? null,
         projects: config.projects.map((project) => project.name),
         projectDirectory: module.signInMethodsProject.testDir,
         projectName: module.signInMethodsProject.name,
         runnerEnvironments: runner.SIGN_IN_COMBINATIONS.map((combination) => ({
           environment: runner.signInCombinationEnvironment(combination, {
             baseEnvironment: process.env,
             token: process.env.REQUESTPORT_E2E_TOKEN,
           }),
           name: combination.name,
         })),
         timeout: config.timeout ?? null,
         variable: module.signInCombinationVariable,
         webServer: config.webServer === undefined
           ? null
           : { command: config.webServer.command, env: config.webServer.env },
         webServerStartBudgetMs: module.webServerStartBudgetMs,
       }));`,
    ],
    {
      cwd: webDirectory,
      encoding: "utf8",
      env: {
        ...inherited,
        DATABASE_URL:
          "postgres://listing:listing@127.0.0.1:1/requestport_listing_only",
        HOME: process.env.HOME,
        NODE_ENV: "test",
        PATH: process.env.PATH,
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN: token,
        ...extra,
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return result;
}

function loadedConfig(extra = {}) {
  const result = loadConfig(extra);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
}

describe("playwright.config.ts", () => {
  test("names the variable and the project this runner uses", () => {
    const loaded = loadedConfig();

    assert.equal(loaded.variable, SIGN_IN_COMBINATION_VARIABLE);
    assert.equal(loaded.projectName, SIGN_IN_PROJECT);
    assert.equal(loaded.projectDirectory, "./tests/sign-in-combinations");
    assert.equal(SERVER_START_BUDGET_MS, loaded.webServerStartBudgetMs);
  });

  test("set for a combination, declares the sign-in project alone, and no web server", () => {
    const loaded = loadedConfig({ [SIGN_IN_COMBINATION_VARIABLE]: "github" });

    assert.deepEqual(loaded.projects, [SIGN_IN_PROJECT]);
    assert.equal(loaded.webServer, null);
    assert.equal(loaded.globalSetup, null);
    assert.equal(loaded.outputDir, "test-results/sign-in-github");
    assert.equal(loaded.globalTimeout, 5 * loaded.timeout);
  });

  test("unset, is the four lanes with their own web server and warm-up", () => {
    const loaded = loadedConfig();

    assert.deepEqual(loaded.projects, [
      "appearance-chromium",
      "route-state-chromium",
      "appearance-webkit",
      "route-state-webkit",
    ]);
    assert.match(loaded.webServer.command, /start-e2e-server\.mjs/u);
    assert.equal(loaded.globalSetup, "./tests/warm-addresses.ts");
  });

  test("starts each combination's server as the default lanes start theirs, but for the sign-in names", () => {
    const loaded = loadedConfig();
    const lanes = { ...loaded.webServer.env };
    for (const name of SIGN_IN_DECIDED_VARIABLES) delete lanes[name];

    for (const { environment, name } of loaded.runnerEnvironments) {
      const combination = SIGN_IN_COMBINATIONS.find(
        (entry) => entry.name === name,
      );
      assert.deepEqual(
        environment,
        {
          ...lanes,
          ...combination.environment,
          [SIGN_IN_COMBINATION_VARIABLE]: name,
        },
        name,
      );
    }
  });

  test("refuses a combination that is not a lower-case name", () => {
    const result = loadConfig({ [SIGN_IN_COMBINATION_VARIABLE]: "../none" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be a lower-case combination name/u);
  });
});
