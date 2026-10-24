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
import type { CommandDefinition } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";
import { fitsUtf8ByteLimit } from "../shared/validation.js";
import { utf16Max } from "../shared/zod-compat.js";
import {
  assertWorkTransition,
  boundedLeasePolicy,
  leaseTimes,
} from "./work-state-machine.js";
import {
  type WorkRepository,
  type WorkSessionRecord,
  workSessionStates,
} from "./work-types.js";

const sessionEventSchema = z.object({
  workSessionId: z.uuid(),
  requestId: z.uuid(),
  agentPrincipalId: z.uuid(),
  state: z.enum(workSessionStates),
  version: z.number().int().positive(),
  heartbeatIntervalSeconds: z.number().int().min(10).max(3600),
});

const updateEventSchema = z.object({
  workSessionId: z.uuid(),
  requestId: z.uuid(),
  updateId: z.uuid(),
  kind: z.enum(["progress", "checkpoint", "blocker", "note"]),
  bodyMd: z.string(),
  progressPercent: z.number().int().min(0).max(100).nullable(),
});

export function registerWorkEventSchemas(registry: EventSchemaRegistry) {
  for (const type of [
    "work.session_claimed.v1",
    "work.session_started.v1",
    "work.session_paused.v1",
    "work.session_resumed.v1",
    "work.session_blocked.v1",
    "work.session_stale.v1",
    "work.session_abandoned.v1",
    "work.session_ended.v1",
  ]) {
    registry.register(type, sessionEventSchema);
  }
  registry.register("work.progress_posted.v1", updateEventSchema);
  return registry;
}

const baseSessionInput = z.object({
  organizationId: z.uuid(),
  workSessionId: z.uuid(),
});

const claimInput = z
  .object({
    organizationId: z.uuid(),
    requestId: z.uuid(),
    installationId: z.uuid(),
    workspaceId: z.uuid(),
  })
  .strict();

const stateInput = baseSessionInput.extend({
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
  outcomeSummaryMd: z
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
    )
    .optional(),
});

/**
 * What `evidence`'s free-form field values may hold (ruling 237 item 3):
 * 10,000 elements across every record's values together, counted as
 * `freeFormJsonExcess` counts them; each value nested at most 8 deep from its
 * own root; and the whole array at most 262,144 bytes of compact JSON. The
 * records and their keys are bounded apart: at most 100 records, of at most
 * 64 fields each.
 */
const evidenceBounds = { elements: 10_000, depth: 8, bytes: 262_144 };

const evidenceRefusals: Record<FreeFormJsonExcess, string> = {
  elements:
    "Work evidence field values may hold at most 10,000 elements in all",
  depth: "A work evidence field value may nest at most 8 levels deep",
  bytes: "Work evidence may take at most 262,144 bytes as compact JSON",
};

const progressInput = baseSessionInput.extend({
  kind: z.enum(["progress", "checkpoint", "blocker", "note"]),
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
      "Work update contains private or secret material",
    ),
  progressPercent: z.number().int().min(0).max(100).nullable().default(null),
  evidence: z
    .array(
      z
        .record(z.string().trim().min(1).check(utf16Max(128)), z.json())
        .superRefine((value, context) => {
          if (Object.keys(value).length > 64) {
            context.addIssue({
              code: "custom",
              message: "Each evidence record may contain at most 64 fields",
            });
          }
          if (containsSensitiveJson(value)) {
            context.addIssue({
              code: "custom",
              message: "Work evidence contains private or secret material",
            });
          }
        }),
    )
    .max(100)
    .superRefine((records, context) => {
      const excess = freeFormJsonExcess(
        records.flatMap((record) => Object.values(record)),
        records,
        evidenceBounds,
      );
      if (excess) {
        context.addIssue({
          code: "custom",
          message: evidenceRefusals[excess],
          params: freeFormJsonRefusal(excess, evidenceBounds),
        });
      }
    })
    .default([]),
});

/**
 * The input schema each command in this module parses with, by command name.
 * These are the same objects the definitions below call `parse` on. Every
 * session state change shares `stateInput`, whose `reason` is optional in the
 * schema; the commands that require one refuse its absence in `execute`, which
 * a schema-only reader cannot see. `heartbeat_work_session` alone takes the
 * bare session reference.
 */
export const workCommandInputSchemas = {
  claim_request: claimInput,
  start_work_session: stateInput,
  heartbeat_work_session: baseSessionInput,
  post_work_update: progressInput,
  pause_work_session: stateInput,
  resume_work_session: stateInput,
  block_work_session: stateInput,
  release_request: stateInput,
  end_work_session: stateInput,
  mark_work_session_stale: stateInput,
  abandon_work_session: stateInput,
} as const;

function result(session: WorkSessionRecord): JsonObject {
  return {
    id: session.id,
    requestId: session.requestId,
    agentPrincipalId: session.agentPrincipalId,
    state: session.state,
    version: session.version,
    heartbeatIntervalSeconds: session.heartbeatIntervalSeconds,
    leaseExpiresAt: session.leaseExpiresAt.toISOString(),
    graceExpiresAt: session.graceExpiresAt.toISOString(),
  };
}

function requireAgent(
  context: Parameters<CommandDefinition<unknown, JsonObject>["authorize"]>[0],
) {
  if (context.actor.type !== "agent") {
    throw new DomainError("forbidden", "An agent identity is required");
  }
  return context.actor;
}

function requireSessionOwner(
  context: Parameters<CommandDefinition<unknown, JsonObject>["authorize"]>[0],
  session: WorkSessionRecord,
) {
  const actor = requireAgent(context);
  if (session.agentPrincipalId !== actor.id) {
    throw new DomainError(
      "forbidden",
      "The work session belongs to another agent",
    );
  }
}

export function createWorkCommandDefinitions(dependencies: {
  events: EventFactory;
  createId?: () => string;
}): Array<CommandDefinition<unknown, JsonObject>> {
  const createId = dependencies.createId ?? uuidv7;

  const claim: CommandDefinition<unknown, JsonObject> = {
    name: "claim_request",
    parse: (input) => claimInput.parse(input),
    async authorize(context, unknownInput) {
      const input = claimInput.parse(unknownInput);
      requireScope(context, "work:claim");
      requireOrganization(context, input.organizationId);
      requireAgent(context);
    },
    async execute(uow, context, unknownInput, meta) {
      if (meta.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "Creation expected version must be zero",
        );
      }
      const input = claimInput.parse(unknownInput);
      const agent = requireAgent(context);
      const request = await uow
        .port<RequestRepository>("requests")
        .findForUpdate(input.organizationId, input.requestId);
      if (!request) throw new DomainError("not_found", "Request was not found");
      requireAgentProject(context, request.targetProjectId);
      requireAgentLane(context, request.laneId);
      if (
        ![
          "accepted",
          "planned",
          "in_progress",
          "blocked",
          "waiting_human",
          "waiting_requester",
        ].includes(request.state)
      ) {
        throw new DomainError(
          "invalid_transition",
          "Request is not available for work",
        );
      }
      const repository = uow.port<WorkRepository>("work");
      if (
        !(await repository.validateAgentBinding({
          organizationId: input.organizationId,
          request,
          agentPrincipalId: agent.id,
          authorizationId: context.credentialId,
          delegatedByUserId: agent.delegatedBy?.id ?? null,
          installationId: input.installationId,
          workspaceId: input.workspaceId,
        }))
      ) {
        throw new DomainError(
          "forbidden",
          "Agent is not bound to this work context",
        );
      }
      const projectPolicy = await repository.projectLeasePolicy({
        organizationId: input.organizationId,
        projectId: request.targetProjectId,
      });
      if (!projectPolicy) {
        throw new DomainError(
          "forbidden",
          "Project work policy is unavailable",
        );
      }
      const policy = boundedLeasePolicy(projectPolicy);
      const timestamp = await repository.currentTime();
      const lease = leaseTimes(timestamp, policy);
      const session = await repository.createClaim({
        id: createId(),
        organizationId: input.organizationId,
        requestId: input.requestId,
        agentPrincipalId: agent.id,
        installationId: input.installationId,
        workspaceId: input.workspaceId,
        authorizationChain: {
          agentPrincipalId: agent.id,
          delegatedByUserId: agent.delegatedBy?.id ?? null,
          authorizationId: context.credentialId,
          organizationId: context.organizationId,
        },
        credentialFingerprint:
          context.credentialFingerprint ?? context.credentialId,
        heartbeatIntervalSeconds: policy.heartbeatIntervalSeconds,
        leaseMultiplier: policy.leaseMultiplier,
        graceSeconds: policy.graceSeconds,
        ...lease,
      });
      const event = dependencies.events.create(context, {
        type: "work.session_claimed.v1",
        schemaVersion: 1,
        aggregateType: "work_session",
        aggregateId: session.id,
        aggregateVersion: session.eventVersion,
        projectId: request.targetProjectId,
        requestId: request.id,
        causationId: context.correlationId,
        data: {
          workSessionId: session.id,
          requestId: request.id,
          agentPrincipalId: session.agentPrincipalId,
          state: session.state,
          version: session.version,
          heartbeatIntervalSeconds: session.heartbeatIntervalSeconds,
        },
      });
      return {
        result: result(session),
        aggregateId: session.id,
        events: [event],
      };
    },
  };

  function stateCommand(options: {
    name: string;
    from: readonly WorkSessionRecord["state"][];
    to: WorkSessionRecord["state"];
    eventType: string;
    requireReason?: boolean;
    requireExpired?: "lease" | "grace";
    serviceOnly?: boolean;
  }): CommandDefinition<unknown, JsonObject> {
    return {
      name: options.name,
      parse: (input) => stateInput.parse(input),
      async authorize(context, unknownInput) {
        const input = stateInput.parse(unknownInput);
        requireOrganization(context, input.organizationId);
        requireScope(
          context,
          options.serviceOnly ? "work:sweep" : "work:update",
        );
        if (options.serviceOnly) {
          if (context.actor.type !== "service") {
            throw new DomainError(
              "forbidden",
              "A service identity is required",
            );
          }
        } else {
          requireAgent(context);
        }
      },
      async execute(uow, context, unknownInput, meta) {
        const input = stateInput.parse(unknownInput);
        if (options.requireReason && !input.reason) {
          throw new DomainError("validation_failed", "A reason is required");
        }
        const repository = uow.port<WorkRepository>("work");
        const session = await repository.findForUpdate(
          input.organizationId,
          input.workSessionId,
        );
        if (!session)
          throw new DomainError("not_found", "Work session was not found");
        const request = await uow
          .port<RequestRepository>("requests")
          .findForUpdate(input.organizationId, session.requestId);
        if (!request) {
          throw new DomainError("not_found", "Request was not found");
        }
        if (!options.serviceOnly) {
          const agent = requireAgent(context);
          requireSessionOwner(context, session);
          if (
            !context.projectId ||
            !(await repository.validateSessionAuthorization({
              organizationId: input.organizationId,
              workSessionId: session.id,
              agentPrincipalId: agent.id,
              authorizationId: context.credentialId,
              delegatedByUserId: agent.delegatedBy?.id ?? null,
              projectId: context.projectId,
            }))
          ) {
            throw new DomainError(
              "forbidden",
              "Agent authorization is no longer active",
            );
          }
        }
        if (!options.from.includes(session.state)) {
          throw new DomainError(
            "invalid_transition",
            "Work session state changed",
          );
        }
        if (meta.expectedVersion !== session.version) {
          throw new DomainError(
            "version_conflict",
            "Work session changed concurrently",
          );
        }
        const timestamp = await repository.currentTime();
        if (
          !options.serviceOnly &&
          options.to !== "ended" &&
          session.leaseExpiresAt.getTime() <= timestamp.getTime()
        ) {
          throw new DomainError(
            "invalid_transition",
            "Expired work session cannot change state",
          );
        }
        if (
          options.requireExpired === "lease" &&
          session.leaseExpiresAt.getTime() > timestamp.getTime()
        ) {
          throw new DomainError(
            "invalid_transition",
            "Work session lease is still active",
          );
        }
        if (
          options.requireExpired === "grace" &&
          session.graceExpiresAt.getTime() > timestamp.getTime()
        ) {
          throw new DomainError(
            "invalid_transition",
            "Work session grace period is still active",
          );
        }
        if (options.name === "start_work_session") {
          if (request.state !== "in_progress") {
            throw new DomainError(
              "invalid_transition",
              "Request must be in progress first",
            );
          }
        }
        assertWorkTransition(session.state, options.to);
        const updated = await repository.transition({
          organizationId: input.organizationId,
          workSessionId: session.id,
          expectedVersion: session.version,
          fromState: session.state,
          toState: options.to,
          startedAt:
            options.to === "active" && !session.startedAt
              ? timestamp
              : undefined,
          endedAt:
            options.to === "ended" || options.to === "abandoned"
              ? timestamp
              : undefined,
          endedReason: input.reason,
          outcomeSummaryMd: input.outcomeSummaryMd,
        });
        const event = dependencies.events.create(context, {
          type: options.eventType,
          schemaVersion: 1,
          aggregateType: "work_session",
          aggregateId: updated.id,
          aggregateVersion: updated.eventVersion,
          projectId: request.targetProjectId,
          requestId: updated.requestId,
          causationId: context.correlationId,
          data: {
            workSessionId: updated.id,
            requestId: updated.requestId,
            agentPrincipalId: updated.agentPrincipalId,
            state: updated.state,
            version: updated.version,
            heartbeatIntervalSeconds: updated.heartbeatIntervalSeconds,
          },
        });
        return {
          result: result(updated),
          aggregateId: updated.id,
          events: [event],
        };
      },
    };
  }

  const heartbeat: CommandDefinition<unknown, JsonObject> = {
    name: "heartbeat_work_session",
    parse: (input) => baseSessionInput.parse(input),
    async authorize(context, unknownInput) {
      const input = baseSessionInput.parse(unknownInput);
      requireOrganization(context, input.organizationId);
      requireScope(context, "work:update");
      requireAgent(context);
    },
    async execute(uow, context, unknownInput, meta) {
      const input = baseSessionInput.parse(unknownInput);
      const repository = uow.port<WorkRepository>("work");
      const session = await repository.findForUpdate(
        input.organizationId,
        input.workSessionId,
      );
      if (!session)
        throw new DomainError("not_found", "Work session was not found");
      const agent = requireAgent(context);
      requireSessionOwner(context, session);
      if (
        !context.projectId ||
        !(await repository.validateSessionAuthorization({
          organizationId: input.organizationId,
          workSessionId: session.id,
          agentPrincipalId: agent.id,
          authorizationId: context.credentialId,
          delegatedByUserId: agent.delegatedBy?.id ?? null,
          projectId: context.projectId,
        }))
      ) {
        throw new DomainError(
          "forbidden",
          "Agent authorization is no longer active",
        );
      }
      if (
        !(
          session.state === "active" ||
          session.state === "paused" ||
          session.state === "blocked"
        )
      ) {
        throw new DomainError(
          "invalid_transition",
          "Work session cannot heartbeat",
        );
      }
      if (meta.expectedVersion !== session.version) {
        throw new DomainError(
          "version_conflict",
          "Work session changed concurrently",
        );
      }
      const timestamp = await repository.currentTime();
      if (session.leaseExpiresAt.getTime() <= timestamp.getTime()) {
        throw new DomainError(
          "invalid_transition",
          "Expired work session cannot heartbeat",
        );
      }
      const policy = boundedLeasePolicy({
        heartbeatIntervalSeconds: session.heartbeatIntervalSeconds,
        leaseMultiplier: session.leaseMultiplier,
        graceSeconds: session.graceSeconds,
      });
      const lease = leaseTimes(timestamp, policy);
      const updated = await repository.heartbeat({
        organizationId: input.organizationId,
        workSessionId: session.id,
        expectedVersion: session.version,
        state: session.state,
        ...lease,
      });
      return { result: result(updated), aggregateId: updated.id, events: [] };
    },
  };

  const progress: CommandDefinition<unknown, JsonObject> = {
    name: "post_work_update",
    parse: (input) => progressInput.parse(input),
    async authorize(context, unknownInput) {
      const input = progressInput.parse(unknownInput);
      requireOrganization(context, input.organizationId);
      requireScope(context, "work:update");
      requireAgent(context);
    },
    async execute(uow, context, unknownInput, meta) {
      const input = progressInput.parse(unknownInput);
      const repository = uow.port<WorkRepository>("work");
      const session = await repository.findForUpdate(
        input.organizationId,
        input.workSessionId,
      );
      if (!session)
        throw new DomainError("not_found", "Work session was not found");
      const request = await uow
        .port<RequestRepository>("requests")
        .findForUpdate(input.organizationId, session.requestId);
      if (!request) throw new DomainError("not_found", "Request was not found");
      const agent = requireAgent(context);
      requireSessionOwner(context, session);
      if (
        !context.projectId ||
        !(await repository.validateSessionAuthorization({
          organizationId: input.organizationId,
          workSessionId: session.id,
          agentPrincipalId: agent.id,
          authorizationId: context.credentialId,
          delegatedByUserId: agent.delegatedBy?.id ?? null,
          projectId: context.projectId,
        }))
      ) {
        throw new DomainError(
          "forbidden",
          "Agent authorization is no longer active",
        );
      }
      if (
        !(
          session.state === "active" ||
          session.state === "paused" ||
          session.state === "blocked"
        )
      ) {
        throw new DomainError(
          "invalid_transition",
          "Work session cannot accept updates",
        );
      }
      if (meta.expectedVersion !== session.version) {
        throw new DomainError(
          "version_conflict",
          "Work session changed concurrently",
        );
      }
      const timestamp = await repository.currentTime();
      if (session.leaseExpiresAt.getTime() <= timestamp.getTime()) {
        throw new DomainError(
          "invalid_transition",
          "Expired work session cannot accept updates",
        );
      }
      const updateId = createId();
      await repository.appendUpdate({
        id: updateId,
        session,
        actor: context.actor,
        kind: input.kind,
        bodyMd: input.bodyMd,
        progressPercent: input.progressPercent,
        evidence: input.evidence,
      });
      const event = dependencies.events.create(context, {
        type: "work.progress_posted.v1",
        schemaVersion: 1,
        aggregateType: "work_session",
        aggregateId: session.id,
        aggregateVersion: session.eventVersion + 1,
        projectId: request.targetProjectId,
        requestId: session.requestId,
        causationId: context.correlationId,
        data: {
          workSessionId: session.id,
          requestId: session.requestId,
          updateId,
          kind: input.kind,
          bodyMd: input.bodyMd,
          progressPercent: input.progressPercent,
        },
      });
      const updated = await repository.transition({
        organizationId: input.organizationId,
        workSessionId: session.id,
        expectedVersion: session.version,
        fromState: session.state,
        toState: session.state,
      });
      return {
        result: { ...result(updated), updateId },
        aggregateId: session.id,
        events: [event],
      };
    },
  };

  return [
    claim,
    stateCommand({
      name: "start_work_session",
      from: ["claimed"],
      to: "active",
      eventType: "work.session_started.v1",
    }),
    heartbeat,
    progress,
    stateCommand({
      name: "pause_work_session",
      from: ["active", "blocked"],
      to: "paused",
      eventType: "work.session_paused.v1",
      requireReason: true,
    }),
    stateCommand({
      name: "resume_work_session",
      from: ["paused", "blocked"],
      to: "active",
      eventType: "work.session_resumed.v1",
      requireReason: true,
    }),
    stateCommand({
      name: "block_work_session",
      from: ["active", "paused"],
      to: "blocked",
      eventType: "work.session_blocked.v1",
      requireReason: true,
    }),
    stateCommand({
      name: "release_request",
      from: ["claimed", "active", "paused", "blocked"],
      to: "ended",
      eventType: "work.session_ended.v1",
      requireReason: true,
    }),
    stateCommand({
      name: "end_work_session",
      from: ["claimed", "active", "paused", "blocked"],
      to: "ended",
      eventType: "work.session_ended.v1",
      requireReason: true,
    }),
    stateCommand({
      name: "mark_work_session_stale",
      from: ["claimed", "active", "paused", "blocked"],
      to: "stale",
      eventType: "work.session_stale.v1",
      requireExpired: "lease",
      serviceOnly: true,
    }),
    stateCommand({
      name: "abandon_work_session",
      from: ["stale"],
      to: "abandoned",
      eventType: "work.session_abandoned.v1",
      requireExpired: "grace",
      serviceOnly: true,
    }),
  ];
}
