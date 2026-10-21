import type { QueryCapability } from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The GET handler's administration branch (Plan 13, F.2.0a; `manifest-f2.md`
 * §4.1). Every path under `/api/v1/administration`, the prefix itself
 * included, is an administration read's, and no such read admits an agent
 * credential (§4.1, rule 2). Only an operator credential is admitted there,
 * by an entry's `credentialKinds` (F.3); that is held in
 * `route.operator.test.ts` and `lib/server-administration-reads.test.ts`.
 *
 * Two things are held here, by running the route:
 *
 * - every path under the prefix refuses a project-bound and a projectless
 *   agent credential with `403`, having read nothing. Before the branch a
 *   project-bound credential was answered `404` there;
 * - every other GET path answers an agent credential as it did before the
 *   branch. The paths come from the registry's own agent queries, not from a
 *   list written here.
 *
 * Authentication, the limiter and `@requestport/db` are replaced; nothing here
 * opens a database. A probe administration entry is appended to the registry,
 * so the refusal is shown on a path an entry holds and not only on paths no
 * entry holds.
 */

const { probeRead } = vi.hoisted(() => ({
  probeRead: {
    kind: "query",
    name: "f2_probe_administration_read",
    // The probe's name is not one of the dispatch map's keys; the cast stands
    // in for a read's name.
    dispatch: { to: "administration-read", method: "f2ProbeRead" as never },
    binding: "organization",
    scope: "org:read",
    rest: {
      method: "GET",
      path: "/api/v1/administration/probe/{probeId}",
      pathParameters: ["probeId"],
      queryParameters: [],
      routeRequiresProject: false,
      rateLimitClass: "token",
    },
    mcpTool: null,
  } satisfies QueryCapability,
}));

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  rateLimit: vi.fn(),
  register: vi.fn(),
  agentQueries: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("@requestport/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@requestport/domain")>();
  return {
    ...actual,
    capabilityRegistry: [...actual.capabilityRegistry, probeRead],
  };
});
vi.mock("@requestport/auth/server", () => ({
  authenticateAgentBearer: mocks.authenticate,
  authenticateApiBearer: mocks.authenticate,
}));
vi.mock("@requestport/config/server", () => ({
  serverEnv: {
    BETTER_AUTH_URL: "https://requestport.example.invalid",
    BETTER_AUTH_SECRET: "route-administration-test-signing-material",
  },
}));
vi.mock("@requestport/db", () => ({
  createAgentQueryRepository: () => mocks.agentQueries,
  createProjectRegistrationRepository: () => ({ register: mocks.register }),
}));
// The route runs every command and every query through the web's
// RequestPort (Plan 13, G.6; ruling 137). Here that RequestPort is core's own
// execution and query functions over the fakes above: the registration
// repository and the agent queries, each built over a stand-in for the
// root's storage's handle, which the factories ignore. This suite reaches
// neither the bus nor an administration read's own body.
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
      commandBus: unreached("the command bus"),
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
  enforceRateLimit: mocks.rateLimit,
  rateLimitFingerprint: () => "route-administration-test",
}));

const { administrationBasePath, agentScopes, capabilityRegistry, DomainError } =
  await import("@requestport/domain");
const route = await import("./route.js");
const { findAdministrationRead, isAdministrationPath } = await import(
  "../../../../lib/server-administration-reads.js"
);

const organizationId = "018f0000-0000-7000-8000-0000000f2a01";
const projectId = "018f0000-0000-7000-8000-0000000f2a02";
const pathValues: Record<string, string> = {
  projectId: "018f0000-0000-7000-8000-0000000f2a05",
  requestId: "018f0000-0000-7000-8000-0000000f2a06",
  probeId: "018f0000-0000-7000-8000-0000000f2a07",
};

const queries = capabilityRegistry.filter(
  (capability): capability is QueryCapability => capability.kind === "query",
);
const agentQueries = queries.filter(
  (query) => query.dispatch.to === "agent-query-repository",
);
const administrationReads = queries.filter(
  (query) => query.dispatch.to === "administration-read",
);
const prefix = administrationBasePath.slice("/api/v1/".length).split("/");

function agent(project: string | null, scopes: readonly string[]) {
  return {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000f2a03" },
    organizationId,
    projectId: project,
    laneIds: new Set<string>(),
    scopes: new Set(scopes),
    credentialId: "f2-administration-credential",
    correlationId: "018f0000-0000-7000-8000-0000000f2a04",
    audience: "api",
    authorizationId: "f2-administration-authorization",
  };
}

/** Every scope an agent grant can hold, so no refusal here is a scope's. */
const everyAgentScope = [...agentScopes];

/** The path's segments after `/api/v1/`, each parameter given its value. */
function concrete(path: string, values = pathValues) {
  return path
    .slice("/api/v1/".length)
    .split("/")
    .map((segment) =>
      segment.startsWith("{") ? (values[segment.slice(1, -1)] ?? "") : segment,
    );
}

function get(parts: readonly string[], search = "") {
  return route.GET(
    new Request(
      `https://requestport.example.invalid/api/v1/${parts.join("/")}${search}`,
    ),
    { params: Promise.resolve({ path: [...parts] }) },
  );
}

function methodsRead() {
  return [
    ...Object.entries(mocks.agentQueries)
      .filter(([, method]) => method.mock.calls.length > 0)
      .map(([name]) => name),
    ...(mocks.register.mock.calls.length > 0 ? ["register"] : []),
  ];
}

beforeEach(() => {
  mocks.authenticate.mockReset();
  mocks.rateLimit.mockReset().mockResolvedValue(undefined);
  mocks.register.mockReset();
  for (const query of agentQueries)
    mocks.agentQueries[query.dispatch.method] = vi
      .fn()
      .mockResolvedValue(
        query.dispatch.method === "getAgentPolicy"
          ? { heartbeatIntervalSeconds: 60 }
          : { answered: query.dispatch.method },
      );
});

describe("the administration prefix", () => {
  /**
   * Every path under the prefix the tests send: the prefix itself; each path
   * an administration entry holds (the probe's, and any the real registry
   * adds); the prefix followed by each agent query's path, so no agent read is
   * reachable through it; the three shared reads §4.1 names; and paths no
   * entry holds, one and several segments deep.
   */
  const paths = [
    prefix,
    ...administrationReads.map((read) => concrete(read.rest.path)),
    ...agentQueries.map((query) => [...prefix, ...concrete(query.rest.path)]),
    [...prefix, "projects"],
    [...prefix, "lanes"],
    [...prefix, "members"],
    [...prefix, "unknown"],
    [...prefix, "unknown", pathValues.probeId ?? "", "deeper"],
  ];

  test("covers the prefix, the probe entry and every agent query under it", () => {
    expect(administrationBasePath).toBe("/api/v1/administration");
    expect(administrationReads.map((read) => read.name)).toContain(
      probeRead.name,
    );
    expect(agentQueries.length).toBeGreaterThan(0);
    expect(paths.length).toBe(
      1 + administrationReads.length + agentQueries.length + 5,
    );
  });

  for (const [credential, project] of [
    ["a project-bound", projectId],
    ["a projectless", null],
  ] as const) {
    test(`refuses ${credential} agent credential with 403 on every path under it, reading nothing`, async () => {
      mocks.authenticate.mockResolvedValue(agent(project, everyAgentScope));

      const wrong: string[] = [];
      for (const parts of paths) {
        for (const search of ["", `?projectId=${projectId}`]) {
          const path = `/${parts.join("/")}${search}`;
          const calls = mocks.rateLimit.mock.calls.length;
          const response = await get(parts, search);
          const body = (await response.json()) as { error?: string };
          const answered = `${response.status} ${body.error ?? "-"} read [${methodsRead().join(", ")}] limited ${mocks.rateLimit.mock.calls.length - calls}`;
          if (answered !== "403 forbidden read [] limited 1")
            wrong.push(`${path}: ${answered}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  test("still answers a request with no credential 401, as before", async () => {
    mocks.authenticate.mockRejectedValue(
      new DomainError("unauthenticated", "A bearer credential is required"),
    );

    const response = await get(prefix);

    expect(response.status).toBe(401);
    expect(methodsRead()).toEqual([]);
  });
});

describe("every other GET path, as before the branch", () => {
  const withAll = () => agent(projectId, everyAgentScope);

  test.each(agentQueries.map((query) => [query.name, query] as const))(
    "%s is read by its own method for a project-bound credential holding its scope",
    async (_name, query) => {
      mocks.authenticate.mockResolvedValue(withAll());

      const response = await get(concrete(query.rest.path));

      expect(response.status).toBe(200);
      const body = await response.json();
      if (query.name === "whoami")
        expect(body).toMatchObject({
          organizationId,
          projectId,
          workPolicy: { heartbeatIntervalSeconds: 60 },
        });
      else expect(body).toEqual({ answered: query.dispatch.method });
      expect(methodsRead()).toEqual([query.dispatch.method]);
      const call = mocks.agentQueries[query.dispatch.method]?.mock.calls[0];
      expect(call?.[0]).toEqual({ ...withAll(), projectId });
      for (const parameter of query.rest.pathParameters)
        expect(call, parameter).toContain(pathValues[parameter]);
    },
  );

  test.each(
    agentQueries
      .filter((query) => query.rest.pathParameters.length > 0)
      .map((query) => [query.name, query] as const),
  )(
    "%s still reads a path parameter whose value is the prefix's segment",
    async (_name, query) => {
      mocks.authenticate.mockResolvedValue(withAll());
      const values = Object.fromEntries(
        query.rest.pathParameters.map((name) => [name, prefix[0] ?? ""]),
      );

      const response = await get(concrete(query.rest.path, values));

      expect(response.status).toBe(200);
      expect(methodsRead()).toEqual([query.dispatch.method]);
      expect(
        mocks.agentQueries[query.dispatch.method]?.mock.calls[0],
      ).toContain(prefix[0]);
    },
  );

  test.each(
    agentQueries
      .filter((query) => query.scope !== null)
      .map((query) => [query.name, query] as const),
  )(
    "%s refuses a project-bound credential without its scope, reading nothing",
    async (_name, query) => {
      mocks.authenticate.mockResolvedValue(
        agent(
          projectId,
          everyAgentScope.filter((scope) => scope !== query.scope),
        ),
      );

      const response = await get(concrete(query.rest.path));

      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("forbidden");
      expect(methodsRead()).toEqual([]);
    },
  );

  test.each(agentQueries.map((query) => [query.name, query] as const))(
    "%s refuses a projectless credential, reading nothing",
    async (_name, query) => {
      mocks.authenticate.mockResolvedValue(agent(null, everyAgentScope));

      const response = await get(concrete(query.rest.path));

      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("forbidden");
      expect(methodsRead()).toEqual([]);
    },
  );

  /**
   * First segments beside the prefix's own: the branch matches the segment
   * exactly, so each stays a path no entry holds.
   */
  const beside = [
    `${prefix[0]}s`,
    `${prefix[0]}-reads`,
    (prefix[0] ?? "").toUpperCase(),
    (prefix[0] ?? "").slice(0, 5),
  ];

  test.each(beside)(
    "/%s answers a project-bound credential 404 and a projectless one 403, reading nothing",
    async (segment) => {
      for (const [project, status, error] of [
        [projectId, 404, "not_found"],
        [null, 403, "forbidden"],
      ] as const) {
        mocks.authenticate.mockResolvedValue(agent(project, everyAgentScope));

        const response = await get([segment, "projects"]);

        expect(response.status, String(project)).toBe(status);
        expect((await response.json()).error).toBe(error);
        expect(methodsRead()).toEqual([]);
      }
    },
  );
});

/**
 * The branch the handler takes, and the entry the dispatch finds, both come
 * from the registry: the prefix from `administrationBasePath`, the entry by
 * matching the path against each administration entry's own.
 */
describe("the administration dispatch's registry lookup", () => {
  test("takes the prefix and every path under it, and no other path", () => {
    expect(isAdministrationPath(prefix)).toBe(true);
    expect(isAdministrationPath([...prefix, "anything", "deeper"])).toBe(true);
    for (const parts of [
      [],
      [`${prefix[0]}s`],
      ["projects", ...prefix],
      ...agentQueries.map((query) => concrete(query.rest.path)),
    ])
      expect(isAdministrationPath(parts), parts.join("/")).toBe(false);
  });

  test("finds the entry whose path it is, with its parameters, and nothing for any other path", () => {
    expect(findAdministrationRead(concrete(probeRead.rest.path))).toMatchObject(
      {
        entry: { name: probeRead.name },
        pathParameters: { probeId: pathValues.probeId },
      },
    );
    for (const parts of [
      prefix,
      [...prefix, "probe"],
      [...prefix, "probe", ""],
      [...concrete(probeRead.rest.path), "deeper"],
      concrete(probeRead.rest.path).slice(1),
    ])
      expect(findAdministrationRead(parts), parts.join("/")).toBeUndefined();
  });
});
