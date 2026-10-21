import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CredentialStore,
  createFileStore,
} from "@requestport/client/credentials";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { HOLDING_PROJECT_ID } from "./holding-store.js";
import {
  LOGIN_USAGE,
  type LoginDependencies,
  parseLoginArguments,
  runLogin,
} from "./login.js";
import {
  createFakeAuthorizationServer,
  FAKE_ORGANIZATION_ID,
  type FakeAuthorizationServer,
  fakeWhoami,
} from "./test-support/fake-authorization-server.js";

const projectA = "018f0000-0000-7000-8000-00000000a001";
const projectB = "018f0000-0000-7000-8000-00000000b001";
const SENTINEL = "SENTINEL_d41d8cd98f00b204";

let home: string;
let checkout: string;
let scratch: string;
let store: CredentialStore;
let server: FakeAuthorizationServer;
let opened: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "requestport-login-home-"));
  checkout = mkdtempSync(join(tmpdir(), "requestport-login-checkout-"));
  scratch = mkdtempSync(join(tmpdir(), "requestport-login-tmp-"));
  store = createFileStore({ home });
  server = createFakeAuthorizationServer();
  opened = [];
});

afterEach(() => {
  for (const directory of [home, checkout, scratch]) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A login run in this process, against the fake. The person consents to each
 * URL the command prints on stderr, choosing the next of `server.grants`.
 */
async function login(argv: string[], env: Record<string, string> = {}) {
  const output = { stderr: "", stdout: "" };
  const dependencies: LoginDependencies = {
    authorization: {
      fetch: server.fetch,
      startCallbackReceiver: () => server.startCallbackReceiver(),
      temporaryDirectory: scratch,
      whoami: fakeWhoami(server).whoami,
    },
    cwd: checkout,
    openBrowser: (url) => {
      opened.push(url);
    },
    output: {
      stderr: (text) => {
        output.stderr += text;
        const url = /\n {2}(\S+)\n/u.exec(text)?.[1];
        if (url !== undefined) server.consent(url);
      },
      stdout: (text) => {
        output.stdout += text;
      },
    },
    store,
  };
  const status = await runLogin(argv, env, dependencies);
  return { status, ...output };
}

const credentialsPath = () => join(home, ".requestport", "credentials.json");
const urlsIn = (text: string) =>
  [...text.matchAll(/\n {2}(\S+)\n/gu)].map((match) => match[1]);

function bind(projectId: string, bound = server.origin) {
  mkdirSync(join(checkout, ".requestport"));
  writeFileSync(
    join(checkout, ".requestport", "project.json"),
    JSON.stringify({
      organizationId: FAKE_ORGANIZATION_ID,
      projectId,
      projectSlug: "the-bound-project",
      server: bound,
    }),
  );
}

describe("the arguments", () => {
  test("--help prints the usage on stdout", async () => {
    const run = await login(["--help"]);

    expect(run).toEqual({ status: 0, stderr: "", stdout: `${LOGIN_USAGE}\n` });
  });

  test("the defaults: mcp, the browser on, nothing else given", () => {
    expect(parseLoginArguments([])).toEqual({ for: "mcp", noBrowser: false });
    expect(
      parseLoginArguments([
        "--server=https://rp.example/",
        "--project",
        projectA.toUpperCase(),
        "--for",
        "both",
        "--no-browser",
      ]),
    ).toEqual({
      for: "both",
      noBrowser: true,
      project: projectA,
      server: "https://rp.example",
    });
  });

  test.each([
    ["an unknown option", [`--${SENTINEL}`]],
    ["an unknown option with a value", [`--token=${SENTINEL}`]],
    ["an argument", [SENTINEL]],
    [
      "a server with a password",
      ["--server", `https://u:${SENTINEL}@rp.example`],
    ],
    ["a server with a path", ["--server", `https://rp.example/${SENTINEL}`]],
    [
      "a server over plain http elsewhere",
      ["--server", `http://${SENTINEL}.example`],
    ],
    ["a project that is not a UUID", ["--project", SENTINEL]],
    ["another audience", ["--for", SENTINEL]],
    ["an option given twice", ["--for", "mcp", `--for=${SENTINEL}`]],
    ["an option with no value", ["--server"]],
    ["an option with an empty value", ["--server="]],
  ])("%s is a usage error that repeats nothing typed", async (_name, argv) => {
    const run = await login(argv);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^requestport login: /u);
    expect(run.stderr).toContain(LOGIN_USAGE);
    expect(run.stderr).not.toContain(SENTINEL);
    expect(server.registrations).toEqual([]);
  });

  test("an unknown credential store is a usage error that does not repeat it", async () => {
    const run = await runLogin(
      ["--server", server.origin],
      { REQUESTPORT_CREDENTIAL_STORE: SENTINEL },
      {
        output: {
          stderr: (text) => {
            expect(text).not.toContain(SENTINEL);
            expect(text).toContain("REQUESTPORT_CREDENTIAL_STORE");
          },
          stdout: () => {},
        },
      },
    );

    expect(run).toBe(2);
  });

  test("no server, and no binding to name one, is a usage error", async () => {
    const run = await login([]);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no server");
    expect(server.registrations).toEqual([]);
  });
});

describe("login", () => {
  test("with no --project and no binding: the mcp credential, under the project granted, and nothing under a placeholder", async () => {
    server.grants.push(projectB);

    const run = await login(["--server", server.origin]);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `Stored the mcp credential for project ${projectB} (organization ${FAKE_ORGANIZATION_ID}) on ${server.origin}.\n`,
    );
    const file = JSON.parse(readFileSync(credentialsPath(), "utf8"));
    expect(Object.keys(file)).toEqual([server.origin]);
    expect(Object.keys(file[server.origin])).toEqual([projectB]);
    expect(Object.keys(file[server.origin][projectB])).toEqual(["mcp"]);
    expect(JSON.stringify(file)).not.toContain(HOLDING_PROJECT_ID);
  });

  test("the authorization URL goes to stderr and the browser, never stdout", async () => {
    server.grants.push(projectA);

    const run = await login(["--server", server.origin]);

    const urls = urlsIn(run.stderr);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(
      /^https:\/\/rp\.example\/api\/auth\/oauth2\/authorize\?/u,
    );
    expect(opened).toEqual(urls);
    expect(run.stdout).not.toContain("oauth2/authorize");
  });

  test("--for api: the api credential, through REST's whoami", async () => {
    server.grants.push(projectA);

    const run = await login(["--server", server.origin, "--for", "api"]);

    expect(run.status).toBe(0);
    expect(store.read(server.origin, projectA, "api")).toMatchObject({
      audience: "api",
      resource: `${server.origin}/api/v1`,
    });
    expect(store.read(server.origin, projectA, "mcp")).toBeUndefined();
  });

  test("--for both: two consents in turn, two records with two client ids", async () => {
    server.grants.push(projectA, projectA);

    const run = await login(["--server", server.origin, "--for", "both"]);

    expect(run.status).toBe(0);
    const urls = urlsIn(run.stderr);
    expect(
      urls.map((url) => new URL(url ?? "").searchParams.get("resource")),
    ).toEqual([`${server.origin}/mcp`, `${server.origin}/api/v1`]);
    const mcp = store.read(server.origin, projectA, "mcp");
    const api = store.read(server.origin, projectA, "api");
    expect(server.registrations).toHaveLength(2);
    expect([mcp?.clientId, api?.clientId]).toEqual(server.registrations);
    expect(mcp?.clientId).not.toBe(api?.clientId);
    expect(run.stdout.split("\n").filter(Boolean)).toHaveLength(2);
  });

  test("--for both, the second consent for another project: refused naming both, and neither stored", async () => {
    server.grants.push(projectA, projectB);

    const run = await login(["--server", server.origin, "--for", "both"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `The api grant is for project ${projectB}, but the mcp grant made first names project ${projectA}. Nothing was stored.`,
    );
    expect(existsSync(credentialsPath())).toBe(false);
    expect(run.stdout).toBe("");
  });

  test("--project A with a grant for B: exits non-zero, names both ids, stores nothing", async () => {
    server.grants.push(projectB);

    const run = await login(["--server", server.origin, "--project", projectA]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `The mcp grant is for project ${projectB}, but --project names project ${projectA}. Nothing was stored.`,
    );
    expect(run.stdout).toBe("");
    expect(existsSync(credentialsPath())).toBe(false);
  });

  test("with a binding and no --project: the binding's server is the default, and its project the one expected", async () => {
    bind(projectA);
    server.grants.push(projectB, projectA);

    const refused = await login([]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      `The mcp grant is for project ${projectB}, but this checkout's binding (${join(checkout, ".requestport", "project.json")}) names project ${projectA}. Nothing was stored.`,
    );
    expect(existsSync(credentialsPath())).toBe(false);

    const stored = await login([]);
    expect(stored.status).toBe(0);
    expect(store.read(server.origin, projectA, "mcp")).toBeDefined();
  });

  test("a binding for another server expects nothing of a login to this one", async () => {
    bind(projectA, "https://elsewhere.example");
    server.grants.push(projectB);

    const run = await login(["--server", server.origin]);

    expect(run.status).toBe(0);
    expect(store.read(server.origin, projectB, "mcp")).toBeDefined();
  });

  test("a record an earlier client stored is named, and replaced", async () => {
    mkdirSync(join(home, ".requestport"), { mode: 0o700 });
    const legacy = {
      [server.origin]: {
        [projectA]: {
          obtained: "2026-01-01T00:00:00.000Z",
          refreshToken: `legacy-${SENTINEL}`,
        },
      },
    };
    writeFileSync(credentialsPath(), JSON.stringify(legacy), { mode: 0o600 });
    expect(store.hasLegacyRecord(server.origin, projectA)).toBe(true);
    server.grants.push(projectA);

    const run = await login(["--server", server.origin, "--project", projectA]);

    expect(run.status).toBe(0);
    expect(run.stderr).toContain(
      `requestport login: the credential stored for project ${projectA} on ${server.origin} was stored by an earlier client without its registration; authorizing again.`,
    );
    expect(run.stderr).not.toContain(SENTINEL);
    expect(store.hasLegacyRecord(server.origin, projectA)).toBe(false);
    expect(store.read(server.origin, projectA, "mcp")?.version).toBe(2);
    expect(readFileSync(credentialsPath(), "utf8")).not.toContain(SENTINEL);
  });

  test("an earlier client's record for the project granted, with nothing expected, is named when it is replaced", async () => {
    mkdirSync(join(home, ".requestport"), { mode: 0o700 });
    writeFileSync(
      credentialsPath(),
      JSON.stringify({
        [server.origin]: {
          [projectB]: {
            obtained: "2026-01-01T00:00:00.000Z",
            refreshToken: "legacy",
          },
        },
      }),
      { mode: 0o600 },
    );
    server.grants.push(projectB);

    const run = await login(["--server", server.origin]);

    expect(run.status).toBe(0);
    expect(run.stderr).toContain(
      `requestport login: the credential stored for project ${projectB} on ${server.origin} was stored by an earlier client without its registration; it is replaced.`,
    );
    expect(store.hasLegacyRecord(server.origin, projectB)).toBe(false);
  });

  test("a failure names no placeholder and stores nothing", async () => {
    server.grants.push(projectA);
    server.refuseRefreshes = true;

    const run = await login(["--server", server.origin, "--for", "api"]);

    expect(run.status).toBe(1);
    expect(run.stderr).not.toContain(HOLDING_PROJECT_ID);
    expect(run.stderr).toContain("the project being granted");
    expect(existsSync(credentialsPath())).toBe(false);
  });
});
