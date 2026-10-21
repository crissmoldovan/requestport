import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { LOCKSTEP } from "./pack-requestport.mjs";
import {
  AGENT_COMMANDS,
  bridgeEnvironment,
  credentialDigests,
  npxDirectoryOf,
  packedExports,
  parseAgentCommand,
  serve as serveAgent,
  serverOf,
} from "./requestport-clean-machine/agent.mjs";
import {
  BROWSERS,
  callbackOf,
  COMMANDS as PERSON_COMMANDS,
  STEPS as PERSON_STEPS,
  parseCommand,
  serve,
} from "./requestport-clean-machine/person.mjs";
import {
  AGENT_CLIENT_NAME,
  AGENT_IN_CONTAINER,
  authorizationUrl,
  bridgeProblems,
  bridgeProcesses,
  CHECKOUTS,
  CLOSED_REGISTRY,
  CONSENT_LINE,
  CONTAINER_HOME,
  cleanContainerArguments,
  createDocker,
  createLedger,
  credentialFrom,
  credentialLineIn,
  DATABASE_IMAGE,
  DATABASE_NAME,
  DATABASE_SQL,
  DRIVER_INSPECT_SCRIPT,
  databaseContainerArguments,
  databasePassword,
  driverContainerArguments,
  driverImage,
  fetchCounts,
  filesHolding,
  HARNESS_COMMANDS,
  harnessCommand,
  hbaProblems,
  INSPECT_SCRIPT,
  INSTANCE_LOGINS,
  inspectProblems,
  installProblems,
  instanceLoginProblems,
  journalOf,
  leftoverCounts,
  linkProblems,
  loginProblems,
  mcpConfiguration,
  migrationProblems,
  nodeImage,
  ownerOf,
  ownerUrlFileOf,
  ownerUrlOf,
  ownProcess,
  PERSON_IN_CONTAINER,
  PORT_SCRIPT,
  PROCESSES_SCRIPT,
  PUBLISHED_FORM,
  parseCommandLine,
  personClient,
  personPlan,
  playwrightVersions,
  principalOption,
  READINESS_SCRIPT,
  README_SLOTS,
  README_STEPS,
  RUN_LABEL,
  readBuildRecord,
  readmeCommand,
  readmeLine,
  refreshCountProblems,
  refuseInsideRepository,
  repositoryRoot,
  requestProblems,
  rotationProblems,
  START_STDERR,
  sessionProblems,
  stageCleanHarness,
  stageDriverHarness,
  startEvents,
  startFailures,
  startProcess,
  startStderrProblems,
  stopCommand,
  stopProblems,
  storedCredentials,
  substitute,
  workerProblems,
} from "./requestport-clean-machine.mjs";
import { PLAYWRIGHT_IMAGE } from "./run-webkit-lanes.mjs";

const HARNESS = join(repositoryRoot, "scripts/requestport-clean-machine.mjs");
const README = readFileSync(
  join(repositoryRoot, "apps/requestport/README.md"),
  "utf8",
);

/** A directory this test owns, removed however the test ends. */
function scratch(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));

  t.after(() => rmSync(directory, { force: true, recursive: true }));

  return directory;
}

const fileOf = (name, version) =>
  `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;

/** The run's fourteen, as a build record names them. */
const TARBALLS = Object.freeze(
  [...LOCKSTEP, "requestport"].map((name) => ({
    name,
    file: fileOf(name, "0.0.0-t"),
  })),
);

describe("the clean container's definitions", () => {
  test("its image is the Node .node-version names, on bookworm's slim variant", (t) => {
    const version = readFileSync(
      join(repositoryRoot, ".node-version"),
      "utf8",
    ).trim();

    assert.equal(nodeImage(), `node:${version}-bookworm-slim`);

    const root = scratch(t, "clean-machine-node-version-");

    writeFileSync(join(root, ".node-version"), "lts/jod\n");
    assert.throws(() => nodeImage(root), /not a Node version/u);
  });

  test("it publishes no port, joins no network of its own (Docker's default bridge only), and keeps HOME out of /home/", () => {
    const args = cleanContainerArguments({
      run: "r1",
      name: "r1-clean",
      image: "node:22.22.3-bookworm-slim",
      tarballs: "/real/tarballs",
      readme: "/real/readme/README.md",
      harness: "/real/harness-clean",
    });

    assert.deepEqual(args, [
      "-d",
      "--init",
      "--name",
      "r1-clean",
      "--label",
      `${RUN_LABEL}=r1`,
      "--user",
      "1000:1000",
      "--tmpfs",
      `${CONTAINER_HOME}:rw,exec,uid=1000,gid=1000,mode=0700`,
      "-e",
      `HOME=${CONTAINER_HOME}`,
      "-e",
      "npm_config_loglevel=http",
      "-e",
      "npm_config_update_notifier=false",
      "-v",
      "/real/tarballs:/tarballs:ro",
      "-v",
      "/real/readme/README.md:/readme/README.md:ro",
      "-v",
      "/real/harness-clean:/harness:ro",
      "--workdir",
      CONTAINER_HOME,
      "node:22.22.3-bookworm-slim",
      "sleep",
      "infinity",
    ]);
    for (const flag of [
      "-p",
      "--publish",
      "-P",
      "--publish-all",
      "--network",
    ]) {
      assert.ok(!args.includes(flag), flag);
    }
    assert.ok(!args.join(" ").includes("3100"));
    assert.ok(!CONTAINER_HOME.startsWith("/home/"));
  });

  test("the driver container shares the clean container's network namespace, with the person read-only", () => {
    const args = driverContainerArguments({
      run: "r1",
      name: "r1-driver",
      clean: "r1-clean",
      image: PLAYWRIGHT_IMAGE,
      harness: "/real/harness-driver",
    });

    assert.deepEqual(args, [
      "-d",
      "--init",
      "--name",
      "r1-driver",
      "--label",
      `${RUN_LABEL}=r1`,
      "--network",
      "container:r1-clean",
      "-v",
      "/real/harness-driver:/harness:ro",
      PLAYWRIGHT_IMAGE,
      "sleep",
      "infinity",
    ]);
    for (const flag of ["-p", "--publish", "-P", "--publish-all", "--ipc"]) {
      assert.ok(!args.includes(flag), flag);
    }
    assert.ok(!args.join(" ").includes("3100"));
  });
});

describe("the driver's Playwright", () => {
  test("the WebKit lanes' image, the root's @playwright/test and the playwright-core staged are one version", () => {
    const versions = playwrightVersions();
    const root = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    );

    assert.equal(versions.image, versions.test);
    assert.equal(versions.test, versions.core);
    assert.equal(versions.test, root.devDependencies["@playwright/test"]);
    assert.equal(
      PLAYWRIGHT_IMAGE,
      `mcr.microsoft.com/playwright:v${versions.core}-noble`,
    );
    assert.equal(
      playwrightVersions(
        repositoryRoot,
        "mcr.microsoft.com/playwright:v1.0.0-noble",
      ).image,
      "1.0.0",
    );
  });

  test("the driver's image is refused unless its tag is the root's @playwright/test and the staged playwright-core's version", () => {
    assert.equal(driverImage(), PLAYWRIGHT_IMAGE);
    assert.throws(
      () =>
        driverImage(
          repositoryRoot,
          "mcr.microsoft.com/playwright:v1.0.0-noble",
        ),
      /the driver's Playwright versions disagree: \{"image":"1\.0\.0",/u,
    );
  });

  test("the staged harness holds the person and playwright-core, with no symbolic link", (t) => {
    const directory = join(scratch(t, "clean-machine-driver-"), "harness");

    stageDriverHarness(directory);

    assert.deepEqual(readdirSync(directory).sort(), [
      "node_modules",
      "person.mjs",
    ]);
    assert.equal(
      readFileSync(join(directory, "person.mjs"), "utf8"),
      readFileSync(
        join(repositoryRoot, "scripts/requestport-clean-machine/person.mjs"),
        "utf8",
      ),
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          join(directory, "node_modules/playwright-core/package.json"),
          "utf8",
        ),
      ).version,
      playwrightVersions().core,
    );

    const found = spawnSync("find", [directory, "-type", "l"], {
      encoding: "utf8",
    });

    assert.equal(found.status, 0);
    assert.equal(found.stdout, "");
  });
});

describe("the person's steps, as the harness reads them", () => {
  test("the owner's email and organization name come from README 33's line", () => {
    assert.deepEqual(
      ownerOf(readmeLine(README, README_STEPS.startPglite).line),
      { email: "owner@example.com", organizationName: "Acme" },
    );
    assert.throws(
      () => ownerOf(`npx ${PUBLISHED_FORM} start --storage pglite`),
      /names no --email/u,
    );
  });

  test("README 139 is the one login line that names a server", () => {
    assert.equal(
      readmeLine(README, README_STEPS.login).line,
      `npx ${PUBLISHED_FORM} login --server http://127.0.0.1:3200`,
    );
  });

  test("the authorization URL is read from login's standard error, among npm's lines", () => {
    const url =
      "http://127.0.0.1:3200/api/auth/oauth2/authorize?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A41999%2Fcallback";
    const stderr = [
      "npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 300ms",
      "requestport login: to authorize the mcp credential, open this URL in a browser:",
      "",
      `  ${url}`,
      "",
    ].join("\n");

    assert.deepEqual(authorizationUrl(stderr), { audience: "mcp", url });
    assert.equal(authorizationUrl(stderr.split("\n")[0]), undefined);
  });

  test("login's stored line gives the audience, the project, the organization and the server", () => {
    const project = "0198a1f2-1111-7222-8333-944445555666";
    const organization = "0198a1f2-aaaa-7bbb-8ccc-9ddddeeeefff";

    assert.deepEqual(
      storedCredentials(
        `Stored the mcp credential for project ${project} (organization ${organization}) on http://127.0.0.1:3200.\n`,
      ),
      [
        {
          audience: "mcp",
          projectId: project,
          organizationId: organization,
          server: "http://127.0.0.1:3200",
        },
      ],
    );
    assert.deepEqual(storedCredentials("something else\n"), []);
  });

  test("a login the person consented to must store one mcp credential, for the person's project, on the line's server", () => {
    const projectId = "0198a1f2-1111-7222-8333-944445555666";
    const good = {
      readmeLine: 139,
      status: 0,
      stored: [
        {
          audience: "mcp",
          projectId,
          organizationId: "o",
          server: "http://127.0.0.1:3200",
        },
      ],
      fetches: { problems: [] },
    };
    const consent = {
      body: "RequestPort has the authorization.\n\nYou can close this tab and go back to your terminal.",
    };
    const judge = (login, answered = consent) =>
      loginProblems({
        browser: "webkit",
        login,
        server: "http://127.0.0.1:3200",
        projectId,
        consent: answered,
      });

    assert.deepEqual(judge(good), []);
    assert.deepEqual(
      judge(
        {
          ...good,
          status: 1,
          stored: [
            {
              ...good.stored[0],
              audience: "api",
              projectId: "other",
              server: "http://127.0.0.1:3300",
            },
            good.stored[0],
          ],
          fetches: {
            problems: ["npm asked registry.npmjs.org for requestport"],
          },
        },
        { body: "Not found." },
      ),
      [
        "webkit: README 139 exited 1",
        "webkit: README 139 stored 2 credential(s), not one",
        "webkit: README 139 stored the api credential, not mcp",
        `webkit: README 139 stored a credential for project other, not ${projectId}, the one the person created`,
        "webkit: README 139 stored a credential on http://127.0.0.1:3300, not http://127.0.0.1:3200",
        'webkit: the callback answered "Not found.", not "RequestPort has the authorization."',
        "webkit: README 139: npm asked registry.npmjs.org for requestport",
      ],
    );
    assert.deepEqual(judge({ ...good, stored: [] }), [
      "webkit: README 139 stored 0 credential(s), not one",
    ]);
  });

  test("each browser has its own project, principal slug and request title", () => {
    const chromium = personPlan("chromium", "h8-x");
    const webkit = personPlan("webkit", "h8-x");

    assert.notEqual(chromium.project.slug, webkit.project.slug);
    assert.notEqual(chromium.project.key, webkit.project.key);
    assert.notEqual(chromium.principalSlug, webkit.principalSlug);
    assert.notEqual(chromium.checkout, webkit.checkout);
    for (const plan of [chromium, webkit]) {
      assert.match(plan.project.key, /^[A-Z][A-Z0-9]{1,9}$/u);
      assert.match(plan.principalSlug, /^[a-z0-9][a-z0-9-]{1,62}$/u);
      assert.match(plan.requestTitle, /h8-x/u);
      assert.ok(plan.checkout.startsWith(`${CHECKOUTS}/`), plan.checkout);
      assert.ok(plan.checkout.startsWith(`${CONTAINER_HOME}/`));
      assert.match(plan.requestDescription, /h8-x/u);
    }
  });
});

/** A child process stand-in: three streams and the close event. */
function fakeChild() {
  const child = new EventEmitter();

  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  return child;
}

describe("the harness's side of the person", () => {
  const CREDENTIAL = `${"C".repeat(21)}_-${"d".repeat(20)}`;

  test("a command reaches the person whole, and the transcript without the credential", async () => {
    const child = fakeChild();
    const entries = [];
    const written = [];
    const person = personClient({
      child,
      transcript: (entry) => entries.push(entry),
      timeoutMs: 5_000,
    });

    child.stdin.on("data", (chunk) => written.push(String(chunk)));
    child.stdout.write(`${JSON.stringify({ ready: { node: "v24" } })}\n`);
    assert.deepEqual(await person.ready, { node: "v24" });

    const asked = person.ask("signIn", {
      browser: "webkit",
      base: "http://127.0.0.1:3200",
      email: "owner@example.com",
      credential: CREDENTIAL,
    });

    await new Promise((settle) => setImmediate(settle));
    child.stdout.write(
      `${JSON.stringify({ id: 1, ok: true, browser: "webkit", result: { landed: "/" } })}\n`,
    );

    assert.deepEqual((await asked).result, { landed: "/" });
    assert.equal(JSON.parse(written.join("")).credential, CREDENTIAL);
    assert.deepEqual(entries, [
      {
        kind: "person",
        id: 1,
        command: "signIn",
        browser: "webkit",
        base: "http://127.0.0.1:3200",
        email: "owner@example.com",
      },
    ]);
    assert.ok(!JSON.stringify(entries).includes(CREDENTIAL));
  });

  test("a failed step, a process that ends, and a silence each fail the ask, naming it", async () => {
    const child = fakeChild();
    const person = personClient({
      child,
      transcript: () => {},
      timeoutMs: 200,
    });
    const failed = person.ask("consent", {
      browser: "chromium",
      url: "http://127.0.0.1:3200/a",
      project: "Acme / P",
      principal: { new: { slug: "s" } },
    });

    child.stdout.write(
      `${JSON.stringify({ id: 1, ok: false, browser: "chromium", step: "consent", error: "chromium: consent: the browser did not reach the callback" })}\n`,
    );
    await assert.rejects(failed, /^Error: chromium: consent: the browser/u);

    await assert.rejects(
      person.ask("seeRequest", {
        browser: "webkit",
        base: "http://127.0.0.1:3200",
        title: "t",
        within: 10,
      }),
      /webkit: seeRequest: no answer within 200 ms/u,
    );

    const pending = person.ask("createProject", {
      browser: "webkit",
      base: "b",
      name: "n",
      key: "K1",
      slug: "s",
    });

    child.emit("close", 1, null);
    await assert.rejects(
      pending,
      /webkit: createProject: the person's process ended \(exit 1\)/u,
    );
    // Asked after the end: refused at once, not after the bound.
    await assert.rejects(
      person.ask("close", {}),
      /^Error: person: close: the person's process ended \(exit 1\)$/u,
    );
    await assert.rejects(person.ready, /the person's process ended/u);
  });
});

describe("the person's protocol", () => {
  const BASE = "http://127.0.0.1:3200";
  const VALID = [
    {
      id: 1,
      command: "signIn",
      browser: "chromium",
      base: BASE,
      email: "owner@example.com",
      credential: "c",
    },
    {
      id: 2,
      command: "createProject",
      browser: "webkit",
      base: BASE,
      name: "P",
      key: "PK",
      slug: "p",
    },
    {
      id: 3,
      command: "consent",
      browser: "webkit",
      url: `${BASE}/a`,
      project: "Acme / P",
      principal: { new: { slug: "agent" } },
    },
    {
      id: 4,
      command: "consent",
      browser: "chromium",
      url: `${BASE}/a`,
      project: "Acme / P",
      principal: { existing: "Acme / Agent" },
    },
    {
      id: 5,
      command: "seeRequest",
      browser: "chromium",
      base: BASE,
      title: "T",
      within: 1000,
    },
    { id: 6, command: "close" },
  ];

  test("each command is read as it was written", () => {
    for (const command of VALID) {
      assert.deepEqual(parseCommand(JSON.stringify(command)), command);
    }
    assert.deepEqual(Object.keys(PERSON_COMMANDS).sort(), [
      "close",
      "consent",
      "createProject",
      "seeRequest",
      "signIn",
    ]);
    assert.deepEqual(BROWSERS, ["chromium", "webkit"]);
  });

  test("a line that is not one of them is refused, saying why", () => {
    const [signIn, , consent, , seeRequest] = VALID;
    const cases = [
      ["not json", /not JSON/u],
      ["[1]", /no id/u],
      [JSON.stringify({ ...signIn, id: "1" }), /no id/u],
      [
        JSON.stringify({ ...signIn, command: "toString" }),
        /no command is named/u,
      ],
      [
        JSON.stringify({ ...signIn, browser: "firefox" }),
        /no browser is named/u,
      ],
      [JSON.stringify({ ...signIn, extra: 1 }), /takes no field extra/u],
      [
        JSON.stringify({ ...signIn, credential: undefined }),
        /signIn needs credential/u,
      ],
      [JSON.stringify({ ...signIn, email: "" }), /email is not a non-empty/u],
      [
        JSON.stringify({ ...consent, principal: { new: {} } }),
        /principal is neither/u,
      ],
      [
        JSON.stringify({
          ...consent,
          principal: { new: { slug: "a" }, existing: "b" },
        }),
        /principal is neither/u,
      ],
      [
        JSON.stringify({ ...seeRequest, within: 0 }),
        /within is not a positive/u,
      ],
      [
        JSON.stringify({ id: 9, command: "close", browser: "webkit" }),
        /takes no field browser/u,
      ],
    ];

    for (const [line, expected] of cases) {
      assert.throws(() => parseCommand(line), expected, line);
    }
  });

  test("the callback is the authorization URL's redirect_uri, on 127.0.0.1 over http", () => {
    const url = (redirect) =>
      `${BASE}/api/auth/oauth2/authorize?client_id=c&redirect_uri=${encodeURIComponent(redirect)}&state=s`;

    assert.deepEqual(callbackOf(url("http://127.0.0.1:41999/callback")), {
      origin: "http://127.0.0.1:41999",
      pathname: "/callback",
    });
    assert.throws(() => callbackOf(`${BASE}/a?x=1`), /names no redirect_uri/u);
    assert.throws(
      () => callbackOf(url("https://agent.example/callback")),
      /not an http address on 127\.0\.0\.1/u,
    );
    assert.throws(
      () => callbackOf(url("http://10.0.0.1:41999/callback")),
      /redirect_uri is http:\/\/10\.0\.0\.1:41999, not an http address on 127\.0\.0\.1/u,
    );
  });
});

/** The person, served from lines, with its browsers and steps given. */
async function servePerson(commands, { open, steps } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const answers = [];

  output.on("data", (chunk) => answers.push(String(chunk)));
  input.end(commands.map((command) => `${command}\n`).join(""));
  await serve({ input, output, open, steps, ready: { node: "test" } });

  return answers
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A Playwright locator stand-in whose every action succeeds. */
function fakeLocator() {
  const locator = {
    click: async () => {},
    fill: async () => {},
    filter: () => locator,
    first: () => locator,
    getAttribute: async () => null,
    getByRole: () => locator,
    innerText: async () => "",
    waitFor: async () => {},
  };

  return locator;
}

describe("the person's sign-in", () => {
  /** A page and a context whose session names `email`. */
  const session = (email) => ({
    page: {
      goto: async () => {},
      getByLabel: () => fakeLocator(),
      getByRole: () => fakeLocator(),
      waitForURL: async () => {},
      url: () => "http://127.0.0.1:3200/",
    },
    context: {
      request: {
        get: async () => ({
          status: () => 200,
          json: async () => ({ user: { email } }),
        }),
      },
    },
  });
  const fields = {
    base: "http://127.0.0.1:3200",
    email: "owner@example.com",
    credential: "c",
  };

  test("lands on / with a session that names the email signed in with", async () => {
    assert.deepEqual(
      await PERSON_STEPS.signIn(session("owner@example.com"), fields),
      { landed: "http://127.0.0.1:3200/", session: 200 },
    );
  });

  test("a session that names another email fails, naming both", async () => {
    await assert.rejects(
      PERSON_STEPS.signIn(session("someone@example.com"), fields),
      /^Error: \/api\/auth\/get-session answered 200 naming "someone@example\.com", not owner@example\.com$/u,
    );
  });
});

describe("the person's answers", () => {
  const CREDENTIAL = `${"E".repeat(21)}_-${"f".repeat(20)}`;
  const signIn = (id, browser) =>
    JSON.stringify({
      id,
      command: "signIn",
      browser,
      base: "http://127.0.0.1:3200",
      email: "owner@example.com",
      credential: CREDENTIAL,
    });

  test("come in order, one per command, after the ready line; one browser is opened once", async () => {
    const opened = [];
    const closed = [];
    const answers = await servePerson(
      [
        signIn(1, "chromium"),
        "not json",
        signIn(2, "chromium"),
        signIn(3, "webkit"),
        JSON.stringify({ id: 4, command: "close" }),
        signIn(5, "webkit"),
      ],
      {
        open: async (name) => {
          opened.push(name);
          return {
            browser: { close: async () => closed.push(name) },
            page: { on() {} },
            version: `${name}-1`,
          };
        },
        steps: { signIn: async (_session, { id }) => ({ step: id }) },
      },
    );

    assert.deepEqual(answers[0], { ready: { node: "test" } });
    assert.deepEqual(
      answers.slice(1).map(({ id, ok }) => [id, ok]),
      [
        [1, true],
        [null, false],
        [2, true],
        [3, true],
        [4, true],
      ],
    );
    assert.equal(answers[2].step, "protocol");
    assert.match(
      answers[2].error,
      /^person: protocol: a line that is not JSON$/u,
    );
    assert.equal(answers[3].browserVersion, "chromium-1");
    assert.equal(answers[4].browserVersion, "webkit-1");
    assert.deepEqual(opened, ["chromium", "webkit"]);
    assert.deepEqual(closed, ["chromium", "webkit"]);
  });

  test("a step that cannot complete fails naming the browser and the step, and never repeats the credential", async () => {
    const [answer] = (
      await servePerson([signIn(1, "webkit")], {
        open: async () => ({ page: { on() {} } }),
        steps: {
          signIn: async (_session, { credential }) => {
            throw new Error(
              `locator.fill: the field refused ${credential}\nCall log: …`,
            );
          },
        },
      })
    ).slice(1);

    assert.equal(answer.ok, false);
    assert.equal(answer.browser, "webkit");
    assert.equal(answer.step, "signIn");
    assert.equal(
      answer.error,
      "webkit: signIn: locator.fill: the field refused <redacted>",
    );
    assert.ok(!JSON.stringify(answer).includes(CREDENTIAL));
  });

  test("a browser that does not start fails its command as the launch step", async () => {
    const [answer] = (
      await servePerson([signIn(1, "webkit")], {
        open: async () => {
          throw new Error(
            "browserType.launch: Executable doesn't exist at /ms-playwright/webkit-1/pw_run.sh",
          );
        },
      })
    ).slice(1);

    assert.deepEqual(answer, {
      id: 1,
      ok: false,
      browser: "webkit",
      step: "launch",
      error:
        "webkit: launch: browserType.launch: Executable doesn't exist at /ms-playwright/webkit-1/pw_run.sh",
    });
  });

  test("a consent whose callback is not listening fails naming the browser and the step", async () => {
    const page = {
      on() {},
      goto: async () => {},
      getByRole: () => fakeLocator(),
      getByLabel: () => fakeLocator(),
      locator: () => fakeLocator(),
      waitForURL: async () => {
        throw new Error("page.waitForURL: Timeout 120000ms exceeded.");
      },
      url: () => "chrome-error://chromewebdata/",
    };
    const consent = JSON.stringify({
      id: 7,
      command: "consent",
      browser: "chromium",
      url: `http://127.0.0.1:3200/api/auth/oauth2/authorize?redirect_uri=${encodeURIComponent("http://127.0.0.1:41999/callback")}`,
      project: "Acme / Chromium project",
      principal: { new: { slug: "chromium-agent" } },
    });
    const [answer] = (
      await servePerson([consent], { open: async () => ({ page }) })
    ).slice(1);

    assert.deepEqual(answer, {
      id: 7,
      ok: false,
      browser: "chromium",
      step: "consent",
      error:
        "chromium: consent: the browser did not reach the callback http://127.0.0.1:41999/callback; it is at chrome-error://chromewebdata/",
    });
  });

  test("an approved consent answers with the callback's address and its query's names, not their values", async () => {
    const landed =
      "http://127.0.0.1:41999/callback?code=SECRETCODE&state=SECRETSTATE&iss=x";
    const page = {
      on() {},
      goto: async () => {},
      getByRole: () => fakeLocator(),
      getByLabel: () => fakeLocator(),
      locator: () => ({
        innerText: async () => "RequestPort has the authorization.\n",
      }),
      waitForURL: async (predicate) => {
        assert.equal(predicate(new URL(landed)), true);
        assert.equal(
          predicate(new URL("http://127.0.0.1:41998/callback")),
          false,
        );
      },
      url: () => landed,
    };
    const [answer] = (
      await servePerson(
        [
          JSON.stringify({
            id: 8,
            command: "consent",
            browser: "webkit",
            url: `http://127.0.0.1:3200/a?redirect_uri=${encodeURIComponent("http://127.0.0.1:41999/callback")}`,
            project: "Acme / WebKit project",
            principal: { existing: "Acme / Agent" },
          }),
        ],
        { open: async () => ({ page }) },
      )
    ).slice(1);

    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.deepEqual(answer.result, {
      callback: {
        origin: "http://127.0.0.1:41999",
        pathname: "/callback",
        queryKeys: ["code", "iss", "state"],
      },
      body: "RequestPort has the authorization.",
    });
    assert.ok(!JSON.stringify(answer).includes("SECRET"));
  });
});

describe("the one substitution", () => {
  const versionLine = `npx ${PUBLISHED_FORM} --version`;

  test("README's --version line becomes the runbook's form, each tarball once and requestport's last", () => {
    const issued = substitute(versionLine, {
      readme: README,
      tarballs: TARBALLS,
    });
    const words = [
      `--@requestport:registry=${CLOSED_REGISTRY}`,
      ...TARBALLS.flatMap(({ file }) => ["-p", `file:/tarballs/${file}`]),
      "requestport",
    ];

    assert.equal(issued.command, `npx ${words.join(" ")} --version`);
    assert.equal(issued.readme, versionLine);
    assert.equal(
      issued.readmeLine,
      README.split("\n").indexOf(versionLine) + 1,
    );
    assert.equal(
      words.at(-2),
      `file:/tarballs/${fileOf("requestport", "0.0.0-t")}`,
    );
  });

  test("a line that is not a line of a README sh block is refused", () => {
    for (const line of [
      `${versionLine} --verbose`,
      `      "args": ["${PUBLISHED_FORM}", "mcp"]`,
      README.split("\n").find((line) => line.startsWith("Each command below")),
      `npx ${PUBLISHED_FORM} --version; touch /tmp/x`,
    ]) {
      assert.throws(
        () => substitute(line, { readme: README, tarballs: TARBALLS }),
        /not a line of the README's sh blocks/u,
        line,
      );
    }
  });

  test("a README line without the published form is issued as it is", () => {
    const issued = substitute("chmod 600 owner-url.txt", {
      readme: README,
      tarballs: TARBALLS,
    });

    assert.equal(issued.command, "chmod 600 owner-url.txt");
  });

  test("a file name that is not one shell word, or requestport not last, is refused", () => {
    const spaced = TARBALLS.map((tarball, index) =>
      index === 0 ? { ...tarball, file: "domain 1.tgz" } : tarball,
    );

    assert.throws(
      () => substitute(versionLine, { readme: README, tarballs: spaced }),
      /not one plain shell word/u,
    );
    assert.throws(
      () =>
        substitute(versionLine, {
          readme: README,
          tarballs: [TARBALLS.at(-1), ...TARBALLS.slice(0, -1)],
        }),
      /last tarball must be requestport's/u,
    );
  });

  test("each step's line is exactly one line of the README's sh blocks", () => {
    assert.equal(readmeLine(README, README_STEPS.version).line, versionLine);
    assert.match(
      readmeLine(README, README_STEPS.startPglite).line,
      /^npx requestport@<version> start --storage pglite --email /u,
    );
    assert.throws(
      () => readmeLine(README, (line) => line.startsWith("npx ")),
      /hold \d+ line\(s\)/u,
    );
  });
});

describe("npm's requests", () => {
  const CLEAN = [
    "npm http fetch GET 200 https://registry.npmjs.org/zod 120ms (cache miss)",
    "npm http fetch GET 200 https://registry.npmjs.org/@img/sharp-linux-arm64/-/sharp-linux-arm64-0.35.5.tgz 80ms (cache miss)",
    "npm http fetch GET http://127.0.0.1:9/@requestport%2fdb attempt 1 failed with ECONNREFUSED",
    "npm http fetch GET http://127.0.0.1:9/@requestport%2fdb attempt 2 failed with ECONNREFUSED",
    "npm http fetch GET http://127.0.0.1:9/@requestport%2fdb attempt 3 failed with ECONNREFUSED",
    "npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 300ms",
    "npm http cache https://registry.npmjs.org/react 22ms (cache hit)",
  ];

  test("are counted by host, the closed registry's by package, and the audit apart", () => {
    const counts = fetchCounts(CLEAN.join("\n"));

    assert.equal(counts.completed, 3);
    assert.deepEqual(counts.completedByHost, { "registry.npmjs.org": 3 });
    assert.equal(counts.closedRegistryAttempts, 3);
    assert.deepEqual(counts.closedRegistryByPackage, { "@requestport/db": 3 });
    assert.equal(counts.audit, 1);
    assert.deepEqual(counts.problems, []);
  });

  test("a request for requestport or an @requestport name anywhere but the closed registry is a problem", () => {
    const counts = fetchCounts(
      [
        ...CLEAN,
        "npm http fetch GET 404 https://registry.npmjs.org/@requestport%2fweb 90ms (cache miss)",
        "npm http fetch GET 200 https://registry.npmjs.org/requestport 70ms (cache miss)",
        "npm http fetch GET https://mirror.example.test/@requestport%2fdb attempt 1 failed with ETIMEDOUT",
      ].join("\n"),
    );

    assert.equal(counts.problems.length, 3);
    assert.match(
      counts.problems[0],
      /registry\.npmjs\.org for @requestport\/web/u,
    );
    assert.match(counts.problems[1], /registry\.npmjs\.org for requestport /u);
    assert.match(
      counts.problems[2],
      /mirror\.example\.test for @requestport\/db/u,
    );
    assert.deepEqual(counts.notSuccessful, [
      "GET 404 https://registry.npmjs.org/@requestport%2fweb",
    ]);
  });
});

describe("the one npx directory", () => {
  const integrityOf = (name) => `sha512-${name}`;
  const tarballs = TARBALLS.map((tarball) => ({
    ...tarball,
    integrity: integrityOf(tarball.name),
  }));
  const goodLock = () => ({
    packages: Object.fromEntries(
      tarballs.map(({ name, file }) => [
        `node_modules/${name}`,
        {
          resolved: `file:../../../../tarballs/${file}`,
          integrity: integrityOf(name),
        },
      ]),
    ),
  });
  const goodLs = [
    "x@ /srv/clean-home/.npm/_npx/x",
    ...LOCKSTEP.map((name) => `+-- ${name}@0.0.0-t`),
    `| +-- ${LOCKSTEP[0]}@0.0.0-t deduped`,
  ].join("\n");

  test("each @requestport package once, from its tarball with the record's integrity, passes", () => {
    assert.deepEqual(
      installProblems({ ls: goodLs, lsStatus: 0, lock: goodLock(), tarballs }),
      [],
    );
  });

  test("a second copy, a registry resolution, another integrity, a missing line or a failed ls is a problem", () => {
    const lock = goodLock();

    lock.packages[
      "node_modules/@requestport/mcp/node_modules/@requestport/auth"
    ] = {
      resolved: "file:../../../../tarballs/requestport-auth-0.0.0-t.tgz",
    };
    lock.packages["node_modules/@requestport/db"].resolved =
      "https://registry.npmjs.org/@requestport/db/-/db-0.0.0-t.tgz";
    lock.packages["node_modules/requestport"].integrity = "sha512-other";

    const ls = goodLs.replace("+-- @requestport/web@0.0.0-t\n", "");
    const problems = installProblems({ ls, lsStatus: 1, lock, tarballs });

    assert.deepEqual(
      problems.map((problem) => problem.split(" ").slice(0, 6).join(" ")),
      [
        "npm ls --all exited 1",
        "the npx lockfile resolves @requestport/db from",
        "the npx lockfile installs @requestport/auth at",
        "npm ls --all names @requestport/web 0",
        "the npx lockfile's integrity for requestport",
      ],
    );
  });
});

describe("the owner's credential", () => {
  const CREDENTIAL = `${"A".repeat(21)}_-${"b".repeat(20)}`;

  test("is the one line of its shape on start's standard output", () => {
    assert.deepEqual(credentialFrom(`NOTICE: something\n${CREDENTIAL}\n\n`), {
      credential: CREDENTIAL,
      lines: 2,
    });
  });

  test("none, or more than one, is refused without echoing what was printed", () => {
    for (const stdout of ["", "short\n", `${CREDENTIAL}\n${CREDENTIAL}\n`]) {
      assert.throws(
        () => credentialFrom(stdout),
        (error) =>
          /one was expected/u.test(error.message) &&
          !error.message.includes(CREDENTIAL),
      );
    }
  });

  test("has arrived once a whole line of its shape, ended by its line break, is on standard output, and not while only part of it is", () => {
    for (const [stdout, arrived] of [
      ["", false],
      ['{"event":"worker.ready"}\n', false],
      [CREDENTIAL.slice(0, 20), false],
      [CREDENTIAL, false],
      [`NOTICE: something\n${CREDENTIAL}`, false],
      [`${CREDENTIAL}\n`, true],
      [`NOTICE: something\n${CREDENTIAL}\n{"event":"worker.re`, true],
    ]) {
      assert.equal(credentialLineIn(stdout), arrived, JSON.stringify(stdout));
    }
  });
});

describe("the stop", () => {
  // The clean container while README 33 served: the npm, sh and node rows as
  // the survey's stop probe read them from /proc (track-h.md, "H.8, the
  // survey"); pid 1 and its sleep as `--init` makes them.
  const SERVING = [
    { pid: 1, ppid: 0, pgrp: 1, cmd: "/sbin/docker-init -- sleep infinity" },
    { pid: 7, ppid: 1, pgrp: 1, cmd: "sleep infinity" },
    {
      pid: 82,
      ppid: 0,
      pgrp: 82,
      cmd: "npm exec requestport start --storage pglite",
    },
    {
      pid: 99,
      ppid: 82,
      pgrp: 82,
      cmd: "sh -c requestport start --storage pglite",
    },
    {
      pid: 100,
      ppid: 99,
      pgrp: 82,
      cmd: "node /srv/clean-home/.npm/_npx/x/node_modules/.bin/requestport start",
    },
  ];

  test("signals npx's process group, in a form dash's kill accepts", () => {
    const npx = startProcess(SERVING);

    assert.equal(npx.pid, 82);
    assert.equal(stopCommand(npx), "kill -TERM -82");
    assert.equal(
      stopCommand({
        pid: 83,
        ppid: 80,
        pgrp: 80,
        cmd: "npm exec requestport start",
      }),
      "kill -TERM -80",
    );
    assert.ok(!stopCommand(npx).includes("--"));
    assert.throws(
      () => stopCommand({ pid: 9, pgrp: 1 }),
      /not a process group/u,
    );
  });

  test("is judged by the stopped line, what is left, and the port", () => {
    assert.deepEqual(
      stopProblems({
        stderr: "requestport start: serving http://127.0.0.1:3200; ...\n",
        left: [SERVING[4]],
        port: "open",
      }),
      [
        "start's standard error has no `stopped` line",
        `left in the clean container: 100 ${SERVING[4].cmd}`,
        "the port answered open after the stop, not ECONNREFUSED",
      ],
    );
    assert.deepEqual(
      stopProblems({
        stderr:
          "requestport start: SIGTERM: stopping.\nrequestport start: stopped: the listener, the worker and every storage are closed.\n",
        left: [],
        port: "ECONNREFUSED",
      }),
      [],
    );
  });

  test("the container's own processes are its init and its sleep, not an orphan", () => {
    assert.deepEqual(
      SERVING.filter(ownProcess).map(({ pid }) => pid),
      [1, 7],
    );
    assert.equal(ownProcess({ pid: 100, ppid: 1, cmd: SERVING[4].cmd }), false);
  });
});

/** A docker stand-in for the ledger: records each call, answers by rule. */
function fakeDocker(answer = () => ({ status: 0, stdout: "" })) {
  const calls = [];
  const docker = (args) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "", ...answer(args) };
  };

  return { calls, docker };
}

describe("the teardown", () => {
  test("removes every container, newest first, with its anonymous volumes", () => {
    const { calls, docker } = fakeDocker();
    const ledger = createLedger(docker);

    for (const name of ["a", "b", "c"]) ledger.create(name, ["--name", name]);
    ledger.teardown();

    assert.deepEqual(
      calls.filter(([command]) => command === "rm"),
      [
        ["rm", "-f", "-v", "c"],
        ["rm", "-f", "-v", "b"],
        ["rm", "-f", "-v", "a"],
      ],
    );
    assert.deepEqual(ledger.teardown(), []);
  });

  test("removes a container whose creation failed", () => {
    const { calls, docker } = fakeDocker((args) =>
      args[0] === "run" && args.includes("b")
        ? { status: 125, stderr: "created, not started" }
        : {},
    );
    const ledger = createLedger(docker);

    ledger.create("a", ["--name", "a"]);
    assert.throws(() => ledger.create("b", ["--name", "b"]), /exited 125/u);
    ledger.teardown();

    assert.deepEqual(
      calls.filter(([command]) => command === "rm").map((call) => call[3]),
      ["b", "a"],
    );
  });

  test("counts the run's containers, and the dangling volumes and networks it added", () => {
    const { calls, docker } = fakeDocker((args) => {
      if (args[0] === "ps") return { stdout: "c1\n" };
      if (args[0] === "volume") return { stdout: "old\nnew\n" };
      if (args[0] === "network") return { stdout: "bridge\nmade\n" };
      return {};
    });

    assert.deepEqual(
      leftoverCounts(docker, {
        run: "r1",
        before: { volumes: ["old"], networks: ["bridge"] },
      }),
      { containers: ["c1"], volumes: ["new"], networks: ["made"] },
    );
    assert.deepEqual(calls[0], [
      "ps",
      "-a",
      "-q",
      "--filter",
      `label=${RUN_LABEL}=r1`,
    ]);
    assert.ok(calls[1].includes("dangling=true"));
    assert.ok(calls[1].includes("label=com.docker.volume.anonymous"));
  });
});

describe("what the clean container holds, and the pack", () => {
  test("the inspection must find uid 1000, the empty HOME, no .npmrc in HOME or npm's global configuration, the README and the record's tarballs", () => {
    const facts = {
      uid: 1000,
      gid: 1000,
      home: CONTAINER_HOME,
      homeEntries: [],
      npmrc: false,
      globalNpmrc: false,
      readme: true,
      tarballs: TARBALLS.map(({ file }) => file).sort(),
    };

    assert.deepEqual(inspectProblems(facts, TARBALLS), []);
    assert.deepEqual(inspectProblems({ ...facts, npmrc: true }, TARBALLS), [
      "HOME holds an .npmrc",
    ]);
    assert.deepEqual(
      inspectProblems({ ...facts, globalNpmrc: true }, TARBALLS),
      ["npm's global npmrc exists"],
    );
    assert.deepEqual(
      inspectProblems({ ...facts, homeEntries: [".npm"] }, TARBALLS),
      ['HOME is not empty: [".npm"]'],
    );
    assert.deepEqual(
      inspectProblems(
        { ...facts, uid: 0, readme: false, tarballs: [] },
        TARBALLS,
      ),
      [
        "the clean container runs as 0:1000",
        "the README is not mounted",
        "/tarballs holds [], not the record's",
      ],
    );
  });

  test("a tarball whose sha512 is not the build record's is refused, at the record's size too", (t) => {
    const root = scratch(t, "clean-machine-record-");
    const pack = fakePack(root);

    assert.equal(readBuildRecord(pack).tarballs.length, TARBALLS.length);

    const record = JSON.parse(
      readFileSync(join(pack, "build-record.json"), "utf8"),
    );
    const [first] = record.tarballs;
    const bytes = readFileSync(join(pack, first.file));

    // The same size, one byte changed: only the digest tells them apart.
    bytes[0] ^= 1;
    writeFileSync(join(pack, first.file), bytes);
    assert.equal(bytes.length, first.size);
    assert.throws(
      () => readBuildRecord(pack),
      new RegExp(
        `${first.file.replaceAll(".", "\\.")} is not the build record's`,
        "u",
      ),
    );
  });
});

describe("the run's docker", () => {
  /** createDocker over stand-in spawns that record what they were given. */
  const recorded = () => {
    const written = [];
    const spawned = [];
    const docker = createDocker({
      transcript: (entry) => written.push(entry),
      spawnSync: (command, args) => {
        spawned.push({ command, args, written: written.length });
        return { status: 0, stdout: "", stderr: "" };
      },
      spawn: (command, args) => {
        spawned.push({ command, args, written: written.length });

        const child = new EventEmitter();

        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => child.emit("close", null, "SIGTERM");

        return child;
      },
    });

    return { written, spawned, docker };
  };

  test("writes each exec and run to the transcript before it spawns it, every time, and spawns the arguments the entry holds", async () => {
    const { written, spawned, docker } = recorded();
    const inspect = harnessCommand("inspect", ["exec", "r-clean", "node"]);
    const created = harnessCommand("docker run", ["run", "--name", "r-clean"]);
    const { entry } = readmeCommand(README_STEPS.version, {
      readme: README,
      tarballs: TARBALLS,
      clean: "r-clean",
    });

    docker.exec(inspect);
    docker.exec(inspect);
    docker.exec(created);

    const started = docker.start(entry);

    assert.deepEqual(written, [inspect, inspect, created, entry]);
    assert.deepEqual(spawned, [
      { command: "docker", args: inspect.argv.slice(1), written: 1 },
      { command: "docker", args: inspect.argv.slice(1), written: 2 },
      { command: "docker", args: created.argv.slice(1), written: 3 },
      { command: "docker", args: entry.argv.slice(1), written: 4 },
    ]);
    assert.ok(docker.inflight.has(started.child));
    started.child.kill();
    assert.equal((await started.done).signal, "SIGTERM");
    assert.equal(docker.inflight.size, 0);
  });

  test("refuses an entry with no harness name or kind, the other subcommand, and a query that runs something in a container, writing and spawning nothing", () => {
    const { written, spawned, docker } = recorded();

    for (const [entry, expected] of [
      [
        { kind: "harness", name: "cleanup", argv: ["docker", "exec", "c"] },
        /no harness command is named cleanup/u,
      ],
      [
        { kind: "shell", argv: ["docker", "exec", "c", "sh"] },
        /an entry of kind "shell" runs nothing in a container/u,
      ],
      [{ argv: ["docker", "exec", "c", "sh"] }, /runs nothing in a container/u],
      [
        { kind: "harness", name: "inspect", argv: ["docker", "run", "c"] },
        /not a docker exec to transcribe/u,
      ],
      [
        { kind: "harness", name: "docker run", argv: ["docker", "exec", "c"] },
        /not a docker run to transcribe/u,
      ],
      [
        { kind: "readme", argv: ["podman", "exec", "c", "sh"] },
        /not a docker exec to transcribe/u,
      ],
    ]) {
      assert.throws(() => docker.exec(entry), expected, JSON.stringify(entry));
      assert.throws(() => docker.start(entry), expected, JSON.stringify(entry));
    }
    assert.throws(
      () => harnessCommand("inspect", ["run", "c"]),
      /inspect runs docker exec, not docker run/u,
    );
    for (const args of [
      ["exec", "c", "sh"],
      ["run", "--name", "c"],
      ["image", "rm", "x"],
      ["container", "exec", "c"],
    ]) {
      assert.throws(() => docker.query(args), /is not a query/u, args[0]);
    }
    assert.deepEqual(written, []);
    assert.deepEqual(spawned, []);
    docker.query(["rm", "-f", "-v", "c"]);
    assert.deepEqual(spawned, [
      { command: "docker", args: ["rm", "-f", "-v", "c"], written: 0 },
    ]);
  });

  test("the harness calls spawn's four names directly for docker inside createDocker and for tar beside it, and for nothing else", () => {
    const source = readFileSync(HARNESS, "utf8");
    const calls = [
      ...source.matchAll(
        /(?<![.\w$])(spawn|spawnSync|spawnLater|spawnNow)\(\s*("[^"]*"|[A-Za-z_$][\w$]*)/gu,
      ),
    ].map(([, callee, first]) => `${callee}(${first}`);

    assert.deepEqual(
      [...source.matchAll(/^import .* from "node:child_process";$/gmu)].map(
        ([line]) => line,
      ),
      ['import { spawn, spawnSync } from "node:child_process";'],
    );
    assert.equal(source.split("child_process").length - 1, 1);
    assert.deepEqual(calls, [
      'spawnSync("tar"',
      'spawnNow("docker"',
      'spawnLater("docker"',
      'spawnSync("tar"',
    ]);
  });
});

describe("the run directory's files", () => {
  test("a file that holds the credential is named, at any depth; one holding part of it is not", (t) => {
    const secret = `${"G".repeat(21)}_-${"h".repeat(20)}`;
    const directory = scratch(t, "clean-machine-sweep-");

    mkdirSync(join(directory, "deeper"));
    writeFileSync(join(directory, "start.stderr"), "serving\n");
    writeFileSync(
      join(directory, "deeper", "transcript.jsonl"),
      `${JSON.stringify({ credential: secret })}\n`,
    );
    writeFileSync(join(directory, "login.stderr"), secret.slice(0, 42));

    assert.deepEqual(filesHolding(directory, secret), [
      join("deeper", "transcript.jsonl"),
    ]);
    assert.throws(() => filesHolding(directory, ""), /no secret/u);
  });
});

describe("the run directory", () => {
  test("inside the repository is refused, through a symbolic link too", (t) => {
    assert.throws(
      () =>
        refuseInsideRepository(
          join(repositoryRoot, "no-such", "run"),
          "the run directory",
        ),
      /inside the repository/u,
    );

    const outside = scratch(t, "clean-machine-link-");
    const link = join(outside, "into-the-repository");

    symlinkSync(join(repositoryRoot, "scripts"), link);
    assert.throws(
      () => refuseInsideRepository(join(link, "run"), "the run directory"),
      /inside the repository/u,
    );
    assert.doesNotThrow(() =>
      refuseInsideRepository(join(outside, "run"), "the run directory"),
    );
  });
});

/**
 * The fake `docker` the command's cases put first on PATH, as a program run
 * once per call with Node's `fs`, `path` and `crypto` and `fake`
 * (`FAKE_CONSTANTS`). Every call appends its arguments to `FAKE_DOCKER_LOG`.
 * It answers the queries the run makes, lists `FAKE_DOCKER_LEFT` as the run's
 * containers, fails the creation whose name ends with `FAKE_DOCKER_FAIL_RUN`,
 * and appends each creation's name and the `POSTGRES_PASSWORD` of its own
 * environment, or null, to `FAKE_DOCKER_ENVIRONMENT`. On the README's
 * `--version` line it blocks (`FAKE_DOCKER_VERSION=block`) or exits 1
 * (`fail`). Without `FAKE_DOCKER_STATE` it answers any other `exec` with `{}`.
 *
 * With `FAKE_DOCKER_STATE`, a directory, it plays a whole run, as the
 * containers would answer it, keeping what one call leaves for the next
 * there: the pack `FAKE_DOCKER_PACK` names installed; `start` printing a
 * credential and serving until a `kill` stops it, or, with
 * `FAKE_DOCKER_START=serving-first`, saying it serves and printing the
 * credential only once a `cat` of its standard error has read that line
 * (ruling 202 item 3); `login` printing an
 * authorization URL and storing its credential once the person consents;
 * `link`; the agent (load, credentials, file, whoami, http), each bridge step
 * a refresh of the stored credential; the person (sign-in, project, consent,
 * `/requests`, close); and on pg the database's readiness and every
 * `DATABASE_SQL` read. `FAKE_DOCKER_PLANT` makes one answer bad: `login`
 * (the mcp credential stored on another server), `spent` (no bridge step
 * changes the refresh token), `seen` (`/requests` never shows the request),
 * `install-after` (`npm ls` fails after the person closes), `stop` (no
 * `stopped` line), `worker` (no `worker.ready` in start's log) or `scheduler`
 * (no retention-cleanup event in it). A call nothing answers exits 97,
 * naming it.
 */
function fakeDockerProgram(fs, path, crypto, fake) {
  const env = process.env;
  const args = process.argv.slice(2);

  fs.appendFileSync(env.FAKE_DOCKER_LOG, `${JSON.stringify(args)}\n`);

  const state = env.FAKE_DOCKER_STATE;
  const plant = env.FAKE_DOCKER_PLANT ?? "";
  const write = (fd, text) => fs.writeSync(fd, text);
  const answer = (text, code = 0) => {
    write(1, text);
    process.exit(code);
  };
  const json = (value, code = 0) => answer(`${JSON.stringify(value)}\n`, code);
  const at = (name) => path.join(state, name);
  const flag = (name) => fs.existsSync(at(name));
  const mark = (name) => fs.writeFileSync(at(name), "");
  const load = (name, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(at(name), "utf8"));
    } catch {
      return fallback;
    }
  };
  const save = (name, value) =>
    fs.writeFileSync(at(name), JSON.stringify(value));
  const once = (name, then) => {
    const timer = setInterval(() => {
      if (flag(name)) {
        clearInterval(timer);
        then();
      }
    }, 25);
  };

  if (args[0] === "version") answer("linux\n");
  if (args[0] === "ps") answer(env.FAKE_DOCKER_LEFT ?? "");
  if (args[0] === "image") answer("sha256:fake []\n");
  if (args[0] === "run") {
    const name = args[args.indexOf("--name") + 1];

    fs.appendFileSync(
      env.FAKE_DOCKER_ENVIRONMENT,
      `${JSON.stringify({ name, password: env.POSTGRES_PASSWORD ?? null })}\n`,
    );

    const fail = env.FAKE_DOCKER_FAIL_RUN;

    if (fail && name.endsWith(fail)) {
      write(2, "fake: created, not started\n");
      process.exit(125);
    }
    if (state !== undefined) {
      const mounts = {};

      args.forEach((word, index) => {
        if (args[index - 1] === "-v") {
          const [source, target] = word.split(":");

          mounts[target] = source;
        }
      });
      save(`mounts-${name.slice(name.lastIndexOf("-") + 1)}`, mounts);
    }
    answer(`${name}-id\n`);
  }
  if (args[0] !== "exec") answer("");

  let index = 1;
  let cwd;

  while (["-i", "-w", "-e"].includes(args[index])) {
    if (args[index] === "-w") cwd = args[index + 1];
    index += args[index] === "-i" ? 1 : 2;
  }

  const container = args[index];
  const words = args.slice(index + 1);
  const script = words[0] === "sh" && words[1] === "-c" ? words[2] : "";
  const nodeScript = words[0] === "node" && words[1] === "-e" ? words[2] : "";

  if (words.at(-1).endsWith("--version")) {
    if (env.FAKE_DOCKER_VERSION === "block") {
      setInterval(() => {}, 1000);
      return;
    }
    if (env.FAKE_DOCKER_VERSION === "fail") answer("", 1);
  }
  if (state === undefined) answer("{}\n");

  const { tarballs } = JSON.parse(
    fs.readFileSync(
      path.join(env.FAKE_DOCKER_PACK, "build-record.json"),
      "utf8",
    ),
  );
  const server = "http://127.0.0.1:3200";
  const npx = `${fake.home}/.npm/_npx/0123abcd`;
  const organization = "00000000-0000-4000-8000-0000000000aa";
  const projects = {
    chromium: "00000000-0000-4000-8000-000000000001",
    webkit: "00000000-0000-4000-8000-000000000002",
  };
  const instance = "fake0123";
  const digest = (text) =>
    crypto.createHash("sha256").update(text).digest("hex");
  const browserOf = (directory) => path.basename(String(directory));
  const ofProject = (projectId) =>
    Object.keys(projects).find((browser) => projects[browser] === projectId);
  const stored = (browser) =>
    ["mcp", "api"].filter((audience) => flag(`stored-${browser}-${audience}`));
  // The refresh tokens issued to each audience's client, by browser: one at
  // login, then one per bridge (mcp) or per HTTP client (api).
  const issued = (browser) => load(`issued-${browser}`, { mcp: 0, api: 0 });
  const issue = (browser, audience, times) => {
    const counts = issued(browser);

    counts[audience] += times;
    save(`issued-${browser}`, counts);
  };
  const client = (browser, audience) => digest(`${audience}-${browser}-client`);
  const bridges = (browser, count) =>
    Array.from({ length: count }, (_, offset) => ({
      stderr: `requestport mcp: serving project ${projects[browser]} (${browser}-project) on ${server}.\n`,
      startedMs: 10 + offset,
      connectedMs: 100 + offset,
      closedMs: 200 + offset,
      transportErrors: [],
    }));

  const start = () => {
    const event = (name, status) =>
      write(1, `${JSON.stringify({ level: "info", event: name, status })}\n`);
    const output = () => {
      write(1, `${crypto.randomBytes(32).toString("base64url")}\n`);
      if (plant !== "worker") event("worker.ready", "ready");
      // The scheduler's first tick, which runs retention-cleanup's body: one
      // event per retention category.
      if (plant !== "scheduler") {
        for (let category = 0; category < 9; category += 1) {
          event("retention.category_completed", "empty");
        }
      }
    };
    const serving = () => {
      fs.writeFileSync(
        at("start.stderr"),
        [
          ...(script.includes("--storage pglite")
            ? [
                "requestport start: storage worker: unbound, on the application storage, with the in-process exclusive runner.",
              ]
            : []),
          `requestport start: serving ${server}; the in-process worker is ready.`,
          "",
        ].join("\n"),
      );
      mark("serving");
    };

    if (env.FAKE_DOCKER_START === "serving-first") {
      // The serving line first, and the credential only once a `cat` of
      // start's standard error has found that line in it (`serving-read`,
      // below), so the harness's cat that sees it cannot also see the
      // credential already delivered.
      serving();
      once("serving-read", output);
    } else {
      output();
      serving();
    }
    once("stopped", () => {
      event("worker.stopped", "drained");
      if (plant !== "stop") {
        fs.appendFileSync(
          at("start.stderr"),
          "requestport start: stopped: the listener, the worker and every storage are closed.\n",
        );
      }
      fs.rmSync(at("serving"));
      process.exit(0);
    });
  };
  const login = () => {
    const browser = browserOf(cwd);
    const audience = script.includes("--for api") ? "api" : "mcp";
    const callback = encodeURIComponent("http://127.0.0.1:41999/callback");

    write(
      2,
      `requestport login: to authorize the ${audience} credential, open this URL in a browser: ${server}/api/auth/oauth2/authorize?client_id=c&redirect_uri=${callback}&state=s&fake=${browser}-${audience}\n`,
    );
    once(`consented-${browser}-${audience}`, () => {
      mark(`stored-${browser}-${audience}`);
      issue(browser, audience, 1);

      const on =
        plant === "login" && audience === "mcp"
          ? "http://127.0.0.1:3201"
          : server;

      write(
        1,
        `Stored the ${audience} credential for project ${projects[browser]} (organization ${organization}) on ${on}.\n`,
      );
      process.exit(0);
    });
  };
  const link = () => {
    const browser = browserOf(cwd);
    const projectId = / --project (\S+)/u.exec(script)[1];

    write(
      1,
      `Using the mcp credential stored for project ${projectId} (organization ${organization}) on ${server}.\nWrote ${cwd}/.requestport/project.json: this checkout is bound to project ${projectId} (${browser}-project) of organization ${organization} on ${server}.\n`,
    );
    save(`binding-${browser}`, {
      organizationId: organization,
      projectId,
      projectSlug: `${browser}-project`,
      server,
    });
    process.exit(0);
  };
  const agent = (command) => {
    const reply = (result, records = []) =>
      json({ ok: true, command: command.command, result, bridges: records });
    const browser =
      command.cwd === undefined
        ? ofProject(command.projectId)
        : browserOf(command.cwd);

    if (command.command === "load") {
      reply({ node: "v22.0.0", client: true, stdioTransport: true });
    }
    if (command.command === "credentials") {
      reply({
        audiences: Object.fromEntries(
          stored(browser).map((audience) => [
            audience,
            {
              clientIdSha256: client(browser, audience),
              refreshTokenSha256: digest(
                `${audience}-${browser}-${issued(browser)[audience]}`,
              ),
            },
          ]),
        ),
        locks: [],
        fileLock: false,
      });
    }
    if (command.command === "file") {
      if (plant !== "spent") issue(browser, "mcp", 1);
      save(`filed-${browser}`, { title: command.title });
      reply(
        {
          server,
          draft: { id: `request-${browser}`, version: 1, state: "draft" },
          submitted: {
            id: `request-${browser}`,
            version: 2,
            state: "submitted",
          },
        },
        bridges(browser, 1),
      );
    }
    if (command.command === "whoami") {
      if (plant !== "spent") issue(browser, "mcp", command.bridges);
      reply(
        {
          server,
          whoami: bridges(browser, command.bridges).map(() => ({
            organizationId: organization,
            projectId: projects[browser],
            audience: "mcp",
          })),
        },
        bridges(browser, command.bridges),
      );
    }
    if (command.command === "http") {
      issue(browser, "api", 1);
      reply({
        whoami: {
          organizationId: organization,
          projectId: command.projectId,
          audience: "api",
        },
        request: {
          id: command.requestId,
          title: load(`filed-${browser}`, {}).title,
          state: "submitted",
          type: "feature",
          targetProjectId: command.projectId,
        },
      });
    }
  };
  const person = () => {
    let buffer = "";

    write(1, `${JSON.stringify({ ready: { node: "v24.0.0" } })}\n`);
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (
        let end = buffer.indexOf("\n");
        end !== -1;
        end = buffer.indexOf("\n")
      ) {
        const { id, command, ...fields } = JSON.parse(buffer.slice(0, end));
        const reply = (result) =>
          write(
            1,
            `${JSON.stringify({
              id,
              ok: true,
              ...(fields.browser === undefined
                ? {}
                : {
                    browser: fields.browser,
                    browserVersion: `${fields.browser}-fake`,
                  }),
              result,
            })}\n`,
          );

        buffer = buffer.slice(end + 1);
        if (command === "signIn") reply({ landed: `${server}/`, session: 200 });
        if (command === "createProject") {
          reply({
            landed: `${server}/settings/projects`,
            projectId: projects[fields.browser],
          });
        }
        if (command === "seeRequest") {
          reply({
            shown:
              plant !== "seen" &&
              load(`filed-${fields.browser}`, {}).title === fields.title,
          });
        }
        if (command === "consent") {
          mark(`consented-${new URL(fields.url).searchParams.get("fake")}`);
          reply({
            callback: {
              origin: "http://127.0.0.1:41999",
              pathname: "/callback",
              queryKeys: ["code", "iss", "state"],
            },
            body: "RequestPort has the authorization.",
          });
        }
        if (command === "close") {
          mark("closed");
          reply({});
          process.exit(0);
        }
      }
    });
  };
  const database = (sql) => {
    if (sql === fake.sql.hba) {
      json([
        { type: "local", database: ["all"], address: null, method: "trust" },
        {
          type: "host",
          database: ["all"],
          address: "127.0.0.1",
          method: "scram-sha-256",
        },
      ]);
    }
    if (sql === fake.sql.migrations) json(fake.whens);
    if (sql === fake.sql.logins) {
      json(
        Object.entries(fake.instanceLogins).map(([kind, group]) => ({
          login: `rp_${instance}_${kind}`,
          canLogin: true,
          superuser: false,
          createdb: false,
          replication: false,
          bypassrls: false,
          createrole: false,
          groups: [group],
          comment: `requestport instance ${instance} database ${fake.database}`,
        })),
      );
    }
    if (sql === fake.sql.sessions) {
      json(flag("serving") ? { [`rp_${instance}_dispatcher`]: 2 } : {});
    }
    if (sql === fake.sql.oauth) {
      json({
        clients: 4,
        refreshTokens: Object.fromEntries(
          Object.keys(projects).flatMap((browser) =>
            stored(browser).map((audience) => [
              client(browser, audience),
              { issued: issued(browser)[audience], live: 1 },
            ]),
          ),
        ),
      });
    }
  };

  if (container.endsWith("-clean")) {
    if (nodeScript === fake.scripts.inspect) {
      json({
        node: "v22.0.0",
        npm: "10.0.0",
        uid: 1000,
        gid: 1000,
        home: fake.home,
        homeEntries: [],
        npmrc: false,
        globalNpmrc: false,
        tarballs: tarballs.map(({ file }) => file).sort(),
        readme: true,
        npmEnvironment: [],
      });
    }
    if (nodeScript === fake.scripts.processes) {
      json([
        {
          pid: 1,
          ppid: 0,
          pgrp: 1,
          cmd: "/sbin/docker-init -- sleep infinity",
        },
        { pid: 7, ppid: 1, pgrp: 7, cmd: "sleep infinity" },
        ...(flag("serving")
          ? [{ pid: 88, ppid: 0, pgrp: 88, cmd: "npm exec requestport start" }]
          : []),
      ]);
    }
    if (words[0] === "node" && words[1] === fake.agent) {
      agent(JSON.parse(fs.readFileSync(0, "utf8")));
    }
    if (script === 'ls -d "$HOME"/.npm/_npx/*/') answer(`${npx}/\n`);
    if (words.join(" ") === "npm ls --all") {
      answer(
        `${[
          npx,
          ...tarballs
            .slice(0, -1)
            .map(({ name, version }) => `+-- ${name}@${version}`),
          `\`-- requestport@${tarballs.at(-1).version}`,
        ].join("\n")}\n`,
        plant === "install-after" && flag("closed") ? 1 : 0,
      );
    }
    if (words[0] === "cat" && words[1] === `${npx}/package-lock.json`) {
      json({
        packages: Object.fromEntries(
          tarballs.map(({ name, file, integrity }) => [
            `node_modules/${name}`,
            { resolved: `file:/tarballs/${file}`, integrity },
          ]),
        ),
      });
    }
    if (words[0] === "cat" && words[1] === fake.startStderr) {
      const text = flag("start.stderr")
        ? fs.readFileSync(at("start.stderr"), "utf8")
        : "";

      if (text.includes("requestport start: serving ")) mark("serving-read");
      answer(text);
    }
    if (
      words[0] === "cat" &&
      words[1]?.endsWith("/.requestport/project.json")
    ) {
      json(load(`binding-${browserOf(path.dirname(path.dirname(words[1])))}`));
    }
    if (script === 'cat > "$1" && stat -c "%a %u" "$1"') {
      fs.readFileSync(0);
      answer("644 1000\n");
    }
    if (script === 'cat > "$1"') {
      fs.readFileSync(0);
      answer("");
    }
    if (script === "chmod 600 owner-url.txt") {
      mark("chmod");
      answer("");
    }
    if (words[0] === "stat")
      answer(flag("chmod") ? "600 1000\n" : "644 1000\n");
    if (words[0] === "mkdir") answer("");
    if (script.startsWith("du -sm ")) answer("12\n");
    if (/^kill -TERM -[0-9]+$/u.test(script)) {
      mark("stopped");
      answer("");
    }
    if (script.endsWith(" requestport --version")) {
      write(
        2,
        "npm http fetch GET 200 https://registry.npmjs.org/commander 12ms (cache miss)\n",
      );
      answer(`requestport ${tarballs.at(-1).version}\n`);
    }
    if (script.startsWith(`exec 2>>${fake.startStderr}; `)) return start();
    if (/ requestport login( |$)/u.test(script)) return login();
    if (/ requestport link /u.test(script)) link();
  }
  if (container.endsWith("-driver")) {
    if (nodeScript === fake.scripts.driverInspect) {
      const harness = load("mounts-driver", {})["/harness"];

      json({
        node: "v24.0.0",
        uid: 1001,
        browsersPath: "/ms-playwright",
        browsers: ["chromium-1", "webkit-1"],
        playwrightCore: JSON.parse(
          fs.readFileSync(
            path.join(harness, "node_modules/playwright-core/package.json"),
            "utf8",
          ),
        ).version,
        person: true,
        shmBytes: 67108864,
      });
    }
    if (nodeScript === fake.scripts.readiness) {
      json({
        ready: { status: 200, body: '{"ready":true}' },
        signIn: { status: 200, length: 1000, poweredBy: null },
      });
    }
    if (nodeScript === fake.scripts.port) {
      answer(flag("serving") ? "open\n" : "ECONNREFUSED\n");
    }
    if (words[0] === "node" && words[1] === fake.person) return person();
  }
  if (container.endsWith("-database")) {
    if (words[0] === "pg_isready") answer("");
    if (words[0] === "psql") database(words.at(-1));
  }
  write(2, `fake docker: nothing answers ${JSON.stringify(args)}\n`);
  process.exit(97);
}

/** The migrations journal the fake pack's `@requestport/db` carries. */
const FAKE_JOURNAL = Object.freeze({
  entries: [
    { idx: 0, when: 1700000000000, tag: "0000_first" },
    { idx: 1, when: 1700000000001, tag: "0001_second" },
  ],
});

/** What the fake docker knows of the harness: its paths, scripts and reads. */
const FAKE_CONSTANTS = Object.freeze({
  home: CONTAINER_HOME,
  startStderr: START_STDERR,
  agent: AGENT_IN_CONTAINER,
  person: PERSON_IN_CONTAINER,
  scripts: {
    inspect: INSPECT_SCRIPT,
    processes: PROCESSES_SCRIPT,
    driverInspect: DRIVER_INSPECT_SCRIPT,
    readiness: READINESS_SCRIPT,
    port: PORT_SCRIPT,
  },
  sql: DATABASE_SQL,
  instanceLogins: INSTANCE_LOGINS,
  database: DATABASE_NAME,
  whens: FAKE_JOURNAL.entries.map(({ when }) => String(when)),
});

const FAKE_DOCKER = `#!/usr/bin/env node
(${fakeDockerProgram.toString()})(require("node:fs"), require("node:path"), require("node:crypto"), ${JSON.stringify(FAKE_CONSTANTS)});
`;

/**
 * A pack directory whose record names the run's fourteen, each its own:
 * `requestport`'s a tarball holding the README, `@requestport/db`'s one
 * holding `FAKE_JOURNAL`.
 */
function fakePack(root) {
  const pack = join(root, "pack");
  const source = join(root, "source", "package");
  const holding = {
    requestport: "package/README.md",
    "@requestport/db": "package/migrations/meta/_journal.json",
  };

  mkdirSync(join(source, "migrations", "meta"), { recursive: true });
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(source, "README.md"), README);
  writeFileSync(
    join(source, "migrations", "meta", "_journal.json"),
    JSON.stringify(FAKE_JOURNAL),
  );

  const tarballs = TARBALLS.map(({ name, file }) => {
    if (Object.hasOwn(holding, name)) {
      const made = spawnSync("tar", [
        "-czf",
        join(pack, file),
        "-C",
        dirname(source),
        holding[name],
      ]);
      assert.equal(made.status, 0, String(made.stderr));
    } else {
      writeFileSync(join(pack, file), `not a tarball: ${name}\n`);
    }
    const bytes = readFileSync(join(pack, file));

    return {
      file,
      name,
      version: "0.0.0-t",
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      size: bytes.length,
      files: 1,
    };
  });

  writeFileSync(
    join(pack, "build-record.json"),
    JSON.stringify({
      commit: "0".repeat(40),
      treeStatus: "",
      node: "v22",
      pnpm: "11",
      tarballs,
    }),
  );

  return pack;
}

/**
 * The command, run with the fake docker first on PATH and TMPDIR given, and
 * `node`'s own options (`--import`) before the file when given.
 */
function startHarness(t, { root, args, env = {}, node = [] }) {
  const bin = join(root, "bin");
  const log = join(root, "docker.log");
  const environment = join(root, "docker-environment.log");

  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(log, "");
  writeFileSync(environment, "");

  const child = spawn(process.execPath, [...node, HARNESS, ...args], {
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_DOCKER_LOG: log,
      FAKE_DOCKER_ENVIRONMENT: environment,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";

  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  t.after(() => child.kill("SIGKILL"));

  const closed = new Promise((settle) =>
    child.on("close", (code, signal) => settle({ code, signal })),
  );
  const jsonLines = (path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  return {
    child,
    closed,
    calls: () => jsonLines(log),
    creations: () => jsonLines(environment),
    output: () => output,
  };
}

async function within(ms, condition) {
  const began = Date.now();

  while (!condition()) {
    if (Date.now() - began > ms) throw new Error(`not within ${ms} ms`);
    await new Promise((settle) => setTimeout(settle, 50));
  }
}

describe("the command, with a fake docker", () => {
  test("a run directory inside the repository is refused before docker is asked", async (t) => {
    const root = scratch(t, "clean-machine-cli-");
    const out = join(repositoryRoot, "clean-machine-run-refused");
    const run = startHarness(t, {
      root,
      args: ["--pack", fakePack(root), "--storage", "pglite", "--out", out],
      env: { TMPDIR: root },
    });
    const { code } = await run.closed;

    assert.equal(code, 1);
    assert.match(run.output(), /inside the repository/u);
    assert.deepEqual(run.calls(), []);
    assert.equal(existsSync(out), false);
  });

  test("a signal mid-run removes what it created, counts what is left, and removes the staging", async (t) => {
    const root = scratch(t, "clean-machine-cli-");
    const real = join(root, "real-tmp");
    const link = join(root, "link-tmp");
    const out = join(root, "out");

    mkdirSync(real);
    symlinkSync(real, link);

    const run = startHarness(t, {
      root,
      args: ["--pack", fakePack(root), "--storage", "pglite", "--out", out],
      env: { TMPDIR: link, FAKE_DOCKER_VERSION: "block" },
    });

    await within(20_000, () =>
      run
        .calls()
        .some(
          (call) => call[0] === "exec" && call.at(-1).endsWith("--version"),
        ),
    );
    run.child.kill("SIGTERM");

    const { code } = await run.closed;
    const calls = run.calls();
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    const clean = `${summary.run}-clean`;
    const versionAt = calls.findIndex(
      (call) => call[0] === "exec" && call.at(-1).endsWith("--version"),
    );
    const removedAt = calls.findIndex((call) => call[0] === "rm");

    assert.equal(code, 143, run.output());
    assert.equal(summary.signal, "SIGTERM");
    assert.equal(summary.exitCode, 143);
    assert.ok(removedAt > versionAt);
    assert.deepEqual(calls[removedAt], ["rm", "-f", "-v", clean]);
    assert.deepEqual(
      calls.slice(removedAt + 1).map(([command]) => command),
      ["ps", "volume", "network"],
    );
    assert.deepEqual(readdirSync(real), []);
    assert.equal(summary.stagingRemoved, true);

    // Every mount source is the path the link resolves to.
    const created = calls.find((call) => call[0] === "run");
    const sources = created
      .filter((_, index) => created[index - 1] === "-v")
      .map((volume) => volume.split(":")[0]);

    assert.equal(sources.length, 3);
    for (const source of sources) {
      assert.ok(source.startsWith(`${realpathSync(real)}/`), source);
    }
  });

  test("a failed creation, and a failed README line, fail the run and remove what was created", async (t) => {
    for (const env of [
      { FAKE_DOCKER_FAIL_RUN: "-clean" },
      { FAKE_DOCKER_VERSION: "fail" },
    ]) {
      const root = scratch(t, "clean-machine-cli-");
      const out = join(root, "out");
      const run = startHarness(t, {
        root,
        args: ["--pack", fakePack(root), "--storage", "pglite", "--out", out],
        env: { TMPDIR: root, ...env },
      });
      const { code } = await run.closed;
      const calls = run.calls();
      const summary = JSON.parse(
        readFileSync(join(out, "summary.json"), "utf8"),
      );

      assert.equal(code, 1, run.output());
      assert.deepEqual(
        calls.filter(([command]) => command === "rm"),
        [["rm", "-f", "-v", `${summary.run}-clean`]],
      );
      assert.match(summary.problems.at(-1), /^the run stopped: /u);
      assert.equal(summary.stagingRemoved, true);
    }
  });

  test("a container still listed after the teardown is a problem of the run", async (t) => {
    const root = scratch(t, "clean-machine-cli-");
    const out = join(root, "out");
    const run = startHarness(t, {
      root,
      args: ["--pack", fakePack(root), "--storage", "pglite", "--out", out],
      env: {
        TMPDIR: root,
        FAKE_DOCKER_VERSION: "fail",
        FAKE_DOCKER_LEFT: "c0ffee\n",
      },
    });
    const { code } = await run.closed;
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));

    assert.equal(code, 1, run.output());
    assert.deepEqual(summary.left, {
      containers: ["c0ffee"],
      volumes: [],
      networks: [],
    });
    assert.ok(
      summary.problems.includes(`left behind: ${JSON.stringify(summary.left)}`),
      JSON.stringify(summary.problems),
    );
  });

  test("on pg, the database is created after the clean container and before README 24, its password in docker's environment only, and removed before the clean one", async (t) => {
    const root = scratch(t, "clean-machine-cli-");
    const out = join(root, "out");
    const run = startHarness(t, {
      root,
      args: ["--pack", fakePack(root), "--storage", "pg", "--out", out],
      env: { TMPDIR: root, FAKE_DOCKER_VERSION: "fail" },
    });
    const { code } = await run.closed;
    const calls = run.calls();
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    const clean = `${summary.run}-clean`;
    const database = `${summary.run}-database`;
    const creations = run.creations();
    const created = calls.filter(([command]) => command === "run");
    const at = (find) => calls.findIndex(find);

    assert.equal(code, 1, run.output());
    assert.equal(summary.storage, "pg");
    assert.deepEqual(
      created.map((call) => call[call.indexOf("--name") + 1]),
      [clean, database],
    );
    assert.deepEqual(
      created[1].slice(1),
      databaseContainerArguments({
        run: summary.run,
        name: database,
        clean,
        image: DATABASE_IMAGE,
      }),
    );
    assert.ok(
      at((call) => call[0] === "run" && call.includes(database)) <
        at((call) => call[0] === "exec" && call.at(-1).endsWith("--version")),
    );

    // The password reached docker run's own environment for the database
    // alone, and is in no argument and no file the run kept.
    assert.deepEqual(
      creations.map(({ name }) => name),
      [clean, database],
    );
    assert.equal(creations[0].password, null);

    const { password } = creations[1];

    assert.match(password, /^[A-Za-z0-9_-]{32}$/u);
    assert.ok(!JSON.stringify(calls).includes(password));
    assert.deepEqual(filesHolding(out, password), []);
    assert.equal(summary.images.database.image, DATABASE_IMAGE);
    assert.deepEqual(
      calls.filter(([command]) => command === "rm"),
      [
        ["rm", "-f", "-v", database],
        ["rm", "-f", "-v", clean],
      ],
    );
    assert.match(summary.problems.at(-1), /^the run stopped: README \d+ /u);
    assert.equal(summary.stagingRemoved, true);
  });

  test("on pg, a database that is not created fails the run, and it and the clean container are removed", async (t) => {
    const root = scratch(t, "clean-machine-cli-");
    const out = join(root, "out");
    const run = startHarness(t, {
      root,
      args: ["--pack", fakePack(root), "--storage", "pg", "--out", out],
      env: { TMPDIR: root, FAKE_DOCKER_FAIL_RUN: "-database" },
    });
    const { code } = await run.closed;
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));

    assert.equal(code, 1, run.output());
    assert.deepEqual(
      run.calls().filter(([command]) => command === "rm"),
      [
        ["rm", "-f", "-v", `${summary.run}-database`],
        ["rm", "-f", "-v", `${summary.run}-clean`],
      ],
    );
    assert.match(
      summary.problems.at(-1),
      /^the run stopped: docker run .*-database exited 125/u,
    );
  });

  test("on pg, a pack whose @requestport/db carries no migrations journal is refused before docker is asked", async (t) => {
    const root = scratch(t, "clean-machine-cli-");
    const pack = fakePack(root);
    const record = JSON.parse(
      readFileSync(join(pack, "build-record.json"), "utf8"),
    );
    const db = record.tarballs.find(({ name }) => name === "@requestport/db");
    const bytes = Buffer.from("not a tarball: @requestport/db\n");

    writeFileSync(join(pack, db.file), bytes);
    db.size = bytes.length;
    db.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    writeFileSync(join(pack, "build-record.json"), JSON.stringify(record));

    const run = startHarness(t, {
      root,
      args: ["--pack", pack, "--storage", "pg", "--out", join(root, "out")],
      env: { TMPDIR: root },
    });
    const { code } = await run.closed;

    assert.equal(code, 1);
    assert.match(
      run.output(),
      /holds no package\/migrations\/meta\/_journal\.json/u,
    );
    assert.deepEqual(run.calls(), []);
  });
});

/**
 * A whole run with the fake docker playing every container
 * (`fakeDockerProgram` with a state directory), on `storage`, with `env`
 * added: its exit, its summary, docker's calls and the transcript's entries.
 */
async function wholeRun(t, storage, env = {}) {
  const root = scratch(t, "clean-machine-whole-");
  const state = join(root, "state");
  const out = join(root, "out");

  mkdirSync(state);

  const pack = fakePack(root);
  const run = startHarness(t, {
    root,
    args: ["--pack", pack, "--storage", storage, "--out", out],
    env: {
      TMPDIR: root,
      FAKE_DOCKER_STATE: state,
      FAKE_DOCKER_PACK: pack,
      ...env,
    },
  });
  const { code } = await run.closed;

  return {
    code,
    output: run.output(),
    calls: run.calls(),
    creations: run.creations(),
    out,
    summary: JSON.parse(readFileSync(join(out, "summary.json"), "utf8")),
    entries: readFileSync(join(out, "transcript.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

/** Each `docker exec` and `docker run` of a list of docker's arguments, sorted. */
const inContainers = (calls) =>
  calls
    .filter(([command]) => command === "exec" || command === "run")
    .map((call) => JSON.stringify(call))
    .sort();

describe("a whole run, with a fake docker playing every container", () => {
  test("on each storage it exits 0 with no problem, and the transcript holds every docker exec and docker run the run spawned, one to one, as spawned", async (t) => {
    for (const storage of ["pglite", "pg"]) {
      const run = await wholeRun(t, storage);
      const transcribed = run.entries
        .filter(({ kind }) => kind === "harness" || kind === "readme")
        .map(({ argv }) => argv.slice(1));

      assert.equal(run.code, 0, `${storage}: ${run.output}`);
      assert.deepEqual(run.summary.problems, [], storage);
      assert.ok(transcribed.length > 50, `${storage}: ${transcribed.length}`);
      assert.deepEqual(inContainers(run.calls), inContainers(transcribed));
      assert.deepEqual(
        run.entries.filter(({ kind }) => kind === "readme").length,
        storage === "pg" ? 9 : 8,
        storage,
      );
      if (storage === "pg") {
        const { password } = run.creations.find(({ name }) =>
          name.endsWith("-database"),
        );

        assert.ok(!JSON.stringify(run.calls).includes(password));
        assert.deepEqual(filesHolding(run.out, password), []);
      }
    }
  });

  test("a start that says it serves before its credential reaches standard output still exits 0 with no problem: the run waits for the credential's line (ruling 202 item 3)", async (t) => {
    // On PGlite alone: the wait is the same code on either storage.
    const run = await wholeRun(t, "pglite", {
      FAKE_DOCKER_START: "serving-first",
    });

    assert.equal(run.code, 0, run.output);
    assert.deepEqual(run.summary.problems, []);
    assert.equal(run.summary.steps.start.stdout.credentialShaped, 1);
    // The cat that saw "serving" saw no credential: it came a turn later.
    assert.ok(
      run.summary.steps.start.stdout.credentialAfterServingMs > 0,
      JSON.stringify(run.summary.steps.start),
    );
  });

  test("each judge's problem reaches the summary and the exit code: login, the refresh spent, the request seen, the install after the agents, the stop, the worker and the scheduler", async (t) => {
    const login = readmeLine(README, README_STEPS.login).number;

    for (const [plant, expected] of [
      [
        "login",
        `chromium: README ${login} stored a credential on http://127.0.0.1:3201, not http://127.0.0.1:3200`,
      ],
      [
        "spent",
        "chromium: the agent's file left the mcp credential's refresh token as it was",
      ],
      [
        "seen",
        (run) =>
          `chromium: /requests does not show "Filed from Chromium in ${run}", which the agent filed`,
      ],
      ["install-after", "after the agents, npm ls --all exited 1"],
      ["stop", "start's standard error has no `stopped` line"],
      ["worker", "start logged worker.ready 0 time(s), not once"],
      [
        "scheduler",
        "start logged no retention.category_completed: no scheduler tick ran the retention-cleanup schedule through the exclusive runner",
      ],
    ]) {
      const run = await wholeRun(t, "pglite", { FAKE_DOCKER_PLANT: plant });
      const problem =
        typeof expected === "function" ? expected(run.summary.run) : expected;

      assert.equal(run.code, 1, `${plant}: ${run.output}`);
      assert.equal(run.summary.exitCode, 1, plant);
      assert.ok(
        run.summary.problems.includes(problem),
        `${plant}: ${JSON.stringify(run.summary.problems)}`,
      );
      assert.ok(
        run.summary.problems.every((found) => !/^the run stopped/u.test(found)),
        `${plant}: ${JSON.stringify(run.summary.problems)}`,
      );
    }
  });

  test("an uncaught exception, and an unhandled rejection, end the run through the teardown: a problem, the containers removed, the summary written, the staging removed", async (t) => {
    for (const [how, planted] of [
      [
        "an uncaught exception",
        'setTimeout(() => { throw new Error("planted"); });',
      ],
      ["an unhandled rejection", 'Promise.reject(new Error("planted"));'],
    ]) {
      const root = scratch(t, "clean-machine-uncaught-");
      const out = join(root, "out");
      const preload = join(root, "plant.mjs");

      // Once README 24 is asked for (and blocks), the plant fires in the
      // harness's own process, outside any try main holds.
      writeFileSync(
        preload,
        `import { readFileSync } from "node:fs";
const timer = setInterval(() => {
  if (readFileSync(process.env.FAKE_DOCKER_LOG, "utf8").includes('--version"]')) {
    clearInterval(timer);
    ${planted}
  }
}, 50);
timer.unref();
`,
      );

      const run = startHarness(t, {
        root,
        node: ["--import", pathToFileURL(preload).href],
        args: ["--pack", fakePack(root), "--storage", "pglite", "--out", out],
        env: { TMPDIR: root, FAKE_DOCKER_VERSION: "block" },
      });
      const { code } = await run.closed;
      const summaryFile = join(out, "summary.json");

      assert.equal(code, 1, `${how}: ${run.output()}`);
      assert.ok(existsSync(summaryFile), `${how}: ${run.output()}`);

      const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
      const calls = run.calls();

      assert.equal(summary.exitCode, 1, how);
      assert.equal(summary.problems.at(-1), `${how} ended the run: planted`);
      assert.deepEqual(
        calls.filter(([command]) => command === "rm"),
        [["rm", "-f", "-v", `${summary.run}-clean`]],
        how,
      );
      assert.equal(summary.stagingRemoved, true, how);
    }
  });
});

describe("the pg path", () => {
  const chmodLine = readmeLine(README, README_STEPS.ownerUrlMode);
  const startLine = readmeLine(README, README_STEPS.startPg);

  test("the command takes --storage pglite or pg, and nothing else", () => {
    for (const storage of ["pglite", "pg"]) {
      assert.equal(
        parseCommandLine(["--pack", "p", "--storage", storage]).storage,
        storage,
      );
    }
    assert.throws(
      () => parseCommandLine(["--pack", "p", "--storage", "postgres"]),
      /--storage must be pglite or pg/u,
    );
  });

  test("the database container shares the clean container's namespace, listens on 127.0.0.1, keeps its data on a tmpfs and its password out of its arguments", () => {
    const args = databaseContainerArguments({
      run: "r1",
      name: "r1-database",
      clean: "r1-clean",
      image: DATABASE_IMAGE,
    });

    assert.equal(DATABASE_IMAGE, "postgres:17-alpine");
    assert.deepEqual(args, [
      "-d",
      "--name",
      "r1-database",
      "--label",
      `${RUN_LABEL}=r1`,
      "--network",
      "container:r1-clean",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_DB=requestport",
      "-e",
      "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
      "postgres:17-alpine",
      "-c",
      "listen_addresses=127.0.0.1",
    ]);
    for (const flag of [
      "-p",
      "--publish",
      "-P",
      "--publish-all",
      "-v",
      "--volume",
      "--mount",
    ]) {
      assert.ok(!args.includes(flag), flag);
    }
    assert.ok(!args.join(" ").includes("3100"));
  });

  test("the owner URL is built at run time: the image's superuser, the run's password, 127.0.0.1 and the image's database", () => {
    const password = databasePassword();
    const url = new URL(ownerUrlOf(password));

    assert.match(password, /^[A-Za-z0-9_-]{32}$/u);
    assert.notEqual(databasePassword(), password);
    assert.equal(url.protocol, "postgres:");
    assert.equal(url.username, "postgres");
    assert.equal(url.password, password);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "5432");
    assert.equal(url.pathname, "/requestport");
    assert.equal(url.search, "");
    for (const refused of [undefined, "short", `${"a".repeat(31)}@/`]) {
      assert.throws(() => ownerUrlOf(refused), /32 or more URL-safe/u);
    }
    // No URL with a password is written in the harness.
    assert.doesNotMatch(
      readFileSync(HARNESS, "utf8"),
      /postgres(?:ql)?:\/\/[^\s/@:]+:[^\s/@]+@/iu,
    );
  });

  test("README 58 and README 59 name one owner URL file, a plain name in the directory they run in", () => {
    assert.equal(chmodLine.line, "chmod 600 owner-url.txt");
    assert.equal(startLine.number, chmodLine.number + 1);
    assert.match(
      startLine.line,
      /^npx requestport@<version> start --owner-url-file owner-url\.txt --email /u,
    );
    assert.equal(
      ownerUrlFileOf({ chmod: chmodLine.line, start: startLine.line }),
      "owner-url.txt",
    );
    assert.deepEqual(ownerOf(startLine.line), {
      email: "owner@example.com",
      organizationName: "Acme",
    });
    assert.equal(
      substitute(chmodLine.line, { readme: README, tarballs: TARBALLS })
        .command,
      chmodLine.line,
    );
    assert.throws(
      () =>
        ownerUrlFileOf({ chmod: "chmod 600 other.txt", start: startLine.line }),
      /one file was expected/u,
    );
    assert.throws(
      () =>
        ownerUrlFileOf({
          chmod: "chmod 600 ../owner-url.txt",
          start: startLine.line.replace("owner-url.txt", "../owner-url.txt"),
        }),
      /not a plain file name/u,
    );
  });

  test("the database's TCP rules must each ask for a SCRAM password", () => {
    const local = { type: "local", address: null, method: "trust" };
    const scram = (address) => ({
      type: "host",
      address,
      method: "scram-sha-256",
    });

    assert.deepEqual(
      hbaProblems([local, scram("127.0.0.1"), scram("::1"), scram("all")]),
      [],
    );
    assert.deepEqual(
      hbaProblems([
        local,
        { type: "host", address: "127.0.0.1", method: "trust" },
        scram("all"),
      ]),
      [
        "the database's host rule for 127.0.0.1 asks for trust, not a SCRAM password",
      ],
    );
    assert.deepEqual(hbaProblems([local]), ["the database has no TCP rule"]);
  });

  test("the journal start applied is @requestport/db's, each migration once, read from its tarball", (t) => {
    const journal = {
      entries: [
        { when: 1, tag: "0000_a" },
        { when: 2, tag: "0001_b" },
        { when: 3, tag: "0002_c" },
      ],
    };

    assert.deepEqual(
      migrationProblems({ applied: ["3", "1", "2"], journal }),
      [],
    );
    for (const applied of [
      ["1", "2"],
      ["1", "2", "3", "4"],
      ["1", "2", "4"],
    ]) {
      assert.equal(
        migrationProblems({ applied, journal }).length,
        1,
        JSON.stringify(applied),
      );
    }
    assert.match(
      migrationProblems({ applied: ["1", "2", "4"], journal })[0],
      /holds 3 row\(s\), not the 3 of @requestport\/db's journal: missing \["3"\], not in it \["4"\]/u,
    );

    const root = scratch(t, "clean-machine-journal-");
    const pack = fakePack(root);
    const db = TARBALLS.find(({ name }) => name === "@requestport/db");

    assert.deepEqual(journalOf(join(pack, db.file)), FAKE_JOURNAL);
    assert.throws(
      () => journalOf(join(pack, TARBALLS.at(-1).file)),
      /holds no package\/migrations\/meta\/_journal\.json/u,
    );
  });

  const ID = "a1b2c3d4e5";
  const login = (kind, changes = {}) => ({
    login: `rp_${ID}_${kind}`,
    canLogin: true,
    superuser: false,
    createdb: false,
    replication: false,
    bypassrls: false,
    createrole: false,
    groups: [INSTANCE_LOGINS[kind]],
    comment: `requestport instance ${ID} database requestport`,
    ...changes,
  });
  const FOUR = Object.keys(INSTANCE_LOGINS).map((kind) => login(kind));

  test("the instance's four logins: one instance, each able to log in with no attribute, in its group alone, carrying the claim", () => {
    assert.deepEqual(
      instanceLoginProblems({ logins: FOUR, database: "requestport" }),
      [],
    );

    const judged = (logins) =>
      instanceLoginProblems({ logins, database: "requestport" });

    assert.match(judged(FOUR.slice(1)).join("\n"), /not one of each/u);
    assert.match(
      judged([
        login("application", { superuser: true }),
        ...FOUR.slice(1),
      ]).join("\n"),
      /rp_a1b2c3d4e5_application holds superuser/u,
    );
    assert.match(
      judged([
        login("application", { bypassrls: true, createrole: true }),
        ...FOUR.slice(1),
      ]).join("\n"),
      /holds bypassrls, createrole/u,
    );
    assert.match(
      judged([
        login("application", { canLogin: false }),
        ...FOUR.slice(1),
      ]).join("\n"),
      /cannot log in/u,
    );
    assert.match(
      judged([
        login("application", {
          groups: ["requestport_application", "requestport_maintenance"],
        }),
        ...FOUR.slice(1),
      ]).join("\n"),
      /not requestport_application alone/u,
    );
    assert.match(
      judged([
        login("application", {
          comment: `requestport instance ${ID} database elsewhere`,
        }),
        ...FOUR.slice(1),
      ]).join("\n"),
      /not the claim on requestport/u,
    );
    assert.match(
      judged([
        ...FOUR,
        {
          ...login("application"),
          login: "rp_ffffffff_application",
          comment: "requestport instance ffffffff database requestport",
        },
      ]).join("\n"),
      /name 2 instance\(s\)/u,
    );
    assert.match(
      judged([...FOUR, { ...login("application"), login: "rp_someone" }]).join(
        "\n",
      ),
      /rp_someone is not one of an instance's four logins' names/u,
    );
  });

  test("the four logins' names, groups and claim are packages/db's operator session's", () => {
    const session = readFileSync(
      join(repositoryRoot, "packages/db/src/operator-session.ts"),
      "utf8",
    );
    const tenant = readFileSync(
      join(repositoryRoot, "packages/db/src/tenant-context.ts"),
      "utf8",
    );
    const entries = (text, name) =>
      Object.fromEntries(
        [
          ...(
            new RegExp(
              `${name}[^=]*=\\s*Object\\.freeze\\(\\{([^}]*)\\}`,
              "u",
            ).exec(text)?.[1] ?? ""
          ).matchAll(/(\w+): "([a-z_]+)"/gu),
        ].map(([, key, value]) => [key, value]),
      );
    const suffixes = entries(session, "const LOGIN_SUFFIXES");
    const groups = {
      ...entries(session, "export const INSTANCE_LOGIN_GROUPS"),
      ...entries(tenant, "export const WORKER_GROUP_ROLES"),
    };

    assert.equal(Object.keys(suffixes).length, 4, JSON.stringify(suffixes));
    assert.deepEqual(
      INSTANCE_LOGINS,
      Object.fromEntries(
        Object.entries(suffixes).map(([kind, suffix]) => [
          suffix,
          groups[kind],
        ]),
      ),
    );
    assert.match(
      session,
      /return `requestport instance \$\{instanceId\} database \$\{database\}`;/u,
    );
  });

  test("a bridge step on pg must add one refresh token per bridge for the stored client, leave one unrevoked, and register no client", () => {
    const client = "c".repeat(64);
    const snapshot = (issued, clients = 2, live = 1) => ({
      audiences: {
        mcp: { clientIdSha256: client, refreshTokenSha256: `r${issued}` },
      },
      server: {
        clients,
        refreshTokens: issued === 0 ? {} : { [client]: { issued, live } },
      },
    });
    const judged = (before, after, issued = 2) =>
      refreshCountProblems({
        browser: "chromium",
        step: "the agent's pair",
        audience: "mcp",
        before,
        after,
        issued,
      });

    assert.deepEqual(judged(snapshot(3), snapshot(5)), []);
    assert.deepEqual(judged(snapshot(0), snapshot(1), 1), []);
    assert.deepEqual(judged(snapshot(3), snapshot(4)), [
      "chromium: the agent's pair: the server issued 1 refresh token(s) to the mcp client, not 2",
    ]);
    assert.deepEqual(judged(snapshot(3), snapshot(6)), [
      "chromium: the agent's pair: the server issued 3 refresh token(s) to the mcp client, not 2",
    ]);
    assert.deepEqual(judged(snapshot(3), snapshot(5, 3)), [
      "chromium: the agent's pair: the server's OAuth clients went from 2 to 3",
    ]);
    assert.deepEqual(judged(snapshot(3), snapshot(5, 2, 2)), [
      "chromium: the agent's pair: the server holds 2 unrevoked refresh token(s) for the mcp client, not one",
    ]);
    assert.deepEqual(
      judged({ audiences: snapshot(3).audiences }, snapshot(5)),
      [
        "chromium: the agent's pair: the server's counts were not read before and after it",
      ],
    );
    assert.deepEqual(judged(snapshot(3), { ...snapshot(5), audiences: {} }), [
      "chromium: the agent's pair: no mcp credential was stored after it",
    ]);
  });

  test("while start serves, every session on the database is one of the instance's four logins; after the stop, none is open", () => {
    const logins = FOUR.map(({ login: name }) => name);
    const serving = {
      [`rp_${ID}_dispatcher`]: 4,
      [`rp_${ID}_maintenance`]: 1,
      [`rp_${ID}_tenant_processor`]: 1,
    };

    assert.deepEqual(
      sessionProblems({ sessions: serving, logins, when: "once start served" }),
      [],
    );
    assert.deepEqual(
      sessionProblems({
        sessions: { ...serving, postgres: 1 },
        logins,
        when: "before the stop",
      }),
      [
        "before the stop, the database has 1 session(s) as postgres, not one of the instance's four logins",
      ],
    );
    assert.deepEqual(
      sessionProblems({
        sessions: {},
        logins,
        when: "after the stop",
        stopped: true,
      }),
      [],
    );
    assert.deepEqual(
      sessionProblems({
        sessions: { [`rp_${ID}_application`]: 1 },
        logins,
        when: "after the stop",
        stopped: true,
      }),
      [
        `after the stop, the database has sessions open: {"rp_${ID}_application":1}`,
      ],
    );
  });

  test("the harness names its database commands, and its psql reads select no client id and no token", () => {
    for (const name of [
      "database readiness",
      "owner url",
      "owner url mode",
      "psql",
    ]) {
      assert.ok(HARNESS_COMMANDS.includes(name), name);
    }

    const oauth = DATABASE_SQL.oauth
      .replace("encode(sha256(convert_to(client_id, 'UTF8')), 'hex')", "")
      .replace("group by client_id", "");

    assert.doesNotMatch(oauth, /client_id/u);
    for (const sql of Object.values(DATABASE_SQL)) {
      assert.doesNotMatch(sql, /\btoken\b/u);
    }
  });
});

const PROJECT = "0198a1f2-1111-7222-8333-944445555666";
const ORGANIZATION = "0198a1f2-aaaa-7bbb-8ccc-9ddddeeeefff";
const SERVER = "http://127.0.0.1:3200";

describe("the agent's README lines", () => {
  const linkLine = readmeLine(README, README_STEPS.link);
  const apiLine = readmeLine(README, README_STEPS.loginApi);

  test("README 148 is the one link line, and README 169 the one login --for api line", () => {
    assert.equal(
      linkLine.line,
      `npx ${PUBLISHED_FORM} link --server http://127.0.0.1:3200 --project <project id>`,
    );
    assert.equal(apiLine.line, `npx ${PUBLISHED_FORM} login --for api`);
    assert.equal(linkLine.line, README.split("\n")[linkLine.number - 1]);
    assert.equal(apiLine.line, README.split("\n")[apiLine.number - 1]);
  });

  test("README 148's slot is filled once, with a project id only, and never left unfilled", () => {
    const issued = substitute(linkLine.line, {
      readme: README,
      tarballs: TARBALLS,
      slots: { "<project id>": PROJECT },
    });

    assert.equal(issued.readme, linkLine.line);
    assert.equal(issued.readmeLine, linkLine.number);
    assert.deepEqual(issued.slots, { "<project id>": PROJECT });
    assert.ok(
      issued.command.endsWith(
        ` requestport link --server http://127.0.0.1:3200 --project ${PROJECT}`,
      ),
      issued.command,
    );
    assert.ok(!issued.command.includes("<project id>"));
    assert.deepEqual(Object.keys(README_SLOTS), ["<project id>"]);

    const refused = (line, slots) =>
      assert.throws(() =>
        substitute(line, { readme: README, tarballs: TARBALLS, slots }),
      );

    assert.throws(
      () => substitute(linkLine.line, { readme: README, tarballs: TARBALLS }),
      /names <project id>, and no value fills it/u,
    );
    for (const value of [
      PROJECT.toUpperCase(),
      `${PROJECT}; touch /tmp/x`,
      "",
      42,
    ]) {
      refused(linkLine.line, { "<project id>": value });
    }
    assert.throws(
      () =>
        substitute(linkLine.line, {
          readme: README,
          tarballs: TARBALLS,
          slots: { "<project id>": PROJECT, "<version>": "1.0.0" },
        }),
      /<version> is not a slot the run fills/u,
    );
    assert.throws(
      () =>
        substitute(apiLine.line, {
          readme: README,
          tarballs: TARBALLS,
          slots: { "<project id>": PROJECT },
        }),
      /does not name <project id> once/u,
    );
  });

  test("the MCP configuration is README 156-163, with the one substitution in its args", () => {
    const made = mcpConfiguration({ readme: README, tarballs: TARBALLS });
    const readmeLines = README.split("\n");
    const words = [
      `--@requestport:registry=${CLOSED_REGISTRY}`,
      ...TARBALLS.flatMap(({ file }) => ["-p", `file:/tarballs/${file}`]),
      "requestport",
    ];

    assert.equal(readmeLines[made.from - 2], "```json");
    assert.equal(readmeLines[made.to], "```");
    assert.equal(
      made.readme,
      readmeLines.slice(made.from - 1, made.to).join("\n"),
    );
    assert.deepEqual(JSON.parse(made.readme).mcpServers.requestport.args, [
      PUBLISHED_FORM,
      "mcp",
    ]);
    assert.deepEqual(made.configuration, {
      mcpServers: {
        requestport: { command: "npx", args: [...words, "mcp"] },
      },
    });
    assert.deepEqual(JSON.parse(made.text), made.configuration);
    // The agent reads it back as the one server it starts.
    assert.deepEqual(serverOf(made.text), {
      command: "npx",
      args: [...words, "mcp"],
    });
  });

  test("a README whose configuration does not run npx requestport@<version> once is refused", () => {
    const block = mcpConfiguration({ readme: README, tarballs: TARBALLS });
    const changed = (text) => README.replace(block.readme, text);

    assert.throws(
      () =>
        mcpConfiguration({
          readme: changed(block.readme.replace(PUBLISHED_FORM, "requestport")),
          tarballs: TARBALLS,
        }),
      /do not run npx requestport@<version> once/u,
    );
    assert.throws(
      () =>
        mcpConfiguration({
          readme: changed(block.readme.replace('"npx"', '"node"')),
          tarballs: TARBALLS,
        }),
      /do not run npx/u,
    );
    assert.throws(
      () =>
        mcpConfiguration({
          readme: `${README}\n\`\`\`json\n${block.readme}\n\`\`\`\n`,
          tarballs: TARBALLS,
        }),
      /hold 2 MCP configuration\(s\)/u,
    );
  });

  test("the existing principal is offered under the client name login registers", () => {
    const authorize = readFileSync(
      join(repositoryRoot, "packages/client/src/authorize.ts"),
      "utf8",
    );

    assert.equal(
      /export const AGENT_CLIENT_NAME = "([^"]+)";/u.exec(authorize)?.[1],
      AGENT_CLIENT_NAME,
    );
    assert.equal(
      principalOption({ organizationName: "Acme" }),
      `Acme / ${AGENT_CLIENT_NAME}`,
    );
  });
});

describe("the agent's judges", () => {
  const serving = `requestport mcp: serving project ${PROJECT} (chromium-project) on ${SERVER}.`;
  const consentLine = (command) =>
    `requestport ${command}: to authorize the mcp credential, open this URL in a browser:`;

  test("a consent asked for is a line any of login, link and mcp prints", () => {
    for (const command of ["login", "link", "mcp"]) {
      assert.ok(CONSENT_LINE.test(`npm http fetch\n${consentLine(command)}\n`));
    }
    assert.ok(!CONSENT_LINE.test(serving));
  });

  test("a login --for api must store one api credential", () => {
    const login = {
      readmeLine: 169,
      status: 0,
      stored: [
        {
          audience: "mcp",
          projectId: PROJECT,
          organizationId: ORGANIZATION,
          server: SERVER,
        },
      ],
      fetches: { problems: [] },
    };
    const judge = (stored) =>
      loginProblems({
        browser: "chromium",
        login: { ...login, stored },
        server: SERVER,
        projectId: PROJECT,
        consent: { body: "RequestPort has the authorization." },
        audience: "api",
      });

    assert.deepEqual(judge([{ ...login.stored[0], audience: "api" }]), []);
    assert.deepEqual(judge(login.stored), [
      "chromium: README 169 stored the mcp credential, not api",
    ]);
  });

  test("a link must use the stored credential, ask for no consent and leave the binding it names", () => {
    const checkout = `${CHECKOUTS}/chromium`;
    const binding = {
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      projectSlug: "chromium-project",
      server: SERVER,
    };
    const good = {
      readmeLine: 148,
      status: 0,
      stdout: [
        `Using the mcp credential stored for project ${PROJECT} (organization ${ORGANIZATION}) on ${SERVER}.`,
        `Wrote ${checkout}/.requestport/project.json: this checkout is bound to project ${PROJECT} (chromium-project) of organization ${ORGANIZATION} on ${SERVER}.`,
        "",
      ].join("\n"),
      stderr:
        "npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 1ms\n",
      fetches: { problems: [] },
    };
    const judge = (link, left = binding) =>
      linkProblems({
        browser: "chromium",
        link,
        server: SERVER,
        projectId: PROJECT,
        organizationId: ORGANIZATION,
        slug: "chromium-project",
        checkout,
        binding: left,
      });

    assert.deepEqual(judge(good), []);
    assert.deepEqual(
      judge(
        {
          ...good,
          status: 1,
          stdout: "",
          stderr: `${consentLine("link")}\n`,
          fetches: {
            problems: ["npm asked registry.npmjs.org for requestport"],
          },
        },
        { ...binding, projectSlug: "other" },
      ),
      [
        "chromium: README 148 exited 1",
        "chromium: README 148 asked for a consent",
        `chromium: README 148 did not say it used the mcp credential stored for project ${PROJECT}`,
        `chromium: README 148 did not say it bound ${checkout}`,
        `chromium: README 148 left the binding ${JSON.stringify({ ...binding, projectSlug: "other" })}, not ${JSON.stringify(binding)}`,
        "chromium: README 148: npm asked registry.npmjs.org for requestport",
      ],
    );
    assert.equal(judge(good, null).length, 1);
  });

  const bridge = (overrides = {}) => ({
    startedMs: 10,
    connectedMs: 900,
    closedMs: 1000,
    pid: 7,
    stderr: `npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 1ms\n${serving}\n`,
    transportErrors: [],
    ...overrides,
  });
  const whoami = {
    organizationId: ORGANIZATION,
    projectId: PROJECT,
    audience: "x",
  };
  const judgeBridges = (answer, bridges = 2, asked = true) =>
    bridgeProblems({
      browser: "chromium",
      step: "pair",
      answer,
      bridges,
      whoami: asked,
      server: SERVER,
      projectId: PROJECT,
      organizationId: ORGANIZATION,
      slug: "chromium-project",
    });

  test("two bridges at once, each serving the project and naming it by whoami, pass", () => {
    assert.deepEqual(
      judgeBridges({
        ok: true,
        result: { whoami: [whoami, whoami] },
        bridges: [bridge(), bridge({ startedMs: 12, connectedMs: 950 })],
      }),
      [],
    );
  });

  test("a consent asked, no serving line, a transport error, a leaked request, another project, or bridges not at once are each a problem", () => {
    const said = "chromium: the agent's pair";

    assert.deepEqual(
      judgeBridges({
        ok: true,
        result: { whoami: [whoami, { ...whoami, projectId: "other" }] },
        bridges: [
          bridge({
            stderr: `${consentLine("mcp")}\nnpm http fetch GET 200 https://registry.npmjs.org/@requestport%2fdb 5ms (cache miss)\n`,
            transportErrors: ["SyntaxError: not JSON"],
          }),
          bridge({ startedMs: 950, connectedMs: 1200 }),
        ],
      }),
      [
        `${said}, bridge 1 asked for a consent`,
        `${said}, bridge 1 did not say it serves project ${PROJECT}`,
        `${said}, bridge 1: its transport reported SyntaxError: not JSON`,
        `${said}, bridge 1: npm asked registry.npmjs.org for @requestport/db (GET https://registry.npmjs.org/@requestport%2fdb, 200)`,
        `${said}, bridge 2's whoami names organization ${ORGANIZATION} and project other, not ${ORGANIZATION} and ${PROJECT}`,
        `${said}: a bridge connected (900 ms) before the last one started (950 ms), so they did not run at once`,
      ],
    );
    assert.deepEqual(
      judgeBridges({
        ok: false,
        error: "agent: whoami: bridge 2: closed",
        bridges: [bridge()],
      }),
      [
        `${said}: agent: whoami: bridge 2: closed`,
        `${said} started 1 bridge(s), not 2`,
      ],
    );
    assert.deepEqual(
      judgeBridges({
        ok: true,
        result: { whoami: [whoami] },
        bridges: [bridge(), bridge()],
      }),
      [`${said} answered 1 whoami, not 2`],
    );
  });

  test("a bridge step must keep the client id, change the refresh token and leave no lock", () => {
    const snapshot = (refresh, client = "c", locks = []) => ({
      audiences: {
        mcp: { clientIdSha256: client, refreshTokenSha256: refresh },
      },
      locks,
      fileLock: false,
    });
    const judge = (before, after) =>
      rotationProblems({
        browser: "webkit",
        step: "the agent's pair",
        audience: "mcp",
        before,
        after,
      });

    assert.deepEqual(judge(snapshot("r1"), snapshot("r2")), []);
    assert.deepEqual(judge(snapshot("r1"), snapshot("r1", "d", ["x.lock"])), [
      "webkit: the agent's pair changed the mcp credential's client id",
      "webkit: the agent's pair left the mcp credential's refresh token as it was",
      'webkit: the agent\'s pair left a lock: {"locks":["x.lock"],"fileLock":false}',
    ]);
    assert.deepEqual(judge({ audiences: {} }, snapshot("r2")), [
      "webkit: the agent's pair: no mcp credential was stored before it",
    ]);
    assert.deepEqual(
      judge(snapshot("r1"), { ...snapshot("r2"), fileLock: true }),
      ['webkit: the agent\'s pair left a lock: {"locks":[],"fileLock":true}'],
    );
  });

  test("the packed HTTP client must read the filed request, with its title and state, for the project", () => {
    const answer = {
      ok: true,
      result: {
        whoami,
        request: {
          id: "r",
          title: "Filed",
          state: "submitted",
          targetProjectId: PROJECT,
        },
      },
    };
    const judge = (given) =>
      requestProblems({
        browser: "webkit",
        answer: given,
        requestId: "r",
        title: "Filed",
        state: "submitted",
        projectId: PROJECT,
        organizationId: ORGANIZATION,
      });

    assert.deepEqual(judge(answer), []);
    assert.deepEqual(
      judge({
        ok: true,
        result: {
          whoami: { ...whoami, projectId: "other" },
          request: { ...answer.result.request, title: "Other", state: "draft" },
        },
      }),
      [
        `webkit: the packed HTTP client's whoami names organization ${ORGANIZATION} and project other, not ${ORGANIZATION} and ${PROJECT}`,
        'webkit: the packed HTTP client read the request\'s title as "Other", not "Filed"',
        'webkit: the packed HTTP client read the request\'s state as "draft", not "submitted"',
      ],
    );
    assert.deepEqual(judge({ ok: false, error: "agent: http: refused" }), [
      "webkit: the packed HTTP client: agent: http: refused",
    ]);
  });

  test("a HostHandoffRefusalError line on start's standard error is a problem (ruling 145)", () => {
    assert.deepEqual(
      startStderrProblems("requestport start: serving x;\n"),
      [],
    );
    assert.deepEqual(
      startStderrProblems(
        "requestport start: serving x;\nHostHandoffRefusalError: storage was refused\n",
      ),
      [
        "start's standard error holds 1 HostHandoffRefusalError line(s): a factory in Next's copy was refused the host's handoff",
      ],
    );
  });

  test("start's standard output is read for its log events, by name and count only: the credential and every field are left out", () => {
    const credential = `${"E".repeat(21)}_-${"f".repeat(20)}`;
    const stdout = [
      '{"level":"info","event":"database.role_guard.role","status":"passed"}',
      credential,
      '{"level":"info","event":"worker.ready","status":"ready"}',
      "not json",
      '{"level":"info","event":"outbox.drained","count":2}',
      '{"level":"info","event":"outbox.drained","count":1}',
      '["an array"]',
      '{"level":"info","status":"no event"}',
    ].join("\n");

    assert.deepEqual(startEvents(stdout), {
      "database.role_guard.role": 1,
      "outbox.drained": 2,
      "worker.ready": 1,
    });
    assert.ok(!JSON.stringify(startEvents(stdout)).includes(credential));
  });

  test("the in-process worker must say it is ready, once, on start's standard error and in its log, with PGlite's exclusive runner named on PGlite, log the retention-cleanup schedule's body (a scheduler tick), and log no failed start, tick or schedule", () => {
    const url = "http://127.0.0.1:3200";
    const ready = `requestport start: serving ${url}; the in-process worker is ready.`;
    const runner =
      "requestport start: storage worker: unbound, on the application storage, with the in-process exclusive runner.";
    const judge = (storage, stderr, events) =>
      workerProblems({ storage, url, stderr, events });
    const ticked = { "worker.ready": 1, "retention.category_completed": 9 };

    assert.deepEqual(judge("pglite", `${runner}\n${ready}\n`, ticked), []);
    assert.deepEqual(judge("pg", `${ready}\n`, ticked), []);
    assert.deepEqual(
      judge("pglite", `${runner}\n${ready}\n`, { "worker.ready": 1 }),
      [
        "start logged no retention.category_completed: no scheduler tick ran the retention-cleanup schedule through the exclusive runner",
      ],
    );
    assert.deepEqual(
      judge("pglite", `${ready}\n`, {
        "worker.ready": 2,
        "retention.category_completed": 1,
        "worker.tick_failed": 1,
        "schedule.failed": 3,
        "worker.start_failed": 1,
      }),
      [
        "start's standard error does not name the in-process exclusive runner PGlite's worker runs through",
        "start logged worker.ready 2 time(s), not once",
        "start logged worker.start_failed 1 time(s)",
        "start logged worker.tick_failed 1 time(s)",
        "start logged schedule.failed 3 time(s)",
      ],
    );
    assert.deepEqual(judge("pg", `requestport start: serving ${url};\n`, {}), [
      `start's standard error does not say "serving ${url}; the in-process worker is ready."`,
      "start logged worker.ready 0 time(s), not once",
      "start logged no retention.category_completed: no scheduler tick ran the retention-cleanup schedule through the exclusive runner",
    ]);
  });

  test("start's log is read for its failures by event, task and error code, a field that is not a plain token as -, and nothing else", () => {
    const credential = `${"E".repeat(21)}_-${"f".repeat(20)}`;
    const stdout = [
      credential,
      '{"level":"warn","event":"job.failed","taskId":"email-delivery","errorCode":"job_failed","message":"x"}',
      '{"level":"warn","event":"job.failed","taskId":"email-delivery","errorCode":"job_failed"}',
      '{"level":"warn","event":"job.timed_out","taskId":"webhook-delivery"}',
      '{"level":"warn","event":"schedule.failed","taskId":"has a space","errorCode":"schedule_failed"}',
      '{"level":"info","event":"worker.ready","taskId":"x"}',
      "not json",
    ].join("\n");

    assert.deepEqual(startFailures(stdout), {
      "job.failed email-delivery job_failed": 2,
      "job.timed_out webhook-delivery -": 1,
      "schedule.failed - schedule_failed": 1,
    });
    assert.deepEqual(startFailures(""), {});
  });

  test("a bridge's processes are npx's, its shell's and requestport mcp's, not start's or the agent's", () => {
    const listed = [
      { pid: 1, cmd: "/sbin/docker-init -- sleep infinity" },
      {
        pid: 20,
        cmd: "npm exec --@requestport:registry=http://127.0.0.1:9/ -p file:/tarballs/r.tgz requestport start --storage pglite",
      },
      { pid: 30, cmd: "node /harness/agent.mjs" },
      {
        pid: 31,
        cmd: "npm exec --@requestport:registry=http://127.0.0.1:9/ -p file:/tarballs/r.tgz requestport mcp",
      },
      { pid: 32, cmd: "sh -c requestport mcp" },
      {
        pid: 33,
        cmd: "node /srv/clean-home/.npm/_npx/c7/node_modules/.bin/requestport mcp",
      },
    ];

    assert.deepEqual(
      bridgeProcesses(listed).map(({ pid }) => pid),
      [31, 32, 33],
    );
  });
});

describe("the agent's protocol", () => {
  const valid = {
    load: { command: "load" },
    file: {
      command: "file",
      cwd: "/c",
      configuration: "/c/.mcp.json",
      title: "t",
      descriptionMd: "d",
      targetProjectId: PROJECT,
      timeoutMs: 1000,
    },
    whoami: {
      command: "whoami",
      cwd: "/c",
      configuration: "/c/.mcp.json",
      bridges: 2,
      timeoutMs: 1000,
    },
    http: {
      command: "http",
      server: SERVER,
      projectId: PROJECT,
      requestId: "r",
    },
    credentials: { command: "credentials", server: SERVER, projectId: PROJECT },
  };

  test("each command is read as it was written", () => {
    assert.deepEqual(
      Object.keys(valid).sort(),
      Object.keys(AGENT_COMMANDS).sort(),
    );
    for (const command of Object.values(valid)) {
      assert.deepEqual(parseAgentCommand(JSON.stringify(command)), command);
    }
  });

  test("input that is not one of them is refused, saying why", () => {
    const cases = [
      ["not json", /not JSON/u],
      ["[1]", /not one JSON object/u],
      [
        JSON.stringify({ command: "toString" }),
        /no command is named "toString"/u,
      ],
      [
        JSON.stringify({ ...valid.http, extra: 1 }),
        /http takes no field extra/u,
      ],
      [
        JSON.stringify({ command: "credentials", server: SERVER }),
        /credentials needs projectId/u,
      ],
      [
        JSON.stringify({ ...valid.whoami, bridges: 0 }),
        /bridges is not a positive whole number/u,
      ],
      [
        JSON.stringify({ ...valid.file, timeoutMs: "1" }),
        /timeoutMs is not a positive whole number/u,
      ],
      [
        JSON.stringify({ ...valid.file, title: "" }),
        /title is not a non-empty string/u,
      ],
    ];

    for (const [text, refusal] of cases) {
      assert.throws(() => parseAgentCommand(text), refusal, text);
    }
  });

  test("the MCP configuration must name requestport alone, as { command, args }", () => {
    const of = (servers) => JSON.stringify({ mcpServers: servers });
    const server = { command: "npx", args: ["requestport", "mcp"] };

    assert.deepEqual(serverOf(of({ requestport: server })), server);
    for (const text of [
      "{",
      of({}),
      of({ requestport: server, other: server }),
      of({ other: server }),
      of({ requestport: { ...server, env: { A: "1" } } }),
      of({ requestport: { command: "npx", args: [1] } }),
    ]) {
      assert.throws(() => serverOf(text), undefined, text);
    }
  });

  test("a bridge gets npm's own variables from the agent's environment, and nothing else of it", () => {
    assert.deepEqual(
      bridgeEnvironment({
        HOME: "/h",
        PATH: "/p",
        npm_config_loglevel: "http",
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        REQUESTPORT_NO_BROWSER: "1",
      }),
      { npm_config_loglevel: "http", NPM_CONFIG_UPDATE_NOTIFIER: "false" },
    );
  });
});

/**
 * Stand-ins for the MCP client: each transport records how it was made, each
 * client records what it was asked, and `events` the order of both.
 */
function fakeMcp({ tools = {}, connect = () => {} } = {}) {
  const events = [];
  const transports = [];
  let made = 0;

  class StdioClientTransport {
    constructor(parameters) {
      made += 1;
      this.n = made;
      this.parameters = parameters;
      this.stderr = new PassThrough();
      this.pid = 4000 + made;
      transports.push(this);
    }
  }

  class Client {
    async connect(transport, options) {
      this.transport = transport;
      events.push(`start ${transport.n}`);
      transport.stderr.write(`bridge ${transport.n} on stderr\n`);
      await new Promise((settle) => setTimeout(settle, 5));
      await connect(transport.n, options);
      events.push(`connected ${transport.n}`);
    }

    async callTool({ name, arguments: args }, options) {
      events.push(`call ${this.transport.n} ${name}`);
      transports[this.transport.n - 1].calls ??= [];
      transports[this.transport.n - 1].calls.push({ name, args, options });
      return tools[name](args, this.transport.n);
    }

    async close() {
      events.push(`close ${this.transport?.n}`);
    }
  }

  return {
    mcp: async () => ({ Client, StdioClientTransport }),
    events,
    transports,
  };
}

/** The agent served one command over stand-in streams; its one answer. */
async function askFakeAgent(command, options) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";

  output.on("data", (chunk) => {
    written += chunk;
  });
  input.end(`${JSON.stringify(command)}\n`);

  const code = await serveAgent({ input, output, ...options });

  assert.equal(written.split("\n").filter(Boolean).length, 1, written);

  return { code, answer: JSON.parse(written) };
}

const MCP_JSON = JSON.stringify({
  mcpServers: {
    requestport: {
      command: "npx",
      args: ["-p", "file:/t/r.tgz", "requestport", "mcp"],
    },
  },
});

describe("the agent's steps, with stand-ins", () => {
  const structured = (value) => ({ structuredContent: value, content: [] });

  test("file drafts with the agent journey's arguments, submits the draft's version, and closes its bridge", async (t) => {
    const directory = scratch(t, "agent-file-");
    const fake = fakeMcp({
      tools: {
        create_request_draft: () =>
          structured({
            result: { id: "req-1", state: "draft", version: 3, extra: 1 },
          }),
        submit_request: () =>
          structured({
            result: { id: "req-1", state: "submitted", version: 4 },
          }),
      },
    });

    writeFileSync(join(directory, ".mcp.json"), MCP_JSON);

    const { code, answer } = await askFakeAgent(
      {
        command: "file",
        cwd: directory,
        configuration: join(directory, ".mcp.json"),
        title: "A title",
        descriptionMd: "A body",
        targetProjectId: PROJECT,
        timeoutMs: 1234,
      },
      {
        mcp: fake.mcp,
        environment: { npm_config_loglevel: "http", HOME: "/h" },
      },
    );
    const [transport] = fake.transports;
    const [draft, submit] = transport.calls;

    assert.equal(code, 0, JSON.stringify(answer));
    assert.deepEqual(transport.parameters, {
      command: "npx",
      args: ["-p", "file:/t/r.tgz", "requestport", "mcp"],
      cwd: directory,
      env: { npm_config_loglevel: "http" },
      stderr: "pipe",
    });
    assert.equal(draft.name, "create_request_draft");
    assert.deepEqual(Object.keys(draft.args).sort(), [
      "descriptionMd",
      "expectedVersion",
      "idempotencyKey",
      "targetProjectId",
      "title",
      "type",
    ]);
    assert.deepEqual(
      { ...draft.args, idempotencyKey: undefined },
      {
        descriptionMd: "A body",
        expectedVersion: 0,
        idempotencyKey: undefined,
        targetProjectId: PROJECT,
        title: "A title",
        type: "feature",
      },
    );
    assert.equal(submit.name, "submit_request");
    assert.deepEqual(
      { ...submit.args, idempotencyKey: undefined },
      { expectedVersion: 3, idempotencyKey: undefined, requestId: "req-1" },
    );
    for (const { args } of [draft, submit]) {
      assert.match(args.idempotencyKey, /^[0-9a-f-]{36}$/u);
    }
    assert.notEqual(draft.args.idempotencyKey, submit.args.idempotencyKey);
    assert.equal(draft.options.timeout, 1234);
    assert.deepEqual(fake.events, [
      "start 1",
      "connected 1",
      "call 1 create_request_draft",
      "call 1 submit_request",
      "close 1",
    ]);
    assert.deepEqual(answer.result.draft, {
      id: "req-1",
      state: "draft",
      version: 3,
    });
    assert.deepEqual(answer.result.submitted, {
      id: "req-1",
      state: "submitted",
      version: 4,
    });
    assert.equal(answer.bridges.length, 1);
    assert.equal(answer.bridges[0].stderr, "bridge 1 on stderr\n");
    assert.equal(answer.bridges[0].pid, 4001);
    for (const field of ["startedMs", "connectedMs", "closedMs"]) {
      assert.equal(typeof answer.bridges[0][field], "number", field);
    }
  });

  test("a refused tool fails the command naming it, and its bridge is still closed", async (t) => {
    const directory = scratch(t, "agent-file-");
    const fake = fakeMcp({
      tools: {
        create_request_draft: () => ({
          isError: true,
          content: [{ type: "text", text: '{"error":"forbidden"}' }],
        }),
      },
    });

    writeFileSync(join(directory, ".mcp.json"), MCP_JSON);

    const { code, answer } = await askFakeAgent(
      {
        command: "file",
        cwd: directory,
        configuration: join(directory, ".mcp.json"),
        title: "t",
        descriptionMd: "d",
        targetProjectId: PROJECT,
        timeoutMs: 1000,
      },
      { mcp: fake.mcp, environment: {} },
    );

    assert.equal(code, 1);
    assert.equal(answer.ok, false);
    assert.equal(answer.step, "file");
    assert.equal(
      answer.error,
      'agent: file: create_request_draft was refused: {"error":"forbidden"}',
    );
    assert.equal(fake.events.at(-1), "close 1");
    assert.match(answer.bridges[0].error, /^create_request_draft: /u);
  });

  test("whoami starts every bridge before any has connected, asks each, and closes each", async (t) => {
    const directory = scratch(t, "agent-whoami-");
    const fake = fakeMcp({
      tools: {
        whoami: (_, n) =>
          structured({
            organizationId: ORGANIZATION,
            projectId: PROJECT,
            audience: `a${n}`,
            scopes: [],
          }),
      },
    });

    writeFileSync(join(directory, ".mcp.json"), MCP_JSON);

    const { code, answer } = await askFakeAgent(
      {
        command: "whoami",
        cwd: directory,
        configuration: join(directory, ".mcp.json"),
        bridges: 2,
        timeoutMs: 1000,
      },
      { mcp: fake.mcp, environment: {} },
    );

    assert.equal(code, 0, JSON.stringify(answer));
    assert.deepEqual(fake.events.slice(0, 2), ["start 1", "start 2"]);
    assert.deepEqual(fake.events.slice(-2).sort(), ["close 1", "close 2"]);
    assert.deepEqual(answer.result.whoami, [
      { organizationId: ORGANIZATION, projectId: PROJECT, audience: "a1" },
      { organizationId: ORGANIZATION, projectId: PROJECT, audience: "a2" },
    ]);
    assert.equal(answer.bridges.length, 2);
    assert.ok(
      Math.max(...answer.bridges.map(({ startedMs }) => startedMs)) <
        Math.min(...answer.bridges.map(({ connectedMs }) => connectedMs)),
      JSON.stringify(answer.bridges),
    );
  });

  test("a bridge that does not connect is named, and every bridge is still closed", async (t) => {
    const directory = scratch(t, "agent-whoami-");
    const fake = fakeMcp({
      tools: {
        whoami: () =>
          structured({ organizationId: ORGANIZATION, projectId: PROJECT }),
      },
      connect: (n) => {
        if (n === 2) throw new Error("Connection closed\nsecond line");
      },
    });

    writeFileSync(join(directory, ".mcp.json"), MCP_JSON);

    const { code, answer } = await askFakeAgent(
      {
        command: "whoami",
        cwd: directory,
        configuration: join(directory, ".mcp.json"),
        bridges: 2,
        timeoutMs: 1000,
      },
      { mcp: fake.mcp, environment: {} },
    );

    assert.equal(code, 1);
    assert.equal(answer.error, "agent: whoami: bridge 2: Connection closed");
    assert.deepEqual(
      fake.events.filter((event) => event.startsWith("close")).sort(),
      ["close 1", "close 2"],
    );
    assert.equal(answer.bridges[1].error, "connect: Connection closed");
  });

  /** A HOME holding one npx directory with a stand-in packed client. */
  function packedHome(
    t,
    exportsOf = (path) => ({ types: `${path}.d.ts`, import: `${path}.js` }),
  ) {
    const home = scratch(t, "agent-home-");
    const client = join(
      home,
      ".npm",
      "_npx",
      "c737",
      "node_modules",
      "@requestport",
      "client",
    );

    mkdirSync(join(client, "dist"), { recursive: true });
    writeFileSync(
      join(client, "package.json"),
      JSON.stringify({
        name: "@requestport/client",
        version: "0.0.0-t",
        type: "module",
        exports: {
          "./http": exportsOf("./dist/http"),
          "./credentials": exportsOf("./dist/credentials"),
        },
      }),
    );
    writeFileSync(
      join(client, "dist", "http.js"),
      [
        "export function createRequestPortHttpClient(options) {",
        "  globalThis.__packedOptions = options;",
        "  return {",
        `    whoami: async () => ({ organizationId: "${ORGANIZATION}", projectId: options.projectId, audience: "api", scopes: [] }),`,
        "    query: async (path) => ({ id: path.split('/')[1], title: 'Filed', state: 'submitted', type: 'feature', targetProjectId: options.projectId, path }),",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(client, "dist", "credentials.js"),
      "export function createFileStore(options) { return { kind: 'file', home: options.home }; }\n",
    );

    return home;
  }

  test("http reads the packed client's import-only exports from the one npx directory, over the file store in HOME", async (t) => {
    const home = packedHome(t);
    const { code, answer } = await askFakeAgent(
      {
        command: "http",
        server: SERVER,
        projectId: PROJECT,
        requestId: "req-1",
      },
      { home },
    );
    const options = globalThis.__packedOptions;

    assert.equal(code, 0, JSON.stringify(answer));
    assert.equal(options.server, SERVER);
    assert.equal(options.projectId, PROJECT);
    assert.deepEqual(options.store, { kind: "file", home });
    assert.deepEqual(answer.result.exports, {
      "./http": "node_modules/@requestport/client/dist/http.js",
      "./credentials": "node_modules/@requestport/client/dist/credentials.js",
    });
    assert.deepEqual(answer.result.client, {
      name: "@requestport/client",
      version: "0.0.0-t",
    });
    assert.deepEqual(answer.result.whoami, {
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      audience: "api",
    });
    assert.deepEqual(answer.result.request, {
      id: "req-1",
      title: "Filed",
      state: "submitted",
      type: "feature",
      targetProjectId: PROJECT,
    });
    delete globalThis.__packedOptions;
  });

  test("no npx directory, two, an export without the import condition, or one that leaves the package is refused", (t) => {
    const home = packedHome(t);
    const client = join(
      npxDirectoryOf(home),
      "node_modules",
      "@requestport",
      "client",
    );

    assert.throws(
      () => npxDirectoryOf(scratch(t, "agent-empty-")),
      /holds 0 npx directories/u,
    );
    mkdirSync(join(home, ".npm", "_npx", "second"));
    assert.throws(() => npxDirectoryOf(home), /holds 2 npx directories/u);

    for (const [entry, refusal] of [
      ["./dist/http.js", /exports no \.\/http under the import condition/u],
      [
        { require: "./dist/http.js" },
        /exports no \.\/http under the import condition/u,
      ],
      [{ import: "../../escape.js" }, /\.\/http leaves the package/u],
    ]) {
      writeFileSync(
        join(client, "package.json"),
        JSON.stringify({
          name: "@requestport/client",
          exports: { "./http": entry },
        }),
      );
      assert.throws(
        () => packedExports(client, ["./http"]),
        refusal,
        JSON.stringify(entry),
      );
    }
  });

  test("credentials gives each audience's client id and refresh token as digests, and never either", async (t) => {
    const home = scratch(t, "agent-credentials-");
    const directory = join(home, ".requestport");
    const record = (audience, refreshToken) => ({
      audience,
      clientId: `client-${audience}`,
      obtained: "2026-10-11T00:00:00.000Z",
      refreshToken,
      resource: `${SERVER}/${audience}`,
      version: 2,
    });
    const digest = (text) => createHash("sha256").update(text).digest("hex");

    mkdirSync(join(directory, "locks"), { recursive: true });
    writeFileSync(join(directory, "locks", "held.lock"), "{}");
    writeFileSync(
      join(directory, "credentials.json"),
      JSON.stringify({
        [SERVER]: {
          [PROJECT]: {
            mcp: record("mcp", "rt-mcp-SECRET"),
            api: record("api", "rt-api-SECRET"),
          },
        },
      }),
    );

    const { answer } = await askFakeAgent(
      { command: "credentials", server: SERVER, projectId: PROJECT },
      { home },
    );

    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.deepEqual(answer.result.audiences.mcp, {
      clientIdSha256: digest("client-mcp"),
      refreshTokenSha256: digest("rt-mcp-SECRET"),
      obtained: "2026-10-11T00:00:00.000Z",
      resource: `${SERVER}/mcp`,
      version: 2,
    });
    assert.equal(
      answer.result.audiences.api.refreshTokenSha256,
      digest("rt-api-SECRET"),
    );
    assert.deepEqual(answer.result.locks, ["held.lock"]);
    assert.equal(answer.result.fileLock, false);
    assert.ok(!JSON.stringify(answer).includes("SECRET"));

    writeFileSync(join(directory, "credentials.json"), '{"x": "rt-SECRET",');

    const broken = await askFakeAgent(
      { command: "credentials", server: SERVER, projectId: PROJECT },
      { home },
    );

    assert.equal(broken.answer.ok, false);
    assert.match(
      broken.answer.error,
      /not valid JSON \(nothing of it is repeated\)/u,
    );
    assert.ok(!JSON.stringify(broken.answer).includes("SECRET"));
    assert.throws(
      () => credentialDigests("rt-SECRET", SERVER, PROJECT),
      (error) => !error.message.includes("SECRET"),
    );
  });
});

describe("the agent's bundle", () => {
  test("holds the lockfile's @modelcontextprotocol/client 2.3.0, and loads it and runs outside the repository", async (t) => {
    const directory = realpathSync(scratch(t, "agent-bundle-"));
    const bundle = await stageCleanHarness(directory);
    const lockfile = readFileSync(
      join(repositoryRoot, "pnpm-lock.yaml"),
      "utf8",
    );
    const importer = lockfile.slice(
      lockfile.indexOf("\n  apps/requestport:\n"),
    );

    assert.match(
      importer,
      /^ {6}'@modelcontextprotocol\/client':\n {8}specifier: 2\.3\.0\n {8}version: 2\.3\.0$/mu,
    );
    assert.ok(
      bundle.packages.includes("@modelcontextprotocol/client@2.3.0"),
      bundle.packages.join(" "),
    );
    assert.ok(bundle.packages.includes("@modelcontextprotocol/core@2.3.0"));
    assert.ok(
      !bundle.packages.some((name) => name.startsWith("@requestport/")),
    );
    assert.equal(bundle.esbuild, "0.28.2");
    assert.deepEqual(readdirSync(directory), ["agent.mjs"]);
    assert.equal(
      bundle.sha256,
      createHash("sha256")
        .update(readFileSync(join(directory, "agent.mjs")))
        .digest("hex"),
    );

    const run = (command, env = {}) =>
      spawnSync(process.execPath, [join(directory, "agent.mjs")], {
        cwd: directory,
        encoding: "utf8",
        env: { PATH: dirname(process.execPath), ...env },
        input: `${JSON.stringify(command)}\n`,
        timeout: 60_000,
      });
    const loaded = run({ command: "load" });

    assert.equal(loaded.status, 0, loaded.stderr);
    assert.deepEqual(JSON.parse(loaded.stdout).result, {
      node: process.version,
      client: true,
      stdioTransport: true,
    });

    const read = run(
      { command: "credentials", server: SERVER, projectId: PROJECT },
      { HOME: directory },
    );

    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout).result, {
      audiences: {},
      locks: [],
      fileLock: false,
    });
  });
});
