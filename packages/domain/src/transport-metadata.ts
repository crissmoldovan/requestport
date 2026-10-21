import { type ZodType, z } from "zod";

import {
  type AgentAdministrationHandlerName,
  agentAdministrationInputSchemas,
} from "./agents/agent-commands.js";
import {
  coreCommandInputSchemas,
  requestActionScopes,
} from "./core/core-commands.js";
import {
  importReviewScope,
  splitImportEntryInputSchema,
} from "./imports/import-review-commands.js";
import { agentRevokeScope } from "./operators/operator-types.js";
import { projectRegistrationInputSchema } from "./projects/project-registration-schema.js";
import { requestStates } from "./requests/request-types.js";
import { requestPriorities, requestTypes } from "./routing/routing-types.js";
import {
  slackAdministrationScope,
  slackConnectionTestInputSchema,
} from "./slack/slack-administration-commands.js";

/**
 * The capability registry: every capability REST exposes, entered once, with
 * the command it dispatches (or the target off the command bus), its input
 * schema, the scope it requires, its REST transport and its MCP tool (Plan 13,
 * F.1). It is not yet every capability a machine caller reaches: the MCP tools
 * no REST path exposes are not entered, and are named in `mcpOnlyTools` at the
 * end of this file instead.
 *
 * `restCommandTransports` and `restQueryTransports` are projections of it, not
 * a second declaration, and `scripts/generate-openapi.mjs` writes the OpenAPI
 * document from them. The `/api/v1` route's POST handler
 * (`handleRestCommand` in `packages/server/src/rest.ts`, which the route,
 * `apps/web/src/app/api/v1/[[...path]]/route.ts`, composes) finds each
 * command here, through `findRestCommandTransport`, and follows its entry: the fields it
 * injects, whether it requires a project, and where it dispatches. The MCP
 * server (`packages/mcp/src/server.ts`) registers each tool an entry names
 * through `mcpToolTransports`, taking the scope that gates it and, for a
 * command, where it dispatches; `packages/mcp/src/server.registry.test.ts`
 * holds it to them at runtime. The route's GET handler hands each path to
 * core's `resolveRestQuery` (`packages/core/src/query.ts`), which finds the
 * entry here that the path names, and the query to its RequestPort's
 * `query`, which hands an administration entry, under the administration
 * prefix, to core's dispatch (`packages/core/src/administration-reads.ts`);
 * `route.administration.test.ts` runs the route there. For every other entry
 * core's dispatch is a switch over the agent queries, and it takes each
 * query's scope from its entry through `findQueryCapability`.
 * `route.registry.test.ts` runs it over every path built from the registry's
 * own segments and an id, up to four segments long, and over each registry
 * path with one segment added, removed or replaced: a path no entry holds
 * must answer 404 having read nothing, and a path one entry holds must be
 * read by that entry's repository method alone. What that run never sends —
 * a segment no entry uses, a longer path, a query parameter — is held by
 * `transport-metadata.test.ts` reading the handler's source: the segments it
 * compares, the query names it asks for and the parameters it reads. Paths
 * under the administration prefix are also run, in
 * `route.administration.test.ts`.
 *
 * Response bodies are not recorded. A command answers `{ result }` where
 * `result` is the command's own output, and no command declares an output
 * schema; the GET answers are repository rows with no schema either.
 */
export const restApiBasePath = "/api/v1";

/**
 * The prefix of every administration read (Plan 13, F.2.0; ruling 4): the
 * reads an operator's writes take their identifiers and versions from. Each
 * is REST only (ruling 2), and no agent query path lies under it.
 */
export const administrationBasePath = `${restApiBasePath}/administration`;

/**
 * The envelope every POST command body must be: `{ input, idempotencyKey,
 * expectedVersion }`, strict, where `input` is an object checked against the
 * command's schema after the injected fields are written into it. The route
 * declares these inline; this is the same pair of constraints.
 */
export const restCommandEnvelopeFields = {
  idempotencyKey: z.string().min(16).max(200),
  expectedVersion: z.number().int().nonnegative(),
} as const;

/** The fifteen request lifecycle actions REST exposes as their own names. */
export const requestLifecycleActions = [
  "submit_request",
  "begin_triage",
  "accept_request",
  "decline_request",
  "mark_duplicate",
  "supersede_request",
  "plan_request",
  "begin_request_work",
  "block_request",
  "resume_request",
  "withdraw_request",
  "cancel_request",
  "reopen_request",
  "complete_request",
  "verify_request",
] as const;

export type RequestLifecycleAction = (typeof requestLifecycleActions)[number];

/**
 * A field the route writes into the command input after spreading the
 * caller's, so a value the caller sends for it is overwritten, never trusted.
 * The command's schema still declares and validates it; a generator describing
 * what a caller sends should strip these.
 */
export type RestInjectedField =
  | { field: string; from: "credential.organizationId" }
  | { field: string; from: "credential.projectId" }
  | { field: string; from: "constant"; value: string };

/**
 * The scope a command requires. Necessary, never sufficient: after it the
 * command still checks roles, claims, project and lane bindings and actor
 * type, none of which is recorded here. One exemption, named at its entry:
 * `revoke_operator_credential` lets a credential revoke itself with no scope.
 *
 * `checkedBy` says where the check runs. `command` is the domain command's
 * `authorize` or `execute`; `project-registration-repository` is
 * `projectRegistrationRepository.register` in `@requestport/db`, off the
 * command bus; `agent-auth-service` is the agent key or grant service in
 * `@requestport/core/agent-services` (`revoke` of `createAgentApiKeyService`,
 * `revokeGrant` of `createAgentGrantService`), which `@requestport/auth`
 * re-exports and the agent administration handler builds and calls, also off
 * the bus (Plan 13, F.2.2); `import-split-handler`
 * is the import split's handler, `splitImportEntry` of `createImportSplit` in
 * `packages/core/src/import-split.ts`, also off the bus, which checks it
 * through `importReviewTarget` (Plan 13, F.2.6);
 * `slack-connection-test-handler` is the Slack connection test's handler,
 * `queueSlackConnectionTest` of `createSlackConnectionTest` in
 * `packages/core/src/slack-connection-test.ts`, also off the bus, which
 * checks it through `slackAdministrationTarget` (Plan 13, F.2.5). The web
 * reaches all three handlers through its RequestPort, which opens their
 * transactions on the web root's storage (Plan 13, G.6).
 */
export type CapabilityScopeRequirement =
  | {
      kind: "fixed";
      scope: string;
      checkedBy:
        | "command"
        | "project-registration-repository"
        | "agent-auth-service"
        | "import-split-handler"
        | "slack-connection-test-handler";
    }
  | {
      kind: "by-action";
      field: "action";
      scopes: Readonly<Record<RequestLifecycleAction, string>>;
      checkedBy: "command";
    };

/**
 * A kind of machine credential REST authenticates: an agent's (`rp_` keys and
 * OAuth grants) or an operator's (`rpo_` keys, Plan 13, F.3). A capability's
 * entry names the kinds REST admits to it in `credentialKinds`; an entry that
 * omits it admits agents only, so an entry nobody decided about can never
 * admit an operator (ruling 25). The route refuses a credential of a kind the
 * entry does not name with 403, after authentication and before anything
 * else. It is the only admission list: there is no second one by path.
 */
export type CredentialKind = "agent" | "operator";

const agentsOnly: readonly CredentialKind[] = ["agent"];

/**
 * Whether REST admits a credential of `kind` to an entry, or to either of its
 * projections: the kinds it names, or agents only when it names none.
 */
export function admitsCredentialKind(
  entry: { credentialKinds?: readonly CredentialKind[] },
  kind: CredentialKind,
) {
  return (entry.credentialKinds ?? agentsOnly).includes(kind);
}

/**
 * The MCP tool that reaches the same capability. `action` is set when the
 * tool is the generic `transition_request` with that action. `actions` is set
 * on the generic REST `transition_request` only: the MCP tool of that name
 * admits fewer actions than REST does (REST admits all fifteen), and it is
 * registered under one scope, which is the REST scope of each action it
 * admits. `registeredWhen` names a condition beyond the one every MCP command
 * tool has — that the credential holds the tool's scope, without which it is
 * not listed at all.
 */
export interface McpToolReference {
  name: string;
  action?: RequestLifecycleAction;
  actions?: readonly RequestLifecycleAction[];
  registeredWhen?: string;
}

/**
 * Where a command runs: a domain command on the bus, or off the bus. Each
 * off-bus handler is `@requestport/core`'s since Plan 13, G.6, and core's
 * `createCommandExecution` dispatches to it. Plan 13, F.2.2:
 * `agent-administration` is one of the two agent revocations, whose handler
 * (`packages/core/src/agent-administration.ts`) keeps the key and grant
 * services' own receipts and re-checks the credential in its own transaction;
 * `handler` names it in the `agentAdministrationHandlers` that module's
 * `createAgentAdministration` returns. Plan 13, F.2.6: `import-split` is the
 * import split, whose handler
 * (`packages/core/src/import-split.ts`, `splitImportEntry`) cuts the record
 * with a parser the domain cannot import, keeps the repository's own receipt
 * and re-checks the credential in its own transaction. Plan 13, F.2.5:
 * `slack-connection-test` is the Slack connection test, whose handler
 * (`packages/core/src/slack-connection-test.ts`, `queueSlackConnectionTest`)
 * starts a task once its own transaction has committed, keeps the
 * repository's operation key as its idempotency and re-checks the credential
 * in that transaction.
 */
export type CommandDispatch =
  | {
      to: "command-bus";
      commandName: keyof typeof coreCommandInputSchemas;
    }
  | { to: "project-registration-repository" }
  | { to: "agent-administration"; handler: AgentAdministrationHandlerName }
  | { to: "import-split" }
  | { to: "slack-connection-test" };

/** How REST reaches a command: `POST <path>` with the command envelope. */
export interface RestCommandRoute {
  method: "POST";
  path: string;
  injectedFields: readonly RestInjectedField[];
  /**
   * True when the route itself refuses a credential bound to no project (a
   * provisioning grant) before dispatch. When false the command may still
   * refuse one; that is the command's decision, not the route's.
   */
  routeRequiresProject: boolean;
  rateLimitClass: "mutation";
}

export interface CommandCapability {
  kind: "command";
  /** The last REST path segment, and the name a caller knows the command by. */
  name: string;
  dispatch: CommandDispatch;
  /** The schema the dispatch target checks `input` against. */
  inputSchema: ZodType;
  scope: CapabilityScopeRequirement;
  rest: RestCommandRoute;
  mcpTool: McpToolReference | null;
  /** The credentials REST admits; absent means agents only. */
  credentialKinds?: readonly CredentialKind[];
}

/**
 * The `agentQueryRepository` methods core's query dispatch reaches, through
 * the RequestPort's agent queries (`packages/core/src/query.ts`).
 */
export type AgentQueryMethod =
  | "getAgentPolicy"
  | "listOrganizations"
  | "listProjects"
  | "getProject"
  | "listRequests"
  | "listTimeline"
  | "getRequest"
  | "listOpenQuestions"
  | "listEvents";

/**
 * The administration reads, by the name each is dispatched under, which is
 * the read's own name (`administrationRead` below). One line per read: an
 * append point, where two appends keep both lines.
 */
export type AdministrationReadName =
  // F.2.0b, the three shared reads (`manifest-f2.md` §4.1).
  | "list_administration_projects"
  | "list_administration_lanes"
  | "list_administration_members"
  // Plan 13, F.2.3.
  | "get_administration_project_settings"
  // Plan 13, F.2.1: the routing rules read, and route evaluation's two
  // purposes.
  | "list_administration_routing_rules"
  | "test_administration_route"
  | "preview_administration_route"
  // Plan 13, F.2.2.
  | "list_administration_agent_principals"
  | "get_administration_agent_principal"
  // Plan 13, F.2.4.
  | "list_administration_operations"
  | "list_administration_retention_holds"
  // Plan 13, F.2.5.
  | "get_administration_slack_configuration"
  // Plan 13, F.2.6.
  | "list_administration_import_runs"
  | "get_administration_import_run"
  // Plan 13, F.2.7.
  | "list_administration_invitations"
  | "get_administration_organization_appearance";

/**
 * Where a query reads. `method` is what the target is called with: an
 * `agentQueryRepository` method, or the name of an administration read. The
 * field has one name on both targets, so a reader that only records the
 * method need not ask which target it has.
 */
export type QueryDispatch =
  | { to: "agent-query-repository"; method: AgentQueryMethod }
  | { to: "administration-read"; method: AdministrationReadName };

/**
 * Which credentials a query answers, by their binding. `project`: only a
 * credential bound to a project, and only about that project; every agent
 * query is bound so. `organization`: only a credential bound to no project.
 * `organization-or-project`: either, a project-bound one seeing its own
 * project's rows only. The second and third are the administration reads'
 * (`manifest-f2.md` §4.1, rule 7).
 */
export type QueryBinding =
  | "project"
  | "organization"
  | "organization-or-project";

/**
 * How REST reaches a query: `GET <path>`. An operator admitted to an agent
 * query (Plan 13, F.3) is answered by the route's operator branch, which never
 * runs the agent path's project check; today that is `whoami` alone, answered
 * from the operator's own context.
 */
export interface RestQueryRoute {
  method: "GET";
  /** With `{name}` for each path parameter. */
  path: string;
  /** The names in braces in `path`, in order. */
  pathParameters: readonly string[];
  queryParameters: readonly RestQueryParameter[];
  /** True exactly when the query's binding is `project`. */
  routeRequiresProject: boolean;
  rateLimitClass: "token";
}

export interface QueryCapability {
  kind: "query";
  /**
   * The name a caller knows the read by. For an agent query it is also the
   * name of the MCP tool that reads the same thing.
   */
  name: string;
  dispatch: QueryDispatch;
  binding: QueryBinding;
  /**
   * Checked by the route before it reads. Null for `whoami`, which every
   * credential it admits reaches: any agent credential bound to a project, and
   * any operator credential.
   */
  scope: string | null;
  rest: RestQueryRoute;
  /** Null for an administration read, which is REST only (ruling 2). */
  mcpTool: McpToolReference | null;
  /** The credentials REST admits; absent means agents only. */
  credentialKinds?: readonly CredentialKind[];
}

export type Capability = CommandCapability | QueryCapability;

/** A command as the REST route and the OpenAPI generator read it. */
export interface RestCommandTransport {
  /** The last path segment, and the name a caller knows the command by. */
  name: string;
  method: "POST";
  path: string;
  dispatch: CommandDispatch;
  /** The schema the dispatch target checks `input` against. */
  inputSchema: ZodType;
  injectedFields: readonly RestInjectedField[];
  scope: CapabilityScopeRequirement;
  /** As `RestCommandRoute.routeRequiresProject`. */
  routeRequiresProject: boolean;
  rateLimitClass: "mutation";
  mcpTool: McpToolReference | null;
  /**
   * As the entry's, which the projection always writes, with an absent one
   * resolved to agents only. Optional so a transport built by hand reads as
   * an entry that names none: agents only, through `admitsCredentialKind`.
   */
  credentialKinds?: readonly CredentialKind[];
}

export interface RestQueryParameter {
  name: string;
  /**
   * True when the route reads it with `getAll`, so it may repeat. When false
   * the route reads it with `get`, and a repeat after the first is ignored.
   */
  repeated: boolean;
  /** For a repeated parameter, the most values the route accepts. */
  maxCount?: number;
  /** What one value must satisfy, after the conversion the route applies. */
  valueSchema: ZodType;
  /** The value used when the parameter is absent, if any. */
  defaultValue?: number;
  /**
   * True when the read refuses a request that omits the parameter, so the
   * OpenAPI document marks it `required`. Absent means optional.
   */
  required?: boolean;
  description: string;
}

/** A query as the OpenAPI generator reads it. */
export interface RestQueryTransport {
  /** As `QueryCapability.name`. */
  name: string;
  binding: QueryBinding;
  method: "GET";
  /** With `{name}` for each path parameter. */
  path: string;
  pathParameters: readonly string[];
  queryParameters: readonly RestQueryParameter[];
  /** Null for `whoami`, which every credential it admits reaches. */
  scope: string | null;
  /** As `RestQueryRoute.routeRequiresProject`. */
  routeRequiresProject: boolean;
  rateLimitClass: "token";
  mcpTool: McpToolReference | null;
  /** As `RestCommandTransport.credentialKinds`. */
  credentialKinds?: readonly CredentialKind[];
}

const organizationId: RestInjectedField = {
  field: "organizationId",
  from: "credential.organizationId",
};

/**
 * The domain's own table (`core/core-commands.ts`), which `transition_request`
 * checks in `authorize` as well as in `execute`: the registry publishes the
 * scope the command enforces rather than a copy of it.
 */
const lifecycleScopes: Readonly<Record<RequestLifecycleAction, string>> =
  requestActionScopes;

/**
 * The lifecycle actions the MCP server gives a tool of their own. The rest
 * are reached through its `transition_request` tool with `action` set, whose
 * enum admits only those eight.
 */
const lifecycleActionsWithOwnMcpTool = new Set<RequestLifecycleAction>([
  "submit_request",
  "withdraw_request",
  "begin_request_work",
  "block_request",
  "resume_request",
  "complete_request",
  "verify_request",
]);

const lifecycleActionsThroughMcpTransition = requestLifecycleActions.filter(
  (action) => !lifecycleActionsWithOwnMcpTool.has(action),
);

function busCommand(
  name: string,
  commandName: keyof typeof coreCommandInputSchemas,
  scope: string,
  options: {
    injectedFields?: readonly RestInjectedField[];
    /** Null for a command no MCP tool reaches; absent means a tool of `name`. */
    mcpTool?: McpToolReference | null;
    routeRequiresProject?: boolean;
    credentialKinds?: readonly CredentialKind[];
  } = {},
): CommandCapability {
  return {
    kind: "command",
    name,
    dispatch: { to: "command-bus", commandName },
    inputSchema: coreCommandInputSchemas[commandName],
    scope: { kind: "fixed", scope, checkedBy: "command" },
    rest: {
      method: "POST",
      path: `${restApiBasePath}/commands/${name}`,
      injectedFields: options.injectedFields ?? [organizationId],
      routeRequiresProject: options.routeRequiresProject ?? false,
      rateLimitClass: "mutation",
    },
    mcpTool: options.mcpTool === undefined ? { name } : options.mcpTool,
    ...(options.credentialKinds
      ? { credentialKinds: options.credentialKinds }
      : {}),
  };
}

function lifecycleCommand(action: RequestLifecycleAction): CommandCapability {
  return busCommand(action, "transition_request", lifecycleScopes[action], {
    injectedFields: [
      organizationId,
      { field: "action", from: "constant", value: action },
    ],
    mcpTool: lifecycleActionsWithOwnMcpTool.has(action)
      ? { name: action }
      : { name: "transition_request", action },
  });
}

const cursor: RestQueryParameter = {
  name: "cursor",
  repeated: false,
  valueSchema: z.string(),
  description: "The opaque `nextCursor` the previous page returned.",
};

/** An agent query: bound to a project, and read over MCP as well. */
function query(
  name: string,
  path: string,
  method: AgentQueryMethod,
  scope: string | null,
  queryParameters: readonly RestQueryParameter[] = [],
  credentialKinds?: readonly CredentialKind[],
): QueryCapability {
  const fullPath = `${restApiBasePath}${path}`;
  const binding: QueryBinding = "project";
  return {
    kind: "query",
    name,
    dispatch: { to: "agent-query-repository", method },
    binding,
    scope,
    rest: {
      method: "GET",
      path: fullPath,
      pathParameters: [...fullPath.matchAll(/\{([^}]+)\}/gu)].map(
        (match) => match[1] ?? "",
      ),
      queryParameters,
      routeRequiresProject: binding === "project",
      rateLimitClass: "token",
    },
    mcpTool: { name },
    ...(credentialKinds ? { credentialKinds } : {}),
  };
}

/**
 * The route both purposes of route evaluation take (Plan 13, F.2.1), as
 * `routeEvaluationInputSchema` names its fields. Each is read once; a repeat
 * after the first is ignored. The schema refuses a route without a target
 * project, a request type or a priority, so those three are required.
 */
const routeEvaluationParameters: readonly RestQueryParameter[] = [
  {
    name: "sourceProjectId",
    repeated: false,
    valueSchema: z.uuid(),
    description:
      "The project of the credential's organisation the request would come from. Absent for a request a person raises directly (`human_direct`).",
  },
  {
    name: "targetProjectId",
    repeated: false,
    required: true,
    valueSchema: z.uuid(),
    description:
      "Required. The project of the credential's organisation the request would go to.",
  },
  {
    name: "requestType",
    repeated: false,
    required: true,
    valueSchema: z.enum(requestTypes),
    description: "Required. One of the request types.",
  },
  {
    name: "priority",
    repeated: false,
    required: true,
    valueSchema: z.enum(requestPriorities),
    description: "Required. One of the request priorities.",
  },
];

/**
 * An administration read (Plan 13, F.2.0; `manifest-f2.md` §4.1): `GET` under
 * `administrationBasePath`, dispatched under its own name to the
 * administration dispatch, REST only (ruling 2), and admitting the operator
 * credential alone (rule 2). The dispatch checks `scope` before it reads.
 */
function administrationRead(
  name: AdministrationReadName,
  path: string,
  binding: QueryBinding,
  scope: string,
  queryParameters: readonly RestQueryParameter[] = [],
): QueryCapability {
  const fullPath = `${administrationBasePath}${path}`;
  return {
    kind: "query",
    name,
    dispatch: { to: "administration-read", method: name },
    binding,
    scope,
    rest: {
      method: "GET",
      path: fullPath,
      pathParameters: [...fullPath.matchAll(/\{([^}]+)\}/gu)].map(
        (match) => match[1] ?? "",
      ),
      queryParameters,
      routeRequiresProject: binding === "project",
      rateLimitClass: "token",
    },
    mcpTool: null,
    credentialKinds: ["operator"],
  };
}

/**
 * Every capability, commands first in the order REST has always listed them,
 * then the GET paths in the order the route's handler tests them. Append new
 * entries at the end; each projection keeps this order within its kind.
 */
export const capabilityRegistry: readonly Capability[] = [
  busCommand("create_request_draft", "create_request_draft", "request:create", {
    injectedFields: [
      organizationId,
      { field: "sourceKind", from: "constant", value: "project" },
      { field: "sourceProjectId", from: "credential.projectId" },
    ],
    // The route takes the draft's source from `withProject(context)`, which
    // refuses a credential bound to no project before dispatch.
    routeRequiresProject: true,
  }),
  busCommand("update_request", "update_request", "request:write"),
  ...requestLifecycleActions.map(lifecycleCommand),
  {
    ...busCommand("transition_request", "transition_request", "", {
      mcpTool: {
        name: "transition_request",
        actions: lifecycleActionsThroughMcpTransition,
      },
    }),
    scope: {
      kind: "by-action",
      field: "action",
      scopes: lifecycleScopes,
      checkedBy: "command",
    },
  },
  busCommand("post_message", "post_message", "request:write"),
  busCommand("ask_question", "ask_question", "request:write"),
  busCommand("answer_question", "answer_question", "question:answer"),
  busCommand("close_question", "close_question", "request:write"),
  busCommand("link_requests", "link_requests", "request:write"),
  busCommand("unlink_requests", "unlink_requests", "request:write"),
  busCommand("attach_artifact", "attach_artifact", "request:write"),
  busCommand(
    "register_agent_installation",
    "register_agent_installation",
    "agent:register",
  ),
  {
    kind: "command",
    name: "register_project",
    dispatch: { to: "project-registration-repository" },
    inputSchema: projectRegistrationInputSchema,
    scope: {
      kind: "fixed",
      scope: "agent:register",
      checkedBy: "project-registration-repository",
    },
    rest: {
      method: "POST",
      path: `${restApiBasePath}/commands/register_project`,
      // The repository binds the registration to the credential's organization
      // and project itself; nothing is written into the caller's input.
      injectedFields: [],
      routeRequiresProject: true,
      rateLimitClass: "mutation",
    },
    mcpTool: {
      name: "register_project",
      registeredWhen: "the MCP host supplies a registerProject dependency",
    },
  },
  busCommand(
    "register_machine_workspace",
    "register_machine_workspace",
    "agent:register",
    {
      mcpTool: {
        name: "register_machine_workspace",
        registeredWhen: "the MCP host accepts private telemetry",
      },
    },
  ),
  busCommand("claim_request", "claim_request", "work:claim"),
  busCommand("start_work_session", "start_work_session", "work:update"),
  busCommand("heartbeat_work_session", "heartbeat_work_session", "work:update"),
  busCommand("post_work_update", "post_work_update", "work:update"),
  busCommand("pause_work_session", "pause_work_session", "work:update"),
  busCommand("resume_work_session", "resume_work_session", "work:update"),
  busCommand("block_work_session", "block_work_session", "work:update"),
  busCommand("release_request", "release_request", "work:update"),
  busCommand("end_work_session", "end_work_session", "work:update"),
  // Plan 13, F.3 (F3-9): the one command F.3 admits operators to, on REST
  // only. `operator:revoke` is required to revoke another credential; a
  // credential revoking itself needs no scope. An agent is refused at the
  // route, and could hold no `operator:revoke` anyway.
  busCommand(
    "revoke_operator_credential",
    "revoke_operator_credential",
    "operator:revoke",
    { mcpTool: null, credentialKinds: ["operator"] },
  ),
  // An operator reaches it too (Plan 13, F.3): the route answers an operator
  // from its own context — actor, origin, organisation, project or null,
  // scopes — and never calls `getAgentPolicy`, since an operator has no
  // project work policy and may have no project at all.
  query("whoami", "/whoami", "getAgentPolicy", null, [], ["agent", "operator"]),
  query(
    "list_organizations",
    "/organizations",
    "listOrganizations",
    "org:read",
  ),
  query("list_projects", "/projects", "listProjects", "project:read"),
  query("get_project", "/projects/{projectId}", "getProject", "project:read"),
  query("list_requests", "/requests", "listRequests", "request:read", [
    cursor,
    {
      name: "limit",
      repeated: false,
      valueSchema: z.number().int().min(1).max(200),
      defaultValue: 50,
      description:
        "A page size. The route converts it with Number(); the repository accepts an integer from 1 to 200, and uses 50 when it is absent.",
    },
    {
      name: "state",
      repeated: true,
      maxCount: 20,
      valueSchema: z.enum(requestStates),
      description:
        "A request state to filter by. Repeat it for several, at most 20; each must be one of the request states.",
    },
  ]),
  query(
    "get_request_timeline",
    "/requests/{requestId}/timeline",
    "listTimeline",
    "request:read",
    [cursor],
  ),
  query("get_request", "/requests/{requestId}", "getRequest", "request:read"),
  query(
    "list_open_questions",
    "/questions",
    "listOpenQuestions",
    "request:read",
    [cursor],
  ),
  query("list_events", "/events", "listEvents", "request:read", [cursor]),
  // F.2.0b: the three shared administration reads (`manifest-f2.md` §4.1).
  // Each answers an organisation-wide credential about the organisation and a
  // project-bound one about its project, except that membership belongs to
  // the organisation, so the members read answers either about every member.
  administrationRead(
    "list_administration_projects",
    "/projects",
    "organization-or-project",
    "project:read",
  ),
  administrationRead(
    "list_administration_lanes",
    "/lanes",
    "organization-or-project",
    "project:read",
    [
      {
        name: "projectId",
        repeated: false,
        valueSchema: z.uuid(),
        description:
          "A project of the credential's organisation, to list its lanes alone. A credential bound to a project may name only that project, and is answered about it when it names none. Any other value is answered 404.",
      },
    ],
  ),
  administrationRead(
    "list_administration_members",
    "/members",
    "organization-or-project",
    "org:read",
  ),
  // Plan 13, F.2.3: the eleven project settings commands, for an operator
  // credential only (ruling 25), on REST only (ruling 2). Each checks
  // `project:manage`, takes the acting member from `memberAuthority` and holds
  // a project-bound operator to its project (`project-settings-commands.ts`).
  // An organisation-wide operator may name any project of its organisation,
  // so the route does not require a project.
  ...(
    [
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
    ] as const
  ).map((name) =>
    busCommand(name, name, "project:manage", {
      mcpTool: null,
      credentialKinds: ["operator"],
    }),
  ),
  // Plan 13, F.2.3 (`manifest-f2.md` §4.1): what those commands take their
  // identifiers, the project's version and the fields they resend from. An
  // organisation-wide operator reads any project of its organisation; one
  // bound to a project reads that project alone, and any other is not found
  // (`getAdministrationProjectSettings`), so its binding is
  // `organization-or-project` and the route requires no project.
  {
    kind: "query",
    name: "get_administration_project_settings",
    dispatch: {
      to: "administration-read",
      method: "get_administration_project_settings",
    },
    binding: "organization-or-project",
    scope: "project:manage",
    rest: {
      method: "GET",
      path: `${administrationBasePath}/projects/{projectId}/settings`,
      pathParameters: ["projectId"],
      queryParameters: [],
      routeRequiresProject: false,
      rateLimitClass: "token",
    },
    mcpTool: null,
    credentialKinds: ["operator"],
  },
  // Plan 13, F.2.1: the three routing rule commands, for an operator
  // credential only (ruling 25), on REST only (ruling 2). Each checks
  // `routing:manage`, takes the acting member from `memberAuthority` and
  // refuses an operator bound to a project, because a rule is the
  // organisation's (`routingMember`, `routing-service.ts`).
  ...(
    [
      "create_routing_rule",
      "update_routing_rule",
      "disable_routing_rule",
    ] as const
  ).map((name) =>
    busCommand(name, name, "routing:manage", {
      mcpTool: null,
      credentialKinds: ["operator"],
    }),
  ),
  // Plan 13, F.2.1 (`manifest-f2.md` §4.1): what update and disable take
  // their rule ids and expected versions from, and every field update
  // resends. The rules are the organisation's, so its binding is
  // `organization`: a credential bound to a project is refused.
  administrationRead(
    "list_administration_routing_rules",
    "/routing-rules",
    "organization",
    "routing:manage",
  ),
  // Plan 13, F.2.1: route evaluation, the routing tester's and the request
  // form's preview's one entry (`evaluateRouteForMember`), read for an
  // organisation-wide operator's member. Each purpose checks the scope its
  // form checks. The route is given as query parameters; the credential's
  // organisation is written over any the caller names, and a parameter the
  // purpose does not take is refused as invalid input.
  administrationRead(
    "test_administration_route",
    "/route-evaluations/test",
    "organization",
    "routing:manage",
    [
      ...routeEvaluationParameters,
      {
        name: "laneId",
        repeated: false,
        valueSchema: z.uuid(),
        description:
          "A lane of the target project to evaluate the route for. Optional.",
      },
      {
        name: "agentPrincipalId",
        repeated: false,
        valueSchema: z.uuid(),
        description:
          "An agent principal of the organisation to evaluate the route for, in place of the operator's member. Optional.",
      },
    ],
  ),
  administrationRead(
    "preview_administration_route",
    "/route-evaluations/preview",
    "organization",
    "request:create",
    routeEvaluationParameters,
  ),
  // Plan 13, F.2.2: the three agent administration acts a machine may be given
  // (ruling 3), for an operator credential only (ruling 25), on REST only
  // (ruling 2), each under `agent:revoke`, the scope that can only take
  // authority away (F3-4). Suspension is the bus command; it takes the acting
  // member from `memberAuthority`, refuses an operator any status but
  // `suspended`, and holds a project-bound operator to the principal's
  // project (`agent-commands.ts`). An organisation-wide operator may name any
  // principal of its organisation, so the route requires no project.
  busCommand(
    "set_agent_principal_status",
    "set_agent_principal_status",
    agentRevokeScope,
    { mcpTool: null, credentialKinds: ["operator"] },
  ),
  // The two revocations stay off the bus (`manifest-f2.md` §2.4): the route
  // hands each to the RequestPort's `execute`, which runs its handler in
  // `packages/core/src/agent-administration.ts`; the handler runs the key or
  // grant service there, under that service's own receipt.
  ...(
    Object.keys(
      agentAdministrationInputSchemas,
    ) as AgentAdministrationHandlerName[]
  ).map(
    (name): CommandCapability => ({
      kind: "command",
      name,
      dispatch: { to: "agent-administration", handler: name },
      inputSchema: agentAdministrationInputSchemas[name],
      scope: {
        kind: "fixed",
        scope: agentRevokeScope,
        checkedBy: "agent-auth-service",
      },
      rest: {
        method: "POST",
        path: `${restApiBasePath}/commands/${name}`,
        injectedFields: [organizationId],
        routeRequiresProject: false,
        rateLimitClass: "mutation",
      },
      mcpTool: null,
      credentialKinds: ["operator"],
    }),
  ),
  // Plan 13, F.2.2 (`manifest-f2.md` §4.1): what those three take their
  // identifiers and expected versions from, under suspension's rule
  // (`agent-reads.ts`). An organisation-wide operator reads its
  // organisation's principals; one bound to a project reads that project's
  // alone, and any other is not found.
  administrationRead(
    "list_administration_agent_principals",
    "/agent-principals",
    "organization-or-project",
    agentRevokeScope,
  ),
  administrationRead(
    "get_administration_agent_principal",
    "/agent-principals/{agentPrincipalId}",
    "organization-or-project",
    agentRevokeScope,
  ),
  // Plan 13, F.2.4: the four requeues and the two retention hold commands,
  // for an operator credential only (ruling 25), on REST only (ruling 2).
  // Each checks `operations:manage`, takes the acting member from
  // `memberAuthority` and refuses a credential bound to a project, because
  // every row they act on belongs to the organisation
  // (`operations-commands.ts`). The route writes the credential's
  // organisation into the input and requires no project.
  ...(
    [
      "requeue_outbox",
      "requeue_notification",
      "requeue_slack_operation",
      "requeue_import_dispatch",
      "create_retention_hold",
      "release_retention_hold",
    ] as const
  ).map((name) =>
    busCommand(name, name, "operations:manage", {
      mcpTool: null,
      credentialKinds: ["operator"],
    }),
  ),
  // Plan 13, F.2.4 (`manifest-f2.md` §4.1): what those commands take their
  // identifiers and expected versions from — each requeue's row and attempt
  // count, each hold and its version. Both are bound to the organisation,
  // but the route does not read `binding`: `/api/v1` dispatches each to its
  // `read…ForOperator` function (`operations-reads.ts`), which first runs the
  // bus's `assertCurrent` — with the switch on, queries that lock and
  // revalidate the credential, its key and its member — and then the list,
  // whose `requireOrganizationWide` refuses a credential bound to a project
  // `forbidden` before the list's own queries. A bound credential is
  // therefore refused after `assertCurrent` has queried, not before.
  administrationRead(
    "list_administration_operations",
    "/operations",
    "organization",
    "operations:manage",
  ),
  administrationRead(
    "list_administration_retention_holds",
    "/retention-holds",
    "organization",
    "operations:manage",
  ),
  // Plan 13, F.2.5: the three Slack administration commands, for an operator
  // credential only (ruling 25), on REST only (ruling 2). Each checks
  // `slack:manage`, takes the acting member from `memberAuthority` and refuses
  // an operator bound to a project, since Slack configuration is the
  // organisation's (`slack-administration-commands.ts`).
  ...(
    [
      "set_slack_user_mapping",
      "set_slack_route",
      "set_slack_installation_status",
    ] as const
  ).map((name) =>
    busCommand(name, name, "slack:manage", {
      mcpTool: null,
      credentialKinds: ["operator"],
    }),
  ),
  // The connection test stays off the bus: it starts a task after its commit.
  // The route hands it, through the RequestPort's `execute`, to
  // `queueSlackConnectionTest` (`packages/core/src/slack-connection-test.ts`),
  // which the connection test form also runs (`lib/server-slack-actions.ts`),
  // and which runs the three commands' own checks
  // (`slackAdministrationTarget`) before its transaction opens: an operator
  // bound to a project is refused there, so the route requires no project.
  {
    kind: "command",
    name: "send_slack_connection_test",
    dispatch: { to: "slack-connection-test" },
    inputSchema: slackConnectionTestInputSchema,
    scope: {
      kind: "fixed",
      scope: slackAdministrationScope,
      checkedBy: "slack-connection-test-handler",
    },
    rest: {
      method: "POST",
      path: `${restApiBasePath}/commands/send_slack_connection_test`,
      injectedFields: [organizationId],
      routeRequiresProject: false,
      rateLimitClass: "mutation",
    },
    mcpTool: null,
    credentialKinds: ["operator"],
  },
  // Plan 13, F.2.5 (`manifest-f2.md` §4.1): what those commands take their
  // identifiers, versions and the route fields they resend from, and the
  // connection test its installation. Bound to the organisation: a credential
  // bound to a project is refused (`getAdministrationSlackConfiguration`).
  administrationRead(
    "get_administration_slack_configuration",
    "/slack",
    "organization",
    "slack:manage",
  ),
  // Plan 13, F.2.6: import review, for an operator credential only (ruling
  // 25), on REST only (ruling 2). `import:write` is also an agent scope (the
  // MCP import tools), so `credentialKinds` is what keeps an agent off these
  // four; the command and the split handler also refuse any context but a
  // person's or an operator's (`memberAuthority`). An organisation-wide
  // operator may name any run of its organisation, and the repository holds a
  // project-bound one to the runs whose source is its project, so the route
  // requires no project. Freezing stays human-only (ruling 3).
  busCommand(
    "review_legacy_import_entry",
    "review_legacy_import_entry",
    importReviewScope,
    { mcpTool: null, credentialKinds: ["operator"] },
  ),
  // The split stays off the bus (`manifest-f2.md` §4, Scope 1): the route
  // hands it to `splitImportEntry`, which the split form also calls.
  {
    kind: "command",
    name: "split_legacy_import_entry",
    dispatch: { to: "import-split" },
    inputSchema: splitImportEntryInputSchema,
    scope: {
      kind: "fixed",
      scope: importReviewScope,
      checkedBy: "import-split-handler",
    },
    rest: {
      method: "POST",
      path: `${restApiBasePath}/commands/split_legacy_import_entry`,
      injectedFields: [organizationId],
      routeRequiresProject: false,
      rateLimitClass: "mutation",
    },
    mcpTool: null,
    credentialKinds: ["operator"],
  },
  // Plan 13, F.2.6 (`manifest-f2.md` §4.1): what review and the split take
  // their run and entry ids and the entry's version from, under their rule
  // (`import-reads.ts`). An organisation-wide operator reads its
  // organisation's runs; one bound to a project reads the runs whose source
  // is that project, and any other is not found.
  administrationRead(
    "list_administration_import_runs",
    "/import-runs",
    "organization-or-project",
    importReviewScope,
  ),
  administrationRead(
    "get_administration_import_run",
    "/import-runs/{runId}",
    "organization-or-project",
    importReviewScope,
  ),
  // Plan 13, F.2.7: inviting a member, changing a member's role or access,
  // revoking an invitation, and the organisation's appearance defaults, for
  // an operator credential only (ruling 25), on REST only (ruling 2). Each
  // checks `members:manage`, takes the acting member from `memberAuthority`
  // and refuses a context bound to a project, because every row it touches
  // is the organisation's (`organization-administration-commands.ts`,
  // `appearance-commands.ts`). The route writes the credential's organisation
  // into the input.
  ...(
    [
      "invite_organization_member",
      "set_organization_member",
      "revoke_organization_invitation",
      "appearance.update_organization_defaults.v1",
    ] as const
  ).map((name) =>
    busCommand(name, name, "members:manage", {
      mcpTool: null,
      credentialKinds: ["operator"],
    }),
  ),
  // Plan 13, F.2.7 (`manifest-f2.md` §4.1): what revoking an invitation and
  // the appearance write take their identifiers, versions and resent values
  // from. Both are the organisation's, and refuse a credential bound to a
  // project (`member-reads.ts`).
  administrationRead(
    "list_administration_invitations",
    "/invitations",
    "organization",
    "members:manage",
  ),
  administrationRead(
    "get_administration_organization_appearance",
    "/appearance",
    "organization",
    "members:manage",
  ),
];

/** Every POST command, in registry order: the commands the route accepts. */
export const restCommandTransports: readonly RestCommandTransport[] =
  capabilityRegistry.flatMap((capability) =>
    capability.kind === "command"
      ? [
          {
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
            credentialKinds: capability.credentialKinds ?? agentsOnly,
          },
        ]
      : [],
  );

/** Every GET path, in registry order: the order the route's handler tests them. */
export const restQueryTransports: readonly RestQueryTransport[] =
  capabilityRegistry.flatMap((capability) =>
    capability.kind === "query"
      ? [
          {
            name: capability.name,
            binding: capability.binding,
            path: capability.rest.path,
            pathParameters: capability.rest.pathParameters,
            queryParameters: capability.rest.queryParameters,
            scope: capability.scope,
            mcpTool: capability.mcpTool,
            method: capability.rest.method,
            routeRequiresProject: capability.rest.routeRequiresProject,
            rateLimitClass: capability.rest.rateLimitClass,
            credentialKinds: capability.credentialKinds ?? agentsOnly,
          },
        ]
      : [],
  );

const restCommandTransportsByName = new Map(
  restCommandTransports.map((transport) => [transport.name, transport]),
);

/**
 * The POST command a caller names, or undefined. A `Map`, so a name that is
 * only an object's inherited property (`constructor`, `__proto__`) finds
 * nothing.
 */
export function findRestCommandTransport(
  name: string,
): RestCommandTransport | undefined {
  return restCommandTransportsByName.get(name);
}

const queryCapabilitiesByName = new Map(
  capabilityRegistry.flatMap((capability) =>
    capability.kind === "query" ? [[capability.name, capability] as const] : [],
  ),
);

/**
 * The query entry of this name, or undefined. Core's query dispatch
 * (`packages/core/src/query.ts`), which the route's GET handler runs, checks
 * the `scope` it finds here before an agent query reads. A `Map`, as
 * `findRestCommandTransport`.
 */
export function findQueryCapability(name: string): QueryCapability | undefined {
  return queryCapabilitiesByName.get(name);
}

/**
 * A tool the MCP server registers from the registry: one per `mcpTool` an
 * entry names for itself. An entry whose `mcpTool` carries `action` is reached
 * through another entry's tool (the generic `transition_request`) and adds
 * none.
 */
export type McpToolTransport =
  | {
      kind: "command";
      name: string;
      /** The scope without which the server does not register the tool. */
      requiredScope: string;
      dispatch: CommandDispatch;
      /**
       * Set on a tool named for a lifecycle action: the action it always
       * sends to `transition_request`.
       */
      action?: RequestLifecycleAction;
      /**
       * Set on the generic `transition_request` only: the actions its `action`
       * input admits, in the order the tool lists them.
       */
      actions?: readonly RequestLifecycleAction[];
      /** As `McpToolReference.registeredWhen`. */
      registeredWhen?: string;
    }
  | {
      kind: "query";
      name: string;
      /** Null for `whoami`, which the server registers for every caller. */
      requiredScope: string | null;
      registeredWhen?: string;
    };

const lifecycleActionNames = new Set<string>(requestLifecycleActions);

/** The one scope every action a by-action tool admits requires. */
function commonScope(
  name: string,
  scopes: Readonly<Record<RequestLifecycleAction, string>>,
  actions: readonly RequestLifecycleAction[],
) {
  const distinct = [...new Set(actions.map((action) => scopes[action]))];
  if (distinct.length !== 1 || distinct[0] === undefined)
    throw new Error(
      `The MCP tool ${name} admits actions under ${distinct.length} scopes; it is registered under one`,
    );
  return distinct[0];
}

function mcpToolTransport(capability: Capability): McpToolTransport[] {
  const tool = capability.mcpTool;
  if (!tool || tool.action) return [];
  const registeredWhen = tool.registeredWhen
    ? { registeredWhen: tool.registeredWhen }
    : {};
  if (capability.kind === "query")
    return [
      {
        kind: "query",
        name: tool.name,
        requiredScope: capability.scope,
        ...registeredWhen,
      },
    ];
  const sendsAction =
    capability.dispatch.to === "command-bus" &&
    capability.dispatch.commandName === "transition_request" &&
    lifecycleActionNames.has(tool.name);
  return [
    {
      kind: "command",
      name: tool.name,
      requiredScope:
        capability.scope.kind === "fixed"
          ? capability.scope.scope
          : commonScope(tool.name, capability.scope.scopes, tool.actions ?? []),
      dispatch: capability.dispatch,
      ...(sendsAction ? { action: tool.name as RequestLifecycleAction } : {}),
      ...(tool.actions ? { actions: tool.actions } : {}),
      ...registeredWhen,
    },
  ];
}

/**
 * Every MCP tool the registry names, in registry order. The server registers
 * each through `findMcpToolTransport`, taking from it the scope that gates the
 * tool and, for a command, where it dispatches; the order the server lists
 * tools in is its own registration order, not this one.
 */
export const mcpToolTransports: readonly McpToolTransport[] =
  capabilityRegistry.flatMap(mcpToolTransport);

const mcpToolTransportsByName = new Map(
  mcpToolTransports.map((tool) => [tool.name, tool]),
);

/**
 * The registry's MCP tool of this name, or undefined — for an MCP-only tool
 * too. A `Map`, as `findRestCommandTransport`.
 */
export function findMcpToolTransport(
  name: string,
): McpToolTransport | undefined {
  return mcpToolTransportsByName.get(name);
}

/**
 * The MCP tools the server registers that no registry entry names: no REST
 * path exposes them, and F.1 has not yet entered them in the registry. They
 * are listed here so that the gap is explicit rather than silent. The server
 * registers them through `registerMcpOnlyTool`, which takes only a name from
 * this list; `packages/mcp/src/server.registry.test.ts` fails when a server
 * lists a tool that is neither named by an entry's `mcpTool` nor listed here,
 * and when the fullest server does not list every name here, or a name here is
 * also an entry's tool or is listed twice. Entering one in the registry means
 * removing it from this list.
 */
export const mcpOnlyTools = [
  "agent_hello",
  "create_project",
  "provision_agent",
  "list_event_subscriptions",
  "create_event_subscription",
  "verify_event_subscription",
  "rotate_event_subscription_secret",
  "set_event_subscription_status",
  "replay_event_delivery",
  "list_legacy_imports",
  "get_legacy_import",
  "analyze_legacy_import",
  "apply_legacy_import",
  "correct_legacy_import",
] as const;

/** A tool the MCP server registers with no registry entry. */
export type McpOnlyTool = (typeof mcpOnlyTools)[number];
