import "./database-surface.js";

import { runSlackQuestionDelivery } from "@requestport/jobs";
import { task } from "@trigger.dev/sdk";

import { triggerJobRunner } from "./job-runner.js";

export const slackQuestionDelivery = task({
  id: "slack-question-delivery",
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 30_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
    randomize: true,
  },
  run: (payload: { intentId: string }) =>
    runSlackQuestionDelivery(payload, triggerJobRunner),
});
