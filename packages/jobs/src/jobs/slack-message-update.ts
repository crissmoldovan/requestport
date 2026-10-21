import { randomUUID } from "node:crypto";

import { createSlackRepository } from "@requestport/db";
import { z } from "zod";

import { observeTaskResult, triggerMetrics } from "../observability.js";
import type { JobPayloads, JobRunner } from "../port.js";
import { decryptSlackInstallationToken } from "../slack-encryption.js";
import {
  createSlackWebClient,
  withSlackRateLimit,
} from "../slack-rate-limit.js";
import { inUnit, workerStorages } from "../worker-storages.js";

const payloadSchema = z.object({
  channelId: z.string().min(1),
  messageTs: z.string().min(1),
  answerId: z.uuid(),
});

export const runSlackMessageUpdate = (
  { operationId }: JobPayloads["slack-message-update"],
  runner: JobRunner,
) =>
  observeTaskResult("slack-message-update", async () => {
    const leaseOwner = `slack-update:${randomUUID()}`;
    // Its steps (track-i2.md, "I.2b design" §3): the operation's
    // organisation from the resolver, a miss being the suppressed claim it
    // always was; a unit that claims it; the Slack call between units; a
    // unit that finishes it.
    const organizationId = await workerStorages().resolveJobOrganization(
      "slack_delivery_operation",
      operationId,
    );
    if (organizationId === null) return { status: "suppressed" };
    const slack = <T>(
      work: (
        repository: ReturnType<typeof createSlackRepository>,
      ) => Promise<T>,
    ) =>
      inUnit(organizationId, (database) =>
        work(createSlackRepository(database)),
      );
    const loaded = await slack((repository) =>
      repository.claimSlackDeliveryOperation({
        operationId,
        operationType: "message_update",
        leaseOwner,
      }),
    );
    if (!loaded) return { status: "suppressed" };
    try {
      const payload = payloadSchema.parse(loaded.operation.operationPayload);
      const token = await decryptSlackInstallationToken({
        organizationId: loaded.installation.organizationId,
        installationId: loaded.installation.id,
        envelope: loaded.installation.botTokenCiphertext,
      });
      const client = createSlackWebClient(token);
      await withSlackRateLimit(
        () =>
          client.chat.update({
            channel: payload.channelId,
            ts: payload.messageTs,
            text: "Answered in RequestPort",
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: "✅ *Answered in RequestPort*" },
              },
            ],
          }),
        (seconds) => runner.sleep(seconds),
      );
      await slack((repository) =>
        repository.finishSlackDeliveryOperation({
          operationId,
          operationType: "message_update",
          leaseOwner,
          delivered: true,
        }),
      );
      triggerMetrics.count("notification.delivery_total", 1, {
        status: "delivered",
        taskId: "slack-message-update",
      });
      return { status: "delivered" };
    } catch (error) {
      const status = await slack((repository) =>
        repository.finishSlackDeliveryOperation({
          operationId,
          operationType: "message_update",
          leaseOwner,
          delivered: false,
          errorCode: "provider_delivery_failed",
        }),
      );
      triggerMetrics.count("notification.delivery_total", 1, {
        status: status ?? "lease_lost",
        taskId: "slack-message-update",
      });
      throw error;
    }
  });

export const repairSlackMessageUpdates = (runner: JobRunner) =>
  observeTaskResult("slack-message-update-repair", async () => {
    const pending = await createSlackRepository(
      workerStorages().dispatcher,
    ).dueSlackDeliveryOperations("message_update");
    await Promise.all(
      pending.map((row) =>
        runner.enqueue("slack-message-update", { operationId: row.id }),
      ),
    );
    return { scheduled: pending.length };
  });
