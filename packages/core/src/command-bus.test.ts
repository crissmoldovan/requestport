import { readFileSync } from "node:fs";

import {
  agentScopes,
  capabilityRegistry,
  operatorManageScope,
  operatorOnlyScopes,
} from "@requestport/domain";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { parseAst } from "vitest/node";

/*
 * The tenant command bus as core composes it (manifest-g.md §2.5's
 * `command-bus` row). Its port table and `humanScopes` are R4 append points
 * (ruling 8). These cases hold what an append must keep true, as
 * `apps/web/src/lib/server-core-commands.test.ts` holds them of the same
 * table, which the web's adapter exports for it: every port name opens its
 * own repository and no other name opens anything, and a signed-in person
 * holds every scope the capability registry requires but the operator-only
 * ones.
 */

const mocks = vi.hoisted(() => ({
  factories: new Map<string, Mock>(),
  managers: [] as Array<{
    database: unknown;
    portFactory: (name: string, database: unknown) => unknown;
  }>,
  registries: [] as unknown[],
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
      database: unknown,
      portFactory: (name: string, database: unknown) => unknown,
    ) => {
      mocks.managers.push({ database, portFactory });
      return { run: vi.fn() };
    },
  };
});
vi.mock("@requestport/domain", async (importOriginal) => {
  const original = await importOriginal<typeof import("@requestport/domain")>();
  return {
    ...original,
    createCoreCommandRegistry: (
      options: Parameters<typeof original.createCoreCommandRegistry>[0],
    ) => {
      mocks.registries.push(options);
      return original.createCoreCommandRegistry(options);
    },
  };
});

const {
  commandTransactions,
  createCommandPorts,
  createCoreCommandBus,
  humanScopes,
  personCommandContext,
} = await import("./command-bus.js");

/** `requests` → `createRequestRepository`, `work` → `createWorkRepository`. */
function spelledFactory(port: string) {
  const singular = port.endsWith("s") ? port.slice(0, -1) : port;
  return `create${singular[0]?.toUpperCase()}${singular.slice(1)}Repository`;
}

const secrets: { operatorCredentials?: "enabled" | "disabled" } = {};
const ports = createCommandPorts(secrets);

/** Opens the port `name` of core's table on a stand-in transaction. */
const open = (name: string, database: unknown) =>
  ports.get(name)?.(database as never);

beforeEach(() => {
  for (const factory of mocks.factories.values()) factory.mockClear();
  mocks.managers.length = 0;
  mocks.registries.length = 0;
  secrets.operatorCredentials = undefined;
});

describe("the command ports", () => {
  test("wrap the real package's repository factories, and the table has ports", () => {
    expect(mocks.factories.size).toBeGreaterThan(0);
    expect(ports.size).toBeGreaterThan(0);
  });

  test.each([...ports.keys()])(
    "open %s with the repository its name spells, on the database they are handed",
    (name) => {
      const transaction = { transaction: name };
      const create = spelledFactory(name);

      expect(open(name, transaction)).toMatchObject({
        openedBy: create,
        database: transaction,
      });
      expect(mocks.factories.get(create)).toHaveBeenCalledOnce();
      expect(mocks.factories.get(create)).toHaveBeenCalledWith(
        transaction,
        ...(name === "commandAuthorization"
          ? [{ operatorCredentials: undefined }]
          : []),
      );
    },
  );

  test.each([undefined, "enabled", "disabled"] as const)(
    "hand commandAuthorization the operator switch as the secrets hold it when it opens, %j",
    (value) => {
      // Set after the table was built: the switch is read as the port opens.
      secrets.operatorCredentials = value;
      const transaction = { transaction: "commandAuthorization" };

      open("commandAuthorization", transaction);

      expect(
        mocks.factories.get("createCommandAuthorizationRepository"),
      ).toHaveBeenCalledWith(transaction, { operatorCredentials: value });
    },
  );

  test("open a different repository for every port", () => {
    const opened = [...ports.keys()].map(
      (name) => (open(name, {}) as { openedBy: string }).openedBy,
    );
    expect(new Set(opened).size).toBe(ports.size);
  });

  test("hold every port F.1 found, as a floor", () => {
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
      expect([...ports.keys()], name).toContain(name);
  });

  test("are the only table: apps/web writes no port line of its own, and its bus is the one its RequestPort composes", () => {
    // Plan 13, G.6, ruling 137 (ruling 64: not duplicated). The web's bus is
    // its RequestPort's (`apps/web/src/lib/server-web-request-port.ts`), composed
    // over this table; `server-core-commands.ts` answers the web's modules
    // from that bus, and builds no transaction manager or repository.
    const source = (path: string) =>
      readFileSync(new URL(path, import.meta.url), "utf8");
    const web = source("../../../apps/web/src/lib/server-core-commands.ts");

    expect(portLines(source("./command-bus.ts"))).toHaveLength(ports.size);
    expect(() => portLines(web)).toThrow("no port table in the module");
    expect(web).not.toMatch(
      /\bcreateCommandTransactionManager\b|\bcreate\w+Repository\b/u,
    );
    expect(web).toContain("webRequestPort().commandBus");
  });
});

describe("the bus's transaction manager", () => {
  test("runs on the database it is given, opening the ports of the table it is given", () => {
    const database = { database: "given" };

    commandTransactions(database as never, ports);

    expect(mocks.managers).toHaveLength(1);
    expect(mocks.managers[0]?.database).toBe(database);
    expect(mocks.managers[0]?.portFactory("routing", { tx: 1 })).toMatchObject({
      openedBy: "createRoutingRepository",
      database: { tx: 1 },
    });
    expect(mocks.managers[0]?.portFactory("outbox", { tx: 1 })).toBeUndefined();
  });
});

describe("the core command bus", () => {
  const transactions = { run: vi.fn() };

  test("is composed over the core registry with the workspace encryption given, the transactions, the fingerprint key, the metrics and the after-commit hook", () => {
    const workspaceEncryption = { encrypt: vi.fn() };
    const metrics = { count: vi.fn(), gauge: vi.fn(), observe: vi.fn() };
    const afterCommit = vi.fn(async () => undefined);

    const bus = createCoreCommandBus({
      transactions,
      fingerprintSecret: "derived-fingerprint-key",
      workspaceEncryption: workspaceEncryption as never,
      metrics,
      afterCommit,
    });
    const dependencies = (
      bus as unknown as { dependencies: Record<string, unknown> }
    ).dependencies;

    expect(mocks.registries).toEqual([{ workspaceEncryption }]);
    expect(dependencies).toMatchObject({
      transactions,
      fingerprintSecret: "derived-fingerprint-key",
      metrics,
      afterCommit,
    });
  });

  test("re-checks each context on the command's own transaction, through the commandAuthorization port", async () => {
    const bus = createCoreCommandBus({
      transactions,
      fingerprintSecret: "derived-fingerprint-key",
    });
    const authorizeContext = (
      bus as unknown as {
        dependencies: {
          authorizeContext: (context: unknown, uow: unknown) => Promise<void>;
        };
      }
    ).dependencies.authorizeContext;
    const assertCurrent = vi.fn(async () => undefined);
    const port = vi.fn(() => ({ assertCurrent }));
    const context = { actor: { type: "user", id: "user-1" } };

    await authorizeContext(context, { port });

    expect(port).toHaveBeenCalledWith("commandAuthorization");
    expect(assertCurrent).toHaveBeenCalledWith(context);
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
    expect([...humanScopes]).toContain(operatorManageScope);
    for (const scope of operatorOnlyScopes)
      expect([...humanScopes], scope).not.toContain(scope);
  });

  test("holds F.2's three scopes, and no agent scope list names them", () => {
    for (const scope of [
      "operations:manage",
      "slack:manage",
      "members:manage",
    ]) {
      expect([...humanScopes], scope).toContain(scope);
      expect([...agentScopes] as string[], scope).not.toContain(scope);
    }
  });
});

describe("a person's command context", () => {
  test("is a user actor with the human scopes, whose credential is the session", () => {
    const context = personCommandContext(
      { id: "session-1", userId: "user-1" },
      "018f0000-0000-7000-8000-0000000c0001",
    );

    expect(context).toEqual({
      actor: { type: "user", id: "user-1" },
      organizationId: "018f0000-0000-7000-8000-0000000c0001",
      scopes: humanScopes,
      credentialId: "session-1",
      correlationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    });
    expect(context.scopes).toBe(humanScopes);
    expect(
      personCommandContext({ id: "session-1", userId: "user-1" }, "org")
        .correlationId,
    ).not.toBe(context.correlationId);
  });
});

/*
 * The port lines of the first `new Map([...])` in a module whose every
 * element is a pair: each pair's key as written, and the repository factory
 * its value is or calls.
 */
type AstNode = { type: string; start: number; end: number } & Record<
  string,
  unknown
>;

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function nodes(root: AstNode): AstNode[] {
  const all: AstNode[] = [];
  const visit = (node: AstNode) => {
    all.push(node);
    for (const value of Object.values(node))
      for (const child of Array.isArray(value) ? value : [value])
        if (isNode(child)) visit(child);
  };
  visit(root);
  return all;
}

function portLines(text: string): string[] {
  const all = nodes(parseAst(text, { lang: "ts" }) as unknown as AstNode);
  const table = all.find((node) => {
    if (node.type !== "NewExpression") return false;
    const callee = node.callee as AstNode;
    const [entries] = node.arguments as AstNode[];
    return (
      callee.type === "Identifier" &&
      callee.name === "Map" &&
      entries?.type === "ArrayExpression" &&
      (entries.elements as AstNode[]).length > 0 &&
      (entries.elements as AstNode[]).every(
        (element) =>
          element?.type === "ArrayExpression" &&
          (element.elements as unknown[]).length === 2,
      )
    );
  });
  if (!table) throw new Error("no port table in the module");
  const [entries] = table.arguments as AstNode[];
  return ((entries as AstNode).elements as AstNode[]).map((entry) => {
    const [key, value] = entry.elements as AstNode[];
    const factory =
      (value as AstNode).type === "Identifier"
        ? ((value as AstNode).name as string)
        : nodes(value as AstNode)
            .filter(
              (node) =>
                node.type === "CallExpression" &&
                (node.callee as AstNode).type === "Identifier" &&
                /^create\w+Repository$/u.test(
                  (node.callee as AstNode).name as string,
                ),
            )
            .map((node) => (node.callee as AstNode).name as string)[0];
    return `${text.slice((key as AstNode).start, (key as AstNode).end)} → ${factory}`;
  });
}
