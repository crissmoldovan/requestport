import "./database-surface.js";

import { runSlackConnectionTest, scheduleDefinition } from "@requestport/jobs";
import { schedules, task } from "@trigger.dev/sdk";

import { triggerJobRunner } from "./job-runner.js";

export const slackConnectionTest = task({
  id: "slack-connection-test",
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 30_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
    randomize: true,
  },
  run: (payload: { operationId: string }) =>
    runSlackConnectionTest(payload, triggerJobRunner),
});

const repair = scheduleDefinition("slack-connection-test-repair");

export const slackConnectionTestRepair = schedules.task({
  id: repair.id,
  cron: repair.cron,
  run: () => repair.run(triggerJobRunner),
});
