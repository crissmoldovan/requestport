import {
  admitsCredentialKind,
  createCoreCommandRegistry,
  normalizedInputHash,
  restCommandTransports,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  agentContext,
  ids,
  restClient,
  signInAs,
} from "../../../../test/api-v1/agent-client.js";
import {
  apiV1,
  resetApiV1Fakes,
} from "../../../../test/api-v1/fake-database.js";
import {
  operatorOnlyRestCommands,
  type RestCommand,
  registryCommandsNotOnRest,
  restCommands,
  restQueries,
} from "../../../../test/api-v1/rest-surface.js";

vi.mock(
  "@requestport/db",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeDatabaseModule,
);
vi.mock(
  "@requestport/auth/server",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeAuthServerModule,
);
vi.mock(
  "@requestport/config/server",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeServerConfigModule,
);
vi.mock(
  "../../../../lib/observability.js",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeObservabilityModule,
);
vi.mock(
  "../../../../lib/trigger-client.js",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js"))
      .fakeTriggerClientModule,
);
// The web root runs, and the web's RequestPort is composed over the storage
// the wiring answers here (`server-web-request-port.ts`): the routes, the
// handlers and the rate limiter reach the faked package through it (Plan 13,
// G.3, G.6; ruling 140).
vi.mock(
  "@requestport/db/wiring",
  async () =>
    (await import("../../../../test/api-v1/fake-database.js")).fakeWiringModule,
);

const route = await import("./route.js");
const { coreCommandBus } = await import(
  "../../../../lib/server-core-commands.js"
);
const api = restClient(route);
const registry = createCoreCommandRegistry();
const busCommands = restCommands.filter((command) => command.busCommand);
const lifecycleNames = restCommands
  .filter(
    (command) =>
      command.busCommand === "transition_request" &&
      command.name !== "transition_request",
  )
  .map((command) => command.name);

beforeEach(() => {
  resetApiV1Fakes();
  vi.restoreAllMocks();
});

/**
 * What the bus receives for a row: the caller's input with the route's own
 * fields written over it.
 */
function dispatchedInput(command: RestCommand) {
  return { ...command.input, ...command.injected };
}

/**
 * Answer `command` from a stored receipt, which is the one success path the
 * bus has that touches no repository: it authorizes, finds a receipt whose
 * input hash matches, and returns the stored result. The hash is computed from
 * what the table says the bus should receive, so a route that dispatched
 * anything else would miss the receipt and fall through to a port.
 */
function storeReceiptFor(command: RestCommand, result: unknown) {
  const definition = registry.resolve(command.busCommand as string);
  if (!definition) throw new Error(`${command.busCommand} is not registered`);
  apiV1.receipts.find.mockResolvedValue({
    normalizedInputHash: normalizedInputHash(
      definition.parse(dispatchedInput(command)),
    ),
    result: result as never,
  });
}

/**
 * Plan 13, track B1: which names `/api/v1` exposes, and what each is
 * dispatched as. F.1 replaces the module-private `Set` and the `GET` if-chain
 * with a capability registry; these are the answers it has to keep.
 */
describe("POST /api/v1/commands/<name>: every name the registry gives REST", () => {
  // The count is the registry's REST commands that admit an agent, not a
  // literal and not the table's own length, so a command added to the
  // registry fails here until the table has its row, and nobody edits a
  // number (Plan 13, F.2.0). The table is the agent surface; the commands
  // only an operator reaches are `operatorOnlyRestCommands` (F.3).
  test("the table holds as many distinct names as the registry's REST commands that admit an agent, 15 of them lifecycle actions", () => {
    const agentCommands = restCommandTransports.filter((transport) =>
      admitsCredentialKind(transport, "agent"),
    );
    const names = restCommands.map((command) => command.name);
    expect(names).toHaveLength(agentCommands.length);
    expect(new Set(names).size).toBe(agentCommands.length);
    expect(lifecycleNames).toHaveLength(15);
  });

  test("they are exactly the registry's commands that admit an agent", () => {
    // Plan 13, F.3: `credentialKinds` decides who reaches a command on REST.
    // The table holds the ones admitting agents; the rest are operator-only.
    expect(
      restCommandTransports
        .filter((transport) => admitsCredentialKind(transport, "agent"))
        .map((transport) => transport.name)
        .toSorted(),
    ).toEqual(restCommands.map((command) => command.name).toSorted());
    expect(operatorOnlyRestCommands.length).toBe(
      restCommandTransports.length - restCommands.length,
    );
  });

  test("every bus-dispatched name resolves in the real core registry", () => {
    for (const command of busCommands) {
      expect(registry.resolve(command.busCommand as string)).toBeDefined();
    }
    // The one name that bypasses the bus is not a registered command at all.
    expect(registry.resolve("register_project")).toBeUndefined();
  });

  test("the registry's other commands are exactly the ones REST withholds", () => {
    const exposed = new Set(
      [...busCommands, ...operatorOnlyRestCommands].map(
        (command) => command.busCommand,
      ),
    );
    expect(registry.names().filter((name) => !exposed.has(name))).toEqual([
      ...registryCommandsNotOnRest,
    ]);
  });

  test.each(busCommands.map((command) => [command.name, command] as const))(
    "%s is dispatched to the bus with the route's fields written over the caller's",
    async (_name, command) => {
      const context = signInAs(agentContext());
      const execute = vi.spyOn(coreCommandBus, "execute");
      storeReceiptFor(command, { characterised: command.name });

      const response = await api.command(command.name, {
        input: command.input,
        idempotencyKey: "b1-dispatch-idempotency-key",
        expectedVersion: command.expectedVersion,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        result: { characterised: command.name },
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith({
        name: command.busCommand,
        input: dispatchedInput(command),
        context,
        meta: {
          idempotencyKey: "b1-dispatch-idempotency-key",
          expectedVersion: command.expectedVersion,
        },
      });
      expect(apiV1.registerProject).not.toHaveBeenCalled();
    },
  );

  test.each(busCommands.map((command) => [command.name, command] as const))(
    "%s cannot be steered by a caller naming the injected fields itself",
    async (_name, command) => {
      signInAs(agentContext());
      const execute = vi.spyOn(coreCommandBus, "execute");
      storeReceiptFor(command, { characterised: command.name });
      const hostile = Object.fromEntries(
        Object.keys(command.injected).map((key) => [
          key,
          key === "action" ? "verify_request" : ids.otherOrganization,
        ]),
      );

      await api.command(command.name, {
        input: { ...command.input, ...hostile },
        expectedVersion: command.expectedVersion,
      });

      const [call] = execute.mock.calls[0] as [{ input: object }];
      expect(call.input).toMatchObject(command.injected);
    },
  );

  test("transition_request is the one lifecycle name whose action the caller chooses", async () => {
    signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");

    await api.command("transition_request", {
      input: { requestId: ids.request, action: "verify_request" },
      expectedVersion: 1,
    });

    const [call] = execute.mock.calls[0] as [{ input: { action: string } }];
    expect(call.input.action).toBe("verify_request");
  });

  test("register_project bypasses the bus and reaches the registration repository with the project-bound grant", async () => {
    const context = signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");
    apiV1.registerProject.mockResolvedValue({ projectId: ids.project });

    const response = await api.command("register_project", {
      input: { alias: "b1-characterised", extra: "passed through as sent" },
      idempotencyKey: "b1-register-project-key",
      expectedVersion: 3,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: { projectId: ids.project },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(apiV1.registerProject).toHaveBeenCalledWith(
      { ...context, projectId: ids.project },
      { alias: "b1-characterised", extra: "passed through as sent" },
      { idempotencyKey: "b1-register-project-key", expectedVersion: 3 },
      "b1-characterisation-signing-material-0001",
    );
  });

  test.each(
    [
      ...registryCommandsNotOnRest,
      "Submit_Request",
      "submit_request ",
      "update_personal_appearance",
      "__proto__",
      "constructor",
      "commands",
    ].map((name): [string] => [name]),
  )("%s is not a REST command, and nothing is dispatched", async (name) => {
    signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");

    const response = await api.command(name, { input: {} });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "not_found",
      message: "The requested resource was not found.",
      details: {},
    });
    expect(execute).not.toHaveBeenCalled();
    expect(apiV1.registerProject).not.toHaveBeenCalled();
  });

  test.each([
    ["no path", undefined],
    ["the bare collection", ["commands"]],
    ["a name under another collection", ["command", "submit_request"]],
    ["a name one level too deep", ["commands", "submit_request", "now"]],
    ["an empty name", ["commands", ""]],
    ["a name at the root", ["submit_request"]],
  ] as const)("POST to %s is not found", async (_label, path) => {
    signInAs(agentContext());
    const execute = vi.spyOn(coreCommandBus, "execute");

    const response = await api.postRaw(path, {
      body: JSON.stringify({
        idempotencyKey: "b1-idempotency-key-0001",
        expectedVersion: 0,
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1: the 9 paths", () => {
  test("the table holds 9 distinct paths", () => {
    expect(restQueries).toHaveLength(9);
    expect(new Set(restQueries.map((query) => query.route)).size).toBe(9);
  });

  test.each(
    restQueries
      .filter((query) => query.route !== "whoami")
      .map((query) => [query.route, query] as const),
  )(
    "GET %s answers the repository's result verbatim, uncached",
    async (_route, query) => {
      const context = signInAs(agentContext());
      const answer = { page: [{ from: query.repositoryMethod }], next: null };
      apiV1.agentQueries[query.repositoryMethod].mockResolvedValue(answer);

      const response = await api.get(query.path);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual(answer);
      const [scopedContext] = apiV1.agentQueries[query.repositoryMethod].mock
        .calls[0] as [object];
      expect(scopedContext).toEqual({ ...context, projectId: ids.project });
      for (const [method, fake] of Object.entries(apiV1.agentQueries)) {
        if (method !== query.repositoryMethod)
          expect(fake).not.toHaveBeenCalled();
      }
    },
  );

  test("GET projects/:projectId passes the id through and 404s on no answer", async () => {
    signInAs(agentContext());
    apiV1.agentQueries.getProject.mockResolvedValue(null);

    const response = await api.get(["projects", "not-even-a-uuid"]);

    expect(response.status).toBe(404);
    expect(apiV1.agentQueries.getProject).toHaveBeenCalledWith(
      expect.anything(),
      "not-even-a-uuid",
    );
  });

  test("GET requests/:requestId 404s on no answer", async () => {
    signInAs(agentContext());
    apiV1.agentQueries.getRequest.mockResolvedValue(null);

    expect((await api.get(["requests", ids.request])).status).toBe(404);
  });

  test("GET requests forwards cursor, limit and every state, and nothing else", async () => {
    signInAs(agentContext());
    apiV1.agentQueries.listRequests.mockResolvedValue({ items: [] });

    await api.get(
      ["requests"],
      "?cursor=c1&limit=25&state=submitted&state=triage&ignored=yes",
    );

    expect(apiV1.agentQueries.listRequests).toHaveBeenCalledWith(
      expect.anything(),
      { cursor: "c1", limit: 25, state: ["submitted", "triage"] },
    );
  });

  test("GET requests with no query sends undefined cursor and limit, and no states", async () => {
    signInAs(agentContext());
    apiV1.agentQueries.listRequests.mockResolvedValue({ items: [] });

    await api.get(["requests"]);

    expect(apiV1.agentQueries.listRequests).toHaveBeenCalledWith(
      expect.anything(),
      { cursor: undefined, limit: undefined, state: [] },
    );
  });

  /**
   * Characterised: the route does not validate `limit`, it only converts it.
   * A non-number reaches the repository as `NaN`, and it is the domain's
   * `normalizePageLimit` that refuses it — faked out here.
   */
  test("GET requests hands a non-numeric limit on as NaN", async () => {
    signInAs(agentContext());
    apiV1.agentQueries.listRequests.mockResolvedValue({ items: [] });

    await api.get(["requests"], "?limit=many");

    const [, options] = apiV1.agentQueries.listRequests.mock.calls[0] as [
      unknown,
      { limit: number },
    ];
    expect(options.limit).toBeNaN();
  });

  test.each([
    ["an unknown state", "?state=archived"],
    [
      "21 states",
      `?${Array.from({ length: 21 }, () => "state=draft").join("&")}`,
    ],
  ])(
    "GET requests refuses %s before the repository is read",
    async (_label, query) => {
      signInAs(agentContext());

      const response = await api.get(["requests"], query);

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        error: "validation_failed",
        message: "API command input is invalid",
      });
      expect(apiV1.agentQueries.listRequests).not.toHaveBeenCalled();
    },
  );

  test.each([
    [
      "requests/:requestId/timeline",
      ["requests", ids.request, "timeline"],
      "listTimeline",
    ],
    ["questions", ["questions"], "listOpenQuestions"],
    ["events", ["events"], "listEvents"],
  ] as const)(
    "GET %s forwards the cursor, and only the cursor",
    async (_label, path, method) => {
      signInAs(agentContext());
      apiV1.agentQueries[method].mockResolvedValue({ items: [] });

      await api.get(path, "?cursor=c2&limit=5&state=draft");
      await api.get(path);

      const calls = apiV1.agentQueries[method].mock.calls;
      expect(calls[0]?.slice(1)).toEqual(
        method === "listTimeline" ? [ids.request, "c2"] : ["c2"],
      );
      expect(calls[1]?.slice(1)).toEqual(
        method === "listTimeline" ? [ids.request, undefined] : [undefined],
      );
    },
  );

  test.each([
    ["no path", undefined],
    ["an unknown resource", ["agents"]],
    ["whoami with a trailing segment", ["whoami", "extra"]],
    ["a differently-cased path", ["Whoami"]],
    ["an empty project id", ["projects", ""]],
    ["an empty request id before timeline", ["requests", "", "timeline"]],
    ["another request sub-resource", ["requests", ids.request, "events"]],
    ["the command collection", ["commands", "submit_request"]],
  ] as const)(
    "GET %s is not found, and no repository is read",
    async (_label, path) => {
      signInAs(agentContext());

      const response = await api.get(path);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "not_found",
        message: "The requested resource was not found.",
        details: {},
      });
      for (const fake of Object.values(apiV1.agentQueries)) {
        expect(fake).not.toHaveBeenCalled();
      }
    },
  );
});

describe("GET /api/v1/whoami", () => {
  /**
   * The one response the route composes itself rather than passing through,
   * so this golden needs no database: every field but `workPolicy` comes from
   * the authenticated context.
   */
  test("composes the credential's own view of itself", async () => {
    signInAs(
      agentContext({
        scopes: ["request:read", "org:read", "work:claim"],
        laneIds: new Set(["lane-b", "lane-a"]),
      }),
    );
    apiV1.agentQueries.getAgentPolicy.mockResolvedValue({
      heartbeatIntervalSeconds: 60,
    });

    const response = await api.get(["whoami"]);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      actor: {
        type: "agent",
        id: ids.agent,
        delegatedBy: { type: "user", id: ids.delegatingUser },
      },
      organizationId: ids.organization,
      projectId: ids.project,
      laneIds: ["lane-b", "lane-a"],
      scopes: ["org:read", "request:read", "work:claim"],
      audience: "api",
      authorizationId: ids.authorization,
      serverSchemaVersion: 1,
      workPolicy: { heartbeatIntervalSeconds: 60 },
    });
  });

  test("is refused when the project has no work policy", async () => {
    signInAs(agentContext());
    apiV1.agentQueries.getAgentPolicy.mockResolvedValue(null);

    const response = await api.get(["whoami"]);

    expect(response.status).toBe(403);
  });
});

/**
 * Labelled, not written. A golden for a successful command or query response
 * pins the payload production returns, and every one of those payloads is
 * built by a repository these suites fake: a golden written against the fake
 * would pin the fake. Each needs a database — a seeded organization, project,
 * agent grant and request — and is recorded here so the gap stays visible.
 */
describe("success goldens that need a database", () => {
  for (const command of restCommands) {
    test.todo(
      `POST commands/${command.name}: the result payload (needs a database)`,
    );
  }
  for (const query of restQueries) {
    test.todo(`GET ${query.route}: the response payload (needs a database)`);
  }
});
