import { describe, expect, test } from "vitest";

import { modalAnswerBody, parseSlackInteraction } from "./interactions.js";

/*
  A Slack answer is measured as zod 4.4.3 measured it for RequestPort 0.2.0,
  in UTF-16 code units, though the workspace runs zod 4.6.7, which counts
  code points.
*/

const emoji = "\u{1F600}";

function submission(answer: string, metadata = "x".repeat(32)) {
  return parseSlackInteraction({
    type: "view_submission",
    team: { id: "T012" },
    user: { id: "U012" },
    view: {
      private_metadata: metadata,
      state: { values: { answer: { body: { value: answer } } } },
    },
  });
}

describe("a Slack answer's bounds, in UTF-16 code units", () => {
  test("5,000 emoji, 10,000 units, are an answer; 5,001 are over it", () => {
    const fits = submission(emoji.repeat(5_000));
    if (fits.type !== "view_submission") throw new Error("not a submission");
    expect(modalAnswerBody(fits)).toBe(emoji.repeat(5_000));

    const over = submission(emoji.repeat(5_001));
    if (over.type !== "view_submission") throw new Error("not a submission");
    expect(() => modalAnswerBody(over)).toThrow(
      /Too big: expected string to have <=10000 characters/,
    );
  });

  test("ten emoji, twenty units, are private metadata long enough", () => {
    expect(submission("Approved", emoji.repeat(10)).type).toBe(
      "view_submission",
    );
  });
});
