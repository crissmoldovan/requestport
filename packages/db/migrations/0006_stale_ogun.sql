CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" integer NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"request_id" uuid,
	"actor" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"causation_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"links" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "domain_events_aggregate_version_check" CHECK ("domain_events"."aggregate_version" > 0),
	CONSTRAINT "domain_events_schema_version_check" CHECK ("domain_events"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"trigger_run_id" text,
	"accepted_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_state_check" CHECK ("outbox"."state" in ('pending', 'leased', 'accepted', 'dead_letter')),
	CONSTRAINT "outbox_attempt_count_check" CHECK ("outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "command_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_fingerprint" text NOT NULL,
	"command_name" text NOT NULL,
	"idempotency_fingerprint" text NOT NULL,
	"normalized_input_hash" text NOT NULL,
	"aggregate_id" uuid,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"source_channel" text NOT NULL,
	"body_md" text NOT NULL,
	"structured_value" jsonb,
	"accepted" boolean DEFAULT true NOT NULL,
	"supersedes_answer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answers_actor_type_check" CHECK ("answers"."actor_type" in ('user', 'agent', 'service')),
	CONSTRAINT "answers_source_channel_check" CHECK ("answers"."source_channel" in ('web', 'mcp', 'slack', 'email', 'import'))
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_url" text NOT NULL,
	"media_type" text,
	"byte_size" integer,
	"sha256" text,
	"provenance" jsonb NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_actor_type_check" CHECK ("artifacts"."created_by_type" in ('user', 'agent', 'service')),
	CONSTRAINT "artifacts_byte_size_check" CHECK ("artifacts"."byte_size" is null or "artifacts"."byte_size" >= 0),
	CONSTRAINT "artifacts_sha256_check" CHECK ("artifacts"."sha256" is null or "artifacts"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "message_mentions" (
	"message_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_mentions_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"body_md" text NOT NULL,
	"visibility" text DEFAULT 'organization' NOT NULL,
	"reply_to_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_actor_type_check" CHECK ("messages"."actor_type" in ('user', 'agent', 'service')),
	CONSTRAINT "messages_visibility_check" CHECK ("messages"."visibility" in ('organization', 'restricted'))
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"parent_request_id" uuid,
	"audience_type" text NOT NULL,
	"audience_id" text,
	"body_md" text NOT NULL,
	"answer_mode" text DEFAULT 'single' NOT NULL,
	"blocks_request" boolean DEFAULT false NOT NULL,
	"resume_state" text,
	"state" text DEFAULT 'open' NOT NULL,
	"deadline_at" timestamp with time zone,
	"escalation_policy" jsonb DEFAULT 'null'::jsonb,
	"closed_by_type" text,
	"closed_by_id" text,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "questions_subject_type_check" CHECK ("questions"."subject_type" in ('request', 'evaluation_run')),
	CONSTRAINT "questions_request_subject_check" CHECK ("questions"."subject_type" <> 'request' or "questions"."parent_request_id" = "questions"."subject_id"),
	CONSTRAINT "questions_audience_type_check" CHECK ("questions"."audience_type" in ('user', 'agent', 'role', 'requester', 'project_maintainers')),
	CONSTRAINT "questions_audience_id_check" CHECK ("questions"."audience_type" in ('requester', 'project_maintainers') or "questions"."audience_id" is not null),
	CONSTRAINT "questions_answer_mode_check" CHECK ("questions"."answer_mode" in ('single', 'multiple')),
	CONSTRAINT "questions_blocking_mode_check" CHECK ("questions"."blocks_request" = false or "questions"."answer_mode" = 'single'),
	CONSTRAINT "questions_resume_state_check" CHECK ("questions"."resume_state" is null or "questions"."resume_state" in ('triage', 'accepted', 'planned', 'in_progress', 'completed')),
	CONSTRAINT "questions_state_check" CHECK ("questions"."state" in ('open', 'answered', 'closed')),
	CONSTRAINT "questions_closed_actor_check" CHECK (("questions"."closed_by_type" is null and "questions"."closed_by_id" is null and "questions"."closed_at" is null)
        or ("questions"."closed_by_type" in ('user', 'agent', 'service') and "questions"."closed_by_id" is not null and "questions"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "user_request_read_states" (
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"last_seen_event_id" uuid,
	"last_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_request_read_states_organization_id_user_id_request_id_pk" PRIMARY KEY("organization_id","user_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "project_sequences" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"next_request_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "project_sequences_organization_id_project_id_pk" PRIMARY KEY("organization_id","project_id"),
	CONSTRAINT "project_sequences_next_request_number_check" CHECK ("project_sequences"."next_request_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "request_acceptance_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"satisfied_at" timestamp with time zone,
	CONSTRAINT "request_acceptance_criteria_position_check" CHECK ("request_acceptance_criteria"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "request_labels" (
	"request_id" uuid NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "request_labels_request_id_label_pk" PRIMARY KEY("request_id","label")
);
--> statement-breakpoint
CREATE TABLE "request_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_request_id" uuid NOT NULL,
	"to_request_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_relationships_type_check" CHECK ("request_relationships"."type" in ('blocks', 'depends_on', 'duplicates', 'supersedes', 'related_to', 'derived_from')),
	CONSTRAINT "request_relationships_actor_type_check" CHECK ("request_relationships"."created_by_type" in ('user', 'agent', 'service')),
	CONSTRAINT "request_relationships_distinct_endpoints_check" CHECK ("request_relationships"."from_request_id" <> "request_relationships"."to_request_id")
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_number" integer,
	"display_key" text,
	"source_kind" text NOT NULL,
	"source_project_id" uuid,
	"target_project_id" uuid NOT NULL,
	"lane_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description_md" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"resume_state" text,
	"state_reason" text,
	"reporter_type" text NOT NULL,
	"reporter_id" text NOT NULL,
	"assignee_type" text,
	"assignee_id" text,
	"visibility" text DEFAULT 'organization' NOT NULL,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"routing_rule_id" uuid,
	"routing_policy_version" integer,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_source_kind_check" CHECK ("requests"."source_kind" in ('project', 'human_direct')),
	CONSTRAINT "requests_source_project_check" CHECK (("requests"."source_kind" = 'project' and "requests"."source_project_id" is not null)
        or ("requests"."source_kind" = 'human_direct' and "requests"."source_project_id" is null)),
	CONSTRAINT "requests_type_check" CHECK ("requests"."type" in ('feature', 'bug', 'question', 'chore', 'investigation')),
	CONSTRAINT "requests_priority_check" CHECK ("requests"."priority" in ('urgent', 'high', 'normal', 'low')),
	CONSTRAINT "requests_state_check" CHECK ("requests"."state" in ('draft', 'submitted', 'triage', 'accepted', 'planned', 'in_progress', 'blocked', 'waiting_human', 'waiting_requester', 'completed', 'verified', 'declined', 'duplicate', 'superseded', 'cancelled')),
	CONSTRAINT "requests_resume_state_check" CHECK ("requests"."resume_state" is null or "requests"."resume_state" in ('triage', 'accepted', 'planned', 'in_progress', 'completed')),
	CONSTRAINT "requests_reporter_type_check" CHECK ("requests"."reporter_type" in ('user', 'agent', 'service')),
	CONSTRAINT "requests_assignee_check" CHECK (("requests"."assignee_type" is null and "requests"."assignee_id" is null)
        or ("requests"."assignee_type" in ('user', 'agent') and "requests"."assignee_id" is not null)),
	CONSTRAINT "requests_visibility_check" CHECK ("requests"."visibility" in ('organization', 'restricted')),
	CONSTRAINT "requests_sensitivity_check" CHECK ("requests"."sensitivity" in ('normal', 'sensitive')),
	CONSTRAINT "requests_version_check" CHECK ("requests"."version" >= 0),
	CONSTRAINT "requests_display_sequence_check" CHECK (("requests"."state" = 'draft' and "requests"."sequence_number" is null and "requests"."display_key" is null)
        or ("requests"."state" <> 'draft' and "requests"."sequence_number" is not null and "requests"."display_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "lanes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lanes_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "lanes_status_check" CHECK ("lanes"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_project_id" uuid,
	"target_project_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"request_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lane_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priorities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"human_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_principal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"specificity" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_rules_source_kind_check" CHECK ("routing_rules"."source_kind" in ('project', 'human_direct')),
	CONSTRAINT "routing_rules_source_project_check" CHECK (("routing_rules"."source_kind" = 'project' and "routing_rules"."source_project_id" is not null)
        or ("routing_rules"."source_kind" = 'human_direct' and "routing_rules"."source_project_id" is null)),
	CONSTRAINT "routing_rules_decision_check" CHECK ("routing_rules"."decision" in ('allow', 'deny')),
	CONSTRAINT "routing_rules_version_check" CHECK ("routing_rules"."version" > 0),
	CONSTRAINT "routing_rules_specificity_check" CHECK ("routing_rules"."specificity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "completion_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"outcome_md" text NOT NULL,
	"changed_repositories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risks_md" text NOT NULL,
	"followups_md" text NOT NULL,
	"verification_steps_md" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "completion_reports_actor_type_check" CHECK ("completion_reports"."actor_type" in ('user', 'agent', 'service'))
);
--> statement-breakpoint
CREATE TABLE "state_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_version" integer NOT NULL,
	"event_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "state_transitions_actor_type_check" CHECK ("state_transitions"."actor_type" in ('user', 'agent', 'service')),
	CONSTRAINT "state_transitions_version_check" CHECK ("state_transitions"."request_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_parent_request_id_requests_id_fk" FOREIGN KEY ("parent_request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_request_read_states" ADD CONSTRAINT "user_request_read_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_request_read_states" ADD CONSTRAINT "user_request_read_states_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_request_read_states" ADD CONSTRAINT "user_request_read_states_last_seen_event_id_domain_events_id_fk" FOREIGN KEY ("last_seen_event_id") REFERENCES "public"."domain_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sequences" ADD CONSTRAINT "project_sequences_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_acceptance_criteria" ADD CONSTRAINT "request_acceptance_criteria_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_labels" ADD CONSTRAINT "request_labels_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_relationships" ADD CONSTRAINT "request_relationships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_relationships" ADD CONSTRAINT "request_relationships_from_request_id_requests_id_fk" FOREIGN KEY ("from_request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_relationships" ADD CONSTRAINT "request_relationships_to_request_id_requests_id_fk" FOREIGN KEY ("to_request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_routing_rule_id_routing_rules_id_fk" FOREIGN KEY ("routing_rule_id") REFERENCES "public"."routing_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_source_project_fk" FOREIGN KEY ("organization_id","source_project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_target_project_fk" FOREIGN KEY ("organization_id","target_project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_lane_fk" FOREIGN KEY ("organization_id","lane_id") REFERENCES "public"."lanes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_source_project_fk" FOREIGN KEY ("organization_id","source_project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_target_project_fk" FOREIGN KEY ("organization_id","target_project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_reports" ADD CONSTRAINT "completion_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_reports" ADD CONSTRAINT "completion_reports_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_events_aggregate_version_unique" ON "domain_events" USING btree ("organization_id","aggregate_type","aggregate_id","aggregate_version");--> statement-breakpoint
CREATE INDEX "domain_events_organization_occurred_idx" ON "domain_events" USING btree ("organization_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "domain_events_project_idx" ON "domain_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "domain_events_request_idx" ON "domain_events" USING btree ("request_id","occurred_at");--> statement-breakpoint
CREATE INDEX "domain_events_type_idx" ON "domain_events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "domain_events_correlation_idx" ON "domain_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_event_unique" ON "outbox" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "outbox_dispatch_idx" ON "outbox" USING btree ("state","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "outbox_lease_expiry_idx" ON "outbox" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "command_receipts_actor_command_key_unique" ON "command_receipts" USING btree ("actor_fingerprint","command_name","idempotency_fingerprint");--> statement-breakpoint
CREATE INDEX "command_receipts_expires_at_idx" ON "command_receipts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "command_receipts_aggregate_id_idx" ON "command_receipts" USING btree ("aggregate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "answers_question_single_accepted_unique" ON "answers" USING btree ("question_id") WHERE "answers"."accepted" = true;--> statement-breakpoint
CREATE INDEX "answers_question_created_idx" ON "answers" USING btree ("question_id","created_at","id");--> statement-breakpoint
CREATE INDEX "artifacts_request_created_idx" ON "artifacts" USING btree ("request_id","created_at","id");--> statement-breakpoint
CREATE INDEX "message_mentions_user_idx" ON "message_mentions" USING btree ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_request_created_idx" ON "messages" USING btree ("request_id","created_at","id");--> statement-breakpoint
CREATE INDEX "messages_reply_to_idx" ON "messages" USING btree ("reply_to_id");--> statement-breakpoint
CREATE INDEX "questions_request_state_idx" ON "questions" USING btree ("parent_request_id","state","created_at");--> statement-breakpoint
CREATE INDEX "questions_audience_state_idx" ON "questions" USING btree ("organization_id","audience_type","audience_id","state");--> statement-breakpoint
CREATE INDEX "questions_deadline_idx" ON "questions" USING btree ("state","deadline_at");--> statement-breakpoint
CREATE INDEX "user_request_read_states_user_idx" ON "user_request_read_states" USING btree ("organization_id","user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "request_acceptance_criteria_position_unique" ON "request_acceptance_criteria" USING btree ("request_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "request_relationships_unique" ON "request_relationships" USING btree ("organization_id","from_request_id","to_request_id","type");--> statement-breakpoint
CREATE INDEX "request_relationships_from_idx" ON "request_relationships" USING btree ("from_request_id");--> statement-breakpoint
CREATE INDEX "request_relationships_to_idx" ON "request_relationships" USING btree ("to_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_project_sequence_unique" ON "requests" USING btree ("target_project_id","sequence_number") WHERE "requests"."sequence_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "requests_project_display_key_unique" ON "requests" USING btree ("target_project_id","display_key") WHERE "requests"."display_key" is not null;--> statement-breakpoint
CREATE INDEX "requests_organization_updated_idx" ON "requests" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "requests_target_state_idx" ON "requests" USING btree ("target_project_id","state");--> statement-breakpoint
CREATE INDEX "requests_source_project_idx" ON "requests" USING btree ("source_project_id");--> statement-breakpoint
CREATE INDEX "requests_assignee_idx" ON "requests" USING btree ("assignee_type","assignee_id");--> statement-breakpoint
CREATE INDEX "requests_reporter_idx" ON "requests" USING btree ("reporter_type","reporter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lanes_project_slug_ci_unique" ON "lanes" USING btree ("organization_id","project_id",lower("slug"));--> statement-breakpoint
CREATE INDEX "lanes_project_idx" ON "lanes" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "routing_rules_organization_idx" ON "routing_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "routing_rules_route_idx" ON "routing_rules" USING btree ("organization_id","source_kind","source_project_id","target_project_id");--> statement-breakpoint
CREATE INDEX "routing_rules_target_idx" ON "routing_rules" USING btree ("target_project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "completion_reports_request_unique" ON "completion_reports" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "completion_reports_organization_created_idx" ON "completion_reports" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "state_transitions_request_version_unique" ON "state_transitions" USING btree ("request_id","request_version");--> statement-breakpoint
CREATE UNIQUE INDEX "state_transitions_event_unique" ON "state_transitions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "state_transitions_request_occurred_idx" ON "state_transitions" USING btree ("request_id","occurred_at","id");
--> statement-breakpoint
CREATE FUNCTION "requestport_reject_append_only_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "domain_events_append_only"
BEFORE UPDATE OR DELETE ON "domain_events"
FOR EACH ROW EXECUTE FUNCTION "requestport_reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "state_transitions_append_only"
BEFORE UPDATE OR DELETE ON "state_transitions"
FOR EACH ROW EXECUTE FUNCTION "requestport_reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "completion_reports_append_only"
BEFORE UPDATE OR DELETE ON "completion_reports"
FOR EACH ROW EXECUTE FUNCTION "requestport_reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "answers_append_only"
BEFORE UPDATE OR DELETE ON "answers"
FOR EACH ROW EXECUTE FUNCTION "requestport_reject_append_only_mutation"();
