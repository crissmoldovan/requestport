/*
  @requestport/server (Plan 13, Track H; manifest-h.md §2.1, §2.2): the host,
  its route table and its Node adapter, and the handlers and helpers moved
  out of the web's routes: the auth family, discovery, health, the artifact
  import, REST and MCP, each of which the host serves. The web imports this
  package by its narrow subpaths, never by this root (`subpaths.test.ts`).
  The pre-move goldens are under `test/route-goldens/`.
*/
export {
  ARTIFACT_IMPORT_MAX_BODY,
  type ArtifactImportOptions,
  handleArtifactImport,
  type ImportRepository,
} from "./artifact-import.js";
export {
  AUTH_MAX_BODY,
  type AuthOptions,
  handleAuthGet,
  handleAuthPost,
} from "./auth.js";
export {
  bearerChallenge,
  reauthorizeWithResourceDescription,
  wantsResourceIndicator,
} from "./bearer-challenge.js";
export {
  type DiscoveryOptions,
  discovery,
  type ProtectedResource,
  protectedResourceDocument,
  protectedResourceMetadata,
} from "./discovery.js";
export {
  livenessResponse,
  READINESS_TIMEOUT_MS,
  type ReadinessCheck,
  type ReadinessProbe,
  readinessResponse,
} from "./health.js";
export {
  createRequestPortHost,
  DEFAULT_HTTP_LIMITS,
  type HostAuth,
  type HostOptions,
  type HttpLimits,
  hostServes,
} from "./host.js";
export {
  assertJsonDepth,
  RequestTooLargeError,
  readBoundedRequestBody,
  readBoundedRequestText,
} from "./input-limits.js";
export {
  handleMcp,
  MCP_MAX_BODY,
  type McpMetrics,
  type McpOptions,
} from "./mcp.js";
export {
  type ListenOptions,
  listen,
  type NodeFallback,
  type RequestPortHandler,
  type RunningHost,
} from "./node.js";
export { withProject } from "./project-scope.js";
export {
  createRateLimiter,
  RATE_LIMIT_POLICIES,
  type RateLimitClass,
  type RateLimitConsumption,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimiterOptions,
  type RateLimitPolicies,
  type RateLimitPolicy,
  type RateLimitRepository,
  rateLimitFingerprint,
  requestIp,
} from "./rate-limit.js";
export {
  handleRestCommand,
  handleRestQuery,
  REST_MAX_BODY,
  type RestOptions,
  type RestPathParts,
  restPathParts,
} from "./rest.js";
export {
  FALLBACK_UNDER_FAMILY,
  isUnderFamily,
  matchRoute,
  ROUTE_FAMILIES,
  ROUTE_TABLE,
  type RouteEntry,
  type RouteName,
} from "./route-table.js";
export { requestSecurityHeaders } from "./security-headers.js";
export { type Challenge, unauthorized } from "./unauthorized.js";
