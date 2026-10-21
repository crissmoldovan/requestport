import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startCallbackServer } from "@requestport/client/callback-server";
import { createFileStore } from "@requestport/client/credentials";
import { AGENT_SCOPES } from "@requestport/client/oauth";
import { readProjectBinding } from "@requestport/client/project";
import type { Storage } from "@requestport/db";
import { createTestStorage, rawQuery } from "@requestport/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runLink } from "./link.js";
import { runLogin } from "./login.js";
import {
  type Consented,
  consentTo,
  newPerson,
  seedPerson,
  sessionCookie,
} from "./test-support/consent.js";
import { startTestHost, type TestHost } from "./test-support/host.js";

/*
 * `requestport link` against a real host (manifest-h.md Done when 13, the
 * link half, and its last sentence: after a full authorization, `git status`
 * in the checkout is clean). The host, the database and the person are
 * `login.integration.test.ts`'s: Better Auth's provider, `/mcp` and
 * `/api/v1` served in this process over a database this file creates on the
 * run's PostgreSQL (`DATABASE_URL`), migrates, and drops in `afterAll`,
 * checking it is gone. Every credential is kept in the file store under a
 * temporary home, and every lock under it or a temporary directory, so
 * nothing here reaches this machine's own `~/.requestport`.
 */

const workspace = resolve(import.meta.dirname, "..");
const bin = join(workspace, "bin", "requestport.mjs");
const base = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
const database = `rp_h6_link_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const realHomeHadStore = existsSync(join(homedir(), ".requestport"));

const admin = createTestStorage({
  driver: "pg",
  pool: { connectionTimeoutMillis: 15_000, idleTimeoutMillis: 1_000, max: 2 },
});
let storage: Storage | undefined;
let host: TestHost;
let cookie: string;
const person = newPerson();
const scratch = mkdtempSync(join(tmpdir(), "requestport-link-e2e-"));

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

const URL_LINE = /\n {2}(http:\/\/\S+)\n/u;
const slugOf = (projectId: string) => `project-${projectId}`;
const bindingPath = (checkout: string) =>
  join(checkout, ".requestport", "project.json");

/** The person consents to `url` for `projectId`, as the browser would. */
function consent(url: string, projectId: string, scopes?: readonly string[]) {
  return consentTo({
    authorizationUrl: url,
    cookie,
    host,
    person,
    projectId,
    ...(scopes === undefined ? {} : { scopes }),
    storage: storage as Storage,
  });
}

/**
 * `requestport link` (or `login`) in this process, the person consenting to
 * each URL it prints on stderr for the next project of `grants`, with
 * `scopes` when given. The receiver is the real loopback one, with a 60 s
 * wait rather than 300 s.
 */
async function inProcess(
  command: typeof runLink | typeof runLogin,
  argv: string[],
  options: {
    cwd: string;
    grants: string[];
    home: string;
    scopes?: readonly string[];
  },
) {
  const output = { stderr: "", stdout: "" };
  const consents: Promise<Consented>[] = [];
  let failed: (error: unknown) => void = () => {};
  const consentFailed = new Promise<never>((_resolve, reject) => {
    failed = reject;
  });
  const run = command(
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
      cwd: options.cwd,
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
          const consented = consent(url, projectId, options.scopes);
          consented.catch(failed);
          consents.push(consented);
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

/** The executable, as a person runs it, consenting to its URL for `grant`. */
async function executable(
  argv: string[],
  options: { cwd: string; grant?: string; home: string },
) {
  const env: NodeJS.ProcessEnv = {
    HOME: options.home,
    PATH: process.env.PATH,
    REQUESTPORT_CREDENTIAL_STORE: "file",
    REQUESTPORT_NO_BROWSER: "1",
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  };
  const child: ChildProcess = spawn(process.execPath, [bin, ...argv], {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let unplanned = false;
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
    if (url !== undefined && consents.length === 0 && !unplanned) {
      if (options.grant === undefined) {
        unplanned = true;
        child.kill();
        return;
      }
      const consented = consent(url, options.grant);
      // Awaited below, after the exit; this keeps an early failure from
      // being reported as unhandled before then.
      consented.catch(() => {});
      consents.push(consented);
    }
  });
  try {
    const code = await exited;
    await Promise.all(consents);
    if (unplanned)
      throw new Error("the command asked for an unplanned consent");
    return { code, consents: consents.length, stderr, stdout };
  } finally {
    child.kill();
  }
}

/** git in `checkout`, with no configuration of this machine's or user's. */
function git(checkout: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=H.6",
      "-c",
      "user.email=h6@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd: checkout,
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: scratch,
        LC_ALL: "C",
        PATH: process.env.PATH,
      },
    },
  );
  expect({ args, status: result.status, stderr: result.stderr }).toMatchObject({
    status: 0,
  });
  return result.stdout;
}

const credentialFile = (home: string) =>
  JSON.parse(
    readFileSync(join(home, ".requestport", "credentials.json"), "utf8"),
  ) as Record<string, Record<string, Record<string, { refreshToken: string }>>>;

describe("the requestport executable's link, in a git checkout", {
  timeout: 120_000,
}, () => {
  test("writes the binding and nothing else; committed, a full authorization and a second link leave git status clean", async () => {
    const home = directory("home");
    const checkout = directory("checkout");
    // The child's working directory is the path the kernel resolved, so
    // through macOS's /var symbolic link it reports /private/var/….
    const real = realpathSync(checkout);
    git(checkout, "init", "--quiet", "--initial-branch=main");
    expect(git(checkout, "status", "--porcelain")).toBe("");

    const linked = await executable(["link", "--server", host.url], {
      cwd: checkout,
      grant: person.projects.a,
      home,
    });

    expect({ code: linked.code, stderr: linked.stderr }).toMatchObject({
      code: 0,
    });
    expect(linked.consents).toBe(1);
    expect(linked.stderr).toMatch(URL_LINE);
    expect(linked.stdout).not.toContain("/api/auth/oauth2/authorize");
    expect(linked.stdout).toBe(
      [
        `Stored the mcp credential for project ${person.projects.a} (organization ${person.organizationId}) on ${host.url}.`,
        `Wrote ${bindingPath(real)}: this checkout is bound to project ${person.projects.a} (${slugOf(person.projects.a)}) of organization ${person.organizationId} on ${host.url}.`,
        "",
      ].join("\n"),
    );
    // The binding is all link wrote in the checkout.
    expect(git(checkout, "status", "--porcelain")).toBe("?? .requestport/\n");
    expect(readdirSync(join(checkout, ".requestport"))).toEqual([
      "project.json",
    ]);
    expect(readProjectBinding(checkout)).toEqual({
      organizationId: person.organizationId,
      projectId: person.projects.a,
      projectSlug: slugOf(person.projects.a),
      server: host.url,
    });

    git(checkout, "add", ".requestport");
    git(checkout, "commit", "--quiet", "-m", "Bind this checkout");
    expect(git(checkout, "status", "--porcelain")).toBe("");

    // A full authorization, its server and project from the binding.
    const loggedIn = await executable(["login"], {
      cwd: checkout,
      grant: person.projects.a,
      home,
    });
    expect({ code: loggedIn.code, stderr: loggedIn.stderr }).toMatchObject({
      code: 0,
    });
    expect(loggedIn.consents).toBe(1);
    expect(git(checkout, "status", "--porcelain")).toBe("");

    // link again: the stored credential, no consent, the binding untouched.
    const again = await executable(["link", "--server", host.url], {
      cwd: checkout,
      home,
    });
    expect({ code: again.code, stderr: again.stderr }).toEqual({
      code: 0,
      stderr: "",
    });
    expect(again.consents).toBe(0);
    expect(again.stdout).toBe(
      [
        `Using the mcp credential stored for project ${person.projects.a} (organization ${person.organizationId}) on ${host.url}.`,
        `${bindingPath(real)} already binds this checkout to project ${person.projects.a} (${slugOf(person.projects.a)}) on ${host.url}; it is left as it is.`,
        "",
      ].join("\n"),
    );
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(Object.keys(credentialFile(home))).toEqual([host.url]);
    expect(Object.keys(credentialFile(home)[host.url] ?? {})).toEqual([
      person.projects.a,
    ]);
  });
});

describe("requestport link, against a host", { timeout: 120_000 }, () => {
  test("an mcp credential stored for the project: no consent; whoami and list_projects name it; the stored credential is spent", async () => {
    const home = directory("home");
    const stored = await inProcess(
      runLogin,
      ["--server", host.url, "--project", person.projects.b],
      { cwd: directory("cwd"), grants: [person.projects.b], home },
    );
    expect(stored.status).toBe(0);
    const before =
      credentialFile(home)[host.url]?.[person.projects.b]?.mcp?.refreshToken;
    const checkout = directory("checkout");

    const run = await inProcess(
      runLink,
      ["--server", host.url, "--project", person.projects.b],
      { cwd: checkout, grants: [], home },
    );

    expect({ status: run.status, stderr: run.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(run.consented).toEqual([]);
    expect(readFileSync(bindingPath(checkout), "utf8")).toBe(
      `${JSON.stringify(
        {
          organizationId: person.organizationId,
          projectId: person.projects.b,
          projectSlug: slugOf(person.projects.b),
          server: host.url,
        },
        null,
        2,
      )}\n`,
    );
    const after =
      credentialFile(home)[host.url]?.[person.projects.b]?.mcp?.refreshToken;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(existsSync(join(home, ".requestport", "locks"))).toBe(true);
  });

  test("--project A with a grant for B: refused, naming both; nothing stored or written", async () => {
    const home = directory("home");
    const checkout = directory("checkout");

    const run = await inProcess(
      runLink,
      ["--server", host.url, "--project", person.projects.a],
      { cwd: checkout, grants: [person.projects.b], home },
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `The mcp grant is for project ${person.projects.b}, but --project names project ${person.projects.a}. Nothing was stored.`,
    );
    expect(run.stdout).toBe("");
    expect(readdirSync(checkout)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  test("a grant bound without project:read: refused, naming the scope; nothing stored or written", async () => {
    const home = directory("home");
    const checkout = directory("checkout");

    const run = await inProcess(runLink, ["--server", host.url], {
      cwd: checkout,
      grants: [person.projects.a],
      home,
      scopes: AGENT_SCOPES.filter((scope) => scope !== "project:read"),
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "requestport link: The mcp grant does not carry the project:read scope, which link needs to read the project's slug (list_projects). Nothing was stored, and nothing was written.",
    );
    expect(run.stdout).toBe("");
    expect(readdirSync(checkout)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
    expect(
      createFileStore({ home }).read(host.url, person.projects.a, "mcp"),
    ).toBeUndefined();
  });
});
