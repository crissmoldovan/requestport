import type {
  RequestRecord,
  RequestState,
  ResumableRequestState,
} from "../requests/request-types.js";
import type { ActorRef } from "../shared/authorization.js";
import type { JsonValue } from "../shared/idempotency.js";

export type QuestionAudience =
  | { type: "user"; id: string }
  | { type: "agent"; id: string }
  | { type: "role"; id: "owner" | "admin" | "member" }
  | { type: "requester" }
  | { type: "project_maintainers" };

export interface QuestionRecord {
  id: string;
  organizationId: string;
  requestId: string;
  audience: QuestionAudience;
  bodyMd: string;
  choices: string[];
  allowFreeText: boolean;
  askedBy: ActorRef;
  answerMode: "single" | "multiple";
  blocksRequest: boolean;
  resumeState: ResumableRequestState | null;
  state: "open" | "answered" | "closed";
  version: number;
  deadlineAt: Date | null;
}

export interface AnswerRecord {
  id: string;
  questionId: string;
  actor: ActorRef;
  sourceChannel: "web" | "mcp" | "slack" | "email" | "import";
  bodyMd: string;
  structuredValue: JsonValue | null;
  accepted: boolean;
  createdAt: Date;
}

export interface CollaborationRepository {
  createMessage(input: {
    id: string;
    request: RequestRecord;
    actor: ActorRef;
    bodyMd: string;
    visibility: "organization" | "restricted";
    replyToId: string | null;
    mentionUserIds: string[];
  }): Promise<void>;
  createQuestion(input: {
    id: string;
    request: RequestRecord;
    actor: ActorRef;
    audience: QuestionAudience;
    bodyMd: string;
    choices: string[];
    allowFreeText: boolean;
    answerMode: "single" | "multiple";
    blocksRequest: boolean;
    resumeState: ResumableRequestState | null;
    deadlineAt: Date | null;
    escalationPolicy: Record<string, JsonValue> | null;
  }): Promise<QuestionRecord>;
  findQuestionForUpdate(
    organizationId: string,
    questionId: string,
  ): Promise<QuestionRecord | null>;
  findCanonicalAnswer(questionId: string): Promise<AnswerRecord | null>;
  createAnswer(input: {
    id: string;
    question: QuestionRecord;
    actor: ActorRef;
    sourceChannel: AnswerRecord["sourceChannel"];
    bodyMd: string;
    structuredValue: JsonValue | null;
    accepted: boolean;
  }): Promise<AnswerRecord>;
  updateQuestion(input: {
    questionId: string;
    organizationId: string;
    expectedVersion: number;
    state: QuestionRecord["state"];
    closedBy: ActorRef | null;
    closedReason: string | null;
  }): Promise<QuestionRecord>;
  countOtherOpenBlockingQuestions(
    requestId: string,
    excludingQuestionId: string,
  ): Promise<number>;
  createRelationship(input: {
    id: string;
    organizationId: string;
    fromRequestId: string;
    toRequestId: string;
    type:
      | "blocks"
      | "depends_on"
      | "duplicates"
      | "supersedes"
      | "related_to"
      | "derived_from";
    actor: ActorRef;
  }): Promise<void>;
  removeRelationship(input: {
    organizationId: string;
    relationshipId: string;
  }): Promise<{
    id: string;
    fromRequestId: string;
    toRequestId: string;
    type: string;
  } | null>;
  createArtifact(input: {
    id: string;
    request: RequestRecord;
    actor: ActorRef;
    kind: string;
    externalUrl: string;
    mediaType: string | null;
    byteSize: number | null;
    sha256: string | null;
    provenance: Record<string, JsonValue>;
  }): Promise<void>;
}

export type QuestionResumeResult =
  | { resumed: true; state: RequestState }
  | {
      resumed: false;
      reason:
        | "not_blocking"
        | "other_blockers_open"
        | "request_state_changed"
        | "resume_state_invalid";
    };
