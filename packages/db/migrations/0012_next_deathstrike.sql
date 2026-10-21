ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk";
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_id_domain_events_id_fk";
--> statement-breakpoint
ALTER TABLE "import_apply_reports" DROP CONSTRAINT "import_apply_reports_import_run_id_import_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "import_conflicts" DROP CONSTRAINT "import_conflicts_import_run_id_import_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "import_conflicts" DROP CONSTRAINT "import_conflicts_entry_id_import_manifest_entries_id_fk";
--> statement-breakpoint
ALTER TABLE "import_entry_applications" DROP CONSTRAINT "import_entry_applications_import_run_id_import_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "import_entry_applications" DROP CONSTRAINT "import_entry_applications_entry_id_import_manifest_entries_id_fk";
--> statement-breakpoint
ALTER TABLE "import_manifest_entries" DROP CONSTRAINT "import_manifest_entries_import_run_id_import_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "import_manifest_entries" DROP CONSTRAINT "import_manifest_entries_source_artifact_id_source_artifacts_id_fk";
--> statement-breakpoint
ALTER TABLE "import_runs" DROP CONSTRAINT "import_runs_import_source_id_import_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "import_runs" DROP CONSTRAINT "import_runs_source_snapshot_id_source_snapshots_id_fk";
--> statement-breakpoint
ALTER TABLE "import_sources" DROP CONSTRAINT "import_sources_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "legacy_aliases" DROP CONSTRAINT "legacy_aliases_source_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "legacy_aliases" DROP CONSTRAINT "legacy_aliases_source_artifact_id_source_artifacts_id_fk";
--> statement-breakpoint
ALTER TABLE "legacy_aliases" DROP CONSTRAINT "legacy_aliases_canonical_request_id_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "legacy_mappings" DROP CONSTRAINT "legacy_mappings_source_artifact_id_source_artifacts_id_fk";
--> statement-breakpoint
ALTER TABLE "legacy_mappings" DROP CONSTRAINT "legacy_mappings_import_run_id_import_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "source_artifacts" DROP CONSTRAINT "source_artifacts_import_source_id_import_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "source_artifacts" DROP CONSTRAINT "source_artifacts_source_snapshot_id_source_snapshots_id_fk";
--> statement-breakpoint
ALTER TABLE "source_snapshots" DROP CONSTRAINT "source_snapshots_import_source_id_import_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_routes" DROP CONSTRAINT "slack_routes_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_user_mappings" DROP CONSTRAINT "slack_user_mappings_installation_id_slack_installations_id_fk";
--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" DROP CONSTRAINT "webhook_subscriptions_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "email_deliveries" DROP CONSTRAINT "email_deliveries_notification_intent_id_notification_intents_id_fk";
--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_event_id_domain_events_id_fk";
--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_invitation_id_invitations_id_fk";
--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_question_id_questions_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_action_tokens" DROP CONSTRAINT "slack_action_tokens_question_id_questions_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_action_tokens" DROP CONSTRAINT "slack_action_tokens_installation_id_slack_installations_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_action_tokens" DROP CONSTRAINT "slack_action_tokens_answer_id_answers_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_deliveries" DROP CONSTRAINT "slack_deliveries_notification_intent_id_notification_intents_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_deliveries" DROP CONSTRAINT "slack_deliveries_installation_id_slack_installations_id_fk";
--> statement-breakpoint
ALTER TABLE "answers" DROP CONSTRAINT "answers_question_id_questions_id_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_request_id_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "message_mentions" DROP CONSTRAINT "message_mentions_message_id_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_request_id_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_parent_request_id_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "user_request_read_states" DROP CONSTRAINT "user_request_read_states_request_id_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "user_request_read_states" DROP CONSTRAINT "user_request_read_states_last_seen_event_id_domain_events_id_fk";
--> statement-breakpoint
ALTER TABLE "request_relationships" DROP CONSTRAINT "request_relationships_from_request_id_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "request_relationships" DROP CONSTRAINT "request_relationships_to_request_id_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "requests" DROP CONSTRAINT "requests_routing_rule_id_routing_rules_id_fk";
--> statement-breakpoint
ALTER TABLE "completion_reports" DROP CONSTRAINT "completion_reports_request_id_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "state_transitions" DROP CONSTRAINT "state_transitions_request_id_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "state_transitions" DROP CONSTRAINT "state_transitions_event_id_domain_events_id_fk";
--> statement-breakpoint
ALTER TABLE "work_sessions" ALTER COLUMN "installation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "work_sessions" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_oauth_grants" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_conflicts" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "import_manifest_entries" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "import_manifest_entries" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_deliveries" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "choices" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "allow_free_text" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_holds" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_holds" ADD COLUMN "released_by_user_id" text;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "import_manifest_entries" ADD CONSTRAINT "import_manifest_entries_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "import_manifest_entries" ADD CONSTRAINT "import_manifest_entries_run_id_id_unique" UNIQUE("import_run_id","id");--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "source_artifacts" ADD CONSTRAINT "source_artifacts_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_source_id_id_unique" UNIQUE("import_source_id","id");--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_fk" FOREIGN KEY ("organization_id","subscription_id") REFERENCES "public"."webhook_subscriptions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."domain_events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_apply_reports" ADD CONSTRAINT "import_apply_reports_run_fk" FOREIGN KEY ("organization_id","import_run_id") REFERENCES "public"."import_runs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_conflicts" ADD CONSTRAINT "import_conflicts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_conflicts" ADD CONSTRAINT "import_conflicts_run_fk" FOREIGN KEY ("organization_id","import_run_id") REFERENCES "public"."import_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_conflicts" ADD CONSTRAINT "import_conflicts_entry_fk" FOREIGN KEY ("organization_id","entry_id") REFERENCES "public"."import_manifest_entries"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_conflicts" ADD CONSTRAINT "import_conflicts_run_entry_fk" FOREIGN KEY ("import_run_id","entry_id") REFERENCES "public"."import_manifest_entries"("import_run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_entry_applications" ADD CONSTRAINT "import_entry_applications_run_fk" FOREIGN KEY ("organization_id","import_run_id") REFERENCES "public"."import_runs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_entry_applications" ADD CONSTRAINT "import_entry_applications_entry_fk" FOREIGN KEY ("organization_id","entry_id") REFERENCES "public"."import_manifest_entries"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_entry_applications" ADD CONSTRAINT "import_entry_applications_run_entry_fk" FOREIGN KEY ("import_run_id","entry_id") REFERENCES "public"."import_manifest_entries"("import_run_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_manifest_entries" ADD CONSTRAINT "import_manifest_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_manifest_entries" ADD CONSTRAINT "import_manifest_entries_run_fk" FOREIGN KEY ("organization_id","import_run_id") REFERENCES "public"."import_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_manifest_entries" ADD CONSTRAINT "import_manifest_entries_artifact_fk" FOREIGN KEY ("organization_id","source_artifact_id") REFERENCES "public"."source_artifacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_import_source_fk" FOREIGN KEY ("organization_id","import_source_id") REFERENCES "public"."import_sources"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_snapshot_fk" FOREIGN KEY ("organization_id","source_snapshot_id") REFERENCES "public"."source_snapshots"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_source_snapshot_fk" FOREIGN KEY ("import_source_id","source_snapshot_id") REFERENCES "public"."source_snapshots"("import_source_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_repository_fk" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."project_repositories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_aliases" ADD CONSTRAINT "legacy_aliases_source_project_fk" FOREIGN KEY ("organization_id","source_project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_aliases" ADD CONSTRAINT "legacy_aliases_source_artifact_fk" FOREIGN KEY ("organization_id","source_artifact_id") REFERENCES "public"."source_artifacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_aliases" ADD CONSTRAINT "legacy_aliases_canonical_request_fk" FOREIGN KEY ("organization_id","canonical_request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_mappings" ADD CONSTRAINT "legacy_mappings_source_artifact_fk" FOREIGN KEY ("organization_id","source_artifact_id") REFERENCES "public"."source_artifacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_mappings" ADD CONSTRAINT "legacy_mappings_import_run_fk" FOREIGN KEY ("organization_id","import_run_id") REFERENCES "public"."import_runs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifacts" ADD CONSTRAINT "source_artifacts_import_source_fk" FOREIGN KEY ("organization_id","import_source_id") REFERENCES "public"."import_sources"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifacts" ADD CONSTRAINT "source_artifacts_snapshot_fk" FOREIGN KEY ("organization_id","source_snapshot_id") REFERENCES "public"."source_snapshots"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_artifacts" ADD CONSTRAINT "source_artifacts_source_snapshot_fk" FOREIGN KEY ("import_source_id","source_snapshot_id") REFERENCES "public"."source_snapshots"("import_source_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_import_source_fk" FOREIGN KEY ("organization_id","import_source_id") REFERENCES "public"."import_sources"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_routes" ADD CONSTRAINT "slack_routes_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_mappings" ADD CONSTRAINT "slack_user_mappings_installation_fk" FOREIGN KEY ("organization_id","installation_id") REFERENCES "public"."slack_installations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_intent_fk" FOREIGN KEY ("organization_id","notification_intent_id") REFERENCES "public"."notification_intents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."domain_events"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_invitation_fk" FOREIGN KEY ("organization_id","invitation_id") REFERENCES "public"."invitations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_question_fk" FOREIGN KEY ("organization_id","question_id") REFERENCES "public"."questions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_action_tokens" ADD CONSTRAINT "slack_action_tokens_question_fk" FOREIGN KEY ("organization_id","question_id") REFERENCES "public"."questions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_action_tokens" ADD CONSTRAINT "slack_action_tokens_installation_fk" FOREIGN KEY ("organization_id","installation_id") REFERENCES "public"."slack_installations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_action_tokens" ADD CONSTRAINT "slack_action_tokens_answer_fk" FOREIGN KEY ("organization_id","answer_id") REFERENCES "public"."answers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_deliveries" ADD CONSTRAINT "slack_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_deliveries" ADD CONSTRAINT "slack_deliveries_intent_fk" FOREIGN KEY ("organization_id","notification_intent_id") REFERENCES "public"."notification_intents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_deliveries" ADD CONSTRAINT "slack_deliveries_installation_fk" FOREIGN KEY ("organization_id","installation_id") REFERENCES "public"."slack_installations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_fk" FOREIGN KEY ("organization_id","question_id") REFERENCES "public"."questions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_fk" FOREIGN KEY ("organization_id","reply_to_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_parent_request_fk" FOREIGN KEY ("organization_id","parent_request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_request_read_states" ADD CONSTRAINT "user_request_read_states_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_request_read_states" ADD CONSTRAINT "user_request_read_states_event_fk" FOREIGN KEY ("organization_id","last_seen_event_id") REFERENCES "public"."domain_events"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_released_by_user_id_user_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_relationships" ADD CONSTRAINT "request_relationships_from_request_fk" FOREIGN KEY ("organization_id","from_request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_relationships" ADD CONSTRAINT "request_relationships_to_request_fk" FOREIGN KEY ("organization_id","to_request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_routing_rule_fk" FOREIGN KEY ("organization_id","routing_rule_id") REFERENCES "public"."routing_rules"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_reports" ADD CONSTRAINT "completion_reports_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."domain_events"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_version_check" CHECK ("agent_credentials"."version" > 0);--> statement-breakpoint
ALTER TABLE "agent_oauth_grants" ADD CONSTRAINT "agent_oauth_grants_version_check" CHECK ("agent_oauth_grants"."version" > 0);--> statement-breakpoint
ALTER TABLE "import_manifest_entries" ADD CONSTRAINT "import_manifest_entries_version_check" CHECK ("import_manifest_entries"."version" > 0);--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_version_check" CHECK ("import_runs"."version" > 0);--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_version_check" CHECK ("source_snapshots"."version" > 0);--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_answer_input_check" CHECK ("questions"."allow_free_text" = true or jsonb_array_length("questions"."choices") > 0);--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_category_check" CHECK ("retention_holds"."category" in ('all','slack_oauth_state','slack_action_token'));--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_version_check" CHECK ("retention_holds"."version" > 0);--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_release_check" CHECK (("retention_holds"."status" = 'active' and "retention_holds"."released_at" is null and "retention_holds"."released_by_user_id" is null) or ("retention_holds"."status" = 'released' and "retention_holds"."released_at" is not null and "retention_holds"."released_by_user_id" is not null));
