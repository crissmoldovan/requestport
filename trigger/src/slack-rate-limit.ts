import { withSlackRateLimit as retryRateLimited } from "@requestport/jobs";

import { triggerJobRunner } from "./job-runner.js";

export { createSlackWebClient } from "@requestport/jobs";

/** Retries a rate-limited Slack call through Trigger.dev's `wait.for`. */
export function withSlackRateLimit<T>(operation: () => Promise<T>) {
  return retryRateLimited(operation, (seconds) =>
    triggerJobRunner.sleep(seconds),
  );
}
