import type { JobPayloads } from "@requestport/jobs";
import type { TaskPayload } from "@trigger.dev/sdk";
import { expectTypeOf, test } from "vitest";

import type { emailDelivery } from "./email-delivery.js";
import type { outboxDelivery } from "./outbox-delivery.js";
import type { slackConnectionTest } from "./slack-connection-test.js";
import type { slackMessageUpdate } from "./slack-message-update.js";
import type { slackQuestionDelivery } from "./slack-question-delivery.js";
import type { webhookDelivery } from "./webhook-delivery.js";

/**
 * The web application used to type each start against the task it started
 * (`tasks.trigger<typeof emailDelivery>`). It now starts jobs by name through
 * `@requestport/jobs`, so this keeps the two halves of that contract joined:
 * `tsc` fails here if a task's payload and the port's drift apart. The two
 * import tasks take `unknown` and parse it strictly, as they always have.
 */
test("every task takes the payload the job-runner port names for it", () => {
  expectTypeOf<TaskPayload<typeof outboxDelivery>>().toEqualTypeOf<
    JobPayloads["outbox-delivery"]
  >();
  expectTypeOf<TaskPayload<typeof webhookDelivery>>().toEqualTypeOf<
    JobPayloads["webhook-delivery"]
  >();
  expectTypeOf<TaskPayload<typeof emailDelivery>>().toEqualTypeOf<
    JobPayloads["email-delivery"]
  >();
  expectTypeOf<TaskPayload<typeof slackQuestionDelivery>>().toEqualTypeOf<
    JobPayloads["slack-question-delivery"]
  >();
  expectTypeOf<TaskPayload<typeof slackMessageUpdate>>().toEqualTypeOf<
    JobPayloads["slack-message-update"]
  >();
  expectTypeOf<TaskPayload<typeof slackConnectionTest>>().toEqualTypeOf<
    JobPayloads["slack-connection-test"]
  >();
});
