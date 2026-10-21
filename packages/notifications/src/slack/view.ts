import { parseNotificationViewModel } from "../view-model.js";

function escapeMrkdwn(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildQuestionBlocks(input: {
  model: unknown;
  answerTokens: Array<{ label: string; token: string }>;
  modalToken?: string;
}) {
  const model = parseNotificationViewModel(input.model);
  if (model.kind !== "question")
    throw new Error("Slack question view requires question model");
  const elements = [
    ...input.answerTokens.map((answer) => ({
      type: "button" as const,
      text: { type: "plain_text" as const, text: answer.label.slice(0, 75) },
      action_id: "requestport_answer",
      value: answer.token,
    })),
    ...(model.allowFreeText && input.modalToken
      ? [
          {
            type: "button" as const,
            text: { type: "plain_text" as const, text: "Other…" },
            action_id: "requestport_other",
            value: input.modalToken,
          },
        ]
      : []),
  ];
  const actionBlocks = Array.from(
    { length: Math.ceil(elements.length / 5) },
    (_, index) => ({
      type: "actions" as const,
      elements: elements.slice(index * 5, index * 5 + 5),
    }),
  );
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Input needed · ${model.requestKey}`.slice(0, 150),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeMrkdwn(model.requestTitle)}*\n${escapeMrkdwn(model.targetProjectName)}\n\n${escapeMrkdwn(model.question ?? "")}`,
      },
    },
    ...(model.actionsEnabled ? actionBlocks : []),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${model.deepLink}|Open canonical request in RequestPort>`,
        },
      ],
    },
  ];
}
