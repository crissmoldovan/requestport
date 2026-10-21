import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import {
  Client,
  parseJSONRPCMessage,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startCallbackServer } from "@requestport/client/callback-server";
import { createFileStore } from "@requestport/client/credentials";
import {
  AuthorizationRequiredError,
  createTokenSource,
} from "@requestport/client/token-source";
import type { Storage } from "@requestport/db";
import { createTestStorage, rawQuery } from "@requestport/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { runLogin } from "./login.js";
import { runMcpBridge } from "./mcp-bridge.js";
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
 * `requestport mcp` against a real host (manifest-h.md Done when 13, the
 * bridge's half). The host, the database and the person are
 * `login.integration.test.ts`'s: Better Auth's provider, `/mcp` and `/api/v1`
 * served in this process over a database this file creates on the run's
 * PostgreSQL (`DATABASE_URL`), migrates, and drops in `afterAll`, checking
 * it is gone. Every credential is kept in the file store under a temporary
 * home, and every lock under it or a temporary directory, so nothing here
 * reaches this machine's own `~/.requestport`. Every bridge started as a
 * process is given its environment explicitly: `StdioClientTransport` adds
 * only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER` of this
 * process's, and `HOME` is always replaced.
 */

const workspace = resolve(import.meta.dirname, "..");
const bin = join(workspace, "bin", "requestport.mjs");
const child = join(import.meta.dirname, "test-support", "bridge-child.mjs");
const base = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
const database = `rp_h6_mcp_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const realHomeHadStore = existsSync(join(homedir(), ".requestport"));

const admin = createTestStorage({
  driver: "pg",
  pool: { connectionTimeoutMillis: 15_000, idleTimeoutMillis: 1_000, max: 2 },
});
let storage: Storage | undefined;
let host: TestHost;
let cookie: string;
const person = newPerson();
const scratch = mkdtempSync(join(tmpdir(), "requestport-mcp-e2e-"));

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
const lockDirectoryOf = (home: string) => join(home, ".requestport", "locks");
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** The person consents to `url` for `projectId`, as the browser would. */
function consent(url: string, projectId: string): Promise<Consented> {
  return consentTo({
    authorizationUrl: url,
    cookie,
    host,
    person,
    projectId,
    storage: storage as Storage,
  });
}

/** A checkout bound to `projectId` on the host, as `link` writes it. */
function boundCheckout(projectId: string): string {
  const checkout = directory("checkout");
  mkdirSync(join(checkout, ".requestport"));
  writeFileSync(
    join(checkout, ".requestport", "project.json"),
    `${JSON.stringify(
      {
        organizationId: person.organizationId,
        projectId,
        projectSlug: slugOf(projectId),
        server: host.url,
      },
      null,
      2,
    )}\n`,
  );
  return checkout;
}

/** The environment every bridge process is given, and nothing else. */
function bridgeEnvironment(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "",
    REQUESTPORT_CREDENTIAL_STORE: "file",
    REQUESTPORT_NO_BROWSER: "1",
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  };
}

/** The receiver an in-process authorization starts: 60 s, not 300 s. */
async function receiver() {
  const started = await startCallbackServer({ timeoutMs: 60_000 });
  return {
    callback: started.received,
    close: () => started.close(),
    redirectUri: started.redirectUri,
  };
}

/** `requestport login --project <id>` in this process, for `mcp`. */
async function storeCredential(home: string, projectId: string) {
  const consents: Promise<Consented>[] = [];
  const status = await runLogin(
    ["--server", host.url, "--project", projectId],
    bridgeEnvironment(home),
    {
      authorization: { startCallbackReceiver: receiver },
      cwd: directory("cwd"),
      output: {
        stderr: (text) => {
          const url = URL_LINE.exec(text)?.[1];
          if (url !== undefined) consents.push(consent(url, projectId));
        },
        stdout: () => {},
      },
    },
  );
  await Promise.all(consents);
  expect(status).toBe(0);
}

const credentialFile = (home: string) =>
  JSON.parse(
    readFileSync(join(home, ".requestport", "credentials.json"), "utf8"),
  ) as Record<string, Record<string, Record<string, { refreshToken: string }>>>;

/** An MCP client of the bridge, over stdio, as an agent starts one. */
async function stdioClient(options: {
  args: string[];
  cwd: string;
  home: string;
  onStderr?: (text: string) => void;
}) {
  const transport = new StdioClientTransport({
    args: options.args,
    command: process.execPath,
    cwd: options.cwd,
    env: bridgeEnvironment(options.home),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    options.onStderr?.(stderr);
  });
  const errors: string[] = [];
  transport.onerror = (error) => {
    errors.push(`${error.name}: ${error.message}`);
  };
  const client = new Client({ name: "h6-agent", version: "1.0.0" });
  return {
    client,
    errors,
    stderr: () => stderr,
    transport,
  };
}

/** `whoami`'s structured content, through `client`. */
async function whoamiThrough(client: Client): Promise<Record<string, unknown>> {
  const result = await client.callTool({ arguments: {}, name: "whoami" });
  return result.structuredContent as Record<string, unknown>;
}

/** Every `spawnRaw` process not yet exited, killed after each case. */
const running = new Set<ChildProcess>();

afterEach(() => {
  for (const started of running) started.kill("SIGKILL");
  running.clear();
});

/** A process with its protocol on pipes the test reads and writes. */
function spawnRaw(args: string[], cwd: string, home: string) {
  const process_: ChildProcess = spawn(process.execPath, args, {
    cwd,
    env: bridgeEnvironment(home),
    stdio: ["pipe", "pipe", "pipe"],
  });
  running.add(process_);
  const output = { stderr: "", stdout: "" };
  process_.stdout?.setEncoding("utf8").on("data", (text: string) => {
    output.stdout += text;
  });
  process_.stderr?.setEncoding("utf8").on("data", (text: string) => {
    output.stderr += text;
  });
  const exited = new Promise<number | null>((resolveExit) => {
    process_.on("exit", (code) => {
      running.delete(process_);
      resolveExit(code);
    });
  });
  const lines = () => output.stdout.split("\n").filter((line) => line !== "");
  return {
    exited,
    lines,
    output,
    process: process_,
    send(message: Record<string, unknown>) {
      process_.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
      );
    },
    async response(id: number, ms = 60_000) {
      const until = Date.now() + ms;
      for (;;) {
        const found = lines()
          .map((line) => JSON.parse(line) as { id?: unknown })
          .find((line) => line.id === id);
        if (found !== undefined) return found as Record<string, unknown>;
        if (Date.now() > until) throw new Error(`no answer to request ${id}`);
        await new Promise((resume) => setTimeout(resume, 20));
      }
    },
  };
}

const initialize = {
  id: 1,
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "h6-agent", version: "1.0.0" },
    protocolVersion: "2025-11-25",
  },
};

describe("the requestport executable's mcp, against a host", {
  timeout: 120_000,
}, () => {
  test("nothing stored: consent on stderr, then it serves the same tools as /mcp over HTTP for the same grant, and whoami names the binding's project", async () => {
    const home = directory("home");
    const checkout = boundCheckout(person.projects.a);
    const consents: Promise<Consented>[] = [];
    const agent = await stdioClient({
      args: [bin, "mcp"],
      cwd: checkout,
      home,
      onStderr: (stderr) => {
        const url = URL_LINE.exec(stderr)?.[1];
        if (url !== undefined && consents.length === 0) {
          consents.push(consent(url, person.projects.a));
        }
      },
    });
    let overHttp: Client | undefined;

    try {
      await agent.client.connect(agent.transport);
      await Promise.all(consents);
      const tools = (await agent.client.listTools()).tools;
      const whoami = await whoamiThrough(agent.client);

      // The same grant over HTTP: the credential the bridge stored, from
      // the same store, under the same lock.
      const tokens = createTokenSource({
        audience: "mcp",
        lockDirectory: lockDirectoryOf(home),
        projectId: person.projects.a,
        server: host.url,
        store: createFileStore({ home }),
      });
      overHttp = new Client({ name: "h6-http", version: "1.0.0" });
      await overHttp.connect(
        new StreamableHTTPClientTransport(new URL(`${host.url}/mcp`), {
          authProvider: { token: () => tokens.accessToken() },
        }),
      );
      const httpTools = (await overHttp.listTools()).tools;

      expect(consents).toHaveLength(1);
      expect(httpTools.map((tool) => tool.name)).toContain("whoami");
      expect(
        tools.map(({ inputSchema, name }) => ({ inputSchema, name })),
      ).toEqual(
        httpTools.map(({ inputSchema, name }) => ({ inputSchema, name })),
      );
      expect(tools).toEqual(httpTools);
      expect(whoami).toMatchObject({
        organizationId: person.organizationId,
        projectId: person.projects.a,
      });
      expect(agent.errors).toEqual([]);
      expect(agent.stderr()).toContain(
        `requestport mcp: serving project ${person.projects.a} (${slugOf(person.projects.a)}) on ${host.url}.\n`,
      );
      expect(Object.keys(credentialFile(home)[host.url] ?? {})).toEqual([
        person.projects.a,
      ]);
    } finally {
      await overHttp?.close();
      await agent.client.close();
    }
  });

  test("a credential for another project: refused, both ids named, stdout empty", async () => {
    const home = directory("home");
    await storeCredential(home, person.projects.b);
    // Granted for B, kept under A's key, as a copied store would hold it.
    const store = createFileStore({ home });
    const record = store.read(host.url, person.projects.b, "mcp");
    if (record === undefined) throw new Error("login stored nothing for B");
    store.write(host.url, person.projects.a, "mcp", record);
    store.clear(host.url, person.projects.b, "mcp");
    const checkout = boundCheckout(person.projects.a);

    const bridge = spawnRaw([bin, "mcp"], checkout, home);
    bridge.send(initialize);
    // Closed at once: a bridge that refuses never reads it, and one that
    // served would read it and exit 0 when it ends, rather than wait.
    bridge.process.stdin?.end();
    const code = await bridge.exited;

    expect({ code, stderr: bridge.output.stderr }).toMatchObject({ code: 1 });
    expect(bridge.output.stdout).toBe("");
    expect(bridge.output.stderr).toBe(
      `requestport mcp: This checkout is bound to project ${person.projects.a} (${slugOf(person.projects.a)}), but the credential is for project ${person.projects.b}. Refusing rather than filing work against the wrong project.\n`,
    );
  });
});

describe("requestport mcp in this process, against a host", {
  timeout: 120_000,
}, () => {
  test("nothing stored, and a grant for another project: refused, naming both; nothing stored, stdout empty", async () => {
    const home = directory("home");
    const checkout = boundCheckout(person.projects.a);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let written = "";
    stdout.setEncoding("utf8").on("data", (text: string) => {
      written += text;
    });
    let stderr = "";
    const consents: Promise<Consented>[] = [];

    const status = await runMcpBridge([], bridgeEnvironment(home), {
      authorization: { startCallbackReceiver: receiver },
      cwd: checkout,
      stderr: (text) => {
        stderr += text;
        const url = URL_LINE.exec(text)?.[1];
        if (url !== undefined) consents.push(consent(url, person.projects.b));
      },
      stdin,
      stdout,
    });
    await Promise.all(consents);

    expect(status).toBe(1);
    expect(consents).toHaveLength(1);
    expect(stderr).toContain(
      `requestport mcp: The mcp grant is for project ${person.projects.b}, but this checkout's binding (${join(checkout, ".requestport", "project.json")}) names project ${person.projects.a}. Nothing was stored.\n`,
    );
    expect(written).toBe("");
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("the bridge as a process of its own (test-support/bridge-child.mjs)", {
  timeout: 120_000,
}, () => {
  test("every line on stdout is a JSON-RPC message, though a module logs with console; stdin closing ends it", async () => {
    const home = directory("home");
    await storeCredential(home, person.projects.a);
    const checkout = boundCheckout(person.projects.a);

    const bridge = spawnRaw(
      [child, JSON.stringify({ consoleProbe: true })],
      checkout,
      home,
    );
    bridge.send(initialize);
    await bridge.response(1);
    bridge.send({ method: "notifications/initialized" });
    bridge.send({ id: 2, method: "tools/list" });
    bridge.send({
      id: 3,
      method: "tools/call",
      params: { arguments: {}, name: "whoami" },
    });
    const listed = await bridge.response(2);
    const called = await bridge.response(3);
    bridge.process.stdin?.end();
    const code = await bridge.exited;

    expect(code).toBe(0);
    expect(listed).toHaveProperty("result.tools");
    expect(called).toMatchObject({
      result: { structuredContent: { projectId: person.projects.a } },
    });
    const lines = bridge.lines();
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => parseJSONRPCMessage(JSON.parse(line))).not.toThrow();
    }
    // The probe's lines went to stderr.
    expect(bridge.output.stderr).toContain("console probe: a POST request");
  });

  /**
   * Two bridges in one checkout over one stored credential, held at a go file
   * until both have loaded and then released together. The first's refresh
   * is answered by the server and then held for three seconds before the
   * bridge sees it, so it holds the lock, with the starting refresh token
   * already rotated on the server and not yet replaced in the store; the
   * second starts only once that answer has arrived (`after`), so its
   * refresh starts inside that window by order, with three seconds to reach
   * the store, rather than by which request the server happens to serve
   * first. Each
   * child records the SHA-256 of every refresh token it presents. A third
   * use, the same in both cases, asks whoami through a token source over the
   * store afterwards.
   */
  async function twoBridges(separateLocks: boolean) {
    const home = directory("home");
    await storeCredential(home, person.projects.a);
    const checkout = boundCheckout(person.projects.a);
    const starting =
      credentialFile(home)[host.url]?.[person.projects.a]?.mcp?.refreshToken;
    if (starting === undefined) throw new Error("nothing stored for A");
    const barrier = directory("barrier");
    const go = join(barrier, "go");
    const answered = join(barrier, "answered");
    const tokenLog = join(barrier, "tokens.log");

    const agents = await Promise.all(
      [{ answered, tokenDelayMs: 3_000 }, { after: answered }].map((timing) =>
        stdioClient({
          args: [
            child,
            JSON.stringify({
              go,
              tokenLog,
              ...timing,
              ...(separateLocks ? { lockDirectory: directory("lock") } : {}),
            }),
          ],
          cwd: checkout,
          home,
        }),
      ),
    );
    try {
      const served = Promise.allSettled(
        agents.map(async (agent) => {
          await agent.client.connect(agent.transport);
          return whoamiThrough(agent.client);
        }),
      );
      const until = Date.now() + 60_000;
      while (
        readdirSync(barrier).filter((name) => name.startsWith("go.ready-"))
          .length < 2
      ) {
        if (Date.now() > until) throw new Error("the bridges did not load");
        await new Promise((resume) => setTimeout(resume, 20));
      }
      writeFileSync(go, "");
      const results = await served;

      const presented = readFileSync(tokenLog, "utf8").trim().split("\n");
      const stored =
        credentialFile(home)[host.url]?.[person.projects.a]?.mcp?.refreshToken;
      const third = await whoamiOverMcp({
        server: host.url,
        tokens: createTokenSource({
          audience: "mcp",
          lockDirectory: lockDirectoryOf(home),
          projectId: person.projects.a,
          server: host.url,
          store: createFileStore({ home }),
        }),
      }).then(
        (identity) => ({ identity }),
        (error: unknown) => ({ error }),
      );
      return {
        presented,
        results,
        starting: sha256(starting),
        stderr: agents.map((agent) => agent.stderr()),
        stored,
        storedChanged: stored !== starting,
        third,
      };
    } finally {
      await Promise.all(agents.map((agent) => agent.client.close()));
    }
  }

  test("two bridges in one checkout share one credential through the token source's lock: both serve, the starting refresh token reaches the server once and no token twice, it rotated, and a third use succeeds", async () => {
    const run = await twoBridges(false);

    expect(
      run.results.map((result) =>
        result.status === "fulfilled" ? result.value.projectId : result.reason,
      ),
      run.stderr.join("\n"),
    ).toEqual([person.projects.a, person.projects.a]);
    expect(run.presented.filter((hash) => hash === run.starting)).toHaveLength(
      1,
    );
    expect(new Set(run.presented).size).toBe(run.presented.length);
    expect(run.presented).toHaveLength(2);
    expect(run.storedChanged).toBe(true);
    expect(run.third).toEqual({
      identity: {
        organizationId: person.organizationId,
        projectId: person.projects.a,
      },
    });
  });

  test("the control: with a lock directory each, the starting refresh token is presented twice, and the server revokes the credential", async () => {
    const run = await twoBridges(true);

    expect(run.presented.filter((hash) => hash === run.starting)).toHaveLength(
      2,
    );
    expect(
      run.results.filter((result) => result.status === "rejected").length,
    ).toBeGreaterThanOrEqual(1);
    expect(run.stderr.join("\n")).toContain(
      '(invalid_grant), so it has been removed. To authorize again, run "requestport login --for mcp".',
    );
    expect("error" in run.third && run.third.error).toBeInstanceOf(
      AuthorizationRequiredError,
    );
  });
});
