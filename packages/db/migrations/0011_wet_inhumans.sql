CREATE TABLE "import_entry_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_run_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"canonical_type" text,
	"canonical_id" uuid,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_entry_applications_outcome_check" CHECK ("import_entry_applications"."outcome" in ('created', 'mapped', 'message', 'skipped', 'existing', 'corrected_message')),
	CONSTRAINT "import_entry_applications_canonical_check" CHECK (("import_entry_applications"."canonical_type" is null and "import_entry_applications"."canonical_id" is null) or ("import_entry_applications"."canonical_type" is not null and "import_entry_applications"."canonical_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD COLUMN "operation_type" text DEFAULT 'message_update' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_routes" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_user_mappings" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD COLUMN "invitation_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD COLUMN "recipient_user_id" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "heartbeat_interval_seconds" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "lease_multiplier" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "grace_seconds" integer DEFAULT 900 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "required_workspace_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_entry_applications" ADD CONSTRAINT "import_entry_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_entry_applications" ADD CONSTRAINT "import_entry_applications_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_entry_applications" ADD CONSTRAINT "import_entry_applications_entry_id_import_manifest_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."import_manifest_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_entry_applications_run_entry_unique" ON "import_entry_applications" USING btree ("import_run_id","entry_id");--> statement-breakpoint
CREATE INDEX "import_entry_applications_run_idx" ON "import_entry_applications" USING btree ("import_run_id","created_at");--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_delivery_operations_pending_idx" ON "slack_delivery_operations" USING btree ("operation_type","status","created_at");--> statement-breakpoint
CREATE INDEX "notification_intents_invitation_idx" ON "notification_intents" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "notification_intents_recipient_idx" ON "notification_intents" USING btree ("organization_id","recipient_user_id","status");--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_version_check" CHECK ("agent_principals"."version" > 0);--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD CONSTRAINT "slack_delivery_operations_type_check" CHECK ("slack_delivery_operations"."operation_type" in ('message_update', 'connection_test'));--> statement-breakpoint
ALTER TABLE "slack_delivery_operations" ADD CONSTRAINT "slack_delivery_operations_status_check" CHECK ("slack_delivery_operations"."status" in ('pending', 'retry', 'delivered', 'failed'));--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_version_check" CHECK ("slack_installations"."version" > 0);--> statement-breakpoint
ALTER TABLE "slack_routes" ADD CONSTRAINT "slack_routes_version_check" CHECK ("slack_routes"."version" > 0);--> statement-breakpoint
ALTER TABLE "slack_user_mappings" ADD CONSTRAINT "slack_user_mappings_version_check" CHECK ("slack_user_mappings"."version" > 0);--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_version_check" CHECK ("webhook_subscriptions"."version" > 0);--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_version_check" CHECK ("invitations"."version" > 0);--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_version_check" CHECK ("organization_members"."version" > 0);--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_version_check" CHECK ("organizations"."version" > 0);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_version_check" CHECK ("projects"."version" > 0);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_heartbeat_interval_check" CHECK ("projects"."heartbeat_interval_seconds" between 10 and 300);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lease_multiplier_check" CHECK ("projects"."lease_multiplier" between 2 and 10);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_grace_seconds_check" CHECK ("projects"."grace_seconds" between 60 and 86400);
--> statement-breakpoint
CREATE TRIGGER "import_entry_applications_append_only"
BEFORE UPDATE OR DELETE ON "import_entry_applications"
FOR EACH ROW EXECUTE FUNCTION "requestport_reject_append_only_mutation"();
