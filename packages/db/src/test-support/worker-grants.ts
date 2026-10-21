/*
 * The worker roles' expected grants (plan 13, Track I.2b, migrations 0020
 * and 0023; manifest-i2.md §5.1), shared by the I.2 catalogue ratchet
 * (row-security.catalogue.integration.test.ts) and the worker suite
 * (worker-row-security.integration.test.ts), so the two cannot disagree.
 */

const S = "SELECT";
const I = "INSERT";
const U = "UPDATE";
const UID = "UPDATE (id)";

/**
 * The tenant processor's grants: track-i2.md, "I.2b design (2026-09-30)",
 * the matrix derived from every statement a processing path issues. A table
 * missing here has none; `UPDATE (id)` is the column grant a row lock needs
 * (D19), and Better Auth's `user` is granted by column.
 */
export const PROCESSOR_GRANTS: Readonly<Record<string, readonly string[]>> = {
  agent_credentials: [S, UID],
  agent_oauth_grants: [S, UID],
  agent_principals: [S, UID],
  command_receipts: [S, I],
  domain_events: [S, I],
  email_deliveries: [S, I, U],
  import_apply_reports: [S, I],
  import_conflicts: [S, I],
  import_entry_applications: [S, I],
  import_manifest_entries: [S, I],
  import_runs: [S, U],
  import_sources: [S, UID],
  import_task_dispatches: [S, U],
  invitations: [S],
  legacy_aliases: [I],
  legacy_mappings: [S, I],
  message_mentions: [I],
  messages: [S, I],
  notification_intents: [S, I, U],
  organization_members: [S, UID],
  organizations: [S, UID],
  outbox: [S, I, U],
  project_members: [S, UID],
  project_sequences: [S, I, U],
  projects: [S, UID],
  questions: [S],
  request_acceptance_criteria: [I],
  request_labels: [I],
  request_relationships: [I],
  requests: [S, I, U],
  routing_rules: [S],
  security_audit_records: [I],
  slack_action_tokens: [I],
  slack_deliveries: [S, I, U],
  slack_delivery_operations: [S, U],
  slack_installations: [S, UID],
  slack_routes: [S],
  slack_user_mappings: [S],
  source_artifacts: [S, UID],
  source_snapshots: [S, U],
  state_transitions: [I],
  user: ["SELECT (email)", "SELECT (id)", "SELECT (name)"],
  webhook_attempts: [S, I, U],
  webhook_deliveries: [S, I, U],
  webhook_subscriptions: [S, U],
  work_sessions: [S, U],
};

/**
 * What 0020 adds to the definer's grants in public (D3): what the seventeen
 * worker bodies use beyond 0019's fifteen. The catalogue test merges these
 * with 0019's.
 */
export const WORKER_DEFINER_GRANTS: Readonly<
  Record<string, readonly string[]>
> = {
  command_receipts: [S, "DELETE", UID],
  domain_events: [S],
  import_conflicts: [S],
  import_task_dispatches: [
    S,
    "UPDATE (accepted_at)",
    "UPDATE (attempt_count)",
    "UPDATE (last_error_code)",
    "UPDATE (lease_expires_at)",
    "UPDATE (lease_owner)",
    "UPDATE (state)",
    "UPDATE (trigger_run_id)",
    "UPDATE (updated_at)",
  ],
  notification_intents: [S],
  oauth_access_token: [S, "DELETE", UID],
  oauth_refresh_token: [S, "DELETE", UID],
  outbox: [
    S,
    "UPDATE (accepted_at)",
    "UPDATE (attempt_count)",
    "UPDATE (lease_expires_at)",
    "UPDATE (lease_owner)",
    "UPDATE (next_attempt_at)",
    "UPDATE (state)",
    "UPDATE (trigger_run_id)",
    "UPDATE (updated_at)",
  ],
  provider_callback_receipts: ["DELETE"],
  rate_limit_buckets: [S, "DELETE", UID],
  requests: [S],
  retention_holds: [S],
  retention_tombstones: ["SELECT (id)", I],
  session: [S, "DELETE", UID],
  slack_action_tokens: ["DELETE"],
  slack_delivery_operations: [S],
  slack_oauth_states: ["DELETE"],
  verification: [S, "DELETE", UID],
  webhook_attempts: [S],
  webhook_deliveries: [S],
  webhook_subscriptions: [S],
  work_sessions: [S],
};

/** The three worker groups. */
export type WorkerGroup =
  | "requestport_dispatcher"
  | "requestport_tenant_processor"
  | "requestport_maintenance";

/**
 * 0020's seventeen functions, by signature, with the one group each serves.
 * Since 0023 (I.2b b5; ruling 214 item 4) that group is the only role that
 * holds `EXECUTE` on each: see {@link workerFunctionAcl}.
 */
export const WORKER_FUNCTIONS: Readonly<Record<string, WorkerGroup>> = {
  "requestport_private.claim_outbox_batch(p_limit integer, p_lease_seconds integer)":
    "requestport_dispatcher",
  "requestport_private.accept_outbox_claim(p_outbox_id uuid, p_lease_id uuid, p_run_id text)":
    "requestport_dispatcher",
  "requestport_private.release_outbox_claim(p_outbox_id uuid, p_lease_id uuid, p_dead_letter boolean, p_delay_ms integer)":
    "requestport_dispatcher",
  "requestport_private.claim_import_dispatch_batch(p_limit integer, p_lease_seconds integer)":
    "requestport_dispatcher",
  "requestport_private.accept_import_dispatch_claim(p_dispatch_id uuid, p_lease_id uuid, p_run_id text)":
    "requestport_dispatcher",
  "requestport_private.due_notification_intents(p_limit integer)":
    "requestport_dispatcher",
  "requestport_private.pending_webhook_deliveries(p_limit integer)":
    "requestport_dispatcher",
  "requestport_private.due_slack_message_updates(p_limit integer)":
    "requestport_dispatcher",
  "requestport_private.due_slack_connection_tests(p_limit integer)":
    "requestport_dispatcher",
  "requestport_private.lease_expired_work_sessions(p_limit integer)":
    "requestport_dispatcher",
  "requestport_private.grace_expired_work_sessions(p_limit integer)":
    "requestport_dispatcher",
  "requestport_private.due_webhook_secret_promotions(p_limit integer)":
    "requestport_dispatcher",
  "requestport_private.due_question_reminders(p_limit integer)":
    "requestport_dispatcher",
  "requestport_private.resolve_job_organization(p_kind text, p_id uuid)":
    "requestport_tenant_processor",
  "requestport_private.operational_metrics_snapshot()":
    "requestport_maintenance",
  "requestport_private.outbox_pending_backlog()": "requestport_maintenance",
  "requestport_private.retention_cleanup(p_category text, p_batch_size integer)":
    "requestport_maintenance",
};

/**
 * A worker function's whole ACL (`proacl`) since 0023: its group's
 * `EXECUTE`, granted by the owner, and no other entry. 0020 also granted the
 * migrating role and left the owner's own entry, through which the migrating
 * role inherits (0019's membership); 0023 revokes both, and its closing
 * check refuses to commit unless every ACL is exactly this.
 */
export function workerFunctionAcl(group: WorkerGroup): readonly string[] {
  return [`${group}=X/requestport_definer`];
}

/**
 * 0021's two live-credential locks (the driver's ruling of 2026-09-30;
 * manifest-i2.md §5.1, rows 18 and 19), by signature, with the groups that
 * may execute them: the tenant processor, and the application, whose command
 * path shares the two agent authorization helpers that b2 moves onto them.
 */
export const CREDENTIAL_LOCK_FUNCTIONS: Readonly<
  Record<
    string,
    readonly ("requestport_tenant_processor" | "requestport_application")[]
  >
> = {
  "requestport_private.lock_live_api_key(p_api_key_id text)": [
    "requestport_tenant_processor",
    "requestport_application",
  ],
  "requestport_private.lock_live_oauth_client(p_client_id text)": [
    "requestport_tenant_processor",
    "requestport_application",
  ],
};

/**
 * What 0021 adds to the definer's grants in public: `FOR SHARE` needs
 * `UPDATE` on one column (D19, P10), and 0019 gave the definer `SELECT` alone
 * on both tables.
 */
export const CREDENTIAL_LOCK_DEFINER_GRANTS: Readonly<
  Record<string, readonly string[]>
> = {
  apikey: [UID],
  oauth_client: [UID],
};
