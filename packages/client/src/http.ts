import { z } from "zod";

import { type CredentialStore, resourceFor } from "./credentials.js";
import type { FetchLike } from "./oauth.js";
import { createTokenSource } from "./token-source.js";

/**
 * REST's own answer for a refusal (`apps/web`'s `/api/v1` route):
 * `{ error, message, details }`, where `details` may name the input `field`
 * that was wrong and how many seconds to wait (`retryAfterSeconds`).
 *
 * `code` is the envelope's `error` when it is a plain lowercase word, and
 * otherwise one of this client's own: `unreachable` when the request could
 * not be sent (no `status`), `unexpected_response` when the answer was not
 * the shape REST documents. The message names the method, the path, the
 * server, the code and the status, and repeats nothing else from the
 * response.
 */
export class RequestPortApiError extends Error {
  readonly code: string;
  readonly details: ApiErrorDetails;
  readonly status: number | undefined;

  constructor(
    message: string,
    status: number | undefined,
    code: string,
    details: ApiErrorDetails = {},
  ) {
    super(message);
    this.name = "RequestPortApiError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export type ApiErrorDetails = {
  readonly field?: string;
  readonly retryAfterSeconds?: number;
};

/** What `GET /api/v1/whoami` documents for an agent's credential. */
const WhoAmISchema = z.object({
  actor: z.object({
    delegatedBy: z
      .object({ id: z.string(), type: z.literal("user") })
      .optional(),
    id: z.string(),
    type: z.literal("agent"),
  }),
  audience: z.string(),
  authorizationId: z.string(),
  laneIds: z.array(z.string()),
  organizationId: z.string(),
  projectId: z.string(),
  scopes: z.array(z.string()),
  serverSchemaVersion: z.number(),
  workPolicy: z.record(z.string(), z.unknown()),
});

export type WhoAmI = z.infer<typeof WhoAmISchema>;

/** A registry command's envelope, as REST takes it. */
export type CommandEnvelope = {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly input?: Readonly<Record<string, unknown>>;
};

export type QueryParameters = Readonly<
  Record<string, number | string | readonly (number | string)[]>
>;

export interface RequestPortHttpClientOptions {
  readonly fetch?: FetchLike;
  /** Where the token source keeps its lock; `~/.requestport/locks` unless given. */
  readonly lockDirectory?: string;
  readonly now?: () => number;
  readonly projectId: string;
  readonly server: string;
  readonly store: CredentialStore;
}

/**
 * `/api/v1` by registry name and path. Nothing on it holds a token, and no
 * value it answers carries one.
 */
export interface RequestPortHttpClient {
  /** `POST /api/v1/commands/<name>`; answers the command's `result`. */
  command(name: string, envelope: CommandEnvelope): Promise<unknown>;
  /** `GET /api/v1/<path>`; answers the body. */
  query(path: string, parameters?: QueryParameters): Promise<unknown>;
  /** `GET /api/v1/whoami`, the credential's view of itself. */
  whoami(): Promise<WhoAmI>;
}

/** A registry command's name: lowercase words joined by underscores. */
const COMMAND_NAME = /^[a-z][a-z0-9_]{0,127}$/u;

/** A path segment of RFC 3986's unreserved characters. */
const SEGMENT = /^[A-Za-z0-9._~-]+$/u;

/** REST's `error` codes are lowercase words; anything else is not repeated. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

/** The field names REST itself publishes (`publicDomainDetails`). */
const FIELD = /^[A-Za-z0-9_.-]{1,128}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Longer than any errno symbol (POSIX's longest, `EPROTONOSUPPORT`, has
 * fifteen characters), so a longer run of capitals is not one.
 */
const ERRNO_MAX_LENGTH = 20;

/**
 * An errno symbol, on the error or its cause, is a word from a fixed set and
 * can be repeated. The error's own message may quote the request, and the
 * request carries the bearer token.
 */
function errnoOf(error: unknown): string {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    const code = isRecord(candidate) ? candidate.code : undefined;
    if (
      typeof code === "string" &&
      code.length <= ERRNO_MAX_LENGTH &&
      /^[A-Z][A-Z0-9_]*$/u.test(code)
    ) {
      return ` (${code})`;
    }
  }
  return "";
}

/**
 * The segments of a path under /api/v1, or a TypeError.
 *
 * Every request carries the bearer token, so a path that resolved anywhere
 * but under this server's /api/v1 would hand the token to what it named.
 * One slash at either end is allowed; an empty segment, `.` or `..`, or any
 * character outside the unreserved set (so no `%`, `?`, `#`, `:` or `\`) is
 * refused before a token is taken.
 */
function segmentsOf(path: string): readonly string[] {
  const trimmed = path.replace(/^\//u, "").replace(/\/$/u, "");
  const segments = trimmed.split("/");

  if (
    trimmed === "" ||
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || !SEGMENT.test(segment),
    )
  ) {
    throw new TypeError(
      "A query names a path under /api/v1: segments of letters, digits and . _ ~ -, separated by single slashes, with no . or .. segment.",
    );
  }
  return segments;
}

function detailsOf(body: unknown, headers: Headers): ApiErrorDetails {
  const given = isRecord(body) && isRecord(body.details) ? body.details : {};
  const field =
    typeof given.field === "string" && FIELD.test(given.field)
      ? given.field
      : undefined;

  let retryAfterSeconds =
    typeof given.retryAfterSeconds === "number" &&
    Number.isFinite(given.retryAfterSeconds) &&
    given.retryAfterSeconds > 0
      ? Math.ceil(given.retryAfterSeconds)
      : undefined;
  const header = headers.get("retry-after");
  if (
    retryAfterSeconds === undefined &&
    header !== null &&
    /^\d{1,6}$/u.test(header)
  ) {
    retryAfterSeconds = Number(header);
  }

  return {
    ...(field === undefined ? {} : { field }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/**
 * manifest-h.md §2.8.4's HTTP client. It takes access tokens from a token
 * source for the `api` audience, so it uses the `api` credential and never
 * the `mcp` one, which `/api/v1` refuses. With no `api` credential the token
 * source's `AuthorizationRequiredError` names `requestport login --for api`.
 */
export function createRequestPortHttpClient(
  options: RequestPortHttpClientOptions,
): RequestPortHttpClient {
  const { projectId, server, store } = options;
  const fetch = options.fetch ?? globalThis.fetch;
  const tokens = createTokenSource({
    audience: "api",
    fetch,
    lockDirectory: options.lockDirectory,
    now: options.now,
    projectId,
    server,
    store,
  });
  const base = new URL(resourceFor(server, "api"));
  const origin = base.origin;

  async function call(
    method: "GET" | "POST",
    segments: readonly string[],
    parameters: QueryParameters = {},
    body?: string,
  ): Promise<unknown> {
    const path = `/${segments.join("/")}`;
    const url = new URL(`${base.href}${path}`);
    for (const [name, value] of Object.entries(parameters)) {
      for (const each of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(name, String(each));
      }
    }
    // Composed from checked segments, so this holds; checked anyway, because
    // the request about to be made carries the bearer token.
    if (
      url.origin !== origin ||
      !url.pathname.startsWith(`${base.pathname}/`)
    ) {
      throw new TypeError(`The request would leave ${base.href}.`);
    }

    const token = await tokens.accessToken();
    const what = `${method} ${path} on ${origin}`;

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        ...(body === undefined ? {} : { body }),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        method,
      });
    } catch (error) {
      throw new RequestPortApiError(
        `${what} could not be sent${errnoOf(error)}.`,
        undefined,
        "unreachable",
      );
    }

    let answer: unknown;
    let readable = true;
    try {
      answer = await response.json();
    } catch {
      readable = false;
    }

    if (!response.ok) {
      const code =
        isRecord(answer) &&
        typeof answer.error === "string" &&
        ERROR_CODE.test(answer.error)
          ? answer.error
          : "unexpected_response";
      // A 401 leaves the token source's access token in place: this client
      // keeps presenting it until `EXPIRY_MARGIN_MS` before it expires (the
      // server issues them for 15 minutes), and only the refresh after that
      // reads the store again. So a credential stored by the login named
      // here serves a new process at once, and this one from its next
      // refresh.
      const remedy =
        response.status === 401
          ? ' To authorize again, run "requestport login --for api".'
          : "";
      throw new RequestPortApiError(
        `${what} was refused: ${code} (HTTP ${response.status}).${remedy}`,
        response.status,
        code,
        detailsOf(answer, response.headers),
      );
    }

    if (!readable) {
      throw new RequestPortApiError(
        `${what} did not answer JSON (HTTP ${response.status}).`,
        response.status,
        "unexpected_response",
      );
    }
    return answer;
  }

  return {
    async command(name, envelope) {
      if (!COMMAND_NAME.test(name)) {
        throw new TypeError(
          "A command is named by its registry name: lowercase letters, digits and underscores.",
        );
      }

      const answer = await call(
        "POST",
        ["commands", name],
        {},
        JSON.stringify({
          expectedVersion: envelope.expectedVersion,
          idempotencyKey: envelope.idempotencyKey,
          input: envelope.input ?? {},
        }),
      );
      if (!isRecord(answer) || !("result" in answer)) {
        throw new RequestPortApiError(
          `POST /commands/${name} on ${origin} answered without a result.`,
          200,
          "unexpected_response",
        );
      }
      return answer.result;
    },

    async query(path, parameters) {
      return call("GET", segmentsOf(path), parameters);
    },

    async whoami() {
      const answer = WhoAmISchema.safeParse(await call("GET", ["whoami"]));
      if (!answer.success) {
        throw new RequestPortApiError(
          `GET /whoami on ${origin} did not answer whoami's documented shape.`,
          200,
          "unexpected_response",
        );
      }
      return answer.data;
    },
  };
}
