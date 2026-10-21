/**
 * The auth family (Plan 13, H.1; manifest-h.md §1.2, §2.2; ruling 147): the
 * handlers behind `/api/auth/*`, `handleAuthGet` for GET and
 * `handleAuthPost` for POST, around Better Auth's `auth.handler`.
 *
 * Moved here from `apps/web/src/app/api/auth/[...all]/route.ts`, whose `GET`
 * and `POST` now hand each request to these with the web's own
 * collaborators; the host (`host.ts`) hands them its own. Better Auth is
 * reached as `toNextJsHandler(auth)` reached it in `better-auth@1.7.6`
 * (`dist/integrations/next-js.mjs:7-18`, **read**): an async function that
 * calls `auth.handler(request)` on the object it is handed, read at each
 * call. Around it, as the route had it: `createAuthRouteHandler`, which
 * stays in `@requestport/auth` and is imported from its `./auth-handler`
 * subpath, which installs nothing (ruling 147); on POST, the body read
 * within its bound and the request rebuilt over it, with its method,
 * headers, `redirect` and signal; the two rate-limit classes, keyed by the
 * client's address; and the 413, 429 and 500 answers. A failure inside
 * Better Auth on POST is not one of those: the route returned the wrapped
 * handler's promise without awaiting it, so its rejection reached Next, and
 * here it reaches the caller.
 *
 * Each handler is handed:
 * - Better Auth's installed object, whose `handler` is called on it;
 * - the rate limiter, for the `auth_initiation` class (a magic link, keyed
 *   by the address and the email) and the `token` class (any path holding
 *   `/oauth2/` or `/token`, keyed by the address);
 * - `requestIp`, the client's address as the request names it: the web
 *   hands it the one `rate-limit.ts` holds, which the host also uses, and
 *   under the host the Node adapter has removed `x-vercel-forwarded-for`
 *   and set `x-forwarded-for` from the socket before the request arrives
 *   (`node.ts`);
 * - the body's bound, `AUTH_MAX_BODY` unless given.
 */
import { createAuthRouteHandler } from "@requestport/auth/auth-handler";
import { DomainError } from "@requestport/domain";

import {
  RequestTooLargeError,
  readBoundedRequestBody,
} from "./input-limits.js";
import type { RateLimiter } from "./rate-limit.js";

/** The most bytes of an auth request's body read: 262,144. */
export const AUTH_MAX_BODY = 262_144;

export interface AuthOptions {
  /** Better Auth's installed object: its `handler` is called on it. */
  auth: { handler(request: Request): Promise<Response> };
  /** The fingerprint and the decision, for the two classes. */
  rateLimiter: Pick<RateLimiter, "enforce" | "fingerprint">;
  /** The client's address, as the request names it. */
  requestIp: (request: Request) => string;
  /** The most bytes of a body read: `AUTH_MAX_BODY` unless given. */
  maxBody?: number;
}

/** Better Auth's handler, as `toNextJsHandler` makes it, wrapped by `createAuthRouteHandler`. */
function betterAuth(options: AuthOptions) {
  return createAuthRouteHandler(async (request) =>
    options.auth.handler(request),
  );
}

export async function handleAuthGet(
  request: Request,
  options: AuthOptions,
): Promise<Response> {
  return betterAuth(options)(request);
}

export async function handleAuthPost(
  request: Request,
  options: AuthOptions,
): Promise<Response> {
  try {
    const body = await readBoundedRequestBody(
      request,
      options.maxBody ?? AUTH_MAX_BODY,
    );
    const boundedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      redirect: request.redirect,
      signal: request.signal,
    });
    const pathname = new URL(boundedRequest.url).pathname;
    if (pathname === "/api/auth/sign-in/magic-link") {
      const parsedBody = (await boundedRequest
        .clone()
        .json()
        .catch(() => null)) as { email?: unknown } | null;
      await options.rateLimiter.enforce({
        endpointClass: "auth_initiation",
        fingerprint: options.rateLimiter.fingerprint(
          options.requestIp(boundedRequest),
          typeof parsedBody?.email === "string" ? parsedBody.email : "invalid",
        ),
      });
    } else if (pathname.includes("/oauth2/") || pathname.includes("/token")) {
      await options.rateLimiter.enforce({
        endpointClass: "token",
        fingerprint: options.rateLimiter.fingerprint(
          options.requestIp(boundedRequest),
        ),
      });
    }
    return betterAuth(options)(boundedRequest);
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      return Response.json(
        {
          error: "request_too_large",
          message: "Authentication request body is too large.",
        },
        { status: 413, headers: { "cache-control": "no-store" } },
      );
    }
    if (error instanceof DomainError && error.code === "rate_limited") {
      return Response.json(
        { error: "rate_limited", message: "Too many requests" },
        {
          status: 429,
          headers: {
            "cache-control": "no-store",
            ...(typeof error.details.retryAfterSeconds === "number"
              ? { "retry-after": String(error.details.retryAfterSeconds) }
              : {}),
          },
        },
      );
    }
    return Response.json(
      { error: "unexpected_error", message: "Authentication request failed." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
