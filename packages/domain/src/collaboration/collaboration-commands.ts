import { isIP } from "node:net";

import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

import type {
  EventFactory,
  EventSchemaRegistry,
} from "../events/event-factory.js";
import type { RequestRepository } from "../requests/request-types.js";
import {
  containsSensitiveContent,
  containsSensitiveJson,
} from "../security/sensitive-content.js";
import {
  type AuthorizedCommandContext,
  requireAgentLane,
  requireAgentProject,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import {
  type FreeFormJsonExcess,
  freeFormJsonExcess,
  freeFormJsonRefusal,
} from "../shared/bounded-json.js";
import type { CommandDefinition, DomainEvent } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject, JsonValue } from "../shared/idempotency.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";
import { fitsUtf8ByteLimit } from "../shared/validation.js";
import { isoDatetime, trimmedUrl, utf16Max } from "../shared/zod-compat.js";
import type {
  CollaborationRepository,
  QuestionAudience,
  QuestionRecord,
  QuestionResumeResult,
} from "./collaboration-types.js";

const eventBase = z.object({
  requestId: z.uuid(),
  version: z.number().int().positive(),
});

export function registerCollaborationEventSchemas(
  registry: EventSchemaRegistry,
) {
  return registry
    .register(
      "message.posted.v1",
      eventBase.extend({
        messageId: z.uuid(),
        visibility: z.enum(["organization", "restricted"]),
      }),
    )
    .register(
      "question.asked.v1",
      eventBase.extend({
        questionId: z.uuid(),
        blocksRequest: z.boolean(),
        answerMode: z.enum(["single", "multiple"]),
        audienceType: z.string(),
        requestState: z.string(),
      }),
    )
    .register(
      "question.answered.v1",
      eventBase.extend({
        questionId: z.uuid(),
        answerId: z.uuid(),
        sourceChannel: z.enum(["web", "mcp", "slack", "email", "import"]),
        resumed: z.boolean(),
        resumeReason: z.string().nullable(),
        requestState: z.string(),
      }),
    )
    .register(
      "question.closed.v1",
      eventBase.extend({ questionId: z.uuid(), reason: z.string() }),
    )
    .register(
      "request.relationship_added.v1",
      eventBase.extend({
        relationshipId: z.uuid(),
        relationshipType: z.string(),
        toRequestId: z.uuid(),
      }),
    )
    .register(
      "request.relationship_removed.v1",
      eventBase.extend({
        relationshipId: z.uuid(),
        relationshipType: z.string(),
        toRequestId: z.uuid(),
      }),
    )
    .register(
      "artifact.attached.v1",
      eventBase.extend({
        artifactId: z.uuid(),
        kind: z.string(),
        externalUrl: trimmedUrl(),
      }),
    );
}

const messageInput = z.object({
  organizationId: z.uuid(),
  requestId: z.uuid(),
  bodyMd: z
    .string()
    .trim()
    .min(1)
    .check(utf16Max(100_000))
    .refine(
      (value) => fitsUtf8ByteLimit(value, 262_144),
      "Markdown content exceeds 256 KiB",
    )
    .refine(
      (value) => !containsSensitiveContent(value),
      "Message contains private or secret material",
    ),
  visibility: z.enum(["organization", "restricted"]).default("organization"),
  replyToId: z.uuid().nullable().optional(),
  mentionUserIds: z
    .array(z.string().min(1).check(utf16Max(255)))
    .max(100)
    .default([]),
});

const audienceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user"),
    id: z.string().min(1).check(utf16Max(255)),
  }),
  z.object({ type: z.literal("agent"), id: z.uuid() }),
  z.object({
    type: z.literal("role"),
    id: z.enum(["owner", "admin", "member"]),
  }),
  z.object({ type: z.literal("requester") }),
  z.object({ type: z.literal("project_maintainers") }),
]);

const escalationPolicySchema = z
  .object({
    reminderOffsetsMinutes: z
      .array(z.number().int().min(0).max(10_080))
      .max(10)
      .default([1_440, 0]),
    escalateAfterMinutes: z
      .number()
      .int()
      .min(0)
      .max(43_200)
      .nullable()
      .default(60),
    escalationAudience: z
      .enum(["project_maintainers", "organization_admins"])
      .nullable()
      .default("project_maintainers"),
  })
  .strict();

const questionInput = z
  .object({
    organizationId: z.uuid(),
    requestId: z.uuid(),
    audience: audienceSchema,
    bodyMd: z
      .string()
      .trim()
      .min(1)
      .check(utf16Max(100_000))
      .refine(
        (value) => fitsUtf8ByteLimit(value, 262_144),
        "Markdown content exceeds 256 KiB",
      )
      .refine(
        (value) => !containsSensitiveContent(value),
        "Question contains private or secret material",
      ),
    choices: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .check(utf16Max(160))
          .refine(
            (value) => !containsSensitiveContent(value),
            "Question choice contains private or secret material",
          ),
      )
      .max(8)
      .default([]),
    allowFreeText: z.boolean().default(true),
    answerMode: z.enum(["single", "multiple"]).default("single"),
    blocksRequest: z.boolean().default(false),
    deadlineAt: isoDatetime().nullable().optional(),
    escalationPolicy: escalationPolicySchema.nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.blocksRequest && value.answerMode !== "single") {
      context.addIssue({
        code: "custom",
        message: "Blocking questions must accept one answer",
        path: ["answerMode"],
      });
    }
    if (!value.allowFreeText && value.choices.length === 0) {
      context.addIssue({
        code: "custom",
        message:
          "At least one structured choice is required when free text is disabled",
        path: ["choices"],
      });
    }
    if (
      new Set(value.choices.map((choice) => choice.toLocaleLowerCase("en-US")))
        .size !== value.choices.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Question choices must be unique",
        path: ["choices"],
      });
    }
  });

/**
 * What `structuredValue` may hold (ruling 237 item 3): 2,000 elements,
 * counted as `freeFormJsonExcess` counts them; nesting at most 8 deep; and at
 * most 65,536 bytes of compact JSON.
 */
const structuredValueBounds = { elements: 2_000, depth: 8, bytes: 65_536 };

const structuredValueRefusals: Record<FreeFormJsonExcess, string> = {
  elements: "A structured answer may hold at most 2,000 elements",
  depth: "A structured answer may nest at most 8 levels deep",
  bytes: "A structured answer may take at most 65,536 bytes as compact JSON",
};

/**
 * What `provenance`'s free-form field values may hold (ruling 237 item 3):
 * 2,000 elements across its values together, counted as `freeFormJsonExcess`
 * counts them; each value nested at most 8 deep from its own root; and the
 * whole object at most 65,536 bytes of compact JSON. Its keys are bounded
 * apart: at most 64.
 */
const provenanceBounds = { elements: 2_000, depth: 8, bytes: 65_536 };

const provenanceRefusals: Record<FreeFormJsonExcess, string> = {
  elements:
    "Artifact provenance field values may hold at most 2,000 elements in all",
  depth: "An artifact provenance field value may nest at most 8 levels deep",
  bytes: "Artifact provenance may take at most 65,536 bytes as compact JSON",
};

const answerInput = z.object({
  organizationId: z.uuid(),
  questionId: z.uuid(),
  bodyMd: z
    .string()
    .trim()
    .min(1)
    .check(utf16Max(100_000))
    .refine(
      (value) => fitsUtf8ByteLimit(value, 262_144),
      "Markdown content exceeds 256 KiB",
    )
    .refine(
      (value) => !containsSensitiveContent(value),
      "Answer contains private or secret material",
    ),
  // One check, not two: given a second, zod's `toJSONSchema` writes this
  // recursive schema inline beside its `$ref`, which would change the
  // published OpenAPI document for no change in what it accepts.
  structuredValue: z
    .json()
    .superRefine((value, context) => {
      const excess = freeFormJsonExcess([value], value, structuredValueBounds);
      if (excess) {
        context.addIssue({
          code: "custom",
          message: structuredValueRefusals[excess],
          params: freeFormJsonRefusal(excess, structuredValueBounds),
        });
      }
      if (containsSensitiveJson(value)) {
        context.addIssue({
          code: "custom",
          message: "Structured answer contains private or secret material",
        });
      }
    })
    .nullable()
    .optional(),
  sourceChannel: z.enum(["web", "mcp", "slack", "email", "import"]),
});

const closeQuestionInput = z.object({
  organizationId: z.uuid(),
  questionId: z.uuid(),
  reason: z
    .string()
    .trim()
    .min(1)
    .check(utf16Max(20_000))
    .refine(
      (value) => !containsSensitiveContent(value),
      "Reason contains private or secret material",
    ),
});

const relationshipInput = z.object({
  organizationId: z.uuid(),
  fromRequestId: z.uuid(),
  toRequestId: z.uuid(),
  type: z.enum([
    "blocks",
    "depends_on",
    "duplicates",
    "supersedes",
    "related_to",
    "derived_from",
  ]),
});

const unlinkInput = z.object({
  organizationId: z.uuid(),
  requestId: z.uuid(),
  relationshipId: z.uuid(),
});

const artifactInput = z.object({
  organizationId: z.uuid(),
  requestId: z.uuid(),
  kind: z.string().trim().min(1).check(utf16Max(64)),
  externalUrl: z.string().trim().min(1).check(utf16Max(4_096)),
  mediaType: z
    .string()
    .trim()
    .min(1)
    .check(utf16Max(255))
    .nullable()
    .optional(),
  byteSize: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable()
    .optional(),
  provenance: z
    .record(z.string().trim().min(1).check(utf16Max(128)), z.json())
    .superRefine((value, context) => {
      if (Object.keys(value).length > 64) {
        context.addIssue({
          code: "custom",
          message: "Artifact provenance may contain at most 64 fields",
        });
      }
      if (containsSensitiveJson(value)) {
        context.addIssue({
          code: "custom",
          message: "Artifact provenance contains private or secret material",
        });
      }
    })
    .superRefine((value, context) => {
      const excess = freeFormJsonExcess(
        Object.values(value),
        value,
        provenanceBounds,
      );
      if (excess) {
        context.addIssue({
          code: "custom",
          message: provenanceRefusals[excess],
          params: freeFormJsonRefusal(excess, provenanceBounds),
        });
      }
    })
    .default({}),
});

/**
 * The input schema each command in this module parses with, by command name.
 * These are the same objects the definitions below call `parse` on, so a
 * transport describing a command's input reads it from here rather than
 * keeping a copy.
 */
export const collaborationCommandInputSchemas = {
  post_message: messageInput,
  ask_question: questionInput,
  answer_question: answerInput,
  close_question: closeQuestionInput,
  link_requests: relationshipInput,
  unlink_requests: unlinkInput,
  attach_artifact: artifactInput,
} as const;

function requestOutput(
  requestId: string,
  version: number,
  extra: JsonObject,
): JsonObject {
  return { requestId, version, ...extra };
}

function isMaintainer(
  access: Awaited<ReturnType<RequestRepository["actorAccess"]>>,
) {
  return (
    access.projectRole === "maintainer" ||
    access.organizationRole === "owner" ||
    access.organizationRole === "admin"
  );
}

function canParticipate(
  access: Awaited<ReturnType<RequestRepository["actorAccess"]>>,
) {
  return (
    access.isReporter ||
    access.isActiveWorker ||
    access.hasExclusiveClaim ||
    access.projectRole === "contributor" ||
    access.explicitTriageGrant ||
    isMaintainer(access)
  );
}

function requireParticipation(
  access: Awaited<ReturnType<RequestRepository["actorAccess"]>>,
) {
  if (!canParticipate(access)) {
    throw new DomainError(
      "forbidden",
      "Request participation access is denied",
    );
  }
}

function audienceAllows(
  question: QuestionRecord,
  context: AuthorizedCommandContext,
  access: Awaited<ReturnType<RequestRepository["actorAccess"]>>,
  request: { targetProjectId: string },
) {
  const actor = context.actor;
  const audience = question.audience;
  if (audience.type === "user") {
    return (
      (actor.type === "user" && actor.id === audience.id) ||
      (actor.type === "agent" && actor.delegatedBy?.id === audience.id)
    );
  }
  if (audience.type === "agent")
    return actor.type === "agent" && actor.id === audience.id;
  if (audience.type === "role") {
    return (
      (actor.type === "user" ||
        (actor.type === "agent" && Boolean(actor.delegatedBy))) &&
      access.organizationRole === audience.id
    );
  }
  if (audience.type === "requester") return access.isReporter;
  if (isMaintainer(access)) return true;
  return (
    actor.type === "agent" &&
    context.projectId === request.targetProjectId &&
    context.scopes.has("request:triage")
  );
}

function normalizeExternalUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError("validation_failed", "Artifact URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    raw.includes("?") ||
    raw.includes("#")
  ) {
    throw new DomainError(
      "validation_failed",
      "Artifact URL must be credential-free HTTPS",
    );
  }
  const schemeSeparator = raw.indexOf("://");
  const rawAuthority =
    schemeSeparator >= 0
      ? raw.slice(schemeSeparator + 3).split(/[/?#]/u, 1)[0]
      : undefined;
  if (!rawAuthority || rawAuthority.includes("@")) {
    throw new DomainError(
      "validation_failed",
      "Artifact URL must be credential-free HTTPS",
    );
  }
  const hostname = url.hostname.toLowerCase();
  const address = hostname.replace(/^\[|\]$/gu, "");
  const ipVersion = isIP(address);
  const octets =
    ipVersion === 4 ? address.split(".").map((part) => Number(part)) : [];
  const [first = -1, second = -1] = octets;
  const privateIpv4 =
    ipVersion === 4 &&
    (first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && [0, 2, 168].includes(second)) ||
      (first === 198 && [18, 19, 51].includes(second)) ||
      (first === 203 && second === 0) ||
      first >= 224);
  const privateIpv6 =
    ipVersion === 6 &&
    (address === "::" ||
      address === "::1" ||
      /^(?:f[cd]|fe[89ab])/iu.test(address) ||
      /^::ffff:(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/iu.test(
        address,
      ));
  const internalHostname = [
    "localhost",
    "local",
    "internal",
    "intranet",
    "lan",
    "home",
  ].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  if (internalHostname || privateIpv4 || privateIpv6) {
    throw new DomainError(
      "validation_failed",
      "Artifact URL host is not allowed",
    );
  }
  url.hostname = hostname;
  return url.toString();
}

async function loadRequest(
  uow: UnitOfWork,
  context: AuthorizedCommandContext,
  organizationId: string,
  requestId: string,
) {
  requireOrganization(context, organizationId);
  const requests = uow.port<RequestRepository>("requests");
  const request = await requests.findForUpdate(organizationId, requestId);
  if (!request) throw new DomainError("not_found", "Request was not found");
  requireAgentProject(
    context,
    request.source.kind === "project" ? request.source.projectId : null,
    request.targetProjectId,
  );
  if (
    context.actor.type === "agent" &&
    context.projectId === request.targetProjectId
  ) {
    requireAgentLane(context, request.laneId);
  }
  return {
    requests,
    request,
    access: await requests.actorAccess(request, context),
  };
}

export function createCollaborationCommandDefinitions(dependencies: {
  events: EventFactory;
  createId?: () => string;
}): Array<CommandDefinition<unknown, JsonObject>> {
  const createId = dependencies.createId ?? uuidv7;
  const postMessage: CommandDefinition<unknown, JsonObject> = {
    name: "post_message",
    parse: (input) => messageInput.parse(input),
    async authorize(context) {
      requireScope(context, "request:write");
    },
    async execute(uow, context, rawInput, meta) {
      if (meta.expectedVersion !== 0)
        throw new DomainError(
          "version_conflict",
          "Message creation expected version must be zero",
        );
      const input = messageInput.parse(rawInput);
      const { request, access } = await loadRequest(
        uow,
        context,
        input.organizationId,
        input.requestId,
      );
      requireParticipation(access);
      const collaboration = uow.port<CollaborationRepository>("collaboration");
      const messageId = createId();
      await collaboration.createMessage({
        id: messageId,
        request,
        actor: context.actor,
        bodyMd: input.bodyMd,
        visibility: input.visibility,
        replyToId: input.replyToId ?? null,
        mentionUserIds: [...new Set(input.mentionUserIds)],
      });
      const event = dependencies.events.create(context, {
        type: "message.posted.v1",
        schemaVersion: 1,
        aggregateType: "message",
        aggregateId: messageId,
        aggregateVersion: 1,
        projectId: request.targetProjectId,
        requestId: request.id,
        causationId: context.correlationId,
        data: {
          requestId: request.id,
          version: 1,
          messageId,
          visibility: input.visibility,
        },
      });
      return {
        result: requestOutput(request.id, request.version, { messageId }),
        aggregateId: messageId,
        events: [event],
      };
    },
  };

  const askQuestion: CommandDefinition<unknown, JsonObject> = {
    name: "ask_question",
    parse: (input) => questionInput.parse(input),
    async authorize(context) {
      requireScope(context, "request:write");
    },
    async execute(uow, context, rawInput, meta) {
      const input = questionInput.parse(rawInput);
      const { requests, request, access } = await loadRequest(
        uow,
        context,
        input.organizationId,
        input.requestId,
      );
      requireParticipation(access);
      if (input.blocksRequest) {
        if (request.version !== meta.expectedVersion)
          throw new DomainError(
            "version_conflict",
            "Request version is stale",
            { currentVersion: request.version },
          );
        if (
          !isMaintainer(access) &&
          !access.isActiveWorker &&
          !access.explicitTriageGrant
        ) {
          throw new DomainError(
            "forbidden",
            "Only an active target worker may block a request with a question",
          );
        }
        if (
          ![
            "triage",
            "accepted",
            "planned",
            "in_progress",
            "completed",
          ].includes(request.state)
        ) {
          throw new DomainError(
            "invalid_transition",
            "Request cannot wait for an answer from its current state",
          );
        }
      } else if (meta.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "Non-blocking question creation expected version must be zero",
        );
      }
      const collaboration = uow.port<CollaborationRepository>("collaboration");
      const questionId = createId();
      const question = await collaboration.createQuestion({
        id: questionId,
        request,
        actor: context.actor,
        audience: input.audience as QuestionAudience,
        bodyMd: input.bodyMd,
        answerMode: input.answerMode,
        blocksRequest: input.blocksRequest,
        choices: input.choices,
        allowFreeText: input.allowFreeText,
        resumeState: input.blocksRequest
          ? (request.state as QuestionRecord["resumeState"])
          : null,
        deadlineAt: input.deadlineAt ? new Date(input.deadlineAt) : null,
        escalationPolicy:
          (input.escalationPolicy as
            | Record<string, JsonValue>
            | null
            | undefined) ?? null,
      });
      let updatedRequest = request;
      if (input.blocksRequest) {
        const toState =
          input.audience.type === "requester"
            ? "waiting_requester"
            : "waiting_human";
        updatedRequest = await requests.transition({
          requestId: request.id,
          organizationId: request.organizationId,
          expectedVersion: request.version,
          fromState: request.state,
          toState,
          resumeState: request.state as QuestionRecord["resumeState"],
          reason: `Blocking question ${questionId}`,
        });
      }
      const event = dependencies.events.create(context, {
        type: "question.asked.v1",
        schemaVersion: 1,
        aggregateType: "question",
        aggregateId: question.id,
        aggregateVersion: question.version,
        projectId: request.targetProjectId,
        requestId: request.id,
        causationId: context.correlationId,
        data: {
          requestId: request.id,
          version: question.version,
          questionId: question.id,
          blocksRequest: question.blocksRequest,
          answerMode: question.answerMode,
          audienceType: question.audience.type,
          requestState: updatedRequest.state,
        },
      });
      const requestEvent = input.blocksRequest
        ? dependencies.events.create(context, {
            type: "request.state_changed.v1",
            schemaVersion: 1,
            aggregateType: "request",
            aggregateId: request.id,
            aggregateVersion: updatedRequest.version,
            projectId: request.targetProjectId,
            requestId: request.id,
            causationId: context.correlationId,
            data: {
              requestId: request.id,
              displayKey: updatedRequest.displayKey,
              state: updatedRequest.state,
              version: updatedRequest.version,
              action: "ask_question",
              fromState: request.state,
              toState: updatedRequest.state,
              reason: `Blocking question ${question.id}`,
            },
            links: updatedRequest.displayKey
              ? { request: updatedRequest.displayKey }
              : {},
          })
        : null;
      return {
        result: requestOutput(request.id, updatedRequest.version, {
          questionId: question.id,
          requestState: updatedRequest.state,
        }),
        aggregateId: question.id,
        events: requestEvent ? [event, requestEvent] : [event],
        afterEventsPersisted: input.blocksRequest
          ? async (_inner: UnitOfWork, events: readonly DomainEvent[]) => {
              const persisted = events[1];
              if (!persisted) throw new Error("Request state event is missing");
              await requests.insertStateTransition({
                id: createId(),
                request: updatedRequest,
                fromState: request.state,
                action: "ask_question",
                reason: `Blocking question ${question.id}`,
                actor: context.actor,
                eventId: persisted.id,
              });
            }
          : undefined,
      };
    },
  };

  const answerQuestion: CommandDefinition<unknown, JsonObject> = {
    name: "answer_question",
    parse: (input) => answerInput.parse(input),
    async authorize(context) {
      requireScope(context, "question:answer");
    },
    async execute(uow, context, rawInput, meta) {
      const input = answerInput.parse(rawInput);
      requireOrganization(context, input.organizationId);
      const collaboration = uow.port<CollaborationRepository>("collaboration");
      const question = await collaboration.findQuestionForUpdate(
        input.organizationId,
        input.questionId,
      );
      if (!question)
        throw new DomainError("not_found", "Question was not found");
      const { requests, request, access } = await loadRequest(
        uow,
        context,
        input.organizationId,
        question.requestId,
      );
      if (!audienceAllows(question, context, access, request))
        throw new DomainError(
          "forbidden",
          "Question is addressed to another actor",
        );
      const canonical = await collaboration.findCanonicalAnswer(question.id);
      if (question.answerMode === "single" && canonical) {
        return {
          result: requestOutput(request.id, request.version, {
            questionId: question.id,
            accepted: false,
            canonicalAnswer: {
              id: canonical.id,
              bodyMd: canonical.bodyMd,
              sourceChannel: canonical.sourceChannel,
            },
          }),
          aggregateId: question.id,
          events: [],
        };
      }
      if (question.state !== "open")
        throw new DomainError("conflict", "Question is closed");
      if (question.version !== meta.expectedVersion)
        throw new DomainError("version_conflict", "Question version is stale", {
          currentVersion: question.version,
        });
      if (!question.allowFreeText && !question.choices.includes(input.bodyMd)) {
        throw new DomainError(
          "validation_failed",
          "Answer must use one of the allowed choices",
        );
      }
      const answer = await collaboration.createAnswer({
        id: createId(),
        question,
        actor: context.actor,
        sourceChannel: input.sourceChannel,
        bodyMd: input.bodyMd,
        structuredValue:
          (input.structuredValue as JsonValue | undefined) ?? null,
        accepted: question.answerMode === "single",
      });
      const updatedQuestion = await collaboration.updateQuestion({
        questionId: question.id,
        organizationId: question.organizationId,
        expectedVersion: question.version,
        state: question.answerMode === "single" ? "answered" : "open",
        closedBy: question.answerMode === "single" ? context.actor : null,
        closedReason: question.answerMode === "single" ? "answered" : null,
      });
      let resume: QuestionResumeResult = {
        resumed: false,
        reason: "not_blocking",
      };
      let updatedRequest = request;
      if (question.blocksRequest) {
        const blockers = await collaboration.countOtherOpenBlockingQuestions(
          request.id,
          question.id,
        );
        if (blockers > 0)
          resume = { resumed: false, reason: "other_blockers_open" };
        else if (!question.resumeState)
          resume = { resumed: false, reason: "resume_state_invalid" };
        else if (
          !(["waiting_human", "waiting_requester"] as const).includes(
            request.state as "waiting_human" | "waiting_requester",
          ) ||
          request.resumeState !== question.resumeState
        ) {
          resume = { resumed: false, reason: "request_state_changed" };
        } else {
          updatedRequest = await requests.transition({
            requestId: request.id,
            organizationId: request.organizationId,
            expectedVersion: request.version,
            fromState: request.state,
            toState: question.resumeState,
            resumeState: null,
            reason: `Answered question ${question.id}`,
          });
          resume = { resumed: true, state: updatedRequest.state };
        }
      }
      const event = dependencies.events.create(context, {
        type: "question.answered.v1",
        schemaVersion: 1,
        aggregateType: "question",
        aggregateId: question.id,
        aggregateVersion: updatedQuestion.version,
        projectId: request.targetProjectId,
        requestId: request.id,
        causationId: context.correlationId,
        data: {
          requestId: request.id,
          version: updatedQuestion.version,
          questionId: question.id,
          answerId: answer.id,
          sourceChannel: answer.sourceChannel,
          resumed: resume.resumed,
          resumeReason: resume.resumed ? null : resume.reason,
          requestState: updatedRequest.state,
        },
      });
      const requestEvent = resume.resumed
        ? dependencies.events.create(context, {
            type: "request.state_changed.v1",
            schemaVersion: 1,
            aggregateType: "request",
            aggregateId: request.id,
            aggregateVersion: updatedRequest.version,
            projectId: request.targetProjectId,
            requestId: request.id,
            causationId: context.correlationId,
            data: {
              requestId: request.id,
              displayKey: updatedRequest.displayKey,
              state: updatedRequest.state,
              version: updatedRequest.version,
              action: "answer_question",
              fromState: request.state,
              toState: updatedRequest.state,
              reason: `Answered question ${question.id}`,
            },
            links: updatedRequest.displayKey
              ? { request: updatedRequest.displayKey }
              : {},
          })
        : null;
      return {
        result: requestOutput(request.id, updatedRequest.version, {
          questionId: question.id,
          answerId: answer.id,
          accepted: true,
          resumed: resume.resumed,
          requestState: updatedRequest.state,
        }),
        aggregateId: question.id,
        events: requestEvent ? [event, requestEvent] : [event],
        afterEventsPersisted: resume.resumed
          ? async (_inner: UnitOfWork, events: readonly DomainEvent[]) => {
              const persisted = events[1];
              if (!persisted) throw new Error("Request state event is missing");
              await requests.insertStateTransition({
                id: createId(),
                request: updatedRequest,
                fromState: request.state,
                action: "answer_question",
                reason: `Answered question ${question.id}`,
                actor: context.actor,
                eventId: persisted.id,
              });
            }
          : undefined,
      };
    },
  };

  const closeQuestion: CommandDefinition<unknown, JsonObject> = {
    name: "close_question",
    parse: (input) => closeQuestionInput.parse(input),
    async authorize(context) {
      requireScope(context, "request:write");
    },
    async execute(uow, context, rawInput, meta) {
      const input = closeQuestionInput.parse(rawInput);
      requireOrganization(context, input.organizationId);
      const collaboration = uow.port<CollaborationRepository>("collaboration");
      const question = await collaboration.findQuestionForUpdate(
        input.organizationId,
        input.questionId,
      );
      if (!question)
        throw new DomainError("not_found", "Question was not found");
      const { request, access } = await loadRequest(
        uow,
        context,
        input.organizationId,
        question.requestId,
      );
      if (question.answerMode !== "multiple")
        throw new DomainError(
          "conflict",
          "Single-answer questions close through an accepted answer",
        );
      if (question.state !== "open")
        throw new DomainError("conflict", "Question is closed");
      if (question.version !== meta.expectedVersion)
        throw new DomainError("version_conflict", "Question version is stale", {
          currentVersion: question.version,
        });
      if (
        !(
          question.askedBy.type === context.actor.type &&
          question.askedBy.id === context.actor.id
        ) &&
        !isMaintainer(access)
      ) {
        throw new DomainError(
          "forbidden",
          "Only the asker or target maintainer may close this question",
        );
      }
      const closed = await collaboration.updateQuestion({
        questionId: question.id,
        organizationId: question.organizationId,
        expectedVersion: question.version,
        state: "closed",
        closedBy: context.actor,
        closedReason: input.reason,
      });
      const event = dependencies.events.create(context, {
        type: "question.closed.v1",
        schemaVersion: 1,
        aggregateType: "question",
        aggregateId: question.id,
        aggregateVersion: closed.version,
        projectId: request.targetProjectId,
        requestId: request.id,
        causationId: context.correlationId,
        data: {
          requestId: request.id,
          version: closed.version,
          questionId: question.id,
          reason: input.reason,
        },
      });
      return {
        result: requestOutput(request.id, request.version, {
          questionId: question.id,
          state: "closed",
        }),
        aggregateId: question.id,
        events: [event],
      };
    },
  };

  const linkRequests: CommandDefinition<unknown, JsonObject> = {
    name: "link_requests",
    parse: (input) => relationshipInput.parse(input),
    async authorize(context) {
      requireScope(context, "request:write");
    },
    async execute(uow, context, rawInput, meta) {
      if (meta.expectedVersion !== 0)
        throw new DomainError(
          "version_conflict",
          "Relationship creation expected version must be zero",
        );
      const input = relationshipInput.parse(rawInput);
      if (input.fromRequestId === input.toRequestId)
        throw new DomainError(
          "validation_failed",
          "A request cannot relate to itself",
        );
      const { request, access } = await loadRequest(
        uow,
        context,
        input.organizationId,
        input.fromRequestId,
      );
      requireParticipation(access);
      const requests = uow.port<RequestRepository>("requests");
      if (
        !(await requests.canReference(
          input.organizationId,
          input.toRequestId,
          context,
        ))
      ) {
        throw new DomainError("not_found", "Related request was not found");
      }
      const collaboration = uow.port<CollaborationRepository>("collaboration");
      const relationshipId = createId();
      await collaboration.createRelationship({
        id: relationshipId,
        ...input,
        actor: context.actor,
      });
      const event = dependencies.events.create(context, {
        type: "request.relationship_added.v1",
        schemaVersion: 1,
        aggregateType: "request_relationship",
        aggregateId: relationshipId,
        aggregateVersion: 1,
        projectId: request.targetProjectId,
        requestId: request.id,
        causationId: context.correlationId,
        data: {
          requestId: request.id,
          version: 1,
          relationshipId,
          relationshipType: input.type,
          toRequestId: input.toRequestId,
        },
      });
      return {
        result: requestOutput(request.id, request.version, { relationshipId }),
        aggregateId: relationshipId,
        events: [event],
      };
    },
  };

  const unlinkRequests: CommandDefinition<unknown, JsonObject> = {
    name: "unlink_requests",
    parse: (input) => unlinkInput.parse(input),
    async authorize(context) {
      requireScope(context, "request:write");
    },
    async execute(uow, context, rawInput, meta) {
      if (meta.expectedVersion !== 0)
        throw new DomainError(
          "version_conflict",
          "Relationship removal expected version must be zero",
        );
      const input = unlinkInput.parse(rawInput);
      const { request, access } = await loadRequest(
        uow,
        context,
        input.organizationId,
        input.requestId,
      );
      requireParticipation(access);
      const collaboration = uow.port<CollaborationRepository>("collaboration");
      const removed = await collaboration.removeRelationship({
        organizationId: input.organizationId,
        relationshipId: input.relationshipId,
      });
      if (!removed || removed.fromRequestId !== input.requestId)
        throw new DomainError("not_found", "Relationship was not found");
      const event = dependencies.events.create(context, {
        type: "request.relationship_removed.v1",
        schemaVersion: 1,
        aggregateType: "request_relationship",
        aggregateId: removed.id,
        aggregateVersion: 2,
        projectId: request.targetProjectId,
        requestId: request.id,
        causationId: context.correlationId,
        data: {
          requestId: request.id,
          version: 2,
          relationshipId: removed.id,
          relationshipType: removed.type,
          toRequestId: removed.toRequestId,
        },
      });
      return {
        result: requestOutput(request.id, request.version, {
          relationshipId: removed.id,
          removed: true,
        }),
        aggregateId: removed.id,
        events: [event],
      };
    },
  };

  const attachArtifact: CommandDefinition<unknown, JsonObject> = {
    name: "attach_artifact",
    parse: (input) => artifactInput.parse(input),
    async authorize(context) {
      requireScope(context, "request:write");
    },
    async execute(uow, context, rawInput, meta) {
      if (meta.expectedVersion !== 0)
        throw new DomainError(
          "version_conflict",
          "Artifact creation expected version must be zero",
        );
      const input = artifactInput.parse(rawInput);
      const { request, access } = await loadRequest(
        uow,
        context,
        input.organizationId,
        input.requestId,
      );
      requireParticipation(access);
      const externalUrl = normalizeExternalUrl(input.externalUrl);
      const collaboration = uow.port<CollaborationRepository>("collaboration");
      const artifactId = createId();
      await collaboration.createArtifact({
        id: artifactId,
        request,
        actor: context.actor,
        kind: input.kind,
        externalUrl,
        mediaType: input.mediaType ?? null,
        byteSize: input.byteSize ?? null,
        sha256: input.sha256 ?? null,
        provenance: input.provenance as Record<string, JsonValue>,
      });
      const event = dependencies.events.create(context, {
        type: "artifact.attached.v1",
        schemaVersion: 1,
        aggregateType: "artifact",
        aggregateId: artifactId,
        aggregateVersion: 1,
        projectId: request.targetProjectId,
        requestId: request.id,
        causationId: context.correlationId,
        data: {
          requestId: request.id,
          version: 1,
          artifactId,
          kind: input.kind,
          externalUrl,
        },
      });
      return {
        result: requestOutput(request.id, request.version, {
          artifactId,
          externalUrl,
        }),
        aggregateId: artifactId,
        events: [event],
      };
    },
  };

  return [
    postMessage,
    askQuestion,
    answerQuestion,
    closeQuestion,
    linkRequests,
    unlinkRequests,
    attachArtifact,
  ];
}
