import { sql } from "drizzle-orm";

import type { Database } from "../client.js";

export type OperationalMetricSnapshot = {
  pendingOutbox: number;
  oldestOutboxSeconds: number;
  deadLetterWebhooks: number;
  notificationBacklog: number;
  staleSessions: number;
  openImportConflicts: number;
  slackOperationBacklog: number;
  deadLetterImportDispatches: number;
};

function finiteCount(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Operational metric snapshot is invalid");
  }
  return parsed;
}

/**
 * The service-wide gauges, through function 15 (Plan 13, I.2b; manifest-i2.md
 * §5.1 (c), ruling 34): a fixed body that returns counts only, executable by
 * the maintenance role alone once 0023 has run (I.2b's b5), and by a
 * superuser, which passes every privilege check.
 */
export function createOperationalMetricsRepository(database: Database) {
  return {
    async snapshot(): Promise<OperationalMetricSnapshot> {
      const result = await database.execute<{
        pending_outbox: number | string;
        oldest_outbox_seconds: number | string;
        dead_letter_webhooks: number | string;
        notification_backlog: number | string;
        stale_sessions: number | string;
        open_import_conflicts: number | string;
        slack_operation_backlog: number | string;
        dead_letter_import_dispatches: number | string;
      }>(
        sql`select pending_outbox, oldest_outbox_seconds, dead_letter_webhooks, notification_backlog, stale_sessions, open_import_conflicts, slack_operation_backlog, dead_letter_import_dispatches from requestport_private.operational_metrics_snapshot()`,
      );
      const row = result.rows[0];
      if (!row) throw new Error("Operational metric snapshot is unavailable");
      return {
        pendingOutbox: finiteCount(row.pending_outbox),
        oldestOutboxSeconds: finiteCount(row.oldest_outbox_seconds),
        deadLetterWebhooks: finiteCount(row.dead_letter_webhooks),
        notificationBacklog: finiteCount(row.notification_backlog),
        staleSessions: finiteCount(row.stale_sessions),
        openImportConflicts: finiteCount(row.open_import_conflicts),
        slackOperationBacklog: finiteCount(row.slack_operation_backlog),
        deadLetterImportDispatches: finiteCount(
          row.dead_letter_import_dispatches,
        ),
      };
    },
  };
}
