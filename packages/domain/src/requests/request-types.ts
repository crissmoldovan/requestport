import type {
  RequestPriority,
  RequestType,
  RouteSource,
} from "../routing/routing-types.js";
import type {
  ActorRef,
  AuthorizedCommandContext,
} from "../shared/authorization.js";

export const requestStates = [
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
] as const;
export type RequestState = (typeof requestStates)[number];

export type ResumableRequestState =
  | "triage"
  | "accepted"
  | "planned"
  | "in_progress"
  | "completed";

export type RequestAction =
  | "submit_request"
  | "begin_triage"
  | "accept_request"
  | "decline_request"
  | "mark_duplicate"
  | "supersede_request"
  | "plan_request"
  | "begin_request_work"
  | "block_request"
  | "resume_request"
  | "withdraw_request"
  | "cancel_request"
  | "reopen_request"
  | "complete_request"
  | "verify_request";

export type RequestTransitionAction =
  | RequestAction
  | "ask_question"
  | "answer_question";

export interface RequestRecord {
  id: string;
  organizationId: string;
  sequenceNumber: number | null;
  displayKey: string | null;
  source: RouteSource;
  targetProjectId: string;
  laneId: string | null;
  type: RequestType;
  title: string;
  descriptionMd: string;
  priority: RequestPriority;
  visibility: "organization" | "restricted";
  sensitivity: "normal" | "sensitive";
  state: RequestState;
  resumeState: ResumableRequestState | null;
  stateReason: string | null;
  reporter: ActorRef;
  assignee: ActorRef | null;
  version: number;
  routingRuleId: string | null;
  routingPolicyVersion: number | null;
  createdAt: Date;
  submittedAt: Date | null;
  updatedAt: Date;
}

export interface RequestActorAccess {
  organizationRole: "owner" | "admin" | "member" | null;
  projectRole: "maintainer" | "contributor" | "viewer" | null;
  isReporter: boolean;
  hasExclusiveClaim: boolean;
  isActiveWorker: boolean;
  explicitTriageGrant: boolean;
}

export interface CompletionReportInput {
  outcomeMd: string;
  changedRepositories: Array<{
    repositoryId?: string;
    repositoryUrl?: string;
    commitSha?: string;
    artifactId?: string;
  }>;
  validations: Array<{
    command: string;
    result: "passed" | "failed" | "not_run";
    summary?: string;
  }>;
  risksMd: string;
  followupsMd: string;
  verificationStepsMd: string;
}

export interface RequestRepository {
  validateDraftOwnership(input: {
    context: AuthorizedCommandContext;
    organizationId: string;
    source: RouteSource;
    targetProjectId: string;
    laneId: string | null;
  }): Promise<boolean>;
  createDraft(input: {
    id: string;
    organizationId: string;
    source: RouteSource;
    targetProjectId: string;
    laneId: string | null;
    type: RequestType;
    title: string;
    descriptionMd: string;
    priority: RequestPriority;
    visibility: "organization" | "restricted";
    sensitivity: "normal" | "sensitive";
    labels: string[];
    acceptanceCriteria: string[];
    reporter: ActorRef;
  }): Promise<RequestRecord>;
  findForUpdate(
    organizationId: string,
    requestId: string,
  ): Promise<RequestRecord | null>;
  actorAccess(
    request: RequestRecord,
    context: AuthorizedCommandContext,
  ): Promise<RequestActorAccess>;
  canReference(
    organizationId: string,
    requestId: string,
    context: AuthorizedCommandContext,
  ): Promise<boolean>;
  hasAcceptanceCriteria(requestId: string): Promise<boolean>;
  allocateDisplayKey(request: RequestRecord): Promise<{
    sequenceNumber: number;
    displayKey: string;
  }>;
  transition(input: {
    requestId: string;
    organizationId: string;
    expectedVersion: number;
    fromState: RequestState;
    toState: RequestState;
    resumeState: ResumableRequestState | null;
    reason: string | null;
    display?: { sequenceNumber: number; displayKey: string };
    routingRuleId?: string | null;
    routingPolicyVersion?: number | null;
  }): Promise<RequestRecord>;
  updateContent(input: {
    requestId: string;
    organizationId: string;
    expectedVersion: number;
    title?: string;
    descriptionMd?: string;
    priority?: RequestPriority;
    visibility?: "organization" | "restricted";
    sensitivity?: "normal" | "sensitive";
  }): Promise<RequestRecord>;
  insertStateTransition(input: {
    id: string;
    request: RequestRecord;
    fromState: RequestState;
    action: RequestTransitionAction;
    reason: string | null;
    actor: ActorRef;
    eventId: string;
  }): Promise<void>;
  createCompletionReport(input: {
    id: string;
    request: RequestRecord;
    actor: ActorRef;
    report: CompletionReportInput;
  }): Promise<void>;
  validateCompletionReferences(
    request: RequestRecord,
    report: CompletionReportInput,
  ): Promise<boolean>;
  addRelationship(input: {
    organizationId: string;
    fromRequestId: string;
    toRequestId: string;
    type: "duplicates" | "supersedes";
    actor: ActorRef;
  }): Promise<{ id: string }>;
}
