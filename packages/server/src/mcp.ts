/**
 * MCP (Plan 13, H.1; manifest-h.md §1.2, §2.2; ruling 147): the handler
 * behind `/mcp` for GET, POST and DELETE, `handleMcp`, an adapter over core
 * (Plan 13, G.6; manifest-g.md §2.5; ruling 137).
 *
 * Moved here from `apps/web/src/app/mcp/route.ts`, whose `GET`, `POST` and
 * `DELETE` now hand each request to `handleMcp` with the web's own
 * collaborators; the host (`host.ts`) hands it its own. The media-type
 * check, the bounded body and its JSON checks, the request rebuilt over the
 * body, the rate-limit classes (`mutation` for POST, `token` otherwise),
 * the dependencies `handleMcpRequest` is handed and their order,
 * `cache-control: no-store` on its answer, the refusal (`unauthorized.ts`),
 * the three metric names and `unexpectedErrorCode` are the route's,
 * unchanged. It is handed, and uses at the point in each request where the
 * route used its own:
 *
 * - the agent bearer authenticator, asked for the `mcp` audience;
 * - the rate limiter;
 * - the RequestPort, asked for once a request is authenticated and
 *   limited, once, and never for a request refused before then. Everything
 *   the tools run is what it composes: `packages/mcp` runs each registry
 *   tool by its domain command name on its command bus and the nine query
 *   tools on its agent queries; `register_project` runs through its
 *   `execute`, as the REST entry of the same name; the MCP-only tools run
 *   its `mcpOnly` capabilities (the delegated provisioning, the webhook
 *   management service and the delivery replay, and the five legacy import
 *   tools). MCP keeps its own admission: it offers a tool by its
 *   registration and the credential's scope, never by REST's
 *   `admitsCredentialKind`, and REST's injected fields and project
 *   requirement are REST's;
 * - the project scope (`withProject`), asked only when a tool needs the
 *   bound project;
 * - the `WWW-Authenticate` challenge, for MCP's protected-resource
 *   document;
 * - whether a session may accept private telemetry, and whether to serve
 *   the 2026-07-28 protocol era, each asked once a request is admitted (the
 *   web judges `REQUESTPORT_MCP_MODERN` on each request; the host's are
 *   fixed when it is made);
 * - the logger an error nothing recognised is written to, and the metric
 *   sink. Beside `requestPortMetricNames`' `mcp.tool_duration_ms` and
 *   `mcp.tool_error_total`, the sink is asked to count
 *   `mcp.unexpected_error_total`, which that list does not hold, as the
 *   route's did;
 * - the body's bound, `MCP_MAX_BODY` unless given.
 */
import type {
  AgentAudience,
  AgentAuthContext,
} from "@requestport/auth/create-auth";
import type { RequestPort, RequestPortLogger } from "@requestport/core";
import { DomainError, type JsonValue } from "@requestport/domain";
import { handleMcpRequest } from "@requestport/mcp";

import { assertJsonDepth, readBoundedRequestBody } from "./input-limits.js";
import type { RateLimiter } from "./rate-limit.js";
import { type Challenge, unauthorized } from "./unauthorized.js";

/** The most bytes of an MCP request's body read: 524,288. */
export const MCP_MAX_BODY = 524_288;

/** Where the handler counts and times what it serves. */
export interface McpMetrics {
  count(name: string, value: number, labels?: Record<string, string>): void;
  observe(name: string, value: number, labels?: Record<string, string>): void;
}

export interface McpOptions {
  /** Authenticates the request's agent bearer; asked for the `mcp` audience. */
  authenticateAgentBearer: (
    request: Request,
    audience: AgentAudience,
  ) => Promise<AgentAuthContext>;
  /** The fingerprint and the decision, for the `mutation` and `token` classes. */
  rateLimiter: Pick<RateLimiter, "enforce" | "fingerprint">;
  /** The RequestPort the tools run on, asked for once a request is admitted. */
  requestPort: () => RequestPort;
  /** The context, proven to name a project, or the `forbidden` refusal. */
  withProject: (context: AgentAuthContext) => { projectId: string };
  /** The `WWW-Authenticate` value for a protected-resource document's path. */
  challenge: Challenge;
  /** Whether a session may accept private telemetry. */
  privateTelemetry: () => boolean;
  /** Whether to serve the 2026-07-28 protocol era beside the 2025 one. */
  modernProtocol: () => boolean;
  /** Where an error nothing recognised is written down. */
  logger: Pick<RequestPortLogger, "error">;
  metrics: McpMetrics;
  /** The most bytes of a body read: `MCP_MAX_BODY` unless given. */
  maxBody?: number;
}

/**
 * What is safe to write down about an error nothing recognised.
 *
 * The logger's field list carries no free-text message, deliberately: an
 * exception's message is where a database quotes the offending value, so
 * repeating it would put rows into a log. What is left is schema rather than
 * data — the error's constructor, a PostgreSQL `SQLSTATE`, the constraint that
 * refused — and that is the same line this repository already draws in its
 * acceptance teardown, which reports a code and a constraint name and drops
 * `message` and `detail`.
 *
 * It is enough to act on. "TypeError" and "error 23503 on
 * agent_credentials_principal_fk" point at different halves of the system,
 * and before this the answer to both was silence.
 */
function unexpectedErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return typeof error;

  const { body, code, constraint, name, status } = error as Readonly<{
    body?: unknown;
    code?: unknown;
    constraint?: unknown;
    name?: unknown;
    status?: unknown;
  }>;
  // Better Auth raises `APIError`, whose `status` is a short enum such as
  // `BAD_REQUEST` and whose `body.code` is one of its own reason codes. Both
  // are vocabulary rather than values; `body.message` is not, and is dropped.
  const reason = (body as Readonly<{ code?: unknown }> | undefined)?.code;

  /*
    Joined with dots, and each part reduced to the characters the logger keeps.

    `errorCode` is a label field: `safeLogRecord` tests it against
    `/^[a-z0-9][a-z0-9_.:-]{0,119}$/i` and drops the whole field when it does
    not match, saying nothing. A space-separated version of this string was
    therefore logged as no error code at all — the field simply went missing,
    which is worse than the silence it replaced because the line looks complete.
    Sanitising here rather than hoping means this value is always recorded.
  */
  const parts = [
    typeof name === "string" ? name : "Error",
    typeof status === "string" || typeof status === "number"
      ? String(status)
      : undefined,
    typeof reason === "string" ? reason : undefined,
    typeof code === "string" ? code : undefined,
    typeof constraint === "string" ? constraint : undefined,
  ]
    .filter((part) => part !== undefined)
    .map((part) => part.replaceAll(/[^a-z0-9_:-]+/giu, "-"))
    .filter((part) => part !== "" && part !== "-");

  return (
    parts
      .join(".")
      .replace(/^[^a-z0-9]+/iu, "")
      .slice(0, 119) || "Error"
  );
}

export async function handleMcp(
  request: Request,
  options: McpOptions,
): Promise<Response> {
  const startedAt = performance.now();
  let toolName = request.method.toLowerCase();
  let metricStatus = "ok";
  try {
    let boundedRequest = request;
    if (request.method === "POST") {
      if (
        request.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      ) {
        return Response.json(
          {
            error: "unsupported_media_type",
            message: "MCP requests require application/json.",
          },
          { status: 415, headers: { "cache-control": "no-store" } },
        );
      }
      const body = await readBoundedRequestBody(
        request,
        options.maxBody ?? MCP_MAX_BODY,
      );
      if (body.byteLength > 0) {
        try {
          const parsed = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          );
          assertJsonDepth(parsed);
          if (
            parsed &&
            typeof parsed === "object" &&
            "method" in parsed &&
            parsed.method === "tools/call" &&
            "params" in parsed &&
            parsed.params &&
            typeof parsed.params === "object" &&
            "name" in parsed.params &&
            typeof parsed.params.name === "string" &&
            /^[a-z0-9_]{1,80}$/u.test(parsed.params.name)
          ) {
            toolName = parsed.params.name;
          }
        } catch (error) {
          if (error instanceof DomainError) throw error;
          throw new DomainError(
            "validation_failed",
            "MCP JSON input is invalid",
          );
        }
      }
      boundedRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
      });
    }
    const context = await options.authenticateAgentBearer(request, "mcp");
    await options.rateLimiter.enforce({
      endpointClass: request.method === "POST" ? "mutation" : "token",
      fingerprint: options.rateLimiter.fingerprint(
        context.authorizationId,
        context.actor.id,
      ),
    });
    const port = options.requestPort();
    const webhooks = port.mcpOnly.webhooks;
    const imports = port.mcpOnly.imports;
    /** This session's call, as the RequestPort's capabilities take it. */
    const call = { context, credentialKind: "agent" as const };
    const json = (value: unknown) =>
      JSON.parse(JSON.stringify(value)) as JsonValue;
    /**
     * The bound project, demanded only when something actually needs it.
     *
     * A provisioning grant names no project and must still be able to connect,
     * call `whoami`, and create a project — so this cannot be asserted when the
     * session opens. Every project-scoped handler below calls it instead, and
     * gets a refusal naming the reason rather than a null flowing into a query.
     */
    const boundProject = () => options.withProject(context).projectId;
    const response = await handleMcpRequest(boundedRequest, {
      acceptsPrivateTelemetry: options.privateTelemetry(),
      context,
      commandBus: port.commandBus,
      createProject: async (input, meta) =>
        json(
          await port.mcpOnly.createProject({
            correlationId: meta.correlationId,
            delegatedByUserId: context.actor.delegatedBy?.id,
            // The grant this session is authenticated by: core re-checks it,
            // in the transaction the project is created in, as the bus
            // re-checks a person's credential.
            credentialId: context.authorizationId,
            organizationId: context.organizationId,
            project: input as Parameters<
              typeof port.mcpOnly.createProject
            >[0]["project"],
          }),
        ),
      provisionAgent: async (input, meta) =>
        json(
          await port.mcpOnly.provisionAgent({
            idempotencyKey: meta.idempotencyKey,
            delegatedByUserId: context.actor.delegatedBy?.id,
            // The credential this session is authenticated by IS the grant, so
            // the lineage is not guessed: it is the same identifier the resolve
            // path will later look for.
            issuingGrantId: context.authorizationId,
            organizationId: context.organizationId,
            provision: input as Parameters<
              typeof port.mcpOnly.provisionAgent
            >[0]["provision"],
          }),
        ),
      /*
        An error nothing named, written down once.

        `errorResult` answers `unexpected_error` for anything it does not
        recognise, and answered it in silence: the exception lived inside a
        route handler for a tenth of a second and then nothing about it
        survived anywhere. A provisioning failure that could not be diagnosed
        from a green-looking server log is what added this.
      */
      reportUnexpectedError: (error) => {
        options.logger.error("mcp.unexpected_error", {
          commandName: toolName,
          errorCode: unexpectedErrorCode(error),
        });
        options.metrics.count("mcp.unexpected_error_total", 1, {
          commandName: toolName,
        });
      },
      registerProject: async (input, meta) =>
        json(await port.execute("register_project", input, { ...call, meta })),
      // Each refuses a context bound to no project before it reads.
      queries: port.agentQueries,
      ...(webhooks && context.scopes.has("webhook:manage")
        ? {
            webhooks: {
              list: async () =>
                json({
                  items: await webhooks.list(context, context.organizationId),
                }),
              create: async (
                input: Record<string, unknown>,
                meta: { idempotencyKey: string; expectedVersion: number },
              ) =>
                json(
                  await webhooks.create(
                    context,
                    {
                      ...input,
                      organizationId: context.organizationId,
                      projectId: boundProject(),
                      projectIds: [boundProject()],
                      laneIds: [...context.laneIds],
                    },
                    meta,
                  ),
                ),
              verify: async (
                id: string,
                meta: { idempotencyKey: string; expectedVersion: number },
              ) =>
                json(
                  await webhooks.verify(
                    context,
                    { organizationId: context.organizationId, id },
                    meta,
                  ),
                ),
              rotate: async (
                id: string,
                overlapMinutes: number,
                meta: { idempotencyKey: string; expectedVersion: number },
              ) =>
                json(
                  await webhooks.rotate(
                    context,
                    {
                      organizationId: context.organizationId,
                      id,
                      overlapMinutes,
                    },
                    meta,
                  ),
                ),
              setStatus: async (
                id: string,
                status: "active" | "disabled" | "revoked",
                meta: { idempotencyKey: string; expectedVersion: number },
              ) =>
                json(
                  await webhooks.setStatus(
                    context,
                    { organizationId: context.organizationId, id, status },
                    meta,
                  ),
                ),
              replay: async (
                deliveryId: string,
                meta: { idempotencyKey: string; expectedVersion: number },
              ) => json(await webhooks.replay(deliveryId, { ...call, meta })),
            },
          }
        : {}),
      ...(context.scopes.has("import:write") && context.laneIds.size === 0
        ? {
            imports: {
              list: async () => json(await imports.list(call)),
              detail: async (runId: string) =>
                json(await imports.detail(runId, call)),
              analyze: async (
                sourceId: string,
                snapshotId: string,
                meta: { idempotencyKey: string; expectedVersion: number },
              ) =>
                json(
                  await imports.analyze(
                    { sourceId, snapshotId },
                    { ...call, meta },
                  ),
                ),
              apply: async (
                runId: string,
                manifestSha256: string,
                meta: { idempotencyKey: string; expectedVersion: number },
              ) =>
                json(
                  await imports.apply(
                    { runId, manifestSha256 },
                    { ...call, meta },
                  ),
                ),
              correct: async (
                runId: string,
                meta: { idempotencyKey: string; expectedVersion: number },
              ) => json(await imports.correct(runId, { ...call, meta })),
            },
          }
        : {}),
      modernProtocol: options.modernProtocol(),
    });
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    metricStatus =
      error instanceof DomainError ? error.code : "unexpected_error";
    options.metrics.count("mcp.tool_error_total", 1, {
      commandName: toolName,
      errorCode: metricStatus,
    });
    return unauthorized(error, options.challenge);
  } finally {
    options.metrics.observe(
      "mcp.tool_duration_ms",
      performance.now() - startedAt,
      {
        commandName: toolName,
        status: metricStatus,
      },
    );
  }
}
