"use server";

import { serverEnv } from "@requestport/config/server";
import {
  createOutboxRepository,
  createWebhookRepository,
} from "@requestport/db";
import { DomainError } from "@requestport/domain";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { namedValidationFailure } from "../../../lib/action-field-issues.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../lib/security/rate-limit.js";
import { getApplicationContext } from "../../../lib/server-application-context.js";
import { humanCommandContext } from "../../../lib/server-core-commands.js";
import { webStorage } from "../../../lib/server-request-port.js";
import { webhookManagementService } from "../../../lib/server-webhooks.js";
import { triggerWebhookDelivery } from "../../../lib/trigger-client.js";
import type { WebhookActionState } from "./webhook-action-state.js";

function list(value: FormDataEntryValue | null) {
  return typeof value === "string"
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function errorState(error: unknown): WebhookActionState {
  if (error instanceof DomainError) {
    const messages: Record<string, string> = {
      configuration_error: "Webhook encryption is not configured.",
      conflict:
        "That webhook change already completed or conflicts with current state. A previously returned signing secret cannot be shown again; start a new rotation or create a replacement.",
      idempotency_conflict:
        "This action key was already used for different webhook settings.",
      forbidden: "Only organization owners and admins can manage webhooks.",
      not_found: "That webhook is no longer available.",
      rate_limited: "Too many webhook changes. Wait a moment and try again.",
      validation_failed: "The endpoint or webhook settings were rejected.",
    };
    // A domain rejection that already knows which value it is about keeps that
    // name, so the message lands on the control the reader has to change.
    const field = error.details.field;
    return {
      status: "error",
      ...(typeof field === "string" ? { field } : {}),
      message: messages[error.code] ?? "Webhook action failed.",
    };
  }
  return { status: "error", message: "Webhook action failed." };
}

/**
 * The session, the organization check and the `webhook_admin` limiter.
 *
 * Every action in this module resolves this before it reads a single value out
 * of the submission. Parsing first turns an owner/admin-only mutation into an
 * oracle an anonymous caller can query: they learn whether the body they sent
 * is well formed without ever costing a session lookup, and — because the
 * limiter lives behind the same call — without any bound on how often they may
 * ask again.
 */
async function context() {
  const application = await getApplicationContext();
  if (!application.currentOrganization)
    throw new DomainError("forbidden", "Organization required");
  if (!webhookManagementService)
    throw new DomainError("configuration_error", "Webhook service unavailable");
  await enforceRateLimit({
    endpointClass: "webhook_admin",
    fingerprint: rateLimitFingerprint(
      application.currentOrganization.id,
      application.session.user.id,
    ),
  });
  return {
    application,
    organization: application.currentOrganization,
    command: humanCommandContext(
      application.session,
      application.currentOrganization.id,
    ),
    service: webhookManagementService,
  };
}

export async function createWebhookAction(
  _previous: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  try {
    // Creation is the one action here whose schema rejection is addressed to a
    // named control, so reading the form first handed an unauthenticated caller
    // an answer distinguishable per field rather than the module's one banner.
    const current = await context();
    const parsed = z
      .object({
        idempotencyKey: z.string().min(16).max(200),
        expectedVersion: z.coerce.number().int().nonnegative(),
        projectId: z.union([z.literal(""), z.uuid()]),
        name: z.string().trim().min(1).max(160),
        endpointUrl: z.string().trim().min(1).max(4_096),
      })
      .safeParse(Object.fromEntries(formData));
    // The create form draws a field for every value it asks for, so a schema
    // rejection is addressed to the control that owns it rather than left in
    // the banner.
    if (!parsed.success) {
      return {
        status: "error",
        ...namedValidationFailure(parsed.error.issues),
      };
    }
    const input = parsed.data;
    const projectId = input.projectId || null;
    const result = await current.service.create(
      current.command,
      {
        organizationId: current.organization.id,
        projectId,
        name: input.name,
        endpointUrl: input.endpointUrl,
        eventTypes: list(formData.get("eventTypes")),
        projectIds: projectId ? [projectId] : [],
        laneIds: formData
          .getAll("laneIds")
          .filter((value): value is string => typeof value === "string"),
        requestTypes: list(formData.get("requestTypes")),
      },
      {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
    );
    revalidatePath("/webhooks");
    return {
      status: "success",
      message:
        "Webhook created. Copy the signing secret now, then verify the endpoint.",
      plaintextSecret: result.plaintextSecret,
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

const itemSchema = z.object({
  id: z.uuid(),
  idempotencyKey: z.string().min(16).max(200),
  expectedVersion: z.coerce.number().int().positive(),
});

export async function verifyWebhookAction(
  _previous: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  try {
    const current = await context();
    const { id, expectedVersion, idempotencyKey } = itemSchema.parse(
      Object.fromEntries(formData),
    );
    await current.service.verify(
      current.command,
      { organizationId: current.organization.id, id },
      { expectedVersion, idempotencyKey },
    );
    revalidatePath("/webhooks");
    return { status: "success", message: "Endpoint verified and enabled." };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function rotateWebhookSecretAction(
  _previous: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  try {
    const current = await context();
    const input = itemSchema
      .extend({ overlapMinutes: z.coerce.number().int().min(5).max(1_440) })
      .parse(Object.fromEntries(formData));
    const { expectedVersion, idempotencyKey, ...rotation } = input;
    const result = await current.service.rotate(
      current.command,
      { organizationId: current.organization.id, ...rotation },
      { expectedVersion, idempotencyKey },
    );
    revalidatePath("/webhooks");
    return {
      status: "success",
      message: `Next secret created; overlap ends ${result.overlapEndsAt.toISOString()}.`,
      plaintextSecret: result.plaintextSecret,
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function setWebhookStatusAction(
  _previous: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  try {
    const current = await context();
    const input = itemSchema
      .extend({ status: z.enum(["active", "disabled", "revoked"]) })
      .parse(Object.fromEntries(formData));
    const { expectedVersion, idempotencyKey, ...statusInput } = input;
    await current.service.setStatus(
      current.command,
      { organizationId: current.organization.id, ...statusInput },
      { expectedVersion, idempotencyKey },
    );
    revalidatePath("/webhooks");
    return { status: "success", message: `Webhook ${input.status}.` };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}

export async function replayWebhookAction(
  _previous: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  try {
    const current = await context();
    const input = z
      .object({
        deliveryId: z.uuid(),
        idempotencyKey: z.string().min(16).max(200),
        expectedVersion: z.coerce.number().int().nonnegative(),
      })
      .parse(Object.fromEntries(formData));
    const storage = webStorage();
    if (
      !(await createWebhookRepository(storage.db).canManage(
        current.organization.id,
        current.application.session.user.id,
      ))
    )
      throw new DomainError("forbidden", "Webhook management access is denied");
    const outbox = createOutboxRepository(storage.db);
    const replay = await outbox.createWebhookReplay({
      organizationId: current.organization.id,
      deliveryId: input.deliveryId,
      actorType: "user",
      actorId: current.application.session.user.id,
      correlationId: current.command.correlationId,
      expectedVersion: input.expectedVersion,
      fingerprintSecret: serverEnv.BETTER_AUTH_SECRET,
      idempotencyKey: input.idempotencyKey,
    });
    if (!replay)
      throw new DomainError("not_found", "Webhook delivery was not found");
    try {
      await triggerWebhookDelivery(replay.id);
    } catch {
      revalidatePath("/webhooks");
      return {
        status: "success",
        message:
          "Webhook replay is durable and will be queued by the repair sweep.",
      };
    }
    revalidatePath("/webhooks");
    return {
      status: "success",
      message: "Webhook replay queued with a new delivery ID.",
    };
  } catch (error) {
    unstable_rethrow(error);
    return errorState(error);
  }
}
