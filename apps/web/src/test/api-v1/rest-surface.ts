/**
 * The `/api/v1` surface as characterised by Plan 13, track B1, written down
 * independently of `route.ts` so the suites can hold the route to it.
 *
 * This is the regression net F.1 is meant to land on: when the command `Set`
 * and the `GET` if-chain are replaced by a capability registry, every row here
 * must still answer the same way, or the difference must be a decision someone
 * wrote down. A row changing because the route changed is the point of the
 * table; a row changing because a test was "fixed" to match is not.
 *
 * Every value below was read from the code at the commit this table was
 * written against, not inferred: the scope each command demands is the one its
 * domain definition passes to `requireScope` (or, for the lifecycle names,
 * the one `authorizeAction` demands for that action), and
 * `register_project`'s is the one `project-registration-repository.ts` checks.
 */
import {
  admitsCredentialKind,
  type RequestState,
  restCommandTransports,
} from "@requestport/domain";

import { ids } from "./agent-client.js";

/** Where a command's scope is enforced — which decides what B1 can prove. */
export type ScopeEnforcement =
  /** In the domain definition's `authorize`, before `execute` runs. */
  | "authorize"
  /**
   * By the action, in `transition_request`: in its `authorize`, before the
   * request is read, and again in its `execute`. Until F.1 step 3 it was
   * `execute` alone, which a replay from a receipt skipped (B1, finding 1).
   */
  | "by-action"
  /** In `@requestport/db`, which these suites fake: needs a database. */
  | "database";

export type RestCommand = {
  /** The name in the URL: `POST /api/v1/commands/<name>`. */
  name: string;
  /**
   * The command the bus is asked to run, or `null` when the route bypasses
   * the bus altogether (`register_project`).
   */
  busCommand: string | null;
  /** Fields the route writes into `input` after the caller's, so they win. */
  injected: Record<string, string>;
  requiredScope: string;
  scopeEnforcement: ScopeEnforcement;
  /**
   * A minimal `input` that the command's schema accepts, as a caller sends it
   * — without the injected fields. Valid input is what lets a scope refusal be
   * seen at all: invalid input is refused as 422 before any scope is read.
   */
  input: Record<string, unknown>;
  /** The envelope's `expectedVersion`. Creation commands demand 0. */
  expectedVersion: number;
  /** The state of the fake request the command finds, when it reads one. */
  requestState: RequestState;
  /** Set for a resumable fake request (`resume_request` needs one). */
  resumeState?: RequestState;
};

const reason = "Characterisation reason, long enough.";

function lifecycle(
  name: string,
  requiredScope: string,
  requestState: RequestState,
  extra: Record<string, unknown> = {},
  resumeState?: RequestState,
): RestCommand {
  return {
    name,
    busCommand: "transition_request",
    injected: { organizationId: ids.organization, action: name },
    requiredScope,
    scopeEnforcement: "by-action",
    input: { requestId: ids.request, ...extra },
    expectedVersion: 1,
    requestState,
    ...(resumeState ? { resumeState } : {}),
  };
}

function command(
  name: string,
  requiredScope: string,
  input: Record<string, unknown>,
  options: {
    expectedVersion?: number;
    requestState?: RequestState;
    injected?: Record<string, string>;
  } = {},
): RestCommand {
  return {
    name,
    busCommand: name,
    injected: { organizationId: ids.organization, ...options.injected },
    requiredScope,
    scopeEnforcement: "authorize",
    input,
    expectedVersion: options.expectedVersion ?? 1,
    requestState: options.requestState ?? "accepted",
  };
}

const completionReport = {
  outcomeMd: "Done.",
  changedRepositories: [],
  validations: [{ command: "pnpm test", result: "passed" }],
  risksMd: "",
  followupsMd: "",
  verificationStepsMd: "Run it.",
};

/**
 * Every command name `route.ts` accepts from an agent, in the order it lists
 * them. The route accepts others from an operator credential only
 * (`operatorOnlyRestCommands`, below).
 */
export const restCommands: readonly RestCommand[] = [
  command(
    "create_request_draft",
    "request:create",
    {
      targetProjectId: ids.project,
      type: "feature",
      title: "Characterised",
      descriptionMd: "A request made by the B1 suite.",
    },
    {
      expectedVersion: 0,
      injected: { sourceKind: "project", sourceProjectId: ids.project },
    },
  ),
  command("update_request", "request:write", {
    requestId: ids.request,
    title: "Renamed",
  }),
  lifecycle("submit_request", "request:create", "draft"),
  lifecycle("begin_triage", "request:triage", "submitted"),
  lifecycle("accept_request", "request:triage", "triage", { reason }),
  lifecycle("decline_request", "request:triage", "triage", { reason }),
  lifecycle("mark_duplicate", "request:triage", "triage", {
    reason,
    relatedRequestId: ids.relatedRequest,
  }),
  lifecycle("supersede_request", "request:triage", "triage", {
    reason,
    relatedRequestId: ids.relatedRequest,
  }),
  lifecycle("plan_request", "request:triage", "accepted"),
  lifecycle("begin_request_work", "work:update", "accepted"),
  lifecycle("block_request", "work:update", "in_progress", { reason }),
  lifecycle(
    "resume_request",
    "work:update",
    "blocked",
    { reason },
    "in_progress",
  ),
  lifecycle("withdraw_request", "request:create", "submitted", { reason }),
  lifecycle("cancel_request", "request:triage", "submitted", { reason }),
  lifecycle("reopen_request", "request:triage", "declined", { reason }),
  lifecycle("complete_request", "request:complete", "in_progress", {
    report: completionReport,
  }),
  lifecycle("verify_request", "request:verify", "completed", {
    reason,
    verificationEvidence: "Checked by hand.",
  }),
  {
    // Exposed under its own name too, so a caller can name any lifecycle
    // action itself. It is the one lifecycle route whose `action` the caller
    // chooses; the scope is the chosen action's.
    ...lifecycle("transition_request", "request:triage", "submitted", {
      action: "begin_triage",
    }),
    busCommand: "transition_request",
    injected: { organizationId: ids.organization },
  },
  command(
    "post_message",
    "request:write",
    {
      requestId: ids.request,
      bodyMd: "A message from the B1 suite.",
    },
    { expectedVersion: 0 },
  ),
  command(
    "ask_question",
    "request:write",
    {
      requestId: ids.request,
      audience: { type: "requester" },
      bodyMd: "A question from the B1 suite?",
    },
    { expectedVersion: 0 },
  ),
  command("answer_question", "question:answer", {
    questionId: ids.question,
    bodyMd: "An answer from the B1 suite.",
    sourceChannel: "mcp",
  }),
  command("close_question", "request:write", {
    questionId: ids.question,
    reason,
  }),
  command(
    "link_requests",
    "request:write",
    {
      fromRequestId: ids.request,
      toRequestId: ids.relatedRequest,
      type: "related_to",
    },
    { expectedVersion: 0 },
  ),
  command(
    "unlink_requests",
    "request:write",
    {
      requestId: ids.request,
      relationshipId: ids.relationship,
    },
    { expectedVersion: 0 },
  ),
  command(
    "attach_artifact",
    "request:write",
    {
      requestId: ids.request,
      kind: "link",
      externalUrl: "https://example.com/b1-artifact",
    },
    { expectedVersion: 0 },
  ),
  command(
    "register_agent_installation",
    "agent:register",
    { softwareName: "b1-suite", softwareVersion: "1.0.0" },
    { expectedVersion: 0 },
  ),
  {
    name: "register_project",
    busCommand: null,
    injected: {},
    requiredScope: "agent:register",
    scopeEnforcement: "database",
    input: { alias: "b1-characterised" },
    expectedVersion: 0,
    requestState: "accepted",
  },
  command(
    "register_machine_workspace",
    "agent:register",
    {
      projectId: ids.project,
      repositoryId: ids.repository,
      installationId: ids.installation,
      privateTelemetry: {},
    },
    { expectedVersion: 0 },
  ),
  command(
    "claim_request",
    "work:claim",
    {
      requestId: ids.request,
      installationId: ids.installation,
      workspaceId: ids.workspace,
    },
    { expectedVersion: 0 },
  ),
  command("start_work_session", "work:update", {
    workSessionId: ids.workSession,
  }),
  command("heartbeat_work_session", "work:update", {
    workSessionId: ids.workSession,
  }),
  command("post_work_update", "work:update", {
    workSessionId: ids.workSession,
    kind: "progress",
    bodyMd: "Progress from the B1 suite.",
  }),
  command("pause_work_session", "work:update", {
    workSessionId: ids.workSession,
    reason,
  }),
  command("resume_work_session", "work:update", {
    workSessionId: ids.workSession,
    reason,
  }),
  command("block_work_session", "work:update", {
    workSessionId: ids.workSession,
    reason,
  }),
  command("release_request", "work:update", {
    workSessionId: ids.workSession,
    reason,
  }),
  command("end_work_session", "work:update", {
    workSessionId: ids.workSession,
    reason,
  }),
  // Ruling 264: the request goes to the delegating person, as a member of
  // the organisation would be named.
  command("assign_request", "request:triage", {
    requestId: ids.request,
    assigneeUserId: ids.delegatingUser,
  }),
];

/**
 * Commands `/api/v1` accepts from an operator credential only (Plan 13, F.3):
 * their registry entry names `credentialKinds` without `"agent"`, so an agent
 * naming one is refused with 403 before the body is read. Read from the
 * registry rather than written down, because `credentialKinds` is the one
 * admission list (ruling 25); `route.operator.test.ts` holds what an operator
 * gets from each.
 */
export const operatorOnlyRestCommands: readonly {
  name: string;
  busCommand: string | null;
}[] = restCommandTransports
  .filter((transport) => !admitsCredentialKind(transport, "agent"))
  .map((transport) => ({
    name: transport.name,
    busCommand:
      transport.dispatch.to === "command-bus"
        ? transport.dispatch.commandName
        : null,
  }));

/**
 * Commands the core registry holds that `/api/v1` does not expose. Adding one
 * to the route is a decision about the public surface, so it should fail here
 * first and be moved into `restCommands` on purpose.
 */
export const registryCommandsNotOnRest = [
  "abandon_work_session",
  "create_agent_principal",
  "mark_work_session_stale",
] as const;

export type RestQuery = {
  /** A label for test names. */
  route: string;
  path: readonly string[];
  /** `agentQueryRepository`'s method the route answers from. */
  repositoryMethod:
    | "getAgentPolicy"
    | "listOrganizations"
    | "listProjects"
    | "getProject"
    | "listRequests"
    | "getRequest"
    | "listTimeline"
    | "listOpenQuestions"
    | "listEvents";
  /** `null` for `whoami`, which demands a project but no scope. */
  requiredScope: string | null;
};

/** All 9 `GET` paths, in the order `route.ts` tests for them. */
export const restQueries: readonly RestQuery[] = [
  {
    route: "whoami",
    path: ["whoami"],
    repositoryMethod: "getAgentPolicy",
    requiredScope: null,
  },
  {
    route: "organizations",
    path: ["organizations"],
    repositoryMethod: "listOrganizations",
    requiredScope: "org:read",
  },
  {
    route: "projects",
    path: ["projects"],
    repositoryMethod: "listProjects",
    requiredScope: "project:read",
  },
  {
    route: "projects/:projectId",
    path: ["projects", ids.project],
    repositoryMethod: "getProject",
    requiredScope: "project:read",
  },
  {
    route: "requests",
    path: ["requests"],
    repositoryMethod: "listRequests",
    requiredScope: "request:read",
  },
  {
    route: "requests/:requestId/timeline",
    path: ["requests", ids.request, "timeline"],
    repositoryMethod: "listTimeline",
    requiredScope: "request:read",
  },
  {
    route: "requests/:requestId",
    path: ["requests", ids.request],
    repositoryMethod: "getRequest",
    requiredScope: "request:read",
  },
  {
    route: "questions",
    path: ["questions"],
    repositoryMethod: "listOpenQuestions",
    requiredScope: "request:read",
  },
  {
    route: "events",
    path: ["events"],
    repositoryMethod: "listEvents",
    requiredScope: "request:read",
  },
];
