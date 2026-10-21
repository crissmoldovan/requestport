/**
 * The exhaustive route/state inventory.
 *
 * Section 8 of the reskin specification says the migration is incomplete until
 * every current surface has been reviewed and converted, and that the table is
 * mirrored here so component and Playwright tests can consume one list rather
 * than each rediscovering the router tree. This module is that mirror: one row
 * per rendered App Router surface, each carrying the closed set of states that
 * surface can be in.
 *
 * Two properties make it a contract rather than documentation:
 *
 * - the discovery test rejects any surface file on disk that has no row here,
 *   so a new page or framework boundary cannot ship without being inventoried;
 * - each row's declared pattern is re-derived from its own file location, so a
 *   row cannot claim a URL its file could never serve.
 *
 * The shell chrome (top bar, navigation, organization switcher, command entry,
 * user menu) and the shared state vocabulary from the same specification table
 * are deliberately not rows: they are not routable surfaces. The shell is
 * covered by its component suites, and the state vocabulary is `routeStates`
 * below, which every row draws from.
 */

/**
 * The closed state vocabulary. Nothing outside this list may appear in a row,
 * and every value must be claimed by at least one surface — a state no surface
 * can reach is a state no test can prove.
 */
export const routeStates = [
  "conflict",
  "default",
  "destructive",
  "disabled",
  "empty",
  "error",
  "loading",
  "member_denied",
  "not_found",
  "pending",
  "provider_unavailable",
  "success",
] as const;

export type RouteState = (typeof routeStates)[number];

/** The four App Router framework boundaries, named by their file. */
export const boundaryKinds = [
  "error",
  "global-error",
  "loading",
  "not-found",
] as const;

export type BoundaryKind = (typeof boundaryKinds)[number];
export type SurfaceKind = "route" | BoundaryKind;

/** The product areas of the specification's route table that are routable. */
export const routeAreas = [
  "agents",
  "authentication",
  "collaboration",
  "core",
  "documentation",
  "framework",
  "integrations",
  "oauth",
  "organization",
  "projects",
] as const;

export type RouteArea = (typeof routeAreas)[number];

export type RouteStateEntry = {
  /** Stable identifier, unique across the inventory and sorted ascending. */
  readonly id: string;
  readonly area: RouteArea;
  /** The URL pattern this surface serves, route groups removed. */
  readonly pattern: string;
  readonly kind: SurfaceKind;
  /** Path of the surface file, relative to `apps/web/src/app`. */
  readonly source: string;
  readonly states: readonly RouteState[];
};

export const routeStateInventory: readonly RouteStateEntry[] = [
  {
    area: "framework",
    id: "boundary:error:(app)",
    kind: "error",
    pattern: "/",
    source: "(app)/error.tsx",
    states: ["error"],
  },
  {
    area: "framework",
    id: "boundary:error:(app)/settings/appearance",
    kind: "error",
    pattern: "/settings/appearance",
    source: "(app)/settings/appearance/error.tsx",
    states: ["error"],
  },
  {
    area: "framework",
    id: "boundary:error:(auth)",
    kind: "error",
    pattern: "/",
    source: "(auth)/error.tsx",
    states: ["error"],
  },
  {
    area: "framework",
    id: "boundary:error:root",
    kind: "error",
    pattern: "/",
    source: "error.tsx",
    states: ["error"],
  },
  {
    area: "framework",
    id: "boundary:global-error:root",
    kind: "global-error",
    pattern: "/",
    source: "global-error.tsx",
    states: ["error"],
  },
  {
    area: "framework",
    id: "boundary:loading:(app)",
    kind: "loading",
    pattern: "/",
    source: "(app)/loading.tsx",
    states: ["loading"],
  },
  {
    area: "framework",
    id: "boundary:loading:(app)/settings/appearance",
    kind: "loading",
    pattern: "/settings/appearance",
    source: "(app)/settings/appearance/loading.tsx",
    states: ["loading"],
  },
  {
    area: "framework",
    id: "boundary:loading:(auth)",
    kind: "loading",
    pattern: "/",
    source: "(auth)/loading.tsx",
    states: ["loading"],
  },
  {
    area: "framework",
    id: "boundary:loading:oauth",
    kind: "loading",
    pattern: "/oauth",
    source: "oauth/loading.tsx",
    states: ["loading"],
  },
  {
    area: "framework",
    id: "boundary:not-found:(app)",
    kind: "not-found",
    pattern: "/",
    source: "(app)/not-found.tsx",
    states: ["not_found"],
  },
  {
    area: "framework",
    id: "boundary:not-found:(auth)",
    kind: "not-found",
    pattern: "/",
    source: "(auth)/not-found.tsx",
    states: ["not_found"],
  },
  {
    area: "framework",
    id: "boundary:not-found:root",
    kind: "not-found",
    pattern: "/",
    source: "not-found.tsx",
    states: ["not_found"],
  },
  {
    area: "core",
    id: "route:/",
    kind: "route",
    pattern: "/",
    source: "(app)/page.tsx",
    states: ["default", "empty", "error", "loading"],
  },
  {
    area: "collaboration",
    id: "route:/activity",
    kind: "route",
    pattern: "/activity",
    source: "(app)/activity/page.tsx",
    states: ["default", "empty", "error", "loading"],
  },
  {
    area: "agents",
    id: "route:/agents",
    kind: "route",
    pattern: "/agents",
    source: "(app)/agents/page.tsx",
    states: ["default", "empty", "error", "loading", "member_denied"],
  },
  {
    area: "agents",
    id: "route:/agents/[agentId]",
    kind: "route",
    pattern: "/agents/[agentId]",
    source: "(app)/agents/[agentId]/page.tsx",
    states: [
      "conflict",
      "default",
      "destructive",
      "error",
      "member_denied",
      "not_found",
      "pending",
      "success",
    ],
  },
  {
    area: "authentication",
    id: "route:/auth-error",
    kind: "route",
    pattern: "/auth-error",
    source: "(auth)/auth-error/page.tsx",
    states: ["default", "error"],
  },
  {
    area: "documentation",
    id: "route:/docs/api",
    kind: "route",
    pattern: "/docs/api",
    source: "docs/api/page.tsx",
    states: ["default"],
  },
  {
    area: "documentation",
    id: "route:/docs/mcp",
    kind: "route",
    pattern: "/docs/mcp",
    source: "docs/mcp/page.tsx",
    states: ["default"],
  },
  {
    area: "integrations",
    id: "route:/imports",
    kind: "route",
    pattern: "/imports",
    source: "(app)/imports/page.tsx",
    states: [
      "default",
      "empty",
      "error",
      "loading",
      "member_denied",
      "pending",
    ],
  },
  {
    area: "integrations",
    id: "route:/imports/[runId]",
    kind: "route",
    pattern: "/imports/[runId]",
    source: "(app)/imports/[runId]/page.tsx",
    states: ["conflict", "default", "error", "not_found", "pending", "success"],
  },
  {
    area: "oauth",
    id: "route:/oauth/agent-consent",
    kind: "route",
    pattern: "/oauth/agent-consent",
    source: "oauth/agent-consent/page.tsx",
    states: [
      "default",
      "destructive",
      "error",
      "not_found",
      "pending",
      "success",
    ],
  },
  {
    area: "collaboration",
    id: "route:/questions",
    kind: "route",
    pattern: "/questions",
    source: "(app)/questions/page.tsx",
    states: ["default", "empty", "error", "loading"],
  },
  {
    area: "collaboration",
    id: "route:/questions/[questionId]/deliveries",
    kind: "route",
    pattern: "/questions/[questionId]/deliveries",
    source: "(app)/questions/[questionId]/deliveries/page.tsx",
    states: [
      "default",
      "empty",
      "error",
      "loading",
      "not_found",
      "provider_unavailable",
    ],
  },
  {
    area: "core",
    id: "route:/requests",
    kind: "route",
    pattern: "/requests",
    source: "(app)/requests/page.tsx",
    // No `disabled`: the list draws a filter toolbar and links to the request
    // it lists. Nothing on it is a control the application refuses — the
    // submissions that can be refused live on the request itself.
    states: ["default", "empty", "error", "loading"],
  },
  {
    area: "core",
    id: "route:/requests/[requestId]",
    kind: "route",
    pattern: "/requests/[requestId]",
    source: "(app)/requests/[requestId]/page.tsx",
    states: [
      "conflict",
      "default",
      "destructive",
      "error",
      "loading",
      "not_found",
      "pending",
      "success",
    ],
  },
  {
    area: "core",
    id: "route:/requests/new",
    kind: "route",
    pattern: "/requests/new",
    source: "(app)/requests/new/page.tsx",
    states: ["conflict", "default", "disabled", "error", "pending", "success"],
  },
  {
    area: "core",
    id: "route:/search",
    kind: "route",
    pattern: "/search",
    source: "(app)/search/page.tsx",
    states: ["default", "empty", "error", "loading", "pending"],
  },
  {
    area: "organization",
    id: "route:/settings/appearance",
    kind: "route",
    pattern: "/settings/appearance",
    source: "(app)/settings/appearance/page.tsx",
    states: [
      "conflict",
      "default",
      "error",
      "loading",
      "member_denied",
      "pending",
      "success",
    ],
  },
  {
    area: "organization",
    id: "route:/settings/members",
    kind: "route",
    pattern: "/settings/members",
    source: "(app)/settings/members/page.tsx",
    states: [
      "conflict",
      "default",
      "destructive",
      "empty",
      "error",
      "member_denied",
      "pending",
      "success",
    ],
  },
  {
    area: "organization",
    id: "route:/settings/operations",
    kind: "route",
    pattern: "/settings/operations",
    source: "(app)/settings/operations/page.tsx",
    states: [
      "default",
      "empty",
      "error",
      "member_denied",
      "pending",
      "provider_unavailable",
    ],
  },
  {
    // Plan 13, F.3: reachable by its URL only until F.3.1 adds navigation. It
    // draws its unavailable notice as its default content while operator
    // credentials are off, which is every local acceptance run: the switch is
    // unset there. Its list, form and actions are pinned by its own suites.
    area: "organization",
    id: "route:/settings/operators",
    kind: "route",
    pattern: "/settings/operators",
    source: "(app)/settings/operators/page.tsx",
    states: ["default", "error"],
  },
  {
    area: "organization",
    id: "route:/settings/organization",
    kind: "route",
    pattern: "/settings/organization",
    source: "(app)/settings/organization/page.tsx",
    states: [
      "conflict",
      "default",
      "error",
      "member_denied",
      "pending",
      "success",
    ],
  },
  {
    area: "projects",
    id: "route:/settings/projects",
    kind: "route",
    pattern: "/settings/projects",
    source: "(app)/settings/projects/page.tsx",
    states: ["default", "empty", "error", "loading", "member_denied"],
  },
  {
    area: "projects",
    id: "route:/settings/projects/[projectId]",
    kind: "route",
    pattern: "/settings/projects/[projectId]",
    source: "(app)/settings/projects/[projectId]/page.tsx",
    states: [
      "conflict",
      "default",
      "destructive",
      "error",
      "member_denied",
      "not_found",
      "pending",
      "success",
    ],
  },
  {
    area: "projects",
    id: "route:/settings/projects/new",
    kind: "route",
    pattern: "/settings/projects/new",
    source: "(app)/settings/projects/new/page.tsx",
    states: ["conflict", "default", "error", "pending", "success"],
  },
  {
    area: "organization",
    id: "route:/settings/routing",
    kind: "route",
    pattern: "/settings/routing",
    source: "(app)/settings/routing/page.tsx",
    states: [
      "default",
      "empty",
      "error",
      "member_denied",
      "pending",
      "success",
    ],
  },
  {
    area: "authentication",
    id: "route:/sign-in",
    kind: "route",
    pattern: "/sign-in",
    source: "(auth)/sign-in/page.tsx",
    states: ["default", "error", "pending", "provider_unavailable", "success"],
  },
  {
    area: "integrations",
    id: "route:/slack",
    kind: "route",
    pattern: "/slack",
    source: "(app)/slack/page.tsx",
    states: [
      "default",
      "empty",
      "error",
      "member_denied",
      "pending",
      "provider_unavailable",
    ],
  },
  {
    area: "integrations",
    id: "route:/webhooks",
    kind: "route",
    pattern: "/webhooks",
    source: "(app)/webhooks/page.tsx",
    states: [
      "default",
      "empty",
      "error",
      "loading",
      "member_denied",
      "pending",
    ],
  },
  {
    area: "integrations",
    id: "route:/webhooks/[subscriptionId]",
    kind: "route",
    pattern: "/webhooks/[subscriptionId]",
    source: "(app)/webhooks/[subscriptionId]/page.tsx",
    states: [
      "conflict",
      "default",
      "destructive",
      "error",
      "not_found",
      "pending",
      "success",
    ],
  },
];

const bySource = new Map(
  routeStateInventory.map((entry) => [entry.source, entry] as const),
);

/**
 * The one inventory row that owns a surface file, addressed exactly as the
 * App Router addresses it: a path relative to `apps/web/src/app`.
 */
export function surfaceForSource(source: string): RouteStateEntry | undefined {
  return bySource.get(source);
}
