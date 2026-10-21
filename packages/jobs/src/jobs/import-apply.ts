import { createHash, randomUUID } from "node:crypto";

import {
  type ClaimSettlement,
  type CommandPortFactory,
  createCollaborationRepository,
  createCommandTransactionManager,
  createImportRepository,
  createImportTaskDispatchRepository,
  createOutboxRepository,
  createRequestRepository,
  createRoutingRepository,
} from "@requestport/db";
import {
  type AuthorizedCommandContext,
  type CommandDefinition,
  canonicalJson,
  createCoreCommandRegistry,
  createCoreEventSchemaRegistry,
  DomainError,
  EventFactory,
  type JsonObject,
  type JsonValue,
  type UnitOfWork,
} from "@requestport/domain";
import { z } from "zod";

import { observeTaskResult, workerLogger } from "../observability.js";
import type { JobRunner } from "../port.js";
import { SettlementPendingError, superseded } from "../settlement.js";
import { inUnit, workerStorages } from "../worker-storages.js";

const logger = workerLogger("trigger-import-apply");

const applyActor = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: z.string().min(1).max(255) }),
  z.object({
    type: z.literal("agent"),
    id: z.uuid(),
    authorizationId: z.uuid(),
    delegatedByUserId: z.string().min(1).max(255).nullable(),
    projectId: z.uuid(),
  }),
]);

const applyPayload = z.object({
  organizationId: z.uuid(),
  runId: z.uuid(),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  actor: applyActor,
});
const storedApplyPayload = applyPayload
  .extend({ kind: z.literal("apply") })
  .strict();

const parsedLegacy = z.object({
  kind: z.enum(["request", "response", "handoff", "research", "unknown"]),
  legacyKey: z
    .object({
      namespace: z.string().min(1).max(64),
      normalizedKey: z.string().min(1).max(255),
    })
    .optional(),
  title: z.string().trim().min(1).max(240).optional(),
  bodyMarkdown: z.string().trim().min(1).max(100_000),
  acceptanceCriteria: z
    .array(z.string().trim().min(1).max(1_000))
    .max(100)
    .default([]),
  targetProjectId: z.uuid().optional(),
  reviewedRelationships: z
    .array(
      z
        .object({
          type: z.enum([
            "blocks",
            "depends_on",
            "duplicates",
            "supersedes",
            "related_to",
            "derived_from",
          ]),
          targetRequestId: z.uuid(),
        })
        .strict(),
    )
    .max(20)
    .default([]),
});

const registry = createCoreCommandRegistry();
const eventFactory = new EventFactory(createCoreEventSchemaRegistry());
const commandPorts: CommandPortFactory = (name, database) => {
  if (name === "requests") return createRequestRepository(database);
  if (name === "routing") return createRoutingRepository(database);
  if (name === "collaboration") return createCollaborationRepository(database);
  if (name === "imports") return createImportRepository(database);
  return undefined;
};

/**
 * One of today's command transactions, as a processing unit for
 * `organizationId` (track-i2.md, "I.2b design" §3): the unit's transaction
 * is bound first, and the command transaction runs inside it, a savepoint
 * there. On one of `createWorkerStorages`' two exceptions, the unit is the
 * handle of the storage its caller gave (`inUnit`, `worker-storages.ts`),
 * and this is the command transaction on it, as before b2.
 */
function commandUnit<T>(
  organizationId: string,
  work: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
  return inUnit(organizationId, (database) =>
    createCommandTransactionManager(database, commandPorts).run(work),
  );
}

type CommandExecution = Awaited<
  ReturnType<CommandDefinition<unknown, JsonValue>["execute"]>
>;

async function executeCommand(
  uow: UnitOfWork,
  context: AuthorizedCommandContext,
  name: string,
  input: unknown,
  expectedVersion: number,
): Promise<CommandExecution> {
  const definition = registry.resolve(name);
  if (!definition) throw new Error(`Import command is unavailable: ${name}`);
  const parsed = definition.parse(input);
  const operationFingerprint = createHash("sha256")
    .update(canonicalJson(parsed))
    .digest("hex")
    .slice(0, 32);
  await definition.authorize(context, parsed, uow);
  const execution = await definition.execute(uow, context, parsed, {
    idempotencyKey: `import:${context.correlationId}:${name}:${operationFingerprint}`,
    expectedVersion,
  });
  await uow.domainEvents.append(execution.events);
  await execution.afterEventsPersisted?.(uow, execution.events);
  return execution;
}

async function applyReviewedRelationships(input: {
  uow: UnitOfWork;
  context: AuthorizedCommandContext;
  organizationId: string;
  sourceRequestId: string;
  relationships: z.infer<typeof parsedLegacy>["reviewedRelationships"];
}) {
  const eventIds: string[] = [];
  for (const relationship of input.relationships) {
    const linked = await executeCommand(
      input.uow,
      input.context,
      "link_requests",
      {
        organizationId: input.organizationId,
        fromRequestId: input.sourceRequestId,
        toRequestId: relationship.targetRequestId,
        type: relationship.type,
      },
      0,
    );
    eventIds.push(...linked.events.map((event) => event.id));
  }
  return eventIds;
}

const safelyCancellableImportStates = new Set([
  "submitted",
  "triage",
  "accepted",
  "planned",
  "in_progress",
  "blocked",
  "waiting_human",
  "waiting_requester",
]);

async function compensateOriginalRequest(input: {
  uow: UnitOfWork;
  context: AuthorizedCommandContext;
  organizationId: string;
  correctionRunId: string;
  originalRequestId: string;
  correctedRequestId: string;
}) {
  const original = await input.uow
    .port<ReturnType<typeof createRequestRepository>>("requests")
    .findForUpdate(input.organizationId, input.originalRequestId);
  if (!original) {
    return {
      archiveAction: "original_unavailable",
      eventIds: [] as string[],
      provenanceMessageId: null,
    };
  }
  const provenance = await executeCommand(
    input.uow,
    input.context,
    "post_message",
    {
      organizationId: input.organizationId,
      requestId: original.id,
      bodyMd: `Legacy import correction ${input.correctionRunId} selected corrected request ${input.correctedRequestId}. The preserved source, original mapping, events, and apply report remain immutable.`,
      visibility: "organization",
      mentionUserIds: [],
    },
    0,
  );
  const messageId = (provenance.result as JsonObject).messageId;
  if (typeof messageId !== "string") {
    throw new Error("Correction provenance message identifier is missing");
  }
  const eventIds = provenance.events.map((event) => event.id);
  if (!safelyCancellableImportStates.has(original.state)) {
    return {
      archiveAction: "retained_terminal",
      eventIds,
      provenanceMessageId: messageId,
    };
  }
  const cancelled = await executeCommand(
    input.uow,
    input.context,
    "transition_request",
    {
      organizationId: input.organizationId,
      requestId: original.id,
      action: "cancel_request",
      reason: `Superseded by corrected legacy import request ${input.correctedRequestId}`,
    },
    original.version,
  );
  return {
    archiveAction: "cancelled",
    eventIds: eventIds.concat(cancelled.events.map((event) => event.id)),
    provenanceMessageId: messageId,
  };
}

function importedRequestType(
  kind: z.infer<typeof parsedLegacy>["kind"],
  title: string,
) {
  if (kind === "research") return "investigation" as const;
  if (/\b(?:bug|defect|regression|broken|crash)\b/iu.test(title))
    return "bug" as const;
  if (kind === "request") return "feature" as const;
  return "chore" as const;
}

async function importContext(input: {
  imports: ReturnType<typeof createImportRepository>;
  organizationId: string;
  projectId: string;
  runId: string;
  actor: z.infer<typeof applyActor>;
}): Promise<AuthorizedCommandContext> {
  if (input.actor.type === "user") {
    await input.imports.requireManagerAccess(
      input.organizationId,
      input.actor.id,
    );
    return {
      actor: input.actor,
      organizationId: input.organizationId,
      scopes: new Set([
        "request:create",
        "request:read",
        "request:write",
        "request:triage",
        "import:write",
      ]),
      credentialId: `import-run:${input.runId}:user:${input.actor.id}`,
      correlationId: randomUUID(),
    };
  }
  if (input.actor.projectId !== input.projectId) {
    throw new DomainError("forbidden", "Import project authorization changed");
  }
  const authorization = await input.imports.requireAgentAccess({
    organizationId: input.organizationId,
    projectId: input.projectId,
    agentPrincipalId: input.actor.id,
    authorizationId: input.actor.authorizationId,
    delegatedByUserId: input.actor.delegatedByUserId,
  });
  return {
    actor: {
      type: "agent",
      id: input.actor.id,
      ...(input.actor.delegatedByUserId
        ? {
            delegatedBy: {
              type: "user" as const,
              id: input.actor.delegatedByUserId,
            },
          }
        : {}),
    },
    organizationId: input.organizationId,
    projectId: input.projectId,
    laneIds: new Set(authorization.laneIds),
    scopes: new Set([
      "request:create",
      "request:read",
      "request:write",
      "request:triage",
      "import:write",
    ]),
    credentialId: input.actor.authorizationId,
    correlationId: randomUUID(),
  };
}

/**
 * Hands the outbox rows of `eventIds` to the runner: their ids read in a
 * unit, then each dispatched between units, bound to `organizationId`.
 */
async function dispatchEvents(
  runner: JobRunner,
  organizationId: string,
  eventIds: string[],
) {
  const rows = await inUnit(organizationId, (database) =>
    createOutboxRepository(database).idsForEvents(eventIds),
  );
  await Promise.allSettled(
    rows.map((row) => runner.dispatchOutbox(row.id, organizationId)),
  );
}

/**
 * Applies one reviewed import run. The payload is parsed strictly here
 * rather than trusted from the caller's type, as it always was: it arrives
 * from a queue.
 *
 * It settles the dispatch under `settlement`, the claim that started it
 * (manifest-i2.md §5.1), read before any effect. Its steps (track-i2.md,
 * "I.2b design" §3): the dispatch's organisation from the resolver, a miss
 * being `suppressed`; a unit that reads the standing and loads the dispatch,
 * and completes it there for a finished run; each of today's command
 * transactions as a unit of its own, with the events of each entry
 * dispatched between units; a unit that completes the dispatch.
 */
export const runImportApply = (
  unknownPayload: unknown,
  runner: JobRunner,
  settlement: ClaimSettlement,
) =>
  observeTaskResult("legacy-import-apply", async () => {
    const { dispatchId, attemptCount } = z
      .object({
        dispatchId: z.uuid(),
        attemptCount: z.number().int().positive(),
      })
      .strict()
      .parse(unknownPayload);
    const organizationId = await workerStorages().resolveJobOrganization(
      "import_task_dispatch",
      dispatchId,
    );
    if (organizationId === null) return { status: "suppressed" as const };
    const complete = () =>
      inUnit(organizationId, (database) =>
        createImportTaskDispatchRepository(database).markCompleted(
          dispatchId,
          attemptCount,
          settlement,
        ),
      );
    const refused = () => {
      logger.warn("import.settlement_refused", {
        dispatchId,
        status: "superseded",
        taskKind: "apply",
      });
      return superseded();
    };

    const opened = await inUnit(organizationId, async (database) => {
      const dispatches = createImportTaskDispatchRepository(database);
      const standing = await dispatches.claimStanding(
        dispatchId,
        attemptCount,
        settlement,
      );
      if (standing !== "held") return { kind: "standing" as const, standing };
      const loaded = await dispatches.load(dispatchId);
      if (!loaded) return { kind: "suppressed" as const };
      if (
        loaded.dispatch.attemptCount !== attemptCount ||
        !["leased", "accepted"].includes(loaded.dispatch.state)
      ) {
        return { kind: "standing" as const, standing: "superseded" as const };
      }
      const stored = storedApplyPayload.parse(loaded.dispatch.taskPayload);
      if (
        loaded.dispatch.taskKind !== "apply" ||
        loaded.dispatch.importRunId !== stored.runId ||
        loaded.dispatch.organizationId !== stored.organizationId ||
        stored.organizationId !== organizationId
      ) {
        throw new Error("Import apply dispatch binding is invalid");
      }
      if (["applied", "failed", "cancelled"].includes(loaded.runState)) {
        const settled = await dispatches.markCompleted(
          dispatchId,
          attemptCount,
          settlement,
        );
        return { kind: "finished" as const, settled };
      }
      return { kind: "held" as const, stored };
    });
    if (opened.kind === "standing") {
      if (opened.standing === "pending_acceptance") {
        throw new SettlementPendingError();
      }
      return superseded();
    }
    if (opened.kind === "suppressed") return { status: "suppressed" as const };
    if (opened.kind === "finished") {
      return opened.settled ? { status: "suppressed" as const } : refused();
    }
    const payload = applyPayload.parse(opened.stored);
    const prepared = await commandUnit(organizationId, async (uow) => {
      const imports =
        uow.port<ReturnType<typeof createImportRepository>>("imports");
      const locked = await imports.lockForApply(payload);
      await importContext({
        imports,
        organizationId: payload.organizationId,
        projectId: locked.source.projectId,
        runId: payload.runId,
        actor: payload.actor,
      });
      const detail = await imports.detail(
        payload.organizationId,
        payload.runId,
      );
      if (!detail)
        throw new DomainError("not_found", "Import run was not found");
      if (locked.alreadyApplied) {
        return {
          alreadyApplied: true as const,
          reportId: detail.report?.id ?? null,
          counts: detail.report?.counts ?? {},
          entries: [] as string[],
          projectId: locked.source.projectId,
        };
      }
      return {
        alreadyApplied: false as const,
        reportId: null,
        counts: {},
        entries: detail.entries
          .map(({ entry }) => entry.id)
          .sort((left, right) => left.localeCompare(right, "en")),
        projectId: locked.source.projectId,
      };
    });
    if (prepared.alreadyApplied) {
      return (await complete()) ? prepared : refused();
    }

    for (const entryId of prepared.entries) {
      const completed = await commandUnit(organizationId, async (uow) => {
        const imports =
          uow.port<ReturnType<typeof createImportRepository>>("imports");
        const locked = await imports.lockForApply(payload);
        const detail = await imports.detail(
          payload.organizationId,
          payload.runId,
        );
        if (!detail)
          throw new DomainError("not_found", "Import run was not found");
        const item = detail.entries.find(({ entry }) => entry.id === entryId);
        if (!item)
          throw new DomainError("conflict", "Approved import entry is missing");
        const prior = await imports.findEntryApplication(
          payload.runId,
          entryId,
        );
        if (prior || locked.alreadyApplied) return { eventIds: [] as string[] };
        const { entry } = item;
        const parsed = parsedLegacy.parse(entry.parsedJson);
        const correction = locked.run.parserVersion.endsWith(":correction");
        const existing = await imports.findMapping(
          entry.sourceArtifactId,
          entry.recordIndex,
        );
        const context = await importContext({
          imports,
          organizationId: payload.organizationId,
          projectId: locked.source.projectId,
          runId: payload.runId,
          actor: payload.actor,
        });
        const mappingBase = {
          organizationId: payload.organizationId,
          sourceArtifactId: entry.sourceArtifactId,
          recordIndex: entry.recordIndex,
          importRunId: payload.runId,
          sourceProjectId: locked.source.projectId,
        };

        if (existing && !correction) {
          await imports.recordEntryApplication({
            organizationId: payload.organizationId,
            runId: payload.runId,
            entryId,
            outcome: "existing",
            canonicalType:
              existing.canonicalType === "skip" ? null : existing.canonicalType,
            canonicalId:
              existing.canonicalType === "skip" ? null : existing.canonicalId,
          });
          return { eventIds: [] as string[] };
        }
        if (entry.decision === "skip") {
          if (!correction)
            await imports.insertMapping({
              ...mappingBase,
              canonicalType: "skip",
              canonicalId: entry.id,
            });
          await imports.recordEntryApplication({
            organizationId: payload.organizationId,
            runId: payload.runId,
            entryId,
            outcome: "skipped",
          });
          return { eventIds: [] as string[] };
        }
        if (entry.decision === "map_existing") {
          if (!entry.proposedCanonicalId)
            throw new DomainError(
              "validation_failed",
              "Mapped import entry is missing a canonical request",
            );
          const request = await uow
            .port<ReturnType<typeof createRequestRepository>>("requests")
            .findForUpdate(payload.organizationId, entry.proposedCanonicalId);
          if (!request)
            throw new DomainError(
              "not_found",
              "Mapped canonical request was not found",
            );
          const warnings: Array<Record<string, unknown>> = [];
          let eventIds: string[] = [];
          if (correction) {
            let compensation = {
              archiveAction: "not_applicable",
              eventIds: [] as string[],
              provenanceMessageId: null as string | null,
            };
            if (
              existing?.canonicalType === "request" &&
              existing.canonicalId !== request.id
            ) {
              compensation = await compensateOriginalRequest({
                uow,
                context,
                organizationId: payload.organizationId,
                correctionRunId: payload.runId,
                originalRequestId: existing.canonicalId,
                correctedRequestId: request.id,
              });
            }
            eventIds = compensation.eventIds;
            warnings.push({
              kind: "compensating_correction",
              sourceArtifactId: entry.sourceArtifactId,
              recordIndex: entry.recordIndex,
              originalMappingId: existing?.id ?? null,
              originalCanonicalType: existing?.canonicalType ?? null,
              originalCanonicalId: existing?.canonicalId ?? null,
              correctedCanonicalType: "request",
              correctedCanonicalId: request.id,
              archiveAction: compensation.archiveAction,
              provenanceMessageId: compensation.provenanceMessageId,
            });
          } else {
            await imports.insertMapping({
              ...mappingBase,
              canonicalType: "request",
              canonicalId: request.id,
              ...(parsed.legacyKey ? { legacyKey: parsed.legacyKey } : {}),
            });
          }
          eventIds.push(
            ...(await applyReviewedRelationships({
              uow,
              context,
              organizationId: payload.organizationId,
              sourceRequestId: request.id,
              relationships: parsed.reviewedRelationships,
            })),
          );
          await imports.recordEntryApplication({
            organizationId: payload.organizationId,
            runId: payload.runId,
            entryId,
            outcome: "mapped",
            canonicalType: "request",
            canonicalId: request.id,
            warnings,
          });
          return { eventIds };
        }
        if (entry.decision === "message") {
          if (!entry.proposedCanonicalId)
            throw new DomainError(
              "validation_failed",
              "Message import entry is missing a canonical request",
            );
          const execution = await executeCommand(
            uow,
            context,
            "post_message",
            {
              organizationId: payload.organizationId,
              requestId: entry.proposedCanonicalId,
              bodyMd: parsed.bodyMarkdown,
              visibility: "organization",
              mentionUserIds: [],
            },
            0,
          );
          const messageId = (execution.result as JsonObject).messageId;
          if (typeof messageId !== "string")
            throw new Error("Imported message identifier is missing");
          const warnings = correction
            ? [
                {
                  kind: "compensating_message",
                  sourceArtifactId: entry.sourceArtifactId,
                  recordIndex: entry.recordIndex,
                  originalCanonicalType: existing?.canonicalType ?? null,
                  originalCanonicalId: existing?.canonicalId ?? null,
                  messageId,
                },
              ]
            : [];
          if (!correction)
            await imports.insertMapping({
              ...mappingBase,
              canonicalType: "message",
              canonicalId: messageId,
            });
          await imports.recordEntryApplication({
            organizationId: payload.organizationId,
            runId: payload.runId,
            entryId,
            outcome: correction ? "corrected_message" : "message",
            canonicalType: "message",
            canonicalId: messageId,
            warnings,
          });
          return { eventIds: execution.events.map((event) => event.id) };
        }
        if (entry.decision !== "create")
          throw new DomainError(
            "conflict",
            "Import manifest contains a non-applicable decision",
          );
        if (!parsed.targetProjectId)
          throw new DomainError(
            "validation_failed",
            "Created import entry is missing a target project",
          );
        const title = parsed.title ?? `Imported ${parsed.kind}`;
        const created = await executeCommand(
          uow,
          context,
          "create_request_draft",
          {
            organizationId: payload.organizationId,
            sourceKind: "project",
            sourceProjectId: locked.source.projectId,
            targetProjectId: parsed.targetProjectId,
            type: importedRequestType(parsed.kind, title),
            title,
            descriptionMd: parsed.bodyMarkdown,
            priority: "normal",
            labels: correction
              ? ["legacy-import", "legacy-import-correction"]
              : ["legacy-import"],
            acceptanceCriteria: parsed.acceptanceCriteria,
          },
          0,
        );
        const createdResult = created.result as JsonObject;
        if (
          typeof createdResult.id !== "string" ||
          typeof createdResult.version !== "number"
        )
          throw new Error("Imported request result is invalid");
        const submitted = await executeCommand(
          uow,
          context,
          "transition_request",
          {
            organizationId: payload.organizationId,
            requestId: createdResult.id,
            action: "submit_request",
          },
          createdResult.version,
        );
        const relationshipEventIds = await applyReviewedRelationships({
          uow,
          context,
          organizationId: payload.organizationId,
          sourceRequestId: createdResult.id,
          relationships: parsed.reviewedRelationships,
        });
        const correctionEvents: string[] = [];
        const correctionWarnings: Array<Record<string, unknown>> = [];
        if (correction) {
          let compensation = {
            archiveAction: "not_applicable",
            eventIds: [] as string[],
            provenanceMessageId: null as string | null,
          };
          if (existing?.canonicalType === "request") {
            compensation = await compensateOriginalRequest({
              uow,
              context,
              organizationId: payload.organizationId,
              correctionRunId: payload.runId,
              originalRequestId: existing.canonicalId,
              correctedRequestId: createdResult.id,
            });
          }
          correctionEvents.push(...compensation.eventIds);
          correctionWarnings.push({
            kind: "compensating_correction",
            sourceArtifactId: entry.sourceArtifactId,
            recordIndex: entry.recordIndex,
            originalMappingId: existing?.id ?? null,
            originalCanonicalType: existing?.canonicalType ?? null,
            originalCanonicalId: existing?.canonicalId ?? null,
            correctedCanonicalType: "request",
            correctedCanonicalId: createdResult.id,
            archiveAction: compensation.archiveAction,
            provenanceMessageId: compensation.provenanceMessageId,
          });
        } else {
          await imports.insertMapping({
            ...mappingBase,
            canonicalType: "request",
            canonicalId: createdResult.id,
            ...(parsed.legacyKey ? { legacyKey: parsed.legacyKey } : {}),
          });
        }
        await imports.recordEntryApplication({
          organizationId: payload.organizationId,
          runId: payload.runId,
          entryId,
          outcome: "created",
          canonicalType: "request",
          canonicalId: createdResult.id,
          warnings: correctionWarnings,
        });
        return {
          eventIds: [...created.events, ...submitted.events]
            .map((event) => event.id)
            .concat(relationshipEventIds, correctionEvents),
        };
      });
      await dispatchEvents(runner, organizationId, completed.eventIds);
    }

    const committed = await commandUnit(organizationId, async (uow) => {
      const imports =
        uow.port<ReturnType<typeof createImportRepository>>("imports");
      const locked = await imports.lockForApply(payload);
      const detail = await imports.detail(
        payload.organizationId,
        payload.runId,
      );
      if (!detail)
        throw new DomainError("not_found", "Import run was not found");
      if (locked.alreadyApplied)
        return {
          alreadyApplied: true as const,
          reportId: detail.report?.id ?? null,
          counts: detail.report?.counts ?? {},
          eventIds: [] as string[],
        };
      const applications = await imports.listEntryApplications(payload.runId);
      if (applications.length !== detail.entries.length)
        throw new DomainError(
          "conflict",
          "Import application has unfinished entries",
        );
      const counts: Record<string, number> = {
        created: 0,
        mapped: 0,
        messages: 0,
        skipped: 0,
        existing: 0,
      };
      const warnings: Array<Record<string, unknown>> = [];
      for (const application of applications) {
        const counter =
          application.outcome === "created"
            ? "created"
            : application.outcome === "mapped"
              ? "mapped"
              : application.outcome === "message" ||
                  application.outcome === "corrected_message"
                ? "messages"
                : application.outcome === "skipped"
                  ? "skipped"
                  : "existing";
        counts[counter] = (counts[counter] ?? 0) + 1;
        warnings.push(...application.warnings);
      }
      const context = await importContext({
        imports,
        organizationId: payload.organizationId,
        projectId: locked.source.projectId,
        runId: payload.runId,
        actor: payload.actor,
      });
      const reportId = await imports.createReport({
        organizationId: payload.organizationId,
        runId: payload.runId,
        counts,
        warnings,
        manifestSha256: payload.manifestSha256,
      });
      if (!reportId) throw new Error("Import apply report persistence failed");
      const appliedEvent = eventFactory.create(context, {
        type: "import.applied.v1",
        schemaVersion: 1,
        aggregateType: "import_run",
        aggregateId: payload.runId,
        aggregateVersion: 1,
        projectId: locked.source.projectId,
        causationId: context.correlationId,
        data: {
          importRunId: payload.runId,
          reportId,
          manifestSha256: payload.manifestSha256,
          counts,
        },
      });
      await uow.domainEvents.append([appliedEvent]);
      await imports.completeApply({
        organizationId: payload.organizationId,
        runId: payload.runId,
        actorType: payload.actor.type,
        actorId: payload.actor.id,
        reportId,
        correlationId: context.correlationId,
      });
      return {
        alreadyApplied: false as const,
        reportId,
        counts,
        eventIds: [appliedEvent.id],
      };
    });
    await dispatchEvents(runner, organizationId, committed.eventIds);
    return (await complete()) ? committed : refused();
  });
