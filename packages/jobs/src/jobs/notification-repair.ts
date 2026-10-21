import { createNotificationRepository } from "@requestport/db";

import { observeTaskResult, triggerMetrics } from "../observability.js";
import type { JobRunner } from "../port.js";
import { workerStorages } from "../worker-storages.js";

export const repairNotificationDeliveries = (runner: JobRunner) =>
  observeTaskResult("notification-delivery-repair", async () => {
    // Function 6, on the dispatcher's storage (track-i2.md, "I.2b design" §3).
    const due = await createNotificationRepository(
      workerStorages().dispatcher,
    ).dueNotificationIntents(100);
    let accepted = 0;
    for (const intent of due) {
      if (intent.channel === "email") {
        await runner.enqueue("email-delivery", { intentId: intent.id });
        accepted += 1;
      } else if (intent.channel === "slack") {
        await runner.enqueue("slack-question-delivery", {
          intentId: intent.id,
        });
        accepted += 1;
      }
    }
    triggerMetrics.gauge("notification.repair_due", due.length, {
      taskId: "notification-delivery-repair",
    });
    return { due: due.length, accepted };
  });
