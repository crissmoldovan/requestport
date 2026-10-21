import type {
  AgentQueryContext,
  createAgentQueryRepository,
} from "@requestport/db";
import {
  type AuthorizedCommandContext,
  admitsCredentialKind,
  type CredentialKind,
  capabilityRegistry,
  DomainError,
  findQueryCapability,
  isOperatorContext,
  type QueryCapability,
  restApiBasePath,
} from "@requestport/domain";
import { z } from "zod";

import {
  type AdministrationReading,
  findAdministrationRead,
  isAdministrationEntry,
  isAdministrationPath,
  notAdmittedToAdministration,
  readAdministrationEntry,
  refuseAgentAtAdministration,
} from "./administration-reads.js";
import { networkCredentialKind, requireProject } from "./network-call.js";

/*
  Running one registry query (manifest-g.md §2.5; Done when 7): the entry by
  its registry name, its admission and its dispatch target, the agent
  queries or an administration read. The REST route's GET handler ran all of
  it until Plan 13, G.6, and is now an adapter over this. Since Plan 13, H.1
  that handler is `handleRestQuery` (`packages/server/src/rest.ts`), which
  the route (`apps/web/src/app/api/v1/[[...path]]/route.ts`) composes. It
  keeps authentication, the rate limit and the response, and finds the
  entry its path names with `resolveRestQuery`, below, which answers the
  refusals a path no entry admits has always had. Here the entry, the kind
  and the project are checked again before the dispatch.

  The entry is read from the registry as it stands when the query runs, as
  the GET handler matched its paths against it, so an entry added at run
  time is found. The scope an agent query checks is asked of
  `findQueryCapability` by name, as the GET handler asked it.

  Admission is the GET handler's:
  - an administration read refuses every agent credential, admits an
    operator only to an entry whose `credentialKinds` names `"operator"`,
    and then only with the entry's scope (`readAdministrationEntry`);
  - an operator at any other query is refused unless the entry admits
    operators, and then lacking its scope; `whoami` is answered from the
    operator's own context, and any other read an entry admits operators to
    has no dispatch, a fault answered as one (500);
  - an agent at any other query is refused without a project
    (`requireProject`), then lacking the scope the registry gives the query
    (`requireQueryScope`). Before both, it is refused at an entry that does
    not admit agents; every such entry admits them today, so that check
    refuses nothing the GET handler answered, and holds `query` to
    `admitsCredentialKind` for an entry that someday does not.

  The agent queries make the project and scope checks again themselves
  (`createAgentQueries`, ruling 230), for a caller of the published API that
  reaches them without `query`, and each administration read makes its
  admission again itself (`administrationReads`, ruling 230).
*/

const requestStateSchema = z.enum([
  "draft",
  "submitted",
  "triage",
  "accepted",
  "planned",
  "in_progress",
  "blocked",
  "waiting_human",
  "waiting_requester",
  "completed",
  "verified",
  "declined",
  "duplicate",
  "superseded",
  "cancelled",
]);

type AgentQueryRepository = ReturnType<typeof createAgentQueryRepository>;

/**
 * An agent's context as the agent queries read it, before its project is
 * proven: the repository's own context (`AgentQueryContext`), whose project
 * may still be absent, as an exclusively-provisioning grant's is.
 */
export type AgentQueryCaller = Omit<AgentQueryContext, "projectId"> & {
  projectId?: string | null;
};

/**
 * The nine agent queries a RequestPort composes, each over a repository built
 * when it runs. Before the repository is built, each refuses a context bound
 * to no project (`requireProject`), and then one lacking the scope the
 * registry gives the query it serves (`requireQueryScope`), as `query`
 * refuses an agent's call to that query, in the same words (ruling 230). The
 * scopes checked are the ones the context states. These are the queries
 * `query` dispatches an agent's call to, and the ones MCP's tools run, which
 * MCP admits by its own tool registration and scope.
 */
export interface AgentQueries {
  getAgentPolicy(
    context: AgentQueryCaller,
  ): ReturnType<AgentQueryRepository["getAgentPolicy"]>;
  listOrganizations(
    context: AgentQueryCaller,
  ): ReturnType<AgentQueryRepository["listOrganizations"]>;
  listProjects(
    context: AgentQueryCaller,
  ): ReturnType<AgentQueryRepository["listProjects"]>;
  getProject(
    context: AgentQueryCaller,
    projectId: string,
  ): ReturnType<AgentQueryRepository["getProject"]>;
  listRequests(
    context: AgentQueryCaller,
    input: Parameters<AgentQueryRepository["listRequests"]>[1],
  ): ReturnType<AgentQueryRepository["listRequests"]>;
  getRequest(
    context: AgentQueryCaller,
    requestId: string,
  ): ReturnType<AgentQueryRepository["getRequest"]>;
  listTimeline(
    context: AgentQueryCaller,
    requestId: string,
    cursor?: string,
  ): ReturnType<AgentQueryRepository["listTimeline"]>;
  listOpenQuestions(
    context: AgentQueryCaller,
    cursor?: string,
  ): ReturnType<AgentQueryRepository["listOpenQuestions"]>;
  listEvents(
    context: AgentQueryCaller,
    cursor?: string,
  ): ReturnType<AgentQueryRepository["listEvents"]>;
}

/**
 * The agent queries over `repository`, asked once for each query that runs,
 * each admitted by `scopeChecked` before it runs.
 */
export function createAgentQueries(
  repository: () => AgentQueryRepository,
): AgentQueries {
  const queries: AgentQueries = {
    getAgentPolicy(context) {
      const scoped = requireProject(context);
      return repository().getAgentPolicy(scoped);
    },
    listOrganizations(context) {
      const scoped = requireProject(context);
      return repository().listOrganizations(scoped);
    },
    listProjects(context) {
      const scoped = requireProject(context);
      return repository().listProjects(scoped);
    },
    getProject(context, projectId) {
      const scoped = requireProject(context);
      return repository().getProject(scoped, projectId);
    },
    listRequests(context, input) {
      const scoped = requireProject(context);
      return repository().listRequests(scoped, input);
    },
    getRequest(context, requestId) {
      const scoped = requireProject(context);
      return repository().getRequest(scoped, requestId);
    },
    listTimeline(context, requestId, cursor) {
      const scoped = requireProject(context);
      return repository().listTimeline(scoped, requestId, cursor);
    },
    listOpenQuestions(context, cursor) {
      const scoped = requireProject(context);
      return repository().listOpenQuestions(scoped, cursor);
    },
    listEvents(context, cursor) {
      const scoped = requireProject(context);
      return repository().listEvents(scoped, cursor);
    },
  };
  return scopeChecked(queries);
}

/**
 * The name of the registry query whose dispatch is the agent query `method`,
 * read from the registry as it stands when the query runs, as `query` reads
 * its entry. No such query, or more than one, is a fault in this dispatch,
 * answered as one (500), never a refusal or a pass.
 */
function queryServedBy(method: keyof AgentQueries): string {
  const names = capabilityRegistry.flatMap((capability) =>
    capability.kind === "query" &&
    capability.dispatch.to === "agent-query-repository" &&
    capability.dispatch.method === method
      ? [capability.name]
      : [],
  );
  const [name] = names;
  if (names.length !== 1 || name === undefined) {
    throw new Error(
      `No single capability registry query dispatches to the agent query ${method}`,
    );
  }
  return name;
}

/**
 * Admits `context` to the agent query `method` by `query`'s rule for an
 * agent, in its order: refused without a project (`requireProject`), then
 * lacking the scope the registry gives the query `method` serves
 * (`requireQueryScope`), which is none for `getAgentPolicy`, `whoami`'s.
 */
function admitAgentQuery(
  context: AgentQueryCaller,
  method: keyof AgentQueries,
) {
  requireQueryScope(requireProject(context), queryServedBy(method));
}

/**
 * `queries`, each admitting its context (`admitAgentQuery`) before it runs,
 * and so before its repository is built (ruling 230). A caller of the
 * published API that hands an agent query an agent's context directly is
 * checked as `query` checks that agent's call. `query` makes the same two
 * checks before it dispatches. The registry gives each method one query, the
 * one `query` calls it for (`@requestport/domain`'s
 * `transport-metadata.test.ts` holds the two in step), so a call `query`
 * admits passes them here too.
 *
 * Each method is `async`, so a refusal, or anything else the admission or
 * the query throws, is the rejection of the promise the method returns,
 * never an exception thrown by the call itself, as `administrationReads`
 * answers one.
 */
function scopeChecked(queries: AgentQueries): AgentQueries {
  return {
    async getAgentPolicy(context) {
      admitAgentQuery(context, "getAgentPolicy");
      return queries.getAgentPolicy(context);
    },
    async listOrganizations(context) {
      admitAgentQuery(context, "listOrganizations");
      return queries.listOrganizations(context);
    },
    async listProjects(context) {
      admitAgentQuery(context, "listProjects");
      return queries.listProjects(context);
    },
    async getProject(context, projectId) {
      admitAgentQuery(context, "getProject");
      return queries.getProject(context, projectId);
    },
    async listRequests(context, input) {
      admitAgentQuery(context, "listRequests");
      return queries.listRequests(context, input);
    },
    async getRequest(context, requestId) {
      admitAgentQuery(context, "getRequest");
      return queries.getRequest(context, requestId);
    },
    async listTimeline(context, requestId, cursor) {
      admitAgentQuery(context, "listTimeline");
      return queries.listTimeline(context, requestId, cursor);
    },
    async listOpenQuestions(context, cursor) {
      admitAgentQuery(context, "listOpenQuestions");
      return queries.listOpenQuestions(context, cursor);
    },
    async listEvents(context, cursor) {
      admitAgentQuery(context, "listEvents");
      return queries.listEvents(context, cursor);
    },
  };
}

/**
 * The context of a network credential's call, as the adapter that
 * authenticated it hands it over: a command context, with what `whoami`
 * answers beyond it where the credential carries it (an agent's audience,
 * and its authorisation, or an operator's). Structural, so core names no
 * type of `@requestport/auth` (manifest-g.md §2.5.1).
 */
export interface QueryContext extends AuthorizedCommandContext {
  audience?: string;
  authorizationId?: string;
}

/** A network credential's call to a query: its context and its kind. */
export interface QueryCall {
  context: QueryContext;
  credentialKind: CredentialKind;
}

/**
 * What a query reads besides its context: its path's parameters, by the
 * names in braces in the entry's path, and the query string, as REST carries
 * it. Absent, each is empty.
 */
export interface QueryParameters {
  pathParameters?: Readonly<Record<string, string>>;
  searchParams?: URLSearchParams;
}

/** What `query` dispatches to. */
export interface QueryTargets {
  /** `agent-query-repository`: the nine agent queries. */
  agentQueries: AgentQueries;
  /**
   * `administration-read`: the handle and the switch each read is handed
   * (`administrationReads`, `administration-reads.ts`).
   */
  administrationReading: AdministrationReading;
}

/**
 * Checks the scope the capability registry gives the query `name`, and none
 * when it gives none (`whoami`). A name the registry does not hold is a fault
 * in this dispatch, answered as one (500), never as a refusal or a pass.
 */
function requireQueryScope(
  context: Pick<AuthorizedCommandContext, "scopes">,
  name: string,
) {
  const query = findQueryCapability(name);
  if (!query) throw new Error(`No capability registry query named ${name}`);
  if (query.scope !== null && !context.scopes.has(query.scope)) {
    throw new DomainError("forbidden", "Agent scope is not sufficient");
  }
}

/**
 * An operator's call to a query outside the administration reads (Plan 13,
 * F.3, F3-12): refused with 403 at a read whose registry entry does not name
 * `"operator"` in `credentialKinds`, before any project check and before any
 * repository runs, so its `operator:<lineage>` id never reaches a uuid
 * comparison; then refused lacking the entry's scope. `whoami` is answered
 * from the operator's own context: its actor and origin, its organisation,
 * its project or null, its scopes. There is no work policy, because an
 * operator does no agent work. Any other read an entry admits operators to
 * needs a dispatch F.3 does not write; until one exists, reaching it is a
 * fault, answered as one (500).
 */
function operatorQuery(entry: QueryCapability, context: QueryContext) {
  if (!admitsCredentialKind(entry, "operator")) {
    throw new DomainError(
      "forbidden",
      "Operator credentials are not admitted to this read",
    );
  }
  if (entry.scope !== null && !context.scopes.has(entry.scope)) {
    throw new DomainError("forbidden", "Operator scope is not sufficient");
  }
  if (entry.name !== "whoami") {
    throw new Error(`No operator dispatch for the query ${entry.name}`);
  }
  return {
    actor: context.actor,
    credentialKind: context.credentialKind,
    organizationId: context.organizationId,
    projectId: context.projectId,
    scopes: [...context.scopes].sort(),
    authorizationId: context.authorizationId,
    serverSchemaVersion: 1,
  };
}

/**
 * The agent's context, stated as the agent queries read it. An agent's
 * context as REST and MCP authenticate it always carries its lanes and its
 * authorisation; one without them is a fault in the adapter that built it,
 * answered as one (500), never a pass.
 */
function agentQueryCaller(context: QueryContext): AgentQueryCaller {
  const { actor, laneIds, authorizationId } = context;
  if (actor.type !== "agent" || !laneIds || authorizationId === undefined) {
    throw new Error(
      "An agent's call to a query carries its lanes and its authorisation",
    );
  }
  return { ...context, actor, laneIds, authorizationId };
}

/**
 * An agent's call to one of the agent queries. Every one is project-scoped:
 * an exclusively-provisioning grant has no project, deliberately — its
 * capability is organization-wide — so it is refused once, here, before the
 * query is told apart, rather than by widening the query context to accept
 * an absence that none of those queries could answer.
 */
async function agentQuery(
  agentQueries: AgentQueries,
  entry: QueryCapability,
  context: QueryContext,
  pathParameters: Readonly<Record<string, string>>,
  searchParams: URLSearchParams,
) {
  if (!admitsCredentialKind(entry, "agent")) {
    throw new DomainError(
      "forbidden",
      "This kind of credential is not admitted to this read",
    );
  }
  const projectScoped = requireProject(agentQueryCaller(context));

  switch (entry.name) {
    case "whoami": {
      requireQueryScope(context, "whoami");
      const policy = await agentQueries.getAgentPolicy(projectScoped);
      if (!policy)
        throw new DomainError(
          "forbidden",
          "Project work policy is unavailable",
        );
      return {
        actor: context.actor,
        organizationId: context.organizationId,
        projectId: context.projectId,
        laneIds: [...(context.laneIds ?? [])],
        scopes: [...context.scopes].sort(),
        audience: context.audience,
        authorizationId: context.authorizationId,
        serverSchemaVersion: 1,
        workPolicy: policy,
      };
    }
    case "list_organizations":
      requireQueryScope(context, "list_organizations");
      return agentQueries.listOrganizations(projectScoped);
    case "list_projects":
      requireQueryScope(context, "list_projects");
      return agentQueries.listProjects(projectScoped);
    case "get_project": {
      requireQueryScope(context, "get_project");
      const result = await agentQueries.getProject(
        projectScoped,
        pathParameters.projectId ?? "",
      );
      if (!result) throw new DomainError("not_found", "Project was not found");
      return result;
    }
    case "list_requests": {
      requireQueryScope(context, "list_requests");
      const state = z
        .array(requestStateSchema)
        .max(20)
        .parse(searchParams.getAll("state"));
      return agentQueries.listRequests(projectScoped, {
        cursor: searchParams.get("cursor") ?? undefined,
        limit: searchParams.has("limit")
          ? Number(searchParams.get("limit"))
          : undefined,
        state,
      });
    }
    case "get_request_timeline":
      requireQueryScope(context, "get_request_timeline");
      return agentQueries.listTimeline(
        projectScoped,
        pathParameters.requestId ?? "",
        searchParams.get("cursor") ?? undefined,
      );
    case "get_request": {
      requireQueryScope(context, "get_request");
      const result = await agentQueries.getRequest(
        projectScoped,
        pathParameters.requestId ?? "",
      );
      if (!result) throw new DomainError("not_found", "Request was not found");
      return result;
    }
    case "list_open_questions":
      requireQueryScope(context, "list_open_questions");
      return agentQueries.listOpenQuestions(
        projectScoped,
        searchParams.get("cursor") ?? undefined,
      );
    case "list_events":
      requireQueryScope(context, "list_events");
      return agentQueries.listEvents(
        projectScoped,
        searchParams.get("cursor") ?? undefined,
      );
    default:
      // An agent query entry this does not know is a fault, never a pass.
      throw new Error(`No agent dispatch for the query ${entry.name}`);
  }
}

/** The query entry named `name` in the registry as it stands, or undefined. */
function queryEntryNamed(name: string): QueryCapability | undefined {
  return capabilityRegistry.find(
    (capability): capability is QueryCapability =>
      capability.kind === "query" && capability.name === name,
  );
}

/**
 * Runs one query for `call`, and answers what its dispatch target answers.
 *
 * - A name the registry holds no query for is `not_found`.
 * - A call whose stated kind is not the kind its context is
 *   (`networkCredentialKind`) is `forbidden`, so an operator's context can
 *   never pass as an agent's, nor a person's as either.
 * - Then the entry's own admission, as above, exactly where
 *   `admitsCredentialKind` says no, and its dispatch: an administration read
 *   (`readAdministrationEntry`), `whoami` for an operator, or one of the
 *   agent queries.
 */
export function createQueryExecution(targets: QueryTargets) {
  return async function query(
    name: string,
    parameters: QueryParameters,
    call: QueryCall,
  ): Promise<unknown> {
    const entry = queryEntryNamed(name);
    if (!entry) {
      throw new DomainError("not_found", "API resource was not found");
    }
    const { context, credentialKind } = call;
    if (networkCredentialKind(context) !== credentialKind) {
      throw new DomainError(
        "forbidden",
        "This kind of credential is not admitted to this read",
      );
    }
    const pathParameters = parameters.pathParameters ?? {};
    const searchParams = parameters.searchParams ?? new URLSearchParams();
    if (isAdministrationEntry(entry)) {
      return readAdministrationEntry(
        entry,
        context,
        { pathParameters, searchParams },
        targets.administrationReading,
      );
    }
    if (entry.dispatch.to !== "agent-query-repository") {
      // An entry whose target this does not know is a fault, never a pass.
      throw new Error(`No dispatch for the target of the query ${name}`);
    }
    return credentialKind === "operator"
      ? operatorQuery(entry, context)
      : agentQuery(
          targets.agentQueries,
          entry,
          context,
          pathParameters,
          searchParams,
        );
  };
}

export type QueryExecution = ReturnType<typeof createQueryExecution>;

/**
 * The query entry, other than an administration read, whose registry path
 * `parts` names — each literal segment equal, each `{parameter}` any
 * non-empty segment — with its path parameters, or undefined.
 */
function findAgentQueryByPath(parts: readonly string[]):
  | {
      entry: QueryCapability;
      pathParameters: Record<string, string>;
    }
  | undefined {
  for (const entry of capabilityRegistry) {
    if (entry.kind !== "query" || isAdministrationEntry(entry)) continue;
    const segments = entry.rest.path
      .slice(restApiBasePath.length + 1)
      .split("/");
    if (segments.length !== parts.length) continue;
    const pathParameters: Record<string, string> = {};
    const matched = segments.every((segment, index) => {
      const part = parts[index] ?? "";
      if (!segment.startsWith("{")) return segment === part;
      pathParameters[segment.slice(1, -1)] = part;
      return part.length > 0;
    });
    if (matched) return { entry, pathParameters };
  }
  return undefined;
}

/**
 * The registry query a REST GET's path below `/api/v1` names, with its path
 * parameters, for the credential behind `context`; or the refusal the GET
 * handler has always answered for a path no entry admits. `query` then runs
 * the entry, checking it again.
 *
 * - The administration prefix, and every path under it (Plan 13, F.2.0a),
 *   names only an administration read, whatever else matches: an agent is
 *   refused `403` before anything is looked up, and a path no entry holds is
 *   refused `403` as one no entry admits, so which administration paths
 *   exist is told to no one who may not read them.
 * - Any other path, for an agent, needs a project first (`requireProject`):
 *   every agent query is project-scoped, so a credential bound to none is
 *   refused before its path is looked up.
 * - Then a path no entry holds is `not_found`, for an agent and an operator
 *   alike.
 */
export function resolveRestQuery(
  parts: readonly string[],
  context: AuthorizedCommandContext,
): { name: string; pathParameters: Record<string, string> } {
  if (isAdministrationPath(parts)) {
    refuseAgentAtAdministration(context);
    const found = findAdministrationRead(parts);
    if (!found) throw notAdmittedToAdministration();
    return { name: found.entry.name, pathParameters: found.pathParameters };
  }
  if (!isOperatorContext(context)) requireProject(context);
  const found = findAgentQueryByPath(parts);
  if (!found) throw new DomainError("not_found", "API resource was not found");
  return { name: found.entry.name, pathParameters: found.pathParameters };
}
