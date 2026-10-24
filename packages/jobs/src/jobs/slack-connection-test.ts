import { randomUUID } from "node:crypto";

import { createSlackRepository } from "@requestport/db";
import { utf16Max } from "@requestport/domain";
import type { ChatPostMessageArguments } from "@slack/web-api";
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
  channelId: z.string().min(1).check(utf16Max(64)),
});

export const runSlackConnectionTest = (
  { operationId }: JobPayloads["slack-connection-test"],
  runner: JobRunner,
) =>
  observeTaskResult("slack-connection-test", async () => {
    const leaseOwner = `slack-test:${randomUUID()}`;
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
        operationType: "connection_test",
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
      const message: ChatPostMessageArguments & { client_msg_id: string } = {
        channel: payload.channelId,
        client_msg_id: operationId,
        text: "RequestPort Slack connection test succeeded.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "✅ *RequestPort Slack connection test succeeded.*",
            },
          },
        ],
      };
      const result = await withSlackRateLimit(
        () => client.chat.postMessage(message),
        (seconds) => runner.sleep(seconds),
      );
      await slack((repository) =>
        repository.finishSlackDeliveryOperation({
          operationId,
          operationType: "connection_test",
          leaseOwner,
          delivered: true,
          providerMessageTs: result.ts,
        }),
      );
      triggerMetrics.count("notification.delivery_total", 1, {
        status: "delivered",
        taskId: "slack-connection-test",
      });
      return { status: "delivered" };
    } catch (error) {
      const status = await slack((repository) =>
        repository.finishSlackDeliveryOperation({
          operationId,
          operationType: "connection_test",
          leaseOwner,
          delivered: false,
          errorCode: "provider_delivery_failed",
        }),
      );
      triggerMetrics.count("notification.delivery_total", 1, {
        status: status ?? "lease_lost",
        taskId: "slack-connection-test",
      });
      throw error;
    }
  });

export const repairSlackConnectionTests = (runner: JobRunner) =>
  observeTaskResult("slack-connection-test-repair", async () => {
    const pending = await createSlackRepository(
      workerStorages().dispatcher,
    ).dueSlackDeliveryOperations("connection_test");
    await Promise.all(
      pending.map((operation) =>
        runner.enqueue("slack-connection-test", { operationId: operation.id }),
      ),
    );
    return { scheduled: pending.length };
  });
