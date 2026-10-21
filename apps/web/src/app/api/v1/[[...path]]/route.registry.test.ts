import type {
  QueryCapability,
  RestCommandTransport,
  RestInjectedField,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

/**
 * The POST handler is driven by the capability registry (Plan 13, F.1): the
 * commands it accepts, the fields it writes into `input`, where it refuses a
 * credential bound to no project, and where it dispatches are each read from
 * the registry's entry, not restated in the route.
 *
 * Shown here by giving the route a registry that differs from the real one —
 * probe entries added, `claim_request` taken away — and watching the route
 * follow it. B1's suites hold the real registry's answers; this holds the
 * route to whatever the registry says. The bus, the registration repository,
 * authentication and the limiter are replaced; nothing here opens a database.
 */

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  execute: vi.fn(),
  register: vi.fn(),
  transports: [] as RestCommandTransport[],
  queryCapabilities: [] as QueryCapability[],
  agentQueries: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("@requestport/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@requestport/domain")>();
  return {
    ...actual,
    findRestCommandTransport: (name: string) =>
      mocks.transports.find((transport) => transport.name === name),
    findQueryCapability: (name: string) =>
      mocks.queryCapabilities.find((query) => query.name === name),
  };
});
vi.mock("@requestport/auth/server", () => ({
  authenticateAgentBearer: mocks.authenticate,
  authenticateApiBearer: (request: Request) =>
    mocks.authenticate(request, "api"),
}));
vi.mock("@requestport/config/server", () => ({
  serverEnv: {
    BETTER_AUTH_URL: "https://requestport.example.invalid",
    BETTER_AUTH_SECRET: "route-registry-test-signing-material",
  },
}));
vi.mock("@requestport/db", () => ({
  createAgentQueryRepository: () => mocks.agentQueries,
  createProjectRegistrationRepository: () => ({ register: mocks.register }),
}));
// The route runs every command and every query through the web's
// RequestPort (Plan 13, G.6; ruling 137). Here that RequestPort is core's own
// execution and query functions over the fakes above: the bus's `execute`,
// and the registration repository and the agent queries, each built over a
// stand-in for the root's storage's handle, which the factories ignore.
vi.mock("../../../../lib/server-web-request-port.js", async () => {
  const {
    createAgentQueries,
    createCommandExecution,
    createProjectRegistration,
    createQueryExecution,
  } = await import("@requestport/core/adapters");
  const database = await import("@requestport/db");
  const { serverEnv } = await import("@requestport/config/server");
  const handle = {} as never;
  const unreached = (target: string) => () => {
    throw new Error(`${target} is not reached in this suite`);
  };
  const registration = createProjectRegistration({
    repository: () => database.createProjectRegistrationRepository(handle),
    secrets: {
      get commandFingerprintKey() {
        return serverEnv.BETTER_AUTH_SECRET;
      },
    },
  });
  const port = {
    execute: createCommandExecution({
      commandBus: async (command) => mocks.execute(command),
      projectRegistration: (context, input, meta) =>
        registration.register(context, input, meta),
      agentAdministration: unreached("agent administration"),
      importSplit: unreached("the import split"),
      slackConnectionTest: unreached("the Slack connection test"),
    }),
    query: createQueryExecution({
      agentQueries: createAgentQueries(() =>
        database.createAgentQueryRepository(handle),
      ),
      administrationReading: { database: handle, secrets: {} },
    }),
  };
  return { webRequestPort: () => port };
});
vi.mock("../../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "route-registry-test",
}));

const { capabilityRegistry, restCommandTransports } = await import(
  "@requestport/domain"
);
const route = await import("./route.js");

const organizationId = "018f0000-0000-7000-8000-0000000f1a01";
const projectId = "018f0000-0000-7000-8000-0000000f1a02";

function agent(project: string | null) {
  return {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000f1a03" },
    organizationId,
    projectId: project,
    laneIds: new Set(),
    scopes: new Set(["request:write"]),
    credentialId: "f1-registry-credential",
    correlationId: "018f0000-0000-7000-8000-0000000f1a04",
    audience: "api",
    authorizationId: "f1-registry-authorization",
  };
}

function probe(
  name: string,
  overrides: Partial<RestCommandTransport> = {},
): RestCommandTransport {
  return {
    name,
    method: "POST",
    path: `/api/v1/commands/${name}`,
    dispatch: { to: "command-bus", commandName: "post_message" },
    inputSchema: z.object({}),
    injectedFields: [],
    scope: { kind: "fixed", scope: "request:write", checkedBy: "command" },
    routeRequiresProject: false,
    rateLimitClass: "mutation",
    mcpTool: null,
    ...overrides,
  };
}

const injectsEveryKind: RestInjectedField[] = [
  { field: "organizationId", from: "credential.organizationId" },
  { field: "marker", from: "constant", value: "from-the-registry" },
  { field: "sourceProjectId", from: "credential.projectId" },
];

function post(name: string, body: unknown = envelope()) {
  return route.POST(
    new Request(`https://requestport.example.invalid/api/v1/commands/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: ["commands", name] }) },
  );
}

function envelope(input: Record<string, unknown> = { bodyMd: "Hello" }) {
  return {
    input,
    idempotencyKey: "f1-registry-idempotency-key",
    expectedVersion: 3,
  };
}

beforeEach(() => {
  mocks.authenticate.mockReset().mockResolvedValue(agent(projectId));
  mocks.execute.mockReset().mockResolvedValue({ executed: true });
  mocks.register.mockReset().mockResolvedValue({ registered: true });
  mocks.transports = [
    ...restCommandTransports.filter(
      (transport) => transport.name !== "claim_request",
    ),
    probe("f1_probe", {
      dispatch: { to: "command-bus", commandName: "update_request" },
      injectedFields: injectsEveryKind,
      routeRequiresProject: true,
    }),
    probe("f1_needs_project", { routeRequiresProject: true }),
    probe("f1_register", {
      dispatch: { to: "project-registration-repository" },
      routeRequiresProject: true,
    }),
  ];
});

describe("the POST handler follows the capability registry", () => {
  test("accepts a command the registry adds, and dispatches it to the entry's bus command with the entry's injected fields", async () => {
    const response = await post(
      "f1_probe",
      envelope({
        bodyMd: "Hello",
        organizationId: "018f0000-0000-7000-8000-0000000f1aff",
        marker: "from-the-caller",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { executed: true } });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.calls[0]?.[0]).toEqual({
      name: "update_request",
      input: {
        bodyMd: "Hello",
        organizationId,
        marker: "from-the-registry",
        sourceProjectId: projectId,
      },
      context: agent(projectId),
      meta: {
        idempotencyKey: "f1-registry-idempotency-key",
        expectedVersion: 3,
      },
    });
  });

  test("answers 404 for a command the registry does not hold, and dispatches nothing", async () => {
    const response = await post("claim_request");

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("not_found");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  test("refuses a credential bound to no project where the entry requires one, before dispatch", async () => {
    mocks.authenticate.mockResolvedValue(agent(null));

    for (const name of ["f1_needs_project", "f1_probe", "f1_register"]) {
      const response = await post(name);
      expect(response.status, name).toBe(403);
      expect((await response.json()).error, name).toBe("forbidden");
    }
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  test("lets a credential bound to no project through where the entry does not require one", async () => {
    mocks.authenticate.mockResolvedValue(agent(null));
    mocks.transports.push(probe("f1_projectless"));

    const response = await post("f1_projectless");

    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.calls[0]?.[0]).toMatchObject({
      name: "post_message",
      input: { bodyMd: "Hello" },
    });
  });

  test("hands an entry dispatched to the project registration repository the caller's input unchanged, off the bus", async () => {
    const response = await post("f1_register", envelope({ alias: "probe" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { registered: true } });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.register).toHaveBeenCalledWith(
      { ...agent(projectId), projectId },
      { alias: "probe" },
      { idempotencyKey: "f1-registry-idempotency-key", expectedVersion: 3 },
      "route-registry-test-signing-material",
    );
  });
});

/**
 * The GET handler checks the scope the registry gives each query (F.1 step
 * 3), rather than naming it. Shown by giving every query a probe scope of its
 * own, `f1:<name>`, that no real grant holds: each path must then refuse a
 * credential holding every real scope and admit one holding only its probe.
 * That also proves each path asks for its own entry, not a neighbour's.
 */
describe("the GET handler takes each query's scope from the registry", () => {
  // The agent queries: the administration reads (Plan 13, F.2.0) are the
  // administration branch's, run in `route.administration.test.ts` and
  // `lib/server-administration-reads.test.ts`.
  const realQueries = capabilityRegistry.filter(
    (capability): capability is QueryCapability =>
      capability.kind === "query" &&
      capability.dispatch.to === "agent-query-repository",
  );
  const everyRealScope = [
    ...new Set(
      capabilityRegistry.flatMap((capability) =>
        capability.kind === "query"
          ? capability.scope === null
            ? []
            : [capability.scope]
          : capability.scope.kind === "fixed"
            ? [capability.scope.scope]
            : Object.values(capability.scope.scopes),
      ),
    ),
  ];
  const pathValues: Record<string, string> = {
    projectId: "018f0000-0000-7000-8000-0000000f1a05",
    requestId: "018f0000-0000-7000-8000-0000000f1a06",
  };

  function get(query: QueryCapability) {
    const parts = query.rest.path
      .slice("/api/v1/".length)
      .split("/")
      .map((segment) =>
        segment.startsWith("{")
          ? (pathValues[segment.slice(1, -1)] ?? "")
          : segment,
      );
    return route.GET(
      new Request(
        `https://requestport.example.invalid/api/v1/${parts.join("/")}`,
      ),
      { params: Promise.resolve({ path: parts }) },
    );
  }

  function holding(scopes: readonly string[]) {
    mocks.authenticate.mockResolvedValue({
      ...agent(projectId),
      scopes: new Set(scopes),
    });
  }

  beforeEach(() => {
    mocks.queryCapabilities = realQueries.map((query) => ({
      ...query,
      scope: `f1:${query.name}`,
    }));
    for (const query of realQueries)
      mocks.agentQueries[query.dispatch.method] = vi
        .fn()
        .mockResolvedValue({ answered: query.name });
  });

  test("covers every agent query in the registry", () => {
    expect(realQueries.map((query) => query.name)).toContain("whoami");
    expect(realQueries).toHaveLength(9);
  });

  test.each(realQueries.map((query) => [query.name, query] as const))(
    "%s is refused holding every real scope but not the registry's",
    async (_name, query) => {
      holding(everyRealScope);

      const response = await get(query);

      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("forbidden");
      // whoami reads its policy only after the check; the rest read nothing.
      expect(mocks.agentQueries[query.dispatch.method]).not.toHaveBeenCalled();
    },
  );

  test.each(realQueries.map((query) => [query.name, query] as const))(
    "%s is answered holding only the registry's scope",
    async (_name, query) => {
      holding([`f1:${query.name}`]);

      const response = await get(query);

      expect(response.status).toBe(200);
      expect(mocks.agentQueries[query.dispatch.method]).toHaveBeenCalledOnce();
    },
  );

  test("a path whose query the registry lacks is answered as a fault, and reads nothing", async () => {
    mocks.queryCapabilities = mocks.queryCapabilities.filter(
      (query) => query.name !== "list_events",
    );
    holding(everyRealScope.concat("f1:list_events"));

    const events = realQueries.find((query) => query.name === "list_events");
    if (!events) throw new Error("list_events is missing");
    const response = await get(events);

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("unexpected_error");
    expect(mocks.agentQueries.listEvents).not.toHaveBeenCalled();
  });

  /**
   * The paths the GET handler answers are the registry's, checked by running
   * it rather than by reading its source. Every path built from the registry's
   * own segments plus an id, up to four segments long, and every registry path
   * with one segment added, removed or replaced, is sent with a credential
   * holding every query's probe scope. A path no entry holds must be answered
   * 404 `not_found` having read nothing; a path one entry holds must be
   * answered 200 by that entry's repository method alone. A branch that reuses
   * the registry's segments at a shape the registry does not hold therefore
   * fails here, whether it reads a repository or not. A branch on a segment
   * the registry does not use is not reached by these paths; the segment check
   * in `transport-metadata.test.ts` holds that. Two entries holding the same
   * path would make the route's branch order decide, so that fails too.
   */
  test("answers every path the registry does not hold with 404, reading nothing, and every path it holds with that entry's method", async () => {
    holding(realQueries.map((query) => `f1:${query.name}`));
    const templates = realQueries.map((query) => ({
      query,
      segments: query.rest.path.slice("/api/v1/".length).split("/"),
    }));
    const id = "018f0000-0000-7000-8000-0000000f1a07";
    const vocabulary = [
      ...new Set(
        templates.flatMap(({ segments }) =>
          segments.filter((segment) => !segment.startsWith("{")),
        ),
      ),
      id,
    ];

    const shapes = new Map<string, string[]>();
    const add = (parts: string[]) => shapes.set(parts.join("/"), parts);
    let layer: string[][] = [[]];
    add([]);
    for (let length = 1; length <= 4; length += 1) {
      layer = layer.flatMap((parts) =>
        vocabulary.map((segment) => [...parts, segment]),
      );
      for (const parts of layer) add(parts);
    }
    for (const { segments } of templates) {
      const concrete = segments.map((segment) =>
        segment.startsWith("{") ? id : segment,
      );
      for (let at = 0; at <= concrete.length; at += 1) {
        if (at < concrete.length)
          add([...concrete.slice(0, at), ...concrete.slice(at + 1)]);
        for (const segment of vocabulary) {
          add([...concrete.slice(0, at), segment, ...concrete.slice(at)]);
          if (at < concrete.length)
            add([...concrete.slice(0, at), segment, ...concrete.slice(at + 1)]);
        }
      }
    }

    const wrong: string[] = [];
    for (const parts of shapes.values()) {
      for (const method of Object.values(mocks.agentQueries))
        method.mockClear();
      const holders = templates.filter(
        ({ segments }) =>
          segments.length === parts.length &&
          segments.every((segment, index) =>
            segment.startsWith("{")
              ? Boolean(parts[index])
              : segment === parts[index],
          ),
      );
      const path = `/${parts.join("/")}`;
      if (holders.length > 1) {
        wrong.push(
          `${path} is held by ${holders.map(({ query }) => query.name).join(" and ")}`,
        );
        continue;
      }

      const response = await route.GET(
        new Request(`https://requestport.example.invalid/api/v1${path}`),
        { params: Promise.resolve({ path: parts }) },
      );
      const body = (await response.json()) as { error?: string };
      const read = Object.entries(mocks.agentQueries)
        .filter(([, method]) => method.mock.calls.length > 0)
        .map(([name]) => name);
      const holder = holders[0]?.query;
      const answered = `${response.status} ${body.error ?? "-"} read [${read.join(", ")}]`;
      const expected = holder
        ? `200 - read [${holder.dispatch.method}]`
        : "404 not_found read []";
      if (answered !== expected)
        wrong.push(`${path}: ${answered}, expected ${expected}`);
    }

    expect(shapes.size).toBeGreaterThan(4000);
    expect(wrong).toEqual([]);
  }, 60_000);

  test("a query the registry gives no scope is answered holding none", async () => {
    mocks.queryCapabilities = mocks.queryCapabilities.map((query) =>
      query.name === "list_events" ? { ...query, scope: null } : query,
    );
    holding([]);

    const events = realQueries.find((query) => query.name === "list_events");
    if (!events) throw new Error("list_events is missing");
    const response = await get(events);

    expect(response.status).toBe(200);
  });
});
