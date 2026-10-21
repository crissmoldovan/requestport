import { randomUUID } from "node:crypto";

import { createNotificationRepository } from "@requestport/db";
import { createResendNotificationAdapter } from "@requestport/notifications";

import { observeTaskResult, triggerMetrics } from "../observability.js";
import type { JobPayloads } from "../port.js";
import { inUnit, workerSettings, workerStorages } from "../worker-storages.js";

/**
 * One e-mail notification. Its steps (track-i2.md, "I.2b design" §3): the
 * intent's organisation from the resolver, a miss being `not_due`; a unit
 * that claims and loads the intent, and suppresses it when it is not
 * deliverable; a unit that creates the delivery; the Resend call between
 * units; a unit that completes or fails it.
 */
export const runEmailDelivery = ({ intentId }: JobPayloads["email-delivery"]) =>
  observeTaskResult("email-delivery", async () => {
    const organizationId = await workerStorages().resolveJobOrganization(
      "notification_intent",
      intentId,
    );
    if (organizationId === null) return { status: "not_due" };
    const unit = <T>(
      work: (
        notifications: ReturnType<typeof createNotificationRepository>,
      ) => Promise<T>,
    ) =>
      inUnit(organizationId, (database) =>
        work(createNotificationRepository(database)),
      );
    const leaseOwner = `email:${randomUUID()}`;
    const opened = await unit(async (notifications) => {
      const claim = await notifications.claimNotificationIntent({
        intentId,
        channel: "email",
        leaseOwner,
      });
      if (!claim) return { status: "not_due" as const };
      const intent = await notifications.loadPendingIntent(
        intentId,
        "email",
        leaseOwner,
      );
      if (!intent) {
        await notifications.suppressPendingIntent(
          intentId,
          "email",
          leaseOwner,
        );
        return { status: "suppressed" as const };
      }
      return { status: "claimed" as const, claim, intent };
    });
    if (opened.status !== "claimed") return { status: opened.status };
    const { claim, intent } = opened;
    let deliveryId: string | null = null;
    try {
      const { email } = workerSettings().secrets;
      if (!email) {
        throw new Error("provider_unavailable");
      }
      const delivery = await unit((notifications) =>
        notifications.ensureEmailDelivery(intent.organizationId, intent.id),
      );
      deliveryId = delivery.id;
      const result = await createResendNotificationAdapter({
        apiKey: email.apiKey,
        from: email.from,
      }).send({
        intentId: intent.id,
        to: intent.recipientRef,
        model: intent.viewModel,
      });
      const completed = await unit((notifications) =>
        notifications.completeEmailDelivery({
          intentId: intent.id,
          deliveryId: delivery.id,
          providerMessageId: result.providerMessageId,
          leaseOwner,
        }),
      );
      if (!completed) throw new Error("delivery_lease_lost");
      triggerMetrics.count("notification.delivery_total", 1, {
        status: "delivered",
        taskId: "email-delivery",
      });
      return { status: "delivered", deliveryId: delivery.id };
    } catch (error) {
      const errorCode =
        error instanceof Error && error.message === "provider_unavailable"
          ? "provider_unavailable"
          : "provider_delivery_failed";
      const failedDeliveryId = deliveryId;
      await unit((notifications) =>
        failedDeliveryId
          ? notifications.failEmailDelivery({
              intentId: intent.id,
              deliveryId: failedDeliveryId,
              leaseOwner,
              attemptCount: claim.attemptCount,
              errorCode,
            })
          : notifications.failNotificationIntent({
              intentId: intent.id,
              channel: "email",
              leaseOwner,
              attemptCount: claim.attemptCount,
              errorCode,
            }),
      );
      triggerMetrics.count("notification.delivery_total", 1, {
        status: "failed",
        taskId: "email-delivery",
      });
      throw error;
    }
  });
