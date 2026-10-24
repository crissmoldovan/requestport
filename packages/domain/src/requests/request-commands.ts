import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

import type {
  EventFactory,
  EventSchemaRegistry,
} from "../events/event-factory.js";
import { evaluateRoute } from "../routing/evaluate-route.js";
import type { RoutingRepository } from "../routing/routing-service.js";
import { requestPriorities, requestTypes } from "../routing/routing-types.js";
import { containsSensitiveContent } from "../security/sensitive-content.js";
import {
  type AuthorizedCommandContext,
  requireAgentLane,
  requireAgentProject,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import type { CommandDefinition, DomainEvent } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";
import { fitsUtf8ByteLimit } from "../shared/validation.js";
import { utf16Max } from "../shared/zod-compat.js";
import { nextRequestState } from "./request-state-machine.js";
import {
  type CompletionReportInput,
  type RequestAction,
  type RequestActorAccess,
  type RequestRecord,
  type RequestRepository,
  requestStates,
} from "./request-types.js";

const actorEventSchema = z.object({
  requestId: z.uuid(),
  displayKey: z.string().nullable(),
  state: z.enum(requestStates),
  version: z.number().int().positive(),
});

const createdEventSchema = actorEventSchema.extend({
  title: z.string(),
  requestType: z.enum(requestTypes),
  priority: z.enum(requestPriorities),
  sourceKind: z.enum(["project", "human_direct"]),
  targetProjectId: z.uuid(),
});

const submittedEventSchema = actorEventSchema.extend({
  routingReason: z.enum(["default_same_org", "matched_allow"]),
  routingRuleId: z.uuid().nullable(),
  routingPolicyVersion: z.number().int().nonnegative(),
});

const transitionEventSchema = actorEventSchema.extend({
  action: z.string(),
  fromState: z.enum(requestStates),
  toState: z.enum(requestStates),
  reason: z.string().nullable(),
});

const completionEventSchema = actorEventSchema.extend({
  reportId: z.uuid(),
  outcomeMd: z.string(),
});

const verificationEventSchema = actorEventSchema.extend({
  reason: z.string(),
  evidence: z.string(),
});

const updatedEventSchema = actorEventSchema.extend({
  changedFields: z.array(
    z.enum(["title", "descriptionMd", "priority", "visibility", "sensitivity"]),
  ),
});

export function registerRequestEventSchemas(registry: EventSchemaRegistry) {
  return registry
    .register("request.created.v1", createdEventSchema)
    .register("request.submitted.v1", submittedEventSchema)
    .register("request.updated.v1", updatedEventSchema)
    .register("request.state_changed.v1", transitionEventSchema)
    .register("request.completion_reported.v1", completionEventSchema)
    .register("request.verified.v1", verificationEventSchema);
}

const createDraftInput = z
  .object({
    organizationId: z.uuid(),
    sourceKind: z.enum(["project", "human_direct"]),
    sourceProjectId: z.uuid().optional(),
    targetProjectId: z.uuid(),
    laneId: z.uuid().nullable().optional(),
    type: z.enum(requestTypes),
    title: z
      .string()
      .trim()
      .min(1)
      .check(utf16Max(240))
      .refine(
        (value) => !containsSensitiveContent(value),
        "Title contains private or secret material",
      ),
    descriptionMd: z
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
        "Description contains private or secret material",
      ),
    priority: z.enum(requestPriorities).default("normal"),
    visibility: z.enum(["organization", "restricted"]).default("organization"),
    sensitivity: z.enum(["normal", "sensitive"]).default("normal"),
    labels: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .check(utf16Max(64))
          .refine(
            (value) => !containsSensitiveContent(value),
            "Label contains private or secret material",
          ),
      )
      .max(50)
      .default([]),
    acceptanceCriteria: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .check(utf16Max(1_000))
          .refine(
            (value) => !containsSensitiveContent(value),
            "Acceptance criterion contains private or secret material",
          ),
      )
      .max(100)
      .default([]),
  })
  .superRefine((value, context) => {
    if ((value.sourceKind === "project") !== Boolean(value.sourceProjectId)) {
      context.addIssue({
        code: "custom",
        message: "Source project is required only for project sources",
        path: ["sourceProjectId"],
      });
    }
    if (
      value.sensitivity === "sensitive" &&
      value.visibility !== "restricted"
    ) {
      context.addIssue({
        code: "custom",
        message: "Sensitive requests must use restricted visibility",
        path: ["visibility"],
      });
    }
  });

const completionReportSchema = z.object({
  outcomeMd: z
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
      "Outcome contains private or secret material",
    ),
  changedRepositories: z
    .array(
      z
        .object({
          repositoryId: z.uuid().optional(),
          repositoryUrl: z
            .string()
            .trim()
            .check(utf16Max(4_096))
            .refine((raw) => {
              try {
                const url = new URL(raw);
                const schemeSeparator = raw.indexOf("://");
                const rawAuthority =
                  schemeSeparator >= 0
                    ? raw.slice(schemeSeparator + 3).split(/[/?#]/u, 1)[0]
                    : undefined;
                return (
                  Boolean(rawAuthority) &&
                  !rawAuthority?.includes("@") &&
                  !raw.includes("?") &&
                  !raw.includes("#") &&
                  url.protocol === "https:" &&
                  !url.username &&
                  !url.password &&
                  !url.search &&
                  !url.hash
                );
              } catch {
                return false;
              }
            }, "Repository URL must be credential-free HTTPS without query or fragment")
            .optional(),
          commitSha: z
            .string()
            .regex(/^[0-9a-f]{7,64}$/u)
            .optional(),
          artifactId: z.uuid().optional(),
        })
        .refine(
          (value) =>
            Boolean(
              value.repositoryId ||
                value.repositoryUrl ||
                value.commitSha ||
                value.artifactId,
            ),
          "A changed repository reference is required",
        ),
    )
    .max(100),
  validations: z
    .array(
      z.object({
        command: z
          .string()
          .trim()
          .min(1)
          .check(utf16Max(2_000))
          .refine(
            (value) => !containsSensitiveContent(value),
            "Validation command contains private or secret material",
          ),
        result: z.enum(["passed", "failed", "not_run"]),
        summary: z
          .string()
          .trim()
          .check(utf16Max(4_000))
          .refine(
            (value) => !containsSensitiveContent(value),
            "Validation summary contains private or secret material",
          )
          .optional(),
      }),
    )
    .min(1)
    .max(200),
  risksMd: z
    .string()
    .trim()
    .check(utf16Max(50_000))
    .refine(
      (value) => !containsSensitiveContent(value),
      "Risk summary contains private or secret material",
    ),
  followupsMd: z
    .string()
    .trim()
    .check(utf16Max(50_000))
    .refine(
      (value) => !containsSensitiveContent(value),
      "Follow-up summary contains private or secret material",
    ),
  verificationStepsMd: z
    .string()
    .trim()
    .min(1)
    .check(utf16Max(50_000))
    .refine(
      (value) => !containsSensitiveContent(value),
      "Verification steps contain private or secret material",
    ),
});

const requestActions = [
  "submit_request",
  "begin_triage",
  "accept_request",
  "decline_request",
  "mark_duplicate",
  "supersede_request",
  "plan_request",
  "begin_request_work",
  "block_request",
  "resume_request",
  "withdraw_request",
  "cancel_request",
  "reopen_request",
  "complete_request",
  "verify_request",
] as const satisfies readonly RequestAction[];

const transitionInput = z
  .object({
    organizationId: z.uuid(),
    requestId: z.uuid(),
    action: z.enum(requestActions),
    reason: z
      .string()
      .trim()
      .min(1)
      .check(utf16Max(20_000))
      .refine(
        (value) => !containsSensitiveContent(value),
        "Reason contains private or secret material",
      )
      .optional(),
    relatedRequestId: z.uuid().optional(),
    report: completionReportSchema.optional(),
    verificationEvidence: z
      .string()
      .trim()
      .min(1)
      .check(utf16Max(50_000))
      .refine(
        (value) => !containsSensitiveContent(value),
        "Verification evidence contains private or secret material",
      )
      .optional(),
  })
  .superRefine((value, context) => {
    const reasonRequired = new Set<RequestAction>([
      "accept_request",
      "decline_request",
      "mark_duplicate",
      "supersede_request",
      "block_request",
      "resume_request",
      "withdraw_request",
      "cancel_request",
      "reopen_request",
      "verify_request",
    ]);
    if (reasonRequired.has(value.action) && !value.reason) {
      context.addIssue({
        code: "custom",
        message: "A reason is required",
        path: ["reason"],
      });
    }
    if (
      (value.action === "mark_duplicate" ||
        value.action === "supersede_request") &&
      !value.relatedRequestId
    ) {
      context.addIssue({
        code: "custom",
        message: "A related request is required",
        path: ["relatedRequestId"],
      });
    }
    if (value.action === "complete_request" && !value.report) {
      context.addIssue({
        code: "custom",
        message: "A completion report is required",
        path: ["report"],
      });
    }
    if (value.action === "verify_request" && !value.verificationEvidence) {
      context.addIssue({
        code: "custom",
        message: "Verification evidence is required",
        path: ["verificationEvidence"],
      });
    }
  });

type TransitionInput = z.infer<typeof transitionInput>;

const updateRequestInput = z
  .object({
    organizationId: z.uuid(),
    requestId: z.uuid(),
    title: z
      .string()
      .trim()
      .min(1)
      .check(utf16Max(240))
      .refine(
        (value) => !containsSensitiveContent(value),
        "Title contains private or secret material",
      )
      .optional(),
    descriptionMd: z
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
        "Description contains private or secret material",
      )
      .optional(),
    priority: z.enum(requestPriorities).optional(),
    visibility: z.enum(["organization", "restricted"]).optional(),
    sensitivity: z.enum(["normal", "sensitive"]).optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.descriptionMd !== undefined ||
      input.priority !== undefined ||
      input.visibility !== undefined ||
      input.sensitivity !== undefined,
    "At least one request field is required",
  );

/**
 * The input schema each command in this module parses with, by command name.
 * These are the same objects the definitions below call `parse` on. The
 * fifteen lifecycle actions are one command, `transition_request`, whose
 * `action` field names the action.
 */
export const requestCommandInputSchemas = {
  create_request_draft: createDraftInput,
  transition_request: transitionInput,
  update_request: updateRequestInput,
} as const;

function requestResult(request: RequestRecord): JsonObject {
  return {
    id: request.id,
    displayKey: request.displayKey,
    state: request.state,
    version: request.version,
  };
}

/**
 * The request facts every request event carries, named the way the event
 * schemas name them.
 *
 * Deliberately not `requestResult`. That one is the *command's* answer to its
 * caller and calls the same value `id`; `actorEventSchema` calls it
 * `requestId`. Both payloads that were built by spreading `requestResult`
 * therefore failed their own schema, and since `request.created.v1` is emitted
 * by the only command that creates a request, creating one was impossible for
 * every caller — the refusal read "Event payload is invalid", which named
 * neither the field nor the event.
 *
 * Keeping the two shapes apart is the point: they are answers to different
 * readers and they disagreed about one key.
 */
function requestEventFacts(request: RequestRecord): JsonObject {
  return {
    requestId: request.id,
    displayKey: request.displayKey,
    state: request.state,
    version: request.version,
  };
}

function isMaintainer(access: RequestActorAccess) {
  return (
    access.projectRole === "maintainer" ||
    access.organizationRole === "owner" ||
    access.organizationRole === "admin"
  );
}

function authorizeAction(
  context: AuthorizedCommandContext,
  request: RequestRecord,
  access: RequestActorAccess,
  action: RequestAction,
) {
  const maintainer = isMaintainer(access);
  const targetAgent =
    context.actor.type === "agent" &&
    context.projectId === request.targetProjectId;
  switch (action) {
    case "submit_request":
      requireScope(context, "request:create");
      if (!access.isReporter)
        throw new DomainError(
          "forbidden",
          "Only the reporter may submit this request",
        );
      break;
    case "begin_triage":
    case "accept_request":
    case "decline_request":
    case "mark_duplicate":
    case "supersede_request":
      requireScope(context, "request:triage");
      if (!maintainer && !access.explicitTriageGrant && !targetAgent)
        throw new DomainError(
          "forbidden",
          "Target triage authority is required",
        );
      break;
    case "plan_request":
      requireScope(context, "request:triage");
      if (!maintainer && !targetAgent && access.projectRole !== "contributor") {
        throw new DomainError(
          "forbidden",
          "Target planning authority is required",
        );
      }
      break;
    case "begin_request_work":
      requireScope(context, "work:update");
      if (!maintainer && !access.hasExclusiveClaim)
        throw new DomainError(
          "forbidden",
          "An active exclusive claim is required",
        );
      break;
    case "block_request":
      requireScope(context, "work:update");
      if (
        !maintainer &&
        !access.isActiveWorker &&
        !access.explicitTriageGrant &&
        !(targetAgent && context.scopes.has("request:triage"))
      ) {
        throw new DomainError(
          "forbidden",
          "An active target worker is required",
        );
      }
      break;
    case "resume_request":
      requireScope(context, "work:update");
      if (!maintainer && !access.isActiveWorker) {
        throw new DomainError(
          "forbidden",
          "An active target worker is required",
        );
      }
      break;
    case "withdraw_request":
      requireScope(context, "request:create");
      if (!access.isReporter)
        throw new DomainError(
          "forbidden",
          "Only the reporter may withdraw this request",
        );
      break;
    case "cancel_request":
    case "reopen_request":
      requireScope(context, "request:triage");
      if (!maintainer)
        throw new DomainError("forbidden", "A target maintainer is required");
      break;
    case "complete_request":
      requireScope(context, "request:complete");
      if (!maintainer && !(context.actor.type === "agent" && targetAgent)) {
        throw new DomainError(
          "forbidden",
          "A target completion agent or maintainer is required",
        );
      }
      break;
    case "verify_request":
      requireScope(context, "request:verify");
      if (!maintainer)
        throw new DomainError("forbidden", "A target maintainer is required");
      break;
  }
  requireOrganization(context, request.organizationId);
}

function transitionEventType(action: RequestAction) {
  if (action === "submit_request") return "request.submitted.v1" as const;
  if (action === "complete_request")
    return "request.completion_reported.v1" as const;
  if (action === "verify_request") return "request.verified.v1" as const;
  return "request.state_changed.v1" as const;
}

function principalForRoute(
  context: AuthorizedCommandContext,
  access: RequestActorAccess,
) {
  return context.actor.type === "user"
    ? {
        type: "user" as const,
        id: context.actor.id,
        organizationRole: access.organizationRole ?? "member",
        scopes: context.scopes,
      }
    : {
        type: "agent" as const,
        id: context.actor.id,
        scopes: context.scopes,
      };
}

export function createRequestCommandDefinitions(dependencies: {
  events: EventFactory;
  createId?: () => string;
}): Array<CommandDefinition<unknown, JsonObject>> {
  const createId = dependencies.createId ?? uuidv7;
  const createDraft: CommandDefinition<unknown, JsonObject> = {
    name: "create_request_draft",
    parse: (input) => createDraftInput.parse(input),
    async authorize(context) {
      requireScope(context, "request:create");
    },
    async execute(uow, context, unknownInput, meta) {
      if (meta.expectedVersion !== 0)
        throw new DomainError(
          "version_conflict",
          "Creation expected version must be zero",
        );
      const input = createDraftInput.parse(unknownInput);
      requireOrganization(context, input.organizationId);
      const repository = uow.port<RequestRepository>("requests");
      const source =
        input.sourceKind === "project"
          ? {
              kind: "project" as const,
              projectId: input.sourceProjectId as string,
            }
          : { kind: "human_direct" as const };
      if (context.actor.type === "agent") {
        if (source.kind !== "project") {
          throw new DomainError(
            "forbidden",
            "Agents must create requests from their bound project",
          );
        }
        requireAgentProject(context, source.projectId);
      }
      if (
        !(await repository.validateDraftOwnership({
          context,
          organizationId: input.organizationId,
          source,
          targetProjectId: input.targetProjectId,
          laneId: input.laneId ?? null,
        }))
      ) {
        throw new DomainError(
          "forbidden",
          "Request source or target is outside the active organization",
        );
      }
      const request = await repository.createDraft({
        id: createId(),
        organizationId: input.organizationId,
        source,
        targetProjectId: input.targetProjectId,
        laneId: input.laneId ?? null,
        type: input.type,
        title: input.title,
        descriptionMd: input.descriptionMd,
        priority: input.priority,
        visibility: input.visibility,
        sensitivity: input.sensitivity,
        labels: [...new Set(input.labels.map((label) => label.toLowerCase()))],
        acceptanceCriteria: input.acceptanceCriteria,
        reporter: context.actor,
      });
      const event = dependencies.events.create(context, {
        type: "request.created.v1",
        schemaVersion: 1,
        aggregateType: "request",
        aggregateId: request.id,
        aggregateVersion: request.version,
        projectId: request.targetProjectId,
        requestId: request.id,
        causationId: context.correlationId,
        data: {
          ...requestEventFacts(request),
          title:
            request.sensitivity === "sensitive"
              ? "Sensitive request"
              : request.title,
          requestType: request.type,
          priority: request.priority,
          sourceKind: request.source.kind,
          targetProjectId: request.targetProjectId,
        },
      });
      return {
        result: requestResult(request),
        aggregateId: request.id,
        events: [event],
      };
    },
  };

  const transition: CommandDefinition<unknown, JsonObject> = {
    name: "transition_request",
    parse: (input) => transitionInput.parse(input),
    async authorize(context) {
      if (context.actor.type === "service") {
        throw new DomainError("forbidden", "A user or agent actor is required");
      }
    },
    async execute(uow: UnitOfWork, context, unknownInput, meta) {
      const input = transitionInput.parse(unknownInput) as TransitionInput;
      requireOrganization(context, input.organizationId);
      const repository = uow.port<RequestRepository>("requests");
      const request = await repository.findForUpdate(
        input.organizationId,
        input.requestId,
      );
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
      if (request.version !== meta.expectedVersion) {
        throw new DomainError("version_conflict", "Request version is stale", {
          currentVersion: request.version,
        });
      }
      const access = await repository.actorAccess(request, context);
      authorizeAction(context, request, access, input.action);
      if (
        input.action === "accept_request" &&
        !(await repository.hasAcceptanceCriteria(request.id))
      ) {
        throw new DomainError(
          "validation_failed",
          "Acceptance criteria are required before accepting a request",
        );
      }
      const next = nextRequestState({
        action: input.action,
        state: request.state,
        resumeState: request.resumeState,
      });
      let display: { sequenceNumber: number; displayKey: string } | undefined;
      let routingRuleId = request.routingRuleId;
      let routingPolicyVersion = request.routingPolicyVersion;
      let routingReason: "default_same_org" | "matched_allow" | null = null;
      if (input.action === "submit_request") {
        const routing = uow.port<RoutingRepository>("routing");
        const rules = await routing.listRules(request.organizationId);
        const decision = evaluateRoute(
          {
            sourceOrganizationId: request.organizationId,
            targetOrganizationId: request.organizationId,
            source: request.source,
            targetProjectId: request.targetProjectId,
            laneId: request.laneId ?? undefined,
            requestType: request.type,
            priority: request.priority,
            principal: principalForRoute(context, access),
          },
          rules,
        );
        if (!decision.allowed) {
          throw new DomainError("route_denied", "Request route is denied", {
            reason: decision.reason,
            matchedRuleId: decision.matchedRuleId,
            policyVersion: decision.policyVersion,
          });
        }
        display = await repository.allocateDisplayKey(request);
        routingRuleId = decision.matchedRuleId ?? null;
        routingPolicyVersion = decision.policyVersion;
        routingReason = decision.reason as "default_same_org" | "matched_allow";
      }
      let lifecycleRelationship: {
        id: string;
        type: "duplicates" | "supersedes";
        toRequestId: string;
      } | null = null;
      if (
        (input.action === "mark_duplicate" ||
          input.action === "supersede_request") &&
        input.relatedRequestId
      ) {
        if (input.relatedRequestId === request.id) {
          throw new DomainError(
            "validation_failed",
            "A request cannot relate to itself",
          );
        }
        if (
          !(await repository.canReference(
            request.organizationId,
            input.relatedRequestId,
            context,
          ))
        ) {
          throw new DomainError("not_found", "Related request was not found");
        }
        const relationship = await repository.addRelationship({
          organizationId: request.organizationId,
          fromRequestId: request.id,
          toRequestId: input.relatedRequestId,
          type: input.action === "mark_duplicate" ? "duplicates" : "supersedes",
          actor: context.actor,
        });
        lifecycleRelationship = {
          id: relationship.id,
          type: input.action === "mark_duplicate" ? "duplicates" : "supersedes",
          toRequestId: input.relatedRequestId,
        };
      }
      const updated = await repository.transition({
        requestId: request.id,
        organizationId: request.organizationId,
        expectedVersion: request.version,
        fromState: request.state,
        toState: next.state,
        resumeState: next.resumeState,
        reason: input.reason ?? null,
        display,
        routingRuleId,
        routingPolicyVersion,
      });
      let reportId: string | null = null;
      if (input.action === "complete_request") {
        const report = input.report as CompletionReportInput;
        if (!(await repository.validateCompletionReferences(request, report))) {
          throw new DomainError(
            "validation_failed",
            "Completion report references must belong to this organization and request",
          );
        }
        reportId = createId();
        await repository.createCompletionReport({
          id: reportId,
          request: updated,
          actor: context.actor,
          report,
        });
      }
      const data: JsonObject =
        input.action === "submit_request"
          ? {
              ...requestEventFacts(updated),
              routingReason: routingReason as
                | "default_same_org"
                | "matched_allow",
              routingRuleId,
              routingPolicyVersion: routingPolicyVersion ?? 0,
            }
          : input.action === "complete_request"
            ? {
                ...requestEventFacts(updated),
                reportId: reportId as string,
                outcomeMd: (input.report as CompletionReportInput).outcomeMd,
              }
            : input.action === "verify_request"
              ? {
                  ...requestEventFacts(updated),
                  reason: input.reason as string,
                  evidence: input.verificationEvidence as string,
                }
              : {
                  ...requestEventFacts(updated),
                  action: input.action,
                  fromState: request.state,
                  toState: updated.state,
                  reason: input.reason ?? null,
                };
      const event = dependencies.events.create(context, {
        type: transitionEventType(input.action),
        schemaVersion: 1,
        aggregateType: "request",
        aggregateId: request.id,
        aggregateVersion: updated.version,
        projectId: request.targetProjectId,
        requestId: request.id,
        causationId: context.correlationId,
        data,
        links: updated.displayKey ? { request: updated.displayKey } : {},
      });
      const relationshipEvent = lifecycleRelationship
        ? dependencies.events.create(context, {
            type: "request.relationship_added.v1",
            schemaVersion: 1,
            aggregateType: "request_relationship",
            aggregateId: lifecycleRelationship.id,
            aggregateVersion: 1,
            projectId: request.targetProjectId,
            requestId: request.id,
            causationId: context.correlationId,
            data: {
              requestId: request.id,
              version: 1,
              relationshipId: lifecycleRelationship.id,
              relationshipType: lifecycleRelationship.type,
              toRequestId: lifecycleRelationship.toRequestId,
            },
          })
        : null;
      return {
        result: requestResult(updated),
        aggregateId: request.id,
        events: relationshipEvent ? [event, relationshipEvent] : [event],
        async afterEventsPersisted(
          _uow: UnitOfWork,
          events: readonly DomainEvent[],
        ) {
          const persisted = events[0];
          if (!persisted)
            throw new Error("Request transition event is missing");
          await repository.insertStateTransition({
            id: createId(),
            request: updated,
            fromState: request.state,
            action: input.action,
            reason: input.reason ?? null,
            actor: context.actor,
            eventId: persisted.id,
          });
        },
      };
    },
  };

  const updateRequest: CommandDefinition<unknown, JsonObject> = {
    name: "update_request",
    parse: (input) => updateRequestInput.parse(input),
    async authorize(context, unknownInput) {
      const input = updateRequestInput.parse(unknownInput);
      requireScope(context, "request:write");
      requireOrganization(context, input.organizationId);
    },
    async execute(uow, context, unknownInput, meta) {
      const input = updateRequestInput.parse(unknownInput);
      const repository = uow.port<RequestRepository>("requests");
      const request = await repository.findForUpdate(
        input.organizationId,
        input.requestId,
      );
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
      const access = await repository.actorAccess(request, context);
      if (
        !access.isReporter &&
        !isMaintainer(access) &&
        !access.isActiveWorker
      ) {
        throw new DomainError("forbidden", "Request update access is denied");
      }
      if (meta.expectedVersion !== request.version) {
        throw new DomainError(
          "version_conflict",
          "Request changed concurrently",
        );
      }
      if (
        [
          "completed",
          "verified",
          "declined",
          "duplicate",
          "superseded",
          "cancelled",
        ].includes(request.state)
      ) {
        throw new DomainError(
          "invalid_transition",
          "Terminal request cannot be edited",
        );
      }
      const nextVisibility = input.visibility ?? request.visibility;
      const nextSensitivity = input.sensitivity ?? request.sensitivity;
      if (nextSensitivity === "sensitive" && nextVisibility !== "restricted") {
        throw new DomainError(
          "validation_failed",
          "Sensitive requests must use restricted visibility",
        );
      }
      const updated = await repository.updateContent({
        requestId: request.id,
        organizationId: request.organizationId,
        expectedVersion: request.version,
        title: input.title,
        descriptionMd: input.descriptionMd,
        priority: input.priority,
        visibility: input.visibility,
        sensitivity: input.sensitivity,
      });
      const changedFields = (
        [
          "title",
          "descriptionMd",
          "priority",
          "visibility",
          "sensitivity",
        ] as const
      ).filter((field) => input[field] !== undefined);
      const event = dependencies.events.create(context, {
        type: "request.updated.v1",
        schemaVersion: 1,
        aggregateType: "request",
        aggregateId: request.id,
        aggregateVersion: updated.version,
        projectId: request.targetProjectId,
        requestId: request.id,
        causationId: context.correlationId,
        data: { ...requestEventFacts(updated), changedFields },
      });
      return {
        result: requestResult(updated),
        aggregateId: request.id,
        events: [event],
      };
    },
  };

  return [createDraft, updateRequest, transition];
}
