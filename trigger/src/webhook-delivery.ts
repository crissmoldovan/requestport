import "./database-surface.js";

import { runWebhookDelivery, scheduleDefinition } from "@requestport/jobs";
import { schedules, task } from "@trigger.dev/sdk";

import { triggerJobRunner } from "./job-runner.js";

export const webhookDelivery = task({
  id: "webhook-delivery",
  retry: {
    maxAttempts: 6,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
    randomize: true,
  },
  run: (payload: { deliveryId: string }) =>
    runWebhookDelivery(payload, triggerJobRunner),
});

const repair = scheduleDefinition("webhook-delivery-repair");

export const webhookDeliveryRepair = schedules.task({
  id: repair.id,
  cron: repair.cron,
  run: () => repair.run(triggerJobRunner),
});
