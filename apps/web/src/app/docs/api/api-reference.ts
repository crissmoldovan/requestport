import document from "./generated/openapi.json";

/**
 * What the REST reference page lists, read from the committed OpenAPI
 * document rather than restated, so the page and the document cannot name
 * different paths, commands, scopes or error codes. The one exception is
 * `readDescriptions`, at the end.
 */

type Operation = {
  operationId: string;
  /**
   * One requirement per security scheme that may call the operation, each
   * mapping the scheme to the scopes it needs: `agentBearer`, and since Plan
   * 13, F.3, `operatorBearer` on what an operator credential is admitted to.
   */
  security: readonly Readonly<Record<string, readonly string[]>>[];
  parameters?: readonly { name: string; in: string }[];
  "x-requestport-scope-by-action"?: Readonly<Record<string, string>>;
};

type ErrorResponse = {
  description: string;
  content: {
    "application/json": {
      schema: { properties: { error: { enum: readonly string[] } } };
    };
  };
};

const paths = document.paths as unknown as Readonly<
  Record<string, { get?: Operation; post?: Operation }>
>;

const basePath = "/api/v1";

/**
 * The scopes an operation lists under any scheme, each once; empty when it
 * needs none. An operation both kinds of credential call names its scope under
 * each scheme. Exported for `page.test.tsx`.
 */
export function scopesOf(operation: Operation): readonly string[] {
  return [
    ...new Set(
      operation.security.flatMap((requirement) =>
        Object.values(requirement).flat(),
      ),
    ),
  ];
}

export type CommandReference = {
  name: string;
  scopes: readonly string[];
  /** True when the scope depends on the input's `action`. */
  scopeByAction: boolean;
};

export const commandReference: readonly CommandReference[] = Object.values(
  paths,
).flatMap((item) =>
  item.post
    ? [
        {
          name: item.post.operationId,
          scopes: scopesOf(item.post),
          scopeByAction:
            item.post["x-requestport-scope-by-action"] !== undefined,
        },
      ]
    : [],
);

export type ReadReference = {
  /** The path below `/api/v1`, with `{name}` for each path parameter. */
  path: string;
  scopes: readonly string[];
  queryParameters: readonly string[];
};

export const readReference: readonly ReadReference[] = Object.entries(
  paths,
).flatMap(([path, item]) =>
  item.get
    ? [
        {
          path: path.startsWith(basePath) ? path.slice(basePath.length) : path,
          scopes: scopesOf(item.get),
          queryParameters: (item.get.parameters ?? [])
            .filter((parameter) => parameter.in === "query")
            .map((parameter) => parameter.name),
        },
      ]
    : [],
);

export type ErrorReference = {
  status: string;
  codes: readonly string[];
  description: string;
};

export const errorReference: readonly ErrorReference[] = Object.entries(
  document.components.responses as unknown as Readonly<
    Record<string, ErrorResponse>
  >,
).map(([name, response]) => ({
  status: name.replace(/^Status/u, ""),
  codes: response.content["application/json"].schema.properties.error.enum,
  description: response.description,
}));

/**
 * One line for each read path, keyed as `readReference` gives the path. The
 * document has no prose for them, so these are written by hand; the page test
 * holds the keys to the document's read paths.
 */
export const readDescriptions: Readonly<Record<string, string>> = {
  "/whoami": "The calling principal and its organization.",
  "/organizations": "The credential's own organization, as a list.",
  "/projects": "Projects the principal can reach.",
  "/projects/{projectId}": "One project.",
  "/requests": "Requests, with opaque cursors.",
  "/requests/{requestId}/timeline": "That request's ordered timeline.",
  "/requests/{requestId}": "One request.",
  "/questions": "Open human questions.",
  "/events": "The tenant event stream.",
  "/administration/projects":
    "Operator credentials only: each project's id and status, and whether the member may represent it.",
  "/administration/lanes":
    "Operator credentials only: each active lane's id and project.",
  "/administration/members":
    "Operator credentials only: each active member's user id, role and version.",
  // Plan 13, F.2.3: an administration read, for an operator credential only.
  "/administration/projects/{projectId}/settings":
    "One project's settings as its settings commands need them: ids, versions and the fields they resend. Operator credentials only.",
  // Plan 13, F.2.1: an administration read and route evaluation's two
  // purposes, for an organisation-wide operator credential only.
  "/administration/routing-rules":
    "The organisation's routing rules as the rule commands need them: ids, versions, enabled, and every field an update resends. Operator credentials only.",
  "/administration/route-evaluations/test":
    "How the organisation's routing rules decide a route, as the routing tester evaluates it: for the operator's member or a named agent principal, on a lane if one is named. Operator credentials only.",
  "/administration/route-evaluations/preview":
    "How the organisation's routing rules decide a route the operator's member would raise, as the request form's preview evaluates it. Operator credentials only.",
  // Plan 13, F.2.2: the agent administration reads, for an operator
  // credential only.
  "/administration/agent-principals":
    "Each agent principal the member may manage: its id, project, status and version. Operator credentials only.",
  "/administration/agent-principals/{agentPrincipalId}":
    "One agent principal as suspension and the two revocations need it: its status and version; each key's id, version, expiry and revocation; each grant's, with its status. Operator credentials only.",
  // Plan 13, F.2.4: two administration reads, for an organisation-wide
  // operator credential only.
  "/administration/operations":
    "Operator credentials bound to no project only: the outbox rows, notification intents, Slack operations and import dispatches a requeue takes, each with its id, state and attempt count.",
  "/administration/retention-holds":
    "Operator credentials bound to no project only: each retention hold's id, category, status and version.",
  // Plan 13, F.2.5: an administration read, for an operator credential only.
  "/administration/slack":
    "The organization's Slack installations, user mappings and routes as the Slack commands need them: ids, versions, states and the route fields they resend. Operator credentials bound to no project only.",
  // Plan 13, F.2.6: two administration reads, for an operator credential only.
  "/administration/import-runs":
    "The organisation's import runs, newest first and at most 200: each run's id, source project, state and version. Operator credentials only.",
  "/administration/import-runs/{runId}":
    "One import run as review and the split need it: its id, state and version, and each entry's id, decision, canonical request and version. Operator credentials only.",
  // Plan 13, F.2.7: two administration reads, for an operator credential only.
  "/administration/invitations":
    "Operator credentials only: each pending invitation's id, role and version, with no address.",
  "/administration/appearance":
    "Operator credentials only: the organisation's appearance defaults and their version, for an owner's credential.",
};
