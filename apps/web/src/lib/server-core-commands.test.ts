import {
  agentScopes,
  capabilityRegistry,
  operatorManageScope,
  operatorOnlyScopes,
} from "@requestport/domain";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";

/**
 * `server-core-commands.ts` (Plan 13, F.1 step 3), the web's adapter over the
 * bus its RequestPort composes since G.6. The port table it exports, core's,
 * and `humanScopes` are R4 append points (ruling 8): F.2's groups and F.3 each
 * add one line. These hold what an append must keep true — every port name opens
 * its own repository and no other name opens anything, and a signed-in person
 * holds every scope the capability registry requires but the operator-only
 * ones (Plan 13, F.3, F3-4).
 *
 * Neither list is restated here. The port cases iterate the exported
 * `commandPorts`, and the `@requestport/db` mock wraps every
 * `create…Repository` export of the real package, so a port line that brings
 * in a new factory needs no edit in this file. A port append can owe this file
 * two things: a naming exception, since each port is expected to open the
 * factory its name spells (`requests` opens `createRequestRepository`), which
 * is what catches two names wired to each other's repositories; and a
 * `portArguments` line, when it hands its factory more than the transaction. The eight
 * ports F.1 found are kept as a floor, so removing one needs an edit here and
 * appending one does not.
 */

const mocks = vi.hoisted(() => ({
  factories: new Map<string, Mock>(),
  serverEnv: {
    BETTER_AUTH_SECRET: "server-core-commands-test-signing-material",
    REQUESTPORT_WORKSPACE_KEK_VERSION: "v1",
    REQUESTPORT_OPERATOR_CREDENTIALS: undefined as string | undefined,
  },
  portFactory: undefined as
    | ((name: string, database: unknown) => unknown)
    | undefined,
}));

vi.mock("@requestport/db", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const wrapped = Object.fromEntries(
    Object.keys(original)
      .filter(
        (name) =>
          /^create\w+Repository$/.test(name) &&
          typeof original[name] === "function",
      )
      .map((name) => {
        const factory = vi.fn((database: unknown) => ({
          openedBy: name,
          database,
        }));
        mocks.factories.set(name, factory);
        return [name, factory];
      }),
  );
  return {
    ...original,
    ...wrapped,
    createCommandTransactionManager: (
      _database: unknown,
      portFactory: (name: string, database: unknown) => unknown,
    ) => {
      mocks.portFactory = portFactory;
      return { run: vi.fn() };
    },
  };
});
vi.mock("@requestport/config/server", () => ({
  serverEnv: mocks.serverEnv,
}));
vi.mock("./observability.js", () => ({
  webMetrics: { count: vi.fn(), gauge: vi.fn(), observe: vi.fn() },
}));
vi.mock("./trigger-client.js", () => ({ dispatchCommittedEvents: vi.fn() }));

const { commandPorts, coreCommandBus, humanCommandContext, humanScopes } =
  await import("./server-core-commands.js");
const { dispatchCommittedEvents } = await import("./trigger-client.js");

function portFactory() {
  if (!mocks.portFactory) throw new Error("no port factory was handed over");
  return mocks.portFactory;
}

/** `requests` → `createRequestRepository`, `work` → `createWorkRepository`. */
function spelledFactory(port: string) {
  const singular = port.endsWith("s") ? port.slice(0, -1) : port;
  return `create${singular[0]?.toUpperCase()}${singular.slice(1)}Repository`;
}

/**
 * What a port hands its factory after the transaction, where it hands more.
 * `commandAuthorization` carries F3-14's switch (Plan 13, F.3), read from
 * `serverEnv` when the port opens.
 */
const portArguments: Readonly<Record<string, () => readonly unknown[]>> = {
  commandAuthorization: () => [
    {
      operatorCredentials: mocks.serverEnv.REQUESTPORT_OPERATOR_CREDENTIALS,
    },
  ],
};

beforeEach(() => {
  for (const factory of mocks.factories.values()) factory.mockClear();
  mocks.serverEnv.REQUESTPORT_OPERATOR_CREDENTIALS = undefined;
});

describe("after a commit", () => {
  test("the bus hands every committed event, with its organisation, to the dispatch that binds each (D5)", async () => {
    const afterCommit = (
      coreCommandBus as unknown as {
        dependencies: {
          afterCommit?: (events: readonly unknown[]) => Promise<void>;
        };
      }
    ).dependencies.afterCommit;
    const events = [
      { id: "event-1", organizationId: "org-a" },
      { id: "event-2", organizationId: "org-a" },
    ];

    expect(afterCommit).toBeTypeOf("function");
    await afterCommit?.(events);
    expect(dispatchCommittedEvents).toHaveBeenCalledOnce();
    expect(dispatchCommittedEvents).toHaveBeenCalledWith(events);
  });
});

describe("the command port factory", () => {
  test("wraps the real package's repository factories, and the table has ports", () => {
    expect(mocks.factories.size).toBeGreaterThan(0);
    expect(commandPorts.size).toBeGreaterThan(0);
  });

  test.each([...commandPorts.keys()])(
    "opens %s with the repository its name spells, on the database it is handed",
    (name) => {
      const transaction = { transaction: name };
      const create = spelledFactory(name);

      expect(portFactory()(name, transaction)).toEqual({
        openedBy: create,
        database: transaction,
      });
      expect(mocks.factories.get(create)).toHaveBeenCalledOnce();
      expect(mocks.factories.get(create)).toHaveBeenCalledWith(
        transaction,
        ...(portArguments[name]?.() ?? []),
      );
    },
  );

  test.each([undefined, "enabled", "disabled"])(
    "hands commandAuthorization the operator switch as it reads, %j",
    (value) => {
      mocks.serverEnv.REQUESTPORT_OPERATOR_CREDENTIALS = value;
      const transaction = { transaction: "commandAuthorization" };

      portFactory()("commandAuthorization", transaction);

      expect(
        mocks.factories.get("createCommandAuthorizationRepository"),
      ).toHaveBeenCalledWith(transaction, { operatorCredentials: value });
    },
  );

  test("still has every port it had when F.1 made it a table", () => {
    // A floor, not the list: an append passes it untouched, and only removing
    // one of these ports needs an edit here.
    for (const name of [
      "agents",
      "appearance",
      "commandAuthorization",
      "requests",
      "routing",
      "workspaces",
      "work",
      "collaboration",
    ])
      expect([...commandPorts.keys()], name).toContain(name);
  });

  test("opens a different repository for every port", () => {
    const opened = [...commandPorts.keys()].map(
      (name) => (portFactory()(name, {}) as { openedBy: string }).openedBy,
    );
    expect(new Set(opened).size).toBe(commandPorts.size);
  });

  test.each(
    [
      "",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "Agents",
      " agents",
      "outbox",
    ].filter((name) => !commandPorts.has(name)),
  )("opens nothing for %j", (name) => {
    expect(portFactory()(name, {})).toBeUndefined();
    for (const factory of mocks.factories.values())
      expect(factory).not.toHaveBeenCalled();
  });
});

describe("humanScopes", () => {
  test("holds every scope a capability in the registry requires", () => {
    const required = capabilityRegistry.flatMap((capability) =>
      capability.kind === "query"
        ? capability.scope === null
          ? []
          : [capability.scope]
        : capability.scope.kind === "fixed"
          ? [capability.scope.scope]
          : Object.values(capability.scope.scopes),
    );
    // Except the scopes only an operator credential carries (F3-4): a
    // person revokes with `operator:manage`, never `operator:revoke`.
    const personal = required.filter(
      (scope) => !operatorOnlyScopes.includes(scope),
    );
    expect(personal.length).toBeGreaterThan(0);
    for (const scope of new Set(personal))
      expect([...humanScopes], scope).toContain(scope);
  });

  test("holds operator:manage and none of the operator-only scopes (F3-4)", () => {
    expect(operatorOnlyScopes.length).toBeGreaterThan(0);
    expect([...humanScopes]).toContain(operatorManageScope);
    for (const scope of operatorOnlyScopes)
      expect([...humanScopes], scope).not.toContain(scope);
  });

  test("holds F.2's three new scopes, and no agent scope list names them", () => {
    // Plan 13, F.2.0's scope commit. The groups' commands will require these
    // of a person; an agent key's and an OAuth grant's scopes must be agent
    // scopes, so leaving them out of `agentScopes` is what keeps them out of
    // agent issuance (manifest-f2 §2.2).
    for (const scope of [
      "operations:manage",
      "slack:manage",
      "members:manage",
    ]) {
      expect([...humanScopes], scope).toContain(scope);
      expect([...agentScopes] as string[], scope).not.toContain(scope);
      expect(operatorOnlyScopes as readonly string[], scope).not.toContain(
        scope,
      );
    }
  });

  test("is what a signed-in person's command context carries", () => {
    const context = humanCommandContext(
      {
        user: { id: "server-core-commands-user" },
        session: { id: "server-core-commands-session" },
      } as Parameters<typeof humanCommandContext>[0],
      "018f0000-0000-7000-8000-0000000f1c01",
    );

    expect(context.scopes).toBe(humanScopes);
    expect(context.actor).toEqual({
      type: "user",
      id: "server-core-commands-user",
    });
  });
});
