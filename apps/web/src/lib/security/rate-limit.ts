/*
  The web's rate limiter (Plan 13, H.1): `@requestport/server`'s, composed
  over the web's own collaborators. The seven classes, the fingerprint, the
  decision and `requestIp` moved to the package's `./rate-limit`; this module
  keeps its exports for its importers, so the suites that `vi.mock` it keep
  intercepting each one. What it hands the limiter is read when a limit is
  fingerprinted or enforced, never as this module loads:
  - the repository, over the web root's storage, built for each decision;
  - the fingerprint's key, `BETTER_AUTH_SECRET`;
  - the rows' label, `VERCEL_ENV ?? NODE_ENV`;
  - the decision's metric, counted through `webMetrics`.
*/
import { serverEnv } from "@requestport/config/server";
import { createRateLimitRepository } from "@requestport/db";
import {
  createRateLimiter,
  type RateLimiter,
} from "@requestport/server/rate-limit";

import { webMetrics } from "../observability.js";
import { webStorage } from "../server-request-port.js";

export {
  type RateLimitClass,
  requestIp,
} from "@requestport/server/rate-limit";

function rateLimitRepository() {
  const storage = webStorage();
  return createRateLimitRepository(storage.db);
}

const limiter = createRateLimiter({
  repository: rateLimitRepository,
  fingerprintKey: () => serverEnv.BETTER_AUTH_SECRET,
  environment: () =>
    process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
  metrics: {
    count: (name, value, labels) => webMetrics.count(name, value, labels),
  },
});

export function rateLimitFingerprint(
  ...parts: Array<string | null | undefined>
) {
  return limiter.fingerprint(...parts);
}

export async function enforceRateLimit(
  input: Parameters<RateLimiter["enforce"]>[0],
) {
  return limiter.enforce(input);
}
