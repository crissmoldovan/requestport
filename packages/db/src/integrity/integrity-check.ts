import { type SQL, sql } from "drizzle-orm";

import type { Database } from "../client.js";

export type IntegrityCheckResult = {
  name: string;
  violations: number;
  ok: boolean;
};

const checks: Array<{ name: string; query: SQL }> = [
  {
    name: "aggregate_version_sequence",
    query: sql`with ordered as (select aggregate_version, lag(aggregate_version) over (partition by organization_id, aggregate_type, aggregate_id order by aggregate_version) previous from domain_events) select count(*)::int as violations from ordered where (previous is null and aggregate_version <> 1) or (previous is not null and aggregate_version <> previous + 1)`,
  },
  {
    name: "event_outbox_correspondence",
    query: sql`select count(*)::int as violations from domain_events e left join outbox o on o.event_id = e.id where o.id is null`,
  },
  {
    name: "outbox_event_reference",
    query: sql`select count(*)::int as violations from outbox o left join domain_events e on e.id = o.event_id where e.id is null`,
  },
  {
    name: "request_event_version",
    query: sql`
      select count(*)::int as violations
      from (
        select r.id::text as id
        from requests r
        left join lateral (
          select max(e.aggregate_version)::int as version
          from domain_events e
          where e.organization_id = r.organization_id
            and e.aggregate_type = 'request'
            and e.aggregate_id = r.id
        ) latest on true
        where coalesce(latest.version, 0) <> r.version

        union all

        select ws.id::text as id
        from work_sessions ws
        left join lateral (
          select max(e.aggregate_version)::int as version
          from domain_events e
          where e.organization_id = ws.organization_id
            and e.aggregate_type = 'work_session'
            and e.aggregate_id = ws.id
        ) latest on true
        where coalesce(latest.version, 0) <> ws.event_version

        union all

        select q.id::text as id
        from questions q
        left join lateral (
          select max(e.aggregate_version)::int as version
          from domain_events e
          where e.organization_id = q.organization_id
            and e.aggregate_type = 'question'
            and e.aggregate_id = q.id
        ) latest on true
        where coalesce(latest.version, 0) <> q.version

        union all

        select st.id::text as id
        from state_transitions st
        left join domain_events e
          on e.organization_id = st.organization_id
          and e.id = st.event_id
        where e.id is null
          or e.aggregate_type <> 'request'
          or e.aggregate_id <> st.request_id
          or e.aggregate_version <> st.request_version
      ) invalid_versions
    `,
  },
  {
    name: "accepted_answer_uniqueness",
    query: sql`select count(*)::int as violations from (select question_id from answers where accepted = true group by question_id having count(*) > 1) duplicate`,
  },
  {
    name: "question_answer_state",
    query: sql`
      select count(*)::int as violations
      from questions q
      left join lateral (
        select count(*) filter (where a.accepted = true)::int as accepted_count
        from answers a
        where a.organization_id = q.organization_id
          and a.question_id = q.id
      ) answer_state on true
      where (q.state = 'answered' and coalesce(answer_state.accepted_count, 0) <> 1)
        or (q.state = 'open' and coalesce(answer_state.accepted_count, 0) <> 0)
    `,
  },
  {
    name: "live_claim_uniqueness",
    query: sql`select count(*)::int as violations from (select request_id from work_sessions where state in ('claimed','active','paused','blocked','stale') group by request_id having count(*) > 1) duplicate`,
  },
  {
    name: "request_scope_consistency",
    query: sql`
      select count(*)::int as violations
      from (
        select r.id::text as id
        from requests r
        left join organizations o on o.id = r.organization_id
        left join projects target
          on target.organization_id = r.organization_id
          and target.id = r.target_project_id
        left join projects source
          on source.organization_id = r.organization_id
          and source.id = r.source_project_id
        left join lanes lane
          on lane.organization_id = r.organization_id
          and lane.id = r.lane_id
        left join routing_rules rule
          on rule.organization_id = r.organization_id
          and rule.id = r.routing_rule_id
        where o.id is null
          or target.id is null
          or (r.source_project_id is not null and source.id is null)
          or (r.lane_id is not null and (lane.id is null or lane.project_id <> r.target_project_id))
          or (r.routing_rule_id is not null and (rule.id is null or rule.target_project_id <> r.target_project_id))

        union all

        select relationship.id::text as id
        from request_relationships relationship
        left join requests source
          on source.organization_id = relationship.organization_id
          and source.id = relationship.from_request_id
        left join requests target
          on target.organization_id = relationship.organization_id
          and target.id = relationship.to_request_id
        where source.id is null or target.id is null
      ) invalid_request_scope
    `,
  },
  {
    name: "work_scope_consistency",
    query: sql`
      select count(*)::int as violations
      from (
        select workspace.id::text as id
        from machine_workspaces workspace
        left join project_repositories repository
          on repository.organization_id = workspace.organization_id
          and repository.id = workspace.repository_id
        left join agent_installations installation
          on installation.organization_id = workspace.organization_id
          and installation.id = workspace.installation_id
        where repository.id is null
          or repository.project_id <> workspace.project_id
          or installation.id is null

        union all

        select session.id::text as id
        from work_sessions session
        left join requests request
          on request.organization_id = session.organization_id
          and request.id = session.request_id
        left join agent_principals principal
          on principal.organization_id = session.organization_id
          and principal.id = session.agent_principal_id
        left join agent_installations installation
          on installation.organization_id = session.organization_id
          and installation.id = session.installation_id
        left join machine_workspaces workspace
          on workspace.organization_id = session.organization_id
          and workspace.id = session.workspace_id
        where request.id is null
          or principal.id is null
          or installation.id is null
          or installation.agent_principal_id <> session.agent_principal_id
          or workspace.id is null
          or workspace.installation_id <> session.installation_id
          or workspace.project_id <> request.target_project_id
          or (principal.project_id is not null and principal.project_id <> request.target_project_id)

        union all

        select work_update.id::text as id
        from work_updates work_update
        left join work_sessions session
          on session.organization_id = work_update.organization_id
          and session.id = work_update.work_session_id
        where session.id is null or session.request_id <> work_update.request_id
      ) invalid_work_scope
    `,
  },
  {
    name: "applied_import_report",
    query: sql`
      select count(*)::int as violations
      from import_runs r
      left join import_apply_reports p on p.import_run_id = r.id
      left join lateral (
        select
          count(*)::int as application_count,
          count(*) filter (where a.outcome = 'created')::int as created_count,
          count(*) filter (where a.outcome = 'mapped')::int as mapped_count,
          count(*) filter (where a.outcome in ('message', 'corrected_message'))::int as message_count,
          count(*) filter (where a.outcome = 'skipped')::int as skipped_count,
          count(*) filter (where a.outcome = 'existing')::int as existing_count
        from import_entry_applications a
        where a.import_run_id = r.id
      ) applications on true
      left join lateral (
        select count(*)::int as manifest_count
        from import_manifest_entries entry
        where entry.import_run_id = r.id
      ) manifest on true
      left join lateral (
        select
          case when jsonb_typeof(p.counts -> 'created') = 'number' and p.counts ->> 'created' ~ '^[0-9]+$' then (p.counts ->> 'created')::int else -1 end as created_count,
          case when jsonb_typeof(p.counts -> 'mapped') = 'number' and p.counts ->> 'mapped' ~ '^[0-9]+$' then (p.counts ->> 'mapped')::int else -1 end as mapped_count,
          case when jsonb_typeof(p.counts -> 'messages') = 'number' and p.counts ->> 'messages' ~ '^[0-9]+$' then (p.counts ->> 'messages')::int else -1 end as message_count,
          case when jsonb_typeof(p.counts -> 'skipped') = 'number' and p.counts ->> 'skipped' ~ '^[0-9]+$' then (p.counts ->> 'skipped')::int else -1 end as skipped_count,
          case when jsonb_typeof(p.counts -> 'existing') = 'number' and p.counts ->> 'existing' ~ '^[0-9]+$' then (p.counts ->> 'existing')::int else -1 end as existing_count
      ) reported on p.id is not null
      where r.state = 'applied'
        and (
          p.id is null
          or coalesce(applications.application_count, 0) <> coalesce(manifest.manifest_count, 0)
          or reported.created_count <> coalesce(applications.created_count, 0)
          or reported.mapped_count <> coalesce(applications.mapped_count, 0)
          or reported.message_count <> coalesce(applications.message_count, 0)
          or reported.skipped_count <> coalesce(applications.skipped_count, 0)
          or reported.existing_count <> coalesce(applications.existing_count, 0)
        )
    `,
  },
  {
    name: "import_report_manifest",
    query: sql`select count(*)::int as violations from import_runs r join import_apply_reports p on p.import_run_id = r.id where r.manifest_sha256 is distinct from p.manifest_sha256`,
  },
  {
    name: "import_mapping_source",
    query: sql`select count(*)::int as violations from legacy_mappings m left join source_artifacts a on a.id = m.source_artifact_id left join import_runs r on r.id = m.import_run_id where a.id is null or r.id is null or a.organization_id <> m.organization_id or r.organization_id <> m.organization_id`,
  },
  {
    name: "webhook_filter_project_reference",
    query: sql`
      select count(*)::int as violations
      from webhook_subscriptions subscription
      where exists (
        select 1
        from jsonb_array_elements_text(subscription.project_ids) as project_filter(project_id)
        left join projects project
          on project.organization_id = subscription.organization_id
          and project.id::text = project_filter.project_id
        where project.id is null
      )
    `,
  },
  {
    name: "dispatcher_receipt_reference",
    query: sql`
      select count(*)::int as violations
      from dispatcher_receipts receipt
      left join outbox on outbox.id = receipt.outbox_id
      where outbox.id is null
    `,
  },
  {
    name: "webhook_delivery_reference",
    query: sql`
      select count(*)::int as violations
      from (
        select d.id::text as id
        from webhook_deliveries d
        left join webhook_subscriptions s on s.id = d.subscription_id
        left join domain_events e on e.id = d.event_id
        where s.id is null
          or e.id is null
          or s.organization_id <> d.organization_id
          or e.organization_id <> d.organization_id
          or (d.status in ('delivered','dead_letter') and d.completed_at is null)
          or (d.status in ('pending','delivering','retry') and d.completed_at is not null)

        union all

        select a.id::text as id
        from webhook_attempts a
        where a.attempt_number <> (
          select count(*)::int
          from webhook_attempts preceding
          where preceding.delivery_id = a.delivery_id
            and preceding.attempt_number <= a.attempt_number
        )
      ) invalid_webhook_delivery
    `,
  },
  {
    name: "notification_delivery_reference",
    query: sql`
      select count(*)::int as violations
      from (
        select i.id::text as id
        from notification_intents i
        left join email_deliveries e
          on e.notification_intent_id = i.id
          and e.organization_id = i.organization_id
        left join slack_deliveries s
          on s.notification_intent_id = i.id
          and s.organization_id = i.organization_id
        where (i.status = 'delivered' and e.id is null and s.id is null)
          or (i.status = 'delivering' and (i.lease_owner is null or i.lease_expires_at is null))
          or (i.status <> 'delivering' and (i.lease_owner is not null or i.lease_expires_at is not null))
          or (i.status in ('delivered','suppressed') and i.next_attempt_at is not null)

        union all

        select e.id::text as id
        from email_deliveries e
        left join notification_intents i
          on i.id = e.notification_intent_id
          and i.organization_id = e.organization_id
        where i.id is null
          or (i.status = 'delivered' and e.provider_message_id is null)

        union all

        select s.id::text as id
        from slack_deliveries s
        left join notification_intents i
          on i.id = s.notification_intent_id
          and i.organization_id = s.organization_id
        where i.id is null
          or (s.status = 'delivered' and s.message_ts is null)

        union all

        select op.id::text as id
        from slack_delivery_operations op
        left join slack_installations installation
          on installation.id = op.installation_id
        where installation.id is null
          or (op.status = 'delivering' and (op.lease_owner is null or op.lease_expires_at is null))
          or (op.status <> 'delivering' and (op.lease_owner is not null or op.lease_expires_at is not null))
      ) invalid_notification_delivery
    `,
  },
];

export async function runIntegrityCheck(input: {
  database: Database;
  expectedWorkspaceKekVersion?: string;
}) {
  const { database } = input;
  const results: IntegrityCheckResult[] = [];
  for (const check of checks) {
    const row = await database.execute<{ violations: number }>(check.query);
    const violations = row.rows[0]?.violations ?? 0;
    results.push({ name: check.name, violations, ok: violations === 0 });
  }
  if (input.expectedWorkspaceKekVersion) {
    const row = await database.execute<{ violations: number }>(
      sql`select count(*)::int as violations from machine_workspaces where kek_version <> ${input.expectedWorkspaceKekVersion}`,
    );
    const violations = row.rows[0]?.violations ?? 0;
    results.push({
      name: "workspace_kek_version",
      violations,
      ok: violations === 0,
    });
  }
  return { ok: results.every((result) => result.ok), checks: results };
}
