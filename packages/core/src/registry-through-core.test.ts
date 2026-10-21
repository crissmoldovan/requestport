import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { Storage } from "@requestport/db";
import {
  type AuthorizedCommandContext,
  admitsCredentialKind,
  agentScopes,
  type CommandCapability,
  type CredentialKind,
  capabilityRegistry,
  DomainError,
  findQueryCapability,
  operatorActor,
  operatorScopes,
  type QueryCapability,
  restCommandTransports,
  restQueryTransports,
} from "@requestport/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * Done when 7 (manifest-g.md §7): every entry of the capability registry,
 * enumerated, run through a RequestPort under each kind of network
 * credential that exists: each command through `execute`, each query
 * through `query`.
 *
 * - A command entry reaches the target its `dispatch` names, in what
 *   RequestPort composed, under each kind `admitsCredentialKind` admits, and
 *   is refused `forbidden` under each kind it excludes, with no target
 *   asked. `execute.test.ts` holds `createCommandExecution` over stand-in
 *   targets, and this file holds it over what `createRequestPort` composes.
 * - A query entry likewise: an administration read reaches its read in
 *   `administrationReads`, handed the storage's handle and the secrets, and
 *   an agent query reaches the agent query its entry dispatches to, with the
 *   context, its project proven, and its path parameters; each is refused
 *   `forbidden`, reading nothing, under the kind it excludes. `whoami` is
 *   the one entry that admits both kinds, so it has no negative case: for
 *   an agent it reads the project's work policy, and for an operator it is
 *   answered from the operator's own context, reading nothing, as the REST
 *   route's GET answered it.
 * - No entry names a kind outside `CredentialKind`.
 * - The two `agent-administration` entries reach their handlers in core in
 *   a process of their own, which loads no module of `@requestport/auth`,
 *   Better Auth or the Trigger.dev SDK (§2.5.1).
 * - The REST route and the MCP route, read as text, hold no dispatch of
 *   their own, and nor do the handlers they compose. Each route composes
 *   `packages/server`'s handlers (Plan 13, H.1), handing them the web's
 *   RequestPort: the REST POST handler hands every command to its `execute`
 *   and the GET handler every query to its `query`, one call each. The MCP
 *   handler runs its registry tools on the RequestPort's command bus, its
 *   query tools on its agent queries and its MCP-only tools on its `mcpOnly`
 *   (ruling 137: "MCP calls core" holds when MCP's bus and queries are the
 *   ones `createRequestPort` composes). A dispatch written back into a route
 *   or a handler can behave exactly as core's does, and then nothing the
 *   route's own suites observe tells the two apart: only its text does.
 *   Turbo does not hash `apps/web` or `packages/server` into this package's
 *   test task, so a cached pass can outlive a change to either; a cold run
 *   (`--force`) re-reads them.
 *
 * The targets RequestPort composes are replaced here by stand-ins that
 * record what reached them: the factories `request-port.ts` composes the
 * off-bus targets from are mocked, the agent query repository's factory is
 * mocked, each administration read is replaced for the case, and the
 * composed bus's `execute` is spied on. So nothing here opens a database,
 * and the storage handed in records what was read from it.
 */

const recorded = vi.hoisted(() => {
  const calls: Array<{ target: string; args: unknown[] }> = [];
  const composed: string[] = [];
  const record =
    (target: string) =>
    async (...args: unknown[]) => {
      calls.push({ target, args });
      return { answeredBy: target };
    };
  return { calls, composed, record };
});

vi.mock("@requestport/db", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const method = (name: string) => recorded.record(`agentQueries.${name}`);
  return {
    ...original,
    createAgentQueryRepository: () => ({
      getAgentPolicy: method("getAgentPolicy"),
      listOrganizations: method("listOrganizations"),
      listProjects: method("listProjects"),
      getProject: method("getProject"),
      listRequests: method("listRequests"),
      getRequest: method("getRequest"),
      listTimeline: method("listTimeline"),
      listOpenQuestions: method("listOpenQuestions"),
      listEvents: method("listEvents"),
    }),
  };
});
vi.mock("./project-registration.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./project-registration.js")>();
  return {
    ...original,
    createProjectRegistration: () => {
      recorded.composed.push("projectRegistration");
      return { register: recorded.record("projectRegistration") };
    },
  };
});
vi.mock("./agent-administration.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./agent-administration.js")>();
  return {
    ...original,
    createAgentAdministration: () => {
      recorded.composed.push("agentAdministration");
      const agentAdministrationHandlers = {
        revoke_agent_credential: recorded.record(
          "agentAdministration.revoke_agent_credential",
        ),
        revoke_agent_oauth_grant: recorded.record(
          "agentAdministration.revoke_agent_oauth_grant",
        ),
      };
      return {
        revokeAgentCredential:
          agentAdministrationHandlers.revoke_agent_credential,
        revokeAgentOauthGrant:
          agentAdministrationHandlers.revoke_agent_oauth_grant,
        agentAdministrationHandlers,
      };
    },
  };
});
vi.mock("./import-split.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./import-split.js")>();
  return {
    ...original,
    createImportSplit: () => {
      recorded.composed.push("importSplit");
      return { splitImportEntry: recorded.record("importSplit") };
    },
  };
});
vi.mock("./slack-connection-test.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./slack-connection-test.js")>();
  return {
    ...original,
    createSlackConnectionTest: () => {
      recorded.composed.push("slackConnectionTest");
      return {
        queueSlackConnectionTest: recorded.record("slackConnectionTest"),
      };
    },
  };
});

const { createRequestPort, requestPortComposition } = await import(
  "./request-port.js"
);
const { administrationReads } = await import("./administration-reads.js");

const organizationId = "018f0000-0000-7000-8000-0000000d0701";
const projectId = "018f0000-0000-7000-8000-0000000d0702";
const meta = { idempotencyKey: "done-when-7-idempotency", expectedVersion: 0 };

function agentContext(): AuthorizedCommandContext {
  return {
    actor: { type: "agent", id: "018f0000-0000-7000-8000-0000000d0703" },
    organizationId,
    projectId,
    scopes: new Set(["request:write"]),
    credentialId: "done-when-7-agent-credential",
    correlationId: "018f0000-0000-7000-8000-0000000d0704",
  };
}

function operatorContext(): AuthorizedCommandContext {
  return {
    actor: operatorActor({
      lineageId: "018f0000-0000-7000-8000-0000000d0705",
      memberUserId: "018f0000-0000-7000-8000-0000000d0706",
    }),
    credentialKind: "operator",
    organizationId,
    projectId,
    scopes: new Set(["agent:revoke"]),
    credentialId: "done-when-7-operator-credential",
    correlationId: "018f0000-0000-7000-8000-0000000d0707",
  };
}

const kinds: readonly CredentialKind[] = ["agent", "operator"];
const contextOf: Record<CredentialKind, () => AuthorizedCommandContext> = {
  agent: agentContext,
  operator: operatorContext,
};

/** A storage that records every member read and refuses every call. */
function recordingStorage() {
  const touched: string[] = [];
  const db = { name: "application" };
  const storage = new Proxy({} as Storage, {
    get(_target, property) {
      touched.push(String(property));
      if (property === "db") return db;
      return () => {
        throw new Error(`storage.${String(property)} was called`);
      };
    },
  });
  return { storage, touched };
}

/**
 * A RequestPort over a recording storage, whose composed bus records each
 * command it is handed in place of running it.
 */
function requestPort() {
  const { storage, touched } = recordingStorage();
  const port = createRequestPort({
    storage,
    secrets: {
      commandFingerprintKey: "done-when-7-signing-material-0000000000001",
      operatorCredentials: "enabled",
    },
    publicUrl: "https://requestport.test",
  });
  vi.spyOn(
    requestPortComposition(port).commandBus,
    "execute",
  ).mockImplementation(recorded.record("commandBus") as never);
  return { port, touched };
}

/** The target, and its arguments, a command entry must reach. */
function expectedCall(
  entry: CommandCapability,
  context: AuthorizedCommandContext,
  input: Record<string, unknown>,
) {
  const { dispatch } = entry;
  switch (dispatch.to) {
    case "command-bus":
      return {
        target: "commandBus",
        args: [{ name: dispatch.commandName, input, context, meta }],
      };
    case "project-registration-repository":
      return { target: "projectRegistration", args: [context, input, meta] };
    case "agent-administration":
      return {
        target: `agentAdministration.${dispatch.handler}`,
        args: [context, input, meta],
      };
    case "import-split":
      return { target: "importSplit", args: [context, input, meta] };
    case "slack-connection-test":
      return { target: "slackConnectionTest", args: [context, input, meta] };
  }
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("execute was not refused");
}

const commands = capabilityRegistry.filter(
  (capability): capability is CommandCapability =>
    capability.kind === "command",
);
const queries = capabilityRegistry.filter(
  (capability): capability is QueryCapability => capability.kind === "query",
);

beforeEach(() => {
  recorded.calls.length = 0;
  recorded.composed.length = 0;
});

describe("the capability registry, enumerated (Done when 7)", () => {
  test("every entry is a command REST serves over POST or a query it serves over GET, each name held once", () => {
    const names = capabilityRegistry.map((capability) => capability.name);
    expect(new Set(names).size).toBe(names.length);
    expect(commands.length + queries.length).toBe(capabilityRegistry.length);
    expect(commands.map((entry) => entry.name)).toEqual(
      restCommandTransports.map((transport) => transport.name),
    );
    expect(queries.map((entry) => entry.rest.path)).toEqual(
      restQueryTransports.map((transport) => transport.path),
    );
  });

  test("no entry names a kind outside CredentialKind, and whoami alone admits both, so it has no negative case: both admissions are asserted, and every other entry excludes exactly one kind", () => {
    for (const capability of capabilityRegistry) {
      for (const kind of capability.credentialKinds ?? [])
        expect(kinds, capability.name).toContain(kind);
    }
    const whoami = findQueryCapability("whoami");
    if (!whoami) throw new Error("the registry holds no whoami");
    expect(admitsCredentialKind(whoami, "agent")).toBe(true);
    expect(admitsCredentialKind(whoami, "operator")).toBe(true);
    expect(
      capabilityRegistry
        .filter((capability) =>
          kinds.every((kind) => admitsCredentialKind(capability, kind)),
        )
        .map((capability) => capability.name),
    ).toEqual(["whoami"]);
    for (const capability of capabilityRegistry) {
      if (capability === whoami) continue;
      expect(
        kinds.filter((kind) => !admitsCredentialKind(capability, kind)),
        capability.name,
      ).toHaveLength(1);
    }
  });
});

describe("every registry command, through a RequestPort", () => {
  test("RequestPort composes each off-bus target once, from its factory, and reads only its storage's handle", () => {
    const { port, touched } = requestPort();

    requestPortComposition(port);

    expect([...recorded.composed].sort()).toEqual([
      "agentAdministration",
      "importSplit",
      "projectRegistration",
      "slackConnectionTest",
    ]);
    expect(touched).toEqual(["db"]);
  });

  test.each(
    commands.flatMap((entry) =>
      kinds.map((kind) => [entry.name, kind, entry] as const),
    ),
  )(
    "%s, for an %s credential: reaches its dispatch target in what RequestPort composed exactly when admitsCredentialKind admits it, and is refused before any target otherwise",
    async (name, kind, entry) => {
      const { port, touched } = requestPort();
      const context = contextOf[kind]();
      const input = { marker: `${name}-input` };

      const outcome = port.execute(name, input, {
        context,
        credentialKind: kind,
        meta,
      });

      if (admitsCredentialKind(entry, kind)) {
        const expected = expectedCall(entry, context, input);
        await expect(outcome).resolves.toEqual({
          answeredBy: expected.target,
        });
        expect(recorded.calls).toEqual([expected]);
      } else {
        const error = await refusal(outcome);
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({
          code: "forbidden",
          message: "This kind of credential is not admitted to this command",
        });
        expect(recorded.calls).toEqual([]);
      }
      expect(touched).toEqual(["db"]);
    },
  );
});

/** The agent query each `agent-query-repository` entry runs, and its arguments past the context. */
const agentQueryCalls: Readonly<
  Record<string, { method: string; args: readonly unknown[] }>
> = {
  whoami: { method: "getAgentPolicy", args: [] },
  list_organizations: { method: "listOrganizations", args: [] },
  list_projects: { method: "listProjects", args: [] },
  get_project: { method: "getProject", args: ["projectId-value"] },
  list_requests: {
    method: "listRequests",
    args: [{ cursor: undefined, limit: undefined, state: [] }],
  },
  get_request_timeline: {
    method: "listTimeline",
    args: ["requestId-value", undefined],
  },
  get_request: { method: "getRequest", args: ["requestId-value"] },
  list_open_questions: { method: "listOpenQuestions", args: [undefined] },
  list_events: { method: "listEvents", args: [undefined] },
};

/** A context for each kind, holding every scope that kind may hold. */
function queryContextOf(kind: CredentialKind) {
  return kind === "agent"
    ? {
        ...agentContext(),
        scopes: new Set<string>(agentScopes),
        laneIds: new Set<string>(),
        audience: "api",
        authorizationId: "done-when-7-agent-credential",
      }
    : {
        ...operatorContext(),
        scopes: new Set<string>(operatorScopes),
        authorizationId: "done-when-7-operator-credential",
      };
}

describe("every registry query, through a RequestPort", () => {
  const reads = administrationReads as Record<
    string,
    (input: unknown) => Promise<unknown>
  >;
  const originals = { ...reads };

  beforeEach(() => {
    for (const name of Object.keys(originals))
      reads[name] = recorded.record(`administrationRead.${name}`);
  });
  afterEach(() => {
    Object.assign(reads, originals);
  });

  test("every agent query entry has its expected call here, so a new one cannot pass unlisted", () => {
    expect(
      queries
        .filter((entry) => entry.dispatch.to === "agent-query-repository")
        .map((entry) => entry.name),
    ).toEqual(Object.keys(agentQueryCalls));
  });

  test.each(
    queries.flatMap((entry) =>
      kinds.map((kind) => [entry.name, kind, entry] as const),
    ),
  )(
    "%s, for an %s credential: reaches its dispatch target in what RequestPort composed exactly when admitsCredentialKind admits it, and is refused before any target otherwise",
    async (name, kind, entry) => {
      const { port, touched } = requestPort();
      const context = queryContextOf(kind);
      const pathParameters = Object.fromEntries(
        entry.rest.pathParameters.map((parameter) => [
          parameter,
          `${parameter}-value`,
        ]),
      );
      const searchParams = new URLSearchParams();

      const outcome = port.query(
        name,
        { pathParameters, searchParams },
        { context, credentialKind: kind },
      );

      if (!admitsCredentialKind(entry, kind)) {
        const error = await refusal(outcome);
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({ code: "forbidden" });
        expect(recorded.calls).toEqual([]);
      } else if (entry.dispatch.to === "administration-read") {
        await expect(outcome).resolves.toEqual({
          answeredBy: `administrationRead.${entry.dispatch.method}`,
        });
        expect(recorded.calls).toEqual([
          {
            target: `administrationRead.${entry.dispatch.method}`,
            args: [
              {
                context,
                pathParameters,
                searchParams,
                reading: {
                  database: { name: "application" },
                  secrets: expect.objectContaining({
                    operatorCredentials: "enabled",
                  }),
                },
              },
            ],
          },
        ]);
      } else if (kind === "operator") {
        // whoami, the one agent query an operator is admitted to, is
        // answered from the operator's own context, reading nothing.
        expect(name).toBe("whoami");
        await expect(outcome).resolves.toMatchObject({
          actor: context.actor,
          credentialKind: "operator",
          serverSchemaVersion: 1,
        });
        expect(recorded.calls).toEqual([]);
      } else {
        const expected = agentQueryCalls[name];
        if (!expected) throw new Error(`no expected call for ${name}`);
        const answered = await outcome;
        expect(recorded.calls).toEqual([
          {
            target: `agentQueries.${expected.method}`,
            args: [{ ...context, projectId }, ...expected.args],
          },
        ]);
        if (name === "whoami")
          expect(answered).toMatchObject({
            workPolicy: { answeredBy: "agentQueries.getAgentPolicy" },
          });
        else
          expect(answered).toEqual({
            answeredBy: `agentQueries.${expected.method}`,
          });
      }
      expect(touched).toEqual(["db"]);
    },
  );
});

/*
 * The two agent revocations, run through a RequestPort in a child process
 * that starts with an empty environment, as `env -i` starts one. The child
 * registers tsx, resolved from packages/jobs as `import.test.ts`'s child does,
 * and tsx reports every module it loads (`onImport`). The storage's
 * `transaction` records the command that opened it and rejects, so each
 * handler is followed until it opens its one transaction on the caller's
 * storage. Each input is valid for its own handler only (a credential's id,
 * or a grant's id and a reason), so a handler handed the other's input
 * refuses it as it parses, before any transaction.
 */
describe("the two agent-administration entries, in a process of their own", () => {
  test("reach their handlers in core, which each open one transaction on the caller's storage, with no module of @requestport/auth, Better Auth or the Trigger.dev SDK loaded", {
    timeout: 120_000,
  }, () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const child = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "--eval",
        revocationProbe(join(repositoryRoot, "packages/jobs/package.json")),
      ],
      {
        cwd: packageRoot,
        env: {},
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 100_000,
      },
    );

    expect({ status: child.status, stderr: child.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    const report = JSON.parse(child.stdout) as {
      outcomes: Record<string, string>;
      opened: string[];
      loaded: string[];
    };
    const loaded = [
      ...new Set(
        report.loaded
          .filter((url) => url.startsWith("file:"))
          .map((url) => fileURLToPath(url)),
      ),
    ];
    const ours = loaded
      .filter((path) => !path.includes("/node_modules/"))
      .map((path) => relative(repositoryRoot, path));

    expect(report.outcomes).toEqual({
      revoke_agent_credential: "the storage's transaction was opened",
      revoke_agent_oauth_grant: "the storage's transaction was opened",
    });
    expect(report.opened).toEqual([
      "revoke_agent_credential",
      "revoke_agent_oauth_grant",
    ]);
    expect(ours).toEqual(
      expect.arrayContaining([
        "packages/core/src/agent-administration.ts",
        "packages/core/src/agent-services/api-key-service.ts",
        "packages/core/src/agent-services/agent-grant-service.ts",
      ]),
    );
    expect(
      loaded.filter(
        (path) =>
          /\/node_modules\/(?:better-auth|@better-auth\/[^/]+|@trigger\.dev\/[^/]+)\//u.test(
            path,
          ) || relative(repositoryRoot, path).startsWith("packages/auth/"),
      ),
    ).toEqual([]);
  });
});

/**
 * The program the revocations' child runs (above). It registers tsx,
 * resolved from `jobsManifest`'s package, imports core and the domain by
 * their names, runs each revocation through a RequestPort over a storage
 * whose `transaction` records and rejects, and writes one line of JSON: how
 * each call ended, the commands that opened a transaction, and every module
 * tsx loaded.
 */
function revocationProbe(jobsManifest: string) {
  return [
    'import { createRequire } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `const jobsRequire = createRequire(${JSON.stringify(jobsManifest)});`,
    'const { register } = await import(pathToFileURL(jobsRequire.resolve("tsx/esm/api")).href);',
    "const loaded = [];",
    "register({ onImport: (url) => loaded.push(url) });",
    'const { createRequestPort } = await import("@requestport/core");',
    'const { operatorActor } = await import("@requestport/domain");',
    "const opened = [];",
    "let running;",
    "const storage = {",
    "  db: {},",
    "  async transaction() {",
    "    opened.push(running);",
    `    throw new Error("the storage's transaction was opened");`,
    "  },",
    "};",
    "const port = createRequestPort({",
    "  storage,",
    '  secrets: { commandFingerprintKey: "done-when-7-signing-material-0000000000001", operatorCredentials: "enabled" },',
    '  publicUrl: "https://requestport.test",',
    "});",
    `const organizationId = ${JSON.stringify(organizationId)};`,
    "const context = {",
    `  actor: operatorActor({ lineageId: "018f0000-0000-7000-8000-0000000d0705", memberUserId: "018f0000-0000-7000-8000-0000000d0706" }),`,
    '  credentialKind: "operator",',
    "  organizationId,",
    "  projectId: null,",
    '  scopes: new Set(["agent:revoke"]),',
    '  credentialId: "done-when-7-operator-credential",',
    '  correlationId: "018f0000-0000-7000-8000-0000000d0707",',
    "};",
    `const meta = ${JSON.stringify(meta)};`,
    "const commands = [",
    '  ["revoke_agent_credential", { organizationId, agentPrincipalId: "018f0000-0000-7000-8000-0000000d0708", credentialId: "018f0000-0000-7000-8000-0000000d0709" }],',
    '  ["revoke_agent_oauth_grant", { organizationId, agentPrincipalId: "018f0000-0000-7000-8000-0000000d0708", grantId: "018f0000-0000-7000-8000-0000000d070a", reason: "The laptop holding it was lost" }],',
    "];",
    "const outcomes = {};",
    "for (const [name, input] of commands) {",
    "  running = name;",
    "  try {",
    '    await port.execute(name, input, { context, credentialKind: "operator", meta });',
    '    outcomes[name] = "resolved";',
    "  } catch (error) {",
    "    outcomes[name] = String(error?.message ?? error);",
    "  }",
    "}",
    // tsx reports each load over a message port: wait until no report has
    // arrived for three turns of the timer.
    "for (let quiet = 0, seen = -1; quiet < 3; ) {",
    "  await new Promise((resolve) => setTimeout(resolve, 50));",
    "  quiet = loaded.length === seen ? quiet + 1 : 0;",
    "  seen = loaded.length;",
    "}",
    "process.stdout.write(JSON.stringify({ outcomes, opened, loaded }));",
  ].join("\n");
}

/** A file of the repository, by its path from the root, with its comments blanked. */
function code(path: string) {
  return withoutComments(
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"),
  );
}

describe("the REST and MCP handlers, and the routes that compose them, read as text", () => {
  // Since Plan 13, H.1 the REST route's bodies are `packages/server`'s
  // `handleRestQuery` and `handleRestCommand`, which the route composes from
  // the web's own collaborators (ruling 147).
  const rest = code("packages/server/src/rest.ts");
  const getAt = rest.indexOf("export async function handleRestQuery(");
  const postAt = rest.indexOf("export async function handleRestCommand(");
  const get = rest.slice(getAt, postAt);
  const post = rest.slice(postAt);
  const route = code("apps/web/src/app/api/v1/[[...path]]/route.ts");
  const routeGetAt = route.indexOf("export async function GET(");
  const routePostAt = route.indexOf("export async function POST(");
  /** Every call of `name` in `text`, by the first 60 characters from it. */
  const calls = (text: string, name: string) =>
    [...text.matchAll(new RegExp(`(?<![\\w$])${name}\\(`, "gu"))].map((match) =>
      text.slice(match.index, match.index + 60),
    );
  /** What `text` names of the dispatch core holds. */
  const dispatchNames = (text: string) =>
    [
      ...text.matchAll(
        /\.dispatch\b|\bdispatch\s*\.|\bcoreCommandBus\b|\bprojectRegistration\b|\bagentAdministrationHandlers\b|\bsplitImportEntry\b|\bqueueSlackConnectionTest\b|\bcreateCommandExecution\b|\bcreateAgentQueryRepository\b|\bagentQueryRepository\b|\brequireQueryScope\b|\breadAdministration\b|\boperatorQuery\b|\bcreateQueryExecution\b/gu,
      ),
    ].map((match) => match[0]);

  test("the POST handler hands every command to its RequestPort's execute, in one call, and holds no dispatch of its own", () => {
    expect(getAt).toBeGreaterThan(0);
    expect(postAt).toBeGreaterThan(getAt);
    expect(calls(post, "execute")).toEqual([
      expect.stringMatching(/^execute\(\s*transport\.name,\s*commandInput,/u),
    ]);
    expect(post).toMatch(/options\s*\.requestPort\(\)\s*\.execute\(/u);
    expect(dispatchNames(post)).toEqual([]);
  });

  test("the GET handler hands every path to core's resolveRestQuery and every query to its RequestPort's query, in one call each, and holds no dispatch of its own", () => {
    expect(rest).toMatch(
      /import\s*\{\s*resolveRestQuery\s*\}\s*from\s*"@requestport\/core\/adapters"/u,
    );
    expect(calls(get, "resolveRestQuery")).toEqual([
      expect.stringMatching(/^resolveRestQuery\(parts, context\)/u),
    ]);
    expect(calls(get, "query")).toEqual([
      expect.stringMatching(/^query\(\s*name,/u),
    ]);
    const queried = /options\s*\.requestPort\(\)\s*\.query\(/u;
    expect(get).toMatch(queried);
    expect(get.indexOf("resolveRestQuery(")).toBeLessThan(get.search(queried));
    expect(get).not.toMatch(/\bwithProject\b|\bparts\[\d\]/u);
    expect(dispatchNames(get)).toEqual([]);
  });

  test("the handlers' module composes and names no dispatch of its own anywhere, outside its handlers too", () => {
    expect(dispatchNames(rest)).toEqual([]);
  });

  test("the REST route composes the two handlers, handing them the web's RequestPort to ask for, and names no dispatch, no query and no command of its own", () => {
    expect(route).toMatch(
      /import\s*\{\s*handleRestCommand,\s*handleRestQuery,[^}]*\}\s*from\s*"@requestport\/server\/rest"/u,
    );
    expect(route).toMatch(
      /import\s*\{\s*webRequestPort\s*\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/lib\/server-web-request-port\.js"/u,
    );
    expect(routeGetAt).toBeGreaterThan(0);
    expect(routePostAt).toBeGreaterThan(routeGetAt);
    expect(
      calls(route.slice(routeGetAt, routePostAt), "handleRestQuery"),
    ).toEqual([expect.stringMatching(/^handleRestQuery\(\s*request,/u)]);
    expect(calls(route.slice(routePostAt), "handleRestCommand")).toEqual([
      expect.stringMatching(/^handleRestCommand\(\s*request,/u),
    ]);
    expect(route).toMatch(/\brequestPort: webRequestPort,/u);
    for (const name of [
      "webRequestPort",
      "execute",
      "query",
      "resolveRestQuery",
      "findRestCommandTransport",
    ])
      expect(calls(route, name), name).toEqual([]);
    expect(dispatchNames(route)).toEqual([]);
  });

  test("the MCP handler runs its registry tools on its RequestPort's command bus, its queries on its agent queries, and its MCP-only tools on its mcpOnly", () => {
    // Since Plan 13, H.1 the MCP route's body is `packages/server`'s
    // `handleMcp`, which asks for the RequestPort it is handed once a request
    // is admitted (ruling 147).
    const mcp = code("packages/server/src/mcp.ts");

    expect(calls(mcp, "requestPort")).toEqual([
      expect.stringMatching(/^requestPort\(\);/u),
    ]);
    expect(mcp).toMatch(/const port = options\.requestPort\(\);/u);
    expect(mcp).toMatch(/\bcommandBus: port\.commandBus,/u);
    expect(mcp).toMatch(/\bqueries: port\.agentQueries,/u);
    for (const member of [
      "port.mcpOnly.createProject(",
      "port.mcpOnly.provisionAgent(",
      "port.mcpOnly.webhooks;",
      "port.mcpOnly.imports;",
    ])
      expect(mcp, member).toContain(member);
    // The handler builds no repository, transaction or composition of its own.
    expect(
      [
        ...mcp.matchAll(
          /\bcoreCommandBus\b|\bwebStorage\b|\bcreate\w+Repository\b|\bbound\w+Repository\b|\bcreateProjectRegistration\b|\bcreateLegacyImportAnalysis\b|\bcreateProjectProvisioning\b|\bcreateWebhookManagement\b|\.transaction\(/gu,
        ),
      ].map((match) => match[0]),
    ).toEqual([]);
    expect(dispatchNames(mcp)).toEqual([]);
  });

  test("the MCP route composes the handler, handing it the web's RequestPort to ask for, once, and names no dispatch, no bus and no capability of its own", () => {
    const route = code("apps/web/src/app/mcp/route.ts");

    expect(route).toMatch(
      /import\s*\{[^}]*\bhandleMcp\b[^}]*\}\s*from\s*"@requestport\/server\/mcp"/u,
    );
    expect(route).toMatch(
      /import\s*\{\s*webRequestPort\s*\}\s*from\s*"\.\.\/\.\.\/lib\/server-web-request-port\.js"/u,
    );
    expect(calls(route, "handleMcp")).toEqual([
      expect.stringMatching(/^handleMcp\(\s*request,/u),
    ]);
    expect(calls(route, "webRequestPort")).toEqual([
      expect.stringMatching(/^webRequestPort\(\),/u),
    ]);
    expect(route).toMatch(/\brequestPort: \(\) => webRequestPort\(\),/u);
    expect(
      [
        ...route.matchAll(
          /\bcommandBus\b|\bagentQueries\b|\bmcpOnly\b|\bhandleMcpRequest\b|\.execute\(|\bcoreCommandBus\b|\bwebStorage\b|\bcreate\w+Repository\b|\.transaction\(/gu,
        ),
      ].map((match) => match[0]),
    ).toEqual([]);
    expect(dispatchNames(route)).toEqual([]);
  });
});

/**
 * `source` with its comments blanked to spaces, so that what the pin reads
 * is code. Strings and template literals are kept whole, so a `//` inside one
 * is not taken for a comment. A regular expression literal holding a quote
 * or a comment's opening would be misread; the REST handlers' module has
 * two and the MCP handler's module three, and none of them holds either.
 */
function withoutComments(source: string) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - index);
      index = stop;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/gu, " ");
      index = stop;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < source.length && source[end] !== char) {
        end += source[end] === "\\" ? 2 : 1;
      }
      out += source.slice(index, end + 1);
      index = end + 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}
