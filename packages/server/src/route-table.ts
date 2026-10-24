/**
 * The host's route table (Plan 13, H.0b's ten entries; manifest-h.md §2.2,
 * Done when 2; ruling 143).
 *
 * Ordered, most specific first, and the first entry that matches decides. An
 * entry's `exact` paths match themselves only. Its `prefix`, which ends in
 * `/`, matches every path that starts with it, so at least one segment more,
 * as Next's `[...x]` does: `/api/auth` itself is not Better Auth's, and REST
 * names `/api/v1` exactly because its `[[...path]]` matches none or more. So
 * `/api/v1/imports/artifacts` reaches the artifact import, entry 6, before
 * REST's prefix, entry 7, can take it.
 *
 * A path is matched as the request names it, byte for byte: no decoding and
 * no case folding. A path ending in `/` never reaches the table: the Node
 * adapter (`node.ts`) answers it with a 308 to the path without it, as Next
 * does, because every prefix entry would otherwise catch the trailing-slash
 * form of a more specific exact one (`/api/v1/imports/artifacts/` would reach
 * REST).
 *
 * `ROUTE_FAMILIES` are the prefixes the host mounts. A path under none of
 * them is the fallback's by construction; a route Next serves under one of
 * them must be in this table or in `FALLBACK_UNDER_FAMILY`, which
 * `route-table.test.ts` holds over every `route.ts` in `apps/web/src/app`.
 */

/** The prefixes the host mounts; everything else is the fallback's. */
export const ROUTE_FAMILIES = [
  "/api/auth",
  "/.well-known",
  "/api/v1",
  "/mcp",
  "/api/health",
] as const;

export type RouteName =
  | "auth"
  | "authorization-server-metadata"
  | "openid-configuration"
  | "protected-resource-api"
  | "protected-resource-mcp"
  | "artifact-import"
  | "rest"
  | "mcp"
  | "liveness"
  | "readiness";

export interface RouteEntry {
  readonly name: RouteName;
  /** Paths this entry serves exactly. */
  readonly exact: readonly string[];
  /** A prefix ending in `/`: every path that starts with it is this entry's. */
  readonly prefix?: string;
}

export const ROUTE_TABLE: readonly RouteEntry[] = [
  { name: "auth", exact: [], prefix: "/api/auth/" },
  {
    name: "authorization-server-metadata",
    exact: ["/.well-known/oauth-authorization-server"],
  },
  {
    name: "openid-configuration",
    exact: ["/.well-known/openid-configuration"],
  },
  {
    name: "protected-resource-api",
    exact: ["/.well-known/oauth-protected-resource/api/v1"],
  },
  {
    name: "protected-resource-mcp",
    exact: ["/.well-known/oauth-protected-resource/mcp"],
  },
  { name: "artifact-import", exact: ["/api/v1/imports/artifacts"] },
  { name: "rest", exact: ["/api/v1"], prefix: "/api/v1/" },
  { name: "mcp", exact: ["/mcp"] },
  { name: "liveness", exact: ["/api/health/live"] },
  { name: "readiness", exact: ["/api/health/ready"] },
];

/**
 * Routes Next serves under a family that the host deliberately leaves to
 * the fallback, by their path pattern as Next derives it from the route's
 * folder (`/api/v1/example/[id]`), each with its reason.
 */
export const FALLBACK_UNDER_FAMILY: readonly {
  readonly pattern: string;
  readonly reason: string;
}[] = [
  {
    pattern: "/.well-known/security.txt",
    reason:
      "RFC 9116's security.txt (Plan 13, J.4): the web serves it from its own route, with no handler in this package, so the host hands it to the fallback.",
  },
];

/** The entry that serves `pathname`: the first that matches, or none. */
export function matchRoute(
  pathname: string,
  table: readonly RouteEntry[] = ROUTE_TABLE,
): RouteEntry | undefined {
  return table.find(
    (entry) =>
      entry.exact.includes(pathname) ||
      (entry.prefix !== undefined && pathname.startsWith(entry.prefix)),
  );
}

/** Whether `pathname` lies under a family the host mounts. */
export function isUnderFamily(pathname: string): boolean {
  return ROUTE_FAMILIES.some(
    (family) => pathname === family || pathname.startsWith(`${family}/`),
  );
}
