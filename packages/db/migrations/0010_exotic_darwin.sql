CREATE TABLE "dispatcher_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_id" uuid NOT NULL,
	"task_name" text NOT NULL,
	"trigger_run_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"leased_by" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_callback_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"body_sha256" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "provider_callback_receipts_sha_check" CHECK ("provider_callback_receipts"."body_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "slack_delivery_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"operation_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_message_ts" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"resolved_ips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_timestamp" timestamp with time zone NOT NULL,
	"signing_key_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"response_status" integer,
	"response_excerpt" text,
	"error_code" text,
	"next_attempt_at" timestamp with time zone,
	CONSTRAINT "webhook_attempts_attempt_check" CHECK ("webhook_attempts"."attempt_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"replay_number" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" in ('pending', 'delivering', 'delivered', 'retry', 'dead_letter', 'cancelled')),
	CONSTRAINT "webhook_deliveries_replay_check" CHECK ("webhook_deliveries"."replay_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_apply_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_run_id" uuid NOT NULL,
	"counts" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_apply_reports_sha_check" CHECK ("import_apply_reports"."manifest_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "import_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_run_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"details" jsonb NOT NULL,
	"resolution" jsonb,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "import_conflicts_severity_check" CHECK ("import_conflicts"."severity" in ('warning', 'blocking'))
);
--> statement-breakpoint
CREATE TABLE "import_manifest_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_run_id" uuid NOT NULL,
	"source_artifact_id" uuid NOT NULL,
	"record_index" integer NOT NULL,
	"proposed_kind" text NOT NULL,
	"parsed_json" jsonb NOT NULL,
	"confidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proposed_canonical_id" uuid,
	"decision" text DEFAULT 'pending' NOT NULL,
	"reviewer_id" text,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "import_manifest_entries_record_check" CHECK ("import_manifest_entries"."record_index" >= 0),
	CONSTRAINT "import_manifest_entries_decision_check" CHECK ("import_manifest_entries"."decision" in ('pending', 'create', 'map_existing', 'message', 'skip', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_source_id" uuid NOT NULL,
	"source_snapshot_id" uuid NOT NULL,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"state" text DEFAULT 'analyzing' NOT NULL,
	"parser_version" text NOT NULL,
	"manifest_sha256" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_runs_state_check" CHECK ("import_runs"."state" in ('analyzing', 'reviewing', 'approved', 'applying', 'applied', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "import_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text DEFAULT 'git' NOT NULL,
	"repository_url" text,
	"repository_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_project_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"normalized_key" text NOT NULL,
	"source_artifact_id" uuid NOT NULL,
	"record_index" integer NOT NULL,
	"canonical_request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_artifact_id" uuid NOT NULL,
	"record_index" integer NOT NULL,
	"canonical_type" text NOT NULL,
	"canonical_id" uuid NOT NULL,
	"import_run_id" uuid NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_source_id" uuid NOT NULL,
	"source_snapshot_id" uuid NOT NULL,
	"relative_path" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"exact_bytes" "bytea" NOT NULL,
	"secret_scan_status" text DEFAULT 'clear' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_artifacts_byte_size_check" CHECK ("source_artifacts"."byte_size" between 0 and 1048576),
	CONSTRAINT "source_artifacts_sha_check" CHECK ("source_artifacts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_artifacts_scan_check" CHECK ("source_artifacts"."secret_scan_status" in ('clear', 'blocked', 'reviewed'))
);
--> statement-breakpoint
CREATE TABLE "source_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_source_id" uuid NOT NULL,
	"git_commit_sha" text,
	"dirty" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'captured' NOT NULL,
	"manifest_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_snapshots_status_check" CHECK ("source_snapshots"."status" in ('capturing', 'captured', 'blocked', 'analyzed')),
	CONSTRAINT "source_snapshots_manifest_sha_check" CHECK ("source_snapshots"."manifest_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "slack_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"bot_token_ciphertext" jsonb NOT NULL,
	"bot_user_id" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"installed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_installations_status_check" CHECK ("slack_installations"."status" in ('active', 'disabled', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "slack_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"mode" text NOT NULL,
	"channel_id" text,
	"fallback" text DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_routes_mode_check" CHECK ("slack_routes"."mode" in ('dm', 'channel', 'both')),
	CONSTRAINT "slack_routes_fallback_check" CHECK ("slack_routes"."fallback" in ('none', 'organization_channel', 'email')),
	CONSTRAINT "slack_routes_status_check" CHECK ("slack_routes"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "slack_user_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_user_mappings_status_check" CHECK ("slack_user_mappings"."status" in ('active', 'disabled', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lane_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending_verification' NOT NULL,
	"current_secret_ciphertext" jsonb NOT NULL,
	"current_secret_key_id" text NOT NULL,
	"next_secret_ciphertext" jsonb,
	"next_secret_key_id" text,
	"overlap_ends_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_subscriptions_status_check" CHECK ("webhook_subscriptions"."status" in ('pending_verification', 'active', 'disabled', 'revoked')),
	CONSTRAINT "webhook_subscriptions_rotation_check" CHECK (("webhook_subscriptions"."next_secret_ciphertext" is null and "webhook_subscriptions"."next_secret_key_id" is null and "webhook_subscriptions"."overlap_ends_at" is null) or ("webhook_subscriptions"."next_secret_ciphertext" is not null and "webhook_subscriptions"."next_secret_key_id" is not null and "webhook_subscriptions"."overlap_ends_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_intent_id" uuid NOT NULL,
	"provider_message_id" text,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_provider_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" uuid,
	"question_id" uuid,
	"channel" text NOT NULL,
	"recipient_ref" text NOT NULL,
	"template" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"view_model" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_intents_channel_check" CHECK ("notification_intents"."channel" in ('email', 'slack')),
	CONSTRAINT "notification_intents_status_check" CHECK ("notification_intents"."status" in ('pending', 'delivering', 'delivered', 'suppressed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "slack_action_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"slack_user_id" text,
	"token_type" text NOT NULL,
	"token_hash" text NOT NULL,
	"action_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_user_id" text,
	"answer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_action_tokens_type_check" CHECK ("slack_action_tokens"."token_type" in ('answer', 'modal_launch', 'modal_submit'))
);
--> statement-breakpoint
CREATE TABLE "slack_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_intent_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"message_ts" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"endpoint_class" text NOT NULL,
	"principal_fingerprint" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_buckets_count_check" CHECK ("rate_limit_buckets"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "retention_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "retention_holds_status_check" CHECK ("retention_holds"."status" in ('active','released'))
);
--> statement-breakpoint
CREATE TABLE "retention_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"category" text NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"deleted_count" integer NOT NULL,
	"selected_ids_sha256" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_tombstones_count_check" CHECK ("retention_tombstones"."deleted_count" >= 0),
	CONSTRAINT "retention_tombstones_sha_check" CHECK ("retention_tombstones"."selected_ids_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "project_aliases" DROP CONSTRAINT "project_aliases_source_check";--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD CONSTRAINT "slack_delivery_operations_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_apply_reports" ADD CONSTRAINT "import_apply_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_apply_reports" ADD CONSTRAINT "import_apply_reports_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_conflicts" ADD CONSTRAINT "import_conflicts_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_conflicts" ADD CONSTRAINT "import_conflicts_entry_id_import_manifest_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."import_manifest_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_manifest_entries" ADD CONSTRAINT "import_manifest_entries_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_manifest_entries" ADD CONSTRAINT "import_manifest_entries_source_artifact_id_source_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."source_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_import_source_id_import_sources_id_fk" FOREIGN KEY ("import_source_id") REFERENCES "public"."import_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_source_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_aliases" ADD CONSTRAINT "legacy_aliases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_aliases" ADD CONSTRAINT "legacy_aliases_source_project_id_projects_id_fk" FOREIGN KEY ("source_project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_aliases" ADD CONSTRAINT "legacy_aliases_source_artifact_id_source_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."source_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_aliases" ADD CONSTRAINT "legacy_aliases_canonical_request_id_requests_id_fk" FOREIGN KEY ("canonical_request_id") REFERENCES "public"."requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_mappings" ADD CONSTRAINT "legacy_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_mappings" ADD CONSTRAINT "legacy_mappings_source_artifact_id_source_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."source_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_mappings" ADD CONSTRAINT "legacy_mappings_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifacts" ADD CONSTRAINT "source_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifacts" ADD CONSTRAINT "source_artifacts_import_source_id_import_sources_id_fk" FOREIGN KEY ("import_source_id") REFERENCES "public"."import_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifacts" ADD CONSTRAINT "source_artifacts_source_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_import_source_id_import_sources_id_fk" FOREIGN KEY ("import_source_id") REFERENCES "public"."import_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_installed_by_user_id_user_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_oauth_states" ADD CONSTRAINT "slack_oauth_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_oauth_states" ADD CONSTRAINT "slack_oauth_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_routes" ADD CONSTRAINT "slack_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_routes" ADD CONSTRAINT "slack_routes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_mappings" ADD CONSTRAINT "slack_user_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_mappings" ADD CONSTRAINT "slack_user_mappings_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_mappings" ADD CONSTRAINT "slack_user_mappings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_notification_intent_id_notification_intents_id_fk" FOREIGN KEY ("notification_intent_id") REFERENCES "public"."notification_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_action_tokens" ADD CONSTRAINT "slack_action_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_action_tokens" ADD CONSTRAINT "slack_action_tokens_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_action_tokens" ADD CONSTRAINT "slack_action_tokens_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_action_tokens" ADD CONSTRAINT "slack_action_tokens_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_deliveries" ADD CONSTRAINT "slack_deliveries_notification_intent_id_notification_intents_id_fk" FOREIGN KEY ("notification_intent_id") REFERENCES "public"."notification_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_deliveries" ADD CONSTRAINT "slack_deliveries_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_tombstones" ADD CONSTRAINT "retention_tombstones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatcher_receipts_outbox_task_unique" ON "dispatcher_receipts" USING btree ("outbox_id","task_name");--> statement-breakpoint
CREATE INDEX "dispatcher_receipts_lease_idx" ON "dispatcher_receipts" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_callback_receipts_event_unique" ON "provider_callback_receipts" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_delivery_operations_key_unique" ON "slack_delivery_operations" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_attempts_delivery_attempt_unique" ON "webhook_attempts" USING btree ("delivery_id","attempt_number");--> statement-breakpoint
CREATE INDEX "webhook_attempts_retry_idx" ON "webhook_attempts" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_replay_unique" ON "webhook_deliveries" USING btree ("subscription_id","event_id","replay_number");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_apply_reports_run_unique" ON "import_apply_reports" USING btree ("import_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_conflicts_entry_kind_unique" ON "import_conflicts" USING btree ("entry_id","kind");--> statement-breakpoint
CREATE INDEX "import_conflicts_run_idx" ON "import_conflicts" USING btree ("import_run_id","severity");--> statement-breakpoint
CREATE UNIQUE INDEX "import_manifest_entries_record_unique" ON "import_manifest_entries" USING btree ("import_run_id","source_artifact_id","record_index");--> statement-breakpoint
CREATE INDEX "import_runs_org_state_idx" ON "import_runs" USING btree ("organization_id","state","created_at");--> statement-breakpoint
CREATE INDEX "import_sources_org_project_idx" ON "import_sources" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_aliases_identity_unique" ON "legacy_aliases" USING btree ("source_project_id","namespace","normalized_key","source_artifact_id","record_index");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_mappings_artifact_record_unique" ON "legacy_mappings" USING btree ("source_artifact_id","record_index");--> statement-breakpoint
CREATE UNIQUE INDEX "source_artifacts_snapshot_path_unique" ON "source_artifacts" USING btree ("import_source_id","source_snapshot_id","relative_path");--> statement-breakpoint
CREATE INDEX "source_artifacts_hash_idx" ON "source_artifacts" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "source_snapshots_source_idx" ON "source_snapshots" USING btree ("import_source_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_installations_active_workspace_unique" ON "slack_installations" USING btree ("organization_id","workspace_id") WHERE "slack_installations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "slack_installations_org_idx" ON "slack_installations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_oauth_states_hash_unique" ON "slack_oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "slack_oauth_states_expiry_idx" ON "slack_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_routes_active_project_unique" ON "slack_routes" USING btree ("organization_id","project_id") WHERE "slack_routes"."status" = 'active' and "slack_routes"."project_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_routes_active_organization_unique" ON "slack_routes" USING btree ("organization_id") WHERE "slack_routes"."status" = 'active' and "slack_routes"."project_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_mappings_installation_slack_unique" ON "slack_user_mappings" USING btree ("installation_id","slack_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_mappings_installation_user_unique" ON "slack_user_mappings" USING btree ("installation_id","user_id");--> statement-breakpoint
CREATE INDEX "slack_user_mappings_org_idx" ON "slack_user_mappings" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_org_status_idx" ON "webhook_subscriptions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_project_idx" ON "webhook_subscriptions" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_idempotency_unique" ON "email_deliveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_provider_unique" ON "email_deliveries" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "notification_intents_pending_idx" ON "notification_intents" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_intents_event_channel_recipient_unique" ON "notification_intents" USING btree ("event_id","channel","recipient_ref","template");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_intents_dedupe_unique" ON "notification_intents" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_action_tokens_hash_unique" ON "slack_action_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "slack_action_tokens_expiry_idx" ON "slack_action_tokens" USING btree ("expires_at","consumed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_deliveries_intent_unique" ON "slack_deliveries" USING btree ("notification_intent_id","installation_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_buckets_identity_unique" ON "rate_limit_buckets" USING btree ("environment","endpoint_class","principal_fingerprint","window_started_at");--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_expiry_idx" ON "rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_holds_active_unique" ON "retention_holds" USING btree ("organization_id","category") WHERE "retention_holds"."status" = 'active';--> statement-breakpoint
CREATE INDEX "retention_tombstones_category_idx" ON "retention_tombstones" USING btree ("category","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_oauth_grants_active_client_user_unique" ON "agent_oauth_grants" USING btree ("user_id","oauth_client_id") WHERE "agent_oauth_grants"."status" = 'active' and "agent_oauth_grants"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "project_aliases" ADD CONSTRAINT "project_aliases_source_check" CHECK ("project_aliases"."source" in ('manual', 'rename', 'import', 'agent'));--> statement-breakpoint

CREATE FUNCTION "requestport_guard_source_snapshot_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'source_snapshots is immutable' USING ERRCODE = '55000';
	END IF;
	IF NEW.id <> OLD.id
		OR NEW.organization_id <> OLD.organization_id
		OR NEW.import_source_id <> OLD.import_source_id
		OR NEW.git_commit_sha IS DISTINCT FROM OLD.git_commit_sha
		OR NEW.dirty <> OLD.dirty
		OR NEW.manifest_sha256 <> OLD.manifest_sha256
		OR NEW.captured_at <> OLD.captured_at
		OR NEW.created_at <> OLD.created_at
		OR NOT (
			(OLD.status = 'capturing' AND NEW.status IN ('captured', 'blocked'))
			OR (OLD.status = 'captured' AND NEW.status = 'analyzed')
			OR OLD.status = NEW.status
		)
	THEN
		RAISE EXCEPTION 'source_snapshots immutable fields cannot change' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "source_snapshots_immutable"
BEFORE UPDATE OR DELETE ON "source_snapshots"
FOR EACH ROW EXECUTE FUNCTION "requestport_guard_source_snapshot_mutation"();--> statement-breakpoint

CREATE FUNCTION "requestport_guard_source_artifact_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'source_artifacts is immutable' USING ERRCODE = '55000';
	END IF;
	IF NEW.id <> OLD.id
		OR NEW.organization_id <> OLD.organization_id
		OR NEW.import_source_id <> OLD.import_source_id
		OR NEW.source_snapshot_id <> OLD.source_snapshot_id
		OR NEW.relative_path <> OLD.relative_path
		OR NEW.media_type <> OLD.media_type
		OR NEW.byte_size <> OLD.byte_size
		OR NEW.sha256 <> OLD.sha256
		OR NEW.exact_bytes <> OLD.exact_bytes
		OR NEW.created_at <> OLD.created_at
		OR NOT (
			(OLD.secret_scan_status = 'blocked' AND NEW.secret_scan_status = 'reviewed')
			OR OLD.secret_scan_status = NEW.secret_scan_status
		)
	THEN
		RAISE EXCEPTION 'source_artifacts immutable fields cannot change' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "source_artifacts_immutable"
BEFORE UPDATE OR DELETE ON "source_artifacts"
FOR EACH ROW EXECUTE FUNCTION "requestport_guard_source_artifact_mutation"();--> statement-breakpoint

CREATE FUNCTION "requestport_guard_frozen_import_entry"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM import_runs
		WHERE id = OLD.import_run_id
		AND state IN ('approved', 'applying', 'applied')
	) THEN
		RAISE EXCEPTION 'approved import manifest entries are immutable' USING ERRCODE = '55000';
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "import_manifest_entries_frozen"
BEFORE UPDATE OR DELETE ON "import_manifest_entries"
FOR EACH ROW EXECUTE FUNCTION "requestport_guard_frozen_import_entry"();--> statement-breakpoint

CREATE TRIGGER "import_apply_reports_append_only"
BEFORE UPDATE OR DELETE ON "import_apply_reports"
FOR EACH ROW EXECUTE FUNCTION "requestport_reject_append_only_mutation"();--> statement-breakpoint

CREATE TRIGGER "legacy_mappings_append_only"
BEFORE UPDATE OR DELETE ON "legacy_mappings"
FOR EACH ROW EXECUTE FUNCTION "requestport_reject_append_only_mutation"();--> statement-breakpoint

CREATE TRIGGER "legacy_aliases_append_only"
BEFORE UPDATE OR DELETE ON "legacy_aliases"
FOR EACH ROW EXECUTE FUNCTION "requestport_reject_append_only_mutation"();--> statement-breakpoint

CREATE TRIGGER "retention_tombstones_append_only"
BEFORE UPDATE OR DELETE ON "retention_tombstones"
FOR EACH ROW EXECUTE FUNCTION "requestport_reject_append_only_mutation"();
