import { createHmac, randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { normalizeSignupEmail } from "../signup-policy.js";
import { MagicLinkEmail } from "./magic-link-template.js";

type EmailPayload = {
  from: string;
  to: string;
  subject: string;
  react: ReactElement;
  headers: { "X-Entity-Ref-ID": string };
};

type SendEmail = (payload: EmailPayload) => Promise<{
  data: { id: string } | null;
  error: unknown;
}>;

type SafeLogFields = {
  correlationId: string;
  emailFingerprint: string;
  outcome: "sent" | "failed";
  providerMessageId?: string;
};

type SafeLogger = {
  info(fields: SafeLogFields): void;
  error(fields: SafeLogFields): void;
};

export function createMagicLinkSender({
  sendEmail,
  fingerprintKey,
  fromEmail,
  logger,
  randomId = randomUUID,
}: {
  sendEmail: SendEmail;
  fingerprintKey: string;
  fromEmail: string;
  logger: SafeLogger;
  randomId?: () => string;
}) {
  return async ({ email, url }: { email: string; url: string }) => {
    const correlationId = randomId();
    const emailFingerprint = createHmac("sha256", fingerprintKey)
      .update(normalizeSignupEmail(email))
      .digest("hex");
    const logBase = { correlationId, emailFingerprint };

    try {
      const result = await sendEmail({
        from: fromEmail,
        to: email,
        subject: "Sign in to RequestPort",
        react: MagicLinkEmail({ url }),
        headers: { "X-Entity-Ref-ID": correlationId },
      });
      if (result.error || !result.data?.id) {
        throw new Error("Email provider rejected request");
      }

      logger.info({
        ...logBase,
        outcome: "sent",
        providerMessageId: result.data.id,
      });
    } catch {
      logger.error({ ...logBase, outcome: "failed" });
      throw new Error("Unable to send sign-in link");
    }
  };
}
