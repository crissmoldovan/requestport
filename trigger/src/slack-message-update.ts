import "./database-surface.js";

import { runSlackMessageUpdate, scheduleDefinition } from "@requestport/jobs";
import { schedules, task } from "@trigger.dev/sdk";

import { triggerJobRunner } from "./job-runner.js";

export const slackMessageUpdate = task({
  id: "slack-message-update",
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 30_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
    randomize: true,
  },
  run: (payload: { operationId: string }) =>
    runSlackMessageUpdate(payload, triggerJobRunner),
});

const repair = scheduleDefinition("slack-message-update-repair");

export const slackMessageUpdateRepair = schedules.task({
  id: repair.id,
  cron: repair.cron,
  run: () => repair.run(triggerJobRunner),
});
