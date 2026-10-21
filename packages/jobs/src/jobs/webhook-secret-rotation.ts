import { randomUUID } from "node:crypto";

import { createWebhookRepository } from "@requestport/db";

import { observeTaskResult } from "../observability.js";
import { webhookAad, webhookEncryption } from "../webhook-encryption.js";
import { inUnit, workerStorages } from "../worker-storages.js";

/**
 * Promotes each webhook subscription's staged secret once its overlap has
 * ended. Its steps (track-i2.md, "I.2b design" §3): the due subscriptions'
 * ids and organisations from function 12 on the dispatcher's storage; per
 * subscription, a unit bound to its organisation that reads the staged
 * secret and its key id; the decryption and re-encryption between units; a
 * unit that promotes it.
 */
export const rotateWebhookSecrets = () =>
  observeTaskResult("webhook-secret-rotation", async () => {
    const due = await createWebhookRepository(
      workerStorages().dispatcher,
    ).listDueSecretPromotions();
    for (const { id, organizationId } of due) {
      const subscription = await inUnit(organizationId, (database) =>
        createWebhookRepository(database).loadDueSecretPromotion(
          organizationId,
          id,
        ),
      );
      if (!subscription) continue;
      const value = await webhookEncryption().decrypt<{ secret: string }>(
        subscription.nextSecretCiphertext,
        webhookAad(subscription.organizationId, subscription.id, "next"),
      );
      const currentEnvelope = await webhookEncryption().encrypt(
        value,
        webhookAad(subscription.organizationId, subscription.id, "current"),
      );
      await inUnit(organizationId, (database) =>
        createWebhookRepository(database).promoteSecret(
          {
            organizationId: subscription.organizationId,
            id: subscription.id,
            envelope: currentEnvelope,
            expectedNextSecretKeyId: subscription.nextSecretKeyId,
          },
          {
            actorType: "system",
            actorId: "trigger:webhook-secret-rotation",
            correlationId: randomUUID(),
          },
        ),
      );
    }
    return { promoted: due.length };
  });
