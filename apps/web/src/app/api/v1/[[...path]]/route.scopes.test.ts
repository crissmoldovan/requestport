import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  agentContext,
  ids,
  restClient,
  signInAs,
  workingAgentScopes,
} from "../../../../test/api-v1/agent-client.js";
import {
  apiV1,
  resetApiV1Fakes,
} from "../../../../test/api-v1/fake-database.js";
import { allowRequestReads } from "../../../../test/api-v1/request-port.js";
import {
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
const api = restClient(route);

beforeEach(() => {
  resetApiV1Fakes();
});

function without(scope: string) {
  return workingAgentScopes.filter((candidate) => candidate !== scope);
}

async function expectForbidden(response: Response) {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    error: "forbidden",
    message: "The credential is not permitted to perform this operation.",
    details: {},
  });
}

/**
 * The scope-denial matrix for `/api/v1`, Plan 13 track B1.
 *
 * Each row is proved from both sides, because either side alone proves
 * nothing. A 403 without the scope could have come from anything that refuses
 * — and the public body is identical for every `forbidden`, since
 * `publicDomainDetails` drops the `scope` detail. So the same call is repeated
 * holding *only* that scope, and must then get past authorization: for a
 * command, to the first port write, which the fake refuses as unconfigured
 * (a 500); for a query, to the repository. The difference between the two
 * runs is exactly one scope, so the 403 is that scope's.
 */
describe("the scope-denial matrix for GET /api/v1", () => {
  const scoped = restQueries.filter((query) => query.requiredScope !== null);

  test.each(
    scoped.map((query) => [query.route, query.requiredScope, query] as const),
  )(
    "GET %s is refused without %s, before the repository is read",
    async (_route, scope, query) => {
      signInAs(agentContext({ scopes: without(scope as string) }));

      await expectForbidden(await api.get(query.path));
      expect(apiV1.agentQueries[query.repositoryMethod]).not.toHaveBeenCalled();
    },
  );

  test.each(
    scoped.map((query) => [query.route, query.requiredScope, query] as const),
  )("GET %s is answered holding only %s", async (_route, scope, query) => {
    signInAs(agentContext({ scopes: [scope as string] }));
    apiV1.agentQueries[query.repositoryMethod].mockResolvedValue({
      answered: query.route,
    });

    const response = await api.get(query.path);

    expect(response.status).toBe(200);
    expect(apiV1.agentQueries[query.repositoryMethod]).toHaveBeenCalledOnce();
  });

  test("GET whoami demands no scope at all", async () => {
    signInAs(agentContext({ scopes: [] }));
    apiV1.agentQueries.getAgentPolicy.mockResolvedValue({ policy: "fake" });

    expect((await api.get(["whoami"])).status).toBe(200);
  });

  /**
   * Refused before the path is even looked at: `withProject` runs ahead of
   * the if-chain, so an unknown path answers 403 here rather than 404.
   */
  test.each([
    ...restQueries.map((query) => [query.route, query.path] as const),
    ["an unknown path", ["no-such-resource"]] as const,
  ])("a grant with no project is refused at GET %s", async (_route, path) => {
    signInAs(agentContext({ projectId: null, scopes: ["project:provision"] }));

    await expectForbidden(await api.get(path));
    for (const query of Object.values(apiV1.agentQueries)) {
      expect(query).not.toHaveBeenCalled();
    }
  });
});

describe("the scope-denial matrix for POST /api/v1/commands", () => {
  const busCommands = restCommands.filter(
    (command) => command.scopeEnforcement !== "database",
  );

  test("every command demands a scope an agent grant can actually hold", () => {
    for (const command of restCommands) {
      expect(workingAgentScopes).toContain(command.requiredScope);
    }
  });

  test.each(
    busCommands.map(
      (command) => [command.name, command.requiredScope, command] as const,
    ),
  )(
    "%s is refused without %s, and writes nothing",
    async (_name, scope, command) => {
      signInAs(agentContext({ scopes: without(scope) }));
      allowRequestReads(command);

      const response = await api.command(command.name, {
        input: command.input,
        expectedVersion: command.expectedVersion,
      });

      await expectForbidden(response);
      expect(apiV1.unconfiguredPortCalls).toEqual([]);
      expect(apiV1.receipts.save).not.toHaveBeenCalled();
      expect(apiV1.appendedEvents).toEqual([]);
    },
  );

  test.each(
    busCommands.map(
      (command) => [command.name, command.requiredScope, command] as const,
    ),
  )(
    "%s gets past authorization holding only %s",
    async (_name, scope, command) => {
      signInAs(agentContext({ scopes: [scope] }));
      allowRequestReads(command);

      const response = await api.command(command.name, {
        input: command.input,
        expectedVersion: command.expectedVersion,
      });

      // Past every check the scope decides, into the first port the fake has no
      // answer for. That refusal is the fake's, not the route's.
      expect(apiV1.unconfiguredPortCalls).toHaveLength(1);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "unexpected_error",
        message: "The RequestPort operation failed.",
      });
    },
  );

  /**
   * `register_project` never reaches the bus. Its scope is checked inside
   * `projectRegistrationRepository.register`, which these suites replace, so
   * all B1 can show is that the route hands the repository the credential's
   * scopes untouched. Whether a missing `agent:register` is refused there
   * needs a database.
   */
  test("register_project hands the repository the grant's scopes untouched (the refusal itself needs a database)", async () => {
    const context = signInAs(
      agentContext({ scopes: without("agent:register") }),
    );
    apiV1.registerProject.mockResolvedValue({ registered: false });

    await api.command("register_project", {
      input: { alias: "b1-characterised" },
    });

    expect(apiV1.registerProject).toHaveBeenCalledOnce();
    const [scopedContext] = apiV1.registerProject.mock.calls[0] as [
      { scopes: ReadonlySet<string> },
    ];
    expect([...scopedContext.scopes].sort()).toEqual(
      [...context.scopes].sort(),
    );
  });

  test.each(restCommands.map((command) => [command.name, command] as const))(
    "a provisioning grant, which names no project, is refused %s",
    async (_name, command) => {
      signInAs(
        agentContext({ projectId: null, scopes: ["project:provision"] }),
      );
      allowRequestReads(command);

      await expectForbidden(
        await api.command(command.name, {
          input: command.input,
          expectedVersion: command.expectedVersion,
        }),
      );
      expect(apiV1.registerProject).not.toHaveBeenCalled();
      expect(apiV1.unconfiguredPortCalls).toEqual([]);
    },
  );

  /**
   * The route writes `sourceProjectId` from the credential's project. A grant
   * with no project has none to write, and used to be told — as a 422 naming
   * `sourceProjectId` — that a field it never sent was invalid, even while
   * holding `request:create`. It is refused as the credential it is instead,
   * the same 403 every other project-scoped route gives, before dispatch.
   */
  test("create_request_draft from a grant with no project is refused 403 before dispatch, even holding request:create", async () => {
    const command = restCommands.find(
      (candidate) => candidate.name === "create_request_draft",
    );
    if (!command) throw new Error("create_request_draft is missing");
    signInAs(agentContext({ projectId: null, scopes: ["request:create"] }));

    await expectForbidden(
      await api.command(command.name, {
        input: command.input,
        expectedVersion: command.expectedVersion,
      }),
    );
    expect(apiV1.transactionsRun).toBe(0);
    expect(apiV1.receipts.lock).not.toHaveBeenCalled();
  });
});

/**
 * B1 characterised this as "not endorsed" (its finding 1), and F.1 step 3
 * changed it deliberately. `AtomicCommandBus` re-runs the definition's
 * `authorize` before it answers from a stored receipt, and says idempotency
 * "never bypasses current authorization". The lifecycle names — the rows the
 * table marks `scopeEnforcement: "by-action"`, each run as
 * `transition_request` — used to check their scope only in `execute`, so a
 * replay was answered without it: an agent whose grant had since lost
 * `request:triage` still got its stored `accept_request` result back.
 * `transition_request`'s `authorize` now checks the action's scope too, so the
 * replay is refused like a first run.
 *
 * The rows are read from the table rather than counted here, so a lifecycle
 * name added to it is replayed too.
 */
describe("a replayed lifecycle command", () => {
  const lifecycleCommands = restCommands.filter(
    (command) => command.scopeEnforcement === "by-action",
  );

  test("is every row the table marks by-action, each run as transition_request", () => {
    expect(lifecycleCommands.map((command) => command.name)).toContain(
      "accept_request",
    );
    for (const command of lifecycleCommands) {
      expect(command.busCommand).toBe("transition_request");
    }
  });

  /** A receipt the bus would answer, for this row's input. */
  async function storeReceipt(command: (typeof lifecycleCommands)[number]) {
    const { createCoreCommandRegistry, normalizedInputHash } = await import(
      "@requestport/domain"
    );
    const definition =
      createCoreCommandRegistry().resolve("transition_request");
    apiV1.receipts.find.mockResolvedValue({
      normalizedInputHash: normalizedInputHash(
        definition?.parse({ ...command.input, ...command.injected }),
      ),
      result: { replayed: command.name },
    });
  }

  // Was "%s is answered from its receipt without %s", expecting 200 and the
  // stored result. Changed by F.1 step 3: refused, as a first run is.
  test.each(
    lifecycleCommands.map(
      (command) => [command.name, command.requiredScope, command] as const,
    ),
  )(
    "%s is refused without %s, though its receipt matches",
    async (_name, scope, command) => {
      await storeReceipt(command);
      signInAs(agentContext({ scopes: without(scope) }));

      const response = await api.command(command.name, {
        input: command.input,
        expectedVersion: command.expectedVersion,
      });

      await expectForbidden(response);
      expect(apiV1.receipts.save).not.toHaveBeenCalled();
      expect(apiV1.unconfiguredPortCalls).toEqual([]);
      expect(ids.organization).toBe(command.injected.organizationId);
    },
  );

  // Added by F.1 step 3, the other side of the row above: the receipt is
  // answered once the scope is held, so the 403 above is the scope's.
  test.each(
    lifecycleCommands.map(
      (command) => [command.name, command.requiredScope, command] as const,
    ),
  )(
    "%s is answered from its receipt holding only %s",
    async (_name, scope, command) => {
      await storeReceipt(command);
      signInAs(agentContext({ scopes: [scope] }));

      const response = await api.command(command.name, {
        input: command.input,
        expectedVersion: command.expectedVersion,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        result: { replayed: command.name },
      });
    },
  );
});
