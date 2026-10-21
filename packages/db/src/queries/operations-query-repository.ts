import { DomainError } from "@requestport/domain";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { inTurn } from "../in-turn.js";
import { organizationMembers, organizations } from "../schema/index.js";
import { inTenantTransaction } from "../tenant-context.js";
import type { Tx } from "../transaction.js";

async function requireOperationsAccess(
  transaction: Tx,
  userId: string,
  organizationId: string,
) {
  const [access] = await transaction
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, organizationMembers.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "active"),
        inArray(organizationMembers.role, ["owner", "admin"]),
      ),
    )
    .for("share")
    .limit(1);
  if (!access) {
    throw new DomainError("forbidden", "Operations access is denied");
  }
}

export function createOperationsQueryRepository(database: Database) {
  return {
    async summary(userId: string, organizationId: string) {
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          await requireOperationsAccess(transaction, userId, organizationId);
          const result = await transaction.execute<{
            pending_outbox: number;
            oldest_outbox_seconds: number;
            dead_webhooks: number;
            pending_notifications: number;
            stale_sessions: number;
            open_import_conflicts: number;
            pending_slack_updates: number;
            dead_import_dispatches: number;
          }>(sql`
        select
          (select count(*)::int from outbox o join domain_events e on e.id = o.event_id where e.organization_id = ${organizationId} and o.state in ('pending','leased','accepted')) as pending_outbox,
          coalesce((select extract(epoch from (clock_timestamp() - min(o.created_at)))::int from outbox o join domain_events e on e.id = o.event_id where e.organization_id = ${organizationId} and o.state in ('pending','leased','accepted')), 0) as oldest_outbox_seconds,
          (select count(*)::int from webhook_deliveries where organization_id = ${organizationId} and status = 'dead_letter') as dead_webhooks,
          (select count(*)::int from notification_intents where organization_id = ${organizationId} and status in ('pending','delivering','failed')) as pending_notifications,
          (select count(*)::int from work_sessions where organization_id = ${organizationId} and state = 'stale') as stale_sessions,
          (select count(*)::int from import_conflicts c join import_runs r on r.id = c.import_run_id where r.organization_id = ${organizationId} and c.severity = 'blocking' and c.resolved_at is null) as open_import_conflicts,
          (select count(*)::int from slack_delivery_operations op join slack_installations i on i.id = op.installation_id where i.organization_id = ${organizationId} and op.status in ('pending','delivering','retry')) as pending_slack_updates,
          (select count(*)::int from import_task_dispatches where organization_id = ${organizationId} and state = 'dead_letter') as dead_import_dispatches
      `);
          return (
            result.rows[0] ?? {
              pending_outbox: 0,
              oldest_outbox_seconds: 0,
              dead_webhooks: 0,
              pending_notifications: 0,
              stale_sessions: 0,
              open_import_conflicts: 0,
              pending_slack_updates: 0,
              dead_import_dispatches: 0,
            }
          );
        },
      );
    },

    async details(userId: string, organizationId: string) {
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          await requireOperationsAccess(transaction, userId, organizationId);
          const [
            outboxRows,
            notificationRows,
            sessionRows,
            conflictRows,
            importDispatchRows,
            slackRows,
          ] = await inTurn([
            () =>
              transaction.execute<{
                id: string;
                event_id: string;
                event_type: string;
                request_id: string | null;
                state: string;
                attempt_count: number;
                next_attempt_at: Date;
                trigger_run_id: string | null;
                created_at: Date;
              }>(sql`
          select o.id, o.event_id, e.type as event_type, e.request_id, o.state,
            o.attempt_count, o.next_attempt_at, o.trigger_run_id, o.created_at
          from outbox o
          join domain_events e on e.id = o.event_id
          where e.organization_id = ${organizationId}
          order by o.created_at desc, o.id desc
          limit 200
        `),
            () =>
              transaction.execute<{
                id: string;
                event_id: string | null;
                question_id: string | null;
                channel: string;
                template: string;
                status: string;
                attempt_count: number;
                next_attempt_at: Date | null;
                last_error_code: string | null;
                provider_status: string | null;
                provider_record_id: string | null;
                created_at: Date;
              }>(sql`
          select n.id, n.event_id, n.question_id, n.channel, n.template, n.status,
            n.attempt_count, n.next_attempt_at, n.last_error_code,
            case
              when n.channel = 'email' then (
                select e.status from email_deliveries e
                where e.notification_intent_id = n.id limit 1
              )
              else (
                select string_agg(s.status, ',' order by s.id)
                from slack_deliveries s
                where s.notification_intent_id = n.id
              )
            end as provider_status,
            case
              when n.channel = 'email' then (
                select e.id::text from email_deliveries e
                where e.notification_intent_id = n.id limit 1
              )
              else (
                select string_agg(s.id::text, ',' order by s.id)
                from slack_deliveries s
                where s.notification_intent_id = n.id
              )
            end as provider_record_id,
            n.created_at
          from notification_intents n
          where n.organization_id = ${organizationId}
          order by n.created_at desc, n.id desc
          limit 200
        `),
            () =>
              transaction.execute<{
                id: string;
                request_id: string;
                agent_principal_id: string;
                state: string;
                lease_expires_at: Date;
                updated_at: Date;
              }>(sql`
          select id, request_id, agent_principal_id, state, lease_expires_at, updated_at
          from work_sessions
          where organization_id = ${organizationId}
          order by updated_at desc, id desc
          limit 200
        `),
            () =>
              transaction.execute<{
                id: string;
                import_run_id: string;
                entry_id: string;
                kind: string;
                severity: string;
                resolved_at: Date | null;
              }>(sql`
          select c.id, c.import_run_id, c.entry_id, c.kind, c.severity, c.resolved_at
          from import_conflicts c
          join import_runs r on r.id = c.import_run_id
          where r.organization_id = ${organizationId}
          order by c.resolved_at nulls first, c.severity desc, c.id
          limit 200
        `),
            () =>
              transaction.execute<{
                id: string;
                import_run_id: string;
                task_kind: string;
                state: string;
                attempt_count: number;
                trigger_run_id: string | null;
                last_error_code: string | null;
                updated_at: Date;
              }>(sql`
          select id, import_run_id, task_kind, state, attempt_count,
            trigger_run_id, last_error_code, updated_at
          from import_task_dispatches
          where organization_id = ${organizationId}
          order by updated_at desc, id desc
          limit 200
        `),
            () =>
              transaction.execute<{
                id: string;
                installation_id: string;
                operation_type: string;
                status: string;
                attempt_count: number;
                next_attempt_at: Date;
                last_error_code: string | null;
                created_at: Date;
                updated_at: Date;
              }>(sql`
          select op.id, op.installation_id, op.operation_type, op.status,
            op.attempt_count, op.next_attempt_at, op.last_error_code,
            op.created_at, op.updated_at
          from slack_delivery_operations op
          join slack_installations i on i.id = op.installation_id
          where i.organization_id = ${organizationId}
          order by op.updated_at desc, op.id desc
          limit 200
        `),
          ]);
          return {
            outbox: outboxRows.rows,
            notifications: notificationRows.rows,
            sessions: sessionRows.rows,
            importConflicts: conflictRows.rows,
            importDispatches: importDispatchRows.rows,
            slackOperations: slackRows.rows,
          };
        },
      );
    },
  };
}
