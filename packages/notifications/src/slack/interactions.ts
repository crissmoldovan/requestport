import { utf16Max, utf16Min } from "@requestport/domain";
import { z } from "zod";

const userSchema = z.object({ id: z.string().min(1).check(utf16Max(64)) });
const teamSchema = z.object({ id: z.string().min(1).check(utf16Max(64)) });

const blockActionSchema = z.object({
  type: z.literal("block_actions"),
  team: teamSchema,
  user: userSchema,
  trigger_id: z.string().min(1).check(utf16Max(255)),
  actions: z
    .array(
      z.object({
        action_id: z.enum(["requestport_answer", "requestport_other"]),
        value: z.string().check(utf16Min(20)).check(utf16Max(512)),
      }),
    )
    .length(1),
  container: z
    .object({
      channel_id: z.string().optional(),
      message_ts: z.string().optional(),
    })
    .optional(),
});

const modalSubmissionSchema = z.object({
  type: z.literal("view_submission"),
  team: teamSchema,
  user: userSchema,
  view: z.object({
    private_metadata: z.string().check(utf16Min(20)).check(utf16Max(512)),
    state: z.object({
      values: z.record(
        z.string(),
        z.record(
          z.string(),
          z.object({ value: z.string().nullable().optional() }),
        ),
      ),
    }),
  }),
});

export type SlackInteraction =
  | z.infer<typeof blockActionSchema>
  | z.infer<typeof modalSubmissionSchema>;

export function parseSlackInteraction(raw: unknown): SlackInteraction {
  return z
    .discriminatedUnion("type", [blockActionSchema, modalSubmissionSchema])
    .parse(raw);
}

export function modalAnswerBody(
  interaction: Extract<SlackInteraction, { type: "view_submission" }>,
) {
  for (const block of Object.values(interaction.view.state.values)) {
    for (const value of Object.values(block)) {
      const text = value.value?.trim();
      if (text) return z.string().min(1).check(utf16Max(10_000)).parse(text);
    }
  }
  throw new Error("A Slack answer is required");
}

export function buildAnswerModal(input: { token: string; requestKey: string }) {
  return {
    type: "modal" as const,
    callback_id: "requestport_answer_modal",
    private_metadata: input.token,
    title: { type: "plain_text" as const, text: "Answer question" },
    submit: { type: "plain_text" as const, text: "Submit" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "input" as const,
        block_id: "requestport_answer_block",
        label: {
          type: "plain_text" as const,
          text: input.requestKey.slice(0, 100),
        },
        element: {
          type: "plain_text_input" as const,
          action_id: "requestport_answer_body",
          multiline: true,
          max_length: 10_000,
        },
      },
    ],
  };
}
