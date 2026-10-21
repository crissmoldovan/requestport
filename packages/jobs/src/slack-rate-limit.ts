import { ErrorCode, WebAPIRateLimitedError, WebClient } from "@slack/web-api";

const maxRateLimitRetries = 3;
// Notification leases last twenty minutes. Keep the complete provider retry
// budget comfortably below that fence so an old worker cannot resume after a
// replacement has claimed the same intent.
const maxRetryAfterSeconds = 3 * 60;

function retryAfterSeconds(error: unknown) {
  if (
    error instanceof WebAPIRateLimitedError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === ErrorCode.RateLimitedError)
  ) {
    const retryAfter = "retryAfter" in error ? error.retryAfter : undefined;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
      return Math.min(maxRetryAfterSeconds, Math.max(1, Math.ceil(retryAfter)));
    }
  }
  return null;
}

export function createSlackWebClient(token: string) {
  return new WebClient(token, {
    rejectRateLimitedCalls: true,
    timeout: 30_000,
  });
}

/**
 * Retries a Slack call that was rate limited, waiting what Slack asked for
 * through `sleep` — the runner's pause, which under Trigger.dev is a
 * checkpointed `wait.for` and under the Postgres worker a timer.
 */
export async function withSlackRateLimit<T>(
  operation: () => Promise<T>,
  sleep: (seconds: number) => Promise<void>,
) {
  for (let attempt = 0; attempt <= maxRateLimitRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const seconds = retryAfterSeconds(error);
      if (seconds === null || attempt === maxRateLimitRetries) throw error;
      await sleep(seconds);
    }
  }
  throw new Error("Slack rate-limit retry budget was exhausted");
}
