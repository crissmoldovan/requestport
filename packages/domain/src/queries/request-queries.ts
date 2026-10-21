import { z } from "zod";
import type {
  RequestAction,
  requestStates,
} from "../requests/request-types.js";
import type {
  requestPriorities,
  requestTypes,
} from "../routing/routing-types.js";
import { DomainError } from "../shared/errors.js";
import type { JsonValue } from "../shared/idempotency.js";

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface RequestListItem {
  id: string;
  displayKey: string | null;
  title: string;
  type: (typeof requestTypes)[number];
  priority: (typeof requestPriorities)[number];
  visibility: "organization" | "restricted";
  sensitivity: "normal" | "sensitive";
  state: (typeof requestStates)[number];
  sourceKind: "project" | "human_direct";
  sourceProjectId: string | null;
  sourceProjectName: string | null;
  targetProjectId: string;
  targetProjectName: string;
  laneId: string | null;
  laneName: string | null;
  reporterType: "user" | "agent" | "service";
  reporterId: string;
  assigneeType: "user" | "agent" | null;
  assigneeId: string | null;
  updatedAt: Date;
  unread: boolean;
  openQuestionCount: number;
}

export interface RequestFilters {
  sourceProjectId?: string;
  targetProjectId?: string;
  laneId?: string;
  state?: Array<(typeof requestStates)[number]>;
  type?: Array<(typeof requestTypes)[number]>;
  priority?: Array<(typeof requestPriorities)[number]>;
  label?: string;
  reporterId?: string;
  assigneeId?: string;
  unanswered?: boolean;
  updatedAfter?: Date;
  mode?: "all" | "inbox" | "my_work";
}

export interface RequestMessageView {
  id: string;
  actorType: string;
  actorId: string;
  bodyMd: string;
  visibility: string;
  replyToId: string | null;
  createdAt: Date;
}

export interface RequestAnswerView {
  id: string;
  actorType: string;
  actorId: string;
  sourceChannel: string;
  bodyMd: string;
  structuredValue: JsonValue | null;
  accepted: boolean;
  createdAt: Date;
}

export interface RequestQuestionView {
  id: string;
  audienceType: string;
  audienceId: string | null;
  bodyMd: string;
  choices: string[];
  allowFreeText: boolean;
  answerMode: "single" | "multiple";
  blocksRequest: boolean;
  state: "open" | "answered" | "closed";
  deadlineAt: Date | null;
  version: number;
  createdAt: Date;
  canAnswer: boolean;
  canClose: boolean;
  answers: RequestAnswerView[];
  deliveries: Array<{
    id: string;
    channel: string;
    status: string;
    createdAt: Date;
    attempts: Array<{ status: string; updatedAt: Date }>;
  }>;
}

export interface RequestDetail extends RequestListItem {
  descriptionMd: string;
  version: number;
  stateReason: string | null;
  resumeState: string | null;
  routingRuleId: string | null;
  routingPolicyVersion: number | null;
  createdAt: Date;
  submittedAt: Date | null;
  allowedActions: RequestAction[];
  permissions: {
    canAskBlocking: boolean;
    canEdit: boolean;
    canParticipate: boolean;
  };
  labels: string[];
  acceptanceCriteria: Array<{
    id: string;
    position: number;
    text: string;
    satisfiedAt: Date | null;
  }>;
  relationships: Array<{
    id: string;
    direction: "outgoing" | "incoming";
    type: string;
    requestId: string;
    displayKey: string | null;
    title: string;
  }>;
  messages: RequestMessageView[];
  questions: RequestQuestionView[];
  artifacts: Array<{
    id: string;
    kind: string;
    externalUrl: string;
    mediaType: string | null;
    byteSize: number | null;
    sha256: string | null;
    provenance: Record<string, JsonValue>;
    createdAt: Date;
  }>;
  completionReport: null | {
    id: string;
    outcomeMd: string;
    changedRepositories: Array<Record<string, JsonValue>>;
    validations: Array<Record<string, JsonValue>>;
    risksMd: string;
    followupsMd: string;
    verificationStepsMd: string;
    createdAt: Date;
  };
  workSessions: Array<{
    id: string;
    agentPrincipalId: string;
    agentDisplayName: string;
    state: string;
    progressPercent: number | null;
    latestProgress: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    leaseExpiresAt: Date;
    updatedAt: Date;
  }>;
  provenance: {
    aliases: Array<{
      id: string;
      namespace: string;
      normalizedKey: string;
      relativePath: string;
      sha256: string;
    }>;
    mappings: Array<{
      id: string;
      recordIndex: number;
      relativePath: string;
      sha256: string;
      importRunId: string;
      appliedAt: Date;
    }>;
  };
}

export interface TimelineEventView {
  id: string;
  type: string;
  schemaVersion: number;
  occurredAt: Date;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  actor: Record<string, JsonValue>;
  data: Record<string, JsonValue>;
  links: Record<string, string>;
}

export interface RequestQueryRepository {
  listRequests(input: {
    userId: string;
    organizationId: string;
    filters?: RequestFilters;
    cursor?: string;
    limit?: number;
  }): Promise<CursorPage<RequestListItem>>;
  getRequest(input: {
    userId: string;
    organizationId: string;
    requestId: string;
  }): Promise<RequestDetail | null>;
  listTimeline(input: {
    userId: string;
    organizationId: string;
    requestId: string;
    cursor?: string;
    limit?: number;
  }): Promise<CursorPage<TimelineEventView>>;
  listOrganizationActivity(input: {
    userId: string;
    organizationId: string;
    cursor?: string;
    limit?: number;
  }): Promise<CursorPage<TimelineEventView>>;
  listOpenQuestions(input: {
    userId: string;
    organizationId: string;
    cursor?: string;
    limit?: number;
  }): Promise<
    CursorPage<
      RequestQuestionView & {
        requestId: string;
        displayKey: string | null;
        title: string;
      }
    >
  >;
  markRequestRead(input: {
    userId: string;
    organizationId: string;
    requestId: string;
    lastSeenEventId: string | null;
  }): Promise<void>;
}

const cursorSchema = z.object({
  v: z.literal(1),
  at: z.iso.datetime(),
  id: z.uuid(),
});

export function encodeCursor(value: { at: Date; id: string }) {
  return Buffer.from(
    JSON.stringify({ v: 1, at: value.at.toISOString(), id: value.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(value: string | undefined) {
  if (!value) return null;
  if (value.length > 2_048) {
    throw new DomainError("validation_failed", "Cursor is invalid");
  }
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return { at: new Date(parsed.at), id: parsed.id };
  } catch {
    throw new DomainError("validation_failed", "Cursor is invalid");
  }
}

export function normalizePageLimit(limit: number | undefined) {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new DomainError(
      "validation_failed",
      "Page limit must be between 1 and 200",
    );
  }
  return limit;
}
