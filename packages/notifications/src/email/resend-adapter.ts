import { render } from "@react-email/render";
import { createElement } from "react";
import { Resend } from "resend";
import { parseNotificationViewModel } from "../view-model.js";
import { InvitationEmail } from "./invitation-email.js";
import { QuestionEmail } from "./question-email.js";
import { RequestEmail } from "./request-email.js";

export function createResendNotificationAdapter(input: {
  apiKey: string;
  from: string;
}) {
  const resend = new Resend(input.apiKey);
  return {
    async send(payload: { intentId: string; to: string; model: unknown }) {
      const model = parseNotificationViewModel(payload.model);
      const element =
        model.kind === "question"
          ? createElement(QuestionEmail, { model })
          : model.kind === "invitation"
            ? createElement(InvitationEmail, { model })
            : createElement(RequestEmail, { model });
      const html = await render(element);
      const result = await resend.emails.send(
        {
          from: input.from,
          to: payload.to,
          subject:
            model.kind === "question"
              ? `Input needed: ${model.requestKey} ${model.requestTitle}`
              : model.kind === "invitation"
                ? `You are invited to ${model.organizationName} on RequestPort`
                : `${model.requestKey}: ${model.requestTitle}`,
          html,
        },
        { idempotencyKey: `requestport-notification-${payload.intentId}` },
      );
      if (result.error || !result.data?.id)
        throw new Error("Notification email delivery failed");
      return { providerMessageId: result.data.id };
    },
    verifyWebhook(
      payload: string,
      headers: { id: string; timestamp: string; signature: string },
      webhookSecret: string,
    ) {
      return resend.webhooks.verify({ payload, headers, webhookSecret });
    },
  };
}
