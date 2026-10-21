import { createNotificationRepository } from "@requestport/db";

import { observeTaskResult } from "../observability.js";
import type { JobRunner } from "../port.js";
import { inUnit, workerSettings, workerStorages } from "../worker-storages.js";

/** The most reminder and escalation intents one run creates, as before. */
const maxIntentsPerRun = 500;

/**
 * Creates the reminder and escalation intents of every question due, and
 * starts their deliveries. Its steps (track-i2.md, "I.2b design" §3): the
 * due questions, their organisations and one instant of the database's
 * clock, from function 13 on the dispatcher's storage; per question, a unit
 * bound to its organisation that creates its intents at that instant; the
 * deliveries started between units.
 */
export const sendQuestionReminders = (runner: JobRunner) =>
  observeTaskResult("question-reminders", async () => {
    const due = await createNotificationRepository(
      workerStorages().dispatcher,
    ).dueQuestionReminders(200);
    let created = 0;
    for (const question of due) {
      const remaining = maxIntentsPerRun - created;
      if (remaining <= 0) break;
      const intents = await inUnit(question.organizationId, (database) =>
        createNotificationRepository(database).materializeQuestionReminder(
          workerSettings().publicUrl,
          question,
          remaining,
        ),
      );
      created += intents.length;
      for (const intent of intents) {
        await runner.enqueue(
          intent.channel === "email"
            ? "email-delivery"
            : "slack-question-delivery",
          { intentId: intent.id },
          { idempotencyKey: `reminder:${intent.channel}:${intent.id}` },
        );
      }
    }
    return { created };
  });
