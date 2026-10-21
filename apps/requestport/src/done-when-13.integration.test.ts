import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  Client,
  parseJSONRPCMessage,
  StreamableHTTPClientTransport,
  serializeMessage,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createFileStore } from "@requestport/client/credentials";
import { readProjectBinding } from "@requestport/client/project";
import { createTokenSource } from "@requestport/client/token-source";
import { createAgentAuthRepository, type Storage } from "@requestport/db";
import { createTestStorage, rawQuery } from "@requestport/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HOLDING_PROJECT_ID } from "./holding-store.js";
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
 * manifest-h.md Done when 13, end to end, in one sequence as a person and
 * their agents run it; with it, two of §2.8.4's sentences about the bridge
 * (stdout carries the protocol and nothing else; two bridges in one checkout
 * share one credential through the token source's lock) and ruling 102's
 * retry against this host's own provider. Each case below is one step. Later
 * steps use what earlier ones stored, so they run in order, in one git
 * checkout:
 *
 * 1. `link --server <url>`; the binding committed.
 * 2. `login --project <A>`, the person granting B: refused, nothing stored.
 * 3. `login` with neither `--project` nor a binding, elsewhere: stored under
 *    the project granted, for the audience asked.
 * 4. `login --for both`: two records from two client ids.
 * 5. `mcp`, started by an agent's client: the tools `/mcp` lists over HTTP.
 * 6. `mcp`'s stdout, byte for byte.
 * 7. Two bridges at once over the stored credential.
 * 8. `mcp` with a credential granted for another project.
 * 9. A 401 to the kept access token, then a revoked grant (ruling 102).
 * 10. git status, and the home, afterwards.
 *
 * Every command is the executable (`bin/requestport.mjs`), given its
 * environment explicitly, against a host served in this process over a
 * database this file creates on the run's PostgreSQL (`DATABASE_URL`),
 * migrates, and drops in `afterAll`, checking it is gone. Credentials are
 * kept in the file store under temporary homes, so nothing reaches this
 * machine's own `~/.requestport` or its keychain.
 */

const workspace = resolve(import.meta.dirname, "..");
const bin = join(workspace, "bin", "requestport.mjs");
const base = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
const database = `rp_h6_dw13_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const realHomeHadStore = existsSync(join(homedir(), ".requestport"));

const admin = createTestStorage({
  driver: "pg",
  pool: { connectionTimeoutMillis: 15_000, idleTimeoutMillis: 1_000, max: 2 },
});
let storage: Storage | undefined;
let host: TestHost;
let cookie: string;
const person = newPerson();
const scratch = mkdtempSync(join(tmpdir(), "requestport-dw13-"));

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

/** A URL a command prints for the person, on a line of its own. */
const URL_LINE = /\n {2}(http:\/\/\S+)\n/u;
const URL_LINES = new RegExp(URL_LINE.source, "gu");
const slugOf = (projectId: string) => `project-${projectId}`;

/** The environment every command is given, and nothing else. */
function environment(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "",
    REQUESTPORT_CREDENTIAL_STORE: "file",
    REQUESTPORT_NO_BROWSER: "1",
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  };
}

/** The person consents to `url` for `projectId`, as the browser would. */
function consent(url: string, projectId: string): Promise<Consented> {
  const consented = consentTo({
    authorizationUrl: url,
    cookie,
    host,
    person,
    projectId,
    storage: storage as Storage,
  });
  // Awaited by the caller later; this keeps an early failure from being
  // reported as unhandled before then.
  consented.catch(() => {});
  return consented;
}

/**
 * The executable, as a person runs it: the person consents to each URL it
 * prints on stderr, in turn, for the next project of `grants`. A URL no
 * grant was planned for stops it.
 */
async function executable(
  argv: string[],
  options: { cwd: string; grants: string[]; home: string },
) {
  const grants = [...options.grants];
  const child: ChildProcess = spawn(process.execPath, [bin, ...argv], {
    cwd: options.cwd,
    env: environment(options.home),
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
    const urls = [...stderr.matchAll(URL_LINES)].map((match) => match[1]);
    for (const url of urls.slice(consents.length)) {
      const projectId = grants.shift();
      if (url === undefined || projectId === undefined) {
        unplanned = true;
        child.kill();
        return;
      }
      consents.push(consent(url, projectId));
    }
  });
  try {
    const code = await exited;
    const consented = await Promise.all(consents);
    if (unplanned) {
      throw new Error("the command asked for an unplanned consent");
    }
    return { code, consented, stderr, stdout };
  } finally {
    child.kill();
  }
}

/**
 * An agent's MCP client of `requestport mcp`, over stdio, as an agent
 * starts one. No case expects the bridge to ask for consent; if it does, the
 * person consents for `projectId`, and the case's own assertions report what
 * the bridge then did, rather than a timeout.
 */
function agentOf(home: string, projectId: string, cwd: string) {
  const transport = new StdioClientTransport({
    args: [bin, "mcp"],
    command: process.execPath,
    cwd,
    env: environment(home),
    stderr: "pipe",
  });
  let stderr = "";
  const consents: Promise<Consented>[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    for (const match of [...stderr.matchAll(URL_LINES)].slice(
      consents.length,
    )) {
      consents.push(consent(match[1] as string, projectId));
    }
  });
  // A line on the bridge's stdout that is not a JSON-RPC message reaches the
  // client's transport as an error, and the client goes on.
  const errors: string[] = [];
  transport.onerror = (error) => {
    errors.push(`${error.name}: ${error.message}`);
  };
  const client = new Client({ name: "h6-agent", version: "1.0.0" });
  return {
    client,
    consents,
    errors,
    stderr: () => stderr,
    transport,
  };
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

type Records = Record<
  string,
  Record<string, Record<string, { clientId: string; refreshToken: string }>>
>;

const credentialPath = (home: string) =>
  join(home, ".requestport", "credentials.json");
const credentialText = (home: string) =>
  readFileSync(credentialPath(home), "utf8");
const credentialFile = (home: string) =>
  JSON.parse(credentialText(home)) as Records;

/** Every file and directory under `directory`, by its relative path. */
function tree(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();
}

/** One count from the host's database. */
async function count(text: string, values: unknown[] = []): Promise<number> {
  const result = await rawQuery<{ count: number }>(
    storage as Storage,
    text,
    values,
  );
  return result.rows[0]?.count ?? Number.NaN;
}

/** OAuth clients the provider has registered: one per authorization. */
const registeredClients = () =>
  count('select count(*)::int as count from "oauth_client"');

/**
 * Refresh tokens the provider has issued to `clientId`: one at the code
 * exchange and one more for each refresh, which rotates (a replayed one
 * deletes them all, revoking the family).
 */
const refreshTokensIssued = (clientId: string) =>
  count(
    'select count(*)::int as count from "oauth_refresh_token" where "client_id" = $1',
    [clientId],
  );

describe("Done when 13, end to end: the requestport executable against a host in this process, in one git checkout", () => {
  const home = mkdtempSync(join(scratch, "home-"));
  const checkout = mkdtempSync(join(scratch, "checkout-"));
  const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
  const elsewhereHome = mkdtempSync(join(scratch, "elsewhere-home-"));
  const projectId = person.projects.a;
  const other = person.projects.b;
  /** Step 5's tools, as `/mcp` lists them over HTTP. */
  let httpTools: Tool[] = [];
  /** Step 9's agent, which both of its cases use. */
  let session: ReturnType<typeof agentOf> | undefined;

  afterAll(async () => {
    await session?.client.close();
  });

  test("1. link --server: one consent, the binding written and nothing else beside it; once it is committed, git status is clean", {
    timeout: 120_000,
  }, async () => {
    git(checkout, "init", "--quiet", "--initial-branch=main");
    expect(git(checkout, "status", "--porcelain")).toBe("");

    const linked = await executable(["link", "--server", host.url], {
      cwd: checkout,
      grants: [projectId],
      home,
    });

    expect({ code: linked.code, stderr: linked.stderr }).toMatchObject({
      code: 0,
    });
    expect(linked.consented).toHaveLength(1);
    expect(readProjectBinding(realpathSync(checkout))).toEqual({
      organizationId: person.organizationId,
      projectId,
      projectSlug: slugOf(projectId),
      server: host.url,
    });
    expect(git(checkout, "status", "--porcelain")).toBe("?? .requestport/\n");
    git(checkout, "add", ".requestport");
    git(checkout, "commit", "--quiet", "-m", "Bind this checkout");
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  test("2. login --project naming the binding's project, when the person grants another: refused naming both ids, and nothing stored or written", {
    timeout: 120_000,
  }, async () => {
    const before = credentialText(home);
    const filesBefore = tree(home);
    const clientsBefore = await registeredClients();

    const refused = await executable(["login", "--project", projectId], {
      cwd: checkout,
      grants: [other],
      home,
    });

    expect({ code: refused.code, stdout: refused.stdout }).toEqual({
      code: 1,
      stdout: "",
    });
    expect(refused.consented).toHaveLength(1);
    expect(refused.stderr).toContain(
      `requestport login: The mcp grant is for project ${other}, but --project names project ${projectId}. Nothing was stored.\n`,
    );
    // The consent registered a client, and its credential went nowhere.
    expect(await registeredClients()).toBe(clientsBefore + 1);
    expect(credentialText(home)).toBe(before);
    expect(tree(home)).toEqual(filesBefore);
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  test("3. login with neither --project nor a binding: stored under the project the person granted, for the audience asked, and nothing under a placeholder", {
    timeout: 120_000,
  }, async () => {
    const forMcp = await executable(["login", "--server", host.url], {
      cwd: elsewhere,
      grants: [other],
      home: elsewhereHome,
    });
    expect({ code: forMcp.code, stderr: forMcp.stderr }).toMatchObject({
      code: 0,
    });
    expect(forMcp.stdout).toBe(
      `Stored the mcp credential for project ${other} (organization ${person.organizationId}) on ${host.url}.\n`,
    );
    expect(Object.keys(credentialFile(elsewhereHome))).toEqual([host.url]);
    expect(Object.keys(credentialFile(elsewhereHome)[host.url] ?? {})).toEqual([
      other,
    ]);
    expect(
      Object.keys(credentialFile(elsewhereHome)[host.url]?.[other] ?? {}),
    ).toEqual(["mcp"]);

    const forApi = await executable(
      ["login", "--server", host.url, "--for", "api"],
      { cwd: elsewhere, grants: [other], home: elsewhereHome },
    );
    expect({ code: forApi.code, stderr: forApi.stderr }).toMatchObject({
      code: 0,
    });
    const stored = credentialFile(elsewhereHome)[host.url];
    expect(Object.keys(stored ?? {})).toEqual([other]);
    expect(Object.keys(stored?.[other] ?? {}).sort()).toEqual(["api", "mcp"]);
    expect([
      stored?.[other]?.mcp?.clientId,
      stored?.[other]?.api?.clientId,
    ]).toEqual(
      [...forMcp.consented, ...forApi.consented].map(
        (consented) => consented.clientId,
      ),
    );
    expect(credentialText(elsewhereHome)).not.toContain(HOLDING_PROJECT_ID);
    // The holding flow's lock was in a directory of its own, removed.
    expect(tree(elsewhereHome)).toEqual([
      ".requestport",
      ".requestport/credentials.json",
    ]);
    expect(tree(elsewhere)).toEqual([]);
  });

  test("4. login --for both: its server and project from the binding, two consents in turn, two records from two client ids; git status is clean", {
    timeout: 120_000,
  }, async () => {
    const loggedIn = await executable(["login", "--for", "both"], {
      cwd: checkout,
      grants: [projectId, projectId],
      home,
    });

    expect({ code: loggedIn.code, stderr: loggedIn.stderr }).toMatchObject({
      code: 0,
    });
    expect(loggedIn.consented).toHaveLength(2);
    expect(loggedIn.stdout).not.toContain("/api/auth/oauth2/authorize");
    const stored = credentialFile(home);
    expect(Object.keys(stored)).toEqual([host.url]);
    expect(Object.keys(stored[host.url] ?? {})).toEqual([projectId]);
    const records = stored[host.url]?.[projectId];
    expect(Object.keys(records ?? {}).sort()).toEqual(["api", "mcp"]);
    expect([records?.mcp?.clientId, records?.api?.clientId]).toEqual(
      loggedIn.consented.map((consented) => consented.clientId),
    );
    expect(records?.mcp?.clientId).not.toBe(records?.api?.clientId);
    expect(credentialText(home)).not.toContain(HOLDING_PROJECT_ID);
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  test("5. mcp, as an agent's client starts it: no consent, the tools /mcp lists over HTTP for the same grant, and whoami names the binding's project", {
    timeout: 120_000,
  }, async () => {
    const agent = agentOf(home, projectId, checkout);
    const overHttp = new Client({ name: "h6-http", version: "1.0.0" });
    try {
      await agent.client.connect(agent.transport);
      const tools = (await agent.client.listTools()).tools;
      const whoami = (
        await agent.client.callTool({ arguments: {}, name: "whoami" })
      ).structuredContent;

      // The same grant over HTTP: a token source over the credential the
      // bridge uses, from the same store, under the same lock.
      const tokens = createTokenSource({
        audience: "mcp",
        lockDirectory: join(home, ".requestport", "locks"),
        projectId,
        server: host.url,
        store: createFileStore({ home }),
      });
      await overHttp.connect(
        new StreamableHTTPClientTransport(new URL(`${host.url}/mcp`), {
          authProvider: { token: () => tokens.accessToken() },
        }),
      );
      httpTools = (await overHttp.listTools()).tools;

      expect(agent.consents).toHaveLength(0);
      expect(agent.stderr()).not.toMatch(URL_LINE);
      expect(httpTools.map((tool) => tool.name)).toContain("whoami");
      expect(tools).toEqual(httpTools);
      expect(whoami).toMatchObject({
        organizationId: person.organizationId,
        projectId,
      });
      expect(agent.errors).toEqual([]);
      expect(agent.stderr()).toContain(
        `requestport mcp: serving project ${projectId} (${slugOf(projectId)}) on ${host.url}.\n`,
      );
    } finally {
      await overHttp.close();
      await agent.client.close();
    }
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  test("6. mcp's stdout carries the protocol and nothing else: every byte is part of a JSON-RPC message on a line of its own", {
    timeout: 120_000,
  }, async () => {
    const child = spawn(process.execPath, [bin, "mcp"], {
      cwd: checkout,
      env: environment(home),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    const exited = new Promise<number | null>((resolveExit) => {
      child.on("exit", (code) => resolveExit(code));
    });
    const send = (message: Record<string, unknown>) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    /** Waits for the answer to `id`, reading only lines that parse. */
    async function answer(id: number) {
      const until = Date.now() + 60_000;
      for (;;) {
        for (const line of stdout.split("\n")) {
          try {
            if ((JSON.parse(line) as { id?: unknown }).id === id) return;
          } catch {
            // Judged below, byte for byte.
          }
        }
        if (Date.now() > until) throw new Error(`no answer to ${id}`);
        await new Promise((resume) => setTimeout(resume, 20));
      }
    }

    try {
      send({
        id: 1,
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "h6-agent", version: "1.0.0" },
          protocolVersion: "2025-11-25",
        },
      });
      await answer(1);
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/list" });
      send({
        id: 3,
        method: "tools/call",
        params: { arguments: {}, name: "whoami" },
      });
      await answer(2);
      await answer(3);
      child.stdin.end();
      expect(await exited).toBe(0);
    } finally {
      child.kill();
    }

    const lines = stdout.split("\n");
    expect(lines.pop(), "stdout ends with a newline").toBe("");
    const read = lines.map((line) => {
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        parseJSONRPCMessage(message);
        return { message };
      } catch {
        return { notJsonRpc: line };
      }
    });
    expect(read.filter((entry) => "notJsonRpc" in entry)).toEqual([]);
    const messages = read.map(
      (entry) => (entry as { message: Record<string, unknown> }).message,
    );
    // Byte for byte: each message as the SDK writes one, and nothing between.
    expect(stdout).toBe(
      messages.map((message) => serializeMessage(message as never)).join(""),
    );
    expect(messages.map((message) => message.id).sort()).toEqual([1, 2, 3]);
    expect(messages.find((message) => message.id === 3)?.result).toMatchObject({
      structuredContent: { projectId },
    });
    expect(stderr).toContain(
      `requestport mcp: serving project ${projectId} (${slugOf(projectId)}) on ${host.url}.\n`,
    );
  });

  test("7. two bridges in the checkout at once share the stored credential: neither mints one, both serve, one refresh each, and a third use succeeds", {
    timeout: 180_000,
  }, async () => {
    const before = credentialFile(home)[host.url]?.[projectId]?.mcp;
    if (before === undefined) throw new Error("no mcp credential stored");
    const clientsBefore = await registeredClients();
    const issuedBefore = await refreshTokensIssued(before.clientId);

    const agents = [
      agentOf(home, projectId, checkout),
      agentOf(home, projectId, checkout),
    ];
    let served: unknown[];
    let errors: string[];
    try {
      served = await Promise.all(
        agents.map(async (agent) => {
          await agent.client.connect(agent.transport);
          return (
            await agent.client.callTool({ arguments: {}, name: "whoami" })
          ).structuredContent;
        }),
      );
      errors = agents.flatMap((agent) => agent.errors);
    } finally {
      await Promise.all(agents.map((agent) => agent.client.close()));
    }
    const after = credentialFile(home)[host.url]?.[projectId]?.mcp;
    const third = await whoamiOverMcp({
      server: host.url,
      tokens: createTokenSource({
        audience: "mcp",
        lockDirectory: join(home, ".requestport", "locks"),
        projectId,
        server: host.url,
        store: createFileStore({ home }),
      }),
    });

    // One credential: the one login stored, and no client registered since.
    expect(after?.clientId).toBe(before.clientId);
    expect(await registeredClients()).toBe(clientsBefore);
    expect(agents.map((agent) => agent.consents.length)).toEqual([0, 0]);
    expect(served).toMatchObject([
      { organizationId: person.organizationId, projectId },
      { organizationId: person.organizationId, projectId },
    ]);
    // One refresh for each bridge's start and one for the third use, each
    // rotating the token the one before it stored: none was presented twice,
    // which would have revoked them all.
    expect(after?.refreshToken).not.toBe(before.refreshToken);
    expect(await refreshTokensIssued(before.clientId)).toBe(issuedBefore + 3);
    expect(third).toEqual({
      organizationId: person.organizationId,
      projectId,
    });
    expect(errors).toEqual([]);
  });

  test("8. mcp with a credential granted for another project: refused naming both ids, and nothing on stdout", {
    timeout: 120_000,
  }, async () => {
    // Step 3's grant for B, kept under A's key, as a copied store would hold
    // it.
    const copiedHome = mkdtempSync(join(scratch, "copied-home-"));
    const granted = createFileStore({ home: elsewhereHome }).read(
      host.url,
      other,
      "mcp",
    );
    if (granted === undefined) throw new Error("step 3 stored nothing for B");
    createFileStore({ home: copiedHome }).write(
      host.url,
      projectId,
      "mcp",
      granted,
    );

    const child = spawn(process.execPath, [bin, "mcp"], {
      cwd: checkout,
      env: environment(copiedHome),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    const exited = new Promise<number | null>((resolveExit) => {
      child.on("exit", (code) => resolveExit(code));
    });
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "h6-agent", version: "1.0.0" },
          protocolVersion: "2025-11-25",
        },
      })}\n`,
    );
    // Closed at once: a bridge that refuses never reads it, and one that
    // served would read it and exit 0 when it ends, rather than wait. One
    // that waited for a consent instead is stopped, and exits with no code.
    child.stdin.end();
    const stop = setTimeout(() => child.kill(), 60_000);
    const code = await exited;
    clearTimeout(stop);

    expect({ code, stderr }).toMatchObject({ code: 1 });
    expect(stdout).toBe("");
    expect(stderr).toBe(
      `requestport mcp: This checkout is bound to project ${projectId} (${slugOf(projectId)}), but the credential is for project ${other}. Refusing rather than filing work against the wrong project.\n`,
    );
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  test("9a. ruling 102 on this host: the server stops accepting the kept access token before it expires (its signing key retired); the agent's request is answered after one refresh", {
    timeout: 120_000,
  }, async () => {
    const stored = () => credentialFile(home)[host.url]?.[projectId]?.mcp;
    const clientId = stored()?.clientId;
    if (clientId === undefined) throw new Error("no mcp credential stored");
    session = agentOf(home, projectId, checkout);
    await session.client.connect(session.transport);
    expect(
      (await session.client.callTool({ arguments: {}, name: "whoami" }))
        .structuredContent,
    ).toMatchObject({ projectId });
    const issuedBefore = await refreshTokensIssued(clientId);
    const keptRefreshToken = stored()?.refreshToken;
    const keysBefore = await count('select count(*)::int as count from "jwks"');

    // The host stops serving the key that signed the bridge's kept token:
    // expired past the jwt plugin's grace period, it leaves the key set the
    // bearer check verifies with, and the next token is signed by a new one.
    await rawQuery(
      storage as Storage,
      `update "jwks" set "expires_at" = '2000-01-01T00:00:00Z'`,
    );
    const tools = (await session.client.listTools()).tools;

    expect(tools).toEqual(httpTools);
    expect(await refreshTokensIssued(clientId)).toBe(issuedBefore + 1);
    expect(stored()?.refreshToken).not.toBe(keptRefreshToken);
    expect(stored()?.clientId).toBe(clientId);
    expect(
      await count('select count(*)::int as count from "jwks"'),
      "the refreshed token was signed by a key made for it",
    ).toBe(keysBefore + 1);
    expect(session.consents).toHaveLength(0);
    // The bridge said nothing but that it serves: no failure was reported.
    expect(
      session
        .stderr()
        .split("\n")
        .filter((line) => line.startsWith("requestport mcp:")),
    ).toEqual([
      `requestport mcp: serving project ${projectId} (${slugOf(projectId)}) on ${host.url}.`,
    ]);
  });

  test("9b. ruling 102 on this host: the grant revoked while mcp serves: the retry's refresh is refused, the record removed, and the agent told to run requestport login --for mcp", {
    timeout: 120_000,
  }, async () => {
    if (session === undefined) throw new Error("step 9a started no agent");
    const clientId = credentialFile(home)[host.url]?.[projectId]?.mcp?.clientId;
    if (clientId === undefined) throw new Error("no mcp credential stored");
    const grants = await rawQuery<{ id: string; version: number }>(
      storage as Storage,
      `select "id", "version" from "agent_oauth_grants" where "oauth_client_id" = $1 and "status" = 'active'`,
      [clientId],
    );
    const grant = grants.rows[0];
    expect(grants.rows).toHaveLength(1);
    if (grant === undefined) throw new Error("no active grant");
    // The person revokes the agent's connection, as the console does.
    await createAgentAuthRepository((storage as Storage).db).revokeOAuthGrant({
      actorUserId: person.userId,
      agentPrincipalId: person.agentPrincipalId,
      correlationId: randomUUID(),
      expectedVersion: grant.version,
      fingerprintSecret: host.secret,
      grantId: grant.id,
      idempotencyKey: randomUUID(),
      organizationId: person.organizationId,
      reason: "Done when 13: ruling 102's revoked grant",
    });

    const refused = await session.client.listTools().then(
      () => undefined,
      (error: unknown) => (error as Error).message,
    );

    expect(refused).toContain(
      `(invalid_grant), so it has been removed. To authorize again, run "requestport login --for mcp".`,
    );
    expect(
      Object.keys(credentialFile(home)[host.url]?.[projectId] ?? {}),
    ).toEqual(["api"]);
    expect(session.consents).toHaveLength(0);
  });

  test("10. afterwards: git status is clean, and under the home are the credential file and an empty locks directory alone", () => {
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(tree(home)).toEqual([
      ".requestport",
      ".requestport/credentials.json",
      ".requestport/locks",
    ]);
    expect(credentialText(home)).not.toContain(HOLDING_PROJECT_ID);
  });
});
