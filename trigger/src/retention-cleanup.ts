import "./database-surface.js";

import { scheduleDefinition } from "@requestport/jobs";
import { schedules } from "@trigger.dev/sdk";

import { triggerJobRunner } from "./job-runner.js";

const definition = scheduleDefinition("retention-cleanup");

export const retentionCleanup = schedules.task({
  id: definition.id,
  cron: definition.cron,
  run: () => definition.run(triggerJobRunner),
});
