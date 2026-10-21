import "./database-surface.js";

import { scheduleDefinition } from "@requestport/jobs";
import { schedules } from "@trigger.dev/sdk";

import { triggerJobRunner } from "./job-runner.js";

const definition = scheduleDefinition("operational-metrics");

export const operationalMetrics = schedules.task({
  id: definition.id,
  cron: definition.cron,
  run: () => definition.run(triggerJobRunner),
});
