/**
 * An authenticated agent and a way to call `/api/v1` as it, for the B1
 * characterisation suites. See `fake-database.ts` for what is faked.
 */
import { agentScopes } from "@requestport/domain";

import { apiV1 } from "./fake-database.js";

export const ids = {
  organization: "018f0000-0000-7000-8000-00000000b101",
  project: "018f0000-0000-7000-8000-00000000b102",
  agent: "018f0000-0000-7000-8000-00000000b103",
  authorization: "018f0000-0000-7000-8000-00000000b104",
  delegatingUser: "b1-delegating-user",
  request: "018f0000-0000-7000-8000-00000000b105",
  relatedRequest: "018f0000-0000-7000-8000-00000000b106",
  question: "018f0000-0000-7000-8000-00000000b107",
  relationship: "018f0000-0000-7000-8000-00000000b108",
  installation: "018f0000-0000-7000-8000-00000000b109",
  workspace: "018f0000-0000-7000-8000-00000000b10a",
  repository: "018f0000-0000-7000-8000-00000000b10b",
  workSession: "018f0000-0000-7000-8000-00000000b10c",
  otherOrganization: "018f0000-0000-7000-8000-00000000b1ff",
} as const;

/**
 * Every scope a *working* agent grant can hold. `project:provision` is left
 * out because a grant carrying it may carry nothing else (the grant service
 * and a database constraint both refuse the mixture), and such a grant has no
 * project — which `/api/v1` refuses before any scope is consulted.
 */
export const workingAgentScopes: readonly string[] = agentScopes.filter(
  (scope) => scope !== "project:provision",
);

export type FakeAgentContext = {
  actor: {
    type: "agent";
    id: string;
    delegatedBy?: { type: "user"; id: string };
  };
  organizationId: string;
  projectId: string | null;
  laneIds: ReadonlySet<string>;
  scopes: ReadonlySet<string>;
  credentialId: string;
  credentialFingerprint: string;
  correlationId: string;
  audience: "api";
  authorizationId: string;
};

/** The shape `authenticateAgentBearer(request, "api")` resolves to. */
export function agentContext(
  overrides: Partial<Omit<FakeAgentContext, "scopes">> & {
    scopes?: Iterable<string>;
  } = {},
): FakeAgentContext {
  const { scopes, ...rest } = overrides;
  return {
    actor: {
      type: "agent",
      id: ids.agent,
      delegatedBy: { type: "user", id: ids.delegatingUser },
    },
    organizationId: ids.organization,
    projectId: ids.project,
    laneIds: new Set(),
    credentialId: ids.authorization,
    credentialFingerprint: "b1-credential-fingerprint",
    correlationId: "018f0000-0000-7000-8000-00000000b1cc",
    audience: "api",
    authorizationId: ids.authorization,
    ...rest,
    scopes: new Set(scopes ?? workingAgentScopes),
  };
}

/** Authenticate every following call as this agent. */
export function signInAs(context: FakeAgentContext) {
  apiV1.authenticate.mockResolvedValue(context);
  return context;
}

type RouteContext = { params: Promise<{ path?: string[] }> };
type Handler = (request: Request, context: RouteContext) => Promise<Response>;

export const apiOrigin = "https://requestport.test";

function routeContext(path: readonly string[] | undefined): RouteContext {
  return {
    params: Promise.resolve(path === undefined ? {} : { path: [...path] }),
  };
}

export function restClient(route: { GET: Handler; POST: Handler }) {
  return {
    get(path: readonly string[] | undefined, query = "") {
      return route.GET(
        new Request(`${apiOrigin}/api/v1/${(path ?? []).join("/")}${query}`, {
          headers: { authorization: "Bearer b1-fake-credential" },
        }),
        routeContext(path),
      );
    },
    /** A raw POST: the body and headers exactly as given. */
    postRaw(
      path: readonly string[] | undefined,
      init: { body?: BodyInit | null; headers?: Record<string, string> },
    ) {
      return route.POST(
        new Request(`${apiOrigin}/api/v1/${(path ?? []).join("/")}`, {
          method: "POST",
          body: init.body ?? null,
          headers: {
            authorization: "Bearer b1-fake-credential",
            ...init.headers,
          },
          ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}),
        } as RequestInit),
        routeContext(path),
      );
    },
    /** A well-formed command envelope for `/commands/<name>`. */
    command(
      name: string,
      envelope: {
        input?: Record<string, unknown>;
        idempotencyKey?: string;
        expectedVersion?: number;
      },
    ) {
      return this.postRaw(["commands", name], {
        body: JSON.stringify({
          idempotencyKey: "b1-idempotency-key-0001",
          expectedVersion: 0,
          ...envelope,
        }),
        headers: { "content-type": "application/json" },
      });
    },
  };
}
