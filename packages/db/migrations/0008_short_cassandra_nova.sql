CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_principal_id" uuid NOT NULL,
	"better_auth_api_key_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"fingerprint" text NOT NULL,
	"audience" text NOT NULL,
	"project_id" uuid NOT NULL,
	"lane_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"overlap_expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_credentials_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "agent_credentials_audience_check" CHECK ("agent_credentials"."audience" in ('mcp', 'api'))
);
--> statement-breakpoint
CREATE TABLE "agent_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_principal_id" uuid NOT NULL,
	"oauth_grant_id" uuid,
	"credential_id" uuid,
	"software_name" text NOT NULL,
	"software_version" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_installations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "agent_installations_status_check" CHECK ("agent_installations"."status" in ('active', 'inactive', 'revoked')),
	CONSTRAINT "agent_installations_credential_source_check" CHECK (num_nonnulls("agent_installations"."oauth_grant_id", "agent_installations"."credential_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "agent_oauth_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_principal_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"oauth_client_id" text NOT NULL,
	"provider_grant_id" text NOT NULL,
	"refresh_family_id" text NOT NULL,
	"audience" text NOT NULL,
	"project_id" uuid NOT NULL,
	"lane_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_oauth_grants_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "agent_oauth_grants_audience_check" CHECK ("agent_oauth_grants"."audience" in ('mcp', 'api')),
	CONSTRAINT "agent_oauth_grants_status_check" CHECK ("agent_oauth_grants"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "agent_principals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"software_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_principals_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "agent_principals_status_check" CHECK ("agent_principals"."status" in ('active', 'suspended', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "machine_workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"safe_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"private_ciphertext" "bytea" NOT NULL,
	"private_nonce" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"kek_version" text NOT NULL,
	"telemetry_schema_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_workspaces_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "machine_workspaces_status_check" CHECK ("machine_workspaces"."status" in ('active', 'inactive', 'revoked')),
	CONSTRAINT "machine_workspaces_telemetry_schema_check" CHECK ("machine_workspaces"."telemetry_schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"agent_principal_id" uuid NOT NULL,
	"installation_id" uuid,
	"workspace_id" uuid,
	"authorization_chain" jsonb NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"claim_mode" text DEFAULT 'exclusive' NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"heartbeat_interval_seconds" integer NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"grace_expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"outcome_summary_md" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_sessions_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "work_sessions_claim_mode_check" CHECK ("work_sessions"."claim_mode" = 'exclusive'),
	CONSTRAINT "work_sessions_state_check" CHECK ("work_sessions"."state" in ('claimed', 'active', 'paused', 'blocked', 'stale', 'abandoned', 'ended')),
	CONSTRAINT "work_sessions_version_check" CHECK ("work_sessions"."version" > 0),
	CONSTRAINT "work_sessions_lease_policy_check" CHECK ("work_sessions"."heartbeat_interval_seconds" between 10 and 3600 and "work_sessions"."grace_expires_at" >= "work_sessions"."lease_expires_at")
);
--> statement-breakpoint
CREATE TABLE "work_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"work_session_id" uuid NOT NULL,
	"actor" jsonb NOT NULL,
	"kind" text NOT NULL,
	"body_md" text NOT NULL,
	"progress_percent" integer,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_updates_kind_check" CHECK ("work_updates"."kind" in ('progress', 'checkpoint', 'blocker', 'note')),
	CONSTRAINT "work_updates_progress_check" CHECK ("work_updates"."progress_percent" is null or "work_updates"."progress_percent" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_principal_fk" FOREIGN KEY ("organization_id","agent_principal_id") REFERENCES "public"."agent_principals"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_principal_fk" FOREIGN KEY ("organization_id","agent_principal_id") REFERENCES "public"."agent_principals"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_oauth_grant_fk" FOREIGN KEY ("organization_id","oauth_grant_id") REFERENCES "public"."agent_oauth_grants"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_credential_fk" FOREIGN KEY ("organization_id","credential_id") REFERENCES "public"."agent_credentials"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_oauth_grants" ADD CONSTRAINT "agent_oauth_grants_principal_fk" FOREIGN KEY ("organization_id","agent_principal_id") REFERENCES "public"."agent_principals"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_oauth_grants" ADD CONSTRAINT "agent_oauth_grants_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "machine_workspaces" ADD CONSTRAINT "machine_workspaces_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_workspaces" ADD CONSTRAINT "machine_workspaces_installation_fk" FOREIGN KEY ("organization_id","installation_id") REFERENCES "public"."agent_installations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_workspaces" ADD CONSTRAINT "machine_workspaces_repository_fk" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."project_repositories"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_agent_fk" FOREIGN KEY ("organization_id","agent_principal_id") REFERENCES "public"."agent_principals"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_installation_fk" FOREIGN KEY ("organization_id","installation_id") REFERENCES "public"."agent_installations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "public"."machine_workspaces"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_updates" ADD CONSTRAINT "work_updates_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_updates" ADD CONSTRAINT "work_updates_session_fk" FOREIGN KEY ("organization_id","work_session_id") REFERENCES "public"."work_sessions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_better_auth_key_unique" ON "agent_credentials" USING btree ("better_auth_api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_fingerprint_unique" ON "agent_credentials" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "agent_credentials_principal_idx" ON "agent_credentials" USING btree ("organization_id","agent_principal_id");--> statement-breakpoint
CREATE INDEX "agent_installations_principal_idx" ON "agent_installations" USING btree ("organization_id","agent_principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_oauth_grants_provider_binding_unique" ON "agent_oauth_grants" USING btree ("user_id","oauth_client_id","provider_grant_id");--> statement-breakpoint
CREATE INDEX "agent_oauth_grants_principal_idx" ON "agent_oauth_grants" USING btree ("organization_id","agent_principal_id");--> statement-breakpoint
CREATE INDEX "agent_oauth_grants_refresh_family_idx" ON "agent_oauth_grants" USING btree ("refresh_family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_organization_slug_ci_unique" ON "agent_principals" USING btree ("organization_id",lower("slug"));--> statement-breakpoint
CREATE INDEX "agent_principals_project_idx" ON "agent_principals" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "machine_workspaces_project_idx" ON "machine_workspaces" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_sessions_request_live_claim_unique" ON "work_sessions" USING btree ("request_id") WHERE "work_sessions"."state" in ('claimed', 'active', 'paused', 'blocked', 'stale');--> statement-breakpoint
CREATE INDEX "work_sessions_agent_idx" ON "work_sessions" USING btree ("organization_id","agent_principal_id");--> statement-breakpoint
CREATE INDEX "work_sessions_lease_idx" ON "work_sessions" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "work_updates_session_created_idx" ON "work_updates" USING btree ("work_session_id","created_at");--> statement-breakpoint
CREATE FUNCTION "requestport_preserve_work_session_snapshot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.request_id IS DISTINCT FROM OLD.request_id
		OR NEW.agent_principal_id IS DISTINCT FROM OLD.agent_principal_id
		OR NEW.installation_id IS DISTINCT FROM OLD.installation_id
		OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
		OR NEW.authorization_chain IS DISTINCT FROM OLD.authorization_chain
		OR NEW.credential_fingerprint IS DISTINCT FROM OLD.credential_fingerprint
		OR NEW.claim_mode IS DISTINCT FROM OLD.claim_mode
		OR NEW.heartbeat_interval_seconds IS DISTINCT FROM OLD.heartbeat_interval_seconds
	THEN
		RAISE EXCEPTION 'work session authorization snapshot is immutable' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "work_sessions_snapshot_immutable"
BEFORE UPDATE ON "work_sessions"
FOR EACH ROW EXECUTE FUNCTION "requestport_preserve_work_session_snapshot"();
--> statement-breakpoint
CREATE TRIGGER "work_updates_append_only"
BEFORE UPDATE OR DELETE ON "work_updates"
FOR EACH ROW EXECUTE FUNCTION "requestport_reject_append_only_mutation"();
