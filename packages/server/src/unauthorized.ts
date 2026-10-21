/**
 * The refusal an MCP request receives (Plan 13, H.1; manifest-h.md §2.2).
 *
 * Moved here from `apps/web/src/app/mcp/unauthorized.ts`, which keeps its
 * `unauthorized(error)` for its test by handing this the web's challenge
 * (`BETTER_AUTH_URL`'s); the MCP handler (`mcp.ts`) hands it the challenge
 * it was given. The statuses, the messages, `retry-after` and the
 * `WWW-Authenticate` challenge on every refusal are the route's, unchanged.
 */
import { DomainError } from "@requestport/domain";

import {
  reauthorizeWithResourceDescription,
  wantsResourceIndicator,
} from "./bearer-challenge.js";
import { RequestTooLargeError } from "./input-limits.js";

/** The `WWW-Authenticate` value for a protected-resource document's path. */
export type Challenge = (
  resourceMetadataPath: string,
  options: { reauthorizeWithResource?: boolean },
) => string;

/**
 * The refusal an unauthenticated or unpermitted MCP request receives, its
 * challenge naming MCP's protected-resource document through `challenge`.
 */
export function unauthorized(error: unknown, challenge: Challenge): Response {
  if (error instanceof RequestTooLargeError) {
    return Response.json(
      { error: "request_too_large", message: "MCP request body is too large" },
      { status: 413, headers: { "cache-control": "no-store" } },
    );
  }
  /**
   * A refusal an agent can act on, in RFC 6750's vocabulary.
   *
   * The diagnosis belongs upstream — `authenticateAgentBearer` is the only code
   * that sees the credential, and it reports one fact: the credential is not in
   * a form this resource can verify, which is what an opaque access token looks
   * like from here. Turning that into HTTP belongs here, and so does the
   * wording: a literal that never leaves this file cannot carry a `"` or a `\`
   * into the `WWW-Authenticate` quoted-string, which nothing interpolated from
   * an error could promise.
   *
   * `resource_metadata` (RFC 9728) is already on every challenge, and it is
   * where the client reads the resource identifier this asks it to indicate.
   */
  const reauthorizeWithResource =
    error instanceof DomainError && wantsResourceIndicator(error);
  const status =
    error instanceof DomainError
      ? error.code === "unauthenticated"
        ? 401
        : error.code === "rate_limited"
          ? 429
          : error.code === "validation_failed"
            ? 400
            : error.code === "configuration_error"
              ? 503
              : 403
      : 403;
  const message =
    error instanceof DomainError
      ? error.code === "unauthenticated"
        ? reauthorizeWithResource
          ? reauthorizeWithResourceDescription
          : "A valid agent credential is required."
        : error.code === "rate_limited"
          ? "Too many requests. Retry later."
          : error.code === "validation_failed"
            ? "The MCP request is invalid."
            : error.code === "configuration_error"
              ? "RequestPort is temporarily unavailable."
              : "The credential is not permitted to access this resource."
      : "RequestPort authorization failed.";
  return Response.json(
    {
      error: error instanceof DomainError ? error.code : "unexpected_error",
      message: message,
    },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(error instanceof DomainError &&
        error.code === "rate_limited" &&
        typeof error.details.retryAfterSeconds === "number"
          ? { "retry-after": String(error.details.retryAfterSeconds) }
          : {}),
        "www-authenticate": challenge(
          "/.well-known/oauth-protected-resource/mcp",
          { reauthorizeWithResource },
        ),
      },
    },
  );
}
