import { randomUUID } from "node:crypto";

import {
  createNotificationRepository,
  createSlackRepository,
} from "@requestport/db";
import {
  buildQuestionBlocks,
  createOpaqueSlackToken,
  hashSlackToken,
} from "@requestport/notifications/slack";
import { parseNotificationViewModel } from "@requestport/notifications/view-model";
import type { ChatPostMessageArguments } from "@slack/web-api";

import { observeTaskResult, triggerMetrics } from "../observability.js";
import type { JobPayloads, JobRunner } from "../port.js";
import {
  decryptSlackInstallationToken,
  slackTokenSecret,
} from "../slack-encryption.js";
import {
  createSlackWebClient,
  withSlackRateLimit,
} from "../slack-rate-limit.js";
import { inUnit, workerStorages } from "../worker-storages.js";

async function actionToken(
  slack: ReturnType<typeof createSlackRepository>,
  input: {
    organizationId: string;
    questionId: string;
    installationId: string;
    slackUserId: string | null;
    tokenType: "answer" | "modal_launch";
    payload: Record<string, string>;
  },
) {
  const raw = createOpaqueSlackToken();
  await slack.createActionToken({
    id: randomUUID(),
    organizationId: input.organizationId,
    questionId: input.questionId,
    installationId: input.installationId,
    slackUserId: input.slackUserId,
    tokenType: input.tokenType,
    tokenHash: hashSlackToken(slackTokenSecret(), raw),
    actionPayload: input.payload,
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
  });
  return raw;
}

/**
 * One Slack question. Its steps (track-i2.md, "I.2b design" §3): the
 * intent's organisation from the resolver, a miss being `not_due`; a unit
 * that claims and loads it, and suppresses it when it is not deliverable;
 * the token's decryption and `conversations.open` between units; per
 * destination, a unit that creates the delivery and its action tokens, the
 * post between units, and a unit that finishes the delivery; a unit that
 * completes the intent, or, on failure, fails the delivery and the intent.
 */
export const runSlackQuestionDelivery = (
  { intentId }: JobPayloads["slack-question-delivery"],
  runner: JobRunner,
) =>
  observeTaskResult("slack-question-delivery", async () => {
    const organizationId = await workerStorages().resolveJobOrganization(
      "notification_intent",
      intentId,
    );
    if (organizationId === null) return { status: "not_due" };
    const unit = <T>(
      work: (repositories: {
        notifications: ReturnType<typeof createNotificationRepository>;
        slack: ReturnType<typeof createSlackRepository>;
      }) => Promise<T>,
    ) =>
      inUnit(organizationId, (database) =>
        work({
          notifications: createNotificationRepository(database),
          slack: createSlackRepository(database),
        }),
      );
    const leaseOwner = `slack:${randomUUID()}`;
    const opened = await unit(async ({ notifications, slack }) => {
      const claim = await notifications.claimNotificationIntent({
        intentId,
        channel: "slack",
        leaseOwner,
      });
      if (!claim) return { status: "not_due" as const };
      const loaded = await slack.loadPendingSlackIntent(intentId, leaseOwner);
      if (!loaded) {
        await notifications.suppressPendingIntent(
          intentId,
          "slack",
          leaseOwner,
        );
        return { status: "suppressed" as const };
      }
      return { status: "claimed" as const, claim, loaded };
    });
    if (opened.status !== "claimed") return { status: opened.status };
    const { claim, loaded } = opened;
    let currentDeliveryId: string | null = null;
    try {
      if (!loaded.intent.questionId) {
        throw new Error("invalid_notification_intent");
      }
      const model = parseNotificationViewModel(loaded.intent.viewModel);
      if (model.kind !== "question") {
        throw new Error("invalid_notification_view_model");
      }
      const token = await decryptSlackInstallationToken({
        organizationId: loaded.intent.organizationId,
        installationId: loaded.installation.id,
        envelope: loaded.installation.botTokenCiphertext,
      });
      const client = createSlackWebClient(token);
      const destinations: Array<{
        channelId: string;
        boundSlackUserId: string | null;
      }> = [];
      const mode = loaded.route?.mode ?? "dm";
      if (mode === "dm" || mode === "both") {
        const opened = await withSlackRateLimit(
          () =>
            client.conversations.open({
              users: loaded.slackUserId,
              return_im: false,
            }),
          (seconds) => runner.sleep(seconds),
        );
        const channelId = opened.channel?.id;
        if (!channelId) throw new Error("provider_response_invalid");
        destinations.push({
          channelId,
          boundSlackUserId: loaded.slackUserId,
        });
      }
      if ((mode === "channel" || mode === "both") && loaded.route?.channelId) {
        destinations.push({
          channelId: loaded.route.channelId,
          boundSlackUserId: null,
        });
      }
      if (!destinations.length) {
        await unit(({ notifications }) =>
          notifications.completeNotificationIntent(
            intentId,
            "slack",
            leaseOwner,
            "suppressed",
          ),
        );
        return { status: "suppressed", reason: "route_unavailable" };
      }
      const questionId = loaded.intent.questionId;
      const delivered: string[] = [];
      for (const destination of destinations) {
        // The delivery and its action tokens in one unit. The tokens were
        // made at once (`Promise.all`) before the units; one transaction
        // runs one statement at a time, so here they are made in turn.
        const prepared = await unit(async ({ slack }) => {
          const delivery = await slack.ensureSlackDelivery({
            organizationId: loaded.intent.organizationId,
            intentId,
            installationId: loaded.installation.id,
            channelId: destination.channelId,
          });
          // As before the units: a failure from here on fails this delivery.
          currentDeliveryId = delivery.id;
          if (delivery.status === "delivered" && delivery.messageTs) {
            return { delivery, answerTokens: [], modalToken: undefined };
          }
          const answerTokens: Array<{ label: string; token: string }> = [];
          if (model.actionsEnabled) {
            for (const label of model.choices) {
              answerTokens.push({
                label,
                token: await actionToken(slack, {
                  organizationId: loaded.intent.organizationId,
                  questionId,
                  installationId: loaded.installation.id,
                  slackUserId: destination.boundSlackUserId,
                  tokenType: "answer",
                  payload: { bodyMd: label },
                }),
              });
            }
          }
          const modalToken =
            model.actionsEnabled && model.allowFreeText
              ? await actionToken(slack, {
                  organizationId: loaded.intent.organizationId,
                  questionId,
                  installationId: loaded.installation.id,
                  slackUserId: destination.boundSlackUserId,
                  tokenType: "modal_launch",
                  payload: {
                    requestKey: String(
                      loaded.intent.viewModel.requestKey ??
                        "RequestPort question",
                    ),
                  },
                })
              : undefined;
          return { delivery, answerTokens, modalToken };
        });
        const { delivery, answerTokens, modalToken } = prepared;
        if (delivery.status === "delivered" && delivery.messageTs) {
          delivered.push(delivery.id);
          currentDeliveryId = null;
          continue;
        }
        const message: ChatPostMessageArguments & { client_msg_id: string } = {
          channel: destination.channelId,
          client_msg_id: delivery.id,
          text: `Input needed for ${String(loaded.intent.viewModel.requestKey ?? "RequestPort")}`,
          blocks: buildQuestionBlocks({
            model: loaded.intent.viewModel,
            answerTokens,
            modalToken,
          }),
        };
        const sent = await withSlackRateLimit(
          () => client.chat.postMessage(message),
          (seconds) => runner.sleep(seconds),
        );
        if (!sent.ts) throw new Error("provider_response_invalid");
        const messageTs = sent.ts;
        const persisted = await unit(({ slack }) =>
          slack.finishSlackDelivery({
            intentId,
            deliveryId: delivery.id,
            leaseOwner,
            status: "delivered",
            messageTs,
          }),
        );
        if (!persisted) throw new Error("delivery_lease_lost");
        delivered.push(delivery.id);
        currentDeliveryId = null;
      }
      const completed = await unit(({ notifications }) =>
        notifications.completeNotificationIntent(
          intentId,
          "slack",
          leaseOwner,
          "delivered",
        ),
      );
      if (!completed) throw new Error("delivery_lease_lost");
      triggerMetrics.count("notification.delivery_total", delivered.length, {
        status: "delivered",
        taskId: "slack-question-delivery",
      });
      return { status: "delivered", deliveryIds: delivered };
    } catch (error) {
      const failedDeliveryId = currentDeliveryId;
      await unit(async ({ notifications, slack }) => {
        if (failedDeliveryId) {
          await slack.finishSlackDelivery({
            intentId,
            deliveryId: failedDeliveryId,
            leaseOwner,
            status: "failed",
          });
        }
        await notifications.failNotificationIntent({
          intentId,
          channel: "slack",
          leaseOwner,
          attemptCount: claim.attemptCount,
          errorCode: "provider_delivery_failed",
        });
      });
      triggerMetrics.count("notification.delivery_total", 1, {
        status: "failed",
        taskId: "slack-question-delivery",
      });
      throw error;
    }
  });
