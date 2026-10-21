import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  type CredentialStore,
  createFileStore,
} from "@requestport/client/credentials";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runLogin } from "./login.js";
import {
  MCP_USAGE,
  type McpBridgeDependencies,
  runMcpBridge,
  UPSTREAM_FAILED,
} from "./mcp-bridge.js";
import {
  createFakeAuthorizationServer,
  FAKE_ORGANIZATION_ID,
  type FakeAuthorizationServer,
  fakeProjectSlug,
} from "./test-support/fake-authorization-server.js";

const projectA = "018f0000-0000-7000-8000-00000000a001";
const projectB = "018f0000-0000-7000-8000-00000000b001";
const SENTINEL = "SENTINEL_d41d8cd98f00b204";
const PROTOCOL_VERSION = "2025-11-25";
/** The token values the fake issues: `access-<n>` and `refresh-<n>`. */
const TOKEN_VALUE = /(?:access|refresh)-\d+/u;

let home: string;
let checkout: string;
let scratch: string;
let store: CredentialStore;
let server: FakeAuthorizationServer;
let opened: string[];

const realHomeHadStore = existsSync(join(homedir(), ".requestport"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "requestport-mcp-home-"));
  checkout = mkdtempSync(join(tmpdir(), "requestport-mcp-checkout-"));
  scratch = mkdtempSync(join(tmpdir(), "requestport-mcp-tmp-"));
  store = createFileStore({ home });
  server = createFakeAuthorizationServer();
  opened = [];
});

afterEach(() => {
  for (const directory of [home, checkout, scratch]) {
    rmSync(directory, { recursive: true, force: true });
  }
  // Nothing here reached this machine's own credential directory.
  expect(existsSync(join(homedir(), ".requestport"))).toBe(realHomeHadStore);
});

/** The checkout's binding, to `projectId` on the fake. */
function bind(projectId: string): void {
  mkdirSync(join(checkout, ".requestport"));
  writeFileSync(
    join(checkout, ".requestport", "project.json"),
    JSON.stringify({
      organizationId: FAKE_ORGANIZATION_ID,
      projectId,
      projectSlug: fakeProjectSlug(projectId),
      server: server.origin,
    }),
  );
}

/** An mcp credential stored as `requestport login --project` stores it. */
async function storeCredential(projectId: string): Promise<void> {
  const status = await runLogin(
    ["--server", server.origin, "--project", projectId],
    { HOME: home },
    {
      authorization: {
        fetch: server.fetch,
        startCallbackReceiver: () => server.startCallbackReceiver(),
        temporaryDirectory: scratch,
      },
      cwd: scratch,
      openBrowser: null,
      output: {
        stderr: (text) => {
          const url = /\n {2}(\S+)\n/u.exec(text)?.[1];
          if (url !== undefined) server.consent(url, projectId);
        },
        stdout: () => {},
      },
      store,
    },
  );
  expect(status).toBe(0);
}

type Message = Record<string, unknown> & { id?: unknown };

/**
 * The bridge in this process, its protocol on streams of the test's, the
 * person consenting to each URL it prints on stderr for the next of
 * `server.grants`.
 */
function startBridge(
  options: {
    argv?: string[];
    env?: Record<string, string>;
    dependencies?: Partial<McpBridgeDependencies>;
  } = {},
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const output = { stderr: "", stdout: "" };
  stdout.setEncoding("utf8");
  stdout.on("data", (text: string) => {
    output.stdout += text;
  });
  const exit = runMcpBridge(
    options.argv ?? [],
    { HOME: home, ...options.env },
    {
      authorization: {
        startCallbackReceiver: () => server.startCallbackReceiver(),
        temporaryDirectory: scratch,
      },
      cwd: checkout,
      fetch: server.fetch,
      openBrowser: (url) => {
        opened.push(url);
      },
      stderr: (text) => {
        output.stderr += text;
        const url = /\n {2}(\S+)\n/u.exec(text)?.[1];
        if (url !== undefined) server.consent(url);
      },
      stdin,
      stdout,
      store,
      ...options.dependencies,
    },
  );

  /** Every line on stdout, each parsed: one that is not JSON fails here. */
  const lines = (): Message[] =>
    output.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Message);

  return {
    exit,
    lines,
    output,
    stdin,
    send(message: Record<string, unknown>) {
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    },
    /** The answer to request `id`, or a failure after `ms`. */
    async response(id: number, ms = 5_000): Promise<Message> {
      const until = Date.now() + ms;
      for (;;) {
        const found = lines().find((line) => line.id === id);
        if (found !== undefined) return found;
        if (Date.now() > until) throw new Error(`no answer to request ${id}`);
        await new Promise((resume) => setTimeout(resume, 5));
      }
    },
  };
}

const initialize = (id = 1) => ({
  id,
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "the agent", version: "1.0.0" },
    protocolVersion: PROTOCOL_VERSION,
  },
});

/** stdin was never read: what was written is all still buffered. */
function expectUnread(stdin: PassThrough, written: number) {
  expect(stdin.listenerCount("data")).toBe(0);
  expect(stdin.readableLength).toBe(written);
}

describe("the arguments", () => {
  test("--help prints the usage on stderr, and nothing on stdout", async () => {
    const bridge = startBridge({ argv: ["--help"] });

    expect(await bridge.exit).toBe(0);
    expect(bridge.output).toEqual({ stderr: `${MCP_USAGE}\n`, stdout: "" });
  });

  test("an unknown option or an argument is a usage error that never repeats it", async () => {
    for (const argv of [
      [`--${SENTINEL}`],
      [SENTINEL],
      ["--no-browser", SENTINEL],
    ]) {
      const bridge = startBridge({ argv });

      expect(await bridge.exit).toBe(2);
      expect(bridge.output.stdout).toBe("");
      expect(bridge.output.stderr).toContain(MCP_USAGE);
      expect(bridge.output.stderr).not.toContain(SENTINEL);
    }
  });
});

describe("before stdin is read", () => {
  test("no binding: refused, naming requestport link; nothing authorized", async () => {
    const bridge = startBridge();
    bridge.send(initialize());
    const written = bridge.stdin.readableLength;
    // Closed: a bridge that refuses never reads it, and one that served
    // would read it and exit 0 when it ends, rather than wait.
    bridge.stdin.end();

    expect(await bridge.exit).toBe(1);
    expect(bridge.output.stdout).toBe("");
    expect(bridge.output.stderr).toContain(
      'run "requestport link --server <url>" in the checkout first.',
    );
    expect(server.registrations).toEqual([]);
    expectUnread(bridge.stdin, written);
  });

  test("a binding whose project id is not lower case: refused, naming the file and the fix; nothing authorized, stdin unread", async () => {
    bind(projectA.toUpperCase());
    const bridge = startBridge();
    bridge.send(initialize());
    const written = bridge.stdin.readableLength;
    bridge.stdin.end();

    expect(await bridge.exit).toBe(1);
    expect(bridge.output.stdout).toBe("");
    expect(bridge.output.stderr).toContain(
      `names project ${projectA.toUpperCase()}, which is not in lower case.`,
    );
    expect(bridge.output.stderr).toContain(
      join(checkout, ".requestport", "project.json"),
    );
    expect(server.registrations).toEqual([]);
    expectUnread(bridge.stdin, written);
  });

  test("a stored credential for another project: refused, naming both; stdin unread, stdout empty", async () => {
    // Granted for B, stored under A's key: a credential for another
    // project, as a copied store or a session left over would hold one.
    await storeCredential(projectB);
    const record = store.read(server.origin, projectB, "mcp");
    if (record === undefined) throw new Error("login stored nothing for B");
    store.write(server.origin, projectA, "mcp", record);
    store.clear(server.origin, projectB, "mcp");
    bind(projectA);
    server.mcpCalls.length = 0;
    const bridge = startBridge();
    bridge.send(initialize());
    const written = bridge.stdin.readableLength;
    // Closed: a bridge that refuses never reads it, and one that served
    // would read it and exit 0 when it ends, rather than wait.
    bridge.stdin.end();

    expect(await bridge.exit).toBe(1);
    expect(bridge.output.stdout).toBe("");
    expect(bridge.output.stderr).toBe(
      `requestport mcp: This checkout is bound to project ${projectA} (${fakeProjectSlug(projectA)}), but the credential is for project ${projectB}. Refusing rather than filing work against the wrong project.\n`,
    );
    expect(server.mcpCalls).toEqual(["whoami"]);
    expectUnread(bridge.stdin, written);
  });

  test("nothing stored: the URL on stderr and the browser, never stdout; the binding's project granted and stored; then it serves", async () => {
    bind(projectA);
    server.grants.push(projectA);
    const bridge = startBridge();
    bridge.send(initialize());

    const answer = await bridge.response(1);

    expect(answer.result).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
    const urls = [...bridge.output.stderr.matchAll(/\n {2}(\S+)\n/gu)].map(
      (match) => match[1],
    );
    expect(urls).toHaveLength(1);
    expect(opened).toEqual(urls);
    expect(bridge.output.stdout).not.toContain("oauth2/authorize");
    expect(bridge.output.stderr).toContain(
      `requestport mcp: stored the mcp credential for project ${projectA} (organization ${FAKE_ORGANIZATION_ID}) on ${server.origin}.\n`,
    );
    expect(store.read(server.origin, projectA, "mcp")).toBeDefined();
    bridge.stdin.end();
    expect(await bridge.exit).toBe(0);
  });

  test("nothing stored, and a grant for another project: refused, naming both; nothing stored, stdin unread", async () => {
    bind(projectA);
    server.grants.push(projectB);
    const bridge = startBridge();
    bridge.send(initialize());
    const written = bridge.stdin.readableLength;
    // Closed: a bridge that refuses never reads it, and one that served
    // would read it and exit 0 when it ends, rather than wait.
    bridge.stdin.end();

    expect(await bridge.exit).toBe(1);
    expect(bridge.output.stdout).toBe("");
    expect(bridge.output.stderr).toContain(
      `requestport mcp: The mcp grant is for project ${projectB}, but this checkout's binding (${join(checkout, ".requestport", "project.json")}) names project ${projectA}. Nothing was stored.\n`,
    );
    expect(store.read(server.origin, projectA, "mcp")).toBeUndefined();
    expect(store.read(server.origin, projectB, "mcp")).toBeUndefined();
    expectUnread(bridge.stdin, written);
  });
});

describe("the relay", () => {
  test("a stored credential: whoami first, no consent; each message forwarded with the negotiated protocol version, each answer written back; stdin closing ends it", async () => {
    await storeCredential(projectA);
    bind(projectA);
    const registrations = server.registrations.length;
    server.mcpMessages.length = 0;
    server.mcpCalls.length = 0;
    const bridge = startBridge();

    bridge.send(initialize());
    const initialized = await bridge.response(1);
    bridge.send({ method: "notifications/initialized" });
    bridge.send({ id: 2, method: "tools/list" });
    bridge.send({
      id: 3,
      method: "tools/call",
      params: { arguments: {}, name: "whoami" },
    });
    const listed = await bridge.response(2);
    const called = await bridge.response(3);

    expect(initialized.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(listed.result).toEqual({
      tools: [
        { inputSchema: { type: "object" }, name: "whoami" },
        { inputSchema: { type: "object" }, name: "list_projects" },
      ],
    });
    expect(called.result).toMatchObject({
      structuredContent: { projectId: projectA },
    });
    // No consent: nothing registered, no URL.
    expect(server.registrations).toHaveLength(registrations);
    expect(bridge.output.stderr).toBe(
      `requestport mcp: serving project ${projectA} (${fakeProjectSlug(projectA)}) on ${server.origin}.\n`,
    );
    // whoami was asked in a session of its own before stdin was read; the
    // agent's session followed, every message after its initialize
    // carrying the version that initialize negotiated.
    expect(server.mcpCalls).toEqual(["whoami", "whoami"]);
    const relayed = server.mcpMessages.slice(
      server.mcpMessages
        .map((message) => message.method)
        .lastIndexOf("initialize"),
    );
    expect(relayed).toEqual([
      { method: "initialize", protocolVersion: null },
      {
        method: "notifications/initialized",
        protocolVersion: PROTOCOL_VERSION,
      },
      { method: "tools/list", protocolVersion: PROTOCOL_VERSION },
      { method: "tools/call", protocolVersion: PROTOCOL_VERSION },
    ]);
    // Every line on stdout is a JSON-RPC message, and there are three.
    expect(bridge.lines().map((line) => [line.jsonrpc, line.id])).toEqual([
      ["2.0", 1],
      ["2.0", 2],
      ["2.0", 3],
    ]);

    bridge.stdin.end();
    expect(await bridge.exit).toBe(0);
  });

  test("a request the server cannot answer gets a JSON-RPC error that names no token and repeats nothing the server said", async () => {
    await storeCredential(projectA);
    bind(projectA);
    const bridge = startBridge();
    bridge.send(initialize());
    await bridge.response(1);

    server.mcpFailure = {
      body: `${SENTINEL} access-1 refresh-1`,
      status: 500,
    };
    bridge.send({ id: 2, method: "tools/list" });
    const refused = await bridge.response(2);
    server.mcpFailure = { throws: new TypeError(`fetch failed ${SENTINEL}`) };
    bridge.send({ id: 3, method: "tools/list" });
    const unreachable = await bridge.response(3);

    expect(refused).toEqual({
      error: {
        code: UPSTREAM_FAILED,
        message: `requestport mcp: The request could not be forwarded to ${server.origin}/mcp: the server answered HTTP 500.`,
      },
      id: 2,
      jsonrpc: "2.0",
    });
    expect(unreachable).toEqual({
      error: {
        code: UPSTREAM_FAILED,
        message: `requestport mcp: The request could not be forwarded to ${server.origin}/mcp: the request did not complete.`,
      },
      id: 3,
      jsonrpc: "2.0",
    });
    for (const text of [bridge.output.stdout, bridge.output.stderr]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toMatch(TOKEN_VALUE);
    }
    bridge.stdin.end();
    expect(await bridge.exit).toBe(0);
  });
});

/*
 * r9-rulings.md, ruling 102: a server that refuses the kept access token
 * before it expires (one it revoked, for instance) is answered with one
 * retry, through a fresh refresh.
 */
describe("a 401 from the server", () => {
  const TOOLS = {
    tools: [
      { inputSchema: { type: "object" }, name: "whoami" },
      { inputSchema: { type: "object" }, name: "list_projects" },
    ],
  };

  /** A bridge serving project A from a stored credential, past initialize. */
  async function serving() {
    await storeCredential(projectA);
    bind(projectA);
    const bridge = startBridge();
    bridge.send(initialize());
    await bridge.response(1);
    const kept = server.mcpBearers.at(-1)?.token;
    if (kept === undefined) throw new Error("initialize presented no token");
    server.mcpBearers.length = 0;
    return { bridge, kept, refreshes: server.refreshes.length };
  }

  test("to the kept token: one retry, with the token one more refresh issued; the request answered, and nothing printed", async () => {
    const { bridge, kept, refreshes } = await serving();
    server.revokeAccessTokens();

    bridge.send({ id: 2, method: "tools/list" });
    const listed = await bridge.response(2);
    bridge.send({ id: 3, method: "tools/list" });
    const again = await bridge.response(3);

    expect(listed).toEqual({ id: 2, jsonrpc: "2.0", result: TOOLS });
    expect(again).toEqual({ id: 3, jsonrpc: "2.0", result: TOOLS });
    expect(server.refreshes).toHaveLength(refreshes + 1);
    const fresh = server.refreshedAccessTokens.at(-1);
    expect(server.mcpBearers).toEqual([
      { refused: true, token: kept },
      { refused: false, token: fresh },
      { refused: false, token: fresh },
    ]);
    expect(bridge.output.stderr).toBe(
      `requestport mcp: serving project ${projectA} (${fakeProjectSlug(projectA)}) on ${server.origin}.\n`,
    );
    bridge.stdin.end();
    expect(await bridge.exit).toBe(0);
  });

  test("to the refreshed token too: the request ends with a JSON-RPC error naming requestport login --for mcp; two attempts and one refresh, no loop; the credential kept", async () => {
    const { bridge, kept, refreshes } = await serving();
    server.refuseAccessTokens = true;

    bridge.send({ id: 2, method: "tools/list" });
    const refused = await bridge.response(2);
    // Anything more would have been sent by now: the fake answers at once.
    await new Promise((resume) => setTimeout(resume, 100));

    const message = `requestport mcp: ${server.origin}/mcp refused the access token of the mcp credential for project ${projectA} (HTTP 401), and refused it again after a fresh refresh. The stored credential is kept. To authorize again, run "requestport login --for mcp".`;
    expect(refused).toEqual({
      error: { code: UPSTREAM_FAILED, message },
      id: 2,
      jsonrpc: "2.0",
    });
    // On stderr too, once.
    expect(bridge.output.stderr).toBe(
      `requestport mcp: serving project ${projectA} (${fakeProjectSlug(projectA)}) on ${server.origin}.\n${message}\n`,
    );
    // The kept token, then the one the single refresh issued, both refused.
    expect(server.mcpBearers).toEqual([
      { refused: true, token: kept },
      { refused: true, token: server.refreshedAccessTokens.at(-1) },
    ]);
    expect(server.refreshes).toHaveLength(refreshes + 1);
    expect(store.read(server.origin, projectA, "mcp")).toBeDefined();
    for (const text of [bridge.output.stdout, bridge.output.stderr]) {
      expect(text).not.toMatch(TOKEN_VALUE);
    }
    bridge.stdin.end();
    expect(await bridge.exit).toBe(0);
  });

  test("and the grant revoked: the refresh's invalid_grant removes the credential, the error names requestport login --for mcp, and nothing is retried", async () => {
    const { bridge, kept, refreshes } = await serving();
    server.revokeAccessTokens();
    server.refuseRefreshes = true;

    bridge.send({ id: 2, method: "tools/list" });
    const refused = await bridge.response(2);

    expect(refused).toEqual({
      error: {
        code: UPSTREAM_FAILED,
        message: `requestport mcp: Authorization required again: ${server.origin} refused the mcp credential for project ${projectA} on ${server.origin} (invalid_grant), so it has been removed. To authorize again, run "requestport login --for mcp".`,
      },
      id: 2,
      jsonrpc: "2.0",
    });
    expect(store.read(server.origin, projectA, "mcp")).toBeUndefined();
    expect(server.mcpBearers).toEqual([{ refused: true, token: kept }]);
    expect(server.refreshes).toHaveLength(refreshes + 1);
    for (const text of [bridge.output.stdout, bridge.output.stderr]) {
      expect(text).not.toMatch(TOKEN_VALUE);
    }
    bridge.stdin.end();
    expect(await bridge.exit).toBe(0);
  });

  test(`to ${"REQUESTPORT_AGENT_TOKEN"}'s token: not retried, nothing refreshed`, async () => {
    bind(projectA);
    const token = server.issueAccessToken(projectA, "mcp");
    const bridge = startBridge({ env: { REQUESTPORT_AGENT_TOKEN: token } });
    bridge.send(initialize());
    await bridge.response(1);
    server.mcpBearers.length = 0;
    server.revokeAccessTokens();

    bridge.send({ id: 2, method: "tools/list" });
    const refused = await bridge.response(2);

    expect(refused).toEqual({
      error: {
        code: UPSTREAM_FAILED,
        message: `requestport mcp: The request could not be forwarded to ${server.origin}/mcp: the server refused the access token (HTTP 401).`,
      },
      id: 2,
      jsonrpc: "2.0",
    });
    expect(server.mcpBearers).toEqual([{ refused: true, token }]);
    expect(server.refreshes).toEqual([]);
    bridge.stdin.end();
    expect(await bridge.exit).toBe(0);
  });
});

describe(`${"REQUESTPORT_AGENT_TOKEN"}, the credential CI is handed`, () => {
  test("is presented as it is: nothing read, stored, refreshed or authorized; its value never printed", async () => {
    bind(projectA);
    const token = server.issueAccessToken(projectA, "mcp");
    const bridge = startBridge({ env: { REQUESTPORT_AGENT_TOKEN: token } });

    bridge.send(initialize());
    bridge.send({
      id: 2,
      method: "tools/call",
      params: { arguments: {}, name: "whoami" },
    });
    const called = await bridge.response(2);

    expect(called.result).toMatchObject({
      structuredContent: { projectId: projectA },
    });
    expect(server.registrations).toEqual([]);
    expect(server.refreshes).toEqual([]);
    expect(existsSync(join(home, ".requestport"))).toBe(false);
    expect(bridge.output.stderr).toContain(
      "requestport mcp: using the credential supplied by REQUESTPORT_AGENT_TOKEN.\n",
    );
    expect(bridge.output.stderr).not.toContain(token);
    expect(bridge.output.stdout).not.toContain(token);
    bridge.stdin.end();
    expect(await bridge.exit).toBe(0);
  });

  test("for another project: refused, naming both; stdout empty", async () => {
    bind(projectA);
    const token = server.issueAccessToken(projectB, "mcp");
    const bridge = startBridge({ env: { REQUESTPORT_AGENT_TOKEN: token } });
    bridge.send(initialize());
    const written = bridge.stdin.readableLength;
    // Closed: a bridge that refuses never reads it, and one that served
    // would read it and exit 0 when it ends, rather than wait.
    bridge.stdin.end();

    expect(await bridge.exit).toBe(1);
    expect(bridge.output.stdout).toBe("");
    expect(bridge.output.stderr).toContain(
      `This checkout is bound to project ${projectA} (${fakeProjectSlug(projectA)}), but the credential is for project ${projectB}.`,
    );
    expect(bridge.output.stderr).not.toContain(token);
    expectUnread(bridge.stdin, written);
  });
});
