/**
 * Rate limits (Plan 13, H.1; manifest-h.md §2.2).
 *
 * Moved here from `apps/web/src/lib/security/rate-limit.ts`, which composes
 * a limiter from this module over the web's own collaborators and keeps its
 * exports for its importers. The policies, the fingerprint, the decision and
 * `requestIp` are this module's; what a limiter reads is handed to it, and it
 * reads each when it is used, never when it is made: the repository it
 * consumes from, the fingerprint's key, the environment label its rows carry,
 * and the sink its decisions are counted in.
 */
import { createHmac } from "node:crypto";

import { DomainError, type MetricSink } from "@requestport/domain";

/** A class's budget: `limit` units in each window of `windowSeconds`. */
export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The seven classes and their policies. */
export const RATE_LIMIT_POLICIES = {
  auth_initiation: { limit: 10, windowSeconds: 600 },
  token: { limit: 60, windowSeconds: 60 },
  mutation: { limit: 120, windowSeconds: 60 },
  slack_workspace: { limit: 300, windowSeconds: 60 },
  slack_user: { limit: 30, windowSeconds: 60 },
  webhook_admin: { limit: 30, windowSeconds: 60 },
  import_ingestion: { limit: 60, windowSeconds: 60 },
} as const satisfies Readonly<Record<string, RateLimitPolicy>>;

export type RateLimitClass = keyof typeof RATE_LIMIT_POLICIES;

export type RateLimitPolicies = Readonly<
  Record<RateLimitClass, RateLimitPolicy>
>;

/** What a limiter asks its repository to consume: `@requestport/db`'s shape. */
export interface RateLimitConsumption {
  environment: string;
  endpointClass: string;
  principalFingerprint: string;
  limit: number;
  windowSeconds: number;
  cost?: number;
}

/** The repository's answer: `createRateLimitRepository(…).consume`'s. */
export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimitRepository {
  consume(input: RateLimitConsumption): Promise<RateLimitDecision>;
}

/**
 * The HMAC-SHA256, under `key`, of the parts trimmed and lower-cased, a
 * missing part as `-`, joined by NUL: a principal's fingerprint, which keys
 * its rows without naming it.
 */
export function rateLimitFingerprint(
  key: string,
  parts: ReadonlyArray<string | null | undefined>,
) {
  return createHmac("sha256", key)
    .update(
      parts.map((part) => part?.trim().toLowerCase() ?? "-").join("\u0000"),
    )
    .digest("hex");
}

export interface RateLimiterOptions {
  /** The repository a decision consumes from, built for each decision. */
  repository: () => RateLimitRepository;
  /** The fingerprint's key (`BETTER_AUTH_SECRET`), read for each fingerprint. */
  fingerprintKey: () => string;
  /** The label each row carries (`VERCEL_ENV ?? NODE_ENV`), read for each decision. */
  environment: () => string;
  /** Where each decision is counted, as `rate_limit.decision_total`. */
  metrics: Pick<MetricSink, "count">;
  /** The classes' policies: `RATE_LIMIT_POLICIES` unless given. */
  policies?: RateLimitPolicies;
}

export interface RateLimiter {
  fingerprint(...parts: Array<string | null | undefined>): string;
  /**
   * Consumes `cost` (one, unless given) from the principal's budget in the
   * class, counts the decision, and answers it; a denial is refused as
   * `rate_limited`, with the seconds until the window turns.
   */
  enforce(input: {
    endpointClass: RateLimitClass;
    fingerprint: string;
    cost?: number;
  }): Promise<RateLimitDecision>;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const policies = options.policies ?? RATE_LIMIT_POLICIES;
  return {
    fingerprint: (...parts) =>
      rateLimitFingerprint(options.fingerprintKey(), parts),
    async enforce(input) {
      const policy = policies[input.endpointClass];
      const result = await options.repository().consume({
        environment: options.environment(),
        endpointClass: input.endpointClass,
        principalFingerprint: input.fingerprint,
        limit: policy.limit,
        windowSeconds: policy.windowSeconds,
        cost: input.cost,
      });
      options.metrics.count("rate_limit.decision_total", 1, {
        endpointClass: input.endpointClass,
        status: result.allowed ? "allowed" : "denied",
      });
      if (!result.allowed)
        throw new DomainError("rate_limited", "Too many requests", {
          retryAfterSeconds: result.retryAfterSeconds,
        });
      return result;
    },
  };
}

/**
 * The client's address as the request names it: the first entry of
 * `x-vercel-forwarded-for`, then of `x-forwarded-for`, else `unknown`. The
 * Node adapter (`node.ts`) removes the first and sets the second from the
 * socket before a handler sees the request.
 */
export function requestIp(request: Request) {
  return (
    request.headers.get("x-vercel-forwarded-for")?.split(",", 1)[0]?.trim() ??
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ??
    "unknown"
  );
}
