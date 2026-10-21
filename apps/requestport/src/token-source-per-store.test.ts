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
import type * as TokenSourceModule from "@requestport/client/token-source";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runLink } from "./link.js";
import { runLogin } from "./login.js";
import { runMcpBridge } from "./mcp-bridge.js";
import {
  createFakeAuthorizationServer,
  FAKE_ORGANIZATION_ID,
  type FakeAuthorizationServer,
  fakeProjectSlug,
} from "./test-support/fake-authorization-server.js";

/*
 * r9-rulings.md, ruling 112: two token sources over one credential store in
 * one process can lengthen each other's hold on the token lock, because the
 * store's calls are synchronous. H.6 closes it with the ruling's first
 * option, one token source per store per process (track-h.md, H.6's survey,
 * question 7): `requestport mcp` builds one over the store it was given,
 * `link` one at most, `login` none, and each holding-store flow one over a
 * holding store of its own. The mock below records every source made in this
 * process through the module every caller imports, `packages/client`'s own
 * `http.ts` included, and the store each was made over.
 */

const made = vi.hoisted(
  () => [] as { audience: string; store: CredentialStore }[],
);

vi.mock("@requestport/client/token-source", async (importOriginal) => {
  const actual = await importOriginal<typeof TokenSourceModule>();
  return {
    ...actual,
    createTokenSource: (options: TokenSourceModule.TokenSourceOptions) => {
      made.push({ audience: options.audience, store: options.store });
      return actual.createTokenSource(options);
    },
  };
});

const projectA = "018f0000-0000-7000-8000-00000000a001";
const PROTOCOL_VERSION = "2025-11-25";
const URL_LINE = /\n {2}(\S+)\n/u;

let home: string;
let checkout: string;
let scratch: string;
let store: CredentialStore;
let server: FakeAuthorizationServer;

const realHomeHadStore = existsSync(join(homedir(), ".requestport"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "requestport-sources-home-"));
  checkout = mkdtempSync(join(tmpdir(), "requestport-sources-checkout-"));
  scratch = mkdtempSync(join(tmpdir(), "requestport-sources-tmp-"));
  store = createFileStore({ home });
  server = createFakeAuthorizationServer();
});

afterEach(() => {
  for (const directory of [home, checkout, scratch]) {
    rmSync(directory, { recursive: true, force: true });
  }
  expect(existsSync(join(homedir(), ".requestport"))).toBe(realHomeHadStore);
});

/** The audiences of the sources made over `over`, in order. */
const madeOver = (over: CredentialStore) =>
  made.filter((source) => source.store === over).map((s) => s.audience);

/** Every other store a source was made over, with the audiences of each. */
function otherStores(): string[][] {
  const others = new Map<CredentialStore, string[]>();
  for (const source of made) {
    if (source.store === store) continue;
    others.set(source.store, [
      ...(others.get(source.store) ?? []),
      source.audience,
    ]);
  }
  return [...others.values()];
}

const authorization = () => ({
  fetch: server.fetch,
  startCallbackReceiver: () => server.startCallbackReceiver(),
  temporaryDirectory: scratch,
});

const consenting = (text: string) => {
  const url = URL_LINE.exec(text)?.[1];
  if (url !== undefined) server.consent(url);
};

/** `requestport login` in this process, the person granting `grants`. */
async function login(argv: string[], grants: string[]) {
  server.grants.push(...grants);
  const status = await runLogin(
    ["--server", server.origin, ...argv],
    { HOME: home },
    {
      authorization: authorization(),
      cwd: scratch,
      openBrowser: null,
      output: { stderr: consenting, stdout: () => {} },
      store,
    },
  );
  expect(status).toBe(0);
}

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

/**
 * `requestport mcp` in this process: initialize, then `tools/list` after
 * the server has revoked the kept access token, so the run covers whoami,
 * the relay and a 401's retry; then stdin closes.
 */
async function bridgeRun() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let written = "";
  stdout.setEncoding("utf8").on("data", (text: string) => {
    written += text;
  });
  const exit = runMcpBridge(
    [],
    { HOME: home },
    {
      authorization: authorization(),
      cwd: checkout,
      fetch: server.fetch,
      openBrowser: null,
      stderr: consenting,
      stdin,
      stdout,
      store,
    },
  );
  const answer = async (id: number) => {
    const until = Date.now() + 5_000;
    for (;;) {
      const found = written
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { id?: unknown })
        .find((line) => line.id === id);
      if (found !== undefined) return found;
      if (Date.now() > until) throw new Error(`no answer to request ${id}`);
      await new Promise((resume) => setTimeout(resume, 5));
    }
  };
  const send = (message: Record<string, unknown>) =>
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  send({
    id: 1,
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "the agent", version: "1.0.0" },
      protocolVersion: PROTOCOL_VERSION,
    },
  });
  await answer(1);
  const refreshes = server.refreshes.length;
  server.revokeAccessTokens();
  send({ id: 2, method: "tools/list" });
  const listed = await answer(2);
  stdin.end();
  expect(await exit).toBe(0);
  expect(listed).toMatchObject({ result: { tools: expect.any(Array) } });
  // The 401 was retried through a refresh: the case the ruling is about.
  expect(server.refreshes).toHaveLength(refreshes + 1);
}

describe("one token source per credential store per process (ruling 112)", () => {
  test("requestport mcp with a stored credential: one source over its store, for whoami, the relay and a 401's retry", async () => {
    await login(["--project", projectA], [projectA]);
    bind(projectA);
    made.length = 0;

    await bridgeRun();

    expect(madeOver(store)).toEqual(["mcp"]);
    expect(otherStores()).toEqual([]);
  });

  test("requestport mcp that authorizes first: still one over its store; the holding flow's one over a store of its own", async () => {
    bind(projectA);
    server.grants.push(projectA);
    made.length = 0;

    await bridgeRun();

    expect(madeOver(store)).toEqual(["mcp"]);
    expect(otherStores()).toEqual([["mcp"]]);
  });

  test("requestport login --for both: none over its store; one over each holding store, packages/client's HTTP client's included", async () => {
    made.length = 0;

    await login(["--project", projectA, "--for", "both"], [projectA, projectA]);

    expect(madeOver(store)).toEqual([]);
    expect(otherStores()).toEqual([["mcp"], ["api"]]);
    expect(store.read(server.origin, projectA, "mcp")).toBeDefined();
    expect(store.read(server.origin, projectA, "api")).toBeDefined();
  });

  test("requestport link with a stored credential: one source over its store", async () => {
    await login(["--project", projectA], [projectA]);
    made.length = 0;

    const status = await runLink(
      ["--server", server.origin, "--project", projectA],
      { HOME: home },
      {
        authorization: authorization(),
        cwd: checkout,
        openBrowser: null,
        output: { stderr: consenting, stdout: () => {} },
        store,
      },
    );

    expect(status).toBe(0);
    expect(madeOver(store)).toEqual(["mcp"]);
    expect(otherStores()).toEqual([]);
  });

  test("requestport link with nothing stored: none over its store; the holding flow's one over a store of its own", async () => {
    server.grants.push(projectA);
    made.length = 0;

    const status = await runLink(
      ["--server", server.origin, "--project", projectA],
      { HOME: home },
      {
        authorization: authorization(),
        cwd: checkout,
        openBrowser: null,
        output: { stderr: consenting, stdout: () => {} },
        store,
      },
    );

    expect(status).toBe(0);
    expect(madeOver(store)).toEqual([]);
    expect(otherStores()).toEqual([["mcp"]]);
    expect(store.read(server.origin, projectA, "mcp")).toBeDefined();
  });

  test(`requestport mcp with ${"REQUESTPORT_AGENT_TOKEN"}: no source at all`, async () => {
    bind(projectA);
    const token = server.issueAccessToken(projectA, "mcp");
    made.length = 0;

    const stdin = new PassThrough();
    const exit = runMcpBridge(
      [],
      { HOME: home, REQUESTPORT_AGENT_TOKEN: token },
      {
        cwd: checkout,
        fetch: server.fetch,
        openBrowser: null,
        stderr: () => {},
        stdin,
        stdout: new PassThrough(),
        store,
      },
    );
    stdin.end();

    expect(await exit).toBe(0);
    expect(made).toEqual([]);
  });
});
