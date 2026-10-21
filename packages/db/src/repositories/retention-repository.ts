import type { RetentionCategory } from "@requestport/domain";
import { type SQL, sql } from "drizzle-orm";

import type { Database } from "../client.js";

/**
 * The rows `retention-preview` counts: today's selection per category, the
 * same one `requestport_private.retention_cleanup` (function 17) deletes by,
 * at a cutoff the preview's caller computes.
 */
function candidateQuery(
  category: RetentionCategory,
  cutoffAt: Date,
  limit: number,
): SQL {
  switch (category) {
    case "verification":
      return sql`select id::text as id, expires_at as retained_at from verification where expires_at < ${cutoffAt} order by expires_at, id limit ${limit}`;
    case "session":
      return sql`select id::text as id, expires_at as retained_at from session where expires_at < ${cutoffAt} order by expires_at, id limit ${limit}`;
    case "oauth_access_token":
      return sql`select id::text as id, expires_at as retained_at from oauth_access_token where expires_at is not null and expires_at < ${cutoffAt} order by expires_at, id limit ${limit}`;
    case "oauth_refresh_token":
      return sql`select id::text as id, coalesce(revoked, expires_at) as retained_at from oauth_refresh_token where coalesce(revoked, expires_at) is not null and coalesce(revoked, expires_at) < ${cutoffAt} order by coalesce(revoked, expires_at), id limit ${limit}`;
    case "command_receipt":
      return sql`select id::text as id, expires_at as retained_at from command_receipts where expires_at < ${cutoffAt} order by expires_at, id limit ${limit}`;
    case "slack_oauth_state":
      return sql`select s.id::text as id, s.expires_at as retained_at from slack_oauth_states s where s.expires_at < ${cutoffAt} and not exists (select 1 from retention_holds h where h.organization_id = s.organization_id and h.status = 'active' and h.category in ('all','slack_oauth_state')) order by s.expires_at, s.id limit ${limit}`;
    case "slack_action_token":
      return sql`select s.id::text as id, s.expires_at as retained_at from slack_action_tokens s where s.expires_at < ${cutoffAt} and not exists (select 1 from retention_holds h where h.organization_id = s.organization_id and h.status = 'active' and h.category in ('all','slack_action_token')) order by s.expires_at, s.id limit ${limit}`;
    case "provider_callback_receipt":
      return sql`select id::text as id, received_at as retained_at from provider_callback_receipts where received_at < ${cutoffAt} order by received_at, id limit ${limit}`;
    case "rate_limit_bucket":
      return sql`select id::text as id, expires_at as retained_at from rate_limit_buckets where expires_at < ${cutoffAt} order by expires_at, id limit ${limit}`;
  }
}

function previewQuery(category: RetentionCategory, cutoffAt: Date): SQL {
  const candidates = candidateQuery(category, cutoffAt, 1_000_000);
  return sql`select count(*)::int as count, min(retained_at) as oldest_at, max(retained_at) as newest_at from (${candidates}) candidates`;
}

export function createRetentionRepository(database: Database) {
  return {
    async currentTime() {
      const result = await database.execute<{ now: string | Date }>(
        sql`select clock_timestamp() as now`,
      );
      const now = new Date(result.rows[0]?.now ?? Number.NaN);
      if (Number.isNaN(now.getTime())) {
        throw new Error("Database clock is unavailable for retention");
      }
      return now;
    },
    async preview(
      policies: Array<{ category: RetentionCategory; cutoffAt: Date }>,
    ) {
      const rows = [];
      for (const policy of policies) {
        const result = await database.execute<{
          count: number;
          oldest_at: string | Date | null;
          newest_at: string | Date | null;
        }>(previewQuery(policy.category, policy.cutoffAt));
        const record = result.rows[0];
        rows.push({
          category: policy.category,
          cutoffAt: policy.cutoffAt,
          count: Number(record?.count ?? 0),
          oldestAt: record?.oldest_at ? new Date(record.oldest_at) : null,
          newestAt: record?.newest_at ? new Date(record.newest_at) : null,
        });
      }
      return rows;
    },
    /**
     * One category's batch through function 17 (Plan 13, I.2b; manifest-i2.md
     * §5.1 (c)): the function selects, tombstones and deletes as this method
     * did, at a cutoff it computes from its own clock and the category's age
     * in a table it owns, never from an argument. `batchSize` is clamped to
     * 1-1 000 there (default 500). In a transaction on this storage (§2.5.0
     * item 7): a bare call is a read the pool's read retry would send again.
     */
    async cleanup(input: { category: RetentionCategory; batchSize?: number }) {
      const batchSize =
        input.batchSize === undefined || !Number.isFinite(input.batchSize)
          ? null
          : Math.max(
              -2_147_483_648,
              Math.min(2_147_483_647, Math.trunc(input.batchSize)),
            );
      const result = await database.transaction((tx) =>
        tx.execute<{
          category: RetentionCategory;
          deleted: number;
          tombstone_id: string | null;
        }>(
          sql`select category, deleted, tombstone_id from requestport_private.retention_cleanup(${input.category}, ${batchSize}::integer)`,
        ),
      );
      const row = result.rows[0];
      if (!row) throw new Error("Retention cleanup returned no result");
      return {
        category: row.category,
        deleted: Number(row.deleted),
        tombstoneId: row.tombstone_id,
      };
    },
  };
}
