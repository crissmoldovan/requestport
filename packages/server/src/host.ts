/**
 * The host (Plan 13, H.1; manifest-h.md §2.1, §2.2; H.0b's names, ruling
 * 143): one fetch handler, `(Request) => Promise<Response>`, that serves the
 * route table's families (`route-table.ts`) and hands everything else to an
 * optional fallback, the web UI. `listen` (`node.ts`) serves it over
 * `node:http`.
 *
 * **What it serves.** Every entry of the table, each by the handler moved
 * into this package from the web's route: the auth family (`auth.ts`),
 * through Better Auth's `auth.handler`; the four discovery documents
 * (`discovery.ts`); the artifact import (`artifact-import.ts`); REST
 * (`rest.ts`); MCP (`mcp.ts`); and the two health routes (`health.ts`).
 * REST is handed the path's parts as Next hands them to the route's
 * `[[...path]]` (`restPathParts`); a path with a segment that does not
 * decode answers `400` with no body, reaching no handler. Next answers the
 * same status before any route runs, but renders its error page as the body
 * (**read**, not measured); the host's stays empty (ruling 160, item 9). A
 * path no entry serves (`hostServes`) is a fallback's: the fetch-level
 * `fallback` below, when one is given. `requestport start` gives none: there
 * Next's request handler, which takes Node's request and response, is
 * `listen`'s Node-level fallback (`node.ts`), and `listen` hands it every
 * path `hostServes` refuses before this handler is asked
 * (`apps/requestport/src/serve/serve.ts`). Without either, the host answers
 * such a path `404`.
 * Nothing deployed calls the host: Vercel serves the web's routes through
 * Next, and H.4's `requestport start` is its first caller.
 *
 * **Methods,** as Next answers a route module that exports only some
 * (`next@16.3.1`, `dist/server/route-modules/app-route/helpers/auto-implement-methods.js:16-82`
 * and `module.js:210-216`, **read**): a method Next does not recognise answers
 * `400`, a recognised one the entry does not serve `405`, both with no body;
 * `HEAD` is answered by `GET`'s handler (the Node adapter writes no body for
 * it); `OPTIONS` answers `204` with `Allow`.
 *
 * **The proxy's headers.** Every answer the host's families give, and its own
 * `404`, carries the headers `apps/web/src/proxy.ts` sets on every response
 * its matcher covers: `requestSecurityHeaders` with a fresh nonce, and
 * `cache-control: private, no-store`. They are merged as Next merges a
 * proxy's response headers with a route's (`next@16.3.1`,
 * `dist/server/lib/router-utils/resolve-routes.js:411-465`,
 * `dist/server/lib/router-server.js:395-398` and
 * `dist/server/send-response.js:28-53`, as the goldens' `next-proxy.ts`
 * models them; ruling 147): the proxy's first, then
 * the route's `set-cookie`, `www-authenticate`, `proxy-authenticate` and
 * `vary` appended, and any other of the route's only where the proxy set
 * none, so the proxy's `cache-control` replaces a route's (H.0b's K1a). The
 * policy's three inputs are derived as `proxy.ts` derives them, with one
 * difference of source: `upgrade-insecure-requests` is dropped for an http
 * public URL on a loopback host (`upgradeInsecureRequestsFor`, H.5), judged
 * once from `publicUrl` when the host is made, where `proxy.ts` reads the
 * runtime `BETTER_AUTH_URL` on each request; `requestport start` passes
 * `BETTER_AUTH_URL` as `publicUrl` (`apps/requestport/src/serve/serve.ts`).
 * The other two inputs, and the end-to-end fence beside the URL, are read per
 * request. What a fallback answers is not the host's: the fetch-level one's
 * is handed back untouched, and Next's never passes through the host. Next
 * runs `proxy.ts` itself.
 *
 * **The order is `next start`'s, not Vercel's (ruling 149, settled by ruling
 * 160, item 7).** For the two protected-resource documents the two differ:
 * Vercel serves the route's own `cache-control: public, max-age=300`
 * (measured in production after #200, `docs/implementation/gotchas.md`,
 * 2026-10-06), and `next start` serves the proxy's `private, no-store` (H.0b,
 * K1a). The host serves `private, no-store`, as `next start` does. Under the
 * self-host, Next serves every path the host does not, in the same process
 * and in `next start`'s order (§2.7.1; `apps/requestport/src/serve/serve.ts`
 * composes it), so following that order keeps one order for every answer the
 * self-host gives.
 * Vercel's answer is unchanged: it serves the web's routes through Next, not
 * through the host. The route goldens pin both halves in a case of their own
 * (`test/route-goldens/route-goldens.test.ts`, "ruling 149").
 */
import type {
  AgentAudience,
  AgentAuthContext,
  ApiAuthContext,
} from "@requestport/auth/create-auth";
import type { RequestPort, RequestPortLogger } from "@requestport/core";
import {
  createImportRepository,
  createRateLimitRepository,
  type Storage,
} from "@requestport/db";
import { type MetricSink, noopMetricSink } from "@requestport/domain";

import {
  ARTIFACT_IMPORT_MAX_BODY,
  type ArtifactImportOptions,
  handleArtifactImport,
} from "./artifact-import.js";
import {
  AUTH_MAX_BODY,
  type AuthOptions,
  handleAuthGet,
  handleAuthPost,
} from "./auth.js";
import { bearerChallenge } from "./bearer-challenge.js";
import { discovery } from "./discovery.js";
import { isE2ECspFenceOpen } from "./e2e-csp-fence.js";
import { livenessResponse, readinessResponse } from "./health.js";
import { handleMcp, MCP_MAX_BODY, type McpOptions } from "./mcp.js";
import type { RequestPortHandler } from "./node.js";
import { withProject } from "./project-scope.js";
import {
  createRateLimiter,
  RATE_LIMIT_POLICIES,
  type RateLimitPolicies,
  requestIp,
} from "./rate-limit.js";
import {
  handleRestCommand,
  handleRestQuery,
  REST_MAX_BODY,
  type RestOptions,
  restPathParts,
} from "./rest.js";
import { matchRoute, type RouteName } from "./route-table.js";
import {
  requestSecurityHeaders,
  upgradeInsecureRequestsFor,
} from "./security-headers.js";

/**
 * Better Auth's installed members the host's families use, the five H.0b
 * named: `auth`, whose `handler` the auth family calls on it; the agent
 * bearer authenticator (the artifact import's and MCP's); the API bearer
 * authenticator (REST's, which admits an agent or an operator credential);
 * and the two discovery handlers (`createAuth`'s,
 * `packages/auth/src/create-auth.ts:368-372`). Structural until G.7's
 * `./create-auth` exports `createAuth`'s type (ruling 147).
 */
export interface HostAuth {
  auth: AuthOptions["auth"];
  authenticateAgentBearer: (
    request: Request,
    audience: AgentAudience,
  ) => Promise<AgentAuthContext>;
  authenticateApiBearer: (request: Request) => Promise<ApiAuthContext>;
  oauthAuthorizationServerMetadata: RequestPortHandler;
  oauthOpenIdConfiguration: RequestPortHandler;
}

/** The bounds on request bodies, and the rate-limit classes' policies. */
export interface HttpLimits {
  /** The most bytes each family's handler reads of a request body. */
  bodies: {
    auth: number;
    rest: number;
    mcp: number;
    artifactImport: number;
  };
  rateLimits: RateLimitPolicies;
}

/**
 * Today's constants: the auth route's 262,144 bytes, REST's and MCP's
 * 524,288, the artifact import's 9 MiB, and the seven classes' policies.
 */
export const DEFAULT_HTTP_LIMITS: HttpLimits = {
  bodies: {
    auth: AUTH_MAX_BODY,
    rest: REST_MAX_BODY,
    mcp: MCP_MAX_BODY,
    artifactImport: ARTIFACT_IMPORT_MAX_BODY,
  },
  rateLimits: RATE_LIMIT_POLICIES,
};

export interface HostOptions {
  /**
   * Core's RequestPort: REST runs each query and each command on it, and
   * MCP's tools run on it.
   */
  requestPort: RequestPort;
  auth: HostAuth;
  /**
   * The issuer, `BETTER_AUTH_URL`: the protected-resource documents name it,
   * and so do the artifact import's, REST's and MCP's challenges. An http URL
   * on a loopback host also drops `upgrade-insecure-requests` from the
   * proxy's headers (`upgradeInsecureRequestsFor`).
   */
  publicUrl: string;
  /**
   * Readiness asks it `ready()` on each request; the artifact import's
   * transaction is its `transaction`, the import repository built on that
   * transaction's handle; the rate limiter's repository is built over `db`
   * for each decision.
   */
  storage: Storage;
  /**
   * `fingerprintKey` is `BETTER_AUTH_SECRET`: the rate limiter's HMAC key,
   * and the artifact import's receipts' fingerprint secret.
   */
  secrets: { fingerprintKey: string };
  /**
   * MCP's two switches, fixed when the host is made: whether to serve the
   * 2026-07-28 protocol era beside the 2025 one (the web serves it for
   * `REQUESTPORT_MCP_MODERN=enabled`), and whether a session may accept
   * private telemetry (the web accepts it where its workspace encryption is
   * configured).
   */
  mcp: { modernProtocol: boolean; privateTelemetry: boolean };
  /**
   * `DEFAULT_HTTP_LIMITS` unless given. The auth family reads `bodies.auth`
   * on POST, the artifact import `bodies.artifactImport`, REST `bodies.rest`
   * and MCP `bodies.mcp`, and the one rate limiter they share reads
   * `rateLimits`; discovery and health take no body and are not limited.
   */
  limits?: HttpLimits;
  /**
   * The label the rate limiter writes on its rows. Unless given, it is
   * `VERCEL_ENV ?? NODE_ENV ?? "development"`, read for each decision, as the
   * web's limiter reads it.
   */
  environment?: string;
  /** Where MCP writes an error nothing recognised; nowhere unless given. */
  logger?: RequestPortLogger;
  /**
   * Where the rate limiter counts each decision and MCP counts and times
   * what it serves; nowhere unless given. MCP also counts
   * `mcp.unexpected_error_total` on it, a name `requestPortMetricNames` does
   * not hold, as the web's route did.
   */
  metrics?: MetricSink;
  /** Everything the host does not serve: the web UI (§2.7). */
  fallback?: RequestPortHandler;
}

/** A logger that writes nothing: MCP's, unless the host is handed one. */
const silentLogger: RequestPortLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** The methods Next recognises (`next@16.3.1`, `dist/server/web/http.js:26-34`). */
const HTTP_METHODS = [
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];
type RouteMethods = Partial<Record<HttpMethod, RequestPortHandler>>;

function isHttpMethod(method: string): method is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(method);
}

/** The entry's answer to the request's method, as Next answers it. */
function answer(methods: RouteMethods, request: Request): Promise<Response> {
  const method = request.method;
  if (!isHttpMethod(method))
    return Promise.resolve(new Response(null, { status: 400 }));
  const handler =
    methods[method] ?? (method === "HEAD" ? methods.GET : undefined);
  if (handler) return handler(request);
  if (method === "OPTIONS") {
    const implemented = new Set(HTTP_METHODS.filter((name) => methods[name]));
    if (methods.GET) implemented.add("HEAD");
    implemented.add("OPTIONS");
    return Promise.resolve(
      new Response(null, {
        status: 204,
        headers: { allow: [...implemented].sort().join(", ") },
      }),
    );
  }
  return Promise.resolve(new Response(null, { status: 405 }));
}

/**
 * The headers `apps/web/src/proxy.ts` sets, for this request.
 * `upgradeForPublicUrl` is `upgradeInsecureRequestsFor` of the host's public
 * URL, where `proxy.ts` asks it of the runtime `BETTER_AUTH_URL`.
 */
function proxyHeaders(request: Request, upgradeForPublicUrl: boolean): Headers {
  const headers = new Headers(
    requestSecurityHeaders({
      nonce: crypto.randomUUID().replaceAll("-", ""),
      production: process.env.NODE_ENV === "production",
      canonicalProductionHost:
        new URL(request.url).hostname === "requestport.com",
      upgradeInsecureRequests:
        !isE2ECspFenceOpen(process.env) && upgradeForPublicUrl,
    }),
  );
  headers.set("cache-control", "private, no-store");
  return headers;
}

/** The route's headers Next appends beside the proxy's, rather than drops. */
const appendedBesideTheProxy = new Set([
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
  "vary",
]);

/** The response with the proxy's headers over its own, as Next serves it. */
function withProxyHeaders(
  request: Request,
  response: Response,
  upgradeForPublicUrl: boolean,
): Response {
  const headers = proxyHeaders(request, upgradeForPublicUrl);
  const fromProxy = new Set(headers.keys());
  for (const [name, value] of response.headers) {
    if (appendedBesideTheProxy.has(name) || !fromProxy.has(name))
      headers.append(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Whether the host answers `pathname` itself: an entry of its route table
 * (`route-table.ts`) serves it. Every other path is a fallback's (above).
 */
export function hostServes(pathname: string): boolean {
  return matchRoute(pathname) !== undefined;
}

export function createRequestPortHost(
  options: HostOptions,
): RequestPortHandler {
  const documents = discovery({
    publicUrl: options.publicUrl,
    oauthAuthorizationServerMetadata:
      options.auth.oauthAuthorizationServerMetadata,
    oauthOpenIdConfiguration: options.auth.oauthOpenIdConfiguration,
  });
  const { storage } = options;
  const upgradeForPublicUrl = upgradeInsecureRequestsFor(options.publicUrl);
  const limits = options.limits ?? DEFAULT_HTTP_LIMITS;
  const metrics = options.metrics ?? noopMetricSink;
  const rateLimiter = createRateLimiter({
    repository: () => createRateLimitRepository(storage.db),
    fingerprintKey: () => options.secrets.fingerprintKey,
    environment: () =>
      options.environment ??
      process.env.VERCEL_ENV ??
      process.env.NODE_ENV ??
      "development",
    metrics,
    policies: limits.rateLimits,
  });
  const artifactImport: ArtifactImportOptions = {
    authenticateAgentBearer: options.auth.authenticateAgentBearer,
    withProject,
    rateLimiter,
    challenge: (resourceMetadataPath, challengeOptions) =>
      bearerChallenge(
        options.publicUrl,
        resourceMetadataPath,
        challengeOptions,
      ),
    importTransaction: (work) =>
      storage.transaction((tx) => work(createImportRepository(tx))),
    fingerprintSecret: () => options.secrets.fingerprintKey,
    maxBody: limits.bodies.artifactImport,
  };
  const rest: RestOptions = {
    authenticateApiBearer: options.auth.authenticateApiBearer,
    rateLimiter,
    requestPort: () => options.requestPort,
    withProject,
    challenge: artifactImport.challenge,
    maxBody: limits.bodies.rest,
  };
  const auth: AuthOptions = {
    auth: options.auth.auth,
    rateLimiter,
    requestIp,
    maxBody: limits.bodies.auth,
  };
  const { modernProtocol, privateTelemetry } = options.mcp;
  const mcp: McpOptions = {
    authenticateAgentBearer: options.auth.authenticateAgentBearer,
    rateLimiter,
    requestPort: () => options.requestPort,
    withProject,
    challenge: artifactImport.challenge,
    privateTelemetry: () => privateTelemetry,
    modernProtocol: () => modernProtocol,
    logger: options.logger ?? silentLogger,
    metrics,
    maxBody: limits.bodies.mcp,
  };
  const mcpAnswer: RequestPortHandler = (request) => handleMcp(request, mcp);
  /** REST's handler for the request, with the path's parts; or Next's `400`. */
  const restAnswer =
    (handle: typeof handleRestQuery): RequestPortHandler =>
    (request) => {
      const parts = restPathParts(new URL(request.url).pathname);
      if (!parts) return Promise.resolve(new Response(null, { status: 400 }));
      return handle(request, async () => parts, rest);
    };
  const served: Record<RouteName, RouteMethods> = {
    auth: {
      GET: (request) => handleAuthGet(request, auth),
      POST: (request) => handleAuthPost(request, auth),
    },
    "authorization-server-metadata": {
      GET: documents["authorization-server-metadata"],
    },
    "openid-configuration": { GET: documents["openid-configuration"] },
    "protected-resource-api": { GET: documents["protected-resource-api"] },
    "protected-resource-mcp": { GET: documents["protected-resource-mcp"] },
    "artifact-import": {
      POST: (request) => handleArtifactImport(request, artifactImport),
    },
    rest: {
      GET: restAnswer(handleRestQuery),
      POST: restAnswer(handleRestCommand),
    },
    mcp: { GET: mcpAnswer, POST: mcpAnswer, DELETE: mcpAnswer },
    liveness: { GET: async () => livenessResponse() },
    readiness: {
      GET: () => readinessResponse(async () => () => storage.ready()),
    },
  };

  return async (request) => {
    const entry = matchRoute(new URL(request.url).pathname);
    if (entry)
      return withProxyHeaders(
        request,
        await answer(served[entry.name], request),
        upgradeForPublicUrl,
      );
    if (options.fallback) return options.fallback(request);
    return withProxyHeaders(
      request,
      new Response(null, { status: 404 }),
      upgradeForPublicUrl,
    );
  };
}
