import { routeStateInventory } from "./route-state-inventory.js";

/**
 * How a browser case reaches one inventory surface, and what the surface — or
 * the segment around it — prints once it has.
 *
 * The acceptance case table names a surface by its inventory identifier and
 * nothing else, because a case is about a *state of a surface* rather than
 * about a URL. Somewhere the two have to meet, and this is that place: one row
 * per inventory row, carrying the address a case drives, the segment whose
 * framework boundaries own it, and the thing the application prints when the
 * page itself has rendered.
 *
 * The printed text is the half that makes a case able to fail. A run that only
 * checked the URL would pass on a page showing its error boundary, its
 * not-found boundary, or nothing at all — every one of those keeps the address.
 * So each row names something the application itself emits: the exact heading a
 * page prints, or, where the heading is a record's own name, the seeded row
 * whose value has to appear.
 *
 * The table is bound to the inventory in both directions by
 * `acceptance-runner-contract.test.ts`, so a new surface cannot ship without an
 * address, and a row here cannot name a surface that does not exist.
 */

/** A placeholder a path carries until the run's own ledger fills it. */
export const acceptancePathTokens = [
  ":missing",
  ":project",
  ":request",
] as const;

export type AcceptancePathToken = (typeof acceptancePathTokens)[number];

/**
 * The four segments that own a set of framework boundaries.
 *
 * A boundary is not a URL — it is what a segment shows when the surface inside
 * it suspends, throws, or answers not-found — so a case in a boundary state
 * asserts the sentence *that segment's* boundary prints. Reading the segment
 * off the surface is what lets one driver per state cover every surface.
 */
export const acceptanceSegments = [
  "app",
  "app-appearance",
  "auth",
  "root",
] as const;

export type AcceptanceSegment = (typeof acceptanceSegments)[number];

export type AcceptanceBoundaryKind =
  | "error"
  | "global-error"
  | "loading"
  | "not-found";

/**
 * Exactly what each segment's boundaries print, taken from the boundary files.
 *
 * Each line is unique to its boundary, which is what makes the assertion mean
 * "this boundary rendered" rather than "some boundary rendered": two error
 * boundaries share a title, and the sentence under it is what tells them apart.
 */
export const acceptanceBoundaryText: Readonly<
  Record<
    AcceptanceSegment,
    Readonly<Partial<Record<AcceptanceBoundaryKind, string>>>
  >
> = {
  app: {
    error:
      "RequestPort could not load this page. Nothing was changed, and the rest of the workspace is unaffected.",
    "global-error": "This page could not be rendered",
    loading: "Loading this page…",
    "not-found": "That record is not available in the current organization.",
  },
  "app-appearance": {
    error: "Appearance settings are unavailable",
    "global-error": "This page could not be rendered",
    loading: "Loading appearance settings…",
    "not-found": "That record is not available in the current organization.",
  },
  auth: {
    error:
      "This sign-in page could not be loaded. No session was created, and nothing about the account has changed.",
    "global-error": "This page could not be rendered",
    loading: "Loading sign-in…",
    "not-found": "That address does not match an authentication page.",
  },
  /**
   * The boundaries a route with no nearer one of its own falls back to.
   *
   * Its loading boundary is written in the consent segment rather than beside
   * the root layout. A `loading.tsx` at the root is a Suspense boundary above
   * every authenticated segment, so React completes the document shell and the
   * server commits it before the authentication decision below has been made —
   * and `redirect()`, reached after the commit, can only emit a meta refresh.
   * Written one segment down, below that segment's own decision, it still gives
   * the only route with no boundary of its own something to stream and
   * something to recover a failure into.
   */
  root: {
    error: "RequestPort could not render this page. Nothing was changed.",
    "global-error": "This page could not be rendered",
    loading: "Loading RequestPort…",
    "not-found": "That address does not match anything in RequestPort.",
  },
};

export type AcceptanceLandmark =
  /** The page's own `<h1>`, spelled exactly. */
  | Readonly<{ kind: "heading"; text: string }>
  /** The page's `<h1>`, which is the seeded row's own value. */
  | Readonly<{ kind: "seeded-heading"; from: "project" | "request" }>
  /** A fixed line the surface prints and nothing else does. */
  | Readonly<{ kind: "text"; text: string }>;

export type AcceptanceSurfaceEntry = Readonly<{
  id: string;
  path: string;
  segment: AcceptanceSegment;
  landmark: AcceptanceLandmark;
  /** Set on the rows that *are* a framework boundary. */
  boundary?: AcceptanceBoundaryKind;
  /**
   * The exact sentence this surface draws when a write conflicts.
   *
   * A conflicting write and a rejected one both land in the same alert, so a
   * case that only waited for an alert would pass on a submission the schema
   * refused — which is a different state, and one the table already covers
   * elsewhere. The sentence is what tells them apart, and each of these is the
   * `conflict` arm of its own action module's fixed message map.
   */
  conflictMessage?: string;
  /**
   * The accessible name of the submit control the conflicting-write case drives.
   *
   * The generic chooser takes the first form in the work area carrying a
   * visible submit, which is the right definition for a surface that draws one.
   * The members surface draws several, and the first is the per-member "Save
   * role" form: the generic option chooser then picks the first role and
   * demotes the tenant's own owner, which the repository refuses with a
   * *genuine* conflict carrying the very sentence the injected one draws. The
   * case therefore passed with the injection disabled, and demoted the owner
   * every time it ran. Where the form the case is about is not the first one on
   * the page, the case names it.
   */
  conflictSubmit?: string;
  /**
   * The query that brings this surface to its empty state.
   *
   * Most surfaces show their empty state as soon as they are opened with
   * nothing to show, which is what the `empty` driver assumes: it opens the
   * address and looks for the component. A surface that answers a *question*
   * has no empty state until it has been asked one — `/search` renders the
   * sentence "Enter at least two characters." until a query arrives, and only
   * a query that matches nothing produces the component. Opening it bare and
   * waiting therefore waited for something that was never going to appear,
   * which is how `route-state-0085` failed the first time that lane ran.
   *
   * Declared here rather than in the case table because it is a fact about the
   * surface, not about the case: any `empty` case on this surface needs it, and
   * a case cannot know it.
   */
  emptyQuery?: string;
  /**
   * The sentence this surface shows in place of an owner-only affordance.
   *
   * A reduced role is refused in one of two shapes the `member_denied` driver
   * already knows — the surface answers not-found, or it draws fewer controls.
   * This surface uses a third: the controls a member sees are the same personal
   * ones an owner sees, and what changes is that the owner-only form is
   * replaced by a statement. `controlNames` reads links, buttons and sidebar
   * items, so it cannot see a paragraph, and the two readings came back
   * identical — which the driver is required to treat as "the fault did
   * nothing". It was the driver that could not see the denial, not the
   * application that failed to make one.
   *
   * Naming the sentence is what makes that shape checkable: the member must see
   * it and the owner must not, so a surface that always showed it, or never
   * did, fails here rather than passing quietly.
   */
  ownerOnlyNotice?: string;
  /**
   * The affordance only an owner is offered on this surface.
   *
   * A fourth denial shape, and the reason the subset rule cannot express it.
   * `/agents` offers both roles a chooser: an owner may scope an agent to the
   * whole organization, a member only to a project they are in, and
   * `agent-management.tsx` builds the options from `allowOrganizationWide`
   * accordingly. Both roles therefore have the same *controls*, and the
   * chooser's accessible name is whatever it currently shows — the
   * organization-wide option for an owner, a project's name for a member. The
   * two readings are not subsets of one another in either direction, and
   * neither is a privilege: one is a value.
   *
   * Naming the affordance is what makes the denial checkable. The owner must be
   * offered it and the member must not, so a surface that offered it to both,
   * or to neither, fails here.
   */
  ownerOnlyControl?: string;
  /**
   * The link that reaches this surface without loading a document.
   *
   * A loading boundary belongs to the segment that suspends, and on a fresh
   * document the whole tree streams from the root: the outermost fallback is
   * what a browser paints first, and a case watching for a nested one sees the
   * outer sentence instead — `boundary:loading:(app)/settings/appearance` was
   * shown "Loading this page…" while its own "Loading appearance settings…" sat
   * in the document, hidden.
   *
   * Reached the way a person reaches it, the shared layout is already rendered
   * and only the segment below it fetches, so the boundary that paints is that
   * segment's own. `/settings/appearance` is not in the primary navigation;
   * `user-control.tsx` links it from the account menu, which is why the label
   * rather than the address is what is named here.
   */
  clientRouteLabel?: string;
}>;

const heading = (text: string): AcceptanceLandmark => ({
  kind: "heading",
  text,
});

/**
 * The sentence one segment's boundary prints, refused when it owns none.
 *
 * The table above is deliberately not total, and a row that names a boundary
 * its segment does not have stops here rather than being given an empty
 * sentence — which every surface prints, and which would therefore make the
 * case pass on anything at all.
 */
export function boundarySentence(
  segment: AcceptanceSegment,
  boundary: AcceptanceBoundaryKind,
): string {
  const text = acceptanceBoundaryText[segment][boundary];
  if (text === undefined) {
    throw new Error(
      `No ${boundary} boundary belongs to the ${segment} segment`,
    );
  }

  return text;
}

function boundaryEntry(
  id: string,
  segment: AcceptanceSegment,
  boundary: AcceptanceBoundaryKind,
  path: string,
  clientRouteLabel?: string,
): AcceptanceSurfaceEntry {
  return {
    boundary,
    ...(clientRouteLabel === undefined ? {} : { clientRouteLabel }),
    id,
    landmark: { kind: "text", text: boundarySentence(segment, boundary) },
    path,
    segment,
  };
}

/**
 * The framework boundaries, each addressed at a route whose failure that
 * segment owns.
 *
 * The root boundaries are driven at `/oauth/agent-consent`, the one
 * authenticated surface that sits directly under the root layout with no nearer
 * boundary of its own, and the root not-found at an address that matches no
 * route at all — which is how a visitor reaches it.
 */
const boundaries: readonly AcceptanceSurfaceEntry[] = [
  boundaryEntry("boundary:error:(app)", "app", "error", "/"),
  boundaryEntry(
    "boundary:error:(app)/settings/appearance",
    "app-appearance",
    "error",
    "/settings/appearance",
  ),
  boundaryEntry("boundary:error:(auth)", "auth", "error", "/auth-error"),
  boundaryEntry("boundary:error:root", "root", "error", "/oauth/agent-consent"),
  boundaryEntry("boundary:global-error:root", "root", "global-error", "/"),
  boundaryEntry("boundary:loading:(app)", "app", "loading", "/"),
  boundaryEntry(
    "boundary:loading:(app)/settings/appearance",
    "app-appearance",
    "loading",
    "/settings/appearance",
    "Appearance settings",
  ),
  boundaryEntry("boundary:loading:(auth)", "auth", "loading", "/auth-error"),
  boundaryEntry(
    "boundary:loading:oauth",
    "root",
    "loading",
    "/oauth/agent-consent",
  ),
  boundaryEntry("boundary:not-found:(app)", "app", "not-found", "/"),
  boundaryEntry(
    "boundary:not-found:(auth)",
    "auth",
    "not-found",
    "/auth-error",
  ),
  boundaryEntry(
    "boundary:not-found:root",
    "root",
    "not-found",
    "/this-address-matches-no-route",
  ),
];

/** The landmark a record-addressed surface prints for an address with no record. */
const absentRecord: AcceptanceLandmark = {
  kind: "text",
  text: boundarySentence("app", "not-found"),
};

const routes: readonly AcceptanceSurfaceEntry[] = [
  { id: "route:/", landmark: heading("Overview"), path: "/", segment: "app" },
  {
    id: "route:/activity",
    landmark: heading("Activity"),
    path: "/activity",
    segment: "app",
  },
  {
    ownerOnlyControl: "Organization-wide",
    id: "route:/agents",
    landmark: heading("Agents"),
    path: "/agents",
    segment: "app",
  },
  {
    id: "route:/agents/[agentId]",
    landmark: absentRecord,
    path: "/agents/:missing",
    segment: "app",
  },
  {
    id: "route:/auth-error",
    landmark: heading("Sign-in unavailable"),
    path: "/auth-error",
    segment: "auth",
  },
  {
    id: "route:/docs/api",
    landmark: heading("REST API"),
    path: "/docs/api",
    segment: "root",
  },
  {
    id: "route:/docs/mcp",
    landmark: heading("MCP agent connection"),
    path: "/docs/mcp",
    segment: "root",
  },
  {
    id: "route:/imports",
    landmark: heading("Legacy imports"),
    path: "/imports",
    segment: "app",
  },
  {
    id: "route:/imports/[runId]",
    landmark: absentRecord,
    path: "/imports/:missing",
    segment: "app",
  },
  {
    id: "route:/oauth/agent-consent",
    landmark: {
      kind: "text",
      text: boundarySentence("root", "not-found"),
    },
    path: "/oauth/agent-consent",
    segment: "root",
  },
  {
    id: "route:/questions",
    landmark: heading("Questions"),
    path: "/questions",
    segment: "app",
  },
  {
    id: "route:/questions/[questionId]/deliveries",
    landmark: absentRecord,
    path: "/questions/:missing/deliveries",
    segment: "app",
  },
  {
    id: "route:/requests",
    landmark: heading("Requests"),
    path: "/requests",
    segment: "app",
  },
  {
    conflictMessage: "The requested change conflicts with current state.",
    id: "route:/requests/[requestId]",
    landmark: { from: "request", kind: "seeded-heading" },
    path: "/requests/:request",
    segment: "app",
  },
  {
    conflictMessage: "The requested change conflicts with current state.",
    id: "route:/requests/new",
    landmark: heading("New request"),
    path: "/requests/new",
    segment: "app",
  },
  {
    // Long, and deliberately nothing a seeded row could contain: the empty
    // state this reaches has to be empty because the search matched nothing,
    // not because the tenant happened to hold no rows.
    emptyQuery: "q=zzzzzzzzzz-no-such-record-zzzzzzzzzz",
    id: "route:/search",
    landmark: heading("Search"),
    path: "/search",
    segment: "app",
  },
  {
    ownerOnlyNotice: "Only an owner can change these defaults.",
    id: "route:/settings/appearance",
    landmark: heading("Appearance"),
    path: "/settings/appearance",
    segment: "app-appearance",
  },
  {
    // The invitation, not the role row. Inviting is the one write on this
    // surface whose unfaulted submission does not conflict on its own, so the
    // sentence below can only be the injected conflict — and the raise happens
    // in the administration wiring's own session step, before the command runs,
    // so a passing case leaves no invitation behind.
    conflictMessage: "That canonical value is already in use.",
    conflictSubmit: "Invite member",
    id: "route:/settings/members",
    landmark: heading("Members"),
    path: "/settings/members",
    segment: "app",
  },
  {
    id: "route:/settings/operations",
    landmark: heading("Operations"),
    path: "/settings/operations",
    segment: "app",
  },
  {
    id: "route:/settings/operators",
    landmark: heading("Operator credentials"),
    path: "/settings/operators",
    segment: "app",
  },
  {
    id: "route:/settings/organization",
    landmark: heading("Organization"),
    path: "/settings/organization",
    segment: "app",
  },
  {
    id: "route:/settings/projects",
    landmark: heading("Projects"),
    path: "/settings/projects",
    segment: "app",
  },
  {
    conflictMessage: "That value is already registered in this organization.",
    id: "route:/settings/projects/[projectId]",
    landmark: { from: "project", kind: "seeded-heading" },
    path: "/settings/projects/:project",
    segment: "app",
  },
  {
    conflictMessage: "That canonical value is already in use.",
    id: "route:/settings/projects/new",
    landmark: heading("Create project"),
    path: "/settings/projects/new",
    segment: "app",
  },
  {
    id: "route:/settings/routing",
    landmark: heading("Routing policy"),
    path: "/settings/routing",
    segment: "app",
  },
  {
    id: "route:/sign-in",
    landmark: heading("Sign in"),
    path: "/sign-in",
    segment: "auth",
  },
  {
    id: "route:/slack",
    landmark: heading("Slack"),
    path: "/slack",
    segment: "app",
  },
  {
    id: "route:/webhooks",
    landmark: heading("Webhooks"),
    path: "/webhooks",
    segment: "app",
  },
  {
    id: "route:/webhooks/[subscriptionId]",
    landmark: absentRecord,
    path: "/webhooks/:missing",
    segment: "app",
  },
];

export const acceptanceSurfaces: readonly AcceptanceSurfaceEntry[] = [
  ...boundaries,
  ...routes,
];

const bySurface = new Map(
  acceptanceSurfaces.map((entry) => [entry.id, entry] as const),
);

export function acceptanceSurface(id: string): AcceptanceSurfaceEntry {
  const entry = bySurface.get(id);
  if (entry === undefined) {
    throw new Error("Acceptance surface is not addressable");
  }

  return entry;
}

/** Exactly the inventory rows, so neither list can grow without the other. */
export const inventorySurfaceIds: readonly string[] = routeStateInventory
  .map((entry) => entry.id)
  .sort();

/**
 * Re-exported so the runner keeps asking one module for both halves.
 *
 * The rules moved next door for the reason that module states; every reader
 * that already asked this one about a surface still asks it about the states
 * of that surface, rather than having to know which of the two files an
 * answer now comes out of.
 */
export {
  type AcceptanceSkipRule,
  acceptanceSkipReason,
  acceptanceSkipRules,
} from "./acceptance-skip-rules.js";
