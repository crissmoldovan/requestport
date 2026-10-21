import { createOutboxRepository } from "@requestport/db";
import {
  createCoreEventSchemaRegistry,
  deserializeEncryptedEnvelope,
  sanitizeEventActor,
  sanitizeEventLinks,
} from "@requestport/domain";
import { classifyWebhookResult, deliverWebhook } from "@requestport/webhooks";

import {
  observeTaskResult,
  triggerMetrics,
  workerLogger,
} from "../observability.js";
import type { JobPayloads, JobRunner } from "../port.js";
import { webhookAad, webhookEncryption } from "../webhook-encryption.js";
import { inUnit, workerSettings, workerStorages } from "../worker-storages.js";

const logger = workerLogger("trigger-webhook-delivery");
const eventSchemas = createCoreEventSchemaRegistry();

const safeWebhookErrors = new Set([
  "response_too_large",
  "delivery_timeout",
  "unsafe_redirect",
  "redirect_limit",
  "invalid_endpoint_url",
  "unsafe_endpoint_url",
  "https_required",
  "unsafe_endpoint_port",
  "unsafe_endpoint_address",
]);

function safeWebhookError(error: unknown) {
  return error instanceof Error && safeWebhookErrors.has(error.message)
    ? error.message
    : "webhook_delivery_failed";
}

/**
 * One attempt at one webhook delivery.
 *
 * Every attempt is recorded before this returns or throws, including when to
 * try again (`finishWebhookAttempt`'s `retryDelaySeconds`), so the delivery's
 * own rows say what happens next whichever runner is in charge: Trigger.dev
 * waits and retries the run, and `webhook-delivery-repair` picks up any
 * `retry` delivery whose time has come.
 *
 * Its steps (track-i2.md, "I.2b design" §3): the delivery's organisation
 * from the resolver, a miss being the missing record it always was; a unit
 * that loads and claims it; the decryption and the POST between units, with
 * the addresses the POST resolved recorded in a short unit of their own; a
 * unit that finishes the attempt.
 */
export const runWebhookDelivery = (
  { deliveryId }: JobPayloads["webhook-delivery"],
  runner: JobRunner,
) =>
  observeTaskResult("webhook-delivery", async () => {
    const organizationId = await workerStorages().resolveJobOrganization(
      "webhook_delivery",
      deliveryId,
    );
    if (organizationId === null) return { status: "suppressed" };
    // During the overlap window the newly returned secret is staged so the
    // receiver has time to install it. Deliveries continue using the current
    // key until the scheduled promotion atomically makes the staged key
    // current; switching immediately would make the advertised overlap a
    // breaking cutover for receivers that still know only the old key.
    const slot = "current";
    const timestamp = Math.floor(Date.now() / 1_000);
    const opened = await inUnit(organizationId, async (database) => {
      const outbox = createOutboxRepository(database);
      const record = await outbox.loadWebhookDelivery(deliveryId);
      if (!record) return null;
      const claimed = await outbox.claimWebhookDelivery({
        deliveryId,
        timestamp,
      });
      return claimed ? { record, claimed } : null;
    });
    if (!opened) return { status: "suppressed" };
    const { record, claimed } = opened;
    const finishAttempt = (
      input: Parameters<
        ReturnType<typeof createOutboxRepository>["finishWebhookAttempt"]
      >[0],
    ) =>
      inUnit(organizationId, (database) =>
        createOutboxRepository(database).finishWebhookAttempt(input),
      );
    const { attemptId, attemptNumber } = claimed;
    const signingKeyId = claimed.signingKeyId;
    let attemptFinished = false;
    try {
      const safeEventData = eventSchemas.parse(
        record.event.type,
        record.event.data,
      );
      const safeEventLinks = sanitizeEventLinks(record.event.links);
      const safeEventActor = sanitizeEventActor(record.event.actor);
      const envelope = deserializeEncryptedEnvelope(claimed.secretCiphertext);
      const secret = await webhookEncryption().decrypt<{ secret: string }>(
        envelope,
        webhookAad(claimed.organizationId, claimed.subscriptionId, slot),
      );
      const response = await deliverWebhook({
        endpointUrl: record.subscription.endpointUrl,
        eventId: record.event.id,
        deliveryId,
        attempt: attemptNumber,
        schemaVersion: record.event.schemaVersion,
        keyId: signingKeyId,
        secret: secret.secret,
        payload: {
          id: record.event.id,
          type: record.event.type,
          schemaVersion: record.event.schemaVersion,
          occurredAt: record.event.occurredAt.toISOString(),
          organizationId: record.event.organizationId,
          projectId: record.event.projectId,
          requestId: record.event.requestId,
          aggregate: {
            type: record.event.aggregateType,
            id: record.event.aggregateId,
            version: record.event.aggregateVersion,
          },
          actor: safeEventActor,
          data:
            record.requestSensitivity === "sensitive"
              ? {
                  requestId: record.event.requestId,
                  sensitivity: "sensitive",
                  redacted: true,
                }
              : safeEventData,
          links: safeEventLinks,
        },
        production: workerSettings().productionWebhookEndpoints,
        privateReceivers: workerSettings().privateWebhookReceivers,
        now: () => timestamp,
        onResolved: async ({ addresses, timestamp }) => {
          void timestamp;
          await inUnit(organizationId, (database) =>
            createOutboxRepository(database).addWebhookResolvedIps(
              attemptId,
              addresses,
            ),
          );
        },
      });
      const classified = classifyWebhookResult(response.status);
      const status =
        classified === "retry" && attemptNumber >= 6
          ? "dead_letter"
          : classified;
      const retryDelayMs =
        response.retryAfterMs ??
        Math.min(3_600_000, 2 ** attemptNumber * 1_000);
      await finishAttempt({
        attemptId,
        deliveryId,
        status,
        responseStatus: response.status,
        responseExcerpt: response.excerpt,
        retryDelaySeconds:
          status === "retry"
            ? Math.max(1, Math.ceil(retryDelayMs / 1_000))
            : undefined,
      });
      attemptFinished = true;
      logger.info("webhook.attempt_finished", {
        deliveryId,
        status,
        count: attemptNumber,
      });
      triggerMetrics.count("webhook.delivery_total", 1, {
        status,
        taskId: "webhook-delivery",
      });
      if (status === "retry") {
        await runner.waitBeforeRetry(
          Math.max(1, Math.ceil(retryDelayMs / 1_000)),
        );
        throw new Error("webhook_retryable_response");
      }
      return { status, responseStatus: response.status };
    } catch (error) {
      const errorCode = safeWebhookError(error);
      if (!attemptFinished) {
        await finishAttempt({
          attemptId,
          deliveryId,
          status: attemptNumber >= 6 ? "dead_letter" : "retry",
          errorCode,
          retryDelaySeconds: Math.max(
            1,
            Math.ceil(Math.min(3_600_000, 2 ** attemptNumber * 1_000) / 1_000),
          ),
        });
      }
      logger.warn("webhook.attempt_failed", {
        deliveryId,
        status: attemptNumber >= 6 ? "dead_letter" : "retry",
        errorCode,
        count: attemptNumber,
      });
      triggerMetrics.count("webhook.delivery_total", 1, {
        status: attemptNumber >= 6 ? "dead_letter" : "retry",
        taskId: "webhook-delivery",
      });
      throw error;
    }
  });

export const repairWebhookDeliveries = (runner: JobRunner) =>
  observeTaskResult("webhook-delivery-repair", async () => {
    const pending = await createOutboxRepository(
      workerStorages().dispatcher,
    ).pendingWebhookDeliveries(100);
    for (const delivery of pending) {
      await runner.enqueue("webhook-delivery", { deliveryId: delivery.id });
    }
    return { scheduled: pending.length };
  });
