import "./database-surface.js";

import { runEmailDelivery } from "@requestport/jobs";
import { task } from "@trigger.dev/sdk";

export const emailDelivery = task({
  id: "email-delivery",
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 30_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
    randomize: true,
  },
  run: (payload: { intentId: string }) => runEmailDelivery(payload),
});
