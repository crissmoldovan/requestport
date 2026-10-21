CREATE TABLE "import_task_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_run_id" uuid NOT NULL,
	"task_kind" text NOT NULL,
	"task_payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"trigger_run_id" text,
	"last_error_code" text,
	"accepted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_task_dispatches_kind_check" CHECK ("import_task_dispatches"."task_kind" in ('analyze', 'apply')),
	CONSTRAINT "import_task_dispatches_state_check" CHECK ("import_task_dispatches"."state" in ('pending', 'leased', 'accepted', 'completed', 'dead_letter')),
	CONSTRAINT "import_task_dispatches_attempt_count_check" CHECK ("import_task_dispatches"."attempt_count" >= 0),
	CONSTRAINT "import_task_dispatches_lease_check" CHECK (("import_task_dispatches"."state" = 'leased' and "import_task_dispatches"."lease_owner" is not null and "import_task_dispatches"."lease_expires_at" is not null) or ("import_task_dispatches"."state" <> 'leased' and "import_task_dispatches"."lease_owner" is null and "import_task_dispatches"."lease_expires_at" is null)),
	CONSTRAINT "import_task_dispatches_acceptance_check" CHECK ("import_task_dispatches"."state" <> 'accepted' or ("import_task_dispatches"."trigger_run_id" is not null and "import_task_dispatches"."accepted_at" is not null)),
	CONSTRAINT "import_task_dispatches_completion_check" CHECK (("import_task_dispatches"."state" = 'completed' and "import_task_dispatches"."completed_at" is not null) or ("import_task_dispatches"."state" <> 'completed' and "import_task_dispatches"."completed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_state_check";--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" DROP CONSTRAINT "slack_delivery_operations_status_check";--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" DROP CONSTRAINT "webhook_subscriptions_rotation_check";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_closed_actor_check";--> statement-breakpoint
ALTER TABLE "work_sessions" DROP CONSTRAINT "work_sessions_lease_policy_check";--> statement-breakpoint
DROP INDEX "agent_oauth_grants_provider_binding_unique";--> statement-breakpoint
DROP INDEX "slack_delivery_operations_pending_idx";--> statement-breakpoint
DROP INDEX "notification_intents_pending_idx";--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "notification_intents" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "event_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "lease_multiplier" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "grace_seconds" integer DEFAULT 900 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_task_dispatches" ADD CONSTRAINT "import_task_dispatches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_task_dispatches" ADD CONSTRAINT "import_task_dispatches_run_fk" FOREIGN KEY ("organization_id","import_run_id") REFERENCES "public"."import_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_task_dispatches_run_kind_unique" ON "import_task_dispatches" USING btree ("import_run_id","task_kind");--> statement-breakpoint
CREATE INDEX "import_task_dispatches_repair_idx" ON "import_task_dispatches" USING btree ("state","updated_at","id");--> statement-breakpoint
CREATE INDEX "agent_oauth_grants_provider_binding_idx" ON "agent_oauth_grants" USING btree ("user_id","oauth_client_id","provider_grant_id");--> statement-breakpoint
CREATE INDEX "slack_delivery_operations_lease_idx" ON "slack_delivery_operations" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "notification_intents_lease_idx" ON "notification_intents" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "slack_delivery_operations_pending_idx" ON "slack_delivery_operations" USING btree ("operation_type","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_intents_pending_idx" ON "notification_intents" USING btree ("channel","status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_lease_check" CHECK (("outbox"."state" = 'leased' and "outbox"."lease_owner" is not null and "outbox"."lease_expires_at" is not null)
        or ("outbox"."state" <> 'leased' and "outbox"."lease_owner" is null and "outbox"."lease_expires_at" is null));--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_state_check" CHECK ("outbox"."state" in ('pending', 'leased', 'accepted', 'completed', 'dead_letter'));--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD CONSTRAINT "slack_delivery_operations_attempt_check" CHECK ("slack_delivery_operations"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD CONSTRAINT "slack_delivery_operations_lease_check" CHECK (("slack_delivery_operations"."status" = 'delivering' and "slack_delivery_operations"."lease_owner" is not null and "slack_delivery_operations"."lease_expires_at" is not null)
      or ("slack_delivery_operations"."status" <> 'delivering' and "slack_delivery_operations"."lease_owner" is null and "slack_delivery_operations"."lease_expires_at" is null));--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD CONSTRAINT "slack_delivery_operations_status_check" CHECK ("slack_delivery_operations"."status" in ('pending', 'delivering', 'retry', 'delivered', 'failed'));--> statement-breakpoint
ALTER TABLE "slack_routes" ADD CONSTRAINT "slack_routes_channel_check" CHECK ("slack_routes"."mode" = 'dm' or "slack_routes"."channel_id" is not null);--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_verification_check" CHECK ("webhook_subscriptions"."status" <> 'active' or "webhook_subscriptions"."verified_at" is not null);--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_rotation_check" CHECK (("webhook_subscriptions"."next_secret_ciphertext" is null and "webhook_subscriptions"."next_secret_key_id" is null and "webhook_subscriptions"."overlap_ends_at" is null) or ("webhook_subscriptions"."next_secret_ciphertext" is not null and "webhook_subscriptions"."next_secret_key_id" is not null and "webhook_subscriptions"."overlap_ends_at" is not null and "webhook_subscriptions"."next_secret_key_id" <> "webhook_subscriptions"."current_secret_key_id"));--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_status_check" CHECK ("email_deliveries"."status" in ('pending','queued','scheduled','sent','delivered','opened','clicked','delivery_delayed','failed','bounced','complained','suppressed','canceled'));--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_attempt_count_check" CHECK ("notification_intents"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_lease_check" CHECK (("notification_intents"."status" = 'delivering' and "notification_intents"."lease_owner" is not null and "notification_intents"."lease_expires_at" is not null)
      or ("notification_intents"."status" <> 'delivering' and "notification_intents"."lease_owner" is null and "notification_intents"."lease_expires_at" is null));--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_schedule_check" CHECK (("notification_intents"."status" in ('delivered','suppressed') and "notification_intents"."next_attempt_at" is null)
      or "notification_intents"."status" in ('pending','delivering','failed'));--> statement-breakpoint
ALTER TABLE "slack_deliveries" ADD CONSTRAINT "slack_deliveries_status_check" CHECK ("slack_deliveries"."status" in ('pending','delivered','failed'));--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_closed_actor_check" CHECK (("questions"."state" = 'open' and "questions"."closed_by_type" is null and "questions"."closed_by_id" is null and "questions"."closed_reason" is null and "questions"."closed_at" is null)
        or ("questions"."state" in ('answered', 'closed') and "questions"."closed_by_type" in ('user', 'agent', 'service') and "questions"."closed_by_id" is not null and "questions"."closed_reason" is not null and "questions"."closed_at" is not null));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_resume_state_lifecycle_check" CHECK (("requests"."state" in ('blocked', 'waiting_human', 'waiting_requester') and "requests"."resume_state" is not null)
        or ("requests"."state" not in ('blocked', 'waiting_human', 'waiting_requester') and "requests"."resume_state" is null));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_sensitive_visibility_check" CHECK ("requests"."sensitivity" <> 'sensitive' or "requests"."visibility" = 'restricted');--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_terminal_timestamp_check" CHECK (("work_sessions"."state" in ('abandoned', 'ended') and "work_sessions"."ended_at" is not null)
        or ("work_sessions"."state" not in ('abandoned', 'ended') and "work_sessions"."ended_at" is null));--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_event_version_check" CHECK ("work_sessions"."event_version" > 0 and "work_sessions"."event_version" <= "work_sessions"."version");--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_lease_policy_check" CHECK ("work_sessions"."heartbeat_interval_seconds" between 10 and 3600 and "work_sessions"."lease_multiplier" between 2 and 10 and "work_sessions"."grace_seconds" between 60 and 86400 and "work_sessions"."grace_expires_at" >= "work_sessions"."lease_expires_at");