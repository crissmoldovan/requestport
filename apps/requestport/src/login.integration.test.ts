import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { startCallbackServer } from "@requestport/client/callback-server";
import { createFileStore } from "@requestport/client/credentials";
import { createRequestPortHttpClient } from "@requestport/client/http";
import { createTokenSource } from "@requestport/client/token-source";
import type { Storage } from "@requestport/db";
import { createTestStorage, rawQuery } from "@requestport/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { HOLDING_PROJECT_ID } from "./holding-store.js";
import { runLogin } from "./login.js";
import {
  type Consented,
  consentTo,
  newPerson,
  seedPerson,
  sessionCookie,
} from "./test-support/consent.js";
import { startTestHost, type TestHost } from "./test-support/host.js";
import { whoamiOverMcp } from "./whoami.js";

/*
 * `requestport login` against a real host (manifest-h.md Done when 13, the
 * login half): Better Auth's provider, `/mcp` and `/api/v1`, composed and
 * served in this process over a database this file creates on the run's
 * PostgreSQL (`DATABASE_URL`), migrates, and drops in `afterAll`, checking
 * that it is gone (track-h.md, H.6's survey, question 9). The person is
 * scripted (`test-support/consent.ts`). Every credential is kept in the file
 * store under a temporary home, never in a keychain, and every token
 * source's lock directory is a temporary one, so nothing here reaches this
 * machine's own `~/.requestport`.
 */

const workspace = resolve(import.meta.dirname, "..");
const bin = join(workspace, "bin", "requestport.mjs");
const base = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
const database = `rp_h6_login_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const realHomeHadStore = existsSync(join(homedir(), ".requestport"));

const admin = createTestStorage({
  driver: "pg",
  pool: { connectionTimeoutMillis: 15_000, idleTimeoutMillis: 1_000, max: 2 },
});
let storage: Storage | undefined;
let host: TestHost;
let cookie: string;
let issuer: { identifier: string; required: boolean };
const person = newPerson();
const scratch = mkdtempSync(join(tmpdir(), "requestport-login-e2e-"));

beforeAll(async () => {
  expect(
    ["127.0.0.1", "localhost", "[::1]"],
    "this file creates a database: DATABASE_URL must name a PostgreSQL on this machine",
  ).toContain(base.hostname);
  await rawQuery(admin, `create database "${database}"`);
  const url = new URL(base);
  url.pathname = `/${database}`;
  storage = createTestStorage({
    connectionString: url.toString(),
    driver: "pg",
    pool: { connectionTimeoutMillis: 15_000, idleTimeoutMillis: 1_000, max: 4 },
  });
  const own = storage;
  host = await startTestHost(own);
  await seedPerson(person, (text, values) =>
    rawQuery(own, text, values === undefined ? undefined : [...values]),
  );
  cookie = await sessionCookie(host, person.userId);
  const metadata = (await (
    await fetch(`${host.url}/.well-known/oauth-authorization-server`)
  ).json()) as {
    authorization_response_iss_parameter_supported?: boolean;
    issuer: string;
  };
  issuer = {
    identifier: metadata.issuer,
    required: metadata.authorization_response_iss_parameter_supported === true,
  };
}, 180_000);

afterAll(async () => {
  try {
    await host?.close();
    await storage?.close();
    await rawQuery(admin, `drop database if exists "${database}" with (force)`);
    const left = await rawQuery<{ count: number }>(
      admin,
      "select count(*)::int as count from pg_catalog.pg_database where datname = $1",
      [database],
    );
    expect(left.rows[0]?.count).toBe(0);
  } finally {
    await admin.close();
    rmSync(scratch, { force: true, recursive: true });
  }
  // Nothing here wrote to this machine's own credential directory.
  expect(existsSync(join(homedir(), ".requestport"))).toBe(realHomeHadStore);
}, 60_000);

/** A directory of its own under the file's scratch directory. */
function directory(name: string): string {
  return mkdtempSync(join(scratch, `${name}-`));
}

/** Every path under `root`, relative to it, sorted. */
function tree(root: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      found.push(relative(root, path));
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return found.sort();
}

const URL_LINE = /\n {2}(http:\/\/\S+)\n/u;

/**
 * `requestport login` in this process, with the person consenting to each
 * URL it prints on stderr for the next project of `grants`. The receiver is
 * the real loopback one, with a 60 s wait rather than 300 s, so a case whose
 * consent failed does not hold its port for five minutes.
 */
async function login(
  argv: string[],
  options: { grants: string[]; home: string; cwd?: string },
) {
  const output = { stderr: "", stdout: "" };
  const consents: Promise<Consented>[] = [];
  let failed: (error: unknown) => void = () => {};
  const consentFailed = new Promise<never>((_resolve, reject) => {
    failed = reject;
  });
  const run = runLogin(
    argv,
    {
      HOME: options.home,
      REQUESTPORT_CREDENTIAL_STORE: "file",
      REQUESTPORT_NO_BROWSER: "1",
    },
    {
      authorization: {
        startCallbackReceiver: async () => {
          const receiver = await startCallbackServer({ timeoutMs: 60_000 });
          return {
            callback: receiver.received,
            close: () => receiver.close(),
            redirectUri: receiver.redirectUri,
          };
        },
      },
      cwd: options.cwd ?? directory("cwd"),
      output: {
        stderr: (text) => {
          output.stderr += text;
          const url = URL_LINE.exec(text)?.[1];
          if (url === undefined) return;
          const projectId = options.grants.shift();
          if (projectId === undefined) {
            failed(new Error("an authorization URL no grant was planned for"));
            return;
          }
          const consent = consentTo({
            authorizationUrl: url,
            cookie,
            host,
            person,
            projectId,
            storage: storage as Storage,
          });
          consent.catch(failed);
          consents.push(consent);
        },
        stdout: (text) => {
          output.stdout += text;
        },
      },
    },
  );
  const status = await Promise.race([run, consentFailed]);
  return { consented: await Promise.all(consents), status, ...output };
}

const credentialFile = (home: string) =>
  JSON.parse(
    readFileSync(join(home, ".requestport", "credentials.json"), "utf8"),
  ) as Record<string, Record<string, Record<string, { clientId: string }>>>;

describe("requestport login, against a host", { timeout: 120_000 }, () => {
  test("no --project, no binding: the mcp credential lands under the project granted, and nothing under a placeholder; the stored credential works", async () => {
    const home = directory("home");

    const run = await login(["--server", host.url], {
      grants: [person.projects.b],
      home,
    });

    expect(run.stderr).not.toContain("requestport login: the");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `Stored the mcp credential for project ${person.projects.b} (organization ${person.organizationId}) on ${host.url}.\n`,
    );
    const file = credentialFile(home);
    expect(Object.keys(file)).toEqual([host.url]);
    expect(Object.keys(file[host.url] ?? {})).toEqual([person.projects.b]);
    expect(Object.keys(file[host.url]?.[person.projects.b] ?? {})).toEqual([
      "mcp",
    ]);
    expect(JSON.stringify(file)).not.toContain(HOLDING_PROJECT_ID);
    // The credential file is all the home holds: no lock, keyed by the
    // placeholder or anything else, was left there.
    expect(tree(home)).toEqual([
      ".requestport",
      join(".requestport", "credentials.json"),
    ]);
    expect(file[host.url]?.[person.projects.b]?.mcp?.clientId).toBe(
      run.consented[0]?.clientId,
    );

    // RFC 9207, against the real provider: the metadata promises `iss`, and
    // the redirect the person's browser followed carried the issuer.
    expect(issuer.required).toBe(true);
    expect(run.consented[0]?.callback.searchParams.get("iss")).toBe(
      issuer.identifier,
    );

    // Spent: a token source over the real store refreshes the stored record,
    // and MCP's whoami names the project.
    const identity = await whoamiOverMcp({
      server: host.url,
      tokens: createTokenSource({
        audience: "mcp",
        lockDirectory: directory("locks"),
        projectId: person.projects.b,
        server: host.url,
        store: createFileStore({ home }),
      }),
    });
    expect(identity).toEqual({
      organizationId: person.organizationId,
      projectId: person.projects.b,
    });
  });

  test("--for api: the api credential, through REST's whoami, and it works", async () => {
    const home = directory("home");

    const run = await login(["--server", host.url, "--for", "api"], {
      grants: [person.projects.a],
      home,
    });

    expect(run.status).toBe(0);
    expect(
      Object.keys(credentialFile(home)[host.url]?.[person.projects.a] ?? {}),
    ).toEqual(["api"]);
    const whoami = await createRequestPortHttpClient({
      lockDirectory: directory("locks"),
      projectId: person.projects.a,
      server: host.url,
      store: createFileStore({ home }),
    }).whoami();
    expect(whoami).toMatchObject({
      organizationId: person.organizationId,
      projectId: person.projects.a,
    });
  });

  test("--for both: two consents in turn, two records from two client ids", async () => {
    const home = directory("home");

    const run = await login(["--server", host.url, "--for", "both"], {
      grants: [person.projects.a, person.projects.a],
      home,
    });

    expect(run.status).toBe(0);
    expect(run.consented).toHaveLength(2);
    const records = credentialFile(home)[host.url]?.[person.projects.a];
    expect(Object.keys(records ?? {}).sort()).toEqual(["api", "mcp"]);
    expect([records?.mcp?.clientId, records?.api?.clientId]).toEqual(
      run.consented.map((consent) => consent.clientId),
    );
    expect(records?.mcp?.clientId).not.toBe(records?.api?.clientId);
  });

  test("--project A with a grant for B: exits non-zero, names both, stores nothing", async () => {
    const home = directory("home");

    const run = await login(
      ["--server", host.url, "--project", person.projects.a],
      { grants: [person.projects.b], home },
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `The mcp grant is for project ${person.projects.b}, but --project names project ${person.projects.a}. Nothing was stored.`,
    );
    expect(run.stdout).toBe("");
    expect(tree(home)).toEqual([]);
  });

  test("with a binding: its server is the default and its project the one expected", async () => {
    const home = directory("home");
    const checkout = directory("checkout");
    mkdirSync(join(checkout, ".requestport"));
    writeFileSync(
      join(checkout, ".requestport", "project.json"),
      JSON.stringify({
        organizationId: person.organizationId,
        projectId: person.projects.a,
        projectSlug: `project-${person.projects.a}`,
        server: host.url,
      }),
    );
    // Started below the checkout's root, through the system's temporary
    // directory as it is named (on macOS a symbolic link): the binding is
    // found by walking up, and its path is reported as it was found.
    const below = join(checkout, "src");
    mkdirSync(below);

    const refused = await login([], {
      cwd: below,
      grants: [person.projects.b],
      home,
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      `The mcp grant is for project ${person.projects.b}, but this checkout's binding (${join(checkout, ".requestport", "project.json")}) names project ${person.projects.a}. Nothing was stored.`,
    );
    expect(tree(home)).toEqual([]);

    const stored = await login([], {
      cwd: realpathSync(below),
      grants: [person.projects.a],
      home,
    });
    expect(stored.status).toBe(0);
    expect(Object.keys(credentialFile(home)[host.url] ?? {})).toEqual([
      person.projects.a,
    ]);
  });

  test("a record an earlier client stored is named, and replaced", async () => {
    const home = directory("home");
    mkdirSync(join(home, ".requestport"), { mode: 0o700 });
    writeFileSync(
      join(home, ".requestport", "credentials.json"),
      JSON.stringify({
        [host.url]: {
          [person.projects.a]: {
            obtained: "2026-01-01T00:00:00.000Z",
            refreshToken: "an-earlier-clients-token",
          },
        },
      }),
      { mode: 0o600 },
    );

    const run = await login(
      ["--server", host.url, "--project", person.projects.a],
      { grants: [person.projects.a], home },
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toContain(
      `requestport login: the credential stored for project ${person.projects.a} on ${host.url} was stored by an earlier client without its registration; authorizing again.`,
    );
    const file = readFileSync(
      join(home, ".requestport", "credentials.json"),
      "utf8",
    );
    expect(file).not.toContain("an-earlier-clients-token");
    expect(
      createFileStore({ home }).hasLegacyRecord(host.url, person.projects.a),
    ).toBe(false);
    expect(
      Object.keys(credentialFile(home)[host.url]?.[person.projects.a] ?? {}),
    ).toEqual(["mcp"]);
  });
});

describe("the requestport executable's login", { timeout: 120_000 }, () => {
  test("prints the URL on stderr only, opens nothing, and keeps the credential where the environment says", async () => {
    const home = directory("home");
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: process.env.PATH,
      REQUESTPORT_CREDENTIAL_STORE: "file",
      REQUESTPORT_NO_BROWSER: "1",
      ...(process.env.TMPDIR === undefined
        ? {}
        : { TMPDIR: process.env.TMPDIR }),
    };
    const child: ChildProcess = spawn(
      process.execPath,
      [bin, "login", "--server", host.url],
      { cwd: directory("cwd"), env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const consents: Promise<Consented>[] = [];
    const exited = new Promise<number | null>((resolveExit) => {
      child.on("exit", (code) => resolveExit(code));
    });
    child.stdout?.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    child.stderr?.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
      const url = URL_LINE.exec(stderr)?.[1];
      if (url !== undefined && consents.length === 0) {
        consents.push(
          consentTo({
            authorizationUrl: url,
            cookie,
            host,
            person,
            projectId: person.projects.a,
            storage: storage as Storage,
          }),
        );
      }
    });

    try {
      const code = await exited;
      await Promise.all(consents);
      expect({ code, stderr }).toMatchObject({ code: 0 });
    } finally {
      child.kill();
    }

    expect(stdout).toBe(
      `Stored the mcp credential for project ${person.projects.a} (organization ${person.organizationId}) on ${host.url}.\n`,
    );
    expect(stderr).toMatch(URL_LINE);
    expect(stdout).not.toContain("/api/auth/oauth2/authorize");
    expect(tree(home)).toEqual([
      ".requestport",
      join(".requestport", "credentials.json"),
    ]);
  });
});
