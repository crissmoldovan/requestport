"use server";

import { serverEnv } from "@requestport/config/server";
import { createRequestQueryRepository } from "@requestport/db";
import {
  DomainError,
  keyedFingerprint,
  requestPriorities,
  requestStates,
  requestTypes,
} from "@requestport/domain";
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { z } from "zod";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../lib/security/rate-limit.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import {
  coreCommandBus,
  humanCommandContext,
} from "../../../lib/server-core-commands.js";
import { webStorage } from "../../../lib/server-request-port.js";
import { evaluateRouteInTransaction } from "../../../lib/server-routing-actions.js";

import {
  type RequestActionState,
  requestFixedValidationMessage,
  requestValidationError,
} from "./request-action-state.js";

const commandResultSchema = z.object({
  id: z.uuid().optional(),
  requestId: z.uuid().optional(),
  displayKey: z.string().nullable().optional(),
  state: z.enum(requestStates).optional(),
  version: z.number().int().nonnegative(),
});

const createSchema = z.object({
  sourceProjectId: z.union([z.literal(""), z.uuid()]),
  targetProjectId: z.uuid(),
  type: z.enum(requestTypes),
  title: z.string().trim().min(1).max(240),
  descriptionMd: z.string().trim().min(1).max(100_000),
  priority: z.enum(requestPriorities),
  visibility: z.enum(["organization", "restricted"]),
  sensitivity: z.enum(["normal", "sensitive"]),
  labels: z.string().max(4_000),
  acceptanceCriteria: z.string().max(100_000),
  intent: z.enum(["draft", "submit"]),
  idempotencyKey: z.string().trim().min(16).max(200),
});

const routePreviewSchema = z.object({
  sourceProjectId: z.union([z.literal(""), z.uuid()]),
  targetProjectId: z.uuid(),
  type: z.enum(requestTypes),
  priority: z.enum(requestPriorities),
});

const transitionSchema = z.object({
  requestId: z.uuid(),
  expectedVersion: z.coerce.number().int().positive(),
  action: z.enum([
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
  ]),
  reason: z.string().trim().max(20_000),
  relatedRequestId: z.string().trim().max(100),
  verificationEvidence: z.string().trim().max(50_000),
  outcomeMd: z.string().trim().max(100_000),
  changedRepositories: z.string().trim().max(100_000),
  validationCommand: z.string().trim().max(2_000),
  validationResult: z.enum(["passed", "failed", "not_run"]),
  validationSummary: z.string().trim().max(4_000),
  risksMd: z.string().trim().max(50_000),
  followupsMd: z.string().trim().max(50_000),
  verificationStepsMd: z.string().trim().max(50_000),
  idempotencyKey: z.string().trim().min(16).max(200),
});

const messageSchema = z.object({
  requestId: z.uuid(),
  bodyMd: z.string().trim().min(1).max(100_000),
  visibility: z.enum(["organization", "restricted"]),
  mentionUserIds: z.string().max(4_000),
  idempotencyKey: z.string().trim().min(16).max(200),
});

const updateSchema = z
  .object({
    requestId: z.uuid(),
    expectedVersion: z.coerce.number().int().positive(),
    title: z.string().trim().min(1).max(240),
    descriptionMd: z.string().trim().min(1).max(100_000),
    priority: z.enum(requestPriorities),
    visibility: z.enum(["organization", "restricted"]),
    sensitivity: z.enum(["normal", "sensitive"]),
    idempotencyKey: z.string().trim().min(16).max(200),
  })
  .refine(
    (value) =>
      value.sensitivity !== "sensitive" || value.visibility === "restricted",
    {
      message: "Sensitive requests must use restricted visibility",
      path: ["visibility"],
    },
  );

const relationshipSchema = z.object({
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
  idempotencyKey: z.string().trim().min(16).max(200),
});

const unlinkSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  idempotencyKey: z.string().trim().min(16).max(200),
});

const closeQuestionSchema = z.object({
  requestId: z.uuid(),
  questionId: z.uuid(),
  expectedVersion: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1).max(20_000),
  idempotencyKey: z.string().trim().min(16).max(200),
});

const questionSchema = z.object({
  requestId: z.uuid(),
  expectedVersion: z.coerce.number().int().positive(),
  audience: z.string().trim().min(1).max(300),
  bodyMd: z.string().trim().min(1).max(100_000),
  choices: z.string().trim().max(2_000),
  allowFreeText: z.enum(["true", "false"]),
  answerMode: z.enum(["single", "multiple"]),
  blocksRequest: z.enum(["true", "false"]),
  deadlineAt: z.string().trim().max(100),
  escalateAfterMinutes: z.enum(["none", "60", "240", "1440"]),
  idempotencyKey: z.string().trim().min(16).max(200),
});

const answerSchema = z
  .object({
    questionId: z.uuid(),
    expectedVersion: z.coerce.number().int().positive(),
    bodyMd: z.string().trim().max(100_000),
    choice: z.string().trim().max(160).optional(),
    idempotencyKey: z.string().trim().min(16).max(200),
  })
  .refine((value) => Boolean(value.choice || value.bodyMd), {
    message: "An answer is required",
    path: ["bodyMd"],
  });

const artifactSchema = z.object({
  requestId: z.uuid(),
  kind: z.string().trim().min(1).max(64),
  externalUrl: z.string().trim().min(1).max(4_096),
  mediaType: z.string().trim().max(255),
  sha256: z.string().trim().max(64),
  idempotencyKey: z.string().trim().min(16).max(200),
});

function strings(formData: FormData) {
  return Object.fromEntries(
    [...formData.entries()].map(([key, value]) => [
      key,
      typeof value === "string" ? value : "",
    ]),
  );
}

function changedRepositories(value: string) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [repositoryUrl, commitSha, ...extra] = line.split(/\s+/u);
      if (!repositoryUrl || extra.length > 0) {
        throw new DomainError(
          "validation_failed",
          "Changed repository reference is invalid",
          {
            field: "changedRepositories",
          },
        );
      }
      return {
        repositoryUrl,
        ...(commitSha ? { commitSha } : {}),
      };
    });
}

function actionError(error: unknown): RequestActionState {
  if (error instanceof DomainError) {
    const messages: Record<string, string> = {
      already_answered: "That question already has a canonical answer.",
      conflict: "The requested change conflicts with current state.",
      forbidden: "You do not have permission to complete that action.",
      idempotency_conflict: "This submission key was already used.",
      invalid_transition:
        "That transition is not available from the current state.",
      not_found: "The requested record is unavailable.",
      rate_limited: "Too many requests. Try again shortly.",
      route_denied: "The current routing policy denies this request.",
      unauthenticated: "Sign in to continue.",
      validation_failed: requestFixedValidationMessage,
      version_conflict: "This record changed. Refresh and try again.",
    };
    return {
      status: "error",
      code: error.code,
      message:
        messages[error.code] ?? "RequestPort could not complete that action.",
      field:
        typeof error.details.field === "string"
          ? error.details.field
          : undefined,
    };
  }
  return {
    status: "error",
    code: "unexpected_error",
    message: "RequestPort could not complete that action.",
  };
}

/** A rejected submission, mapped by the module that owns the state shape. */
function validationError(result: z.ZodError): RequestActionState {
  return requestValidationError(result.issues);
}

/**
 * The session, the organization check and the `mutation` limiter.
 *
 * Every action in this module resolves this before it reads a single value out
 * of the submission. Parsing first turns a member-only mutation into an oracle
 * an anonymous caller can query: they learn which of the values a request form
 * asks for the server rejects without ever costing a session lookup, and —
 * because the limiter lives behind the same call — without any bound on how
 * often they may ask again.
 */
async function commandContext() {
  const application = await getApplicationContext();
  if (!application.currentOrganization) {
    throw new DomainError("forbidden", "An active organization is required");
  }
  await enforceRateLimit({
    endpointClass: "mutation",
    fingerprint: rateLimitFingerprint(
      application.currentOrganization.id,
      application.session.user.id,
    ),
  });
  return {
    application,
    organization: application.currentOrganization,
    context: humanCommandContext(
      application.session,
      application.currentOrganization.id,
    ),
  };
}

type RequestCommandContext = Awaited<ReturnType<typeof commandContext>>;

/**
 * The same step, resolved as a value rather than thrown.
 *
 * Every action here answers a rejected submission from outside its `try` — and
 * `createRequestAction` finishes with a `redirect()`, which works by throwing,
 * so widening that `try` to cover the parse would swallow the navigation.
 * Handing the failure back as a state instead moves the guards in front of the
 * parse and leaves both of those exactly as they were.
 */
async function authorized(): Promise<
  | { ok: true; current: RequestCommandContext }
  | { ok: false; state: RequestActionState }
> {
  try {
    return { ok: true, current: await commandContext() };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, state: actionError(error) };
  }
}

export async function previewRequestRouteAction(input: unknown) {
  try {
    const application = await getApplicationContext();
    const organization = application.currentOrganization;
    if (!organization) return { status: "unavailable" as const };
    await enforceRateLimit({
      endpointClass: "token",
      fingerprint: rateLimitFingerprint(
        "route-preview",
        organization.id,
        application.session.user.id,
      ),
    });
    const parsed = routePreviewSchema.safeParse(input);
    if (!parsed.success) {
      return { status: "invalid" as const };
    }
    // The one evaluation entry the routing tester also reaches. It refuses a
    // member who is not active in the active organisation (answered below as
    // unavailable), and denies a source project the member cannot represent
    // with no_matching_permission at policy version 0, reading no rule.
    const decision = await evaluateRouteInTransaction(
      humanCommandContext(application.session, organization.id),
      {
        purpose: "preview",
        organizationId: organization.id,
        ...(parsed.data.sourceProjectId
          ? { sourceProjectId: parsed.data.sourceProjectId }
          : {}),
        targetProjectId: parsed.data.targetProjectId,
        requestType: parsed.data.type,
        priority: parsed.data.priority,
      },
    );
    return {
      status: decision.allowed ? ("allowed" as const) : ("denied" as const),
      reason: decision.reason,
      policyVersion: decision.policyVersion,
      matchedRuleId: decision.matchedRuleId ?? null,
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof DomainError && error.code === "rate_limited") {
      return { status: "rate_limited" as const };
    }
    return { status: "unavailable" as const };
  }
}

export async function createRequestAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const { context, organization } = gate.current;
  const parsed = createSchema.safeParse(strings(formData));
  if (!parsed.success) return validationError(parsed.error);
  let created: z.infer<typeof commandResultSchema>;
  try {
    created = commandResultSchema.parse(
      await coreCommandBus.execute({
        name: "create_request_draft",
        context,
        meta: {
          expectedVersion: 0,
          idempotencyKey: parsed.data.idempotencyKey,
        },
        input: {
          organizationId: organization.id,
          sourceKind: parsed.data.sourceProjectId ? "project" : "human_direct",
          ...(parsed.data.sourceProjectId
            ? { sourceProjectId: parsed.data.sourceProjectId }
            : {}),
          targetProjectId: parsed.data.targetProjectId,
          type: parsed.data.type,
          title: parsed.data.title,
          descriptionMd: parsed.data.descriptionMd,
          priority: parsed.data.priority,
          visibility: parsed.data.visibility,
          sensitivity: parsed.data.sensitivity,
          labels: parsed.data.labels
            .split(",")
            .map((label) => label.trim())
            .filter(Boolean),
          acceptanceCriteria: parsed.data.acceptanceCriteria
            .split("\n")
            .map((criterion) => criterion.trim())
            .filter(Boolean),
        },
      }),
    );
    if (!created.id) throw new Error("Request creation result is invalid");
    if (parsed.data.intent === "submit") {
      created = commandResultSchema.parse(
        await coreCommandBus.execute({
          name: "transition_request",
          context,
          meta: {
            expectedVersion: created.version,
            idempotencyKey: keyedFingerprint(
              serverEnv.BETTER_AUTH_SECRET,
              `submit:${parsed.data.idempotencyKey}`,
            ),
          },
          input: {
            organizationId: organization.id,
            requestId: created.id,
            action: "submit_request",
          },
        }),
      );
    }
  } catch (error) {
    return actionError(error);
  }
  revalidatePath("/requests");
  redirect(`/requests/${created.id}`);
}

export async function transitionRequestAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const { context, organization } = gate.current;
  const parsed = transitionSchema.safeParse(strings(formData));
  if (!parsed.success) return validationError(parsed.error);
  try {
    const input: Record<string, unknown> = {
      organizationId: organization.id,
      requestId: parsed.data.requestId,
      action: parsed.data.action,
    };
    if (parsed.data.reason) input.reason = parsed.data.reason;
    if (parsed.data.relatedRequestId) {
      input.relatedRequestId = parsed.data.relatedRequestId;
    }
    if (parsed.data.verificationEvidence) {
      input.verificationEvidence = parsed.data.verificationEvidence;
    }
    if (parsed.data.action === "complete_request") {
      input.report = {
        outcomeMd: parsed.data.outcomeMd,
        changedRepositories: changedRepositories(
          parsed.data.changedRepositories,
        ),
        validations: [
          {
            command: parsed.data.validationCommand || "Not specified",
            result: parsed.data.validationResult,
            summary: parsed.data.validationSummary || undefined,
          },
        ],
        risksMd: parsed.data.risksMd,
        followupsMd: parsed.data.followupsMd,
        verificationStepsMd: parsed.data.verificationStepsMd,
      };
    }
    await coreCommandBus.execute({
      name: "transition_request",
      context,
      meta: {
        expectedVersion: parsed.data.expectedVersion,
        idempotencyKey: parsed.data.idempotencyKey,
      },
      input,
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/requests/${parsed.data.requestId}`);
  revalidatePath("/requests");
  return { status: "success", message: "Request state updated." };
}

export async function postMessageAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const { context, organization } = gate.current;
  const parsed = messageSchema.safeParse(strings(formData));
  if (!parsed.success) return validationError(parsed.error);
  try {
    await coreCommandBus.execute({
      name: "post_message",
      context,
      meta: { expectedVersion: 0, idempotencyKey: parsed.data.idempotencyKey },
      input: {
        organizationId: organization.id,
        requestId: parsed.data.requestId,
        bodyMd: parsed.data.bodyMd,
        visibility: parsed.data.visibility,
        mentionUserIds: parsed.data.mentionUserIds
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      },
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/requests/${parsed.data.requestId}`);
  return { status: "success", message: "Comment posted." };
}

export async function updateRequestAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const { context, organization } = gate.current;
  const parsed = updateSchema.safeParse(strings(formData));
  if (!parsed.success) return validationError(parsed.error);
  try {
    await coreCommandBus.execute({
      name: "update_request",
      context,
      meta: {
        expectedVersion: parsed.data.expectedVersion,
        idempotencyKey: parsed.data.idempotencyKey,
      },
      input: {
        organizationId: organization.id,
        requestId: parsed.data.requestId,
        title: parsed.data.title,
        descriptionMd: parsed.data.descriptionMd,
        priority: parsed.data.priority,
        visibility: parsed.data.visibility,
        sensitivity: parsed.data.sensitivity,
      },
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/requests/${parsed.data.requestId}`);
  revalidatePath("/requests");
  return { status: "success", message: "Request content updated." };
}

export async function linkRequestsAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const { context, organization } = gate.current;
  const parsed = relationshipSchema.safeParse(strings(formData));
  if (!parsed.success) return validationError(parsed.error);
  try {
    await coreCommandBus.execute({
      name: "link_requests",
      context,
      meta: { expectedVersion: 0, idempotencyKey: parsed.data.idempotencyKey },
      input: {
        organizationId: organization.id,
        fromRequestId: parsed.data.fromRequestId,
        toRequestId: parsed.data.toRequestId,
        type: parsed.data.type,
      },
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/requests/${parsed.data.fromRequestId}`);
  return { status: "success", message: "Relationship added." };
}

export async function unlinkRequestsAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const { context, organization } = gate.current;
  const parsed = unlinkSchema.safeParse(strings(formData));
  if (!parsed.success) return validationError(parsed.error);
  try {
    await coreCommandBus.execute({
      name: "unlink_requests",
      context,
      meta: { expectedVersion: 0, idempotencyKey: parsed.data.idempotencyKey },
      input: {
        organizationId: organization.id,
        requestId: parsed.data.requestId,
        relationshipId: parsed.data.relationshipId,
      },
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/requests/${parsed.data.requestId}`);
  return { status: "success", message: "Relationship removed." };
}

export async function closeQuestionAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const { context, organization } = gate.current;
  const parsed = closeQuestionSchema.safeParse(strings(formData));
  if (!parsed.success) return validationError(parsed.error);
  try {
    await coreCommandBus.execute({
      name: "close_question",
      context,
      meta: {
        expectedVersion: parsed.data.expectedVersion,
        idempotencyKey: parsed.data.idempotencyKey,
      },
      input: {
        organizationId: organization.id,
        questionId: parsed.data.questionId,
        reason: parsed.data.reason,
      },
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/requests/${parsed.data.requestId}`);
  revalidatePath("/questions");
  return { status: "success", message: "Question closed." };
}

export async function askQuestionAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const { context, organization } = gate.current;
  const parsed = questionSchema.safeParse(strings(formData));
  if (!parsed.success) return validationError(parsed.error);
  try {
    const [audienceType, audienceId] = parsed.data.audience.split(":", 2);
    const audience =
      audienceType === "user" && audienceId
        ? { type: "user" as const, id: audienceId }
        : audienceType === "role" &&
            (audienceId === "owner" ||
              audienceId === "admin" ||
              audienceId === "member")
          ? { type: "role" as const, id: audienceId }
          : audienceType === "requester"
            ? { type: "requester" as const }
            : audienceType === "project_maintainers"
              ? { type: "project_maintainers" as const }
              : null;
    if (!audience) {
      throw new DomainError(
        "validation_failed",
        "Question audience is invalid",
      );
    }
    await coreCommandBus.execute({
      name: "ask_question",
      context,
      meta: {
        expectedVersion:
          parsed.data.blocksRequest === "true"
            ? parsed.data.expectedVersion
            : 0,
        idempotencyKey: parsed.data.idempotencyKey,
      },
      input: {
        organizationId: organization.id,
        requestId: parsed.data.requestId,
        audience,
        bodyMd: parsed.data.bodyMd,
        choices: [
          ...new Set(
            parsed.data.choices
              .split("\n")
              .map((choice) => choice.trim())
              .filter(Boolean),
          ),
        ],
        allowFreeText: parsed.data.allowFreeText === "true",
        answerMode: parsed.data.answerMode,
        blocksRequest: parsed.data.blocksRequest === "true",
        deadlineAt: parsed.data.deadlineAt
          ? new Date(parsed.data.deadlineAt).toISOString()
          : null,
        escalationPolicy: parsed.data.deadlineAt
          ? {
              reminderOffsetsMinutes: [1_440, 0],
              escalateAfterMinutes:
                parsed.data.escalateAfterMinutes === "none"
                  ? null
                  : Number(parsed.data.escalateAfterMinutes),
              escalationAudience:
                parsed.data.escalateAfterMinutes === "none"
                  ? null
                  : "project_maintainers",
            }
          : null,
      },
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/requests/${parsed.data.requestId}`);
  revalidatePath("/questions");
  return { status: "success", message: "Question opened." };
}

export async function answerQuestionAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const { context, organization } = gate.current;
  const parsed = answerSchema.safeParse(strings(formData));
  if (!parsed.success) return validationError(parsed.error);
  try {
    await coreCommandBus.execute({
      name: "answer_question",
      context,
      meta: {
        expectedVersion: parsed.data.expectedVersion,
        idempotencyKey: parsed.data.idempotencyKey,
      },
      input: {
        organizationId: organization.id,
        questionId: parsed.data.questionId,
        bodyMd: parsed.data.choice || parsed.data.bodyMd,
        sourceChannel: "web",
      },
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath("/questions");
  revalidatePath("/requests");
  return { status: "success", message: "Answer recorded." };
}

export async function attachArtifactAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const gate = await authorized();
  if (!gate.ok) return gate.state;
  const { context, organization } = gate.current;
  const parsed = artifactSchema.safeParse(strings(formData));
  if (!parsed.success) return validationError(parsed.error);
  try {
    await coreCommandBus.execute({
      name: "attach_artifact",
      context,
      meta: { expectedVersion: 0, idempotencyKey: parsed.data.idempotencyKey },
      input: {
        organizationId: organization.id,
        requestId: parsed.data.requestId,
        kind: parsed.data.kind,
        externalUrl: parsed.data.externalUrl,
        mediaType: parsed.data.mediaType || null,
        sha256: parsed.data.sha256 || null,
        provenance: { enteredVia: "web" },
      },
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/requests/${parsed.data.requestId}`);
  return { status: "success", message: "Artifact link attached." };
}

export async function markRequestReadAction(formData: FormData) {
  const gate = await authorized();
  if (!gate.ok) return;
  const requestId = z.uuid().safeParse(formData.get("requestId"));
  const eventId = z
    .uuid()
    .nullable()
    .safeParse(formData.get("eventId") || null);
  if (!requestId.success || !eventId.success) return;
  try {
    const storage = webStorage();
    await createRequestQueryRepository(storage.db).markRequestRead({
      userId: gate.current.application.session.user.id,
      organizationId: gate.current.organization.id,
      requestId: requestId.data,
      lastSeenEventId: eventId.data,
    });
  } catch {
    return;
  }
  revalidatePath("/requests");
}
