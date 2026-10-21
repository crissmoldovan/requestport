import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  type Audience,
  type CredentialStore,
  createFileStore,
  resourceFor,
} from "./credentials.js";
import { createRequestPortHttpClient, RequestPortApiError } from "./http.js";
import type { FetchLike } from "./oauth.js";
import {
  createFakeProvider,
  type FakeProvider,
} from "./test-support/fake-provider.js";
import { AuthorizationRequiredError } from "./token-source.js";

const SERVER = "https://requestport.com";
const API = `${SERVER}/api/v1`;
const PROJECT = "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const directories: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "requestport-http-"));
  directories.push(root);
  return root;
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { force: true, recursive: true });
  }
});

type Call = { readonly init: RequestInit | undefined; readonly url: string };

type Harness = {
  readonly calls: Call[];
  client(): ReturnType<typeof createRequestPortHttpClient>;
  readonly first: string;
  readonly provider: FakeProvider;
  readonly store: CredentialStore;
  /** Answers every request under /api/v1 but whoami, which the provider answers. */
  rest: ((url: string, init: RequestInit | undefined) => Response) | undefined;
};

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function bearerOf(init: RequestInit | undefined): string {
  return (new Headers(init?.headers).get("authorization") ?? "").replace(
    /^Bearer /u,
    "",
  );
}

/**
 * A stored credential for one audience, a provider that issued it, and a
 * client whose fetch reaches the provider (discovery, the token endpoint and
 * `whoami`) and, for every other path under /api/v1, `rest`.
 */
function harness(audience: Audience | "none" = "api"): Harness {
  const provider = createFakeProvider(SERVER);
  const store = createFileStore({ home: scratch() });
  const lockDirectory = join(scratch(), "locks");
  const calls: Call[] = [];
  let first = "";

  if (audience !== "none") {
    const resource = resourceFor(SERVER, audience);
    first = provider.authorize({
      clientId: `client-${audience}`,
      projectId: PROJECT,
      resource,
    });
    store.write(SERVER, PROJECT, audience, {
      audience,
      clientId: `client-${audience}`,
      obtained: "2026-09-30T10:00:00.000Z",
      refreshToken: first,
      resource,
      version: 2,
    });
  }

  const run: Harness = {
    calls,
    client: () =>
      createRequestPortHttpClient({
        fetch,
        lockDirectory,
        projectId: PROJECT,
        server: SERVER,
        store,
      }),
    first,
    provider,
    rest: undefined,
    store,
  };

  const fetch: FetchLike = async (url, init) => {
    calls.push({ init, url });
    if (url.startsWith(`${API}/`) && url !== `${API}/whoami`) {
      if (!provider.accepts(bearerOf(init), API)) {
        return json({ error: "unauthenticated", message: "x" }, 401);
      }
      if (run.rest === undefined) throw new Error(`no stub for ${url}`);
      return run.rest(url, init);
    }
    return provider.fetch(url, init);
  };

  return run;
}

function restCalls(run: Harness): Call[] {
  return run.calls.filter((call) => call.url.startsWith(`${API}/`));
}

/** Every token the provider issued or was shown. */
function tokensOf(run: Harness): string[] {
  return [
    run.first,
    ...run.provider.refreshes.map((each) => each.refreshToken ?? ""),
    run.store.read(SERVER, PROJECT, "api")?.refreshToken ?? "",
    ...restCalls(run).map((call) => bearerOf(call.init)),
  ].filter((token) => token !== "");
}

function expectNoTokenIn(value: unknown, run: Harness): void {
  const text =
    value instanceof Error
      ? JSON.stringify(value, Object.getOwnPropertyNames(value))
      : JSON.stringify(value);
  for (const token of tokensOf(run)) expect(text).not.toContain(token);
}

async function thrownBy(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("the call was expected to throw, and did not");
}

describe("calling whoami", () => {
  /** manifest-h.md Done when 12. */
  test("sends a refreshed api token, and returns no token in any value", async () => {
    const run = harness();

    const identity = await run.client().whoami();

    const sent = run.calls.find((call) => call.url === `${API}/whoami`);
    expect(run.provider.refreshes).toEqual([
      { clientId: "client-api", refreshToken: run.first, resource: API },
    ]);
    expect(run.provider.accepts(bearerOf(sent?.init), API)).toBe(true);
    expect(run.store.read(SERVER, PROJECT, "api")?.refreshToken).not.toBe(
      run.first,
    );
    expect(identity).toEqual({
      actor: { id: "agent-1", type: "agent" },
      audience: "api",
      authorizationId: "authorization-1",
      laneIds: [],
      organizationId: "c533d303-b467-421d-bb76-bef05608d496",
      projectId: PROJECT,
      scopes: ["request:read"],
      serverSchemaVersion: 1,
      workPolicy: { heartbeatIntervalSeconds: 60 },
    });
    expectNoTokenIn(identity, run);
    expect(tokensOf(run).length).toBeGreaterThanOrEqual(3);
  });

  test("offers whoami, a command and a query, and nothing that holds a token", () => {
    expect(Object.keys(harness().client()).sort()).toEqual([
      "command",
      "query",
      "whoami",
    ]);
  });

  test("keeps only the fields whoami documents", async () => {
    const run = harness();
    const fetch: FetchLike = async (url, init) =>
      url === `${API}/whoami`
        ? json({
            ...((await (await run.provider.fetch(url, init)).json()) as Record<
              string,
              unknown
            >),
            extra: "not documented",
          })
        : run.provider.fetch(url, init);

    const identity = await createRequestPortHttpClient({
      fetch,
      lockDirectory: join(scratch(), "locks"),
      projectId: PROJECT,
      server: SERVER,
      store: run.store,
    }).whoami();

    expect(identity).not.toHaveProperty("extra");
  });

  test("refuses an answer that is not whoami's shape", async () => {
    const run = harness();
    const fetch: FetchLike = async (url, init) =>
      url === `${API}/whoami`
        ? json({ projectId: 42 })
        : run.provider.fetch(url, init);

    const error = await thrownBy(() =>
      createRequestPortHttpClient({
        fetch,
        lockDirectory: join(scratch(), "locks"),
        projectId: PROJECT,
        server: SERVER,
        store: run.store,
      }).whoami(),
    );

    expect(error).toBeInstanceOf(RequestPortApiError);
    expect((error as RequestPortApiError).code).toBe("unexpected_response");
  });
});

/**
 * The HTTP client is the `api` audience's. A token for `mcp` is refused at
 * /api/v1, so a stored `mcp` credential is not one it can use.
 */
describe("without an api credential", () => {
  test.each([
    ["nothing is stored", "none"],
    ["only the mcp credential is stored", "mcp"],
  ] as const)(
    "answers authorization required when %s, naming requestport login --for api",
    async (_case, stored) => {
      const run = harness(stored);

      const error = await thrownBy(() => run.client().whoami());

      expect(error).toBeInstanceOf(AuthorizationRequiredError);
      expect(String(error)).toMatch(/authorization required/iu);
      expect(String(error)).toContain("requestport login --for api");
      expect(restCalls(run)).toEqual([]);
    },
  );
});

describe("a registry command", () => {
  test("is posted by name with its envelope, and answers its result", async () => {
    const run = harness();
    run.rest = () => json({ result: { requestId: "r-1", version: 1 } });

    const result = await run.client().command("create_request_draft", {
      expectedVersion: 0,
      idempotencyKey: "a3c9e0d2-77b1-4f3e-9b8a-5c1d2e3f4a5b",
      input: { title: "Rotate the keys" },
    });

    const [call] = restCalls(run);
    expect(call?.url).toBe(`${API}/commands/create_request_draft`);
    expect(call?.init?.method).toBe("POST");
    expect(new Headers(call?.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      expectedVersion: 0,
      idempotencyKey: "a3c9e0d2-77b1-4f3e-9b8a-5c1d2e3f4a5b",
      input: { title: "Rotate the keys" },
    });
    expect(result).toEqual({ requestId: "r-1", version: 1 });
    expectNoTokenIn(result, run);
  });

  test("sends an empty input when none is given", async () => {
    const run = harness();
    run.rest = () => json({ result: null });

    await run.client().command("agent_hello", {
      expectedVersion: 0,
      idempotencyKey: "b3c9e0d2-77b1-4f3e-9b8a-5c1d2e3f4a5b",
    });

    expect(JSON.parse(String(restCalls(run)[0]?.init?.body)).input).toEqual({});
  });

  test.each(["Create", "create-request", "../whoami", "create_request/x", ""])(
    "refuses the name %j before a token is taken or a request sent",
    async (name) => {
      const run = harness();

      await expect(
        run.client().command(name, {
          expectedVersion: 0,
          idempotencyKey: "c3c9e0d2-77b1-4f3e-9b8a-5c1d2e3f4a5b",
        }),
      ).rejects.toThrow(TypeError);
      expect(run.calls).toEqual([]);
    },
  );
});

describe("a query", () => {
  test("is a GET of its path under /api/v1, with its parameters", async () => {
    const run = harness();
    run.rest = () => json({ items: [], nextCursor: null });

    const result = await run.client().query("requests", {
      limit: 10,
      state: ["triage", "accepted"],
    });

    const [call] = restCalls(run);
    expect(call?.init?.method).toBe("GET");
    expect(call?.url).toBe(
      `${API}/requests?limit=10&state=triage&state=accepted`,
    );
    expect(result).toEqual({ items: [], nextCursor: null });
  });

  test("takes a path of several segments, with or without slashes at its ends", async () => {
    const run = harness();
    run.rest = () => json({ events: [] });

    await run
      .client()
      .query("/requests/0b5c6a4e-1f2a-4c3b-8d9e-0a1b2c3d4e5f/timeline/");

    expect(restCalls(run)[0]?.url).toBe(
      `${API}/requests/0b5c6a4e-1f2a-4c3b-8d9e-0a1b2c3d4e5f/timeline`,
    );
  });

  /**
   * The request carries the bearer token, so a path that resolved anywhere
   * but under this server's /api/v1 would hand the token to whatever it
   * named.
   */
  test.each([
    "",
    "/",
    "../auth/oauth2/token",
    "requests/../../auth",
    "a/./b",
    "//evil.example/x",
    "https://evil.example/x",
    "requests?state=triage",
    "requests#top",
    "requests\\..\\auth",
    "requests/%2e%2e/auth",
  ])(
    "refuses the path %j before a token is taken or a request sent",
    async (path) => {
      const run = harness();

      await expect(run.client().query(path)).rejects.toThrow(TypeError);
      expect(run.calls).toEqual([]);
    },
  );
});

/**
 * REST's error envelope (`{ error, message, details }`) becomes a
 * `RequestPortApiError`: the status, the `error` code when it is a plain
 * word, and the two details REST publishes, `field` and
 * `retryAfterSeconds`. Nothing else from the response is repeated.
 */
describe("a refusal", () => {
  /**
   * What a refusal's free text may carry that this client must not repeat:
   * a value of the server's own, and the bearer token the request carried,
   * which a proxy or a faulty handler can echo into a response. REST's
   * `message` is prose for whoever reads the response, and of `details`
   * only the two fields REST publishes are kept, whatever else it holds.
   */
  const ECHOED = "echoed-by-the-server-Qz7wX2";

  function echoing(body: unknown, bearer: string): unknown {
    const echo = `${ECHOED} ${bearer}`;
    if (typeof body === "string") {
      return body.replace("</html>", ` ${echo}</html>`);
    }
    const given = body as { details?: Record<string, unknown> };
    return {
      ...given,
      details: { ...given.details, hint: echo, value: bearer },
      message: echo,
    };
  }

  function expectNothingEchoedIn(error: unknown, run: Harness): void {
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error as object)),
    ).not.toContain(ECHOED);
    expectNoTokenIn(error, run);
  }

  test.each([
    [403, { error: "forbidden", message: "m", details: {} }, "forbidden", {}],
    [404, { error: "not_found", message: "m", details: {} }, "not_found", {}],
    [
      409,
      { error: "version_conflict", message: "m", details: {} },
      "version_conflict",
      {},
    ],
    [
      422,
      {
        error: "validation_failed",
        message: "m",
        details: { field: "input.title" },
      },
      "validation_failed",
      { field: "input.title" },
    ],
    [
      429,
      {
        error: "rate_limited",
        message: "m",
        details: { retryAfterSeconds: 7 },
      },
      "rate_limited",
      { retryAfterSeconds: 7 },
    ],
    [500, { error: "unexpected_error", message: "m" }, "unexpected_error", {}],
    [502, "<html>bad gateway</html>", "unexpected_response", {}],
    [400, { error: "Not A Word!", message: "m" }, "unexpected_response", {}],
    [
      422,
      {
        error: "validation_failed",
        details: { field: "has spaces and; more" },
      },
      "validation_failed",
      {},
    ],
  ] as const)(
    "answering %d becomes a typed error",
    async (status, body, code, details) => {
      const run = harness();
      run.rest = (_url, init) => {
        const echoed = echoing(body, bearerOf(init));
        return typeof echoed === "string"
          ? new Response(echoed, { status })
          : json(echoed, status);
      };

      const error = await thrownBy(() => run.client().query("requests"));

      expect(error).toBeInstanceOf(RequestPortApiError);
      expect((error as RequestPortApiError).status).toBe(status);
      expect((error as RequestPortApiError).code).toBe(code);
      expect((error as RequestPortApiError).details).toEqual(details);
      expect(String(error)).toContain(String(status));
      expect(String(error)).toContain("GET /requests");
      expectNothingEchoedIn(error, run);
    },
  );

  test("takes the retry delay from the header when the body does not give one", async () => {
    const run = harness();
    run.rest = () =>
      json({ error: "rate_limited", message: "m", details: {} }, 429, {
        "retry-after": "12",
      });

    const error = await thrownBy(() => run.client().query("requests"));

    expect((error as RequestPortApiError).details).toEqual({
      retryAfterSeconds: 12,
    });
  });

  test("answering 401 names the command that authorizes again", async () => {
    const run = harness();
    run.rest = (_url, init) =>
      json(
        echoing(
          { error: "unauthenticated", message: "m", details: {} },
          bearerOf(init),
        ),
        401,
      );

    const error = await thrownBy(() => run.client().query("requests"));

    expect((error as RequestPortApiError).code).toBe("unauthenticated");
    expect(String(error)).toContain("requestport login --for api");
    expectNothingEchoedIn(error, run);
  });

  test("a server that cannot be reached says so, and nothing the failure quoted", async () => {
    const run = harness();
    run.rest = (_url, init) => {
      throw Object.assign(new TypeError(`fetch failed for ${bearerOf(init)}`), {
        cause: { code: "ECONNRESET" },
      });
    };

    const error = await thrownBy(() => run.client().query("requests"));

    expect(error).toBeInstanceOf(RequestPortApiError);
    expect((error as RequestPortApiError).code).toBe("unreachable");
    expect((error as RequestPortApiError).status).toBeUndefined();
    expect(String(error)).toContain("ECONNRESET");
    expectNoTokenIn(error, run);
  });

  test("an answer that is not JSON is refused as unexpected", async () => {
    const run = harness();
    run.rest = () => new Response("<html>ok</html>", { status: 200 });

    const error = await thrownBy(() => run.client().query("requests"));

    expect((error as RequestPortApiError).code).toBe("unexpected_response");
  });

  test("a command answer with no result is refused as unexpected", async () => {
    const run = harness();
    run.rest = () => json({ ok: true });

    const error = await thrownBy(() =>
      run.client().command("agent_hello", {
        expectedVersion: 0,
        idempotencyKey: "d3c9e0d2-77b1-4f3e-9b8a-5c1d2e3f4a5b",
      }),
    );

    expect((error as RequestPortApiError).code).toBe("unexpected_response");
  });
});
