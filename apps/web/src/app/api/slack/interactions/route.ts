import { serverEnv } from "@requestport/config/server";
import { createSlackRepository } from "@requestport/db";
import { DomainError } from "@requestport/domain";
import {
  buildAnswerModal,
  modalAnswerBody,
  parseSlackInteraction,
  verifySlackRequest,
} from "@requestport/notifications/slack";
import { WebClient } from "@slack/web-api";
import { NextResponse } from "next/server";
import {
  assertJsonDepth,
  RequestTooLargeError,
  readBoundedRequestText,
} from "../../../../lib/security/input-limits.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../../lib/security/rate-limit.js";
import { webStorage } from "../../../../lib/server-request-port.js";
import {
  answerSlackQuestion,
  decryptSlackBotToken,
  prepareSlackAnswerModal,
} from "../../../../lib/server-slack.js";
import { triggerSlackMessageUpdate } from "../../../../lib/trigger-client.js";

const MAX_BODY_BYTES = 256 * 1_024;

function permanentError(interactionType: "block_actions" | "view_submission") {
  return interactionType === "view_submission"
    ? NextResponse.json({
        response_action: "errors",
        errors: {
          requestport_answer_block:
            "This action is unavailable. Reopen the question in RequestPort.",
        },
      })
    : NextResponse.json({
        response_type: "ephemeral",
        text: "This action is unavailable. Reopen the question in RequestPort.",
      });
}

async function submitDurableMessageUpdate(operationId: string | null) {
  if (!operationId) return;
  try {
    await triggerSlackMessageUpdate(operationId);
  } catch {
    // The answer and the message-update operation are already committed. Slack
    // must receive a successful acknowledgement; the scheduled repair task is
    // the durable retry path for a failed Trigger submission.
  }
}

export async function POST(request: Request) {
  if (!serverEnv.REQUESTPORT_SLACK_SIGNING_SECRET)
    return new NextResponse("Not configured", { status: 503 });
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/x-www-form-urlencoded"
  ) {
    return new NextResponse("Unsupported media type", { status: 415 });
  }
  let rawBody: string;
  try {
    rawBody = await readBoundedRequestText(request, MAX_BODY_BYTES);
  } catch (error) {
    return new NextResponse(
      error instanceof RequestTooLargeError
        ? "Payload too large"
        : "Invalid payload",
      { status: error instanceof RequestTooLargeError ? 413 : 400 },
    );
  }
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  if (
    !verifySlackRequest({
      rawBody,
      timestamp,
      signature,
      signingSecret: serverEnv.REQUESTPORT_SLACK_SIGNING_SECRET,
    })
  ) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  let interaction: ReturnType<typeof parseSlackInteraction>;
  try {
    const payload = new URLSearchParams(rawBody).get("payload");
    const parsed = JSON.parse(payload ?? "null") as unknown;
    assertJsonDepth(parsed);
    interaction = parseSlackInteraction(parsed);
  } catch {
    return new NextResponse("Invalid payload", { status: 400 });
  }
  try {
    await enforceRateLimit({
      endpointClass: "slack_workspace",
      fingerprint: rateLimitFingerprint(interaction.team.id),
    });
    await enforceRateLimit({
      endpointClass: "slack_user",
      fingerprint: rateLimitFingerprint(
        interaction.team.id,
        interaction.user.id,
      ),
    });
    if (interaction.type === "block_actions") {
      const action = interaction.actions[0];
      if (!action) return permanentError(interaction.type);
      if (action.action_id === "requestport_answer") {
        const result = await answerSlackQuestion({
          rawToken: action.value,
          tokenType: "answer",
          workspaceId: interaction.team.id,
          slackUserId: interaction.user.id,
          channelId: interaction.container?.channel_id,
          messageTs: interaction.container?.message_ts,
        });
        // The canonical answer and its durable update operation are committed
        // before this point. Do not put Trigger's network latency on Slack's
        // three-second acknowledgement path; the scheduled repair task owns
        // recovery when this best-effort submission cannot finish in-process.
        void submitDurableMessageUpdate(result.operationId);
        return new NextResponse(null, { status: 200 });
      }
      const modal = await prepareSlackAnswerModal({
        rawToken: action.value,
        workspaceId: interaction.team.id,
        slackUserId: interaction.user.id,
        channelId: interaction.container?.channel_id,
        messageTs: interaction.container?.message_ts,
      });
      const storage = webStorage();
      const installation = await createSlackRepository(
        storage.db,
      ).loadInstallation(modal.organizationId, modal.installationId);
      if (!installation) return permanentError(interaction.type);
      const token = await decryptSlackBotToken({
        organizationId: modal.organizationId,
        installationId: modal.installationId,
        envelope: installation.botTokenCiphertext,
      });
      await new WebClient(token, {
        rejectRateLimitedCalls: true,
        timeout: 2_500,
      }).views.open({
        trigger_id: interaction.trigger_id,
        view: buildAnswerModal({
          token: modal.submitToken,
          requestKey: modal.requestKey,
        }),
      });
      return new NextResponse(null, { status: 200 });
    }
    const result = await answerSlackQuestion({
      rawToken: interaction.view.private_metadata,
      tokenType: "modal_submit",
      workspaceId: interaction.team.id,
      slackUserId: interaction.user.id,
      bodyMd: modalAnswerBody(interaction),
    });
    void submitDurableMessageUpdate(result.operationId);
    return new NextResponse(null, { status: 200 });
  } catch (error) {
    if (error instanceof DomainError && error.code === "rate_limited") {
      return new NextResponse("Too many requests", {
        status: 429,
        headers:
          typeof error.details.retryAfterSeconds === "number"
            ? { "retry-after": String(error.details.retryAfterSeconds) }
            : undefined,
      });
    }
    if (
      error instanceof DomainError &&
      ["forbidden", "not_found", "conflict", "validation_failed"].includes(
        error.code,
      )
    ) {
      return permanentError(interaction.type);
    }
    return new NextResponse("Interaction failed", { status: 500 });
  }
}
