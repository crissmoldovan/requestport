import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";
import { type ZodType, z } from "zod";

import {
  type AuthorizedCommandContext,
  administrationBasePath,
  admitsCredentialKind,
  agentAdministrationInputSchemas,
  agentScopes,
  type CommandMeta,
  capabilityRegistry,
  coreCommandInputSchemas,
  createCoreCommandRegistry,
  DomainError,
  findMcpToolTransport,
  findQueryCapability,
  findRestCommandTransport,
  mcpOnlyTools,
  mcpToolTransports,
  normalizePageLimit,
  operatorActor,
  operatorScopes,
  projectRegistrationInputSchema,
  type RequestRecord,
  type RestCommandTransport,
  requestLifecycleActions,
  requestStates,
  restApiBasePath,
  restCommandEnvelopeFields,
  restCommandTransports,
  restQueryTransports,
  slackConnectionTestInputSchema,
  splitImportEntryInputSchema,
  type UnitOfWork,
} from "./index.js";

/*
  The REST route's handlers live in a workspace this package cannot import
  (`packages/server`, which depends on this package, not the reverse; since
  Plan 13, H.1 the route, in `apps/web`, composes them, and ruling 147
  re-pointed these checks at them), and so does the dispatch they hand
  their queries to, core's (`packages/core`, which depends on this package
  too), so the checks that hold the registry to them read their source as
  text. The POST handler reads the registry itself (Plan 13, F.1), so for
  POST these checks only confirm it declares no command of its own;
  `route.registry.test.ts` in `apps/web` runs the route against a changed
  registry. The GET handler hands every path to core (Plan 13, G.6; ruling
  137): `resolveRestQuery` and `query` in `packages/core/src/query.ts` find
  and run the query, and the agent queries' dispatch there is still written
  by hand, so it is read here in the GET handler's place. Its one branch
  that is not, the administration prefix (Plan 13, F.2.0a), goes to core's
  `packages/core/src/administration-reads.ts`, which is read here too;
  `route.administration.test.ts` runs the route there.

  The MCP server registers its tools from the registry (F.1 step 2), and is no
  longer read here: `packages/mcp/src/server.registry.test.ts` builds it and
  holds it to the registry at runtime.

  Turbo does not hash `apps/web`, `packages/server` or `packages/core` into
  this package's test task, so a cached pass of this file can outlive a
  change to any of them. A cold run (`--force`) re-reads them.
*/
const repositoryRoot = new URL("../../../", import.meta.url);
/** The REST handlers' module, which the route composes. */
const restHandlerSource = readFileSync(
  new URL("packages/server/src/rest.ts", repositoryRoot),
  "utf8",
);
/** The route itself: a composition of the two handlers above. */
const restRouteSource = readFileSync(
  new URL("apps/web/src/app/api/v1/[[...path]]/route.ts", repositoryRoot),
  "utf8",
);
function between(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`No span from ${start} to ${end}`);
  return source.slice(from, to);
}

/** The string literals in `text`, in order. */
function stringLiterals(text: string) {
  return [...text.matchAll(/"([^"]+)"/gu)].map((entry) => entry[1] ?? "");
}

const getHandler = between(
  restHandlerSource,
  "export async function handleRestQuery(",
  "export async function handleRestCommand(",
);
const postHandler = restHandlerSource.slice(
  restHandlerSource.indexOf("export async function handleRestCommand("),
);
/** Core's query dispatch, which the GET handler hands every query to. */
const queryDispatchSource = readFileSync(
  new URL("packages/core/src/query.ts", repositoryRoot),
  "utf8",
);
/** The agent queries' dispatch in core: `agentQuery`'s body. */
const agentQueryDispatch = between(
  queryDispatchSource,
  "async function agentQuery(",
  "\n}\n",
);
const administrationDispatchSource = readFileSync(
  new URL("packages/core/src/administration-reads.ts", repositoryRoot),
  "utf8",
);

/**
 * The queries core's agent query dispatch reads: every query entry but the
 * administration reads, which go to their own dispatch.
 */
const agentQueryEntries = capabilityRegistry.filter(
  (capability) =>
    capability.kind === "query" &&
    capability.dispatch.to === "agent-query-repository",
);
const agentQueryPaths = new Set(
  agentQueryEntries.map((capability) => capability.rest.path),
);
const agentQueryTransports = restQueryTransports.filter((transport) =>
  agentQueryPaths.has(transport.path),
);

const lifecycleNames = restCommandTransports
  .filter((transport) =>
    transport.injectedFields.some((field) => field.field === "action"),
  )
  .map((transport) => transport.name);

describe("REST transport metadata against the route and the handlers it composes", () => {
  test("the route declares no POST command of its own: the POST handler it composes finds each in the registry", () => {
    expect(postHandler).toContain("findRestCommandTransport(parts[1])");
    expect(restHandlerSource).not.toMatch(/new Set\(/u);
    expect(restRouteSource).not.toMatch(/new Set\(/u);
    expect(
      between(restRouteSource, "export async function POST(", "\n}\n"),
    ).toContain("handleRestCommand(");
    expect(restRouteSource).not.toContain("findRestCommandTransport");
    for (const transport of restCommandTransports) {
      expect(postHandler, transport.name).not.toContain(`"${transport.name}"`);
      expect(restRouteSource, transport.name).not.toContain(
        `"${transport.name}"`,
      );
    }
  });

  test("injects `action` for exactly the request lifecycle actions", () => {
    expect(lifecycleNames).toEqual([...requestLifecycleActions]);
  });

  test("every path is the base path plus /commands/<name>, over POST", () => {
    for (const transport of restCommandTransports) {
      expect(transport.method).toBe("POST");
      expect(transport.path).toBe(
        `${restApiBasePath}/commands/${transport.name}`,
      );
    }
  });

  test("the envelope fields are the route's", () => {
    expect(restHandlerSource).toContain(
      "idempotencyKey: z.string().check(utf16Min(16)).check(utf16Max(200))",
    );
    expect(restHandlerSource).toContain(
      "expectedVersion: z.number().int().nonnegative()",
    );
    expect(
      restCommandEnvelopeFields.idempotencyKey.safeParse("x").success,
    ).toBe(false);
    expect(
      restCommandEnvelopeFields.idempotencyKey.safeParse("x".repeat(16))
        .success,
    ).toBe(true);
    expect(
      restCommandEnvelopeFields.idempotencyKey.safeParse("x".repeat(201))
        .success,
    ).toBe(false);
    expect(restCommandEnvelopeFields.expectedVersion.safeParse(0).success).toBe(
      true,
    );
    expect(
      restCommandEnvelopeFields.expectedVersion.safeParse(-1).success,
    ).toBe(false);
    expect(
      restCommandEnvelopeFields.expectedVersion.safeParse(1.5).success,
    ).toBe(false);
  });

  test("the route writes each kind of injected field, after the caller's input", () => {
    const kinds = new Set(
      restCommandTransports.flatMap((transport) =>
        transport.injectedFields.map((field) => field.from),
      ),
    );
    for (const kind of kinds)
      expect(restHandlerSource, kind).toContain(`case "${kind}":`);
    const injectedAt = postHandler.search(
      /injectedValue\(\s*injection,\s*context,\s*options\.withProject,?\s*\)/u,
    );
    expect(postHandler.indexOf("{ ...body.input }")).toBeGreaterThan(0);
    expect(postHandler.indexOf("{ ...body.input }")).toBeLessThan(injectedAt);
  });

  // Plan 13, F.2.2 added the two agent revocations, which keep the key and
  // grant services' own receipts and so stay off the bus (`manifest-f2.md`
  // §2.4); the route hands each to its handler by name. F.2.5's connection
  // test follow-up added the Slack connection test, which the route hands to
  // `queueSlackConnectionTest`. F.2.6 added the import split, which the route
  // hands to `splitImportEntry`.
  test("only register_project, the two agent revocations, F.2.5's connection test and F.2.6's split are dispatched off the command bus, and only register_project and create_request_draft require a project at the route", () => {
    const offBus = restCommandTransports.filter(
      (transport) => transport.dispatch.to !== "command-bus",
    );
    expect(
      offBus.map((transport) => [transport.name, transport.dispatch]),
    ).toEqual([
      ["register_project", { to: "project-registration-repository" }],
      [
        "revoke_agent_credential",
        { to: "agent-administration", handler: "revoke_agent_credential" },
      ],
      [
        "revoke_agent_oauth_grant",
        { to: "agent-administration", handler: "revoke_agent_oauth_grant" },
      ],
      ["send_slack_connection_test", { to: "slack-connection-test" }],
      ["split_legacy_import_entry", { to: "import-split" }],
    ]);
    const needProject = restCommandTransports
      .filter((transport) => transport.routeRequiresProject)
      .map((transport) => transport.name);
    expect(needProject).toEqual(["create_request_draft", "register_project"]);
  });

  test("the rate-limit classes are the route's", () => {
    expect(getHandler).toContain('endpointClass: "token"');
    expect(postHandler).toContain('endpointClass: "mutation"');
    for (const transport of restCommandTransports)
      expect(transport.rateLimitClass).toBe("mutation");
    for (const transport of restQueryTransports)
      expect(transport.rateLimitClass).toBe("token");
  });

  // Replaced in F.1 step 3, when the route stopped naming scopes. It read
  // "the GET scopes are the route's, in the route's order": each
  // `requireAgentScope(context, "<scope>")` literal against the registry's
  // scopes. The dispatch now asks the registry for each query's scope by
  // name, and `route.registry.test.ts` changes the scopes under it and
  // watches it follow; this holds the names it asks for. Since Plan 13, G.6
  // the dispatch is core's, so it is read there.
  test("core's agent query dispatch asks the registry for each agent query's scope, in the registry's order, and names none itself", () => {
    const asked = [
      ...agentQueryDispatch.matchAll(
        /requireQueryScope\(context, "([^"]+)"\)/gu,
      ),
    ].map((match) => match[1]);
    expect(asked).toEqual(
      agentQueryEntries.map((capability) => capability.name),
    );
    for (const name of asked)
      expect(findQueryCapability(name ?? ""), name).toBeDefined();
    expect(queryDispatchSource).not.toMatch(/requireAgentScope\(context, "/u);
    expect(getHandler).not.toMatch(/requireQueryScope|requireAgentScope/u);
  });

  // Until Plan 13, G.6 the GET handler matched each path against segments
  // it wrote itself (`parts[0] === "whoami"`), and this held those segments
  // equal to the registry's. Core matches a path against each entry's own
  // path instead, so the segments served are the registry's by construction;
  // this holds that neither the route nor core writes a segment of its own,
  // and that a project is asked for first.
  test("the GET path segments are the registry's: core matches each path against the entries' own paths, names no segment itself, and asks for a project before it looks one up and again before it branches", () => {
    expect(getHandler).not.toMatch(/parts\[\d\] === "/u);
    expect(queryDispatchSource).not.toMatch(/parts\[\d\] === "/u);
    const lookup = between(
      queryDispatchSource,
      "function findAgentQueryByPath(",
      "\n}\n",
    );
    expect(lookup).toContain("for (const entry of capabilityRegistry)");
    expect(lookup).toContain("entry.rest.path");
    const resolve = queryDispatchSource.slice(
      queryDispatchSource.indexOf("export function resolveRestQuery("),
    );
    expect(resolve.indexOf("requireProject(context)")).toBeGreaterThan(0);
    expect(resolve.indexOf("requireProject(context)")).toBeLessThan(
      resolve.indexOf("findAgentQueryByPath(parts)"),
    );
    // Every agent query is refused without a project before it branches.
    expect(agentQueryDispatch.indexOf("requireProject(")).toBeGreaterThan(0);
    expect(agentQueryDispatch.indexOf("requireProject(")).toBeLessThan(
      agentQueryDispatch.indexOf("switch (entry.name)"),
    );
    for (const transport of agentQueryTransports) {
      expect(transport.method).toBe("GET");
      expect(transport.routeRequiresProject).toBe(true);
    }
  });

  /*
    Plan 13, F.2.0a (`manifest-f2.md` §4.1): the prefix and every path under
    it go to the administration dispatch, after authentication and the rate
    limit and before the project check, since such a read may be bound to no
    project. Since Plan 13, G.6 (ruling 137) the GET handler hands every path
    to core: `resolveRestQuery` looks the prefix up first, refusing an agent
    credential before it looks anything up, and `query` hands an
    administration entry to its dispatch before the operator branch and the
    agent queries. Neither the route nor core names the prefix or any
    administration read: the dispatch takes the prefix from
    `administrationBasePath` and the entry from the registry.
  */
  test("the administration prefix goes to its dispatch, after the rate limit and before the project check and the operator branch", () => {
    const once = (source: string, text: string) =>
      source.split(text).length - 1;
    // The GET handler: authentication, the rate limit, then core, once each;
    // the route that composes it calls none of them itself.
    const order = [
      /options\.authenticateApiBearer\(request/u,
      /options\.rateLimiter\.enforce\(/u,
      /resolveRestQuery\(parts, context\)/u,
      /options\s*\.requestPort\(\)\s*\.query\(/u,
    ].map((text) => getHandler.search(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(once(getHandler, "resolveRestQuery(")).toBe(1);
    expect(once(restHandlerSource, "resolveRestQuery(")).toBe(1);
    expect(once(restRouteSource, "resolveRestQuery(")).toBe(0);
    expect(
      between(restRouteSource, "export async function GET(", "\n}\n"),
    ).toContain("handleRestQuery(");
    expect(getHandler).not.toMatch(
      /readAdministration|isAdministrationPath|agentQueryRepository|operatorQuery|withProject/u,
    );
    // Core's lookup: the prefix first, an agent refused there before
    // anything is looked up, and a project asked for only off the prefix.
    const resolve = queryDispatchSource.slice(
      queryDispatchSource.indexOf("export function resolveRestQuery("),
    );
    const lookup = [
      "isAdministrationPath(parts)",
      "refuseAgentAtAdministration(context)",
      "findAdministrationRead(parts)",
      "requireProject(context)",
      "findAgentQueryByPath(parts)",
    ].map((text) => resolve.indexOf(text));
    expect(lookup.every((at) => at >= 0)).toBe(true);
    expect(lookup).toEqual([...lookup].sort((a, b) => a - b));
    const prefixBranch = between(
      resolve,
      "if (isAdministrationPath(parts)) {",
      "\n  }\n",
    );
    expect(prefixBranch).toMatch(/\breturn\b/u);
    expect(prefixBranch).not.toMatch(/requireProject|findAgentQueryByPath/u);
    // Core's run: an administration entry goes to its dispatch before the
    // operator branch and the agent queries.
    const run = queryDispatchSource.slice(
      queryDispatchSource.indexOf("export function createQueryExecution("),
    );
    const branches = [
      "isAdministrationEntry(entry)",
      "readAdministrationEntry(",
      "operatorQuery(entry, context)",
      "agentQuery(",
    ].map((text) => run.indexOf(text));
    expect(branches.every((at) => at >= 0)).toBe(true);
    expect(branches).toEqual([...branches].sort((a, b) => a - b));
    expect(
      between(run, "if (isAdministrationEntry(entry)) {", "\n    }\n"),
    ).toMatch(/^if \(isAdministrationEntry\(entry\)\) \{\s+return /u);
    const prefixSegment = administrationBasePath.slice(
      restApiBasePath.length + 1,
    );
    expect(stringLiterals(restHandlerSource)).not.toContain(prefixSegment);
    expect(stringLiterals(restRouteSource)).not.toContain(prefixSegment);
    expect(stringLiterals(queryDispatchSource)).not.toContain(prefixSegment);

    const dispatch = administrationDispatchSource;
    expect(stringLiterals(dispatch)).not.toContain(prefixSegment);
    expect(dispatch).toMatch(/administrationBasePath\s*\.slice\(/u);
    expect(dispatch).toContain(
      "capabilityRegistry.filter(isAdministrationEntry)",
    );
    expect(dispatch).not.toContain("agentQueryRepository");
    expect(
      between(
        dispatch,
        "export function refuseAgentAtAdministration(",
        "\n}\n",
      ),
    ).toContain('context.actor.type === "agent"');
    const read = dispatch.slice(
      dispatch.indexOf("export async function readAdministrationEntry("),
    );
    const steps = [
      "refuseAgentAtAdministration(context)",
      "admits(entry, context)",
      "context.scopes.has(entry.scope)",
      "administrationReadNamed(entry.dispatch.method)",
    ].map((text) => read.indexOf(text));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  test("the GET query parameters are the ones core's agent query dispatch reads", () => {
    const read = new Set(
      [
        ...agentQueryDispatch.matchAll(
          /searchParams\.(?:get|getAll|has)\("([^"]+)"\)/gu,
        ),
      ].map((match) => match[1]),
    );
    expect(getHandler).not.toMatch(/searchParams\.(?:get|getAll|has)\(/u);
    // An administration read's parameters are read by the read, not here.
    const declared = new Set(
      agentQueryTransports.flatMap((transport) =>
        transport.queryParameters.map((parameter) => parameter.name),
      ),
    );
    expect(declared).toEqual(read);
  });

  test("a query parameter repeats exactly when core's agent query dispatch reads it with getAll", () => {
    for (const transport of agentQueryTransports) {
      for (const parameter of transport.queryParameters) {
        const all = agentQueryDispatch.includes(
          `searchParams.getAll("${parameter.name}")`,
        );
        const one = agentQueryDispatch.includes(
          `searchParams.get("${parameter.name}")`,
        );
        expect(all || one, parameter.name).toBe(true);
        expect(all && one, parameter.name).toBe(false);
        expect(parameter.repeated, parameter.name).toBe(all);
      }
    }
  });

  const queryParameter = (name: string) =>
    agentQueryTransports
      .flatMap((transport) => transport.queryParameters)
      .find((parameter) => parameter.name === name);

  test("state takes core's request states, as many times as core allows", () => {
    const state = queryParameter("state");
    const dispatchStates = stringLiterals(
      between(
        queryDispatchSource,
        "const requestStateSchema = z.enum([",
        "]);",
      ),
    );
    expect(dispatchStates).toEqual([...requestStates]);
    expect(z.toJSONSchema(state?.valueSchema as ZodType).enum).toEqual(
      dispatchStates,
    );
    const maxCount =
      /\.array\(requestStateSchema\)\s*\.max\((\d+)\)\s*\.parse\(searchParams\.getAll\("state"\)\)/u.exec(
        agentQueryDispatch,
      )?.[1];
    expect(state?.maxCount).toBe(Number(maxCount));
  });

  test("limit is the integer range the repository's page check admits", () => {
    const limit = queryParameter("limit");
    if (!limit?.valueSchema) throw new Error("limit declares no value schema");
    expect(agentQueryDispatch).toContain('Number(searchParams.get("limit"))');
    expect(limit.defaultValue).toBe(normalizePageLimit(undefined));
    for (const value of [-1, 0, 1, 1.5, 50, 200, 201, Number.NaN]) {
      let admitted = true;
      try {
        normalizePageLimit(value);
      } catch {
        admitted = false;
      }
      expect(limit.valueSchema.safeParse(value).success, String(value)).toBe(
        admitted,
      );
    }
  });
});

describe("REST transport metadata against the domain", () => {
  test("each command transport describes its input with the schema its dispatch parses", () => {
    for (const transport of restCommandTransports) {
      const expected =
        transport.dispatch.to === "command-bus"
          ? coreCommandInputSchemas[transport.dispatch.commandName]
          : transport.dispatch.to === "agent-administration"
            ? agentAdministrationInputSchemas[transport.dispatch.handler]
            : transport.dispatch.to === "import-split"
              ? splitImportEntryInputSchema
              : transport.dispatch.to === "slack-connection-test"
                ? slackConnectionTestInputSchema
                : projectRegistrationInputSchema;
      expect(transport.inputSchema, transport.name).toBe(expected);
    }
  });

  test("every injected field is a field of that schema, so a generator can strip it", () => {
    for (const transport of restCommandTransports) {
      const shape = (transport.inputSchema as { shape?: object }).shape ?? {};
      for (const injected of transport.injectedFields) {
        expect(Object.keys(shape), transport.name).toContain(injected.field);
      }
    }
  });

  test("each lifecycle name injects itself as the action", () => {
    for (const name of lifecycleNames) {
      const transport = restCommandTransports.find(
        (entry) => entry.name === name,
      );
      expect(transport?.injectedFields).toContainEqual({
        field: "action",
        from: "constant",
        value: name,
      });
      expect(transport?.dispatch).toEqual({
        to: "command-bus",
        commandName: "transition_request",
      });
    }
  });
});

/*
  Scopes, proven by running the command rather than by reading it.

  Each bus command is parsed from a valid fixture and then authorized and
  executed against a context holding no scope at all: the first refusal must
  be `forbidden` naming the declared scope. Run again holding only that scope,
  the command must get past every scope check — it then stops somewhere else
  (a port this fake does not serve, a version check, a missing role), which is
  fine: a scope is necessary, not sufficient.
*/
const ids = {
  organization: "018f0000-0000-7000-8000-00000000f001",
  project: "018f0000-0000-7000-8000-00000000f002",
  request: "018f0000-0000-7000-8000-00000000f003",
  related: "018f0000-0000-7000-8000-00000000f004",
  agent: "018f0000-0000-7000-8000-00000000f005",
  question: "018f0000-0000-7000-8000-00000000f006",
  relationship: "018f0000-0000-7000-8000-00000000f007",
  installation: "018f0000-0000-7000-8000-00000000f008",
  workspace: "018f0000-0000-7000-8000-00000000f009",
  repository: "018f0000-0000-7000-8000-00000000f00a",
  session: "018f0000-0000-7000-8000-00000000f00b",
};

const transitionFixture = {
  requestId: ids.request,
  reason: "A stated reason",
  relatedRequestId: ids.related,
  verificationEvidence: "Checked by hand",
  report: {
    outcomeMd: "Done",
    changedRepositories: [],
    validations: [{ command: "pnpm test", result: "passed" }],
    risksMd: "",
    followupsMd: "",
    verificationStepsMd: "Run the suite",
  },
};

const sessionFixture = { workSessionId: ids.session, reason: "A reason" };

const fixtures: Record<string, Record<string, unknown>> = {
  create_request_draft: {
    targetProjectId: ids.project,
    type: "feature",
    title: "A title",
    descriptionMd: "A description",
  },
  update_request: { requestId: ids.request, title: "A new title" },
  transition_request: transitionFixture,
  post_message: { requestId: ids.request, bodyMd: "Hello" },
  ask_question: {
    requestId: ids.request,
    audience: { type: "requester" },
    bodyMd: "Which one?",
  },
  answer_question: {
    questionId: ids.question,
    bodyMd: "This one",
    sourceChannel: "mcp",
  },
  close_question: { questionId: ids.question, reason: "Answered elsewhere" },
  link_requests: {
    fromRequestId: ids.request,
    toRequestId: ids.related,
    type: "blocks",
  },
  unlink_requests: { requestId: ids.request, relationshipId: ids.relationship },
  attach_artifact: {
    requestId: ids.request,
    kind: "link",
    externalUrl: "https://example.com/artifact",
  },
  register_agent_installation: {
    softwareName: "cli",
    softwareVersion: "1.0.0",
  },
  register_machine_workspace: {
    projectId: ids.project,
    repositoryId: ids.repository,
    installationId: ids.installation,
    privateTelemetry: {},
  },
  claim_request: {
    requestId: ids.request,
    installationId: ids.installation,
    workspaceId: ids.workspace,
  },
  start_work_session: sessionFixture,
  heartbeat_work_session: { workSessionId: ids.session },
  post_work_update: {
    workSessionId: ids.session,
    kind: "progress",
    bodyMd: "Progress",
  },
  pause_work_session: sessionFixture,
  resume_work_session: sessionFixture,
  block_work_session: sessionFixture,
  release_request: sessionFixture,
  end_work_session: sessionFixture,
  assign_request: { requestId: ids.request, assigneeUserId: "user_member" },
};

class PortReached extends Error {}

const now = new Date("2026-09-27T00:00:00.000Z");
const request: RequestRecord = {
  id: ids.request,
  organizationId: ids.organization,
  sequenceNumber: 1,
  displayKey: "F0-1",
  source: { kind: "project", projectId: ids.project },
  targetProjectId: ids.project,
  laneId: null,
  type: "feature",
  title: "A title",
  descriptionMd: "A description",
  priority: "normal",
  visibility: "organization",
  sensitivity: "normal",
  state: "submitted",
  resumeState: null,
  stateReason: null,
  reporter: { type: "agent", id: ids.agent },
  assignee: null,
  version: 1,
  routingRuleId: null,
  routingPolicyVersion: null,
  createdAt: now,
  submittedAt: now,
  updatedAt: now,
};

/**
 * Serves only what `transition_request` reads before it checks a scope: the
 * request, and an access record that grants every role, so the scope is the
 * only thing left to refuse. Anything else a command reaches throws
 * `PortReached`, which the test counts as having got past the scope checks.
 */
function unitOfWork(): UnitOfWork {
  const served: Record<string, Record<string, unknown>> = {
    requests: {
      findForUpdate: async () => request,
      actorAccess: async () => ({
        organizationRole: "owner",
        projectRole: "maintainer",
        isReporter: true,
        hasExclusiveClaim: true,
        isActiveWorker: true,
        explicitTriageGrant: true,
      }),
    },
  };
  const unserved = (name: string) =>
    new Proxy(
      {},
      {
        get(_, property) {
          if (property === "then") return undefined;
          const value = served[name]?.[String(property)];
          return (
            value ??
            (() => {
              throw new PortReached(`${name}.${String(property)}`);
            })
          );
        },
      },
    );
  return {
    commandReceipts: unserved(
      "commandReceipts",
    ) as UnitOfWork["commandReceipts"],
    domainEvents: unserved("domainEvents") as UnitOfWork["domainEvents"],
    port: <T>(name: string) => unserved(name) as T,
  };
}

async function firstRefusal(
  commandName: string,
  input: Record<string, unknown>,
  scopes: string[],
) {
  const definition = createCoreCommandRegistry().resolve(commandName);
  if (!definition) throw new Error(`No command ${commandName}`);
  const parsed = definition.parse(input);
  const context: AuthorizedCommandContext = {
    actor: { type: "agent", id: ids.agent },
    organizationId: ids.organization,
    projectId: ids.project,
    laneIds: new Set(),
    scopes: new Set(scopes),
    credentialId: "f0-credential",
    correlationId: "f0-correlation",
  };
  const meta: CommandMeta = {
    idempotencyKey: "f0-idempotency-key-0001",
    expectedVersion: 1,
  };
  const uow = unitOfWork();
  try {
    await definition.authorize(context, parsed, uow);
    await definition.execute(uow, context, parsed, meta);
    return null;
  } catch (error) {
    return error;
  }
}

function scopeRefused(error: unknown) {
  return error instanceof DomainError &&
    error.code === "forbidden" &&
    typeof error.details.scope === "string"
    ? error.details.scope
    : null;
}

function commandInput(
  transport: RestCommandTransport,
  action?: string,
): Record<string, unknown> {
  if (transport.dispatch.to !== "command-bus")
    throw new Error("not a bus command");
  const input: Record<string, unknown> = {
    ...(fixtures[transport.name] ??
      fixtures[transport.dispatch.commandName] ??
      {}),
    ...(action ? { action } : {}),
  };
  for (const injected of transport.injectedFields) {
    input[injected.field] =
      injected.from === "constant"
        ? injected.value
        : injected.from === "credential.organizationId"
          ? ids.organization
          : ids.project;
  }
  return input;
}

describe("REST transport scopes, by execution", () => {
  // Run with an agent context, so only the commands REST admits agents to
  // (Plan 13, F.3); `revoke_operator_credential` is run as an operator below.
  const onBus = restCommandTransports.filter(
    (transport) =>
      transport.dispatch.to === "command-bus" &&
      admitsCredentialKind(transport, "agent"),
  );

  test.each(
    onBus
      .filter((transport) => transport.scope.kind === "fixed")
      .map((transport) => [transport.name, transport] as const),
  )(
    "%s refuses without its declared scope, and passes the scope check with it",
    async (_, transport) => {
      if (
        transport.dispatch.to !== "command-bus" ||
        transport.scope.kind !== "fixed"
      )
        return;
      const input = commandInput(transport);
      const without = await firstRefusal(
        transport.dispatch.commandName,
        input,
        [],
      );
      expect(scopeRefused(without)).toBe(transport.scope.scope);
      const withIt = await firstRefusal(transport.dispatch.commandName, input, [
        transport.scope.scope,
      ]);
      expect(scopeRefused(withIt)).toBeNull();
    },
  );

  test("transition_request's scope follows its action, for every action", async () => {
    const transport = restCommandTransports.find(
      (entry) => entry.name === "transition_request",
    );
    if (transport?.scope.kind !== "by-action")
      throw new Error("transition_request must declare a scope per action");
    expect(Object.keys(transport.scope.scopes).sort()).toEqual(
      [...lifecycleNames].sort(),
    );
    for (const [action, scope] of Object.entries(transport.scope.scopes)) {
      const input = commandInput(transport, action);
      expect(
        scopeRefused(await firstRefusal("transition_request", input, [])),
        action,
      ).toBe(scope);
      expect(
        scopeRefused(await firstRefusal("transition_request", input, [scope])),
        action,
      ).toBeNull();
    }
  });

  test("the lifecycle names declare the same scope as their action", () => {
    const generic = restCommandTransports.find(
      (entry) => entry.name === "transition_request",
    );
    if (generic?.scope.kind !== "by-action") throw new Error("by-action");
    for (const name of lifecycleNames) {
      const transport = restCommandTransports.find(
        (entry) => entry.name === name,
      );
      expect(transport?.scope).toEqual({
        kind: "fixed",
        scope: generic.scope.scopes[name as keyof typeof generic.scope.scopes],
        checkedBy: "command",
      });
    }
  });

  test("a fixture that does not parse fails the run instead of passing it", async () => {
    // Fixtures are parsed outside the try in `firstRefusal`, so a missing or
    // stale one cannot be mistaken for a refusal. A command the fake could not
    // carry as far as its scope check would report `PortReached` with no scope
    // named, and the per-command test above fails on that instead.
    await expect(
      firstRefusal("post_message", { organizationId: ids.organization }, []),
    ).rejects.toThrow();
  });
});

describe("the metadata as a whole", () => {
  test("every schema it points at is a real object schema", () => {
    for (const transport of restCommandTransports) {
      expect(
        (transport.inputSchema as ZodType & { shape?: object }).shape,
        transport.name,
      ).toBeTypeOf("object");
    }
  });
});

/*
  The capability registry (Plan 13, F.1). `restCommandTransports` and
  `restQueryTransports` are projections of it, so the REST route, the OpenAPI
  generator and these tests read one list; nothing above is declared twice.
*/
describe("the capability registry", () => {
  const commands = capabilityRegistry.filter(
    (capability) => capability.kind === "command",
  );
  const queries = capabilityRegistry.filter(
    (capability) => capability.kind === "query",
  );
  const agentQueries = queries.filter(
    (capability) => capability.dispatch.to === "agent-query-repository",
  );
  const administrationReads = queries.filter(
    (capability) => capability.dispatch.to === "administration-read",
  );

  test("names each capability once", () => {
    const names = capabilityRegistry.map((capability) => capability.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("the POST transports are its commands, in its order, field for field", () => {
    expect(restCommandTransports.map((transport) => transport.name)).toEqual(
      commands.map((capability) => capability.name),
    );
    for (const [index, capability] of commands.entries()) {
      const transport = restCommandTransports[index];
      expect(transport, capability.name).toEqual({
        name: capability.name,
        method: capability.rest.method,
        path: capability.rest.path,
        dispatch: capability.dispatch,
        inputSchema: capability.inputSchema,
        injectedFields: capability.rest.injectedFields,
        scope: capability.scope,
        routeRequiresProject: capability.rest.routeRequiresProject,
        rateLimitClass: capability.rest.rateLimitClass,
        mcpTool: capability.mcpTool,
        credentialKinds: capability.credentialKinds ?? ["agent"],
      });
      expect(transport?.inputSchema, capability.name).toBe(
        capability.inputSchema,
      );
    }
  });

  test("the GET transports are its queries, in its order, field for field", () => {
    expect(restQueryTransports.map((transport) => transport.path)).toEqual(
      queries.map((capability) => capability.rest.path),
    );
    for (const [index, capability] of queries.entries()) {
      expect(restQueryTransports[index], capability.name).toEqual({
        name: capability.name,
        binding: capability.binding,
        method: capability.rest.method,
        path: capability.rest.path,
        pathParameters: capability.rest.pathParameters,
        queryParameters: capability.rest.queryParameters,
        scope: capability.scope,
        routeRequiresProject: capability.rest.routeRequiresProject,
        rateLimitClass: capability.rest.rateLimitClass,
        mcpTool: capability.mcpTool,
        credentialKinds: capability.credentialKinds ?? ["agent"],
      });
    }
  });

  test("a query is named for the MCP tool that reads the same thing", () => {
    for (const capability of agentQueries)
      expect(capability.mcpTool?.name).toBe(capability.name);
  });

  // Plan 13, F.2.0 (ruling 26): the query entry gains a binding, a second
  // dispatch target and a nullable MCP tool, for the administration reads.
  test("a query's route requires a project exactly when the query is bound to one", () => {
    for (const capability of queries)
      expect(capability.rest.routeRequiresProject, capability.name).toBe(
        capability.binding === "project",
      );
  });

  test("an agent query is bound to a project and reached over MCP too; an administration read is REST only, under its own prefix", () => {
    for (const capability of agentQueries) {
      expect(capability.binding, capability.name).toBe("project");
      expect(capability.mcpTool, capability.name).not.toBeNull();
      expect(
        capability.rest.path.startsWith(`${administrationBasePath}/`),
        capability.name,
      ).toBe(false);
    }
    for (const capability of administrationReads) {
      expect(capability.mcpTool, capability.name).toBeNull();
      expect(capability.rest.path, capability.name).toMatch(
        new RegExp(`^${administrationBasePath}/[^/]`, "u"),
      );
    }
    expect(administrationBasePath).toBe(`${restApiBasePath}/administration`);
  });

  /*
    The GET handler sends the administration prefix, and every path under it,
    to the administration dispatch, before any agent query, so an agent path
    the prefix could match would lose its read to that branch. The prefix
    itself stands for everything under it, and a path parameter matches any
    one segment.
  */
  test("no administration path equals, or is a prefix of, an agent query path", () => {
    const segments = (path: string) =>
      path.slice(restApiBasePath.length + 1).split("/");
    const matches = (pattern: string, segment: string) =>
      pattern === segment || pattern.startsWith("{") || segment.startsWith("{");
    const shadows = (administration: string, agent: string) => {
      const prefix = segments(administration);
      const full = segments(agent);
      return (
        prefix.length <= full.length &&
        prefix.every((segment, index) => matches(segment, full[index] ?? ""))
      );
    };
    const administrationPaths = [
      administrationBasePath,
      ...administrationReads.map((capability) => capability.rest.path),
    ];
    const shadowedBy = (agent: string) =>
      administrationPaths.filter((administration) =>
        shadows(administration, agent),
      );
    const agentPaths = agentQueries.map((capability) => capability.rest.path);
    expect(agentPaths.length).toBeGreaterThan(0);
    // The check can fire: a parameter at the prefix's own position would, and
    // so would an agent path at the prefix itself or under it.
    expect(shadows(`${restApiBasePath}/{anything}`, agentPaths[0] ?? "")).toBe(
      true,
    );
    expect(shadowedBy(administrationBasePath)).not.toEqual([]);
    expect(shadowedBy(`${administrationBasePath}/anything`)).not.toEqual([]);
    for (const agent of agentPaths)
      expect(shadowedBy(agent), agent).toEqual([]);
  });

  /*
    F.2.0b (`manifest-f2.md` §4.1): the three shared reads, entered once each.
    Each is dispatched under its own name to the administration dispatch, is
    REST only, admits operators alone, and answers an organisation-wide or a
    project-bound credential.
  */
  test("holds F.2.0b's three shared reads, field for field", () => {
    const shared = [
      ["list_administration_projects", "/projects", "project:read", []],
      ["list_administration_lanes", "/lanes", "project:read", ["projectId"]],
      ["list_administration_members", "/members", "org:read", []],
    ] as const;
    for (const [name, path, scope, parameters] of shared) {
      const read = findQueryCapability(name);
      expect(read, name).toMatchObject({
        kind: "query",
        name,
        dispatch: { to: "administration-read", method: name },
        binding: "organization-or-project",
        scope,
        rest: {
          method: "GET",
          path: `${administrationBasePath}${path}`,
          pathParameters: [],
          routeRequiresProject: false,
          rateLimitClass: "token",
        },
        mcpTool: null,
        credentialKinds: ["operator"],
      });
      expect(
        read?.rest.queryParameters.map((parameter) => parameter.name),
        name,
      ).toEqual(parameters);
      expect(
        restQueryTransports.some((transport) => transport.name === name),
        name,
      ).toBe(true);
      expect(findMcpToolTransport(name), name).toBeUndefined();
      expect(operatorScopes, name).toContain(scope);
    }
    const lanes = findQueryCapability("list_administration_lanes");
    const projectId = lanes?.rest.queryParameters[0];
    expect(projectId?.repeated).toBe(false);
    expect(
      projectId?.valueSchema.safeParse("018f0000-0000-7000-8000-0000000f2b01")
        .success,
    ).toBe(true);
    expect(projectId?.valueSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  test("each query's path parameters are the braces in its path", () => {
    for (const capability of queries)
      expect(capability.rest.pathParameters, capability.name).toEqual(
        [...capability.rest.path.matchAll(/\{([^}]+)\}/gu)].map(
          (match) => match[1],
        ),
      );
  });

  test("each query dispatches to the repository method core calls, in core's order", () => {
    const called = [
      ...agentQueryDispatch.matchAll(/agentQueries\.([A-Za-z]+)\(/gu),
    ].map((match) => match[1]);
    expect(
      agentQueries.map((capability) => capability.dispatch.method),
    ).toEqual(called);
    // Each of core's agent queries calls the repository method of its name.
    const repositoryCalls = [
      ...between(
        queryDispatchSource,
        "export function createAgentQueries(",
        "\n}\n",
      ).matchAll(
        /(\w+)\([^)]*\) \{\s+const scoped = requireProject\(context\);\s+return repository\(\)\.([A-Za-z]+)\(/gu,
      ),
    ].map((match) => [match[1], match[2]]);
    expect(repositoryCalls.map(([method]) => method).sort()).toEqual(
      [...new Set(called)].sort(),
    );
    for (const [method, repositoryMethod] of repositoryCalls)
      expect(repositoryMethod, method).toBe(method);
  });

  test("a command that injects the credential's project requires one at the route", () => {
    for (const capability of commands) {
      const injectsProject = capability.rest.injectedFields.some(
        (field) => field.from === "credential.projectId",
      );
      if (injectsProject)
        expect(capability.rest.routeRequiresProject, capability.name).toBe(
          true,
        );
    }
  });

  test("finds a POST transport by its name, and nothing by any other", () => {
    for (const transport of restCommandTransports)
      expect(findRestCommandTransport(transport.name)).toBe(transport);
    for (const name of [
      "",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "Claim_request",
      " claim_request",
      "claim_request ",
      "whoami",
      // A bus command REST does not expose (Plan 13, F.2.1's registry half
      // exposed the rule commands this line named before).
      "abandon_work_session",
    ])
      expect(findRestCommandTransport(name), JSON.stringify(name)).toBe(
        undefined,
      );
  });

  test("requires only scopes an agent grant can hold, and never project:provision", () => {
    // `agentScopes` (agents/agent-types.ts) is what a grant may carry; the
    // registry is checked against it rather than generating it, since it
    // holds scopes no entry requires. project:provision is exclusive and
    // projectless, so no project-scoped capability may require it. Only the
    // entries that admit agents are an agent's to hold (Plan 13, F.3); the
    // operator entries are held to `operatorScopes` below.
    const required = new Set(
      capabilityRegistry
        .filter((capability) => admitsCredentialKind(capability, "agent"))
        .flatMap((capability) =>
          capability.kind === "query"
            ? capability.scope === null
              ? []
              : [capability.scope]
            : capability.scope.kind === "fixed"
              ? [capability.scope.scope]
              : Object.values(capability.scope.scopes),
        ),
    );
    expect(required.size).toBeGreaterThan(1);
    for (const scope of required) {
      expect(agentScopes as readonly string[], scope).toContain(scope);
      expect(scope).not.toBe("project:provision");
    }
  });

  test("finds a query entry by its name, and nothing by any other", () => {
    for (const capability of capabilityRegistry)
      if (capability.kind === "query")
        expect(findQueryCapability(capability.name)).toBe(capability);
    for (const name of [
      "",
      "constructor",
      "__proto__",
      "toString",
      "Whoami",
      " whoami",
      "claim_request",
      "/whoami",
    ])
      expect(findQueryCapability(name), JSON.stringify(name)).toBe(undefined);
  });
});

/*
  The MCP projection: one entry per tool the registry names, which the MCP
  server registers from (Plan 13, F.1 step 2). What the server does with it is
  held at runtime by `packages/mcp/src/server.registry.test.ts`; this holds the
  projection to the registry.
*/
describe("the registry's MCP tools", () => {
  const namedTools = capabilityRegistry.filter(
    (capability) => capability.mcpTool && !capability.mcpTool.action,
  );

  test("are the tools the entries name for themselves, once each, in registry order", () => {
    expect(mcpToolTransports.map((tool) => tool.name)).toEqual(
      namedTools.map((capability) => capability.mcpTool?.name),
    );
    expect(new Set(mcpToolTransports.map((tool) => tool.name)).size).toBe(
      mcpToolTransports.length,
    );
  });

  test("carry each entry's kind, dispatch and host condition", () => {
    namedTools.forEach((capability, index) => {
      const tool = mcpToolTransports[index];
      expect(tool?.kind, capability.name).toBe(capability.kind);
      expect(tool?.registeredWhen, capability.name).toBe(
        capability.mcpTool?.registeredWhen,
      );
      if (capability.kind === "command" && tool?.kind === "command")
        expect(tool.dispatch, capability.name).toEqual(capability.dispatch);
    });
  });

  test("require the entry's scope; the generic transition_request, the one scope of the actions it admits", () => {
    namedTools.forEach((capability, index) => {
      const tool = mcpToolTransports[index];
      if (capability.kind === "query")
        expect(tool?.requiredScope, capability.name).toBe(capability.scope);
      else if (capability.scope.kind === "fixed")
        expect(tool?.requiredScope, capability.name).toBe(
          capability.scope.scope,
        );
      else {
        const { scopes } = capability.scope;
        const admitted = capability.mcpTool?.actions ?? [];
        expect(admitted.length).toBeGreaterThan(0);
        expect(
          new Set(admitted.map((action) => scopes[action])),
          capability.name,
        ).toEqual(new Set([tool?.requiredScope]));
      }
    });
    expect(findMcpToolTransport("transition_request")?.requiredScope).toBe(
      "request:triage",
    );
    expect(findMcpToolTransport("whoami")?.requiredScope).toBeNull();
  });

  test("send a lifecycle action exactly when named for one, and admit the rest through transition_request", () => {
    const lifecycle = new Set<string>(requestLifecycleActions);
    for (const tool of mcpToolTransports) {
      if (tool.kind !== "command") continue;
      expect(tool.action, tool.name).toBe(
        lifecycle.has(tool.name) ? tool.name : undefined,
      );
    }
    const generic = findMcpToolTransport("transition_request");
    if (generic?.kind !== "command") throw new Error("transition_request");
    const reachedThroughGeneric = capabilityRegistry.flatMap((capability) =>
      capability.mcpTool?.action ? [capability.mcpTool.action] : [],
    );
    expect(generic.actions).toEqual(reachedThroughGeneric);
    // Every lifecycle action is reached by exactly one tool.
    const ownTools = mcpToolTransports.flatMap((tool) =>
      tool.kind === "command" && tool.action ? [tool.action] : [],
    );
    expect([...ownTools, ...(generic.actions ?? [])].sort()).toEqual(
      [...requestLifecycleActions].sort(),
    );
  });

  test("leave out only entries reached by action through transition_request, which admits that action", () => {
    const generic = findMcpToolTransport("transition_request");
    if (generic?.kind !== "command") throw new Error("transition_request");
    const reachedByAction = capabilityRegistry.filter(
      (capability) => capability.mcpTool?.action,
    );
    expect(reachedByAction.length).toBeGreaterThan(0);
    for (const capability of reachedByAction) {
      expect(capability.mcpTool?.name, capability.name).toBe(
        "transition_request",
      );
      expect(generic.actions, capability.name).toContain(
        capability.mcpTool?.action,
      );
    }
  });

  test("do not include a tool declared MCP-only", () => {
    for (const name of mcpOnlyTools)
      expect(findMcpToolTransport(name), name).toBeUndefined();
  });

  test("finds a tool by its name, and nothing by any other", () => {
    for (const tool of mcpToolTransports)
      expect(findMcpToolTransport(tool.name)).toBe(tool);
    for (const name of [
      "",
      "constructor",
      "__proto__",
      "toString",
      "Whoami",
      "begin_triage",
      "agent_hello",
    ])
      expect(findMcpToolTransport(name), JSON.stringify(name)).toBe(undefined);
  });
});

/*
  Plan 13, F.3 (F3-12, ruling 25): which kinds of credential REST admits to a
  capability is the entry's `credentialKinds`. An entry that omits it admits
  agents only, so an entry nobody decided about can never admit an operator.
  When F.3 merged exactly two entries admitted operators; each F.2 group adds
  its own, in the change that admits them (F.2.0b the first, then F.2.3, then
  F.2.1, then F.2.2, then F.2.4, then F.2.5, then F.2.6, then F.2.7).
*/
describe("credentialKinds", () => {
  test("an entry that omits it admits agents only", () => {
    const silent = capabilityRegistry.filter(
      (capability) => capability.credentialKinds === undefined,
    );
    expect(silent.length).toBeGreaterThan(0);
    for (const capability of silent) {
      expect(admitsCredentialKind(capability, "agent"), capability.name).toBe(
        true,
      );
      expect(
        admitsCredentialKind(capability, "operator"),
        capability.name,
      ).toBe(false);
    }
  });

  test("exactly these entries admit operators: F.3's two, F.2.0b's three administration reads, F.2.3's project settings, F.2.1's routing, F.2.2's agent administration, F.2.4's operations, F.2.5's Slack administration, F.2.6's import review and F.2.7's members", () => {
    const projectSettings = [
      "add_project_alias",
      "add_project_repository",
      "set_default_project_repository",
      "set_project_repository_status",
      "add_project_lane",
      "set_default_project_lane",
      "set_project_lane_status",
      "set_project_member",
      "set_project_work_policy",
      "update_project_metadata",
      "set_project_status",
      "get_administration_project_settings",
    ];
    const routing = [
      "create_routing_rule",
      "update_routing_rule",
      "disable_routing_rule",
      "list_administration_routing_rules",
      "test_administration_route",
      "preview_administration_route",
    ];
    const agentAdministration = [
      "set_agent_principal_status",
      "revoke_agent_credential",
      "revoke_agent_oauth_grant",
      "list_administration_agent_principals",
      "get_administration_agent_principal",
    ];
    const operations = [
      "requeue_outbox",
      "requeue_notification",
      "requeue_slack_operation",
      "requeue_import_dispatch",
      "create_retention_hold",
      "release_retention_hold",
      "list_administration_operations",
      "list_administration_retention_holds",
    ];
    const slackAdministration = [
      "set_slack_user_mapping",
      "set_slack_route",
      "set_slack_installation_status",
      "send_slack_connection_test",
      "get_administration_slack_configuration",
    ];
    const members = [
      "invite_organization_member",
      "set_organization_member",
      "revoke_organization_invitation",
      "resend_organization_invitation",
      "appearance.update_organization_defaults.v1",
      "list_administration_invitations",
      "get_administration_organization_appearance",
    ];
    expect(
      capabilityRegistry
        .filter((capability) => admitsCredentialKind(capability, "operator"))
        .map((capability) => [capability.name, capability.credentialKinds]),
    ).toEqual([
      ["revoke_operator_credential", ["operator"]],
      ["whoami", ["agent", "operator"]],
      ["list_administration_projects", ["operator"]],
      ["list_administration_lanes", ["operator"]],
      ["list_administration_members", ["operator"]],
      ...projectSettings.map((name) => [name, ["operator"]]),
      ...routing.map((name) => [name, ["operator"]]),
      ...agentAdministration.map((name) => [name, ["operator"]]),
      ...operations.map((name) => [name, ["operator"]]),
      ...slackAdministration.map((name) => [name, ["operator"]]),
      ["review_legacy_import_entry", ["operator"]],
      ["split_legacy_import_entry", ["operator"]],
      ["list_administration_import_runs", ["operator"]],
      ["get_administration_import_run", ["operator"]],
      ...members.map((name) => [name, ["operator"]]),
    ]);
  });

  // `manifest-f2.md` §4.1, rule 2: an administration read admits the operator
  // credential and no other, whichever group adds it.
  test("every administration read admits operators alone", () => {
    const reads = capabilityRegistry.filter(
      (capability) =>
        capability.kind === "query" &&
        capability.dispatch.to === "administration-read",
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads)
      expect(read.credentialKinds, read.name).toEqual(["operator"]);
  });

  test("both projections carry it, resolved, for the route and the generator", () => {
    expect(
      findRestCommandTransport("revoke_operator_credential")?.credentialKinds,
    ).toEqual(["operator"]);
    expect(findRestCommandTransport("claim_request")?.credentialKinds).toEqual([
      "agent",
    ]);
    expect(
      restQueryTransports.find((transport) =>
        transport.path.endsWith("/whoami"),
      )?.credentialKinds,
    ).toEqual(["agent", "operator"]);
    expect(
      restQueryTransports.find((transport) =>
        transport.path.endsWith("/events"),
      )?.credentialKinds,
    ).toEqual(["agent"]);
  });

  test("revoke_operator_credential is a REST command only, bound to the credential's organisation", () => {
    const transport = findRestCommandTransport("revoke_operator_credential");
    expect(transport).toMatchObject({
      path: `${restApiBasePath}/commands/revoke_operator_credential`,
      dispatch: {
        to: "command-bus",
        commandName: "revoke_operator_credential",
      },
      injectedFields: [
        { field: "organizationId", from: "credential.organizationId" },
      ],
      routeRequiresProject: false,
      scope: {
        kind: "fixed",
        scope: "operator:revoke",
        checkedBy: "command",
      },
      mcpTool: null,
    });
    expect(transport?.inputSchema).toBe(
      coreCommandInputSchemas.revoke_operator_credential,
    );
    expect(findMcpToolTransport("revoke_operator_credential")).toBeUndefined();
  });

  test("an operator entry requires only scopes an operator may hold", () => {
    for (const capability of capabilityRegistry.filter((entry) =>
      admitsCredentialKind(entry, "operator"),
    )) {
      const scope =
        capability.kind === "query"
          ? capability.scope
          : capability.scope.kind === "fixed"
            ? capability.scope.scope
            : null;
      if (scope !== null)
        expect(operatorScopes, capability.name).toContain(scope);
    }
  });

  test("revoke_operator_credential refuses an operator without operator:revoke for another credential, and passes the scope check with it", async () => {
    const definition = createCoreCommandRegistry().resolve(
      "revoke_operator_credential",
    );
    if (!definition) throw new Error("revoke_operator_credential");
    const input = definition.parse({
      organizationId: ids.organization,
      credentialId: ids.relationship,
    });
    const target = {
      id: ids.relationship,
      organizationId: ids.organization,
      memberUserId: "user_f3",
      projectId: null,
      lineageId: ids.relationship,
      version: 1,
      revokedAt: null,
    };
    const run = async (scopes: string[]) => {
      const context: AuthorizedCommandContext = {
        actor: operatorActor({
          lineageId: ids.installation,
          memberUserId: "user_f3",
        }),
        credentialKind: "operator",
        organizationId: ids.organization,
        projectId: null,
        laneIds: new Set(),
        scopes: new Set(scopes),
        credentialId: ids.session,
        correlationId: "f3-correlation",
      };
      const uow: UnitOfWork = {
        ...unitOfWork(),
        port: <T>() =>
          ({
            lockCredential: async () => target,
            lockMemberRole: async () => null,
            revokeCredential: async () => {
              throw new PortReached("operatorCredentials.revokeCredential");
            },
          }) as T,
      };
      try {
        await definition.authorize(context, input, uow);
        await definition.execute(uow, context, input, {
          idempotencyKey: "f3-idempotency-key-0001",
          expectedVersion: 1,
        });
        return null;
      } catch (error) {
        return error;
      }
    };
    expect(scopeRefused(await run([]))).toBe("operator:revoke");
    const withIt = await run(["operator:revoke"]);
    expect(scopeRefused(withIt)).toBeNull();
    expect(withIt).toBeInstanceOf(PortReached);
  });
});
