import { serverEnv } from "@requestport/config/server";
import { createNotificationRepository } from "@requestport/db";
import { DomainError } from "@requestport/domain";
import { createResendNotificationAdapter } from "@requestport/notifications";

import { webLogger } from "../../../../lib/observability.js";
import {
  RequestTooLargeError,
  readBoundedRequestText,
} from "../../../../lib/security/input-limits.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
  requestIp,
} from "../../../../lib/security/rate-limit.js";
import { webStorage } from "../../../../lib/server-request-port.js";

const MAX_BODY = 256 * 1_024;

export async function POST(request: Request) {
  if (
    !serverEnv.RESEND_API_KEY ||
    !serverEnv.RESEND_FROM_EMAIL ||
    !serverEnv.RESEND_WEBHOOK_SECRET
  ) {
    return Response.json({ error: "provider_unavailable" }, { status: 503 });
  }
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return Response.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  let rawBody: string;
  try {
    rawBody = await readBoundedRequestText(request, MAX_BODY);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RequestTooLargeError
            ? "request_too_large"
            : "invalid_callback",
      },
      { status: error instanceof RequestTooLargeError ? 413 : 400 },
    );
  }
  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!id || !timestamp || !signature)
    return Response.json({ error: "invalid_callback" }, { status: 400 });
  try {
    await enforceRateLimit({
      endpointClass: "mutation",
      fingerprint: rateLimitFingerprint("resend-callback", requestIp(request)),
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === "rate_limited") {
      return Response.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers:
            typeof error.details.retryAfterSeconds === "number"
              ? { "retry-after": String(error.details.retryAfterSeconds) }
              : undefined,
        },
      );
    }
    return Response.json(
      { error: "callback_processing_failed" },
      { status: 500 },
    );
  }
  let event: { type: string; created_at: string; data?: { email_id?: string } };
  try {
    event = createResendNotificationAdapter({
      apiKey: serverEnv.RESEND_API_KEY,
      from: serverEnv.RESEND_FROM_EMAIL,
    }).verifyWebhook(
      rawBody,
      { id, timestamp, signature },
      serverEnv.RESEND_WEBHOOK_SECRET,
    ) as typeof event;
  } catch {
    return Response.json({ error: "invalid_callback" }, { status: 400 });
  }
  try {
    const occurredAt = new Date(event.created_at);
    if (Number.isNaN(occurredAt.getTime()))
      return Response.json({ error: "invalid_callback" }, { status: 400 });
    const storage = webStorage();
    const result = await createNotificationRepository(
      storage.db,
    ).recordProviderCallback({
      provider: "resend",
      eventId: id,
      rawBody,
      occurredAt,
      providerMessageId: event.data?.email_id,
      status: event.type.replace("email.", ""),
    });
    if (result.conflict) {
      webLogger.error("provider.callback_conflict", {
        provider: "resend",
        providerEventId: id,
        status: "rejected",
        errorCode: "provider_event_body_conflict",
      });
      return Response.json(
        { error: "provider_event_conflict" },
        { status: 409 },
      );
    }
    return Response.json({ received: true });
  } catch {
    return Response.json(
      { error: "callback_processing_failed" },
      { status: 500 },
    );
  }
}
