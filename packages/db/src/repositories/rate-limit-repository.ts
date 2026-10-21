import { and, eq, lt, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { rateLimitBuckets } from "../schema/index.js";
import type { Tx } from "../transaction.js";

type RateLimitDatabase = Database | Tx;

export function createRateLimitRepository(database: RateLimitDatabase) {
  return {
    async consume(input: {
      environment: string;
      endpointClass: string;
      principalFingerprint: string;
      limit: number;
      windowSeconds: number;
      cost?: number;
    }) {
      const cost = input.cost ?? 1;
      const rows = await database.execute<{
        count: number | string;
        current_time: Date | string;
        window_started_at: Date | string;
      }>(sql`
        with database_clock as materialized (
          select clock_timestamp() as database_now
        ), rate_window as materialized (
          select
            database_now,
            to_timestamp(
              floor(extract(epoch from database_now) / ${input.windowSeconds})
              * ${input.windowSeconds}
            ) as window_started_at
          from database_clock
        )
        insert into ${rateLimitBuckets} ("environment", "endpoint_class", "principal_fingerprint", "window_started_at", "count", "expires_at")
        select
          ${input.environment},
          ${input.endpointClass},
          ${input.principalFingerprint},
          window_started_at,
          ${cost},
          window_started_at + (${input.windowSeconds * 2} * interval '1 second')
        from rate_window
        on conflict ("environment", "endpoint_class", "principal_fingerprint", "window_started_at")
        do update set "count" = ${rateLimitBuckets.count} + ${cost}, "updated_at" = clock_timestamp()
        where ${rateLimitBuckets.count} + ${cost} <= ${input.limit}
        returning
          ${rateLimitBuckets.count} as count,
          ${rateLimitBuckets.windowStartedAt} as window_started_at,
          (select database_now from database_clock) as current_time
      `);
      const accepted = rows.rows[0];
      const currentTime = new Date(accepted?.current_time ?? Number.NaN);
      const windowStartedAt = new Date(
        accepted?.window_started_at ?? Number.NaN,
      );
      const count = Number(accepted?.count ?? input.limit);
      if (
        !accepted ||
        Number.isNaN(currentTime.getTime()) ||
        Number.isNaN(windowStartedAt.getTime())
      ) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: input.windowSeconds,
        };
      }
      return {
        allowed: count <= input.limit,
        remaining: Math.max(0, input.limit - count),
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(
            (windowStartedAt.getTime() +
              input.windowSeconds * 1_000 -
              currentTime.getTime()) /
              1_000,
          ),
        ),
      };
    },
    async deleteExpired(before: Date, limit = 1_000) {
      const selected = await database
        .select({ id: rateLimitBuckets.id })
        .from(rateLimitBuckets)
        .where(lt(rateLimitBuckets.expiresAt, before))
        .orderBy(rateLimitBuckets.expiresAt, rateLimitBuckets.id)
        .limit(limit);
      if (!selected.length) return 0;
      let deleted = 0;
      for (const row of selected) {
        const result = await database
          .delete(rateLimitBuckets)
          .where(
            and(
              eq(rateLimitBuckets.id, row.id),
              lt(rateLimitBuckets.expiresAt, before),
            ),
          )
          .returning({ id: rateLimitBuckets.id });
        deleted += result.length;
      }
      return deleted;
    },
  };
}
