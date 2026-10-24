/**
 * The REST API (Plan 13, H.1; manifest-h.md §1.2, §2.2): the handlers behind
 * `/api/v1` and every path under it but the artifact import's,
 * `handleRestQuery` for GET and `handleRestCommand` for POST.
 *
 * Moved here from `apps/web/src/app/api/v1/[[...path]]/route.ts`, whose `GET`
 * and `POST` now hand each request to these with the web's own
 * collaborators; the host (`host.ts`) hands them its own. The command
 * envelope, the 524,288-byte bound, the error mapping (`responseError`,
 * `publicDomainMessages`, `publicDomainDetails`), the injected fields and
 * their order, and the document the challenge names are the route's,
 * unchanged. Each handler is handed, and uses at the point in each request
 * where the route used its own:
 *
 * - the API bearer authenticator, which admits an agent or an operator
 *   credential, the one place an operator credential is admitted (F.3,
 *   F3-11);
 * - the rate limiter, for the `token` class on GET and the `mutation` class
 *   on POST;
 * - the path's parts under `/api/v1`, asked for once the request is
 *   admitted (and, on POST, once its content type is JSON);
 * - the RequestPort, asked for as the query or the command runs, once,
 *   and never for a request refused before then: core's `query` and
 *   `execute` hold every dispatch;
 * - the project scope (`withProject`), for a command whose entry requires a
 *   project, and for the project a command's entry injects;
 * - the `WWW-Authenticate` challenge, for `/api/v1`'s protected-resource
 *   document;
 * - the body's bound, `REST_MAX_BODY` unless given.
 *
 * Every command is found in the capability registry by
 * `findRestCommandTransport`, which this module imports from
 * `@requestport/domain` and calls as each request names its command.
 */
import type { ApiAuthContext } from "@requestport/auth/create-auth";
import type { RequestPort } from "@requestport/core";
import { resolveRestQuery } from "@requestport/core/adapters";
import {
  admitsCredentialKind,
  type CredentialKind,
  DomainError,
  findRestCommandTransport,
  isOperatorContext,
  type RestInjectedField,
} from "@requestport/domain";
import { ZodError, z } from "zod";

import {
  reauthorizeWithResourceDescription,
  wantsResourceIndicator,
} from "./bearer-challenge.js";
import {
  assertJsonDepth,
  RequestTooLargeError,
  readBoundedRequestText,
} from "./input-limits.js";
import type { RateLimiter } from "./rate-limit.js";

/** The most bytes of a command's body the REST API reads: 524,288. */
export const REST_MAX_BODY = 524_288;

/** The `WWW-Authenticate` value for a protected-resource document's path. */
type Challenge = (
  resourceMetadataPath: string,
  options: { reauthorizeWithResource?: boolean },
) => string;

export interface RestOptions {
  /**
   * Authenticates the request's bearer: an agent, or an operator credential,
   * which only this API admits.
   */
  authenticateApiBearer: (request: Request) => Promise<ApiAuthContext>;
  /** The fingerprint and the decision, for the `token` and `mutation` classes. */
  rateLimiter: Pick<RateLimiter, "enforce" | "fingerprint">;
  /** The RequestPort that runs the query or the command, asked for as it runs. */
  requestPort: () => Pick<RequestPort, "execute" | "query">;
  /** The context, proven to name a project, or the `forbidden` refusal. */
  withProject: (context: ApiAuthContext) => { projectId: string };
  /** The `WWW-Authenticate` value for a protected-resource document's path. */
  challenge: Challenge;
  /** The most bytes of a command's body read: `REST_MAX_BODY` unless given. */
  maxBody?: number;
}

/**
 * The path's parts under `/api/v1`, as Next hands them to the route's
 * optional catch-all, asked for once.
 */
export type RestPathParts = () => Promise<readonly string[]>;

/** Next's pattern for `app/api/v1/[[...path]]` (`route-regex.js:58`, `:81`). */
const restPath = /^\/api\/v1(?:\/(.+?))?(?:\/)?$/u;

/**
 * The parts of a path under `/api/v1` as Next hands them to the route's
 * optional catch-all (`next@16.3.1`, `dist/shared/lib/router/utils/route-matcher.js:17-35`,
 * **read**): none for `/api/v1` itself, and otherwise what follows it, split
 * on `/`, each segment decoded by `decodeURIComponent`, one trailing `/`
 * aside. None for a path outside `/api/v1`, and none for a path with a
 * segment that does not decode, which Next answers `400` before any route
 * runs (`dist/server/base-server.js:1010-1012`, **read**, not measured).
 */
export function restPathParts(pathname: string): string[] | undefined {
  const matched = restPath.exec(pathname);
  if (!matched) return undefined;
  if (matched[1] === undefined) return [];
  try {
    return matched[1].split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

const commandEnvelopeSchema = z
  .object({
    input: z.record(z.string(), z.unknown()).default({}),
    idempotencyKey: z.string().min(16).max(200),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

function json(value: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(value, {
    ...init,
    headers,
  });
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
  validation_failed: "The request input is invalid.",
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

function responseError(error: unknown, challenge: Challenge) {
  if (error instanceof RequestTooLargeError) {
    return Response.json(
      { error: "request_too_large", message: "API request body is too large" },
      { status: 413, headers: { "cache-control": "no-store" } },
    );
  }
  if (error instanceof ZodError) {
    return Response.json(
      {
        error: "validation_failed",
        message: "API command input is invalid",
      },
      { status: 422, headers: { "cache-control": "no-store" } },
    );
  }
  if (error instanceof DomainError) {
    const status =
      error.code === "unauthenticated"
        ? 401
        : error.code === "forbidden"
          ? 403
          : error.code === "not_found"
            ? 404
            : error.code === "validation_failed"
              ? 422
              : error.code === "configuration_error"
                ? 503
                : error.code === "rate_limited"
                  ? 429
                  : 409;
    return Response.json(
      {
        error: error.code,
        message: wantsResourceIndicator(error)
          ? reauthorizeWithResourceDescription
          : (publicDomainMessages[error.code] ??
            "The RequestPort operation failed."),
        details: publicDomainDetails(error),
      },
      {
        status,
        headers: {
          "cache-control": "no-store",
          ...(error.code === "rate_limited" &&
          typeof error.details.retryAfterSeconds === "number"
            ? { "retry-after": String(error.details.retryAfterSeconds) }
            : {}),
          // The same answer `/mcp` gives, from the same builder. An agent
          // whose refresh dropped the resource indicator used to learn what to
          // do about it at one address and not the other, though the broken
          // credential and the remedy are identical.
          ...(status === 401
            ? {
                "www-authenticate": challenge(
                  "/.well-known/oauth-protected-resource/api/v1",
                  { reauthorizeWithResource: wantsResourceIndicator(error) },
                ),
              }
            : {}),
        },
      },
    );
  }
  return Response.json(
    { error: "unexpected_error", message: "The RequestPort operation failed." },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

/**
 * What this API authenticates (Plan 13, F.3, F3-11): an agent, as before,
 * or an operator credential, which only `authenticateApiBearer`, this API's
 * authenticator and no other surface's, ever admits.
 */
type ApiContext = ApiAuthContext;
type OperatorContext = Extract<ApiContext, { credentialKind: "operator" }>;

function isOperator(context: ApiContext): context is OperatorContext {
  return isOperatorContext(context);
}

function credentialKindOf(context: ApiContext): CredentialKind {
  return isOperator(context) ? "operator" : "agent";
}

/** The value the handler writes into `input` for one injected field. */
function injectedValue(
  injection: RestInjectedField,
  context: ApiContext,
  withProject: RestOptions["withProject"],
) {
  switch (injection.from) {
    case "credential.organizationId":
      return context.organizationId;
    // A grant with no project has none to write, and `withProject` refuses it
    // as the credential it is; writing its `null` in instead had the schema
    // refuse the field as if the caller had sent it.
    case "credential.projectId":
      return withProject(context).projectId;
    case "constant":
      return injection.value;
  }
}

/** `GET /api/v1/…`: one registry query. */
export async function handleRestQuery(
  request: Request,
  pathParts: RestPathParts,
  options: RestOptions,
): Promise<Response> {
  try {
    const context = await options.authenticateApiBearer(request);
    await options.rateLimiter.enforce({
      endpointClass: "token",
      fingerprint: options.rateLimiter.fingerprint(
        context.authorizationId,
        context.actor.id,
      ),
    });
    const parts = await pathParts();

    /**
     * Every GET is a registry query, run by the RequestPort (Plan 13, G.6;
     * manifest-g.md §2.5; ruling 137). Core finds the query the path names,
     * answering the refusals a path no entry admits has always had here
     * (`resolveRestQuery`): the administration prefix, and every path under
     * it, names only an administration read (Plan 13, F.2.0a), whose
     * dispatch refuses an agent credential before it looks anything up, and
     * any other path asks an agent for a project before it is looked up.
     * Then `query` checks the entry and the credential's kind again, and
     * runs the entry's dispatch: an administration read, which re-checks the
     * operator in its own transaction before it reads (F.3, ruling 25),
     * `whoami` for an operator, from its own context (F.3, F3-12), or one of
     * the agent queries, each project-scoped and each checking the scope the
     * registry gives it.
     */
    const { name, pathParameters } = resolveRestQuery(parts, context);
    return json(
      await options
        .requestPort()
        .query(
          name,
          { pathParameters, searchParams: new URL(request.url).searchParams },
          { context, credentialKind: credentialKindOf(context) },
        ),
    );
  } catch (error) {
    return responseError(error, options.challenge);
  }
}

/** `POST /api/v1/commands/<name>`: one registry command. */
export async function handleRestCommand(
  request: Request,
  pathParts: RestPathParts,
  options: RestOptions,
): Promise<Response> {
  try {
    const context = await options.authenticateApiBearer(request);
    await options.rateLimiter.enforce({
      endpointClass: "mutation",
      fingerprint: options.rateLimiter.fingerprint(
        context.authorizationId,
        context.actor.id,
      ),
    });
    if (
      request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      return json(
        {
          error: "unsupported_media_type",
          message: "API commands require application/json.",
        },
        { status: 415 },
      );
    }
    const parts = await pathParts();
    // The commands this API accepts are the capability registry's.
    const transport =
      parts.length === 2 && parts[0] === "commands" && parts[1]
        ? findRestCommandTransport(parts[1])
        : undefined;
    if (!transport) {
      throw new DomainError("not_found", "API command was not found");
    }
    // The kinds of credential the command's registry entry admits (Plan 13,
    // F.3, ruling 25): an entry that names none admits agents only. Checked
    // before the body is read and before anything is dispatched.
    if (!admitsCredentialKind(transport, credentialKindOf(context))) {
      throw new DomainError(
        "forbidden",
        "This kind of credential is not admitted to this command",
      );
    }
    const rawBody = await readBoundedRequestText(
      request,
      options.maxBody ?? REST_MAX_BODY,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      throw new DomainError("validation_failed", "API JSON input is invalid");
    }
    assertJsonDepth(parsed);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new DomainError(
        "validation_failed",
        "API command envelope is invalid",
      );
    }
    const body = commandEnvelopeSchema.parse(parsed);
    // Where the registry says so, a credential bound to no project is refused
    // here, before dispatch, as the credential it is.
    if (transport.routeRequiresProject) options.withProject(context);
    const meta = {
      idempotencyKey: body.idempotencyKey,
      expectedVersion: body.expectedVersion,
    };
    // Injected after the caller's fields, so a value the caller sent for one
    // is overwritten, never trusted. Project registration's entry injects
    // nothing: its repository binds the registration to the credential's
    // organisation and project itself.
    const commandInput = { ...body.input };
    for (const injection of transport.injectedFields) {
      commandInput[injection.field] = injectedValue(
        injection,
        context,
        options.withProject,
      );
    }
    // The RequestPort runs the command (Plan 13, G.6; manifest-g.md §2.5;
    // ruling 137): `execute` checks the entry, the kind and the project
    // again, then dispatches to the entry's target, as the RequestPort
    // composed it over its storage: the command bus, project registration,
    // or one of the off-bus handlers — the two agent revocations (Plan 13,
    // F.2.2), the import split (F.2.6) and the Slack connection test
    // (F.2.5), each of which re-checks the credential in its own
    // transaction and keeps its own receipt or operation key.
    const result = await options
      .requestPort()
      .execute(transport.name, commandInput, {
        context,
        credentialKind: credentialKindOf(context),
        meta,
      });
    return json({ result });
  } catch (error) {
    return responseError(error, options.challenge);
  }
}
