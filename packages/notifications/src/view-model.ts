import { redactSensitiveText } from "@requestport/domain";
import { z } from "zod";

function safeText(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).transform(redactSensitiveText);
}

/**
 * A notification's deep link, kept exactly as given: https, or http on a
 * loopback host (localhost, *.localhost, 127.0.0.0/8, [::1]), the hosts the
 * issuer's rule admits over http (`isServableIssuerUrl`, @requestport/auth),
 * so that a self-hosted instance at its default public URL,
 * http://127.0.0.1:3200, links to itself (Plan 13, H.4; ruling 163, item 1).
 * No other http link and no other scheme is taken.
 */
function deepLinkField() {
  return z.url().refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "[::1]" ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host)
    );
  });
}

const requestFields = {
  requestId: z.uuid(),
  requestKey: safeText(64),
  requestTitle: safeText(240),
  targetProjectName: safeText(160),
  deepLink: deepLinkField(),
  recipientName: safeText(160),
};

const requestNotificationSchema = z
  .object({
    kind: z.literal("request"),
    ...requestFields,
    reason: safeText(1_000).optional(),
  })
  .strict();

const questionNotificationSchema = z
  .object({
    kind: z.literal("question"),
    ...requestFields,
    questionId: z.uuid(),
    question: safeText(2_000),
    choices: z.array(safeText(160)).max(8).default([]),
    allowFreeText: z.boolean().default(true),
    actionsEnabled: z.boolean().default(true),
    escalationAudience: z
      .enum(["project_maintainers", "organization_admins"])
      .nullable()
      .optional(),
    reason: safeText(1_000).optional(),
    deadlineAt: z.iso.datetime().optional(),
  })
  .strict();

const invitationNotificationSchema = z
  .object({
    kind: z.literal("invitation"),
    organizationName: safeText(160),
    role: z.enum(["owner", "admin", "member"]),
    deepLink: deepLinkField(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const notificationViewModelSchema = z.union([
  requestNotificationSchema,
  questionNotificationSchema,
  invitationNotificationSchema,
]);

export type NotificationViewModel = z.infer<typeof notificationViewModelSchema>;

export function parseNotificationViewModel(input: unknown) {
  return notificationViewModelSchema.parse(input);
}
