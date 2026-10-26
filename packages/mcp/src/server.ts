import {
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  McpServer,
  readRequestBody,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { AgentAuthContext } from "@requestport/auth/create-auth";
import type {
  CommandBus,
  JsonValue,
  McpOnlyTool,
  RequestLifecycleAction,
} from "@requestport/domain";
import {
  containsSensitiveJson,
  DomainError,
  dropOwnProtoKeys,
  findMcpToolTransport,
  isoDatetime,
  trimmedUrl,
  utf16Max,
  utf16Min,
} from "@requestport/domain";
import { z } from "zod";

export interface McpQueryServices {
  getAgentPolicy(context: AgentAuthContext): Promise<{
    heartbeatIntervalSeconds: number;
    leaseMultiplier: number;
    graceSeconds: number;
    requiredWorkspaceFields: string[];
  } | null>;
  listOrganizations(context: AgentAuthContext): Promise<JsonValue>;
  listProjects(context: AgentAuthContext): Promise<JsonValue>;
  getProject(context: AgentAuthContext, projectId: string): Promise<JsonValue>;
  listRequests(
    context: AgentAuthContext,
    input: { cursor?: string; limit?: number; state?: string[] },
  ): Promise<JsonValue>;
  getRequest(context: AgentAuthContext, requestId: string): Promise<JsonValue>;
  listTimeline(
    context: AgentAuthContext,
    requestId: string,
    cursor?: string,
  ): Promise<JsonValue>;
  listOpenQuestions(
    context: AgentAuthContext,
    cursor?: string,
  ): Promise<JsonValue>;
  listEvents(context: AgentAuthContext, cursor?: string): Promise<JsonValue>;
}

export type McpServerDependencies = {
  acceptsPrivateTelemetry?: boolean;
  /**
   * Serve the 2026-07-28 protocol era beside the 2025 one. Off unless the
   * host turns it on; `apps/web` does so only for
   * `REQUESTPORT_MCP_MODERN=enabled`. Off, every request goes to the 2025
   * transport, built as it was on the v1 SDK (`handleMcpRequest`).
   */
  modernProtocol?: boolean;
  /**
   * Where an error nothing here recognised is reported.
   *
   * Every refusal this server can name is answered with a code and a public
   * message. Anything else answers `unexpected_error` — and used to answer it
   * in silence, writing nothing anywhere, so an agent was told the operation
   * failed and the deployment kept no record of why. A provisioning failure
   * that took two hours to trace is what added this: the exception existed for
   * a tenth of a second inside a route handler and then nothing about it
   * survived.
   *
   * The report goes to the host's own logger rather than to the client. The
   * client still learns only that the operation failed, because the exception
   * may carry the input that caused it.
   */
  reportUnexpectedError?: (error: unknown) => void;
  context: AgentAuthContext;
  commandBus: CommandBus;
  queries: McpQueryServices;
  registerProject?: (
    input: Record<string, unknown>,
    meta: { idempotencyKey: string; expectedVersion: number },
  ) => Promise<JsonValue>;
  /**
   * Create a project in this credential's organization.
   *
   * Absent unless the deployment wires it, and unreachable unless the caller
   * holds `project:provision`. That scope is exclusive in the sense the grant
   * service enforces — a provisioning grant may carry no other scope — but not
   * in the sense of reaching a single tool: `provision_agent` is gated on the
   * same scope and `whoami` is ungated. The host is responsible for proving the delegating
   * human is still an owner or admin; this server only decides whether the tool
   * exists.
   */
  createProject?: (
    input: Record<string, unknown>,
    meta: { correlationId: string },
  ) => Promise<JsonValue>;
  /**
   * Create an agent principal in a project and issue its first credential.
   *
   * Separate from `createProject` because minting a secret is a different
   * audited act from making a project, and a caller that wanted only the
   * project should never be handed one.
   */
  provisionAgent?: (
    input: Record<string, unknown>,
    meta: { idempotencyKey: string },
  ) => Promise<JsonValue>;
  webhooks?: {
    list(): Promise<JsonValue>;
    create(
      input: Record<string, unknown>,
      meta: { idempotencyKey: string; expectedVersion: number },
    ): Promise<JsonValue>;
    verify(
      id: string,
      meta: { idempotencyKey: string; expectedVersion: number },
    ): Promise<JsonValue>;
    rotate(
      id: string,
      overlapMinutes: number,
      meta: { idempotencyKey: string; expectedVersion: number },
    ): Promise<JsonValue>;
    setStatus(
      id: string,
      status: "active" | "disabled" | "revoked",
      meta: { idempotencyKey: string; expectedVersion: number },
    ): Promise<JsonValue>;
    replay(
      deliveryId: string,
      meta: { idempotencyKey: string; expectedVersion: number },
    ): Promise<JsonValue>;
  };
  imports?: {
    list(): Promise<JsonValue>;
    analyze(
      sourceId: string,
      snapshotId: string,
      meta: { idempotencyKey: string; expectedVersion: number },
    ): Promise<JsonValue>;
    detail(runId: string): Promise<JsonValue>;
    apply(
      runId: string,
      manifestSha256: string,
      meta: { idempotencyKey: string; expectedVersion: number },
    ): Promise<JsonValue>;
    correct(
      runId: string,
      meta: { idempotencyKey: string; expectedVersion: number },
    ): Promise<JsonValue>;
  };
};

const commandMeta = {
  idempotencyKey: z.string().check(utf16Min(16)).check(utf16Max(200)),
  expectedVersion: z.number().int().nonnegative(),
};

const cursorSchema = z.string().min(1).check(utf16Max(2_048));
const capabilityKeySchema = z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/u);
const capabilitiesSchema = z
  .record(capabilityKeySchema, z.boolean())
  .refine((value) => Object.keys(value).length <= 128, {
    message: "At most 128 capabilities may be reported",
  });
const boundedJsonRecord = (maximumEntries: number) =>
  z
    .record(z.string().min(1).check(utf16Max(128)), z.json())
    .refine((value) => Object.keys(value).length <= maximumEntries, {
      message: `At most ${maximumEntries} fields may be supplied`,
    });

function content(value: JsonValue) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent:
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : { value },
  };
}

const publicDomainMessages: Record<string, string> = {
  already_answered: "That question already has a canonical answer.",
  configuration_error: "RequestPort is temporarily unavailable.",
  conflict: "The requested operation conflicts with current state.",
  forbidden: "The credential is not permitted to perform this operation.",
  idempotency_conflict:
    "The idempotency key was already used with different input.",
  invalid_state:
    "The requested resource is unavailable from its current state.",
  invalid_transition: "The requested state transition is unavailable.",
  not_found: "The requested resource was not found.",
  rate_limited: "Too many requests. Retry later.",
  route_denied: "The current routing policy denies this request.",
  unauthenticated: "A valid agent credential is required.",
  validation_failed: "The tool input is invalid.",
  version_conflict: "The resource changed. Reload it and retry.",
};

/** The bounds a free-form input's refusal may name (ruling 237 item 3). */
const freeFormBounds: readonly string[] = ["elements", "depth", "bytes"];

function publicDomainDetails(error: DomainError) {
  const details: Record<string, string | number> = {};
  if (
    typeof error.details.field === "string" &&
    /^[A-Za-z0-9_.-]{1,128}$/u.test(error.details.field)
  ) {
    details.field = error.details.field;
  }
  // The bound a free-form input exceeded, and its value, as the domain's
  // bus names them: published together, or not at all.
  if (
    typeof error.details.bound === "string" &&
    freeFormBounds.includes(error.details.bound) &&
    typeof error.details.maximum === "number" &&
    Number.isSafeInteger(error.details.maximum) &&
    error.details.maximum > 0
  ) {
    details.bound = error.details.bound;
    details.maximum = error.details.maximum;
  }
  if (
    typeof error.details.retryAfterSeconds === "number" &&
    Number.isFinite(error.details.retryAfterSeconds)
  ) {
    details.retryAfterSeconds = Math.max(
      1,
      Math.ceil(error.details.retryAfterSeconds),
    );
  }
  return details;
}

function errorResult(error: unknown, report?: (error: unknown) => void) {
  if (error instanceof z.ZodError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "validation_failed",
            message: "MCP tool input is invalid.",
          }),
        },
      ],
    };
  }
  if (error instanceof DomainError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: error.code,
            message:
              publicDomainMessages[error.code] ??
              "The RequestPort operation failed.",
            details: publicDomainDetails(error),
          }),
        },
      ],
    };
  }
  report?.(error);

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: "unexpected_error",
          message: "The RequestPort operation failed.",
        }),
      },
    ],
  };
}

async function safeRead(
  report: ((error: unknown) => void) | undefined,
  run: () => Promise<JsonValue>,
) {
  try {
    return content(await run());
  } catch (error) {
    return errorResult(error, report);
  }
}

/** What a tool says about itself in `tools/list`, apart from its name. */
interface ToolConfig<InputArgs extends StandardSchemaWithJSON> {
  description: string;
  inputSchema: InputArgs;
  annotations: ToolAnnotations;
}

/**
 * The capability registry's entry for a tool this server registers from it
 * (Plan 13, F.1). A name the registry does not hold throws, so building the
 * server fails whatever the credential: a tool is not served without its
 * entry.
 */
function registryTool(name: string) {
  const tool = findMcpToolTransport(name);
  if (!tool)
    throw new Error(`The MCP tool ${name} has no capability registry entry`);
  return tool;
}

/**
 * Register a tool the registry names, behind the scope the registry gives it
 * (none for `whoami`). `onlyIf` is a host condition beyond the scope, which
 * the registry records as the tool's `registeredWhen`. The registry is read
 * before either condition, so a missing entry throws on every host.
 */
function registerRegistryTool<InputArgs extends StandardSchemaWithJSON>(
  server: McpServer,
  dependencies: McpServerDependencies,
  name: string,
  config: ToolConfig<InputArgs>,
  callback: ToolCallback<InputArgs>,
  onlyIf = true,
) {
  const { requiredScope } = registryTool(name);
  if (!onlyIf) return;
  if (requiredScope !== null && !dependencies.context.scopes.has(requiredScope))
    return;
  server.registerTool(name, config, callback);
}

/**
 * Register a tool the registry does not hold, which `mcpOnlyTools` in
 * `@requestport/domain` must declare. Its gate is its caller's.
 */
function registerMcpOnlyTool<InputArgs extends StandardSchemaWithJSON>(
  server: McpServer,
  name: McpOnlyTool,
  config: ToolConfig<InputArgs>,
  callback: ToolCallback<InputArgs>,
) {
  server.registerTool(name, config, callback);
}

/**
 * Register a tool that runs a command on the bus. The registry names the
 * command, the scope, and for a tool named for a lifecycle action the action
 * it sends; the caller supplies what the tool says about itself and any
 * mapping of its input.
 */
function registerCommand(
  server: McpServer,
  dependencies: McpServerDependencies,
  options: {
    name: string;
    description: string;
    schema: z.ZodObject<z.ZodRawShape>;
    mapInput?: (input: Record<string, unknown>) => Record<string, unknown>;
    onlyIf?: boolean;
  },
) {
  const tool = registryTool(options.name);
  if (tool.kind !== "command" || tool.dispatch.to !== "command-bus")
    throw new Error(
      `The MCP tool ${options.name} does not run a command on the bus`,
    );
  const { commandName } = tool.dispatch;
  const action = tool.action ? { action: tool.action } : {};
  registerRegistryTool(
    server,
    dependencies,
    options.name,
    {
      description: options.description,
      inputSchema: options.schema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const values = input as Record<string, unknown>;
        const commandValues = { ...values };
        delete commandValues.idempotencyKey;
        delete commandValues.expectedVersion;
        const result = await dependencies.commandBus.execute({
          name: commandName,
          input: {
            ...(options.mapInput?.(commandValues) ?? commandValues),
            ...action,
            organizationId: dependencies.context.organizationId,
          },
          context: dependencies.context,
          meta: {
            idempotencyKey: String(values.idempotencyKey),
            expectedVersion: Number(values.expectedVersion),
          },
        });
        return content({
          result,
          suggestedNextActions: suggestedNextActions(options.name),
        });
      } catch (error) {
        return errorResult(error, dependencies.reportUnexpectedError);
      }
    },
    options.onlyIf,
  );
}

/** The lifecycle actions the registry admits through `transition_request`. */
function transitionActions() {
  const tool = registryTool("transition_request");
  const actions = tool.kind === "command" ? (tool.actions ?? []) : [];
  if (actions.length === 0)
    throw new Error("The MCP tool transition_request admits no action");
  return actions as readonly [
    RequestLifecycleAction,
    ...RequestLifecycleAction[],
  ];
}

function suggestedNextActions(name: string) {
  const actions: Record<string, string[]> = {
    create_request_draft: ["submit_request", "get_request"],
    submit_request: ["get_request", "get_request_timeline"],
    claim_request: ["transition_request", "start_work_session"],
    start_work_session: ["heartbeat_work_session", "post_work_update"],
    post_work_update: ["heartbeat_work_session", "get_request_timeline"],
    end_work_session: ["complete_request", "get_request_timeline"],
  };
  return actions[name] ?? ["get_request", "list_events"];
}

/**
 * The most array elements and object keys, counted together at every level,
 * that one `tools/call`'s `arguments` may carry: `McpServer`'s
 * `maxToolInputElements` (rulings 236 and 237; GHSA-46jr-4wx8-v453), which
 * the SDK leaves unlimited unless it is set. A call over it gets the SDK's
 * `isError` result naming the limit before its input is validated, so the
 * tool does not run. Both legs of `handleMcpRequest` serve the server built
 * below, so it holds on each.
 *
 * It is 17,000, the JSON values packages/server's MCP handler lets one
 * message hold (`assertJsonDepth`'s bound) before it calls
 * `handleMcpRequest`. Each element or key counted here is a value that
 * walk visits, and it also visits the message, its `params` and `arguments`,
 * so a call that handler admits is under this limit: behind it, as on
 * production's `/mcp`, the limit refuses nothing. It guards a caller of
 * `handleMcpRequest` with no such handler in front. packages/server's
 * `mcp.tool-input-limit.test.ts` fails if either number moves without the
 * other.
 *
 * 17,000 is the largest message a legitimate call sends, rounded up to the
 * next 1,000 (ruling 237 item 3): `post_work_update`'s, whose seven keys, 100
 * evidence records and 64 fields in each come to 6,507 elements, and whose
 * evidence field values the domain lets hold 10,000 more, 16,507 in all; its
 * message on the 2026-07-28 leg, with the six-value `_meta` the tests send,
 * holds 16,520 values. The domain bounds what
 * the free-form values nest (an evidence field's, `provenance`'s,
 * `structuredValue`; `privateTelemetry` it parses strictly), not these tool
 * schemas. `server.tool-input-limit.test.ts` works the 16,507 and the 16,520
 * out from `tools/list` and the domain's bounds, and fails if they move.
 */
const maxToolInputElements = 17_000;

export function createRequestPortMcpServer(
  dependencies: McpServerDependencies,
) {
  const server = new McpServer(
    { name: "RequestPort", version: "1.0.0" },
    { capabilities: { tools: {} }, maxToolInputElements },
  );

  registerRegistryTool(
    server,
    dependencies,
    "whoami",
    {
      description:
        "Return the effective RequestPort agent identity and constraints.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      content({
        actor: dependencies.context.actor,
        organizationId: dependencies.context.organizationId,
        projectId: dependencies.context.projectId,
        laneIds: [...dependencies.context.laneIds],
        scopes: [...dependencies.context.scopes].sort(),
        audience: dependencies.context.audience,
        authorizationId: dependencies.context.authorizationId,
        serverSchemaVersion: 1,
      }),
  );

  registerRegistryTool(
    server,
    dependencies,
    "list_organizations",
    {
      description: "List the organization granted to this agent.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      safeRead(dependencies.reportUnexpectedError, () =>
        dependencies.queries.listOrganizations(dependencies.context),
      ),
  );

  registerRegistryTool(
    server,
    dependencies,
    "list_projects",
    {
      description: "List projects visible to this agent grant.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      safeRead(dependencies.reportUnexpectedError, () =>
        dependencies.queries.listProjects(dependencies.context),
      ),
  );
  registerRegistryTool(
    server,
    dependencies,
    "get_project",
    {
      description: "Get one visible project.",
      inputSchema: z.object({ projectId: z.uuid() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectId }) =>
      safeRead(dependencies.reportUnexpectedError, () =>
        dependencies.queries.getProject(dependencies.context, projectId),
      ),
  );

  registerRegistryTool(
    server,
    dependencies,
    "list_requests",
    {
      description: "List authorized requests with a durable cursor.",
      inputSchema: z.object({
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        state: z
          .array(
            z.enum([
              "draft",
              "submitted",
              "triage",
              "accepted",
              "planned",
              "in_progress",
              "blocked",
              "waiting_human",
              "waiting_requester",
              "completed",
              "verified",
              "declined",
              "duplicate",
              "superseded",
              "cancelled",
            ]),
          )
          .max(20)
          .optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) =>
      safeRead(dependencies.reportUnexpectedError, () =>
        dependencies.queries.listRequests(dependencies.context, input),
      ),
  );
  registerRegistryTool(
    server,
    dependencies,
    "get_request",
    {
      description: "Get an authorized request and its safe detail projection.",
      inputSchema: z.object({ requestId: z.uuid() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ requestId }) =>
      safeRead(dependencies.reportUnexpectedError, () =>
        dependencies.queries.getRequest(dependencies.context, requestId),
      ),
  );
  registerRegistryTool(
    server,
    dependencies,
    "get_request_timeline",
    {
      description: "Get the canonical request event timeline.",
      inputSchema: z.object({
        requestId: z.uuid(),
        cursor: cursorSchema.optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ requestId, cursor }) =>
      safeRead(dependencies.reportUnexpectedError, () =>
        dependencies.queries.listTimeline(
          dependencies.context,
          requestId,
          cursor,
        ),
      ),
  );
  registerRegistryTool(
    server,
    dependencies,
    "list_open_questions",
    {
      description: "List open human-input questions visible to this agent.",
      inputSchema: z.object({ cursor: cursorSchema.optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ cursor }) =>
      safeRead(dependencies.reportUnexpectedError, () =>
        dependencies.queries.listOpenQuestions(dependencies.context, cursor),
      ),
  );
  registerRegistryTool(
    server,
    dependencies,
    "list_events",
    {
      description: "Read the durable organization event feed from a cursor.",
      inputSchema: z.object({ cursor: cursorSchema.optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ cursor }) =>
      safeRead(dependencies.reportUnexpectedError, () =>
        dependencies.queries.listEvents(dependencies.context, cursor),
      ),
  );

  /**
   * Not offered to a session that has no project to negotiate policy for.
   *
   * `agent_hello` answers with the work policy of the bound project, so a
   * provisioning grant — which names none — got a tool it could only ever be
   * refused by. RequestPort's own published connection sequence puts this at
   * step four, so an agent following the documentation hit a wall the
   * documentation did not mention. Absent is a clearer answer than present and
   * always failing.
   */
  if (dependencies.context.projectId) {
    registerMcpOnlyTool(
      server,
      "agent_hello",
      {
        description: "Negotiate effective agent policy before starting work.",
        inputSchema: z.object({
          softwareName: z.string().min(1).check(utf16Max(160)),
          softwareVersion: z.string().min(1).check(utf16Max(160)),
          capabilities: capabilitiesSchema.default({}),
          intendedProjectId: z.uuid().optional(),
          installationId: z.uuid().optional(),
          workspaceId: z.uuid().optional(),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async (input) =>
        safeRead(dependencies.reportUnexpectedError, async () => {
          if (containsSensitiveJson(input)) {
            throw new DomainError(
              "validation_failed",
              "Agent metadata contains private or secret material",
            );
          }
          if (
            input.intendedProjectId &&
            input.intendedProjectId !== dependencies.context.projectId
          ) {
            throw new DomainError(
              "forbidden",
              "Agent project binding does not match",
            );
          }
          const policy = await dependencies.queries.getAgentPolicy(
            dependencies.context,
          );
          if (!policy) {
            throw new DomainError(
              "forbidden",
              "Project work policy is unavailable",
            );
          }
          return {
            agentPrincipalId: dependencies.context.actor.id,
            projectId: dependencies.context.projectId,
            effectiveScopes: [...dependencies.context.scopes].sort(),
            serverSchemaVersion: 1,
            ...policy,
            acceptsPrivateTelemetry:
              dependencies.acceptsPrivateTelemetry ?? false,
            reported: input,
          };
        }),
    );
  }

  registerCommand(server, dependencies, {
    name: "register_agent_installation",
    description: "Register this authenticated agent installation.",
    schema: z.object({
      ...commandMeta,
      softwareName: z.string().min(1).check(utf16Max(160)),
      softwareVersion: z.string().min(1).check(utf16Max(160)),
      capabilities: capabilitiesSchema.default({}),
    }),
  });
  /**
   * The one tool a provisioning grant exists for.
   *
   * What a provisioning grant may reach, stated exactly, because an earlier
   * version of this comment overstated it. `project:provision` gates two tools,
   * not one — this and `provision_agent` below — and `whoami` is registered
   * unconditionally, so such a session lists three. What is true, and what the
   * grant depends on, is narrower: no tool that needs a *project* is among
   * them, which is what lets such a grant name no project at all.
   *
   * The exclusivity that is real lives a layer down: `agent-grant-service.ts`
   * refuses a provisioning grant that carries any other scope, and the database
   * constraint refuses it again. That is enforced and tested. It is not the
   * same claim as "this session reaches one tool", and the two were conflated.
   */
  if (
    dependencies.context.scopes.has("project:provision") &&
    dependencies.createProject
  ) {
    registerMcpOnlyTool(
      server,
      "create_project",
      {
        description:
          "Create a project in this credential's organization, as the human who delegated this grant.",
        inputSchema: z.object({
          /**
           * A correlation id, and named as one because that is what it does.
           *
           * It was called `idempotencyKey` beside `idempotentHint: true`, and
           * neither was true: the value reaches `ProjectService` as a
           * correlation id and nothing deduplicates on it. What actually makes
           * a retry safe is the unique slug per organization — a repeat is
           * refused as a conflict rather than creating a second project — and
           * that is a different promise from "call it twice and get the same
           * answer".
           */
          correlationId: z.uuid(),
          name: z.string().min(1).check(utf16Max(160)),
          slug: z
            .string()
            .min(1)
            .check(utf16Max(63))
            .regex(/^[a-z0-9][a-z0-9-]*$/u, "must be a lowercase slug"),
          keyPrefix: z
            .string()
            .min(1)
            .check(utf16Max(10))
            .regex(/^[A-Z][A-Z0-9]*$/u, "must be uppercase letters and digits"),
          description: z.string().check(utf16Max(2_000)).optional(),
          // zod 4.6 writes the last check's format, `starts_with`, into
          // tools/list; `.meta` keeps the `uri` 0.2.0 listed.
          repositoryUrl: trimmedUrl()
            .startsWith("https://github.com/")
            .meta({ format: "uri" })
            .optional(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          // Retrying is safe — the slug is unique per organization, so a repeat
          // is refused rather than duplicated — but it is not idempotent: the
          // second call answers with a conflict, not the first call's result.
          idempotentHint: false,
        },
      },
      async (input) => {
        try {
          const { correlationId, ...project } = input;
          return content(
            (await dependencies.createProject?.(project, {
              correlationId,
            })) ?? {},
          );
        } catch (error) {
          return errorResult(error, dependencies.reportUnexpectedError);
        }
      },
    );
  }

  if (
    dependencies.context.scopes.has("project:provision") &&
    dependencies.provisionAgent
  ) {
    registerMcpOnlyTool(
      server,
      "provision_agent",
      {
        description:
          "Create an agent principal in a project of this organization and issue its first credential.",
        inputSchema: z.object({
          idempotencyKey: z.uuid(),
          projectId: z.uuid(),
          displayName: z.string().min(1).check(utf16Max(160)),
          slug: z
            .string()
            .min(1)
            .check(utf16Max(120))
            .regex(/^[a-z0-9][a-z0-9-]*$/u, "must be a lowercase slug"),
          softwareName: z.string().min(1).check(utf16Max(160)).optional(),
          laneIds: z.array(z.uuid()).max(100).default([]),
          /**
           * Working scopes only. A provisioning credential that could mint
           * another is a foothold rather than a capability, and the exclusivity
           * rule everywhere else would be decoration if the scope could be
           * handed out from here. Refused in the schema so the refusal cannot
           * be skipped by a caller that reaches the host directly.
           */
          scopes: z
            .array(z.string().min(1).check(utf16Max(64)))
            .min(1)
            .max(30)
            .refine(
              (values) => !values.includes("project:provision"),
              "A provisioned credential may not carry project:provision",
            ),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (input) => {
        try {
          const { idempotencyKey, ...provision } = input;
          return content(
            (await dependencies.provisionAgent?.(provision, {
              idempotencyKey,
            })) ?? {},
          );
        } catch (error) {
          return errorResult(error, dependencies.reportUnexpectedError);
        }
      },
    );
  }

  registerRegistryTool(
    server,
    dependencies,
    "register_project",
    {
      description:
        "Idempotently register an alias or canonical GitHub repository for the project bound to this agent credential.",
      inputSchema: z
        .object({
          ...commandMeta,
          alias: z.string().min(1).check(utf16Max(120)).optional(),
          // zod 4.6 writes the last check's format, `starts_with`, into
          // tools/list; `.meta` keeps the `uri` 0.2.0 listed.
          repositoryUrl: trimmedUrl()
            .startsWith("https://github.com/")
            .meta({ format: "uri" })
            .optional(),
        })
        .refine((value) => value.alias || value.repositoryUrl, {
          message: "An alias or repositoryUrl is required",
        }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const { idempotencyKey, expectedVersion, ...registration } = input;
        return content(
          (await dependencies.registerProject?.(registration, {
            idempotencyKey,
            expectedVersion,
          })) ?? {},
        );
      } catch (error) {
        return errorResult(error, dependencies.reportUnexpectedError);
      }
    },
    Boolean(dependencies.registerProject),
  );
  registerCommand(server, dependencies, {
    name: "register_machine_workspace",
    description:
      "Register safe capabilities and encrypted private machine telemetry.",
    schema: z.object({
      ...commandMeta,
      projectId: z.uuid(),
      repositoryId: z.uuid(),
      installationId: z.uuid(),
      safeCapabilities: capabilitiesSchema.default({}),
      privateTelemetry: boundedJsonRecord(128),
      telemetrySchemaVersion: z.number().int().positive().default(1),
    }),
    onlyIf: Boolean(dependencies.acceptsPrivateTelemetry),
  });

  const createDraftSchema = z.object({
    ...commandMeta,
    targetProjectId: z.uuid(),
    laneId: z.uuid().nullable().optional(),
    type: z.enum(["feature", "bug", "question", "chore", "investigation"]),
    title: z.string().min(1).check(utf16Max(240)),
    descriptionMd: z.string().min(1).check(utf16Max(100_000)),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    visibility: z.enum(["organization", "restricted"]).default("organization"),
    sensitivity: z.enum(["normal", "sensitive"]).default("normal"),
    labels: z
      .array(z.string().trim().min(1).check(utf16Max(80)))
      .max(50)
      .default([]),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).check(utf16Max(2_000)))
      .max(100)
      .default([]),
  });
  registerCommand(server, dependencies, {
    name: "create_request_draft",
    description: "Create a project-sourced request draft.",
    schema: createDraftSchema,
    mapInput: (input) => ({
      ...input,
      sourceKind: "project",
      sourceProjectId: dependencies.context.projectId,
    }),
  });

  const simpleRequestCommand = z.object({
    ...commandMeta,
    requestId: z.uuid(),
  });
  registerCommand(server, dependencies, {
    name: "submit_request",
    description: "Submit a request draft through routing policy.",
    schema: simpleRequestCommand,
  });
  registerCommand(server, dependencies, {
    name: "withdraw_request",
    description: "Withdraw a submitted or triage request as its reporter.",
    schema: z.object({
      ...commandMeta,
      requestId: z.uuid(),
      reason: z.string().min(1).check(utf16Max(20_000)),
    }),
  });
  registerCommand(server, dependencies, {
    name: "update_request",
    description: "Update the mutable content of a non-terminal request.",
    schema: z.object({
      ...commandMeta,
      requestId: z.uuid(),
      title: z.string().min(1).check(utf16Max(240)).optional(),
      descriptionMd: z.string().min(1).check(utf16Max(100_000)).optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      visibility: z.enum(["organization", "restricted"]).optional(),
      sensitivity: z.enum(["normal", "sensitive"]).optional(),
    }),
  });
  registerCommand(server, dependencies, {
    name: "assign_request",
    description:
      "Assign a non-terminal request to an active member of the organization, or unassign it with null.",
    schema: z.object({
      ...commandMeta,
      requestId: z.uuid(),
      assigneeUserId: z.string().trim().min(1).check(utf16Max(255)).nullable(),
    }),
  });
  registerCommand(server, dependencies, {
    name: "post_message",
    description: "Post a canonical request comment.",
    schema: z.object({
      ...commandMeta,
      requestId: z.uuid(),
      bodyMd: z.string().min(1).check(utf16Max(100_000)),
      visibility: z
        .enum(["organization", "restricted"])
        .default("organization"),
      replyToId: z.uuid().nullable().optional(),
      mentionUserIds: z
        .array(z.string().min(1).check(utf16Max(255)))
        .max(100)
        .default([]),
    }),
  });
  registerCommand(server, dependencies, {
    name: "link_requests",
    description: "Create a typed relationship between two requests.",
    schema: z.object({
      ...commandMeta,
      fromRequestId: z.uuid(),
      toRequestId: z.uuid(),
      type: z.enum([
        "related_to",
        "blocks",
        "depends_on",
        "duplicates",
        "supersedes",
        "derived_from",
      ]),
    }),
  });
  registerCommand(server, dependencies, {
    name: "unlink_requests",
    description: "Remove an outgoing request relationship.",
    schema: z.object({
      ...commandMeta,
      requestId: z.uuid(),
      relationshipId: z.uuid(),
    }),
  });
  registerCommand(server, dependencies, {
    name: "ask_question",
    description: "Ask a durable request-scoped HITL question.",
    schema: z.object({
      ...commandMeta,
      requestId: z.uuid(),
      audienceType: z.enum([
        "user",
        "agent",
        "role",
        "requester",
        "target_maintainers",
      ]),
      audienceId: z.string().min(1).check(utf16Max(255)).nullable().optional(),
      bodyMd: z.string().min(1).check(utf16Max(100_000)),
      choices: z
        .array(z.string().trim().min(1).check(utf16Max(160)))
        .max(8)
        .default([]),
      allowFreeText: z.boolean().default(true),
      answerMode: z.enum(["single", "multiple"]).default("single"),
      blocksRequest: z.boolean().default(false),
      deadlineAt: isoDatetime().nullable().optional(),
      escalationPolicy: z
        .object({
          reminderOffsetsMinutes: z
            .array(z.number().int().min(0).max(10_080))
            .max(10)
            .default([1_440, 0]),
          escalateAfterMinutes: z
            .number()
            .int()
            .min(0)
            .max(43_200)
            .nullable()
            .default(60),
          escalationAudience: z
            .enum(["project_maintainers", "organization_admins"])
            .nullable()
            .default("project_maintainers"),
        })
        .strict()
        .nullable()
        .optional(),
    }),
    mapInput: (input) => {
      const audienceType = String(input.audienceType);
      const id =
        typeof input.audienceId === "string" ? input.audienceId : undefined;
      const audience =
        audienceType === "target_maintainers"
          ? { type: "project_maintainers" }
          : audienceType === "requester"
            ? { type: "requester" }
            : { type: audienceType, id };
      return {
        ...input,
        audience,
        audienceType: undefined,
        audienceId: undefined,
      };
    },
  });
  registerCommand(server, dependencies, {
    name: "answer_question",
    description: "Answer a canonical HITL question.",
    schema: z.object({
      ...commandMeta,
      questionId: z.uuid(),
      bodyMd: z.string().min(1).check(utf16Max(100_000)),
      structuredValue: z.json().nullable().optional(),
      sourceChannel: z.literal("mcp").default("mcp"),
    }),
  });
  registerCommand(server, dependencies, {
    name: "close_question",
    description: "Close a non-blocking or already-resolved question.",
    schema: z.object({
      ...commandMeta,
      questionId: z.uuid(),
      reason: z.string().min(1).check(utf16Max(20_000)),
    }),
  });
  registerCommand(server, dependencies, {
    name: "attach_artifact",
    description:
      "Attach external artifact metadata; file upload is not supported.",
    schema: z.object({
      ...commandMeta,
      requestId: z.uuid(),
      kind: z.string().min(1).check(utf16Max(64)),
      // As `repositoryUrl` above: tools/list keeps 0.2.0's `uri`.
      externalUrl: trimmedUrl().startsWith("https://").meta({ format: "uri" }),
      mediaType: z.string().check(utf16Max(255)).nullable().optional(),
      byteSize: z.number().int().nonnegative().nullable().optional(),
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .nullable()
        .optional(),
      provenance: boundedJsonRecord(64).default({}),
    }),
  });

  for (const command of [
    [
      "claim_request",
      z.object({
        ...commandMeta,
        requestId: z.uuid(),
        installationId: z.uuid(),
        workspaceId: z.uuid(),
      }),
    ],
    [
      "start_work_session",
      simpleRequestCommand
        .omit({ requestId: true })
        .extend({ workSessionId: z.uuid() }),
    ],
    [
      "heartbeat_work_session",
      simpleRequestCommand
        .omit({ requestId: true })
        .extend({ workSessionId: z.uuid() }),
    ],
    [
      "pause_work_session",
      simpleRequestCommand.omit({ requestId: true }).extend({
        workSessionId: z.uuid(),
        reason: z.string().trim().min(1).check(utf16Max(20_000)),
      }),
    ],
    [
      "resume_work_session",
      simpleRequestCommand.omit({ requestId: true }).extend({
        workSessionId: z.uuid(),
        reason: z.string().trim().min(1).check(utf16Max(20_000)),
      }),
    ],
    [
      "block_work_session",
      simpleRequestCommand.omit({ requestId: true }).extend({
        workSessionId: z.uuid(),
        reason: z.string().trim().min(1).check(utf16Max(20_000)),
      }),
    ],
    [
      "release_request",
      simpleRequestCommand.omit({ requestId: true }).extend({
        workSessionId: z.uuid(),
        reason: z.string().trim().min(1).check(utf16Max(20_000)),
      }),
    ],
    [
      "end_work_session",
      simpleRequestCommand.omit({ requestId: true }).extend({
        workSessionId: z.uuid(),
        reason: z.string().trim().min(1).check(utf16Max(20_000)),
        outcomeSummaryMd: z
          .string()
          .trim()
          .min(1)
          .check(utf16Max(100_000))
          .optional(),
      }),
    ],
  ] as const) {
    registerCommand(server, dependencies, {
      name: command[0],
      description: `Execute ${command[0].replaceAll("_", " ")}.`,
      schema: command[1],
    });
  }
  registerCommand(server, dependencies, {
    name: "post_work_update",
    description: "Post a semantic progress update for a live work session.",
    schema: z.object({
      ...commandMeta,
      workSessionId: z.uuid(),
      kind: z.enum(["progress", "checkpoint", "blocker", "note"]),
      bodyMd: z.string().min(1).check(utf16Max(100_000)),
      progressPercent: z
        .number()
        .int()
        .min(0)
        .max(100)
        .nullable()
        .default(null),
      evidence: z.array(boundedJsonRecord(64)).max(100).default([]),
    }),
  });
  registerCommand(server, dependencies, {
    name: "transition_request",
    description: "Apply an allowed request lifecycle action.",
    schema: z.object({
      ...commandMeta,
      requestId: z.uuid(),
      action: z.enum(transitionActions()),
      reason: z.string().check(utf16Max(20_000)).optional(),
      relatedRequestId: z.uuid().optional(),
    }),
  });
  for (const action of [
    "begin_request_work",
    "block_request",
    "resume_request",
  ] as const) {
    registerCommand(server, dependencies, {
      name: action,
      description: `Apply the ${action.replaceAll("_", " ")} lifecycle action as an authorized worker.`,
      schema: z.object({
        ...commandMeta,
        requestId: z.uuid(),
        reason: z.string().check(utf16Max(20_000)).optional(),
      }),
    });
  }
  registerCommand(server, dependencies, {
    name: "complete_request",
    description: "Submit the mandatory structured completion report.",
    schema: z.object({
      ...commandMeta,
      requestId: z.uuid(),
      report: z.object({
        outcomeMd: z.string().trim().min(1).check(utf16Max(100_000)),
        changedRepositories: z
          .array(
            z
              .object({
                repositoryId: z.uuid().optional(),
                repositoryUrl: trimmedUrl().check(utf16Max(4_096)).optional(),
                commitSha: z
                  .string()
                  .regex(/^[0-9a-f]{7,64}$/u)
                  .optional(),
                artifactId: z.uuid().optional(),
              })
              .refine(
                (value) =>
                  Boolean(
                    value.repositoryId ||
                      value.repositoryUrl ||
                      value.commitSha ||
                      value.artifactId,
                  ),
                "A changed repository reference is required",
              ),
          )
          .max(100),
        validations: z
          .array(
            z.object({
              command: z.string().trim().min(1).check(utf16Max(2_000)),
              result: z.enum(["passed", "failed", "not_run"]),
              summary: z.string().trim().check(utf16Max(4_000)).optional(),
            }),
          )
          .min(1)
          .max(200),
        risksMd: z.string().trim().check(utf16Max(50_000)),
        followupsMd: z.string().trim().check(utf16Max(50_000)),
        verificationStepsMd: z.string().trim().min(1).check(utf16Max(50_000)),
      }),
    }),
  });
  registerCommand(server, dependencies, {
    name: "verify_request",
    description: "Verify a completed request with evidence.",
    schema: z.object({
      ...commandMeta,
      requestId: z.uuid(),
      reason: z.string().trim().min(1).check(utf16Max(20_000)),
      verificationEvidence: z.string().trim().min(1).check(utf16Max(100_000)),
    }),
  });

  if (
    dependencies.context.scopes.has("webhook:manage") &&
    dependencies.webhooks
  ) {
    registerMcpOnlyTool(
      server,
      "list_event_subscriptions",
      {
        description: "List event subscriptions for the granted project.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async () =>
        safeRead(
          dependencies.reportUnexpectedError,
          async () => dependencies.webhooks?.list() ?? { items: [] },
        ),
    );
    registerMcpOnlyTool(
      server,
      "create_event_subscription",
      {
        description:
          "Create a project-scoped signed webhook. The signing secret is returned once.",
        inputSchema: z.object({
          ...commandMeta,
          name: z.string().min(1).check(utf16Max(160)),
          endpointUrl: trimmedUrl().check(utf16Max(2_048)),
          eventTypes: z
            .array(z.string().min(1).check(utf16Max(160)))
            .max(100)
            .default([]),
          requestTypes: z
            .array(z.string().min(1).check(utf16Max(80)))
            .max(50)
            .default([]),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (input) => {
        try {
          const { idempotencyKey, expectedVersion, ...settings } = input;
          return content(
            (await dependencies.webhooks?.create(settings, {
              idempotencyKey,
              expectedVersion,
            })) ?? {},
          );
        } catch (error) {
          return errorResult(error, dependencies.reportUnexpectedError);
        }
      },
    );
    registerMcpOnlyTool(
      server,
      "verify_event_subscription",
      {
        description: "Verify and activate a webhook endpoint.",
        inputSchema: z.object({ ...commandMeta, subscriptionId: z.uuid() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async ({ subscriptionId, expectedVersion, idempotencyKey }) => {
        try {
          return content(
            (await dependencies.webhooks?.verify(subscriptionId, {
              expectedVersion,
              idempotencyKey,
            })) ?? {},
          );
        } catch (error) {
          return errorResult(error, dependencies.reportUnexpectedError);
        }
      },
    );
    registerMcpOnlyTool(
      server,
      "rotate_event_subscription_secret",
      {
        description:
          "Rotate a webhook signing secret with a bounded overlap. The new secret is returned once.",
        inputSchema: z.object({
          ...commandMeta,
          subscriptionId: z.uuid(),
          overlapMinutes: z.number().int().min(5).max(1_440).default(60),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async ({
        subscriptionId,
        expectedVersion,
        idempotencyKey,
        overlapMinutes,
      }) => {
        try {
          return content(
            (await dependencies.webhooks?.rotate(
              subscriptionId,
              overlapMinutes,
              { expectedVersion, idempotencyKey },
            )) ?? {},
          );
        } catch (error) {
          return errorResult(error, dependencies.reportUnexpectedError);
        }
      },
    );
    registerMcpOnlyTool(
      server,
      "set_event_subscription_status",
      {
        description: "Enable, disable, or revoke a webhook subscription.",
        inputSchema: z.object({
          ...commandMeta,
          subscriptionId: z.uuid(),
          status: z.enum(["active", "disabled", "revoked"]),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      async ({ subscriptionId, expectedVersion, idempotencyKey, status }) => {
        try {
          return content(
            (await dependencies.webhooks?.setStatus(subscriptionId, status, {
              expectedVersion,
              idempotencyKey,
            })) ?? {},
          );
        } catch (error) {
          return errorResult(error, dependencies.reportUnexpectedError);
        }
      },
    );
    registerMcpOnlyTool(
      server,
      "replay_event_delivery",
      {
        description:
          "Replay a retained webhook delivery with a new delivery ID.",
        inputSchema: z.object({ ...commandMeta, deliveryId: z.uuid() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async ({ deliveryId, expectedVersion, idempotencyKey }) => {
        try {
          return content(
            (await dependencies.webhooks?.replay(deliveryId, {
              expectedVersion,
              idempotencyKey,
            })) ?? {},
          );
        } catch (error) {
          return errorResult(error, dependencies.reportUnexpectedError);
        }
      },
    );
  }

  if (dependencies.context.scopes.has("import:write") && dependencies.imports) {
    registerMcpOnlyTool(
      server,
      "list_legacy_imports",
      {
        description:
          "List preserved legacy import runs for the granted project.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async () =>
        safeRead(
          dependencies.reportUnexpectedError,
          async () => dependencies.imports?.list() ?? { items: [] },
        ),
    );
    registerMcpOnlyTool(
      server,
      "get_legacy_import",
      {
        description:
          "Read one legacy import manifest and review state for the granted project.",
        inputSchema: z.object({ runId: z.uuid() }),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async ({ runId }) => {
        try {
          return content((await dependencies.imports?.detail(runId)) ?? null);
        } catch (error) {
          return errorResult(error, dependencies.reportUnexpectedError);
        }
      },
    );
    registerMcpOnlyTool(
      server,
      "analyze_legacy_import",
      {
        description:
          "Start deterministic analysis of an already preserved source snapshot. Capture bytes through the bounded REST upload first.",
        inputSchema: z.object({
          ...commandMeta,
          sourceId: z.uuid(),
          snapshotId: z.uuid(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async ({ sourceId, snapshotId, idempotencyKey, expectedVersion }) => {
        try {
          return content(
            (await dependencies.imports?.analyze(sourceId, snapshotId, {
              idempotencyKey,
              expectedVersion,
            })) ?? {},
          );
        } catch (error) {
          return errorResult(error, dependencies.reportUnexpectedError);
        }
      },
    );
    registerMcpOnlyTool(
      server,
      "apply_legacy_import",
      {
        description:
          "Apply a human-approved immutable legacy manifest after supplying its full SHA-256 hash.",
        inputSchema: z.object({
          ...commandMeta,
          runId: z.uuid(),
          manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      async ({ runId, manifestSha256, idempotencyKey, expectedVersion }) => {
        try {
          return content(
            (await dependencies.imports?.apply(runId, manifestSha256, {
              idempotencyKey,
              expectedVersion,
            })) ?? {},
          );
        } catch (error) {
          return errorResult(error, dependencies.reportUnexpectedError);
        }
      },
    );
    registerMcpOnlyTool(
      server,
      "correct_legacy_import",
      {
        description:
          "Create a new compensating review run from an applied import without mutating its source, mappings, report, or history.",
        inputSchema: z.object({ ...commandMeta, runId: z.uuid() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async ({ runId, idempotencyKey, expectedVersion }) => {
        try {
          return content(
            (await dependencies.imports?.correct(runId, {
              idempotencyKey,
              expectedVersion,
            })) ?? {},
          );
        } catch (error) {
          return errorResult(error, dependencies.reportUnexpectedError);
        }
      },
    );
  }

  return server;
}

/**
 * RequestPort's bound on an MCP request body, below the SDK's 4 MiB.
 * `handleMcpRequest` enforces it on a declared `content-length` and, while the
 * 2026-07-28 leg is on, also while reading the body of either era. With the
 * leg off, a body with no declared length is bounded by the route instead,
 * which reads every POST through `readBoundedRequestBody(request, 524_288)`
 * before calling this; inside this package that path accepts up to the SDK's
 * 4 MiB, as it did on 1.30.1.
 */
const maxRequestBodySize = 524_288;

/**
 * A JSON POST's body, parsed as the SDK parses it (`readRequestBody` under
 * the same bound, then `JSON.parse`), with every own `__proto__` key
 * removed (`dropOwnProtoKeys`), for the SDK to take as `parsedBody`. zod
 * 4.4.3, which 0.2.0 ran, dropped such a key wherever a tool's schema met
 * it; zod 4.6.7's strict objects refuse it. `undefined`, so that the SDK
 * reads the body itself and answers as it always has, for anything else: a
 * request that is not a POST, not JSON, empty, over the bound, unreadable or
 * not JSON. It reads a clone, so the request is whole for the SDK either way.
 */
async function bodyWithoutOwnProtoKeys(request: Request): Promise<unknown> {
  if (
    request.method.toUpperCase() !== "POST" ||
    !isJsonContentType(request.headers.get("content-type"))
  )
    return undefined;
  let text: string;
  try {
    const read = await readRequestBody(request.clone(), maxRequestBodySize);
    if (read.tooLarge || read.text.length === 0) return undefined;
    text = read.text;
  } catch {
    return undefined;
  }
  try {
    return dropOwnProtoKeys(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Serve one MCP request, in whichever protocol era it speaks.
 *
 * 2025-era traffic (the `initialize` handshake and everything a 2025 client
 * sends after it, GET and DELETE included) goes to a per-request
 * `WebStandardStreamableHTTPServerTransport` built exactly as before the v2
 * SDK: stateless, answering JSON. `legacy-wire.test.ts` pins that wire.
 *
 * The 2026-07-28 era is served only when `dependencies.modernProtocol` is
 * true, which the route sets for `REQUESTPORT_MCP_MODERN=enabled` alone. Then
 * a request the SDK's own `isLegacyRequest` does not classify as 2025-era goes
 * to `createMcpHandler`, built per request because the dependencies are the
 * credential's. It rejects 2025-era traffic rather than serving it
 * statelessly, because its stateless leg answers without
 * `enableJsonResponse` and refuses GET and DELETE, both changes to the wire
 * above; `isLegacyRequest` keeps that traffic away from it. It answers JSON:
 * this server emits no notification before a result. Its tool list carries
 * the SDK's cache hint, `cacheScope: "private"`, which must stay private
 * because the list depends on the credential's scopes.
 *
 * Nothing here ever sends `notifications/tools/list_changed`: the tool list
 * changes only with a new credential. The modern leg therefore advertises
 * `tools.listChanged: false`, and closes the handler once the request is
 * answered, which ends any `subscriptions/listen` stream at once with the
 * spec's graceful-close result instead of holding the function open until
 * its time limit. The 2025 leg still advertises `listChanged: true`, as the
 * v1 SDK did, so that wire does not change.
 */
export async function handleMcpRequest(
  request: Request,
  dependencies: McpServerDependencies,
): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxRequestBodySize) {
    return Response.json({ error: "request_too_large" }, { status: 413 });
  }
  const parsedBody = await bodyWithoutOwnProtoKeys(request);
  if (
    !dependencies.modernProtocol ||
    (await isLegacyRequest(request, parsedBody, { maxRequestBodySize }))
  ) {
    const server = createRequestPortMcpServer(dependencies);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody });
  }
  const handler = createMcpHandler(
    () => {
      const server = createRequestPortMcpServer(dependencies);
      server.server.registerCapabilities({ tools: { listChanged: false } });
      return server;
    },
    { legacy: "reject", responseMode: "json", maxRequestBodySize },
  );
  try {
    return await handler.fetch(request, { parsedBody });
  } finally {
    await handler.close();
  }
}
