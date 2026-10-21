import "./database-surface.js";

import { scheduleDefinition } from "@requestport/jobs";
import { schedules } from "@trigger.dev/sdk";

import { triggerJobRunner } from "./job-runner.js";

const definition = scheduleDefinition("notification-delivery-repair");

export const notificationDeliveryRepair = schedules.task({
  id: definition.id,
  cron: definition.cron,
  run: () => definition.run(triggerJobRunner),
});
