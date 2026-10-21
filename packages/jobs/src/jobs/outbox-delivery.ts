import {
  type ClaimSettlement,
  createNotificationRepository,
  createOutboxRepository,
} from "@requestport/db";
import {
  createCoreEventSchemaRegistry,
  DomainError,
} from "@requestport/domain";

import {
  observeTaskResult,
  triggerMetrics,
  workerLogger,
} from "../observability.js";
import type { JobRunner } from "../port.js";
import { SettlementPendingError, superseded } from "../settlement.js";
import { inUnit, workerSettings, workerStorages } from "../worker-storages.js";

const logger = workerLogger("trigger-outbox-delivery");
const eventSchemas = createCoreEventSchemaRegistry();

/**
 * The routing body, separated from any runner so the registered event
 * contract can be exercised directly. `outbox-delivery` is the only thing
 * standing between an immutable migration's envelope and a terminal dead
 * letter, so both appearance event types are proven here rather than only in
 * production.
 *
 * It settles the row itself — completes it, or dead-letters it — under
 * `settlement`, the claim that started it (manifest-i2.md §5.1): the
 * poller's lease, or the Trigger.dev run's own id. A throw leaves the row to
 * whoever claimed it: Trigger.dev's retry policy, or the Postgres worker's
 * outbox poller, which releases it under its lease.
 *
 * Its steps (track-i2.md, "I.2b design" §3): the row's organisation from the
 * resolver; a unit that reads the standing and loads the event, and
 * dead-letters it there when it is missing, invalid or unregistered; a unit
 * that finds the webhook subscriptions and creates the deliveries and
 * notification intents; the children started between units; a unit that
 * completes the row.
 */
export async function deliverOutboxEvent(
  outboxId: string,
  runner: JobRunner,
  settlement: ClaimSettlement,
) {
  return observeTaskResult("outbox-delivery", async () => {
    const organizationId = await workerStorages().resolveJobOrganization(
      "outbox",
      outboxId,
    );
    // Absent, or no longer in flight: nothing holds it for this body, and
    // there is no organisation to bind a dead letter to.
    if (organizationId === null) {
      logger.warn("outbox.unresolved", { outboxId, status: "superseded" });
      return superseded();
    }

    const opened = await inUnit(organizationId, async (database) => {
      const outbox = createOutboxRepository(database);
      const standing = await outbox.claimStanding(outboxId, settlement);
      if (standing !== "held") return { kind: "standing" as const, standing };
      const loaded = await outbox.loadEvent(outboxId);
      if (!loaded) {
        const settled = await outbox.deadLetter(outboxId, settlement);
        return {
          kind: "dead_letter" as const,
          reason: "event_missing" as const,
          settled,
          eventId: undefined,
        };
      }
      try {
        eventSchemas.parse(loaded.event.type, loaded.event.data);
      } catch (error) {
        // A registered type with a bad payload and a type this worker has
        // never heard of are both terminal, but they mean different things:
        // the first is a corrupt or drifted envelope, the second is a
        // deployment ordering problem where a newer writer met an older
        // worker. Staging acceptance needs to tell them apart.
        const reason =
          error instanceof DomainError
            ? ("event_schema_invalid" as const)
            : ("event_type_unregistered" as const);
        const settled = await outbox.deadLetter(outboxId, settlement);
        return {
          kind: "dead_letter" as const,
          reason,
          settled,
          eventId: loaded.event.id,
        };
      }
      return { kind: "held" as const, loaded };
    });

    if (opened.kind === "standing") {
      if (opened.standing === "pending_acceptance") {
        throw new SettlementPendingError();
      }
      return superseded();
    }
    if (opened.kind === "dead_letter") {
      if (!opened.settled) {
        logger.warn("outbox.settlement_refused", {
          outboxId,
          status: "superseded",
          errorCode: opened.reason,
        });
        return superseded();
      }
      logger.warn(`outbox.${opened.reason}`, {
        outboxId,
        ...(opened.eventId === undefined ? {} : { eventId: opened.eventId }),
        status: "dead_letter",
        errorCode: opened.reason,
      });
      return { status: "dead_letter", reason: opened.reason };
    }

    const { event } = opened.loaded;
    const routed = await inUnit(organizationId, async (database) => {
      const outbox = createOutboxRepository(database);
      const notifications = createNotificationRepository(database);
      const subscriptions = await outbox.matchingWebhookSubscriptions(event);
      const deliveryIds: string[] = [];
      for (const subscription of subscriptions) {
        deliveryIds.push(
          await outbox.ensureWebhookDelivery({
            organizationId: event.organizationId,
            subscriptionId: subscription.id,
            eventId: event.id,
          }),
        );
      }
      const { publicUrl } = workerSettings();
      const notificationIntents = [
        ...(await notifications.materializeRequestIntents(event.id, publicUrl)),
        ...(await notifications.materializeQuestionIntents(
          event.id,
          publicUrl,
        )),
        ...(await notifications.materializeInvitationIntents(
          event.id,
          publicUrl,
        )),
      ];
      return { deliveryIds, notificationIntents };
    });
    const { deliveryIds, notificationIntents } = routed;

    for (const deliveryId of deliveryIds) {
      await runner.enqueue("webhook-delivery", { deliveryId });
    }
    for (const intent of notificationIntents) {
      if (intent.channel === "email") {
        await runner.enqueue(
          "email-delivery",
          { intentId: intent.id },
          { idempotencyKey: `email:${intent.id}` },
        );
      } else if (intent.channel === "slack") {
        await runner.enqueue(
          "slack-question-delivery",
          { intentId: intent.id },
          { idempotencyKey: `slack:${intent.id}` },
        );
      }
    }
    logger.info("outbox.routed", {
      outboxId,
      eventId: event.id,
      status: "routed",
      count: deliveryIds.length + notificationIntents.length,
    });
    triggerMetrics.count(
      "notification.delivery_total",
      notificationIntents.length,
      {
        status: "materialized",
        taskId: "outbox-delivery",
      },
    );

    const completed = await inUnit(organizationId, (database) =>
      createOutboxRepository(database).markCompleted(outboxId, settlement),
    );
    if (!completed) {
      // The body overran its lease, or the row was claimed again under it.
      // Its effects stand, and may repeat under the claim that holds the row
      // now (timing.ts: claims re-check state, deliveries are keyed).
      logger.warn("outbox.settlement_refused", {
        outboxId,
        eventId: event.id,
        status: "superseded",
      });
      return superseded();
    }
    return {
      status: "routed",
      webhookDeliveries: deliveryIds,
      notificationIntents: notificationIntents.map((intent) => intent.id),
    };
  });
}
