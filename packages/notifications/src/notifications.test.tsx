import { createHmac } from "node:crypto";

import { render } from "@react-email/render";
import { createElement } from "react";
import { describe, expect, test } from "vitest";

import { InvitationEmail } from "./email/invitation-email.js";
import { QuestionEmail } from "./email/question-email.js";
import {
  buildAnswerModal,
  modalAnswerBody,
  parseSlackInteraction,
} from "./slack/interactions.js";
import {
  createOpaqueSlackToken,
  hashSlackToken,
  verifySlackTokenHash,
} from "./slack/token-service.js";
import { verifySlackRequest } from "./slack/verify-request.js";
import { buildQuestionBlocks } from "./slack/view.js";
import {
  type NotificationViewModel,
  notificationViewModelSchema,
  parseNotificationViewModel,
} from "./view-model.js";

const questionModel: Extract<NotificationViewModel, { kind: "question" }> = {
  kind: "question",
  requestId: "018f0000-0000-7000-8000-000000000001",
  requestKey: "PORT-42",
  requestTitle: "Review & decide <now>",
  targetProjectName: "Harbour",
  deepLink:
    "https://requestport.com/requests/018f0000-0000-7000-8000-000000000001",
  recipientName: "Cristian",
  questionId: "018f0000-0000-7000-8000-000000000002",
  question: "Should <legacy> behavior remain?",
  choices: ["Keep", "Change"],
  allowFreeText: true,
  actionsEnabled: true,
};

describe("notification safe projection", () => {
  test("rejects unknown or auth-like fields and redacts private machine telemetry", () => {
    expect(() =>
      parseNotificationViewModel({ ...questionModel, token: "secret-value" }),
    ).toThrow();
    expect(() =>
      parseNotificationViewModel({
        ...questionModel,
        url: "https://example.com/token",
      }),
    ).toThrow();
    expect(
      parseNotificationViewModel({
        ...questionModel,
        question: "hostname=private-builder.internal",
      }),
    ).toMatchObject({
      question: "[Sensitive content omitted — open RequestPort]",
    });
  });

  test("renders question and invitation emails without authentication credentials", async () => {
    const questionHtml = await render(
      createElement(QuestionEmail, { model: questionModel }),
    );
    const invitationModel: Extract<
      NotificationViewModel,
      { kind: "invitation" }
    > = {
      kind: "invitation",
      organizationName: "CUE++",
      role: "member",
      deepLink: "https://requestport.com/sign-in",
      expiresAt: "2026-08-20T12:00:00.000Z",
    };
    const invitationHtml = await render(
      createElement(InvitationEmail, { model: invitationModel }),
    );
    expect(questionHtml).toContain("PORT-42");
    expect(questionHtml).toContain("Answer in RequestPort");
    expect(questionHtml).not.toMatch(
      /api[_-]?key|magic[- ]?link token|hostname=/iu,
    );
    expect(invitationHtml).toContain(
      "The invitation contains no sign-in token",
    );
    expect(invitationHtml).not.toContain("token=");
  });
});

/*
 * A notification's deep link (Plan 13, H.4; ruling 163, item 1): https, as
 * production's public URL makes it, or http on a loopback host, as a
 * self-host's default public URL, http://127.0.0.1:3200, makes it. Each row
 * is held to the request, question and invitation models alike.
 */
describe("notification deep links", () => {
  const models = {
    request: (deepLink: string) => ({
      kind: "request",
      requestId: questionModel.requestId,
      requestKey: questionModel.requestKey,
      requestTitle: questionModel.requestTitle,
      targetProjectName: questionModel.targetProjectName,
      deepLink,
      recipientName: questionModel.recipientName,
    }),
    question: (deepLink: string) => ({ ...questionModel, deepLink }),
    invitation: (deepLink: string) => ({
      kind: "invitation",
      organizationName: "CUE++",
      role: "member",
      deepLink,
      expiresAt: "2026-08-20T12:00:00.000Z",
    }),
  };
  /** Each model's answer for `deepLink`: the link it keeps, or "refused". */
  const answers = (deepLink: string) =>
    Object.fromEntries(
      Object.entries(models).map(([kind, model]) => {
        const parsed = notificationViewModelSchema.safeParse(model(deepLink));
        return [kind, parsed.success ? parsed.data.deepLink : "refused"];
      }),
    );
  const kept = (deepLink: string) => ({
    request: deepLink,
    question: deepLink,
    invitation: deepLink,
  });
  const refused = {
    request: "refused",
    question: "refused",
    invitation: "refused",
  };

  test.each([
    "http://127.0.0.1:3200/sign-in",
    "http://127.0.0.1:3200/requests/018f0000-0000-7000-8000-000000000001",
    "http://127.1.2.3/sign-in",
    "http://localhost:3200/sign-in",
    "http://localhost.:3200/sign-in",
    "http://requestport.localhost:3200/sign-in",
    "http://[::1]:3200/sign-in",
  ])("keeps %s: http on a loopback host, as the issuer admits it", (link) => {
    expect(answers(link)).toEqual(kept(link));
  });

  test.each([
    "http://requestport.com/sign-in",
    "http://example.com:3200/sign-in",
    "http://10.0.0.5:3200/sign-in",
    "http://192.168.1.10/sign-in",
    "http://0.0.0.0:3200/sign-in",
    "http://[::ffff:127.0.0.1]/sign-in",
    "http://127.0.0.1.example.com/sign-in",
    "http://localhost.example.com/sign-in",
    "http://notlocalhost/sign-in",
    "ftp://127.0.0.1/sign-in",
    "ws://127.0.0.1:3200/sign-in",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %s: http on any other host, and any other scheme", (link) => {
    expect(answers(link)).toEqual(refused);
  });

  test.each([
    "https://requestport.com/requests/018f0000-0000-7000-8000-000000000001",
    "https://requestport.com/sign-in",
    "https://requestport.com",
    "https://REQUESTPORT.com/Sign-In",
    "https://example.com:8443/requests/x?tab=answers",
    "https://127.0.0.1:3200/sign-in",
  ])(
    "keeps %s exactly as given, as production's https links always were",
    (link) => {
      expect(answers(link)).toEqual(kept(link));
    },
  );
});

describe("Slack request and token security", () => {
  test("verifies an exact current signature and rejects stale or malformed signatures", () => {
    const rawBody = "payload=%7B%22type%22%3A%22block_actions%22%7D";
    const timestamp = 1_800_000_000;
    const secret = "slack-signing-secret";
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
    expect(
      verifySlackRequest({
        rawBody,
        timestamp: String(timestamp),
        signature,
        signingSecret: secret,
        now: timestamp,
      }),
    ).toBe(true);
    expect(
      verifySlackRequest({
        rawBody,
        timestamp: String(timestamp),
        signature,
        signingSecret: secret,
        now: timestamp + 301,
      }),
    ).toBe(false);
    expect(
      verifySlackRequest({
        rawBody,
        timestamp: String(timestamp),
        signature: `${signature}00`,
        signingSecret: secret,
        now: timestamp,
      }),
    ).toBe(false);
  });

  /**
   * The comparison itself, which nothing else reaches.
   *
   * The case above looks like it covers this and does not. Its stale signature
   * exits on the freshness window and its malformed one exits on the shape
   * regex, so both are refused before a digest is ever computed — and the only
   * signature that reaches the comparison is the correct one. Replacing the
   * whole comparison with `return true` left that case, and the entire package
   * suite, green.
   *
   * Every signature below is well-formed and fresh, so each one arrives at the
   * comparison and is refused only because the digest does not match. Each also
   * names one input of the base string `v0:{timestamp}:{body}`, so a digest
   * that stopped keying on the body, the timestamp or the secret fails here
   * rather than silently accepting a forgery.
   */
  test("refuses a well-formed signature that is not the right one", () => {
    const rawBody = "payload=%7B%22type%22%3A%22block_actions%22%7D";
    const timestamp = 1_800_000_000;
    const secret = "slack-signing-secret";
    const sign = (body: string, at: number, signingSecret: string) =>
      `v0=${createHmac("sha256", signingSecret).update(`v0:${at}:${body}`).digest("hex")}`;
    const wellFormed = {
      rawBody,
      signingSecret: secret,
      timestamp: String(timestamp),
      now: timestamp,
    };

    // An attacker's own hex of the right shape.
    expect(
      verifySlackRequest({ ...wellFormed, signature: `v0=${"a".repeat(64)}` }),
    ).toBe(false);
    // The right secret and moment, a different body.
    expect(
      verifySlackRequest({
        ...wellFormed,
        signature: sign(
          "payload=%7B%22type%22%3A%22other%22%7D",
          timestamp,
          secret,
        ),
      }),
    ).toBe(false);
    // The right body and secret, a moment still inside the window.
    expect(
      verifySlackRequest({
        ...wellFormed,
        signature: sign(rawBody, timestamp + 60, secret),
      }),
    ).toBe(false);
    // Everything right but the secret.
    expect(
      verifySlackRequest({
        ...wellFormed,
        signature: sign(rawBody, timestamp, "not-the-signing-secret"),
      }),
    ).toBe(false);
  });

  test("creates opaque tokens and compares only canonical hashes", () => {
    const token = createOpaqueSlackToken();
    const hash = hashSlackToken("state-secret", token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(verifySlackTokenHash("state-secret", token, hash)).toBe(true);
    expect(verifySlackTokenHash("state-secret", `${token}x`, hash)).toBe(false);
    expect(verifySlackTokenHash("state-secret", token, "not-a-hash")).toBe(
      false,
    );
  });
});

describe("Slack HITL views", () => {
  test("escapes mrkdwn and splits actions into Slack-sized groups", () => {
    const blocks = buildQuestionBlocks({
      model: { ...questionModel, choices: ["1", "2", "3", "4", "5", "6"] },
      answerTokens: ["1", "2", "3", "4", "5", "6"].map((label) => ({
        label,
        token: `token-${label}`,
      })),
      modalToken: "modal-token",
    });
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("Review &amp; decide &lt;now&gt;");
    expect(blocks.filter((block) => block.type === "actions")).toHaveLength(2);
    expect(serialized).toContain("Open canonical request in RequestPort");
  });

  test("parses only bounded interaction shapes and extracts trimmed modal text", () => {
    const interaction = parseSlackInteraction({
      type: "view_submission",
      team: { id: "T012" },
      user: { id: "U012" },
      view: {
        private_metadata: "x".repeat(32),
        state: { values: { answer: { body: { value: "  Approved  " } } } },
      },
    });
    expect(interaction.type).toBe("view_submission");
    if (interaction.type === "view_submission") {
      expect(modalAnswerBody(interaction)).toBe("Approved");
    }
    expect(() =>
      parseSlackInteraction({
        type: "block_actions",
        team: {},
        user: {},
        actions: [],
      }),
    ).toThrow();
    expect(
      buildAnswerModal({ token: "x".repeat(32), requestKey: "PORT-42" }),
    ).toMatchObject({
      type: "modal",
      private_metadata: "x".repeat(32),
    });
  });
});
